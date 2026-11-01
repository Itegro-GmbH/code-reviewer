// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the GitHub client against the fake GitHub API over real HTTP: what it reads, how it
// pages, which token it uses, and that every failure becomes a stable code without a secret in it.
import { describe, expect, it } from "vitest";
import type { FakeGithub } from "../../../../../fakes/github/server.ts";
import { startGithubAppHarness } from "../../../test-support/github-app-harness.ts";
import {
  commentTarget,
  createGithubAppClient,
  type GithubAppClient,
} from "./client.ts";
import { loadGithubAppConfig } from "./config.ts";
import { GithubAppError } from "./errors.ts";

const ACME = { login: "acme", id: 5001, type: "Organization" } as const;

async function setup(
  options: { requestTimeoutMs?: number; warn?: (line: string) => void } = {},
) {
  const harness = await startGithubAppHarness();
  const { fake, clock, env } = harness;
  fake.addInstallation({ id: 4242, account: ACME });
  fake.setRepositories(4242, [
    { id: 7001, fullName: "acme/widgets" },
    { id: 7002, fullName: "acme/gadgets" },
  ]);
  const client = createGithubAppClient({
    config: loadGithubAppConfig(env),
    now: clock.now,
    ...options,
  });
  return { fake, clock, client };
}

async function failureOf(run: Promise<unknown>): Promise<GithubAppError> {
  const error = await run.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(GithubAppError);
  return error as GithubAppError;
}

describe("listing installations", () => {
  it("reads the account and the suspended flag of every installation", async () => {
    const { fake, client } = await setup();
    fake.addInstallation({
      id: 4300,
      account: { login: "octocat", id: 583231, type: "User" },
      suspended: true,
    });

    const installations = await client.listInstallations();

    // The permissions an installation holds (#749) are what the app is granted unless its owner accepted less.
    const permissions = {
      checks: "write",
      contents: "read",
      issues: "write",
      metadata: "read",
      pull_requests: "write",
    };
    expect(installations).toEqual([
      {
        id: "4242",
        accountLogin: "acme",
        accountId: 5001,
        accountType: "Organization",
        suspended: false,
        permissions,
      },
      {
        id: "4300",
        accountLogin: "octocat",
        accountId: 583231,
        accountType: "User",
        suspended: true,
        permissions,
      },
    ]);
  });

  it("reads all pages", async () => {
    const { fake, client } = await setup();
    for (let id = 5000; id < 5130; id += 1)
      fake.addInstallation({
        id,
        account: { login: `org${id}`, id, type: "Organization" },
      });

    const installations = await client.listInstallations();

    expect(installations).toHaveLength(131);
    expect(new Set(installations.map((item) => item.id)).size).toBe(131);
  });

  // #749-T06
  it("reads the permissions an installation accepted, which can be less than the app is granted", async () => {
    const { fake, client } = await setup();
    fake.setAppPermissions({ metadata: "read", contents: "write" });
    fake.setInstallationPermissions(4242, {
      metadata: "read",
      contents: "read",
    });

    expect((await client.getInstallation("4242"))?.permissions).toEqual({
      metadata: "read",
      contents: "read",
    });
  });

  it("returns null for an installation GitHub does not know", async () => {
    const { client } = await setup();

    expect(await client.getInstallation("9999")).toBeNull();
    expect(await client.getInstallation("4242")).toMatchObject({
      id: "4242",
      accountLogin: "acme",
    });
  });
});

describe("installation records", () => {
  it("skips an installation whose account has no login and warns, without blocking the others", async () => {
    const warnings: string[] = [];
    const { fake, client } = await setup({
      warn: (line) => warnings.push(line),
    });
    fake.addRawInstallationRecord({
      id: 4999,
      account: { id: 1 },
      suspended_at: null,
    });

    const installations = await client.listInstallations();

    expect(installations.map((item) => item.id)).toEqual(["4242"]);
    expect(warnings).toEqual([expect.stringContaining("installation 4999")]);
  });
});

describe("the App JWT", () => {
  it("is reused until shortly before it ends and then replaced", async () => {
    const { fake, clock, client } = await setup();

    await client.listInstallations();
    await client.getInstallation("4242");
    expect(new Set(fake.seenCredentials()).size).toBe(1);

    clock.advance(6 * 60 * 1000);
    await client.listInstallations();
    expect(new Set(fake.seenCredentials()).size).toBe(2);
  });
});

