// SPDX-License-Identifier: LicenseRef-Proprietary

// The next instruction of a session (#841, part of #745): `continueSession` is the submit behind `POST .../sessions/:sessionId/turns`,
// `startQueued` starts the one instruction that waited for the end of a turn, and `continuation` is what the Runs page needs for its
// "Continue" form. The order of the submit, nothing written before the last step:
//   1. the body is valid; the session is this workspace's (else 404);
//   2. a request id that made a turn before gets that turn back (like #791); one that is queued gets the queue back;
//   3. the repository is active, the installation can write contents;
//   4. the session's branch is still on the platform (`IMPLEMENTER_BRANCH_GONE`), or the session never pushed one;
//   5. the model is allowed, the cost limit is within the operator's maximum, the environment and the profile are copied as in the first
//      turn; what the body leaves out is what the last turn had;
//   6. one transaction: the session goes `idle` to `running` and the turn and its job are written (`queue.enqueueFollowUpTurn`). A
//      session that runs takes the instruction into its queue instead, exactly one; a second is `IMPLEMENTER_SESSION_BUSY`.
// The queued instruction keeps the choices of step 5, so it starts as it was asked for, whatever is done to the environment meanwhile.
import type { ImplementerEnvironmentsRepository } from "../db/repositories/implementer-environments-repository.ts";
import type { ImplementerRepository } from "../db/repositories/implementer-repository.ts";
import type {
  DiscardedInstruction,
  DiscardReason,
  QueuedInstruction,
  StoredImplementerSession,
  TurnEnvironment,
  TurnProfile,
  TurnRunnerEnvironment,
} from "../db/repositories/implementer-repository.ts";
import type { ImplementerStepsRepository } from "../db/repositories/implementer-steps-repository.ts";
import type { IntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import type { ProfilesRepository } from "../db/repositories/profiles-repository.ts";
import type { RepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import type { StoredResultSchema } from "../db/agent-result.ts";
import type { ModelChoice } from "../db/implementer-model-choice.ts";
import { IntegrationError } from "../integrations/errors.ts";
import type { IntegrationRegistry } from "../integrations/registry.ts";
import type { Integration, RepoRef } from "../integrations/types.ts";
import { JobQueueError } from "../jobs/errors.ts";
import type { JobQueue } from "../jobs/job-queue.ts";
import type { EnqueueImplementerTurnResult } from "../jobs/job-types.ts";
import { isEnvironmentVcpus } from "./environments/limits.ts";
import { validateContinueInput, type ContinueInput } from "./continue-input.ts";
import { ImplementerError } from "./errors.ts";
import type { ImplementerModels } from "./models.ts";
import {
  copyEnvironment,
  copyProfile,
  MAX_ID_LENGTH,
  noAccessReason,
  platformFailure,
  resolveRepository,
  requireOwnKey,
  resultOfProfile,
  sameModel,
} from "./service-support.ts";

export type FollowUpDependencies = {
  repositories: Pick<RepositoriesRepository, "get">;
  integrations: Pick<IntegrationsRepository, "get">;
  registry: Pick<IntegrationRegistry, "resolve">;
  models: Pick<ImplementerModels, "check">;
  environments: Pick<ImplementerEnvironmentsRepository, "get">;
  profiles: Pick<ProfilesRepository, "findByName">;
  sessions: Pick<
    ImplementerRepository,
    | "getSession"
    | "getTurnByJob"
    | "lastTurn"
    | "queueInstruction"
    | "discardQueued"
    | "noteQueuedAttempt"
  >;
  steps: Pick<ImplementerStepsRepository, "lastStep">;
  queue: Pick<JobQueue, "enqueueFollowUpTurn" | "findImplementerTurn">;
  /** The operator's maximum cost per turn in whole US cents, read for each call. */
  operatorCostLimitCents(): Promise<number>;
  log?: (line: string) => void;
  /** The clock, for how long an instruction has waited. */
  now?: () => Date;
};

/** What the submit did. `queued`: a turn runs, and the instruction starts when it ends. */
export type ContinuedSession = {
  status: "started" | "queued";
  sessionId: string;
  /** The run of the new turn; null while the instruction is only queued. */
  runId: string | null;
  turnNumber: number | null;
  /** False when the same client request id was accepted before: nothing was written now. */
  created: boolean;
};

/** What `startQueued` did. `retry`: the platform could not be asked; the instruction stays queued and the sweep tries again. */
export type StartQueuedOutcome =
  | { status: "started"; runId: string }
  | { status: "discarded"; reason: DiscardReason }
  | { status: "nothing" }
  | { status: "retry" };

/** What the Runs page needs to offer "Continue" on a run; absent for a run that is not the newest turn of its session. */
export type Continuation = {
  sessionId: string;
  branch: string;
  turnNumber: number;
  /** The session's state now: a turn runs (the form queues) or it is idle (the form starts). */
  sessionStatus: "running" | "idle";
  defaults: {
    model: ModelChoice;
    costLimitCents: number | null;
    environment: { id: string; name: string } | null;
    /** `name@version` of the last turn's profile, or null. */
    profile: string | null;
  };
  queued: { instruction: string } | null;
  discarded: { reason: DiscardReason; instruction: string } | null;
  /** About how many tokens the next first call reads again (the last call's context and answer); null when not known. */
  historyTokens: number | null;
};

export type FollowUps = {
  continueSession(
    user: { id: string; githubLogin: string },
    sessionId: string,
    input: unknown,
  ): Promise<ContinuedSession>;
  /** Starts the queued instruction of an idle session, or discards it with the reason. Idempotent; never throws for the platform. */
  startQueued(sessionId: string): Promise<StartQueuedOutcome>;
  /** The "Continue" facts of a run (its job id); undefined when the run is not the newest turn of a session of this workspace. */
  continuation(jobId: string): Promise<Continuation | undefined>;
};

const SESSION_NOT_FOUND = () =>
  new ImplementerError(
    "IMPLEMENTER_SESSION_NOT_FOUND",
    "There is no such session in this workspace.",
  );
const SESSION_BUSY = () =>
  new ImplementerError(
    "IMPLEMENTER_SESSION_BUSY",
    "A turn runs and the next instruction is queued already.",
  );
const BRANCH_GONE = () =>
  new ImplementerError(
    "IMPLEMENTER_BRANCH_GONE",
    "The branch of this session is no longer on GitHub. Start a new task.",
  );

/** How long a queued instruction waits for a start before it is discarded as `github_unavailable`, counted from when it was queued. */
export const QUEUED_INSTRUCTION_TTL_MS = 24 * 60 * 60 * 1000;

/** Tries to attempt the write this many times when the session changes under it (it ended, or an instruction was queued by someone else). */
const WRITE_ATTEMPTS = 3;

/** The choices of a turn, resolved and copied. */
type Choices = {
  model: ModelChoice;
  costLimitCents: number | null;
  environment: TurnEnvironment | null;
  runnerEnvironment: TurnRunnerEnvironment | null;
  profile: TurnProfile | null;
  resultSchema: StoredResultSchema | null;
};

/** An id that can be looked up: a string without a NUL byte, not empty and not longer than any id of ours. */
function isPlausibleId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id !== "" &&
    id.length <= MAX_ID_LENGTH &&
    !id.includes("\u0000")
  );
}

