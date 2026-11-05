// SPDX-License-Identifier: LicenseRef-Proprietary

// Everything a test of the webhook route needs: the sync harness (a real Postgres database, the fake
// GitHub API, the real GitHub App provider behind a registry), the delivery record, a recording
// intake and the route's handler wired to all of them. `deliver*` builds signed requests like GitHub.
import { vi } from "vitest";
import type { FakePullRequest } from "../../../fakes/github/server.ts";
import {
  signWebhookBody,
  webhookDelivery,
  webhookFixture,
  type WebhookDeliveryOptions,
} from "../../../fakes/github/webhooks.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { createWebhookDeliveriesRepository } from "../db/repositories/webhook-deliveries-repository.ts";
import type { IntegrationProvider } from "../integrations/provider.ts";
import { createIntegrationRegistry } from "../integrations/registry.ts";
import { createProjectService } from "../projects/service.ts";
import {
  createGithubAppWebhookHandler,
  type AutomaticReviewDeps,
  type WorkspaceCollaborators,
} from "../webhooks/github-app-handler.ts";
import {
  builtInReviewSettings,
  type ReviewSettings,
} from "../review-settings/settings.ts";
import type { WebhookLogger } from "../webhooks/logger.ts";
import { TEST_WEBHOOK_SECRET } from "./github-app.ts";
import { startSyncHarness } from "./integration-sync-harness.ts";
import { createRecordingReviewTriggerIntake } from "./recording-review-trigger-intake.ts";

/** The head commit of pull request 7 in the recorded payloads. */
export const FIXTURE_HEAD_SHA = "1f3a5c7e9b2d4f60a8c1e3b5d7f90a2c4e6b8d01";

/** Pull request 7 as the recorded payloads describe it; GitHub knows it when the head is checked. */
export function fixturePullRequest(
  overrides: Partial<FakePullRequest> = {},
): FakePullRequest {
  return {
    number: 7,
    title: "Add widget caching",
    state: "open",
    headSha: FIXTURE_HEAD_SHA,
    headRef: "feature/caching",
    baseRef: "main",
    author: { login: "alice", id: 1001 },
    ...overrides,
  };
}

