// SPDX-License-Identifier: LicenseRef-Proprietary

// A workspace as a customer leaves it, for the tests of its deletion (#658): the same rows in the integration test of the
// deletion and in the tests of the locks it takes, so they cannot drift apart.
import type { Kysely } from "kysely";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import { createBillingNotificationsRepository } from "../db/repositories/billing-notifications-repository.ts";
import { createBillingProfilesRepository } from "../db/repositories/billing-profiles-repository.ts";
import { createBillingTopUpIntentsRepository } from "../db/repositories/billing-topup-intents-repository.ts";
import { createImplementerRepository } from "../db/repositories/implementer-repository.ts";
import { createInstallationLinkRequestsRepository } from "../db/repositories/installation-link-requests-repository.ts";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createInvitationsRepository } from "../db/repositories/invitations-repository.ts";
import { createJobsRepository } from "../db/repositories/jobs-repository.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { createUsageRecordsRepository } from "../db/repositories/usage-records-repository.ts";
import { createWorkspaceEntitlementsRepository } from "../db/repositories/workspace-entitlements-repository.ts";
import { createWorkspaceMembersRepository } from "../db/repositories/workspace-members-repository.ts";
import { createWorkspaceSecretsRepository } from "../db/repositories/workspace-secrets-repository.ts";
import { createAppSettingsRepository } from "../db/repositories/app-settings-repository.ts";
import type { Database } from "../db/schema.ts";

const SHA = "b".repeat(40);

