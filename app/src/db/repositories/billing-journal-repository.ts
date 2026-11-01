// SPDX-License-Identifier: LicenseRef-Proprietary

// The balance journal of ONE workspace (tables `billing_journal_entries` and `billing_balances`; the factory takes the
// workspace id, see ../workspace-scope.ts; ADR 0006, 2.7; src/billing/README.md). One USD balance per workspace, in
// micro-USD integers, as the sum of an append-only journal; the balance row is a cache updated in the transaction of
// every entry, and `verify()` compares the two.
//
// Everything that writes runs in one transaction (the caller's, when it hands in a transaction) and is idempotent on the key `(workspace, type, ref_key)`: the same key with
// the same amount returns the entry that exists, with another amount it is `idempotency_conflict`. A `reserve` is the one
// conditional write, a hold of at most the balance: it takes the balance row's lock first (`FOR UPDATE`), answers a repeated job from the entry it wrote, and runs
// `UPDATE ... SET balance = balance - :hold WHERE balance >= :hold`, so two claims of one workspace can never spend the
// same money. Since #605 no claim takes a hold: a job's price is written when it ends, as one `usage` entry by `charge`,
// which takes the balance row's lock like every writer and, being keyed by the job, writes it once. `reserve`, `settle` and
// `release` remain for the holds an earlier release wrote: `settle` and `release` take the same lock before they read what a
// job has, so a settlement and a release of one job are decided one after the other and a voided job is never charged. Every
// other entry updates the balance unconditionally: a charge, a refund, a chargeback or a correction may take it below zero,
// and a balance below zero refuses every `reserve`. Every writer takes the balance row's lock before it writes anything,
// `append` included, so no two of them can wait for each other; `release` and `usage` are written only by `release()`,
// `settle()` and `charge()`.
//
// Entries are listed by `seq`, the order they were written in; `created_at` is a millisecond and not unique.
//
// Amounts are `bigint` columns: Postgres hands them back as text, so every one is converted with `Number` (exact up to
// 2^53 micro-USD, far beyond any balance). A row of another workspace is simply not there: a reversal names an entry of
// this workspace or it is `reversed_entry_not_found`, and a settlement names a reservation of this workspace.
import "server-only";
import { sql, type Kysely, type Selectable } from "kysely";
import {
  BillingJournalError,
  refKeyOf,
  requireAppendable,
  validateEntry,
  type BillingEntryType,
  type NewJournalEntry,
  type ReserveRefusal,
} from "../../billing/journal.ts";
import { noteBalanceMovedSafely } from "../../billing/balance-notifications.ts";
import { jobKindOf, type JobKind } from "../../job-kind/job-kind.ts";
import { formatTimestamp } from "../codecs.ts";
import { databaseDriver } from "../driver.ts";
import type { BillingJournalEntriesTable, Database } from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";
import { ENDED_JOB_STATUSES } from "./billing-holds-sweep.ts";

/** An entry as the rest of the app sees it. Amounts are micro-USD integers; timestamps are ISO 8601 text in UTC. */
export type JournalEntry = {
  /** The order entries were written in: unique, and the order `entries()` lists them in (`created_at` is a millisecond). */
  seq: number;
  id: string;
  workspaceId: string;
  type: BillingEntryType;
  amountMicroUsd: number;
  refKey: string;
  jobId: string | null;
  reviewKind: JobKind | null;
  minutes: number | null;
  aiMicroUsd: number | null;
  infraMicroUsd: number | null;
  reversesEntryId: string | null;
  provider: string | null;
  providerRef: string | null;
  actorUserId: string | null;
  note: string | null;
  createdAt: string;
};

/** Where a reader stopped: the next page starts before this `seq`, going back in time. */
export type JournalCursor = { seq: number };

export type JournalPage = {
  entries: JournalEntry[];
  /** The cursor of the next page, or undefined when this was the last one. */
  next: JournalCursor | undefined;
};

