// SPDX-License-Identifier: LicenseRef-Proprietary

// #917: what the GitHub client sends to request reviewers (REST) and to move an issue on a Project board (GraphQL), against a scripted
// `fetch`: the token each call asks for, the requests in order, and how the answers of GitHub come back (a board without the option, a
// board that is not there, a missing permission). The same calls over real HTTP are not needed to pin these down: no state of GitHub's
// is involved beyond what the script answers.
import { describe, expect, it } from "vitest";
import {
  createGithubAppClient,
  type GithubAppClient,
  type JobTokenScope,
} from "./client.ts";
import { loadGithubAppConfig } from "./config.ts";
import { GithubAppError } from "./errors.ts";
import {
  BOARD_STATUS_TOKEN_PERMISSIONS,
  REVIEW_REQUEST_TOKEN_PERMISSIONS,
} from "./job-access.ts";
import { testGithubAppEnv } from "../../../test-support/github-app.ts";

type Seen = { method: string; path: string; body: unknown };
type Answer = { status?: number; json?: unknown };

const json = (answer: Answer): Response =>
  new Response(JSON.stringify(answer.json ?? {}), {
    status: answer.status ?? 200,
    headers: { "content-type": "application/json" },
  });

/** A client whose HTTP answers come from `route`; every request is kept in `seen`. */
function setup(route: (seen: Seen) => Answer | undefined) {
  const seen: Seen[] = [];
  const scripted: typeof fetch = (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as unknown)
        : undefined;
    const entry: Seen = {
      method: init?.method ?? "GET",
      path: url.pathname,
      body,
    };
    seen.push(entry);
    if (entry.path.endsWith("/access_tokens")) {
      const asked = body as {
        repository_ids: number[];
        permissions: Record<string, string>;
      };
      return Promise.resolve(
        json({
          status: 201,
          json: {
            token: `token-${seen.length}`,
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            repository_selection: "selected",
            repositories: asked.repository_ids.map((id) => ({ id })),
            permissions: asked.permissions,
          },
        }),
      );
    }
    if (entry.path === "/installation/token")
      return Promise.resolve(new Response(null, { status: 204 }));
    return Promise.resolve(json(route(entry) ?? { status: 404 }));
  };
  const client: GithubAppClient = createGithubAppClient({
    config: loadGithubAppConfig(testGithubAppEnv()),
    fetch: scripted,
  });
  const calls = () =>
    seen.filter(
      (entry) =>
        !entry.path.endsWith("/access_tokens") &&
        entry.path !== "/installation/token",
    );
  return { client, seen, calls };
}

const REVIEW: JobTokenScope = {
  repositoryIds: [7001],
  permissions: REVIEW_REQUEST_TOKEN_PERMISSIONS,
};
const BOARD: JobTokenScope = {
  repositoryIds: [7001],
  permissions: BOARD_STATUS_TOKEN_PERMISSIONS,
};
const REVIEWS_PATH = "/repos/acme/widgets/pulls/12/requested_reviewers";

const board = (options: string[] | null) => ({
  id: "PVT_board",
  field:
    options === null
      ? null
      : {
          id: "PVTSSF_status",
          options: options.map((name) => ({ id: `opt-${name}`, name })),
        },
});

/** What GraphQL answers by the query it was sent. */
function graphql(
  seen: Seen,
  answers: {
    lookup: unknown;
    add?: unknown;
    set?: unknown;
    /** `errors` that come next to the `data` of the mutation that adds the card, or the one that sets the status. */
    addErrors?: unknown;
    setErrors?: unknown;
  },
): Answer | undefined {
  if (seen.path !== "/graphql") return undefined;
  const query = (seen.body as { query: string }).query;
  if (query.includes("addProjectV2ItemById"))
    return {
      json: {
        data: answers.add ?? {
          addProjectV2ItemById: { item: { id: "PVTI_card" } },
        },
        ...(answers.addErrors === undefined
          ? {}
          : { errors: answers.addErrors }),
      },
    };
  if (query.includes("updateProjectV2ItemFieldValue"))
    return {
      json: {
        data: answers.set ?? {
          updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_card" } },
        },
        ...(answers.setErrors === undefined
          ? {}
          : { errors: answers.setErrors }),
      },
    };
  return { json: { data: answers.lookup } };
}

