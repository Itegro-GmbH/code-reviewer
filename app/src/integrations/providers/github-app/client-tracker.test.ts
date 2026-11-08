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
        return {
          json: [
            // #924-T04: the list says who a review is asked from
            {
              ...pull(7),
              requested_reviewers: [{ login: "carol" }],
              updated_at: "2026-11-07T08:30:00Z",
            },
            pull(8),
          ],
        };
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
      0,
    );

    expect(page).toEqual({
      pullRequests: [
        {
          number: 7,
          checksState: "failure",
          reviewRequestedFrom: ["carol"],
          // #924-T17: the head commit now, which the marks of a review that was acted on are held against
          headSha: SHA,
          // #924-T10: the time the list read, which a newer delivery is compared with; the epoch when the entry says none
          updatedAt: "2026-11-07T08:30:00.000Z",
        },
        {
          number: 8,
          checksState: "failure",
          // an entry without a list of reviewers says nothing about them (#924-T18): the key is left out, it is not an empty list
          headSha: SHA,
          updatedAt: "1970-01-01T00:00:00.000Z",
        },
      ],
      last: true,
      lastNumber: 8,
    });
    // One token for the whole page: the checks are read with the token of the list.
    expect(tokenRequests(calls)).toHaveLength(1);
  });

  // #937-T50
  it("continues after the number it was given, over as many lists as it takes, and says where the next page continues", async () => {
    const numbers = Array.from({ length: 140 }, (_, i) => i + 1);
    const { client, calls } = scripted((call) => {
      const listed = /^\/repos\/acme\/widgets\/pulls\?.*&page=(\d+)/.exec(
        call.path,
      );
      if (listed !== null) {
        const from = (Number(listed[1]) - 1) * 100;
        return { json: numbers.slice(from, from + 100).map(pull) };
      }
      if (call.path.includes("/check-suites"))
        return { json: { check_suites: [] } };
      return undefined;
    });

    // 30 pull requests after number 95: they stand on the first and the second list.
    const page = await client.readTrackerChecks(
      "4242",
      READ,
      "acme/widgets",
      95,
    );

    expect(page.pullRequests.map((pr) => pr.number)).toEqual(
      numbers.slice(95, 125),
    );
    expect(page).toMatchObject({ last: false, lastNumber: 125 });
    expect(
      calls.filter((call) => call.path.startsWith("/repos/acme/widgets/pulls?"))
        .length,
    ).toBe(2);

    const rest = await client.readTrackerChecks(
      "4242",
      READ,
      "acme/widgets",
      125,
    );
    expect(rest.pullRequests.map((pr) => pr.number)).toEqual(
      numbers.slice(125),
    );
    expect(rest).toMatchObject({ last: true, lastNumber: 140 });
  });

  // #937-T51
  it("ends with an empty last page when nothing is left after the number, and refuses a number that is none", async () => {
    const { client } = scripted((call) =>
      call.path.startsWith("/repos/acme/widgets/pulls?")
        ? { json: [pull(7), pull(8)] }
        : undefined,
    );

    expect(
      await client.readTrackerChecks("4242", READ, "acme/widgets", 8),
    ).toEqual({ pullRequests: [], last: true, lastNumber: null });
    for (const bad of [-1, 1.5, Number.NaN])
      await expect(
        client.readTrackerChecks("4242", READ, "acme/widgets", bad),
      ).rejects.toBeInstanceOf(GithubAppError);
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

  // #937-T52
  it("reads only the chosen board, without listing the boards of the repository, and continues within it by its cursor", async () => {
    const { client, calls } = scripted((call) => {
      if (call.path !== "/graphql") return undefined;
      return { json: items(["In Progress"], true) };
    });

    const first = await client.readTrackerBoard(
      "4242",
      BOARD,
      "acme/widgets",
      null,
      "PVT_9",
    );
    expect(first).toEqual({
      available: true,
      items: [{ nodeId: "I_0", status: "In Progress" }],
      next: "0:cursor-1",
    });
    await client.readTrackerBoard(
      "4242",
      BOARD,
      "acme/widgets",
      "0:cursor-1",
      "PVT_9",
    );
    // A position that names another board by its index starts the chosen board at its first page.
    await client.readTrackerBoard(
      "4242",
      BOARD,
      "acme/widgets",
      "3:cursor-1",
      "PVT_9",
    );

    const bodies = calls
      .filter((call) => call.path === "/graphql")
      .map((call) => call.body as { query: string; variables: unknown });
    expect(bodies.every((body) => !body.query.includes("projectsV2"))).toBe(
      true,
    );
    expect(bodies.map((body) => body.variables)).toEqual([
      { project: "PVT_9", after: null, first: 100 },
      { project: "PVT_9", after: "cursor-1", first: 100 },
      { project: "PVT_9", after: null, first: 100 },
    ]);
  });

  // #937-T53
  it("is not available when the chosen board cannot be read, and ends after its last page", async () => {
    const gone = scripted((call) =>
      call.path === "/graphql" ? { json: { data: { node: null } } } : undefined,
    );
    expect(
      await gone.client.readTrackerBoard(
        "4242",
        BOARD,
        "acme/widgets",
        null,
        "PVT_gone",
      ),
    ).toEqual({ available: false, items: [], next: null });

    const last = scripted((call) =>
      call.path === "/graphql" ? { json: items(["Todo"], false) } : undefined,
    );
    expect(
      await last.client.readTrackerBoard(
        "4242",
        BOARD,
        "acme/widgets",
        null,
        "PVT_9",
      ),
    ).toMatchObject({ available: true, next: null });
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

  // #932-R23
  it("keeps the place of a board it may not read, so that the position of the boards after it does not shift", async () => {
    const refused = (type: string) => ({
      errors: [{ type, path: ["repository", "projectsV2", "nodes", 1] }],
    });
    const { client } = scripted((call) => {
      if (call.path !== "/graphql") return undefined;
      const query = (call.body as { query: string }).query;
      return {
        json: query.includes("projectsV2")
          ? {
              data: {
                repository: {
                  projectsV2: {
                    nodes: [{ id: "PVT_1" }, null, { id: "PVT_3" }],
                  },
                },
              },
              ...refused("FORBIDDEN"),
            }
          : items(["Done"], false),
      };
    });

    // The position "2:" was saved when the board in the middle could still be read: it still means the third board.
    const third = await client.readTrackerBoard(
      "4242",
      BOARD,
      "acme/widgets",
      "2:",
    );
    expect(third).toEqual({
      available: true,
      items: [{ nodeId: "I_0", status: "Done" }],
      next: null,
    });
  });

  // #932-R24
  it("goes on with the next board it may read after one it may not, and ends when there is none", async () => {
    const seen: unknown[] = [];
    const { client } = scripted((call) => {
      if (call.path !== "/graphql") return undefined;
      const body = call.body as {
        query: string;
        variables: Record<string, unknown>;
      };
      if (!body.query.includes("projectsV2")) seen.push(body.variables.project);
      return {
        json: body.query.includes("projectsV2")
          ? {
              data: {
                repository: {
                  projectsV2: {
                    nodes: [null, { id: "PVT_2" }, null, { id: "PVT_4" }, null],
                  },
                },
              },
              errors: [{ type: "FORBIDDEN", path: ["repository"] }],
            }
          : items(["Done"], false),
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

    expect(first.next).toBe("3:");
    expect(second.next).toBeNull();
    expect(seen).toEqual(["PVT_2", "PVT_4"]);
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

describe("the boards of a repository (#922)", () => {
  const node = (overrides: Record<string, unknown>) => ({
    id: "PVT_1",
    number: 1,
    title: "Roadmap",
    closed: false,
    field: {
      id: "PVTSSF_1",
      options: [{ name: "Todo" }, { name: "In Progress" }, { name: "Done" }],
    },
    ...overrides,
  });

  // #922-T40
  it("lists the open boards with the Status field and its options, with a token that holds the board permission and nothing else", async () => {
    const { client, calls } = scripted((call) =>
      call.path === "/graphql"
        ? {
            json: {
              data: {
                repository: {
                  projectsV2: {
                    nodes: [
                      node({}),
                      node({
                        id: "PVT_2",
                        number: 2,
                        title: "Old",
                        closed: true,
                      }),
                      // A board without a Status field: it can be listed, no ticket can be moved on it.
                      node({
                        id: "PVT_3",
                        number: 3,
                        title: "Loose",
                        field: null,
                      }),
                      // Nodes of a shape that is none are skipped.
                      { id: 5 },
                    ],
                  },
                },
              },
            },
          }
        : undefined,
    );

    const answer = await client.listRepositoryBoards(
      "4242",
      BOARD,
      "acme/widgets",
    );

    expect(answer).toEqual({
      available: true,
      boards: [
        {
          projectV2Id: "PVT_1",
          number: 1,
          title: "Roadmap",
          statusFieldId: "PVTSSF_1",
          statuses: ["Todo", "In Progress", "Done"],
        },
        {
          projectV2Id: "PVT_3",
          number: 3,
          title: "Loose",
          statusFieldId: null,
          statuses: [],
        },
      ],
    });
    expect(tokenRequests(calls)[0]?.body).toEqual({
      repository_ids: [7001],
      permissions: BOARD.permissions,
    });
    const query = calls.find((call) => call.path === "/graphql")?.body as {
      query: string;
      variables: Record<string, unknown>;
    };
    expect(query.variables).toMatchObject({ owner: "acme", name: "widgets" });
    // Closed boards are left out at GitHub, so they cannot fill the page and hide the open ones.
    expect(query.query).toContain('query:"is:open"');
  });

  // #932-R25
  it("leaves a board it may not read out of the list and keeps the readable ones: an unreadable board can be neither synced nor moved on", async () => {
    const { client } = scripted((call) =>
      call.path === "/graphql"
        ? {
            json: {
              data: {
                repository: { projectsV2: { nodes: [node({}), null] } },
              },
              errors: [
                {
                  type: "FORBIDDEN",
                  path: ["repository", "projectsV2", "nodes", 1],
                },
              ],
            },
          }
        : undefined,
    );

    expect(
      await client.listRepositoryBoards("4242", BOARD, "acme/widgets"),
    ).toEqual({
      available: true,
      boards: [
        {
          projectV2Id: "PVT_1",
          number: 1,
          title: "Roadmap",
          statusFieldId: "PVTSSF_1",
          statuses: ["Todo", "In Progress", "Done"],
        },
      ],
    });
  });

  // #922-T41
  it.each(["FORBIDDEN", "INSUFFICIENT_SCOPES", "NOT_FOUND"])(
    "is not available when GitHub answers with only %s errors",
    async (type) => {
      const { client } = scripted((call) =>
        call.path === "/graphql"
          ? { json: { data: null, errors: [{ type, message: "no" }] } }
          : undefined,
      );

      expect(
        await client.listRepositoryBoards("4242", BOARD, "acme/widgets"),
      ).toEqual({ available: false, boards: [] });
    },
  );

  // #922-T42
  it("is not available when GitHub refuses the token for the board permission, and fails on anything else", async () => {
    const refused = scripted((call) =>
      /\/access_tokens$/.test(call.path)
        ? {
            status: 422,
            json: { message: "The permissions requested are not granted." },
          }
        : undefined,
    );
    expect(
      await refused.client.listRepositoryBoards("4242", BOARD, "acme/widgets"),
    ).toEqual({ available: false, boards: [] });

    const broken = scripted((call) =>
      call.path === "/graphql" ? { status: 500, json: {} } : undefined,
    );
    await expect(
      broken.client.listRepositoryBoards("4242", BOARD, "acme/widgets"),
    ).rejects.toBeInstanceOf(GithubAppError);
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

  // #937-T54
  it("answers the status of the chosen board only, whatever the other boards of the ticket say", async () => {
    const onBoards = (
      nodes: unknown[],
      hasNextPage = false,
    ): { json: unknown } => ({
      json: {
        data: { node: { projectItems: { pageInfo: { hasNextPage }, nodes } } },
      },
    });
    const item = (project: string, name: string | null) => ({
      project: { id: project },
      fieldValueByName: name === null ? null : { name },
    });
    const ask = (answer: { json: unknown }, boardId?: string) =>
      scripted((call) =>
        call.path === "/graphql" ? answer : undefined,
      ).client.readTrackerBoardStatus("4242", BOARD, "I_12", boardId);

    const two = onBoards([item("PVT_2", "Done"), item("PVT_1", "In Review")]);
    expect(await ask(two, "PVT_1")).toEqual({
      available: true,
      status: "In Review",
    });
    // Without a chosen board the first status wins, as before.
    expect(await ask(two)).toEqual({ available: true, status: "Done" });
    // On the chosen board with no status: none, even when another board has one.
    expect(
      await ask(
        onBoards([item("PVT_2", "Done"), item("PVT_1", null)]),
        "PVT_1",
      ),
    ).toEqual({ available: true, status: null });
    // Not on the chosen board: none.
    expect(await ask(onBoards([item("PVT_2", "Done")]), "PVT_1")).toEqual({
      available: true,
      status: null,
    });
    expect(await ask(onBoards([]), "PVT_1")).toEqual({
      available: true,
      status: null,
    });
    // The answer cannot say: more items than it holds, or an item GitHub could not give.
    expect(await ask(onBoards([item("PVT_2", "Done")], true), "PVT_1")).toEqual(
      { available: false, status: null },
    );
    expect(await ask(onBoards([item("PVT_2", "Done"), null]), "PVT_1")).toEqual(
      { available: false, status: null },
    );
    // ... unless the chosen board is among the items it holds.
    expect(await ask(onBoards([item("PVT_1", "Todo")], true), "PVT_1")).toEqual(
      { available: true, status: "Todo" },
    );
  });

  // #937-T55
  it("asks for the board of each item next to its status", async () => {
    const { client, calls } = scripted((call) =>
      call.path === "/graphql" ? statuses(null) : undefined,
    );
    await client.readTrackerBoardStatus("4242", BOARD, "I_12", "PVT_1");
    const body = calls.find((call) => call.path === "/graphql")?.body as {
      query: string;
    };
    expect(body.query).toContain("project{id}");
    expect(body.query).toContain("pageInfo{hasNextPage}");
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

  // #932-R26
  it("is not available when every board item of the ticket is refused: there is no status to write", async () => {
    const { client } = scripted((call) =>
      call.path === "/graphql"
        ? {
            json: {
              data: { node: { projectItems: { nodes: [null, null] } } },
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
      available: false,
      status: null,
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
