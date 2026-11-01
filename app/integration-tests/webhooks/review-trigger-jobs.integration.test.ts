// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down how a verified delivery ends up in the job queue: through the real webhook handler, the
// real GitHub App provider, the real queue and a real Postgres database. The intake is a thin mapping from
// a trigger to a job; what the queue does with it (supersede, dedupe) is covered in
// src/jobs/job-queue.integration.test.ts, so these tests only show that the pieces are connected and
// that a redelivery or a replay produces no second job.
import { describe, expect, it } from "vitest";
import { webhookFixture } from "../../../fakes/github/webhooks.ts";
import { createRepositoriesRepository } from "../../src/db/repositories/repositories-repository.ts";
import { createIntegrationRegistry } from "../../src/integrations/registry.ts";
import type { JobKind } from "../../src/job-kind/job-kind.ts";
import { createJobQueue } from "../../src/jobs/job-queue.ts";
import { startWebhookHarness } from "../../src/test-support/webhook-harness.ts";
import { TEST_WEBHOOK_SECRET } from "../../src/test-support/github-app.ts";
import { webhookDelivery } from "../../../fakes/github/webhooks.ts";
import {
  createGithubAppWebhookHandler,
  type WorkspaceCollaborators,
} from "../../src/webhooks/github-app-handler.ts";
import { createJobQueueReviewTriggerIntake } from "../../src/webhooks/job-queue-intake.ts";
import { defaultWorkspaceId } from "../../src/test-support/workspaces.ts";

const OPENED_HEAD = "1f3a5c7e9b2d4f60a8c1e3b5d7f90a2c4e6b8d01";
const NEW_HEAD = "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00";

type PullRequestPayload = { pull_request: { head: { sha: string } } };

function withHeadSha(fixture: string, sha: string): PullRequestPayload {
  const payload = webhookFixture(fixture) as unknown as PullRequestPayload;
  payload.pull_request.head.sha = sha;
  return payload;
}

/** The webhook harness with the job queue intake instead of the recording one. */
async function startHarness(
  options: {
    projects?: WorkspaceCollaborators["projects"];
    kindAllowed?: (kind: JobKind) => boolean;
  } = {},
) {
  const h = await startWebhookHarness();
  const queue = createJobQueue(
    h.db,
    await defaultWorkspaceId(h.db),
    options.kindAllowed === undefined
      ? {}
      : { kindAllowed: options.kindAllowed },
  );
  const repositories = createRepositoriesRepository(
    h.db,
    await defaultWorkspaceId(h.db),
  );
  const logLines: string[] = [];
  const warnLines: string[] = [];
  const routeLog: string[] = [];
  const intake = createJobQueueReviewTriggerIntake({
    queue,
    repositories,
    logger: {
      info: (line) => logLines.push(line),
      warn: (line) => warnLines.push(line),
      error: (line) => logLines.push(line),
    },
  });
  const handler = createGithubAppWebhookHandler({
    registry: createIntegrationRegistry({ github_app: h.provider }),
    integrations: h.integrations,
    deliveries: h.deliveries,
    sync: h.sync,
    workspace: () => ({
      projects: options.projects ?? h.projects,
      settingsFor: h.settingsFor,
      intake,
    }),
    automatic: h.automatic,
    logger: {
      info: (line) => routeLog.push(line),
      warn: (line) => routeLog.push(line),
      error: (line) => routeLog.push(line),
    },
  });
  const send = (
    fixture: string,
    options: { deliveryId?: string; payload?: unknown } = {},
  ) =>
    handler(
      webhookDelivery({
        event: fixture.split(".")[0] as string,
        payload: (options.payload ?? webhookFixture(fixture)) as never,
        secret: TEST_WEBHOOK_SECRET,
        ...(options.deliveryId === undefined
          ? {}
          : { deliveryId: options.deliveryId }),
      }),
    );
  return { h, queue, intake, send, logLines, warnLines, routeLog };
}

