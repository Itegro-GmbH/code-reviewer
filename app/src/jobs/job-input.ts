// SPDX-License-Identifier: LicenseRef-Proprietary

// Checks what `enqueue` is given before anything is written. The values come from webhooks and
// comments, so nothing here trusts a type annotation: every field is looked at as `unknown`.
import { REVIEW_COMMANDS, type ReviewCommand } from "../integrations/types.ts";
import {
  PROJECT_REVIEW_KINDS,
  type ProjectReviewKind,
} from "../job-kind/job-kind.ts";
import type { JobFieldError } from "./errors.ts";
import {
  JOB_TRIGGER_KINDS,
  type EnqueueImplementerTurnInput,
  type EnqueueJobInput,
  type JobTriggerKind,
} from "./job-types.ts";

const HEAD_SHA = /^[0-9a-f]{40}$/i;

/** An input that passed the checks, with defaults filled in. */
export type ValidEnqueueInput = {
  repositoryId: string;
  prNumber: number;
  prUrl: string;
  /** Lower case. */
  headSha: string;
  /**
   * The review kind, when the caller names one. Left out by the producers: the queue resolves it from
   * the project inside the enqueue transaction (`review-kind.ts`), so it cannot race a settings change.
   */
  reviewKind: ProjectReviewKind | undefined;
  command: ReviewCommand;
  args: string;
  triggerKind: JobTriggerKind;
  actorLogin: string;
  deliveryId: string | null;
  commentId: string | null;
  runAfter: Date | null;
};

export type EnqueueInputCheck =
  | { ok: true; value: ValidEnqueueInput }
  | { ok: false; fieldErrors: JobFieldError[] };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

export function validateEnqueueInput(
  input: EnqueueJobInput,
): EnqueueInputCheck {
  const fields = input as Partial<Record<keyof EnqueueJobInput, unknown>>;
  const fieldErrors: JobFieldError[] = [];
  const refuse = (field: string, code: JobFieldError["code"]) =>
    void fieldErrors.push({ field, code });

  if (!isNonEmptyString(fields.repositoryId))
    refuse("repositoryId", "required");

  const prNumber = fields.prNumber;
  if (
    typeof prNumber !== "number" ||
    !Number.isSafeInteger(prNumber) ||
    prNumber < 1
  )
    refuse("prNumber", "invalid");

  const prUrl = fields.prUrl;
  if (!isNonEmptyString(prUrl)) refuse("prUrl", "required");
  else if (!isHttpUrl(prUrl)) refuse("prUrl", "invalid");

  const headSha = fields.headSha;
  if (typeof headSha !== "string" || !HEAD_SHA.test(headSha))
    refuse("headSha", "invalid");

  // #195: the kind is pinned at enqueue time. When the caller names one it must be known; when it is
  // left out the queue resolves it from the project inside the enqueue transaction.
  const reviewKind = fields.reviewKind;
  if (
    reviewKind !== undefined &&
    !PROJECT_REVIEW_KINDS.some((kind) => kind === reviewKind)
  )
    refuse("reviewKind", "invalid");

  const command = fields.command;
  if (command === undefined || command === null || command === "")
    refuse("command", "required");
  else if (!REVIEW_COMMANDS.some((known) => known === command))
    refuse("command", "invalid");

  const args = fields.args ?? "";
  if (typeof args !== "string") refuse("args", "invalid");
  // `/review` takes no text (#203), so any non-empty arguments would name a different job that then
  // runs the same review; they are refused. (Kept as a field so a legacy caller gets a named error.)
  else if (args !== "") refuse("args", "invalid");

  if (!JOB_TRIGGER_KINDS.some((kind) => kind === fields.triggerKind))
    refuse("triggerKind", "invalid");

  if (!isNonEmptyString(fields.actorLogin)) refuse("actorLogin", "required");

  const deliveryId = fields.deliveryId ?? null;
  if (deliveryId !== null && !isNonEmptyString(deliveryId))
    refuse("deliveryId", "invalid");

  const commentId = fields.commentId ?? null;
  if (commentId !== null && !isNonEmptyString(commentId))
    refuse("commentId", "invalid");

  const runAfter = fields.runAfter ?? null;
  if (
    runAfter !== null &&
    (!(runAfter instanceof Date) || Number.isNaN(runAfter.getTime()))
  )
    refuse("runAfter", "invalid");

  if (fieldErrors.length > 0) return { ok: false, fieldErrors };

  // The checks above narrowed the fields; the casts only restate what they proved.
  return {
    ok: true,
    value: {
      repositoryId: fields.repositoryId as string,
      prNumber: prNumber as number,
      prUrl: prUrl as string,
      headSha: (headSha as string).toLowerCase(),
      reviewKind: reviewKind as ProjectReviewKind | undefined,
      command: command as ReviewCommand,
      args: args as string,
      triggerKind: fields.triggerKind as JobTriggerKind,
      actorLogin: fields.actorLogin as string,
      deliveryId: deliveryId as string | null,
      commentId: commentId as string | null,
      runAfter: runAfter as Date | null,
    },
  };
}

