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
 * - `defaultBranch`: `{{trigger.repo.defaultBranch}}`;
 * - `branch`: `{{<agent step>.branch}}`, the branch the platform made.
 */
export type TargetRoot = "input" | "issue" | "defaultBranch" | "branch";

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

const ISSUE_ROOTS: readonly TargetRoot[] = ["issue", "input"];
const LABEL_ROOTS: readonly TargetRoot[] = ["input"];
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
  output: objectOf({ number: INTEGER, url: STRING }),
};

export const GITHUB_ISSUE_COMMENT: ConnectorSpec = {
  name: "github.issue.comment",
  description: "Writes a comment on an issue or pull request.",
  inputs: {
    issue: { type: ISSUE, required: true, target: ISSUE_ROOTS },
    body: { type: STRING, required: true },
  },
  output: objectOf({ url: STRING }),
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

export const BUILT_IN_CONNECTORS: readonly ConnectorSpec[] = [
  GITHUB_ISSUE_COMMENT,
  GITHUB_ISSUE_LABELS,
  GITHUB_PULL_REQUEST_OPEN,
];
