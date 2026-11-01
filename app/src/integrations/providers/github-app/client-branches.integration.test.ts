// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the branch reads of the GitHub client and the branches of the fake GitHub over real HTTP (#750): the
// default branch, the first hundred branches with the default first, one branch by name (also `feature/x`), the
// token these reads use (one repository, `contents: read`), and that a branch only exists where the registered Git
// repository has it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitRepository } from "../../../../../fakes/github/git-fixture.ts";
import { startGithubAppHarness } from "../../../test-support/github-app-harness.ts";
import { cleanUpAfterTest } from "../../../test-support/test-database.ts";
import { createGithubAppClient } from "./client.ts";
import { loadGithubAppConfig } from "./config.ts";
import { GithubAppError } from "./errors.ts";

const SCOPE = {
  repositoryIds: [7001],
  permissions: { contents: "read", metadata: "read" },
} as const;

async function setup(
  options: {
    defaultBranch?: string;
    branches?: string[];
    requestTimeoutMs?: number;
  } = {},
) {
  const harness = await startGithubAppHarness();
  const { fake, clock, env } = harness;
  fake.addInstallation({
    id: 4242,
    account: { login: "acme", id: 5001, type: "Organization" },
  });
  fake.setRepositories(4242, [
    { id: 7001, fullName: "acme/widgets" },
    { id: 7002, fullName: "acme/gadgets" },
  ]);
  const directory = mkdtempSync(join(tmpdir(), "cr-fake-branches-"));
  cleanUpAfterTest(async () => {
    await Promise.resolve();
    rmSync(directory, { recursive: true, force: true });
  });
  const repository = createGitRepository(join(directory, "widgets"), {
    ...(options.defaultBranch === undefined
      ? {}
      : { defaultBranch: options.defaultBranch }),
  });
  const base = repository.commit({ "README.md": "base\n" }, "Base");
  for (const name of options.branches ?? [])
    repository.setRef(`refs/heads/${name}`, base);
  fake.addGitRepository("acme/widgets", repository.path);
  const client = createGithubAppClient({
    config: loadGithubAppConfig(env),
    now: clock.now,
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
  });
  return { fake, client, repository, base };
}

async function failureOf(run: Promise<unknown>): Promise<GithubAppError> {
  const error = await run.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(GithubAppError);
  return error as GithubAppError;
}

const branchRequests = (fake: { requests(): { path: string }[] }) =>
  fake.requests().filter((r) => r.path === "/repos/acme/widgets/branches");

describe("the default branch of a repository", () => {
  // #750-T01
  it.each(["main", "trunk"])(
    "reads %s from a fixture made with that default",
    async (defaultBranch) => {
      const { client } = await setup({ defaultBranch });

      expect(
        await client.getRepositoryFacts("4242", SCOPE, "acme/widgets"),
      ).toEqual({ defaultBranch });
    },
  );

  // #750-T06
  it("is the default branch of the fixture in every answer of the fake, not the one the repository was set up with", async () => {
    const { fake, client } = await setup({ defaultBranch: "trunk" });
    const token = (
      await client.mintInstallationToken("4242", {
        ...SCOPE,
        repositoryIds: [7001, 7002],
      })
    ).token;
    const get = async (path: string) =>
      (await fetch(`${fake.baseUrl}${path}`, {
        headers: { authorization: `Bearer ${token}` },
      }).then((response) => response.json())) as Record<string, unknown>;

    expect((await get("/repos/acme/widgets"))["default_branch"]).toBe("trunk");
    expect(
      (
        (await get("/installation/repositories"))["repositories"] as {
          full_name: string;
          default_branch: string;
        }[]
      ).map((repo) => [repo.full_name, repo.default_branch]),
    ).toEqual([
      ["acme/widgets", "trunk"],
      ["acme/gadgets", "main"],
    ]);
  });
});

