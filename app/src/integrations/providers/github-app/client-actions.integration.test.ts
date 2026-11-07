// SPDX-License-Identifier: LicenseRef-Proprietary

// #844: what the GitHub client sends for the workflow actions (open a pull request, comment, labels), against the fake GitHub over real
// HTTP: which token each call uses, what is found again instead of made twice, and how each refusal comes back as a stable code.
import { describe, expect, it } from "vitest";
import { startGithubAppHarness } from "../../../test-support/github-app-harness.ts";
import {
  createGithubAppClient,
  type GithubAppClient,
  type JobTokenScope,
} from "./client.ts";
import { loadGithubAppConfig } from "./config.ts";
import { GithubAppError } from "./errors.ts";

const ACME = { login: "acme", id: 5001, type: "Organization" } as const;
const PULLS: JobTokenScope = {
  repositoryIds: [7001],
  permissions: { pull_requests: "write", metadata: "read" },
};
const ISSUES: JobTokenScope = {
  repositoryIds: [7001],
  permissions: { issues: "write", metadata: "read" },
};
const HEAD_SHA = "c".repeat(40);

async function setup(options: { fetch?: typeof fetch } = {}) {
  const harness = await startGithubAppHarness();
  const { fake, clock, env } = harness;
  fake.addInstallation({ id: 4242, account: ACME });
  fake.setRepositories(4242, [{ id: 7001, fullName: "acme/widgets" }]);
  fake.addBranch("acme/widgets", "workflow/r1/work", HEAD_SHA);
  const client: GithubAppClient = createGithubAppClient({
    config: loadGithubAppConfig(env),
    now: clock.now,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  return { fake, client };
}

async function failureOf(run: Promise<unknown>): Promise<GithubAppError> {
  const error = await run.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(GithubAppError);
  return error as GithubAppError;
}

describe("opening a pull request", () => {
  // #844-T340
  it("opens it from the branch with a token for pull requests of this repository only, and switches the token off", async () => {
    const { fake, client } = await setup();

    const opened = await client.openPullRequest("4242", PULLS, "acme/widgets", {
      head: "workflow/r1/work",
      base: "main",
      title: "Add caching",
      body: "Closes #7",
      draft: true,
    });

    expect(opened).toEqual({
      number: 1,
      url: expect.stringContaining("/acme/widgets/pull/1") as string,
      existing: false,
    });
    expect(fake.tokenRequests().at(-1)).toMatchObject({
      repositoryIds: [7001],
      permissions: { pull_requests: "write", metadata: "read" },
    });
    expect(fake.revokedInstallationTokens()).toHaveLength(1);
  });

  // #844-T341
  it("answers with the pull request that is open for the same head and base instead of opening a second", async () => {
    const { client } = await setup();
    const input = {
      head: "workflow/r1/work",
      base: "main",
      title: "Add caching",
    };

    const first = await client.openPullRequest(
      "4242",
      PULLS,
      "acme/widgets",
      input,
    );
    const again = await client.openPullRequest(
      "4242",
      PULLS,
      "acme/widgets",
      input,
    );

    expect(again).toEqual({
      number: first.number,
      url: first.url,
      existing: true,
    });
  });

  // #844-T342
  it("is 'no commits between' for a branch that is at the base, and an unknown branch is a plain refusal", async () => {
    const { fake, client } = await setup();
    fake.addBranch("acme/widgets", "empty", "b".repeat(40));

    const none = await failureOf(
      client.openPullRequest("4242", PULLS, "acme/widgets", {
        head: "empty",
        base: "main",
        title: "T",
      }),
    );
    expect(none).toMatchObject({
      code: "GITHUB_APP_REQUEST_FAILED",
      status: 422,
      refusal: "no_commits_between",
    });

    const unknown = await failureOf(
      client.openPullRequest("4242", PULLS, "acme/widgets", {
        head: "nope",
        base: "main",
        title: "T",
      }),
    );
    expect(unknown).toMatchObject({
      code: "GITHUB_APP_REQUEST_FAILED",
      status: 422,
      refusal: "other",
    });
  });

  // #913-T02
  it("names resource, field and code of a refusal whose errors carry no message, and keeps the other classifications", async () => {
    const answer = (errors: unknown[]) =>
      (async (input, init) => {
        if (init?.method === "POST" && String(input).endsWith("/pulls"))
          return new Response(
            JSON.stringify({ message: "Validation Failed", errors }),
            { status: 422, headers: { "content-type": "application/json" } },
          );
        return fetch(input, init);
      }) satisfies typeof fetch;
    const open = async (errors: unknown[]) => {
      const { client } = await setup({ fetch: answer(errors) });
      return failureOf(
        client.openPullRequest("4242", PULLS, "acme/widgets", {
          head: "workflow/r1/work",
          base: "main",
          title: "T",
        }),
      );
    };

    const withoutMessage = await open([
      { resource: "PullRequest", field: "head", code: "invalid" },
    ]);
    expect(withoutMessage).toMatchObject({
      status: 422,
      refusal: "other",
      reason: "PullRequest head invalid",
    });

    const withMessage = await open([
      { resource: "PullRequest", code: "custom", message: "title is missing" },
    ]);
    expect(withMessage).toMatchObject({
      refusal: "other",
      reason: "title is missing",
    });

    expect(
      await open([
        {
          resource: "PullRequest",
          code: "custom",
          message: "No commits between main and workflow/r1/work",
        },
      ]),
    ).toMatchObject({ refusal: "no_commits_between" });
    expect(
      await open([
        {
          resource: "PullRequest",
          code: "custom",
          message: "A pull request already exists for acme:workflow/r1/work.",
        },
      ]),
    ).toMatchObject({ refusal: "pull_request_exists" });
  });

  // #913-T02
  it("keeps links, tokens and control characters out of the reason and bounds it", async () => {
    // Joined at run time: a token-looking literal would trip the scan for committed secrets.
    const token = ["ghs", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_");
    const hostile = `see https://evil.example/x ${token}\nnext ${"y".repeat(1_000)}`;
    const { client } = await setup({
      fetch: (async (input, init) => {
        if (init?.method === "POST" && String(input).endsWith("/pulls"))
          return new Response(
            JSON.stringify({
              message: "Validation Failed",
              errors: [{ resource: "PullRequest", message: hostile }],
            }),
            { status: 422 },
          );
        return fetch(input, init);
      }) satisfies typeof fetch,
    });

    const error = await failureOf(
      client.openPullRequest("4242", PULLS, "acme/widgets", {
        head: "workflow/r1/work",
        base: "main",
        title: "T",
      }),
    );

    expect(error.reason).toBeDefined();
    expect(error.reason).not.toMatch(/https?:|ghs_|[\u0000-\u001f]/);
    expect(error.reason?.length).toBeLessThanOrEqual(300);
    // Cut at the bound, and the cut shows.
    expect(error.reason).toHaveLength(300);
    expect(error.reason?.endsWith("…")).toBe(true);
  });

  // #913-T02
  it("classifies only what GitHub wrote as a message, never the resource, field and code it names", async () => {
    const open = async (body: unknown) => {
      const { client } = await setup({
        fetch: (async (input, init) => {
          if (init?.method === "POST" && String(input).endsWith("/pulls"))
            return new Response(JSON.stringify(body), { status: 422 });
          return fetch(input, init);
        }) satisfies typeof fetch,
      });
      return failureOf(
        client.openPullRequest("4242", PULLS, "acme/widgets", {
          head: "workflow/r1/work",
          base: "main",
          title: "T",
        }),
      );
    };

    // The names of an entry are for the reason only: `archived` here is a field, not GitHub saying the repository is archived.
    expect(
      await open({
        message: "Validation Failed",
        errors: [
          { resource: "Repository", field: "archived", code: "invalid" },
        ],
      }),
    ).toMatchObject({
      refusal: "other",
      reason: "Repository archived invalid",
    });
    // A real message still classifies.
    expect(
      await open({
        message: "Validation Failed",
        errors: [
          { resource: "Repository", message: "Repository was archived" },
        ],
      }),
    ).toMatchObject({ refusal: "repository_archived" });
    // A message of white space says nothing: the names stand in for it.
    expect(
      await open({
        message: "Validation Failed",
        errors: [
          {
            message: "   ",
            resource: "PullRequest",
            field: "head",
            code: "invalid",
          },
        ],
      }),
    ).toMatchObject({ reason: "PullRequest head invalid" });
    // Without errors the top-level message is the reason.
    expect(await open({ message: "Validation Failed" })).toMatchObject({
      refusal: "other",
      reason: "Validation Failed",
    });
  });

  // #913-T02
  it("defuses every kind of link and the marks that make one in a reason, and cuts after that so that the bound holds", async () => {
    const reasonFor = async (text: string) => {
      const { client } = await setup({
        fetch: (async (input, init) => {
          if (init?.method === "POST" && String(input).endsWith("/pulls"))
            return new Response(
              JSON.stringify({
                message: "Validation Failed",
                errors: [{ resource: "PullRequest", message: text }],
              }),
              { status: 422 },
            );
          return fetch(input, init);
        }) satisfies typeof fetch,
      });
      const error = await failureOf(
        client.openPullRequest("4242", PULLS, "acme/widgets", {
          head: "workflow/r1/work",
          base: "main",
          title: "T",
        }),
      );
      return error.reason ?? "";
    };

    for (const hostile of [
      "see www.evil.example/x now",
      "see //evil.example/x now",
      "see ftp://evil.example/x now",
      "see javascript:alert(1) now",
      "see mailto:a@evil.example now",
      "see HTTPS://EVIL.EXAMPLE/x now",
    ]) {
      const reason = await reasonFor(hostile);
      expect(reason, hostile).toBe("see [link] now");
    }
    const marked = await reasonFor("a [click](x) <b>b</b> `c` d");
    expect(marked).not.toMatch(/[\[\]()<>`]/);
    // A colon that starts nothing stays.
    expect(await reasonFor("title: is missing")).toBe("title: is missing");

    // A short word that becomes "[link]" grows: the cut comes after, so the bound still holds.
    const grown = await reasonFor("a:b ".repeat(400));
    expect(grown.length).toBeLessThanOrEqual(300);
    expect(grown.endsWith("…")).toBe(true);
  });

  // #913-T02
  it("keeps GitHub's reason out of a refused token request", async () => {
    const { client } = await setup({
      fetch: (async (input, init) => {
        if (String(input).endsWith("/access_tokens"))
          return new Response(
            JSON.stringify({
              message: "Validation Failed",
              errors: [
                { message: "The permissions requested are not granted" },
              ],
            }),
            { status: 422 },
          );
        return fetch(input, init);
      }) satisfies typeof fetch,
    });

    const error = await failureOf(
      client.openPullRequest("4242", PULLS, "acme/widgets", {
        head: "workflow/r1/work",
        base: "main",
        title: "T",
      }),
    );

    expect(error).toMatchObject({
      status: 422,
      duringTokenRequest: true,
      refusal: "permission_missing",
    });
    expect(error.reason).toBeUndefined();
  });

  // #844-T345
  it("finds the pull request somebody opened between the look and the call: GitHub says it exists, the second look answers it", async () => {
    const { fake, client } = await setup();
    const input = {
      head: "workflow/r1/work",
      base: "main",
      title: "Add caching",
    };
    const first = await client.openPullRequest(
      "4242",
      PULLS,
      "acme/widgets",
      input,
    );
    // The first look is told there is none (as when the pull request is opened right after it); the call then gets 422 "already exists".
    fake.fail({
      method: "GET",
      pathIncludes: "/pulls",
      status: 200,
      body: [],
      times: 1,
    });

    const raced = await client.openPullRequest(
      "4242",
      PULLS,
      "acme/widgets",
      input,
    );

    expect(raced).toEqual({
      number: first.number,
      url: first.url,
      existing: true,
    });
    expect(
      fake
        .requests()
        .filter((r) => r.method === "POST" && r.path.endsWith("/pulls")),
    ).toHaveLength(2);
  });

  // #844-T346
  it("rethrows the refusal when GitHub says the pull request exists and the second look finds none", async () => {
    const { fake, client } = await setup();
    const input = {
      head: "workflow/r1/work",
      base: "main",
      title: "Add caching",
    };
    await client.openPullRequest("4242", PULLS, "acme/widgets", input);
    fake.fail({
      method: "GET",
      pathIncludes: "/pulls",
      status: 200,
      body: [],
    });

    const failed = await failureOf(
      client.openPullRequest("4242", PULLS, "acme/widgets", input),
    );

    expect(failed).toMatchObject({
      status: 422,
      refusal: "pull_request_exists",
    });
  });

  // #844-T347
  it("takes an open pull request for the answer only when its head is a branch of this repository and head and base are the ones asked for", async () => {
    const pull = (headRepo: string, headRef: string, baseRef: string) => ({
      number: 40,
      title: "Somebody else's",
      html_url: "https://github.com/acme/widgets/pull/40",
      state: "open",
      user: { login: "someone", id: 9 },
      head: {
        sha: "d".repeat(40),
        ref: headRef,
        repo: { full_name: headRepo },
      },
      base: { ref: baseRef },
    });
    const input = {
      head: "workflow/r1/work",
      base: "main",
      title: "Add caching",
    };
    // A fork of the same owner has the branch name too (`acme:workflow/r1/work` names both), and the list may hold other branches.
    for (const lookalike of [
      pull("acme/widgets-fork", "workflow/r1/work", "main"),
      pull("acme/widgets", "workflow/r1/other", "main"),
      pull("acme/widgets", "workflow/r1/work", "develop"),
    ]) {
      const { fake, client } = await setup();
      fake.fail({
        method: "GET",
        pathIncludes: "/pulls",
        status: 200,
        body: [lookalike],
        times: 1,
      });
      const opened = await client.openPullRequest(
        "4242",
        PULLS,
        "acme/widgets",
        input,
      );
      expect(opened.existing).toBe(false);
      expect(opened.number).not.toBe(40);
    }

    // Owner and repository names are case-insensitive on GitHub.
    const { fake, client } = await setup();
    fake.fail({
      method: "GET",
      pathIncludes: "/pulls",
      status: 200,
      body: [pull("Acme/Widgets", "workflow/r1/work", "main")],
      times: 1,
    });
    expect(
      await client.openPullRequest("4242", PULLS, "acme/widgets", input),
    ).toMatchObject({ number: 40, existing: true });
  });

  // #844-T343
  it("fails with the token refused when the App does not hold the permission", async () => {
    const { fake, client } = await setup();
    fake.setAppPermissions({
      metadata: "read",
      contents: "read",
      issues: "write",
    });

    const refused = await failureOf(
      client.openPullRequest("4242", PULLS, "acme/widgets", {
        head: "workflow/r1/work",
        base: "main",
        title: "T",
      }),
    );
    expect(refused).toMatchObject({
      status: 422,
      duringTokenRequest: true,
      refusal: "permission_missing",
    });
  });

  // #844-T348
  it("fails with 403 and the permission missing when GitHub refuses the call itself (the token lacks the right)", async () => {
    const { fake, client } = await setup();
    fake.fail({
      method: "POST",
      pathIncludes: "/pulls",
      status: 403,
      message: "Resource not accessible by integration",
    });

    const refused = await failureOf(
      client.openPullRequest("4242", PULLS, "acme/widgets", {
        head: "workflow/r1/work",
        base: "main",
        title: "T",
      }),
    );

    expect(refused).toMatchObject({
      code: "GITHUB_APP_FORBIDDEN",
      status: 403,
      refusal: "permission_missing",
    });
    expect(refused.duringTokenRequest).toBeFalsy();
  });

  // #844-T349
  it("tells a 403 with a rate limit message, with or without the rate limit headers, from a missing permission and from a 403 for another reason", async () => {
    const { fake, client } = await setup();
    const open = () =>
      client.openPullRequest("4242", PULLS, "acme/widgets", {
        head: "workflow/r1/work",
        base: "main",
        title: "T",
      });
    const post = { method: "POST", pathIncludes: "/pulls", times: 1 } as const;

    // The secondary limit: no header, only the text.
    fake.fail({
      ...post,
      status: 403,
      message:
        "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
    });
    expect(await failureOf(open())).toMatchObject({
      code: "GITHUB_APP_RATE_LIMITED",
      status: 403,
      retryAfterSeconds: null,
    });

    // The primary limit and the abuse limit send headers.
    fake.fail({
      ...post,
      status: 403,
      message: "API rate limit exceeded",
      headers: { "x-ratelimit-remaining": "0" },
    });
    expect(await failureOf(open())).toMatchObject({
      code: "GITHUB_APP_RATE_LIMITED",
    });
    fake.fail({
      ...post,
      status: 403,
      message: "Forbidden",
      headers: { "retry-after": "30" },
    });
    expect(await failureOf(open())).toMatchObject({
      code: "GITHUB_APP_RATE_LIMITED",
      retryAfterSeconds: 30,
    });

    // Any other 403 is forbidden, for a reason that is not the permission.
    fake.fail({ ...post, status: 403, message: "Repository access blocked" });
    expect(await failureOf(open())).toMatchObject({
      code: "GITHUB_APP_FORBIDDEN",
      status: 403,
      refusal: "other",
    });
  });

  // #844-T344
  it("cannot be pointed at another repository or an unusable branch, and honors the abort signal", async () => {
    const { client } = await setup();

    await expect(
      client.openPullRequest("4242", PULLS, "acme/widgets", {
        head: "../x",
        base: "main",
        title: "T",
      }),
    ).rejects.toBeInstanceOf(GithubAppError);
    await expect(
      client.openPullRequest("4242", PULLS, "../widgets", {
        head: "a",
        base: "main",
        title: "T",
      }),
    ).rejects.toBeInstanceOf(GithubAppError);

    const controller = new AbortController();
    controller.abort();
    const aborted = await failureOf(
      client.openPullRequest(
        "4242",
        PULLS,
        "acme/widgets",
        { head: "workflow/r1/work", base: "main", title: "T" },
        controller.signal,
      ),
    );
    expect(aborted.code).toBe("GITHUB_APP_UNAVAILABLE");
  });
});

describe("commenting on an issue", () => {
  // #844-T350
  it("writes the comment below an issue and answers its id and url", async () => {
    const { fake, client } = await setup();
    fake.addIssue("acme/widgets", { number: 7, title: "Cache the widgets" });

    const comment = await client.createIssueComment(
      "4242",
      ISSUES,
      "acme/widgets",
      7,
      "Done.",
    );

    expect(comment.url).toContain("/acme/widgets/issues/7#issuecomment-");
    expect(
      fake.issueComments("acme/widgets", 7).map((entry) => entry.body),
    ).toEqual(["Done."]);
  });

  // #844-T351
  it("is 404 for an issue that does not exist, the token refused when the App lacks the permission, and honors the abort signal", async () => {
    const { fake, client } = await setup();

    const missing = await failureOf(
      client.createIssueComment("4242", ISSUES, "acme/widgets", 99, "x"),
    );
    expect(missing.code).toBe("GITHUB_APP_NOT_FOUND");

    fake.setAppPermissions({
      metadata: "read",
      contents: "read",
      pull_requests: "write",
    });
    const refused = await failureOf(
      client.createIssueComment("4242", ISSUES, "acme/widgets", 7, "x"),
    );
    expect(refused).toMatchObject({
      duringTokenRequest: true,
      refusal: "permission_missing",
    });

    const controller = new AbortController();
    controller.abort();
    expect(
      (
        await failureOf(
          client.createIssueComment(
            "4242",
            ISSUES,
            "acme/widgets",
            7,
            "x",
            controller.signal,
          ),
        )
      ).code,
    ).toBe("GITHUB_APP_UNAVAILABLE");
  });
});

describe("a comment that GitHub refuses at the call", () => {
  // #844-T352
  it("is 403 with the permission missing when the token lacks the right, and a rate limit when the text says so", async () => {
    const { fake, client } = await setup();
    fake.addIssue("acme/widgets", { number: 7, title: "T" });
    const comment = () =>
      client.createIssueComment("4242", ISSUES, "acme/widgets", 7, "x");

    fake.fail({
      method: "POST",
      pathIncludes: "/comments",
      status: 403,
      message: "Resource not accessible by integration",
      times: 1,
    });
    expect(await failureOf(comment())).toMatchObject({
      code: "GITHUB_APP_FORBIDDEN",
      refusal: "permission_missing",
    });

    fake.fail({
      method: "POST",
      pathIncludes: "/comments",
      status: 403,
      message: "You have exceeded a secondary rate limit.",
      times: 1,
    });
    expect(await failureOf(comment())).toMatchObject({
      code: "GITHUB_APP_RATE_LIMITED",
    });
    expect(fake.issueComments("acme/widgets", 7)).toEqual([]);
  });
});

describe("the comments below an issue", () => {
  // #844-T353
  it("lists the comments below an issue that is no pull request, with the author, so the marker of an earlier try is found", async () => {
    const { fake, client } = await setup();
    fake.addIssue("acme/widgets", { number: 7, title: "T" });
    await client.createIssueComment(
      "4242",
      ISSUES,
      "acme/widgets",
      7,
      "Done.\n\n<!-- wf-r1-1 -->",
    );

    const listed = await client.listIssueComments(
      "4242",
      ISSUES,
      "acme/widgets",
      7,
    );

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      authorLogin: expect.stringMatching(/\[bot\]$/) as string,
      body: "Done.\n\n<!-- wf-r1-1 -->",
    });
    expect(
      await client.listIssueComments("4242", ISSUES, "acme/widgets", 7, {
        signal: new AbortController().signal,
      }),
    ).toHaveLength(1);
    await expect(
      client.listIssueComments("4242", ISSUES, "acme/widgets", 99),
    ).rejects.toMatchObject({ code: "GITHUB_APP_NOT_FOUND" });
  });
});

describe("changing labels", () => {
  // #844-T360
  it("adds and removes, skips what is there or gone, and answers every label now on the issue", async () => {
    const { fake, client } = await setup();
    fake.addIssue("acme/widgets", {
      number: 7,
      title: "T",
      labels: ["ready", "bug"],
    });

    const labels = await client.changeIssueLabels(
      "4242",
      ISSUES,
      "acme/widgets",
      7,
      {
        add: ["agent working", "bug"],
        remove: ["ready", "never-there"],
      },
    );

    expect(labels).toEqual(["bug", "agent working"]);
    expect(fake.issueLabels("acme/widgets", 7)).toEqual([
      "bug",
      "agent working",
    ]);

    // The same change again changes nothing.
    expect(
      await client.changeIssueLabels("4242", ISSUES, "acme/widgets", 7, {
        add: ["agent working", "bug"],
        remove: ["ready", "never-there"],
      }),
    ).toEqual(["bug", "agent working"]);
  });

  // #844-T361
  it("works on a pull request number too, and is 404 for a number that is neither", async () => {
    const { fake, client } = await setup();
    const opened = await client.openPullRequest("4242", PULLS, "acme/widgets", {
      head: "workflow/r1/work",
      base: "main",
      title: "T",
    });

    expect(
      await client.changeIssueLabels(
        "4242",
        ISSUES,
        "acme/widgets",
        opened.number,
        { add: ["x"], remove: [] },
      ),
    ).toEqual(["x"]);
    expect(fake.issueLabels("acme/widgets", opened.number)).toEqual(["x"]);

    const missing = await failureOf(
      client.changeIssueLabels("4242", ISSUES, "acme/widgets", 99, {
        add: ["x"],
        remove: [],
      }),
    );
    expect(missing.code).toBe("GITHUB_APP_NOT_FOUND");
  });

  // #844-T364
  it("refuses a label that is only dots before any request: `DELETE .../labels/.` would remove every label of the issue", async () => {
    const { fake, client } = await setup();
    fake.addIssue("acme/widgets", {
      number: 7,
      title: "T",
      labels: ["ready", "bug"],
    });

    for (const change of [
      { add: [], remove: ["."] },
      { add: [], remove: [".."] },
      { add: [], remove: ["..."] },
      { add: ["."], remove: [] },
      { add: ["ok"], remove: ["bug", ".."] },
    ])
      await expect(
        client.changeIssueLabels("4242", ISSUES, "acme/widgets", 7, change),
      ).rejects.toBeInstanceOf(GithubAppError);

    expect(fake.issueLabels("acme/widgets", 7)).toEqual(["ready", "bug"]);
    expect(fake.requests().filter((r) => r.path.includes("/labels"))).toEqual(
      [],
    );
  });

  // #844-T362
  it("is refused with the token request when the App lacks the issue permission, and honors the abort signal", async () => {
    const { fake, client } = await setup();
    fake.addIssue("acme/widgets", { number: 7, title: "T" });
    fake.setAppPermissions({
      metadata: "read",
      contents: "read",
      pull_requests: "write",
    });

    const refused = await failureOf(
      client.changeIssueLabels("4242", ISSUES, "acme/widgets", 7, {
        add: ["x"],
        remove: [],
      }),
    );
    expect(refused).toMatchObject({
      duringTokenRequest: true,
      refusal: "permission_missing",
    });

    const controller = new AbortController();
    controller.abort();
    expect(
      (
        await failureOf(
          client.changeIssueLabels(
            "4242",
            ISSUES,
            "acme/widgets",
            7,
            { add: ["x"], remove: [] },
            controller.signal,
          ),
        )
      ).code,
    ).toBe("GITHUB_APP_UNAVAILABLE");
  });
});

describe("reading an issue as a ticket", () => {
  const READ: JobTokenScope = {
    repositoryIds: [7001],
    permissions: { issues: "read", metadata: "read" },
  };

  // #916-T01
  it("reads the number, title, body, address, labels, assignees and issue type with a token that reads issues of this repository only", async () => {
    const { fake, client } = await setup();
    fake.addIssue("acme/widgets", {
      number: 128,
      title: "Cache the widget list",
      body: "Rebuilt on every request.",
      labels: ["enhancement", "agent implement"],
      assignees: ["alice", "bob"],
      type: "Bug",
    });

    const ticket = await client.getIssue("4242", READ, "acme/widgets", 128);

    expect(ticket).toEqual({
      number: 128,
      title: "Cache the widget list",
      body: "Rebuilt on every request.",
      url: expect.stringContaining("/acme/widgets/issues/128") as string,
      labels: ["enhancement", "agent implement"],
      assignees: ["alice", "bob"],
      type: "Bug",
    });
    expect(fake.tokenRequests().at(-1)).toMatchObject({
      repositoryIds: [7001],
      permissions: { issues: "read", metadata: "read" },
    });
    expect(fake.revokedInstallationTokens()).toHaveLength(1);
  });

  // #916-T02
  it("has an empty body, no assignees and an empty type for an issue that has none", async () => {
    const { fake, client } = await setup();
    fake.addIssue("acme/widgets", { number: 5, title: "Plain" });

    expect(
      await client.getIssue("4242", READ, "acme/widgets", 5),
    ).toMatchObject({ body: "", assignees: [], type: "", labels: [] });
  });

  // #916-T03
  it("is null for a number that is no issue and for a pull request, which is no ticket", async () => {
    const { client } = await setup();
    const opened = await client.openPullRequest("4242", PULLS, "acme/widgets", {
      head: "workflow/r1/work",
      base: "main",
      title: "T",
    });

    expect(await client.getIssue("4242", READ, "acme/widgets", 99)).toBeNull();
    expect(
      await client.getIssue("4242", READ, "acme/widgets", opened.number),
    ).toBeNull();
  });

  // #916-T04
  it("honors the abort signal and refuses a number that is no issue number before any request", async () => {
    const { client } = await setup();
    const aborted = new AbortController();
    aborted.abort();

    const stopped = await failureOf(
      client.getIssue("4242", READ, "acme/widgets", 7, aborted.signal),
    );
    expect(stopped).toBeInstanceOf(GithubAppError);
    await expect(
      client.getIssue("4242", READ, "acme/widgets", 0),
    ).rejects.toThrow();
  });
});
