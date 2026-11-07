// SPDX-License-Identifier: LicenseRef-Proprietary

// The bounds of workflow format v1 (#833). A typed copy of what `contracts/workflow.v1.json` and `contracts/result-schema.v1.json`
// state as numbers; `integration-tests/compatibility/workflow-contract.integration.test.ts` holds the two together.

/** Rounds a loop may be given at most. `maxRounds` is required and cannot be raised above this. */
export const LOOP_ROUNDS_MAX = 10;
/** Steps in one document, counted through every branch and loop body. */
export const STEPS_MAX = 50;
/** How deep `if` and `loop` may nest inside each other. */
export const NESTING_DEPTH_MAX = 4;
/** How deep `loop` may nest inside `loop`. */
export const LOOP_NESTING_MAX = 2;
/** Triggers one workflow may have (#916). */
export const TRIGGERS_MAX = 10;
/** Workflow budget in USD when the document names none. */
export const BUDGET_DEFAULT_USD = 20;
/**
 * The time one agent turn of a workflow may run, in minutes (#918): the bounds of `turnTimeLimitMinutes` and what a document without it gets.
 * The maximum is the 3600 seconds the Dispatcher gives the VM of an Implementer turn: more would be cut without the final push.
 */
export const TURN_TIME_LIMIT_MINUTES_MIN = 15;
export const TURN_TIME_LIMIT_MINUTES_MAX = 60;
export const TURN_TIME_LIMIT_MINUTES_DEFAULT = 60;
/** What the operator allows a workflow to spend, until the operator can set it (the service takes it as a parameter). */
export const BUDGET_OPERATOR_MAX_USD = 100;
/** A serialized document may not be larger than this (UTF-8 bytes). */
export const DOCUMENT_MAX_BYTES = 256 * 1024;
export const NAME_MAX_LENGTH = 100;
/** The label that starts a workflow. */
export const LABEL_MAX_LENGTH = 100;
export const ID_MAX_LENGTH = 64;
export const DESCRIPTION_MAX_LENGTH = 1000;
export const TEMPLATE_MAX_LENGTH = 20_000;
export const CONDITION_DEPTH_MAX = 4;
/** The most problems one answer lists; a document with more is `truncated`. */
export const ERRORS_MAX = 200;
/** The check stops once it holds this many problems: a few more than the answer lists, so the cut is not made on the first ones found. */
export const ERRORS_COLLECT_MAX = ERRORS_MAX + 50;
/** The most names a list in an answer holds (`available`, and the names a message lists); the message says how many more there are. */
export const NAMES_LISTED_MAX = 20;
/** How deep braces may nest in the default of a reference: `{{a.b | default {"k": {"j": 1}}}}` is two deep. */
export const DEFAULT_BRACE_DEPTH_MAX = 3;
/** The largest issue number a workflow may name (a signed 32-bit integer, what GitHub's numbers fit in for a long time to come). */
export const ISSUE_NUMBER_MAX = 2 ** 31 - 1;

/** Result schemas (`contracts/result-schema.v1.json`). */
export const RESULT_DEPTH_MAX = 4;
export const RESULT_PROPERTIES_MAX = 50;
export const RESULT_PROPERTIES_TOTAL_MAX = 100;
export const RESULT_ENUM_VALUES_MAX = 50;
export const RESULT_ENUM_VALUE_MAX_LENGTH = 200;
export const RESULT_DESCRIPTION_MAX_LENGTH = 500;
export const RESULT_FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** What a string may hold when the schema sets no `maxLength`, and the most a schema may allow. */
export const STRING_MAX_LENGTH_DEFAULT = 10_000;
export const STRING_MAX_LENGTH_LIMIT = 100_000;
/** What a list may hold when the schema sets no `maxItems`, and the most a schema may allow. */
export const LIST_MAX_ITEMS_DEFAULT = 100;
export const LIST_MAX_ITEMS_LIMIT = 1000;

/** A workflow id as the routes take it (`/workflows/<id>`); longer is "not found". Its own bound, not that of a step id. */
export const WORKFLOW_ID_MAX_LENGTH = 64;

/** Per workspace. */
export const WORKFLOWS_PER_WORKSPACE_MAX = 100;
/**
 * Per workspace: archived workflows stay (their versions are history), but not without bound. At the maximum an archive is refused
 * (`WORKFLOW_ARCHIVE_LIMIT_REACHED`), so archiving and creating again cannot grow the rows for ever; creating and saving go on.
 */
export const ARCHIVED_WORKFLOWS_PER_WORKSPACE_MAX = 1000;
export const VERSIONS_PER_WORKFLOW_MAX = 500;