export type JournalBalance = {
  /** The sum of all entries: what the workspace may spend, already without the money held by running reviews. */
  balanceMicroUsd: number;
  /** Held by running reviews: the open reservations. */
  reservedMicroUsd: number;
};

/**
 * The cache against the journal. Differences are cache minus sum. A stranded hold (#591) is a `reservation` of a job that
 * has ended, whose usage record is no longer `reserved` (so nothing is left to settle it), and that has no `release`: money
 * held for a run that is over. A superseded run whose Worker still drains is not one. The cache and the journal agree about it, so only the
 * jobs show it; `consistent` is true when both differences are zero and no hold is stranded.
 */
export type JournalVerification = {
  balanceMicroUsd: number;
  expectedBalanceMicroUsd: number;
  differenceMicroUsd: number;
  reservedMicroUsd: number;
  expectedReservedMicroUsd: number;
  reservedDifferenceMicroUsd: number;
  strandedHoldCount: number;
  strandedHoldMicroUsd: number;
  consistent: boolean;
};

export type AppendResult = {
  entry: JournalEntry;
  /** False when the key existed already and its entry was returned. */
  created: boolean;
};

export type ReserveResult =
  | { ok: true; entry: JournalEntry; created: boolean }
  | {
      ok: false;
      code: ReserveRefusal;
      /** What the balance was when the hold was refused. */
      balanceMicroUsd: number;
    };

/** What a finished run cost: the two parts the customer sees, the started minutes and the kind of review. */
export type JobCharge = {
  aiMicroUsd: number;
  infraMicroUsd: number;
  minutes: number;
  reviewKind: JobKind;
};

export type SettleResult =
  | {
      ok: true;
      release: JournalEntry;
      /** Null when the run cost nothing: the hold is released and no usage is written. */
      usage: JournalEntry | null;
      /** True when this call wrote the charge (the usage; the release when there is no usage). False for a repeat. */
      created: boolean;
    }
  | { ok: false; code: "reservation_not_found" | "job_already_released" };

export type ChargeResult = { entry: JournalEntry; created: boolean };

export type ReleaseResult =
  | { ok: true; entry: JournalEntry; created: boolean }
  | { ok: false; code: "reservation_not_found" };

