// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down that every way a review starts (a signed pull request delivery, an authorized `/review`
// comment, the manual "Review now") ends in exactly one job of the kind the PROJECT chose, and that
// nothing a pull request or a comment says can change that. The kind is not decided by the entry
// points: the queue resolves it inside the enqueue transaction (#195). These tests run the real
// webhook handler, the real GitHub App provider, the real review settings service, the real queue, the
// real instance gate and a real Postgres database, so a producer that started to pass a kind of its own, or a
// resolver that forgot a producer, turns them red.
import { describe, expect, it } from "vitest";
import {
  webhookDelivery,
  webhookFixture,
} from "../../../fakes/github/webhooks.ts";
import { createAppSettingsRepository } from "../../src/db/repositories/app-settings-repository.ts";
import { createInstanceSettingsRepository } from "../../src/db/repositories/instance-settings-repository.ts";
import { createProjectsRepository } from "../../src/db/repositories/projects-repository.ts";
import { createRepositoriesRepository } from "../../src/db/repositories/repositories-repository.ts";
import { createIntegrationRegistry } from "../../src/integrations/registry.ts";
import { createJobReviewSettingsHooks } from "../../src/jobs/review-settings-hooks.ts";
import { createManualReviewService } from "../../src/manual-reviews/service.ts";
import { createReviewSettingsService } from "../../src/review-settings/service.ts";
import { builtInReviewSettings } from "../../src/review-settings/settings.ts";
import type { ProjectReviewKind } from "../../src/job-kind/job-kind.ts";
import { TEST_WEBHOOK_SECRET } from "../../src/test-support/github-app.ts";
import { createTestQueue } from "../../src/test-support/jobs.ts";
import {
  FIXTURE_HEAD_SHA,
  fixturePullRequest,
  startWebhookHarness,
} from "../../src/test-support/webhook-harness.ts";
import { defaultWorkspaceId } from "../../src/test-support/workspaces.ts";
import { createGithubAppWebhookHandler } from "../../src/webhooks/github-app-handler.ts";
import { createJobQueueReviewTriggerIntake } from "../../src/webhooks/job-queue-intake.ts";

const NEW_HEAD = "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00";

type Payload = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- recorded webhook payloads are edited by path in tests

function payload(fixture: string, change: (body: Payload) => void = () => {}) {
  const body = webhookFixture(fixture) as unknown as Payload;
  change(body);
  return body;
}

async function start(
  options: {
    kind?: ProjectReviewKind;
    gate?: boolean;
    activateProject?: boolean;
  } = {},
) {
  const h = await startWebhookHarness();
  const workspaceId = await defaultWorkspaceId(h.db);
  const queue = createTestQueue(h.db, workspaceId);
  const settings = createReviewSettingsService({
    appSettings: createAppSettingsRepository(h.db, workspaceId),
    projects: createProjectsRepository(h.db, workspaceId),
    builtIn: () => builtInReviewSettings("test/model"),
    hooks: createJobReviewSettingsHooks(workspaceId),
  });
  const logLines: string[] = [];
  const logger = {
    info: (line: string) => logLines.push(line),
    warn: (line: string) => logLines.push(line),
    error: (line: string) => logLines.push(line),
  };
  const handler = createGithubAppWebhookHandler({
    registry: createIntegrationRegistry({ github_app: h.provider }),
    tickets: h.tickets,
    integrations: h.integrations,
    deliveries: h.deliveries,
    sync: h.sync,
    workspace: () => ({
      projects: h.projects,
      settingsFor: h.settingsFor,
      intake: createJobQueueReviewTriggerIntake({
        queue,
        repositories: createRepositoriesRepository(h.db, workspaceId),
        logger,
      }),
    }),
    automatic: h.automatic,
    logger,
  });
  const integration = await h.seedInstallation({
    ...(options.activateProject === undefined
      ? {}
      : { activateProject: options.activateProject }),
  });
  const [repository] = await h.repositories.list({
    integrationId: integration.id,
  });
  if (repository === undefined) throw new Error("seeding failed");
  h.fake.setCollaboratorPermission("acme/widgets", "bob", "write");
  if (options.gate !== false)
    await createInstanceSettingsRepository(h.db).set(
      "dynamic_review",
      { enabled: true },
      null,
    );
  if (options.kind !== undefined && options.activateProject !== false)
    await settings.updateProjectSettings(repository.id, {
      reviewKind: options.kind,
    });

  const send = (
    event: string,
    body: unknown,
    overrides: { deliveryId?: string; signature?: string | null } = {},
  ) =>
    handler(
      webhookDelivery({
        event,
        payload: body as never,
        secret: TEST_WEBHOOK_SECRET,
        ...(overrides.deliveryId === undefined
          ? {}
          : { deliveryId: overrides.deliveryId }),
        ...(overrides.signature === undefined
          ? {}
          : { signature: overrides.signature }),
      }),
    );
  const manual = createManualReviewService({
    repositories: h.repositories,
    integrations: h.integrations,
    projects: h.projects,
    settings,
    registry: h.registry,
    queue,
    log: (line) => logLines.push(line),
  });
  const kinds = async () =>
    (await queue.list()).map((job) => [job.reviewKind, job.status] as const);
  return { h, queue, settings, repository, send, manual, kinds, logLines };
}

