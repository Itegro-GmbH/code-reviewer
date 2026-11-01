// SPDX-License-Identifier: LicenseRef-Proprietary

// The data of the billing page of a workspace (ADR 0006, 2.5; #505), for the code that serves a person: the balance, what
// running reviews hold, the journal page by page, the payments that are still pending, and, for an Owner and an Admin
// (`manage_billing`), the billing profile, the monthly limit and what this UTC month has cost. A Member reads the balance and
// the journal and nothing else. Only FINAL prices leave: a charge is its AI price and its infrastructure price; no rate, no
// minute count, no reference, no note and no provider does (`src/workspace-billing/view.ts`). The first contact grants the start
// credit before the balance is read (#507), so the page never shows a workspace without it.
//
// Billing off is the route's and the page's business (`guardBillingRoute`, `isBillingOn`): nothing here is reached then, and
// the start credit asks the switch again. A person's workspace is the actor's; nothing in a query names another one.
import "server-only";
import type { Kysely } from "kysely";
import {
  createBillingJournalRepository,
  type JournalEntry,
} from "../db/repositories/billing-journal-repository.ts";
import { createBillingTopUpIntentsRepository } from "../db/repositories/billing-topup-intents-repository.ts";
import type { Database } from "../db/schema.ts";
import { can } from "../workspaces/permissions.ts";
import {
  JOURNAL_ROW_KINDS,
  type BalanceState,
  type BillingProfileFormView,
  type JournalPageView,
  type JournalRowKind,
  type JournalRowView,
  type PendingTopUpView,
  type WorkspaceBillingView,
  type WorkspaceKeyMode,
} from "../workspace-billing/view.ts";
import type { BillingAdapter } from "./adapter.ts";
import { utcMonthStart } from "./claim-caps.ts";
import { createMonthlyLimitService } from "./monthly-limit-service.ts";
import {
  createBillingProfileService,
  type BillingActor,
} from "./profile-service.ts";
import { ensureStartCredit } from "./start-credit.ts";

export const WORKSPACE_BILLING_ERROR_CODES = [
  "forbidden",
  "journal_query_invalid",
] as const;
export type WorkspaceBillingErrorCode =
  (typeof WORKSPACE_BILLING_ERROR_CODES)[number];

/** The journal page a person gets without asking for a size, and the most they may ask for. */
export const JOURNAL_PAGE_SIZE = 25;
export const JOURNAL_PAGE_MAX = 50;
/** The most pending payments the page lists. */
const PENDING_TOP_UPS_LIMIT = 20;

/** The entries a customer does not read: an old hold and the release that gives it back (it is a charge's detail, not a row). */
const HIDDEN_TYPES = ["reservation", "release"] as const;

export type JournalQuery = {
  /** The cursor of the previous page (opaque text), or none for the first page. */
  cursor?: unknown;
  /** How many rows, a whole number from 1 to `JOURNAL_PAGE_MAX`; none for the default. */
  limit?: unknown;
};

export type WorkspaceBillingService = {
  overview(
    actor: BillingActor,
  ): Promise<
    { ok: true; view: WorkspaceBillingView } | { ok: false; error: "forbidden" }
  >;
  journal(
    actor: BillingActor,
    query: JournalQuery,
  ): Promise<
    | { ok: true; page: JournalPageView }
    | { ok: false; error: "forbidden" | "journal_query_invalid" }
  >;
};

const CURSOR = /^[1-9]\d{0,14}$/;

function readQuery(
  query: JournalQuery,
): { cursor: number | undefined; limit: number } | undefined {
  let cursor: number | undefined;
  if (query.cursor !== undefined && query.cursor !== null) {
    if (typeof query.cursor !== "string" || !CURSOR.test(query.cursor))
      return undefined;
    cursor = Number(query.cursor);
  }
  let limit = JOURNAL_PAGE_SIZE;
  if (query.limit !== undefined && query.limit !== null) {
    const asNumber =
      typeof query.limit === "string" && /^\d{1,3}$/.test(query.limit)
        ? Number(query.limit)
        : query.limit;
    if (
      typeof asNumber !== "number" ||
      !Number.isInteger(asNumber) ||
      asNumber < 1 ||
      asNumber > JOURNAL_PAGE_MAX
    )
      return undefined;
    limit = asNumber;
  }
  return { cursor, limit };
}

