// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the service behind the Implementer form (#755), with the real service, the real GitHub App provider and client against
// the fake GitHub, the real job queue and a real Postgres database: which repositories and branches a person can pick, and the
// submit that checks them again (the browser names ids and words, GitHub and the database decide) before it writes a session, a
// turn and a job in one transaction.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createGitRepository } from "../../../fakes/github/git-fixture.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import { cleanUpAfterTest } from "../test-support/test-database.ts";
import { seedImplementerRepository } from "../test-support/implementer.ts";
import { createTestQueue } from "../test-support/jobs.ts";
import {
  ALLOW_ALL,
  BASE_SHA,
  READ_ONLY,
  USER,
  WITH_WRITE,
  startImplementerHarness,
} from "../test-support/implementer-harness.ts";
import type { ImplementerModels } from "./models.ts";

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
}

describe("the repositories of the form", () => {
  // #755-T01
  it("lists the active repositories of the workspace with the write permission the installation holds", async () => {
    const { service, repository } = await startImplementerHarness();

    expect(await service.listRepositories()).toEqual({
      repositories: [
        {
          id: repository.id,
          fullName: "acme/widgets",
          writeGranted: true,
          unwritable: null,
        },
      ],
    });
  });

  // #755-T01
  it("says write access is not granted for an installation that holds contents read only, and true once it accepts", async () => {
    const { h, service, repository } = await startImplementerHarness({
      accepted: READ_ONLY,
    });

    expect((await service.listRepositories()).repositories).toEqual([
      {
        id: repository.id,
        fullName: "acme/widgets",
        writeGranted: false,
        unwritable: "write_not_granted",
      },
    ]);

    h.fake.setInstallationPermissions(4242, WITH_WRITE);
    expect((await service.listRepositories()).repositories).toEqual([
      {
        id: repository.id,
        fullName: "acme/widgets",
        writeGranted: true,
        unwritable: null,
      },
    ]);
  });

  // #755-T01
  it("lists a repository without a project: the repositories of the workspace, not only the reviewed ones", async () => {
    const { h, service, repository } = await startImplementerHarness();

    expect(await h.projects.getActiveProjectForRepository(repository.id)).toBe(
      undefined,
    );
    expect((await service.listRepositories()).repositories).toHaveLength(1);
  });

  // #755-T01
  it("never lists a repository the platform no longer lists, one of a disabled integration, or one of another workspace", async () => {
    const { h, service, integration } = await startImplementerHarness();
    const other = await addWorkspace(h.db, "other");
    await seedImplementerRepository(h.db, other, "elsewhere");

    // Another workspace's repository is simply not there.
    expect(
      (await service.listRepositories()).repositories.map((r) => r.fullName),
    ).toEqual(["acme/widgets"]);

    await h.repositories.reconcile(integration.id, []);
    expect((await service.listRepositories()).repositories).toEqual([]);
  });

  // #791
  it("does not list the repositories of a disabled or disconnected integration, though they are still active", async () => {
    const { h, service, integration } = await startImplementerHarness();
    expect((await service.listRepositories()).repositories).toHaveLength(1);

    for (const status of ["disabled", "disconnected"] as const) {
      await h.integrations.setStatus(integration.id, status);
      // The repository row is still active: only the integration says it is not usable.
      expect(
        (await h.repositories.list({ active: true })).map((r) => r.fullName),
      ).toEqual(["acme/widgets"]);
      expect((await service.listRepositories()).repositories, status).toEqual(
        [],
      );
    }
  });

  // #755-T01
  it("asks the platform once for each installation, however many repositories it has", async () => {
    const { h, service, integration } = await startImplementerHarness();
    h.fake.setRepositories(4242, [
      { id: 7001, fullName: "acme/widgets" },
      { id: 7002, fullName: "acme/gadgets" },
    ]);
    await h.repositories.reconcile(integration.id, [
      {
        integrationId: integration.id,
        externalId: "7001",
        fullName: "acme/widgets",
        url: "https://github.test/acme/widgets",
      },
      {
        integrationId: integration.id,
        externalId: "7002",
        fullName: "acme/gadgets",
        url: "https://github.test/acme/gadgets",
      },
    ]);
    const asked = vi.spyOn(
      h.registry.resolve("github_app"),
      "installationPermissions",
    );

    const { repositories } = await service.listRepositories();

    expect(repositories.map((r) => r.fullName)).toEqual([
      "acme/gadgets",
      "acme/widgets",
    ]);
    expect(asked).toHaveBeenCalledTimes(1);
  });

  // #755-T01
  it("lists an installation the platform has removed as not writable instead of failing the list", async () => {
    const { h, service } = await startImplementerHarness();
    h.fake.fail({ pathIncludes: "/app/installations/4242", status: 404 });

    expect((await service.listRepositories()).repositories).toMatchObject([
      {
        fullName: "acme/widgets",
        writeGranted: false,
        unwritable: "connection_gone",
      },
    ]);
  });

  // #755-T13
  it("reports the platform failing as unavailable, with no repository list", async () => {
    const { h, service } = await startImplementerHarness();
    h.fake.fail({ pathIncludes: "/app/installations/4242", status: 500 });

    expect(await failureOf(service.listRepositories())).toMatchObject({
      code: "IMPLEMENTER_GITHUB_UNAVAILABLE",
    });
  });
});

