// SPDX-License-Identifier: LicenseRef-Proprietary

// The Jira site of a ticket in the lane runs list (#1086): looked up once per repository with Jira runs, never for a GitHub issue.
import { describe, expect, it } from "vitest";
import type {
  StoredWorkflowRun,
  WorkspaceRunRow,
} from "../db/repositories/workflow-runs-repository.ts";
import { createWorkflowRunService } from "./service.ts";

function rowOf(id: string, repositoryId: string, ticketRef: string) {
  return {
    run: {
      id,
      workspaceId: "ws-1",
      workflowId: "wf-1",
      workflowVersion: 1,
      repositoryId,
      status: "succeeded",
      errorCode: null,
      budgetMicroUsd: 0,
      spentMicroUsd: 0,
      triggerKind: "manual",
      triggerId: "by-hand",
      actorLogin: "ada",
      ticketRef,
      createdAt: "2026-11-18T10:00:00.000Z",
      finishedAt: null,
    } as unknown as StoredWorkflowRun,
    laneName: "Lane",
    repositoryName: "acme/widgets",
    steps: [],
    document: null,
    ticket: { title: "T" },
  } satisfies WorkspaceRunRow;
}

function serviceWith(
  rows: WorkspaceRunRow[],
  lookups: string[],
  withLookup = true,
) {
  return createWorkflowRunService({
    runs: {
      async listWorkspaceRuns() {
        return { rows, next: null };
      },
    },
    ...(withLookup
      ? {
          async jiraSiteUrlOf(repositoryId: string) {
            lookups.push(repositoryId);
            if (repositoryId === "repo-boom") throw new Error("db down");
            return repositoryId === "repo-1"
              ? { siteUrl: "https://acme.atlassian.net", projectKey: "LAT" }
              : undefined;
          },
        }
      : {}),
  } as unknown as Parameters<typeof createWorkflowRunService>[0]);
}

describe("listWorkspace and the Jira site", () => {
  // #1086-T06
  it("hands the site of the project's connection to the Jira tickets only, one lookup per repository", async () => {
    const lookups: string[] = [];
    const view = await serviceWith(
      [
        rowOf("a", "repo-1", "jira:acme/widgets#LAT-1"),
        rowOf("b", "repo-1", "jira:acme/widgets#LAT-2"),
        rowOf("c", "repo-2", "jira:acme/other#LAT-3"),
        rowOf("d", "repo-1", "github:acme/widgets#5"),
      ],
      lookups,
    ).listWorkspace({});

    expect(view.runs.map((run) => run.ticket?.jiraSiteUrl)).toEqual([
      "https://acme.atlassian.net",
      "https://acme.atlassian.net",
      null,
      null,
    ]);
    expect(lookups.sort()).toEqual(["repo-1", "repo-2"]);
  });

  // #1086-T07
  it("asks for no site on a page without a Jira ticket, and links nothing where the service has no lookup", async () => {
    const lookups: string[] = [];
    const github = await serviceWith(
      [rowOf("a", "repo-1", "github:acme/widgets#5")],
      lookups,
    ).listWorkspace({});
    expect(lookups).toEqual([]);
    expect(github.runs[0]?.ticket?.jiraSiteUrl).toBeNull();

    const without = await serviceWith(
      [rowOf("a", "repo-1", "jira:acme/widgets#LAT-1")],
      lookups,
      false,
    ).listWorkspace({});
    expect(without.runs[0]?.ticket?.jiraSiteUrl).toBeNull();
  });

  // #1086-T09
  it("links no ticket of a project that was pointed at another Jira project since the run", async () => {
    const view = await serviceWith(
      [
        rowOf("a", "repo-1", "jira:acme/widgets#OLD-9"),
        rowOf("b", "repo-1", "jira:acme/widgets#LAT-9"),
      ],
      [],
    ).listWorkspace({});

    expect(view.runs.map((run) => run.ticket?.jiraSiteUrl)).toEqual([
      null,
      "https://acme.atlassian.net",
    ]);
  });

  // #1086-T10
  it("lists the runs without a link for a repository whose site lookup fails, the others keep theirs", async () => {
    const view = await serviceWith(
      [
        rowOf("a", "repo-boom", "jira:acme/boom#LAT-1"),
        rowOf("b", "repo-1", "jira:acme/widgets#LAT-2"),
      ],
      [],
    ).listWorkspace({});

    expect(view.runs.map((run) => run.ticket?.jiraSiteUrl)).toEqual([
      null,
      "https://acme.atlassian.net",
    ]);
  });
});
