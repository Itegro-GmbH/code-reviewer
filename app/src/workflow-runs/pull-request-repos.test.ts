// SPDX-License-Identifier: LicenseRef-Proprietary

// #1094 (epic #1090, ADR 0006): the pull request step with `repos` at run time: the inputs (one title and body per repository, the facts held to
// their shape) and the connector (one pull request per repository with a pushed branch of its own, skips, existing ones, failures).
import { describe, expect, it } from "vitest";
import { IntegrationError } from "../integrations/errors.ts";
import type { IntegrationProvider } from "../integrations/provider.ts";
import type { Integration, RepoRef } from "../integrations/types.ts";
import { fakeIntegration } from "../test-support/fake-integration-provider.ts";
import {
  GITHUB_PULL_REQUEST_OPEN,
  TICKET_REQUEST_REVIEW,
} from "../workflows/connectors.ts";
import {
  ActionInputError,
  ConnectorError,
  resolveActionInputs,
  type ActionCall,
} from "./connectors.ts";
import { createGithubConnectors } from "./github-connectors.ts";
import { ACTION_TIMEOUT_MS, STEP_STALE_MS, actionBudgetMs } from "./limits.ts";
import type { RunValues } from "./templates.ts";

const REPOS = [
  {
    fullName: "acme/app",
    base: "main",
    branch: "feature/7",
    commits: ["a1"],
    headCommit: "a1",
    pushed: true,
  },
  {
    fullName: "acme/lib",
    base: "develop",
    branch: "develop",
    commits: ["b1"],
    headCommit: "b1",
    pushed: true,
  },
  {
    fullName: "acme/docs",
    base: "main",
    branch: "feature/7",
    commits: [],
    headCommit: "c0",
    pushed: false,
  },
  {
    fullName: "acme/empty",
    base: "main",
    branch: "feature/7",
    commits: [],
    headCommit: "d0",
    pushed: true,
  },
];

const values: RunValues = {
  trigger: {},
  steps: { implement: { repos: REPOS, summary: "Retry policy." } },
  agentSteps: new Set(["implement"]),
};

const NODE = {
  repos: "{{implement.repos}}",
  title: "[{{repo.fullName}}] retry",
  body: "{{repo.branch}} into {{repo.base}}",
};

describe("the inputs of a pull request step with repos", () => {
  // #1094-T20
  it("writes one title and one body for every repository", () => {
    const inputs = resolveActionInputs(NODE, GITHUB_PULL_REQUEST_OPEN, values);
    expect(inputs.title).toBeUndefined();
    expect(inputs.repos).toEqual([
      expect.objectContaining({
        fullName: "acme/app",
        title: "[acme/app] retry",
        body: "feature/7 into main",
      }),
      expect.objectContaining({
        fullName: "acme/lib",
        title: "[acme/lib] retry",
      }),
      expect.objectContaining({ fullName: "acme/docs" }),
      expect.objectContaining({ fullName: "acme/empty" }),
    ]);
  });

  // #1094-T21
  it("refuses a repos that is no list of repositories", () => {
    for (const bad of [
      [{ fullName: "a/b" }],
      [{ fullName: "a/b", base: "main", branch: "" }],
      "text",
    ])
      expect(() =>
        resolveActionInputs(NODE, GITHUB_PULL_REQUEST_OPEN, {
          ...values,
          steps: { implement: { repos: bad } },
        }),
      ).toThrow(ActionInputError);
  });

  // #1094-T22
  it("keeps the single form: head is needed without repos", () => {
    expect(() =>
      resolveActionInputs({ title: "x" }, GITHUB_PULL_REQUEST_OPEN, values),
    ).toThrow("head is missing.");
    expect(
      resolveActionInputs(
        { head: "{{implement.summary}}", title: "x" },
        GITHUB_PULL_REQUEST_OPEN,
        { ...values, steps: { implement: { summary: "b" } } },
      ),
    ).toEqual({ head: "b", title: "x" });
  });
});

type Opened = { repo: string; head: string; base: string; title: string };