describe("the branches of the form", () => {
  // #755-T02
  it("gives the default branch, flagged by its own field, first in the list", async () => {
    const { h, service, repository } = await startImplementerHarness();
    h.fake.addPullRequest("acme/widgets", {
      number: 1,
      title: "x",
      state: "open",
      headSha: "1".repeat(40),
      headRef: "feature/a",
      baseRef: "main",
      author: { login: "alice", id: 1 },
    });

    expect(await service.listBranches(repository.id)).toEqual({
      defaultBranch: "main",
      branches: ["main", "feature/a"],
      truncated: false,
    });
  });

  // #755-T02
  it("caps the list at one hundred names and says so", async () => {
    const { h, service, repository } = await startImplementerHarness();
    const directory = mkdtempSync(join(tmpdir(), "cr-755-branches-"));
    cleanUpAfterTest(async () => {
      await Promise.resolve();
      rmSync(directory, { recursive: true, force: true });
    });
    const git = createGitRepository(join(directory, "widgets"), {
      defaultBranch: "trunk",
    });
    const base = git.commit({ "README.md": "base\n" }, "Base");
    for (let n = 0; n < 120; n += 1)
      git.setRef(`refs/heads/b${String(n).padStart(3, "0")}`, base);
    h.fake.addGitRepository("acme/widgets", git.path);

    const result = await service.listBranches(repository.id);

    expect(result.defaultBranch).toBe("trunk");
    expect(result.branches).toHaveLength(100);
    expect(result.branches[0]).toBe("trunk");
    expect(result.truncated).toBe(true);
  });

  // #755-T02
  it.each([401, 403, 404])(
    "reports GitHub answering %i as the app not being installed",
    async (status) => {
      const { h, service, repository } = await startImplementerHarness();
      h.fake.fail({ pathIncludes: "/branches", status });

      expect(
        await failureOf(service.listBranches(repository.id)),
      ).toMatchObject({ code: "IMPLEMENTER_APP_NOT_INSTALLED" });
    },
  );

  // #755-T02
  it("reports GitHub failing as unavailable", async () => {
    const { h, service, repository } = await startImplementerHarness();
    h.fake.fail({ pathIncludes: "/branches", status: 500 });

    expect(await failureOf(service.listBranches(repository.id))).toMatchObject({
      code: "IMPLEMENTER_GITHUB_UNAVAILABLE",
    });
  });

  // #755-T02
  it("asks for the list only after the repository read worked, so no call is left running when the request is answered", async () => {
    const { h, service, repository } = await startImplementerHarness();
    h.fake.fail({ pathIncludes: "/repos/acme/widgets", status: 404 });
    const before = h.fake.requests().length;

    expect(await failureOf(service.listBranches(repository.id))).toMatchObject({
      code: "IMPLEMENTER_APP_NOT_INSTALLED",
    });

    // One token, one read: a second call started beside the first would have minted a token of its own.
    expect(
      h.fake
        .requests()
        .slice(before)
        .map((request) => `${request.method} ${request.path}`),
    ).toEqual([
      "POST /app/installations/4242/access_tokens",
      "GET /repos/acme/widgets",
      "DELETE /installation/token",
    ]);
  });

  // #755-T01
  it("answers not found for a repository of another workspace or nobody, and does not ask GitHub", async () => {
    const { h, service } = await startImplementerHarness();
    const other = await addWorkspace(h.db, "other");
    const seeded = await seedImplementerRepository(h.db, other, "elsewhere");
    const before = h.fake.requests().length;

    for (const id of [seeded.repositoryId, "no-such-id"])
      expect(await failureOf(service.listBranches(id))).toMatchObject({
        code: "IMPLEMENTER_REPOSITORY_NOT_FOUND",
      });
    expect(h.fake.requests()).toHaveLength(before);
  });

  it("answers the app not being installed for a disabled integration, without asking GitHub", async () => {
    const { h, service, repository, integration } =
      await startImplementerHarness();
    await h.integrations.setStatus(integration.id, "disabled");
    const before = h.fake.requests().length;

    expect(await failureOf(service.listBranches(repository.id))).toMatchObject({
      code: "IMPLEMENTER_APP_NOT_INSTALLED",
    });
    expect(h.fake.requests()).toHaveLength(before);
  });
});

