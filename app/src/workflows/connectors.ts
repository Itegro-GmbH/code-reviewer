// SPDX-License-Identifier: LicenseRef-Proprietary

// The connectors an action node can name in format v1 (#833): per connector the inputs it takes and the output it yields, as value
// types. Nothing here executes anything; the engine (M3) runs the action and the validator only holds the workflow to these
// shapes. `contracts/workflow.v1.json` lists the same connectors and inputs; `schema-agreement.test.ts` holds the two together.
import {
  BOOLEAN,
  NUMBER,
  STRING,
  listOf,
  objectOf,
  type ObjectType,
  type ValueType,
} from "./value-type.ts";

export type InputSpec = { type: ValueType; required: boolean };

export type ConnectorSpec = {
  name: string;
  description: string;
  /** The inputs by name. Anything else on the node is refused. */
  inputs: Readonly<Record<string, InputSpec>>;
  /** What later nodes can refer to: `{{<action id>.<field>}}`. */
  output: ObjectType;
  /** The action works on a repository: `repo` is optional only where the trigger names one (`trigger.repo`). */
  needsRepo: boolean;
  /** At least one of these inputs must be given. */
  atLeastOneOf?: readonly string[];
};

/** An issue is given as the issue object of the trigger or as its number. */
const ISSUE: ValueType = {
  kind: "oneOf",
  options: [objectOf({ number: NUMBER }), NUMBER],
};

const REPO: InputSpec = { type: STRING, required: false };

export const GITHUB_PULL_REQUEST_OPEN: ConnectorSpec = {
  name: "github.pullRequest.open",
  description: "Opens a pull request from a branch.",
  needsRepo: true,
  inputs: {
    repo: REPO,
    head: { type: STRING, required: true },
    base: { type: STRING, required: false },
    title: { type: STRING, required: true },
    body: { type: STRING, required: false },
    draft: { type: BOOLEAN, required: false },
  },
  output: objectOf({ number: NUMBER, url: STRING }),
};

export const GITHUB_ISSUE_COMMENT: ConnectorSpec = {
  name: "github.issue.comment",
  description: "Writes a comment on an issue or pull request.",
  needsRepo: true,
  inputs: {
    repo: REPO,
    issue: { type: ISSUE, required: true },
    body: { type: STRING, required: true },
  },
  output: objectOf({ url: STRING }),
};

export const GITHUB_ISSUE_LABELS: ConnectorSpec = {
  name: "github.issue.labels",
  description: "Adds and removes labels on an issue or pull request.",
  needsRepo: true,
  inputs: {
    repo: REPO,
    issue: { type: ISSUE, required: true },
    add: { type: listOf(STRING), required: false },
    remove: { type: listOf(STRING), required: false },
  },
  output: objectOf({ labels: listOf(STRING) }),
  atLeastOneOf: ["add", "remove"],
};

export const BUILT_IN_CONNECTORS: readonly ConnectorSpec[] = [
  GITHUB_ISSUE_COMMENT,
  GITHUB_ISSUE_LABELS,
  GITHUB_PULL_REQUEST_OPEN,
];
