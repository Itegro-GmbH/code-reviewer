// SPDX-License-Identifier: LicenseRef-Proprietary

// #1092 (epic #1090, ADR 0006): the start of a task on several repositories (a step of a lane with `repos`): each repository must be one of the
// workspace with an active integration, writable when the turn may push, with a base branch that exists (the default branch when none is named);
// the session keeps the list as resolved, with the mount names. Only the engine may send `repos`, never a request body.
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
        getBranch: async (
          _i: unknown,
          repo: { fullName: string },
          name: string,
        ) =>
          (
            options.branches?.[repo.fullName] ?? ["main", "development"]
          ).includes(name)
            ? { name, sha: `${name}`.padEnd(40, "a").slice(0, 40) }
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

const OPTIONS = { workflowStep: true };

async function failureOf(promise: Promise<unknown>): Promise<ImplementerError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ImplementerError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("a task on several repositories", () => {
  // #1092-T30
  it("resolves the default branch as the base and the base as the branch, and keeps the list with the mount names", async () => {
    const { service, enqueue } = build();

    const started = await service.startTask(
      USER,
      {
        ...TASK,
        repos: [
          { repositoryId: "repo-app" },
          { repositoryId: "repo-lib", base: "main", branch: "feature/x" },
          { repositoryId: "repo-other-app" },
        ],
      },
      OPTIONS,
    );

    expect(started).toEqual({
      runId: "job-1",
      sessionId: "session-1",
      created: true,
    });
    const call = enqueue.mock.calls[0]?.[0] as unknown as Record<
      string,
      unknown
    >;
    expect(call.repositoryId).toBe("repo-app");
    expect(call.baseBranch).toBe("development");
    expect(call.branch).toBe("workflow/run-1/implement");
    expect(call.repos).toEqual([
      {
        repositoryId: "repo-app",
        fullName: "Acme/App",
        name: "Acme__App",
        base: "development",
        branch: "development",
      },
      {
        repositoryId: "repo-lib",
        fullName: "Acme/lib",
        name: "lib",
        base: "main",
        branch: "feature/x",
      },
      {
        repositoryId: "repo-other-app",
        fullName: "Other/app",
        name: "Other__app",
        base: "main",
        branch: "main",
      },
    ]);
  });

  // #1092-T31
  it("refuses a repository without the right to write when the turn may push, naming its place in the list", async () => {
    const { service, enqueue } = build({ write: { "int-2": false } });
    const error = await failureOf(
      service.startTask(
        USER,
        {
          ...TASK,
          repos: [
            { repositoryId: "repo-app" },
            { repositoryId: "repo-other-app" },
          ],
        },
        OPTIONS,
      ),
    );
    expect(error.code).toBe("IMPLEMENTER_WRITE_NOT_GRANTED");
    expect(error.repoIndex).toBe(1);
    expect(enqueue).not.toHaveBeenCalled();
  });

  // #1092-T32
  it("refuses a base branch the repository does not have, and a repository that is not one of the workspace", async () => {
    const { service } = build({ branches: { "Acme/lib": ["main"] } });
    const base = await failureOf(
      service.startTask(
        USER,
        {
          ...TASK,
          repos: [
            { repositoryId: "repo-app" },
            { repositoryId: "repo-lib", base: "nope" },
          ],
        },
        OPTIONS,
      ),
    );
    expect(base.code).toBe("IMPLEMENTER_BASE_BRANCH_NOT_FOUND");
    expect(base.repoIndex).toBe(1);

    const missing = await failureOf(
      service.startTask(
        USER,
        { ...TASK, repos: [{ repositoryId: "repo-gone" }] },
        OPTIONS,
      ),
    );
    expect(missing.code).toBe("IMPLEMENTER_REPOSITORY_NOT_FOUND");
    expect(missing.repoIndex).toBe(0);
  });

  // #1092-T33
  it("never takes repos from a request body: only the engine may send them", async () => {
    const { service, enqueue } = build();
    const error = await failureOf(
      service.startTask(USER, {
        ...TASK,
        clientRequestId: "request-1",
        repositoryId: "repo-app",
        baseBranch: "main",
        repos: [{ repositoryId: "repo-app" }],
      }),
    );
    expect(error.code).toBe("IMPLEMENTER_REQUEST_INVALID");
    expect(error.issues.map((i) => i.field)).toContain("repos");
    expect(enqueue).not.toHaveBeenCalled();
  });

  // #1092-T34
  it("refuses a repository named twice and entries that are not repositories", async () => {
    const { service } = build();
    for (const repos of [
      [{ repositoryId: "repo-app" }, { repositoryId: "repo-app" }],
      [],
      [{ repositoryId: "repo-app", remote: "x" }],
      Array.from({ length: 11 }, () => ({ repositoryId: "repo-app" })),
    ])
      expect(
        (await failureOf(service.startTask(USER, { ...TASK, repos }, OPTIONS)))
          .code,
      ).toBe("IMPLEMENTER_REQUEST_INVALID");
  });

  // #1092-T35
  it("hands back the first task for a repeated request, and takes a base that moved for the same", async () => {
    const stored = [
      {
        repositoryId: "repo-app",
        fullName: "Acme/App",
        name: "Acme__App",
        base: "old-default",
        branch: "old-default",
      },
    ];
    const found = {
      status: "existing",
      job: { id: "job-1" },
      session: {
        id: "session-1",
        repositoryId: "repo-app",
        baseBranch: "old-default",
        branch: "workflow/run-1/implement",
        repos: stored,
      },
      turn: {
        instruction: "Do it.",
        modelChoice: { entryId: "entry-1" },
        costLimitCents: null,
        profile: null,
      },
    };
    const { service, enqueue } = build({ found });
    expect(
      await service.startTask(
        USER,
        { ...TASK, repos: [{ repositoryId: "repo-app" }] },
        OPTIONS,
      ),
    ).toEqual({ runId: "job-1", sessionId: "session-1", created: false });
    // A repository that was not the first's is another task.
    expect(
      (
        await failureOf(
          service.startTask(
            USER,
            { ...TASK, repos: [{ repositoryId: "repo-lib" }] },
            OPTIONS,
          ),
        )
      ).code,
    ).toBe("IMPLEMENTER_REQUEST_REUSED");
    expect(enqueue).not.toHaveBeenCalled();
  });
});