export async function addUser(db: Kysely<Database>, id: string) {
  await db
    .insertInto("users")
    .values({
      id,
      name: id,
      email: `${id}@example.test`,
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
}

/**
 * A workspace as a customer leaves it: an Owner and an Admin, an installation with a repository and a project, a queued
 * job with its usage record and check run, settings, a stored key, an invitation, a billing profile, and a journal whose
 * balance is `balance` (0 by spending the top-up on a job that finished).
 */
export async function seedWorkspaceForDeletion(
  db: Kysely<Database>,
  workspaceId: string,
  tag: string,
  options: { balanceMicroUsd: number },
) {
  await addUser(db, `owner-${tag}`);
  await addUser(db, `admin-${tag}`);
  const members = createWorkspaceMembersRepository(db, workspaceId);
  await members.add(`owner-${tag}`, "owner");
  await members.add(`admin-${tag}`, "admin");
  const integrations = createIntegrationsRepository(db, workspaceId);
  const integration = await integrations.create({
    type: "github_app",
    displayName: `acme-${tag}`,
    externalId: `installation-${tag}`,
    config: { accountLogin: `acme-${tag}`, accountType: "Organization" },
  });
  const repositories = createRepositoriesRepository(db, workspaceId);
  await repositories.reconcile(integration.id, [
    {
      integrationId: integration.id,
      externalId: `repo-${tag}`,
      fullName: `acme/${tag}`,
      url: `https://github.test/acme/${tag}`,
    },
  ]);
  const [repository] = await repositories.list();
  if (repository === undefined) throw new Error("seeding failed");
  await createProjectsRepository(db, workspaceId).activate(repository.id);
  const jobs = createJobsRepository(db, workspaceId);
  const enqueue = async (prNumber: number, deliveryId: string) => {
    const enqueued = await jobs.enqueue({
      repositoryId: repository.id,
      prNumber,
      prUrl: `https://github.test/acme/${tag}/pull/${prNumber}`,
      headSha: SHA,
      reviewKind: "diff",
      command: "review",
      args: "",
      triggerKind: "webhook",
      actorLogin: "octocat",
      deliveryId,
      commentId: "comment-" + deliveryId,
      runAfter: null,
    });
    if (enqueued.status !== "created") throw new Error("seeding failed");
    return enqueued.job;
  };
  const queued = await enqueue(7, `delivery-${tag}`);
  // The finished job is also the job of the Implementer turn below, so it carries the negative slot (-1: the first session).
  const finished = await enqueue(-1, `delivery-finished-${tag}`);
  const usage = createUsageRecordsRepository(db, workspaceId);
  await usage.reserve(queued.id, "own");
  await db
    .insertInto("job_vm_runs")
    .values({
      job_id: finished.id,
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
  // #751-T08: a session of the Implementer (slot 1) and its turn, whose job is one of the workspace's own.
  await createImplementerRepository(db, workspaceId).createSessionWithTurn(
    {
      repositoryId: repository.id,
      baseBranch: "main",
      branch: `implementer/${tag}`,
      instruction: `Instruction ${tag}`,
      modelChoice: { entryId: `entry-${tag}` },
      costLimitCents: null,
      createdBy: `owner-${tag}`,
    },
    async () => finished.id,
  );
  await db
    .insertInto("job_dispatches")
    .values({
      job_id: queued.id,
      state: "pending",
      attempts: 0,
      consecutive_failures: 0,
      next_dispatch_at: "2026-10-23T12:00:00.000Z",
      acked_at: null,
      last_attempt_at: null,
      last_status: null,
      last_code: null,
      created_at: "2026-10-23T12:00:00.000Z",
      updated_at: "2026-10-23T12:00:00.000Z",
    })
    .execute();
  await db
    .insertInto("job_check_runs")
    .values({
      job_id: queued.id,
      workspace_id: workspaceId,
      next_attempt_at: "2026-10-23T12:00:00.000Z",
      created_at: "2026-10-23T12:00:00.000Z",
      updated_at: "2026-10-23T12:00:00.000Z",
    })
    .execute();
  await createAppSettingsRepository(db, workspaceId).set(
    "review_defaults",
    { from: tag },
    tag,
  );
  await createWorkspaceSecretsRepository(db, workspaceId).put({
    name: "llm_api_key",
    binding: `binding-${tag}`,
    ciphertext: `ciphertext-${tag}`,
    nonce: `nonce-${tag}`,
    keyVersion: 1,
    lastFour: null,
    updatedBy: `owner-${tag}`,
  });
  await createWorkspaceEntitlementsRepository(db, workspaceId).put(
    {
      planLabel: `plan-${tag}`,
      keyMode: "managed",
      limits: {
        diffRunsPerPeriod: 10,
        dynamicRunsPerPeriod: null,
        managedCostLimitMicroUsd: 1000,
        ownKeyCostLimitMicroUsd: null,
      },
      periodStart: "2026-10-01T00:00:00.000Z",
      suspended: false,
      suspensionCode: null,
    },
    `owner-${tag}`,
  );
  await createInvitationsRepository(db, workspaceId).create({
    id: `invitation-${tag}`,
    email: `invited-${tag}@example.test`,
    role: "member",
    invitedBy: `owner-${tag}`,
    tokenHash: `hash-${tag}`,
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
  });
  await createInstallationLinkRequestsRepository(db, workspaceId).createPending(
    {
      requestedBy: `owner-${tag}`,
      requesterGithubLogin: `login-${tag}`,
      installationId: `requested-${tag}`,
      accountLogin: `acme-${tag}`,
      accountType: "Organization",
      accountId: `account-${tag}`,
      evidence: {
        tokenCanAccess: true,
        roleResult: "unreadable",
        roleDetail: "forbidden",
      },
    },
  );
  const profiles = createBillingProfilesRepository(db, workspaceId);
  await profiles.save({
    legalName: `Legal ${tag} GmbH`,
    country: "DE",
    addressLine1: `Street ${tag}`,
    addressLine2: `Floor ${tag}`,
    postalCode: "10115",
    city: "Berlin",
    vatId: "DE123456789",
  });
  await profiles.confirmBusiness({
    userId: `owner-${tag}`,
    termsVersion: "2026-10",
  });
  await profiles.setCustomer("fake", `cus_${tag}`);
  await createBillingNotificationsRepository(db, workspaceId).markSent(
    "empty",
    "due",
  );
  const intents = createBillingTopUpIntentsRepository(db, workspaceId);
  const paid = await intents.create({
    adapter: "fake",
    amountMicroUsd: 25_000_000,
  });
  await intents.attachRefs(paid.id, {
    checkoutRef: `cs-${tag}`,
    paymentRef: `pi-${tag}`,
  });
  // Paid long ago: an intent that is still pending would be an open payment.
  await db
    .updateTable("billing_topup_intents")
    .set({ state: "paid", created_at: "2026-09-01T00:00:00.000Z" })
    .where("id", "=", paid.id)
    .execute();
  const journal = createBillingJournalRepository(db, workspaceId);
  await journal.append({
    type: "top_up",
    amountMicroUsd: 5_000_000,
    refKey: `pi-${tag}`,
  });
  const spent = 5_000_000 - options.balanceMicroUsd;
  if (spent > 0)
    await journal.charge(finished.id, {
      aiMicroUsd: spent,
      infraMicroUsd: 0,
      minutes: 1,
      reviewKind: "diff",
    });
  return { workspaceId, tag, queuedJobId: queued.id, integration };
}

export type SeededWorkspace = Awaited<
  ReturnType<typeof seedWorkspaceForDeletion>
>;
