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
import { NETWORK_OFF, type NetworkRule } from "../network-rule/network.ts";
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
import { branchConflict, checkBranchName } from "./branch-name.ts";
import { createRunCanceller, type RunCanceller } from "./cancel.ts";
import { ImplementerError, type UnwritableReason } from "./errors.ts";
import {
  BRANCH_CONFLICT,
  BRANCH_EXISTS,
  copyEnvironment,
  copyProfile,
  modelNeedsCatalog,
  requireRunnerForHarness,
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
import {
  deriveMountNames,
  firstRepeat,
  type SessionRepo,
} from "../db/session-repos.ts";

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

export type ImplementerService = FollowUps &
  RunCanceller & {
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
   * The most the task may cost, in whole US cents. It is the cost limit of the task: the cost limit of the profile version is not read
   * when it is given (#918). It is held to the operator's maximum like any limit, but a cap above that maximum is lowered to it
   * instead of refused.
   */
  costCapCents?: number;
  /**
   * #918: how many minutes the turn may run, from the `turnTimeLimitMinutes` of the workflow. Copied into the turn; the claim hands it
   * to the Worker as its time limit. Left out: the platform's 60 minutes.
   */
  timeLimitMinutes?: number;
  /** #920: the request id may start with the prefix that is the engine's alone (`wf-`); a request body never gets this. */
  workflowStep?: boolean;
  /**
   * #1105 (ADR 0007): the settings of a lane step that carries them itself instead of naming a profile. The profile of the turn is this copy
   * (the lane's name and version, no profile row behind it), and the body names no `profile`. Its `model` is the body's own and checked as
   * any model is. A hosted environment contributes its size only: the step's script and network rule replace the environment's (none given
   * is none). A request body never gets this.
   */
  inline?: {
    profile: TurnProfile;
    setupScript?: string;
    network?: NetworkRule;
  };
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
  queue: Pick<
    JobQueue,
    "enqueueImplementerTurn" | "findImplementerTurn" | "get" | "requestCancel"
  >;
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

/** Whether the profile copy of an earlier turn is the one a step with settings of its own would write now (#1105). */
function sameInlineProfile(
  stored: TurnProfile | null,
  asked: TurnProfile,
): boolean {
  return (
    stored !== null &&
    stored.id === asked.id &&
    stored.name === asked.name &&
    stored.version === asked.version &&
    stored.canPush === asked.canPush &&
    stored.instructions === asked.instructions &&
    (stored.harness ?? "opencode") === (asked.harness ?? "opencode")
  );
}

/**
 * Whether the repositories of a repeated body are those of the earlier task (#1092): one repository with the same base, or the same list
 * of repositories, where a base or a branch the body names is the stored one (left out is not compared: the default branch may have moved).
 */
function sameRepos(
  stored: SessionRepo[] | null,
  task: Pick<StartInput, "repos" | "baseBranch">,
  base?: string,
): boolean {
  if (task.repos === undefined)
    return (stored ?? null) === null && base === task.baseBranch;
  return (
    stored !== null &&
    stored.length === task.repos.length &&
    task.repos.every(
      (entry, index) =>
        stored[index]?.repositoryId === entry.repositoryId &&
        (entry.base === undefined || stored[index]?.base === entry.base) &&
        (entry.branch === undefined || stored[index]?.branch === entry.branch),
    )
  );
}

/** The answer for a request id that made a task before: that task when the body is the same, else the conflict. */
function repeatOf(
  earlier: EnqueueImplementerTurnResult,
  task: StartInput,
  inline?: StartTaskOptions["inline"],
): StartedTask {
  const { session, turn } = earlier;
  // With a profile the model is the version's, not the body's, and the cost limit is the operator's maximum: only the profile is compared.
  // A step with settings of its own (#1105) is held to its model and its profile copy; its cost limit is the cap of the lane's budget,
  // which moves with every earlier step, so it is not compared.
  const sameChoices =
    task.profile !== null ||
    (inline === undefined &&
      turn.costLimitCents === task.costLimitCents &&
      task.model !== null &&
      sameModel(turn.modelChoice, task.model)) ||
    (inline !== undefined &&
      task.model !== null &&
      sameModel(turn.modelChoice, task.model));
  const same =
    session.repositoryId === task.repositoryId &&
    sameRepos(session.repos, task, session.baseBranch) &&
    (session.startBranch ?? null) === (task.startBranch ?? null) &&
    session.branch === task.branch &&
    turn.instruction === task.instruction &&
    (turn.environment?.id ?? turn.runnerEnvironment?.id ?? null) ===
      task.environmentId &&
    (inline === undefined
      ? sameProfile(turn.profile, task.profile)
      : sameInlineProfile(turn.profile, inline.profile)) &&
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
  const canceller = createRunCanceller({
    queue: deps.queue,
    ...(deps.log === undefined ? {} : { log: deps.log }),
  });

  /** The one repository of a task of today: the permission, the repository, the base (and start) branch and the branch that must not exist. */
  async function resolveSingle(
    task: StartInput,
  ): Promise<{ baseSha: string; fullName: string }> {
    const { integration, repo } = await resolveRepository(
      deps,
      task.repositoryId,
    );
    const provider = deps.registry.resolve(integration.type);

    let baseSha: string;
    try {
      if (!(await provider.installationPermissions(integration)).contentsWrite)
        throw new ImplementerError(
          "IMPLEMENTER_WRITE_NOT_GRANTED",
          "The installation has not accepted the permission to write contents yet.",
        );
      // The repository path must still resolve before a missing branch can be believed (`getBranch` answers null for a
      // repository that was renamed, too).
      await provider.getRepositoryFacts(integration, repo);
      const base = await provider.getBranch(integration, repo, task.baseBranch);
      if (base === null)
        throw new ImplementerError(
          "IMPLEMENTER_BASE_BRANCH_NOT_FOUND",
          "The repository has no branch with the name of the base branch.",
        );
      baseSha = base.sha;
      // #909: the session starts at the start branch when the task names one; its tip is where the work begins.
      if (task.startBranch !== undefined) {
        const start = await provider.getBranch(
          integration,
          repo,
          task.startBranch,
        );
        if (start === null)
          throw new ImplementerError(
            "IMPLEMENTER_BASE_BRANCH_NOT_FOUND",
            "The repository has no branch with the name of the start branch.",
          );
        baseSha = start.sha;
      }
      if ((await provider.getBranch(integration, repo, task.branch)) !== null)
        throw BRANCH_EXISTS();
      // Git holds `foo` or `foo/bar`, not both. What the read can tell: the first 100 branches the platform lists.
      const listed = await provider.listBranches(integration, repo);
      if (branchConflict(task.branch, listed.names) !== null)
        throw BRANCH_CONFLICT();
    } catch (error) {
      throw platformFailure(error);
    }

    return { baseSha, fullName: repo.fullName };
  }

  /**
   * #1092: the repositories of a step with `repos`, resolved: each one is a repository of the workspace with an active integration, the
   * installation can write to it when the profile may push, and its base branch (the default branch when the step named none) exists.
   * A branch is not asked for here: whether it exists is decided when the job is claimed (`branchExists`), so a retry or a second round on
   * the same branch is the ordinary case. Refusals carry the place of the repository in `repoIndex`.
   */
  async function resolveRepos(
    entries: NonNullable<StartInput["repos"]>,
    mustWrite: boolean,
  ): Promise<{ repos: SessionRepo[]; baseSha: string }> {
    const refusal = (error: unknown, index: number): ImplementerError => {
      const known = platformFailure(error);
      return known.code === "IMPLEMENTER_GITHUB_UNAVAILABLE"
        ? known
        : new ImplementerError(known.code, known.message, {
            ...(known.issues.length === 0 ? {} : { issues: known.issues }),
            repoIndex: index,
          });
    };
    const permissions = new Map<string, Promise<boolean>>();
    const seen = new Set<string>();
    const resolved: Array<Omit<SessionRepo, "name">> = [];
    let firstSha = "";
    for (const [index, entry] of entries.entries()) {
      if (seen.has(entry.repositoryId))
        throw new ImplementerError(
          "IMPLEMENTER_REQUEST_INVALID",
          "A repository is named twice.",
          { repoIndex: index },
        );
      seen.add(entry.repositoryId);
      try {
        const { integration, repo } = await resolveRepository(
          deps,
          entry.repositoryId,
        );
        const provider = deps.registry.resolve(integration.type);
        if (mustWrite) {
          let granted = permissions.get(integration.id);
          if (granted === undefined) {
            granted = provider
              .installationPermissions(integration)
              .then((held) => held.contentsWrite);
            permissions.set(integration.id, granted);
          }
          if (!(await granted))
            throw new ImplementerError(
              "IMPLEMENTER_WRITE_NOT_GRANTED",
              "The installation has not accepted the permission to write contents yet.",
            );
        }
        // The repository path must still resolve before a missing branch can be believed; its default branch is the base when none is named.
        const facts = await provider.getRepositoryFacts(integration, repo);
        const base = entry.base ?? facts.defaultBranch;
        const head = await provider.getBranch(integration, repo, base);
        if (head === null)
          throw new ImplementerError(
            "IMPLEMENTER_BASE_BRANCH_NOT_FOUND",
            "The repository has no branch with the name of the base branch.",
          );
        const branch = entry.branch ?? base;
        if (branch !== base && !checkBranchName(branch, "").ok)
          throw new ImplementerError(
            "IMPLEMENTER_REQUEST_INVALID",
            "The branch is not a valid branch name.",
          );
        if (index === 0) firstSha = head.sha;
        resolved.push({
          repositoryId: entry.repositoryId,
          fullName: repo.fullName,
          base,
          branch,
        });
      } catch (error) {
        throw refusal(error, index);
      }
    }
    const fullNames = resolved.map((entry) => entry.fullName);
    const names = deriveMountNames(fullNames);
    if (firstRepeat(fullNames) >= 0 || firstRepeat(names) >= 0)
      throw new ImplementerError(
        "IMPLEMENTER_REQUEST_INVALID",
        "Two repositories of the task are the same repository or would be mounted under one name.",
      );
    return {
      repos: resolved.map((entry, index) => ({
        ...entry,
        name: names[index] as string,
      })),
      baseSha: firstSha,
    };
  }

  return {
    ...followUps,
    ...canceller,

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
      const checked = validateStartInput(input, {
        workflowStep: options.workflowStep === true,
      });
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
      if (earlier !== undefined) return repeatOf(earlier, task, options.inline);

      // #1092: a step with `repos` is checked repository by repository; the profile is read first, because whether the repositories must be
      // writable depends on it (a profile that may not push gets read access only).
      const preCopied =
        task.repos !== undefined && task.profile !== null
          ? await copyProfile(deps.profiles, task.profile)
          : undefined;
      const preProfile = preCopied?.profile ?? options.inline?.profile ?? null;
      let baseSha: string;
      let repoName: string;
      let sessionRepos: SessionRepo[] | undefined;
      if (task.repos !== undefined) {
        const resolved = await resolveRepos(
          task.repos,
          preProfile?.canPush !== false,
        );
        baseSha = resolved.baseSha;
        sessionRepos = resolved.repos;
        repoName = resolved.repos.map((entry) => entry.fullName).join(",");
      } else {
        const resolved = await resolveSingle(task);
        baseSha = resolved.baseSha;
        repoName = resolved.fullName;
      }

      // A profile (#843) is read now and its version copied into the turn: what it says at this moment is what the task runs with,
      // whatever is done to it afterwards. Its model takes the place of the body's and is checked like it. Its cost limit is not read (#918):
      // the cap is the operator's maximum, as for a version that never had one (`claim.ts`: `costLimitCents ?? operatorCents`).
      let profile: TurnProfile | null = null;
      let profileResult: string | null = null;
      let model: ModelChoice;
      let costLimitCents: number | null;
      if (task.profile === null) {
        // `validateStartInput` leaves the model out only when a profile is named.
        model = task.model as ModelChoice;
        costLimitCents = task.costLimitCents;
        // #1105: a step with settings of its own: its profile is the copy the engine built, and no cost limit of its own (the cap below).
        if (options.inline !== undefined) {
          profile = options.inline.profile;
          costLimitCents = null;
        }
      } else {
        const copied =
          preCopied ?? (await copyProfile(deps.profiles, task.profile));
        profile = copied.profile;
        model = copied.model;
        costLimitCents = null;
        profileResult = copied.defaultResult;
      }

      // The result schema (#843): the task's own, else the default of its profile version, copied into the turn like the rest. A task
      // with neither runs without a finish tool, as it did before result schemas.
      const resultSchema = task.result ?? resultOfProfile(profileResult);

      // The model of the harness claude-code is a name Claude Code reads on the device's login: no catalog, no key of the workspace.
      const reason = modelNeedsCatalog(profile)
        ? await deps.models.check(model)
        : null;
      if (reason !== null)
        throw new ImplementerError(
          "IMPLEMENTER_MODEL_NOT_ALLOWED",
          "This model cannot be used for a task.",
          { reason },
        );

      // The environment is read now and copied into the turn: what it says at this moment is what the task runs with, whatever
      // is done to it afterwards. An id of another workspace, or of one that is gone, is the same refusal.
      const copiedEnv =
        task.environmentId === null
          ? { environment: null, runnerEnvironment: null }
          : await copyEnvironment(deps.environments, task.environmentId, model);
      const { runnerEnvironment } = copiedEnv;
      requireRunnerForHarness(profile, runnerEnvironment);
      // #1105: the script and the network rule are the step's (ADR 0007, decision 11); the hosted environment keeps its size.
      const environment =
        options.inline === undefined || copiedEnv.environment === null
          ? copiedEnv.environment
          : {
              ...copiedEnv.environment,
              setupScript: options.inline.setupScript ?? "",
              network: options.inline.network ?? NETWORK_OFF,
            };

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
          // #1092: with `repos` the session names the first repository and its resolved base; the list is stored with it.
          baseBranch: sessionRepos?.[0]?.base ?? task.baseBranch,
          ...(task.startBranch === undefined
            ? {}
            : { startBranch: task.startBranch }),
          baseSha,
          branch: task.branch,
          ...(sessionRepos === undefined ? {} : { repos: sessionRepos }),
          instruction: task.instruction,
          modelChoice: model,
          costLimitCents,
          ...(options.timeLimitMinutes === undefined
            ? {}
            : { timeLimitMinutes: options.timeLimitMinutes }),
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
      if (result.status === "existing")
        return repeatOf(result, task, options.inline);
      log(
        `[implementer] task ${result.status} job=${result.job.id} session=${result.session.id} repo=${repoName} by=${user.githubLogin}`,
      );
      return {
        runId: result.job.id,
        sessionId: result.session.id,
        created: true,
      };
    },
  };
}
