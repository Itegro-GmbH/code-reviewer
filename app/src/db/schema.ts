// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ColumnType, Generated } from "kysely";

// Row types of every table, the single place Kysely learns the schema from. Add a table here in the
// same change as the migration that creates it. Column conventions: see README.md in this folder.

export interface AppMetaTable {
  key: string;
  value: string;
  /** ISO 8601 text in UTC. */
  updated_at: string;
}

// The four tables below belong to Better Auth: it reads and writes them through its Kysely adapter
// (src/auth/auth.ts), so they have no repository. Nothing else in the app writes to them.
export interface UsersTable {
  id: string;
  name: string;
  email: string;
  /** 1 or 0. */
  email_verified: number;
  image: string | null;
  /** The current GitHub login, refreshed on every sign in. Null for a user without a GitHub account. */
  github_login: string | null;
  /**
   * When the user was imported from an installation that existed before accounts (ISO 8601, UTC), or
   * null. Set by the import only; only imported users qualify for the merge with the instance admin.
   */
  imported_at: string | null;
  /**
   * 1 for the instance admin (the account the first-run setup creates), otherwise 0. The database
   * fills in 0, so an insert (Better Auth's, a test's) may leave it out.
   */
  is_instance_admin: ColumnType<number, number | undefined, number>;
  /**
   * The verified primary email of the user's GitHub account when another account has it already, so an
   * imported user's placeholder address could not be replaced (src/github-signin/decide.ts); otherwise null.
   */
  email_conflict: string | null;
  /** When the membership in the allowed GitHub organization was last confirmed (ISO 8601, UTC), or null. */
  org_checked_at: string | null;
  /** The GitHub organization that check was made for, or null. */
  org_checked_for: string | null;
  /**
   * The PostHog distinct id the landing page (code-review.com) handed over at the sign-up, or null (#692). Written once
   * (the first touch), never changed, never shown or logged; the app does not use it (src/landing-identity/README.md).
   */
  posthog_distinct_id: string | null;
  /** The PostHog session id that came with it, or null. */
  posthog_session_id: string | null;
  /** When the two above were stored (ISO 8601, UTC), or null. Non-null is what makes them first-touch only. */
  posthog_captured_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionsTable {
  id: string;
  expires_at: string;
  token: string;
  created_at: string;
  updated_at: string;
  ip_address: string | null;
  user_agent: string | null;
  user_id: string;
}

export interface AccountsTable {
  id: string;
  /** The identity at the provider: the numeric GitHub id, as text. */
  account_id: string;
  provider_id: string;
  user_id: string;
  access_token: string | null;
  refresh_token: string | null;
  id_token: string | null;
  access_token_expires_at: string | null;
  refresh_token_expires_at: string | null;
  scope: string | null;
  password: string | null;
  created_at: string;
  updated_at: string;
}

export interface VerificationsTable {
  id: string;
  identifier: string;
  value: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

/** Which GitHub account a login on the allow list is bound to; used by the update to accounts (`src/legacy-import/`). */
export interface AllowedLoginPinsTable {
  /** The lower-cased GitHub login. */
  login: string;
  /** The numeric GitHub id, as text. */
  github_id: string;
  /** ISO 8601 text in UTC. */
  pinned_at: string;
}

/** The owner of customer data (src/workspaces/README.md). */
export interface WorkspacesTable {
  id: string;
  name: string;
  /** Unique. */
  slug: string;
  /** The user who created it, or null (made by a migration or the setup). */
  created_by: string | null;
  /** ISO 8601 text in UTC. */
  created_at: string;
  /**
   * When the workspace was deleted (#658), or null; the row then is a tombstone (src/db/repositories/workspaces-repository.ts).
   * Never written on insert (the column defaults to null), so a workspace can be made on the schema of the release before.
   */
  deleted_at: ColumnType<
    string | null,
    string | null | undefined,
    string | null
  >;
}

/** A user's membership of a workspace, with a role (a WorkspaceRole, src/db/workspace-roles.ts). */
export interface WorkspaceMembersTable {
  workspace_id: string;
  user_id: string;
  role: string;
  /** ISO 8601 text in UTC. */
  created_at: string;
}

export interface IntegrationsTable {
  id: string;
  /** The workspace the connection belongs to; one installation is linked to one workspace only. */
  workspace_id: string;
  /** An IntegrationType (src/integrations/types.ts). */
  type: string;
  display_name: string;
  /** The platform's id for the connection, for example a GitHub installation id. */
  external_id: string;
  /** JSON text: settings only, never a secret. */
  config: string;
  /** JSON text, reserved for token integrations. Null for a GitHub App. */
  credentials: string | null;
  webhook_secret: string | null;
  /** An IntegrationStatus. */
  status: string;
  /** ISO 8601 text in UTC. */
  created_at: string;
  updated_at: string;
}

export interface RepositoriesTable {
  id: string;
  /** The workspace of the integration, repeated here so queries need no join. */
  workspace_id: string;
  /** The integration (for a GitHub App: the installation) that gives access to the repository. */
  integration_id: string;
  /** The platform's id of the repository. */
  external_id: string;
  /** "owner/name". */
  full_name: string;
  url: string;
  /** 1 while the platform still lists the repository for the integration, 0 once it does not. */
  active: number;
  /** ISO 8601 text in UTC. */
  created_at: string;
  updated_at: string;
}

export interface ProjectsTable {
  id: string;
  /** The repository this project reviews; unique, so a repository has at most one project. */
  repository_id: string;
  /** 1 while the project is switched on, 0 after it was deactivated. */
  active: number;
  /** JSON text: the project's setting overrides, '{}' until some are saved. */
  settings: string;
  /** ISO 8601 text in UTC. */
  created_at: string;
  updated_at: string;
}

/** One setting of a workspace (src/db/repositories/app-settings-repository.ts). */
export interface AppSettingsTable {
  workspace_id: string;
  /** The name of the setting, for example "review_defaults". */
  key: string;
  /** JSON text. */
  value: string;
  /** ISO 8601 text in UTC. */
  updated_at: string;
  /** The GitHub login of the person who saved it last, or null. */
  updated_by: string | null;
}

export interface WebhookDeliveriesTable {
  /** The platform's delivery id (GitHub: `X-GitHub-Delivery`). */
  delivery_id: string;
  /** The event name of the delivery, for example "pull_request". */
  event: string;
  /** A WebhookDeliveryOutcome (src/db/repositories/webhook-deliveries-repository.ts). */
  outcome: string;
  /** Random value of the request that owns the claim; only its owner may complete or release it. */
  claim_token: string;
  /** ISO 8601 text in UTC: when the current claim was made. */
  received_at: string;
}

export interface JobsTable {
  id: string;
  /** The workspace of the repository, repeated here so queries need no join. */
  workspace_id: string;
  repository_id: string;
  pr_number: number;
  pr_url: string;
  /** 40 hexadecimal characters, lower case. */
  head_sha: string;
  /**
   * A ProjectReviewKind (#195), 'diff' for PR-Agent and 'dynamic' for the read-only agent. The
   * database default is 'diff', so a row written without it (a migration, an older app instance) is a
   * Diff job.
   */
  review_kind: ColumnType<string, string | undefined, string>;
  /** A ReviewCommand (src/integrations/types.ts). */
  command: string;
  /** Text after the command, an empty string when there is none. Untrusted. */
  args: string;
  /** A JobTriggerKind (src/jobs/job-types.ts). */
  trigger_kind: string;
  actor_login: string;
  /** The webhook delivery that created the job, or null. Unique where not null. */
  delivery_id: string | null;
  /** A JobStatus (src/db/job-status.ts). */
  status: string;
  /** ISO 8601 text in UTC: the job is not handed out before this moment. */
  run_after: string;
  /** How many attempts were lost (a lease ran out, a claim was given back). */
  attempts: number;
  runner_id: string | null;
  /**
   * Random value of the current claim; required to heartbeat, complete or release the job. Cleared
   * when the job is requeued, kept on a finished job so that a repeated report is recognised.
   */
  lease_token: string | null;
  /**
   * How many times the Worker of the current claim fetched the job details (#320, at most 3). Reset by
   * every claim, so it only counts for a claim made with a per-job credential. Not a `Job` field.
   */
  worker_fetches: ColumnType<number, number | undefined, number>;
  /** #397: 1 when the holder of the claim understands that its run can be superseded (the feature `supersede`). */
  accepts_supersede: ColumnType<number, number | undefined, number>;
  claimed_at: string | null;
  heartbeat_at: string | null;
  lease_expires_at: string | null;
  /** JSON text, or null. */
  result: string | null;
  error_code: string | null;
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

/** A comment that was answered with a job (src/jobs/README.md). One row per comment. */
export interface JobCommentsTable {
  repository_id: string;
  /** The platform's id of the comment, as text. */
  comment_id: string;
  /** The job that answers the comment; possibly one that was already waiting or running. */
  job_id: string;
}

/** One setting of the whole instance, with a JSON value (src/db/repositories/instance-settings-repository.ts). */
export interface InstanceSettingsTable {
  key: string;
  /** JSON text. */
  value: string;
  /** The id of the user who saved it last, or null. */
  updated_by: string | null;
  /** ISO 8601 text in UTC. */
  updated_at: string;
}

/** A shared counter with a window (src/db/repositories/rate-limits-repository.ts). */
export interface RateLimitsTable {
  key: string;
  /** ISO 8601 text in UTC: when the current window began. */
  window_started_at: string;
  count: number;
}

/** The setup code of a serverless deployment (src/db/repositories/setup-codes-repository.ts, src/setup/). At most one row. */
export interface SetupCodesTable {
  /** The id of this issuance of the code; the setup session is bound to it. */
  id: string;
  /** Always 1 and unique: the table cannot hold a second row, and the replacement is one upsert on it. */
  slot: number;
  /** Hex of a keyed hash (HMAC with a key derived from `APP_SECRET`) of the id and the code. */
  code_hash: string;
  /** ISO 8601 text in UTC. */
  created_at: string;
  /** ISO 8601 text in UTC. */
  expires_at: string;
  /** ISO 8601 text in UTC; set when the correct code was used. */
  used_at: string | null;
  /** Wrong attempts (counted before the comparison, so concurrent guesses cannot exceed the limit). */
  failures: number;
  /** ISO 8601 text in UTC: when the current rate limit window began. */
  window_started_at: string | null;
  attempts_in_window: number;
}

/** An encrypted credential of the instance (src/db/repositories/secrets-repository.ts, src/secrets/). */
export interface SecretsTable {
  /** The secret's name; the row id that is bound into the ciphertext. */
  name: string;
  /** The encrypted value followed by the authentication tag, base64. */
  ciphertext: string;
  /** The random 96-bit nonce, base64. */
  nonce: string;
  /** The version of the derived key that encrypted it. */
  key_version: number;
  /** The last four characters of the value when the caller asked for the hint (not a secret), or null. */
  last_four: string | null;
  /** The id of the user who saved it last, or null. */
  updated_by: string | null;
  /** ISO 8601 text in UTC. */
  updated_at: string;
}

/** An encrypted credential of one workspace (src/db/repositories/workspace-secrets-repository.ts, src/secrets/). */
export interface WorkspaceSecretsTable {
  workspace_id: string;
  /** The secret's name (the field bound into the ciphertext), from WORKSPACE_SECRET_NAMES. */
  name: string;
  /** What the secret was made for (the provider of an LLM key); it must still match when it is used. */
  binding: string;
  /** The encrypted value followed by the authentication tag, base64. */
  ciphertext: string;
  /** The random 96-bit nonce, base64. */
  nonce: string;
  /** The version of the derived key that encrypted it. */
  key_version: number;
  /** The last four characters of the value when the caller asked for the hint (not a secret), or null. */
  last_four: string | null;
  /** The id of the user who saved it last, or null. */
  updated_by: string | null;
  /** ISO 8601 text in UTC. */
  updated_at: string;
}

/**
 * What an operator allows one workspace (src/db/repositories/workspace-entitlements-repository.ts,
 * src/workspaces/entitlements.ts). One row per workspace; no row means the instance default or unlimited.
 */
export interface WorkspaceEntitlementsTable {
  /** The workspace; the primary key, so a workspace has at most one row. */
  workspace_id: string;
  /** A label for display and audit, at most 64 printable characters; the code never branches on it. */
  plan_label: string;
  /** `own` or `managed` (KEY_MODES). */
  key_mode: string;
  /** JSON text: `diffRunsPerPeriod`, `dynamicRunsPerPeriod`, `managedCostLimitMicroUsd`, `ownKeyCostLimitMicroUsd` (#361; absent in an entry from before it), each a count or null. */
  limits: string;
  /** ISO 8601 text in UTC: usage counts from here. Never moves to an earlier time. */
  period_start: string;
  /** 1 while the workspace's reviews are suspended, otherwise 0. */
  suspended: number;
  /** A short lowercase code that says why; null unless `suspended` is 1. */
  suspension_code: string | null;
  /** #428: JSON text `{"catalogEntries":[ids]}`; null means every released entry (and is what a row of before #428 has). */
  model_access: string | null;
  /** ISO 8601 text in UTC. */
  updated_at: string;
  /** The id of the user who saved it last, or null (the operator API, or a user who was deleted since). */
  updated_by: string | null;
}

/**
 * What one run consumed (src/db/repositories/usage-records-repository.ts, src/usage/README.md). One row per job,
 * written at the claim and settled or voided when the job ends.
 */
export interface UsageRecordsTable {
  /** The tie-break of the page of settled records, after `settled_at`. */
  id: string;
  workspace_id: string;
  /** Unique: a job has one record, however often it is claimed. */
  job_id: string;
  /** A ProjectReviewKind, copied from the job. */
  review_kind: string;
  /** `own` or `managed` (KEY_MODES): whose key the run used. */
  key_mode: string;
  /** The managed model tier; null until the tiers exist. Old rows only: the catalog entry replaces it (#432). */
  model_tier: string | null;
  /** The catalog entry a managed run used (#432); null for an own run and for a row from before the catalog. */
  catalog_entry_id: string | null;
  /** The name of that entry when the run was claimed (a snapshot: a rename does not rewrite history). */
  catalog_entry_name: string | null;
  /** The provider the run was sent to (#432); operator data, never served to a member. Null before #432. */
  llm_provider: string | null;
  /** `reserved`, `settled` or `void` (USAGE_STATES). */
  state: string;
  /** The measured cost in millionths of a US dollar; null when unknown. Only on a settled record. */
  cost_micro_usd: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  /** ISO 8601 text in UTC. */
  reserved_at: string;
  /** ISO 8601 text in UTC; only a settled record has it. */
  settled_at: string | null;
  /** Why the record was settled without a report of its run (SETTLED_REASONS); null when the run reported. */
  settled_reason: string | null;
  /**
   * `open` from a claim made with billing on until its one settlement, then `settled` (BILLING_STATES, #605); null for a job
   * claimed with billing off, which is never charged.
   */
  billing_state: string | null;
}

/** The LLM key handed to a runner with the claim of a job, encrypted (src/runner-api/claimed-keys.ts). */
export interface JobClaimedKeysTable {
  job_id: string;
  /** The encrypted key followed by the authentication tag, base64. */
  ciphertext: string;
  /** The random 96-bit nonce, base64. */
  nonce: string;
  key_version: number;
  /** ISO 8601 text in UTC. */
  created_at: string;
}

/** Where the signed wake-up call of a job stands (src/dispatch/README.md); only written in webhook mode. */
export interface JobDispatchesTable {
  job_id: string;
  /** `pending`, `acked` or `stopped` (`DISPATCH_STATES`). */
  state: string;
  /** How many times the call was claimed for sending (0 while it never was). */
  attempts: number;
  /** Failed sends in a row; the schedule of the next wait. */
  consecutive_failures: number;
  /** ISO 8601 text in UTC: when the job is to be sent (again). While a send is in flight: when its claim ends. */
  next_dispatch_at: string;
  acked_at: string | null;
  last_attempt_at: string | null;
  /** The HTTP status of the last answer, null when there was none. */
  last_status: number | null;
  /** A name of `DISPATCH_RESULT_CODES`. */
  last_code: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * The notice of a refused review that one pull request got in one period (#281). Unique by workspace, repository,
 * pull request and period start: that is what keeps a second push from posting again.
 */
export interface RefusalNoticesTable {
  id: string;
  workspace_id: string;
  repository_id: string;
  pr_number: number;
  /** The `period_start` of the entitlements the refusal was decided under (ISO 8601 text in UTC). */
  period_start: string;
  /** A NoticeCode: the refusal the notice is about (`quota_exhausted` or `workspace_suspended`). */
  code: string;
  /** `pending`, `posted` or `dropped` (`NOTICE_STATES`). */
  state: string;
  /** How many times a post was started; bounded by the code. */
  attempts: number;
  /** ISO 8601 text in UTC: when a post may be started again. While one is in flight: when its claim ends. */
  next_attempt_at: string;
  /** ISO 8601 text in UTC; only a posted notice has it. */
  posted_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Where the check run and the review verdict of one review job stand on GitHub (#405, src/check-runs/README.md): one
 * row per job. The ids make the work idempotent; `synced_status` is the job status the check run shows now.
 */
export interface JobCheckRunsTable {
  job_id: string;
  /** The workspace of the job, repeated here so queries need no join to scope. */
  workspace_id: string;
  /** The id of the check run on the platform, as text; null until it is made. */
  check_run_id: string | null;
  /** The id of the review the app submitted, as text; null until then (or when none is submitted). */
  review_id: string | null;
  /** `approve`, `request_changes` or `withdrawn`: what the app did to the pull request with the verdict; null if nothing. */
  review_event: string | null;
  /** When `review_event` was recorded (ISO 8601 UTC); null with it. Orders the events of one pull request. */
  review_event_at: string | null;
  /** A JobStatus: the status of the job the check run shows now; null before the first sync. */
  synced_status: string | null;
  /** How many times the creation of the check run was started (counted before the call). */
  check_create_attempts: ColumnType<number, number | undefined, number>;
  /** How many times the submission of the review was started (counted before the call). */
  review_submit_attempts: ColumnType<number, number | undefined, number>;
  /** `active` or `dropped` (`CHECK_RUN_STATES`): the check run alone, dropped when the App may not write it. */
  check_state: ColumnType<string, string | undefined, string>;
  /** `pending`, `done` or `dropped` (`REVIEW_VERDICT_STATES`). */
  review_state: ColumnType<string, string | undefined, string>;
  /** `active`, `settled` or `dropped` (`JOB_CHECK_STATES`). */
  state: ColumnType<string, string | undefined, string>;
  /** Syncs started since the last one that finished, counted when they start (so a sync cut off counts); bounded by the code. */
  attempts: ColumnType<number, number | undefined, number>;
  /** ISO 8601 text in UTC: when a sync may start again. While one runs: when its claim ends. */
  next_attempt_at: string;
  /** The stable code of the last failure or of the reason the row was dropped. */
  last_code: string | null;
  /**
   * The body of the review comment the run posted, read once after the run ended (#657); null until then. An empty
   * string: the comment was looked for and could not be read.
   */
  review_comment: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Where the infrastructure of a review job began and ended (#493, src/billing/README.md, "Billable minutes"): one row per
 * VM the Dispatcher reported, or one `job_wall_clock` row where no VM exists. It only measures.
 */
export interface JobVmRunsTable {
  job_id: string;
  /** The name of the VM (the Dispatcher's; unique per launch), or `job_wall_clock` where no VM exists. */
  vm_name: string;
  /** The workspace of the job, repeated here so queries need no join to scope. */
  workspace_id: string;
  /** The attempt the VM was started for: the job's lost attempts at the time of the report, plus one. For audit. */
  attempt: number;
  /** `jobs.claimed_at` of the claim the VM was started for: the identity of the claim; the VM of the final claim counts. */
  claimed_at: string;
  /** ISO 8601 UTC: when the VM was created, as the Dispatcher reported it, kept between the claim and the report. */
  started_at: string;
  /** ISO 8601 UTC: when the App received the report (its own clock). */
  reported_at: string;
  /** The VM's own timeout in seconds (the platform ends the VM there); null for `job_wall_clock`. */
  vm_timeout_seconds: number | null;
  /** ISO 8601 UTC: the teardown, or null while none is known. Null together with `end_source`. */
  ended_at: string | null;
  /** A VmEndSource (src/db/billing-minutes.ts); null together with `ended_at`. */
  end_source: string | null;
  /** 1 for the VM that counts for the job's bill (the final claim's), else 0. */
  billable: ColumnType<number, number | undefined, number>;
  /** `ceil(seconds / 60)` of the span once the end is known, at least 1; null before that. */
  billable_minutes: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * A single-use token that hands an Owner or Admin over to the operator-configured plan page (#284,
 * src/plan-handoff/). Only the hash of the token is kept.
 */
export interface PlanHandoffTokensTable {
  /** SHA-256 of the token, hex. */
  token_hash: string;
  workspace_id: string;
  user_id: string;
  /** The role the person had when the token was made: `owner` or `admin`. */
  role: string;
  /** ISO 8601 text in UTC. */
  created_at: string;
  /** ISO 8601 text in UTC. */
  expires_at: string;
  /** ISO 8601 text in UTC, or null while the token is unused. */
  used_at: string | null;
  /** ISO 8601 text in UTC, or null; set when a newer token of the same person in the same workspace replaced it. */
  revoked_at: string | null;
}

/** A single-use link to set a new password; only the hash of the token is kept (src/auth/password-reset.ts). */
export interface PasswordResetTokensTable {
  /** SHA-256 of the token, hex. */
  token_hash: string;
  user_id: string;
  /** ISO 8601 text in UTC. */
  created_at: string;
  /** ISO 8601 text in UTC. */
  expires_at: string;
  /** ISO 8601 text in UTC, or null while the token is unused. */
  used_at: string | null;
}

/** A single-use link that verifies an email address; only the hash of the token is kept (src/signup/). */
export interface EmailVerificationTokensTable {
  /** SHA-256 of the token, hex. */
  token_hash: string;
  user_id: string;
  /** The address the link verifies; it verifies nothing once the account has another address. */
  email: string;
  /**
   * The password hash (Better Auth's format) of the sign-up that made the link. The link is used with that
   * password, and that hash becomes the password of the account.
   */
  password_hash: string;
  /** ISO 8601 text in UTC. */
  created_at: string;
  /** ISO 8601 text in UTC. */
  expires_at: string;
  /** ISO 8601 text in UTC, or null while the token is unused. */
  used_at: string | null;
}

/**
 * The single-use side of a signed `state` that travels through the browser and GitHub (the manifest flow, the
 * authorization that links a GitHub identity); see src/signed-state/.
 */
export interface SignedStatesTable {
  /** The random nonce that the signed value names. */
  id: string;
  /** What the state is for (`github-manifest`, `github-link`): a state of one purpose is worthless for another. */
  purpose: string;
  /** The person who started it. */
  user_id: string | null;
  /** SHA-256 (hex) of the session it was started in: the callback must come from the same session. */
  session_hash: string | null;
  /** The PKCE verifier of an authorization started here; never leaves the server. */
  code_verifier: string | null;
  /** JSON text that belongs to the flow and comes back when the state is used (never a secret), or null. */
  data: string | null;
  /** ISO 8601 text in UTC. */
  created_at: string;
  /** ISO 8601 text in UTC. */
  expires_at: string;
  /** ISO 8601 text in UTC, or null while the state is unused. */
  used_at: string | null;
}

/**
 * A single-use link that brings a person into a workspace; only the hash of the token is kept
 * (src/workspaces/invitations.ts).
 */
export interface InvitationsTable {
  id: string;
  workspace_id: string;
  /** The address the invitation is bound to, canonical (src/signup/rule.ts `canonicalEmail`). */
  email: string;
  /** The role the person gets (a WorkspaceRole, src/db/workspace-roles.ts). */
  role: string;
  /** SHA-256 of the token, hex. A resend replaces it, which invalidates the old link. */
  token_hash: string;
  /** The user who created it, or null (the user is gone). */
  invited_by: string | null;
  /** ISO 8601 text in UTC. */
  created_at: string;
  /** ISO 8601 text in UTC. */
  expires_at: string;
  /** ISO 8601 text in UTC, or null while the invitation is pending or was revoked. */
  accepted_at: string | null;
  accepted_by: string | null;
  /** ISO 8601 text in UTC, or null while the invitation is pending or was accepted. */
  revoked_at: string | null;
}

/**
 * A request to link a GitHub App installation that the instance admin decides, because the role of the
 * requester's GitHub account could not be read (src/installation-binding/). Keeps the evidence, never a token.
 */
export interface InstallationLinkRequestsTable {
  id: string;
  workspace_id: string;
  /** The user who asked, or null once the user is gone. */
  requested_by: string | null;
  /** The login of the GitHub account the requester proved control of, or null. */
  requester_github_login: string | null;
  /** The platform's id of the installation, as text. */
  installation_id: string;
  account_login: string;
  /** `User` or `Organization`, as GitHub says. */
  account_type: string;
  /** The numeric id of the installation's account, as text. */
  account_id: string;
  /** An InstallationLinkRequestStatus (src/db/installation-link-request.ts). */
  status: string;
  /** 1 when the requester's token lists the installation, 0 when it does not, null when it could not be asked. */
  token_can_access: number | null;
  /** A RoleResult (src/installation-binding/github-user.ts). */
  role_result: string;
  /** A stable code that says why the role could not be read, or null. */
  role_detail: string | null;
  /** ISO 8601 text in UTC. */
  created_at: string;
  /** ISO 8601 text in UTC, or null while the request is pending. */
  decided_at: string | null;
  decided_by: string | null;
}

/** An installation of the GitHub App that no workspace has linked (src/db/repositories/unclaimed-installations-repository.ts). */
export interface UnclaimedInstallationsTable {
  /** The platform's id of the installation, as text. */
  installation_id: string;
  account_login: string;
  account_type: string;
  /** ISO 8601 text in UTC. */
  first_seen_at: string;
  /** ISO 8601 text in UTC. */
  last_seen_at: string;
  /** `webhook` or `sync`. */
  source: string;
}

/**
 * One entry of the operator's model catalog (#425, src/model-catalog/). Instance level: no workspace owns it. `name` is
 * shown to members, `provider` and `model_id` are operator only.
 */
export interface ModelCatalogEntriesTable {
  /** Opaque: `mce_` and 32 random hex digits. */
  id: string;
  /** 1 to 40 printable characters; shown to members. */
  name: string;
  /** The name folded to lower case (`nameKeyOf`); unique, so two names never differ only in case. */
  name_key: string;
  description: string | null;
  /** A provider of the registry; checked in code, not by the database. */
  provider: string;
  model_id: string;
  /** 0 or 1; at least one of the two kinds is 1 (a check). */
  serves_diff: number;
  serves_dynamic: number;
  /** `draft`, `released` or `retired` (`CATALOG_STATUSES`). */
  status: string;
  sort_order: number;
  /** ISO 8601 text in UTC. */
  created_at: string;
  updated_at: string;
  /** The user who changed it last, or null (the system, or a user who was deleted since). */
  updated_by: string | null;
}

/**
 * A provider of the models.dev catalog (#548, src/models-dev/). Instance level. Never deleted: a provider that
 * disappears upstream gets `unlisted_at`. Every text is untrusted data, length-capped before it is stored.
 */
export interface ModelsDevProvidersTable {
  /** The id models.dev uses and the supported-provider file lists (`deepseek`, `openai`). */
  provider_id: string;
  name: string;
  /** `trusted`, `url_changed` or `rejected` (`URL_STATES`): the trust on first use of the address. */
  url_state: string;
  /** The address the first check passed and an admin confirmed later; null while `rejected`. Where a real key is sent. */
  trusted_url: string | null;
  /** The address (or refused text) that differs from the trusted one and waits for an admin; null otherwise. */
  pending_url: string | null;
  /** Why the address was refused (`URL_PROBLEMS`), or null. */
  url_problem: string | null;
  /** ISO 8601 text in UTC: when the block began. */
  url_changed_at: string | null;
  first_seen_at: string;
  /** Set when the provider has no model in the latest fetch; the last known row stays. */
  unlisted_at: string | null;
  updated_at: string;
}

/**
 * A model of the models.dev catalog: only models with tool calling of a supported provider. Never deleted: a model
 * that disappears upstream gets `unlisted_at` and keeps its last known entry; a returning model clears it.
 */
export interface ModelsDevModelsTable {
  provider_id: string;
  model_id: string;
  name: string;
  family: string | null;
  context_limit: number;
  output_limit: number;
  input_limit: number | null;
  /** 0 or 1. */
  reasoning: number;
  temperature: number;
  attachment: number;
  /** JSON text: `{"input":["text"],"output":["text"]}`. */
  modalities: string;
  /** models.dev's own status (`alpha`, `beta`, `deprecated`, `active`); `deprecated` is shown as a warning. */
  upstream_status: string | null;
  /** JSON text of the prices (decimal strings, USD per million tokens), or null for an unpriced model. */
  cost: string | null;
  /** The `last_updated` date models.dev states. */
  upstream_updated: string | null;
  /** JSON text: `true` or `{"field":"reasoning_content"}`, or null. */
  interleaved: string | null;
  first_seen_at: string;
  unlisted_at: string | null;
  updated_at: string;
}

/** The one row (`id` = `models.dev`) of the state of the last fetch. */
export interface ModelsDevFetchStateTable {
  id: string;
  last_attempt_at: string | null;
  last_success_at: string | null;
  /** `ok` or `failed`. */
  last_status: string;
  /** A stable code of the last failure (`MODELS_DEV_FETCH_ERROR_CODES`); kept until the next success. */
  last_error: string | null;
  /** JSON text of the counts of the last applied fetch. */
  last_summary: string | null;
}

/**
 * Whether the admin enabled a catalog model for the managed key (#549). One row per model, changed in place; no row means
 * the admin has not decided ("new"). Instance level.
 */
export interface ModelEnablementsTable {
  provider_id: string;
  model_id: string;
  /** 0 or 1. */
  enabled: number;
  /** The user who made the last change, or null. No foreign key: the decision stays when a user is deleted. */
  changed_by: string | null;
  changed_at: string;
}

/**
 * What an admin confirmed as a catalog model's price (#549). Append-only (the database refuses an update and a delete);
 * the latest row of a model counts. Instance level.
 */
export interface ModelPriceConfirmationsTable {
  /** The order rows were written in (identity / rowid): the primary key, never set by the app. */
  seq: Generated<number>;
  provider_id: string;
  model_id: string;
  /** `catalog` (confirmed as shown) or `admin` (corrected, with a reason). */
  source: string;
  /** JSON text of the confirmed price book (src/model-prices/price-book.ts): amounts are decimal strings of micro-USD per million tokens. */
  price: string;
  /** JSON text of the price models.dev and the override file stated at that time; null when they stated none. */
  reference_price: string | null;
  /** SHA-256 hex of the reference; the price is stale once today's reference hashes differently. */
  reference_hash: string;
  reason: string | null;
  /** The user who confirmed, or null. No foreign key: the history stays when a user is deleted. */
  confirmed_by: string | null;
  confirmed_at: string;
}

/**
 * One thing that happened to a workspace's money (src/billing/README.md, ADR 0006, 2.7; #495). Append-only: the database
 * refuses an update and a delete. Amounts are micro-USD integers, signed. Postgres hands a `bigint` back as a string, so
 * the repository converts them with `Number`; the type is the application's.
 */
export interface BillingJournalEntriesTable {
  /** The order entries were written in (identity / autoincrement): the primary key, never set by the app. */
  seq: Generated<number>;
  id: string;
  workspace_id: string;
  /** A BillingEntryType (BILLING_ENTRY_TYPES). */
  type: string;
  amount_micro_usd: number;
  /** The job id or the provider reference; with `type` and the workspace the idempotency key (D14). */
  ref_key: string;
  /** Opaque, no foreign key: the journal outlives the job. */
  job_id: string | null;
  review_kind: string | null;
  minutes: number | null;
  ai_micro_usd: number | null;
  infra_micro_usd: number | null;
  /** The entry a `correction` reverses; unique, so a reversal happens once. */
  reverses_entry_id: string | null;
  provider: string | null;
  provider_ref: string | null;
  /** Opaque, no foreign key: a deleted or merged user does not rewrite the journal. */
  actor_user_id: string | null;
  note: string | null;
  /** ISO 8601 text in UTC. */
  created_at: string;
}

/** The cache of the journal's sum per workspace, updated in the transaction of every entry (src/billing/README.md). */
export interface BillingBalancesTable {
  workspace_id: string;
  /** The sum of all entries; below zero only through a settlement, refund, chargeback or correction. */
  balance_micro_usd: number;
  /** The open reservations; never below zero. */
  reserved_micro_usd: number;
  updated_at: string;
}

/**
 * The billing profile of one workspace (#501; customer data, never logged): the business that buys credit, the
 * confirmation of the first top-up and the provider's customer made from it. One row per workspace.
 */
export interface BillingProfilesTable {
  workspace_id: string;
  legal_name: string;
  /** ISO 3166-1 alpha-2, upper case. */
  country: string;
  address_line1: string;
  address_line2: string | null;
  postal_code: string;
  city: string;
  /** Normalized, a light format check only. */
  vat_id: string | null;
  /** The business confirmation: when (ISO 8601, UTC), by which user (null once the user is gone) and the terms version. */
  confirmed_at: string | null;
  confirmed_by: string | null;
  terms_version: string | null;
  /** The adapter's id and its opaque id of the customer made from this profile; both null until the first top-up. */
  customer_adapter: string | null;
  customer_ref: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * What a workspace sets for its own billing (src/billing/README.md, ADR 0006, 2.9; #499): the optional monthly total limit.
 * One row per workspace, made by the first change; no row means no limit.
 */
export interface BillingWorkspaceSettingsTable {
  workspace_id: string;
  /** Micro-USD, positive; null is no limit. `bigint` on Postgres, which reads it back as text (the repository converts). */
  monthly_limit_micro_usd: number | null;
  /** The user who last changed it; null once that user is gone. */
  updated_by: string | null;
  /** ISO 8601 text in UTC. */
  updated_at: string;
}

/**
 * What a workspace has been told about its balance (src/billing/README.md, "Balance notifications"; ADR 0006, D9; #506): one row
 * for each workspace and kind, made by the first crossing.
 */
export interface BillingNotificationsTable {
  workspace_id: string;
  /** A BalanceNotificationKind (src/billing/balance-notifications.ts): `low` or `empty`. */
  kind: string;
  /** `armed`: the next drop into the state is told; `sent`: told (or known) since the last time the balance was out of it. */
  state: string;
  /** ISO 8601 text in UTC; null while armed and for a crossing that was not mailed. */
  sent_at: string | null;
  /** A BalanceMailDelivery (src/billing/balance-notifications.ts): none, due, sending, delivered or failed. */
  delivery: string;
  updated_at: string;
}

/**
 * The memory of the start credit (src/billing/README.md, ADR 0006, 2.16; #507): one row for each GitHub account that was
 * granted it. Instance level, a numeric id and a workspace id only, and no foreign key: it outlives the workspace.
 */
export interface BillingStartCreditGrantsTable {
  /** The numeric id of the GitHub account of the installation, as text. The primary key: one grant per account. */
  github_account_id: string;
  /** The workspace that got the credit; it may be gone. */
  workspace_id: string;
  /** ISO 8601 text in UTC. */
  granted_at: string;
}

/**
 * The row written before any checkout exists (src/billing/README.md, ADR 0006, 2.13; #497): the one way a payment reaches
 * a workspace. `amount_micro_usd` is what WE asked for and bounds the credit; the provider ids are recorded once known.
 */
export interface BillingTopupIntentsTable {
  id: string;
  workspace_id: string;
  /** The id of the adapter that created the checkout. */
  adapter: string;
  amount_micro_usd: number;
  /** A TopUpIntentState (src/billing/adapter.ts): pending, paid, failed or expired. */
  state: string;
  /** The provider's opaque id of the checkout session; unique per adapter. */
  provider_checkout_ref: string | null;
  /** The provider's opaque id of the payment; unique per adapter, and the key of the journal's `top_up`. */
  provider_payment_ref: string | null;
  /** What the payment credited (net, micro-USD); 0 until paid. */
  credited_micro_usd: Generated<number>;
  /** What refunds took back of it, and what disputes did; together never above the credit (a check). */
  refunded_micro_usd: Generated<number>;
  disputed_micro_usd: Generated<number>;
  /**
   * What the buyer was charged, gross, in the provider's unit (cents of the currency paid in), pinned when the payment is
   * credited; null before that, for an intent paid before the column existed and for a provider that does not say (#502).
   */
  provider_amount: number | null;
  /** The lower case ISO 4217 code of `provider_amount`, pinned with it; null whenever the amount is (#502). */
  provider_currency: string | null;
  /** ISO 8601 text in UTC. */
  created_at: string;
  updated_at: string;
}

/**
 * One delivery of a provider's event, by event id (#497). No payload and no amount: an id, an outcome and, for a refund
 * or a dispute, the order of its states. Instance level.
 */
export interface BillingWebhookEventsTable {
  provider: string;
  event_id: string;
  /** A BillingEventOutcome (src/billing/adapter.ts), or 'processing' inside the transaction that handles the event. */
  outcome: string;
  /** 'refund:<id>' or 'dispute:<id>' for the events about those objects, 'payment:<id>' for a payment, else null. */
  subject: string | null;
  /** ISO 8601 text in UTC: when it happened at the provider. */
  occurred_at: string | null;
  received_at: string;
  /** 'open' for an event an operator must review (BILLING_REVIEW_OUTCOMES), 'resolved' once it was; null otherwise. */
  review_state: string | null;
  /** Whose payment the event is, when the application could attribute it to one of its intents (#502); else null. */
  workspace_id: string | null;
  intent_id: string | null;
  /** The resolution of a review (#603), null while open and for a review closed before it existed: when (ISO 8601, UTC), who (a user id), why, and the journal entry of a manual credit or correction. */
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  resolution_entry_id: string | null;
}

/**
 * A branch the Implementer works on (#751): the agent's task for one repository, the saved OpenCode session and its summary.
 * Its turns are the instructions given on it (this slice: one). `slot` is the number of the session within its repository
 * (1, 2, ...): the job of its turns holds `-slot` as the pull request number, so the queue's "one running job per pull request"
 * means "one running turn per session". The repository and the workspace are linked by a composite key: the database refuses a
 * session whose repository is another workspace's.
 */
export interface ImplementerSessionsTable {
  id: string;
  workspace_id: string;
  repository_id: string;
  slot: number;
  /** The branch the new branch starts from. */
  base_branch: string;
  /** The new branch, unique within the repository. */
  branch: string;
  /** The last commit pushed to `branch`; null until a turn pushed one. */
  head_commit: string | null;
  /** `running` while a turn is queued or running, `idle` once a turn has ended. */
  status: "running" | "idle";
  opencode_session_id: string | null;
  opencode_version: string | null;
  summary: string | null;
  created_by: string;
  /** ISO 8601 UTC. */
  created_at: string;
  updated_at: string;
}

/**
 * One instruction given to a session (#751). Its status is the status of its job (`job_id`, unique): there is no second state
 * machine. `model_choice` is JSON text of `{entryId}` or `{provider, model}` (src/db/implementer-model-choice.ts).
 */
export interface ImplementerTurnsTable {
  id: string;
  session_id: string;
  workspace_id: string;
  /** 1 for the first instruction of the session. */
  number: number;
  instruction: string;
  model_choice: string;
  /** The customer's cost limit for the turn in cents; null when none was asked for. */
  cost_limit_cents: number | null;
  job_id: string;
  created_by: string;
  created_at: string;
}

export interface Database {
  app_meta: AppMetaTable;
  users: UsersTable;
  sessions: SessionsTable;
  accounts: AccountsTable;
  verifications: VerificationsTable;
  allowed_login_pins: AllowedLoginPinsTable;
  workspaces: WorkspacesTable;
  workspace_members: WorkspaceMembersTable;
  integrations: IntegrationsTable;
  repositories: RepositoriesTable;
  projects: ProjectsTable;
  webhook_deliveries: WebhookDeliveriesTable;
  jobs: JobsTable;
  job_comments: JobCommentsTable;
  app_settings: AppSettingsTable;
  instance_settings: InstanceSettingsTable;
  rate_limits: RateLimitsTable;
  setup_codes: SetupCodesTable;
  secrets: SecretsTable;
  workspace_secrets: WorkspaceSecretsTable;
  workspace_entitlements: WorkspaceEntitlementsTable;
  usage_records: UsageRecordsTable;
  job_claimed_keys: JobClaimedKeysTable;
  job_dispatches: JobDispatchesTable;
  refusal_notices: RefusalNoticesTable;
  job_check_runs: JobCheckRunsTable;
  job_vm_runs: JobVmRunsTable;
  implementer_sessions: ImplementerSessionsTable;
  implementer_turns: ImplementerTurnsTable;
  plan_handoff_tokens: PlanHandoffTokensTable;
  model_catalog_entries: ModelCatalogEntriesTable;
  models_dev_providers: ModelsDevProvidersTable;
  models_dev_models: ModelsDevModelsTable;
  models_dev_fetch_state: ModelsDevFetchStateTable;
  model_enablements: ModelEnablementsTable;
  model_price_confirmations: ModelPriceConfirmationsTable;
  billing_journal_entries: BillingJournalEntriesTable;
  billing_balances: BillingBalancesTable;
  billing_profiles: BillingProfilesTable;
  billing_start_credit_grants: BillingStartCreditGrantsTable;
  billing_workspace_settings: BillingWorkspaceSettingsTable;
  billing_notifications: BillingNotificationsTable;
  billing_topup_intents: BillingTopupIntentsTable;
  billing_webhook_events: BillingWebhookEventsTable;
  password_reset_tokens: PasswordResetTokensTable;
  email_verification_tokens: EmailVerificationTokensTable;
  signed_states: SignedStatesTable;
  invitations: InvitationsTable;
  installation_link_requests: InstallationLinkRequestsTable;
  unclaimed_installations: UnclaimedInstallationsTable;
}