describe("listing the repositories of an installation", () => {
  it("returns the id, full name and web URL of each repository", async () => {
    const { client } = await setup();

    const repos = await client.listInstallationRepositories("4242");

    expect(repos).toEqual([
      {
        externalId: "7001",
        fullName: "acme/widgets",
        url: "https://github.test/acme/widgets",
      },
      {
        externalId: "7002",
        fullName: "acme/gadgets",
        url: "https://github.test/acme/gadgets",
      },
    ]);
  });

  it("reads every page of a large installation", async () => {
    const { fake, client } = await setup();
    fake.setRepositories(
      4242,
      Array.from({ length: 250 }, (_, index) => ({
        id: 10_000 + index,
        fullName: `acme/repo-${index}`,
      })),
    );

    const repos = await client.listInstallationRepositories("4242");

    expect(repos).toHaveLength(250);
    expect(
      fake.requests().filter((r) => r.path === "/installation/repositories"),
    ).toHaveLength(3);
  });

  it("reuses the installation token until it is about to expire", async () => {
    const { fake, clock, client } = await setup();

    await client.listInstallationRepositories("4242");
    await client.listInstallationRepositories("4242");
    expect(fake.issuedInstallationTokens()).toHaveLength(1);

    clock.advance(59 * 60 * 1000 + 30_000);
    await client.listInstallationRepositories("4242");
    expect(fake.issuedInstallationTokens()).toHaveLength(2);
  });

  it("asks for a new token once when GitHub refuses the cached one", async () => {
    const { fake, client } = await setup();
    await client.listInstallationRepositories("4242");
    fake.fail({
      pathIncludes: "/installation/repositories",
      status: 401,
      times: 1,
    });

    const repos = await client.listInstallationRepositories("4242");

    expect(repos).toHaveLength(2);
    expect(fake.issuedInstallationTokens()).toHaveLength(2);
  });

  it("fails instead of returning a list shorter than GitHub's own count", async () => {
    const { fake, client } = await setup();
    fake.omitFromListings(4242, [7002]);

    const error = await failureOf(client.listInstallationRepositories("4242"));

    expect(error).toMatchObject({ code: "GITHUB_APP_UNAVAILABLE" });
    expect(error.message).toContain("1 of 2");
  });

  it("fails with a stable code instead of returning a partial list when a later page fails", async () => {
    const { fake, client } = await setup();
    fake.setRepositories(
      4242,
      Array.from({ length: 150 }, (_, index) => ({
        id: index + 1,
        fullName: `acme/repo-${index}`,
      })),
    );
    fake.fail({ queryIncludes: "page=2", status: 500 });

    const error = await failureOf(client.listInstallationRepositories("4242"));

    expect(error).toMatchObject({
      code: "GITHUB_APP_UNAVAILABLE",
      status: 500,
    });
  });
});

