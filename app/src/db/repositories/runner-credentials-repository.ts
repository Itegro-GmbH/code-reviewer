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

/** #972: a key the app made for the delivery of one runner: the secret is shown once, the database keeps only `sealed`. */
export type MintedDeliveryKey = {
  keyId: string;
  secret: string;
  /** The secret as the database keeps it (`sealDeliverySecret`). */
  sealed: string;
};

/** What the app holds of a runner's delivery. The secret is present only in the answer of the call that made it. */
export type StoredDelivery =
  | { mode: "poll" }
  | { mode: "webhook"; url: string; keyId: string; secret?: string };

export type DeliveryChange =
  | { mode: "poll" }
  | {
      mode: "webhook";
      url: string;
      /** A new secret even when one exists. */
      rotateSecret: boolean;
      /** Makes the key, asked for only when there is none or a new one is wanted. */
      mintKey: () => MintedDeliveryKey;
    };

export type NewRunner = Announcement & {
  name: string;
  credentialHash: string;
  /** #972: the id of the runner when its sealed secret has to be bound to it before the row exists. */
  id?: string;
  /** #972: the webhook delivery announced with the registration; the runner polls without it. */
  delivery?: { url: string; key: MintedDeliveryKey };
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
  /**
   * #972: how the runner learns of a job now. `poll` drops the address, the key id and the sealed secret. `webhook` keeps the secret that
   * exists, unless a new one is asked for or there is none, in which case it makes one: the secret is in the answer of that call and in
   * no other. Undefined when the runner was revoked meanwhile.
   */
  setDelivery(
    runnerId: string,
    change: DeliveryChange,
  ): Promise<StoredDelivery | undefined>;
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
        const id = runner.id ?? newId();
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
            ...(runner.delivery === undefined
              ? {}
              : {
                  delivery_mode: "webhook",
                  delivery_url: runner.delivery.url,
                  delivery_key_id: runner.delivery.key.keyId,
                  delivery_secret: runner.delivery.key.sealed,
                }),
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

    async setDelivery(runnerId, change) {
      return db.transaction().execute(async (trx) => {
        // Two announcements of one runner at the same moment take turns: the second sees the secret the first made.
        const current = await trx
          .selectFrom("runners")
          .select(["delivery_secret", "delivery_key_id"])
          .where("id", "=", runnerId)
          .where("revoked_at", "is", null)
          .forUpdate()
          .executeTakeFirst();
        if (current === undefined) return undefined;
        if (change.mode === "poll") {
          await trx
            .updateTable("runners")
            .set({
              delivery_mode: "poll",
              delivery_url: null,
              delivery_key_id: null,
              delivery_secret: null,
            })
            .where("id", "=", runnerId)
            .execute();
          return { mode: "poll" };
        }
        const keep =
          !change.rotateSecret &&
          current.delivery_secret !== null &&
          current.delivery_key_id !== null;
        const minted = keep ? undefined : change.mintKey();
        const keyId = minted?.keyId ?? (current.delivery_key_id as string);
        await trx
          .updateTable("runners")
          .set({
            delivery_mode: "webhook",
            delivery_url: change.url,
            delivery_key_id: keyId,
            ...(minted === undefined ? {} : { delivery_secret: minted.sealed }),
          })
          .where("id", "=", runnerId)
          .execute();
        return {
          mode: "webhook",
          url: change.url,
          keyId,
          ...(minted === undefined ? {} : { secret: minted.secret }),
        };
      });
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
