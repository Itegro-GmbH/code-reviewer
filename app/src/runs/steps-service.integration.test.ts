// SPDX-License-Identifier: LicenseRef-Proprietary

// The steps of a run of the Implementer for the Runs page (#745, live view), through the real handler, service and repositories on
// Postgres: the parts a running turn stored come back after a cursor in the order they began in, a part that changed comes again
// in its old place, a run that is not a run of the Implementer of the workspace is a run nobody has, and what is stored is read as
// untrusted text.
import { describe, expect, it } from "vitest";
import { createImplementerStepsRepository } from "../db/repositories/implementer-steps-repository.ts";
import { createUsageRecordsRepository } from "../db/repositories/usage-records-repository.ts";
import { sha } from "../test-support/jobs.ts";
import { createRunsFixture } from "../test-support/runs.ts";
import { sessionUser } from "../test-support/session-lookup.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import { addUser } from "../test-support/workspace-deletion-fixture.ts";
import { createRunStepsRouteHandlers } from "./http.ts";
import { createRunStepsService } from "./steps-service.ts";
import type { StepsSnapshot } from "./steps-view.ts";
import { createRunsRepository } from "../db/repositories/runs-repository.ts";

const HIDDEN_MODEL = "vendor/secret-model";

async function start() {
  const f = await createRunsFixture();
  await addUser(f.db, "user-1");
  const steps = createImplementerStepsRepository(
    f.db,
    f.workspaceId,
    f.clock.now,
  );
  const service = createRunStepsService({
    runs: f.runsRepository,
    steps,
    redact: (text) => text.replaceAll("SECRET-VALUE", "[redacted]"),
    hiddenModels: () => Promise.resolve([HIDDEN_MODEL]),
  });
  const handlers = createRunStepsRouteHandlers({
    requireUser: () => Promise.resolve(sessionUser("member")),
    service,
  });
  let counter = 0;
  /** A turn a runner holds: queued, claimed with the engine `implementer`. */
  async function turn() {
    counter += 1;
    f.clock.advance(1000);
    const enqueued = await f.queue.enqueueImplementerTurn({
      repositoryId: f.repositoryId,
      baseBranch: "main",
      baseSha: sha("a"),
      branch: `implementer/p${String(counter)}`,
      instruction: "Add a health endpoint.",
      modelChoice: { entryId: "entry-1" },
      costLimitCents: null,
      createdBy: "user-1",
      actorLogin: "octocat",
      clientRequestId: `request-${String(counter)}`,
    });
    if (enqueued.status !== "created") throw new Error("not created");
    const claim = await f.queue.claimNext("runner-1", ["implementer"]);
    if (claim === null || claim.job.id !== enqueued.job.id)
      throw new Error("the turn was not claimed");
    return { job: claim.job, lease: claim.leaseToken };
  }
  const ask = async (id: string, query = "") => {
    const response = await handlers.steps(
      new Request(`https://app.test/api/w/default/runs/${id}/steps${query}`),
      id,
    );
    return {
      status: response.status,
      body: (await response.json()) as unknown,
    };
  };
  return { f, steps, turn, ask };
}

const words = (partId: string, seq: number, text: string, kind = "text") => ({
  partId,
  seq,
  kind,
  payload: {
    text,
    bytes: text.length,
    startedAt: 1000 * seq,
    endedAt: 1000 * seq + 500,
  },
});

