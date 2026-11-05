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
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { createWorkflowRunsRepository } from "../db/repositories/workflow-runs-repository.ts";
import { dueWorkflowRuns } from "../db/repositories/workflow-runs-sweep.ts";
import { createWorkflowsRepository } from "../db/repositories/workflows-repository.ts";
import { createWorkspaceMembersRepository } from "../db/repositories/workspace-members-repository.ts";
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
import { createConnectorRegistry } from "./connectors.ts";
import { createGithubConnectors } from "./github-connectors.ts";
import { createTurnReader } from "./turn-reader.ts";
import { reconcileRuns, type ReconcileReport } from "./reconcile.ts";
import { WorkflowRunError } from "./errors.ts";
import { createWorkflowEngine, type WorkflowEngine } from "./engine.ts";
import { RUN_QUIET_MS, SWEEP_RUNS_MAX } from "./limits.ts";
import { createLabelTrigger, type LabelTrigger } from "./label-trigger.ts";
import {
  createWorkflowRunService,
  type WorkflowRunService,
} from "./service.ts";

/**
 * The actions this server can do: the three GitHub actions, through the GitHub App of the workspace. They need rights of the App the
 * owner grants (Issues and Pull requests: read and write); where the App lacks one, the step ends as `github_permission_missing`.
 */
const connectors = createConnectorRegistry(
  createGithubConnectors({
    async targetOf(call) {
      const db = getDatabase();
      const repository = await createRepositoriesRepository(
        db,
        call.workspaceId,
      ).get(call.repository.id);
      if (repository === undefined) return undefined;
      const integration = await createIntegrationsRepository(
        db,
        call.workspaceId,
      ).get(repository.integrationId);
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
    },
  }),
);

/** The engine of one workspace. */
export function workflowEngineFor(workspaceId: string): WorkflowEngine {
  const db = getDatabase();
  const repositories = createRepositoriesRepository(db, workspaceId);
  const jobs = createJobsRepository(db, workspaceId);
  const turns = createImplementerRepository(db, workspaceId);
  return createWorkflowEngine({
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

/** The run service of one workspace. */
export function workflowRunServiceFor(workspaceId: string): WorkflowRunService {
  const db = getDatabase();
  const repositories = createRepositoriesRepository(db, workspaceId);
  const integrations = createIntegrationsRepository(db, workspaceId);
  return createWorkflowRunService({
    runs: createWorkflowRunsRepository(db, workspaceId),
    workflows: createWorkflowsRepository(db, workspaceId),
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
        return { id: repository.id, defaultBranch: facts.defaultBranch };
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
