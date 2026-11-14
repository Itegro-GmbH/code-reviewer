// SPDX-License-Identifier: LicenseRef-Proprietary

// The binding of installations to workspaces assembled for integration tests (src/installation-binding/): a real
// database, the fake GitHub on a loopback port as github.com and api.github.com, the GitHub App saved in
// the encrypted store the way the admin portal saves it (with the user authorization), the real registry, the
// real synchronization with the real placement, the real services and route handlers, and a clock the test moves.
// `walk` does what a person does: presses "Connect GitHub", installs on GitHub, comes back to the setup address,
// authorizes, and comes back to the callback.
import type {
  FakeGithub,
  FakeInstallation,
} from "../../../fakes/github/server.ts";
import {
  webhookDelivery,
  webhookFixture,
} from "../../../fakes/github/webhooks.ts";
import { createIntegrationDirectory } from "../db/repositories/integration-directory-repository.ts";
import { createAppSettingsRepository } from "../db/repositories/app-settings-repository.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { createJobQueue } from "../jobs/job-queue.ts";
import { createProjectService } from "../projects/service.ts";
import { createReviewSettingsService } from "../review-settings/service.ts";
import { builtInReviewSettings } from "../review-settings/settings.ts";
import { createAutomaticReviewSettingsSource } from "../webhooks/automatic-review-settings.ts";
import { createJobQueueReviewTriggerIntake } from "../webhooks/job-queue-intake.ts";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import { createWebhookDeliveriesRepository } from "../db/repositories/webhook-deliveries-repository.ts";
import {
  createGithubAppWebhookHandler,
  type WorkspaceCollaborators,
} from "../webhooks/github-app-handler.ts";
import { createRecordingReviewTriggerIntake } from "./recording-review-trigger-intake.ts";
import { createInstallationLinkRequestDirectory } from "../db/repositories/installation-link-request-directory-repository.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createUnclaimedInstallationsRepository } from "../db/repositories/unclaimed-installations-repository.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import { createGithubCredentialStore } from "../github-config/credentials.ts";
import {
  assembleInstallationBinding,
  bindingTenancy,
} from "../installation-binding/assemble.ts";
import {
  createBindingRouteHandlers,
  type BindingRouteDependencies,
  type BindingRouteHandlers,
} from "../installation-binding/http.ts";
import { createConnectionPlacement } from "../installation-binding/placement.ts";
import { hitBindingLimit } from "../installation-binding/rate-limits.ts";
import type {
  BindingActor,
  CallbackResult,
} from "../installation-binding/service.ts";
import { createDefaultProviders } from "../integrations/registry.ts";
import { createIntegrationSync } from "../integrations/sync/service.ts";
import { createKeyedLock } from "../integrations/sync/keyed-lock.ts";
import { purposeOfState } from "../signed-state/state.ts";
import type { WorkspaceAccess } from "../workspaces/access.ts";
import type { WorkspaceRole } from "../db/workspace-roles.ts";
import { TEST_APP_ID, TEST_APP_SLUG, testAppKeys } from "./github-app.ts";
import {
  startTestGithub,
  TEST_CLIENT_ID,
  TEST_CLIENT_SECRET,
} from "./github-fake.ts";
import {
  GITHUB_CONFIG_TEST_PUBLIC_URL,
  GITHUB_CONFIG_TEST_SECRET,
} from "./github-config-harness.ts";
import { sessionUser } from "./session-lookup.ts";
import { createTestDatabase } from "./test-database.ts";
import { insertUser } from "./users.ts";

export const BINDING_SETUP_URL = `${GITHUB_CONFIG_TEST_PUBLIC_URL}/github/connected`;

export type BindingHarnessOptions = {
  github?: FakeGithub;
  tenancy?: "single" | "multi";
  /** Whether the App has a user authorization (client id and secret). Default: yes. */
  userAuthorization?: boolean;
  /** The "private app" flag the admin saved. Default: true. */
  privateApp?: boolean | null;
};