function balanceState(balanceMicroUsd: number): BalanceState {
  if (balanceMicroUsd < 0) return "negative";
  return balanceMicroUsd === 0 ? "empty" : "ok";
}

function isRowKind(type: string): type is JournalRowKind {
  return (JOURNAL_ROW_KINDS as readonly string[]).includes(type);
}

type RunFacts = { label: string; keyMode: string | null };

export function createWorkspaceBillingService({
  db,
  now = () => new Date(),
  activeAdapter,
  keyMode,
  startCredit,
}: {
  db: Kysely<Database>;
  now?: () => Date;
  /** The adapter billing runs on, or undefined when the setting names one this instance does not have. */
  activeAdapter: () => Promise<BillingAdapter | undefined>;
  /** Whose key the workspace's reviews run on, for the line that points to the LLM access page. */
  keyMode: (workspaceId: string) => Promise<WorkspaceKeyMode>;
  /** The first-contact grant of the start credit; the real one unless a test stands in. Never throws. */
  startCredit?: (workspaceId: string) => Promise<unknown>;
}): WorkspaceBillingService {
  const grantStartCredit =
    startCredit ?? ((workspaceId) => ensureStartCredit(db, workspaceId, now));

  /** The pull request of each run and whose key it used, for the rows that are charges. One read for the page, by job id. */
  async function runFactsOf(
    workspaceId: string,
    jobIds: readonly string[],
  ): Promise<Map<string, RunFacts>> {
    const facts = new Map<string, RunFacts>();
    if (jobIds.length === 0) return facts;
    const rows = await db
      .selectFrom("jobs")
      .innerJoin("repositories", "repositories.id", "jobs.repository_id")
      .leftJoin("usage_records", (join) =>
        join
          .onRef("usage_records.job_id", "=", "jobs.id")
          .on("usage_records.workspace_id", "=", workspaceId),
      )
      // #752: a turn of the Implementer has no pull request (its number is a negative placeholder); it is named by its branch.
      .leftJoin("implementer_turns", (join) =>
        join
          .onRef("implementer_turns.job_id", "=", "jobs.id")
          .on("implementer_turns.workspace_id", "=", workspaceId),
      )
      .leftJoin("implementer_sessions", (join) =>
        join
          .onRef("implementer_sessions.id", "=", "implementer_turns.session_id")
          .on("implementer_sessions.workspace_id", "=", workspaceId),
      )
      .select([
        "jobs.id as id",
        "jobs.pr_number as pr_number",
        "jobs.review_kind as review_kind",
        "repositories.full_name as full_name",
        "usage_records.key_mode as key_mode",
        "implementer_sessions.branch as branch",
      ])
      .where("jobs.workspace_id", "=", workspaceId)
      .where("jobs.id", "in", [...jobIds])
      .execute();
    for (const row of rows)
      facts.set(row.id, {
        label:
          row.review_kind === "implementer"
            ? `${row.full_name} ${row.branch ?? "(Implementer)"}`
            : `${row.full_name} #${String(row.pr_number)}`,
        keyMode: row.key_mode,
      });
    return facts;
  }

  function rowOf(
    entry: JournalEntry,
    facts: ReadonlyMap<string, RunFacts>,
  ): JournalRowView | undefined {
    if (!isRowKind(entry.type)) return undefined;
    const base = {
      id: entry.id,
      kind: entry.type,
      amountMicroUsd: entry.amountMicroUsd,
      createdAt: entry.createdAt,
      run: null,
      aiMicroUsd: null,
      infraMicroUsd: null,
    } satisfies JournalRowView;
    if (entry.type !== "usage") return base;
    const run = entry.jobId === null ? undefined : facts.get(entry.jobId);
    return {
      ...base,
      run:
        entry.jobId === null || run === undefined
          ? null
          : { id: entry.jobId, label: run.label },
      // A review on the workspace's own key pays infrastructure only: no AI price is shown for it.
      aiMicroUsd: run?.keyMode === "own" ? null : (entry.aiMicroUsd ?? 0),
      infraMicroUsd: entry.infraMicroUsd ?? 0,
    };
  }

  async function pageOf(
    workspaceId: string,
    query: { cursor: number | undefined; limit: number },
  ): Promise<JournalPageView> {
    const page = await createBillingJournalRepository(
      db,
      workspaceId,
      now,
    ).entries({
      cursor: query.cursor === undefined ? undefined : { seq: query.cursor },
      limit: query.limit,
      excludeTypes: HIDDEN_TYPES,
    });
    const facts = await runFactsOf(
      workspaceId,
      page.entries.flatMap((entry) =>
        entry.type === "usage" && entry.jobId !== null ? [entry.jobId] : [],
      ),
    );
    return {
      rows: page.entries.flatMap((entry) => rowOf(entry, facts) ?? []),
      next: page.next === undefined ? null : String(page.next.seq),
    };
  }

  async function pendingOf(
    workspaceId: string,
    adapter: BillingAdapter | undefined,
  ): Promise<PendingTopUpView[]> {
    const intents = await createBillingTopUpIntentsRepository(
      db,
      workspaceId,
      now,
    ).list({ limit: PENDING_TOP_UPS_LIMIT });
    return intents
      .filter((intent) => intent.state === "pending")
      .map((intent) => ({
        id: intent.id,
        amountMicroUsd: intent.amountMicroUsd,
        createdAt: intent.createdAt,
        canCheck:
          adapter?.lookupTopUp !== undefined && intent.checkoutRef !== null,
      }));
  }

  return {
    async overview(actor) {
      if (!can(actor.role, "view")) return { ok: false, error: "forbidden" };
      const { workspaceId } = actor;
      const canManage = can(actor.role, "manage_billing");
      await grantStartCredit(workspaceId);
      const journal = createBillingJournalRepository(db, workspaceId, now);
      const [balance, adapter, mode, page] = await Promise.all([
        journal.balance(),
        activeAdapter(),
        keyMode(workspaceId),
        pageOf(workspaceId, { cursor: undefined, limit: JOURNAL_PAGE_SIZE }),
      ]);
      const view: WorkspaceBillingView = {
        canManage,
        balanceMicroUsd: balance.balanceMicroUsd,
        heldMicroUsd: balance.reservedMicroUsd,
        state: balanceState(balance.balanceMicroUsd),
        topUpAvailable: adapter?.capabilities.checkout === true,
        profileRequired: adapter?.capabilities.requiresBillingProfile === true,
        pendingTopUps: [],
        profile: null,
        monthlyLimitCents: null,
        chargedThisMonthMicroUsd: null,
        keyMode: mode,
        journal: page,
      };
      if (!canManage) return { ok: true, view };
      const [pending, profile, limit, charged] = await Promise.all([
        pendingOf(workspaceId, adapter),
        createBillingProfileService({ db, now }).get(actor),
        createMonthlyLimitService({ db, now }).get(actor),
        journal.chargedSince(utcMonthStart(now())),
      ]);
      return {
        ok: true,
        view: {
          ...view,
          pendingTopUps: pending,
          profile:
            profile.ok && profile.profile !== null
              ? profileFormOf(profile.profile)
              : null,
          monthlyLimitCents: limit.ok ? limit.monthlyLimitCents : null,
          chargedThisMonthMicroUsd: charged,
        },
      };
    },

    async journal(actor, query) {
      if (!can(actor.role, "view")) return { ok: false, error: "forbidden" };
      const read = readQuery(query);
      if (read === undefined)
        return { ok: false, error: "journal_query_invalid" };
      return { ok: true, page: await pageOf(actor.workspaceId, read) };
    },
  };
}

function profileFormOf(profile: {
  legalName: string;
  country: string;
  addressLine1: string;
  addressLine2: string | null;
  postalCode: string;
  city: string;
  vatId: string | null;
  businessConfirmed: boolean;
}): BillingProfileFormView {
  return {
    legalName: profile.legalName,
    country: profile.country,
    addressLine1: profile.addressLine1,
    addressLine2: profile.addressLine2,
    postalCode: profile.postalCode,
    city: profile.city,
    vatId: profile.vatId,
    businessConfirmed: profile.businessConfirmed,
  };
}
