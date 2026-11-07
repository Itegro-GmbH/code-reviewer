// SPDX-License-Identifier: LicenseRef-Proprietary

// The connectors an action node can name in format v1 (#833): per connector the inputs it takes and the output it yields, as value
// types. Nothing here executes anything; the engine (M3) runs the action and the validator only holds the workflow to these
// shapes. `contracts/workflow.v1.json` lists the same connectors and inputs; `integration-tests/compatibility/
// workflow-contract.integration.test.ts` holds the two together.
//
// A run works on ONE repository, the one of its trigger (`trigger.repo` of an issue trigger, the input `repo` of a manual one), so an
// action names none. The inputs that decide a TARGET (which issue, which branches, which labels) are marked: they take a literal or
// one reference to a value the platform or the caller vouches for, never a value an agent reported and never the free text of whoever
// opened the issue (`check-values.ts`).
import {
  BOOLEAN,
  INTEGER,
  STRING,
  listOf,
  objectOf,
  type ObjectType,
  type ValueType,
} from "./value-type.ts";

/**
 * Where a reference in a target input may start, one value each:
 * - `input`: `{{trigger.input.…}}`, what the caller of a manual trigger hands in (its type is the schema's);
 * - `issue`: `{{trigger.issue}}` or `{{trigger.issue.number}}`, the issue that started the run (not its title, body or labels: whoever
 *   opened the issue wrote those);
 * - `ticket` (#916): `{{trigger.ticket}}` or `{{trigger.ticket.number}}`, the ticket the run is about, the same way;
 * - `defaultBranch`: `{{trigger.repo.defaultBranch}}` or `{{trigger.ticket.repo.defaultBranch}}`;
 * - `branch`: `{{<agent step>.branch}}`, the branch the platform made;
 * - `pullRequest` (#917): `{{<action>.number}}` of a `pullRequest.open` action, the pull request the platform opened.
 *
 * An input with no root at all (`target: []`) takes a literal only: a name the platform looks up on the provider (a board, a status).
 */
export type TargetRoot =
  "input" | "issue" | "ticket" | "defaultBranch" | "branch" | "pullRequest";

export type InputSpec = {
  type: ValueType;
  required: boolean;
  /** Set on the inputs that decide a target: the roots a reference in it may start with. A literal is always fine. */
  target?: readonly TargetRoot[];
};

export type ConnectorSpec = {
  name: string;
  description: string;
  /** The inputs by name. Anything else on the node is refused. */
  inputs: Readonly<Record<string, InputSpec>>;
  /** What later nodes can refer to: `{{<action id>.<field>}}`. */
  output: ObjectType;
  /** At least one of these inputs must be given. */
  atLeastOneOf?: readonly string[];
};

/** An issue is given as a positive whole number or as a reference to the issue object of the trigger or to a whole number. */
const ISSUE: ValueType = {
  kind: "oneOf",
  options: [objectOf({ number: INTEGER }), INTEGER],
};

const ISSUE_ROOTS: readonly TargetRoot[] = ["issue", "ticket", "input"];
const LABEL_ROOTS: readonly TargetRoot[] = ["input"];
/** A pull request is given as its number: a positive whole number, the number a `pullRequest.open` action yielded, or a manual input. */
const PULL_REQUEST_ROOTS: readonly TargetRoot[] = ["pullRequest", "input"];
export const GITHUB_PULL_REQUEST_OPEN: ConnectorSpec = {
  name: "github.pullRequest.open",
  description: "Opens a pull request from a branch.",
  inputs: {
    head: { type: STRING, required: true, target: ["branch"] },
    base: {
      type: STRING,
      required: false,
      target: ["defaultBranch", "input"],
    },
    title: { type: STRING, required: true },
    body: { type: STRING, required: false },
    draft: { type: BOOLEAN, required: false },
  },
  output: objectOf({ number: INTEGER, url: STRING, existing: BOOLEAN }),
};

export const GITHUB_ISSUE_COMMENT: ConnectorSpec = {
  name: "github.issue.comment",
  description: "Writes a comment on an issue or pull request.",
  inputs: {
    issue: { type: ISSUE, required: true, target: ISSUE_ROOTS },
    body: { type: STRING, required: true },
  },
  output: objectOf({ url: STRING, existing: BOOLEAN }),
};