function setup(
  behaviour: (repo: string) => Error | { number: number; existing: boolean } = (
    repo,
  ) => ({ number: repo === "acme/app" ? 5 : 9, existing: false }),
  known: readonly string[] = [
    "acme/app",
    "acme/lib",
    "acme/docs",
    "acme/empty",
  ],
  delayMs = 0,
) {
  const opened: Opened[] = [];
  const integration: Integration = fakeIntegration({ id: "i1" });
  const refOf = (fullName: string): RepoRef => ({
    integrationId: "i1",
    externalId: fullName,
    fullName,
    url: `https://github.com/${fullName}`,
  });
  const reviews: Array<{ repo: string; pullRequest: number }> = [];
  const provider = {
    async requestReviewers(
      _integration: Integration,
      repo: RepoRef,
      pullRequest: number,
      logins: string[],
    ) {
      reviews.push({ repo: repo.fullName, pullRequest });
      return { requested: logins };
    },
    async openPullRequest(
      _integration: Integration,
      repo: RepoRef,
      input: { head: string; base: string; title: string },
    ) {
      opened.push({
        repo: repo.fullName,
        head: input.head,
        base: input.base,
        title: input.title,
      });
      if (delayMs > 0)
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      const result = behaviour(repo.fullName);
      if (result instanceof Error) throw result;
      return {
        number: result.number,
        existing: result.existing,
        url: `https://github.com/${repo.fullName}/pull/${String(result.number)}`,
      };
    },
  } as unknown as IntegrationProvider;
  const connectors = createGithubConnectors({
    // The repository of the run: it must not be the one a review of a pull request of another repository is asked on.
    targetOf: async () => ({
      provider,
      integration,
      repo: refOf("acme/app"),
    }),
    targetOfRepository: async (_call, fullName) =>
      known.includes(fullName)
        ? {
            provider,
            integration,
            repo: refOf(fullName),
          }
        : undefined,
    ticketTargetOf: async () => undefined,
  });
  const connector = connectors.find(
    (candidate) => candidate.name === "github.pullRequest.open",
  );
  const review = connectors.find(
    (candidate) => candidate.name === "ticket.requestReview",
  );
  if (connector === undefined || review === undefined)
    throw new Error("no connector");
  return { opened, connector, review, reviews };
}

function call(inputs: Record<string, unknown>, budgetMs?: number): ActionCall {
  return {
    workspaceId: "w1",
    runId: "r1",
    stepId: "pr",
    repository: { id: "repo-1", fullName: "acme/app" },
    baseBranch: "main",
    inputs,
    idempotencyKey: "wf-r1-2",
    stepCreatedAt: "2026-11-18T10:00:00.000Z",
    signal: new AbortController().signal,
    ...(budgetMs === undefined ? {} : { budgetMs }),
  };
}

const inputsOf = () =>
  resolveActionInputs(NODE, GITHUB_PULL_REQUEST_OPEN, values);