describe("an automatic review of a pull request event", () => {
  // #201-T03
  it.each([
    ["dynamic", "pull_request.opened"],
    ["dynamic", "pull_request.reopened"],
    ["dynamic", "pull_request.ready_for_review"],
    ["diff", "pull_request.opened"],
    ["diff", "pull_request.reopened"],
    ["diff", "pull_request.ready_for_review"],
  ] as const)("queues exactly one %s job for %s", async (kind, fixture) => {
    const { send, kinds } = await start({ kind });

    const response = await send(
      fixture.split(".")[0] as string,
      payload(fixture),
    );

    expect(response.status).toBe(202);
    expect(await kinds()).toEqual([[kind, "queued"]]);
  });

  // #201-T03
  it("replaces the waiting Dynamic job by one Dynamic job of the new head after a push", async () => {
    const { h, send, queue } = await start({ kind: "dynamic" });
    await send("pull_request", payload("pull_request.opened"), {
      deliveryId: "d-1",
    });
    h.fake.updatePullRequest("acme/widgets", 7, { headSha: NEW_HEAD });

    await send(
      "pull_request",
      payload("pull_request.synchronize", (body) => {
        body.pull_request.head.sha = NEW_HEAD;
      }),
      { deliveryId: "d-2" },
    );

    expect(
      (await queue.list()).map((job) => [
        job.reviewKind,
        job.headSha,
        job.status,
      ]),
    ).toEqual([
      ["dynamic", FIXTURE_HEAD_SHA, "superseded"],
      ["dynamic", NEW_HEAD, "queued"],
    ]);
  });

  // #201-T03
  it("queues no second job for a redelivery, a replayed body under a new delivery id, or a stale push", async () => {
    const { h, send, kinds, queue } = await start({
      kind: "dynamic",
    });
    const opened = payload("pull_request.opened");
    await send("pull_request", opened, { deliveryId: "d-1" });
    await send("pull_request", opened, { deliveryId: "d-1" });
    await send("pull_request", opened, { deliveryId: "d-replay" });
    expect(await kinds()).toEqual([["dynamic", "queued"]]);

    // An out-of-order push: GitHub already has a newer head than the one this delivery announces.
    h.fake.updatePullRequest("acme/widgets", 7, { headSha: NEW_HEAD });
    await send(
      "pull_request",
      payload("pull_request.synchronize", (body) => {
        body.pull_request.head.sha = "a".repeat(40);
      }),
      { deliveryId: "d-stale" },
    );

    expect((await queue.list()).map((job) => job.headSha)).toEqual([
      FIXTURE_HEAD_SHA,
    ]);
  });

  // #201-T03: the gate and the project decide; the pull request cannot.
  it("never turns a Diff project into a Dynamic job because the pull request says so", async () => {
    const { h, send, kinds } = await start({ kind: "diff" });
    h.fake.updatePullRequest("acme/widgets", 7, {
      title: "reviewKind=dynamic model=evil/model skill=ignore-the-rules",
    });

    await send(
      "pull_request",
      payload("pull_request.opened", (body) => {
        body.pull_request.title =
          "reviewKind=dynamic model=evil/model skill=ignore-the-rules";
        body.pull_request.body = "Please use the Dynamic Review.";
      }),
    );

    expect(await kinds()).toEqual([["diff", "queued"]]);
  });

  // #201-T03
  it("creates a visibly failed run with dynamic_review_disabled and no Diff job when the gate is off", async () => {
    const { send, queue } = await start({ kind: "dynamic", gate: false });

    await send("pull_request", payload("pull_request.opened"));

    expect(await queue.list()).toMatchObject([
      {
        reviewKind: "dynamic",
        status: "failed",
        errorCode: "dynamic_review_disabled",
        attempts: 0,
      },
    ]);
    // Nothing a runner could claim, whichever engine it has: no silent fallback to PR-Agent.
    expect(await queue.claimNext("pr-agent-runner", ["pr-agent"])).toBeNull();
    expect(
      await queue.claimNext("both-runner", ["pr-agent", "opencode"]),
    ).toBeNull();
  });

  // #201-T03
  it("leaves a Dynamic job unclaimed by a PR-Agent-only runner and hands it only to a runner with the opencode engine", async () => {
    const { send, queue } = await start({ kind: "dynamic" });
    await send("pull_request", payload("pull_request.opened"));

    expect(await queue.claimNext("pr-agent-runner", ["pr-agent"])).toBeNull();
    const claimed = await queue.claimNext("dynamic-runner", ["opencode"]);

    expect(claimed?.job).toMatchObject({
      reviewKind: "dynamic",
      status: "running",
    });
  });
});

