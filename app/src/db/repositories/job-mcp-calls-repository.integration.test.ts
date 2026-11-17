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
  MAX_GATE_REFUSALS_STORED,
  MAX_MCP_CALLS_RECORDED_PER_JOB,
  McpSeqOutOfRangeError,
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
      "suppressed",
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

    expect((await repo.summary(job.id)).rows).toBe(
      MAX_MCP_CALLS_RECORDED_PER_JOB,
    );
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

    expect((await repo.summary(job.id)).rows).toBe(
      MAX_MCP_CALLS_RECORDED_PER_JOB + 1,
    );
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
    expect(await other.summary(fixture.job.id)).toEqual({
      rows: 0,
      suppressed: 0,
    });
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
  // #1055-T03: the refusal of the gate comes before the claim's call count, so a loop can make thousands of them
  it("stores only the first refusals of 'too many calls at once' and counts the rest on the newest of them, in one statement each", async () => {
    const { repo, job } = await setup();
    const gate = call({
      status: 429,
      outcome: "mcp_too_many_concurrent_calls",
      tool: null,
      rpcMethod: null,
      durationMs: 0,
    });
    for (let i = 0; i < MAX_GATE_REFUSALS_STORED; i += 1)
      expect(await repo.record(job.id, gate)).toBe("stored");
    // A real call in between does not change what is counted.
    expect(await repo.record(job.id, call())).toBe("stored");
    expect(await repo.record(job.id, gate)).toBe("counted");
    expect(await repo.record(job.id, gate)).toBe("counted");
    expect(await repo.record(job.id, gate)).toBe("counted");

    // The rows: the refusals that were stored and the real call; the three others are a number.
    expect(await repo.summary(job.id)).toEqual({
      rows: MAX_GATE_REFUSALS_STORED + 1,
      suppressed: 3,
    });
    const rows = await repo.listAfter(job.id, 0, 100);
    const withCount = rows.filter((row) => row.suppressed > 0);
    expect(withCount).toHaveLength(1);
    // On the newest refusal row (not on the real call).
    expect(withCount[0]).toMatchObject({
      outcome: "mcp_too_many_concurrent_calls",
      suppressed: 3,
    });
  });

  // #1055-T03
  it("keeps the room of the real calls: a flood of gate refusals does not eat the budget of the job", async () => {
    const { repo, job } = await setup();
    const gate = call({
      status: 429,
      outcome: "mcp_too_many_concurrent_calls",
    });
    for (let i = 0; i < MAX_GATE_REFUSALS_STORED + 500; i += 1)
      await repo.record(job.id, gate);

    expect((await repo.summary(job.id)).rows).toBe(MAX_GATE_REFUSALS_STORED);
    expect((await repo.summary(job.id)).suppressed).toBe(500);
  });

  // #1055-T04
  it("does not store or count a gate refusal for a job of another workspace", async () => {
    const fixture = await setup();
    const otherId = await addWorkspace(fixture.db, "other");
    const otherJobId = await enqueueInWorkspace(fixture, otherId);
    const gate = call({
      status: 429,
      outcome: "mcp_too_many_concurrent_calls",
    });

    expect(await fixture.repo.record(otherJobId, gate)).toBe("unknown_job");
    expect(
      await fixture.db.selectFrom("job_mcp_calls").select("seq").execute(),
    ).toEqual([]);
  });

  // #1055-T03: rows become visible when their transaction commits, not in the order of their seq
  it("reads again from some rows before the cursor, so a row that became visible late is found", async () => {
    const { repo, job, db } = await setup();
    // A transaction that took the lower seq but commits after the row with the higher one.
    const late = db.transaction().execute(async (trx) => {
      await sql`insert into job_mcp_calls (job_id, workspace_id, server_id, server_name, rpc_method, tool, status, outcome, duration_ms, request_bytes, response_bytes, created_at)
        values (${job.id}, ${job.workspaceId}, 's-1', 'Late', 'tools/call', 'late', 200, 'ok', 1, 1, 1, '2026-11-17T08:00:00.000Z')`.execute(
        trx,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await repo.record(job.id, call({ serverName: "Fast" }));
    const first = await repo.listAfter(job.id, 0, 10);
    expect(first.map((row) => row.serverName)).toEqual(["Fast"]);
    const cursor = first.at(-1)!.seq;
    await late;

    // Without the overlap the late row (lower seq) is never read; with it, it is.
    expect(await repo.listAfter(job.id, cursor, 10)).toEqual([]);
    const again = await repo.listAfter(job.id, cursor, 10, 50);
    expect(again.map((row) => row.serverName)).toEqual(["Late", "Fast"]);
    expect(again[0]!.seq).toBeLessThan(cursor);
  });

  // #1055-T03
  it("keeps the overlap to rows of the job, not to a distance in the table-wide sequence", async () => {
    const fixture = await setup();
    const { repo, job } = fixture;
    for (let i = 0; i < 5; i += 1) await repo.record(job.id, call());
    // A flood of another workspace's rows between: the sequence jumps far.
    const otherId = await addWorkspace(fixture.db, "other");
    const otherJobId = await enqueueInWorkspace(fixture, otherId);
    await sql`insert into job_mcp_calls (job_id, workspace_id, server_id, server_name, rpc_method, tool, status, outcome, duration_ms, request_bytes, response_bytes, created_at)
      select ${otherJobId}, ${otherId}, 's', 'x', null, null, 200, 'ok', 1, 1, 1, '2026-11-17T08:00:00.000Z' from generate_series(1, 500)`.execute(
      fixture.db,
    );
    await repo.record(job.id, call({ serverName: "after the flood" }));
    const all = await repo.listAfter(job.id, 0, 100);
    const cursor = all.at(-1)!.seq;

    const again = await repo.listAfter(job.id, cursor, 100, 3);
    expect(again.map((row) => row.seq)).toEqual(
      all.slice(-3).map((row) => row.seq),
    );
  });

  // #1055-T03
  it("refuses to go on instead of misordering when a seq is beyond what a number holds exactly", async () => {
    const { repo, job, db } = await setup();
    await sql`select setval(pg_get_serial_sequence('job_mcp_calls', 'seq'), 9007199254740993)`.execute(
      db,
    );
    await repo.record(job.id, call());

    await expect(repo.listAfter(job.id, 0, 10)).rejects.toBeInstanceOf(
      McpSeqOutOfRangeError,
    );
  });
});
