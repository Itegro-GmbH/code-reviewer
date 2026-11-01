// SPDX-License-Identifier: LicenseRef-Proprietary

// The service with stand-ins for its collaborators (#756, review of #793): what a request id that was accepted before does when
// the body is not the one that made the task, and which reason the list gives for a repository the form cannot send a task to.
import { describe, expect, it, vi } from "vitest";
import {
  IntegrationError,
  type IntegrationErrorCode,
} from "../integrations/errors.ts";
import type { ModelChoice } from "../db/implementer-model-choice.ts";
import { ImplementerError, UNWRITABLE_REASONS } from "./errors.ts";
import {
  createImplementerService,
  type ImplementerServiceDependencies,
} from "./service.ts";

const USER = { id: "user-1", githubLogin: "octocat" };
const FIRST = {
  repositoryId: "repo-1",
  baseBranch: "main",
  branch: "implementer/abc123",
  instruction: "Add a health endpoint.",
  model: { entryId: "entry-1" } as ModelChoice,
  clientRequestId: "request-1",
};

/** The turn that `FIRST` made. */
function existing(
  overrides: { costLimitCents?: number | null; model?: ModelChoice } = {},
) {
  return {
    status: "existing" as const,
    job: { id: "job-1" },
    session: {
      id: "session-1",
      repositoryId: "repo-1",
      baseBranch: "main",
      branch: "implementer/abc123",
    },
    turn: {
      instruction: "Add a health endpoint.",
      modelChoice: overrides.model ?? ({ entryId: "entry-1" } as ModelChoice),
      costLimitCents: overrides.costLimitCents ?? null,
    },
  };
}

function build(options: {
  found?: ReturnType<typeof existing>;
  permissions?: () => Promise<{ contentsWrite: boolean }>;
}) {
  const platform = vi.fn(() => {
    throw new Error("the platform must not be asked");
  });
  const provider = {
    installationPermissions: options.permissions ?? platform,
    getRepositoryFacts: platform,
    getBranch: platform,
    listBranches: platform,
  };
  const integration = { id: "int-1", type: "github_app", status: "active" };
  const enqueue = vi.fn();
  const deps = {
    repositories: {
      get: async () => ({
        id: "repo-1",
        active: true,
        integrationId: "int-1",
        externalId: "1",
        fullName: "acme/widgets",
        url: "https://github.test/acme/widgets",
      }),
      list: async () => [
        {
          id: "repo-1",
          active: true,
          integrationId: "int-1",
          externalId: "1",
          fullName: "acme/widgets",
          url: "https://github.test/acme/widgets",
        },
      ],
    },
    integrations: {
      get: async () => integration,
      list: async () => [integration],
    },
    registry: { resolve: () => provider },
    models: {
      options: async () => ({ keyMode: "unreadable" }),
      check: async () => null,
    },
    queue: {
      findImplementerTurn: async () => options.found,
      enqueueImplementerTurn: enqueue,
    },
    operatorCostLimitCents: async () => 500,
    log: () => {},
  } as unknown as ImplementerServiceDependencies;
  return { service: createImplementerService(deps), platform, enqueue };
}

async function failureOf(promise: Promise<unknown>): Promise<ImplementerError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ImplementerError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("a request id that was accepted before", () => {
  // #756-T06
  it("hands back the first task for the same body, and asks the platform nothing", async () => {
    const { service, platform, enqueue } = build({ found: existing() });

    expect(await service.startTask(USER, FIRST)).toEqual({
      runId: "job-1",
      sessionId: "session-1",
      created: false,
    });
    expect(platform).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  // #756-T06
  it.each([
    ["the instruction", { instruction: "Add a readiness endpoint." }],
    ["the branch", { branch: "implementer/other1" }],
    ["the base branch", { baseBranch: "develop" }],
    ["the repository", { repositoryId: "repo-2" }],
    ["the model", { model: { entryId: "entry-2" } }],
    [
      "the model, by its form",
      { model: { provider: "deepseek", model: "chat" } },
    ],
    ["the cost limit", { costLimitCents: 200 }],
  ])(
    "is a conflict when %s is not the one of the first task, and names the first task",
    async (_name, change) => {
      const { service, enqueue } = build({ found: existing() });

      const error = await failureOf(
        service.startTask(USER, { ...FIRST, ...change }),
      );

      expect(error).toMatchObject({
        code: "IMPLEMENTER_REQUEST_REUSED",
        runId: "job-1",
      });
      expect(enqueue).not.toHaveBeenCalled();
    },
  );

  // #756-T06
  it("is a conflict when the first task had a cost limit and this body has none", async () => {
    const { service } = build({ found: existing({ costLimitCents: 200 }) });

    expect(await failureOf(service.startTask(USER, FIRST))).toMatchObject({
      code: "IMPLEMENTER_REQUEST_REUSED",
    });
  });

  // #756-T06
  it("takes an own-key model with the fields in another order for the same model", async () => {
    const own = { provider: "deepseek", model: "chat" } as ModelChoice;
    const { service } = build({ found: existing({ model: own }) });

    expect(
      await service.startTask(USER, {
        ...FIRST,
        model: { model: "chat", provider: "deepseek" },
      }),
    ).toMatchObject({ created: false });
  });
});

describe("the reason a repository cannot be sent a task", () => {
  const CASES: Array<
    [IntegrationErrorCode, (typeof UNWRITABLE_REASONS)[number]]
  > = [
    ["INTEGRATION_ACCESS_CONNECTION_GONE", "connection_gone"],
    ["INTEGRATION_ACCESS_CONNECTION_SUSPENDED", "connection_suspended"],
    ["INTEGRATION_ACCESS_APP_AUTH_FAILED", "app_auth_failed"],
    ["INTEGRATION_ACCESS_SCOPE_REFUSED", "scope_refused"],
    ["INTEGRATION_REPOSITORY_NOT_ACCESSIBLE", "repository_not_accessible"],
  ];

  // #756-T02
  it.each(CASES)("is kept apart for %s: %s", async (code, reason) => {
    const { service } = build({
      permissions: () => Promise.reject(new IntegrationError(code, "no")),
    });

    expect((await service.listRepositories()).repositories).toEqual([
      {
        id: "repo-1",
        fullName: "acme/widgets",
        writeGranted: false,
        unwritable: reason,
      },
    ]);
  });

  // #756-T02
  it("is write_not_granted for an installation that holds no contents write, and null where it does", async () => {
    const without = build({
      permissions: async () => ({ contentsWrite: false }),
    });
    const withWrite = build({
      permissions: async () => ({ contentsWrite: true }),
    });

    expect(
      (await without.service.listRepositories()).repositories[0],
    ).toMatchObject({ writeGranted: false, unwritable: "write_not_granted" });
    expect(
      (await withWrite.service.listRepositories()).repositories[0],
    ).toMatchObject({ writeGranted: true, unwritable: null });
  });

  // #756-T02
  it("fails the list for any other failure of the platform", async () => {
    const { service } = build({
      permissions: () =>
        Promise.reject(
          new IntegrationError("INTEGRATION_ACCESS_RATE_LIMITED", "slow"),
        ),
    });

    await expect(service.listRepositories()).rejects.toMatchObject({
      code: "IMPLEMENTER_GITHUB_UNAVAILABLE",
    });
  });

  it("has a reason for each no-access code of the integrations", () => {
    expect(UNWRITABLE_REASONS).toEqual([
      "write_not_granted",
      ...CASES.map(([, reason]) => reason),
    ]);
  });
});