export type BillingJournalRepository = {
  /**
   * Appends an entry and updates the balance in the same transaction. Idempotent on `(type, key)`: the same key returns
   * the existing entry (`created: false`) and changes nothing; another amount under it throws `idempotency_conflict`.
   * Takes the balance row's lock first, like every writer. Throws `invalid_entry` for an entry that breaks a rule,
   * `reservation_required` for a `reservation` (only `reserve` may take a hold), `job_entry_required` for a `release` or
   * a `usage` (only `release()` and `settle()` write them), `reversed_entry_not_found` / `already_reversed` for a bad
   * reversal.
   */
  append(entry: NewJournalEntry): Promise<AppendResult>;
  /**
   * Takes a hold of `holdMicroUsd` for a job: a `reservation` entry and `balance -= hold, reserved += hold`, only when the
   * balance covers the hold. A refusal writes nothing and says why: `balance_negative` (a refund, chargeback or final
   * charge took it below zero: the workspace is blocked) or `insufficient_balance`. A repeated job returns its
   * reservation, whatever the balance is now, unless that was released already: `reservation_released`.
   */
  reserve(holdMicroUsd: number, jobId: string): Promise<ReserveResult>;
  /**
   * The price of a finished job (#605): one `usage` entry for the job, with no hold behind it. Takes the balance row's lock
   * first, may take the balance below zero, and is idempotent on the job: the same charge returns the entry that exists
   * (`created: false`), another one is `idempotency_conflict`. The caller decides that a charge is due (a run that is free
   * or prices to nothing writes nothing); a charge of zero is `invalid_entry`. For a job that holds an old reservation use
   * `settle`.
   */
  charge(jobId: string, charge: JobCharge): Promise<ChargeResult>;
  /**
   * Ends the hold of a job with its charge: a `release` of the whole hold and a `usage` of the charge, in one
   * transaction. A charge of zero writes only the release. Repeating it changes nothing; repeating it with other parts,
   * minutes or kind is `idempotency_conflict`. A job without a reservation, or one whose hold was released without a
   * charge (also by a release that commits at the same moment: both take the balance row's lock), answers with a code.
   */
  settle(jobId: string, charge: JobCharge): Promise<SettleResult>;
  /** Gives the hold of a job back without a charge (a job that never ran). Repeating it changes nothing. */
  release(jobId: string): Promise<ReleaseResult>;
  /**
   * Takes the balance row's lock (`FOR UPDATE`) and keeps it until the
   * transaction ends, for a caller that writes another table before it appends (the start credit's grants table, #507): the
   * rule is the lock first, then any write. A workspace without a balance row has nothing to lock.
   */
  lockBalance(): Promise<void>;
  /** The entry of this workspace with a type and key (a payment, a refund, a dispute, a job), or undefined (#497). */
  findByKey(
    type: BillingEntryType,
    refKey: string,
  ): Promise<JournalEntry | undefined>;
  /** The cached balance; a workspace without a row has 0 and 0. */
  balance(): Promise<JournalBalance>;
  /**
   * What this workspace was charged since `since` (ISO 8601, inclusive): the sum of its `usage` entries, AI plus
   * infrastructure, as a positive amount (#499, the monthly total limit). Top-ups, holds, releases and corrections are not
   * charges. Reads the journal and takes no lock: the claim that asks holds the gate lock of the queue.
   */
  chargedSince(since: string): Promise<number>;
  /**
   * The entries, newest first, `limit` at a time, after the cursor of the previous page. `excludeTypes` leaves entries of those
   * types out of the pages (the customer's journal does not list a hold or its release, #505); the cursor still walks the whole
   * journal, so a page is full whenever more entries follow.
   */
  entries(options: {
    cursor?: JournalCursor | undefined;
    limit: number;
    excludeTypes?: readonly BillingEntryType[] | undefined;
  }): Promise<JournalPage>;
  /**
   * Compares the cache with the sum of the journal and with its open reservations, and counts the holds of jobs that ended
   * without a release (#591).
   */
  verify(): Promise<JournalVerification>;
};

function toEntry(row: Selectable<BillingJournalEntriesTable>): JournalEntry {
  const amount = (value: number | null) =>
    value === null ? null : Number(value);
  return {
    seq: Number(row.seq),
    id: row.id,
    workspaceId: row.workspace_id,
    type: row.type as BillingEntryType,
    amountMicroUsd: Number(row.amount_micro_usd),
    refKey: row.ref_key,
    jobId: row.job_id,
    reviewKind: row.review_kind === null ? null : jobKindOf(row.review_kind),
    minutes: row.minutes,
    aiMicroUsd: amount(row.ai_micro_usd),
    infraMicroUsd: amount(row.infra_micro_usd),
    reversesEntryId: row.reverses_entry_id,
    provider: row.provider,
    providerRef: row.provider_ref,
    actorUserId: row.actor_user_id,
    note: row.note,
    createdAt: row.created_at,
  };
}

function inTransaction<T>(
  db: Kysely<Database>,
  run: (trx: Kysely<Database>) => Promise<T>,
): Promise<T> {
  return db.isTransaction ? run(db) : db.transaction().execute(run);
}

function sameCharge(existing: JournalEntry, entry: NewJournalEntry): boolean {
  return (
    existing.aiMicroUsd === (entry.aiMicroUsd ?? null) &&
    existing.infraMicroUsd === (entry.infraMicroUsd ?? null) &&
    existing.minutes === (entry.minutes ?? null) &&
    existing.reviewKind === (entry.reviewKind ?? null)
  );
}

