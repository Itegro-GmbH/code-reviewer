// SPDX-License-Identifier: LicenseRef-Proprietary

// The ticket a run is about (#916), as the steps read it: `{{trigger.ticket.number|title|body|labels|type|assignees|url|repo}}`. Every
// trigger that yields one makes it the same way, whether the platform handed it over in a webhook (the label trigger) or the engine
// read it when a person or a script started the run (the `ticket` input). The texts are those of whoever opened the ticket: bounded here
// once, and defused where they go into the text of an action (`templates.ts`).
import {
  BRANCH_MAX_CHARS,
  ISSUE_BODY_MAX_CHARS,
  ISSUE_LABELS_MAX,
  ISSUE_LABEL_MAX_CHARS,
  ISSUE_TITLE_MAX_CHARS,
  ISSUE_URL_MAX_CHARS,
  TICKET_ASSIGNEES_MAX,
  TICKET_ASSIGNEE_MAX_CHARS,
  TICKET_TYPE_MAX_CHARS,
} from "./limits.ts";
import { isRecord } from "../workflows/json.ts";
import { cleanText } from "./templates.ts";

/** What `{{trigger.ticket}}` holds: `TICKET_TYPE` of `src/workflows/ticket-ref.ts`. */
export type TicketValue = {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  type: string;
  assignees: string[];
  repo: {
    fullName: string;
    owner: string;
    name: string;
    defaultBranch: string;
  };
};

/**
 * The text without what no text may hold (`cleanText`), at most `max` characters. A longer text is cut and says how long it was, so
 * that whoever reads it knows (`note`), within `max` as a whole.
 */
export function bounded(text: string, max: number, note: boolean): string {
  const clean = cleanText(text);
  const characters = Array.from(clean);
  if (characters.length <= max) return clean;
  const ending = note ? `… [cut: ${characters.length} characters]` : "…";
  return `${characters.slice(0, max - ending.length).join("")}${ending}`;
}

/** The ticket as the steps read it, bounded. `assignees` and `type` are empty when the platform did not say. */
export function ticketValue(
  ticket: {
    number: number;
    title: string;
    body: string;
    url: string;
    labels: readonly string[];
    type?: string | undefined;
    assignees?: readonly string[] | undefined;
  },
  repo: { fullName: string; defaultBranch: string },
): TicketValue {
  const { fullName } = repo;
  const slash = fullName.indexOf("/");
  return {
    number: ticket.number,
    title: bounded(ticket.title, ISSUE_TITLE_MAX_CHARS, false),
    body: bounded(ticket.body, ISSUE_BODY_MAX_CHARS, true),
    url: bounded(ticket.url, ISSUE_URL_MAX_CHARS, false),
    labels: ticket.labels
      .slice(0, ISSUE_LABELS_MAX)
      .map((name) => bounded(name, ISSUE_LABEL_MAX_CHARS, false)),
    type: bounded(ticket.type ?? "", TICKET_TYPE_MAX_CHARS, false),
    assignees: (ticket.assignees ?? [])
      .slice(0, TICKET_ASSIGNEES_MAX)
      .map((login) => bounded(login, TICKET_ASSIGNEE_MAX_CHARS, false)),
    repo: {
      fullName,
      owner: slash < 0 ? fullName : fullName.slice(0, slash),
      name: slash < 0 ? fullName : fullName.slice(slash + 1),
      defaultBranch: bounded(repo.defaultBranch, BRANCH_MAX_CHARS, false),
    },
  };
}

/**
 * What a run started by hand or through the API stored as its `trigger_input`: the input as it was handed in (the shape every version
 * stored, kept for every run whose trigger has no `ticket` input, so a version that still runs during a deploy reads it), or
 * `{ input, ticket }` for a run that has a ticket (the input without the ticket, and the ticket as it was read when the run started).
 * The two are told apart by `ticket`: a record next to an `input` record and nothing else.
 */
export function readStoredInput(stored: unknown): {
  input: Record<string, unknown>;
  ticket?: Record<string, unknown>;
} {
  if (!isRecord(stored)) return { input: {} };
  const { input, ticket, ...others } = stored;
  if (Object.keys(others).length === 0 && isRecord(input) && isRecord(ticket))
    return { input, ticket };
  return { input: stored };
}

/** The `trigger_input` to store for a run started by hand or through the API: the raw input, or `{ input, ticket }` once a ticket is resolved. */
export function storedInputOf(
  input: Record<string, unknown>,
  ticket: TicketValue | undefined,
): Record<string, unknown> {
  return ticket === undefined ? input : { input, ticket };
}
