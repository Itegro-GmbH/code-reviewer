// SPDX-License-Identifier: LicenseRef-Proprietary

// The interface behind which everything ticket specific lives (#1035, epic #1034). Tickets are not a part of the git platform: a ticket
// source is GitHub issues today and becomes Jira Cloud next, while GitHub stays the code host (clone, push, pull request). The git
// `IntegrationProvider` (`provider.ts`) keeps the repository and the pull request; a `TicketProvider` reads and writes tickets, and the
// mirror of the tickets (`src/tracker/`) reads its deliveries and pages through it. A ticket is named by a text key (`15` for GitHub,
// `PROJ-123` for Jira), never by a number: a provider turns the key into whatever its platform calls the ticket.
import type {
  Integration,
  RepoRef,
  TrackerChangeResult,
  TrackerPage,
  TrackerPageStep,
} from "./types.ts";

/**
 * Where a call about tickets acts: the connection the platform is reached through, and the container the tickets sit in (GitHub: the
 * repository whose issues they are). The container is a `RepoRef` because that is what a GitHub ticket source is; a provider whose tickets
 * live in a project of its own reads the same fields as that project (id, key, address).
 */
export type TicketScope = {
  integration: Integration;
  repo: RepoRef;
  /**
   * Where the tickets are when they are not the repository's issues (#1039): the Jira project of the project's ticket source, on the
   * connection of the workspace. `repo` is then the repository the code lives in (where a mirror row and a pull request go).
   */
  jira?: { connectionId: string; projectKey: string };
};

/** One ticket as a provider reads it: the fields a workflow reads as `{{trigger.ticket.…}}`. The texts are those of whoever opened it: untrusted. */
export type TicketRead = {
  /** The text key of the ticket: `15` for a GitHub issue, `PROJ-123` for Jira. */
  key: string;
  /** The number of the ticket where the platform numbers its tickets (GitHub); absent otherwise. */
  number?: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  assignees: string[];
  type: string;
  /** The status of the ticket as its platform names it (Jira's own status name, #1039); absent where the platform gives none (GitHub issues). */
  status?: string;
  /** The platform's id of that status where it has one (Jira, #1058): the same in every language, unlike the name; absent otherwise. */
  statusId?: string;
};

/** A board of a ticket container as the picker of a new project needs it (#922). */
export type BoardInfo = {
  /** The platform's global id of the board. */
  projectV2Id: string;
  /** The number the board has in its owner's list. */
  number: number;
  title: string;
  /** The global id of its Status field; null when it has none (a status cannot be set on such a board). */
  statusFieldId: string | null;
  /** The names of the Status field's options, as the board spells them. */
  statuses: string[];
};

export interface TicketProvider {
  /** The provider's name in a project's ticket source and in a `ticket_ref` (`github`). */
  readonly id: string;

  /** True where a status is not a column of a board (Jira): `ticket.setStatus` then needs no board of the project and names none (#1040). */
  readonly boardless?: true;

  /**
   * Whether `key` can name a ticket of this provider at all (GitHub: a whole number; Jira: `PROJ-123`). A cheap check on the text, no call to
   * the platform: the ticket actions refuse a key that fails it as an input of the action. Left out, every key passes.
   */
  isTicketKey?(key: string): boolean;

  /**
   * One ticket of the container with the fields a workflow reads as `{{trigger.ticket.…}}` (#916), or null when there is none with that key
   * (a GitHub pull request is none). Read with a token limited to this container and to reading tickets. Rejects with an
   * `IntegrationError` like the reads of the git provider.
   */
  readTicket?(
    scope: TicketScope,
    key: string,
    signal?: AbortSignal,
  ): Promise<TicketRead | null>;

  /**
   * Writes `body` below the ticket, as the app (#844). With a `marker` (text inside `body`), the app's own comment that holds it is the
   * result (`existing`) and nothing is written, so a call that is made again does not comment twice; `since` (ISO 8601) bounds that look to
   * the comments changed after it. Rejects like the writes of the git provider.
   */
  commentOnTicket?(
    scope: TicketScope,
    key: string,
    body: string,
    options?: { signal?: AbortSignal; marker?: string; since?: string },
  ): Promise<{ url: string; existing: boolean; id?: string }>;

  /**
   * Replaces the body of the app's own comment `commentId` below the ticket `key` (#920; the key since #1040: Jira addresses a comment
   * through its issue). Rejects like `commentOnTicket`; 404 when the comment is gone.
   */
  updateTicketComment?(
    scope: TicketScope,
    key: string,
    commentId: string,
    body: string,
    signal?: AbortSignal,
  ): Promise<void>;

  /** Adds and removes labels of a ticket (#844). Idempotent. Answers every label on the ticket afterwards. */
  changeTicketLabels?(
    scope: TicketScope,
    key: string,
    change: { add: readonly string[]; remove: readonly string[] },
    signal?: AbortSignal,
  ): Promise<{ labels: string[] }>;

  /**
   * Puts the ticket into the status named `status`. GitHub (#917): the column of the Project board `board` (projects_v2), adding the ticket
   * to the board when it is not on it. Jira (#1040): the transition to that status of the issue's workflow (`boardless`: no `board`).
   * What the board, the workflow or the ticket decide is an answer, not an error. Idempotent: a ticket that is in the status stays.
   */
  setTicketStatus?(
    scope: TicketScope,
    key: string,
    move: { board?: string; status: string },
    signal?: AbortSignal,
  ): Promise<
    | { kind: "moved"; status: string }
    | { kind: "board_not_found" }
    | { kind: "issue_not_found" }
    | { kind: "status_unknown"; available: string[] }
    /** The workflow has such a status, but no transition leads there from the ticket's current one (Jira, #1040): `reachable` are the ones that do. */
    | { kind: "status_unreachable"; reachable: string[] }
  >;