export async function createBindingHarness(
  options: BindingHarnessOptions = {},
) {
  const { db } = await createTestDatabase();
  const github =
    options.github ?? (await startTestGithub({ appSlug: TEST_APP_SLUG }));
  github.setAppSetupUrl(BINDING_SETUP_URL);
  const clock = { time: Date.parse("2026-10-12T10:00:00.000Z") };
  const now = () => new Date(clock.time);
  const settings = createInstanceSettingsRepository(db, now);
  await settings.set("tenancy", options.tenancy ?? "multi", null);

  const env = {
    GITHUB_API_BASE_URL: github.baseUrl,
    ALLOW_TEST_GITHUB_ENDPOINTS: "true",
  };
  const credentials = createGithubCredentialStore({
    db,
    appSecret: GITHUB_CONFIG_TEST_SECRET,
    env,
    now,
  });
  await insertUser(db, { id: "instance-admin", isInstanceAdmin: true });
  await credentials.persistApp({
    actorId: "instance-admin",
    stored: {
      appId: TEST_APP_ID,
      slug: TEST_APP_SLUG,
      clientId: options.userAuthorization === false ? null : TEST_CLIENT_ID,
      privateApp: options.privateApp === undefined ? true : options.privateApp,
      origin: "manual",
    },
    privateKey: testAppKeys().privateKey,
    webhookSecret: "a-webhook-secret-of-the-test",
    clientSecret:
      options.userAuthorization === false
        ? { kind: "keep" }
        : { kind: "set", value: TEST_CLIENT_SECRET },
  });

  const { integrations: registry, tickets } = createDefaultProviders({
    loadConfig: async () => {
      const loaded = await credentials.load();
      if (!loaded.app.ok) throw new Error("The GitHub App is not configured.");
      return loaded.app.config;
    },
    githubClient: { requestTimeoutMs: 5000 },
  });
  const lock = createKeyedLock();
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  const sync = createIntegrationSync({
    db,
    registry,
    now,
    lock,
    log,
    placeNewConnection: createConnectionPlacement({
      db,
      now,
      ownerAccount: async () =>
        (await registry.resolve("github_app").ownerAccount?.()) ?? null,
      privateApp: async () =>
        (await credentials.load()).stored?.privateApp === true,
    }),
  });

  const binding = assembleInstallationBinding({
    db,
    registry,
    sync,
    lock,
    appSecret: GITHUB_CONFIG_TEST_SECRET,
    publicUrl: GITHUB_CONFIG_TEST_PUBLIC_URL,
    oauthBaseUrl: github.baseUrl,
    apiBaseUrl: github.baseUrl,
    github: async () => {
      const loaded = await credentials.load();
      const { userAuthorization } = loaded;
      return {
        slug: loaded.slug,
        userAuthorization:
          userAuthorization.state === "configured"
            ? {
                clientId: userAuthorization.clientId,
                clientSecret: userAuthorization.clientSecret.reveal(),
              }
            : null,
      };
    },
    tenancy: () => bindingTenancy(db),
    now,
    log,
    timeoutMs: 5000,
  });

  const workspaces = createWorkspacesRepository(db, now);
  const sessions = new Map<string, string>();

  /** A signed in person: the account (once), a membership if asked, and the session of the browser. */
  async function person(
    id: string,
    membership?: { workspaceId: string; role: WorkspaceRole },
    session = `session-${id}`,
  ): Promise<BindingActor> {
    const exists = await db
      .selectFrom("users")
      .select("id")
      .where("id", "=", id)
      .executeTakeFirst();
    if (exists === undefined) await insertUser(db, { id, emailVerified: true });
    if (membership !== undefined)
      await workspaces.addMember(membership.workspaceId, id, membership.role);
    sessions.set(id, session);
    return { id, sessionId: session };
  }

  async function workspace(slug: string) {
    return workspaces.create({
      name: `Workspace ${slug}`,
      slug,
      createdBy: null,
    });
  }

  function accessOf(
    actor: BindingActor,
    workspaceValue: Awaited<ReturnType<typeof workspace>>,
    role: WorkspaceRole,
  ): WorkspaceAccess {
    return {
      user: sessionUser(actor.id),
      workspace: workspaceValue,
      role,
    };
  }

  function handlers(
    actor: BindingActor | null = null,
    /** Replaces collaborators, for example a synchronization that fails. */
    overrides: Partial<BindingRouteDependencies> = {},
  ): BindingRouteHandlers {
    return createBindingRouteHandlers({
      service: binding.service,
      connections: binding.connections,
      sync,
      sessionId: async () => actor?.sessionId ?? null,
      session: async () =>
        actor === null
          ? null
          : { userId: actor.id, sessionId: actor.sessionId },
      workspaceSlug: async (id) => (await workspaces.get(id))?.slug ?? null,
      syncLimit: (userId) =>
        hitBindingLimit(
          createRateLimitsRepository(db, now),
          "sync",
          userId,
          now(),
        ),
      isAuthorizationState: (state) =>
        purposeOfState(GITHUB_CONFIG_TEST_SECRET, state) === "github-authorize",
      ...overrides,
    });
  }

  /**
   * The collaborators of the running server for one workspace: the real project service, the real review
   * settings and the real job queue, so a delivery that deserves a review makes a job and one that does not
   * makes none. Pass it as `webhook(h.reviewingCollaborators)`.
   */
  function reviewingCollaborators(workspaceId: string): WorkspaceCollaborators {
    const repositories = createRepositoriesRepository(db, workspaceId);
    return {
      projects: createProjectService({
        projects: createProjectsRepository(db, workspaceId, now),
      }),
      settingsFor: createAutomaticReviewSettingsSource({
        repositories,
        settings: createReviewSettingsService({
          appSettings: createAppSettingsRepository(db, workspaceId, now),
          projects: createProjectsRepository(db, workspaceId, now),
          builtIn: () => builtInReviewSettings("test-model"),
        }),
      }),
      intake: createJobQueueReviewTriggerIntake({
        queue: createJobQueue(db, workspaceId),
        repositories,
        logger: {
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
        },
      }),
    };
  }

  /**
   * The route of the GitHub App webhook over the same database, registry and synchronization. `workspace`
   * gives the collaborators of a delivery's workspace (default: no project is active anywhere, so a review
   * trigger ends there).
   */
  function webhook(
    workspace: (workspaceId: string) => WorkspaceCollaborators = () => ({
      projects: { hasActiveProject: async () => false },
      settingsFor: async () => undefined,
      intake: createRecordingReviewTriggerIntake(),
    }),
  ) {
    const handler = createGithubAppWebhookHandler({
      registry,
      tickets,
      integrations: createIntegrationDirectory(db),
      deliveries: createWebhookDeliveriesRepository(db),
      sync,
      workspace,
      automatic: {},
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });
    return {
      handler,
      /** A signed delivery of a recorded payload, or of the payload a test changed. */
      async deliver(
        fixture: string,
        change: (payload: Record<string, unknown>) => void = () => undefined,
      ): Promise<{ status: number; outcome: string | null }> {
        const payload = webhookFixture(fixture);
        change(payload);
        const response = await handler(
          webhookDelivery({
            event: fixture.split(".")[0] as string,
            payload,
            secret: "a-webhook-secret-of-the-test",
          }),
        );
        const body = (await response.json()) as { outcome?: string };
        return { status: response.status, outcome: body.outcome ?? null };
      },
    };
  }

  /** An account of the fake GitHub (and, for an organization, who belongs to it and in which role). */
  function githubUser(id: number, login: string) {
    github.addUser({
      id,
      login,
      name: login,
      email: `${login}@users.example.test`,
    });
  }

  function install(
    installation: FakeInstallation,
    repositories: string[] = [],
  ) {
    github.addInstallation(installation);
    github.setRepositories(
      installation.id,
      repositories.map((fullName, index) => ({
        id: installation.id * 100 + index,
        fullName,
      })),
    );
  }

  /**
   * What the person's browser does between "Connect GitHub" and the end: the installation page (a click on
   * "Install" or "Ask ... to approve"), the setup address, GitHub's authorization (a click on "Authorize"),
   * and the callback. Resolves to every step's answer so a test can look at any of them.
   */
  async function walk(
    actor: BindingActor,
    workspaceId: string,
    options: {
      installationId: number;
      /** The GitHub account that authorizes. */
      githubLogin: string;
      action?: "install" | "request";
    },
  ) {
    const started = await binding.service.startConnect(actor, workspaceId);
    if (!started.ok) return { started } as const;
    const back = await confirmInstallation(started.url, options);
    const setup = await binding.service.completeSetup(actor, {
      installationId: back.searchParams.get("installation_id"),
      setupAction: back.searchParams.get("setup_action"),
      state: back.searchParams.get("state"),
    });
    if (setup.kind !== "authorize") return { started, setup } as const;
    const final = await authorize(actor, setup.url, options.githubLogin);
    return { started, setup, final } as const;
  }

  /** The click on "Install" (or "Ask ... to approve") on the fake installation page. */
  async function confirmInstallation(
    startUrl: string,
    options: { installationId: number; action?: "install" | "request" },
  ): Promise<URL> {
    const state = new URL(startUrl).searchParams.get("state") ?? "";
    const response = await fetch(
      `${github.baseUrl}/apps/${TEST_APP_SLUG}/installations/confirm`,
      {
        method: "POST",
        body: new URLSearchParams({
          slug: TEST_APP_SLUG,
          state,
          installation_id: String(options.installationId),
          action: options.action ?? "install",
        }),
        redirect: "manual",
      },
    );
    const location = response.headers.get("location");
    if (response.status !== 302 || location === null)
      throw new Error(`The fake installation page did not redirect.`);
    return new URL(location);
  }

  /** The click on "Authorize <login>" at GitHub and the callback that follows. */
  async function authorize(
    actor: BindingActor,
    authorizeUrl: string,
    githubLogin: string,
  ): Promise<CallbackResult> {
    const callback = await github.authorize(authorizeUrl, githubLogin);
    return binding.service.completeAuthorization(actor, {
      code: callback.searchParams.get("code"),
      state: callback.searchParams.get("state"),
      error: callback.searchParams.get("error"),
    });
  }

  return {
    db,
    github,
    clock,
    now,
    advance(ms: number) {
      clock.time += ms;
    },
    settings,
    credentials,
    registry,
    sync,
    logs,
    binding,
    workspaces,
    workspace,
    person,
    accessOf,
    handlers,
    webhook,
    reviewingCollaborators,
    githubUser,
    install,
    walk,
    confirmInstallation,
    authorize,
    requests: createInstallationLinkRequestDirectory(db, now),
    unclaimed: createUnclaimedInstallationsRepository(db, now),
    /** The connections as stored: workspace, status. */
    async integrationRows() {
      return db
        .selectFrom("integrations")
        .select(["id", "workspace_id", "external_id", "status", "display_name"])
        .orderBy("external_id")
        .execute();
    },
    async repositoryRows(workspaceId?: string) {
      const query = db
        .selectFrom("repositories")
        .select(["workspace_id", "full_name", "active", "integration_id"])
        .orderBy("full_name");
      return (
        workspaceId === undefined
          ? query
          : query.where("workspace_id", "=", workspaceId)
      ).execute();
    },
    async githubAccounts(userId: string) {
      return db
        .selectFrom("accounts")
        .select(["account_id", "provider_id"])
        .where("user_id", "=", userId)
        .where("provider_id", "=", "github")
        .execute();
    },
    async userCount() {
      const row = await db
        .selectFrom("users")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow();
      return Number(row.count);
    },
  };
}

export type BindingHarness = Awaited<ReturnType<typeof createBindingHarness>>;
