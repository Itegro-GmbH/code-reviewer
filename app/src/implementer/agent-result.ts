// SPDX-License-Identifier: LicenseRef-Proprietary

// The result schema of a task (#843), as the task keeps it. Written by the validator of the format (`workflows/result-schema.ts`) and
// read back by it, so a task never runs with a schema the finish tool cannot be made from. The result an agent hands in is checked
// against it by the runner, after the agent's container is gone (`runner/.../finish_tool.py`, held to the rules of
// `checkResultValue` by `contracts/result-check-vectors.json`); the app holds it to the bounds of a result (`db/agent-result.ts`) and
// keeps it as data. Pure.
import {
  validateResultSchema,
  type ResultSchema,
} from "../workflows/result-schema.ts";

/**
 * A schema written by the validator of the format, read back as the validator reads it. Null for text that is none (it cannot be: the
 * only writer is the validator's own service), so a caller never runs a turn with a schema it cannot use.
 */
export function readStoredResultSchema(
  text: string | null,
): ResultSchema | null {
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return validateResultSchema(parsed).schema ?? null;
}
