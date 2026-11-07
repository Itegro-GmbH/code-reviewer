// SPDX-License-Identifier: LicenseRef-Proprietary

// The reads of the ticket mirror's full sync (#923) against a scripted GitHub: the token of each read (one repository, read access, and
// the board permission only for the board), the pages, the check suites of a commit, and a board the app may not read. The scripted
// answers follow GitHub's documentation; the real API is not called.
import { describe, expect, it } from "vitest";
import {
  TEST_WEBHOOK_SECRET,
  testGithubAppEnv,
} from "../../../test-support/github-app.ts";
import { createGithubAppClient } from "./client.ts";
import { loadGithubAppConfig } from "./config.ts";
import { GithubAppError } from "./errors.ts";

void TEST_WEBHOOK_SECRET;

const READ = {
  repositoryIds: [7001],
  permissions: {
    issues: "read",
    pull_requests: "read",
    checks: "read",
    metadata: "read",
  },
} as const;
const BOARD = {
  repositoryIds: [7001],
  permissions: { organization_projects: "read", metadata: "read" },
} as const;

type Call = { method: string; path: string; body: unknown };
type Answer = { status?: number; json: unknown };

/** A fetch that answers the token request itself (echoing the scope) and every other call from `answers`. */
function scripted(answers: (call: Call) => Answer | undefined) {
  const calls: Call[] = [];
  let tokenNumber = 0;
  const fetchStub: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname + url.search,
      body:
        typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
    };
    calls.push(call);
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (call.method === "DELETE" && url.pathname === "/installation/token")
      return new Response(null, { status: 204 });
    if (call.method === "POST" && /\/access_tokens$/.test(url.pathname)) {
      const asked = call.body as {
        repository_ids: number[];
        permissions: Record<string, string>;
      };
      // Only an answer that names the token request refuses it; a handler that answers every call is for the reads.
      const failure = answers(call);
      if (failure?.status !== undefined && failure.status >= 400)
        return json(failure.json, failure.status);
      tokenNumber += 1;
      return json(
        {
          token: `ghs_scripted_${tokenNumber}`,
          expires_at: "2099-01-01T00:00:00Z",
          repository_selection: "selected",
          repositories: asked.repository_ids.map((id) => ({ id })),
          permissions: asked.permissions,
        },
        201,
      );
    }
    const answer = answers(call);
    if (answer === undefined) return json({ message: "Not Found" }, 404);
    return json(answer.json, answer.status);
  };
  const client = createGithubAppClient({
    config: loadGithubAppConfig(testGithubAppEnv()),
    fetch: fetchStub,
    warn: () => undefined,
  });
  return { client, calls };
}

const ISSUE = {
  number: 12,
  node_id: "I_12",
  title: "Cache the widget list",
  body: "Rebuilt on every request.",
  state: "open",
  labels: [],
  assignees: [],
  parent_issue_url: null,
  updated_at: "2026-11-06T10:00:00Z",
};

const tokenRequests = (calls: Call[]) =>
  calls.filter((call) => /\/access_tokens$/.test(call.path));

describe("the issues of the full sync", () => {
  // #923-T75
  it("reads a page oldest first with a token of one repository and read access, and switches the token off", async () => {
    const { client, calls } = scripted((call) =>
      call.path.startsWith("/repos/acme/widgets/issues?")
        ? {
            json: [
              ISSUE,
              { ...ISSUE, number: 13, node_id: "I_13", pull_request: { merged_at: null } },
              { no: "ticket" },
            ],
          }
        : undefined,
    );

    const page = await client.readTrackerIssues("4242", READ, "acme/widgets", 1);

    expect(page.last).toBe(true);
    expect(page.items.map((item) => [item.number, item.kind])).toEqual([
      [12, "issue"],
      [13, "pull_request"],
    ]);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /app/installations/4242/access_tokens",
      "GET /repos/acme/widgets/issues?state=all&sort=created&direction=asc&per_page=100&page=1",
      "DELETE /installation/token",
    ]);
    expect(tokenRequests(calls)[0]?.body).toEqual({
      repository_ids: [7001],
      permissions: READ.permissions,
    });
  });

  // #923-T76
  it("says a full page is not the last, and refuses a page outside what a list may have", async () => {
    const { client } = scripted(() => ({
      json: Array.from({ length: 100 }, (_, i) => ({ ...ISSUE, number: i + 1, node_id: `I_${i}` })),
    }));

    expect((await client.readTrackerIssues("4242", READ, "acme/widgets", 2)).last).toBe(false);
    await expect(client.readTrackerIssues("4242", READ, "acme/widgets", 0)).rejects.toBeInstanceOf(GithubAppError);
    await expect(client.readTrackerIssues("4242", READ, "acme/widgets", 101)).rejects.toBeInstanceOf(GithubAppError);
  });

  // #923-T77
  it("fails with the code of GitHub's answer, and never repeats its body", async () => {
    const { client } = scripted((call) =>
      call.path.startsWith("/repos/")
        ? { status: 500, json: { message: "internal secret detail" } }
        : undefined,
    );

    const error = await client
      .readTrackerIssues("4242", READ, "acme/widgets", 1)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(GithubAppError);
    expect((error as GithubAppError).code).toBe("GITHUB_APP_UNAVAILABLE");
    expect((error as GithubAppError).message).not.toContain("secret");
  });
});

