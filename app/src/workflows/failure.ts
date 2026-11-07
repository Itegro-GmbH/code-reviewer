// SPDX-License-Identifier: LicenseRef-Proprietary

// The failure a run ended with, as the steps of `onFailure` read it (#902): `{{failure.status}}`, `.stepId`, `.code` and `.message`.
// They run after a run ended `failed` or `cancelled` and may only comment on an issue and change its labels, so the connectors they
// may name are listed here. The engine (src/workflow-runs/) fills the facts in; the validator only knows their types.
import {
  GITHUB_ISSUE_COMMENT,
  GITHUB_ISSUE_LABELS,
  TICKET_COMMENT,
  TICKET_LABELS,
} from "./connectors.ts";
import { enumOf, objectOf, STRING, type ObjectType } from "./value-type.ts";

/** What a reference to the failure starts with. Taken as an id by the steps of `onFailure`, so none of them can be called like it. */
export const FAILURE_ID = "failure";

/** How a run ended when `onFailure` runs: its final status stays this. */
export const FAILURE_STATUSES = ["failed", "cancelled"] as const;
export type FailureStatus = (typeof FAILURE_STATUSES)[number];

/**
 * The connectors an `onFailure` step may use: no agent runs after a failure, and no pull request opens from work that failed. They cost
 * nothing, so they also run when the budget is used up.
 */
export const ON_FAILURE_CONNECTORS: readonly string[] = [
  GITHUB_ISSUE_COMMENT.name,
  GITHUB_ISSUE_LABELS.name,
  TICKET_COMMENT.name,
  TICKET_LABELS.name,
];

/** The node kinds an `onFailure` list may hold: actions, and `if` over the facts of the failure. */
export const ON_FAILURE_KINDS: readonly string[] = ["action", "if"];

/** What `{{failure.*}}` holds. */
export const FAILURE_TYPE: ObjectType = objectOf({
  status: enumOf(...FAILURE_STATUSES),
  stepId: STRING,
  code: STRING,
  message: STRING,
});
