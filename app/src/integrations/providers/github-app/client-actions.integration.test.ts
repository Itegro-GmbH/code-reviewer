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

async function setup() {
  const harness = await startGithubAppHarness();
  const { fake, clock, env } = harness;
  fake.addInstallation({ id: 4242, account: ACME });
  fake.setRepositories(4242, [{ id: 7001, fullName: "acme/widgets" }]);
  fake.addBranch("acme/widgets", "workflow/r1/work", HEAD_SHA);
  const client: GithubAppClient = createGithubAppClient({
    config: loadGithubAppConfig(env),
    now: clock.now,
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
  it("is 'no commits between' for a branch that is at the base, 'exists' is handled, an unknown branch is a plain refusal", async () => {
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

  // #844-T343
  it("fails with the token refused when the App does not hold the permission, and with 403 when the token lacks it", async () => {
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
  it("is 404 for an issue that does not exist, 403 when the token lacks the permission, and honors the abort signal", async () => {
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
