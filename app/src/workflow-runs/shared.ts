// SPDX-License-Identifier: LicenseRef-Proprietary

// The wiring of the running server behind the workflow engine (#844): the real database, the Implementer service, the registry of
// connectors, and the three entry points the rest of the app uses: the run service behind the routes, the hook of the runner API that
// says a turn is over, and the reconciler of the sweep.
import "server-only";
import { createImplementerEnvironmentsRepository } from "../db/repositories/implementer-environments-repository.ts";
import { createImplementerRepository } from "../db/repositories/implementer-repository.ts";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createJobsRepository } from "../db/repositories/jobs-repository.ts";
import { createProfilesRepository } from "../db/repositories/profiles-repository.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { createWorkflowRunsRepository } from "../db/repositories/workflow-runs-repository.ts";
import { dueWorkflowRuns } from "../db/repositories/workflow-runs-sweep.ts";
import { createWorkflowsRepository } from "../db/repositories/workflows-repository.ts";
import { createWorkspaceMembersRepository } from "../db/repositories/workspace-members-repository.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { runAfterResponse } from "../dispatch/shared.ts";
import { startQueuedFollowUps } from "../implementer/follow-up-shared.ts";
import {
  implementerServiceFor,
  implementerTurnPricer,
} from "../implementer/shared.ts";
import { integrationRegistry } from "../integrations/registry.ts";
import { jobQueueFor } from "../jobs/shared.ts";
import type { Job } from "../jobs/job-types.ts";
import { loadAuthConfig } from "../auth/config.ts";
import type { ReachSamples } from "../workflows/reach.ts";
import { createGithubAskChannel } from "./ask-channel.ts";
import { runPagePath } from "./ask-comment.ts";
import { createTicketAnswers, type TicketAnswers } from "./ticket-answers.ts";
import { createConnectorRegistry } from "./connectors.ts";
import {
  createGithubConnectors,
  type GithubActionTarget,
} from "./github-connectors.ts";
import { createTurnReader } from "./turn-reader.ts";
import { reconcileRuns, type ReconcileReport } from "./reconcile.ts";
import { WorkflowRunError } from "./errors.ts";
import { createWorkflowEngine, type WorkflowEngine } from "./engine.ts";
import { RUN_QUIET_MS, SWEEP_RUNS_MAX } from "./limits.ts";
import { createLabelTrigger, type LabelTrigger } from "./label-trigger.ts";
import { latestRunSamples } from "./samples.ts";
import {
  createWorkflowRunService,
  type WorkflowRunService,
} from "./service.ts";

/**
 * The actions this server can do: the GitHub actions, through the GitHub App of the workspace. They need rights of the App the
 * owner grants (Issues and Pull requests: read and write, and for `ticket.setStatus` the opt-in Projects permission); where the App
 * lacks one, the step ends as `github_permission_missing`.
 */
export async function connectorTargetOf(
  workspaceId: string,
  repositoryId: string,
): Promise<GithubActionTarget | undefined> {
  const db = getDatabase();
  const repository = await createRepositoriesRepository(db, workspaceId).get(
    repositoryId,
  );
  if (repository === undefined) return undefined;
  const integration = await createIntegrationsRepository(db, workspaceId).get(
    repository.integrationId,
  );
  if (integration === undefined || integration.status !== "active")
    return undefined;
  return {
    provider: integrationRegistry.resolve(integration.type),
    integration,
    repo: {
      integrationId: repository.integrationId,
      externalId: repository.externalId,
      fullName: repository.fullName,
      url: repository.url,
    },
  };
}

const connectors = createConnectorRegistry(
  createGithubConnectors({
    targetOf: (call) => connectorTargetOf(call.workspaceId, call.repository.id),
    // #922: the board of the project the run's lane belongs to.
    async projectBoard(call) {
      const db = getDatabase();
      const run = await createWorkflowRunsRepository(
        db,
        call.workspaceId,
      ).getRun(call.runId);
      if (run === undefined) return undefined;
      const workflow = await createWorkflowsRepository(
        db,
        call.workspaceId,
      ).get(run.workflowId);
      if (workflow?.workflow.projectId == null) return undefined;
      const project = await createProjectsRepository(
        db,
        call.workspaceId,
      ).getById(workflow.workflow.projectId);
      return project?.ticketSource.board?.projectV2Id;
    },
    // The members of the workspace are the people of its projects until a project has members of its own (#922).
    projectMembers: (call) =>
      createWorkspaceMembersRepository(
        getDatabase(),
        call.workspaceId,
      ).githubLogins(),
  }),
);

/**
 * Where the questions of agents are shown for one workspace (#920): the ticket of the run, else its pull request, through the GitHub App of the
 * workspace. The members of the workspace that have a GitHub login are the ones asked.
 */