function addOpenPullRequest(h: Awaited<ReturnType<typeof startHarness>>["h"]) {
  h.fake.addPullRequest("acme/widgets", {
    number: 7,
    title: "Add widget caching",
    state: "open",
    headSha: OPENED_HEAD,
    headRef: "feature/caching",
    baseRef: "main",
    author: { login: "alice", id: 1001 },
  });
}

describe("a pull request delivery with the job queue behind the route", () => {
  it("creates one waiting review job for the opened pull request that is due at once", async () => {
    const { h, queue, send } = await startHarness();
    await h.seedInstallation();

    const response = await send("pull_request.opened", { deliveryId: "d-1" });

    expect(response.status).toBe(202);
    const [job, ...rest] = await queue.list();
    expect(rest).toEqual([]);
    expect(job).toMatchObject({
      prNumber: 7,
      headSha: OPENED_HEAD,
      command: "review",
      args: "",
      triggerKind: "webhook",
      status: "queued",
      deliveryId: "d-1",
      actorLogin: expect.any(String),
    });
    expect(Date.parse(job?.runAfter ?? "")).toBeLessThanOrEqual(Date.now());
    const repository = await createRepositoriesRepository(
      h.db,
      await defaultWorkspaceId(h.db),
    ).findByExternalId(
      (await h.integrations.findByExternalId("github_app", "4242"))?.id ?? "",
      "7001",
    );
    expect(job?.repositoryId).toBe(repository?.id);
  });

  it("replaces the waiting job when the pull request is updated", async () => {
    const { h, queue, send } = await startHarness();
    await h.seedInstallation();
    await send("pull_request.opened", { deliveryId: "d-1" });
    h.fake.updatePullRequest("acme/widgets", 7, { headSha: NEW_HEAD });

    await send("pull_request.synchronize", {
      deliveryId: "d-2",
      payload: withHeadSha("pull_request.synchronize", NEW_HEAD),
    });

    expect(
      (await queue.list()).map((job) => [job.headSha, job.status]),
    ).toEqual([
      [OPENED_HEAD, "superseded"],
      [NEW_HEAD, "queued"],
    ]);
  });

  // CR-27-T08
  it("creates no second job when the same signed body is replayed under a new delivery id", async () => {
    const { h, queue, send } = await startHarness();
    await h.seedInstallation();

    await send("pull_request.opened", { deliveryId: "d-1" });
    const replay = await send("pull_request.opened", {
      deliveryId: "d-replay",
    });

    expect(replay.status).toBe(202);
    expect(await queue.list()).toHaveLength(1);
  });

  it("creates no second job when the intake gets the same delivery twice", async () => {
    const { h, queue, intake } = await startHarness();
    const integration = await h.seedInstallation();
    const trigger = {
      kind: "opened" as const,
      command: null,
      args: null,
      repo: {
        integrationId: integration.id,
        externalId: "7001",
        fullName: "acme/widgets",
        url: "https://github.test/acme/widgets",
      },
      prNumber: 7,
      prUrl: "https://github.test/acme/widgets/pull/7",
      headSha: OPENED_HEAD,
      actor: { login: "alice", externalId: "1001" },
      draft: false,
      state: "open" as const,
    };
    const source = { deliveryId: "d-1", event: "pull_request" };

    await intake.enqueueReviewTrigger(trigger, integration, source);
    await intake.enqueueReviewTrigger(trigger, integration, source);

    expect(await queue.list()).toHaveLength(1);
  });

  it("answers 500 and releases the delivery when the repository is not synchronized yet, so a redelivery works", async () => {
    // The project gate cannot see the missing row, so it is replaced by one that lets everything
    // pass: this is the race between a delivery and the synchronization, which the intake must
    // survive.
    const { h, queue, send, routeLog } = await startHarness({
      projects: { hasActiveProject: async () => true },
    });
    await h.seedInstallation();
    await h.db.deleteFrom("projects").execute();
    await h.db.deleteFrom("repositories").execute();

    const failed = await send("pull_request.opened", { deliveryId: "d-1" });

    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "WEBHOOK_PROCESSING_FAILED" });
    expect(await queue.list()).toEqual([]);
    expect(await h.snapshotTables()).toMatchObject({ deliveries: [] });
    expect(routeLog.join("\n")).toContain(
      "JobQueueError: JOB_REPOSITORY_UNKNOWN: No repository row for acme/widgets",
    );
  });
});