const lookupByNumber = (
  projectV2: unknown,
  issue: unknown = { id: "I_issue" },
) => ({
  repository: { issue, owner: { projectV2 } },
});

async function failureOf(run: Promise<unknown>): Promise<GithubAppError> {
  const error = await run.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(GithubAppError);
  return error as GithubAppError;
}

describe("requesting reviewers", () => {
  // #917-T200
  it("asks for the logins with a token for pull requests only and answers the ones GitHub lists as asked", async () => {
    const { client, seen, calls } = setup((entry) =>
      entry.path === REVIEWS_PATH
        ? {
            status: 201,
            json: {
              requested_reviewers: [
                { login: "Alice" },
                { login: "someone-else" },
              ],
            },
          }
        : undefined,
    );

    const requested = await client.requestPullRequestReviewers(
      "4242",
      REVIEW,
      "acme/widgets",
      12,
      ["alice", "bob"],
    );

    expect(requested).toEqual(["Alice"]);
    expect(calls()).toEqual([
      {
        method: "POST",
        path: REVIEWS_PATH,
        body: { reviewers: ["alice", "bob"] },
      },
    ]);
    expect(seen[0]?.body).toMatchObject({
      repository_ids: [7001],
      permissions: { pull_requests: "write", metadata: "read" },
    });
    expect(seen.at(-1)?.path).toBe("/installation/token");
  });

  // #917-T201
  it("refuses a login that is no GitHub user name before it sends anything", async () => {
    const { client, seen } = setup(() => undefined);

    const error = await failureOf(
      client.requestPullRequestReviewers("4242", REVIEW, "acme/widgets", 12, [
        "../admin",
      ]),
    );

    expect(error.code).toBe("GITHUB_APP_REQUEST_FAILED");
    expect(seen).toEqual([]);
  });

  // #917-T202
  it("fails the whole request when GitHub refuses a reviewer, and says so as a 422", async () => {
    const { client } = setup((entry) =>
      entry.path === REVIEWS_PATH
        ? {
            status: 422,
            json: {
              message: "Reviews may only be requested from collaborators.",
            },
          }
        : undefined,
    );

    const error = await failureOf(
      client.requestPullRequestReviewers("4242", REVIEW, "acme/widgets", 12, [
        "stranger",
      ]),
    );

    expect(error.status).toBe(422);
  });

  // #917-T203
  it("asks one by one with skipRefused and leaves out the ones GitHub refuses", async () => {
    const { client, calls } = setup((entry) => {
      if (entry.path !== REVIEWS_PATH) return undefined;
      const [login] = (entry.body as { reviewers: string[] }).reviewers;
      return login === "stranger"
        ? {
            status: 422,
            json: {
              message:
                "Reviews may only be requested from collaborators. One or more of the users you specified is not a collaborator of the acme/widgets repository.",
            },
          }
        : { status: 201, json: { requested_reviewers: [{ login }] } };
    });

    const requested = await client.requestPullRequestReviewers(
      "4242",
      REVIEW,
      "acme/widgets",
      12,
      ["alice", "stranger", "bob"],
      { skipRefused: true },
    );

    expect(requested).toEqual(["alice", "bob"]);
    expect(calls().map((entry) => entry.body)).toEqual([
      { reviewers: ["alice"] },
      { reviewers: ["stranger"] },
      { reviewers: ["bob"] },
    ]);
  });

  // #917-T204
  it("does not skip a failure that is not a refused reviewer, also with skipRefused", async () => {
    const { client } = setup((entry) =>
      entry.path === REVIEWS_PATH ? { status: 404 } : undefined,
    );

    const error = await failureOf(
      client.requestPullRequestReviewers(
        "4242",
        REVIEW,
        "acme/widgets",
        12,
        ["alice"],
        { skipRefused: true },
      ),
    );

    expect(error.code).toBe("GITHUB_APP_NOT_FOUND");
  });

  // #917-T205
  it("leaves out the author of the pull request with skipRefused, but not a 422 that is about something else", async () => {
    const author = setup((entry) => {
      if (entry.path !== REVIEWS_PATH) return undefined;
      const [login] = (entry.body as { reviewers: string[] }).reviewers;
      return login === "writer"
        ? {
            status: 422,
            json: {
              message: "Review cannot be requested from pull request author.",
            },
          }
        : { status: 201, json: { requested_reviewers: [{ login }] } };
    });
    const closed = setup((entry) =>
      entry.path === REVIEWS_PATH
        ? {
            status: 422,
            json: {
              message: "Review cannot be requested on closed pull requests.",
            },
          }
        : undefined,
    );

    expect(
      await author.client.requestPullRequestReviewers(
        "4242",
        REVIEW,
        "acme/widgets",
        12,
        ["writer", "bob"],
        { skipRefused: true },
      ),
    ).toEqual(["bob"]);
    const error = await failureOf(
      closed.client.requestPullRequestReviewers(
        "4242",
        REVIEW,
        "acme/widgets",
        12,
        ["alice", "bob"],
        { skipRefused: true },
      ),
    );
    expect(error.status).toBe(422);
    expect(closed.calls()).toHaveLength(1);
  });

  // #917-T206
  it("stops asking once max users are requested, counting the ones that were refused as not asked", async () => {
    const { client, calls } = setup((entry) => {
      if (entry.path !== REVIEWS_PATH) return undefined;
      const [login] = (entry.body as { reviewers: string[] }).reviewers;
      return login === "stranger"
        ? {
            status: 422,
            json: {
              message: "Reviews may only be requested from collaborators.",
            },
          }
        : { status: 201, json: { requested_reviewers: [{ login }] } };
    });

    const requested = await client.requestPullRequestReviewers(
      "4242",
      REVIEW,
      "acme/widgets",
      12,
      ["stranger", "alice", "bob", "carol"],
      { skipRefused: true, max: 2 },
    );

    expect(requested).toEqual(["alice", "bob"]);
    expect(calls().map((entry) => entry.body)).toEqual([
      { reviewers: ["stranger"] },
      { reviewers: ["alice"] },
      { reviewers: ["bob"] },
    ]);
  });
});

