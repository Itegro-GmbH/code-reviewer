// SPDX-License-Identifier: LicenseRef-Proprietary

// The query, the cursor and the row of the list of lane runs (#1078).
import { describe, expect, it } from "vitest";
import type {
  StoredWorkflowRun,
  WorkspaceRunRow,
} from "../db/repositories/workflow-runs-repository.ts";
import { WorkflowRunError } from "./errors.ts";
import {
  decodeCursor,
  encodeCursor,
  LANE_RUNS_PAGE_DEFAULT,
  LANE_RUNS_PAGE_MAX,
  listItemOf,
  readListQuery,
} from "./lane-run-list.ts";

function stored(overrides: Partial<StoredWorkflowRun> = {}): StoredWorkflowRun {
  return {
    id: "run-1",
    workspaceId: "ws-1",
    workflowId: "wf-1",
    workflowVersion: 2,
    repositoryId: "repo-1",
    baseBranch: "main",
    triggerInput: "{}",
    status: "running",
    errorCode: null,
    budgetMicroUsd: 20_000_000,
    spentMicroUsd: 1_500_000,
    clientRequestId: "req-1",
    triggerKind: "manual",
    triggerId: "by-hand",
    createdBy: null,
    actorLogin: "octocat",
    cancelRequestedAt: null,
    discardedAt: null,
    pauseRequestedAt: null,
    failure: null,
    ticketRef: "github:acme/widgets#128",
    createdAt: "2026-11-18T10:00:00.000Z",
    updatedAt: "2026-11-18T10:05:00.000Z",
    finishedAt: null,
    ...overrides,
  };
}

const document = JSON.stringify({
  triggers: [{ id: "by-hand", kind: "manual" }],
  steps: [
    { id: "plan", kind: "agent", description: "Plan" },
    { id: "ship", kind: "action", connector: "pr.merge" },
  ],
});

function row(overrides: Partial<WorkspaceRunRow> = {}): WorkspaceRunRow {
  return {
    run: stored(),
    laneName: "Ship it",
    repositoryName: "acme/widgets",
    steps: [{ stepId: "plan", kind: "agent", status: "running", round: 1 }],
    document,
    ticket: { title: "Cache the thing" },
    ...overrides,
  };
}

describe("readListQuery", () => {
  // #1078-T40
  it("reads no filter and the default page size from an empty query", () => {
    expect(readListQuery({})).toEqual({
      filter: {},
      limit: LANE_RUNS_PAGE_DEFAULT,
    });
    expect(
      readListQuery({
        status: null,
        project: "",
        lane: undefined,
        cursor: null,
      }),
    ).toEqual({ filter: {}, limit: LANE_RUNS_PAGE_DEFAULT });
  });

  // #1078-T41
  it("reads the status, the project, the lane and the limit", () => {
    expect(
      readListQuery({
        status: "waiting",
        project: "repo-1",
        lane: "wf-1",
        limit: "10",
      }),
    ).toEqual({
      filter: { status: "waiting", repositoryId: "repo-1", workflowId: "wf-1" },
      limit: 10,
    });
  });

  // #1078-T42
  it.each([
    { status: "everything" },
    { limit: "0" },
    { limit: String(LANE_RUNS_PAGE_MAX + 1) },
    { limit: "ten" },
    { project: "x".repeat(200) },
    { cursor: "not a cursor" },
  ])("refuses %o with WORKFLOW_RUN_REQUEST_INVALID", (raw) => {
    expect(() => readListQuery(raw)).toThrow(
      expect.objectContaining({
        constructor: WorkflowRunError,
        code: "WORKFLOW_RUN_REQUEST_INVALID",
      }),
    );
  });
});

describe("the cursor", () => {
  // #1078-T43
  it("round-trips", () => {
    const cursor = {
      active: false,
      createdAt: "2026-11-18T10:00:00.000Z",
      id: "run-9",
    };

    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    expect(decodeCursor(encodeCursor({ ...cursor, active: true })).active).toBe(
      true,
    );
  });

  // #1078-T44
  it("refuses a cursor that is no cursor", () => {
    const wrong = [
      Buffer.from('[2,"a","b"]').toString("base64url"),
      Buffer.from('[0,"a"]').toString("base64url"),
      Buffer.from('{"a":1}').toString("base64url"),
      Buffer.from("[0,1,2]").toString("base64url"),
    ];
    for (const text of wrong)
      expect(() => decodeCursor(text)).toThrow(WorkflowRunError);
  });
});

describe("listItemOf", () => {
  // #1078-T45
  it("carries the lane, project, ticket, budget and the track inputs of the run", () => {
    const item = listItemOf(row());

    expect(item).toMatchObject({
      id: "run-1",
      laneName: "Ship it",
      workflowVersion: 2,
      status: "running",
      project: { id: "repo-1", name: "acme/widgets" },
      ticket: {
        label: "#128",
        title: "Cache the thing",
        key: "128",
        githubRepository: "acme/widgets",
        jiraSiteUrl: null,
      },
      budgetUsd: 20,
      spentUsd: 1.5,
    });
    expect(item.nodes.map((node) => node.id)).toEqual(["plan", "ship"]);
    expect(item.steps).toEqual([
      { id: "plan", kind: "agent", status: "running", round: 1 },
    ]);
  });

  // #1078-T46
  it("has no ticket for a run without one, and no title for a ticket the mirror does not hold", () => {
    expect(
      listItemOf(row({ run: stored({ ticketRef: null }) })).ticket,
    ).toBeNull();
    expect(listItemOf(row({ ticket: null })).ticket?.title).toBeNull();
  });

  // #1078-T47
  it("names a Jira ticket by its key and carries no site when the project's connection is not known", () => {
    const item = listItemOf(
      row({ run: stored({ ticketRef: "jira:acme/widgets#LAT-58" }) }),
    );

    expect(item.ticket).toMatchObject({
      label: "LAT-58",
      key: "LAT-58",
      githubRepository: null,
      jiraSiteUrl: null,
    });
  });

  // #1086-T04
  it("carries the Jira site of the repository of the run for a Jira ticket, and never for a GitHub issue", () => {
    const sites = new Map([
      ["repo-1", { siteUrl: "https://acme.atlassian.net", projectKey: "LAT" }],
    ]);

    expect(
      listItemOf(
        row({ run: stored({ ticketRef: "jira:acme/widgets#LAT-58" }) }),
        sites,
      ).ticket?.jiraSiteUrl,
    ).toBe("https://acme.atlassian.net");
    expect(listItemOf(row(), sites).ticket?.jiraSiteUrl).toBeNull();
  });

  // #1086-T08
  it("links no Jira ticket whose key is of another Jira project than the project's current source", () => {
    const sites = new Map([
      ["repo-1", { siteUrl: "https://beta.atlassian.net", projectKey: "LAT" }],
    ]);
    const of = (ref: string) =>
      listItemOf(row({ run: stored({ ticketRef: ref }) }), sites).ticket
        ?.jiraSiteUrl;

    expect(of("jira:acme/widgets#OLD-58")).toBeNull();
    // A key that only starts with the same letters is another project.
    expect(of("jira:acme/widgets#LATE-58")).toBeNull();
    expect(of("jira:acme/widgets#LAT-58")).toBe("https://beta.atlassian.net");
  });

  // #1078-T48
  it("shows no ticket for a reference that does not parse, and no nodes for a version that is gone", () => {
    const item = listItemOf(
      row({
        run: stored({ ticketRef: "javascript:alert(1)" }),
        document: null,
      }),
    );

    expect(item.ticket).toBeNull();
    expect(item.nodes).toEqual([]);
  });
});
