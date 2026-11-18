// SPDX-License-Identifier: LicenseRef-Proprietary

// The list of the lane runs of a workspace (#1078, epic #1077): what a request may ask (`readListQuery`), the opaque cursor between two
// pages, and the shape of one row of the list (`listItemOf`): the run with its lane, project and ticket, and what a view needs to draw
// where the run stands in its lane (the top-level nodes of the lane version and the summaries of the steps; the mapping of the two onto
// a track is `workflow-pages/run-track.ts`). Pure: the service reads the rows and hands them in.
import type {
  StepSummary,
  WorkspaceRunRow,
  WorkspaceRunsCursor,
  WorkspaceRunsFilter,
} from "../db/repositories/workflow-runs-repository.ts";
import {
  WORKSPACE_RUN_STATUS_FILTERS,
  type WorkspaceRunStatusFilter,
} from "../db/workflow-run-filters.ts";
import { parseTicketRef } from "../workflows/ticket-ref.ts";
import { WorkflowRunError } from "./errors.ts";
import { laneNodesOfRun, type LaneNodeView } from "./lane-nodes.ts";
import { MICRO_USD_PER_USD, RUNS_LISTED_MAX } from "./limits.ts";

/** How many runs a page holds when the request does not say. */
export const LANE_RUNS_PAGE_DEFAULT = 25;
/** The most runs a page holds. */
export const LANE_RUNS_PAGE_MAX = RUNS_LISTED_MAX;

const ID_MAX_LENGTH = 128;
const CURSOR_MAX_LENGTH = 512;

export type LaneRunsQuery = {
  filter: WorkspaceRunsFilter;
  limit: number;
  after?: WorkspaceRunsCursor;
};

/** What a person or a script asks: every field is the text of a query string, or left out. */
export type RawLaneRunsQuery = {
  status?: string | null | undefined;
  project?: string | null | undefined;
  lane?: string | null | undefined;
  cursor?: string | null | undefined;
  limit?: string | null | undefined;
};

/** The step of a run as a view needs it: the id of the node it runs, what kind, how it stands, and the round of its loop. */
export type StepSummaryView = {
  id: string;
  kind: StepSummary["kind"];
  status: StepSummary["status"];
  round: number;
};

export type LaneRunListItemView = {
  id: string;
  workflowId: string;
  /** The version of the lane the run started with. */
  workflowVersion: number;
  /** The name of the lane. A text of whoever named it. */
  laneName: string;
  status: WorkspaceRunRow["run"]["status"];
  errorCode: string | null;
  /** The repository the run works on: the project of the list. `name` is `owner/name`, null when the repository is gone. */
  project: { id: string; name: string | null };
  /** The ticket the run is about; null for a run that is about none. */
  ticket: {
    /** `#128` for a GitHub issue, the key (`PROJ-7`) for any other provider. */
    label: string;
    /** The title from the ticket mirror, or null when the mirror does not hold the ticket. The words of whoever opened it: text only. */
    title: string | null;
    /** The page of the ticket on its platform, or null where it is not known (a Jira site is not known to the list). */
    url: string | null;
  } | null;
  /** The top-level nodes of the version of the lane the run started with; empty when that version cannot be read any more. */
  nodes: LaneNodeView[];
  steps: StepSummaryView[];
  budgetUsd: number;
  spentUsd: number;
  createdAt: string;
  finishedAt: string | null;
};

export type LaneRunListView = {
  runs: LaneRunListItemView[];
  /** The `cursor` of the request for the next page; null on the last page. */
  nextCursor: string | null;
  /** When the list was read: the clock the relative times and the running durations of the page are counted against. */
  now: string;
};

const invalid = (message: string): WorkflowRunError =>
  new WorkflowRunError("WORKFLOW_RUN_REQUEST_INVALID", message);

function idOf(
  value: string | null | undefined,
  name: string,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value.length > ID_MAX_LENGTH) throw invalid(`The ${name} is not valid.`);
  return value;
}

