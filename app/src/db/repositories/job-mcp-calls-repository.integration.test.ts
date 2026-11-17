// SPDX-License-Identifier: LicenseRef-Proprietary

// The record of the MCP calls of a job (#1055) against a real Postgres: a call is stored with what `McpCallMeta` holds and nothing else, the
// calls come back in the order they were written in after a cursor, a job keeps at most 2000 of them (the rest is not stored), a call of a job of
// another workspace is not stored and not read, and a server that was removed does not take its calls with it.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createJobQueueFixture } from "../../test-support/jobs.ts";
import { addWorkspace } from "../../test-support/workspaces.ts";
import { enqueueInWorkspace } from "../../test-support/other-workspace-jobs.ts";
import {
  createJobMcpCallsRepository,
  MAX_MCP_CALLS_RECORDED_PER_JOB,
  type McpCallRecord,
} from "./job-mcp-calls-repository.ts";

const call = (over: Partial<McpCallRecord> = {}): McpCallRecord => ({
  serverId: "s-1",
  serverName: "Linear",
  rpcMethod: "tools/call",
  tool: "list_issues",
  status: 200,
  outcome: "ok",
  durationMs: 120,
  requestBytes: 90,
  responseBytes: 4000,
  ...over,
});

async function setup() {
  const fixture = await createJobQueueFixture();
  const job = await fixture.enqueueNew();
  const repo = createJobMcpCallsRepository(
    fixture.db,
    fixture.workspaceId,
    fixture.clock.now,
  );
  return { ...fixture, job, repo };
}

describe("the MCP calls repository", () => {
  // #1055-T01
  it("stores a call with the fields of the call's metadata and reads it back after a cursor, oldest first", async () => {
    const { repo, job, clock } = await setup();

    expect(await repo.record(job.id, call())).toBe("stored");
    clock.advance(5);
    expect(
      await repo.record(
        job.id,
        call({
          serverName: "Sentry",
          tool: null,
          rpcMethod: "tools/list",
          outcome: "mcp_proxy_timeout",
          status: 503,
        }),
      ),
    ).toBe("stored");

    const all = await repo.listAfter(job.id, 0, 10);
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({
      serverId: "s-1",
      serverName: "Linear",
      rpcMethod: "tools/call",
      tool: "list_issues",
      status: 200,
      outcome: "ok",
      durationMs: 120,
      requestBytes: 90,
      responseBytes: 4000,
    });
    expect(all[1]).toMatchObject({
      serverName: "Sentry",
      tool: null,
      outcome: "mcp_proxy_timeout",
    });
    expect(all[0]!.seq).toBeLessThan(all[1]!.seq);
    expect(await repo.listAfter(job.id, all[0]!.seq, 10)).toEqual([all[1]]);
    expect(await repo.listAfter(job.id, all[1]!.seq, 10)).toEqual([]);
    expect(await repo.listAfter(job.id, 0, 1)).toEqual([all[0]]);
  });

  // #1055-T02
  it("has no column that could hold an argument, an answer, a header or an address", async () => {
    const { db } = await setup();

    const { rows } = await sql<{
      column_name: string;
    }>`select column_name from information_schema.columns where table_name = 'job_mcp_calls' order by column_name`.execute(
      db,
    );

    expect(rows.map((row) => row.column_name)).toEqual([
      "created_at",
      "duration_ms",
      "job_id",
      "outcome",
      "request_bytes",
      "response_bytes",
      "rpc_method",
      "seq",
      "server_id",
      "server_name",
      "status",
      "tool",
      "workspace_id",
    ]);
  });

  // #1055-T03
  it("keeps at most 2000 calls for a job: the rest is not stored and the answer says so", async () => {
    const { repo, job, db } = await setup();
    // 1999 rows in one statement, then the last one that fits, then one too many.
    await sql`insert into job_mcp_calls (job_id, workspace_id, server_id, server_name, rpc_method, tool, status, outcome, duration_ms, request_bytes, response_bytes, created_at)
      select ${job.id}, ${job.workspaceId}, 's-1', 'Linear', 'tools/call', 'x', 200, 'ok', 1, 1, 1, '2026-11-17T08:00:00.000Z'
      from generate_series(1, ${MAX_MCP_CALLS_RECORDED_PER_JOB - 1})`.execute(
      db,
    );

    expect(await repo.record(job.id, call())).toBe("stored");
    expect(await repo.record(job.id, call())).toBe("capped");

    expect(await repo.count(job.id)).toBe(MAX_MCP_CALLS_RECORDED_PER_JOB);
  });

  // #1055-T03
  it("keeps one row more for the refusal that says the call limit was reached, and only one", async () => {
    const { repo, job, db } = await setup();
    await sql`insert into job_mcp_calls (job_id, workspace_id, server_id, server_name, rpc_method, tool, status, outcome, duration_ms, request_bytes, response_bytes, created_at)
      select ${job.id}, ${job.workspaceId}, 's-1', 'Linear', 'tools/call', 'x', 200, 'ok', 1, 1, 1, '2026-11-17T08:00:00.000Z'
      from generate_series(1, ${MAX_MCP_CALLS_RECORDED_PER_JOB})`.execute(db);
    const limit = call({
      status: 429,
      outcome: "mcp_call_limit_reached",
      durationMs: 0,
    });

    expect(await repo.record(job.id, call())).toBe("capped");
    expect(await repo.record(job.id, limit)).toBe("stored");
    expect(await repo.record(job.id, limit)).toBe("capped");

    expect(await repo.count(job.id)).toBe(MAX_MCP_CALLS_RECORDED_PER_JOB + 1);
  });

  // #1055-T04
  it("does not store or read a call across workspaces", async () => {
    const fixture = await setup();
    const otherId = await addWorkspace(fixture.db, "other");
    const otherJobId = await enqueueInWorkspace(fixture, otherId);
    const other = createJobMcpCallsRepository(
      fixture.db,
      otherId,
      fixture.clock.now,
    );

    // The job is another workspace's: not stored, whichever way it is asked.
    expect(await fixture.repo.record(otherJobId, call())).toBe("unknown_job");
    await fixture.repo.record(fixture.job.id, call());

    expect(await other.listAfter(fixture.job.id, 0, 10)).toEqual([]);
    expect(await other.count(fixture.job.id)).toBe(0);
    expect(await fixture.repo.listAfter(otherJobId, 0, 10)).toEqual([]);
    expect(
      await fixture.db.selectFrom("job_mcp_calls").select("job_id").execute(),
    ).toEqual([{ job_id: fixture.job.id }]);
  });

  // #1055-T05
  it("keeps the calls of a server that was removed afterwards (the server is not a foreign key)", async () => {
    const { repo, job } = await setup();

    await repo.record(job.id, call({ serverId: "removed-server" }));

    expect(await repo.listAfter(job.id, 0, 10)).toMatchObject([
      { serverId: "removed-server", serverName: "Linear" },
    ]);
  });
});
