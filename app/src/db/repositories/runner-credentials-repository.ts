// SPDX-License-Identifier: LicenseRef-Proprietary

// What happens to a runner before its workspace is known (#854): the exchange of a registration token for a runner, and the lookup of
// a runner by its credential on every call it makes. Instance level on purpose (`scoping.test.ts`): the caller holds only a secret,
// and the answer names the workspace, which is where everything that follows goes. It never lists. A token that is unknown, used or
// expired is one refusal, so the answer says nothing about which. Every change two callers could make at the same moment is ONE
// statement with its condition in the WHERE clause (the token is used by `update ... where used_at is null`, so two runners racing
// for it cannot both win).
import "server-only";
import { sql, type Kysely } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import type { Database } from "../schema.ts";
import {
  labelsToText,
  type Announcement,
} from "../../runner-identity/announcement.ts";
import { runnerFrom, type StoredRunner } from "./runners-repository.ts";

export type NewRunner = Announcement & {
  name: string;
  credentialHash: string;
};

export type RedeemOutcome =
  { ok: true; runner: StoredRunner } | { ok: false; reason: "invalid_token" };

export type RunnerCredentialsRepository = {
  /** Uses the token (once) and makes the runner of its workspace. */
  redeem(tokenHash: string, runner: NewRunner): Promise<RedeemOutcome>;
  /**
   * The runner of a credential, seen now: the credential of a revoked runner finds nothing. A renewal's previous credential works until
   * the new one is used once, and using the new one retires it.
   */
  authenticate(credentialHash: string): Promise<StoredRunner | undefined>;
  /** What the runner says about itself now (its configuration lives on its machine). False when it was revoked meanwhile. */
  announce(runnerId: string, announcement: Announcement): Promise<boolean>;
  /** A credential for the runner that presented `presentedHash`; the previous one stays valid until the new one is used. */
  renew(
    runnerId: string,
    presentedHash: string,
    newHash: string,
  ): Promise<boolean>;
};

export function createRunnerCredentialsRepository(
  db: Kysely<Database>,
  options: { now?: () => Date; newId?: () => string } = {},
): RunnerCredentialsRepository {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => crypto.randomUUID());

  return {
    redeem(tokenHash, runner) {
      return db.transaction().execute(async (trx): Promise<RedeemOutcome> => {
        const timestamp = formatTimestamp(now());
        const id = newId();
        const used = await trx
          .updateTable("runner_registration_tokens")
          .set({ used_at: timestamp, runner_id: id })
          .where("token_hash", "=", tokenHash)
          .where("used_at", "is", null)
          .where("expires_at", ">", timestamp)
          .returning("workspace_id")
          .executeTakeFirst();
        if (used === undefined) return { ok: false, reason: "invalid_token" };
        // The runner row exists in the same transaction as the use of the token: a token never goes without a runner.
        const row = await trx
          .insertInto("runners")
          .values({
            id,
            workspace_id: used.workspace_id,
            name: runner.name,
            labels: labelsToText(runner.labels),
            base_version: runner.baseVersion,
            manifest: JSON.stringify(runner.manifest),
            limits: JSON.stringify(runner.limits),
            credential_hash: runner.credentialHash,
            previous_credential_hash: null,
            created_at: timestamp,
            last_seen_at: timestamp,
            revoked_at: null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        return { ok: true, runner: runnerFrom(row) };
      });
    },

    async authenticate(credentialHash) {
      const row = await db
        .updateTable("runners")
        .set({
          last_seen_at: formatTimestamp(now()),
          // The first call with the new credential retires the one it replaced.
          previous_credential_hash: sql<
            string | null
          >`case when credential_hash = ${credentialHash} then null else previous_credential_hash end`,
        })
        .where((eb) =>
          eb.or([
            eb("credential_hash", "=", credentialHash),
            eb("previous_credential_hash", "=", credentialHash),
          ]),
        )
        .where("revoked_at", "is", null)
        .returningAll()
        .executeTakeFirst();
      return row === undefined ? undefined : runnerFrom(row);
    },

    async announce(runnerId, announcement) {
      const result = await db
        .updateTable("runners")
        .set({
          labels: labelsToText(announcement.labels),
          base_version: announcement.baseVersion,
          manifest: JSON.stringify(announcement.manifest),
          limits: JSON.stringify(announcement.limits),
        })
        .where("id", "=", runnerId)
        .where("revoked_at", "is", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },

    // The previous credential may renew too, so that a renewal whose answer was lost locks nobody out. The price, accepted: until the
    // new credential is first used, whoever holds a leaked previous one can renew as well (and lock the runner out). Revoking the
    // runner in the app ends both at once.
    async renew(runnerId, presentedHash, newHash) {
      const result = await db
        .updateTable("runners")
        .set({
          previous_credential_hash: presentedHash,
          credential_hash: newHash,
        })
        .where("id", "=", runnerId)
        .where("revoked_at", "is", null)
        .where((eb) =>
          eb.or([
            eb("credential_hash", "=", presentedHash),
            eb("previous_credential_hash", "=", presentedHash),
          ]),
        )
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },
  };
}
