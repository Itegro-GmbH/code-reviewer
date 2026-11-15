// SPDX-License-Identifier: LicenseRef-Proprietary

// The resolver the running server uses for the ticket actions of a run (#1035): run → lane → project → ticket source, with the repositories
// faked. A lane that names no project, a missing run or lane, and a deleted project all fall back to GitHub on the run's repository.
import { describe, expect, it, vi } from "vitest";
import type { StoredProject } from "../db/repositories/projects-repository.ts";
import {
  createTicketProviderRegistry,
  type TicketProvider,
  type TicketScope,
} from "../integrations/ticket-provider.ts";
import type { Integration, RepoRef } from "../integrations/types.ts";
import { createRunTicketTargets } from "./run-ticket-targets.ts";

const integration = { id: "int-1", workspaceId: "w1" } as Integration;
const repo: RepoRef = {
  integrationId: "int-1",
  externalId: "99",
  fullName: "acme/widgets",
  url: "https://github.com/acme/widgets",
};
const gitScope: TicketScope = { integration, repo };
const call = {
  workspaceId: "w1",
  runId: "run-1",
  repository: { id: "repo-1" },
};

const github: TicketProvider = { id: "github", isTicketKey: () => true };
const fake: TicketProvider = { id: "fake", isTicketKey: () => true };
const jira: TicketProvider = { id: "jira", isTicketKey: () => true };

function project(
  ticketSource: Partial<StoredProject["ticketSource"]>,
): StoredProject {
  return {
    id: "p1",
    ticketSource: {
      provider: "github",
      repositoryId: "repo-1",
      ...ticketSource,
    },
  } as unknown as StoredProject;
}

function wire(
  options: {
    run?: { workflowId: string } | undefined;
    workflow?: { workflow: { projectId: string | null } } | undefined;
    project?: StoredProject | undefined;
    gitScope?: TicketScope | undefined;
  } = {},
) {
  const getRun = vi.fn(async () => options.run);
  const getWorkflow = vi.fn(async () => options.workflow);
  const getProject = vi.fn(async () => options.project);
  const gitScopeOf = vi.fn(async () =>
    "gitScope" in options ? options.gitScope : gitScope,
  );
  const targets = createRunTicketTargets({
    tickets: createTicketProviderRegistry([github, fake, jira]),
    runs: () => ({ getRun }) as never,
    workflows: () => ({ get: getWorkflow }) as never,
    projects: () => ({ getById: getProject }) as never,
    gitScopeOf,
  });
  return { targets, getRun, getWorkflow, getProject, gitScopeOf };
}

const LANE = { run: { workflowId: "wf-1" } };

describe("the ticket target of a run", () => {
  // #1035-T01
  it("is GitHub on the run's repository for a lane without a project", async () => {
    const { targets, getProject, gitScopeOf } = wire({
      ...LANE,
      workflow: { workflow: { projectId: null } },
    });

    expect(await targets.ticketTargetOf(call)).toEqual({
      provider: github,
      scope: gitScope,
    });
    expect(getProject).not.toHaveBeenCalled();
    expect(gitScopeOf).toHaveBeenCalledWith("w1", "repo-1");
  });

  it("is GitHub on the run's repository when the run is missing", async () => {
    const { targets, getWorkflow } = wire({ run: undefined });

    expect(await targets.ticketTargetOf(call)).toEqual({
      provider: github,
      scope: gitScope,
    });
    expect(getWorkflow).not.toHaveBeenCalled();
  });

  it("is GitHub on the run's repository when the lane is missing", async () => {
    const { targets, getProject } = wire({ ...LANE, workflow: undefined });

    expect(await targets.ticketTargetOf(call)).toEqual({
      provider: github,
      scope: gitScope,
    });
    expect(getProject).not.toHaveBeenCalled();
  });

  it("is GitHub on the run's repository when the project was deleted", async () => {
    const { targets, getProject } = wire({
      ...LANE,
      workflow: { workflow: { projectId: "p1" } },
      project: undefined,
    });

    expect(await targets.ticketTargetOf(call)).toEqual({
      provider: github,
      scope: gitScope,
    });
    expect(getProject).toHaveBeenCalledWith("p1");
  });

  it("is the same integration and repository the git target names for a project with a GitHub source", async () => {
    const { targets, gitScopeOf } = wire({
      ...LANE,
      workflow: { workflow: { projectId: "p1" } },
      project: project({ provider: "github" }),
    });

    const target = await targets.ticketTargetOf(call);

    expect(target?.provider).toBe(github);
    expect(target?.scope.integration).toBe(integration);
    expect(target?.scope.repo).toBe(repo);
    expect(gitScopeOf).toHaveBeenCalledWith("w1", "repo-1");
  });

  it("finds no target when the run's repository has no active connection", async () => {
    const { targets } = wire({
      ...LANE,
      workflow: { workflow: { projectId: null } },
      gitScope: undefined,
    });

    expect(await targets.ticketTargetOf(call)).toBeUndefined();
  });

  // #1039
  it("is the Jira provider with the Jira project of the source and the repository the code lives in, for a project with a Jira source", async () => {
    const { targets, gitScopeOf } = wire({
      ...LANE,
      workflow: { workflow: { projectId: "p1" } },
      project: project({
        provider: "jira",
        connectionId: "conn-1",
        projectKey: "PROJ",
      }),
    });

    const target = await targets.ticketTargetOf(call);

    expect(target?.provider).toBe(jira);
    expect(target?.scope).toEqual({
      integration,
      repo,
      jira: { connectionId: "conn-1", projectKey: "PROJ" },
    });
    expect(gitScopeOf).toHaveBeenCalledWith("w1", "repo-1");
  });

  // #1039
  it("finds no target for a Jira source that names no connection or project, or when the repository has no active connection", async () => {
    expect(
      await wire({
        ...LANE,
        workflow: { workflow: { projectId: "p1" } },
        project: project({ provider: "jira" }),
      }).targets.ticketTargetOf(call),
    ).toBeUndefined();
    expect(
      await wire({
        ...LANE,
        workflow: { workflow: { projectId: "p1" } },
        project: project({
          provider: "jira",
          connectionId: "conn-1",
          projectKey: "PROJ",
        }),
        gitScope: undefined,
      }).targets.ticketTargetOf(call),
    ).toBeUndefined();
  });

  it("does not guess a container for a source whose provider the server has no scope for", async () => {
    const { targets, gitScopeOf } = wire({
      ...LANE,
      workflow: { workflow: { projectId: "p1" } },
      project: project({ provider: "fake" }),
    });

    expect(await targets.ticketTargetOf(call)).toBeUndefined();
    expect(gitScopeOf).not.toHaveBeenCalled();
  });
});

describe("the project of a run", () => {
  it("is the project of the lane, and undefined where there is none", async () => {
    const stored = project({});
    expect(
      await wire({
        ...LANE,
        workflow: { workflow: { projectId: "p1" } },
        project: stored,
      }).targets.projectOfRun(call),
    ).toBe(stored);
    expect(
      await wire({ run: undefined }).targets.projectOfRun(call),
    ).toBeUndefined();
    expect(
      await wire({
        ...LANE,
        workflow: { workflow: { projectId: null } },
      }).targets.projectOfRun(call),
    ).toBeUndefined();
  });
});