describe("listing the branches", () => {
  // #750-T02
  it("lists the default branch first, then the others by name", async () => {
    const { client } = await setup({
      defaultBranch: "trunk",
      branches: ["zeta", "alpha", "feature/x"],
    });

    expect(await client.listBranches("4242", SCOPE, "acme/widgets")).toEqual({
      names: ["trunk", "alpha", "feature/x", "zeta"],
      truncated: false,
    });
  });

  // #750-T02
  it("lists exactly 100 branches without truncation, one request for the page and one that finds the end", async () => {
    const { fake, client } = await setup({
      branches: Array.from(
        { length: 99 },
        (_, index) => `b${String(index).padStart(3, "0")}`,
      ),
    });

    const listed = await client.listBranches("4242", SCOPE, "acme/widgets");

    expect(listed.names).toHaveLength(100);
    expect(listed.truncated).toBe(false);
    expect(branchRequests(fake)).toHaveLength(2);
  });

  // #750-T02
  it("lists the first 100 names of more branches, the default first even when it sorts late, and says it is cut", async () => {
    const { fake, client } = await setup({
      defaultBranch: "zzz-default",
      branches: Array.from(
        { length: 104 },
        (_, index) => `b${String(index).padStart(3, "0")}`,
      ),
    });

    const listed = await client.listBranches("4242", SCOPE, "acme/widgets");

    expect(listed.truncated).toBe(true);
    expect(listed.names).toHaveLength(100);
    expect(listed.names[0]).toBe("zzz-default");
    expect(listed.names[1]).toBe("b000");
    expect(new Set(listed.names).size).toBe(100);
    // One request per page: the first page and the one that shows there is more.
    expect(branchRequests(fake)).toHaveLength(2);
  });

  // #750-T06
  it("pages like GitHub: per_page and page", async () => {
    const { fake, client } = await setup({ branches: ["a", "b", "c", "d"] });
    const token = (await client.mintInstallationToken("4242", SCOPE)).token;
    const page = async (query: string) =>
      (
        (await fetch(`${fake.baseUrl}/repos/acme/widgets/branches?${query}`, {
          headers: { authorization: `Bearer ${token}` },
        }).then((response) => response.json())) as { name: string }[]
      ).map((branch) => branch.name);

    expect(await page("per_page=2&page=1")).toEqual(["a", "b"]);
    expect(await page("per_page=2&page=2")).toEqual(["c", "d"]);
    expect(await page("per_page=2&page=3")).toEqual(["main"]);
    expect(await page("per_page=2&page=4")).toEqual([]);
  });
});

describe("one branch", () => {
  // #750-T03
  it("returns the sha of an existing branch, also one with a slash in its name", async () => {
    const { client, repository, base } = await setup({
      branches: ["feature/x"],
    });
    repository.branch("feature/y");
    const head = repository.commit({ "y.txt": "y\n" }, "Y");

    expect(
      await client.getBranch("4242", SCOPE, "acme/widgets", "feature/x"),
    ).toEqual({ sha: base });
    expect(
      await client.getBranch("4242", SCOPE, "acme/widgets", "feature/y"),
    ).toEqual({ sha: head });
    expect(
      await client.getBranch("4242", SCOPE, "acme/widgets", "main"),
    ).toEqual({ sha: base });
  });

  // #750-T03
  it("sends the name as one percent encoded path segment, also one with # or %", async () => {
    const { fake, client, base } = await setup({
      branches: ["feature/x", "a#b", "50%"],
    });

    for (const name of ["feature/x", "a#b", "50%"])
      expect(
        await client.getBranch("4242", SCOPE, "acme/widgets", name),
      ).toEqual({ sha: base });

    expect(
      fake
        .requests()
        .filter((r) => r.path.startsWith("/repos/acme/widgets/branches/"))
        .map((r) => r.path),
    ).toEqual([
      "/repos/acme/widgets/branches/feature%2Fx",
      "/repos/acme/widgets/branches/a%23b",
      "/repos/acme/widgets/branches/50%25",
    ]);
  });

  // #750-T03
  it("returns null for an unknown branch", async () => {
    const { client } = await setup();

    expect(
      await client.getBranch("4242", SCOPE, "acme/widgets", "nope"),
    ).toBeNull();
    expect(
      await client.getBranch("4242", SCOPE, "acme/widgets", "feature/nope"),
    ).toBeNull();
  });

  // #750-T06
  it("finds a branch that is created in the fixture after the fake started, and a pull request's branches without a fixture", async () => {
    const { fake, client, repository } = await setup();
    expect(
      await client.getBranch("4242", SCOPE, "acme/widgets", "later"),
    ).toBeNull();

    repository.branch("later");
    const head = repository.commit({ "later.txt": "x\n" }, "Later");
    expect(
      await client.getBranch("4242", SCOPE, "acme/widgets", "later"),
    ).toEqual({ sha: head });
    expect(
      (await client.listBranches("4242", SCOPE, "acme/widgets")).names,
    ).toEqual(["main", "later"]);

    // A repository without a fixture knows its default branch and the branches of its pull requests.
    fake.addPullRequest("acme/gadgets", {
      number: 3,
      title: "Change",
      state: "open",
      headSha: "c".repeat(40),
      headRef: "topic",
      baseRef: "main",
      author: { login: "alice", id: 1001 },
    });
    const gadgets = { repositoryIds: [7002], permissions: SCOPE.permissions };
    expect(await client.listBranches("4242", gadgets, "acme/gadgets")).toEqual({
      names: ["main", "topic"],
      truncated: false,
    });
    expect(
      await client.getBranch("4242", gadgets, "acme/gadgets", "topic"),
    ).toEqual({ sha: "c".repeat(40) });
    expect(
      await client.getBranch("4242", gadgets, "acme/gadgets", "other"),
    ).toBeNull();
  });
});

