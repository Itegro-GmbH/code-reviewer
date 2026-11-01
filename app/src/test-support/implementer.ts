// SPDX-License-Identifier: LicenseRef-Proprietary

// Implementer sessions for tests (#751): a workspace with a repository, and a task started the way the queue will start one
// (P7, #752): the session and the turn are made by the implementer repository, and the job in between by the callback, with
// the placeholders of the plan (`pr_number = -slot`) so the unique index of the queue works on them.
import type { Kysely } from "kysely";
import { createImplementerRepository } from "../db/repositories/implementer-repository.ts";
import type { NewImplementerTask } from "../db/repositories/implementer-repository.ts";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createJobsRepository } from "../db/repositories/jobs-repository.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import type { Database } from "../db/schema.ts";
import { addUser } from "./workspace-deletion-fixture.ts";

const BASE_SHA = "a".repeat(40);

/** A user, an installation and one active repository with an active project in `workspaceId`. */
export async function seedImplementerRepository(
  db: Kysely<Database>,
  workspaceId: string,
  tag: string,
) {
  const userId = `user-${tag}`;
  await addUser(db, userId);
  const integration = await createIntegrationsRepository(
    db,
    workspaceId,
  ).create({
    type: "github_app",
    displayName: `acme-${tag}`,
    externalId: `installation-${tag}`,
    config: {},
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
  return { userId, repositoryId: repository.id, repoUrl: repository.url };
}

/** The task of a session; every field has a default so that a test names only what it is about. */
export function taskOf(
  seed: { userId: string; repositoryId: string },
  overrides: Partial<NewImplementerTask> = {},
): NewImplementerTask {
  return {
    repositoryId: seed.repositoryId,
    baseBranch: "main",
    branch: "implementer/abc123",
    instruction: "Add a health endpoint.",
    modelChoice: { entryId: "entry-1" },
    costLimitCents: null,
    createdBy: seed.userId,
    ...overrides,
  };
}

/** A queued job in the shape of a turn's (`pr_number` negative), made by the jobs repository of the workspace. */
export async function enqueueTurnJob(
  db: Kysely<Database>,
  workspaceId: string,
  input: {
    repositoryId: string;
    slot: number;
    branch: string;
    repoUrl: string;
  },
): Promise<string> {
  const created = await createJobsRepository(db, workspaceId).enqueue({
    repositoryId: input.repositoryId,
    prNumber: -input.slot,
    prUrl: `${input.repoUrl}/tree/${input.branch}`,
    headSha: BASE_SHA,
    reviewKind: "diff",
    command: "review",
    args: "",
    triggerKind: "manual",
    actorLogin: "octocat",
    deliveryId: `implementer:${input.repositoryId}:${input.branch}`,
    commentId: null,
    runAfter: null,
  });
  if (created.status !== "created")
    throw new Error(`the test job was not created: ${created.status}`);
  return created.job.id;
}

/**
 * Starts a task like the queue will: the job is made inside the transaction of the session, by the jobs repository of the same
 * workspace, with the slot as a negative pull request number.
 */
export function startTask(
  db: Kysely<Database>,
  workspaceId: string,
  task: NewImplementerTask,
  repoUrl = "https://github.test/acme/x",
) {
  return createImplementerRepository(db, workspaceId).createSessionWithTurn(
    task,
    (trx, { slot }) =>
      enqueueTurnJob(trx, workspaceId, {
        repositoryId: task.repositoryId,
        slot,
        branch: task.branch,
        repoUrl,
      }),
  );
}
