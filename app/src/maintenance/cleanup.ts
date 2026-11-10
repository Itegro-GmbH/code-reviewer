// SPDX-License-Identifier: LicenseRef-Proprietary

// Removes rows nobody needs any more, so tables that an outsider can make grow stay small: the counters of
// `rate_limits` (one per address, link or account that was ever counted), the verification links and the
// reset links that expired or were used. Nothing that still has an effect is removed.
//
// - A counter is removed once its window is over, and every window of the app is at most 24 hours
//   (`LONGEST_RATE_LIMIT_WINDOW_MS`, pinned by the test against every window constant), so no counter in
//   force is ever removed and no limit starts early.
// - A signed state (the single-use side of the round trips through GitHub) is removed once it has expired.
// - A sign-up that was never verified is removed a week after its first verification link was made (and at
//   the earliest a week after the sign-up; more links do not postpone it), together with its password account, its links and its reset
//   links (they cascade). Only a plain pending sign-up qualifies: see `expireUnverifiedAccounts`.
// - A verification link is kept for a week after it expired or was used, so that someone who holds it
//   (and its password) is told "used" or "expired" and not just "not valid". After that it is gone.
// - The LLM key that was handed to a runner with the claim of a job (`job_claimed_keys`, encrypted) is kept
//   for a week after the job finished, as long as a late or repeated report of the job can still need it to
//   mask the key in its result. After that it is gone: a key that was rotated away does not stay in the
//   database for ever. (The row also goes with its job.)
// - The row of the dispatch webhook of a job (`job_dispatches`, #326) is kept for a week after the job
//   finished, for whoever asks why a review started late, and then removed. A queued or running job keeps its row.
// - A handoff token of "Manage plan" (`plan_handoff_tokens`, #284) is valid for five minutes; its row is kept a day
//   after it expired, then removed (not counted in the result, like a signed state).
import type { Kysely } from "kysely";
import { CREDENTIAL_PROVIDER_ID } from "../auth/session-user.ts";
import { formatTimestamp } from "../db/codecs.ts";
import { createJobClaimedKeysRepository } from "../db/repositories/job-claimed-keys-repository.ts";
import { createJobDispatchesRepository } from "../db/repositories/job-dispatches-repository.ts";
import { createRunnerDispatchesRepository } from "../db/repositories/runner-dispatches-repository.ts";
import { createPlanHandoffRedeemRepository } from "../db/repositories/plan-handoff-redeem-repository.ts";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import type { Database } from "../db/schema.ts";

export const LONGEST_RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const VERIFICATION_TOKEN_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** A reset link is kept as long, for the same reason: a hash that is still known answers "used" or "expired". */
export const PASSWORD_RESET_TOKEN_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long an email and password sign-up may wait for its address to be verified. After that the account
 * is removed and the address is free for a new sign-up. Longer than the 24 hours a link is valid, so the
 * owner of the address has days to use a link, and as long as the links are kept (the week above).
 */
export const UNVERIFIED_ACCOUNT_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** How long the key of a finished job is kept: a late report of the job can still be masked. */
export const JOB_CLAIMED_KEY_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** How long the dispatch row of a finished job is kept: it only tells how the call to the Dispatcher went. */
export const JOB_DISPATCH_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** How long a handoff token is kept after it expired: nothing reads it by then, it only keeps the table small. */
export const PLAN_HANDOFF_TOKEN_KEEP_MS = 24 * 60 * 60 * 1000;

export type CleanupResult = {
  rateLimits: number;
  unverifiedAccounts: number;
  verificationTokens: number;
  passwordResetTokens: number;
  jobClaimedKeys: number;
  jobDispatches: number;
};

async function canVerifyByMail(
  mailConfigured: CleanupOptions["mailConfigured"],
): Promise<boolean> {
  if (mailConfigured === undefined) return false;
  try {
    return await mailConfigured();
  } catch {
    return false;
  }
}

export type CleanupOptions = {
  /**
   * Whether the instance can verify addresses by mail right now. Unverified accounts are removed only
   * when it can: without a mail server nothing can be verified and every email and password account is
   * usable unverified. A failing check counts as "no". Not given: no account is removed.
   */
  mailConfigured?: () => Promise<boolean>;
};

/**
 * Removes the email and password sign-ups that never verified their address. Only a sign-up that
 * - is not verified, is not the instance admin and was not imported,
 * - has a password account and no other identity (no GitHub),
 * - belongs to no workspace and has no session,
 * - was sent a verification link (the person was asked to verify), the first one more than the keep time
 *   ago (an account that is asked to verify now, for instance after a mail server was configured, gets the
 *   whole week; asking for more links later does not extend it),
 * - and was made more than the keep time ago.
 * Their rows in `accounts`, `email_verification_tokens`, `password_reset_tokens` and `signed_states` go
 * with them (`on delete cascade`). Runs before the links are cleaned up. A link is kept 24 hours of validity plus a
 * week, so the first link is still there when the account is a week old (pinned by a test).
 */
