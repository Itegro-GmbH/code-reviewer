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
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as unknown)
          : undefined,
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
  it("reads a page, the least recently changed first, with a token of one repository and read access, and switches the token off", async () => {
    const { client, calls } = scripted((call) =>
      call.path.startsWith("/repos/acme/widgets/issues?")
        ? {
            json: [
              ISSUE,
              {
                ...ISSUE,
                number: 13,
                node_id: "I_13",
                pull_request: { merged_at: null },
              },
              { no: "ticket" },
            ],
          }
        : undefined,
    );

    const page = await client.readTrackerIssues(
      "4242",
      READ,
      "acme/widgets",
      1,
    );

    expect(page.last).toBe(true);
    expect(page.items.map((item) => [item.number, item.kind])).toEqual([
      [12, "issue"],
      [13, "pull_request"],
    ]);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /app/installations/4242/access_tokens",
      "GET /repos/acme/widgets/issues?state=all&sort=updated&direction=asc&per_page=100&page=1",
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
      json: Array.from({ length: 100 }, (_, i) => ({
        ...ISSUE,
        number: i + 1,
        node_id: `I_${i}`,
      })),
    }));

    expect(
      (await client.readTrackerIssues("4242", READ, "acme/widgets", 2)).last,
    ).toBe(false);
    await expect(
      client.readTrackerIssues("4242", READ, "acme/widgets", 0),
    ).rejects.toBeInstanceOf(GithubAppError);
    await expect(
      client.readTrackerIssues("4242", READ, "acme/widgets", 101),
    ).rejects.toBeInstanceOf(GithubAppError);
  });

  // #923-R14
  it("continues a list from a time, in whole seconds, and refuses a time that is none", async () => {
    const { client, calls } = scripted((call) =>
      call.path.startsWith("/repos/acme/widgets/issues?")
        ? { json: [] }
        : undefined,
    );

    await client.readTrackerIssues(
      "4242",
      READ,
      "acme/widgets",
      2,
      "2026-11-06T10:00:03.456Z",
    );

    expect(calls.map((call) => call.path)).toContain(
      "/repos/acme/widgets/issues?state=all&sort=updated&direction=asc&per_page=100&page=2&since=2026-11-06T10%3A00%3A03Z",
    );
    for (const since of [
      "yesterday",
      "2026-11-06",
      "2026-11-06T10:00:03+02:00",
    ])
      await expect(
        client.readTrackerIssues("4242", READ, "acme/widgets", 1, since),
      ).rejects.toBeInstanceOf(GithubAppError);
  });

  // #923-R15
  it("counts the tickets of a page that it could not read", async () => {
    const { client } = scripted(() => ({
      json: [ISSUE, { no: "ticket" }, { number: "x" }],
    }));

    const page = await client.readTrackerIssues(
      "4242",
      READ,
      "acme/widgets",
      1,
    );

    expect(page.items.map((item) => item.number)).toEqual([12]);
    expect(page.skipped).toBe(2);
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
      if (
        call.path.startsWith(`/repos/acme/widgets/commits/${SHA}/check-suites`)
      )
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

    const page = await client.readTrackerChecks(
      "4242",
      READ,
      "acme/widgets",
      1,
    );

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

    expect(
      await client.readChecksState("4242", READ, "acme/widgets", SHA),
    ).toBeNull();
    await expect(
      client.readChecksState("4242", READ, "acme/widgets", "../../etc"),
    ).rejects.toBeInstanceOf(GithubAppError);
  });
});

