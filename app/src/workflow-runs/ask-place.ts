// SPDX-License-Identifier: LicenseRef-Proprietary

// Where the question of a run is shown (#920): the ticket of the run, else the pull request an action step of it opened. Kept apart from
// `ask-channel.ts` so the engine can ask for the place without importing the channel, which imports the engine's types.
import type {
  StoredStepRun,
  StoredWorkflowRun,
} from "../db/repositories/workflow-runs-repository.ts";
import { isRecord } from "../workflows/json.ts";
import { JIRA_ISSUE_KEY, parseTicketRef } from "../workflows/ticket-ref.ts";
import { ticketNumberOfKey } from "../integrations/ticket-provider.ts";
import { readStoredInput } from "./ticket.ts";

/**
 * What a run is about: the key of its ticket or, failing that, the number of the pull request it opened (as text, like a key). A ticket is
 * written through the ticket provider, a pull request through the git provider (#1035).
 */
export type Place = { key: string; kind: "ticket" | "pull_request" };

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
 * The ticket the run is about: the key in `workflow_runs.ticket_ref` (#923). A run written before the column existed and not
 * backfilled has none, and its ticket is read from the input of its trigger: `trigger.ticket` of a run with a `ticket` input, and the
 * issue of a run a label started.
 */
export function ticketKeyOf(
  run: Pick<StoredWorkflowRun, "ticketRef" | "triggerInput">,
): string | undefined {
  if (run.ticketRef !== null) {
    const parsed = parseTicketRef(run.ticketRef);
    if (parsed.ok) return parsed.ref.key;
  }
  const { input, ticket } = readStoredInput(jsonOrNull(run.triggerInput));
  const found =
    ticket ??
    (isRecord(input.ticket) ? input.ticket : undefined) ??
    (isRecord(input.issue) ? input.issue : undefined);
  if (found === undefined) return undefined;
  if (typeof found.key === "string" && found.key !== "") return found.key;
  const number = wholeNumber(found.number);
  return number === undefined ? undefined : String(number);
}

/** The key of the Jira issue a run is about (`PROJ-12` of `jira:acme/shop#PROJ-12`), or undefined: another provider, or no ticket. */
export function jiraKeyOfRef(ticketRef: string | null): string | undefined {
  if (ticketRef === null) return undefined;
  const parsed = parseTicketRef(ticketRef);
  return parsed.ok &&
    parsed.ref.provider === "jira" &&
    JIRA_ISSUE_KEY.test(parsed.ref.key)
    ? parsed.ref.key
    : undefined;
}

/** The number of the run's ticket where the provider numbers its tickets (GitHub), or undefined: `ticketKeyOf` read as a number. */
export function ticketNumberOf(
  run: Pick<StoredWorkflowRun, "ticketRef" | "triggerInput">,
): number | undefined {
  const key = ticketKeyOf(run);
  return key === undefined ? undefined : ticketNumberOfKey(key);
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
  const ticket = ticketKeyOf(run);
  if (ticket !== undefined) return { key: ticket, kind: "ticket" };
  const pullRequest = pullRequestNumberOf(steps);
  return pullRequest === undefined
    ? undefined
    : { key: String(pullRequest), kind: "pull_request" };
}