describe("the token of these reads", () => {
  // #750-T05
  it.each([
    [
      "getRepositoryFacts",
      (c: Client) => c.getRepositoryFacts("4242", SCOPE, "acme/widgets"),
    ],
    [
      "listBranches",
      (c: Client) => c.listBranches("4242", SCOPE, "acme/widgets"),
    ],
    [
      "getBranch",
      (c: Client) => c.getBranch("4242", SCOPE, "acme/widgets", "main"),
    ],
  ])(
    "%s uses a token for the one repository with contents: read, and switches it off",
    async (_name, run) => {
      const { fake, client } = await setup();

      await run(client);

      expect(fake.tokenRequests()).toEqual([
        {
          installationId: 4242,
          repositories: null,
          repositoryIds: [7001],
          permissions: { contents: "read", metadata: "read" },
        },
      ]);
      expect(fake.revokedInstallationTokens()).toEqual(
        fake.issuedInstallationTokens(),
      );
    },
  );

  // #750-T05
  it("is refused by the fake without contents: read", async () => {
    const { fake, client } = await setup();
    const token = (
      await client.mintInstallationToken("4242", {
        repositoryIds: [7001],
        permissions: { metadata: "read" },
      })
    ).token;

    const response = await fetch(
      `${fake.baseUrl}/repos/acme/widgets/branches`,
      { headers: { authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(403);
  });
});

type Client = ReturnType<typeof createGithubAppClient>;

describe("what the client refuses and how a failure shows", () => {
  // #750-T04
  it.each([
    [401, "GITHUB_APP_AUTH_FAILED"],
    [403, "GITHUB_APP_FORBIDDEN"],
    [404, "GITHUB_APP_NOT_FOUND"],
    [500, "GITHUB_APP_UNAVAILABLE"],
    [429, "GITHUB_APP_RATE_LIMITED"],
  ] as const)(
    "answers %s with %s for the repository facts and the list",
    async (status, code) => {
      const { fake, client } = await setup();
      fake.fail({ pathIncludes: "/repos/acme/widgets", status });

      expect(
        (
          await failureOf(
            client.getRepositoryFacts("4242", SCOPE, "acme/widgets"),
          )
        ).code,
      ).toBe(code);
      expect(
        (await failureOf(client.listBranches("4242", SCOPE, "acme/widgets")))
          .code,
      ).toBe(code);
    },
  );

  // #750-T04
  it("turns only a 404 of the branch itself into null; the other refusals stay", async () => {
    const { fake, client } = await setup();
    fake.fail({ pathIncludes: "/branches/", status: 403 });

    expect(
      (await failureOf(client.getBranch("4242", SCOPE, "acme/widgets", "main")))
        .code,
    ).toBe("GITHUB_APP_FORBIDDEN");
  });

  // #750-T04
  it("rejects a repository name and a branch name that cannot be a path", async () => {
    const { fake, client } = await setup();

    // `.` and `..` would be dot segments of the path; a lone surrogate cannot be percent encoded.
    for (const name of [
      "",
      "a\nb",
      "x".repeat(300),
      ".",
      "..",
      "a\ud800b",
      "\udc00",
      "tail\ud83d",
    ])
      expect(
        (await failureOf(client.getBranch("4242", SCOPE, "acme/widgets", name)))
          .code,
      ).toBe("GITHUB_APP_REQUEST_FAILED");
    expect(
      (await failureOf(client.getBranch("4242", SCOPE, "acme", "main"))).code,
    ).toBe("GITHUB_APP_REQUEST_FAILED");
    expect(fake.requests()).toEqual([]);
  });

  // #750-T04
  it.each([404, 422, 500])(
    "rejects getBranch when the token request is answered %s, and never gives null",
    async (status) => {
      const { fake, client } = await setup();
      fake.fail({ pathIncludes: "/access_tokens", status });

      const error = await failureOf(
        client.getBranch("4242", SCOPE, "acme/widgets", "main"),
      );

      expect(error.duringTokenRequest).toBe(true);
      expect(error.status).toBe(status);
      expect(
        fake.requests().filter((r) => r.path.includes("/branches")),
      ).toEqual([]);
    },
  );

  // #750-T04
  it.each([
    [
      "getRepositoryFacts",
      "/repos/acme/widgets",
      (c: Client, signal: AbortSignal) =>
        c.getRepositoryFacts("4242", SCOPE, "acme/widgets", signal),
    ],
    [
      "listBranches (default branch)",
      "/repos/acme/widgets",
      (c: Client, signal: AbortSignal) =>
        c.listBranches("4242", SCOPE, "acme/widgets", signal),
    ],
    [
      "listBranches (page)",
      "/repos/acme/widgets/branches",
      (c: Client, signal: AbortSignal) =>
        c.listBranches("4242", SCOPE, "acme/widgets", signal),
    ],
    [
      "getBranch",
      "/repos/acme/widgets/branches/main",
      (c: Client, signal: AbortSignal) =>
        c.getBranch("4242", SCOPE, "acme/widgets", "main", signal),
    ],
  ])(
    "%s ends the request in flight when the caller's signal fires, long before the client's own timeout",
    async (_name, hungPath, run) => {
      // The client's own timeout is a minute away: only the caller's signal can end the request in time.
      const { fake, client } = await setup({ requestTimeoutMs: 60_000 });
      fake.fail({ pathIncludes: hungPath, hang: true, times: 1 });
      const controller = new AbortController();

      const startedAt = Date.now();
      const pending = failureOf(run(client, controller.signal));
      const deadline = Date.now() + 5000;
      while (
        !fake.requests().some((r) => r.path.startsWith(hungPath)) &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      controller.abort();

      const ended = await Promise.race([
        pending,
        new Promise<"still waiting">((resolve) =>
          setTimeout(() => resolve("still waiting"), 5000),
        ),
      ]);
      expect(ended).not.toBe("still waiting");
      expect((ended as GithubAppError).code).toBe("GITHUB_APP_UNAVAILABLE");
      expect(Date.now() - startedAt).toBeLessThan(10_000);
      const abortedDeadline = Date.now() + 5000;
      while (fake.abortedRequests().length < 1 && Date.now() < abortedDeadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fake.abortedRequests().map((r) => r.path)).toContain(hungPath);
    },
  );

  // #750-T04
  it("ends a request nobody aborts at the client's own timeout", async () => {
    const { fake, client } = await setup({ requestTimeoutMs: 200 });
    fake.fail({ pathIncludes: "/branches/", hang: true });

    expect(
      (await failureOf(client.getBranch("4242", SCOPE, "acme/widgets", "main")))
        .code,
    ).toBe("GITHUB_APP_UNAVAILABLE");
  });

  // #750-T07
  it("never reads a pull request", async () => {
    const { fake, client } = await setup();
    fake.addPullRequest("acme/widgets", {
      number: 7,
      title: "Change",
      state: "open",
      headSha: "d".repeat(40),
      headRef: "topic",
      baseRef: "main",
      author: { login: "alice", id: 1001 },
    });

    await client.getRepositoryFacts("4242", SCOPE, "acme/widgets");
    await client.listBranches("4242", SCOPE, "acme/widgets");
    await client.getBranch("4242", SCOPE, "acme/widgets", "topic");

    expect(
      fake.requests().filter((r) => /\/(pulls|issues)\b/.test(r.path)),
    ).toEqual([]);
  });
});