describe("the board of the full sync", () => {
  const boards = {
    data: {
      repository: { projectsV2: { nodes: [{ id: "PVT_1" }, { id: "PVT_2" }] } },
    },
  };
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
      return {
        json: query.includes("projectsV2")
          ? boards
          : items(["In Progress", null], false),
      };
    });

    const page = await client.readTrackerBoard(
      "4242",
      BOARD,
      "acme/widgets",
      null,
    );

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
      const body = call.body as {
        query: string;
        variables: Record<string, unknown>;
      };
      if (body.query.includes("projectsV2")) return { json: boards };
      seen.push(body.variables);
      // Only the first page of the first board has a next page.
      return {
        json: items(
          ["Done"],
          body.variables.project === "PVT_1" && body.variables.after === null,
        ),
      };
    });

    const first = await client.readTrackerBoard(
      "4242",
      BOARD,
      "acme/widgets",
      null,
    );
    const second = await client.readTrackerBoard(
      "4242",
      BOARD,
      "acme/widgets",
      first.next,
    );
    const last = await client.readTrackerBoard(
      "4242",
      BOARD,
      "acme/widgets",
      "1:",
    );

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
    [
      "GraphQL answers with errors",
      () => ({ json: { errors: [{ type: "FORBIDDEN" }] } }),
    ],
    [
      "the repository has no boards the token can see",
      () => ({ json: { data: { repository: null } } }),
    ],
  ])("is not available when %s, and fails nothing", async (_name, answer) => {
    const { client } = scripted((call) =>
      call.path === "/graphql" ? answer() : undefined,
    );

    expect(
      await client.readTrackerBoard("4242", BOARD, "acme/widgets", null),
    ).toEqual({
      available: false,
      items: [],
      next: null,
    });
  });

  // #923-T83
  it("is not available when GitHub refuses the token for the board permission", async () => {
    const { client } = scripted((call) =>
      /\/access_tokens$/.test(call.path)
        ? {
            status: 422,
            json: {
              message:
                "The permissions requested are not granted to this installation.",
            },
          }
        : undefined,
    );

    expect(
      await client.readTrackerBoard("4242", BOARD, "acme/widgets", null),
    ).toEqual({
      available: false,
      items: [],
      next: null,
    });
  });

  // #923-R16
  it.each(["FORBIDDEN", "INSUFFICIENT_SCOPES", "NOT_FOUND"])(
    "is not available when GitHub answers the query with only %s errors",
    async (type) => {
      const { client } = scripted((call) =>
        call.path === "/graphql"
          ? {
              json: {
                data: null,
                errors: [{ type, message: "not for this app" }],
              },
            }
          : undefined,
      );

      expect(
        await client.readTrackerBoard("4242", BOARD, "acme/widgets", null),
      ).toEqual({ available: false, items: [], next: null });
    },
  );

  // #932-R19
  it("reads the boards it may read when only some of them are refused, instead of calling all of them unavailable", async () => {
    const { client } = scripted((call) => {
      if (call.path !== "/graphql") return undefined;
      const query = (call.body as { query: string }).query;
      return {
        json: query.includes("projectsV2")
          ? {
              // The second board is another organization's: GitHub answers null for it and says why.
              data: {
                repository: {
                  projectsV2: { nodes: [{ id: "PVT_1" }, null] },
                },
              },
              errors: [
                {
                  type: "FORBIDDEN",
                  path: ["repository", "projectsV2", "nodes", 1],
                },
              ],
            }
          : items(["Done"], false),
      };
    });

    expect(
      await client.readTrackerBoard("4242", BOARD, "acme/widgets", null),
    ).toEqual({
      available: true,
      items: [{ nodeId: "I_0", status: "Done" }],
      next: null,
    });
  });

  // #932-R20
  it("is still not available when the refused answer has no usable data", async () => {
    const { client } = scripted((call) =>
      call.path === "/graphql"
        ? {
            json: {
              data: { repository: null },
              errors: [{ type: "NOT_FOUND" }],
            },
          }
        : undefined,
    );

    expect(
      await client.readTrackerBoard("4242", BOARD, "acme/widgets", null),
    ).toEqual({ available: false, items: [], next: null });
  });

  // #923-R17
  it.each([
    [
      [{ type: "RATE_LIMITED", message: "slow down" }],
      "GITHUB_APP_RATE_LIMITED",
    ],
    [[{ type: "INTERNAL", message: "boom" }], "GITHUB_APP_REQUEST_FAILED"],
    [[{ message: "no type" }], "GITHUB_APP_REQUEST_FAILED"],
    // One error that is not about the permission is enough: the board is not "not ours".
    [
      [
        { type: "FORBIDDEN", message: "a" },
        { type: "MAX_NODE_LIMIT_EXCEEDED", message: "b" },
      ],
      "GITHUB_APP_REQUEST_FAILED",
    ],
  ])(
    "fails, so that the sync keeps its place, when the errors are %j",
    async (errors, code) => {
      const { client } = scripted((call) =>
        call.path === "/graphql" ? { json: { data: null, errors } } : undefined,
      );

      await expect(
        client.readTrackerBoard("4242", BOARD, "acme/widgets", null),
      ).rejects.toMatchObject({ code });
    },
  );

  // #923-R18
  it("fails when the answer has neither data nor errors", async () => {
    const { client } = scripted((call) =>
      call.path === "/graphql" ? { json: {} } : undefined,
    );

    await expect(
      client.readTrackerBoard("4242", BOARD, "acme/widgets", null),
    ).rejects.toBeInstanceOf(GithubAppError);
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

describe("the board status of one ticket (#932)", () => {
  const answer = (projectItems: unknown) => ({
    json: { data: { node: { projectItems } } },
  });
  const statuses = (...values: (string | null)[]) =>
    answer({
      nodes: values.map((name) => ({
        fieldValueByName: name === null ? null : { name },
      })),
    });

  // #932-T08
  it("asks for the not archived board items of the ticket with the board token, and answers the first status", async () => {
    const { client, calls } = scripted((call) =>
      call.path === "/graphql"
        ? statuses(null, "In Review", "Done")
        : undefined,
    );

    expect(await client.readTrackerBoardStatus("4242", BOARD, "I_12")).toEqual({
      available: true,
      status: "In Review",
    });

    expect(tokenRequests(calls)[0]?.body).toEqual({
      repository_ids: [7001],
      permissions: BOARD.permissions,
    });
    const body = calls.find((call) => call.path === "/graphql")?.body as {
      query: string;
      variables: unknown;
    };
    expect(body.variables).toEqual({ id: "I_12" });
    expect(body.query).toContain("includeArchived:false");
  });

  // #932-T09
  it("answers no status for a ticket that is on no board, or has none on its boards", async () => {
    const none = scripted((call) =>
      call.path === "/graphql" ? answer({ nodes: [] }) : undefined,
    );
    expect(
      await none.client.readTrackerBoardStatus("4242", BOARD, "I_12"),
    ).toEqual({ available: true, status: null });

    const empty = scripted((call) =>
      call.path === "/graphql" ? statuses(null, "") : undefined,
    );
    expect(
      await empty.client.readTrackerBoardStatus("4242", BOARD, "I_12"),
    ).toEqual({ available: true, status: null });

    // A node that is none (deleted since) has no board either.
    const gone = scripted((call) =>
      call.path === "/graphql" ? { json: { data: { node: null } } } : undefined,
    );
    expect(
      await gone.client.readTrackerBoardStatus("4242", BOARD, "I_12"),
    ).toEqual({ available: true, status: null });
  });

  // #932-T10
  it.each([
    [
      "GraphQL says the app may not read it",
      { errors: [{ type: "FORBIDDEN" }] },
    ],
    ["the answer is not a ticket's", { data: { node: { id: "x" } } }],
  ])("is not available when %s", async (_name, json) => {
    const { client } = scripted((call) =>
      call.path === "/graphql" ? { json } : undefined,
    );

    expect(await client.readTrackerBoardStatus("4242", BOARD, "I_12")).toEqual({
      available: false,
      status: null,
    });
  });

  // #932-R21
  it("answers the status the readable board items give when one board item is refused", async () => {
    const { client } = scripted((call) =>
      call.path === "/graphql"
        ? {
            json: {
              data: {
                node: {
                  projectItems: {
                    nodes: [null, { fieldValueByName: { name: "In Review" } }],
                  },
                },
              },
              errors: [
                {
                  type: "FORBIDDEN",
                  path: ["node", "projectItems", "nodes", 0],
                },
              ],
            },
          }
        : undefined,
    );

    expect(await client.readTrackerBoardStatus("4242", BOARD, "I_12")).toEqual({
      available: true,
      status: "In Review",
    });
  });

  // #932-R22
  it("is not available when the ticket itself is refused: no data, no status", async () => {
    const { client } = scripted((call) =>
      call.path === "/graphql"
        ? {
            json: {
              data: { node: null },
              errors: [{ type: "NOT_FOUND" }],
            },
          }
        : undefined,
    );

    expect(await client.readTrackerBoardStatus("4242", BOARD, "I_12")).toEqual({
      available: false,
      status: null,
    });
  });

  // #932-T11
  it("fails, and does not read as 'no board', when GitHub has an error that is not about the permission", async () => {
    const { client } = scripted((call) =>
      call.path === "/graphql"
        ? { json: { errors: [{ type: "RATE_LIMITED", message: "slow down" }] } }
        : undefined,
    );

    await expect(
      client.readTrackerBoardStatus("4242", BOARD, "I_12"),
    ).rejects.toBeInstanceOf(GithubAppError);
  });

  // #932-T12
  it("refuses a node id that is no usable id before asking anything", async () => {
    const { client, calls } = scripted(() => undefined);

    await expect(
      client.readTrackerBoardStatus("4242", BOARD, ""),
    ).rejects.toBeInstanceOf(GithubAppError);
    expect(calls).toEqual([]);
  });
});