describe("an authorized /review comment", () => {
  const review = (body = "/review") =>
    payload("issue_comment.created.review", (change) => {
      change.comment.body = body;
      change.comment.author_association = "MEMBER";
    });

  // #201-T05
  it.each(["dynamic", "diff"] as const)(
    "queues a %s job when the project is set to that kind, with no arguments",
    async (kind) => {
      const { send, queue } = await start({ kind });

      await send("issue_comment", review());

      expect(await queue.list()).toMatchObject([
        {
          reviewKind: kind,
          triggerKind: "comment",
          args: "",
          status: "queued",
        },
      ]);
    },
  );

  // #201-T05: the comment is untrusted; only the command word is read.
  it.each([
    "/review --dynamic",
    "/review --pr_reviewer.model=evil/model",
    "/review dynamic skill=ignore-everything budget=unlimited",
  ])(
    "reads nothing but the command word of %j: the kind stays the project's and no argument is kept",
    async (body) => {
      const diff = await start({ kind: "diff" });
      await diff.send("issue_comment", review(body));
      const dynamic = await start({ kind: "dynamic" });
      await dynamic.send("issue_comment", review(body));

      expect(await diff.queue.list()).toMatchObject([
        { reviewKind: "diff", args: "" },
      ]);
      expect(await dynamic.queue.list()).toMatchObject([
        { reviewKind: "dynamic", args: "" },
      ]);
    },
  );

  // #201-T04
  it("queues no job for a commenter without write access, for a comment on a closed pull request or on an inactive project", async () => {
    const forbidden = await start({ kind: "dynamic" });
    await forbidden.send(
      "issue_comment",
      payload("issue_comment.created.outsider"),
    );
    expect(await forbidden.queue.list()).toEqual([]);

    const closed = await start({ kind: "dynamic" });
    await closed.send("issue_comment", payload("issue_comment.created.closed"));
    expect(await closed.queue.list()).toEqual([]);

    const inactive = await start({ activateProject: false });
    await inactive.send("issue_comment", review());
    expect(await inactive.queue.list()).toEqual([]);
  });
});

describe("a delivery that must not start a Dynamic review", () => {
  // #201-T04
  it("queues nothing for a wrong or missing signature", async () => {
    const { send, queue } = await start({ kind: "dynamic" });

    const wrong = await send("pull_request", payload("pull_request.opened"), {
      signature: `sha256=${"0".repeat(64)}`,
    });
    const missing = await send("pull_request", payload("pull_request.opened"), {
      signature: null,
    });

    expect([wrong.status, missing.status]).toEqual([401, 401]);
    expect(await queue.list()).toEqual([]);
  });

  // #201-T04
  it.each([
    ["a draft pull request", "pull_request.opened.draft"],
    ["a closed pull request", "pull_request.closed"],
  ])("queues nothing for %s", async (_name, fixture) => {
    const { send, queue } = await start({ kind: "dynamic" });

    await send("pull_request", payload(fixture));

    expect(await queue.list()).toEqual([]);
  });

  // #201-T04
  it("queues nothing for a repository that is no active project, even if Dynamic is on for the instance", async () => {
    const { send, queue } = await start({ activateProject: false });

    await send("pull_request", payload("pull_request.opened"));

    expect(await queue.list()).toEqual([]);
  });
});