function askChannelFor(workspaceId: string) {
  const db = getDatabase();
  const runs = createWorkflowRunsRepository(db, workspaceId);
  return createGithubAskChannel({
    async targetOf(run) {
      return connectorTargetOf(workspaceId, run.repositoryId);
    },
    listSteps: (runId) => runs.listSteps(runId),
    isDiscarded: async (runId) =>
      (await runs.getRun(runId))?.status === "discarded",
    memberLogins: () =>
      createWorkspaceMembersRepository(db, workspaceId).githubLogins(),
    async runLink(run) {
      const workspace = await createWorkspacesRepository(db).get(workspaceId);
      return new URL(
        runPagePath(workspace?.slug ?? workspaceId, run),
        loadAuthConfig(process.env).baseUrl,
      ).href;
    },
  });
}

/** The engine of one workspace. */
export function workflowEngineFor(workspaceId: string): WorkflowEngine {
  const db = getDatabase();
  const repositories = createRepositoriesRepository(db, workspaceId);
  const jobs = createJobsRepository(db, workspaceId);
  const turns = createImplementerRepository(db, workspaceId);
  return createWorkflowEngine({
    asks: askChannelFor(workspaceId),
    runs: createWorkflowRunsRepository(db, workspaceId),
    workflows: createWorkflowsRepository(db, workspaceId),
    members: createWorkspaceMembersRepository(db, workspaceId),
    profiles: createProfilesRepository(db, workspaceId),
    environments: createImplementerEnvironmentsRepository(db, workspaceId),
    implementer: implementerServiceFor(workspaceId),
    jobs: jobQueueFor(workspaceId),
    turns: createTurnReader({
      jobs,
      turns,
      priceOf: implementerTurnPricer(),
    }),
    connectors,
    repositoryName: async (id) => (await repositories.get(id))?.fullName,
  });
}

/**
 * The part of the engine that takes an answer or discards a run, built when one comes. The engine reaches the Implementer and, through it,
 * the keys of the instance (the app secret): a route that only reads or starts runs, and a webhook that carries no answer, do not need them
 * and load without them.
 */
function lazyAnswerEngine(
  workspaceId: string,
): Pick<WorkflowEngine, "answer" | "discard"> {
  return {
    answer: (runId, input) =>
      workflowEngineFor(workspaceId).answer(runId, input),
    discard: (runId) => workflowEngineFor(workspaceId).discard(runId),
  };
}

/** The run service of one workspace. */
export function workflowRunServiceFor(workspaceId: string): WorkflowRunService {
  const db = getDatabase();
  const repositories = createRepositoriesRepository(db, workspaceId);
  const integrations = createIntegrationsRepository(db, workspaceId);
  return createWorkflowRunService({
    runs: createWorkflowRunsRepository(db, workspaceId),
    // #920: the engine that takes an answer from the page of the run.
    engine: lazyAnswerEngine(workspaceId),
    workflows: createWorkflowsRepository(db, workspaceId),
    projects: createProjectsRepository(db, workspaceId),
    repositoryName: async (id) => (await repositories.get(id))?.fullName,
    async resolveRepository(fullName) {
      const wanted = fullName.toLowerCase();
      const repository = (await repositories.list({ active: true })).find(
        (candidate) => candidate.fullName.toLowerCase() === wanted,
      );
      if (repository === undefined) return undefined;
      const integration = await integrations.get(repository.integrationId);
      if (integration === undefined || integration.status !== "active")
        return undefined;
      try {
        const facts = await integrationRegistry
          .resolve(integration.type)
          .getRepositoryFacts(integration, {
            integrationId: repository.integrationId,
            externalId: repository.externalId,
            fullName: repository.fullName,
            url: repository.url,
          });
        return {
          id: repository.id,
          fullName: repository.fullName,
          defaultBranch: facts.defaultBranch,
        };
      } catch {
        throw new WorkflowRunError(
          "WORKFLOW_RUN_GITHUB_UNAVAILABLE",
          "GitHub could not be asked, or answered with something unusable.",
        );
      }
    },
    async readTicket(repositoryId, number) {
      const repository = await repositories.get(repositoryId);
      if (repository === undefined) return undefined;
      const integration = await integrations.get(repository.integrationId);
      if (integration === undefined || integration.status !== "active")
        return undefined;
      const provider = integrationRegistry.resolve(integration.type);
      if (provider.readIssue === undefined) return undefined;
      try {
        return (
          (await provider.readIssue(
            integration,
            {
              integrationId: repository.integrationId,
              externalId: repository.externalId,
              fullName: repository.fullName,
              url: repository.url,
            },
            number,
          )) ?? undefined
        );
      } catch {
        throw new WorkflowRunError(
          "WORKFLOW_RUN_GITHUB_UNAVAILABLE",
          "GitHub could not be asked, or answered with something unusable.",
        );
      }
    },
    // The first steps run after the response: starting a turn asks GitHub several times.
    kick: (runId) =>
      runAfterResponse(() => workflowEngineFor(workspaceId).advance(runId)),
  });
}

