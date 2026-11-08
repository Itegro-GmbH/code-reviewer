// SPDX-License-Identifier: LicenseRef-Proprietary

// What the validator reports (#833): one issue per problem, with a JSON pointer to the place, a stable code, the cause in a
// sentence and, where a choice was wrong, the names that were available at that point. Callers branch on `code`, never on the
// message. The list is the same for `POST .../workflows/validate` and for a refused save.

import { ERRORS_COLLECT_MAX, NAMES_LISTED_MAX } from "./limits.ts";

/**
 * Codes the JSON Schema (`contracts/workflow.v1.json`, `contracts/result-schema.v1.json`) states too: the shape of the document.
 * `integration-tests/compatibility/workflow-contract.integration.test.ts` holds that a document is refused by the schema exactly when
 * one of these is reported.
 */
export const FORM_ISSUE_CODES = [
  /** A value of the wrong JSON type. */
  "wrong_type",
  /** A key the format does not have here. `available` names the keys that exist. */
  "unknown_field",
  /** A required key is absent. */
  "missing_field",
  /** The right type, a value the field does not take (a pattern, a range, a list of names, a length). */
  "invalid_value",
  /** A `kind` the format does not have. */
  "unknown_kind",
  /** A trigger `kind` the format does not have. */
  "unknown_trigger_kind",
  /** A connector the format does not have. */
  "unknown_connector",
  /** A number above what the format allows (a length, a count); or, checking a result, a value longer than its schema allows. */
  "limit_exceeded",
] as const;

/** Codes only the validator knows: they need the whole document or the resolver. */
export const SEMANTIC_ISSUE_CODES = [
  /** A node kind that is reserved in the format and not available in version 1. */
  "kind_not_supported",
  /** Two steps with one id. */
  "duplicate_id",
  /** The text of a `{{ }}` is not a reference, or a `{{` is never closed. */
  "template_syntax",
  /** A reference starts with a name that is no step. `available` names the steps in reach. */
  "reference_unknown_step",
  /** A reference names a step that comes later (or is the step itself). */
  "reference_to_later_step",
  /** The step exists and ran earlier, but not on every path to here (inside a branch, or in another branch). */
  "reference_not_in_scope",
  /** The step has no such field. `available` names its fields. */
  "reference_unknown_field",
  /** The field is not required in the result schema, so it can be missing; give a default or make it required. */
  "reference_optional_field",
  /** The profile may not push, so its steps yield no branch and no commits. */
  "reference_fact_unavailable",
  /** The referenced value does not fit where it is used. */
  "reference_type_mismatch",
  /** The default of a reference does not fit the referenced value. */
  "default_type_mismatch",
  /** `previous.` outside a loop body. */
  "previous_outside_loop",
  /** `previous.` where round one has no value and no default is given. */
  "previous_without_default",
  /** `previous.<id>` names no step of the loop body that always runs. */
  "previous_unknown_step",
  /** A comparison of things that cannot be compared, or an operand of the wrong type. */
  "condition_operand_type",
  /** A text compared with an enum field that can never hold it. */
  "condition_value_not_in_enum",
  /** `instruction.next` in a step outside a loop. */
  "instruction_next_outside_loop",
  /** `session.continue` names no agent step that ran before on every path. */
  "session_target_invalid",
  /** The profile does not exist (`available` names those that do). */
  "profile_unknown",
  /** The profile was archived (`available` names those that can be run). */
  "profile_archived",
  /** The profile exists, that version does not. */
  "profile_version_unknown",
  /** No environment of that name in the workspace. */
  "environment_unknown",
  /** The step names an environment other than the one of its profile (#919): a profile says where it works. `available` names the profile's. */
  "environment_mismatch",
  /** The profile names no environment (a version saved before #919) and the step names none either (#919). `available` names the environments. */
  "environment_required",
  /** A step runs a profile with a managed model (the platform's key) in a runner environment; a runner works with the owner's own key (#854). */
  "runner_needs_own_key",
  /** A step runs a profile whose harness is not OpenCode in an environment that is not a runner's (#854). */
  "harness_needs_runner",
  /** The result of the step names a field the platform fills in itself. */
  "result_field_reserved",
  /** The run has no repository: a manual trigger must declare the input `repo` (a required text). */
  "repo_required",
  /** An input that decides a target (an issue, a branch, a label, the environment) holds a value that is not a literal or one reference to the trigger or to the branch of an agent step. */
  "target_from_untrusted_value",
  /** A step adds the label that starts the workflow, which would start it again. */
  "label_retriggers_workflow",
  /** Two `ticket.labeled` triggers wait for the same label (the JSON Schema cannot say it). */
  "duplicate_trigger_label",
  /** A `required` entry of a result schema that names no property (the schema language cannot say it). */
  "required_field_unknown",
  /** A step of `onFailure` that is not a comment, a label change or an `if` over them: no agent, no loop, no pull request runs after a failure. */
  "on_failure_step_not_allowed",
  /** More steps than a document may hold. */
  "too_many_steps",
  /** `if` and `loop` nested deeper than allowed, or a result schema with more levels than allowed. */
  "nesting_too_deep",
  /** A result schema with more fields in all than allowed. */
  "result_schema_too_large",
  /** The budget is above what the operator allows. */
  "budget_above_maximum",
] as const;

