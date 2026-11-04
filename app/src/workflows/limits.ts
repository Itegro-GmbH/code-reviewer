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
/** Workflow budget in USD when the document names none. */
export const BUDGET_DEFAULT_USD = 20;
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
/** How deep braces may nest in the default of a reference: `{{a.b | default {"k": {"j": 1}}}}` is two deep. */
export const DEFAULT_BRACE_DEPTH_MAX = 3;

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

/** Per workspace. */
export const WORKFLOWS_PER_WORKSPACE_MAX = 100;
export const VERSIONS_PER_WORKFLOW_MAX = 500;