/**
 * What takes the answer a comment `/answer ...` gives (#920): finds the run of the workspace that waits on the ticket or the pull request and
 * answers it. The turn that goes on starts after the response, as the first steps of a run do.
 */
export function ticketAnswersFor(workspaceId: string): TicketAnswers {
  const db = getDatabase();
  const repositories = createRepositoriesRepository(db, workspaceId);
  const runs = createWorkflowRunsRepository(db, workspaceId);
  return createTicketAnswers({
    async activeRepository(repo) {
      const repository = await repositories.findByExternalId(
        repo.integrationId,
        repo.externalId,
      );
      return repository?.active === true ? { id: repository.id } : undefined;
    },
    listWaitingForTicket: (ticketRef) =>
      runs.listWaitingForTicket(ticketRef, 100),
    listWaitingWithoutTicket: (repositoryId) =>
      runs.listWaitingWithoutTicket(repositoryId, 100),
    listSteps: (runId) => runs.listSteps(runId),
    hasRuns: (repositoryId) => runs.hasRunOnRepository(repositoryId),
    engine: lazyAnswerEngine(workspaceId),
    async reply(repositoryId, answer, text, key) {
      const target = await connectorTargetOf(workspaceId, repositoryId);
      if (target?.provider.commentOnIssue === undefined) return;
      await target.provider.commentOnIssue(
        target.integration,
        target.repo,
        answer.number,
        `${key}\n${text}`,
        // The reply follows the comment it answers: nothing older can hold the marker.
        {
          marker: key,
          ...(answer.createdAt === undefined
            ? {}
            : { since: answer.createdAt }),
        },
      );
    },
    kick: (runId) =>
      runAfterResponse(() => workflowEngineFor(workspaceId).advance(runId)),
  });
}

/**
 * The label trigger of one workspace (#845): the webhook hands it the issue a label was put on, it writes the runs of the workflows that
 * wait for that label. The first steps run after the response, as for a run started by hand.
 */
export function labelTriggerFor(workspaceId: string): LabelTrigger {
  const db = getDatabase();
  const repositories = createRepositoriesRepository(db, workspaceId);
  return createLabelTrigger({
    runs: createWorkflowRunsRepository(db, workspaceId),
    workflows: createWorkflowsRepository(db, workspaceId),
    async activeRepository(repo) {
      const repository = await repositories.findByExternalId(
        repo.integrationId,
        repo.externalId,
      );
      return repository?.active === true ? { id: repository.id } : undefined;
    },
    kick: (runId) =>
      runAfterResponse(() => workflowEngineFor(workspaceId).advance(runId)),
  });
}

/**
 * The hook of the runner API for a turn that is over (`ReportDeps.turnEnded`): hands the end to the engine after the response. It
 * never throws and the engine's own failures stay in the engine.
 */
export function turnEnded(job: Pick<Job, "id" | "workspaceId">): void {
  runAfterResponse(() => workflowEngineFor(job.workspaceId).jobEnded(job.id));
  // #841: the instruction a person queued behind this turn starts now. A second, independent reaction to the same event: it does not
  // wait for the engine, and neither can fail the other (`runAfterResponse` swallows what its work throws, and the starter counts and logs
  // its own failures). It lives here and not in the runner API because this module already depends on the Implementer; the runner API
  // importing it would be a new import cycle.
  runAfterResponse(() => startQueuedFollowUps(job));
}

/**
 * The reconciler of the sweep: a job can end without anybody reporting it (its lease ran out, a Dispatcher never started it), so no
 * event reaches the engine. The runs that run and were not touched for a while are looked at again; `advance` does nothing for a run
 * that waits for a job still running. `budgetMs` bounds the pass (checked between two runs). Returns how many runs it looked at.
 */
export function reconcileWorkflowRuns(
  options: { budgetMs?: number; now?: () => Date } = {},
): Promise<ReconcileReport> {
  const now = options.now ?? (() => new Date());
  return reconcileRuns({
    budgetMs: options.budgetMs,
    due: () =>
      dueWorkflowRuns(getDatabase(), {
        olderThan: new Date(now().getTime() - RUN_QUIET_MS).toISOString(),
        limit: SWEEP_RUNS_MAX,
      }),
    async look({ workspaceId, runId }) {
      await workflowEngineFor(workspaceId).advance(runId);
      // A run that waits is marked as looked at, so the next sweep takes the runs that waited longer first.
      await createWorkflowRunsRepository(getDatabase(), workspaceId).lockRun(
        runId,
        (lock) => lock.touch(),
      );
    },
  });
}

/** What the latest run of a workflow of one workspace held, for the samples of the picker of the lane builder (#927). */
export function runSamplesFor(
  workspaceId: string,
): (workflowId: string) => Promise<ReachSamples | undefined> {
  const runs = createWorkflowRunsRepository(getDatabase(), workspaceId);
  return (workflowId) => latestRunSamples(runs, workflowId);
}
