// SPDX-License-Identifier: LicenseRef-Proprietary

// #505: the data of the billing page of a workspace (ADR 0006, 2.5), over a real database. The balance, what running reviews
// hold, the journal page with its signs and its cursor, the state when reviews are paused, what an Owner or an Admin gets and a
// Member does not, the prices of a charged review, and the first contact that grants the start credit before the balance is read.
import type { Kysely } from "kysely";
import { describe, expect, it, vi } from "vitest";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import { createBillingProfilesRepository } from "../db/repositories/billing-profiles-repository.ts";
import { createBillingTopUpIntentsRepository } from "../db/repositories/billing-topup-intents-repository.ts";
import { createBillingWorkspaceSettingsRepository } from "../db/repositories/billing-workspace-settings-repository.ts";
import { createUsageRecordsRepository } from "../db/repositories/usage-records-repository.ts";
import {
  fundWorkspace,
  setBillingSwitch,
} from "../test-support/billing-switch.ts";
import { createFakeBillingAdapter } from "../test-support/fake-billing-adapter.ts";
import { createJobQueueFixture, sha } from "../test-support/jobs.ts";
import { createCapabilitySet } from "../capabilities/capability.ts";
import { createJobQueue } from "../jobs/job-queue.ts";
import { addUser } from "../test-support/workspace-deletion-fixture.ts";
import type { Database } from "../db/schema.ts";
import { insertUser } from "../test-support/users.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import type { WorkspaceRole } from "../db/workspace-roles.ts";
import type { BillingAdapter } from "./adapter.ts";
import { manualAdapter } from "./manual-adapter.ts";
import { createWorkspaceBillingService } from "./workspace-page.ts";

const USD = 1_000_000;

async function start(
  options: {
    /** The Dynamic Review rollout gate of the fixture's queue (default off). */
    dynamicReview?: boolean;
    adapter?: BillingAdapter | undefined;
    /** Stands in for the start credit; gets the database, the workspace and the clock. */
    startCredit?: (context: {
      db: Kysely<Database>;
      workspaceId: string;
      now: () => Date;
    }) => Promise<unknown>;
  } = {},
) {
  const fixture = await createJobQueueFixture(
    options.dynamicReview === true ? { dynamicReview: true } : {},
  );
  const { db, workspaceId } = fixture;
  await setBillingSwitch(db, true);
  const adapter =
    "adapter" in options ? options.adapter : createFakeBillingAdapter();
  const service = createWorkspaceBillingService({
    db,
    now: fixture.clock.now,
    activeAdapter: () => Promise.resolve(adapter),
    keyMode: () => Promise.resolve("managed"),
    ...(options.startCredit === undefined
      ? {}
      : {
          startCredit: () =>
            options.startCredit!({ db, workspaceId, now: fixture.clock.now }),
        }),
  });
  const actor = (role: WorkspaceRole, workspace = workspaceId) => ({
    workspaceId: workspace,
    userId: `u-${role}`,
    role,
  });
  const journal = () =>
    createBillingJournalRepository(db, workspaceId, fixture.clock.now);
  return { fixture, db, workspaceId, service, actor, journal };
}

async function overviewOf(
  t: Awaited<ReturnType<typeof start>>,
  role: WorkspaceRole = "owner",
) {
  const result = await t.service.overview(t.actor(role));
  if (!result.ok) throw new Error(`refused: ${result.error}`);
  return result.view;
}