describe("moving an issue on a board", () => {
  // #917-T210
  it("looks the board up by its number, adds the issue to it and sets the option of the status, with a token for projects and issues", async () => {
    const { client, seen, calls } = setup((entry) =>
      graphql(entry, {
        lookup: lookupByNumber(board(["Todo", "In review", "Done"])),
      }),
    );

    const moved = await client.moveIssueOnBoard(
      "4242",
      BOARD,
      "acme/widgets",
      5,
      { board: "7", status: "In review" },
    );

    expect(moved).toEqual({ kind: "moved", status: "In review" });
    expect(seen[0]?.body).toMatchObject({
      repository_ids: [7001],
      permissions: {
        organization_projects: "write",
        issues: "read",
        metadata: "read",
      },
    });
    const [lookup, add, set] = calls().map(
      (entry) =>
        entry.body as { query: string; variables: Record<string, unknown> },
    );
    expect(lookup?.variables).toEqual({
      owner: "acme",
      name: "widgets",
      issue: 5,
      board: 7,
    });
    expect(add?.variables).toEqual({
      project: "PVT_board",
      content: "I_issue",
    });
    expect(set?.variables).toEqual({
      project: "PVT_board",
      item: "PVTI_card",
      field: "PVTSSF_status",
      option: "opt-In review",
    });
    expect(seen.at(-1)?.path).toBe("/installation/token");
  });

  // #917-T211
  it("looks the board up by its node id when that is what was given", async () => {
    const { client, calls } = setup((entry) =>
      graphql(entry, {
        lookup: {
          repository: { issue: { id: "I_issue" } },
          node: { ...board(["Done"]), owner: { login: "Acme" } },
        },
      }),
    );

    const moved = await client.moveIssueOnBoard(
      "4242",
      BOARD,
      "acme/widgets",
      5,
      {
        board: "PVT_kwDOabc-_1",
        status: "Done",
      },
    );

    expect(moved).toEqual({ kind: "moved", status: "Done" });
    expect(
      (calls()[0]?.body as { variables: Record<string, unknown> }).variables
        .board,
    ).toBe("PVT_kwDOabc-_1");
  });

  // #917-T212
  it("answers the options of the board and changes nothing when the status is not one of them", async () => {
    const { client, calls } = setup((entry) =>
      graphql(entry, { lookup: lookupByNumber(board(["Todo", "Done"])) }),
    );

    const moved = await client.moveIssueOnBoard(
      "4242",
      BOARD,
      "acme/widgets",
      5,
      {
        board: "7",
        status: "done",
      },
    );

    expect(moved).toEqual({
      kind: "status_unknown",
      available: ["Todo", "Done"],
    });
    expect(calls()).toHaveLength(1);
  });

  // #917-T213
  it("answers no options for a board without a Status field", async () => {
    const { client } = setup((entry) =>
      graphql(entry, { lookup: lookupByNumber(board(null)) }),
    );

    expect(
      await client.moveIssueOnBoard("4242", BOARD, "acme/widgets", 5, {
        board: "7",
        status: "Done",
      }),
    ).toEqual({ kind: "status_unknown", available: [] });
  });

  // #917-T214
  it("answers board_not_found when there is no project of that number, and issue_not_found when there is no such issue", async () => {
    const noBoard = setup((entry) =>
      graphql(entry, { lookup: lookupByNumber(null) }),
    );
    const noIssue = setup((entry) =>
      graphql(entry, { lookup: lookupByNumber(board(["Done"]), null) }),
    );

    expect(
      await noBoard.client.moveIssueOnBoard("4242", BOARD, "acme/widgets", 5, {
        board: "7",
        status: "Done",
      }),
    ).toEqual({ kind: "board_not_found" });
    expect(
      await noIssue.client.moveIssueOnBoard("4242", BOARD, "acme/widgets", 5, {
        board: "7",
        status: "Done",
      }),
    ).toEqual({ kind: "issue_not_found" });
  });

  // #917-T215
  it("rejects with a refusal of the permission when GraphQL says FORBIDDEN, and with a rate limit when it says RATE_LIMITED", async () => {
    const forbidden = setup((entry) =>
      entry.path === "/graphql"
        ? {
            json: {
              data: null,
              errors: [
                {
                  type: "FORBIDDEN",
                  message: "Resource not accessible by integration",
                },
              ],
            },
          }
        : undefined,
    );
    const limited = setup((entry) =>
      entry.path === "/graphql"
        ? {
            json: {
              data: null,
              errors: [
                { type: "RATE_LIMITED", message: "API rate limit exceeded" },
              ],
            },
          }
        : undefined,
    );

    const refused = await failureOf(
      forbidden.client.moveIssueOnBoard("4242", BOARD, "acme/widgets", 5, {
        board: "7",
        status: "Done",
      }),
    );
    const waiting = await failureOf(
      limited.client.moveIssueOnBoard("4242", BOARD, "acme/widgets", 5, {
        board: "7",
        status: "Done",
      }),
    );

    expect(refused).toMatchObject({
      code: "GITHUB_APP_FORBIDDEN",
      refusal: "permission_missing",
    });
    expect(waiting.code).toBe("GITHUB_APP_RATE_LIMITED");
  });

  // #917-T216
  it("refuses a board that is neither a project number nor a node id before it sends anything", async () => {
    const { client, seen } = setup(() => undefined);

    for (const board of ["0", "-1", "7; drop", "PVT_", "other_id", ""])
      expect(
        (
          await failureOf(
            client.moveIssueOnBoard("4242", BOARD, "acme/widgets", 5, {
              board,
              status: "Done",
            }),
          )
        ).code,
      ).toBe("GITHUB_APP_REQUEST_FAILED");
    expect(seen).toEqual([]);
  });
  // #917-T217
  it("answers board_not_found for a node id of a project that belongs to another owner or to none, and moves nothing", async () => {
    const lookupOf = (node: unknown) => ({
      repository: { issue: { id: "I_issue" } },
      node,
    });
    const elsewhere = setup((entry) =>
      graphql(entry, {
        lookup: lookupOf({ ...board(["Done"]), owner: { login: "other-org" } }),
      }),
    );
    const unowned = setup((entry) =>
      graphql(entry, { lookup: lookupOf(board(["Done"])) }),
    );

    for (const { client, calls } of [elsewhere, unowned]) {
      expect(
        await client.moveIssueOnBoard("4242", BOARD, "acme/widgets", 5, {
          board: "PVT_kwDOabc-_1",
          status: "Done",
        }),
      ).toEqual({ kind: "board_not_found" });
      expect(calls()).toHaveLength(1);
    }
  });

  // #917-T218
  it("rejects when GraphQL answers errors next to partial data on the mutation that sets the status or the one that adds the card", async () => {
    const lookup = lookupByNumber(board(["Done"]));
    const sets = setup((entry) =>
      graphql(entry, {
        lookup,
        set: { updateProjectV2ItemFieldValue: null },
        setErrors: [{ type: "UNPROCESSABLE", message: "The option is gone." }],
      }),
    );
    const adds = setup((entry) =>
      graphql(entry, {
        lookup,
        add: { addProjectV2ItemById: null },
        addErrors: [{ type: "NOT_FOUND", message: "Could not resolve." }],
      }),
    );
    const bare = setup((entry) =>
      graphql(entry, {
        lookup,
        set: { updateProjectV2ItemFieldValue: { projectV2Item: null } },
      }),
    );
    const move = { board: "7", status: "Done" };

    const refused = await failureOf(
      sets.client.moveIssueOnBoard("4242", BOARD, "acme/widgets", 5, move),
    );
    const missing = await failureOf(
      adds.client.moveIssueOnBoard("4242", BOARD, "acme/widgets", 5, move),
    );
    const noItem = await failureOf(
      bare.client.moveIssueOnBoard("4242", BOARD, "acme/widgets", 5, move),
    );

    expect(refused).toMatchObject({
      code: "GITHUB_APP_REQUEST_FAILED",
      status: 422,
      reason: "The option is gone.",
    });
    expect(missing).toMatchObject({
      code: "GITHUB_APP_NOT_FOUND",
      status: 404,
    });
    expect(noItem.code).toBe("GITHUB_APP_REQUEST_FAILED");
    expect(adds.calls()).toHaveLength(2);
  });
});

