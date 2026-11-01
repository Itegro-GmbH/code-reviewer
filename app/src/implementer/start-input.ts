// SPDX-License-Identifier: LicenseRef-Proprietary

// Checks the body that starts an Implementer task (#755). The values come from the browser, so nothing here trusts a type: every
// field is looked at as `unknown`, and a refusal names the field and a code that never holds the value. The instruction is kept
// exactly as written.
import type { ModelChoice } from "../db/implementer-model-choice.ts";
import { BRANCH_NAME, CLIENT_REQUEST_ID } from "../jobs/job-input.ts";
import { REVIEW_SETTING_LIMITS } from "../review-settings/settings.ts";
import { checkBranchName } from "./branch-name.ts";
import type { ImplementerIssue } from "./errors.ts";

/** The instruction the agent is given: at most this many characters (the same bound as the form's text area). */
export const INSTRUCTION_MAX_LENGTH = 20_000;
const ID_MAX_LENGTH = 128;
const MODEL_FIELD_MAX_LENGTH = 200;

export type StartInput = {
  repositoryId: string;
  baseBranch: string;
  branch: string;
  instruction: string;
  model: ModelChoice;
  /** The customer's limit for the turn in whole US cents; null when none was asked for. */
  costLimitCents: number | null;
  clientRequestId: string;
};

export type StartInputCheck =
  { ok: true; value: StartInput } | { ok: false; issues: ImplementerIssue[] };

// Control characters other than tab, line feed and carriage return; a lone surrogate half is not text at all.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** Every control character, tab and line breaks included: an id or a model name is one line. */
const CONTROL_OR_NEWLINE = /[\u0000-\u001f\u007f]/;

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** The model choice if the value is exactly one of the two shapes of a turn's `model_choice`. */
function readModel(value: unknown): ModelChoice | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  // No control character (a NUL is refused by Postgres, and these fields reach queries) and a bounded length.
  const fits = (...fields: unknown[]) =>
    fields.every(
      (field) =>
        isText(field) &&
        field.length <= MODEL_FIELD_MAX_LENGTH &&
        !CONTROL_OR_NEWLINE.test(field),
    );
  if (keys === "entryId" && fits(record.entryId))
    return { entryId: record.entryId as string };
  if (keys === "model,provider" && fits(record.provider, record.model))
    return {
      provider: record.provider as string,
      model: record.model as string,
    };
  return undefined;
}

export function validateStartInput(body: unknown): StartInputCheck {
  const fields: Record<string, unknown> =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const issues: ImplementerIssue[] = [];
  const refuse = (
    field: ImplementerIssue["field"],
    code: ImplementerIssue["code"],
  ) => void issues.push({ field, code });

  const repositoryId = fields.repositoryId;
  if (
    repositoryId === undefined ||
    repositoryId === "" ||
    (typeof repositoryId === "string" && repositoryId.trim() === "")
  )
    refuse("repositoryId", "required");
  else if (
    typeof repositoryId !== "string" ||
    repositoryId.length > ID_MAX_LENGTH
  )
    refuse("repositoryId", "invalid");

  const baseBranch = fields.baseBranch;
  if (baseBranch === undefined || baseBranch === "")
    refuse("baseBranch", "required");
  // The base branch exists on the platform or the submit is refused; here it only has to be a name the queue can hold.
  else if (typeof baseBranch !== "string" || !BRANCH_NAME.test(baseBranch))
    refuse("baseBranch", "invalid");

  const branch = fields.branch;
  if (branch === undefined || branch === "") refuse("branch", "required");
  else if (typeof branch !== "string") refuse("branch", "invalid");
  else {
    const checked = checkBranchName(
      branch,
      typeof baseBranch === "string" ? baseBranch : "",
    );
    if (!checked.ok)
      refuse("branch", checked.issue === "empty" ? "required" : checked.issue);
  }

  const instruction = fields.instruction;
  if (instruction === undefined || instruction === null)
    refuse("instruction", "required");
  else if (typeof instruction !== "string") refuse("instruction", "invalid");
  else if (instruction.trim() === "") refuse("instruction", "required");
  else if (instruction.length > INSTRUCTION_MAX_LENGTH)
    refuse("instruction", "too_long");
  else if (CONTROL.test(instruction) || LONE_SURROGATE.test(instruction))
    refuse("instruction", "invalid");

  const model = readModel(fields.model);
  if (fields.model === undefined || fields.model === null)
    refuse("model", "required");
  else if (model === undefined) refuse("model", "invalid");

  const cost = fields.costLimitCents ?? null;
  if (
    cost !== null &&
    (typeof cost !== "number" ||
      !Number.isSafeInteger(cost) ||
      cost < REVIEW_SETTING_LIMITS.maxCostCents.min ||
      cost > REVIEW_SETTING_LIMITS.maxCostCents.max)
  )
    refuse("costLimitCents", "invalid");

  const requestId = fields.clientRequestId;
  if (requestId === undefined || requestId === "")
    refuse("clientRequestId", "required");
  else if (typeof requestId !== "string") refuse("clientRequestId", "invalid");
  else if (requestId.length > 200) refuse("clientRequestId", "too_long");
  else if (!CLIENT_REQUEST_ID.test(requestId))
    refuse("clientRequestId", "invalid");

  if (issues.length > 0) return { ok: false, issues };
  // The checks above narrowed the fields; the casts only restate what they proved.
  return {
    ok: true,
    value: {
      repositoryId: repositoryId as string,
      baseBranch: baseBranch as string,
      branch: branch as string,
      instruction: instruction as string,
      model: model as ModelChoice,
      costLimitCents: cost as number | null,
      clientRequestId: requestId as string,
    },
  };
}