  /**
   * Only where the platform has tickets the app mirrors (#923): what a delivery says about the ticket mirror. Reads the payload and no
   * more; a delivery that is no news for the mirror is `ignored` with a reason for the log.
   */
  parseTrackerChange?(
    integration: Integration,
    request: Request,
  ): Promise<TrackerChangeResult>;

  /**
   * Only together with `parseTrackerChange`: one page of one phase of a full sync of a container's tickets (#923), read with a token of
   * its own that holds the read permissions of that phase and nothing else. Rejects when the platform cannot be asked; a board the app may
   * not read is `available: false`, never a failure.
   */
  readTrackerPage?(
    scope: TicketScope,
    step: TrackerPageStep,
    signal?: AbortSignal,
  ): Promise<TrackerPage>;

  /**
   * Only together with `parseTrackerChange`: the status the boards give a ticket now, by the platform's id of the ticket (#932): the status
   * on the first board that has one, or null. `boardId` (#937): only the item of the ticket on that board counts. `available: false` when
   * the app may not read boards. Rejects when the platform cannot be asked.
   */
  readBoardStatus?(
    scope: TicketScope,
    nodeId: string,
    boardId?: string,
    signal?: AbortSignal,
  ): Promise<{ available: boolean; status: string | null }>;

  /**
   * Only where tickets sit on a board (#922): the boards a project may take as its own, with the Status field of each and the names of
   * its options. A container whose boards the app may not read is `available: false`, never a failure.
   */
  listBoards?(
    scope: TicketScope,
    signal?: AbortSignal,
  ): Promise<{ available: boolean; boards: BoardInfo[] }>;

  /**
   * Only where a ticket's pull requests carry checks (the GitHub mirror): the state of the checks of a commit as the platform names it
   * (`success`, `failure`, `in_progress`, ...), or null when it has none.
   */
  readChecksState?(
    scope: TicketScope,
    headSha: string,
    signal?: AbortSignal,
  ): Promise<string | null>;
}

/**
 * What a ticket provider that is not GitHub fails with (#1040): a code the ticket actions translate to a step failure, and a short text
 * that holds nothing of the platform's answer (a message of Jira may name people and tickets).
 */
export const TICKET_PROVIDER_ERROR_CODES = [
  /** There is no such ticket (or comment) for the account the connection is made with. */
  "ticket_not_found",
  /** The platform refused the account: it may not see the ticket or write to it. */
  "ticket_forbidden",
  /** The connection of the workspace is broken: a person has to connect it again. */
  "ticket_connection_broken",
  /** The platform could not be reached or answered something unusable. */
  "ticket_unavailable",
  /** The platform refused what was asked (a label it does not take, a transition that needs a form). */
  "ticket_rejected",
] as const;
export type TicketProviderErrorCode =
  (typeof TICKET_PROVIDER_ERROR_CODES)[number];

export class TicketProviderError extends Error {
  readonly code: TicketProviderErrorCode;

  constructor(code: TicketProviderErrorCode, message: string) {
    super(message);
    this.name = "TicketProviderError";
    this.code = code;
  }
}

/** The provider a ticket source names. */
export type TicketProviderRegistry = {
  /** The provider of this name, or undefined when none is registered. */
  get(id: string): TicketProvider | undefined;
  /** The names of the registered providers. */
  ids(): string[];
};

export function createTicketProviderRegistry(
  providers: readonly TicketProvider[],
): TicketProviderRegistry {
  const byId = new Map<string, TicketProvider>();
  for (const provider of providers) {
    if (byId.has(provider.id))
      throw new Error(
        `Two ticket providers are registered as "${provider.id}".`,
      );
    byId.set(provider.id, provider);
  }
  return {
    get: (id) => byId.get(id),
    ids: () => [...byId.keys()],
  };
}

/** The key of a ticket the platform numbers (GitHub): the number as text. */
export const ticketKeyOfNumber = (number: number): string => String(number);

/** The number a key names where the platform numbers its tickets, or undefined for a key that is none. */
export function ticketNumberOfKey(key: string): number | undefined {
  if (!/^[1-9]\d{0,9}$/.test(key)) return undefined;
  return Number(key);
}

/**
 * Ticket providers a module that cannot be imported where the engine runs registers at the start of the process (#1040): the Jira provider
 * (`jira/shared.ts`) reaches the engine's ticket actions from every entry point (a route, the runner API, the sweep) without those modules
 * importing `jira` (an import cycle). Kept on `globalThis` under a symbol: the routes of a Next.js server are separate bundles of one process.
 */
const REGISTERED = Symbol.for("code-reviewer.registered-ticket-providers");

function registeredMap(): Map<string, TicketProvider> {
  const holder = globalThis as unknown as Record<symbol, unknown>;
  const found = holder[REGISTERED];
  if (found instanceof Map) return found as Map<string, TicketProvider>;
  const created = new Map<string, TicketProvider>();
  holder[REGISTERED] = created;
  return created;
}

/** Makes `provider` the ticket provider of its id for the whole process (a second registration of the id replaces the first). */
export function registerTicketProvider(provider: TicketProvider): void {
  registeredMap().set(provider.id, provider);
}

/** The provider registered under `id`, or undefined. */
export function registeredTicketProvider(
  id: string,
): TicketProvider | undefined {
  return registeredMap().get(id);
}
