// SPDX-License-Identifier: LicenseRef-Proprietary

// What the app does with the result an agent handed in (#843), at the completion of its turn, once the report is cleaned. The result
// is the agent's data and never a reason to lose the report it comes with (the branches that were pushed, the commits, the usage):
// a result over the bounds, after the secrets were taken out of it, is dropped; and a turn that has a result schema and reports
// success without a result is recorded as `no_result`, as the runner does for a turn it ends itself. The app does not check the value
// against the schema of the turn (the runner did; the M3 engine checks it again with `checkResultValue` before it routes the value
// anywhere, `docs/workflows.md`). Pure.
import { boundAgentResult } from "../db/agent-result.ts";
import type { RunnerResult } from "./contract.ts";

export const MISSING_AGENT_RESULT_MESSAGE =
  "the agent ended without a result that fits the schema";

/**
 * The result as it is stored. `hasSchema` is asked only when the report is a success without a result. A result that is over the
 * bounds is taken out (also where the turn failed for another reason, which keeps its code); a success of a turn with a schema and
 * no result is the failure `no_result`, which keeps the rest of the report.
 */
export async function withAgentResultOrNoResult(
  result: RunnerResult,
  hasSchema: () => Promise<boolean>,
): Promise<RunnerResult> {
  const block = result.implementer;
  if (block === undefined) return result;
  let kept = result;
  if (block.agentResult !== undefined) {
    if (boundAgentResult(block.agentResult).ok) return result;
    const rest = { ...block };
    delete rest.agentResult;
    kept = { ...result, implementer: rest };
  }
  if (kept.errorCode !== null || !(await hasSchema())) return kept;
  return {
    ...kept,
    ok: false,
    errorCode: "no_result",
    errorMessage: MISSING_AGENT_RESULT_MESSAGE,
  };
}
