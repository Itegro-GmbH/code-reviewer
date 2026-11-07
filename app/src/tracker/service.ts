// SPDX-License-Identifier: LicenseRef-Proprietary

// What the routes use of the ticket mirror (#923) in ONE workspace: the list of a repository's issues, enriched at read time, and the
// full sync ("Resync"). The enrichment is read when the list is asked for and never stored: the run that is going on for each ticket (the
// lane, its current step and status) and the money the runs of the ticket spent so far, both from `workflow_runs` through `ticket_ref`.
// The cache itself holds only what the provider delivers; a value here is the provider's, unmapped.
import type { IntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import type { RepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import type {
  TrackerItem,
  TrackerItemState,
  TrackerRepository,
} from "../db/repositories/tracker-repository.ts";
import type { WorkflowRunsRepository } from "../db/repositories/workflow-runs-repository.ts";
import { IntegrationError } from "../integrations/errors.ts";
import type { Integration } from "../integrations/types.ts";
import type { ProjectService } from "../projects/service.ts";
import { TrackerError } from "./errors.ts";
import { TRACKER_PROVIDER } from "./mirror.ts";
import type { SyncProgress, TrackerSync } from "./sync.ts";

/** The run that is going on for a ticket. */
export type TicketLane = {
  runId: string;
  /** The name of the workflow. */
  name: string;
  /** The step that runs now (or the next one that waits); null before the first step is written. */
  step: string | null;
  status: "running";
};

/** One ticket of the list: the provider's fields as the cache holds them, plus what is read at the time of the question. */
export type TicketListItem = {
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
  repositoryId: string;
  repo: string;
  items: TicketListItem[];
  /**
   * Where the cache stands: when the last full sync ended, whether one is under way, and when a row was last written (a delivery, or the
   * sync). A `lastWriteAt` that is not after `lastFullSyncAt` says no delivery has arrived since the sync (#932): what the hint in Setup
   * reads ("nothing has been delivered since the last full sync").
   */
  sync: {
    lastFullSyncAt: string | null;
    inProgress: boolean;
    lastWriteAt: string | null;
  };
};

export type TicketQuery = {
  /** Left out: `open`. `all` lists both. */
  state: TrackerItemState | "all";
  limit: number;
  offset: number;
};

export type TrackerService = {
  /** The tickets of an active project's repository, the newest change first. Throws a `TrackerError`. */
  listIssues(repositoryId: string, query: TicketQuery): Promise<TicketList>;
  /**
   * Continues the full sync of the repository or starts one, until it is done or the budget is spent (`SyncProgress.status`). Throws a
   * `TrackerError`; the position reached is kept, so asking again continues.
   */
  sync(
    repositoryId: string,
    options?: { maxPages?: number; deadline?: number },
  ): Promise<SyncProgress>;
};

export type TrackerServiceDependencies = {
  repositories: Pick<RepositoriesRepository, "get">;
  integrations: Pick<IntegrationsRepository, "get">;
  projects: Pick<ProjectService, "getActiveProjectForRepository">;
  tracker: Pick<
    TrackerRepository,
    "listItems" | "getSyncState" | "newestWriteAt"
  >;
  runs: Pick<WorkflowRunsRepository, "summarizeTickets">;
  sync: TrackerSync;
};

const MAX_ID_LENGTH = 128;
const MICRO = 1_000_000;

/** `github:owner/repo#128`: the form of `workflow_runs.ticket_ref`. */
export const ticketRefOf = (repo: string, number: number): string =>
  `${TRACKER_PROVIDER}:${repo}#${number}`;

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
    return repository;
  }

  return {
    async listIssues(repositoryId, query) {
      const repository = await resolve(repositoryId);
      const items = await deps.tracker.listItems(repository.id, {
        ...(query.state === "all" ? {} : { state: query.state }),
        limit: query.limit,
        offset: query.offset,
      });
      const summaries = new Map(
        (
          await deps.runs.summarizeTickets(
            items.map((item) => ticketRefOf(item.repo, item.number)),
          )
        ).map((summary) => [summary.ticketRef, summary]),
      );
      const state = await deps.tracker.getSyncState(repository.id);
      return {
        repositoryId: repository.id,
        repo: repository.fullName,
        items: items.map((item) => {
          const summary = summaries.get(ticketRefOf(item.repo, item.number));
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
            checksState: item.checksState,
            updatedAt: item.updatedAt,
            syncedAt: item.syncedAt,
            url: `${repository.url}/${segment}/${item.number}`,
            lane:
              summary?.activeRun == null
                ? null
                : {
                    runId: summary.activeRun.runId,
                    name: summary.activeRun.workflowName,
                    step: summary.activeRun.stepId,
                    status: "running",
                  },
            costUsd: (summary?.spentMicroUsd ?? 0) / MICRO,
          };
        }),
        sync: {
          lastFullSyncAt: state?.lastFullSyncAt ?? null,
          inProgress: state?.cursor != null,
          lastWriteAt: await deps.tracker.newestWriteAt(repository.id),
        },
      };
    },

    async sync(repositoryId, options = {}) {
      const repository = await resolve(repositoryId);
      const integration: Integration | undefined = await deps.integrations.get(
        repository.integrationId,
      );
      if (integration === undefined || integration.status !== "active")
        throw new TrackerError(
          "TRACKER_INTEGRATION_UNAVAILABLE",
          "The installation of the repository is suspended, removed or disconnected.",
        );
      try {
        return await deps.sync.run(integration, repository, options);
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