export const ISSUE_CODES = [
  ...FORM_ISSUE_CODES,
  ...SEMANTIC_ISSUE_CODES,
] as const;
export type IssueCode = (typeof ISSUE_CODES)[number];
export type FormIssueCode = (typeof FORM_ISSUE_CODES)[number];

const FORM_SET: ReadonlySet<string> = new Set(FORM_ISSUE_CODES);
export function isFormIssue(issue: { code: string }): boolean {
  return FORM_SET.has(issue.code);
}

export type Issue = {
  /** JSON pointer into the document that was checked ("" is the document itself). */
  path: string;
  code: IssueCode;
  /** The cause, in a sentence an AI can act on. Never the text of a user value longer than a name. */
  message: string;
  /** The names that were available at that point, when the problem is a wrong name. */
  available?: string[];
};

/** The names for `available`: the first `NAMES_LISTED_MAX`, each cut to the length of a name. */
function listed(names: readonly string[]): string[] {
  return names.slice(0, NAMES_LISTED_MAX).map(clip);
}

export function issue(
  path: string,
  code: IssueCode,
  message: string,
  available?: readonly string[],
): Issue {
  return available === undefined
    ? { path, code, message }
    : { path, code, message, available: listed(available) };
}

/**
 * Collects the problems of one check, and says when it has enough: the check runs in document order and stops once it holds more
 * than an answer lists (`ERRORS_COLLECT_MAX`), because everything after that is work for an answer that cannot show it. A document of
 * 200 KB can hold hundreds of thousands of problems; each one costs a message.
 */
export class IssueSink {
  readonly issues: Issue[] = [];
  /** The cap was reached: there may be more problems than were collected. */
  full = false;

  readonly report = (found: Issue): void => {
    if (this.full) return;
    this.issues.push(found);
    if (this.issues.length >= ERRORS_COLLECT_MAX) this.full = true;
  };

  readonly halted = (): boolean => this.full;
}

/** Longest piece of a user's text a message, a path or a list of names repeats: the length of a name. */
export const ECHO_MAX_LENGTH = 64;

/** A user's text for a message, cut to the length of a name, in quotes: `'abc…'`. A message never repeats a whole value. */
export function shown(text: string): string {
  return `'${clip(text)}'`;
}

/** A user's text cut to the length of a name, marked when it was cut (no quotes: for lists of names). */
export function clip(text: string): string {
  const characters = Array.from(text.slice(0, ECHO_MAX_LENGTH * 2));
  return characters.length > ECHO_MAX_LENGTH ||
    text.length > ECHO_MAX_LENGTH * 2
    ? `${characters.slice(0, ECHO_MAX_LENGTH).join("")}…`
    : text;
}

/**
 * A pointer segment: `~` and `/` are escaped (RFC 6901). A segment longer than a name is cut and marked with an ellipsis: the
 * pointer of such a key points near it, not at it.
 */
export function pointer(
  base: string,
  ...segments: (string | number)[]
): string {
  return segments.reduce<string>(
    (path, segment) =>
      `${path}/${clip(String(segment)).replaceAll("~", "~0").replaceAll("/", "~1")}`,
    base,
  );
}

function segmentsOf(path: string): string[] {
  return path === "" ? [] : path.slice(1).split("/");
}

/** Pointers in document order: `/steps/2` before `/steps/10`. */
export function comparePaths(a: string, b: string): number {
  const left = segmentsOf(a);
  const right = segmentsOf(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const x = left[i] as string;
    const y = right[i] as string;
    if (x === y) continue;
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
    if (numeric) return Number(x) - Number(y);
    return x < y ? -1 : 1;
  }
  return left.length - right.length;
}

/** All issues, sorted by path, then by code, then by message: the same document always gives the same list. */
export function sortIssues(issues: readonly Issue[]): Issue[] {
  return [...issues].sort(
    (a, b) =>
      comparePaths(a.path, b.path) ||
      (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) ||
      (a.message < b.message ? -1 : a.message > b.message ? 1 : 0),
  );
}

/**
 * Names as a list for a message: `'a', 'b'`. At most `NAMES_LISTED_MAX` are named; the rest is counted (`and 12 more`). `total` is how
 * many there are when `names` is only the first of them; `"more"` when it is not known (the list was cut after one name too many).
 */
export function listNames(
  names: readonly string[],
  total: number | "more" = names.length,
): string {
  if (total === 0 || names.length === 0) return "none";
  const named = names.slice(0, NAMES_LISTED_MAX).map(shown).join(", ");
  if (total === "more")
    return names.length > NAMES_LISTED_MAX ? `${named} and more` : named;
  const more = total - Math.min(names.length, NAMES_LISTED_MAX);
  return more > 0 ? `${named} and ${more} more` : named;
}
