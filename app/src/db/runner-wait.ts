// SPDX-License-Identifier: LicenseRef-Proprietary

// Why a queued turn of a lane step waits for its runner, for the run page (#1105, ADR 0007, decision 13). A hosted runner waits for a free
// place (n of m in use); a self-hosted one is busy (a person may cancel; nothing else ends the wait), offline, or online but unable to
// take the turn (its version or its manifest), and the last two end in `no_runner_available` after the deadline. Read-only; scoped to one workspace.
import "server-only";
import { sql, type Kysely } from "kysely";
import type { Database } from "./schema.ts";
import type { WorkspaceId } from "./workspace-scope.ts";
import {
  accessRule,
  announcesHarness,
  customerAccess,
  entriesParam,
} from "../runner-identity/access.ts";
import {
  manifestFromText,
  limitsFromText,
} from "../runner-identity/announcement.ts";
import {
  minimumBaseVersion,
  runnerConcurrency,
} from "../runner-identity/config.ts";
import { OPENCODE_HARNESS } from "../runner-identity/harness.ts";
import { customerRunnerId } from "../runner-identity/tokens.ts";
import { meetsMinimum } from "../runner-identity/versions.ts";
import { configuredNoRunnerAvailableMs } from "./job-limits.ts";
import { formatTimestamp } from "./codecs.ts";
import type { RunnerWaitSource } from "../runs/run-view.ts";

type Env = Record<string, string | undefined>;

/** The wait of a queued hosted turn that copied the hosted runner `environmentId`; null when that runner has a free place (or is none). */
export async function hostedWaitOf(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  environmentId: string,
): Promise<RunnerWaitSource | null> {
  const { rows } = await sql<{
    name: string;
    concurrency: number;
    running: string | number;
  }>`select h.name as name, h.concurrency as concurrency,
      (select count(*) from jobs as r
         join implementer_turns as held on held.job_id = r.id
        where r.status = 'running' and held.environment_id = h.id
          and held.workspace_id = h.workspace_id and held.environment_kind is null) as running
    from implementer_environments as h
    where h.id = ${environmentId} and h.workspace_id = ${workspaceId} and h.concurrency is not null`.execute(
    db,
  );
  const row = rows[0];
  if (row === undefined) return null;
  const running = Number(row.running);
  return running >= row.concurrency
    ? {
        kind: "hosted",
        name: row.name,
        running,
        limit: row.concurrency,
      }
    : null;
}

/**
 * The wait of a queued turn of a step that named the self-hosted runner `runnerId`, for the job `jobId`. "ready" means nothing explains the wait
 * but the runner's own polling (it is online, can take the turn and has a free place).
 */
export async function selfHostedWaitOf(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  runnerId: string,
  jobId: string,
  now: Date,
  env: Env = process.env,
): Promise<RunnerWaitSource | null> {
  const runner = await db
    .selectFrom("runners")
    .select([
      "name",
      "revoked_at",
      "last_seen_at",
      "base_version",
      "manifest",
      "limits",
    ])
    .where("workspace_id", "=", workspaceId)
    .where("id", "=", runnerId)
    .executeTakeFirst();
  if (runner === undefined) return null;
  const deadlineMs = configuredNoRunnerAvailableMs(env);
  const deadlineMinutes = Math.round(deadlineMs / 60_000);
  const seenAfter = formatTimestamp(new Date(now.getTime() - deadlineMs));
  const base = {
    kind: "self_hosted",
    name: runner.name,
    deadlineMinutes,
  } as const;
  if (runner.revoked_at !== null || runner.last_seen_at <= seenAfter)
    return { ...base, state: "offline", running: 0, limit: 0 };
  const minimum = minimumBaseVersion(env);
  const harnesses = manifestFromText(runner.manifest).harnesses;
  let serves =
    (minimum === null || meetsMinimum(runner.base_version, minimum)) &&
    announcesHarness(harnesses, OPENCODE_HARNESS);
  if (serves) {
    const { rows } = await sql<{ ok: boolean }>`select ${accessRule(
      entriesParam(customerAccess(harnesses)),
      "demanded",
    )} as ok from implementer_turns as demanded where demanded.job_id = ${jobId}`.execute(
      db,
    );
    serves = rows[0]?.ok === true;
  }
  if (!serves) return { ...base, state: "cannot_serve", running: 0, limit: 0 };
  const limit = runnerConcurrency(limitsFromText(runner.limits), env);
  const { rows } = await sql<{
    running: string | number;
  }>`select count(*) as running from jobs
    where status = 'running' and runner_id = ${customerRunnerId(runnerId)} and workspace_id = ${workspaceId}`.execute(
    db,
  );
  const running = Number(rows[0]?.running ?? 0);
  return {
    ...base,
    state: running >= limit ? "busy" : "ready",
    running,
    limit,
  };
}
