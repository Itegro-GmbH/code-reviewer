// SPDX-License-Identifier: LicenseRef-Proprietary

// The wiring of the running server behind the workflow engine (#844): the real database, the Implementer service, the registry of
// connectors, and the three entry points the rest of the app uses: the run service behind the routes, the hook of the runner API that
// says a turn is over, and the reconciler of the sweep.
import "server-only";
import { createImplementerEnvironmentsRepository } from "../db/repositories/implementer-environments-repository.ts";
import { createImplementerRepository } from "../db/repositories/implementer-repository.ts";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createJiraConnectionsRepository } from "../db/repositories/jira-connections-repository.ts";
import { createJobsRepository } from "../db/repositories/jobs-repository.ts";
import { createProfilesRepository } from "../db/repositories/profiles-repository.ts";
import {
  createProjectsRepository,
  jiraSourceOf,
} from "../db/repositories/projects-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { JIRA_ISSUE_KEY } from "../workflows/ticket-ref.ts";
import type { JiraAnswerTakerShape } from "./ticket-answers.ts";
import {
  registeredTicketProvider,
  type TicketProvider,
  type TicketProviderRegistry,
} from "../integrations/ticket-provider.ts";
import { createTrackerRepository } from "../db/repositories/tracker-repository.ts";
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
import {
  integrationRegistry,
  ticketProviderRegistry,
} from "../integrations/registry.ts";
import type { TicketScope } from "../integrations/ticket-provider.ts";
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
import { DEFAULT_TICKET_PROVIDER } from "./ticket-target.ts";
import { createRunTicketTargets } from "./run-ticket-targets.ts";
import { reconcileRuns, type ReconcileReport } from "./reconcile.ts";
import { WorkflowRunError } from "./errors.ts";
import { createWorkflowEngine, type WorkflowEngine } from "./engine.ts";
import { RUN_QUIET_MS, SWEEP_RUNS_MAX } from "./limits.ts";
import { createLabelTrigger, type LabelTrigger } from "./label-trigger.ts";
import { createStatusTrigger, type StatusTrigger } from "./status-trigger.ts";
import {
  createJiraStatusTrigger,
  jiraProjectView,
  type JiraStatusTrigger,
  type JiraStatusTriggerDependencies,
} from "./jira-status-trigger.ts";
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

/**
 * The Jira ticket provider as the engine's wiring knows it without importing `jira` (the `workflow-runs` module may not: a cycle through
 * `projects`): it can name a key and has NO method, so a ticket action of a process that registered no Jira provider finds a target and
 * ends with `ticket_provider_unsupported` (#1039). The real one is registered at the start of the process (`instrumentation.ts`,
 * `registerTicketProvider`, #1040) and found here at every call; a route that reads Jira tickets may also hand it in (`ticketProvidersWith`).
 */
export const WRITELESS_JIRA_PROVIDER: TicketProvider = {
  id: "jira",
  isTicketKey: (key) => JIRA_ISSUE_KEY.test(key),
};

/** The ticket providers of the app's registry (GitHub issues), the Jira stand-in above and, taking its place, the providers a caller hands in. */
export function ticketProvidersWith(
  extra: readonly TicketProvider[] = [],
): TicketProviderRegistry {
  const byId = new Map<string, TicketProvider>(
    [WRITELESS_JIRA_PROVIDER, ...extra].map((provider) => [
      provider.id,
      provider,
    ]),
  );
  const extraIds = new Set(extra.map((provider) => provider.id));
  return {
    // A provider handed in wins; then the one registered for the process (looked up now: it is registered at start); then the stand-ins.
    get: (id) =>
      (extraIds.has(id) ? byId.get(id) : undefined) ??
      registeredTicketProvider(id) ??
      byId.get(id) ??
      ticketProviderRegistry.get(id),
    ids: () => [...new Set([...ticketProviderRegistry.ids(), ...byId.keys()])],
  };
}