describe("github.pullRequest.open with repos", () => {
  // #1094-T30
  it("opens one pull request per repository with a pushed branch of its own, each in its repository and against its base", async () => {
    const { opened, connector } = setup();
    const output = await connector.run(call(inputsOf()));
    expect(opened).toEqual([
      {
        repo: "acme/app",
        head: "feature/7",
        base: "main",
        title: "[acme/app] retry",
      },
      {
        repo: "acme/empty",
        head: "feature/7",
        base: "main",
        title: "[acme/empty] retry",
      },
    ]);
    expect(output).toEqual({
      pullRequests: [
        {
          fullName: "acme/app",
          base: "main",
          head: "feature/7",
          state: "opened",
          number: 5,
          url: "https://github.com/acme/app/pull/5",
        },
        {
          fullName: "acme/lib",
          base: "develop",
          head: "develop",
          state: "skipped",
          reason: "direct",
        },
        {
          fullName: "acme/docs",
          base: "main",
          head: "feature/7",
          state: "skipped",
          reason: "not_pushed",
        },
        {
          fullName: "acme/empty",
          base: "main",
          head: "feature/7",
          state: "opened",
          number: 9,
          url: "https://github.com/acme/empty/pull/9",
        },
      ],
      number: 5,
      url: "https://github.com/acme/app/pull/5",
      existing: false,
      repository: "acme/app",
    });
  });

  // #1094-T31
  it("reports an open pull request as existing and a branch without commits ahead as skipped", async () => {
    const { connector } = setup((repo) =>
      repo === "acme/app"
        ? { number: 3, existing: true }
        : new IntegrationError("INTEGRATION_NO_CHANGES_TO_COMPARE", "none", {}),
    );
    const output = await connector.run(call(inputsOf()));
    expect(output).toMatchObject({ number: 3, existing: true });
    const list = (output as { pullRequests: Array<Record<string, unknown>> })
      .pullRequests;
    expect(
      list.map((entry) => [entry.fullName, entry.state, entry.reason]),
    ).toEqual([
      ["acme/app", "existing", undefined],
      ["acme/lib", "skipped", "direct"],
      ["acme/docs", "skipped", "not_pushed"],
      ["acme/empty", "skipped", "no_commits"],
    ]);
  });

  // #1094-T32
  it("yields no single pull request when every repository is skipped", async () => {
    const { opened, connector } = setup();
    const only = (inputsOf().repos as Array<{ fullName: string }>).filter(
      (entry) => entry.fullName === "acme/lib",
    );
    const output = await connector.run(call({ ...inputsOf(), repos: only }));
    expect(opened).toEqual([]);
    expect(output).not.toHaveProperty("number");
    expect(output).not.toHaveProperty("url");
  });

  // #1094-T33
  it("tries the other repositories when one is refused, and fails with the pull requests that were opened named", async () => {
    const { opened, connector } = setup((repo) =>
      repo === "acme/app"
        ? new IntegrationError("INTEGRATION_ACCESS_SCOPE_REFUSED", "no", {})
        : { number: 9, existing: false },
    );
    const error = await connector.run(call(inputsOf())).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ConnectorError);
    expect((error as ConnectorError).code).toBe("github_permission_missing");
    expect((error as ConnectorError).message).toContain("acme/empty#9");
    expect(opened.map((entry) => entry.repo)).toEqual([
      "acme/app",
      "acme/empty",
    ]);
  });

  // #1094-T34
  it("acts on repositories of the workspace only", async () => {
    const { opened, connector } = setup(undefined, ["acme/lib"]);
    const error = await connector.run(call(inputsOf())).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect((error as ConnectorError).code).toBe("github_not_found");
    expect((error as ConnectorError).message).toContain("acme/app");
    expect(opened).toEqual([]);
  });
});

/** A repository entry of `repos` as the facts of an agent step give it. */
const entry = (fullName: string, extra: Record<string, unknown> = {}) => ({
  fullName,
  base: "main",
  branch: "feature/7",
  commits: ["x1"],
  headCommit: "x1",
  pushed: true,
  pushRejected: false,
  title: `[${fullName}] retry`,
  ...extra,
});

const outcome = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    (value) => value,
    (reason: unknown) => reason,
  );