describe("the checks of the full sync", () => {
  const SHA = "1f3a5c7e9b2d4f60a8c1e3b5d7f90a2c4e6b8d01";
  const pull = (number: number) => ({
    number,
    title: "A pull request",
    html_url: `https://github.com/acme/widgets/pull/${number}`,
    state: "open",
    draft: false,
    user: { login: "alice", id: 1 },
    head: { sha: SHA, ref: "feature" },
    base: { ref: "main" },
  });

  // #923-T78
  it("reads the open pull requests and the check suites of the head of each", async () => {
    const { client, calls } = scripted((call) => {
      if (call.path.startsWith("/repos/acme/widgets/pulls?"))
        return { json: [pull(7), pull(8)] };
      if (call.path.startsWith(`/repos/acme/widgets/commits/${SHA}/check-suites`))
        return {
          json: {
            check_suites: [
              { status: "completed", conclusion: "success" },
              { status: "completed", conclusion: "failure" },
            ],
          },
        };
      return undefined;
    });

    const page = await client.readTrackerChecks("4242", READ, "acme/widgets", 1);

    expect(page).toEqual({
      pullRequests: [
        { number: 7, checksState: "failure" },
        { number: 8, checksState: "failure" },
      ],
      last: true,
    });
    // One token for the whole page: the checks are read with the token of the list.
    expect(tokenRequests(calls)).toHaveLength(1);
  });

  // #923-T79
  it("asks for the checks of one commit, and refuses a commit that is not a hexadecimal name", async () => {
    const { client } = scripted((call) =>
      call.path.includes("/check-suites")
        ? { json: { check_suites: [] } }
        : undefined,
    );

    expect(await client.readChecksState("4242", READ, "acme/widgets", SHA)).toBeNull();
    await expect(
      client.readChecksState("4242", READ, "acme/widgets", "../../etc"),
    ).rejects.toBeInstanceOf(GithubAppError);
  });
});

describe("the board of the full sync", () => {
  const boards = { data: { repository: { projectsV2: { nodes: [{ id: "PVT_1" }, { id: "PVT_2" }] } } } };
  const items = (names: (string | null)[], hasNextPage: boolean) => ({
    data: {
      node: {
        items: {
          pageInfo: { hasNextPage, endCursor: hasNextPage ? "cursor-1" : null },
          nodes: [
            ...names.map((name, i) => ({
              content: { id: `I_${i}` },
              fieldValueByName: name === null ? null : { name },
            })),
            { content: null, fieldValueByName: null },
            { content: {}, fieldValueByName: null },
          ],
        },
      },
    },
  });

  // #923-T80
  it("reads the status of the items with a token that holds the board permission and nothing the issues need", async () => {
    const { client, calls } = scripted((call) => {
      if (call.path !== "/graphql") return undefined;
      const query = (call.body as { query: string }).query;
      return { json: query.includes("projectsV2") ? boards : items(["In Progress", null], false) };
    });

    const page = await client.readTrackerBoard("4242", BOARD, "acme/widgets", null);

    expect(page).toEqual({
      available: true,
      items: [
        { nodeId: "I_0", status: "In Progress" },
        { nodeId: "I_1", status: null },
      ],
      // The first board is read to its end; the second board is next.
      next: "1:",
    });
    expect(tokenRequests(calls)[0]?.body).toEqual({
      repository_ids: [7001],
      permissions: BOARD.permissions,
    });
  });

  // #923-T81
  it("continues within a board by its cursor and ends after the last board", async () => {
    const seen: unknown[] = [];
    const { client } = scripted((call) => {
      if (call.path !== "/graphql") return undefined;
      const body = call.body as { query: string; variables: Record<string, unknown> };
      if (body.query.includes("projectsV2")) return { json: boards };
      seen.push(body.variables);
      // Only the first page of the first board has a next page.
      return {
        json: items(["Done"], body.variables.project === "PVT_1" && body.variables.after === null),
      };
    });

    const first = await client.readTrackerBoard("4242", BOARD, "acme/widgets", null);
    const second = await client.readTrackerBoard("4242", BOARD, "acme/widgets", first.next);
    const last = await client.readTrackerBoard("4242", BOARD, "acme/widgets", "1:");

    expect(first.next).toBe("0:cursor-1");
    expect(second.next).toBe("1:");
    expect(last.next).toBeNull();
    expect(seen).toEqual([
      { project: "PVT_1", after: null, first: 100 },
      { project: "PVT_1", after: "cursor-1", first: 100 },
      { project: "PVT_2", after: null, first: 100 },
    ]);
  });

  // #923-T82
  it.each([
    ["GraphQL answers with errors", () => ({ json: { errors: [{ type: "FORBIDDEN" }] } })],
    ["the repository has no boards the token can see", () => ({ json: { data: { repository: null } } })],
  ])("is not available when %s, and fails nothing", async (_name, answer) => {
    const { client } = scripted((call) => (call.path === "/graphql" ? answer() : undefined));

    expect(await client.readTrackerBoard("4242", BOARD, "acme/widgets", null)).toEqual({
      available: false,
      items: [],
      next: null,
    });
  });

  // #923-T83
  it("is not available when GitHub refuses the token for the board permission", async () => {
    const { client } = scripted((call) =>
      /\/access_tokens$/.test(call.path)
        ? { status: 422, json: { message: "The permissions requested are not granted to this installation." } }
        : undefined,
    );

    expect(await client.readTrackerBoard("4242", BOARD, "acme/widgets", null)).toEqual({
      available: false,
      items: [],
      next: null,
    });
  });

  // #923-T84
  it("still fails when GitHub cannot be reached", async () => {
    const { client } = scripted((call) =>
      call.path === "/graphql" ? { status: 503, json: {} } : undefined,
    );

    await expect(
      client.readTrackerBoard("4242", BOARD, "acme/widgets", null),
    ).rejects.toMatchObject({ code: "GITHUB_APP_UNAVAILABLE" });
  });
});
