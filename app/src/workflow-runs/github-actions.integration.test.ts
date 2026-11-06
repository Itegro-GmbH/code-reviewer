// SPDX-License-Identifier: LicenseRef-Proprietary

// The slice of milestone 3 (#844): start by hand, an agent step works on a branch, the real GitHub connectors open the pull request and
// comment on the issue, against the fake GitHub, a real Postgres and the real Implementer queue. What a turn does inside its VM is not
// simulated: the test pushes the branch to the fake GitHub and ends the turn with the report a runner would send.
import { describe, expect, it } from "vitest";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { sha } from "../test-support/jobs.ts";
import {
  SUMMARY_RESULT,
  startEngineHarness,
  type EngineHarness,
} from "../test-support/workflow-engine-harness.ts";
import { createGithubConnectors } from "./github-connectors.ts";

const TRIGGER = {
  kind: "manual",
  input: {
    type: "object",
    required: ["repo", "issue"],
    properties: { repo: { type: "string" }, issue: { type: "integer" } },
  },
} as const;

/** Work on the issue, open the pull request, say so on the issue, and label it. */
function issueToPullRequest(): Record<string, unknown> {
  return {
    version: 1,
    name: "Issue to pull request",
    trigger: TRIGGER,
    steps: [
      {
        id: "implement",
        kind: "agent",
        profile: "worker",
        environment: "Python",
        instruction: "Work on issue {{trigger.input.issue}}.",
        result: SUMMARY_RESULT,
      },
      {
        id: "pr",
        kind: "action",
        connector: "github.pullRequest.open",
        head: "{{implement.branch}}",
        title: "Fix: {{implement.summary}}",
        body: "{{implement.summary}}\n\nCloses #{{trigger.input.issue}}",
      },
      {
        id: "comment",
        kind: "action",
        connector: "github.issue.comment",
        issue: "{{trigger.input.issue}}",
        body: "Opened {{pr.url}} (pull request {{pr.number}}).",
      },
      {
        id: "label",
        kind: "action",
        connector: "github.issue.labels",
        issue: "{{trigger.input.issue}}",
        add: ["pr opened"],
        remove: ["agent working"],
      },
    ],
  };
}

async function startHarness(): Promise<EngineHarness> {
  // The connectors need the harness (its database and registry), the harness needs the connectors: the target is asked per call.
  const holder: { app?: EngineHarness } = {};
  const connectors = createGithubConnectors({
    async targetOf(call) {
      const app = holder.app;
      if (app === undefined) return undefined;
      const repository = await app.h.repositories.get(call.repository.id);
      if (repository === undefined) return undefined;
      const integration = await createIntegrationsRepository(
        app.h.db,
        app.h.workspaceId,
      ).get(repository.integrationId);
      if (integration === undefined) return undefined;
      return {
        provider: app.h.registry.resolve(integration.type),
        integration,
        repo: {
          integrationId: repository.integrationId,
          externalId: repository.externalId,
          fullName: repository.fullName,
          url: repository.url,
        },
      };
    },
  });
  holder.app = await startEngineHarness({ connectors });
  return holder.app;
}

async function startRun(app: EngineHarness) {
  const workflow = await app.saveWorkflow(issueToPullRequest());
  const { run } = await app.start(workflow.id, {
    input: { repo: "acme/widgets", issue: 7 },
  });
  await app.engine.advance(run.id);
  return { workflow, runId: run.id };
}

async function endAgentTurn(app: EngineHarness, runId: string) {
  // The Worker pushed the branch of the step: the fake GitHub knows it at a commit of its own.
  app.h.fake.addBranch("acme/widgets", `workflow/${runId}/implement`, sha("d"));
  const jobId = await app.finishTurn({
    agentResult: { summary: "Cache the widgets" },
    commits: [sha("d")],
    headCommit: sha("d"),
  });
  await app.engine.jobEnded(jobId);
}