describe("the steps of a run of the Implementer", () => {
  // #745-T40
  it("come back in the order the parts began in, with a cursor", async () => {
    const { steps, turn, ask } = await start();
    const { job, lease } = await turn();
    await steps.recordSteps(job.id, lease, [
      words("prt_c", 3, "The answer."),
      words("prt_a", 1, "Let me look.", "reasoning"),
      {
        partId: "prt_b",
        seq: 2,
        kind: "tool",
        payload: {
          tool: "bash",
          status: "completed",
          title: "ls",
          input: '{"command":"ls"}',
        },
      },
      {
        partId: "prt_d",
        seq: 4,
        kind: "step",
        payload: {
          reason: "stop",
          tokens: {
            input: 10,
            output: 2,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
          cost: 0.01,
        },
      },
    ]);

    const { status, body } = await ask(job.id);
    const page = body as StepsSnapshot;

    expect(status).toBe(200);
    expect(page.steps.map((s) => [s.ordinal, s.partId, s.kind])).toEqual([
      [1, "prt_a", "reasoning"],
      [2, "prt_b", "tool"],
      [3, "prt_c", "text"],
      [4, "prt_d", "step"],
    ]);
    expect(page.steps[1]).toMatchObject({
      tool: "bash",
      status: "completed",
      title: "ls",
      input: '{"command":"ls"}',
    });
    expect(page.steps[3]).toMatchObject({
      tokens: { input: 10, output: 2 },
      cost: 0.01,
    });
    expect(page).toMatchObject({ cursor: 4, hasMore: false });
  });

  // #745-T41
  it("page by the cursor: a limit holds back the rest, and asking after the cursor gets it", async () => {
    const { steps, turn, ask } = await start();
    const { job, lease } = await turn();
    await steps.recordSteps(
      job.id,
      lease,
      [1, 2, 3, 4, 5].map((n) =>
        words(`prt_${String(n)}`, n, `Text ${String(n)}`),
      ),
    );

    const first = (await ask(job.id, "?after=0&limit=2")).body as StepsSnapshot;
    const second = (await ask(job.id, `?after=${String(first.cursor)}&limit=2`))
      .body as StepsSnapshot;
    const last = (await ask(job.id, `?after=${String(second.cursor)}&limit=2`))
      .body as StepsSnapshot;
    const nothing = (await ask(job.id, `?after=${String(last.cursor)}`))
      .body as StepsSnapshot;

    expect(first.steps.map((s) => s.partId)).toEqual(["prt_1", "prt_2"]);
    expect(first).toMatchObject({ cursor: 2, hasMore: true });
    expect(second.steps.map((s) => s.partId)).toEqual(["prt_3", "prt_4"]);
    expect(second).toMatchObject({ cursor: 4, hasMore: true });
    expect(last.steps.map((s) => s.partId)).toEqual(["prt_5"]);
    expect(last).toMatchObject({ cursor: 5, hasMore: false });
    expect(nothing).toEqual({ steps: [], cursor: 5, hasMore: false });
  });

  // #745-T42
  it("bring a part that changed again, in its old place, and nothing else", async () => {
    const { steps, turn, ask } = await start();
    const { job, lease } = await turn();
    await steps.recordSteps(job.id, lease, [
      {
        partId: "prt_t",
        seq: 1,
        kind: "tool",
        payload: { tool: "bash", status: "running" },
      },
      words("prt_x", 2, "While it runs."),
    ]);
    const before = (await ask(job.id)).body as StepsSnapshot;
    await steps.recordSteps(job.id, lease, [
      {
        partId: "prt_t",
        seq: 3,
        kind: "tool",
        payload: { tool: "bash", status: "completed" },
      },
    ]);

    const after = (await ask(job.id, `?after=${String(before.cursor)}`))
      .body as StepsSnapshot;

    expect(after.steps).toEqual([
      expect.objectContaining({
        partId: "prt_t",
        seq: 3,
        ordinal: 1,
        status: "completed",
      }),
    ]);
    expect(after.cursor).toBe(3);
  });

  // #745-T43
  it("answer an empty page for a run of the Implementer that has no steps", async () => {
    const { turn, ask } = await start();
    const { job } = await turn();

    expect((await ask(job.id)).body).toEqual({
      steps: [],
      cursor: 0,
      hasMore: false,
    });
    expect((await ask(job.id, "?after=7")).body).toEqual({
      steps: [],
      cursor: 7,
      hasMore: false,
    });
  });

  // #745-T44
  it("are a run nobody has for a run of another kind, an unknown id and a malformed one", async () => {
    const { f, ask } = await start();
    const review = await f.waiting();

    for (const id of [
      review.id,
      "00000000-0000-4000-8000-000000000000",
      "not-an-id",
    ]) {
      const answer = await ask(id);
      expect(answer).toEqual({ status: 404, body: { error: "RUN_NOT_FOUND" } });
    }
  });

  // #745-T45
  it("are a run nobody has for a workspace other than the run's", async () => {
    const { f, steps, turn } = await start();
    const { job, lease } = await turn();
    await steps.recordSteps(job.id, lease, [words("prt_1", 1, "Secret plan.")]);
    const other = await addWorkspace(f.db, "bravo");
    const service = createRunStepsService({
      runs: createRunsRepository(f.db, other),
      steps: createImplementerStepsRepository(f.db, other, f.clock.now),
    });

    expect(await service.list(job.id, 0, 200)).toBeUndefined();
  });

  // #745-T46
  it.each([
    "?after=-1",
    "?after=abc",
    "?after=1.5",
    "?after=99999999999",
    "?limit=0",
    "?limit=ten",
  ])("refuse the query %s", async (query) => {
    const { turn, ask } = await start();
    const { job } = await turn();

    expect(await ask(job.id, query)).toEqual({
      status: 400,
      body: { error: "STEPS_QUERY_INVALID" },
    });
  });

  // #745-T47
  it("read a limit above 200 as 200", async () => {
    const { steps, turn, ask } = await start();
    const { job, lease } = await turn();
    const records = Array.from({ length: 250 }, (_, i) =>
      words(`prt_${String(i + 1)}`, i + 1, "x"),
    );
    await steps.recordSteps(job.id, lease, records);

    const page = (await ask(job.id, "?limit=100000")).body as StepsSnapshot;

    expect(page.steps).toHaveLength(200);
    expect(page.hasMore).toBe(true);
  });

  // #745-T48
  it("show only text: fields of the wrong type are left out, a kind the page does not know is skipped, and the secrets the app knows are taken out", async () => {
    const { steps, turn, ask } = await start();
    const { job, lease } = await turn();
    await steps.recordSteps(job.id, lease, [
      {
        partId: "prt_1",
        seq: 1,
        kind: "text",
        payload: {
          text: "<img src=x onerror=alert(1)> SECRET-VALUE",
          bytes: "many",
          startedAt: -5,
          tokens: "none",
          extra: { nested: true },
        },
      },
      {
        partId: "prt_2",
        seq: 2,
        kind: "diagram",
        payload: { text: "a kind of a newer runner" },
      },
      {
        partId: "prt_3",
        seq: 3,
        kind: "tool",
        payload: { tool: 42, status: ["completed"], input: '{"a":1}' },
      },
    ]);

    const page = (await ask(job.id)).body as StepsSnapshot;

    expect(page.steps).toEqual([
      {
        partId: "prt_1",
        seq: 1,
        ordinal: 1,
        kind: "text",
        text: "<img src=x onerror=alert(1)> [redacted]",
      },
      { partId: "prt_3", seq: 3, ordinal: 3, kind: "tool", input: '{"a":1}' },
    ]);
    // The cursor moves past the part the page does not show, so it is not asked for again.
    expect(page.cursor).toBe(3);
  });
  // #745-T49
  describe("on the operator's key", () => {
    /** What the runner API would have stored on the workspace's own key: the cost, the cache counts, the names. */
    const model = [
      {
        partId: "prt_1",
        seq: 1,
        kind: "text",
        payload: {
          text: `I am ${HIDDEN_MODEL}, served by Anthropic.`,
          bytes: 40,
        },
      },
      {
        partId: "prt_2",
        seq: 2,
        kind: "tool",
        payload: {
          tool: "bash",
          status: "completed",
          title: `ask ${HIDDEN_MODEL}`,
          input: '{"model":"vendor/secret-model","by":"openrouter"}',
          error: "OpenRouter said no",
        },
      },
      {
        partId: "prt_3",
        seq: 3,
        kind: "step",
        payload: {
          reason: "stop",
          tokens: {
            input: 10,
            output: 2,
            reasoning: 1,
            cacheRead: 900,
            cacheWrite: 40,
          },
          cost: 0.5,
        },
      },
    ];

    // #745-T49
    it.each([
      ["a key mode of managed", "key mode"],
      ["a catalog entry", "entry"],
    ])(
      "shows no cost, no cache counts and no model or provider name, with %s, whatever the stored row holds",
      async (_name, how) => {
        const { f, steps, turn, ask } = await start();
        const { job, lease } = await turn();
        await steps.recordSteps(job.id, lease, model);
        const usage = createUsageRecordsRepository(
          f.db,
          f.workspaceId,
          f.clock.now,
        );
        if (how === "key mode") await usage.setKeyMode(job.id, "managed");
        else
          await usage.setSelection(job.id, {
            provider: "openrouter",
            catalogEntry: { id: "entry-1", name: "Fast" },
          });

        const page = (await ask(job.id)).body as StepsSnapshot;

        const shown = JSON.stringify(page);
        expect(shown).not.toContain(HIDDEN_MODEL);
        expect(shown.toLowerCase()).not.toContain("anthropic");
        expect(shown.toLowerCase()).not.toContain("openrouter");
        expect(page.steps[0]?.text).toBe("I am [model], served by [provider].");
        const last = page.steps[2];
        expect(last).not.toHaveProperty("cost");
        expect(last?.tokens).toEqual({
          input: 10,
          output: 2,
          reasoning: 1,
          cacheRead: 0,
          cacheWrite: 0,
        });
      },
    );

    // #745-T49
    it("keeps cost, cache counts and names for a run on the workspace's own key", async () => {
      const { f, steps, turn, ask } = await start();
      const { job, lease } = await turn();
      await steps.recordSteps(job.id, lease, model);
      await createUsageRecordsRepository(
        f.db,
        f.workspaceId,
        f.clock.now,
      ).setKeyMode(job.id, "own");

      const page = (await ask(job.id)).body as StepsSnapshot;

      expect(page.steps[0]?.text).toContain(HIDDEN_MODEL);
      expect(page.steps[2]).toMatchObject({
        cost: 0.5,
        tokens: { cacheRead: 900, cacheWrite: 40 },
      });
    });
  });
});
