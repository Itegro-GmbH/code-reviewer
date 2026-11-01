// SPDX-License-Identifier: LicenseRef-Proprietary

// A second workspace with its own data is invisible to the first through every scoped repository
// (docs/decisions/0001-editions-setup-and-accounts.md, section 2.7). Table driven over the methods of
// every scoped repository: each is called with the scope of workspace A against the ids and keys of
// workspace B, and nothing of B may come back or change. The table must cover every method of every
// repository, so a method added later without a row here fails the last test.
import { describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { createTestDatabase } from "../../test-support/test-database.ts";
import {
  addWorkspace,
  defaultWorkspaceId,
} from "../../test-support/workspaces.ts";
import type { Database } from "../schema.ts";
import { createAppSettingsRepository } from "./app-settings-repository.ts";
import { createInstallationLinkRequestsRepository } from "./installation-link-requests-repository.ts";
import { createIntegrationsRepository } from "./integrations-repository.ts";
import { createInvitationsRepository } from "./invitations-repository.ts";
import { createWorkspaceMembersRepository } from "./workspace-members-repository.ts";
import { createWorkspaceEntitlementsRepository } from "./workspace-entitlements-repository.ts";
import { createWorkspaceErasureRepository } from "./workspace-erasure-repository.ts";
import { createWorkspaceSecretsRepository } from "./workspace-secrets-repository.ts";
import { createJobsRepository } from "./jobs-repository.ts";
import { createProjectsRepository } from "./projects-repository.ts";
import { createRepositoriesRepository } from "./repositories-repository.ts";
import { createRunsRepository } from "./runs-repository.ts";
import { createPlanHandoffTokensRepository } from "./plan-handoff-tokens-repository.ts";
import { createJobCheckRunsRepository } from "./job-check-runs-repository.ts";
import { createJobVmRunsRepository } from "./job-vm-runs-repository.ts";
import { createRefusalNoticesRepository } from "./refusal-notices-repository.ts";
import { createUsageRecordsRepository } from "./usage-records-repository.ts";
import { createBillingJournalRepository } from "./billing-journal-repository.ts";
import { createBillingTopUpIntentsRepository } from "./billing-topup-intents-repository.ts";
import { createBillingProfilesRepository } from "./billing-profiles-repository.ts";
import { createBillingNotificationsRepository } from "./billing-notifications-repository.ts";
import { createBillingWorkspaceSettingsRepository } from "./billing-workspace-settings-repository.ts";
import { createImplementerRepository } from "./implementer-repository.ts";

const SHA = "b".repeat(40);
const FAILED_SHA = "c".repeat(40);

function reposOf(db: Kysely<Database>, workspaceId: string) {
  return {
    integrations: createIntegrationsRepository(db, workspaceId),
    repositories: createRepositoriesRepository(db, workspaceId),
    projects: createProjectsRepository(db, workspaceId),
    appSettings: createAppSettingsRepository(db, workspaceId),
    jobs: createJobsRepository(db, workspaceId),
    runs: createRunsRepository(db, workspaceId),
    members: createWorkspaceMembersRepository(db, workspaceId),
    invitations: createInvitationsRepository(db, workspaceId),
    linkRequests: createInstallationLinkRequestsRepository(db, workspaceId),
    workspaceSecrets: createWorkspaceSecretsRepository(db, workspaceId),
    entitlements: createWorkspaceEntitlementsRepository(db, workspaceId),
    usage: createUsageRecordsRepository(db, workspaceId),
    notices: createRefusalNoticesRepository(db, workspaceId),
    jobChecks: createJobCheckRunsRepository(db, workspaceId),
    vmRuns: createJobVmRunsRepository(db, workspaceId),
    planHandoff: createPlanHandoffTokensRepository(db, workspaceId),
    billing: createBillingJournalRepository(db, workspaceId),
    topUpIntents: createBillingTopUpIntentsRepository(db, workspaceId),
    profiles: createBillingProfilesRepository(db, workspaceId),
    limits: createBillingWorkspaceSettingsRepository(db, workspaceId),
    notifications: createBillingNotificationsRepository(db, workspaceId),
    implementer: createImplementerRepository(db, workspaceId),
    erasure: createWorkspaceErasureRepository(db, workspaceId),
  };
}
type Repos = ReturnType<typeof reposOf>;

/** The entitlements of a workspace; the label says whose they are. */
function entitlementsOf(tag: string, overrides: { planLabel?: string } = {}) {
  return {
    planLabel: overrides.planLabel ?? `plan-${tag}`,
    keyMode: "managed" as const,
    limits: {
      diffRunsPerPeriod: 10,
      dynamicRunsPerPeriod: null,
      managedCostLimitMicroUsd: 1000,
      ownKeyCostLimitMicroUsd: null,
    },
    periodStart: "2026-10-01T00:00:00.000Z",
    suspended: false,
    suspensionCode: null,
  };
}

/** The pull request and period of the notice every seeded workspace has. */
function noticeKeyOf(repositoryId: string) {
  return {
    repositoryId,
    prNumber: 7,
    periodStart: "2026-10-01T00:00:00.000Z",
  };
}
const NOTICE_OPTIONS = { leaseMs: 60_000, maxAttempts: 3 };
const CHECK_LEASE = { leaseMs: 60_000, maxAttempts: 5 };

/** One workspace with an integration, a repository, a project, a job and a setting. */
async function seed(
  db: Kysely<Database>,
  workspaceId: string,
  tag: string,
  options: { earlierFailedJob?: boolean; implementerTask?: boolean } = {},
) {
  const repos = reposOf(db, workspaceId);
  const integration = await repos.integrations.create({
    type: "github_app",
    displayName: `acme-${tag}`,
    externalId: `ext-${tag}`,
    config: {},
  });
  await repos.repositories.reconcile(integration.id, [
    {
      integrationId: integration.id,
      externalId: `repo-${tag}`,
      fullName: `acme/${tag}`,
      url: `https://github.test/acme/${tag}`,
    },
  ]);
  const [repository] = await repos.repositories.list();
  if (repository === undefined) throw new Error("seeding failed");
  await repos.projects.activate(repository.id);
  const enqueued = await repos.jobs.enqueue({
    repositoryId: repository.id,
    prNumber: 7,
    prUrl: `https://github.test/acme/${tag}/pull/7`,
    headSha: SHA,
    reviewKind: "diff",
    command: "review",
    args: "",
    triggerKind: "webhook",
    actorLogin: "octocat",
    deliveryId: `delivery-${tag}`,
    commentId: null,
    runAfter: null,
  });
  if (enqueued.status !== "created") throw new Error("seeding failed");
  // An earlier job of the same pull request and kind that ran and failed (a head the summary comment
  // may hold, #255): the lookup of the attempted heads of the other workspace has something to leak.
  if (options.earlierFailedJob === true) {
    const row = await db
      .selectFrom("jobs")
      .selectAll()
      .where("id", "=", enqueued.job.id)
      .executeTakeFirstOrThrow();
    await db
      .insertInto("jobs")
      .values({
        ...row,
        id: `failed-${tag}`,
        head_sha: FAILED_SHA,
        delivery_id: null,
        status: "failed",
        error_code: "timeout",
        claimed_at: "2026-10-10T23:50:00.000Z",
        created_at: "2026-10-11T00:00:00.000Z",
        updated_at: "2026-10-11T00:00:00.000Z",
        finished_at: "2026-10-11T00:00:00.000Z",
      })
      .execute();
    // The VM of that job's claim (#493): A must neither see, end, measure nor add to it.
    await db
      .insertInto("job_vm_runs")
      .values({
        job_id: `failed-${tag}`,
        vm_name: `vm-${tag}`,
        workspace_id: workspaceId,
        attempt: 1,
        claimed_at: "2026-10-10T23:50:00.000Z",
        started_at: "2026-10-10T23:51:00.000Z",
        reported_at: "2026-10-10T23:51:01.000Z",
        vm_timeout_seconds: 2100,
        billable: 1,
        created_at: "2026-10-10T23:51:01.000Z",
        updated_at: "2026-10-10T23:51:01.000Z",
      })
      .execute();
  }
  // A cancelled job whose record is still reserved (it waited again after a lost lease): `voidEndedJobs` of
  // the other workspace must not touch it.
  if (options.earlierFailedJob === true) {
    const row = await db
      .selectFrom("jobs")
      .selectAll()
      .where("id", "=", enqueued.job.id)
      .executeTakeFirstOrThrow();
    await db
      .insertInto("jobs")
      .values({
        ...row,
        id: `cancelled-${tag}`,
        head_sha: "d".repeat(40),
        delivery_id: null,
        status: "cancelled",
        error_code: "project_deactivated",
        created_at: "2026-10-11T00:00:00.000Z",
        updated_at: "2026-10-11T00:00:00.000Z",
        finished_at: "2026-10-11T00:00:00.000Z",
      })
      .execute();
    await repos.usage.reserve(`cancelled-${tag}`, "own");
  }
  await repos.appSettings.set("review_defaults", { from: tag }, tag);
  // A member and an open invitation.
  await db
    .insertInto("users")
    .values({
      id: `user-${tag}`,
      name: `user-${tag}`,
      email: `user-${tag}@example.test`,
      email_verified: 1,
      image: null,
      github_login: null,
      imported_at: null,
      is_instance_admin: 0,
      org_checked_at: null,
      org_checked_for: null,
      created_at: "2026-10-12T00:00:00.000Z",
      updated_at: "2026-10-12T00:00:00.000Z",
    })
    .execute();
  await repos.members.add(`user-${tag}`, "owner");
  const invitation = await repos.invitations.create({
    id: `invitation-${tag}`,
    email: `invited-${tag}@example.test`,
    role: "member",
    invitedBy: `user-${tag}`,
    tokenHash: `hash-${tag}`,
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
  });
  const linkRequest = await repos.linkRequests.createPending({
    requestedBy: `user-${tag}`,
    requesterGithubLogin: `login-${tag}`,
    installationId: `installation-${tag}`,
    accountLogin: `acme-${tag}`,
    accountType: "Organization",
    accountId: `account-${tag}`,
    evidence: {
      tokenCanAccess: true,
      roleResult: "unreadable",
      roleDetail: "forbidden",
    },
  });
  await repos.entitlements.put(entitlementsOf(tag), `user-${tag}`);
  // A reserved record for the job, and a settled managed one for the earlier failed job (when there is one).
  await repos.usage.reserve(enqueued.job.id, "managed");
  if (options.earlierFailedJob === true) {
    await repos.usage.reserve(`failed-${tag}`, "managed");
    await repos.usage.settle(`failed-${tag}`, {
      state: "settled",
      costMicroUsd: 500,
      promptTokens: 10,
      completionTokens: 5,
    });
  }
  // The notice of a refused review on the seeded pull request (#281).
  const taken = await repos.notices.begin(
    noticeKeyOf(repository.id),
    "quota_exhausted",
    NOTICE_OPTIONS,
  );
  if (!taken.acquired) throw new Error("seeding failed");
  // The check run record of the seeded job (#405).
  const checked = await repos.jobChecks.take(enqueued.job.id, CHECK_LEASE);
  if (!checked.acquired) throw new Error("seeding failed");
  await repos.jobChecks.recordCheck(enqueued.job.id, {
    checkRunId: `check-${tag}`,
    syncedStatus: "queued",
  });
  await repos.jobChecks.finish(enqueued.job.id, { settled: false });
  // The handoff token of the Owner of the workspace (#284).
  await repos.planHandoff.issue({
    tokenHash: `handoff-${tag}`,
    userId: `user-${tag}`,
    role: "owner",
    ttlMs: 5 * 60 * 1000,
  });
  await repos.workspaceSecrets.put({
    name: "llm_api_key",
    binding: `binding-${tag}`,
    ciphertext: `ciphertext-${tag}`,
    nonce: `nonce-${tag}`,
    keyVersion: 1,
    lastFour: null,
    updatedBy: `user-${tag}`,
  });
  // #426-T10: the key of a second provider has a name of its own in the same workspace.
  await repos.workspaceSecrets.put({
    name: "llm_api_key.fakeai",
    binding: `fakeai-${tag}`,
    ciphertext: `ciphertext-fakeai-${tag}`,
    nonce: `nonce-fakeai-${tag}`,
    keyVersion: 1,
    lastFour: null,
    updatedBy: `user-${tag}`,
  });
  // The balance journal (#495): a top-up and a hold, so the other workspace has a balance, an entry and a reservation to reach for.
  const topUp = await repos.billing.append({
    type: "top_up",
    amountMicroUsd: 5_000_000,
    refKey: `pi-${tag}`,
  });
  await repos.billing.reserve(1_000_000, `held-${tag}`);
  // The top-up intents (#497): one with a payment, so the other workspace has an intent to reach for.
  const topUpIntent = await repos.topUpIntents.create({
    adapter: "fake",
    amountMicroUsd: 25_000_000,
  });
  await repos.topUpIntents.attachRefs(topUpIntent.id, {
    checkoutRef: `cs-${tag}`,
    paymentRef: `pi-intent-${tag}`,
  });
  // One that never got a page (#501), which a sweep of the other workspace must not fail.
  const unpagedIntent = await repos.topUpIntents.create({
    adapter: "fake",
    amountMicroUsd: 10_000_000,
  });
  // The billing profile (#501): customer data, with a customer, so the other workspace has a profile to reach for.
  await repos.profiles.save({
    legalName: `Legal ${tag} GmbH`,
    country: "DE",
    addressLine1: `Street ${tag}`,
    addressLine2: null,
    postalCode: "10115",
    city: "Berlin",
    vatId: null,
  });
  await repos.profiles.setCustomer("fake", `cus_${tag}`);
  // The monthly limit (#499): each workspace has its own, so the other's is there to be reached for.
  await repos.limits.setMonthlyLimit(
    tag === "a" ? 10_000_000 : 20_000_000,
    null,
  );
  // #506-T09: the balance notifications. Each workspace was told "empty", and B was also told "low" without a mail, so the other
  // workspace's rows are there to be read, re-armed and marked.
  await repos.notifications.markSent("empty", "due");
  if (tag === "b") await repos.notifications.markSent("low", "none");
  // The Implementer's session and turn (#751): a task on the seeded repository with a job of its own (the negative slot as the
  // pull request number), so the other workspace has a session, a turn and a job to reach for. Only B gets one: its job would
  // show up in A's job and run lists, which the cases of those lists count.
  const started =
    options.implementerTask !== true
      ? undefined
      : await repos.implementer.createSessionWithTurn(
          {
            repositoryId: repository.id,
            baseBranch: "main",
            branch: `implementer/${tag}`,
            instruction: `Instruction ${tag}`,
            modelChoice: { entryId: `entry-${tag}` },
            costLimitCents: 100,
            createdBy: `user-${tag}`,
          },
          async (trx, { slot }) => {
            const turnJob = await createJobsRepository(
              trx,
              workspaceId,
            ).enqueue({
              repositoryId: repository.id,
              prNumber: -slot,
              prUrl: `https://github.test/acme/${tag}/tree/implementer/${tag}`,
              headSha: SHA,
              reviewKind: "diff",
              command: "review",
              args: "",
              triggerKind: "manual",
              actorLogin: "octocat",
              deliveryId: `implementer-${tag}`,
              commentId: null,
              runAfter: null,
            });
            if (turnJob.status !== "created") throw new Error("seeding failed");
            return turnJob.job.id;
          },
        );
  return {
    implementer: started,
    topUpIntentId: topUpIntent.id,
    unpagedIntentId: unpagedIntent.id,
    workspaceId,
    userId: `user-${tag}`,
    journalEntryId: topUp.entry.id,
    heldJobId: `held-${tag}`,
    invitation,
    linkRequest,
    integration,
    repository,
    job: enqueued.job,
    notice: taken.notice,
    externalRepositoryId: `repo-${tag}`,
  };
}
type Seeded = Awaited<ReturnType<typeof seed>>;

/** Every row of every scoped table that belongs to a workspace, as stored. */
async function rowsOf(db: Kysely<Database>, workspaceId: string) {
  return {
    integrations: await db
      .selectFrom("integrations")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .orderBy("id")
      .execute(),
    repositories: await db
      .selectFrom("repositories")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .orderBy("id")
      .execute(),
    jobs: await db
      .selectFrom("jobs")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .orderBy("id")
      .execute(),
    members: await db
      .selectFrom("workspace_members")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .orderBy("user_id")
      .execute(),
    invitations: await db
      .selectFrom("invitations")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .orderBy("id")
      .execute(),
    linkRequests: await db
      .selectFrom("installation_link_requests")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .orderBy("id")
      .execute(),
    usageRecords: await db
      .selectFrom("usage_records")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .orderBy("id")
      .execute(),
    jobCheckRuns: await db
      .selectFrom("job_check_runs")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .orderBy("job_id")
      .execute(),
    jobVmRuns: await db
      .selectFrom("job_vm_runs")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .orderBy("vm_name")
      .execute(),
    refusalNotices: await db
      .selectFrom("refusal_notices")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .orderBy("id")
      .execute(),
    planHandoffTokens: await db
      .selectFrom("plan_handoff_tokens")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .orderBy("token_hash")
      .execute(),
    entitlements: await db
      .selectFrom("workspace_entitlements")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .execute(),
    workspaceSecrets: await db
      .selectFrom("workspace_secrets")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .orderBy("name")
      .execute(),
    billingEntries: await db
      .selectFrom("billing_journal_entries")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .orderBy("id")
      .execute(),
    billingBalances: await db
      .selectFrom("billing_balances")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .execute(),
    billingTopUpIntents: await db
      .selectFrom("billing_topup_intents")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .orderBy("id")
      .execute(),
    billingProfiles: await db
      .selectFrom("billing_profiles")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .execute(),
    billingNotifications: await db
      .selectFrom("billing_notifications")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .orderBy("kind")
      .execute(),
    billingWorkspaceSettings: await db
      .selectFrom("billing_workspace_settings")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .execute(),
    appSettings: await db
      .selectFrom("app_settings")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .orderBy("key")
      .execute(),
    projects: await db
      .selectFrom("projects")
      .innerJoin("repositories", "repositories.id", "projects.repository_id")
      .selectAll("projects")
      .where("repositories.workspace_id", "=", workspaceId)
      .orderBy("projects.id")
      .execute(),
    implementerSessions: await db
      .selectFrom("implementer_sessions")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .orderBy("id")
      .execute(),
    implementerTurns: await db
      .selectFrom("implementer_turns")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .orderBy("id")
      .execute(),
  };
}

type Case = {
  /** `repository.method`, which the completeness test compares with the repositories themselves. */
  name: string;
  /** What the call answers when workspace A asks for what belongs to B. */
  run: (a: Repos, b: Seeded, db: Kysely<Database>) => Promise<unknown>;
  /** Checks the answer: it is "not found" in the way that method says so, or holds only A's data. */
  expectAnswer: (answer: unknown, a: Seeded, b: Seeded) => void;
};

/** The session and turn of the workspace that was seeded with a task. */
function taskOf(seeded: Seeded) {
  if (seeded.implementer === undefined)
    throw new Error("this workspace was seeded without a task");
  return seeded.implementer;
}

const notFound = (code: string) => (answer: unknown) =>
  expect(answer).toMatchObject({ rejected: expect.objectContaining({ code }) });

/** Turns a rejection into a value, so one table row can expect either. */
async function settle(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    return { rejected: error };
  }
}

