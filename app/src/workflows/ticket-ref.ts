// SPDX-License-Identifier: LicenseRef-Proprietary

// The ticket (#916): the work item a run is about, in the words of the platform it lives on. A ticket is named by a reference,
// `<provider>:<locator>`, like `github:owner/repo#128`; the engine resolves it through the provider when the run starts and the steps
// read the result as `{{trigger.ticket.…}}`. GitHub and Jira are the providers; the reference and the fields are provider neutral, so
// each fills the same fields. A ticket is named by a text key inside its provider (`15` for a GitHub issue, `PROJ-123`
// for Jira, #1035). Pure: no database, no I/O.
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

/**
 * The providers a ticket reference may name; a caller that has registered another one (a test, later Jira) passes its own list. The same
 * list as `TICKET_PROVIDERS` of `integrations/types.ts`, which the project's ticket source reads (this module may not import it; a test
 * holds the two together).
 */
export const TICKET_PROVIDERS = ["github", "jira"] as const;
export type TicketProviderName = string;

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
  /** The text key of the ticket (`15` for GitHub, `PROJ-123` for Jira): the one field every provider fills. */
  key: STRING,
  /** The number of the ticket where the platform numbers its tickets (GitHub lanes); `key` is the field for all providers. */
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
  provider: TicketProviderName;
  /** Where the key lives: `owner/name` of the repository for GitHub. */
  repo: string;
  /** The text key of the ticket inside the provider: `128` for a GitHub issue. */
  key: string;
};

const GITHUB_REF =
  /^github:([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})#(\d{1,10})$/;
/** The form of a reference of any other provider: its container, then the key. Providers refine it when they arrive. */
const GENERIC_REF =
  /^[a-z][a-z0-9]{0,31}:([A-Za-z0-9_./-]{1,200})#([A-Za-z0-9._-]{1,64})$/;

export type TicketRefProblem = {
  reason: "format" | "provider" | "number";
  message: string;
};

/** Reads `github:owner/repo#128`; the problem says what is wrong, for an issue of the validator or a refused start. */
export function parseTicketRef(
  text: string,
  providers: readonly string[] = TICKET_PROVIDERS,
): { ok: true; ref: TicketRef } | { ok: false; problem: TicketRefProblem } {
  const colon = text.indexOf(":");
  const provider = colon < 0 ? "" : text.slice(0, colon);
  if (provider !== "" && !providers.includes(provider))
    return {
      ok: false,
      problem: {
        reason: "provider",
        message: `The ticket provider ${JSON.stringify(provider.slice(0, 40))} is not known. Providers: ${providers.join(", ")}.`,
      },
    };
  if (provider !== "github") {
    const generic = provider === "" ? null : GENERIC_REF.exec(text);
    if (generic !== null)
      return {
        ok: true,
        ref: { provider, repo: generic[1] ?? "", key: generic[2] ?? "" },
      };
  }
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
    ref: {
      provider: "github",
      repo: `${match[1]}/${match[2]}`,
      key: String(number),
    },
  };
}

export function formatTicketRef(ref: TicketRef): string {
  return `${ref.provider}:${ref.repo}#${ref.key}`;
}
