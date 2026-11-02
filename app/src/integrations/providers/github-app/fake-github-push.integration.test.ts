// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the push of the fake GitHub (fakes/github/git-http.ts) over real HTTP with the real Git client (#766): the
// smart HTTP receive-pack of a registered repository, which the Implementer's turn uses to publish its branch. The
// token is the Basic password and must have been minted with `contents: write` for the repository; a branch that
// is new, or moves forward, is accepted; a diverged history, a forced push and a deletion are refused like GitHub
// refuses them; the pushed branch is at once visible through the branch endpoints; the request log names the pushed
// refs and never a token. The Implementer journey (#767) relies on this, so a wrong fake fails here first.
import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createGitRepository } from "../../../../../fakes/github/git-fixture.ts";
import { startGithubFake } from "../../../../../fakes/github/server.ts";
import { createGithubAppClient } from "./client.ts";
import { loadGithubAppConfig } from "./config.ts";
import {
  testGithubAppEnv,
  TEST_APP_ID,
  testAppKeys,
} from "../../../test-support/github-app.ts";
import { cleanUpAfterTest } from "../../../test-support/test-database.ts";

const OWNER = { login: "acme", id: 5001, type: "Organization" } as const;
const WIDGETS = { id: 7001, fullName: "acme/widgets" };
const OTHER = { id: 7002, fullName: "acme/other" };

async function setup() {
  const fake = await startGithubFake({
    appId: TEST_APP_ID,
    publicKeyPem: testAppKeys().publicKey,
    appSlug: "code-reviewer-test",
    selfLinks: true,
  });
  cleanUpAfterTest(() => fake.close());
  // The app of an Implementer deployment holds Contents: write.
  fake.setAppPermissions({
    metadata: "read",
    contents: "write",
    pull_requests: "write",
  });
  fake.addInstallation({ id: 4242, account: OWNER });
  fake.setRepositories(4242, [WIDGETS, OTHER]);
  const directory = mkdtempSync(join(tmpdir(), "cr-fake-push-"));
  cleanUpAfterTest(async () => {
    await Promise.resolve();
    rmSync(directory, { recursive: true, force: true });
  });
  const repository = createGitRepository(join(directory, "widgets"));
  const base = repository.commit({ "README.md": "base\n" }, "Base");
  fake.addGitRepository(WIDGETS.fullName, repository.path);
  const client = createGithubAppClient({
    config: loadGithubAppConfig(
      testGithubAppEnv({
        GITHUB_API_BASE_URL: fake.baseUrl,
        ALLOW_TEST_GITHUB_ENDPOINTS: "true",
      }),
    ),
  });
  const mint = async (repositoryIds: number[], contents: "read" | "write") =>
    (
      await client.mintInstallationToken("4242", {
        repositoryIds,
        permissions: { contents, metadata: "read" },
      })
    ).token;
  const remote = `${fake.baseUrl}/acme/widgets.git`;
  return { fake, repository, base, mint, directory, remote };
}

