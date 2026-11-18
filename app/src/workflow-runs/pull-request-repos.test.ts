// SPDX-License-Identifier: LicenseRef-Proprietary

// #1094 (epic #1090, ADR 0006): the pull request step with `repos` at run time: the inputs (one title and body per repository, the facts held to
// their shape) and the connector (one pull request per repository with a pushed branch of its own, skips, existing ones, failures).
import { describe, expect, it } from "vitest";
import { IntegrationError } from "../integrations/errors.ts";
import type { IntegrationProvider } from "../integrations/provider.ts";
import type { Integration, RepoRef } from "../integrations/types.ts";
import { fakeIntegration } from "../test-support/fake-integration-provider.ts";
import { GITHUB_PULL_REQUEST_OPEN } from "../workflows/connectors.ts";
import {
  ActionInputError,
  ConnectorError,
  resolveActionInputs,
  type ActionCall,
} from "./connectors.ts";
import { createGithubConnectors } from "./github-connectors.ts";
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
      [],
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
) {
  const opened: Opened[] = [];
  const integration: Integration = fakeIntegration({ id: "i1" });
  const refOf = (fullName: string): RepoRef => ({
    integrationId: "i1",
    externalId: fullName,
    fullName,
    url: `https://github.com/${fullName}`,
  });
  const provider = {
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
      const result = behaviour(repo.fullName);
      if (result instanceof Error) throw result;
      return {
        number: result.number,
        existing: result.existing,
        url: `https://github.com/${repo.fullName}/pull/${String(result.number)}`,
      };
    },
  } as unknown as IntegrationProvider;
  const [connector] = createGithubConnectors({
    targetOf: async () => undefined,
    targetOfRepository: async (_call, fullName) =>
      known.includes(fullName)
        ? { provider, integration, repo: refOf(fullName) }
        : undefined,
    ticketTargetOf: async () => undefined,
  }).filter((candidate) => candidate.name === "github.pullRequest.open");
  if (connector === undefined) throw new Error("no connector");
  return { opened, connector };
}

function call(inputs: Record<string, unknown>): ActionCall {
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
