// SPDX-License-Identifier: LicenseRef-Proprietary

// Everything a test of the Implementer's service needs (#755): the webhook harness (a real Postgres database, the fake GitHub API,
// the real GitHub App provider behind a registry), an installation "acme" with the repository "acme/widgets" whose App asks for
// contents write and that has accepted it, a user, the real job queue and the service wired to all of them. The model check is
// a stand-in that allows everything unless a test says otherwise; the rule itself is proven in src/implementer/models.test.ts.
import type { FakePermissions } from "../../../fakes/github/server.ts";
import { createImplementerService } from "../implementer/service.ts";
import type { ImplementerModels } from "../implementer/models.ts";
import { createTestQueue } from "./jobs.ts";
import { addUser } from "./workspace-deletion-fixture.ts";
import { startWebhookHarness } from "./webhook-harness.ts";

export const READ_ONLY: FakePermissions = {
  metadata: "read",
  contents: "read",
  pull_requests: "write",
  issues: "write",
  checks: "write",
};
export const WITH_WRITE: FakePermissions = { ...READ_ONLY, contents: "write" };

/** The commit the fake GitHub gives the default branch of a repository without a Git fixture. */
export const BASE_SHA = "b".repeat(40);

export const USER = { id: "user-1", githubLogin: "octocat" };

export const ALLOW_ALL: ImplementerModels = {
  options: async () => ({ keyMode: "managed", entries: [] }),
  check: async () => null,
};

export async function startImplementerHarness(
  options: {
    requestTimeoutMs?: number;
    /** What the installation has accepted; default: contents write. */
    accepted?: FakePermissions;
    models?: ImplementerModels;
    operatorCostLimitCents?: number;
  } = {},
) {
  const h = await startWebhookHarness({
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
  });
  const integration = await h.seedInstallation({ activateProject: false });
  const [repository] = await h.repositories.list({
    integrationId: integration.id,
  });
  if (repository === undefined) throw new Error("seeding failed");
  // seedInstallation adds pull request 7; the tests set up their own.
  h.fake.reset();
  h.fake.setAppPermissions(WITH_WRITE);
  h.fake.addInstallation({
    id: 4242,
    account: { login: "acme", id: 5001, type: "Organization" },
  });
  h.fake.setInstallationPermissions(4242, options.accepted ?? WITH_WRITE);
  h.fake.setRepositories(4242, [{ id: 7001, fullName: "acme/widgets" }]);
  await addUser(h.db, USER.id);

  const queue = createTestQueue(h.db, h.workspaceId);
  const lines: string[] = [];
  const service = createImplementerService({
    repositories: h.repositories,
    integrations: h.integrations,
    registry: h.registry,
    models: options.models ?? ALLOW_ALL,
    queue,
    operatorCostLimitCents: async () => options.operatorCostLimitCents ?? 500,
    log: (line) => lines.push(line),
  });

  /** The rows a submit writes, for "nothing was written" assertions. */
  async function counts() {
    const count = async (
      table: "jobs" | "implementer_sessions" | "implementer_turns",
    ) =>
      Number(
        (
          await h.db
            .selectFrom(table)
            .select((eb) => eb.fn.countAll().as("n"))
            .executeTakeFirstOrThrow()
        ).n,
      );
    return {
      jobs: await count("jobs"),
      sessions: await count("implementer_sessions"),
      turns: await count("implementer_turns"),
    };
  }

  /** A body that a person's form sends; every field can be replaced. */
  const body = (overrides: Record<string, unknown> = {}) => ({
    repositoryId: repository.id,
    baseBranch: "main",
    branch: "implementer/abc123",
    instruction: "Add a health endpoint.",
    model: { entryId: "entry-1" },
    clientRequestId: "request-1",
    ...overrides,
  });

  return { h, repository, integration, service, queue, lines, counts, body };
}

export type ImplementerHarness = Awaited<
  ReturnType<typeof startImplementerHarness>
>;