export type ImplementerTurnInputCheck =
  | { ok: true; value: EnqueueImplementerTurnInput }
  | { ok: false; fieldErrors: JobFieldError[] };

/** A request id as a client sends it: printable ASCII without a space, so it is safe inside the job's delivery id and logs. */
export const CLIENT_REQUEST_ID = /^[\x21-\x7e]{1,200}$/;
/** A branch name: no control character and no space (git refuses both), and bounded. */
export const BRANCH_NAME = /^[^\s\x00-\x1f\x7f]{1,255}$/;

/**
 * Checks what `enqueueImplementerTurn` is given before anything is written (#752). The model choice is checked where it is
 * stored (`implementer-model-choice.ts`); the existence of the repository and the branch, by the transaction that writes them.
 */
export function validateImplementerTurnInput(
  input: EnqueueImplementerTurnInput,
): ImplementerTurnInputCheck {
  const fields = input as Partial<
    Record<keyof EnqueueImplementerTurnInput, unknown>
  >;
  const fieldErrors: JobFieldError[] = [];
  const refuse = (field: string, code: JobFieldError["code"]) =>
    void fieldErrors.push({ field, code });

  if (!isNonEmptyString(fields.repositoryId))
    refuse("repositoryId", "required");
  for (const field of ["baseBranch", "branch"] as const) {
    const value = fields[field];
    if (!isNonEmptyString(value)) refuse(field, "required");
    else if (!BRANCH_NAME.test(value)) refuse(field, "invalid");
  }
  const baseSha = fields.baseSha;
  if (typeof baseSha !== "string" || !HEAD_SHA.test(baseSha))
    refuse("baseSha", "invalid");
  if (!isNonEmptyString(fields.instruction)) refuse("instruction", "required");
  const cost = fields.costLimitCents;
  if (
    cost !== null &&
    (typeof cost !== "number" || !Number.isSafeInteger(cost) || cost < 1)
  )
    refuse("costLimitCents", "invalid");
  if (!isNonEmptyString(fields.createdBy)) refuse("createdBy", "required");
  if (!isNonEmptyString(fields.actorLogin)) refuse("actorLogin", "required");
  const requestId = fields.clientRequestId;
  if (typeof requestId !== "string" || requestId === "")
    refuse("clientRequestId", "required");
  else if (!CLIENT_REQUEST_ID.test(requestId))
    refuse("clientRequestId", requestId.length > 200 ? "too_long" : "invalid");

  if (fieldErrors.length > 0) return { ok: false, fieldErrors };
  return {
    ok: true,
    value: {
      ...input,
      baseSha: (baseSha as string).toLowerCase(),
    },
  };
}