describe("github.pullRequest.open with repos: results and failures", () => {
  // #1094-T37
  it("reports direct, not pushed, push rejected, no commits, existing and opened in one run", async () => {
    const { connector } = setup(
      (repo) =>
        repo === "acme/e"
          ? new IntegrationError(
              "INTEGRATION_NO_CHANGES_TO_COMPARE",
              "none",
              {},
            )
          : { number: 10, existing: repo === "acme/d" },
      ["a", "b", "c", "d", "e", "f"].map((name) => `acme/${name}`),
    );
    const output = (await connector.run(
      call({
        repos: [
          entry("acme/a", { branch: "main" }),
          entry("acme/b", { pushed: false }),
          entry("acme/c", { pushed: false, pushRejected: true }),
          entry("acme/d"),
          entry("acme/e"),
          entry("acme/f"),
        ],
      }),
    )) as { pullRequests: Array<Record<string, unknown>>; number: number };
    expect(
      output.pullRequests.map((item) => [
        item.fullName,
        item.state,
        item.reason,
      ]),
    ).toEqual([
      ["acme/a", "skipped", "direct"],
      ["acme/b", "skipped", "not_pushed"],
      ["acme/c", "skipped", "push_rejected"],
      ["acme/d", "existing", undefined],
      ["acme/e", "skipped", "no_commits"],
      ["acme/f", "opened", undefined],
    ]);
    // The first pull request that exists is the single one.
    expect(output).toMatchObject({
      number: 10,
      existing: true,
      repository: "acme/d",
    });
  });

  // #1094-T38
  it("finds the pull requests of an earlier run again when the step is run a second time after a partial failure", async () => {
    let attempt = 1;
    const { opened, connector } = setup((repo) => {
      if (attempt === 1 && repo === "acme/empty")
        return new IntegrationError(
          "INTEGRATION_ACCESS_SCOPE_REFUSED",
          "no",
          {},
        );
      return {
        number: repo === "acme/app" ? 5 : 9,
        existing: attempt === 2 && repo === "acme/app",
      };
    });
    const first = await outcome(connector.run(call(inputsOf())));
    expect(first).toBeInstanceOf(ConnectorError);
    // What the first run opened stays with the failed step.
    expect((first as ConnectorError).output).toMatchObject({
      number: 5,
      repository: "acme/app",
    });
    attempt = 2;
    const second = (await connector.run(call(inputsOf()))) as {
      pullRequests: Array<Record<string, unknown>>;
    };
    expect(
      second.pullRequests.map((item) => [item.fullName, item.state]),
    ).toEqual([
      ["acme/app", "existing"],
      ["acme/lib", "skipped"],
      ["acme/docs", "skipped"],
      ["acme/empty", "opened"],
    ]);
    expect(opened.map((item) => item.repo)).toEqual([
      "acme/app",
      "acme/empty",
      "acme/app",
      "acme/empty",
    ]);
  });

  // #1094-T39
  it("lists the pull requests opened before a failure of an unknown kind and keeps them as the output", async () => {
    const { connector } = setup((repo) =>
      repo === "acme/empty"
        ? new Error("socket hang up secret-token-123")
        : { number: 5, existing: false },
    );
    const error = (await outcome(
      connector.run(call(inputsOf())),
    )) as ConnectorError;
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error.code).toBe("action_failed");
    expect(error.message).toContain("acme/app#5");
    expect(error.message).not.toContain("secret-token-123");
    expect(error.output).toMatchObject({ number: 5 });
  });

  // #1094-T44
  it.each([
    "INTEGRATION_ACCESS_RATE_LIMITED",
    "INTEGRATION_ACCESS_UNAVAILABLE",
  ])(
    "stops with the repositories not tried named when GitHub answers %s",
    async (code) => {
      const { opened, connector } = setup(
        (repo) =>
          repo === "acme/app"
            ? { number: 5, existing: false }
            : new IntegrationError(
                code as "INTEGRATION_ACCESS_RATE_LIMITED",
                "x",
                {},
              ),
        ["app", "b", "c", "d"].map((name) => `acme/${name}`),
      );
      const repos = ["app", "b", "c", "d"].map((name) => entry(`acme/${name}`));
      const error = (await outcome(
        connector.run(call({ repos })),
      )) as ConnectorError;
      expect(error.code).toBe(
        code === "INTEGRATION_ACCESS_RATE_LIMITED"
          ? "github_rate_limited"
          : "github_unavailable",
      );
      // acme/b failed, c and d are not tried.
      expect(opened.map((item) => item.repo)).toEqual(["acme/app", "acme/b"]);
      expect(error.message).toContain("2 repositories were not tried");
      expect(error.message).toContain("acme/app#5");
    },
  );

  // #1094-T45
  it("gives a step with many repositories more time, and stops with its partial output before the time is over", async () => {
    expect(actionBudgetMs(1)).toBe(ACTION_TIMEOUT_MS);
    expect(actionBudgetMs(10)).toBeGreaterThan(ACTION_TIMEOUT_MS);
    // Never so long that a step that is working is taken over as abandoned.
    expect(actionBudgetMs(1000)).toBeLessThan(STEP_STALE_MS);
    const names = ["a", "b", "c", "d", "e", "f"].map((name) => `acme/${name}`);
    const { opened, connector } = setup(
      () => ({ number: 4, existing: false }),
      names,
      40,
    );
    const error = (await outcome(
      connector.run(call({ repos: names.map((name) => entry(name)) }, 100)),
    )) as ConnectorError;
    expect(error.code).toBe("action_timeout");
    expect(opened.length).toBeGreaterThan(0);
    expect(opened.length).toBeLessThan(names.length);
    expect(error.message).toContain("not tried");
    expect(
      (error.output as { pullRequests: unknown[] }).pullRequests,
    ).toHaveLength(opened.length);
  });

  // #1094-T46
  it("is a step with nothing to open when the list is empty", async () => {
    expect(
      resolveActionInputs(NODE, GITHUB_PULL_REQUEST_OPEN, {
        ...values,
        steps: { implement: { repos: [] } },
      }).repos,
    ).toEqual([]);
    const { opened, connector } = setup();
    const output = await connector.run(call({ repos: [] }));
    expect(opened).toEqual([]);
    expect(output).toEqual({ pullRequests: [] });
  });

  // #1094-T47
  it("refuses a branch with a mention, an issue reference or markdown before any pull request is opened, so none of it reaches a title or a body", async () => {
    for (const branch of [
      "fix/@team-1",
      "fix/closes-#1",
      "fix/[x](http://e.test)",
    ]) {
      const tricky = [REPOS[0], { ...REPOS[3], branch }];
      const inputs = resolveActionInputs(
        {
          repos: "{{implement.repos}}",
          title: "{{repo.branch}}",
          body: "Branch {{repo.branch}}",
        },
        GITHUB_PULL_REQUEST_OPEN,
        { ...values, steps: { implement: { repos: tricky } } },
      );
      const { opened, connector } = setup();
      expect(await outcome(connector.run(call(inputs)))).toBeInstanceOf(
        ActionInputError,
      );
      // The first repository is fine and still gets nothing: every entry is checked before the first call.
      expect(opened).toEqual([]);
    }
    // A name that git allows and the connector accepts goes into the text as it is.
    const [first] = resolveActionInputs(
      { repos: "{{implement.repos}}", title: "{{repo.branch}}" },
      GITHUB_PULL_REQUEST_OPEN,
      { ...values, steps: { implement: { repos: [REPOS[0]] } } },
    ).repos as Array<{ title: string }>;
    expect(first?.title).toBe("feature/7");
  });

  // #1094-T48
  it("does not open any pull request when the branch of a later repository is not a branch name", async () => {
    const { opened, connector } = setup();
    const error = await outcome(
      connector.run(
        call({
          repos: [entry("acme/app"), entry("acme/empty", { branch: "x y@#" })],
        }),
      ),
    );
    expect(error).toBeInstanceOf(ActionInputError);
    expect(opened).toEqual([]);
  });
});