export async function startWebhookHarness(
  options: {
    maxBodyBytes?: number;
    /** How long one request to the fake GitHub may take (default: 5 seconds). */
    requestTimeoutMs?: number;
    env?: Record<string, string | undefined>;
    /** The GitHub App lives only in the database (see `startSyncHarness`). */
    credentialsFromDatabase?: boolean;
    /** Changes the real provider, for example to make `canTrigger` refuse. */
    wrapProvider?: (provider: IntegrationProvider) => IntegrationProvider;
    /** The review settings every project uses; default: the built-in values (everything on). */
    reviewSettings?: Partial<ReviewSettings>;
    /** The most connections the pool of the database opens. */
    poolMax?: number;
  } = {},
) {
  const base = await startSyncHarness({
    ...(options.poolMax === undefined ? {} : { poolMax: options.poolMax }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.credentialsFromDatabase === undefined
      ? {}
      : { credentialsFromDatabase: options.credentialsFromDatabase }),
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
  });
  const github = base.registry.resolve("github_app");
  const provider = options.wrapProvider?.(github) ?? github;
  // Spies on the calls that matter for the order of the route's steps.
  const verifyWebhook = vi.spyOn(provider, "verifyWebhook");
  const parseEvent = vi.spyOn(provider, "parseEvent");
  const registry = createIntegrationRegistry({ github_app: provider });

  const deliveries = createWebhookDeliveriesRepository(base.db);
  const projects = createProjectService({
    projects: createProjectsRepository(base.db, base.workspaceId),
  });
  const intake = createRecordingReviewTriggerIntake();
  const infoLines: string[] = [];
  const errorLines: string[] = [];
  const logger: WebhookLogger = {
    info: (line) => infoLines.push(line),
    warn: (line) => infoLines.push(line),
    error: (line) => errorLines.push(line),
  };
  const settings: ReviewSettings = {
    ...builtInReviewSettings("test/model"),
    ...options.reviewSettings,
  };
  const settingsFor: WorkspaceCollaborators["settingsFor"] = async () =>
    settings;
  const automatic: AutomaticReviewDeps = {};
  const handler = createGithubAppWebhookHandler({
    registry,
    integrations: base.directory,
    deliveries,
    sync: base.sync,
    workspace: () => ({ projects, settingsFor, intake }),
    automatic,
    logger,
    ...(options.maxBodyBytes === undefined
      ? {}
      : { maxBodyBytes: options.maxBodyBytes }),
  });

  /**
   * The installation 4242 of "acme" with one repository (7001, "acme/widgets"), stored as an active
   * integration. The repository is activated as a project unless `activateProject` is false, because
   * a review trigger for a repository without an active project is not handed to the intake.
   */
  async function seedInstallation(options: { activateProject?: boolean } = {}) {
    base.fake.addInstallation({
      id: 4242,
      account: { login: "acme", id: 5001, type: "Organization" },
    });
    base.fake.setRepositories(4242, [{ id: 7001, fullName: "acme/widgets" }]);
    await base.sync.syncAll();
    const integration = await base.integrations.findByExternalId(
      "github_app",
      "4242",
    );
    if (integration === undefined) throw new Error("seeding failed");
    // Pull request 7, as the recorded payloads describe it: an open pull request whose head commit
    // is the one in the fixtures. A push is judged against it, so a test that wants another head
    // commit changes it with `fake.updatePullRequest`.
    base.fake.addPullRequest("acme/widgets", fixturePullRequest());
    if (options.activateProject !== false) {
      const [repository] = await base.repositories.list({
        integrationId: integration.id,
      });
      if (repository === undefined) throw new Error("seeding failed");
      await projects.activateProject(repository.id);
    }
    return integration;
  }

  /** A signed delivery of a recorded payload, for example `deliver("pull_request.opened")`. */
  function deliver(
    fixture: string,
    overrides: Partial<WebhookDeliveryOptions> = {},
  ): Promise<Response> {
    return handler(
      webhookDelivery({
        event: fixture.split(".")[0] as string,
        payload: webhookFixture(fixture),
        secret: TEST_WEBHOOK_SECRET,
        ...overrides,
      }),
    );
  }

  /**
   * A delivery with a body and headers chosen by the test, signed with the right secret unless
   * `signature` says otherwise. A header set to `null` is left out.
   */
  function deliverRaw(
    body: string | Uint8Array,
    headers: Record<string, string | null> = {},
    signature?: string | null,
  ): Promise<Response> {
    const all: Record<string, string | null> = {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": crypto.randomUUID(),
      "x-hub-signature-256":
        signature === undefined
          ? signWebhookBody(body, TEST_WEBHOOK_SECRET)
          : signature,
      ...headers,
    };
    const requestHeaders = new Headers();
    for (const [name, value] of Object.entries(all))
      if (value !== null) requestHeaders.set(name, value);
    return handler(
      new Request("https://app.test/api/webhooks/github-app", {
        method: "POST",
        headers: requestHeaders,
        body: body as BodyInit,
      }),
    );
  }

  /** Every table the route may touch, for "nothing changed" assertions. */
  async function snapshotTables() {
    return {
      integrations: await base.db
        .selectFrom("integrations")
        .selectAll()
        .execute(),
      repositories: await base.db
        .selectFrom("repositories")
        .selectAll()
        .execute(),
      projects: await base.db.selectFrom("projects").selectAll().execute(),
      deliveries: await base.db
        .selectFrom("webhook_deliveries")
        .selectAll()
        .execute(),
    };
  }

  return {
    ...base,
    provider,
    verifyWebhook,
    parseEvent,
    deliveries,
    projects,
    settingsFor,
    automatic,
    intake,
    handler,
    infoLines,
    errorLines,
    seedInstallation,
    deliver,
    deliverRaw,
    snapshotTables,
    /** Every line the route logged. */
    logLines: () => [...infoLines, ...errorLines],
  };
}

export type WebhookHarness = Awaited<ReturnType<typeof startWebhookHarness>>;
