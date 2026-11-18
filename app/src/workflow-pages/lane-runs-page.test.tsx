// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The two tabs of the Runs page (#1078): chosen through the address, the Lane runs tab the default only where lanes exist.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LANE_RUNS_COPY } from "./messages.ts";
import { RunsViewTabs, runsViewOf } from "./lane-runs-page.tsx";

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