const runTicketTargets = createRunTicketTargets({
  tickets: ticketProvidersWith(),
  runs: (workspaceId) =>
    createWorkflowRunsRepository(getDatabase(), workspaceId),
  workflows: (workspaceId) =>
    createWorkflowsRepository(getDatabase(), workspaceId),
  projects: (workspaceId) =>
    createProjectsRepository(getDatabase(), workspaceId),
  async gitScopeOf(
    workspaceId,
    repositoryId,
  ): Promise<TicketScope | undefined> {
    const target = await connectorTargetOf(workspaceId, repositoryId);
    return target === undefined
      ? undefined
      : { integration: target.integration, repo: target.repo };
  },
});

/** Where the ticket actions of a run act (#1035): the ticket provider the ticket source of the run's project names; see `run-ticket-targets.ts`. */
export const ticketTargetOf = runTicketTargets.ticketTargetOf;
const projectOfRun = runTicketTargets.projectOfRun;

const connectors = createConnectorRegistry(
  createGithubConnectors({
    targetOf: (call) => connectorTargetOf(call.workspaceId, call.repository.id),
    ticketTargetOf,
    // #922: the board of the project the run's lane belongs to.
    async projectBoard(call) {
      return (await projectOfRun(call))?.ticketSource.board?.projectV2Id;
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
    ticketTargetOf: (run) =>
      ticketTargetOf({
        workspaceId,
        runId: run.id,
        repository: { id: run.repositoryId },
      }),
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

/**
 * What a run reads from GitHub before it exists: the repository of the workspace with its default branch, and a ticket of it (the
 * texts are those of whoever opened it). Shared by the run service (a start by hand) and the status trigger (#1036).
 */
function githubReads(
  workspaceId: string,
  tickets: TicketProviderRegistry = ticketProvidersWith(),
): Pick<
  Parameters<typeof createWorkflowRunService>[0],
  "resolveRepository" | "readTicket"
> {
  const db = getDatabase();
  const repositories = createRepositoriesRepository(db, workspaceId);
  const integrations = createIntegrationsRepository(db, workspaceId);
  const projects = createProjectsRepository(db, workspaceId);
  return {
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
    async readTicket(repositoryId, key) {
      const repository = await repositories.get(repositoryId);
      if (repository === undefined) return undefined;
      const integration = await integrations.get(repository.integrationId);
      if (integration === undefined || integration.status !== "active")
        return undefined;
      // The tickets of a repository are read through the ticket provider of its project's source: the GitHub issues of the repository, or
      // the Jira project (#1039; the repository is then where the code lives).
      const jira = jiraSourceOf(
        (await projects.findActiveForRepository(repositoryId))
          ?.ticketSource ?? {
          provider: "github",
          repositoryId,
          board: null,
        },
      );
      const provider = tickets.get(
        jira === null ? DEFAULT_TICKET_PROVIDER : "jira",
      );
      if (provider?.readTicket === undefined) return undefined;
      try {
        return (
          (await provider.readTicket(
            {
              integration,
              repo: {
                integrationId: repository.integrationId,
                externalId: repository.externalId,
                fullName: repository.fullName,
                url: repository.url,
              },
              ...(jira === null ? {} : { jira }),
            },
            key,
          )) ?? undefined
        );
      } catch {
        throw new WorkflowRunError(
          "WORKFLOW_RUN_GITHUB_UNAVAILABLE",
          "The ticket platform (GitHub or Jira) could not be asked, or answered with something unusable.",
        );
      }
    },
  };
}

/** The run service of one workspace. */
export function workflowRunServiceFor(
  workspaceId: string,
  /** The ticket providers the route can read tickets with that this module may not import (the Jira provider, #1039). */
  extraTicketProviders: readonly TicketProvider[] = [],
): WorkflowRunService {
  const db = getDatabase();
  const repositories = createRepositoriesRepository(db, workspaceId);
  const projects = createProjectsRepository(db, workspaceId);
  const jiraConnections = createJiraConnectionsRepository(db, workspaceId);
  return createWorkflowRunService({
    runs: createWorkflowRunsRepository(db, workspaceId),
    // #920: the engine that takes an answer from the page of the run.
    engine: lazyAnswerEngine(workspaceId),
    workflows: createWorkflowsRepository(db, workspaceId),
    projects,
    repositoryName: async (id) => (await repositories.get(id))?.fullName,
    // #1086: the site of a Jira ticket's link, from the stored connection of the project's source (never a call to Jira).
    jiraSiteUrlOf: async (repositoryId) => {
      const jira = jiraSourceOf(
        (await projects.get(repositoryId))?.ticketSource ?? {
          provider: "github",
          repositoryId,
          board: null,
        },
      );
      if (jira === null) return undefined;
      return (await jiraConnections.get(jira.connectionId))?.siteUrl;
    },
    ...githubReads(workspaceId, ticketProvidersWith(extraTicketProviders)),
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
      // The reply goes where the comment was: below the Jira issue, through the ticket provider of the project's Jira source (#1040).
      if (answer.ticket?.provider === "jira") {
        const jira = jiraSourceOf(
          (
            await createProjectsRepository(
              db,
              workspaceId,
            ).findActiveForRepository(repositoryId)
          )?.ticketSource ?? { provider: "github", repositoryId, board: null },
        );
        const provider = ticketProvidersWith().get("jira");
        const target = await connectorTargetOf(workspaceId, repositoryId);
        if (
          jira === null ||
          provider?.commentOnTicket === undefined ||
          target === undefined
        )
          return;
        await provider.commentOnTicket(
          { integration: target.integration, repo: target.repo, jira },
          answer.ticket.key,
          `${key}\n${text}`,
          {
            marker: key,
            ...(answer.createdAt === undefined
              ? {}
              : { since: answer.createdAt }),
          },
        );
        return;
      }
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
 * What takes the answer a Jira comment `/answer …` gives (#1040): the Jira webhook hands over the comment; this finds the run that waits on
 * the issue (`ticket_ref` `jira:<owner>/<repo>#PROJ-12`) with `ticketAnswersFor` and answers it, as a comment on GitHub does.
 */
export function jiraAnswersFor(workspaceId: string): JiraAnswerTakerShape {
  const repositories = createRepositoriesRepository(getDatabase(), workspaceId);
  const answers = ticketAnswersFor(workspaceId);
  return {
    async answer(deliveryId, answer) {
      const repository = await repositories.get(answer.repositoryId);
      if (repository === undefined) return { outcome: "no_run" };
      const { comment } = answer;
      const taken = await answers.answer(deliveryId, {
        repo: {
          integrationId: repository.integrationId,
          externalId: repository.externalId,
          fullName: repository.fullName,
          url: repository.url,
        },
        number: Number(JIRA_ISSUE_KEY.exec(answer.issueKey)?.[2] ?? 0),
        ticket: { provider: "jira", key: answer.issueKey },
        commentId: comment.id,
        ...(comment.createdAt === "" ? {} : { createdAt: comment.createdAt }),
        actor: {
          login: comment.author.name,
          externalId: comment.author.accountId,
        },
        ...(answer.choice === undefined ? {} : { choice: answer.choice }),
        ...(answer.text === undefined ? {} : { text: answer.text }),
        raw: answer.raw,
      });
      return taken.outcome === "not_taken"
        ? { outcome: "not_taken", reason: taken.reason }
        : taken;
    },
  };
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
 * The status trigger of one workspace (#1036): the webhook hands it a board item that got another Status once the ticket mirror took it; it
 * writes the runs of the workflows that wait for that status. The ticket and the repository are read from GitHub only when a workflow
 * matched. The first steps run after the response, as for a label.
 */
export function statusTriggerFor(workspaceId: string): StatusTrigger {
  const db = getDatabase();
  const repositories = createRepositoriesRepository(db, workspaceId);
  const tracker = createTrackerRepository(db, workspaceId);
  const projects = createProjectsRepository(db, workspaceId);
  const integrations = createIntegrationsRepository(db, workspaceId);
  const reads = githubReads(workspaceId);
  return createStatusTrigger({
    runs: createWorkflowRunsRepository(db, workspaceId),
    workflows: createWorkflowsRepository(db, workspaceId),
    async ticketOfNode(nodeId) {
      const item = await tracker.findItemByNode(nodeId);
      // A pull request on a board is no ticket a lane starts for.
      return item === undefined || item.kind !== "issue"
        ? undefined
        : {
            provider: item.provider,
            repositoryId: item.repositoryId,
            integrationId:
              (await repositories.get(item.repositoryId))?.integrationId ?? "",
            key: item.key,
          };
    },
    async currentStatusOf(repositoryId, nodeId, board) {
      const repository = await repositories.get(repositoryId);
      if (repository === undefined) return { available: false, status: null };
      const integration = await integrations.get(repository.integrationId);
      if (integration === undefined || integration.status !== "active")
        return { available: false, status: null };
      const provider = ticketProviderRegistry.get(DEFAULT_TICKET_PROVIDER);
      if (provider?.readBoardStatus === undefined)
        return { available: false, status: null };
      return provider.readBoardStatus(
        {
          integration,
          repo: {
            integrationId: repository.integrationId,
            externalId: repository.externalId,
            fullName: repository.fullName,
            url: repository.url,
          },
        },
        nodeId,
        board,
      );
    },
    async boardOf(repositoryId) {
      return (await projects.findActiveForRepository(repositoryId))
        ?.ticketSource.board?.projectV2Id;
    },
    async repositoryOf(repositoryId) {
      const repository = await repositories.get(repositoryId);
      if (repository === undefined || !repository.active) return undefined;
      return reads.resolveRepository(repository.fullName);
    },
    readTicket: reads.readTicket,
    kick: (runId) =>
      runAfterResponse(() => workflowEngineFor(workspaceId).advance(runId)),
  });
}

/**
 * The status trigger of a Jira project in one workspace (#1039): the webhook hands it an issue whose status changed; it finds the lanes of
 * the registration's project, asks Jira for the issue's status NOW (the stale guard) and writes the runs. The first steps run after the
 * response, as for a label.
 */
export function jiraStatusTriggerFor(
  workspaceId: string,
  /** The Jira ticket provider (`jira/shared.ts`): the route that wires the Jira webhook hands it in. */
  jira: TicketProvider,
  /** The statuses of a Jira project (`jira/shared.ts` `jiraStatusesFor`): lanes compare a status by its id, because Jira localizes names (#1058). */
  statusesOf?: JiraStatusTriggerDependencies["statusesOf"],
): JiraStatusTrigger {
  const db = getDatabase();
  const projects = createProjectsRepository(db, workspaceId);
  const reads = githubReads(workspaceId, ticketProvidersWith([jira]));
  const repositories = createRepositoriesRepository(db, workspaceId);
  return createJiraStatusTrigger({
    ...(statusesOf === undefined ? {} : { statusesOf }),
    runs: createWorkflowRunsRepository(db, workspaceId),
    workflows: createWorkflowsRepository(db, workspaceId),
    async projectOf(projectId) {
      const project = await projects.getById(projectId);
      return project === undefined ? undefined : jiraProjectView(project);
    },
    async repositoryOf(repositoryId) {
      const repository = await repositories.get(repositoryId);
      if (repository === undefined || !repository.active) return undefined;
      return reads.resolveRepository(repository.fullName);
    },
    readTicket: (source, key) => reads.readTicket(source.repositoryId, key),
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
