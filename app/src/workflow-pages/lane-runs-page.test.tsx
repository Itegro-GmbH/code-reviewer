// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The two tabs of the Runs page (#1078): chosen through the address, the Lane runs tab the default only where lanes exist.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LANE_RUNS_COPY } from "./messages.ts";
import type { LaneRunListView } from "../workflow-runs/lane-run-list.ts";
import {
  RunsViewTabs,
  loadLaneRunsPage,
  runsViewOf,
} from "./lane-runs-page.tsx";

afterEach(cleanup);

describe("runsViewOf", () => {
  // #1078-T110
  it("defaults to the lane runs where the deployment has lanes, and takes ?view=agents", () => {
    expect(runsViewOf({}, true)).toBe("lanes");
    expect(runsViewOf({ view: "lanes" }, true)).toBe("lanes");
    expect(runsViewOf({ view: "agents" }, true)).toBe("agents");
    expect(runsViewOf({ view: ["agents", "lanes"] }, true)).toBe("agents");
    expect(runsViewOf({ view: "nonsense" }, true)).toBe("lanes");
  });

  // #1078-T111
  it("is the agent runs where the deployment has no lanes, whatever the address says", () => {
    expect(runsViewOf({}, false)).toBe("agents");
    expect(runsViewOf({ view: "lanes" }, false)).toBe("agents");
  });
});

describe("RunsViewTabs", () => {
  // #1078-T112
  it("links the two tabs through the address and marks the current one", () => {
    render(<RunsViewTabs workspaceSlug="acme" view="agents" />);

    const lanes = screen.getByRole("link", { name: LANE_RUNS_COPY.tabLanes });
    const agents = screen.getByRole("link", { name: LANE_RUNS_COPY.tabAgents });
    expect(lanes.getAttribute("href")).toBe("/w/acme/runs?view=lanes");
    expect(agents.getAttribute("href")).toBe("/w/acme/runs?view=agents");
    expect(agents.getAttribute("aria-current")).toBe("page");
    expect(lanes.getAttribute("aria-current")).toBeNull();
  });
});

describe("loadLaneRunsPage", () => {
  const archivedRun = {
    id: "run-1",
    workflowId: "wf-archived",
    laneName: "Old lane",
    project: { id: "repo-1", name: "acme/widgets" },
  };
  const snapshot = (runs: object[]): LaneRunListView =>
    ({
      runs,
      nextCursor: null,
      now: "2026-11-18T12:00:00.000Z",
    }) as LaneRunListView;
  const deps = (runs: object[], lane?: { id: string; name: string }) => ({
    runs: { listWorkspace: async () => snapshot(runs) },
    workflows: {
      list: async () => ({
        workflows: [{ id: "wf-live", name: "Live lane" }],
        maximum: 100,
      }),
      get: async (id: string) => {
        if (lane?.id !== id) throw new Error("not found");
        return lane;
      },
    },
    projects: {
      listProjects: async () => [
        {
          repository: { id: "repo-1", fullName: "acme/widgets" },
          project: { id: "p-1", active: true },
        },
      ],
    },
  });
  const load = (
    search: Record<string, string>,
    runs: object[],
    lane?: { id: string; name: string },
  ) =>
    loadLaneRunsPage(
      search,
      deps(runs, lane) as unknown as Parameters<typeof loadLaneRunsPage>[1],
    );

  // #1078-T113
  it("offers the lane of a run on the page when the lane is archived, besides the lanes of the projects", async () => {
    const data = await load({}, [archivedRun]);

    expect(data.kind === "ready" && data.lanes).toEqual([
      { id: "wf-live", name: "Live lane" },
      { id: "wf-archived", name: "Old lane" },
    ]);
  });

  // #1078-T114
  it("offers the archived lane the address names, even when none of its runs is on the page, and no lane of another workspace", async () => {
    const named = await load({ lane: "wf-archived" }, [], {
      id: "wf-archived",
      name: "Old lane",
    });
    const foreign = await load({ lane: "wf-of-another-workspace" }, []);

    expect(
      named.kind === "ready" && named.lanes.map((lane) => lane.id),
    ).toEqual(["wf-live", "wf-archived"]);
    expect(
      foreign.kind === "ready" && foreign.lanes.map((lane) => lane.id),
    ).toEqual(["wf-live"]);
  });
});
