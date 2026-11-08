// SPDX-License-Identifier: LicenseRef-Proprietary

// #917: the provider-neutral connectors (`pullRequest.open`, `pullRequest.comment`, `ticket.comment`, `ticket.labels`) and the two new
// ones (`ticket.setStatus`, `ticket.requestReview`), through the real GitHub App provider on an in-memory client: that each name does
// what it says with the narrowest token, that the `github.*` aliases still do the same, and how each refusal comes back. What the client
// sends over HTTP is pinned down in `client-board-review.test.ts`.
import { describe, expect, it } from "vitest";
import {
  fakeGithubAppClient,
  type FakeGithubAppClientData,
} from "./fake-client.ts";
import { loadGithubAppConfig } from "./config.ts";
import { GithubAppError } from "./errors.ts";
import { WORKFLOW_ACTION_TOKEN_PERMISSIONS } from "./job-access.ts";
import { createGithubAppProvider } from "./provider.ts";
import { fakeIntegration } from "../../../test-support/fake-integration-provider.ts";
import { testGithubAppEnv } from "../../../test-support/github-app.ts";
import type { RepoRef } from "../../types.ts";
import {
  ActionInputError,
  ConnectorError,
  type ActionCall,
} from "../../../workflow-runs/connectors.ts";
import { createGithubConnectors } from "../../../workflow-runs/github-connectors.ts";
import { BUILT_IN_CONNECTORS } from "../../../workflows/connectors.ts";

const integration = fakeIntegration({
  id: "integration-1",
  externalId: "4242",
});
const widgets: RepoRef = {
  integrationId: "integration-1",
  externalId: "7001",
  fullName: "acme/widgets",
  url: "https://github.com/acme/widgets",
};

function setup(
  data: FakeGithubAppClientData = {},
  projectMembers?: (call: ActionCall) => Promise<string[]>,
  projectBoard?: (call: ActionCall) => Promise<string | undefined>,
) {
  const client = fakeGithubAppClient(data);
  const provider = createGithubAppProvider({
    config: loadGithubAppConfig(testGithubAppEnv()),
    client,
  });
  const connectors = createGithubConnectors({
    targetOf: async () => ({ provider, integration, repo: widgets }),
    ...(projectMembers === undefined ? {} : { projectMembers }),
    ...(projectBoard === undefined ? {} : { projectBoard }),
  });
  const connector = (name: string) => {
    const found = connectors.find((candidate) => candidate.name === name);
    if (found === undefined) throw new Error(`no connector ${name}`);
    return found;
  };
  return { client, connector, connectors };
}

function call(inputs: Record<string, unknown>): ActionCall {
  return {
    workspaceId: "w1",
    runId: "r1",
    stepId: "step",
    repository: { id: "repo-1", fullName: "acme/widgets" },
    baseBranch: "main",
    inputs,
    idempotencyKey: "wf-r1-1",
    stepCreatedAt: "2026-11-05T10:00:00.000Z",
    signal: new AbortController().signal,
  };
}

async function failure(run: Promise<unknown>): Promise<Error> {
  const error = await run.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof Error)) throw new Error("expected a failure");
  return error;
}

const tokenRefused = new GithubAppError(
  "GITHUB_APP_REQUEST_FAILED",
  "GitHub answered 422 for POST /app/installations/{id}/access_tokens.",
  { status: 422, duringTokenRequest: true, refusal: "permission_missing" },
);

describe("the connectors of the engine", () => {
  // #917-T100
  it("has one connector for each name of the catalog, the aliases included, and one token entry for each", () => {
    const { connectors } = setup();

    const names = BUILT_IN_CONNECTORS.map((spec) => spec.name).sort();

    expect(connectors.map((connector) => connector.name).sort()).toEqual(names);
    expect(Object.keys(WORKFLOW_ACTION_TOKEN_PERMISSIONS).sort()).toEqual(
      names,
    );
  });
});