describe("ticket.requestReview after a pull request step with repos", () => {
  const first = {
    pullRequest: 9,
    repository: "acme/lib",
    reviewers: ["octocat"],
  };

  // #1094-T49
  it("asks for the review in the repository of the first pull request, not in the repository of the run", async () => {
    const { review, reviews } = setup();
    await review.run(call(first));
    expect(reviews).toEqual([{ repo: "acme/lib", pullRequest: 9 }]);
    reviews.length = 0;
    // Without `repository` the single form is unchanged: the repository of the run.
    await review.run(call({ pullRequest: 3, reviewers: ["octocat"] }));
    expect(reviews).toEqual([{ repo: "acme/app", pullRequest: 3 }]);
  });

  // #1094-T50
  it("refuses a repository that is not one of the workspace, and a text that is no repository", async () => {
    const { review, reviews } = setup();
    const gone = (await outcome(
      review.run(call({ ...first, repository: "evil/other" })),
    )) as ConnectorError;
    expect(gone.code).toBe("github_not_found");
    expect(
      await outcome(review.run(call({ ...first, repository: "../x" }))),
    ).toBeInstanceOf(ActionInputError);
    expect(reviews).toEqual([]);
  });

  // #1094-T51
  it("skips with a clear status when the step opened no pull request, whatever other pull request the run's repository has", async () => {
    const { review, reviews } = setup();
    // The number and the repository are left out by the inputs when the reference has no value (`skipsWhenMissing`).
    const inputs = resolveActionInputs(
      {
        pullRequest: "{{pr.number}}",
        repository: "{{pr.repository}}",
        reviewers: ["octocat"],
      },
      TICKET_REQUEST_REVIEW,
      {
        trigger: {},
        steps: { pr: { pullRequests: [] } },
        agentSteps: new Set(),
      },
    );
    expect(inputs).toEqual({ reviewers: ["octocat"] });
    expect(await review.run(call(inputs))).toEqual({
      requested: [],
      skipped: "no_pull_request",
    });
    expect(reviews).toEqual([]);
  });

  // #1094-T52
  it("reads the number and the repository of the first pull request from the step output", () => {
    const inputs = resolveActionInputs(
      {
        pullRequest: "{{pr.number}}",
        repository: "{{pr.repository}}",
        reviewers: ["octocat"],
      },
      TICKET_REQUEST_REVIEW,
      {
        trigger: {},
        steps: { pr: { number: 9, repository: "acme/lib", pullRequests: [] } },
        agentSteps: new Set(),
      },
    );
    expect(inputs).toEqual({
      pullRequest: 9,
      repository: "acme/lib",
      reviewers: ["octocat"],
    });
  });
});
