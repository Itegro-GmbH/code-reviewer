// SPDX-License-Identifier: LicenseRef-Proprietary

// The runs for the pages: which runs exist, one run, and the last run of each repository. A thin layer
// over the read side of the jobs table (`runs-repository.ts`) that turns stored jobs into the views
// the browser may see (`run-view.ts`) and checks what comes in from a URL. The clock is passed in so a
// test fixes the time a running run's duration is counted to.
import "server-only";
import type { ProductIdentity } from "../product-identity/identity.ts";
import type { RunsRepository } from "../db/repositories/runs-repository.ts";
import type { LastRun, LastRunSource } from "../projects/ui/list-view.ts";
import type { RunPriceView } from "../workspace-billing/view.ts";
import { isRunStatus } from "./run-status.ts";
import {
  toCustomerRunDetailView,
  toRunRowView,
  type RunDetailSnapshot,
  type RunsFilter,
  type RunsSnapshot,
} from "./run-view.ts";

/** How many runs the list shows at most. */
export const RUNS_LIST_LIMIT = 100;

/** What a request may ask the list for. A value that is not valid is refused, not ignored. */
export type RunsFilterInput = {
  repositoryId?: string | undefined;
  status?: string | undefined;
};

export type ParsedRunsFilter = { ok: true; filter: RunsFilter } | { ok: false };

const MAX_ID_LENGTH = 128;
const RUN_ID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * An empty value means "no filter". Surrounding white space is not part of a value; a value that is
 * nothing but white space, an unknown status and an overlong repository id are invalid.
 */
export function parseRunsFilter(input: RunsFilterInput): ParsedRunsFilter {
  const filter: RunsFilter = {};
  if (input.repositoryId !== undefined && input.repositoryId !== "") {
    const repositoryId = input.repositoryId.trim();
    if (repositoryId === "" || repositoryId.length > MAX_ID_LENGTH)
      return { ok: false };
    filter.repositoryId = repositoryId;
  }
  if (input.status !== undefined && input.status !== "") {
    const status = input.status.trim();
    if (!isRunStatus(status)) return { ok: false };
    filter.status = status;
  }
  return { ok: true, filter };
}

/** The run with its price when it has one; a run without one stays exactly as it was. */
function withPrice<T extends { id: string }>(
  run: T,
  prices: ReadonlyMap<string, RunPriceView> | undefined,
): T & { price?: RunPriceView } {
  const price = prices?.get(run.id);
  return price === undefined ? run : { ...run, price };
}

export type RunsService = {
  list(filter: RunsFilter): Promise<RunsSnapshot>;
  /** undefined for an id that is not a run id or that nobody has. */
  get(id: string): Promise<RunDetailSnapshot | undefined>;
};

export function createRunsService(deps: {
  /** Who the run texts speak for: the sentences of a failed run name the product. */
  product: ProductIdentity;
  runs: RunsRepository;
  now?: () => Date;
  /** Takes secrets out of a log before it is shown. */
  redact?: (text: string) => string;
  /**
   * The price of each of these runs that has one (#505). Absent while billing is off: no run then carries a price, and nothing of
   * billing is read.
   */
  prices?: (jobIds: readonly string[]) => Promise<Map<string, RunPriceView>>;
}): RunsService {
  const now = deps.now ?? (() => new Date());
  return {
    async list(filter) {
      const answeredAt = now();
      const { runs, hasMore } = await deps.runs.list({
        ...filter,
        limit: RUNS_LIST_LIMIT,
      });
      const prices = await deps.prices?.(runs.map(({ job }) => job.id));
      return {
        generatedAt: answeredAt.toISOString(),
        runs: runs.map(({ job, project, implementer }) =>
          withPrice(
            toRunRowView(
              deps.product,
              job,
              project,
              answeredAt,
              implementer ?? null,
              deps.redact,
            ),
            prices,
          ),
        ),
        limited: hasMore,
      };
    },

    async get(id) {
      if (!RUN_ID.test(id)) return undefined;
      const answeredAt = now();
      const stored = await deps.runs.get(id);
      if (stored === undefined) return undefined;
      const prices = await deps.prices?.([stored.job.id]);
      return {
        generatedAt: answeredAt.toISOString(),
        run: withPrice(
          toCustomerRunDetailView(
            deps.product,
            stored.job,
            stored.project,
            answeredAt,
            deps.redact,
            stored.onManagedKey,
            stored.reviewComment,
            stored.implementer ?? null,
          ),
          prices,
        ),
      };
    },
  };
}

/**
 * The last run of each repository for the project list: its newest job, whatever its status, with the
 * time it last changed (when it finished, else when it started, else when it was queued).
 */
export function createLastRunSource(deps: {
  runs: RunsRepository;
}): LastRunSource {
  return async (repositoryIds) => {
    const jobs = await deps.runs.latestPerRepository(repositoryIds);
    return new Map<string, LastRun>(
      jobs.map((job) => [
        job.repositoryId,
        {
          status: job.status,
          at: job.finishedAt ?? job.claimedAt ?? job.createdAt,
        },
      ]),
    );
  };
}