describe("failures", () => {
  // CR-21-T13
  it("maps a refused App JWT to an auth error that carries no credential", async () => {
    const { fake, client } = await setup();
    fake.rejectAppJwts(true);

    const error = await failureOf(client.listInstallations());

    expect(error).toMatchObject({
      code: "GITHUB_APP_AUTH_FAILED",
      status: 401,
    });
    for (const credential of fake.seenCredentials())
      expect(error.message).not.toContain(credential);
  });

  it("maps a server error to unavailable", async () => {
    const { fake, client } = await setup();
    fake.fail({ status: 503 });

    expect(await failureOf(client.listInstallations())).toMatchObject({
      code: "GITHUB_APP_UNAVAILABLE",
      status: 503,
    });
  });

  it("maps a request that takes too long to unavailable", async () => {
    const { fake, client } = await setup({ requestTimeoutMs: 100 });
    fake.fail({ delayMs: 1500 });

    expect(await failureOf(client.listInstallations())).toMatchObject({
      code: "GITHUB_APP_UNAVAILABLE",
      status: null,
    });
  });

  it("maps a rate limit to a code with the time to wait", async () => {
    const { fake, client } = await setup();
    fake.fail({ status: 429, headers: { "retry-after": "30" }, times: 1 });
    fake.fail({
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "retry-after": "12" },
      times: 1,
    });

    expect(await failureOf(client.listInstallations())).toMatchObject({
      code: "GITHUB_APP_RATE_LIMITED",
      retryAfterSeconds: 30,
    });
    expect(await failureOf(client.listInstallations())).toMatchObject({
      code: "GITHUB_APP_RATE_LIMITED",
      retryAfterSeconds: 12,
    });
  });

  it("passes on how long a server error asks to wait, never a negative or empty value", async () => {
    const { fake, client } = await setup();
    fake.fail({ status: 503, headers: { "retry-after": "30" }, times: 1 });
    fake.fail({ status: 503, headers: { "retry-after": "-5" }, times: 1 });
    fake.fail({ status: 503, headers: { "retry-after": "" }, times: 1 });
    fake.fail({ status: 503, times: 1 });

    const waits = [];
    for (let attempt = 0; attempt < 4; attempt += 1)
      waits.push(
        (await failureOf(client.listInstallations())).retryAfterSeconds,
      );

    expect(waits).toEqual([30, 0, null, null]);
  });

  it("clamps a rate limit that is already over to zero seconds", async () => {
    const { fake, clock, client } = await setup();
    fake.fail({
      status: 429,
      headers: { "x-ratelimit-reset": String(clock.now() / 1000 - 100) },
      times: 1,
    });

    expect(
      (await failureOf(client.listInstallations())).retryAfterSeconds,
    ).toBe(0);
  });

  it("maps a plain 403 to forbidden and an unexpected status to a failed request", async () => {
    const { fake, client } = await setup();
    fake.fail({ status: 403, times: 1 });
    fake.fail({ status: 418, times: 1 });

    expect((await failureOf(client.listInstallations())).code).toBe(
      "GITHUB_APP_FORBIDDEN",
    );
    expect((await failureOf(client.listInstallations())).code).toBe(
      "GITHUB_APP_REQUEST_FAILED",
    );
  });

  it("refuses an installation id that is not a number before any request", async () => {
    const { fake, client } = await setup();

    const error = await failureOf(
      client.listInstallationRepositories("4242/../1"),
    );

    expect(error.code).toBe("GITHUB_APP_REQUEST_FAILED");
    expect(fake.requests()).toEqual([]);
  });
});

describe("requests that would point somewhere else", () => {
  it("refuses dot segments in a repository name, a login and a bad pull request number before any request", async () => {
    const { fake, client } = await setup();

    for (const run of [
      client.getPullRequest("4242", "acme/..", 7),
      client.getPullRequest("4242", "../widgets", 7),
      client.getPullRequest("4242", "acme/widgets", Number.NaN),
      client.getPullRequest("4242", "acme/widgets", 0),
      client.getPullRequest("4242", "acme/widgets", 1.5),
      client.listOpenPullRequests("4242", "./."),
      client.getCollaboratorPermission("4242", "acme/widgets", ".."),
    ])
      expect((await failureOf(run)).code).toBe("GITHUB_APP_REQUEST_FAILED");
    expect(fake.requests()).toEqual([]);
  });
});

describe("pull requests", () => {
  async function withPullRequests(): Promise<{
    client: GithubAppClient;
    fake: FakeGithub;
  }> {
    const { fake, client } = await setup();
    fake.addPullRequest("acme/widgets", {
      number: 7,
      title: "Add widget caching",
      state: "open",
      headSha: "abc123",
      headRef: "feature/caching",
      baseRef: "main",
      author: { login: "alice", id: 1001 },
    });
    fake.addPullRequest("acme/widgets", {
      number: 8,
      title: "Work in progress",
      state: "open",
      draft: true,
      headSha: "def456",
      headRef: "wip",
      baseRef: "main",
      author: { login: "bob", id: 1002 },
    });
    fake.addPullRequest("acme/widgets", {
      number: 9,
      title: "Old change",
      state: "closed",
      merged: true,
      headSha: "0a0a0a",
      headRef: "old",
      baseRef: "main",
      author: { login: "alice", id: 1001 },
    });
    return { client, fake };
  }

  it("reads one pull request in the normalized shape", async () => {
    const { client } = await withPullRequests();

    expect(await client.getPullRequest("4242", "acme/widgets", 7)).toEqual({
      number: 7,
      title: "Add widget caching",
      url: "https://github.test/acme/widgets/pull/7",
      headSha: "abc123",
      baseRef: "main",
      headRef: "feature/caching",
      draft: false,
      state: "open",
      author: { login: "alice", externalId: "1001" },
    });
  });

  it("marks drafts and merged pull requests", async () => {
    const { client } = await withPullRequests();

    expect(
      await client.getPullRequest("4242", "acme/widgets", 8),
    ).toMatchObject({ draft: true, state: "open" });
    expect(
      await client.getPullRequest("4242", "acme/widgets", 9),
    ).toMatchObject({ draft: false, state: "merged" });
  });

  it("lists only the open pull requests, drafts included", async () => {
    const { client } = await withPullRequests();

    const open = await client.listOpenPullRequests("4242", "acme/widgets");

    expect(open.map((pr) => pr.number)).toEqual([7, 8]);
  });

  it("reports an unknown pull request as not found", async () => {
    const { client } = await withPullRequests();

    expect(
      await failureOf(client.getPullRequest("4242", "acme/widgets", 99)),
    ).toMatchObject({ code: "GITHUB_APP_NOT_FOUND", status: 404 });
  });

  it("tells a 404 of the pull request from a 404 of the token request", async () => {
    const { client, fake } = await withPullRequests();

    const missingPullRequest = await failureOf(
      client.getPullRequest("4242", "acme/widgets", 99),
    );
    fake.removeInstallation(4242);
    const missingInstallation = await failureOf(
      client.getPullRequest("4242", "acme/widgets", 7),
    );

    expect(missingPullRequest).toMatchObject({
      code: "GITHUB_APP_NOT_FOUND",
      duringTokenRequest: false,
    });
    expect(missingInstallation).toMatchObject({
      code: "GITHUB_APP_NOT_FOUND",
      duringTokenRequest: true,
    });
  });
});