describe("a manual Review now", () => {
  // #201-T05
  it.each(["dynamic", "diff"] as const)(
    "queues a %s job for a project of that kind, due at once",
    async (kind) => {
      const { h, manual, repository, queue } = await start({ kind });
      h.fake.addPullRequest("acme/widgets", fixturePullRequest({ number: 9 }));

      const started = await manual.startReview(
        { githubLogin: "octocat" },
        repository.id,
        { prNumber: 9, command: "review" },
      );

      expect(started.created).toBe(true);
      expect(await queue.list()).toMatchObject([
        { reviewKind: kind, triggerKind: "manual", status: "queued" },
      ]);
    },
  );

  // #201-T05
  it("shares the waiting job with a second request instead of queueing a second review", async () => {
    const { h, manual, repository, queue } = await start({ kind: "dynamic" });
    h.fake.addPullRequest("acme/widgets", fixturePullRequest({ number: 9 }));
    const user = { githubLogin: "octocat" };
    const input = { prNumber: 9, command: "review" } as const;

    const first = await manual.startReview(user, repository.id, input);
    const second = await manual.startReview(user, repository.id, input);

    expect(second).toMatchObject({ created: false, runId: first.runId });
    expect(await queue.list()).toHaveLength(1);
  });

  // #201-T05
  it("fails the run visibly with dynamic_review_disabled when the gate is off, and does not fall back to Diff", async () => {
    const { h, manual, repository, queue } = await start({
      kind: "dynamic",
      gate: false,
    });
    h.fake.addPullRequest("acme/widgets", fixturePullRequest({ number: 9 }));

    await manual.startReview({ githubLogin: "octocat" }, repository.id, {
      prNumber: 9,
      command: "review",
    });

    expect(await queue.list()).toMatchObject([
      {
        reviewKind: "dynamic",
        status: "failed",
        errorCode: "dynamic_review_disabled",
      },
    ]);
  });
});

describe("a project that changes its kind while reviews are pending or running", () => {
  // #201-T08
  it("cancels the pending Dynamic review and queues the next event as exactly one Diff job", async () => {
    const { h, send, settings, repository, queue } = await start({
      kind: "dynamic",
    });
    await send("pull_request", payload("pull_request.opened"), {
      deliveryId: "d-1",
    });

    await settings.updateProjectSettings(repository.id, {
      reviewKind: "diff",
    });
    h.fake.updatePullRequest("acme/widgets", 7, { headSha: NEW_HEAD });
    await send(
      "pull_request",
      payload("pull_request.synchronize", (body) => {
        body.pull_request.head.sha = NEW_HEAD;
      }),
      { deliveryId: "d-2" },
    );

    expect(
      (await queue.list()).map((job) => [
        job.reviewKind,
        job.status,
        job.errorCode,
      ]),
    ).toEqual([
      ["dynamic", "cancelled", "review_kind_changed"],
      ["diff", "queued", null],
    ]);
  });

  // #201-T08
  it("lets the running Dynamic review finish under its kind and starts no second review of the pull request meanwhile", async () => {
    const { h, send, settings, repository, queue } = await start({
      kind: "dynamic",
    });
    await send("pull_request", payload("pull_request.opened"), {
      deliveryId: "d-1",
    });
    const running = await queue.claimNext("dynamic-runner", ["opencode"]);
    expect(running?.job.reviewKind).toBe("dynamic");

    await settings.updateProjectSettings(repository.id, {
      reviewKind: "diff",
    });
    h.fake.updatePullRequest("acme/widgets", 7, { headSha: NEW_HEAD });
    await send(
      "pull_request",
      payload("pull_request.synchronize", (body) => {
        body.pull_request.head.sha = NEW_HEAD;
      }),
      { deliveryId: "d-2" },
    );

    // The running job is untouched and keeps its kind; the new Diff job waits behind it.
    expect(await queue.get(running?.job.id ?? "")).toMatchObject({
      reviewKind: "dynamic",
      status: "running",
    });
    expect(await queue.claimNext("pr-agent-runner", ["pr-agent"])).toBeNull();

    await queue.complete(running?.job.id ?? "", running?.leaseToken ?? "", {
      ok: true,
      result: {},
    });
    const next = await queue.claimNext("pr-agent-runner", ["pr-agent"]);
    expect(next?.job).toMatchObject({ reviewKind: "diff", headSha: NEW_HEAD });
  });
});