describe("ticket.setStatus", () => {
  // #917-T110
  it("moves the issue to the status on the board with a token for projects and issues of this repository, and yields the status", async () => {
    const { client, connector } = setup();

    const output = await connector("ticket.setStatus").run(
      call({ ticket: 5, board: "7", status: "In review" }),
    );

    expect(output).toEqual({ status: "In review" });
    const [moved] = client.calls.filter((c) => c.method === "moveIssueOnBoard");
    expect(moved?.args.slice(0, 5)).toEqual([
      "4242",
      {
        repositoryIds: [7001],
        permissions: {
          organization_projects: "write",
          issues: "read",
          metadata: "read",
        },
      },
      "acme/widgets",
      5,
      { board: "7", status: "In review" },
    ]);
  });

  // #917-T111
  it("ends with board_status_unknown and names the statuses of the board when there is none of that name", async () => {
    const { connector } = setup({
      boardMove: { kind: "status_unknown", available: ["Todo", "Done"] },
    });

    const error = await failure(
      connector("ticket.setStatus").run(
        call({ ticket: 5, board: "7", status: "Doing" }),
      ),
    );

    expect(error).toBeInstanceOf(ConnectorError);
    expect((error as ConnectorError).code).toBe("board_status_unknown");
    expect(error.message).toContain("Todo, Done");
    expect(error.message).not.toContain("Doing");
  });

  // #917-T112
  it("says that a board without a Status field has no statuses, and cleans and bounds the names it lists", async () => {
    const none = setup({
      boardMove: { kind: "status_unknown", available: [] },
    });
    const many = setup({
      boardMove: {
        kind: "status_unknown",
        available: [
          "See https://evil.example now",
          ...Array.from({ length: 25 }, (_, i) => `Column ${String(i)}`),
        ],
      },
    });
    const input = call({ ticket: 5, board: "7", status: "x" });

    const noneError = await failure(
      none.connector("ticket.setStatus").run(input),
    );
    const manyError = await failure(
      many.connector("ticket.setStatus").run(input),
    );

    expect(noneError.message).toContain("no Status field with options");
    expect(manyError.message).toContain("[link]");
    expect(manyError.message).not.toContain("evil.example");
    expect(manyError.message).toContain("and 6 more");
  });

  // #917-T113
  it("ends with github_not_found for a board that is not among the projects of the owner and for an issue that is not there", async () => {
    const noBoard = setup({ boardMove: { kind: "board_not_found" } });
    const noIssue = setup({ boardMove: { kind: "issue_not_found" } });
    const input = call({ ticket: 5, board: "7", status: "Done" });

    const boardError = await failure(
      noBoard.connector("ticket.setStatus").run(input),
    );
    const issueError = await failure(
      noIssue.connector("ticket.setStatus").run(input),
    );

    expect((boardError as ConnectorError).code).toBe("github_not_found");
    expect(boardError.message).toContain("GitHub Project");
    expect((issueError as ConnectorError).code).toBe("github_not_found");
    expect(issueError.message).toContain("no issue");
  });

  // #917-T114
  it("ends with github_permission_missing and names the Projects permission when the App does not hold it", async () => {
    const { connector } = setup({ boardFailure: tokenRefused });

    const error = await failure(
      connector("ticket.setStatus").run(
        call({ ticket: 5, board: "7", status: "Done" }),
      ),
    );

    expect((error as ConnectorError).code).toBe("github_permission_missing");
    expect(error.message).toContain("Projects: Read and write");
  });

  // #917-T115
  it("refuses a board or a status that is not what the action takes before it asks GitHub", async () => {
    const { client, connector } = setup();

    for (const inputs of [
      { ticket: 5, board: "seven", status: "Done" },
      { ticket: 5, board: "7", status: "   " },
      { ticket: 5, board: "7", status: "Do\nne" },
      { ticket: 0, board: "7", status: "Done" },
    ])
      expect(
        await failure(connector("ticket.setStatus").run(call(inputs))),
      ).toBeInstanceOf(ActionInputError);
    expect(client.calls).toEqual([]);
  });

  // #922-T51
  it("takes the board of the project when the step names none, and the board of the step when it names one", async () => {
    const { client, connector } = setup({}, undefined, async () => "PVT_board");

    await connector("ticket.setStatus").run(
      call({ ticket: 5, status: "Done" }),
    );
    await connector("ticket.setStatus").run(
      call({ ticket: 5, board: "7", status: "Done" }),
    );

    const boards = client.calls
      .filter((c) => c.method === "moveIssueOnBoard")
      .map((c) => (c.args[4] as { board: string }).board);
    expect(boards).toEqual(["PVT_board", "7"]);
  });

  // #922-T52
  it("is an action_input_invalid, before GitHub is asked, when the step names no board and the project has none", async () => {
    const withoutBoard = setup({}, undefined, async () => undefined);
    const withoutHook = setup();

    for (const { client, connector } of [withoutBoard, withoutHook]) {
      const error = await failure(
        connector("ticket.setStatus").run(call({ ticket: 5, status: "Done" })),
      );
      expect(error).toBeInstanceOf(ActionInputError);
      expect(error.message).toContain("has no board");
      expect(client.calls).toEqual([]);
    }
  });

  // #917-T116
  it("is idempotent, so a timeout of it does not say that it may have happened", () => {
    expect(setup().connector("ticket.setStatus").idempotent).toBe(true);
  });
});

