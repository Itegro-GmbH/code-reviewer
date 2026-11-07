// SPDX-License-Identifier: LicenseRef-Proprietary

// The samples of the latest run (#927): what the picker shows next to a value.
import { describe, expect, it } from "vitest";
import type {
  StoredStepRun,
  StoredWorkflowRun,
  WorkflowRunsRepository,
} from "../db/repositories/workflow-runs-repository.ts";
import { latestRunSamples } from "./samples.ts";

function runsWith(
  run: Partial<StoredWorkflowRun> | undefined,
  steps: Partial<StoredStepRun>[] = [],
): Pick<WorkflowRunsRepository, "listRuns" | "listSteps"> {
  return {
    listRuns: async () =>
      run === undefined
        ? []
        : [
            {
              triggerKind: "manual",
              triggerId: null,
              failure: null,
              ...run,
            } as StoredWorkflowRun,
          ],
    listSteps: async () => steps as StoredStepRun[],
  };
}

describe("latestRunSamples", () => {
  // #927-T25
  it("has nothing for a workflow that has not run", async () => {
    expect(await latestRunSamples(runsWith(undefined), "wf")).toBeUndefined();
  });

  // #927-T26
  it("reads a run started by hand: its input and ticket as the steps read them, and the output of the steps that succeeded", async () => {
    const samples = await latestRunSamples(
      runsWith(
        {
          triggerKind: "manual",
          triggerId: "start",
          triggerInput: JSON.stringify({
            input: { reason: "why" },
            ticket: { title: "Crash" },
          }),
        },
        [
          { stepId: "a", status: "succeeded", output: '{"summary":"first"}' },
          { stepId: "a", status: "succeeded", output: '{"summary":"second"}' },
          { stepId: "b", status: "failed", output: '{"summary":"no"}' },
        ],
      ),
      "wf",
    );

    expect(samples?.trigger).toEqual({
      id: "start",
      kind: "manual",
      input: { reason: "why" },
      ticket: { title: "Crash" },
    });
    expect(samples?.steps).toEqual({ a: { summary: "second" } });
    expect(samples?.failure).toBeUndefined();
  });

  // #927-T27
  it("reads a run a label started, and the failure of a run that began its onFailure steps", async () => {
    const samples = await latestRunSamples(
      runsWith({
        triggerKind: "ticket.labeled",
        triggerInput: JSON.stringify({ ticket: { title: "T" } }),
        failure: JSON.stringify({
          status: "failed",
          stepId: "a",
          code: "x",
          message: "boom",
          errorCode: null,
        }),
      }),
      "wf",
    );

    expect(samples?.trigger).toMatchObject({
      kind: "ticket.labeled",
      id: "labeled",
      ticket: { title: "T" },
    });
    expect(samples?.failure).toMatchObject({ message: "boom" });
  });
});
