// SPDX-License-Identifier: LicenseRef-Proprietary

// The bounds of the workflow engine (#844).

/** The input of a manual trigger as JSON text, the bound of the column. */
export const TRIGGER_INPUT_MAX_CHARS = 64 * 1024;
/** The longest value that is put into a text (an instruction, a comment) as it is; a longer one is cut and says so. */
export const TEMPLATE_VALUE_MAX_CHARS = 10_000;
/** The longest text a step may build in all, for a target that sets no bound of its own. */
export const TEMPLATE_TEXT_MAX_CHARS = 20_000;
/** Money in the unit of the tables: millionths of a US dollar. */
export const MICRO_USD_PER_USD = 1_000_000;
export const MICRO_USD_PER_CENT = 10_000;
/** The most a column of micro dollars holds (`integer`); a budget and a spend are held below it. */
export const MICRO_USD_COLUMN_MAX = 2_000_000_000;
/** The runs of one workflow a list answers. */
export const RUNS_LISTED_MAX = 50;
/** A step that was claimed and has no job after this long was not finished by whoever claimed it. */
export const STEP_STALE_MS = 2 * 60 * 1000;
/**
 * The most a connector may take for one call (#844): well under `STEP_STALE_MS`, so that a step still being worked on is never taken
 * for abandoned and run a second time while its action is still running. Every connector keeps to it (`docs/workflows.md`).
 */
export const ACTION_TIMEOUT_MS = 60 * 1000;
/** An agent step that has no job this long after it was written is given up (`agent_start_failed`). */
export const STEP_GIVE_UP_MS = 60 * 60 * 1000;
/** The sweep looks at a run that nobody touched for this long. */
export const RUN_QUIET_MS = 60 * 1000;
/** The most runs one sweep works through. */
export const SWEEP_RUNS_MAX = 25;
/** The most moves one call makes for one run: every step is written once and ended once, plus one more look. */
export const MOVES_PER_CALL_MAX = 200;
/** Words of an error message kept with a step. */
export const ERROR_MESSAGE_MAX_CHARS = 1000;
/** The message of a failure that the steps of `onFailure` read (`{{failure.message}}`, #902): short, because it goes into a comment. */
export const FAILURE_MESSAGE_MAX_CHARS = 300;
/** A pull request title of an action: GitHub accepts 256 characters; a longer one is cut. */
export const ACTION_TITLE_MAX_CHARS = 256;
/** The text of a comment or a pull request description of an action: GitHub accepts 65 536; a longer text is cut and says so. */
export const ACTION_BODY_MAX_CHARS = 60_000;
/** A label name: GitHub accepts 50 characters. */
export const ACTION_LABEL_MAX_CHARS = 50;
/** The most labels one action adds or removes. */
export const ACTION_LABELS_MAX = 20;
/** A branch name an action is given (a Git ref component is at most 255 bytes). */
export const ACTION_BRANCH_MAX_CHARS = 255;
/**
 * GitHub's reason for a refused action as the step reports it (#913), counted after the text is defused (defusing makes it longer, so
 * the cut comes last). The generic sentence in front of it and this bound keep the whole message under `FAILURE_MESSAGE_MAX_CHARS`,
 * which the steps of `onFailure` read.
 */
export const GITHUB_REASON_MAX_CHARS = 150;

/** The issue a label hands to a run (#845) is stored bounded: whoever opened the issue chose its words. */
export const ISSUE_TITLE_MAX_CHARS = 256;
/**
 * The body is held below what one value of a text may be (`TEMPLATE_VALUE_MAX_CHARS`), so that a longer body is cut here, once, and says
 * so. The instruction of an agent step is at most `INSTRUCTION_MAX_LENGTH` (20 000) characters: with the title (256), the labels
 * (`ISSUE_LABELS_MAX` of `ISSUE_LABEL_MAX_CHARS`, 1 000 at most) and this body (8 000) an issue takes at most about 9 300 of them, and
 * the rest is the workflow's own text, however it places the three.
 */
export const ISSUE_BODY_MAX_CHARS = 8_000;
export const ISSUE_URL_MAX_CHARS = 500;
export const ISSUE_LABELS_MAX = 20;
/** A label name: GitHub accepts 50 characters. */
export const ISSUE_LABEL_MAX_CHARS = 50;
/** A GitHub login is at most 39 characters; a bot's ends in `[bot]`. */
export const ACTOR_LOGIN_MAX_CHARS = 100;
/** The logins a ticket may list as assigned, and the length of one; GitHub allows ten assignees and a login of 39 characters. */
export const TICKET_ASSIGNEES_MAX = 20;
export const TICKET_ASSIGNEE_MAX_CHARS = 100;
/** The kind of a ticket (`Bug`). */
export const TICKET_TYPE_MAX_CHARS = 100;
/** The default branch of a repository as a run stores it (a Git ref component is at most 255 bytes). */
export const BRANCH_MAX_CHARS = 255;