/** The runner's header: Basic with the user `x-access-token` and the installation token. */
function basic(token: string): string {
  return `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
}

const run = promisify(execFile);

// Asynchronous on purpose: the fake runs in this very process, and a blocked event loop cannot answer.
async function git(
  directory: string,
  token: string,
  ...args: string[]
): Promise<string> {
  const environment: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: directory,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Agent",
    GIT_AUTHOR_EMAIL: "agent@example.test",
    GIT_COMMITTER_NAME: "Agent",
    GIT_COMMITTER_EMAIL: "agent@example.test",
  };
  const done = await run(
    "git",
    ["-c", `http.extraHeader=Authorization: ${basic(token)}`, ...args],
    {
      cwd: directory,
      encoding: "utf8",
      // Next's types make NODE_ENV a required variable; Git does not read it.
      env: environment as NodeJS.ProcessEnv,
    },
  );
  return done.stdout;
}

/** A clone of the fake's repository with a commit on a new branch, ready to push. */
async function workingCopy(
  setupResult: Awaited<ReturnType<typeof setup>>,
  token: string,
  name: string,
  branch: string,
  file = "agent.txt",
  content = "hello\n",
): Promise<string> {
  const clone = join(setupResult.directory, name);
  execFileSync("git", ["init", "--quiet", clone]);
  await git(
    clone,
    token,
    "fetch",
    "--quiet",
    setupResult.remote,
    setupResult.base,
  );
  execFileSync("git", [
    "-C",
    clone,
    "checkout",
    "--quiet",
    "-b",
    branch,
    setupResult.base,
  ]);
  writeFileSync(join(clone, file), content);
  execFileSync("git", ["-C", clone, "add", "--all"]);
  await git(clone, token, "commit", "--quiet", "--message", `Add ${file}`);
  return clone;
}

async function push(
  clone: string,
  token: string,
  remote: string,
  ...args: string[]
): Promise<{ ok: boolean; output: string }> {
  try {
    // Options first, then the remote, then the refspecs.
    const options = args.filter((arg) => arg.startsWith("--"));
    const refspecs = args.filter((arg) => !arg.startsWith("--"));
    await git(clone, token, "push", "--quiet", ...options, remote, ...refspecs);
    return { ok: true, output: "" };
  } catch (failure) {
    return {
      ok: false,
      output: String((failure as { stderr?: unknown }).stderr),
    };
  }
}

async function branchSha(
  fake: { baseUrl: string },
  token: string,
  name: string,
): Promise<string | null> {
  const found = await fetch(
    `${fake.baseUrl}/repos/acme/widgets/branches/${encodeURIComponent(name)}`,
    { headers: { authorization: `token ${token}` } },
  );
  if (found.status === 404) return null;
  return ((await found.json()) as { commit: { sha: string } }).commit.sha;
}

describe("the push of the fake GitHub", () => {
  // #766-T01
  it("accepts a new branch with a write token, lists it and lets the branch endpoint read it", async () => {
    const context = await setup();
    const token = await context.mint([WIDGETS.id], "write");
    const clone = await workingCopy(
      context,
      token,
      "clone",
      "implementer/add-agent",
    );

    const pushed = await push(
      clone,
      token,
      context.remote,
      "HEAD:refs/heads/implementer/add-agent",
    );

    expect(pushed).toEqual({ ok: true, output: "" });
    const head = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const listed = await fetch(
      `${context.fake.baseUrl}/repos/acme/widgets/branches?per_page=100`,
      { headers: { authorization: `token ${token}` } },
    );
    expect(
      ((await listed.json()) as Array<{ name: string }>).map((b) => b.name),
    ).toEqual(["implementer/add-agent", "main"]);
    expect(await branchSha(context.fake, token, "implementer/add-agent")).toBe(
      head,
    );
    // The objects are really there: a reader fetches the commit and reads the file.
    const reader = join(context.directory, "reader");
    execFileSync("git", ["init", "--quiet", reader]);
    await git(
      reader,
      token,
      "fetch",
      "--quiet",
      context.remote,
      "implementer/add-agent",
    );
    expect(
      execFileSync("git", ["-C", reader, "show", "FETCH_HEAD:agent.txt"], {
        encoding: "utf8",
      }),
    ).toBe("hello\n");
  });

  // The Implementer's App never has the `workflows` permission: GitHub refuses the push of that ref and takes the
  // others (the runner pushes one ref per command).
  it("refuses a push that creates a workflow file with GitHub's words and takes a plain branch beside it", async () => {
    const context = await setup();
    const token = await context.mint([WIDGETS.id], "write");
    const workflow = await workingCopy(
      context,
      token,
      "workflow",
      "implementer/workflow",
      ".github/workflows/smoke.yml",
      "on: push\n",
    );
    const plain = await workingCopy(
      context,
      token,
      "plain",
      "implementer/plain",
    );

    const refused = await push(
      workflow,
      token,
      context.remote,
      "HEAD:refs/heads/implementer/workflow",
    );
    const taken = await push(
      plain,
      token,
      context.remote,
      "HEAD:refs/heads/implementer/plain",
    );

    expect(refused.ok).toBe(false);
    expect(refused.output).toContain(
      "refusing to allow a GitHub App to create or update workflow `.github/workflows/smoke.yml` without `workflows` permission",
    );
    expect(taken.ok).toBe(true);
    expect(await branchSha(context.fake, token, "implementer/workflow")).toBe(
      null,
    );
    expect(await branchSha(context.fake, token, "implementer/plain")).not.toBe(
      null,
    );
  });

  // #766-T01
  it("accepts a second push that moves its own branch forward", async () => {
    const context = await setup();
    const token = await context.mint([WIDGETS.id], "write");
    const clone = await workingCopy(context, token, "clone", "implementer/x");
    await push(clone, token, context.remote, "HEAD:refs/heads/implementer/x");
    writeFileSync(join(clone, "second.txt"), "two\n");
    execFileSync("git", ["-C", clone, "add", "--all"]);
    await git(clone, token, "commit", "--quiet", "--message", "Second");

    const pushed = await push(
      clone,
      token,
      context.remote,
      "HEAD:refs/heads/implementer/x",
    );

    const head = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    expect(pushed.ok).toBe(true);
    expect(await branchSha(context.fake, token, "implementer/x")).toBe(head);
  });

  // #766-T02
  it("answers 403 to a token with Contents: read, 401 to a bad one and 404 for a repository the token does not reach", async () => {
    const context = await setup();
    const readToken = await context.mint([WIDGETS.id], "read");
    const writeToken = await context.mint([OTHER.id], "write");
    const advertise = `${context.remote}/info/refs?service=git-receive-pack`;

    const read = await fetch(advertise, {
      headers: { authorization: basic(readToken) },
    });
    const bad = await fetch(advertise, {
      headers: { authorization: basic("not-a-token") },
    });
    const none = await fetch(advertise);
    const unreachable = await fetch(advertise, {
      headers: { authorization: basic(writeToken) },
    });
    const post = await fetch(`${context.remote}/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basic(readToken) },
      body: "0000",
    });

    expect(read.status).toBe(403);
    expect(bad.status).toBe(401);
    expect(none.status).toBe(401);
    expect(unreachable.status).toBe(404);
    expect(post.status).toBe(403);
  });

  // #766-T02
  it("refuses a real push with a read token and leaves the repository as it was", async () => {
    const context = await setup();
    const readToken = await context.mint([WIDGETS.id], "read");
    const clone = await workingCopy(
      context,
      readToken,
      "clone",
      "implementer/x",
    );

    const pushed = await push(
      clone,
      readToken,
      context.remote,
      "HEAD:refs/heads/implementer/x",
    );

    expect(pushed.ok).toBe(false);
    expect(pushed.output).toContain("403");
    expect(
      await branchSha(context.fake, readToken, "implementer/x"),
    ).toBeNull();
  });

  // #766-T02
  it("accepts a push with a write token for the app's default read access only when the token asked for write", async () => {
    const context = await setup();
    // The app holds write, but a token minted without a permission list keeps the app's grant.
    const token = (
      await createGithubAppClient({
        config: loadGithubAppConfig(
          testGithubAppEnv({
            GITHUB_API_BASE_URL: context.fake.baseUrl,
            ALLOW_TEST_GITHUB_ENDPOINTS: "true",
          }),
        ),
      }).mintInstallationToken("4242", {
        repositoryIds: [WIDGETS.id],
        permissions: { metadata: "read" },
      })
    ).token;

    const advertise = await fetch(
      `${context.remote}/info/refs?service=git-receive-pack`,
      { headers: { authorization: basic(token) } },
    );

    expect(advertise.status).toBe(403);
  });

  // #766-T03
  it("refuses a push to an existing branch with a diverged history, a forced push and a deletion", async () => {
    const context = await setup();
    const token = await context.mint([WIDGETS.id], "write");
    const first = await workingCopy(
      context,
      token,
      "first",
      "implementer/x",
      "a.txt",
      "a\n",
    );
    await push(first, token, context.remote, "HEAD:refs/heads/implementer/x");
    const stored = await branchSha(context.fake, token, "implementer/x");
    const second = await workingCopy(
      context,
      token,
      "second",
      "other",
      "b.txt",
      "b\n",
    );

    const diverged = await push(
      second,
      token,
      context.remote,
      "HEAD:refs/heads/implementer/x",
    );
    const forced = await push(
      second,
      token,
      context.remote,
      "--force",
      "HEAD:refs/heads/implementer/x",
    );
    const deleted = await push(
      second,
      token,
      context.remote,
      ":refs/heads/implementer/x",
    );

    // The client stops the plain push itself ("fetch first"); the forced push and the deletion reach the fake, which
    // refuses them like GitHub does.
    expect(diverged.ok).toBe(false);
    expect(diverged.output).toContain("[rejected]");
    expect(forced.ok).toBe(false);
    expect(forced.output).toContain("[remote rejected]");
    expect(forced.output).toContain("non-fast-forward");
    expect(deleted.ok).toBe(false);
    expect(deleted.output).toContain("[remote rejected]");
    expect(deleted.output).toContain("deletion prohibited");
    expect(await branchSha(context.fake, token, "implementer/x")).toBe(stored);
  });

  // #766-T04
  it("lists the pushed refs in the request log and through the control endpoint, and never a token", async () => {
    const context = await setup();
    const token = await context.mint([WIDGETS.id], "write");
    const clone = await workingCopy(context, token, "clone", "implementer/x");
    await push(clone, token, context.remote, "HEAD:refs/heads/implementer/x");

    const posted = context.fake
      .requests()
      .filter((request) => request.path.endsWith("/git-receive-pack"));
    const control = await fetch(
      `${context.fake.baseUrl}/__fake/pushes?repository=acme/widgets`,
    );

    expect(posted).toEqual([
      {
        method: "POST",
        path: "/acme/widgets.git/git-receive-pack",
        refs: ["refs/heads/implementer/x"],
      },
    ]);
    expect(context.fake.pushes()).toEqual([
      { repository: "acme/widgets", refs: ["refs/heads/implementer/x"] },
    ]);
    expect(await control.json()).toEqual({
      pushes: [
        { repository: "acme/widgets", refs: ["refs/heads/implementer/x"] },
      ],
    });
    expect(JSON.stringify(context.fake.requests())).not.toContain(token);
    expect(JSON.stringify(context.fake.pushes())).not.toContain(token);
  });

  // #767 (review of #779, item 4)
  it("challenges a request without credentials with WWW-Authenticate: Basic, so that URL credentials work", async () => {
    const context = await setup();
    const token = await context.mint([WIDGETS.id], "write");
    const advertise = `${context.remote}/info/refs?service=git-receive-pack`;

    const none = await fetch(advertise);
    const bad = await fetch(advertise, {
      headers: { authorization: basic("not-a-token") },
    });
    // A client that only knows the credentials from the URL sends them after the challenge.
    const clone = join(context.directory, "by-url");
    execFileSync("git", ["init", "--quiet", clone]);
    const withCredentials = new URL(context.remote);
    withCredentials.username = "x-access-token";
    withCredentials.password = token;
    const environment: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: context.directory,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    };
    await run(
      "git",
      ["fetch", "--quiet", withCredentials.toString(), context.base],
      // Next's types make NODE_ENV a required variable; Git does not read it.
      { cwd: clone, env: environment as NodeJS.ProcessEnv },
    );

    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toMatch(/^Basic /);
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toMatch(/^Basic /);
    expect(
      execFileSync("git", ["-C", clone, "cat-file", "-t", context.base], {
        encoding: "utf8",
      }).trim(),
    ).toBe("commit");
  });

  // #767 (review of #779, item 3)
  it("records a push over 1 MB once: the client's 4-byte probe names no ref and is not a push", async () => {
    const context = await setup();
    const token = await context.mint([WIDGETS.id], "write");
    const clone = await workingCopy(context, token, "clone", "implementer/big");
    // Incompressible, and above http.postBuffer (1 MiB): the client probes the server before it sends the body.
    writeFileSync(join(clone, "big.bin"), randomBytes(2_500_000));
    execFileSync("git", ["-C", clone, "add", "--all"]);
    await git(clone, token, "commit", "--quiet", "--message", "Add big.bin");

    const pushed = await push(
      clone,
      token,
      context.remote,
      "HEAD:refs/heads/implementer/big",
    );

    const posts = context.fake
      .requests()
      .filter(
        (request) =>
          request.method === "POST" &&
          request.path.endsWith("/git-receive-pack"),
      );
    expect(pushed.ok).toBe(true);
    // The probe really happened (two POSTs), and only the one with the command is a push.
    expect(posts.length).toBeGreaterThanOrEqual(2);
    expect(posts.filter((post) => post.refs !== undefined)).toHaveLength(1);
    expect(context.fake.pushes()).toEqual([
      { repository: "acme/widgets", refs: ["refs/heads/implementer/big"] },
    ]);
  });

  // #767 (review of #779, item 2)
  it("accepts a tag, a note and a fast-forward of the default branch, which is why a journey asserts the refs it expects", async () => {
    const context = await setup();
    const token = await context.mint([WIDGETS.id], "write");
    const clone = await workingCopy(context, token, "clone", "implementer/x");
    execFileSync("git", ["-C", clone, "tag", "v1"]);
    execFileSync("git", [
      "-C",
      clone,
      "update-ref",
      "refs/notes/commits",
      "HEAD",
    ]);

    const tag = await push(clone, token, context.remote, "refs/tags/v1");
    const note = await push(
      clone,
      token,
      context.remote,
      "refs/notes/commits:refs/notes/commits",
    );
    const main = await push(
      clone,
      token,
      context.remote,
      "HEAD:refs/heads/main",
    );

    expect([tag.ok, note.ok, main.ok]).toEqual([true, true, true]);
    expect(context.fake.pushes().flatMap((entry) => entry.refs)).toEqual([
      "refs/tags/v1",
      "refs/notes/commits",
      "refs/heads/main",
    ]);
  });

  // #767
  it("lets a test running the fake as its own process raise the App to Contents: write", async () => {
    const context = await setup();
    // The App of the first test holds write already; narrow it, then raise it through the control endpoint.
    context.fake.setAppPermissions({ metadata: "read", contents: "read" });
    const readOnly = await context
      .mint([WIDGETS.id], "write")
      .catch(() => null);

    const raised = await fetch(
      `${context.fake.baseUrl}/__fake/app-permissions`,
      {
        method: "POST",
        body: JSON.stringify({
          permissions: { metadata: "read", contents: "write" },
        }),
      },
    );
    const refused = await fetch(
      `${context.fake.baseUrl}/__fake/app-permissions`,
      {
        method: "POST",
        body: JSON.stringify({ permissions: { contents: "everything" } }),
      },
    );
    const token = await context.mint([WIDGETS.id], "write");
    const advertise = await fetch(
      `${context.remote}/info/refs?service=git-receive-pack`,
      { headers: { authorization: basic(token) } },
    );

    expect(readOnly).toBeNull();
    expect(raised.status).toBe(201);
    expect(refused.status).toBe(400);
    expect(advertise.status).toBe(200);
  });

  // #767
  it("lists the request log through a control endpoint, a push with its refs and without a token", async () => {
    const context = await setup();
    const token = await context.mint([WIDGETS.id], "write");
    const clone = await workingCopy(context, token, "clone", "implementer/x");
    await push(clone, token, context.remote, "HEAD:refs/heads/implementer/x");

    const listed = (await (
      await fetch(`${context.fake.baseUrl}/__fake/requests`)
    ).json()) as {
      requests: Array<{ method: string; path: string; refs?: string[] }>;
    };

    expect(listed.requests).toContainEqual({
      method: "POST",
      path: "/acme/widgets.git/git-receive-pack",
      refs: ["refs/heads/implementer/x"],
    });
    expect(JSON.stringify(listed)).not.toContain(token);
  });

  // #767
  it("still lists the repositories of an installation after a journey removed the fixture of one of them", async () => {
    const context = await setup();
    const token = await context.mint([WIDGETS.id, OTHER.id], "read");
    rmSync(join(context.directory, "widgets"), {
      recursive: true,
      force: true,
    });

    const listed = await fetch(
      `${context.fake.baseUrl}/installation/repositories`,
      {
        headers: { authorization: `token ${token}` },
      },
    );

    expect(listed.status).toBe(200);
    expect(
      (
        (await listed.json()) as { repositories: Array<{ full_name: string }> }
      ).repositories.map((repo) => repo.full_name),
    ).toEqual([WIDGETS.fullName, OTHER.fullName]);
  });

  // #767
  it("states the html_url a test gives a repository, and the default address of the others", async () => {
    const context = await setup();
    context.fake.setRepositories(4242, [
      { ...WIDGETS, htmlUrl: "https://127.0.0.1:1/acme/widgets" },
      OTHER,
    ]);
    const token = await context.mint([WIDGETS.id, OTHER.id], "read");

    const listed = await fetch(
      `${context.fake.baseUrl}/installation/repositories`,
      {
        headers: { authorization: `token ${token}` },
      },
    );

    expect(
      (
        (await listed.json()) as {
          repositories: Array<{ full_name: string; html_url: string }>;
        }
      ).repositories.map((repo) => [repo.full_name, repo.html_url]),
    ).toEqual([
      ["acme/widgets", "https://127.0.0.1:1/acme/widgets"],
      ["acme/other", `${context.fake.baseUrl}/acme/other`],
    ]);
  });
});