describe("starting a task", () => {
  // #755-T03
  it("writes a session, a turn and a queued job, and answers with the ids of the run and the session", async () => {
    const { h, service, repository, body, counts } =
      await startImplementerHarness();

    const started = await service.startTask(USER, body());

    expect(started).toMatchObject({ created: true });
    expect(await counts()).toEqual({ jobs: 1, sessions: 1, turns: 1 });
    const job = await h.db
      .selectFrom("jobs")
      .selectAll()
      .where("id", "=", started.runId)
      .executeTakeFirstOrThrow();
    expect(job).toMatchObject({
      repository_id: repository.id,
      review_kind: "implementer",
      trigger_kind: "manual",
      status: "queued",
      actor_login: "octocat",
      pr_number: -1,
      head_sha: BASE_SHA,
      pr_url: "https://github.test/acme/widgets/tree/implementer/abc123",
    });
    const session = await h.db
      .selectFrom("implementer_sessions")
      .selectAll()
      .where("id", "=", started.sessionId)
      .executeTakeFirstOrThrow();
    expect(session).toMatchObject({
      repository_id: repository.id,
      base_branch: "main",
      branch: "implementer/abc123",
      created_by: USER.id,
    });
    const turn = await h.db
      .selectFrom("implementer_turns")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(turn).toMatchObject({
      session_id: started.sessionId,
      job_id: started.runId,
      instruction: "Add a health endpoint.",
      cost_limit_cents: null,
    });
  });

  // #755-T03
  it("hands the same ids back for a repeated client request id and writes nothing", async () => {
    const { service, body, counts } = await startImplementerHarness();
    const first = await service.startTask(USER, body());
    const before = await counts();

    const again = await service.startTask(USER, body());

    expect(again).toEqual({ ...first, created: false });
    expect(await counts()).toEqual(before);
  });

  // #756 (review of #793)
  it.each([
    ["the instruction", { instruction: "Something else." }],
    ["the branch", { branch: "implementer/other1" }],
    ["the model", { model: { entryId: "entry-2" } }],
    ["the cost limit", { costLimitCents: 100 }],
  ])(
    "refuses a repeated client request id with another %s as another task, names the first run, and writes nothing",
    async (_name, change) => {
      const { service, body, counts } = await startImplementerHarness();
      const first = await service.startTask(USER, body());
      const before = await counts();

      const error = await failureOf(
        service.startTask(USER, body(change as Record<string, unknown>)),
      );

      expect(error).toMatchObject({
        code: "IMPLEMENTER_REQUEST_REUSED",
        runId: first.runId,
      });
      expect(await counts()).toEqual(before);
    },
  );

  // #755-T03
  it("takes the instruction as written and the model as chosen", async () => {
    const { h, service, body } = await startImplementerHarness();
    const instruction = "  Do this.\n\nThen that.\n";

    await service.startTask(
      USER,
      body({
        instruction,
        model: { provider: "deepseek", model: "deepseek-chat" },
      }),
    );

    const turn = await h.db
      .selectFrom("implementer_turns")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(turn.instruction).toBe(instruction);
    expect(JSON.parse(turn.model_choice)).toEqual({
      provider: "deepseek",
      model: "deepseek-chat",
    });
  });

  // #755-T05
  it("links a branch with `#` or `%` in its name to the branch, encoded (`?` and `..` are refused as git refuses them)", async () => {
    const { h, service, body } = await startImplementerHarness();

    const started = await service.startTask(
      USER,
      body({ branch: "feature/a#b%d" }),
    );

    const job = await h.db
      .selectFrom("jobs")
      .select("pr_url")
      .where("id", "=", started.runId)
      .executeTakeFirstOrThrow();
    expect(job.pr_url).toBe(
      "https://github.test/acme/widgets/tree/feature/a%23b%25d",
    );
  });

  // #755-T04
  it("asks the repository first, then the base branch, then the new one, and only then writes", async () => {
    const { h, service, body } = await startImplementerHarness();
    const before = h.fake.requests().length;

    await service.startTask(USER, body());

    const paths = h.fake
      .requests()
      .slice(before)
      .map((request) => request.path)
      .filter((path) => /^\/repos\/acme\/widgets(\/branches\/.*)?$/.test(path));
    // Then the list of branches, for a name that cannot live beside one of them (#791).
    expect(paths.slice(0, 3)).toEqual([
      "/repos/acme/widgets",
      "/repos/acme/widgets/branches/main",
      "/repos/acme/widgets/branches/implementer%2Fabc123",
    ]);
    expect(paths.length).toBeGreaterThan(3);
  });

  // #755-T04
  it("refuses a new branch that exists on GitHub with IMPLEMENTER_BRANCH_EXISTS and writes nothing", async () => {
    const { h, service, body, counts } = await startImplementerHarness();
    h.fake.addPullRequest("acme/widgets", {
      number: 1,
      title: "x",
      state: "open",
      headSha: "1".repeat(40),
      headRef: "implementer/abc123",
      baseRef: "main",
      author: { login: "alice", id: 1 },
    });

    expect(await failureOf(service.startTask(USER, body()))).toMatchObject({
      code: "IMPLEMENTER_BRANCH_EXISTS",
    });
    expect(await counts()).toEqual({ jobs: 0, sessions: 0, turns: 0 });
  });

  // #755-T04
  it("refuses an unknown base branch with IMPLEMENTER_BASE_BRANCH_NOT_FOUND and writes nothing", async () => {
    const { service, body, counts } = await startImplementerHarness();

    expect(
      await failureOf(service.startTask(USER, body({ baseBranch: "nope" }))),
    ).toMatchObject({ code: "IMPLEMENTER_BASE_BRANCH_NOT_FOUND" });
    expect(await counts()).toEqual({ jobs: 0, sessions: 0, turns: 0 });
  });

  // #755-T04
  it("refuses a new branch equal to the base branch as an invalid request, before it asks GitHub", async () => {
    const { h, service, body, counts } = await startImplementerHarness();
    const before = h.fake.requests().length;

    expect(
      await failureOf(service.startTask(USER, body({ branch: "main" }))),
    ).toMatchObject({
      code: "IMPLEMENTER_REQUEST_INVALID",
      issues: [{ field: "branch", code: "same_as_base" }],
    });
    expect(h.fake.requests()).toHaveLength(before);
    expect(await counts()).toEqual({ jobs: 0, sessions: 0, turns: 0 });
  });

  // #755-T05, #755-T06
  it("refuses a body that breaks the rules with the issues named, before anything is read", async () => {
    const { h, service, body, counts } = await startImplementerHarness();
    const before = h.fake.requests().length;

    expect(
      await failureOf(
        service.startTask(USER, body({ branch: "a..b", instruction: " " })),
      ),
    ).toMatchObject({
      code: "IMPLEMENTER_REQUEST_INVALID",
      issues: [
        { field: "branch", code: "double_dot" },
        { field: "instruction", code: "required" },
      ],
    });
    expect(h.fake.requests()).toHaveLength(before);
    expect(await counts()).toEqual({ jobs: 0, sessions: 0, turns: 0 });
  });

  // #755 (review of #785)
  it("says a new branch name is needed when a session of the repository holds the name already, also when GitHub has no such branch", async () => {
    const { service, body, counts } = await startImplementerHarness();
    await service.startTask(USER, body());

    const error = await failureOf(
      service.startTask(USER, body({ clientRequestId: "request-2" })),
    );

    expect(error).toMatchObject({ code: "IMPLEMENTER_BRANCH_EXISTS" });
    expect((error as Error).message).toMatch(/new branch name/i);
    expect(await counts()).toEqual({ jobs: 1, sessions: 1, turns: 1 });
  });

  // #755-T11
  it("lets exactly one of two submits with the same new branch through", async () => {
    const { service, body, counts } = await startImplementerHarness();

    const results = await Promise.allSettled([
      service.startTask(USER, body({ clientRequestId: "request-a" })),
      service.startTask(USER, body({ clientRequestId: "request-b" })),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.filter((r) => r.status === "rejected");
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "IMPLEMENTER_BRANCH_EXISTS",
    });
    expect(await counts()).toEqual({ jobs: 1, sessions: 1, turns: 1 });
  });

  // #755-T08
  it("refuses an installation that has not accepted contents write with IMPLEMENTER_WRITE_NOT_GRANTED, before it reads a branch", async () => {
    const { h, service, body, counts } = await startImplementerHarness({
      accepted: READ_ONLY,
    });
    const before = h.fake.requests().length;

    expect(await failureOf(service.startTask(USER, body()))).toMatchObject({
      code: "IMPLEMENTER_WRITE_NOT_GRANTED",
    });
    expect(
      h.fake
        .requests()
        .slice(before)
        .filter((request) => request.path.includes("/branches")),
    ).toEqual([]);
    expect(await counts()).toEqual({ jobs: 0, sessions: 0, turns: 0 });
  });

  // #755-T01, #101-WM
  it("answers not found for a repository of another workspace and does not ask GitHub", async () => {
    const { h, service, body, counts } = await startImplementerHarness();
    const other = await addWorkspace(h.db, "other");
    const seeded = await seedImplementerRepository(h.db, other, "elsewhere");
    const before = h.fake.requests().length;

    expect(
      await failureOf(
        service.startTask(USER, body({ repositoryId: seeded.repositoryId })),
      ),
    ).toMatchObject({ code: "IMPLEMENTER_REPOSITORY_NOT_FOUND" });
    expect(h.fake.requests()).toHaveLength(before);
    expect(await counts()).toEqual({ jobs: 0, sessions: 0, turns: 0 });
  });

  it("answers the app not being installed for a disabled integration, and writes nothing", async () => {
    const { h, service, body, integration, counts } =
      await startImplementerHarness();
    await h.integrations.setStatus(integration.id, "disabled");

    expect(await failureOf(service.startTask(USER, body()))).toMatchObject({
      code: "IMPLEMENTER_APP_NOT_INSTALLED",
    });
    expect(await counts()).toEqual({ jobs: 0, sessions: 0, turns: 0 });
  });

  it("answers not found for a repository the platform no longer lists", async () => {
    const { h, service, body, integration } = await startImplementerHarness();
    await h.repositories.reconcile(integration.id, []);

    expect(await failureOf(service.startTask(USER, body()))).toMatchObject({
      code: "IMPLEMENTER_REPOSITORY_NOT_FOUND",
    });
  });

  // #755-T13
  it.each([
    ["a branch lookup", "/branches/main"],
    ["the repository read", "/repos/acme/widgets"],
    ["the installation read", "/app/installations/4242"],
  ])(
    "answers 503 IMPLEMENTER_GITHUB_UNAVAILABLE when %s fails, and writes nothing",
    async (_name, pathIncludes) => {
      const { h, service, body, counts } = await startImplementerHarness();
      h.fake.fail({ pathIncludes, status: 500 });

      expect(await failureOf(service.startTask(USER, body()))).toMatchObject({
        code: "IMPLEMENTER_GITHUB_UNAVAILABLE",
      });
      expect(await counts()).toEqual({ jobs: 0, sessions: 0, turns: 0 });
    },
  );

  // #755-T13
  it("answers unavailable when GitHub is too slow", async () => {
    const { h, service, body, counts } = await startImplementerHarness({
      requestTimeoutMs: 150,
    });
    h.fake.fail({ pathIncludes: "/branches/", delayMs: 1500 });

    expect(await failureOf(service.startTask(USER, body()))).toMatchObject({
      code: "IMPLEMENTER_GITHUB_UNAVAILABLE",
    });
    expect(await counts()).toEqual({ jobs: 0, sessions: 0, turns: 0 });
  });

  // #755-T07
  it("refuses a model the claim would refuse with IMPLEMENTER_MODEL_NOT_ALLOWED and its reason, after the branches and before it writes", async () => {
    const models: ImplementerModels = {
      ...ALLOW_ALL,
      check: async () => "entry_not_released",
    };
    const { h, service, body, counts } = await startImplementerHarness({
      models,
    });
    const before = h.fake.requests().length;

    expect(await failureOf(service.startTask(USER, body()))).toMatchObject({
      code: "IMPLEMENTER_MODEL_NOT_ALLOWED",
      reason: "entry_not_released",
    });
    expect(
      h.fake
        .requests()
        .slice(before)
        .filter((request) => request.path.includes("/branches/")),
    ).toHaveLength(2);
    expect(await counts()).toEqual({ jobs: 0, sessions: 0, turns: 0 });
  });

  // #755-T07
  it("puts the choice of the person to the check as it was sent", async () => {
    const check = vi.fn(async () => null);
    const { service, body } = await startImplementerHarness({
      models: { ...ALLOW_ALL, check },
    });

    await service.startTask(
      USER,
      body({ model: { provider: "deepseek", model: "deepseek-chat" } }),
    );

    expect(check).toHaveBeenCalledWith({
      provider: "deepseek",
      model: "deepseek-chat",
    });
  });

  // #791
  it("hands the first task back for a retry after the branch was pushed, without asking GitHub, and writes nothing", async () => {
    const { h, service, body, counts } = await startImplementerHarness();
    const first = await service.startTask(USER, body());
    // The agent pushed the branch in the meantime.
    h.fake.addPullRequest("acme/widgets", {
      number: 1,
      title: "x",
      state: "open",
      headSha: "1".repeat(40),
      headRef: "implementer/abc123",
      baseRef: "main",
      author: { login: "alice", id: 1 },
    });
    const before = h.fake.requests().length;
    const rows = await counts();

    const again = await service.startTask(USER, body());

    expect(again).toEqual({ ...first, created: false });
    expect(h.fake.requests()).toHaveLength(before);
    expect(await counts()).toEqual(rows);
  });

  // #791
  it("still refuses another request for the branch of a task that is running, and a retry of a request of another workspace is no repeat", async () => {
    const { h, service, body, counts } = await startImplementerHarness();
    await service.startTask(USER, body());
    h.fake.addPullRequest("acme/widgets", {
      number: 1,
      title: "x",
      state: "open",
      headSha: "1".repeat(40),
      headRef: "implementer/abc123",
      baseRef: "main",
      author: { login: "alice", id: 1 },
    });

    expect(
      await failureOf(
        service.startTask(USER, body({ clientRequestId: "request-2" })),
      ),
    ).toMatchObject({ code: "IMPLEMENTER_BRANCH_EXISTS" });
    expect(await counts()).toEqual({ jobs: 1, sessions: 1, turns: 1 });
  });

  // #791
  it("takes a client request id of another workspace for no repeat: the task is made here, and the other's is not handed out", async () => {
    const { h, service, body, counts } = await startImplementerHarness();
    const other = await addWorkspace(h.db, "other");
    const seeded = await seedImplementerRepository(h.db, other, "elsewhere");
    const foreign = await createTestQueue(h.db, other).enqueueImplementerTurn({
      repositoryId: seeded.repositoryId,
      baseBranch: "main",
      baseSha: BASE_SHA,
      branch: "implementer/abc123",
      instruction: "Foreign task.",
      modelChoice: { entryId: "entry-1" },
      costLimitCents: null,
      createdBy: seeded.userId,
      actorLogin: "mallory",
      clientRequestId: "request-1",
    });

    const started = await service.startTask(USER, body());

    expect(started.created).toBe(true);
    expect(started.runId).not.toBe(foreign.job.id);
    expect(started.sessionId).not.toBe(foreign.session.id);
    expect((await counts()).jobs).toBe(2);
  });

  // #791
  it("answers an id with a NUL byte as an unknown id, in the body and in the address, without asking Postgres or GitHub", async () => {
    const { h, service, body, counts } = await startImplementerHarness();
    const before = h.fake.requests().length;

    for (const repositoryId of [
      "a\u0000b",
      "\u0000",
      "x".repeat(20) + "\u0000",
    ]) {
      expect(
        await failureOf(service.startTask(USER, body({ repositoryId }))),
      ).toMatchObject({ code: "IMPLEMENTER_REPOSITORY_NOT_FOUND" });
      expect(await failureOf(service.listBranches(repositoryId))).toMatchObject(
        { code: "IMPLEMENTER_REPOSITORY_NOT_FOUND" },
      );
    }
    expect(h.fake.requests()).toHaveLength(before);
    expect(await counts()).toEqual({ jobs: 0, sessions: 0, turns: 0 });
  });

  // #791
  it("refuses a model with a NUL byte in it before any query is made", async () => {
    const check = vi.fn(async () => null);
    const { service, body } = await startImplementerHarness({
      models: { ...ALLOW_ALL, check },
    });

    for (const model of [
      { entryId: "a\u0000b" },
      { provider: "deepseek", model: "m\u0000" },
      { provider: "d\u0000", model: "m" },
    ])
      expect(
        await failureOf(service.startTask(USER, body({ model }))),
      ).toMatchObject({
        code: "IMPLEMENTER_REQUEST_INVALID",
        issues: [{ field: "model" }],
      });
    expect(check).not.toHaveBeenCalled();
  });

  describe("a folder and a file of branches", () => {
    const branch = (name: string) => ({
      number: 1,
      title: "x",
      state: "open" as const,
      headSha: "1".repeat(40),
      headRef: name,
      baseRef: "main",
      author: { login: "alice", id: 1 },
    });

    // #791
    it.each([
      ["feature/new", "feature"],
      ["feature", "feature/old"],
      ["a/b/c", "a/b"],
    ])(
      "refuses %s while %s exists with IMPLEMENTER_BRANCH_CONFLICT, before the model is looked at, and writes nothing",
      async (name, existing) => {
        const check = vi.fn(async () => null);
        const { h, service, body, counts } = await startImplementerHarness({
          models: { ...ALLOW_ALL, check },
        });
        h.fake.addPullRequest("acme/widgets", branch(existing));

        const error = await failureOf(
          service.startTask(USER, body({ branch: name })),
        );

        expect(error).toMatchObject({ code: "IMPLEMENTER_BRANCH_CONFLICT" });
        expect((error as Error).message).toMatch(/new branch name/i);
        expect(check).not.toHaveBeenCalled();
        expect(await counts()).toEqual({ jobs: 0, sessions: 0, turns: 0 });
      },
    );

    // #791
    it("takes a name beside the existing ones", async () => {
      const { h, service, body } = await startImplementerHarness();
      h.fake.addPullRequest("acme/widgets", branch("feature/old"));
      h.fake.addPullRequest("acme/widgets", { ...branch("feat"), number: 2 });

      const started = await service.startTask(
        USER,
        body({ branch: "feature/new" }),
      );

      expect(started.created).toBe(true);
    });

    // #791: what the read cannot tell. The list is the first 100 names, so a conflict with a branch beyond them is found by
    // git at the push, not here. A task whose session holds a name that is not on GitHub yet is not in the read either.
    it("sees only the first 100 branches: a conflict beyond them is not found at submit", async () => {
      const { h, service, body } = await startImplementerHarness();
      const directory = mkdtempSync(join(tmpdir(), "cr-791-branches-"));
      cleanUpAfterTest(async () => {
        await Promise.resolve();
        rmSync(directory, { recursive: true, force: true });
      });
      const git = createGitRepository(join(directory, "widgets"), {
        defaultBranch: "main",
      });
      const base = git.commit({ "README.md": "base\n" }, "Base");
      for (let n = 0; n < 120; n += 1)
        git.setRef(`refs/heads/b${String(n).padStart(3, "0")}`, base);
      h.fake.addGitRepository("acme/widgets", git.path);

      // b005 is among the first 100 and found; b115 is beyond them.
      expect(
        await failureOf(service.startTask(USER, body({ branch: "b005/x" }))),
      ).toMatchObject({ code: "IMPLEMENTER_BRANCH_CONFLICT" });
      expect(
        (await service.startTask(USER, body({ branch: "b115/x" }))).created,
      ).toBe(true);
    });
  });

  describe("the cost limit", () => {
    // #755-T12
    it("refuses a limit above the operator's maximum with EXCEEDS_OPERATOR_MAXIMUM and the maximum, and writes nothing", async () => {
      const { service, body, counts } = await startImplementerHarness({
        operatorCostLimitCents: 500,
      });

      expect(
        await failureOf(service.startTask(USER, body({ costLimitCents: 501 }))),
      ).toMatchObject({
        code: "EXCEEDS_OPERATOR_MAXIMUM",
        maximumCents: 500,
      });
      expect(await counts()).toEqual({ jobs: 0, sessions: 0, turns: 0 });
    });

    // #755-T12
    it.each([1, 250, 500])("takes a limit of %i cents", async (cents) => {
      const { h, service, body } = await startImplementerHarness({
        operatorCostLimitCents: 500,
      });

      await service.startTask(USER, body({ costLimitCents: cents }));

      const turn = await h.db
        .selectFrom("implementer_turns")
        .select("cost_limit_cents")
        .executeTakeFirstOrThrow();
      expect(turn.cost_limit_cents).toBe(cents);
    });

    // #755-T12
    it("keeps none when none is asked for: the operator's maximum applies at the claim", async () => {
      const { h, service, body } = await startImplementerHarness();

      await service.startTask(USER, body());

      const turn = await h.db
        .selectFrom("implementer_turns")
        .select("cost_limit_cents")
        .executeTakeFirstOrThrow();
      expect(turn.cost_limit_cents).toBeNull();
    });
  });

  it("logs one line per task without the instruction, a token or the model", async () => {
    const { service, body, lines } = await startImplementerHarness();

    await service.startTask(USER, body({ instruction: "SECRET-INSTRUCTION" }));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("acme/widgets");
    expect(lines.join("\n")).not.toContain("SECRET-INSTRUCTION");
    expect(lines.join("\n")).not.toContain("entry-1");
  });
});