describe("the billing page data of a workspace", () => {
  // #505-T01
  it("reports the balance, nothing held and the journal newest first with the right signs", async () => {
    const t = await start();
    await t.journal().append({
      type: "top_up",
      amountMicroUsd: 20 * USD,
      refKey: "pi_1",
      provider: "fake",
      providerRef: "pi_1",
    });
    await t.journal().charge("job-1", {
      aiMicroUsd: 1_500_000,
      infraMicroUsd: 130_000,
      minutes: 10,
      reviewKind: "diff",
    });

    const view = await overviewOf(t);

    expect(view.balanceMicroUsd).toBe(20 * USD - 1_630_000);
    expect(view.heldMicroUsd).toBe(0);
    expect(view.state).toBe("ok");
    expect(
      view.journal.rows.map((row) => [row.kind, row.amountMicroUsd]),
    ).toEqual([
      ["usage", -1_630_000],
      ["top_up", 20 * USD],
    ]);
    expect(view.journal.rows[0]).toMatchObject({
      aiMicroUsd: 1_500_000,
      infraMicroUsd: 130_000,
    });
    expect(view.journal.next).toBeNull();
  });

  // #505-T01
  it("pages the journal by a cursor that ends on the last page", async () => {
    const t = await start();
    for (let index = 1; index <= 5; index += 1)
      await fundWorkspace(
        t.db,
        t.workspaceId,
        index * USD,
        t.fixture.clock.now,
      );

    const first = await t.service.journal(t.actor("member"), { limit: 2 });
    expect(
      first.ok && first.page.rows.map((row) => row.amountMicroUsd),
    ).toEqual([5 * USD, 4 * USD]);
    const cursor = first.ok ? first.page.next : null;
    expect(cursor).not.toBeNull();
    const second = await t.service.journal(t.actor("member"), {
      limit: 2,
      cursor,
    });
    expect(
      second.ok && second.page.rows.map((row) => row.amountMicroUsd),
    ).toEqual([3 * USD, 2 * USD]);
    const third = await t.service.journal(t.actor("member"), {
      limit: 2,
      cursor: second.ok ? second.page.next : null,
    });
    expect(
      third.ok && third.page.rows.map((row) => row.amountMicroUsd),
    ).toEqual([1 * USD]);
    expect(third.ok && third.page.next).toBeNull();
  });

  // #505-T01
  it("refuses a cursor or a limit that is not a number", async () => {
    const t = await start();

    for (const input of [
      { cursor: "abc" },
      { cursor: "-3" },
      { cursor: "1e3" },
      { limit: "ten" },
      { limit: 0 },
    ])
      expect(await t.service.journal(t.actor("member"), input)).toEqual({
        ok: false,
        error: "journal_query_invalid",
      });
  });

  // #505-T01
  it("keeps a hold and its release out of the journal and reports the hold as held", async () => {
    const t = await start();
    await fundWorkspace(t.db, t.workspaceId, 10 * USD, t.fixture.clock.now);
    await t.journal().reserve(3 * USD, "job-old");
    await t.journal().release("job-old");
    await t.journal().reserve(2 * USD, "job-running");

    const view = await overviewOf(t);

    expect(view.heldMicroUsd).toBe(2 * USD);
    expect(view.balanceMicroUsd).toBe(8 * USD);
    expect(view.journal.rows.map((row) => row.kind)).toEqual(["top_up"]);
  });

  // #505-T01
  it("grants the start credit before it reads the balance", async () => {
    const order: string[] = [];
    const t = await start({
      startCredit: async ({ db, workspaceId, now }) => {
        order.push("start credit");
        await fundWorkspace(db, workspaceId, 2 * USD, now);
      },
    });

    const view = await overviewOf(t);

    expect(order).toEqual(["start credit"]);
    expect(view.balanceMicroUsd).toBe(2 * USD);
    expect(view.journal.rows).toHaveLength(1);
  });

  // #505-T08
  it("explains an empty balance and a negative one with a state, and a negative one holds the way out in the journal", async () => {
    const t = await start();
    expect((await overviewOf(t)).state).toBe("empty");

    await fundWorkspace(t.db, t.workspaceId, 1 * USD, t.fixture.clock.now);
    await t.journal().charge("job-big", {
      aiMicroUsd: 2 * USD,
      infraMicroUsd: 500_000,
      minutes: 3,
      reviewKind: "dynamic",
    });
    const view = await overviewOf(t);

    expect(view.state).toBe("negative");
    expect(view.balanceMicroUsd).toBe(-1_500_000);
  });

  // #505-T02
  it("gives a Member the balance and the journal and none of the profile, the pending payments, the limit or the spending", async () => {
    const t = await start({
      adapter: {
        ...createFakeBillingAdapter(),
        capabilities: {
          ...createFakeBillingAdapter().capabilities,
          requiresBillingProfile: true,
        },
      },
    });
    await fundWorkspace(t.db, t.workspaceId, 10 * USD, t.fixture.clock.now);
    await createBillingProfilesRepository(t.db, t.workspaceId).save({
      legalName: "Acme GmbH",
      country: "DE",
      addressLine1: "Hauptstrasse 1",
      addressLine2: null,
      postalCode: "10115",
      city: "Berlin",
      vatId: "DE123456789",
    });
    const limitSetter = await insertUser(t.db, { id: "u-limit-setter" });
    await createBillingWorkspaceSettingsRepository(
      t.db,
      t.workspaceId,
    ).setMonthlyLimit(100 * USD, limitSetter);
    await createBillingTopUpIntentsRepository(t.db, t.workspaceId).create({
      adapter: "fake",
      amountMicroUsd: 25 * USD,
    });

    const member = await overviewOf(t, "member");
    const owner = await overviewOf(t, "owner");

    expect(member).toMatchObject({
      canManage: false,
      balanceMicroUsd: 10 * USD,
      profile: null,
      pendingTopUps: [],
      monthlyLimitCents: null,
      chargedThisMonthMicroUsd: null,
    });
    expect(JSON.stringify(member)).not.toContain("Acme GmbH");
    expect(JSON.stringify(member)).not.toContain("DE123456789");
    expect(owner).toMatchObject({
      canManage: true,
      profile: { legalName: "Acme GmbH", vatId: "DE123456789" },
      monthlyLimitCents: 10_000,
      chargedThisMonthMicroUsd: 0,
    });
    expect(owner.pendingTopUps).toHaveLength(1);
    expect(owner.pendingTopUps[0]).toMatchObject({
      amountMicroUsd: 25 * USD,
      canCheck: false,
    });
  });

  // #505-T02
  it("never reads another workspace's journal: the actor's workspace is the only one", async () => {
    const t = await start();
    const otherId = await addWorkspace(t.db, "other");
    await fundWorkspace(t.db, otherId, 99 * USD, t.fixture.clock.now);
    await fundWorkspace(t.db, t.workspaceId, 1 * USD, t.fixture.clock.now);

    const view = await overviewOf(t);

    expect(view.balanceMicroUsd).toBe(1 * USD);
    expect(view.journal.rows).toHaveLength(1);
  });

  // #505-T10
  it("shows no top-up form for the manual adapter", async () => {
    const t = await start({ adapter: manualAdapter });

    const view = await overviewOf(t);

    expect(view).toMatchObject({
      topUpAvailable: false,
      profileRequired: false,
    });
  });

  // #505-T10
  it("shows no top-up form when the adapter is not known", async () => {
    const t = await start({ adapter: undefined });

    expect((await overviewOf(t)).topUpAvailable).toBe(false);
  });

  // #505-T01
  it("counts only this UTC month's charges toward the spending shown to an Owner", async () => {
    const t = await start();
    await fundWorkspace(t.db, t.workspaceId, 50 * USD, t.fixture.clock.now);
    await t.journal().charge("job-this-month", {
      aiMicroUsd: 1 * USD,
      infraMicroUsd: 250_000,
      minutes: 1,
      reviewKind: "diff",
    });

    const view = await overviewOf(t);

    expect(view.chargedThisMonthMicroUsd).toBe(1_250_000);
  });

  // #505-T01
  it("lets a pending payment be checked when the adapter can look it up and the buyer has a payment page", async () => {
    const t = await start();
    const intents = createBillingTopUpIntentsRepository(t.db, t.workspaceId);
    const withPage = await intents.create({
      adapter: "fake",
      amountMicroUsd: 10 * USD,
    });
    await intents.attachRefs(withPage.id, { checkoutRef: "cs_fake_1" });
    await intents.create({ adapter: "fake", amountMicroUsd: 11 * USD });

    const view = await overviewOf(t);

    expect(
      view.pendingTopUps
        .map((pending) => [pending.amountMicroUsd, pending.canCheck])
        .sort(),
    ).toEqual([
      [10 * USD, true],
      [11 * USD, false],
    ]);
  });

  // #505-T06
  it("never puts a minute count, a rate, a reference, a note or a provider into the view", async () => {
    const t = await start();
    await t.journal().append({
      type: "correction",
      amountMicroUsd: -1 * USD,
      refKey: "corr-secret-ref",
      note: "internal note about the customer",
      actorUserId: "u-admin",
    });
    await t.journal().append({
      type: "top_up",
      amountMicroUsd: 20 * USD,
      refKey: "pi_ref_marker",
      provider: "stripe",
      providerRef: "pi_ref_marker",
    });
    await t.journal().charge("job-6", {
      aiMicroUsd: 1_500_000,
      infraMicroUsd: 130_000,
      minutes: 777,
      reviewKind: "dynamic",
    });
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const text = JSON.stringify(await overviewOf(t));

    // The minute count as a standalone number; a substring of "777" turns up inside the random ids of the view now and
    // then (#714).
    expect(text).not.toMatch(/(?<![0-9A-Za-z])777(?![0-9A-Za-z])/);
    for (const secret of [
      "minutes",
      "corr-secret-ref",
      "pi_ref_marker",
      "internal note",
      "stripe",
      "u-admin",
      "dynamic",
      "reviewKind",
      "refKey",
    ])
      expect(text).not.toContain(secret);
    spy.mockRestore();
  });

  // #505-T05
  it("links a charge to its run and names the pull request, and shows only the infrastructure price of a review on the workspace's own key", async () => {
    const t = await start();
    await fundWorkspace(t.db, t.workspaceId, 50 * USD, t.fixture.clock.now);
    const managed = await t.fixture.enqueueNew({ prNumber: 7 });
    const own = await t.fixture.enqueueNew({ prNumber: 8 });
    const records = createUsageRecordsRepository(
      t.db,
      t.workspaceId,
      t.fixture.clock.now,
    );
    await records.reserve(managed.id, "managed");
    await records.reserve(own.id, "own");
    await t.journal().charge(managed.id, {
      aiMicroUsd: 1 * USD,
      infraMicroUsd: 200_000,
      minutes: 2,
      reviewKind: "diff",
    });
    await t.journal().charge(own.id, {
      aiMicroUsd: 0,
      infraMicroUsd: 300_000,
      minutes: 3,
      reviewKind: "diff",
    });

    const view = await overviewOf(t);

    const [ownRow, managedRow] = view.journal.rows;
    expect(managedRow).toMatchObject({
      aiMicroUsd: 1 * USD,
      infraMicroUsd: 200_000,
      run: {
        id: managed.id,
        label: expect.stringMatching(/^acme\/(widgets|gadgets) #7$/),
      },
    });
    expect(ownRow).toMatchObject({
      aiMicroUsd: null,
      infraMicroUsd: 300_000,
      run: {
        id: own.id,
        label: expect.stringMatching(/^acme\/(widgets|gadgets) #8$/),
      },
    });
  });

  // #752 review: a turn of the Implementer has no pull request, so its negative placeholder number is never shown.
  it("names the charge of a turn of the Implementer by its branch, and leaves the labels of Diff and Dynamic rows as they were", async () => {
    const t = await start({ dynamicReview: true });
    await fundWorkspace(t.db, t.workspaceId, 50 * USD, t.fixture.clock.now);
    await addUser(t.db, "user-1");
    const capable = createCapabilitySet([
      "review",
      "dynamic-review",
      "implementer",
    ]);
    const queue = createJobQueue(t.db, t.workspaceId, {
      now: t.fixture.clock.now,
      kindAllowed: (kind) => capable.allowsReviewKind(kind),
    });
    const diff = await t.fixture.enqueueNew({ prNumber: 7 });
    const dynamic = await t.fixture.enqueueNew({
      prNumber: 9,
      headSha: sha("c"),
      reviewKind: "dynamic",
    });
    const turn = await queue.enqueueImplementerTurn({
      repositoryId: t.fixture.repositoryId,
      baseBranch: "main",
      baseSha: sha("b"),
      branch: "implementer/add-health",
      instruction: "Add a health endpoint.",
      modelChoice: { entryId: "entry-1" },
      costLimitCents: null,
      createdBy: "user-1",
      actorLogin: "octocat",
      clientRequestId: "request-1",
    });
    if (turn.status !== "created") throw new Error("expected a new turn");
    const records = createUsageRecordsRepository(
      t.db,
      t.workspaceId,
      t.fixture.clock.now,
    );
    await records.reserve(diff.id, "managed");
    await records.reserve(dynamic.id, "managed");
    await records.reserve(turn.job.id, "managed");
    await t.journal().charge(diff.id, {
      aiMicroUsd: 1 * USD,
      infraMicroUsd: 100_000,
      minutes: 1,
      reviewKind: "diff",
    });
    await t.journal().charge(dynamic.id, {
      aiMicroUsd: 1 * USD,
      infraMicroUsd: 100_000,
      minutes: 1,
      reviewKind: "dynamic",
    });
    await t.journal().charge(turn.job.id, {
      aiMicroUsd: 2 * USD,
      infraMicroUsd: 300_000,
      minutes: 3,
      reviewKind: "implementer",
    });

    const view = await overviewOf(t);

    const labels = view.journal.rows.flatMap((row) =>
      row.run === null ? [] : [row.run.label],
    );
    expect(labels).toHaveLength(3);
    expect(labels).toContainEqual(
      expect.stringMatching(
        /^acme\/(widgets|gadgets) implementer\/add-health$/,
      ),
    );
    expect(labels).toContainEqual(
      expect.stringMatching(/^acme\/(widgets|gadgets) #7$/),
    );
    expect(labels).toContainEqual(
      expect.stringMatching(/^acme\/(widgets|gadgets) #9$/),
    );
    expect(labels.join(" ")).not.toContain("#-");
  });
});