async function expireUnverifiedAccounts(
  db: Kysely<Database>,
  now: Date,
): Promise<number> {
  const cutoff = formatTimestamp(
    new Date(now.getTime() - UNVERIFIED_ACCOUNT_KEEP_MS),
  );
  const result = await db
    .deleteFrom("users")
    .where("email_verified", "=", 0)
    .where("is_instance_admin", "=", 0)
    .where("imported_at", "is", null)
    .where("created_at", "<", cutoff)
    .where((eb) =>
      eb.and([
        eb.exists(
          eb
            .selectFrom("accounts")
            .select("accounts.id")
            .whereRef("accounts.user_id", "=", "users.id")
            .where("accounts.provider_id", "=", CREDENTIAL_PROVIDER_ID),
        ),
        eb.not(
          eb.exists(
            eb
              .selectFrom("accounts")
              .select("accounts.id")
              .whereRef("accounts.user_id", "=", "users.id")
              .where("accounts.provider_id", "<>", CREDENTIAL_PROVIDER_ID),
          ),
        ),
        eb.not(
          eb.exists(
            eb
              .selectFrom("workspace_members")
              .select("workspace_members.user_id")
              .whereRef("workspace_members.user_id", "=", "users.id"),
          ),
        ),
        eb.not(
          eb.exists(
            eb
              .selectFrom("sessions")
              .select("sessions.id")
              .whereRef("sessions.user_id", "=", "users.id"),
          ),
        ),
        // The first verification link was made more than the keep time ago. Anchored on the first link, not
        // the latest one: asking for a new link (the resend is public) must not postpone the removal.
        eb.exists(
          eb
            .selectFrom("email_verification_tokens")
            .select("email_verification_tokens.token_hash")
            .whereRef("email_verification_tokens.user_id", "=", "users.id")
            .where("email_verification_tokens.created_at", "<", cutoff),
        ),
      ]),
    )
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}

export async function cleanUpExpiredRows(
  db: Kysely<Database>,
  now: () => Date = () => new Date(),
  { mailConfigured }: CleanupOptions = {},
): Promise<CleanupResult> {
  const unverifiedAccounts = (await canVerifyByMail(mailConfigured))
    ? await expireUnverifiedAccounts(db, now())
    : 0;
  const rateLimits = await createRateLimitsRepository(db, now).deleteExpired(
    LONGEST_RATE_LIMIT_WINDOW_MS,
  );
  const cutoff = formatTimestamp(
    new Date(now().getTime() - VERIFICATION_TOKEN_KEEP_MS),
  );
  const tokens = await db
    .deleteFrom("email_verification_tokens")
    .where((eb) =>
      eb.or([eb("expires_at", "<=", cutoff), eb("used_at", "<=", cutoff)]),
    )
    .executeTakeFirst();
  const resetCutoff = formatTimestamp(
    new Date(now().getTime() - PASSWORD_RESET_TOKEN_KEEP_MS),
  );
  const resets = await db
    .deleteFrom("password_reset_tokens")
    .where((eb) =>
      eb.or([
        eb("expires_at", "<=", resetCutoff),
        eb("used_at", "<=", resetCutoff),
      ]),
    )
    .executeTakeFirst();
  // A signed state lives ten minutes; one that has expired is of no use to anyone (not counted in the result).
  await db
    .deleteFrom("signed_states")
    .where("expires_at", "<=", formatTimestamp(now()))
    .execute();
  await createPlanHandoffRedeemRepository(db, now).deleteExpiredBefore(
    new Date(now().getTime() - PLAN_HANDOFF_TOKEN_KEEP_MS),
  );
  const jobClaimedKeys = await createJobClaimedKeysRepository(
    db,
    now,
  ).deleteFinishedBefore(new Date(now().getTime() - JOB_CLAIMED_KEY_KEEP_MS));
  const dispatchCutoff = new Date(now().getTime() - JOB_DISPATCH_KEEP_MS);
  const jobDispatches =
    (await createJobDispatchesRepository(db, now).deleteFinishedBefore(
      dispatchCutoff,
    )) +
    // #972: the rows of the doorbells to customers' webhook dispatchers are kept as long.
    (await createRunnerDispatchesRepository(db, now).deleteFinishedBefore(
      dispatchCutoff,
    ));
  return {
    rateLimits,
    unverifiedAccounts,
    verificationTokens: Number(tokens.numDeletedRows),
    passwordResetTokens: Number(resets.numDeletedRows),
    jobClaimedKeys,
    jobDispatches,
  };
}
