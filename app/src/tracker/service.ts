// SPDX-License-Identifier: LicenseRef-Proprietary

// What the routes use of the ticket mirror (#923) in ONE workspace: the list of a repository's issues, enriched at read time, and the
// full sync ("Resync"). The enrichment is read when the list is asked for and never stored: the run that is going on for each ticket (the
// lane, its current step and status) and the money the runs of the ticket spent so far, both from `workflow_runs` through `ticket_ref`.
// The cache itself holds only what the provider delivers; a value here is the provider's, unmapped.
import type { IntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { jiraSourceOf } from "../db/repositories/projects-repository.ts";
import type { RepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import type {
  TrackerItem,
  TrackerItemState,
  TrackerRepository,
} from "../db/repositories/tracker-repository.ts";
import type {
  RunLaneProgress,
  WorkflowRunsRepository,
} from "../db/repositories/workflow-runs-repository.ts";
import { IntegrationError } from "../integrations/errors.ts";
import type { Integration } from "../integrations/types.ts";
import type { ProjectService } from "../projects/service.ts";
import type { SyncState } from "../projects/ui/sync-staleness.ts";
import {
  laneNodesOfRun,
  type LaneNodeView,
} from "../workflow-runs/lane-nodes.ts";
import type { StepSummaryView } from "../workflow-runs/lane-run-list.ts";
import { TrackerError } from "./errors.ts";
import { TRACKER_PROVIDER } from "./mirror.ts";
import type { SyncProgress, TrackerSync } from "./sync.ts";

/** The run that is going on for a ticket: running, or waiting for an answer (#925). */
export type TicketLane = {
  runId: string;
  /** The workflow (lane) of the run: the address of the run page. */
  workflowId: string;
  /** The name of the workflow. */
  name: string;
  /** The step that runs now, or asks (or the next one that waits); null before the first step is written. */
  step: string | null;
  status: "running" | "waiting";
  /**
   * The top-level nodes of the version of the lane the run started with (#1080), what the board's step track is drawn on; empty when that
   * version cannot be read any more (the track is then left out).
   */
  nodes: LaneNodeView[];
  /** The summaries of the steps the run has written so far, in the order they were written (#1080). */
  steps: StepSummaryView[];
};

/** One ticket of the list: the provider's fields as the cache holds them, plus what is read at the time of the question. */
export type TicketListItem = {
  /** The text key of the ticket inside its provider (`15` for a GitHub issue, `PROJ-7` for a Jira issue, #1040). */
  key: string;
  number: number;
  kind: TrackerItem["kind"];
  state: TrackerItem["state"];
  stateReason: string | null;
  type: string | null;
  title: string;
  bodyExcerpt: string;
  labels: TrackerItem["labels"];
  assignees: TrackerItem["assignees"];
  boardStatus: string | null;
  parentNumber: number | null;
  pullRequests: number[];
  /**
   * The state of each linked pull request the cache holds, wherever it is (also outside of the page). A pull request the cache does not
   * hold has no entry: its state is unknown (#954).
   */
  pullRequestStates: Record<number, TrackerItemState>;
  checksState: string | null;
  /** The provider's time of the last change. */
  updatedAt: string;
  /** When the cache last wrote the row. */
  syncedAt: string;
  /** The address of the ticket on the provider. */
  url: string;
  /** The run that is going on for the ticket, or null. */
  lane: TicketLane | null;
  /** What the runs of the ticket spent so far, in US dollars. */
  costUsd: number;
};

export type TicketList = {
  /** The provider of the project's ticket source: `github` or `jira` (#1040); the Issues tab words and links its tickets for it. */
  provider: string;
  repositoryId: string;
  repo: string;
  items: TicketListItem[];
  /**
   * Where the cache stands: when the last full sync ended, whether one is under way, and when a row was last written (a delivery, or the
   * sync). A `lastWriteAt` that is not after `lastFullSyncAt` says no delivery has arrived since the sync (#932): what the hint in Setup
   * reads ("nothing has been delivered since the last full sync").
   */
  sync: SyncState;
};

export type TicketQuery = {
  /** Left out: `open`. `all` lists both. */
  state: TrackerItemState | "all";
  limit: number;
  offset: number;
};

export type TrackerService = {
  /** Where the cache of an active project's repository stands, without reading a ticket (the Setup tab's hint). Throws a `TrackerError`. */
  syncState(repositoryId: string): Promise<SyncState>;
  /** The tickets of an active project's repository, the newest change first. Throws a `TrackerError`. */
  listIssues(repositoryId: string, query: TicketQuery): Promise<TicketList>;
  /**
   * Continues the full sync of the repository or starts one, until it is done or the budget is spent (`SyncProgress.status`). Throws a
   * `TrackerError`; the position reached is kept, so asking again continues.
   */
  sync(
    repositoryId: string,
    options?: {
      maxPages?: number;
      deadline?: number;
      signal?: AbortSignal;
      resume?: boolean;
    },
  ): Promise<SyncProgress>;
};

/**
 * What reads a Jira project into the mirror (#1040): `src/jira/resync.ts`, which this module does not import (the two would form an import
 * cycle; `shared.ts` wires them). Left out where the deployment has no Jira: a Jira project is then `TRACKER_SOURCE_NOT_MIRRORED`.
 */
export type JiraMirrorSync = {
  /** The address of a ticket of the site (`<site>/browse/KEY`), or undefined when the site is not known. */
  siteUrlOf(connectionId: string): Promise<string | undefined>;
  sync(
    target: {
      repositoryId: string;
      repoFullName: string;
      connectionId: string;
      projectKey: string;
    },
    options: {
      maxPages?: number;
      deadline?: number;
      signal?: AbortSignal;
      resume?: boolean;
    },
  ): Promise<SyncProgress>;
};

export type TrackerServiceDependencies = {
  repositories: Pick<RepositoriesRepository, "get">;
  integrations: Pick<IntegrationsRepository, "get">;
  projects: Pick<ProjectService, "getActiveProjectForRepository">;
  tracker: Pick<
    TrackerRepository,
    "listItems" | "listItemsByNumbers" | "getSyncState" | "newestWriteAt"
  >;
  runs: Pick<WorkflowRunsRepository, "summarizeTickets" | "laneProgressOfRuns">;
  sync: TrackerSync;
  jira?: JiraMirrorSync;
};

/** The nodes and the step summaries of an active run for the board (#1080); a run whose progress was not read shows no track. */
function laneProgressView(
  progress: RunLaneProgress | undefined,
): Pick<TicketLane, "nodes" | "steps"> {
  if (progress === undefined) return { nodes: [], steps: [] };
  return {
    nodes: laneNodesOfRun(progress.document ?? undefined, {
      id: progress.triggerId,
      kind: progress.triggerKind,
    }),
    steps: progress.steps.map((step) => ({
      id: step.stepId,
      kind: step.kind,
      status: step.status,
      round: step.round,
    })),
  };
}

const MAX_ID_LENGTH = 128;
const MICRO = 1_000_000;
/** The most numbers one `listItemsByNumbers` call looks at. */
const NUMBERS_PER_READ = 200;

/** `github:owner/repo#128`: the form of `workflow_runs.ticket_ref` (`<provider>:<repo>#<key>`). */
export const ticketRefOf = (
  repo: string,
  key: string | number,
  provider: string = TRACKER_PROVIDER,
): string => `${provider}:${repo}#${key}`;

export function createTrackerService(
  deps: TrackerServiceDependencies,
): TrackerService {
  async function resolve(repositoryId: string) {
    if (
      typeof repositoryId !== "string" ||
      repositoryId.trim() === "" ||
      repositoryId.length > MAX_ID_LENGTH
    )
      throw new TrackerError(
        "TRACKER_REPOSITORY_NOT_FOUND",
        "There is no repository with this id.",
      );
    const repository = await deps.repositories.get(repositoryId);
    if (repository === undefined || !repository.active)
      throw new TrackerError(
        "TRACKER_REPOSITORY_NOT_FOUND",
        "There is no repository with this id.",
      );
    const project = await deps.projects.getActiveProjectForRepository(
      repository.id,
    );
    if (project === undefined)
      throw new TrackerError(
        "TRACKER_PROJECT_NOT_ACTIVE",
        "The repository has no active project, so its tickets are not mirrored.",
      );
    // The mirror holds GitHub issues or, since #1040, the issues of the project's Jira project (the issues of the repository of a Jira
    // project are not that project's tickets); a source it cannot read is not mirrored.
    const jira = jiraSourceOf(project.ticketSource);
    if (
      jira === null
        ? project.ticketSource.provider !== TRACKER_PROVIDER
        : deps.jira === undefined
    )
      throw new TrackerError(
        "TRACKER_SOURCE_NOT_MIRRORED",
        "The tickets of this project do not come from a source whose tickets are mirrored here.",
      );
    return { repository, project, jira };
  }

  async function stateOf(
    repositoryId: string,
    provider?: string,
  ): Promise<SyncState> {
    const state = await deps.tracker.getSyncState(repositoryId, provider);
    return {
      lastFullSyncAt: state?.lastFullSyncAt ?? null,
      inProgress: state?.cursor != null,
      lastWriteAt: await deps.tracker.newestWriteAt(repositoryId),
    };
  }

  /** The state of every pull request that an issue of the page links, from the page or else from the cache, in as few reads as possible. */
  async function pullRequestStatesOf(
    repositoryId: string,
    items: readonly TrackerItem[],
  ): Promise<Map<number, TrackerItemState>> {
    const states = new Map<number, TrackerItemState>();
    for (const item of items)
      if (item.kind === "pull_request") states.set(item.number, item.state);
    const missing = [
      ...new Set(
        items
          .filter((item) => item.kind === "issue")
          .flatMap((item) => item.pullRequests),
      ),
    ].filter((number) => !states.has(number));
    for (let at = 0; at < missing.length; at += NUMBERS_PER_READ)
      for (const found of await deps.tracker.listItemsByNumbers(
        repositoryId,
        missing.slice(at, at + NUMBERS_PER_READ),
      ))
        if (found.kind === "pull_request")
          states.set(found.number, found.state);
    return states;
  }

  return {
    async syncState(repositoryId) {
      const { repository, jira } = await resolve(repositoryId);
      return stateOf(repository.id, jira === null ? undefined : "jira");
    },

    async listIssues(repositoryId, query) {
      const { repository, jira } = await resolve(repositoryId);
      const siteUrl =
        jira === null
          ? undefined
          : (await deps.jira?.siteUrlOf(jira.connectionId))?.replace(
              /\/+$/,
              "",
            );
      const items = await deps.tracker.listItems(repository.id, {
        ...(query.state === "all" ? {} : { state: query.state }),
        limit: query.limit,
        offset: query.offset,
      });
      const pullStates = await pullRequestStatesOf(repository.id, items);
      const summaries = new Map(
        (
          await deps.runs.summarizeTickets(
            items.map((item) =>
              ticketRefOf(item.repo, item.key, item.provider),
            ),
          )
        ).map((summary) => [summary.ticketRef, summary]),
      );
      // Where each active run stands in its lane: one read of the steps and one of the lane versions for every active run of the page.
      const progress = new Map(
        (
          await deps.runs.laneProgressOfRuns(
            [...summaries.values()].flatMap((summary) =>
              summary.activeRun === null ? [] : [summary.activeRun.runId],
            ),
          )
        ).map((entry) => [entry.runId, entry]),
      );
      return {
        provider: jira === null ? TRACKER_PROVIDER : "jira",
        repositoryId: repository.id,
        repo: repository.fullName,
        items: items.map((item) => {
          const summary = summaries.get(
            ticketRefOf(item.repo, item.key, item.provider),
          );
          const segment = item.kind === "pull_request" ? "pull" : "issues";
          return {
            number: item.number,
            kind: item.kind,
            state: item.state,
            stateReason: item.stateReason,
            type: item.type,
            title: item.title,
            bodyExcerpt: item.bodyExcerpt,
            labels: item.labels,
            assignees: item.assignees,
            boardStatus: item.boardStatus,
            parentNumber: item.parentNumber,
            pullRequests: item.pullRequests,
            pullRequestStates: Object.fromEntries(
              item.pullRequests.flatMap(
                (number): [number, TrackerItemState][] => {
                  const state = pullStates.get(number);
                  return state === undefined ? [] : [[number, state]];
                },
              ),
            ),
            checksState: item.checksState,
            updatedAt: item.updatedAt,
            syncedAt: item.syncedAt,
            key: item.key,
            url:
              jira === null
                ? `${repository.url}/${segment}/${item.number}`
                : siteUrl === undefined
                  ? ""
                  : `${siteUrl}/browse/${encodeURIComponent(item.key)}`,
            lane:
              summary?.activeRun == null
                ? null
                : {
                    runId: summary.activeRun.runId,
                    workflowId: summary.activeRun.workflowId,
                    name: summary.activeRun.workflowName,
                    step: summary.activeRun.stepId,
                    status:
                      summary.activeRun.status === "waiting"
                        ? "waiting"
                        : "running",
                    ...laneProgressView(progress.get(summary.activeRun.runId)),
                  },
            costUsd: (summary?.spentMicroUsd ?? 0) / MICRO,
          };
        }),
        sync: await stateOf(repository.id),
      };
    },

    async sync(repositoryId, options = {}) {
      const { repository, project, jira } = await resolve(repositoryId);
      if (jira !== null && deps.jira !== undefined) {
        // A Jira project is read through its connection (no installation of the repository is involved: it only holds the code).
        try {
          return await deps.jira.sync(
            {
              repositoryId: repository.id,
              repoFullName: repository.fullName,
              ...jira,
            },
            options,
          );
        } catch (error) {
          const providerCode =
            typeof (error as { providerCode?: unknown } | null)
              ?.providerCode === "string"
              ? String((error as { providerCode: string }).providerCode)
              : error instanceof Error
                ? error.name
                : "unknown";
          console.error(
            `[tracker] sync of repository=${repository.id} (Jira) failed (${providerCode})`,
          );
          throw new TrackerError(
            "TRACKER_SYNC_FAILED",
            "Jira could not be asked, or refused. The sync stands where it was; start it again.",
            { providerCode },
          );
        }
      }
      const integration: Integration | undefined = await deps.integrations.get(
        repository.integrationId,
      );
      if (integration === undefined || integration.status !== "active")
        throw new TrackerError(
          "TRACKER_INTEGRATION_UNAVAILABLE",
          "The installation of the repository is suspended, removed or disconnected.",
        );
      try {
        // The project's own board, when it chose one (#922), is the only one that gives the board status.
        const boardId = project.ticketSource.board?.projectV2Id;
        return await deps.sync.run(integration, repository, {
          ...options,
          ...(boardId === undefined ? {} : { boardId }),
        });
      } catch (error) {
        // The code of the failure is for the log; the body of a failure of the platform is never repeated.
        const providerCode =
          error instanceof IntegrationError
            ? error.code
            : error instanceof Error
              ? error.name
              : "unknown";
        console.error(
          `[tracker] sync of repository=${repository.id} failed (${providerCode})`,
        );
        throw new TrackerError(
          "TRACKER_SYNC_FAILED",
          "GitHub could not be asked, or refused. The sync stands where it was; start it again.",
          { providerCode },
        );
      }
    },
  };
}