const CASES: Case[] = [
  // integrations
  {
    name: "integrations.get",
    run: (a, b) => a.integrations.get(b.integration.id),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "integrations.findByExternalId",
    run: (a, b) =>
      a.integrations.findByExternalId("github_app", b.integration.externalId),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "integrations.list",
    run: (a) => a.integrations.list(),
    expectAnswer: (answer, a) =>
      expect(answer).toEqual([
        expect.objectContaining({
          id: a.integration.id,
          workspaceId: a.workspaceId,
        }),
      ]),
  },
  {
    name: "integrations.create",
    run: (a) =>
      a.integrations.create({
        type: "github_app",
        displayName: "new",
        externalId: "ext-new",
        config: {},
      }),
    expectAnswer: (answer, a) =>
      expect(answer).toMatchObject({ workspaceId: a.workspaceId }),
  },
  {
    name: "integrations.setStatus",
    run: (a, b) =>
      settle(() => a.integrations.setStatus(b.integration.id, "disabled")),
    expectAnswer: (answer) => notFound("INTEGRATION_NOT_FOUND")(answer),
  },
  {
    name: "integrations.updateDetails",
    run: (a, b) =>
      settle(() =>
        a.integrations.updateDetails(b.integration.id, {
          displayName: "hijacked",
          config: {},
        }),
      ),
    expectAnswer: (answer) => notFound("INTEGRATION_NOT_FOUND")(answer),
  },
  // repositories
  {
    name: "repositories.list",
    run: (a) => a.repositories.list(),
    expectAnswer: (answer, a) =>
      expect(answer).toEqual([
        expect.objectContaining({ id: a.repository.id }),
      ]),
  },
  {
    name: "repositories.list (filtered by the integration of B)",
    run: (a, b) => a.repositories.list({ integrationId: b.integration.id }),
    expectAnswer: (answer) => expect(answer).toEqual([]),
  },
  {
    name: "repositories.get",
    run: (a, b) => a.repositories.get(b.repository.id),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "repositories.findByExternalId",
    run: (a, b) =>
      a.repositories.findByExternalId(b.integration.id, b.externalRepositoryId),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "repositories.reconcile",
    run: (a, b) => settle(() => a.repositories.reconcile(b.integration.id, [])),
    expectAnswer: (answer) => notFound("INTEGRATION_NOT_FOUND")(answer),
  },
  {
    name: "repositories.deactivateAll",
    run: (a, b) => a.repositories.deactivateAll(b.integration.id),
    expectAnswer: (answer) => expect(answer).toBe(0),
  },
  // projects
  {
    name: "projects.get",
    run: (a, b) => a.projects.get(b.repository.id),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "projects.findActiveForRepository",
    run: (a, b) => a.projects.findActiveForRepository(b.repository.id),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "projects.findActiveForExternalRepository",
    run: (a, b) =>
      a.projects.findActiveForExternalRepository(
        b.integration.id,
        b.externalRepositoryId,
      ),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "projects.activate",
    run: (a, b) => a.projects.activate(b.repository.id),
    expectAnswer: (answer) =>
      expect(answer).toEqual({ kind: "repository_not_found" }),
  },
  {
    name: "projects.deactivate",
    run: (a, b) => a.projects.deactivate(b.repository.id),
    expectAnswer: (answer) =>
      expect(answer).toEqual({ kind: "repository_not_found" }),
  },
  {
    name: "projects.updateSettings",
    run: (a, b) =>
      a.projects.updateSettings(b.repository.id, { hijacked: true }),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "projects.updateSettingsWith",
    run: (a, b) =>
      a.projects.updateSettingsWith(b.repository.id, () => ({
        hijacked: true,
      })),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "projects.list",
    run: (a) => a.projects.list(),
    expectAnswer: (answer, a) =>
      expect(answer).toEqual([
        expect.objectContaining({
          repository: expect.objectContaining({ id: a.repository.id }),
        }),
      ]),
  },
  {
    name: "projects.listLocked",
    // Locks and lists the repositories of A's workspace only, in the transaction it is given.
    run: (a, _b, db) =>
      db.transaction().execute((trx) => a.projects.listLocked(trx)),
    expectAnswer: (answer, a) =>
      expect(answer).toEqual([
        expect.objectContaining({
          repository: expect.objectContaining({ id: a.repository.id }),
        }),
      ]),
  },
  {
    name: "projects.find",
    run: (a, b) => a.projects.find(b.repository.id),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  // app settings
  {
    name: "appSettings.get",
    run: (a) => a.appSettings.get("review_defaults"),
    expectAnswer: (answer, a) =>
      expect(answer).toMatchObject({
        value: { from: a.integration.displayName.replace("acme-", "") },
      }),
  },
  {
    name: "appSettings.set",
    run: (a) =>
      a.appSettings.set("review_defaults", { from: "A-changed" }, "a"),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "appSettings.setIfUnchanged",
    run: async (a) =>
      a.appSettings.setIfUnchanged(
        "review_defaults",
        { from: "A-changed" },
        "a",
        (await a.appSettings.get("review_defaults"))?.updatedAt ?? null,
      ),
    expectAnswer: (answer) => expect(answer).toBe(true),
  },
  {
    name: "appSettings.delete",
    run: (a) => a.appSettings.delete("review_defaults"),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  // jobs
  {
    name: "jobs.get",
    run: (a, b) => a.jobs.get(b.job.id),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "jobs.list",
    run: (a) => a.jobs.list(),
    expectAnswer: (answer, a) =>
      expect(answer).toEqual([expect.objectContaining({ id: a.job.id })]),
  },
  {
    name: "jobs.list (filtered by the repository of B)",
    run: (a, b) => a.jobs.list({ repositoryId: b.repository.id }),
    expectAnswer: (answer) => expect(answer).toEqual([]),
  },
  {
    name: "jobs.previousReviewedSha",
    run: (a, b) =>
      a.jobs.previousReviewedSha({
        repositoryId: b.repository.id,
        prNumber: 7,
        reviewKind: "dynamic",
        excludeJobId: b.job.id,
      }),
    expectAnswer: (answer) => expect(answer).toBeNull(),
  },
  {
    name: "jobs.attemptedShas",
    run: (a, b) =>
      // The kind of B's seeded jobs, so only the workspace filter keeps its failed head out.
      a.jobs.attemptedShas({
        repositoryId: b.repository.id,
        prNumber: 7,
        reviewKind: "diff",
        excludeJobId: b.job.id,
      }),
    expectAnswer: (answer) =>
      expect(answer).toEqual({ shas: [], truncated: false }),
  },
  {
    name: "jobs.enqueue",
    run: (a, b) =>
      settle(() =>
        a.jobs.enqueue({
          repositoryId: b.repository.id,
          prNumber: 99,
          prUrl: "https://github.test/acme/b/pull/99",
          headSha: SHA,
          reviewKind: "diff",
          command: "review",
          args: "",
          triggerKind: "manual",
          actorLogin: "octocat",
          deliveryId: null,
          commentId: null,
          runAfter: null,
        }),
      ),
    expectAnswer: (answer) =>
      expect(answer).toMatchObject({
        rejected: expect.objectContaining({
          code: "23503",
        }),
      }),
  },
  {
    // #752-T05: a turn of the Implementer cannot be queued on a repository of another workspace; nothing is written
    name: "jobs.enqueueImplementerTurn",
    run: (a, b) =>
      settle(() =>
        a.jobs.enqueueImplementerTurn({
          repositoryId: b.repository.id,
          baseBranch: "main",
          baseSha: SHA,
          branch: "implementer/foreign",
          instruction: "Do it.",
          modelChoice: { entryId: "entry-1" },
          costLimitCents: null,
          createdBy: b.userId,
          actorLogin: "octocat",
          clientRequestId: "foreign-request",
        }),
      ),
    expectAnswer: (answer) =>
      expect(answer).toMatchObject({
        rejected: expect.objectContaining({ code: "JOB_REPOSITORY_UNKNOWN" }),
      }),
  },
  {
    // #791: a request id is looked up in the workspace of the scope; a turn of B is never found under A (the delivery id carries the workspace)
    name: "jobs.findImplementerTurn",
    run: (a) => a.jobs.findImplementerTurn("request-of-b"),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "jobs.cancelWaitingForRepository",
    run: (a, b) => a.jobs.cancelWaitingForRepository(b.repository.id),
    expectAnswer: (answer) => expect(answer).toBe(0),
  },
  {
    name: "jobs.cancelWaitingForReviewKindChange",
    run: (a, b) => a.jobs.cancelWaitingForReviewKindChange(b.repository.id),
    expectAnswer: (answer) => expect(answer).toBe(0),
  },
  {
    name: "jobs.discardWaitingForPr",
    run: (a, b) => a.jobs.discardWaitingForPr(b.repository.id, 7),
    expectAnswer: (answer) => expect(answer).toBe(0),
  },
  {
    name: "jobs.discardWaitingAutomaticForPr",
    run: (a, b) => a.jobs.discardWaitingAutomaticForPr(b.repository.id, 7),
    expectAnswer: (answer) => expect(answer).toBe(0),
  },
  // members
  {
    name: "members.list",
    run: (a) => a.members.list(),
    expectAnswer: (answer, a) =>
      expect(answer).toEqual([expect.objectContaining({ userId: a.userId })]),
  },
  {
    name: "members.get",
    run: (a, b) => a.members.get(b.userId),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "members.countOwners",
    run: (a) => a.members.countOwners(),
    expectAnswer: (answer) => expect(answer).toBe(1),
  },
  {
    name: "members.add",
    run: (a, b) => a.members.add(b.userId, "admin"),
    // B's owner joins A: a row of A's own; B keeps its row (the check below compares B's rows).
    expectAnswer: (answer) => expect(answer).toBe("added"),
  },
  {
    name: "members.setRole",
    run: (a, b) => a.members.setRole(b.userId, "member"),
    expectAnswer: (answer) => expect(answer).toBe(false),
  },
  {
    name: "members.remove",
    run: (a, b) => a.members.remove(b.userId),
    expectAnswer: (answer) => expect(answer).toBe(false),
  },
  {
    name: "members.lock",
    run: (a) => a.members.lock(),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  // invitations
  {
    name: "invitations.create",
    run: (a) =>
      a.invitations.create({
        id: "invitation-new",
        email: "new@example.test",
        role: "member",
        invitedBy: "user-a",
        tokenHash: "hash-new",
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      }),
    expectAnswer: (answer, a) =>
      expect(answer).toMatchObject({ workspaceId: a.workspaceId }),
  },
  {
    name: "invitations.get",
    run: (a, b) => a.invitations.get(b.invitation.id),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "invitations.listOpen",
    run: (a) => a.invitations.listOpen(),
    expectAnswer: (answer, a) =>
      expect(answer).toEqual([
        expect.objectContaining({ id: a.invitation.id }),
      ]),
  },
  {
    name: "invitations.findOpenByEmail",
    run: (a, b) => a.invitations.findOpenByEmail(b.invitation.email),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "invitations.revokeExpiredFor",
    run: (a, b) => a.invitations.revokeExpiredFor(b.invitation.email),
    expectAnswer: (answer) => expect(answer).toBe(0),
  },
  {
    name: "invitations.revoke",
    run: (a, b) => a.invitations.revoke(b.invitation.id),
    expectAnswer: (answer) => expect(answer).toBe(false),
  },
  {
    name: "invitations.replaceToken",
    run: (a, b) =>
      a.invitations.replaceToken(
        b.invitation.id,
        "hash-hijacked",
        new Date("2099-01-01T00:00:00.000Z"),
      ),
    expectAnswer: (answer) => expect(answer).toBe(false),
  },
  {
    name: "invitations.markAccepted",
    run: (a, b) => a.invitations.markAccepted(b.invitation.id, "user-a"),
    expectAnswer: (answer) => expect(answer).toBe(false),
  },
  // installation link requests
  {
    name: "linkRequests.createPending",
    run: (a, b) =>
      a.linkRequests.createPending({
        requestedBy: "user-a",
        requesterGithubLogin: "login-a",
        // The same installation as B's pending request: A's request is A's own, B's is not touched.
        installationId: b.linkRequest.installationId,
        accountLogin: "acme-b",
        accountType: "Organization",
        accountId: "account-b",
        evidence: {
          tokenCanAccess: false,
          roleResult: "unreadable",
          roleDetail: "forbidden",
        },
      }),
    expectAnswer: (answer, a, b) =>
      expect(answer).toMatchObject({
        workspaceId: a.workspaceId,
        id: expect.not.stringMatching(b.linkRequest.id),
      }),
  },
  {
    name: "linkRequests.get",
    run: (a, b) => a.linkRequests.get(b.linkRequest.id),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "linkRequests.findPending",
    run: (a, b) => a.linkRequests.findPending(b.linkRequest.installationId),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "linkRequests.list",
    run: (a) => a.linkRequests.list(),
    expectAnswer: (answer, a) =>
      expect(answer).toEqual([
        expect.objectContaining({ id: a.linkRequest.id }),
      ]),
  },
  // workspace secrets: the names are the same in every workspace, so the scope is what decides whose it is
  {
    name: "workspaceSecrets.get",
    run: (a) => a.workspaceSecrets.get("llm_api_key"),
    expectAnswer: (answer) =>
      expect(answer).toMatchObject({ binding: "binding-a" }),
  },
  {
    name: "workspaceSecrets.put",
    run: (a) =>
      a.workspaceSecrets.put({
        name: "llm_api_key",
        binding: "binding-a-changed",
        ciphertext: "ciphertext-a-changed",
        nonce: "nonce-a-changed",
        keyVersion: 1,
        lastFour: null,
        updatedBy: null,
      }),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  // #555: the names of a catalog provider's key slots are listed for one workspace only
  {
    name: "workspaceSecrets.names",
    run: (a) => a.workspaceSecrets.names(),
    expectAnswer: (answer) =>
      expect(answer).toEqual(["llm_api_key", "llm_api_key.fakeai"]),
  },
  {
    name: "workspaceSecrets.remove",
    run: (a) => a.workspaceSecrets.remove("llm_api_key"),
    expectAnswer: (answer) => expect(answer).toBe(true),
  },
  // #426-T10: the same, for the name of a second provider's key
  {
    name: "workspaceSecrets.get (provider-qualified name)",
    run: (a) => a.workspaceSecrets.get("llm_api_key.fakeai"),
    expectAnswer: (answer) =>
      expect(answer).toMatchObject({ binding: "fakeai-a" }),
  },
  {
    name: "workspaceSecrets.put (provider-qualified name)",
    run: (a) =>
      a.workspaceSecrets.put({
        name: "llm_api_key.fakeai",
        binding: "fakeai-a-changed",
        ciphertext: "ciphertext-fakeai-a-changed",
        nonce: "nonce-fakeai-a-changed",
        keyVersion: 1,
        lastFour: null,
        updatedBy: null,
      }),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "workspaceSecrets.remove (provider-qualified name)",
    run: (a) => a.workspaceSecrets.remove("llm_api_key.fakeai"),
    expectAnswer: (answer) => expect(answer).toBe(true),
  },
  // entitlements: one row per workspace, so the scope alone decides whose row it is
  {
    name: "entitlements.get",
    run: (a) => a.entitlements.get(),
    expectAnswer: (answer) =>
      expect(answer).toMatchObject({ planLabel: "plan-a" }),
  },
  {
    name: "entitlements.put",
    run: (a) =>
      a.entitlements.put(entitlementsOf("a", { planLabel: "changed" }), null),
    expectAnswer: (answer) =>
      expect(answer).toMatchObject({ planLabel: "changed" }),
  },
  {
    name: "entitlements.remove",
    run: (a) => a.entitlements.remove(),
    expectAnswer: (answer) => expect(answer).toBe(true),
  },
  // usage records: a job of B is not there for A, so it is neither reserved, changed nor settled, and
  // A's reads and pages do not see B's records
  {
    name: "usage.reserve",
    run: (a, b) => a.usage.reserve(b.job.id, "own"),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "usage.openBilling",
    run: (a, b) => a.usage.openBilling(b.job.id),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "usage.closeBilling",
    run: (a, b) => a.usage.closeBilling(b.job.id),
    expectAnswer: (answer) => expect(answer).toBe(false),
  },
  {
    name: "usage.setKeyMode",
    run: (a, b) => a.usage.setKeyMode(b.job.id, "own"),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "usage.setSelection",
    run: (a, b) =>
      a.usage.setSelection(b.job.id, {
        provider: "openrouter",
        catalogEntry: { id: "mce_other", name: "Other" },
      }),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "usage.settle",
    run: (a, b) =>
      a.usage.settle(b.job.id, {
        state: "settled",
        costMicroUsd: 999,
        promptTokens: 1,
        completionTokens: 1,
      }),
    // Another workspace's job is not there: nothing was settled.
    expectAnswer: (answer) => expect(answer).toBe(false),
  },
  {
    name: "usage.markSuperseded",
    run: (a, b) => a.usage.markSuperseded([b.job.id]),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "usage.voidEndedJobs",
    run: (a) => a.usage.voidEndedJobs(),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "usage.voidEndedJobsWithIds",
    run: (a) => a.usage.voidEndedJobsWithIds(),
    expectAnswer: (answer) => expect(answer).toEqual([]),
  },
  {
    name: "usage.get",
    run: (a, b) => a.usage.get(b.job.id),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "usage.countByKind",
    run: (a) => a.usage.countByKind("2000-01-01T00:00:00.000Z"),
    expectAnswer: (answer) => expect(answer).toEqual({ diff: 1, dynamic: 0 }),
  },
  // the started reviews (#499): A counts its own record, never B's
  {
    name: "usage.startedSince",
    run: (a) => a.usage.startedSince("2000-01-01T00:00:00.000Z"),
    expectAnswer: (answer) => expect(answer).toBe(1),
  },
  {
    name: "usage.sumSettledCostMicroUsd",
    run: (a) =>
      a.usage.sumSettledCostMicroUsd("2000-01-01T00:00:00.000Z", "managed"),
    expectAnswer: (answer) => expect(answer).toBe(0),
  },
  {
    name: "usage.pageSettled",
    run: (a) => a.usage.pageSettled({ limit: 50 }),
    expectAnswer: (answer) => expect(answer).toMatchObject({ records: [] }),
  },
  {
    name: "usage.summarize",
    run: (a) =>
      a.usage.summarize({
        from: "2000-01-01T00:00:00.000Z",
        to: "2100-01-01T00:00:00.000Z",
      }),
    expectAnswer: (answer) =>
      expect(answer).toEqual([
        expect.objectContaining({ recordCount: 1, settledCount: 0 }),
      ]),
  },
  // refusal notices: B's pull request is not one of A's, so A neither sees, takes nor changes B's notice
  {
    name: "notices.find",
    run: (a, b) => a.notices.find(noticeKeyOf(b.repository.id)),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "notices.begin",
    run: (a, b) =>
      a.notices.begin(
        { ...noticeKeyOf(b.repository.id), prNumber: 8 },
        "quota_exhausted",
        NOTICE_OPTIONS,
      ),
    expectAnswer: (answer) => expect(answer).toEqual({ acquired: false }),
  },
  {
    name: "notices.markPosted",
    run: (a, b) => a.notices.markPosted(b.notice.id),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "notices.markDropped",
    run: (a, b) => a.notices.markDropped(b.notice.id),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "notices.failed",
    run: (a, b) =>
      a.notices.failed(b.notice.id, new Date("2099-01-01T00:00:00.000Z")),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  // job check runs (#405): B's job is not one of A's, so A neither sees, takes nor changes B's check run record
  // (#405-T35, for every method of the repository below)
  {
    name: "jobChecks.find",
    run: (a, b) => a.jobChecks.find(b.job.id),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "jobChecks.take",
    run: (a, b) => a.jobChecks.take(b.job.id, CHECK_LEASE),
    expectAnswer: (answer) => expect(answer).toEqual({ acquired: false }),
  },
  {
    name: "jobChecks.noteStarted",
    run: (a, b) => a.jobChecks.noteStarted(b.job.id, "check"),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "jobChecks.recordCheck",
    run: (a, b) =>
      a.jobChecks.recordCheck(b.job.id, {
        checkRunId: "hijacked",
        syncedStatus: "running",
      }),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "jobChecks.dropCheck",
    run: (a, b) => a.jobChecks.dropCheck(b.job.id, "X"),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "jobChecks.lastReviewEventOfPullRequest",
    run: (a, b) => a.jobChecks.lastReviewEventOfPullRequest(b.job.id),
    expectAnswer: (answer) => expect(answer).toBeNull(),
  },
  {
    name: "jobChecks.forgetCheckAttempts",
    run: (a, b) => a.jobChecks.forgetCheckAttempts(b.job.id),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "jobChecks.recordReview",
    run: (a, b) =>
      a.jobChecks.recordReview(b.job.id, {
        reviewId: "hijacked",
        reviewState: "done",
      }),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "jobChecks.recordReviewComment",
    run: (a, b) => a.jobChecks.recordReviewComment(b.job.id, "hijacked"),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "jobChecks.reviewCommentOf",
    run: (a, b) => a.jobChecks.reviewCommentOf(b.job.id),
    expectAnswer: (answer) => expect(answer).toBeNull(),
  },
  {
    name: "jobChecks.finish",
    run: (a, b) => a.jobChecks.finish(b.job.id, { settled: true }),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "jobChecks.failed",
    run: (a, b) =>
      a.jobChecks.failed(b.job.id, {
        code: "X",
        retryAt: new Date("2099-01-01T00:00:00.000Z"),
        maxAttempts: 1,
      }),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "jobChecks.drop",
    run: (a, b) => a.jobChecks.drop(b.job.id, "X"),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  // VM runs (#493-T11): B's job is not one of A's, so A neither sees, starts, ends, measures nor adds to its VM runs
  {
    name: "vmRuns.list",
    run: (a) => a.vmRuns.list("failed-b"),
    expectAnswer: (answer) => expect(answer).toEqual([]),
  },
  {
    name: "vmRuns.recordStart",
    run: (a, b) =>
      a.vmRuns.recordStart({
        jobId: b.job.id,
        vmName: "hijacked",
        claimedAt: "2026-10-10T23:50:00.000Z",
        attempt: 1,
        startedAt: new Date("2026-10-10T23:51:00.000Z"),
        vmTimeoutSeconds: 2100,
      }),
    expectAnswer: (answer) => expect(answer).toBe("refused"),
  },
  {
    name: "vmRuns.confirmStopped",
    run: (a) =>
      a.vmRuns.confirmStopped(
        "failed-b",
        ["vm-b"],
        new Date("2026-10-11T00:00:30.000Z"),
      ),
    expectAnswer: (answer) => expect(answer).toBe(0),
  },
  {
    name: "vmRuns.recordWallClock",
    run: (a) => a.vmRuns.recordWallClock("failed-b"),
    expectAnswer: (answer) => expect(answer).toBe("not_measurable"),
  },
  {
    name: "vmRuns.measure",
    run: (a) => a.vmRuns.measure("failed-b"),
    expectAnswer: (answer) => expect(answer).toEqual({ state: "not_ended" }),
  },
  // handoff tokens: making one under A for B's Owner revokes nothing of B's
  {
    name: "planHandoff.issue",
    run: (a, b) =>
      a.planHandoff.issue({
        tokenHash: "handoff-from-a",
        userId: b.userId,
        role: "owner",
        ttlMs: 5 * 60 * 1000,
      }),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  // the balance journal: A's entries, balance and holds are A's own; B's key, hold and entry are not there for A, and
  // what A writes under the same keys lands in A
  {
    name: "billing.append",
    run: (a) =>
      a.billing.append({
        type: "top_up",
        amountMicroUsd: 1_000_000,
        refKey: "pi-b",
      }),
    expectAnswer: (answer, a) =>
      expect(answer).toMatchObject({
        created: true,
        entry: { workspaceId: a.workspaceId, refKey: "pi-b" },
      }),
  },
  {
    name: "billing.append (a reversal of an entry of B)",
    run: (a, b) =>
      settle(() =>
        a.billing.append({
          type: "correction",
          amountMicroUsd: -5_000_000,
          refKey: "reverse-b",
          reversesEntryId: b.journalEntryId,
        }),
      ),
    expectAnswer: notFound("reversed_entry_not_found"),
  },
  {
    name: "billing.reserve",
    run: (a, b) => a.billing.reserve(1_000_000, b.heldJobId),
    expectAnswer: (answer, a) =>
      expect(answer).toMatchObject({
        ok: true,
        created: true,
        entry: { workspaceId: a.workspaceId },
      }),
  },
  {
    // #605: the price of a job is keyed by workspace and job, so a job id of B writes an entry of A, never of B
    name: "billing.charge",
    run: (a, b) =>
      a.billing.charge(b.heldJobId, {
        aiMicroUsd: 0,
        infraMicroUsd: 500_000,
        minutes: 1,
        reviewKind: "diff",
      }),
    expectAnswer: (answer, a) =>
      expect(answer).toMatchObject({
        created: true,
        entry: { workspaceId: a.workspaceId },
      }),
  },
  {
    name: "billing.settle",
    run: (a, b) =>
      a.billing.settle(b.heldJobId, {
        aiMicroUsd: 0,
        infraMicroUsd: 500_000,
        minutes: 1,
        reviewKind: "diff",
      }),
    expectAnswer: (answer) =>
      expect(answer).toEqual({ ok: false, code: "reservation_not_found" }),
  },
  {
    name: "billing.release",
    run: (a, b) => a.billing.release(b.heldJobId),
    expectAnswer: (answer) =>
      expect(answer).toEqual({ ok: false, code: "reservation_not_found" }),
  },
  {
    name: "billing.balance",
    run: (a) => a.billing.balance(),
    expectAnswer: (answer) =>
      expect(answer).toEqual({
        balanceMicroUsd: 4_000_000,
        reservedMicroUsd: 1_000_000,
      }),
  },
  {
    name: "billing.entries",
    run: (a) => a.billing.entries({ limit: 50 }),
    expectAnswer: (answer, a) => {
      const { entries } = answer as { entries: Array<{ workspaceId: string }> };
      expect(entries).toHaveLength(2);
      expect(entries.map((entry) => entry.workspaceId)).toEqual([
        a.workspaceId,
        a.workspaceId,
      ]);
    },
  },
  // the charged total (#499): A was charged nothing, whatever B was
  {
    name: "billing.chargedSince",
    run: (a) => a.billing.chargedSince("2000-01-01T00:00:00.000Z"),
    expectAnswer: (answer) => expect(answer).toBe(0),
  },
  // the balance lock (#507) writes nothing, and it locks the row of A's own workspace only
  {
    name: "billing.lockBalance",
    run: (a) => a.billing.lockBalance(),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "billing.verify",
    run: (a) => a.billing.verify(),
    expectAnswer: (answer) =>
      expect(answer).toMatchObject({ consistent: true, differenceMicroUsd: 0 }),
  },
  // the journal lookup by key (#497): B's entry is not there for A
  {
    name: "billing.findByKey",
    run: (a) => a.billing.findByKey("top_up", "pi-b"),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  // the top-up intents (#497): A sees only its own; B's intent is not there for A, and what A creates lands in A
  {
    name: "topUpIntents.get",
    run: (a, b) => a.topUpIntents.get(b.topUpIntentId),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "topUpIntents.list",
    run: (a) => a.topUpIntents.list({ limit: 50 }),
    expectAnswer: (answer, a) => {
      const intents = answer as Array<{ workspaceId: string }>;
      expect(intents).toHaveLength(2);
      expect(
        intents.every((intent) => intent.workspaceId === a.workspaceId),
      ).toBe(true);
    },
  },
  {
    name: "topUpIntents.create",
    run: (a) =>
      a.topUpIntents.create({ adapter: "fake", amountMicroUsd: 10_000_000 }),
    expectAnswer: (answer, a) =>
      expect(answer).toMatchObject({
        workspaceId: a.workspaceId,
        state: "pending",
      }),
  },
  {
    name: "topUpIntents.attachRefs",
    run: (a, b) =>
      a.topUpIntents.attachRefs(b.topUpIntentId, { paymentRef: "pi-stolen" }),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "topUpIntents.markPaid",
    run: (a, b) =>
      a.topUpIntents.markPaid(b.topUpIntentId, {
        paymentRef: "pi-intent-b",
        creditedMicroUsd: 25_000_000,
      }),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "topUpIntents.markExpired",
    run: (a, b) => a.topUpIntents.markExpired(b.topUpIntentId),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "topUpIntents.addDebited",
    run: (a, b) => a.topUpIntents.addDebited(b.topUpIntentId, "refund", 1),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "topUpIntents.markFailedUnlessPage",
    run: (a, b) => a.topUpIntents.markFailedUnlessPage(b.unpagedIntentId),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    // Every pending intent of B without a page is old enough for this cutoff, and none of them is A's to fail.
    name: "topUpIntents.failPendingWithoutPage",
    run: (a) => a.topUpIntents.failPendingWithoutPage(-60_000),
    expectAnswer: (answer) => expect(answer).toBe(1),
  },
  {
    name: "topUpIntents.markFailed",
    run: (a, b) => a.topUpIntents.markFailed(b.topUpIntentId),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  // the billing profile (#501): A reads and writes its own; B's profile, confirmation and customer are not reachable from A
  {
    name: "profiles.get",
    run: (a) => a.profiles.get(),
    expectAnswer: (answer) =>
      expect(answer).toMatchObject({
        legalName: "Legal a GmbH",
        customerRef: "cus_a",
        createdAt: expect.any(String),
      }),
  },
  {
    name: "profiles.save",
    run: (a) =>
      a.profiles.save({
        legalName: "Changed GmbH",
        country: "FR",
        addressLine1: "Rue 1",
        addressLine2: null,
        postalCode: "75001",
        city: "Paris",
        vatId: null,
      }),
    expectAnswer: (answer) =>
      expect(answer).toMatchObject({
        legalName: "Changed GmbH",
        customerRef: "cus_a",
      }),
  },
  {
    name: "profiles.confirmBusiness",
    run: (a) =>
      a.profiles.confirmBusiness({ userId: "user-a", termsVersion: "1" }),
    expectAnswer: (answer) =>
      expect(answer).toMatchObject({
        confirmedBy: "user-a",
        legalName: "Legal a GmbH",
      }),
  },
  {
    name: "profiles.setCustomer",
    run: (a) => a.profiles.setCustomer("fake", "cus_new"),
    expectAnswer: (answer) =>
      expect(answer).toMatchObject({
        customerRef: "cus_new",
        legalName: "Legal a GmbH",
      }),
  },
  // the workspace billing settings (#499): A reads and sets its own limit; B's stays as it is
  {
    name: "limits.get",
    run: (a) => a.limits.get(),
    expectAnswer: (answer) =>
      expect(answer).toMatchObject({ monthlyLimitMicroUsd: 10_000_000 }),
  },
  {
    name: "limits.monthlyLimitMicroUsd",
    run: (a) => a.limits.monthlyLimitMicroUsd(),
    expectAnswer: (answer) => expect(answer).toBe(10_000_000),
  },
  {
    name: "limits.setMonthlyLimit",
    run: (a) => a.limits.setMonthlyLimit(null, null),
    expectAnswer: (answer) =>
      expect(answer).toMatchObject({ monthlyLimitMicroUsd: null }),
  },
  // #506-T09: the balance notifications: A reads, marks and re-arms its own rows; B's "low" and its mail stay as they are
  {
    name: "notifications.list",
    run: (a) => a.notifications.list(),
    expectAnswer: (answer) =>
      expect(answer).toEqual([
        expect.objectContaining({ kind: "empty", state: "sent" }),
      ]),
  },
  {
    name: "notifications.get",
    run: (a) => a.notifications.get("low"),
    expectAnswer: (answer) =>
      expect(answer).toMatchObject({ kind: "low", state: "armed" }),
  },
  {
    name: "notifications.markSent",
    run: (a) => a.notifications.markSent("low", "due"),
    expectAnswer: (answer) => expect(answer).toBe(true),
  },
  {
    name: "notifications.rearm",
    run: (a) => a.notifications.rearm("low"),
    expectAnswer: (answer) => expect(answer).toBe(false),
  },
  // erasure (#658): A's scope reads nothing of B's (B has a queued job and a pending top-up intent) and erases only A.
  {
    name: "erasure.hasRunningJobs",
    run: (a) => a.erasure.hasRunningJobs(new Date("2026-10-23T12:00:00.000Z")),
    expectAnswer: (answer) => expect(answer).toBe(false),
  },
  {
    name: "erasure.lockActiveJobs",
    run: (a) => a.erasure.lockActiveJobs(),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "erasure.openChecks",
    run: (a) => a.erasure.openChecks(),
    // Only A's own waiting check run, never B's.
    expectAnswer: (answer, a) =>
      expect(answer).toMatchObject([
        { jobId: a.job.id, checkRunId: "check-a" },
      ]),
  },
  {
    name: "erasure.hasOpenPayment",
    run: (a) => a.erasure.hasOpenPayment(new Date("2000-01-01T00:00:00.000Z")),
    expectAnswer: (answer) => expect(answer).toBe(true),
  },
  {
    name: "erasure.erase",
    run: (a) =>
      a.erasure.erase({
        name: "Deleted",
        slug: "deleted-a",
        deletedAt: new Date("2026-10-23T12:00:00.000Z"),
      }),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  // implementer sessions (#751-T02): B's session, turn and branch are not A's to read, extend or change
  {
    name: "implementer.getSession",
    run: (a, b) => a.implementer.getSession(taskOf(b).session.id),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "implementer.getTurnByJob",
    run: (a, b) => a.implementer.getTurnByJob(taskOf(b).turn.jobId),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "implementer.listForRepository",
    run: (a, b) => a.implementer.listForRepository(b.repository.id),
    expectAnswer: (answer) => expect(answer).toEqual([]),
  },
  {
    name: "implementer.recordTurnResult",
    run: (a, b) =>
      a.implementer.recordTurnResult(taskOf(b).session.id, {
        headCommit: "e".repeat(40),
        opencode: { sessionId: "hijacked", version: "1.0.0" },
        summary: "hijacked",
      }),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "implementer.createSessionWithTurn",
    run: (a, b) =>
      settle(() =>
        a.implementer.createSessionWithTurn(
          {
            repositoryId: b.repository.id,
            baseBranch: "main",
            branch: "implementer/from-a",
            instruction: "Do it.",
            modelChoice: { entryId: "entry-a" },
            costLimitCents: null,
            createdBy: "user-a",
          },
          async () => b.job.id,
        ),
      ),
    expectAnswer: notFound("IMPLEMENTER_REPOSITORY_NOT_FOUND"),
  },
  // runs
  {
    name: "runs.list",
    run: (a) => a.runs.list({ limit: 50 }),
    expectAnswer: (answer, a) =>
      expect(answer).toMatchObject({
        runs: [{ job: expect.objectContaining({ id: a.job.id }) }],
        hasMore: false,
      }),
  },
  {
    name: "runs.get",
    run: (a, b) => a.runs.get(b.job.id),
    expectAnswer: (answer) => expect(answer).toBeUndefined(),
  },
  {
    name: "runs.latestPerRepository",
    run: (a, b) => a.runs.latestPerRepository([b.repository.id]),
    expectAnswer: (answer) => expect(answer).toEqual([]),
  },
];

async function twoWorkspaces() {
  const { db } = await createTestDatabase();
  const idA = await defaultWorkspaceId(db);
  const idB = await addWorkspace(db, "other");
  const a = await seed(db, idA, "a");
  const b = await seed(db, idB, "b", {
    earlierFailedJob: true,
    implementerTask: true,
  });
  return { db, a, b, reposA: reposOf(db, idA), reposB: reposOf(db, idB) };
}

describe("the attempted heads inside the scope that owns them", () => {
  // Positive control for the "jobs.attemptedShas" case: the same query answers in B's own scope.
  it("names the failed head for the workspace that owns it", async () => {
    const { b, reposB } = await twoWorkspaces();

    const answer = await reposB.jobs.attemptedShas({
      repositoryId: b.repository.id,
      prNumber: 7,
      reviewKind: "diff",
      excludeJobId: b.job.id,
    });

    expect(answer).toEqual({ shas: [FAILED_SHA], truncated: false });
  });
});

describe("enqueueing under the scope of A against what B already has", () => {
  /**
   * B has a waiting automatic job (its run-after time is in the future, like a debounced push) and
   * a job that answers a comment. Every lookup that decides "this job exists already" must stay
   * inside the workspace: if one looks across workspaces, A is handed B's job (or B's job is changed)
   * instead of being refused.
   */
  async function withBusyB() {
    const base = await twoWorkspaces();
    const future = "2099-01-01T00:00:00.000Z";
    await base.db
      .updateTable("jobs")
      .set({ run_after: future })
      .where("id", "=", base.b.job.id)
      .execute();
    const commentJob = await base.reposB.jobs.enqueue({
      repositoryId: base.b.repository.id,
      prNumber: 8,
      prUrl: "https://github.test/acme/b/pull/8",
      headSha: SHA,
      reviewKind: "diff",
      command: "review",
      args: "",
      triggerKind: "comment",
      actorLogin: "octocat",
      deliveryId: "delivery-comment-b",
      commentId: "comment-b",
      runAfter: null,
    });
    if (commentJob.status !== "created") throw new Error("seeding failed");
    return { ...base, commentJob: commentJob.job };
  }

  const input = (repositoryId: string) => ({
    repositoryId,
    prNumber: 7,
    prUrl: "https://github.test/acme/b/pull/7",
    headSha: SHA,
    reviewKind: "diff" as const,
    command: "review" as const,
    args: "",
    triggerKind: "manual" as const,
    actorLogin: "mallory",
    deliveryId: null,
    commentId: null,
    runAfter: null,
  });

  // DM-06, DM-07
  it("is refused for the same pull request and command as a job of B, and B's job keeps its run-after time", async () => {
    const { db, b, reposA } = await withBusyB();
    const before = await rowsOf(db, b.workspaceId);

    // A person's job would be "already active" and pull B's waiting job forward.
    await expect(
      reposA.jobs.enqueue(input(b.repository.id)),
    ).rejects.toMatchObject({ code: "23503" });

    expect(await rowsOf(db, b.workspaceId)).toEqual(before);
  });

  // DM-06, DM-07
  it("is refused for the same head commit as an automatic job of B, which it would otherwise return", async () => {
    const { db, b, reposA } = await withBusyB();
    const before = await rowsOf(db, b.workspaceId);

    await expect(
      reposA.jobs.enqueue({
        ...input(b.repository.id),
        triggerKind: "webhook",
        actorLogin: "octocat",
      }),
      // The unique index of automatic jobs per head commit may refuse it before the foreign key does.
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^2350[35]$/),
    });

    expect(await rowsOf(db, b.workspaceId)).toEqual(before);
  });

  // DM-06, DM-07
  it("does not return the job of B for the delivery id of B", async () => {
    const { db, a, b, reposA } = await withBusyB();
    const before = await rowsOf(db, b.workspaceId);

    // A valid job in A's own repository that only reuses B's delivery id: the answer must not be
    // B's job. (The unique index on delivery ids is instance wide, so the insert is refused.)
    await expect(
      reposA.jobs.enqueue({
        ...input(a.repository.id),
        prNumber: 55,
        deliveryId: "delivery-b",
      }),
    ).rejects.toMatchObject({ code: "23505" });

    expect(await rowsOf(db, b.workspaceId)).toEqual(before);
  });

  // DM-06, DM-07
  it("does not return the job of B for the comment of B", async () => {
    const { db, b, reposA } = await withBusyB();
    const before = await rowsOf(db, b.workspaceId);

    await expect(
      reposA.jobs.enqueue({
        ...input(b.repository.id),
        prNumber: 8,
        triggerKind: "comment",
        commentId: "comment-b",
      }),
    ).rejects.toMatchObject({ code: "23503" });

    expect(await rowsOf(db, b.workspaceId)).toEqual(before);
    expect(
      await db
        .selectFrom("job_comments")
        .select("job_id")
        .where("comment_id", "=", "comment-b")
        .execute(),
    ).toEqual([{ job_id: expect.any(String) }]);
  });
});

describe("two workspaces", () => {
  // DM-06, DM-07
  it.each(CASES.map((testCase) => [testCase.name, testCase] as const))(
    "keep workspace B out of reach of %s under the scope of A",
    async (_name, testCase) => {
      const { db, a, b, reposA } = await twoWorkspaces();
      const before = await rowsOf(db, b.workspaceId);

      const answer = await testCase.run(reposA, b, db);

      testCase.expectAnswer(answer, a, b);
      expect(await rowsOf(db, b.workspaceId)).toEqual(before);
    },
  );

  // DM-06
  it("have a table row for every method of every scoped repository", async () => {
    const { reposA } = await twoWorkspaces();
    const covered = new Set(
      CASES.map((testCase) => testCase.name.split(" ")[0] ?? ""),
    );
    const methods = Object.entries(reposA).flatMap(([group, repository]) =>
      Object.keys(repository).map((method) => `${group}.${method}`),
    );

    expect(methods.length).toBeGreaterThan(0);
    for (const method of methods)
      expect(covered, `${method} has no case in CASES`).toContain(method);
  });

  // #271-T06
  // #426-T10: both workspaces hold the same names, so a read that lost its workspace filter would still find a row;
  // only a name that B alone holds shows it.
  it("keep the key of a provider apart on a read: A does not see the provider-qualified secret only B has", async () => {
    const { reposA, reposB } = await twoWorkspaces();
    await reposB.workspaceSecrets.put({
      name: "llm_api_key.onlyb",
      binding: "onlyb-b",
      ciphertext: "ciphertext-onlyb-b",
      nonce: "nonce-onlyb-b",
      keyVersion: 1,
      lastFour: null,
      updatedBy: "user-b",
    });

    expect(await reposA.workspaceSecrets.get("llm_api_key.onlyb")).toBe(
      undefined,
    );
    expect(
      await reposB.workspaceSecrets.get("llm_api_key.onlyb"),
    ).toMatchObject({ binding: "onlyb-b" });
  });

  it("keep the entitlements apart: changing A's leaves B with its own", async () => {
    const { reposA, reposB } = await twoWorkspaces();

    await reposA.entitlements.put(
      entitlementsOf("a", { planLabel: "changed" }),
      null,
    );
    expect(await reposB.entitlements.get()).toMatchObject({
      planLabel: "plan-b",
    });

    expect(await reposA.entitlements.get()).toMatchObject({
      planLabel: "changed",
    });
  });

  // #272-T06
  it("keep the usage records apart: B's records stay B's, each side counts and sums only its own", async () => {
    const { a, b, reposA, reposB } = await twoWorkspaces();
    const since = "2000-01-01T00:00:00.000Z";

    expect(await reposB.usage.get(b.job.id)).toMatchObject({
      workspaceId: b.workspaceId,
      state: "reserved",
    });
    expect(await reposA.usage.get(a.job.id)).toMatchObject({
      workspaceId: a.workspaceId,
    });
    expect(await reposB.usage.countByKind(since)).toEqual({
      diff: 3,
      dynamic: 0,
    });
    expect(await reposB.usage.sumSettledCostMicroUsd(since, "managed")).toBe(
      500,
    );
    expect(
      (await reposB.usage.pageSettled({ limit: 10 })).records,
    ).toHaveLength(1);
    const groups = await reposB.usage.summarize({
      from: since,
      to: "2100-01-01T00:00:00.000Z",
    });
    const total = (
      field: "recordCount" | "settledCount" | "knownCostMicroUsd",
    ) => groups.reduce((sum, group) => sum + group[field], 0);
    expect(total("recordCount")).toBe(3);
    expect(total("settledCount")).toBe(1);
    expect(total("knownCostMicroUsd")).toBe(500);
  });

  // DM-10
  it("keep the review defaults apart: changing A leaves B with its own", async () => {
    const { reposA, reposB } = await twoWorkspaces();

    await reposA.appSettings.set("review_defaults", { changed: true }, "alice");

    expect((await reposA.appSettings.get("review_defaults"))?.value).toEqual({
      changed: true,
    });
    expect((await reposB.appSettings.get("review_defaults"))?.value).toEqual({
      from: "b",
    });
  });

  // DM-10
  it("give a workspace that never saved defaults none, so the built-in values apply", async () => {
    const { db } = await twoWorkspaces();
    const third = reposOf(db, await addWorkspace(db, "third"));

    expect(await third.appSettings.get("review_defaults")).toBeUndefined();
  });

  it("can hold the same pull request number in both, each with its own job", async () => {
    const { a, b, reposA, reposB } = await twoWorkspaces();

    expect(await reposA.jobs.list()).toEqual([
      expect.objectContaining({ id: a.job.id, workspaceId: a.workspaceId }),
    ]);
    // B also holds its earlier failed job (seeded for the attempted-heads case), a cancelled one and the job of its Implementer turn.
    expect(await reposB.jobs.list()).toEqual([
      expect.objectContaining({
        id: "cancelled-b",
        workspaceId: b.workspaceId,
      }),
      expect.objectContaining({ id: "failed-b", workspaceId: b.workspaceId }),
      expect.objectContaining({ id: b.job.id, workspaceId: b.workspaceId }),
      expect.objectContaining({
        id: taskOf(b).turn.jobId,
        workspaceId: b.workspaceId,
      }),
    ]);
  });
});