describe("start by hand, implementer, open the pull request, comment on the issue", () => {
  // #844-T370
  it("runs the whole slice with the real connectors against the fake GitHub", async () => {
    const app = await startHarness();
    app.h.fake.addIssue("acme/widgets", {
      number: 7,
      title: "Cache the widgets",
      labels: ["agent working", "bug"],
    });
    const { runId } = await startRun(app);

    await endAgentTurn(app, runId);

    const state = await app.stateOf(runId);
    expect(state.run).toMatchObject({ status: "succeeded", errorCode: null });
    expect(state.steps.map((step) => [step.stepId, step.status])).toEqual([
      ["implement", "succeeded"],
      ["pr", "succeeded"],
      ["comment", "succeeded"],
      ["label", "succeeded"],
    ]);
    // The pull request is on GitHub, from the branch of the step into the branch the run started from.
    const [opened] = app.h.fake
      .pullRequests("acme/widgets")
      .filter((pr) => pr.headRef === `workflow/${runId}/implement`);
    expect(opened).toMatchObject({
      number: 8,
      title: "Fix: Cache the widgets",
      baseRef: "main",
      state: "open",
    });
    expect(opened?.body).toBe("Cache the widgets\n\nCloses #7");
    // The output fields can be referenced: the comment on the issue carries the url and the number of the pull request.
    const prOutput = JSON.parse(state.steps[1]?.output ?? "null") as {
      number: number;
      url: string;
      existing: boolean;
    };
    expect(prOutput.number).toBe(8);
    expect(prOutput.existing).toBe(false);
    // The comment ends with the invisible marker of its step (position 2) of this run.
    expect(
      app.h.fake.issueComments("acme/widgets", 7).map((c) => c.body),
    ).toEqual([
      `Opened ${prOutput.url} (pull request 8).\n\n<!-- wf-${runId}-2 -->`,
    ]);
    expect(app.h.fake.issueLabels("acme/widgets", 7)).toEqual([
      "bug",
      "pr opened",
    ]);
    expect(JSON.parse(state.steps[3]?.output ?? "null")).toEqual({
      labels: ["bug", "pr opened"],
    });
  });

  // #844-T371
  it("ends the step with github_permission_missing and a sentence that names the permission when the App may not write pull requests", async () => {
    const app = await startHarness();
    app.h.fake.addIssue("acme/widgets", {
      number: 7,
      title: "Cache the widgets",
    });
    const { runId } = await startRun(app);
    app.h.fake.setInstallationPermissions(4242, {
      metadata: "read",
      contents: "write",
      issues: "write",
    });

    await endAgentTurn(app, runId);

    const state = await app.stateOf(runId);
    expect(state.run).toMatchObject({
      status: "failed",
      errorCode: "step_failed",
    });
    expect(state.steps.map((step) => [step.stepId, step.status])).toEqual([
      ["implement", "succeeded"],
      ["pr", "failed"],
    ]);
    expect(state.steps[1]).toMatchObject({
      errorCode: "github_permission_missing",
    });
    expect(state.steps[1]?.errorMessage).toContain(
      "Pull requests: Read and write and Contents: Read-only",
    );
    expect(state.steps[1]?.errorMessage).toContain("open pull requests");
    expect(app.h.fake.pullRequests("acme/widgets")).toHaveLength(0);
  });

  // #844-T372
  it("takes a pull request that is open for the same branches as the result, and ends with github_not_found for an issue that is not there", async () => {
    const app = await startHarness();
    const { runId } = await startRun(app);
    // A pull request for the branch is open already (an earlier try that was not recorded, or somebody opened it).
    app.h.fake.addBranch(
      "acme/widgets",
      `workflow/${runId}/implement`,
      sha("d"),
    );
    app.h.fake.addPullRequest("acme/widgets", {
      number: 3,
      title: "Already",
      state: "open",
      headSha: sha("d"),
      headRef: `workflow/${runId}/implement`,
      baseRef: "main",
      author: { login: "octocat", id: 1 },
    });

    await endAgentTurn(app, runId);

    const state = await app.stateOf(runId);
    expect(JSON.parse(state.steps[1]?.output ?? "null")).toMatchObject({
      number: 3,
      existing: true,
    });
    // Issue 7 does not exist in this fake: the comment fails with the code for a missing issue.
    expect(state.steps[2]).toMatchObject({
      status: "failed",
      errorCode: "github_not_found",
    });
    expect(app.h.fake.pullRequests("acme/widgets")).toHaveLength(1);
  });
});
