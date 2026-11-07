// SPDX-License-Identifier: LicenseRef-Proprietary

// The stable error codes of the webhook route. A caller (GitHub's delivery log, a test) branches on
// `error`, never on the status text; the response carries nothing else, so it can never echo the body,
// a secret or a signature.
export const WEBHOOK_ERROR_CODES = [
  /** The body is larger than the limit. 413. */
  "WEBHOOK_BODY_TOO_LARGE",
  /** The signature is missing, malformed or does not match the body, or deliveries cannot be verified at all. 401. */
  "WEBHOOK_SIGNATURE_INVALID",
  /** The `X-GitHub-Event` header is missing or malformed. 400. */
  "WEBHOOK_EVENT_HEADER_INVALID",
  /** The `X-GitHub-Delivery` header is missing or malformed. 400. */
  "WEBHOOK_DELIVERY_HEADER_INVALID",
  /** The body is not valid JSON. 400. */
  "WEBHOOK_BODY_NOT_JSON",
  /** The signature is valid, but the payload of an event the app uses lacks fields it reads (for example no head commit). 400. */
  "WEBHOOK_PAYLOAD_INVALID",
  /** Another request is handling this delivery right now; GitHub shows it as failed and it can be redelivered. 409. */
  "WEBHOOK_DELIVERY_IN_PROGRESS",
  /** Handling the delivery failed; it can be redelivered. 5xx. */
  "WEBHOOK_PROCESSING_FAILED",
] as const;
export type WebhookErrorCode = (typeof WEBHOOK_ERROR_CODES)[number];

/** What the route answers with `202`: it only names what happened, for GitHub's delivery log. */
export const WEBHOOK_ACCEPTED_OUTCOMES = [
  /** The event is not one the app uses; nothing was recorded or done. */
  "event_not_used",
  /** The delivery id was handled before; nothing was done. */
  "duplicate",
  "ignored",
  "unknown_installation",
  "integration_disabled",
  "trigger_not_allowed",
  /** The repository has no active project (never activated, deactivated, or gone from the installation). */
  "project_not_active",
  /** A comment command the project's settings do not allow; nothing was handed to the intake. */
  "command_not_allowed",
  "trigger_enqueued",
  /**
   * A pull request event that deliberately starts no review: a draft, a closed pull request, a
   * setting that switches it off, or a commit that is no longer the head. The reason is logged.
   */
  "trigger_skipped",
  /** A pull request was closed; the jobs still waiting for it were dropped (possibly none). */
  "waiting_jobs_discarded",
  /** An issue got a label (#845) and at least one workflow of the workspace has a run for it now (started by this delivery or an earlier try of it). */
  "workflow_runs_started",
  /** An issue got a label (#845) and no workflow of the workspace starts for it (no workflow with the label, or the repository is not an active one). */
  "no_workflow_matched",
  /** A comment `/answer ...` (#920) answered the question a workflow run waits for. */
  "ticket_answered",
  /** A comment `/answer ...` (#920) that no waiting run takes: none waits on this ticket, or the answer cannot be used, or somebody answered first. */
  "no_answer_taken",
  "installation_changed",
  /** An installation that no workspace has linked: noted as unclaimed, nothing was created. */
  "installation_unclaimed",
] as const;
export type WebhookAcceptedOutcome = (typeof WEBHOOK_ACCEPTED_OUTCOMES)[number];

/** Thrown inside the handler for a failure that has its own answer. */
export class WebhookProcessingError extends Error {
  readonly safeMessage = true as const;
  readonly status: 500 | 503;

  constructor(
    message: string,
    status: 500 | 503 = 500,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "WebhookProcessingError";
    this.status = status;
  }
}

/** Thrown inside the handler for a payload that is signed but not usable; answered with 400. */
export class WebhookPayloadError extends Error {
  readonly safeMessage = true as const;

  constructor(message: string) {
    super(message);
    this.name = "WebhookPayloadError";
  }
}