describe("aborting a read", () => {
  // The client's own timeout is far longer than every signal below, so only the caller's signal can
  // close a connection within the wait of `abortedPaths`.
  const LONG_CLIENT_TIMEOUT = { requestTimeoutMs: 60_000 };

  /** Waits until the fake has seen the client close a connection, or fails after a few seconds. */
  async function abortedPaths(fake: FakeGithub, count: number) {
    const deadline = Date.now() + 5000;
    while (fake.abortedRequests().length < count && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    return fake.abortedRequests().map((request) => request.path);
  }

  // Head check: the request must be cancelled, not just waited for no longer.
  it("closes the connection of a pull request read that GitHub never answers when the signal fires", async () => {
    const { client, fake } = await setup(LONG_CLIENT_TIMEOUT);
    // The token request passes; the pull request itself never gets an answer.
    fake.fail({ pathIncludes: "/pulls/", hang: true });

    const failure = await failureOf(
      client.getPullRequest(
        "4242",
        "acme/widgets",
        7,
        AbortSignal.timeout(100),
      ),
    );

    expect(failure).toMatchObject({ code: "GITHUB_APP_UNAVAILABLE" });
    expect(await abortedPaths(fake, 1)).toEqual([
      "/repos/acme/widgets/pulls/7",
    ]);
  });

  it("closes the connection of the token request when the signal fires while the token is minted", async () => {
    const { client, fake } = await setup(LONG_CLIENT_TIMEOUT);
    fake.fail({ pathIncludes: "/access_tokens", hang: true });

    const failure = await failureOf(
      client.getPullRequest(
        "4242",
        "acme/widgets",
        7,
        AbortSignal.timeout(100),
      ),
    );

    expect(failure).toMatchObject({ code: "GITHUB_APP_UNAVAILABLE" });
    expect(await abortedPaths(fake, 1)).toEqual([
      "/app/installations/4242/access_tokens",
    ]);
  });

  it("closes the connection of a listing of open pull requests that GitHub never answers when the signal fires", async () => {
    const { client, fake } = await setup(LONG_CLIENT_TIMEOUT);
    fake.fail({ pathIncludes: "/pulls", hang: true });

    const failure = await failureOf(
      client.listOpenPullRequests(
        "4242",
        "acme/widgets",
        AbortSignal.timeout(100),
      ),
    );

    expect(failure).toMatchObject({ code: "GITHUB_APP_UNAVAILABLE" });
    expect(await abortedPaths(fake, 1)).toEqual(["/repos/acme/widgets/pulls"]);
  });

  it("reports a signal that fires while the answer is being read as unavailable, not as a malformed answer", async () => {
    const { client, fake } = await setup(LONG_CLIENT_TIMEOUT);
    fake.addPullRequest("acme/widgets", {
      number: 7,
      title: "Add widget caching",
      state: "open",
      headSha: "abc123",
      headRef: "feature/caching",
      baseRef: "main",
      author: { login: "alice", id: 1001 },
    });
    fake.fail({ pathIncludes: "/pulls/", hangBody: true });

    const failure = await failureOf(
      client.getPullRequest(
        "4242",
        "acme/widgets",
        7,
        AbortSignal.timeout(200),
      ),
    );

    expect(failure).toMatchObject({ code: "GITHUB_APP_UNAVAILABLE" });
    expect(await abortedPaths(fake, 1)).toEqual([
      "/repos/acme/widgets/pulls/7",
    ]);
  });

  it("sends no request at all when the signal has already fired", async () => {
    const { client, fake } = await setup();
    const controller = new AbortController();
    controller.abort();

    const failure = await failureOf(
      client.getPullRequest("4242", "acme/widgets", 7, controller.signal),
    );

    expect(failure).toMatchObject({ code: "GITHUB_APP_UNAVAILABLE" });
    expect(fake.requests()).toEqual([]);
  });

  it("still gives up on its own timeout when the caller's signal never fires", async () => {
    const { client, fake } = await setup({ requestTimeoutMs: 100 });
    fake.fail({ pathIncludes: "/pulls/", hang: true });

    const failure = await failureOf(
      client.getPullRequest(
        "4242",
        "acme/widgets",
        7,
        new AbortController().signal,
      ),
    );

    expect(failure).toMatchObject({ code: "GITHUB_APP_UNAVAILABLE" });
    expect(await abortedPaths(fake, 1)).toEqual([
      "/repos/acme/widgets/pulls/7",
    ]);
  });
});

describe("collaborator permissions", () => {
  it("returns the permission of a user and none for a user without access", async () => {
    const { fake, client } = await setup();
    fake.setCollaboratorPermission("acme/widgets", "bob", "write");

    expect(
      await client.getCollaboratorPermission("4242", "acme/widgets", "Bob"),
    ).toBe("write");
    expect(
      await client.getCollaboratorPermission("4242", "acme/widgets", "mallory"),
    ).toBe("none");
  });
});

const JOB_SCOPE = {
  repositoryIds: [7001],
  permissions: { pull_requests: "write", metadata: "read" },
} as const;

describe("minting an installation token", () => {
  it("narrows the token to the given repository ids and permissions", async () => {
    const { fake, clock, client } = await setup();

    const token = await client.mintInstallationToken("4242", JOB_SCOPE);

    expect(token.token).toMatch(/^ghs_/);
    expect(Date.parse(token.expiresAt)).toBe(clock.now() + 60 * 60 * 1000);
    expect(fake.tokenRequests()).toEqual([
      {
        installationId: 4242,
        repositories: null,
        repositoryIds: [7001],
        permissions: { pull_requests: "write", metadata: "read" },
      },
    ]);
  });

  it("never reuses a token from the cache for a job", async () => {
    const { fake, client } = await setup();

    await client.mintInstallationToken("4242", JOB_SCOPE);
    await client.mintInstallationToken("4242", JOB_SCOPE);

    expect(fake.issuedInstallationTokens()).toHaveLength(2);
  });

  it("refuses a scope without a repository, a usable id or a permission before any request", async () => {
    const { fake, client } = await setup();

    for (const scope of [
      { ...JOB_SCOPE, repositoryIds: [] },
      { ...JOB_SCOPE, repositoryIds: [0] },
      { ...JOB_SCOPE, repositoryIds: [1.5] },
      { ...JOB_SCOPE, permissions: {} },
    ])
      expect(
        (await failureOf(client.mintInstallationToken("4242", scope))).code,
      ).toBe("GITHUB_APP_REQUEST_FAILED");
    expect(fake.requests()).toEqual([]);
  });

  it("fails for a repository the installation cannot access and for a suspended installation", async () => {
    const { fake, client } = await setup();

    expect(
      await failureOf(
        client.mintInstallationToken("4242", {
          ...JOB_SCOPE,
          repositoryIds: [9999],
        }),
      ),
    ).toMatchObject({ code: "GITHUB_APP_REQUEST_FAILED", status: 422 });

    fake.suspendInstallation(4242, true);
    expect(
      (await failureOf(client.mintInstallationToken("4242", JOB_SCOPE))).code,
    ).toBe("GITHUB_APP_FORBIDDEN");
  });

  it("discards a token GitHub reports as broader than asked for, or does not describe, and switches it off", async () => {
    const { fake, client } = await setup();

    const patches: Array<Record<string, unknown>> = [
      { repository_selection: "all" },
      { permissions: { pull_requests: "write", administration: "write" } },
      { permissions: { pull_requests: "write", metadata: "write" } },
      { permissions: { pull_requests: "owner" } },
      { repositories: [{ id: 7001 }, { id: 7002 }] },
      // Fail closed: a description that leaves something out is not accepted either.
      { repository_selection: undefined },
      { repositories: undefined },
      { permissions: undefined },
    ];
    for (const patch of patches) {
      fake.answerTokensWith(patch);
      expect(
        await failureOf(client.mintInstallationToken("4242", JOB_SCOPE)),
      ).toMatchObject({ code: "GITHUB_APP_REQUEST_FAILED", status: null });
    }

    expect(fake.revokedInstallationTokens()).toEqual(
      fake.issuedInstallationTokens(),
    );
    expect(fake.revokedInstallationTokens()).toHaveLength(patches.length);
  });

  it("makes a discarded token useless and still reports the original failure when switching it off fails", async () => {
    const { fake, client } = await setup();
    fake.answerTokensWith({ repository_selection: "all" });
    fake.fail({ pathIncludes: "/installation/token", status: 500, times: 1 });

    const error = await failureOf(
      client.mintInstallationToken("4242", JOB_SCOPE),
    );

    expect(error.message).toContain("broader");
    expect(fake.revokedInstallationTokens()).toEqual([]);

    fake.answerTokensWith({ repository_selection: "all" });
    await failureOf(client.mintInstallationToken("4242", JOB_SCOPE));
    const [, second] = fake.issuedInstallationTokens() as [string, string];
    const status = await fetch(`${fake.baseUrl}/installation/repositories`, {
      headers: { authorization: `Bearer ${second}` },
    }).then((response) => response.status);
    expect(status).toBe(401);
  });
});

// #281: the notice of a refused review is written with a token narrowed to the one repository and to the
// comment permissions, and switched off again once the call is done.
const NOTICE_SCOPE = {
  repositoryIds: [7001],
  permissions: { issues: "write", metadata: "read" },
} as const;

describe("comments below a pull request, written and read with a narrow token", () => {
  async function withPullRequest() {
    const { fake, client } = await setup();
    fake.addPullRequest("acme/widgets", {
      number: 7,
      title: "Add widget caching",
      state: "open",
      headSha: "abc123",
      headRef: "feature/caching",
      baseRef: "main",
      author: { login: "alice", id: 1001 },
    });
    return { fake, client };
  }

  // #281-T01
  it("posts a comment as the bot of the app with a token limited to the repository and the comment permission", async () => {
    const { fake, client } = await withPullRequest();

    const created = await client.createIssueComment(
      "4242",
      NOTICE_SCOPE,
      "acme/widgets",
      7,
      "hello",
    );

    expect(created.id).toMatch(/^\d+$/);
    expect(fake.pullRequestComments("acme/widgets", 7)).toMatchObject([
      { body: "hello", login: "fake-app[bot]" },
    ]);
    expect(fake.tokenRequests()).toEqual([
      {
        installationId: 4242,
        repositories: null,
        repositoryIds: [7001],
        permissions: { issues: "write", metadata: "read" },
      },
    ]);
  });

  // #657-T04
  it("reads one comment by its id with a token limited to the repository and the read permission, and answers null for one that is gone", async () => {
    const { fake, client } = await withPullRequest();
    const created = await client.createIssueComment(
      "4242",
      NOTICE_SCOPE,
      "acme/widgets",
      7,
      "## Review\n\nA finding.",
    );
    const scope = {
      repositoryIds: [7001],
      permissions: { issues: "read", metadata: "read" },
    } as const;

    expect(
      await client.getIssueComment("4242", scope, "acme/widgets", created.id),
    ).toEqual({
      id: created.id,
      body: "## Review\n\nA finding.",
      authorLogin: "fake-app[bot]",
      // The pull request the comment sits below, from its links (#657).
      below: { repoFullName: "acme/widgets", number: 7 },
    });
    expect(
      await client.getIssueComment("4242", scope, "acme/widgets", "999999"),
    ).toBeNull();
    expect(fake.tokenRequests().at(-1)).toMatchObject({
      repositoryIds: [7001],
      permissions: { issues: "read", metadata: "read" },
    });
    // One for the comment written, one for each read.
    expect(fake.revokedInstallationTokens()).toHaveLength(3);
  });

  it("switches the token off after the call, whether it worked or not", async () => {
    const { fake, client } = await withPullRequest();

    await client.createIssueComment(
      "4242",
      NOTICE_SCOPE,
      "acme/widgets",
      7,
      "a",
    );
    expect(fake.revokedInstallationTokens()).toHaveLength(1);

    await failureOf(
      client.createIssueComment("4242", NOTICE_SCOPE, "acme/widgets", 99, "b"),
    );
    expect(fake.revokedInstallationTokens()).toHaveLength(2);
  });

  it("lists the comments of a pull request with their author", async () => {
    const { fake, client } = await withPullRequest();
    fake.addPullRequestComment("acme/widgets", 7, "from the bot");
    fake.addPullRequestComment("acme/widgets", 7, "from a person", "alice");

    const comments = await client.listIssueComments(
      "4242",
      NOTICE_SCOPE,
      "acme/widgets",
      7,
      { since: "2026-10-10T00:00:00.000Z" },
    );

    expect(comments).toEqual([
      expect.objectContaining({
        body: "from the bot",
        authorLogin: "fake-app[bot]",
      }),
      expect.objectContaining({ body: "from a person", authorLogin: "alice" }),
    ]);
  });

  it("asks only for the comments changed since a time", async () => {
    const { fake, client } = await withPullRequest();
    // Only a request that carries the filter is answered with the failure.
    fake.fail({ queryIncludes: "since=2026-10-10", status: 500 });

    await failureOf(
      client.listIssueComments("4242", NOTICE_SCOPE, "acme/widgets", 7, {
        since: "2026-10-10T00:00:00.000Z",
      }),
    );
    expect(
      await client.listIssueComments("4242", NOTICE_SCOPE, "acme/widgets", 7),
    ).toEqual([]);
  });

  // #281-T06
  it.each([
    [403, "GITHUB_APP_FORBIDDEN"],
    [404, "GITHUB_APP_NOT_FOUND"],
    [502, "GITHUB_APP_UNAVAILABLE"],
  ] as const)(
    "fails with a stable code when GitHub answers %s",
    async (status, code) => {
      const { fake, client } = await withPullRequest();
      fake.fail({ pathIncludes: "/issues/7/comments", status });

      expect(
        await failureOf(
          client.createIssueComment(
            "4242",
            NOTICE_SCOPE,
            "acme/widgets",
            7,
            "x",
          ),
        ),
      ).toMatchObject({ code });
      expect(fake.pullRequestComments("acme/widgets", 7)).toEqual([]);
    },
  );

  it("refuses a repository name or a number that is not one, before any request", async () => {
    const { fake, client } = await withPullRequest();

    await failureOf(
      client.createIssueComment("4242", NOTICE_SCOPE, "../x", 7, "x"),
    );
    await failureOf(
      client.createIssueComment("4242", NOTICE_SCOPE, "acme/widgets", 0, "x"),
    );
    await failureOf(
      client.listIssueComments("abc", NOTICE_SCOPE, "acme/widgets", 7),
    );

    expect(fake.requests()).toEqual([]);
  });
});

// #657-T04
describe("the pull request a comment sits below, from its links", () => {
  it("reads issue_url first, then html_url, and nothing from a link that is not one of a repository", () => {
    expect(
      commentTarget({
        issue_url: "https://api.github.com/repos/acme/widgets/issues/7",
        html_url: "https://github.com/acme/other/pull/9#issuecomment-1",
      }),
    ).toEqual({ repoFullName: "acme/widgets", number: 7 });
    expect(
      commentTarget({
        issue_url: "https://ghe.example/api/v3/repos/acme/widgets/issues/7",
      }),
    ).toEqual({ repoFullName: "acme/widgets", number: 7 });
    expect(
      commentTarget({
        html_url: "https://github.com/acme/widgets/pull/8#issuecomment-55",
      }),
    ).toEqual({ repoFullName: "acme/widgets", number: 8 });
    expect(
      commentTarget({ issue_url: "http://x/repos/a/b/issues/7" }),
    ).toBeNull();
    expect(commentTarget({ html_url: "https://github.com/acme" })).toBeNull();
    expect(commentTarget({ issue_url: 7 })).toBeNull();
    expect(commentTarget({})).toBeNull();
  });
});