export const GITHUB_ISSUE_LABELS: ConnectorSpec = {
  name: "github.issue.labels",
  description: "Adds and removes labels on an issue or pull request.",
  inputs: {
    issue: { type: ISSUE, required: true, target: ISSUE_ROOTS },
    add: { type: listOf(STRING), required: false, target: LABEL_ROOTS },
    remove: { type: listOf(STRING), required: false, target: LABEL_ROOTS },
  },
  output: objectOf({ labels: listOf(STRING) }),
  atLeastOneOf: ["add", "remove"],
};

/**
 * The provider-neutral names of the two actions on a ticket (#916): the same inputs with `ticket` for `issue`. The engine does them
 * through the provider of the ticket's repository, which is GitHub so far: `ticket.comment` is `github.issue.comment`, `ticket.labels`
 * is `github.issue.labels`.
 */
export const TICKET_COMMENT: ConnectorSpec = {
  name: "ticket.comment",
  description: "Writes a comment on a ticket.",
  inputs: {
    ticket: { type: ISSUE, required: true, target: ISSUE_ROOTS },
    body: { type: STRING, required: true },
  },
  output: GITHUB_ISSUE_COMMENT.output,
};

export const TICKET_LABELS: ConnectorSpec = {
  name: "ticket.labels",
  description: "Adds and removes labels on a ticket.",
  inputs: {
    ticket: { type: ISSUE, required: true, target: ISSUE_ROOTS },
    add: { type: listOf(STRING), required: false, target: LABEL_ROOTS },
    remove: { type: listOf(STRING), required: false, target: LABEL_ROOTS },
  },
  output: GITHUB_ISSUE_LABELS.output,
  atLeastOneOf: ["add", "remove"],
};

/** What `ticket.requestReview` asks: the members of the project (#917), or these GitHub logins. */
export const PROJECT_MEMBERS = "project members";

/**
 * The provider-neutral names of the actions on a pull request and of the two that only a board and a review have (#917). The provider
 * comes from the repository of the run: GitHub so far.
 * - `pullRequest.open` is `github.pullRequest.open` and `pullRequest.comment` writes a comment below a pull request;
 * - `ticket.setStatus` puts a ticket into a column of the board of the project the lane belongs to (#922: the GitHub Project, projects_v2,
 *   its ticket source names); `board` (the number of a Project or its node id) is an override that stays accepted. `status` is a literal
 *   option name of that board and the engine looks it up when it runs (`board_status_unknown` names the options there are);
 * - `ticket.requestReview` asks for a review of a pull request, from the members of the project or from logins.
 */
export const PULL_REQUEST_OPEN: ConnectorSpec = {
  ...GITHUB_PULL_REQUEST_OPEN,
  name: "pullRequest.open",
};

export const PULL_REQUEST_COMMENT: ConnectorSpec = {
  name: "pullRequest.comment",
  description: "Writes a comment on a pull request.",
  inputs: {
    pullRequest: { type: INTEGER, required: true, target: PULL_REQUEST_ROOTS },
    body: { type: STRING, required: true },
  },
  output: GITHUB_ISSUE_COMMENT.output,
};

export const TICKET_SET_STATUS: ConnectorSpec = {
  name: "ticket.setStatus",
  description: "Moves a ticket to a column of the board of its project.",
  inputs: {
    ticket: { type: ISSUE, required: true, target: ISSUE_ROOTS },
    board: { type: STRING, required: false, target: [] },
    status: { type: STRING, required: true, target: [] },
  },
  output: objectOf({ status: STRING }),
};

export const TICKET_REQUEST_REVIEW: ConnectorSpec = {
  name: "ticket.requestReview",
  description: "Asks for a review of a pull request.",
  inputs: {
    pullRequest: { type: INTEGER, required: true, target: PULL_REQUEST_ROOTS },
    reviewers: {
      type: { kind: "oneOf", options: [STRING, listOf(STRING)] },
      required: true,
      target: LABEL_ROOTS,
    },
  },
  output: objectOf({ requested: listOf(STRING) }),
};

/** The action a `pullRequest` target may come from: the one that opens a pull request, under either name. */
export const PULL_REQUEST_OPENING_CONNECTORS: readonly string[] = [
  GITHUB_PULL_REQUEST_OPEN.name,
  PULL_REQUEST_OPEN.name,
];

export const BUILT_IN_CONNECTORS: readonly ConnectorSpec[] = [
  GITHUB_ISSUE_COMMENT,
  GITHUB_ISSUE_LABELS,
  GITHUB_PULL_REQUEST_OPEN,
  PULL_REQUEST_COMMENT,
  PULL_REQUEST_OPEN,
  TICKET_COMMENT,
  TICKET_LABELS,
  TICKET_REQUEST_REVIEW,
  TICKET_SET_STATUS,
];
