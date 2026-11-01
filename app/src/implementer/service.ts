// SPDX-License-Identifier: LicenseRef-Proprietary

// The server side of "send off a task" (#755, part of #745): which repositories, which branches and which models a person can
// pick, and the submit. It follows the pattern of `manual-reviews` (service, http, errors, shared). The browser names ids and
// words; the workspace's own rows and the platform decide, in this order: the body is valid, the repository is this
// workspace's and its integration is active (before all of it: a request that was accepted before is answered with what it
// made, #791), the installation has accepted the permission to write contents, the repository
// path still resolves (`getRepositoryFacts`, which `getBranch` needs before a null can be believed), the base branch exists,
// the new branch does not exist and is no folder or file of a listed one, the model is one the claim would run, the cost limit is within the operator's maximum. Then one
// transaction writes the session, the turn and the job (`queue.enqueueImplementerTurn`), and the queue wakes the Dispatcher.
// Nothing is written before the last step, and a platform that cannot be asked ends the submit with 503.
import type { IntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import type { RepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { ImplementerStoreError } from "../db/implementer-errors.ts";
import {
  IntegrationError,
  type IntegrationErrorCode,
} from "../integrations/errors.ts";
import type { IntegrationRegistry } from "../integrations/registry.ts";
import type { Integration, RepoRef } from "../integrations/types.ts";
import type { ModelChoice } from "../db/implementer-model-choice.ts";
import { JobQueueError } from "../jobs/errors.ts";
import type { EnqueueImplementerTurnResult } from "../jobs/job-types.ts";
import type { JobQueue } from "../jobs/job-queue.ts";
import { branchConflict } from "./branch-name.ts";
import { ImplementerError, type UnwritableReason } from "./errors.ts";
import type { ImplementerModels, ModelOptions } from "./models.ts";
import { validateStartInput, type StartInput } from "./start-input.ts";

export type RepositoryChoice = {
  id: string;
  fullName: string;
  /** Whether the installation has accepted the permission to write contents; false: the form says so and offers no task. */
  writeGranted: boolean;
  /** Why not, when `writeGranted` is false: the permission is missing, or the platform refuses the app for another reason. */
  unwritable: UnwritableReason | null;
};

export type BranchChoices = {
  defaultBranch: string;
  /** At most the first 100, the default branch first. */
  branches: string[];
  /** There are more branches than the list holds. */
  truncated: boolean;
};

export type StartedTask = {
  /** The id of the job, which is the id of its run. */
  runId: string;
  sessionId: string;
  /** False when the same client request id was accepted before: the ids are those of that task and nothing was written. */
  created: boolean;
};

export type ImplementerService = {
  /** The active repositories of the workspace whose integration is active (a project is not needed), by name. */
  listRepositories(): Promise<{ repositories: RepositoryChoice[] }>;
  listBranches(repositoryId: string): Promise<BranchChoices>;
  listModels(): Promise<ModelOptions>;
  /**
   * Starts a task. `user` is the signed-in person: `id` is recorded as the creator of the session, `githubLogin` as the actor
   * of the job. `input` is the body as received and is checked here. Throws an `ImplementerError`.
   */
  startTask(
    user: { id: string; githubLogin: string },
    input: unknown,
  ): Promise<StartedTask>;
};

export type ImplementerServiceDependencies = {
  repositories: Pick<RepositoriesRepository, "get" | "list">;
  integrations: Pick<IntegrationsRepository, "get" | "list">;
  registry: Pick<IntegrationRegistry, "resolve">;
  models: ImplementerModels;
  queue: Pick<JobQueue, "enqueueImplementerTurn" | "findImplementerTurn">;
  /** The operator's maximum cost per turn in whole US cents, read for each call. */
  operatorCostLimitCents(): Promise<number>;
  /** One line per started task; never carries the instruction, a model or a token. */
  log?: (line: string) => void;
};

const MAX_ID_LENGTH = 128;

const NOT_FOUND = () =>
  new ImplementerError(
    "IMPLEMENTER_REPOSITORY_NOT_FOUND",
    "There is no such repository in this workspace.",
  );
const NOT_INSTALLED = () =>
  new ImplementerError(
    "IMPLEMENTER_APP_NOT_INSTALLED",
    "The app is not installed for this repository any more, or GitHub refuses it access.",
  );
const UNAVAILABLE = () =>
  new ImplementerError(
    "IMPLEMENTER_GITHUB_UNAVAILABLE",
    "GitHub could not be asked, or answered with something unusable.",
  );
const BRANCH_EXISTS = () =>
  new ImplementerError(
    "IMPLEMENTER_BRANCH_EXISTS",
    "A branch or an earlier task of this repository already has this branch name. Choose a new branch name.",
  );

const BRANCH_CONFLICT = () =>
  new ImplementerError(
    "IMPLEMENTER_BRANCH_CONFLICT",
    "A branch name cannot be a folder of another branch (foo and foo/bar), and a branch of this repository already has such a name. Choose a new branch name.",
  );

/**
 * The codes of an access failure that mean the app has no (more) access to the connection or the repository, each with the
 * reason the form gives for it.
 */
const NO_ACCESS_REASONS: Partial<
  Record<IntegrationErrorCode, UnwritableReason>
> = {
  INTEGRATION_ACCESS_CONNECTION_GONE: "connection_gone",
  INTEGRATION_ACCESS_CONNECTION_SUSPENDED: "connection_suspended",
  INTEGRATION_ACCESS_APP_AUTH_FAILED: "app_auth_failed",
  INTEGRATION_ACCESS_SCOPE_REFUSED: "scope_refused",
  INTEGRATION_REPOSITORY_NOT_ACCESSIBLE: "repository_not_accessible",
};

function noAccessReason(error: unknown): UnwritableReason | undefined {
  return error instanceof IntegrationError
    ? NO_ACCESS_REASONS[error.code]
    : undefined;
}

function isNoAccess(error: unknown): boolean {
  return noAccessReason(error) !== undefined;
}

/** What went wrong while asking the platform, as an error of this module. */
function platformFailure(error: unknown): ImplementerError {
  if (error instanceof ImplementerError) return error;
  return isNoAccess(error) ? NOT_INSTALLED() : UNAVAILABLE();
}

/** Whether a stored model choice is the one of the body: the same entry, or the same provider and model. */
function sameModel(stored: ModelChoice, asked: ModelChoice): boolean {
  if ("entryId" in stored || "entryId" in asked)
    return (
      "entryId" in stored &&
      "entryId" in asked &&
      stored.entryId === asked.entryId
    );
  return stored.provider === asked.provider && stored.model === asked.model;
}

/** The answer for a request id that made a task before: that task when the body is the same, else the conflict. */
function repeatOf(
  earlier: EnqueueImplementerTurnResult,
  task: StartInput,
): StartedTask {
  const { session, turn } = earlier;
  const same =
    session.repositoryId === task.repositoryId &&
    session.baseBranch === task.baseBranch &&
    session.branch === task.branch &&
    turn.instruction === task.instruction &&
    turn.costLimitCents === task.costLimitCents &&
    sameModel(turn.modelChoice, task.model);
  if (!same)
    throw new ImplementerError(
      "IMPLEMENTER_REQUEST_REUSED",
      "This request id made another task.",
      { runId: earlier.job.id },
    );
  return { runId: earlier.job.id, sessionId: session.id, created: false };
}

export function createImplementerService(
  deps: ImplementerServiceDependencies,
): ImplementerService {
  const log = deps.log ?? ((line) => console.info(line));

  /** The repository, its active integration and the reference the provider needs, or the refusal. Nothing is asked of the platform. */
  async function resolveRepository(repositoryId: string): Promise<{
    integration: Integration;
    repo: RepoRef;
  }> {
    if (
      typeof repositoryId !== "string" ||
      repositoryId.trim() === "" ||
      repositoryId.length > MAX_ID_LENGTH
    )
      throw new ImplementerError(
        "IMPLEMENTER_REQUEST_INVALID",
        "The repository id is missing or malformed.",
      );
    // Postgres refuses a NUL in text (22021) and the request would end in a 500: no row has such an id, so it is an unknown id.
    if (repositoryId.includes("\u0000")) throw NOT_FOUND();
    const repository = await deps.repositories.get(repositoryId);
    if (repository === undefined || !repository.active) throw NOT_FOUND();
    const integration = await deps.integrations.get(repository.integrationId);
    if (integration === undefined) throw NOT_FOUND();
    if (integration.status !== "active") throw NOT_INSTALLED();
    return {
      integration,
      repo: {
        integrationId: repository.integrationId,
        externalId: repository.externalId,
        fullName: repository.fullName,
        url: repository.url,
      },
    };
  }

  return {
    async listRepositories() {
      const integrations = new Map(
        (await deps.integrations.list())
          .filter((integration) => integration.status === "active")
          .map((integration) => [integration.id, integration]),
      );
      const repositories = (await deps.repositories.list({ active: true }))
        .filter((repository) => integrations.has(repository.integrationId))
        .sort((a, b) => a.fullName.localeCompare(b.fullName));
      // One question to the platform for each installation, however many repositories it has.
      const unwritable = new Map<string, Promise<UnwritableReason | null>>();
      const unwritableReason = (
        integration: Integration,
      ): Promise<UnwritableReason | null> => {
        const known = unwritable.get(integration.id);
        if (known !== undefined) return known;
        const asked = deps.registry
          .resolve(integration.type)
          .installationPermissions(integration)
          .then(
            (permissions) =>
              permissions.contentsWrite ? null : ("write_not_granted" as const),
            (error: unknown) => {
              // An installation that is gone or refused has no write access, for the reason the platform gave; any other
              // failure is the platform's.
              const reason = noAccessReason(error);
              if (reason !== undefined) return reason;
              throw platformFailure(error);
            },
          );
        unwritable.set(integration.id, asked);
        return asked;
      };
      const choices: RepositoryChoice[] = [];
      for (const repository of repositories) {
        const integration = integrations.get(repository.integrationId);
        if (integration === undefined) continue;
        const reason = await unwritableReason(integration);
        choices.push({
          id: repository.id,
          fullName: repository.fullName,
          writeGranted: reason === null,
          unwritable: reason,
        });
      }
      return { repositories: choices };
    },

    async listBranches(repositoryId) {
      const { integration, repo } = await resolveRepository(repositoryId);
      const provider = deps.registry.resolve(integration.type);
      try {
        // One after the other: with `Promise.all` the second call would keep running (and holding a token and a connection)
        // after the first one failed and the request was answered.
        const facts = await provider.getRepositoryFacts(integration, repo);
        const branches = await provider.listBranches(integration, repo);
        return {
          defaultBranch: facts.defaultBranch,
          branches: branches.names,
          truncated: branches.truncated,
        };
      } catch (error) {
        throw platformFailure(error);
      }
    },

    listModels: () => deps.models.options(),

    async startTask(user, input) {
      const checked = validateStartInput(input);
      if (!checked.ok)
        throw new ImplementerError(
          "IMPLEMENTER_REQUEST_INVALID",
          "The request is not valid.",
          { issues: checked.issues },
        );
      const task = checked.value;

      // A request that was accepted before is answered with what it made, before anything else is asked: a retry after a lost
      // answer, a reconnect, the second tab. Minutes later the agent may have pushed the branch, and the branch check below
      // would call the person's own task "the branch exists" and have them start a second, paid one. Only the same task is
      // handed back: an id that made another task (the form edited after a lost answer, a client that reuses ids) is a
      // conflict that names the first task, never a silent 200 with a task the person did not ask for.
      const earlier = await deps.queue.findImplementerTurn(
        task.clientRequestId,
      );
      if (earlier !== undefined) return repeatOf(earlier, task);

      const { integration, repo } = await resolveRepository(task.repositoryId);
      const provider = deps.registry.resolve(integration.type);

      let baseSha: string;
      try {
        if (
          !(await provider.installationPermissions(integration)).contentsWrite
        )
          throw new ImplementerError(
            "IMPLEMENTER_WRITE_NOT_GRANTED",
            "The installation has not accepted the permission to write contents yet.",
          );
        // The repository path must still resolve before a missing branch can be believed (`getBranch` answers null for a
        // repository that was renamed, too).
        await provider.getRepositoryFacts(integration, repo);
        const base = await provider.getBranch(
          integration,
          repo,
          task.baseBranch,
        );
        if (base === null)
          throw new ImplementerError(
            "IMPLEMENTER_BASE_BRANCH_NOT_FOUND",
            "The repository has no branch with the name of the base branch.",
          );
        baseSha = base.sha;
        if ((await provider.getBranch(integration, repo, task.branch)) !== null)
          throw BRANCH_EXISTS();
        // Git holds `foo` or `foo/bar`, not both. What the read can tell: the first 100 branches the platform lists.
        const listed = await provider.listBranches(integration, repo);
        if (branchConflict(task.branch, listed.names) !== null)
          throw BRANCH_CONFLICT();
      } catch (error) {
        throw platformFailure(error);
      }

      const reason = await deps.models.check(task.model);
      if (reason !== null)
        throw new ImplementerError(
          "IMPLEMENTER_MODEL_NOT_ALLOWED",
          "This model cannot be used for a task.",
          { reason },
        );

      if (task.costLimitCents !== null) {
        const maximumCents = await deps.operatorCostLimitCents();
        if (task.costLimitCents > maximumCents)
          throw new ImplementerError(
            "EXCEEDS_OPERATOR_MAXIMUM",
            "The cost limit is above the maximum per task.",
            { maximumCents },
          );
      }

      let result;
      try {
        result = await deps.queue.enqueueImplementerTurn({
          repositoryId: task.repositoryId,
          baseBranch: task.baseBranch,
          baseSha,
          branch: task.branch,
          instruction: task.instruction,
          modelChoice: task.model,
          costLimitCents: task.costLimitCents,
          createdBy: user.id,
          actorLogin: user.githubLogin,
          clientRequestId: task.clientRequestId,
        });
      } catch (error) {
        // A lost race on the branch name hits the unique index of the sessions.
        if (
          error instanceof ImplementerStoreError &&
          error.code === "IMPLEMENTER_BRANCH_TAKEN"
        )
          throw BRANCH_EXISTS();
        if (
          error instanceof ImplementerStoreError &&
          error.code === "IMPLEMENTER_REPOSITORY_NOT_FOUND"
        )
          throw NOT_FOUND();
        // The checks above are the stricter ones; this is the safety net for what the queue refuses besides.
        if (
          error instanceof JobQueueError &&
          error.code === "JOB_INPUT_INVALID"
        )
          throw new ImplementerError(
            "IMPLEMENTER_REQUEST_INVALID",
            "The job queue did not accept the request.",
          );
        throw error;
      }
      if (result.status === "existing") return repeatOf(result, task);
      log(
        `[implementer] task ${result.status} job=${result.job.id} session=${result.session.id} repo=${repo.fullName} by=${user.githubLogin}`,
      );
      return {
        runId: result.job.id,
        sessionId: result.session.id,
        created: true,
      };
    },
  };
}