export function encodeCursor(cursor: WorkspaceRunsCursor): string {
  return Buffer.from(
    JSON.stringify([cursor.active ? 0 : 1, cursor.createdAt, cursor.id]),
  ).toString("base64url");
}

export function decodeCursor(text: string): WorkspaceRunsCursor {
  const bad = invalid("The cursor is not valid.");
  if (text.length > CURSOR_MAX_LENGTH) throw bad;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
  } catch {
    throw bad;
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) throw bad;
  const [rank, createdAt, id] = parsed as unknown[];
  if (
    (rank !== 0 && rank !== 1) ||
    typeof createdAt !== "string" ||
    createdAt.length === 0 ||
    createdAt.length > 40 ||
    typeof id !== "string" ||
    id.length === 0 ||
    id.length > ID_MAX_LENGTH
  )
    throw bad;
  return { active: rank === 0, createdAt, id };
}

/** The query as the service reads it. Throws `WORKFLOW_RUN_REQUEST_INVALID` for a status, a limit or a cursor that is none. */
export function readListQuery(raw: RawLaneRunsQuery): LaneRunsQuery {
  const filter: WorkspaceRunsFilter = {};
  if (raw.status !== undefined && raw.status !== null && raw.status !== "") {
    if (
      !(WORKSPACE_RUN_STATUS_FILTERS as readonly string[]).includes(raw.status)
    )
      throw invalid(
        `The status must be one of ${WORKSPACE_RUN_STATUS_FILTERS.join(", ")}.`,
      );
    filter.status = raw.status as WorkspaceRunStatusFilter;
  }
  const project = idOf(raw.project, "project");
  if (project !== undefined) filter.repositoryId = project;
  const lane = idOf(raw.lane, "lane");
  if (lane !== undefined) filter.workflowId = lane;
  let limit = LANE_RUNS_PAGE_DEFAULT;
  if (raw.limit !== undefined && raw.limit !== null && raw.limit !== "") {
    limit = Number(raw.limit);
    if (!/^\d{1,3}$/.test(raw.limit) || limit < 1 || limit > LANE_RUNS_PAGE_MAX)
      throw invalid(
        `The limit must be a whole number from 1 to ${String(LANE_RUNS_PAGE_MAX)}.`,
      );
  }
  const cursor = raw.cursor;
  return {
    filter,
    limit,
    ...(cursor === undefined || cursor === null || cursor === ""
      ? {}
      : { after: decodeCursor(cursor) }),
  };
}

/**
 * The ticket of a run as the list shows it. The reference was written by the engine (`github:owner/repo#128`, `jira:…#PROJ-7`); one that
 * does not parse shows no ticket rather than a made-up one. A link exists only for GitHub, where the reference names the page.
 */
function ticketOf(
  ref: string | null,
  title: string | null,
): LaneRunListItemView["ticket"] {
  if (ref === null) return null;
  const parsed = parseTicketRef(ref);
  if (!parsed.ok) return null;
  const { provider, repo, key } = parsed.ref;
  const github = provider === "github";
  return {
    label: github ? `#${key}` : key,
    title,
    url: github ? `https://github.com/${repo}/issues/${key}` : null,
  };
}

export function listItemOf(row: WorkspaceRunRow): LaneRunListItemView {
  const { run } = row;
  return {
    id: run.id,
    workflowId: run.workflowId,
    workflowVersion: run.workflowVersion,
    laneName: row.laneName,
    status: run.status,
    errorCode: run.errorCode,
    project: { id: run.repositoryId, name: row.repositoryName },
    ticket: ticketOf(run.ticketRef, row.ticket?.title ?? null),
    nodes: laneNodesOfRun(row.document ?? undefined, {
      id: run.triggerId,
      kind: run.triggerKind,
    }),
    steps: row.steps.map((step) => ({
      id: step.stepId,
      kind: step.kind,
      status: step.status,
      round: step.round,
    })),
    budgetUsd: run.budgetMicroUsd / MICRO_USD_PER_USD,
    spentUsd: run.spentMicroUsd / MICRO_USD_PER_USD,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
  };
}
