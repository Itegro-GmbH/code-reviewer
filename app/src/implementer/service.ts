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
import type { ImplementerEnvironmentsRepository } from "../db/repositories/implementer-environments-repository.ts";
import type { TurnProfile } from "../db/repositories/implementer-repository.ts";
import type { ProfilesRepository } from "../db/repositories/profiles-repository.ts";
import type { IntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import type { RepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { ImplementerStoreError } from "../db/implementer-errors.ts";
import type { IntegrationRegistry } from "../integrations/registry.ts";
import type { Integration } from "../integrations/types.ts";
import type { ModelChoice } from "../db/implementer-model-choice.ts";
import { JobQueueError } from "../jobs/errors.ts";
import type { EnqueueImplementerTurnResult } from "../jobs/job-types.ts";
import type { JobQueue } from "../jobs/job-queue.ts";
import { branchConflict } from "./branch-name.ts";
import { ImplementerError, type UnwritableReason } from "./errors.ts";
import {
  BRANCH_CONFLICT,
  BRANCH_EXISTS,
  copyEnvironment,
  copyProfile,
  noAccessReason,
  NOT_FOUND,
  platformFailure,
  resolveRepository,
  resultOfProfile,
  sameModel,
} from "./service-support.ts";
import type { ImplementerModels, ModelOptions } from "./models.ts";
import {
  createFollowUps,
  type FollowUps,
  type FollowUpDependencies,
} from "./follow-up.ts";
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

export type ImplementerService = FollowUps & {
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
    options?: StartTaskOptions,
  ): Promise<StartedTask>;
};

/**
 * What only code inside the app can ask for, never a request body (#844): the workflow engine starts a step with the rest of the
 * workflow's budget as the most the step may cost.
 */
export type StartTaskOptions = {
  /**
   * The most the task may cost, in whole US cents. It lowers the cost limit of the task (the profile version's, or none) and never
   * raises it; it is held to the operator's maximum like any limit, but a cap above that maximum is lowered to it instead of refused.
   */
  costCapCents?: number;
};

export type ImplementerServiceDependencies = FollowUpDependencies & {
  repositories: Pick<RepositoriesRepository, "get" | "list">;
  integrations: Pick<IntegrationsRepository, "get" | "list">;
  registry: Pick<IntegrationRegistry, "resolve">;
  models: ImplementerModels;
  /** The workspace's environments (#818): a task may start with one, copied into the turn. */
  environments: Pick<ImplementerEnvironmentsRepository, "get">;
  /** The workspace's profiles (#843): a task may run with one, whose version is copied into the turn. */
  profiles: Pick<ProfilesRepository, "findByName">;
  queue: Pick<JobQueue, "enqueueImplementerTurn" | "findImplementerTurn">;
  /** The operator's maximum cost per turn in whole US cents, read for each call. */
  operatorCostLimitCents(): Promise<number>;
  /** One line per started task; never carries the instruction, a model or a token. */
  log?: (line: string) => void;
};

/** Whether the result schema a repeated body names is the one the earlier task ran with (a body that names none compares nothing). */
function sameResult(stored: unknown, asked: StartInput["result"]): boolean {
  return asked === null || JSON.stringify(stored) === JSON.stringify(asked);
}

function sameProfile(
  stored: TurnProfile | null,
  asked: StartInput["profile"],
): boolean {
  if (asked === null) return stored === null;
  return (
    stored !== null &&
    stored.name === asked.name &&
    (asked.version === null || stored.version === asked.version)
  );
}

/** The answer for a request id that made a task before: that task when the body is the same, else the conflict. */
function repeatOf(
  earlier: EnqueueImplementerTurnResult,
  task: StartInput,
): StartedTask {
  const { session, turn } = earlier;
  // With a profile the model and the cost limit are the version's, not the body's: only the profile is compared.
  const sameChoices =
    task.profile !== null ||
    (turn.costLimitCents === task.costLimitCents &&
      task.model !== null &&
      sameModel(turn.modelChoice, task.model));
  const same =
    session.repositoryId === task.repositoryId &&
    session.baseBranch === task.baseBranch &&
    session.branch === task.branch &&
    turn.instruction === task.instruction &&
    (turn.environment?.id ?? turn.runnerEnvironment?.id ?? null) ===
      task.environmentId &&
    sameProfile(turn.profile, task.profile) &&
    sameResult(turn.resultSchema, task.result) &&
    sameChoices;
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
  const followUps = createFollowUps(deps);

  return {
    ...followUps,

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
      const { integration, repo } = await resolveRepository(deps, repositoryId);
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

    async startTask(user, input, options = {}) {
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

      const { integration, repo } = await resolveRepository(
        deps,
        task.repositoryId,
      );
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

      // A profile (#843) is read now and its version copied into the turn: what it says at this moment is what the task runs with,
      // whatever is done to it afterwards. Its model and cost limit take the place of the body's, and are checked like the body's.
      let profile: TurnProfile | null = null;
      let profileResult: string | null = null;
      let model: ModelChoice;
      let costLimitCents: number | null;
      if (task.profile === null) {
        // `validateStartInput` leaves the model out only when a profile is named.
        model = task.model as ModelChoice;
        costLimitCents = task.costLimitCents;
      } else {
        const copied = await copyProfile(deps.profiles, task.profile);
        profile = copied.profile;
        model = copied.model;
        costLimitCents = copied.costLimitCents;
        profileResult = copied.defaultResult;
      }

      // The result schema (#843): the task's own, else the default of its profile version, copied into the turn like the rest. A task
      // with neither runs without a finish tool, as it did before result schemas.
      const resultSchema = task.result ?? resultOfProfile(profileResult);

      const reason = await deps.models.check(model);
      if (reason !== null)
        throw new ImplementerError(
          "IMPLEMENTER_MODEL_NOT_ALLOWED",
          "This model cannot be used for a task.",
          { reason },
        );

      // The environment is read now and copied into the turn: what it says at this moment is what the task runs with, whatever
      // is done to it afterwards. An id of another workspace, or of one that is gone, is the same refusal.
      const { environment, runnerEnvironment } =
        task.environmentId === null
          ? { environment: null, runnerEnvironment: null }
          : await copyEnvironment(deps.environments, task.environmentId, model);

      if (costLimitCents !== null) {
        const maximumCents = await deps.operatorCostLimitCents();
        if (costLimitCents > maximumCents)
          throw new ImplementerError(
            "EXCEEDS_OPERATOR_MAXIMUM",
            "The cost limit is above the maximum per task.",
            { maximumCents },
          );
      }
      // The cap of the caller (#844) only lowers: the smaller of it, the limit above and the operator's maximum.
      if (options.costCapCents !== undefined) {
        const maximumCents = await deps.operatorCostLimitCents();
        costLimitCents = Math.min(
          costLimitCents ?? Number.POSITIVE_INFINITY,
          Math.max(1, Math.floor(options.costCapCents)),
          maximumCents,
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
          modelChoice: model,
          costLimitCents,
          environment,
          runnerEnvironment,
          profile,
          resultSchema,
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