// #203-T04
describe("a comment delivery with the job queue behind the route", () => {
  it("creates a review job with the review command and no arguments", async () => {
    const { h, queue, send } = await startHarness();
    await h.seedInstallation();
    addOpenPullRequest(h);
    h.fake.setCollaboratorPermission("acme/widgets", "bob", "write");

    const response = await send("issue_comment.created.review", {
      deliveryId: "d-1",
    });

    expect(response.status).toBe(202);
    expect(await queue.list()).toMatchObject([
      {
        prNumber: 7,
        headSha: OPENED_HEAD,
        command: "review",
        args: "",
        triggerKind: "comment",
        actorLogin: "bob",
        status: "queued",
      },
    ]);
  });

  // #731-T05
  it("drops a trigger whose review kind this deployment has no capability for, with a warning and not an error", async () => {
    const { h, queue, intake, logLines, warnLines } = await startHarness({
      kindAllowed: () => false,
    });
    const integration = await h.seedInstallation();

    await intake.enqueueReviewTrigger(
      {
        kind: "command",
        command: "review",
        args: "",
        repo: {
          integrationId: integration.id,
          externalId: "7001",
          fullName: "acme/widgets",
          url: "https://github.test/acme/widgets",
        },
        prNumber: 7,
        prUrl: "https://github.test/acme/widgets/pull/7",
        headSha: OPENED_HEAD,
        commentId: "99001",
        actor: { login: "bob", externalId: "1002" },
      },
      integration,
      { deliveryId: "d-1", event: "issue_comment" },
    );

    expect(await queue.list()).toEqual([]);
    expect(warnLines).toHaveLength(1);
    expect(warnLines[0]).toContain("trigger dropped, JOB_KIND_UNAVAILABLE");
    expect(logLines).toEqual([]);
  });

  it("drops a trigger that carries review arguments instead of failing the delivery again and again", async () => {
    const { h, queue, intake, logLines } = await startHarness();
    const integration = await h.seedInstallation();

    await intake.enqueueReviewTrigger(
      {
        kind: "command",
        command: "review",
        args: "SECRET-QUESTION ".repeat(1000),
        repo: {
          integrationId: integration.id,
          externalId: "7001",
          fullName: "acme/widgets",
          url: "https://github.test/acme/widgets",
        },
        prNumber: 7,
        prUrl: "https://github.test/acme/widgets/pull/7",
        headSha: OPENED_HEAD,
        commentId: "99001",
        actor: { login: "bob", externalId: "1002" },
      },
      integration,
      { deliveryId: "d-1", event: "issue_comment" },
    );

    expect(await queue.list()).toEqual([]);
    const logged = logLines.join("\n");
    expect(logged).toContain("trigger dropped");
    expect(logged).toContain("fields=args:invalid");
    expect(logged).not.toContain("SECRET-QUESTION");
  });

  // #203-T03
  it("ignores a removed-command comment: no job, and the text is never logged", async () => {
    const { h, queue, send, logLines } = await startHarness();
    await h.seedInstallation();
    addOpenPullRequest(h);
    h.fake.setCollaboratorPermission("acme/widgets", "bob", "write");

    const response = await send("issue_comment.created.ask", {
      deliveryId: "d-1",
    });

    expect(response.status).toBe(202);
    expect(await queue.list()).toEqual([]);
    expect(logLines.join("\n")).not.toContain("cache key");
  });
});
