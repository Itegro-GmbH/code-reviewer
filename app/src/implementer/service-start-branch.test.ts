// SPDX-License-Identifier: LicenseRef-Proprietary

// #909: a task may name the branch its new branch is made from, apart from the base branch it is compared with. The service looks for
// that branch on the platform like it does for the base, starts the task at its tip, and hands it to the queue next to the base.
import { describe, expect, it, vi } from "vitest";
import type { ModelChoice } from "../db/implementer-model-choice.ts";
import { ImplementerError } from "./errors.ts";
import {
  createImplementerService,
  type ImplementerServiceDependencies,
} from "./service.ts";

const USER = { id: "user-1", githubLogin: "octocat" };
const MAIN_SHA = "a".repeat(40);
const FEATURE_SHA = "b".repeat(40);
const TASK = {
  repositoryId: "repo-1",
  baseBranch: "main",
  branch: "workflow/run-1/review",
  instruction: "Review it.",
  model: { entryId: "entry-1" } as ModelChoice,
  clientRequestId: "request-1",
};

function build() {
  const branches: Record<string, { sha: string }> = {
    main: { sha: MAIN_SHA },
    "workflow/run-1/implement": { sha: FEATURE_SHA },
  };
  const provider = {
    installationPermissions: async () => ({ contentsWrite: true }),
    getRepositoryFacts: async () => ({ defaultBranch: "main" }),
    getBranch: vi.fn(
      async (_integration: unknown, _repo: unknown, name: string) =>
        branches[name] ?? null,
    ),
    listBranches: async () => ({
      names: Object.keys(branches),
      truncated: false,
    }),
  };
  const integration = { id: "int-1", type: "github_app", status: "active" };
  const repository = {
    id: "repo-1",
    active: true,
    integrationId: "int-1",
    externalId: "1",
    fullName: "acme/widgets",
    url: "https://github.test/acme/widgets",
  };
  const enqueue = vi.fn(async () => ({
    status: "created" as const,
    job: { id: "job-1" },
    session: { id: "session-1" },
  }));
  const deps = {
    repositories: {
      get: async () => repository,
      list: async () => [repository],
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
      findImplementerTurn: async () => undefined,
      enqueueImplementerTurn: enqueue,
    },
    operatorCostLimitCents: async () => 500,
    log: () => {},
  } as unknown as ImplementerServiceDependencies;
  return { service: createImplementerService(deps), enqueue };
}

describe("a task with a start branch", () => {
  // #909-T03
  it("starts at the tip of the start branch and hands both branches to the queue", async () => {
    const app = build();

    await app.service.startTask(USER, {
      ...TASK,
      startBranch: "workflow/run-1/implement",
    });

    expect(app.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        baseBranch: "main",
        startBranch: "workflow/run-1/implement",
        baseSha: FEATURE_SHA,
        branch: "workflow/run-1/review",
      }),
    );
  });

  // #909-T03
  it("starts at the tip of the base and sends no start branch when the task names none", async () => {
    const app = build();

    await app.service.startTask(USER, TASK);

    const [input] = app.enqueue.mock.calls[0] as unknown as [
      Record<string, unknown>,
    ];
    expect(input).toMatchObject({ baseBranch: "main", baseSha: MAIN_SHA });
    expect(input).not.toHaveProperty("startBranch");
  });

  // #909-T04
  it("is refused as a missing branch, before anything is queued, when the platform has no such start branch", async () => {
    const app = build();

    const refused = await app.service
      .startTask(USER, { ...TASK, startBranch: "gone/branch" })
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(ImplementerError);
    expect(refused).toMatchObject({
      code: "IMPLEMENTER_BASE_BRANCH_NOT_FOUND",
    });
    expect(app.enqueue).not.toHaveBeenCalled();
  });

  // #909-T07
  it("is refused as invalid when the start branch is not a branch name or is the new branch", async () => {
    const app = build();

    for (const startBranch of ["bad name", TASK.branch]) {
      const refused = await app.service
        .startTask(USER, { ...TASK, startBranch })
        .catch((error: unknown) => error);
      expect(refused).toMatchObject({ code: "IMPLEMENTER_REQUEST_INVALID" });
    }
    expect(app.enqueue).not.toHaveBeenCalled();
  });
});
