// SPDX-License-Identifier: LicenseRef-Proprietary

// The gate of the lane note on the page of an agent run (#1080): the lookup runs only for a task, on a deployment with the Implementer.
import { describe, expect, it, vi } from "vitest";
import { laneStepOfAgentRunPage } from "./agent-run-lane-step.ts";

const STEP = {
  workflowId: "wf-1",
  runId: "run-1",
  laneName: "Ship it",
  stepId: "implement",
};

function runs() {
  return { laneStepOfAgentRun: vi.fn().mockResolvedValue(STEP) };
}

describe("the lane step of the page of an agent run", () => {
  // #1080-T70
  it("is read for a task on a deployment with the Implementer", async () => {
    const service = runs();

    expect(
      await laneStepOfAgentRunPage({
        hasImplementer: true,
        isTask: true,
        runId: "job-1",
        runs: () => service,
      }),
    ).toEqual(STEP);
    expect(service.laneStepOfAgentRun).toHaveBeenCalledWith("job-1");
  });

  // #1080-T71
  it("is not read for a run that is no task, nor on a deployment without the Implementer", async () => {
    const service = runs();

    expect(
      await laneStepOfAgentRunPage({
        hasImplementer: true,
        isTask: false,
        runId: "job-1",
        runs: () => service,
      }),
    ).toBeUndefined();
    expect(
      await laneStepOfAgentRunPage({
        hasImplementer: false,
        isTask: true,
        runId: "job-1",
        runs: () => service,
      }),
    ).toBeUndefined();
    expect(service.laneStepOfAgentRun).not.toHaveBeenCalled();
  });
});