/** The total of a charge, or `invalid_entry` when it is not made of non-negative integer parts of a job. */
function chargeTotal(jobId: string, charge: JobCharge): number {
  const total = charge.aiMicroUsd + charge.infraMicroUsd;
  const parts = [charge.aiMicroUsd, charge.infraMicroUsd];
  if (
    jobId === "" ||
    !Number.isSafeInteger(total) ||
    parts.some((part) => !Number.isSafeInteger(part) || part < 0)
  )
    throw new BillingJournalError(
      "invalid_entry",
      "a charge is made of non-negative integer parts",
    );
  return total;
}

function requireHold(holdMicroUsd: number, jobId: string): void {
  if (!Number.isSafeInteger(holdMicroUsd) || holdMicroUsd <= 0)
    throw new BillingJournalError(
      "invalid_entry",
      "a hold is a positive integer",
    );
  if (jobId === "")
    throw new BillingJournalError("invalid_entry", "a hold belongs to a job");
}

export function createBillingJournalRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  now: () => Date = () => new Date(),
  newId: () => string = () => crypto.randomUUID(),
): BillingJournalRepository {
  async function findEntry(
    trx: Kysely<Database>,
    type: BillingEntryType,
    refKey: string,
  ): Promise<JournalEntry | undefined> {
    const row = await trx
      .selectFrom("billing_journal_entries")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .where("type", "=", type)
      .where("ref_key", "=", refKey)
      .executeTakeFirst();
    return row === undefined ? undefined : toEntry(row);
  }

  async function findById(
    trx: Kysely<Database>,
    id: string,
  ): Promise<JournalEntry | undefined> {
    const row = await trx
      .selectFrom("billing_journal_entries")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", id)
      .executeTakeFirst();
    return row === undefined ? undefined : toEntry(row);
  }

  /** What a reversal must satisfy before it is written: it names an entry of this workspace, with the opposite amount. */
  async function checkReversal(
    trx: Kysely<Database>,
    entry: NewJournalEntry,
  ): Promise<void> {
    if (entry.reversesEntryId == null) return;
    const original = await findById(trx, entry.reversesEntryId);
    if (original === undefined)
      throw new BillingJournalError(
        "reversed_entry_not_found",
        "the entry to reverse is not in this workspace",
      );
    // A hold and its release move `reserved`; they end with the job, never by a correction.
    if (original.type === "reservation" || original.type === "release")
      throw new BillingJournalError(
        "invalid_entry",
        "a hold is released, not reversed",
      );
    if (entry.amountMicroUsd !== -original.amountMicroUsd)
      throw new BillingJournalError(
        "invalid_entry",
        "a reversal has the opposite amount of the entry it reverses",
      );
  }

  /** The hold a release gives back is the hold the job took: the reservation names the amount. */
  async function checkRelease(
    trx: Kysely<Database>,
    entry: NewJournalEntry,
  ): Promise<void> {
    if (entry.type !== "release") return;
    const reservation = await findEntry(trx, "reservation", refKeyOf(entry));
    if (reservation === undefined)
      throw new BillingJournalError(
        "reservation_not_found",
        "there is no hold to release",
      );
    if (entry.amountMicroUsd !== -reservation.amountMicroUsd)
      throw new BillingJournalError(
        "invalid_entry",
        "a release gives back the whole hold",
      );
  }

  /** Writes the row of an entry, or finds the one the key has; does not touch the balance. */
  async function writeEntry(
    trx: Kysely<Database>,
    entry: NewJournalEntry,
    timestamp: string,
  ): Promise<AppendResult> {
    validateEntry(entry);
    await checkReversal(trx, entry);
    await checkRelease(trx, entry);
    const refKey = refKeyOf(entry);
    // No conflict target: any unique index may refuse the row (the key, a second reversal), and none may raise.
    const inserted = await trx
      .insertInto("billing_journal_entries")
      .values({
        id: newId(),
        workspace_id: workspaceId,
        type: entry.type,
        amount_micro_usd: entry.amountMicroUsd,
        ref_key: refKey,
        job_id: entry.jobId ?? null,
        review_kind: entry.reviewKind ?? null,
        minutes: entry.minutes ?? null,
        ai_micro_usd: entry.aiMicroUsd ?? null,
        infra_micro_usd: entry.infraMicroUsd ?? null,
        reverses_entry_id: entry.reversesEntryId ?? null,
        provider: entry.provider ?? null,
        provider_ref: entry.providerRef ?? null,
        actor_user_id: entry.actorUserId ?? null,
        note: entry.note ?? null,
        created_at: timestamp,
      })
      .onConflict((conflict) => conflict.doNothing())
      .returningAll()
      .executeTakeFirst();
    if (inserted !== undefined)
      return { entry: toEntry(inserted), created: true };

    const existing = await findEntry(trx, entry.type, refKey);
    if (existing === undefined) {
      // Not the key, so the only other unique index that applies: the entry was reversed already.
      if (entry.reversesEntryId != null)
        throw new BillingJournalError(
          "already_reversed",
          "this entry was reversed already",
        );
      throw new Error(
        "The journal refused an entry for a reason that is not its key.",
      );
    }
    // A usage is also its parts, its minutes and its kind: the same total with other numbers is another charge.
    if (
      existing.amountMicroUsd !== entry.amountMicroUsd ||
      (entry.type === "usage" && !sameCharge(existing, entry))
    )
      throw new BillingJournalError(
        "idempotency_conflict",
        `${entry.type} ${refKey} exists with another amount`,
      );
    return { entry: existing, created: false };
  }

  /** The cache follows an entry that was just written: `balance += amount`, and the holds follow reservations and releases. */
  async function applyToBalanceRow(
    trx: Kysely<Database>,
    entry: JournalEntry,
    timestamp: string,
  ): Promise<void> {
    const holds =
      entry.type === "reservation" || entry.type === "release"
        ? -entry.amountMicroUsd
        : 0;
    const addToRow = async () =>
      (await trx
        .updateTable("billing_balances")
        .set((eb) => ({
          balance_micro_usd: eb("balance_micro_usd", "+", entry.amountMicroUsd),
          reserved_micro_usd: eb("reserved_micro_usd", "+", holds),
          updated_at: timestamp,
        }))
        .where("workspace_id", "=", workspaceId)
        .returning("workspace_id")
        .executeTakeFirst()) !== undefined;
    // Not one upsert: Postgres checks the row it would insert (`reserved >= 0`) before it looks for the conflict, and a
    // release brings `reserved` down. The first entry of a workspace creates the row; a second one racing it adds to it.
    if (await addToRow()) return;
    const created = await trx
      .insertInto("billing_balances")
      .values({
        workspace_id: workspaceId,
        balance_micro_usd: entry.amountMicroUsd,
        reserved_micro_usd: holds,
        updated_at: timestamp,
      })
      .onConflict((conflict) => conflict.doNothing())
      .returning("workspace_id")
      .executeTakeFirst();
    if (created === undefined && !(await addToRow()))
      throw new Error(
        "The balance row of a workspace could be neither added to nor created.",
      );
  }

  /**
   * The balance follows an entry, and then, under the lock of its row, whether the workspace is to be told is decided in the
   * same transaction (#506; src/billing/balance-notifications.ts). Nothing is sent from here.
   */
  async function applyToBalance(
    trx: Kysely<Database>,
    entry: JournalEntry,
    timestamp: string,
  ): Promise<void> {
    await applyToBalanceRow(trx, entry, timestamp);
    await noteBalanceMovedSafely(trx, {
      workspaceId,
      move: entry.amountMicroUsd < 0 ? "down" : "up",
      now,
    });
  }

  async function appendIn(
    trx: Kysely<Database>,
    entry: NewJournalEntry,
    timestamp: string,
  ): Promise<AppendResult> {
    const written = await writeEntry(trx, entry, timestamp);
    if (written.created) await applyToBalance(trx, written.entry, timestamp);
    return written;
  }

  /** The balance row, locked on Postgres until the transaction ends; undefined for a workspace with no entry yet. */
  async function lockBalance(
    trx: Kysely<Database>,
  ): Promise<JournalBalance | undefined> {
    let query = trx
      .selectFrom("billing_balances")
      .select(["balance_micro_usd", "reserved_micro_usd"])
      .where("workspace_id", "=", workspaceId);
    if (databaseDriver(trx) === "postgres") query = query.forUpdate();
    const row = await query.executeTakeFirst();
    return row === undefined
      ? undefined
      : {
          balanceMicroUsd: Number(row.balance_micro_usd),
          reservedMicroUsd: Number(row.reserved_micro_usd),
        };
  }

  /** The conditional write of a hold, under the balance row's lock: the balance must cover it, or nothing is written. */
  async function takeHold(
    trx: Kysely<Database>,
    holdMicroUsd: number,
    jobId: string,
    current: JournalBalance | undefined,
    timestamp: string,
  ): Promise<ReserveResult> {
    const held = await trx
      .updateTable("billing_balances")
      .set((eb) => ({
        balance_micro_usd: eb("balance_micro_usd", "-", holdMicroUsd),
        reserved_micro_usd: eb("reserved_micro_usd", "+", holdMicroUsd),
        updated_at: timestamp,
      }))
      .where("workspace_id", "=", workspaceId)
      .where("balance_micro_usd", ">=", holdMicroUsd)
      .returning("workspace_id")
      .executeTakeFirst();
    if (held === undefined) {
      const balanceMicroUsd = current?.balanceMicroUsd ?? 0;
      return {
        ok: false,
        code: balanceMicroUsd < 0 ? "balance_negative" : "insufficient_balance",
        balanceMicroUsd,
      };
    }
    const written = await writeEntry(
      trx,
      {
        type: "reservation",
        amountMicroUsd: -holdMicroUsd,
        jobId,
        refKey: jobId,
      },
      timestamp,
    );
    return { ok: true, entry: written.entry, created: written.created };
  }

  /**
   * The answer for a job that has a reservation already: the reservation, unchanged, while it is held. Once it was
   * released (the job ended free or was settled) nothing is held any more, so it is `reservation_released` and never
   * `ok`: a retry must not run on a hold that is gone (the contract for #498 is in src/billing/README.md).
   */
  async function reservationOf(
    trx: Kysely<Database>,
    reservation: JournalEntry,
    current: JournalBalance | undefined,
  ): Promise<ReserveResult> {
    const released = await findEntry(trx, "release", reservation.refKey);
    if (released !== undefined)
      return {
        ok: false,
        code: "reservation_released",
        balanceMicroUsd: current?.balanceMicroUsd ?? 0,
      };
    return { ok: true, entry: reservation, created: false };
  }

  async function readBalance(): Promise<JournalBalance> {
    const row = await db
      .selectFrom("billing_balances")
      .select(["balance_micro_usd", "reserved_micro_usd"])
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirst();
    return {
      balanceMicroUsd: Number(row?.balance_micro_usd ?? 0),
      reservedMicroUsd: Number(row?.reserved_micro_usd ?? 0),
    };
  }

  return {
    async lockBalance() {
      await inTransaction(db, async (trx) => {
        await lockBalance(trx);
      });
    },

    async append(entry) {
      requireAppendable(entry);
      const timestamp = formatTimestamp(now());
      return inTransaction(db, async (trx) => {
        // The balance row first, like every other writer: the entry's row is written after the lock, never before it.
        await lockBalance(trx);
        return appendIn(trx, entry, timestamp);
      });
    },

    async reserve(holdMicroUsd, jobId) {
      requireHold(holdMicroUsd, jobId);
      const timestamp = formatTimestamp(now());
      return inTransaction(db, async (trx): Promise<ReserveResult> => {
        const current = await lockBalance(trx);
        const existing = await findEntry(trx, "reservation", jobId);
        if (existing !== undefined) {
          if (existing.amountMicroUsd !== -holdMicroUsd)
            throw new BillingJournalError(
              "idempotency_conflict",
              `reservation ${jobId} exists with another amount`,
            );
          return reservationOf(trx, existing, current);
        }
        return takeHold(trx, holdMicroUsd, jobId, current, timestamp);
      });
    },

    async charge(jobId, charge) {
      const total = chargeTotal(jobId, charge);
      if (total === 0)
        throw new BillingJournalError(
          "invalid_entry",
          "a charge is more than zero",
        );
      const timestamp = formatTimestamp(now());
      return inTransaction(db, async (trx): Promise<ChargeResult> => {
        await lockBalance(trx);
        const usage = await appendIn(
          trx,
          {
            type: "usage",
            amountMicroUsd: -total,
            jobId,
            refKey: jobId,
            reviewKind: charge.reviewKind,
            minutes: charge.minutes,
            aiMicroUsd: charge.aiMicroUsd,
            infraMicroUsd: charge.infraMicroUsd,
          },
          timestamp,
        );
        return { entry: usage.entry, created: usage.created };
      });
    },

    async settle(jobId, charge) {
      const total = chargeTotal(jobId, charge);
      const timestamp = formatTimestamp(now());
      return inTransaction(db, async (trx): Promise<SettleResult> => {
        // The lock a release takes as well: what the job has (a release, a usage) is read after any other writer of the
        // job has committed, so a settlement never charges a job a release has voided.
        await lockBalance(trx);
        const reservation = await findEntry(trx, "reservation", jobId);
        if (reservation === undefined)
          return { ok: false, code: "reservation_not_found" };
        const released = await findEntry(trx, "release", jobId);
        const charged = await findEntry(trx, "usage", jobId);
        // Voided before: the hold went back and the run was not billed. A late settlement is not a second life.
        if (released !== undefined && charged === undefined && total > 0)
          return { ok: false, code: "job_already_released" };
        if (total === 0 && charged !== undefined)
          throw new BillingJournalError(
            "idempotency_conflict",
            `usage ${jobId} exists with another amount`,
          );
        const release = await appendIn(
          trx,
          {
            type: "release",
            amountMicroUsd: -reservation.amountMicroUsd,
            jobId,
            refKey: jobId,
          },
          timestamp,
        );
        const usage =
          total === 0
            ? null
            : await appendIn(
                trx,
                {
                  type: "usage",
                  amountMicroUsd: -total,
                  jobId,
                  refKey: jobId,
                  reviewKind: charge.reviewKind,
                  minutes: charge.minutes,
                  aiMicroUsd: charge.aiMicroUsd,
                  infraMicroUsd: charge.infraMicroUsd,
                },
                timestamp,
              );
        return {
          ok: true,
          release: release.entry,
          usage: usage?.entry ?? null,
          created: usage?.created ?? release.created,
        };
      });
    },

    async release(jobId) {
      if (jobId === "")
        throw new BillingJournalError(
          "invalid_entry",
          "a release belongs to a job",
        );
      const timestamp = formatTimestamp(now());
      return inTransaction(db, async (trx): Promise<ReleaseResult> => {
        await lockBalance(trx); // see settle
        const reservation = await findEntry(trx, "reservation", jobId);
        if (reservation === undefined)
          return { ok: false, code: "reservation_not_found" };
        const release = await appendIn(
          trx,
          {
            type: "release",
            amountMicroUsd: -reservation.amountMicroUsd,
            jobId,
            refKey: jobId,
          },
          timestamp,
        );
        return { ok: true, entry: release.entry, created: release.created };
      });
    },

    findByKey: (type, refKey) => findEntry(db, type, refKey),

    balance: readBalance,

    async chargedSince(since) {
      const row = await db
        .selectFrom("billing_journal_entries")
        .select((eb) => eb.fn.sum("amount_micro_usd").as("total"))
        .where("workspace_id", "=", workspaceId)
        .where("type", "=", "usage")
        .where("created_at", ">=", since)
        .executeTakeFirst();
      // A usage entry is a debit: the amount is negative. Postgres hands a sum back as text.
      return -Number(row?.total ?? 0) || 0;
    },

    async entries({ cursor, limit, excludeTypes }) {
      let query = db
        .selectFrom("billing_journal_entries")
        .selectAll()
        .where("workspace_id", "=", workspaceId);
      if (cursor !== undefined) query = query.where("seq", "<", cursor.seq);
      if (excludeTypes !== undefined && excludeTypes.length > 0)
        query = query.where("type", "not in", [...excludeTypes]);
      // One more than the page, to know whether another page follows.
      const rows = await query
        .orderBy("seq", "desc")
        .limit(limit + 1)
        .execute();
      const entries = rows.slice(0, limit).map(toEntry);
      const last = entries.at(-1);
      return {
        entries,
        next:
          rows.length > limit && last !== undefined
            ? { seq: last.seq }
            : undefined,
      };
    },

    async verify() {
      // One statement, so one snapshot: an entry that commits between two reads would show as drift.
      const { rows } = await sql<{
        balance: string | number | null;
        reserved: string | number | null;
        cached_balance: string | number | null;
        cached_reserved: string | number | null;
        stranded_count: string | number | null;
        stranded_micro: string | number | null;
      }>`
        select
          sums.balance,
          sums.reserved,
          cache.balance_micro_usd as cached_balance,
          cache.reserved_micro_usd as cached_reserved,
          stranded.stranded_count,
          stranded.stranded_micro
        from (
          select
            sum(amount_micro_usd) as balance,
            sum(case when type in ('reservation', 'release') then -amount_micro_usd else 0 end) as reserved
          from billing_journal_entries
          where workspace_id = ${workspaceId}
        ) as sums
        left join billing_balances as cache on cache.workspace_id = ${workspaceId}
        cross join (
          select
            count(*) as stranded_count,
            coalesce(sum(-r.amount_micro_usd), 0) as stranded_micro
          from billing_journal_entries as r
          join jobs as j on j.id = r.ref_key and j.workspace_id = r.workspace_id
          where r.workspace_id = ${workspaceId}
            and r.type = 'reservation'
            and j.status in (${sql.join([...ENDED_JOB_STATUSES])})
            and not exists (
              select 1 from usage_records as u
              where u.job_id = j.id and u.state = 'reserved'
            )
            and not exists (
              select 1 from billing_journal_entries as l
              where l.workspace_id = r.workspace_id
                and l.type = 'release'
                and l.ref_key = r.ref_key
            )
        ) as stranded`.execute(db);
      const expectedBalanceMicroUsd = Number(rows[0]?.balance ?? 0);
      const expectedReservedMicroUsd = Number(rows[0]?.reserved ?? 0);
      const cached = {
        balanceMicroUsd: Number(rows[0]?.cached_balance ?? 0),
        reservedMicroUsd: Number(rows[0]?.cached_reserved ?? 0),
      };
      const differenceMicroUsd =
        cached.balanceMicroUsd - expectedBalanceMicroUsd;
      const reservedDifferenceMicroUsd =
        cached.reservedMicroUsd - expectedReservedMicroUsd;
      const strandedHoldCount = Number(rows[0]?.stranded_count ?? 0);
      const strandedHoldMicroUsd = Number(rows[0]?.stranded_micro ?? 0);
      return {
        balanceMicroUsd: cached.balanceMicroUsd,
        expectedBalanceMicroUsd,
        differenceMicroUsd,
        reservedMicroUsd: cached.reservedMicroUsd,
        expectedReservedMicroUsd,
        reservedDifferenceMicroUsd,
        strandedHoldCount,
        strandedHoldMicroUsd,
        consistent:
          differenceMicroUsd === 0 &&
          reservedDifferenceMicroUsd === 0 &&
          strandedHoldCount === 0,
      };
    },
  };
}
