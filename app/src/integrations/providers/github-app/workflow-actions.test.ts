// SPDX-License-Identifier: LicenseRef-Proprietary

// #844: the three GitHub actions, through the real GitHub App provider on an in-memory client. What the client sends over HTTP is
// pinned down against the fake GitHub in `client-actions.integration.test.ts`.
import { describe, expect, it } from "vitest";
import {
  fakeGithubAppClient,
  type FakeGithubAppClientData,
} from "./fake-client.ts";
import { loadGithubAppConfig } from "./config.ts";
import { GithubAppError } from "./errors.ts";
import { createGithubAppProvider } from "./provider.ts";
import { fakeIntegration } from "../../../test-support/fake-integration-provider.ts";
import { testGithubAppEnv } from "../../../test-support/github-app.ts";
import type { RepoRef } from "../../types.ts";
import { IntegrationError } from "../../errors.ts";
import {
  ActionInputError,
  ConnectorError,
  CONNECTOR_FAILURE_CODES,
  MAY_HAVE_HAPPENED,
  type ActionCall,
} from "../../../workflow-runs/connectors.ts";
import {
  cleanBody,
  cleanTitle,
  createGithubConnectors,
} from "../../../workflow-runs/github-connectors.ts";
import {
  ACTION_BODY_MAX_CHARS,
  ACTION_LABELS_MAX,
  ACTION_TITLE_MAX_CHARS,
} from "../../../workflow-runs/limits.ts";
import { STEP_FAILURE_CODES } from "../../../workflow-runs/errors.ts";

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

function setup(data: FakeGithubAppClientData = {}, repo: RepoRef = widgets) {
  const client = fakeGithubAppClient(data);
  const provider = createGithubAppProvider({
    config: loadGithubAppConfig(testGithubAppEnv()),
    client,
  });
  const connectors = createGithubConnectors({
    targetOf: async () => ({ provider, integration, repo }),
  });
  const connector = (name: string) => {
    const found = connectors.find((candidate) => candidate.name === name);
    if (found === undefined) throw new Error(`no connector ${name}`);
    return found;
  };
  return { client, connector };
}

