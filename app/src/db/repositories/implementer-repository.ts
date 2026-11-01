// SPDX-License-Identifier: LicenseRef-Proprietary

// Access to the Implementer's sessions and turns of ONE workspace (the tables `implementer_sessions` and `implementer_turns`;
// the factory takes the workspace id, see ../workspace-scope.ts). A session is a branch the agent works on, a turn one
// instruction given on it; the status of a turn is the status of its job, so nothing here keeps one. The jobs row of a turn
// is made by the queue (#752) through the callback of `createSessionWithTurn`, in the same transaction: the slot of the
// session is needed for the job's placeholder pull request number (`-slot`), and the turn needs the job.
// A row of another workspace is simply not there. src/db/README.md, "Implementer sessions and turns".
import "server-only";
import type { Kysely, Selectable } from "kysely";
import { sql } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import { ImplementerStoreError } from "../implementer-errors.ts";
import {
  decodeModelChoice,
  encodeModelChoice,
  type ModelChoice,
} from "../implementer-model-choice.ts";
import type {
  Database,
  ImplementerSessionsTable,
  ImplementerTurnsTable,
} from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";

/** A session as the rest of the app sees it. Timestamps are ISO 8601 text in UTC. */
export type StoredImplementerSession = {
  id: string;
  workspaceId: string;
  repositoryId: string;
  /** The number of the session in its repository, from 1; its jobs hold `-slot` as the pull request number. */
  slot: number;
  baseBranch: string;
  branch: string;
  /** The last commit pushed to the branch; null until a turn has pushed one. */
  headCommit: string | null;
  /** `running` from the start of the first turn until a turn has ended. */
  status: "running" | "idle";
  opencodeSessionId: string | null;
  opencodeVersion: string | null;
  summary: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type StoredImplementerTurn = {
  id: string;
  sessionId: string;
  workspaceId: string;
  /** 1 for the first instruction of the session. */
  number: number;
  instruction: string;
  modelChoice: ModelChoice;
  /** The customer's cost limit for the turn in cents; null when none was asked for. */
  costLimitCents: number | null;
  /** The job that runs the turn; its status is the turn's. */
  jobId: string;
  createdBy: string;
  createdAt: string;
};

/** What is known when a task is accepted. */
export type NewImplementerTask = {
  repositoryId: string;
  baseBranch: string;
  /** The new branch; one session per branch and repository. */
  branch: string;
  instruction: string;
  modelChoice: ModelChoice;
  costLimitCents: number | null;
  createdBy: string;
};

/**
 * Makes the job of the first turn and returns its id. It runs inside the transaction (`trx`, to be used for everything it
 * writes), after the slot is fixed and before the turn is written; the job must be one of this workspace.
 */
export type CreateTurnJob = (
  trx: Kysely<Database>,
  context: { slot: number; sessionId: string },
) => Promise<string>;

/** What a turn produced. `null` leaves the stored value as it is (a turn that pushed nothing keeps the earlier head). */
export type TurnResult = {
  headCommit: string | null;
  opencode: { sessionId: string; version: string } | null;
  summary: string | null;
};

export type ImplementerRepository = {
  /**
   * Starts a session with its first turn in one transaction: locks the repository row (as the enqueue of a review does, so
   * two tasks for one repository take turns), takes the next slot, writes the session, calls `createJob`, writes the turn.
   * Rejects with `IMPLEMENTER_REPOSITORY_NOT_FOUND` (not this workspace's repository), `IMPLEMENTER_BRANCH_TAKEN` (the
   * repository has a session on this branch already; the callback is not called), `IMPLEMENTER_JOB_NOT_FOUND` (the callback
   * returned a job of another workspace) or `IMPLEMENTER_JOB_MISMATCH` (a job of another repository, or with a pull request
   * number other than `-slot`); nothing is written then. The caller takes the instance gate lock first, as the
   * enqueue of a review does, when it needs one.
   */
  createSessionWithTurn(
    task: NewImplementerTask,
    createJob: CreateTurnJob,
  ): Promise<{
    session: StoredImplementerSession;
    turn: StoredImplementerTurn;
  }>;
  getSession(sessionId: string): Promise<StoredImplementerSession | undefined>;
  /** The turn that a job runs, with its session; undefined for a job that is not a turn of this workspace. */
  getTurnByJob(
    jobId: string,
  ): Promise<
    | { turn: StoredImplementerTurn; session: StoredImplementerSession }
    | undefined
  >;
  /**
   * Records what a turn produced and sets the session `idle`. Returns the session, or undefined when it is not this
   * workspace's. A `null` field leaves the stored value as it is. The status of a turn is its job's, but the status of the
   * session is only this call: whoever sees the job of a turn end WITHOUT a result report (failed, cancelled, timed out) must
   * call it with null fields, otherwise the session stays `running` for good.
   */
  recordTurnResult(
    sessionId: string,
    result: TurnResult,
  ): Promise<StoredImplementerSession | undefined>;
  /** The sessions of a repository, newest first (highest slot first), each with its turns by number. */
  listForRepository(
    repositoryId: string,
  ): Promise<
    Array<{ session: StoredImplementerSession; turns: StoredImplementerTurn[] }>
  >;
};

function sessionFrom(
  row: Selectable<ImplementerSessionsTable>,
): StoredImplementerSession {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    repositoryId: row.repository_id,
    slot: row.slot,
    baseBranch: row.base_branch,
    branch: row.branch,
    headCommit: row.head_commit,
    status: row.status,
    opencodeSessionId: row.opencode_session_id,
    opencodeVersion: row.opencode_version,
    summary: row.summary,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function turnFrom(
  row: Selectable<ImplementerTurnsTable>,
): StoredImplementerTurn {
  return {
    id: row.id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    number: row.number,
    instruction: row.instruction,
    modelChoice: decodeModelChoice(row.model_choice),
    costLimitCents: row.cost_limit_cents,
    jobId: row.job_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export function createImplementerRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  now: () => Date = () => new Date(),
  newId: () => string = () => crypto.randomUUID(),
): ImplementerRepository {
  // A transaction cannot start another one; inside one, just use it.
  function inTransaction<T>(
    run: (executor: Kysely<Database>) => Promise<T>,
  ): Promise<T> {
    return db.isTransaction ? run(db) : db.transaction().execute(run);
  }

  async function sessionById(
    executor: Kysely<Database>,
    sessionId: string,
  ): Promise<StoredImplementerSession | undefined> {
    const row = await executor
      .selectFrom("implementer_sessions")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", sessionId)
      .executeTakeFirst();
    return row === undefined ? undefined : sessionFrom(row);
  }

  return {
    createSessionWithTurn(task, createJob) {
      return inTransaction(async (trx) => {
        const timestamp = formatTimestamp(now());

        // The same row the enqueue of a review locks: tasks for one repository take turns, so the slot is the next one.
        const repository = await trx
          .selectFrom("repositories")
          .select("id")
          .where("workspace_id", "=", workspaceId)
          .where("id", "=", task.repositoryId)
          .forUpdate()
          .executeTakeFirst();
        if (repository === undefined)
          throw new ImplementerStoreError(
            "IMPLEMENTER_REPOSITORY_NOT_FOUND",
            "The repository is not one of this workspace.",
          );

        const { max } = await trx
          .selectFrom("implementer_sessions")
          .select((eb) => eb.fn.max("slot").as("max"))
          .where("workspace_id", "=", workspaceId)
          .where("repository_id", "=", task.repositoryId)
          .executeTakeFirstOrThrow();
        const slot = (max ?? 0) + 1;

        // `do nothing` instead of a raised violation: the branch being taken is an answer, and it must not abort the
        // transaction of a caller that handed one in.
        const inserted = await trx
          .insertInto("implementer_sessions")
          .values({
            id: newId(),
            workspace_id: workspaceId,
            repository_id: task.repositoryId,
            slot,
            base_branch: task.baseBranch,
            branch: task.branch,
            status: "running",
            created_by: task.createdBy,
            created_at: timestamp,
            updated_at: timestamp,
          })
          .onConflict((conflict) =>
            conflict.columns(["repository_id", "branch"]).doNothing(),
          )
          .returningAll()
          .executeTakeFirst();
        if (inserted === undefined)
          throw new ImplementerStoreError(
            "IMPLEMENTER_BRANCH_TAKEN",
            "The repository has a session on this branch already.",
          );

        const jobId = await createJob(trx, { slot, sessionId: inserted.id });
        const job = await trx
          .selectFrom("jobs")
          .select(["repository_id", "pr_number"])
          .where("workspace_id", "=", workspaceId)
          .where("id", "=", jobId)
          .executeTakeFirst();
        if (job === undefined)
          throw new ImplementerStoreError(
            "IMPLEMENTER_JOB_NOT_FOUND",
            "The job of the turn is not a job of this workspace.",
          );
        // The one running job per pull request index only means one running turn per session when the job carries `-slot`.
        if (job.repository_id !== task.repositoryId || job.pr_number !== -slot)
          throw new ImplementerStoreError(
            "IMPLEMENTER_JOB_MISMATCH",
            "The job of the turn is of another repository or does not carry the negative slot as its pull request number.",
          );

        const turn = await trx
          .insertInto("implementer_turns")
          .values({
            id: newId(),
            session_id: inserted.id,
            workspace_id: workspaceId,
            number: 1,
            instruction: task.instruction,
            model_choice: encodeModelChoice(task.modelChoice),
            cost_limit_cents: task.costLimitCents,
            job_id: jobId,
            created_by: task.createdBy,
            created_at: timestamp,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        return { session: sessionFrom(inserted), turn: turnFrom(turn) };
      });
    },

    getSession(sessionId) {
      return sessionById(db, sessionId);
    },

    async getTurnByJob(jobId) {
      const row = await db
        .selectFrom("implementer_turns")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("job_id", "=", jobId)
        .executeTakeFirst();
      if (row === undefined) return undefined;
      const session = await sessionById(db, row.session_id);
      if (session === undefined) return undefined;
      return { turn: turnFrom(row), session };
    },

    async recordTurnResult(sessionId, result) {
      const row = await db
        .updateTable("implementer_sessions")
        .set({
          status: "idle",
          head_commit: sql<
            string | null
          >`coalesce(${result.headCommit}, head_commit)`,
          opencode_session_id: sql<
            string | null
          >`coalesce(${result.opencode?.sessionId ?? null}, opencode_session_id)`,
          opencode_version: sql<
            string | null
          >`coalesce(${result.opencode?.version ?? null}, opencode_version)`,
          summary: sql<string | null>`coalesce(${result.summary}, summary)`,
          updated_at: formatTimestamp(now()),
        })
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", sessionId)
        .returningAll()
        .executeTakeFirst();
      return row === undefined ? undefined : sessionFrom(row);
    },

    async listForRepository(repositoryId) {
      const sessions = await db
        .selectFrom("implementer_sessions")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("repository_id", "=", repositoryId)
        .orderBy("slot", "desc")
        .execute();
      if (sessions.length === 0) return [];
      const turns = await db
        .selectFrom("implementer_turns")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where(
          "session_id",
          "in",
          sessions.map((session) => session.id),
        )
        .orderBy("number")
        .execute();
      return sessions.map((session) => ({
        session: sessionFrom(session),
        turns: turns
          .filter((turn) => turn.session_id === session.id)
          .map(turnFrom),
      }));
    },
  };
}
