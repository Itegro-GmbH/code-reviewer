// SPDX-License-Identifier: LicenseRef-Proprietary

// Whether the page of an agent run asks for its lane step (#1080, epic #1077): only a deployment with the Implementer (lanes run on it) and
// only for a task (a run of the Implementer); any other run costs no read. The lookup is the run service's, inside the workspace.
import type {
  LaneStepOfAgentRunView,
  WorkflowRunService,
} from "../workflow-runs/service.ts";

export async function laneStepOfAgentRunPage(input: {
  /** `getCapabilities().has("implementer")` */
  hasImplementer: boolean;
  /** Whether the run is an Implementer task (`run.implementer !== undefined`). */
  isTask: boolean;
  runId: string;
  /** The service is made only when the lookup runs. */
  runs: () => Pick<WorkflowRunService, "laneStepOfAgentRun">;
}): Promise<LaneStepOfAgentRunView | undefined> {
  if (!input.hasImplementer || !input.isTask) return undefined;
  return input.runs().laneStepOfAgentRun(input.runId);
}