function call(
  inputs: Record<string, unknown>,
  signal: AbortSignal = new AbortController().signal,
): ActionCall {
  return {
    workspaceId: "w1",
    runId: "r1",
    stepId: "open",
    repository: { id: "repo-1", fullName: "acme/widgets" },
    baseBranch: "main",
    inputs,
    idempotencyKey: "wf-r1-1",
    stepCreatedAt: "2026-11-05T10:00:00.000Z",
    signal,
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

const forbidden = new GithubAppError(
  "GITHUB_APP_FORBIDDEN",
  "GitHub answered 403 for POST /repos/{owner}/{repo}/pulls.",
  { status: 403, refusal: "permission_missing" },
);
/** A 422 of the call itself (not of the token request) with the reason the GitHub client read from the answer, if it read one. */
const refusedFor = (reason: string | undefined) =>
  new GithubAppError(
    "GITHUB_APP_REQUEST_FAILED",
    "GitHub answered 422 for POST /repos/{owner}/{repo}/pulls.",
    {
      status: 422,
      refusal: "other",
      ...(reason === undefined ? {} : { reason }),
    },
  );
const tokenRefused = new GithubAppError(
  "GITHUB_APP_REQUEST_FAILED",
  "GitHub answered 422 for POST /app/installations/{id}/access_tokens.",
  { status: 422, duringTokenRequest: true, refusal: "permission_missing" },
);

describe("github.pullRequest.open", () => {
  // #844-T300
  it("opens a pull request on the repository of the run with a token for pull requests and the contents it reads, and reports number and url", async () => {
    const { client, connector } = setup();

    const output = await connector("github.pullRequest.open").run(
      call({
        head: "workflow/r1/work",
        title: "Add caching",
        body: "Closes #7",
        draft: true,
      }),
    );

    expect(output).toEqual({
      number: 12,
      url: "https://github.com/acme/widgets/pull/12",
      existing: false,
    });
    const [opened] = client.calls.filter((c) => c.method === "openPullRequest");
    expect(opened?.args.slice(0, 2)).toEqual([
      "4242",
      {
        repositoryIds: [7001],
        permissions: {
          pull_requests: "write",
          contents: "read",
          metadata: "read",
        },
      },
    ]);
    // The base is the branch the run started from when the node names none.
    expect(opened?.args[2]).toBe("acme/widgets");
    expect(opened?.args[3]).toEqual({
      head: "workflow/r1/work",
      base: "main",
      title: "Add caching",
      body: "Closes #7",
      draft: true,
    });
  });

  // #844-T301
  it("takes an open pull request for the same branches as the result", async () => {
    const { connector } = setup({
      openedPullRequest: {
        number: 5,
        url: "https://github.com/acme/widgets/pull/5",
        existing: true,
      },
    });

    await expect(
      connector("github.pullRequest.open").run(
        call({ head: "workflow/r1/work", base: "dev", title: "T" }),
      ),
    ).resolves.toEqual({
      number: 5,
      url: "https://github.com/acme/widgets/pull/5",
      existing: true,
    });
  });

  // #844-T302
  it("holds the inputs to data: one line title, a bounded body, a plain branch of this repository", async () => {
    const { client, connector } = setup();
    const run = (inputs: Record<string, unknown>) =>
      connector("github.pullRequest.open").run(call(inputs));

    await run({
      head: "workflow/r1/work",
      title: `Line one\nLine two\r\n\t${"x".repeat(400)}`,
      body: "b".repeat(ACTION_BODY_MAX_CHARS + 500),
    });
    const sent = client.calls.find((c) => c.method === "openPullRequest")
      ?.args[3] as { title: string; body: string };
    expect(sent.title).not.toMatch(/[\r\n\t]/);
    expect(sent.title.startsWith("Line one Line two x")).toBe(true);
    expect(sent.title.length).toBeLessThanOrEqual(ACTION_TITLE_MAX_CHARS);
    expect(sent.body.startsWith("b".repeat(ACTION_BODY_MAX_CHARS))).toBe(true);
    expect(sent.body).toContain("500 more characters were left out");

    for (const head of [
      "other-owner:branch",
      "",
      "-x",
      "a..b",
      "a b",
      "main.lock",
      "a".repeat(300),
    ])
      expect(await failure(run({ head, title: "T" }))).toBeInstanceOf(
        ActionInputError,
      );
    expect(
      await failure(run({ head: "workflow/r1/work", title: " \n " })),
    ).toBeInstanceOf(ActionInputError);
    expect(
      await failure(run({ head: "main", base: "main", title: "T" })),
    ).toBeInstanceOf(ActionInputError);
  });

  // #844-T303
  it("ends with github_permission_missing and names the permission when the App lacks the right (403, or the token refused)", async () => {
    for (const openPullRequestFailure of [forbidden, tokenRefused]) {
      const { connector } = setup({ openPullRequestFailure });
      const error = await failure(
        connector("github.pullRequest.open").run(
          call({ head: "workflow/r1/work", title: "T" }),
        ),
      );
      expect(error).toBeInstanceOf(ConnectorError);
      expect((error as ConnectorError).code).toBe("github_permission_missing");
      expect(error.message).toContain("Pull requests: Read and write");
      expect(error.message).toContain("open pull requests");
    }
  });

  // #844-T304
  it("maps not found, validation (no commits between the branches) and the rate limit to stable codes", async () => {
    const cases: [GithubAppError, string, RegExp][] = [
      [
        new GithubAppError(
          "GITHUB_APP_NOT_FOUND",
          "GitHub answered 404 for x.",
          {
            status: 404,
          },
        ),
        "github_not_found",
        /no such issue, pull request or repository/,
      ],
      [
        new GithubAppError(
          "GITHUB_APP_REQUEST_FAILED",
          "GitHub answered 422 for POST /repos/{owner}/{repo}/pulls.",
          { status: 422, refusal: "no_commits_between" },
        ),
        "github_validation",
        /no commits between/,
      ],
      [
        new GithubAppError(
          "GITHUB_APP_REQUEST_FAILED",
          "GitHub answered 422 for POST /repos/{owner}/{repo}/pulls.",
          { status: 422, refusal: "other" },
        ),
        "github_validation",
        /refused the request/,
      ],
      [
        new GithubAppError(
          "GITHUB_APP_RATE_LIMITED",
          "GitHub rate limit reached.",
          {
            status: 429,
            retryAfterSeconds: 30,
          },
        ),
        "github_rate_limited",
        /wait 30 seconds/,
      ],
      [
        new GithubAppError(
          "GITHUB_APP_UNAVAILABLE",
          "GitHub could not be reached.",
          {},
        ),
        "github_unavailable",
        /could not be reached/,
      ],
    ];
    for (const [openPullRequestFailure, code, text] of cases) {
      const { connector } = setup({ openPullRequestFailure });
      const error = await failure(
        connector("github.pullRequest.open").run(
          call({ head: "workflow/r1/work", title: "T" }),
        ),
      );
      expect(error).toBeInstanceOf(ConnectorError);
      expect((error as ConnectorError).code).toBe(code);
      expect(error.message).toMatch(text);
    }
  });

  // #913-T03
  it("names GitHub's reason in the github_validation message, and keeps the generic sentence in front of it", async () => {
    const { connector } = setup({
      openPullRequestFailure: refusedFor("PullRequest head invalid"),
    });

    const error = await failure(
      connector("github.pullRequest.open").run(
        call({ head: "workflow/r1/work", title: "T" }),
      ),
    );

    expect(error).toBeInstanceOf(ConnectorError);
    expect((error as ConnectorError).code).toBe("github_validation");
    expect(error.message).toBe(
      "GitHub refused the request: one of the values is not accepted (for example a branch that does not exist). GitHub said: PullRequest head invalid.",
    );
  });

  // #913-T03
  it("cuts GitHub's reason to its bound and defuses it: it is untrusted text and no link or token passes", async () => {
    const hostile = [
      "Ask @org/team to close #12.\n<!-- marker -->",
      "see https://evil.example/x?t=ghs_abcdefghijklmnopqrstuvwxyz0123456789",
      "token ghs_abcdefghijklmnopqrstuvwxyz0123456789 and github_pat_11ABCDEFG0abcdefghijklmnop_qrstuvwx",
      "x".repeat(2_000),
    ].join(" ");
    const { connector } = setup({
      openPullRequestFailure: refusedFor(hostile),
    });

    const error = await failure(
      connector("github.pullRequest.open").run(
        call({ head: "workflow/r1/work", title: "T" }),
      ),
    );

    expect((error as ConnectorError).code).toBe("github_validation");
    expect(error.message.length).toBeLessThanOrEqual(300);
    expect(error.message).not.toMatch(/https?:\/\//);
    expect(error.message).not.toMatch(/ghs_|github_pat_/);
    expect(error.message).not.toContain("@org");
    expect(error.message).not.toContain("<!--");
    expect(error.message).not.toMatch(/[\u0000-\u001f]/);
    expect(error.message).toContain("GitHub said: ");
  });

  // #913-T03
  it("says only the generic sentence when GitHub gave no reason", async () => {
    const { connector } = setup({
      openPullRequestFailure: refusedFor(undefined),
    });

    const error = await failure(
      connector("github.pullRequest.open").run(
        call({ head: "workflow/r1/work", title: "T" }),
      ),
    );

    expect(error.message).toBe(
      "GitHub refused the request: one of the values is not accepted (for example a branch that does not exist).",
    );
  });

  // #844-T305
  it("passes the abort signal on and fails without a request once it has fired", async () => {
    const { client, connector } = setup();
    const controller = new AbortController();
    await connector("github.pullRequest.open").run(
      call({ head: "workflow/r1/work", title: "T" }, controller.signal),
    );
    expect(
      client.calls.find((c) => c.method === "openPullRequest")?.args.at(-1),
    ).toBe(controller.signal);

    controller.abort();
    const error = await failure(
      connector("github.pullRequest.open").run(
        call({ head: "workflow/r1/other", title: "T" }, controller.signal),
      ),
    );
    expect((error as ConnectorError).code).toBe("github_unavailable");
  });

  // #844-T306
  it("never reaches another repository: a repository that is not the integration's is refused before any call", async () => {
    const { client, connector } = setup(
      {},
      { ...widgets, integrationId: "someone-elses" },
    );
    const error = await failure(
      connector("github.pullRequest.open").run(
        call({ head: "workflow/r1/work", title: "T" }),
      ),
    );
    expect((error as ConnectorError).code).toBe("github_permission_missing");
    expect(client.calls.some((c) => c.method === "openPullRequest")).toBe(
      false,
    );
  });
});

describe("github.issue.comment", () => {
  // #844-T310
  it("writes the comment with an issue token and reports the url", async () => {
    const { client, connector } = setup();

    const output = await connector("github.issue.comment").run(
      call({ issue: 7, body: "Done: https://github.com/acme/widgets/pull/12" }),
    );

    expect(output).toEqual({
      url: "https://github.com/acme/widgets/pull/7#issuecomment-5001",
      existing: false,
    });
    const [written] = client.calls.filter(
      (c) => c.method === "createIssueComment",
    );
    // The text is followed by the invisible marker of the step of the run.
    expect(written?.args.slice(0, 5)).toEqual([
      "4242",
      {
        repositoryIds: [7001],
        permissions: { issues: "write", metadata: "read" },
      },
      "acme/widgets",
      7,
      "Done: https://github.com/acme/widgets/pull/12\n\n<!-- wf-r1-1 -->",
    ]);
  });

  // #844-T311
  it("bounds the body, drops control characters and refuses an empty one or a bad issue", async () => {
    const { client, connector } = setup();
    const run = (inputs: Record<string, unknown>) =>
      connector("github.issue.comment").run(call(inputs));

    await run({
      issue: 7,
      body: `a\u0000b\u0007c\nd${"z".repeat(ACTION_BODY_MAX_CHARS)}`,
    });
    const body = client.calls.find((c) => c.method === "createIssueComment")
      ?.args[4] as string;
    expect(body.startsWith("abc\nd")).toBe(true);
    expect(body).toContain("more characters were left out");
    expect(body.endsWith("\n\n<!-- wf-r1-1 -->")).toBe(true);

    expect(await failure(run({ issue: 7, body: "  \n" }))).toBeInstanceOf(
      ActionInputError,
    );
    for (const issue of [0, -1, 1.5, "7", undefined])
      expect(await failure(run({ issue, body: "x" }))).toBeInstanceOf(
        ActionInputError,
      );
  });

  // #844-T312
  it("ends with github_permission_missing naming the issue permission, github_not_found for an unknown issue", async () => {
    const missing = setup({ commentFailure: forbidden });
    const error = await failure(
      missing
        .connector("github.issue.comment")
        .run(call({ issue: 7, body: "x" })),
    );
    expect((error as ConnectorError).code).toBe("github_permission_missing");
    expect(error.message).toContain("Issues: Read and write");
    expect(error.message).toContain("write comments");

    const unknown = setup({
      commentFailure: new GithubAppError("GITHUB_APP_NOT_FOUND", "404", {
        status: 404,
      }),
    });
    expect(
      (
        (await failure(
          unknown
            .connector("github.issue.comment")
            .run(call({ issue: 99, body: "x" })),
        )) as ConnectorError
      ).code,
    ).toBe("github_not_found");
  });

  // #844-T313
  it("keeps to the abort signal", async () => {
    const { client, connector } = setup();
    const controller = new AbortController();
    controller.abort();
    const error = await failure(
      connector("github.issue.comment").run(
        call({ issue: 7, body: "x" }, controller.signal),
      ),
    );
    expect((error as ConnectorError).code).toBe("github_unavailable");
    expect(client.calls.at(-1)?.args.at(-1)).toBe(controller.signal);
  });
});

describe("github.issue.labels", () => {
  // #844-T320
  it("adds and removes labels with an issue token and reports every label now on the issue", async () => {
    const { client, connector } = setup({
      labelsAfter: ["agent working", "bug"],
    });

    const output = await connector("github.issue.labels").run(
      call({
        issue: 7,
        add: ["agent working", "agent working"],
        remove: [" ready "],
      }),
    );

    expect(output).toEqual({ labels: ["agent working", "bug"] });
    const [changed] = client.calls.filter(
      (c) => c.method === "changeIssueLabels",
    );
    expect(changed?.args.slice(0, 5)).toEqual([
      "4242",
      {
        repositoryIds: [7001],
        permissions: { issues: "write", metadata: "read" },
      },
      "acme/widgets",
      7,
      { add: ["agent working"], remove: ["ready"] },
    ]);
  });

  // #844-T321
  it("holds the lists to data: at least one label, bounded names and count", async () => {
    const { connector } = setup();
    const run = (inputs: Record<string, unknown>) =>
      connector("github.issue.labels").run(call({ issue: 7, ...inputs }));

    for (const inputs of [
      {},
      { add: [] },
      { add: [""] },
      { add: ["x".repeat(51)] },
      { add: ["a\nb"] },
      { remove: ["."] },
      { remove: [".."] },
      { add: ["..."] },
      {
        add: Array.from(
          { length: ACTION_LABELS_MAX + 1 },
          (_, i) => `l${String(i)}`,
        ),
      },
      { remove: "bug" },
    ])
      expect(await failure(run(inputs))).toBeInstanceOf(ActionInputError);
  });

  // #844-T322
  it("maps a refused App, an unknown issue and the rate limit like the other actions", async () => {
    const cases: [GithubAppError, string][] = [
      [tokenRefused, "github_permission_missing"],
      [
        new GithubAppError("GITHUB_APP_NOT_FOUND", "404", { status: 404 }),
        "github_not_found",
      ],
      [
        new GithubAppError("GITHUB_APP_RATE_LIMITED", "limit", {
          status: 403,
          retryAfterSeconds: null,
        }),
        "github_rate_limited",
      ],
    ];
    for (const [labelsFailure, code] of cases) {
      const { connector } = setup({ labelsFailure });
      const error = await failure(
        connector("github.issue.labels").run(call({ issue: 7, add: ["x"] })),
      );
      expect((error as ConnectorError).code).toBe(code);
      if (code === "github_permission_missing")
        expect(error.message).toContain("change labels");
    }
  });

  // #844-T323
  it("keeps to the abort signal", async () => {
    const { client, connector } = setup();
    const controller = new AbortController();
    controller.abort();
    const error = await failure(
      connector("github.issue.labels").run(
        call({ issue: 7, add: ["x"] }, controller.signal),
      ),
    );
    expect((error as ConnectorError).code).toBe("github_unavailable");
    expect(client.calls.at(-1)?.args.at(-1)).toBe(controller.signal);
  });
});

describe("what a step reports and what it is told", () => {
  // #844-T307
  it("reports an address of the repository's own pages, whatever GitHub's answer says (it ends up as a link on the run page)", async () => {
    for (const url of [
      "javascript:alert(1)",
      "https://evil.example/acme/widgets/pull/5",
      "https://github.com/acme/widgets-other/pull/5",
      "https://github.com/acme/widgets/../../evil/repo/pull/5",
      "https://github.com/acme/widgets/%2e%2e/%2e%2e/evil/repo/pull/5",
      "https://github.com@evil.example/acme/widgets/pull/5",
      "https://user:pass@github.com/acme/widgets/pull/5",
      "https://github.com.evil.example/acme/widgets/pull/5",
      "https://github.com/acme/widgets",
      "http://github.com/acme/widgets/pull/5",
    ]) {
      const { connector } = setup({
        openedPullRequest: { number: 5, url, existing: false },
      });
      expect(
        await connector("github.pullRequest.open").run(
          call({ head: "workflow/r1/work", title: "T" }),
        ),
      ).toEqual({
        number: 5,
        url: "https://github.com/acme/widgets/pull/5",
        existing: false,
      });
    }
  });

  // #844-T308
  it("cuts a title and a body without tearing a surrogate pair, drops lone halves, and drops bidirectional controls from a title", () => {
    const pair = "\u{1F600}";
    // The cut falls inside the pair of the emoji: the pair goes whole.
    const title = cleanTitle(
      `${"a".repeat(ACTION_TITLE_MAX_CHARS - 2)}${pair}${pair}`,
    );
    expect(title).toBe(`${"a".repeat(ACTION_TITLE_MAX_CHARS - 2)}…`);
    expect(title).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    // A title that fits exactly is not cut.
    const exact = `${"a".repeat(ACTION_TITLE_MAX_CHARS - 3)}${pair}b`;
    expect(cleanTitle(exact)).toBe(exact);

    const body = cleanBody(
      `${"b".repeat(ACTION_BODY_MAX_CHARS - 1)}${pair}tail`,
      "body",
    );
    expect(body.startsWith("b".repeat(ACTION_BODY_MAX_CHARS - 1))).toBe(true);
    expect(body).not.toContain(pair);
    expect(body).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(body).toContain("more characters were left out");

    expect(cleanTitle("a\ud800b\udc00c")).toBe("abc");
    expect(cleanBody("a\ud800b", "body")).toBe("ab");
    expect(cleanTitle("fix ‮gnp.exe‬ ⁦x⁩ done")).toBe("fix gnp.exe x done");
    expect(cleanTitle("a\u200eb\u200fc\u061cd")).toBe("abcd");
    // A body loses the bidirectional controls as well (overrides, isolates, direction marks, the Arabic letter mark); the zero-width
    // space that defuses a mention stays.
    expect(
      cleanBody(
        "keep \u202e\u2066x\u2069\u202a\u200e\u200f\u061c here @\u200bbob",
        "body",
      ),
    ).toBe("keep x here @\u200bbob");
  });

  // #844-T309
  it("says the action may have happened when GitHub could not be reached for an action that creates something, not for labels", async () => {
    const unavailableFailure = new GithubAppError(
      "GITHUB_APP_UNAVAILABLE",
      "GitHub answered 502.",
      { status: 502 },
    );
    const run = {
      "github.pullRequest.open": { head: "workflow/r1/work", title: "T" },
      "github.issue.comment": { issue: 7, body: "x" },
      "github.issue.labels": { issue: 7, add: ["x"] },
    } as const;
    for (const [name, inputs] of Object.entries(run)) {
      const { connector } = setup({
        openPullRequestFailure: unavailableFailure,
        commentFailure: unavailableFailure,
        labelsFailure: unavailableFailure,
      });
      const error = await failure(connector(name).run(call({ ...inputs })));
      expect((error as ConnectorError).code).toBe("github_unavailable");
      if (name === "github.issue.labels")
        expect(error.message).not.toContain(MAY_HAVE_HAPPENED);
      else expect(error.message).toContain(MAY_HAVE_HAPPENED);
    }
  });

  // #844-T314
  it("writes a marker with the comment and, when the same step comes again, finds its own comment instead of writing a second", async () => {
    const marked = {
      id: "6001",
      authorLogin: "code-reviewer-test[bot]",
      body: "Done.\n\n<!-- wf-r1-1 -->",
    };
    const again = setup({ comments: { "acme/widgets#7": [marked] } });

    expect(
      await again
        .connector("github.issue.comment")
        .run(call({ issue: 7, body: "Done." })),
    ).toEqual({
      url: "https://github.com/acme/widgets/issues/7#issuecomment-6001",
      existing: true,
    });
    expect(
      again.client.calls.some((c) => c.method === "createIssueComment"),
    ).toBe(false);

    // Only the comments changed since the step began (less a margin for the clocks) are looked at, not all pages.
    expect(
      again.client.calls
        .find((c) => c.method === "listIssueComments")
        ?.args.at(-1),
    ).toMatchObject({ since: "2026-11-05T09:55:00.000Z" });

    // A comment of somebody else with the same text is not the app's, and the marker of another step is another comment.
    const other = setup({
      comments: {
        "acme/widgets#7": [
          { ...marked, id: "6002", authorLogin: "someone" },
          { ...marked, id: "6003", body: "Done.\n\n<!-- wf-r1-2 -->" },
        ],
      },
    });
    expect(
      await other
        .connector("github.issue.comment")
        .run(call({ issue: 7, body: "Done." })),
    ).toMatchObject({ existing: false });
    expect(
      other.client.calls.filter((c) => c.method === "createIssueComment"),
    ).toHaveLength(1);
  });

  // #844-T315
  it("does not call a 403 for another reason a missing permission: the step fails as itself and does not send the owner to the App's settings", async () => {
    const otherForbidden = new GithubAppError(
      "GITHUB_APP_FORBIDDEN",
      "GitHub answered 403 for POST /repos/{owner}/{repo}/issues/{n}/comments.",
      { status: 403, refusal: "other" },
    );
    const run = {
      "github.pullRequest.open": { head: "workflow/r1/work", title: "T" },
      "github.issue.comment": { issue: 7, body: "x" },
      "github.issue.labels": { issue: 7, add: ["x"] },
    } as const;
    for (const [name, inputs] of Object.entries(run)) {
      const { connector } = setup({
        openPullRequestFailure: otherForbidden,
        commentFailure: otherForbidden,
        labelsFailure: otherForbidden,
      });
      const error = await failure(connector(name).run(call({ ...inputs })));
      // Not a ConnectorError of the permission: the engine ends the step as `action_failed`.
      expect(error).toBeInstanceOf(IntegrationError);
      expect((error as IntegrationError).code).toBe(
        "INTEGRATION_ACCESS_FAILED",
      );
      expect(error.message).not.toMatch(/permission/i);
    }
  });

  // #844-T316
  it("refuses a label of dots only before any call to GitHub (the address of its removal would be that of every label)", async () => {
    const { client, connector } = setup();
    for (const label of [".", "..", "...", " . "])
      for (const input of ["add", "remove"])
        expect(
          await failure(
            connector("github.issue.labels").run(
              call({ issue: 7, [input]: [label] }),
            ),
          ),
        ).toBeInstanceOf(ActionInputError);
    expect(client.calls.some((c) => c.method === "changeIssueLabels")).toBe(
      false,
    );
    // A name with dots in it is a name.
    await connector("github.issue.labels").run(
      call({ issue: 7, add: [".net", "v1.2"] }),
    );
    expect(client.calls.some((c) => c.method === "changeIssueLabels")).toBe(
      true,
    );
  });
});

describe("the codes of a connector", () => {
  // #844-T330
  it("are step failure codes, so a step can end with them", () => {
    for (const code of CONNECTOR_FAILURE_CODES)
      expect(STEP_FAILURE_CODES as readonly string[]).toContain(code);
  });

  // #844-T331
  it("end a step with a connector's own code in the engine's report (a repository with no active connection is github_not_found)", async () => {
    const connectors = createGithubConnectors({
      targetOf: async () => undefined,
    });
    const error = await failure(
      (connectors[1] as { run(c: ActionCall): Promise<unknown> }).run(
        call({ issue: 7, body: "x" }),
      ),
    );
    expect((error as ConnectorError).code).toBe("github_not_found");
  });
});