describe("ticket.requestReview", () => {
  // #917-T120
  it("asks the logins for a review of the pull request with a token for pull requests only, and yields who is asked", async () => {
    const { client, connector } = setup();

    const output = await connector("ticket.requestReview").run(
      call({ pullRequest: 12, reviewers: ["alice", "Bob", "alice"] }),
    );

    expect(output).toEqual({ requested: ["alice", "Bob"] });
    const [asked] = client.calls.filter(
      (c) => c.method === "requestPullRequestReviewers",
    );
    expect(asked?.args.slice(0, 6)).toEqual([
      "4242",
      {
        repositoryIds: [7001],
        permissions: { pull_requests: "write", metadata: "read" },
      },
      "acme/widgets",
      12,
      ["alice", "Bob"],
      false,
    ]);
  });

  // #917-T121
  it("asks the members of the project one by one when the text is project members, and leaves out the ones GitHub refuses", async () => {
    const { client, connector } = setup(
      { reviewersAfter: ["carol"] },
      async () => ["carol", "dave", "not a login!", "Carol"],
    );

    const output = await connector("ticket.requestReview").run(
      call({ pullRequest: 12, reviewers: "project members" }),
    );

    expect(output).toEqual({ requested: ["carol"] });
    const [asked] = client.calls.filter(
      (c) => c.method === "requestPullRequestReviewers",
    );
    expect(asked?.args.slice(4, 7)).toEqual([["carol", "dave"], true, 15]);
  });

  // #917-T125
  it("passes every member on in order, not the first 15, and lets GitHub stop at 15 that it accepts", async () => {
    const members = Array.from({ length: 20 }, (_, i) => `user${String(i)}`);
    const { client, connector } = setup(
      { reviewersAfter: members.slice(3, 18) },
      async () => members,
    );

    const output = await connector("ticket.requestReview").run(
      call({ pullRequest: 12, reviewers: "project members" }),
    );

    expect(output).toEqual({ requested: members.slice(3, 18) });
    const [asked] = client.calls.filter(
      (c) => c.method === "requestPullRequestReviewers",
    );
    expect(asked?.args.slice(4, 7)).toEqual([members, true, 15]);
  });

  // #917-T126
  it("ends with github_validation and says why when none of the members could be requested", async () => {
    const { connector } = setup({ reviewersAfter: [] }, async () => [
      "carol",
      "dave",
    ]);

    const error = await failure(
      connector("ticket.requestReview").run(
        call({ pullRequest: 12, reviewers: "project members" }),
      ),
    );

    expect(error).toBeInstanceOf(ConnectorError);
    expect((error as ConnectorError).code).toBe("github_validation");
    expect(error.message).toContain("none of the members");
  });

  // #917-T127
  it("does not hide a failure that is not about a person: a refusal for a closed pull request ends the step with github_validation", async () => {
    const { connector } = setup(
      {
        reviewersFailure: new GithubAppError(
          "GITHUB_APP_REQUEST_FAILED",
          "GitHub answered 422 for POST /repos/{owner}/{repo}/pulls/{n}/requested_reviewers.",
          {
            status: 422,
            refusal: "other",
            reason: "Review cannot be requested on closed pull requests",
          },
        ),
      },
      async () => ["carol"],
    );

    const error = await failure(
      connector("ticket.requestReview").run(
        call({ pullRequest: 12, reviewers: "project members" }),
      ),
    );

    expect((error as ConnectorError).code).toBe("github_validation");
    expect(error.message).toContain("closed pull requests");
  });

  // #917-T122
  it("is an action_input_invalid when project members cannot be resolved or none has a login", async () => {
    const unwired = setup();
    const empty = setup({}, async () => []);
    const input = call({ pullRequest: 12, reviewers: "project members" });

    expect(
      await failure(unwired.connector("ticket.requestReview").run(input)),
    ).toBeInstanceOf(ActionInputError);
    expect(
      await failure(empty.connector("ticket.requestReview").run(input)),
    ).toBeInstanceOf(ActionInputError);
    expect(unwired.client.calls).toEqual([]);
  });

  // #917-T123
  it("refuses other text than project members, a login that is none, nobody, and more than 15 people", async () => {
    const { client, connector } = setup();
    const sixteen = Array.from({ length: 16 }, (_, i) => `user${String(i)}`);

    for (const reviewers of ["everybody", ["bad login"], [], sixteen, [42]])
      expect(
        await failure(
          connector("ticket.requestReview").run(
            call({ pullRequest: 12, reviewers }),
          ),
        ),
      ).toBeInstanceOf(ActionInputError);
    expect(
      await failure(
        connector("ticket.requestReview").run(
          call({ pullRequest: 0, reviewers: ["a"] }),
        ),
      ),
    ).toBeInstanceOf(ActionInputError);
    expect(client.calls).toEqual([]);
  });

  // #917-T124
  it("ends with github_validation when GitHub refuses a person the lane names, and github_permission_missing without the permission", async () => {
    const refused = setup({
      reviewersFailure: new GithubAppError(
        "GITHUB_APP_REQUEST_FAILED",
        "GitHub answered 422 for POST /repos/{owner}/{repo}/pulls/{n}/requested_reviewers.",
        {
          status: 422,
          refusal: "other",
          reason: "Reviews may only be requested from collaborators",
        },
      ),
    });
    const noRight = setup({ reviewersFailure: tokenRefused });
    const input = call({ pullRequest: 12, reviewers: ["stranger"] });

    const validation = await failure(
      refused.connector("ticket.requestReview").run(input),
    );
    const permission = await failure(
      noRight.connector("ticket.requestReview").run(input),
    );

    expect((validation as ConnectorError).code).toBe("github_validation");
    expect(validation.message).toContain("collaborators");
    expect((permission as ConnectorError).code).toBe(
      "github_permission_missing",
    );
    expect(permission.message).toContain("Pull requests: Read and write");
  });
});

