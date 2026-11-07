// SPDX-License-Identifier: LicenseRef-Proprietary

// Where the question of a run is shown (#920): the ticket of the run, else the pull request an action step of it opened. Kept apart from
// `ask-channel.ts` so the engine can ask for the place without importing the channel, which imports the engine's types.
import type {
  StoredStepRun,
  StoredWorkflowRun,
} from "../db/repositories/workflow-runs-repository.ts";
import { isRecord } from "../workflows/json.ts";
import { parseTicketRef } from "../workflows/ticket-ref.ts";
import { readStoredInput } from "./ticket.ts";

/** What a run is about: the number of its ticket or, failing that, of the pull request it opened. */
export type Place = { number: number; kind: "ticket" | "pull_request" };

function jsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function wholeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
    ? value
    : undefined;
}

/**
 * The ticket the run is about: the number in `workflow_runs.ticket_ref` (#923). A run written before the column existed and not
 * backfilled has none, and its ticket is read from the input of its trigger: `trigger.ticket` of a run with a `ticket` input, and the
 * issue of a run a label started.
 */
export function ticketNumberOf(
  run: Pick<StoredWorkflowRun, "ticketRef" | "triggerInput">,
): number | undefined {
  if (run.ticketRef !== null) {
    const parsed = parseTicketRef(run.ticketRef);
    if (parsed.ok) return parsed.ref.number;
  }
  const { input, ticket } = readStoredInput(jsonOrNull(run.triggerInput));
  const found =
    ticket ??
    (isRecord(input.ticket) ? input.ticket : undefined) ??
    (isRecord(input.issue) ? input.issue : undefined);
  return found === undefined ? undefined : wholeNumber(found.number);
}

/** The pull request an action step of the run opened: the last one whose output is a pull request of the repository (`number` and its `/pull/<n>` address). */
export function pullRequestNumberOf(
  steps: readonly StoredStepRun[],
): number | undefined {
  for (const step of steps.toReversed()) {
    if (
      step.kind !== "action" ||
      step.status !== "succeeded" ||
      step.output === null
    )
      continue;
    const output = jsonOrNull(step.output);
    if (!isRecord(output)) continue;
    const number = wholeNumber(output.number);
    if (
      number !== undefined &&
      typeof output.url === "string" &&
      output.url.endsWith(`/pull/${String(number)}`)
    )
      return number;
  }
  return undefined;
}

/** Where a question of the run is shown. */
export function placeOf(
  run: Pick<StoredWorkflowRun, "ticketRef" | "triggerInput">,
  steps: readonly StoredStepRun[],
): Place | undefined {
  const ticket = ticketNumberOf(run);
  if (ticket !== undefined) return { number: ticket, kind: "ticket" };
  const pullRequest = pullRequestNumberOf(steps);
  return pullRequest === undefined
    ? undefined
    : { number: pullRequest, kind: "pull_request" };
}
