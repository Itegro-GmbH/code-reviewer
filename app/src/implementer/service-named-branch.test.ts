// SPDX-License-Identifier: LicenseRef-Proprietary

// #1177 (epic #1175): the start of a task whose step names the branch it pushes to (`pushBranch`). The engine sends it as a `repos` list of one
// entry and says so (`options.pushBranch`); the Implementer then refuses the default branch of the repository, the base branch, a protected
// branch, and a branch that exists and that no earlier run of the lane made. It never overwrites: a branch that is new is made from the base.
import { describe, expect, it, vi } from "vitest";
import type { ModelChoice } from "../db/implementer-model-choice.ts";
import { ImplementerError } from "./errors.ts";
import {
  createImplementerService,
  type ImplementerServiceDependencies,
} from "./service.ts";

const USER = { id: "user-1", githubLogin: "octocat" };

const ROWS = [
  ["repo-app", "int-1", "Acme/App", "development"],
  ["repo-lib", "int-1", "Acme/lib", "main"],
  ["repo-other-app", "int-2", "Other/app", "main"],
] as const;

type Options = {
  branches?: Record<string, string[]>;
  protectedBranches?: string[];
  write?: Record<string, boolean>;
  found?: unknown;
};

function build(options: Options = {}) {
  const enqueue = vi.fn(async (input: { repos?: unknown[] }) => ({
    status: "created" as const,
    job: { id: "job-1" },
    session: { id: "session-1", repos: input.repos },
    turn: {},
  }));
  const integrations = new Map(
    ["int-1", "int-2"].map((id) => [
      id,
      { id, type: "github_app", status: "active" },
    ]),
  );
  const rowOf = (id: string) => ROWS.find((row) => row[0] === id);
  const deps = {
    repositories: {
      get: async (id: string) => {
        const row = rowOf(id);
        return row === undefined
          ? undefined
          : {
              id: row[0],
              active: true,
              integrationId: row[1],
              externalId: String(ROWS.indexOf(row) + 1),
              fullName: row[2],
              url: `https://github.test/${row[2]}`,
            };
      },
    },
    integrations: { get: async (id: string) => integrations.get(id) },
    registry: {
      resolve: () => ({
        installationPermissions: async (integration: { id: string }) => ({
          contentsWrite: options.write?.[integration.id] ?? true,
        }),
        getRepositoryFacts: async (
          _i: unknown,
          repo: { fullName: string },
        ) => ({
          defaultBranch: rowOf(
            ROWS.find((row) => row[2] === repo.fullName)?.[0] ?? "",
          )?.[3],
        }),
        listBranches: async (_i: unknown, repo: { fullName: string }) => ({
          names: options.branches?.[repo.fullName] ?? ["main", "development"],
          truncated: false,
        }),
        getBranch: async (
          _i: unknown,
          repo: { fullName: string },
          name: string,
        ) =>
          (
            options.branches?.[repo.fullName] ?? ["main", "development"]
          ).includes(name)
            ? {
                name,
                sha: `${name}`.padEnd(40, "a").slice(0, 40),
                protected: options.protectedBranches?.includes(name) === true,
              }
            : null,
      }),
    },
    profiles: { findByName: async () => undefined },
    models: {
      options: async () => ({ keyMode: "unreadable" }),
      check: async () => null,
    },
    environments: { get: async () => undefined },
    queue: {
      findImplementerTurn: async () => options.found,
      enqueueImplementerTurn: enqueue,
    },
    operatorCostLimitCents: async () => 500,
    log: () => {},
  } as unknown as ImplementerServiceDependencies;
  return { service: createImplementerService(deps), enqueue };
}

const TASK = {
  branch: "workflow/run-1/implement",
  instruction: "Do it.",
  model: { entryId: "entry-1" } as ModelChoice,
  clientRequestId: "wf-run-1-0",
};

const NAMED = {
  ...TASK,
  repos: [{ repositoryId: "repo-lib", base: "main", branch: "agent/handoff" }],
};

function options(madeByLane = false) {
  return {
    workflowStep: true,
    pushBranch: { madeByLane: vi.fn(async () => madeByLane) },
  };
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

describe("a task that pushes to a branch the step names", () => {
  // #1177-T20
  it("makes a new branch from the base and keeps the platform's name as the key of the session", async () => {
    const { service, enqueue } = build();
    await service.startTask(USER, NAMED, options());
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({
      branch: "workflow/run-1/implement",
      repos: [
        { repositoryId: "repo-lib", base: "main", branch: "agent/handoff" },
      ],
    });
  });

  // #1177-T21
  it("refuses the default branch of the repository and the base branch, before anything is written", async () => {
    // The default branch of Acme/lib is main; a task that names the base as its branch would work on it directly.
    for (const branch of ["main", "development"]) {
      const { service, enqueue } = build();
      const base = "development";
      const error = await failureOf(
        service.startTask(
          USER,
          { ...TASK, repos: [{ repositoryId: "repo-lib", base, branch }] },
          options(),
        ),
      );
      expect(error.code, branch).toBe("IMPLEMENTER_REQUEST_INVALID");
      expect(error.repoIndex).toBe(0);
      expect(enqueue).not.toHaveBeenCalled();
    }
  });

  // #1177-T22
  it("refuses a protected branch, also one an earlier run of the lane made", async () => {
    const { service, enqueue } = build({
      branches: { "Acme/lib": ["main", "release"] },
      protectedBranches: ["release"],
    });
    const error = await failureOf(
      service.startTask(
        USER,
        {
          ...TASK,
          repos: [
            { repositoryId: "repo-lib", base: "main", branch: "release" },
          ],
        },
        options(true),
      ),
    );
    expect(error.code).toBe("IMPLEMENTER_BRANCH_PROTECTED");
    expect(enqueue).not.toHaveBeenCalled();
  });

  // #1177-T23
  it("refuses a branch that exists on the remote when no earlier run of the lane made it", async () => {
    const { service, enqueue } = build({
      branches: { "Acme/lib": ["main", "agent/handoff"] },
    });
    const given = options(false);
    const error = await failureOf(service.startTask(USER, NAMED, given));
    expect(error.code).toBe("IMPLEMENTER_BRANCH_EXISTS");
    expect(error.repoIndex).toBe(0);
    expect(given.pushBranch.madeByLane).toHaveBeenCalledWith(
      "repo-lib",
      "agent/handoff",
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  // #1177-T24
  it("continues a branch that exists when an earlier run of the lane made it", async () => {
    const { service, enqueue } = build({
      branches: { "Acme/lib": ["main", "agent/handoff"] },
    });
    await service.startTask(USER, NAMED, options(true));
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  // #1177-T25
  it("refuses a name that is a folder of a branch of the repository or the other way round", async () => {
    const { service, enqueue } = build({
      branches: { "Acme/lib": ["main", "agent"] },
    });
    const error = await failureOf(service.startTask(USER, NAMED, options()));
    expect(error.code).toBe("IMPLEMENTER_BRANCH_CONFLICT");
    expect(enqueue).not.toHaveBeenCalled();
  });

  // #1177-T26
  it("asks nothing more of a task that has no named branch", async () => {
    const { service } = build({ branches: { "Acme/lib": ["main", "x"] } });
    await service.startTask(
      USER,
      {
        ...TASK,
        repos: [{ repositoryId: "repo-lib", base: "main", branch: "x" }],
      },
      { workflowStep: true },
    );
  });
});