describe("the provider-neutral names and their aliases", () => {
  // #917-T130
  it("opens a pull request as pullRequest.open exactly as github.pullRequest.open does", async () => {
    const inputs = { head: "workflow/r1/work", title: "Add caching" };
    const neutral = setup();
    const github = setup();

    const a = await neutral.connector("pullRequest.open").run(call(inputs));
    const b = await github
      .connector("github.pullRequest.open")
      .run(call(inputs));

    expect(a).toEqual(b);
    expect(neutral.client.calls.map((c) => c.method)).toEqual(
      github.client.calls.map((c) => c.method),
    );
  });

  // #917-T131
  it("writes the comment below the pull request as pullRequest.comment, with the token of a comment", async () => {
    const { client, connector } = setup();

    const output = await connector("pullRequest.comment").run(
      call({ pullRequest: 12, body: "Ready for review." }),
    );

    expect(output).toMatchObject({ existing: false });
    const [written] = client.calls.filter(
      (c) => c.method === "createIssueComment",
    );
    expect(written?.args.slice(0, 5)).toEqual([
      "4242",
      {
        repositoryIds: [7001],
        permissions: { issues: "write", metadata: "read" },
      },
      "acme/widgets",
      12,
      expect.stringContaining("Ready for review.") as string,
    ]);
  });

  // #917-T132
  it.each([
    ["ticket.comment", "github.issue.comment", "ticket", { body: "Hi" }],
    ["ticket.labels", "github.issue.labels", "ticket", { add: ["triaged"] }],
  ])(
    "%s does what %s does, with the target under its own name",
    async (neutral, github, input, rest) => {
      const a = setup();
      const b = setup();

      const viaNeutral = await a
        .connector(neutral)
        .run(call({ [input]: 5, ...rest }));
      const viaGithub = await b
        .connector(github)
        .run(call({ issue: 5, ...rest }));

      expect(viaNeutral).toEqual(viaGithub);
      expect(a.client.calls.map((c) => c.args.slice(0, 4))).toEqual(
        b.client.calls.map((c) => c.args.slice(0, 4)),
      );
    },
  );

  // #917-T133
  it("keeps what a connector is for its alias: labels are idempotent, the others are not", () => {
    const { connector } = setup();

    expect(connector("ticket.labels").idempotent).toBe(true);
    expect(connector("github.issue.labels").idempotent).toBe(true);
    expect(connector("pullRequest.comment").idempotent).toBeUndefined();
    expect(connector("pullRequest.open").idempotent).toBeUndefined();
  });
});