function profileRefOf(profile: TurnProfile | null): string | null {
  return profile === null ? null : `${profile.name}@${String(profile.version)}`;
}

export function createFollowUps(deps: FollowUpDependencies): FollowUps {
  const log = deps.log ?? ((line) => console.info(line));
  const now = deps.now ?? (() => new Date());

  /**
   * The tip a turn is accepted at: the session's branch when it has pushed one (it must still be there), else the base branch. A
   * platform failure other than "not there" is the platform's, as for the first turn.
   */
  async function tipOf(
    session: StoredImplementerSession,
    integration: Integration,
    repo: RepoRef,
  ): Promise<string> {
    const provider = deps.registry.resolve(integration.type);
    try {
      if (!(await provider.installationPermissions(integration)).contentsWrite)
        throw new ImplementerError(
          "IMPLEMENTER_WRITE_NOT_GRANTED",
          "The installation has not accepted the permission to write contents yet.",
        );
      // The repository path must still resolve before a missing branch can be believed.
      await provider.getRepositoryFacts(integration, repo);
      if (session.headCommit !== null) {
        const branch = await provider.getBranch(
          integration,
          repo,
          session.branch,
        );
        if (branch === null) throw BRANCH_GONE();
        return branch.sha;
      }
      const base = await provider.getBranch(
        integration,
        repo,
        session.baseBranch,
      );
      if (base === null)
        throw new ImplementerError(
          "IMPLEMENTER_BASE_BRANCH_NOT_FOUND",
          "The repository has no branch with the name of the base branch.",
        );
      return base.sha;
    } catch (error) {
      throw platformFailure(error);
    }
  }

  /** The choices of the body over the defaults of the last turn (`continue-input.ts`: left out is as before, `null` is none). */
  async function resolveChoices(
    input: ContinueInput,
    last: {
      modelChoice: ModelChoice;
      costLimitCents: number | null;
      environment: TurnEnvironment | null;
      runnerEnvironment: TurnRunnerEnvironment | null;
      profile: TurnProfile | null;
      resultSchema: StoredResultSchema | null;
    },
  ): Promise<Choices> {
    let model = input.model ?? last.modelChoice;
    let costLimitCents =
      input.costLimitCents === undefined
        ? last.costLimitCents
        : input.costLimitCents;
    let profile: TurnProfile | null = last.profile;
    let resultSchema: StoredResultSchema | null = last.resultSchema;
    if (input.profile === null) {
      profile = null;
      resultSchema = null;
    } else if (input.profile !== undefined) {
      const copied = await copyProfile(deps.profiles, input.profile);
      profile = copied.profile;
      model = copied.model;
      costLimitCents = copied.costLimitCents;
      resultSchema = resultOfProfile(copied.defaultResult);
    }

    let environment: TurnEnvironment | null;
    let runnerEnvironment: TurnRunnerEnvironment | null;
    if (input.environmentId === undefined) {
      environment = last.environment;
      runnerEnvironment = last.runnerEnvironment;
      // The runner environment of the last turn stays, so its model must still be one of the owner's own key (the body may change it).
      if (runnerEnvironment !== null) requireOwnKey(model);
      // The copy of the last turn is used as it is, but a size that is no longer offered is refused as for a live environment.
      if (environment !== null && !isEnvironmentVcpus(environment.vcpus))
        throw new ImplementerError(
          "IMPLEMENTER_ENVIRONMENT_SIZE_UNSUPPORTED",
          "The size of this environment is no longer offered.",
        );
    } else if (input.environmentId === null) {
      environment = null;
      runnerEnvironment = null;
    } else
      ({ environment, runnerEnvironment } = await copyEnvironment(
        deps.environments,
        input.environmentId,
        model,
      ));

    const reason = await deps.models.check(model);
    if (reason !== null)
      throw new ImplementerError(
        "IMPLEMENTER_MODEL_NOT_ALLOWED",
        "This model cannot be used for a task.",
        { reason },
      );
    if (costLimitCents !== null) {
      const maximumCents = await deps.operatorCostLimitCents();
      if (costLimitCents > maximumCents)
        throw new ImplementerError(
          "EXCEEDS_OPERATOR_MAXIMUM",
          "The cost limit is above the maximum per task.",
          { maximumCents },
        );
    }
    return {
      model,
      costLimitCents,
      environment,
      runnerEnvironment,
      profile,
      resultSchema,
    };
  }

  /** Whether what a repeated body asks for is what the earlier turn, or the instruction still queued, was made with (left out is not compared). */
  function sameAsked(
    held: {
      instruction: string;
      modelChoice: ModelChoice;
      costLimitCents: number | null;
      environment: TurnEnvironment | null;
      runnerEnvironment?: TurnRunnerEnvironment | null;
      profile: TurnProfile | null;
    },
    input: ContinueInput,
  ): boolean {
    return (
      held.instruction === input.instruction &&
      (input.model === undefined || sameModel(held.modelChoice, input.model)) &&
      (input.costLimitCents === undefined ||
        held.costLimitCents === input.costLimitCents) &&
      (input.environmentId === undefined ||
        (held.environment?.id ?? held.runnerEnvironment?.id ?? null) ===
          input.environmentId) &&
      (input.profile === undefined ||
        (input.profile === null
          ? held.profile === null
          : held.profile !== null &&
            held.profile.name === input.profile.name &&
            (input.profile.version === null ||
              held.profile.version === input.profile.version)))
    );
  }

  /** The answer for a request id that made a turn before: that turn when it is the same instruction on the same session, else the conflict. */
  function repeatOfTurn(
    earlier: EnqueueImplementerTurnResult,
    sessionId: string,
    input: ContinueInput,
  ): ContinuedSession {
    const { session, turn } = earlier;
    if (session.id !== sessionId || turn.number < 2 || !sameAsked(turn, input))
      throw new ImplementerError(
        "IMPLEMENTER_REQUEST_REUSED",
        "This request id made another task.",
        { runId: earlier.job.id },
      );
    return {
      status: "started",
      sessionId: session.id,
      runId: earlier.job.id,
      turnNumber: turn.number,
      created: false,
    };
  }

  function repeatOfQueued(
    session: StoredImplementerSession,
    input: ContinueInput,
  ): ContinuedSession {
    if (session.queued === null || !sameAsked(session.queued, input))
      throw new ImplementerError(
        "IMPLEMENTER_REQUEST_REUSED",
        "This request id made another task.",
      );
    return {
      status: "queued",
      sessionId: session.id,
      runId: null,
      turnNumber: null,
      created: false,
    };
  }

  /**
   * Discards the instruction this call read, and no other: when a newer one is queued by now (this one started, and the turn ended)
   * nothing is discarded and the outcome is `nothing`. Says why in the log (the instruction is never logged).
   */
  async function discard(
    session: StoredImplementerSession,
    queued: QueuedInstruction,
    reason: DiscardReason,
  ): Promise<StartQueuedOutcome> {
    const discarded = await deps.sessions.discardQueued(
      session.id,
      queued.clientRequestId,
      reason,
    );
    if (discarded === undefined) return { status: "nothing" };
    log(
      `[implementer] queued instruction discarded session=${session.id} reason=${reason}`,
    );
    return { status: "discarded", reason };
  }

  /** The platform could not be asked: the instruction waits for the next try, unless it has waited for `QUEUED_INSTRUCTION_TTL_MS`. */
  function retryOrExpire(
    session: StoredImplementerSession,
    queued: QueuedInstruction,
  ): Promise<StartQueuedOutcome> {
    const waited = now().getTime() - Date.parse(queued.queuedAt);
    if (waited >= QUEUED_INSTRUCTION_TTL_MS)
      return discard(session, queued, "github_unavailable");
    return Promise.resolve({ status: "retry" });
  }

  return {
    async continueSession(user, sessionId, body) {
      const checked = validateContinueInput(body);
      if (!checked.ok)
        throw new ImplementerError(
          "IMPLEMENTER_REQUEST_INVALID",
          "The request is not valid.",
          { issues: checked.issues },
        );
      const input = checked.value;
      if (!isPlausibleId(sessionId)) throw SESSION_NOT_FOUND();
      const session = await deps.sessions.getSession(sessionId);
      if (session === undefined) throw SESSION_NOT_FOUND();

      // A request that was accepted before is answered with what it made, before anything else is asked.
      const earlier = await deps.queue.findImplementerTurn(
        input.clientRequestId,
      );
      if (earlier !== undefined)
        return repeatOfTurn(earlier, session.id, input);
      if (session.queued?.clientRequestId === input.clientRequestId)
        return repeatOfQueued(session, input);

      const last = await deps.sessions.lastTurn(session.id);
      if (last === undefined) throw SESSION_NOT_FOUND();
      const { integration, repo } = await resolveRepository(
        deps,
        session.repositoryId,
      );
      const headSha = await tipOf(session, integration, repo);
      const choices = await resolveChoices(input, last);

      const queued: QueuedInstruction = {
        clientRequestId: input.clientRequestId,
        instruction: input.instruction,
        modelChoice: choices.model,
        costLimitCents: choices.costLimitCents,
        environment: choices.environment,
        runnerEnvironment: choices.runnerEnvironment,
        profile: choices.profile,
        resultSchema: choices.resultSchema,
        createdBy: user.id,
        actorLogin: user.githubLogin,
        queuedAt: new Date().toISOString(),
      };

      for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
        let result;
        try {
          result = await deps.queue.enqueueFollowUpTurn({
            sessionId: session.id,
            headSha,
            instruction: input.instruction,
            modelChoice: choices.model,
            costLimitCents: choices.costLimitCents,
            environment: choices.environment,
            runnerEnvironment: choices.runnerEnvironment,
            profile: choices.profile,
            resultSchema: choices.resultSchema,
            createdBy: user.id,
            actorLogin: user.githubLogin,
            clientRequestId: input.clientRequestId,
            fromQueued: false,
          });
        } catch (error) {
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
        if (result.status === "created") {
          log(
            `[implementer] follow-up created job=${result.job.id} session=${result.session.id} turn=${String(result.turn.number)} by=${user.githubLogin}`,
          );
          return {
            status: "started",
            sessionId: result.session.id,
            runId: result.job.id,
            turnNumber: result.turn.number,
            created: true,
          };
        }
        if (result.status === "existing")
          return repeatOfTurn(result, session.id, input);
        if (result.status === "session_not_found") throw SESSION_NOT_FOUND();

        // `busy` (`nothing_queued` is only for `fromQueued`): a turn runs, or the turn that ended has an instruction that is about to start.
        const placed = await deps.sessions.queueInstruction(session.id, queued);
        if (placed.status === "queued") {
          log(
            `[implementer] follow-up queued session=${session.id} by=${user.githubLogin}`,
          );
          return {
            status: "queued",
            sessionId: session.id,
            runId: null,
            turnNumber: null,
            created: true,
          };
        }
        if (placed.status === "not_found") throw SESSION_NOT_FOUND();
        if (placed.status === "full") {
          // The same request may have queued it a moment ago (a retry racing the first call).
          const now = await deps.sessions.getSession(session.id);
          if (now?.queued?.clientRequestId === input.clientRequestId)
            return repeatOfQueued(now, input);
          throw SESSION_BUSY();
        }
        // `idle`: the turn ended between the two writes; the next attempt starts it.
      }
      throw SESSION_BUSY();
    },

    async startQueued(sessionId) {
      const session = await deps.sessions.getSession(sessionId);
      const queued = session?.queued ?? null;
      if (session === undefined || queued === null)
        return { status: "nothing" };
      if (session.status !== "idle") return { status: "nothing" };
      // Before anything is asked of the platform: the sweep spaces its tries by this, whatever becomes of this one.
      await deps.sessions.noteQueuedAttempt(session.id, queued.clientRequestId);

      // What could have changed since the instruction was queued: the repository, the installation, the branch, the model.
      let tip: string;
      try {
        const { integration, repo } = await resolveRepository(
          deps,
          session.repositoryId,
        );
        tip = await tipOf(session, integration, repo);
      } catch (error) {
        if (error instanceof ImplementerError) {
          if (error.code === "IMPLEMENTER_BRANCH_GONE")
            return discard(session, queued, "branch_gone");
          if (error.code === "IMPLEMENTER_WRITE_NOT_GRANTED")
            return discard(session, queued, "write_not_granted");
          if (
            error.code === "IMPLEMENTER_REPOSITORY_NOT_FOUND" ||
            error.code === "IMPLEMENTER_APP_NOT_INSTALLED" ||
            error.code === "IMPLEMENTER_BASE_BRANCH_NOT_FOUND"
          )
            return discard(session, queued, "repository_unavailable");
          // The platform could not be asked: the instruction waits for the next try.
          return retryOrExpire(session, queued);
        }
        // A failure the platform's own error type names as "no access" is the same as a repository that is gone.
        if (
          error instanceof IntegrationError &&
          noAccessReason(error) !== undefined
        )
          return discard(session, queued, "repository_unavailable");
        return retryOrExpire(session, queued);
      }

      if ((await deps.models.check(queued.modelChoice)) !== null)
        return discard(session, queued, "model_not_allowed");
      if (
        queued.costLimitCents !== null &&
        queued.costLimitCents > (await deps.operatorCostLimitCents())
      )
        return discard(session, queued, "cost_limit_exceeded");
      if (
        queued.environment !== null &&
        !isEnvironmentVcpus(queued.environment.vcpus)
      )
        return discard(session, queued, "environment_unavailable");

      const result = await deps.queue.enqueueFollowUpTurn({
        sessionId: session.id,
        headSha: tip,
        instruction: queued.instruction,
        modelChoice: queued.modelChoice,
        costLimitCents: queued.costLimitCents,
        environment: queued.environment,
        runnerEnvironment: queued.runnerEnvironment ?? null,
        profile: queued.profile,
        resultSchema: queued.resultSchema,
        createdBy: queued.createdBy,
        actorLogin: queued.actorLogin,
        clientRequestId: queued.clientRequestId,
        fromQueued: true,
      });
      // `existing`: another call started this very instruction a moment ago (its request id found the turn). It is started, not by this call.
      if (result.status === "created") {
        log(
          `[implementer] queued instruction started job=${result.job.id} session=${session.id} turn=${String(result.turn.number)}`,
        );
        return { status: "started", runId: result.job.id };
      }
      return { status: "nothing" };
    },

    async continuation(jobId) {
      // An id the database would refuse (a NUL byte) or that is no id at all is a run that is not there, not a failure.
      if (!isPlausibleId(jobId)) return undefined;
      const found = await deps.sessions.getTurnByJob(jobId);
      if (found === undefined) return undefined;
      const { turn, session } = found;
      const last = await deps.sessions.lastTurn(session.id);
      // Only the newest turn continues: an older run links to the newer one, it does not branch.
      if (last === undefined || last.id !== turn.id) return undefined;
      const step = await deps.steps.lastStep(turn.jobId);
      const tokens =
        step === undefined ||
        typeof step.tokens !== "object" ||
        step.tokens === null
          ? null
          : (step.tokens as Record<string, unknown>);
      const count = (name: string): number => {
        const value = tokens?.[name];
        return typeof value === "number" && Number.isFinite(value) && value > 0
          ? value
          : 0;
      };
      const chosen = turn.environment ?? turn.runnerEnvironment;
      const total =
        count("input") +
        count("cacheRead") +
        count("cacheWrite") +
        count("output");
      return {
        sessionId: session.id,
        branch: session.branch,
        turnNumber: turn.number,
        sessionStatus: session.status,
        defaults: {
          model: turn.modelChoice,
          costLimitCents: turn.costLimitCents,
          environment:
            chosen === null ? null : { id: chosen.id, name: chosen.name },
          profile: profileRefOf(turn.profile),
        },
        queued:
          session.queued === null
            ? null
            : { instruction: session.queued.instruction },
        discarded:
          session.discarded === null ? null : toDiscarded(session.discarded),
        historyTokens: total > 0 ? total : null,
      };
    },
  };
}

function toDiscarded(discarded: DiscardedInstruction): {
  reason: DiscardReason;
  instruction: string;
} {
  return { reason: discarded.reason, instruction: discarded.instruction };
}
