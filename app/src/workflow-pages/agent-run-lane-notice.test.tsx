// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The note on an agent run that is a step of a lane run (#1080): it names the lane and the step and links to the lane run at that step.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentRunLaneNotice,
  laneRunStepPath,
} from "./agent-run-lane-notice.tsx";

afterEach(cleanup);

const STEP = {
  workflowId: "wf-1",
  runId: "run-1",
  laneName: "Ship it",
  stepId: "implement",
};

describe("the lane note of an agent run", () => {
  // #1080-T40
  it("says which lane and step the agent run belongs to and links to the lane run at that step", () => {
    render(<AgentRunLaneNotice workspaceSlug="acme" step={STEP} />);

    expect(
      screen.getByText(
        'This agent run is the step "implement" of the lane Ship it.',
      ),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Open the lane run at this step" })
        .getAttribute("href"),
    ).toBe("/w/acme/workflows/wf-1/runs/run-1?step=implement");
  });

  // #1080-T41
  it("shows the words of the lane's author as text and encodes them in the address", () => {
    const hostile = {
      workflowId: "wf/1",
      runId: "run 1",
      laneName: "<img src=x onerror=alert(1)>",
      stepId: "a&b=c#d",
    };

    const { container } = render(
      <AgentRunLaneNotice workspaceSlug="acme" step={hostile} />,
    );

    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(laneRunStepPath("acme", hostile)).toBe(
      "/w/acme/workflows/wf%2F1/runs/run%201?step=a%26b%3Dc%23d",
    );
  });
});
