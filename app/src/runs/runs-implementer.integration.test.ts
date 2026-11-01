// SPDX-License-Identifier: LicenseRef-Proprietary

// The Runs pages show runs of the Implementer (#758, part of #745) next to the others: a turn is made through the queue (session,
// turn and job), claimed by a runner with the engine `implementer`, completed with its result block, and read back through the
// real service and routes. The list stays ordered and filtered as before, and the runs of the other kinds are untouched.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { sha } from "../test-support/jobs.ts";
import { sessionUser } from "../test-support/session-lookup.ts";
import { createRunsFixture } from "../test-support/runs.ts";
import { addUser } from "../test-support/workspace-deletion-fixture.ts";
import { createRunsRouteHandlers } from "./http.ts";

const HEAD = sha("b");

async function start() {
  const f = await createRunsFixture();
  await addUser(f.db, "user-1");
  // The repositories of the fixture live on a test host; the links of a run are made only for github.com.
  await sql`update repositories set url = 'https://github.com/' || full_name`.execute(
    f.db,
  );
  let counter = 0;
  /** A task, started and claimed; completed with `outcome` when one is given. */
  async function task(
    outcome?: Parameters<typeof f.queue.complete>[2],
    overrides: { repositoryId?: string; instruction?: string } = {},
  ) {
    counter += 1;
    f.clock.advance(1000);
    const enqueued = await f.queue.enqueueImplementerTurn({
      repositoryId: overrides.repositoryId ?? f.repositoryId,
      baseBranch: "main",
      baseSha: sha("a"),
      branch: `implementer/b${String(counter)}`,
      instruction: overrides.instruction ?? "Add a health endpoint.",
      modelChoice: { entryId: "entry-1" },
      costLimitCents: null,
      createdBy: "user-1",
      actorLogin: "octocat",
      clientRequestId: `request-${String(counter)}`,
    });
    if (enqueued.status !== "created") throw new Error("not created");
    if (outcome === undefined) return enqueued.job;
    const claim = await f.queue.claimNext("runner-1", ["implementer"]);
    if (claim === null || claim.job.id !== enqueued.job.id)
      throw new Error("the task was not claimed");
    f.clock.advance(50_000);
    const done = await f.queue.complete(
      claim.job.id,
      claim.leaseToken,
      outcome,
    );
    if (done.status !== "completed") throw new Error(done.status);
    return done.job;
  }
  return { f, task, branchOf: (n: number) => `implementer/b${String(n)}` };
}

const block = {
  baseCommit: sha("a"),
  headCommit: HEAD,
  pushed: true,
  commits: [{ sha: HEAD, subject: "Add a health endpoint" }],
  filesChanged: [{ path: "src/health.ts", status: "added" }],
  summary: "Added a health endpoint.",
  opencode: { sessionId: "ses_1", version: "1.19.0" },
};

describe("implementer runs in the Runs pages", () => {
  // #758-T07
  it("lists a task with its repository and branch, without a pull request", async () => {
    const { f, task } = await start();
    const job = await task();

    const { runs } = await f.runs.list({});

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: job.id,
      project: "acme/gadgets",
      reviewKind: "implementer",
      status: "queued",
      prUrl: null,
      implementer: {
        branch: "implementer/b1",
        branchUrl: "https://github.com/acme/gadgets/tree/implementer/b1",
      },
    });
  });

  // #758-T07
  it("returns the instruction, the base branch, the commits and the summary of a finished task", async () => {
    const { f, task } = await start();
    const job = await task(
      {
        ok: true,
        result: {
          ok: true,
          commentUrl: null,
          logTail: "",
          implementer: block,
          usage: {
            model: "vendor/coder",
            totalTokens: 10,
            aiCalls: 2,
            costUsd: 0.2,
          },
        },
      },
      { instruction: "Add a health endpoint." },
    );

    const snapshot = await f.runs.get(job.id);

    expect(snapshot?.run).toMatchObject({
      status: "succeeded",
      reviewKind: "implementer",
      commentMissing: false,
      usage: { model: "vendor/coder" },
      implementer: {
        branch: "implementer/b1",
        baseBranch: "main",
        instruction: { preview: "Add a health endpoint.", full: null },
        summary: "Added a health endpoint.",
        commits: {
          shown: [
            {
              shortSha: HEAD.slice(0, 7),
              subject: "Add a health endpoint",
              url: `https://github.com/acme/gadgets/commit/${HEAD}`,
            },
          ],
          more: 0,
        },
        files: { count: 1, more: 0 },
        head: { shortSha: HEAD.slice(0, 7) },
      },
    });
  });

  // #758-T03, #758-T07
  it("says a failed task pushed its commits and words its failure for a task, through the routes the page polls", async () => {
    const { f, task } = await start();
    const job = await task({
      ok: false,
      errorCode: "cost_limit_reached",
      result: { ok: false, commentUrl: null, logTail: "", implementer: block },
    });
    const route = createRunsRouteHandlers({
      requireUser: () => Promise.resolve(sessionUser("member")),
      service: f.runs,
    });

    const list = await route.list(
      new Request("https://app.test/api/w/default/runs"),
    );
    const detail = await route.detail(
      new Request(`https://app.test/api/w/default/runs/${job.id}`),
      job.id,
    );
    const body = (await detail.json()) as {
      run: { problem: string; implementer: { pushedNote: string } };
    };

    expect(list.status).toBe(200);
    expect(await list.text()).toContain(
      '"implementer":{"branch":"implementer/b1"',
    );
    expect(detail.status).toBe(200);
    expect(body.run.implementer.pushedNote).toBe(
      "1 commit was pushed to implementer/b1.",
    );
    expect(body.run.problem).toMatch(/task stopped at its cost limit/);
    expect(body.run.problem).not.toMatch(/posted no review/);
  });

  // #758-T08
  it("keeps the order and the project filter for a mix of Diff, Dynamic and implementer runs", async () => {
    const { f, task } = await start();
    const diff = await f.finished({ ok: true, result: { ok: true } });
    const here = await task();
    const other = await task(undefined, { repositoryId: f.otherRepositoryId });
    const dynamic = await f.waiting({ repositoryId: f.otherRepositoryId });

    const all = await f.runs.list({});
    const byProject = await f.runs.list({ repositoryId: f.repositoryId });
    const byOther = await f.runs.list({ repositoryId: f.otherRepositoryId });

    expect(all.runs.map((run) => run.id)).toEqual([
      dynamic.id,
      other.id,
      here.id,
      diff.id,
    ]);
    expect(byProject.runs.map((run) => run.id)).toEqual([here.id, diff.id]);
    expect(byOther.runs.map((run) => run.id)).toEqual([dynamic.id, other.id]);
    // A run of another kind has no implementer key at all.
    expect(all.runs.map((run) => "implementer" in run)).toEqual([
      false,
      true,
      true,
      false,
    ]);
  });

  // #758-T09
  it("leaves the JSON of a Diff run what it was", async () => {
    const { f } = await start();
    const diff = await f.finished({ ok: true, result: { ok: true } });

    const [row] = (await f.runs.list({})).runs;
    const detail = (await f.runs.get(diff.id))?.run;

    expect(Object.keys(row ?? {})).not.toContain("implementer");
    expect(Object.keys(detail ?? {})).not.toContain("implementer");
  });
});