describe("taking review requests back", () => {
  // #924-T210
  it("deletes the request of a login with a token for pull requests only and answers who is still asked", async () => {
    const { client, seen, calls } = setup((entry) =>
      entry.path === REVIEWS_PATH
        ? { json: { requested_reviewers: [{ login: "Bob" }] } }
        : undefined,
    );

    const left = await client.removePullRequestReviewers(
      "4242",
      REVIEW,
      "acme/widgets",
      12,
      ["alice"],
    );

    expect(left).toEqual(["Bob"]);
    expect(calls()).toEqual([
      { method: "DELETE", path: REVIEWS_PATH, body: { reviewers: ["alice"] } },
    ]);
    expect(seen[0]?.body).toMatchObject({
      repository_ids: [7001],
      permissions: { pull_requests: "write", metadata: "read" },
    });
    expect(seen.at(-1)?.path).toBe("/installation/token");
  });

  // #924-T211
  it("refuses a login that is no GitHub user name before it sends anything, and an answer that is not a pull request", async () => {
    const refused = setup(() => undefined);
    const odd = setup((entry) =>
      entry.path === REVIEWS_PATH ? { json: { unexpected: true } } : undefined,
    );

    const error = await failureOf(
      refused.client.removePullRequestReviewers(
        "4242",
        REVIEW,
        "acme/widgets",
        12,
        ["../admin"],
      ),
    );
    const shape = await failureOf(
      odd.client.removePullRequestReviewers(
        "4242",
        REVIEW,
        "acme/widgets",
        12,
        ["alice"],
      ),
    );

    expect(error.code).toBe("GITHUB_APP_REQUEST_FAILED");
    expect(refused.seen).toEqual([]);
    expect(shape.code).toBe("GITHUB_APP_REQUEST_FAILED");
  });

  // #924-T212
  it("rejects like the other calls when GitHub refuses (a 422 for a login that was not asked)", async () => {
    const { client } = setup((entry) =>
      entry.path === REVIEWS_PATH
        ? { status: 422, json: { message: "Review request not found." } }
        : undefined,
    );

    const error = await failureOf(
      client.removePullRequestReviewers("4242", REVIEW, "acme/widgets", 12, [
        "alice",
      ]),
    );

    expect(error.status).toBe(422);
  });
});
