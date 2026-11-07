// SPDX-License-Identifier: LicenseRef-Proprietary

// The ticket (#916): the work item a run is about, in the words of the platform it lives on. A ticket is named by a reference,
// `<provider>:<locator>`, like `github:owner/repo#128`; the engine resolves it through the provider when the run starts and the steps
// read the result as `{{trigger.ticket.…}}`. GitHub is the one provider so far; the reference and the fields are provider neutral, so
// another one (Jira) fills the same fields. Pure: no database, no I/O.
import { ISSUE_NUMBER_MAX } from "./limits.ts";
import {
  INTEGER,
  STRING,
  listOf,
  objectOf,
  type ObjectType,
} from "./value-type.ts";

/** The name of the input that holds the ticket: `{{trigger.ticket}}` reads it. */
export const TICKET_INPUT = "ticket";

export const TICKET_PROVIDERS = ["github"] as const;
export type TicketProvider = (typeof TICKET_PROVIDERS)[number];

/** The repository a ticket lives in, as the steps read `{{trigger.ticket.repo.…}}` and (for an issue trigger) `{{trigger.repo.…}}`. */
export const TICKET_REPO_TYPE: ObjectType = objectOf({
  fullName: STRING,
  owner: STRING,
  name: STRING,
  defaultBranch: STRING,
});

/**
 * What `{{trigger.ticket}}` holds, whichever trigger yields it. `type` is the kind of ticket the platform reports (GitHub's issue type
 * such as `Bug`) and is empty when it has none; `assignees` are the logins of the people it is assigned to.
 */
export const TICKET_TYPE: ObjectType = objectOf({
  number: INTEGER,
  title: STRING,
  body: STRING,
  url: STRING,
  labels: listOf(STRING),
  type: STRING,
  assignees: listOf(STRING),
  repo: TICKET_REPO_TYPE,
});

export type TicketRef = {
  provider: TicketProvider;
  /** `owner/name` of the repository. */
  repo: string;
  number: number;
};

const GITHUB_REF =
  /^github:([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})#(\d{1,10})$/;

export type TicketRefProblem = {
  reason: "format" | "provider" | "number";
  message: string;
};

/** Reads `github:owner/repo#128`; the problem says what is wrong, for an issue of the validator or a refused start. */
export function parseTicketRef(
  text: string,
): { ok: true; ref: TicketRef } | { ok: false; problem: TicketRefProblem } {
  const colon = text.indexOf(":");
  const provider = colon < 0 ? "" : text.slice(0, colon);
  if (
    provider !== "" &&
    !(TICKET_PROVIDERS as readonly string[]).includes(provider)
  )
    return {
      ok: false,
      problem: {
        reason: "provider",
        message: `The ticket provider ${JSON.stringify(provider.slice(0, 40))} is not known. Providers: ${TICKET_PROVIDERS.join(", ")}.`,
      },
    };
  const match = GITHUB_REF.exec(text);
  if (match === null)
    return {
      ok: false,
      problem: {
        reason: "format",
        message:
          "A ticket is named like github:owner/repo#128: the provider, the repository and the number.",
      },
    };
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number < 1 || number > ISSUE_NUMBER_MAX)
    return {
      ok: false,
      problem: {
        reason: "number",
        message: `The number of a ticket is a whole number from 1 to ${ISSUE_NUMBER_MAX}.`,
      },
    };
  return {
    ok: true,
    ref: { provider: "github", repo: `${match[1]}/${match[2]}`, number },
  };
}

export function formatTicketRef(ref: TicketRef): string {
  return `${ref.provider}:${ref.repo}#${ref.number}`;
}
