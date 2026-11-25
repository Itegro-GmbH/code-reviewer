// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it, vi } from "vitest";
import { WorkflowRunError } from "../../../workflow-runs/errors.ts";
import { createWaitForRun } from "./wait-for-run.ts";
import {
  runLookup,
  runMcpCallsService,
  runStepsService,
  workflowRunsService,
} from "./services.ts";
import {
  LANE_ID,
  RUN_ID,
  contextWith,
  data,
  failure,
  run,
  step,
  waitingStep,
} from "./test-support.ts";
import { createToolRegistry } from "../registry.ts";

type Fakes = {
  service?: Record<string, unknown>;
  lookup?: (runId: string) => Promise<string | undefined>;
  steps?: Record<string, unknown>;
  calls?: Record<string, unknown>;
};

function setup(
  fakes: Fakes = {},
  overrides: Parameters<typeof contextWith>[1] = {},
) {
  return contextWith(
    [
      [workflowRunsService as never, fakes.service ?? {}],
      [runLookup as never, { laneOf: fakes.lookup ?? (async () => LANE_ID) }],
      [runStepsService as never, fakes.steps ?? {}],
      [runMcpCallsService as never, fakes.calls ?? {}],
    ],
    overrides,
  );
}

const refuse = (
  code: ConstructorParameters<typeof WorkflowRunError>[0],
  extra = {},
) => new WorkflowRunError(code, `service says ${code}`, extra);

describe("start_run", () => {
  // #1146-T1
  it("starts the run of the lane through the run service and answers it with its address", async () => {
    const start = vi.fn(async () => ({ run: run(), created: true }));
    const answer = await data("start_run", setup({ service: { start } }), {
      laneId: LANE_ID,
      input: { ticket: "#12" },
      clientRequestId: "mine-1",
    });
    expect(start).toHaveBeenCalledWith(
      { id: "user-ada", githubLogin: "Ada via Claude Code" },
      LANE_ID,
      { input: { ticket: "#12" }, clientRequestId: "mine-1" },
    );
    expect(answer).toMatchObject({
      created: true,
      url: `https://factory.example.test/w/acme/workflows/${LANE_ID}/runs/${RUN_ID}`,
      finished: false,
      waitingFor: [],
      run: { id: RUN_ID, status: "running" },
    });
  });

  // #1146-T2
  it("names the trigger when given, makes a request id when none is given, and starts with an empty input", async () => {
    const start = vi.fn(async () => ({ run: run(), created: true }));
    await data("start_run", setup({ service: { start } }), {
      laneId: LANE_ID,
      trigger: "manual-2",
    });
    const body = (start.mock.calls[0] as unknown[])[2] as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({ trigger: "manual-2", input: {} });
    expect(body.clientRequestId).toMatch(/^[\x21-\x7e]{1,200}$/);
  });

  // #1146-T3
  it("answers a request id used before with the run it made (created: false)", async () => {
    const start = vi.fn(async () => ({ run: run(), created: false }));
    expect(
      await data("start_run", setup({ service: { start } }), {
        laneId: LANE_ID,
        clientRequestId: "mine-1",
      }),
    ).toMatchObject({ created: false });
  });

  // #1146-T4
  it("maps an input the lane does not take to invalid_input with every problem", async () => {
    const errors = [{ path: "ticket", code: "required", message: "missing" }];
    const fail = await failure(
      "start_run",
      setup({
        service: {
          start: async () => {
            throw refuse("WORKFLOW_RUN_INPUT_INVALID", { errors });
          },
        },
      }),
      { laneId: LANE_ID },
    );
    expect(fail).toMatchObject({
      error: "invalid_input",
      code: "WORKFLOW_RUN_INPUT_INVALID",
      errors,
    });
  });

  // #1146-T5
  it.each([
    ["WORKFLOW_RUN_WORKFLOW_NOT_FOUND", "not_found"],
    ["WORKFLOW_RUN_TRIGGER_UNKNOWN", "not_found"],
    ["WORKFLOW_RUN_WORKFLOW_ARCHIVED", "conflict"],
    ["WORKFLOW_RUN_REQUEST_REUSED", "conflict"],
    ["WORKFLOW_RUN_PROJECT_INACTIVE", "conflict"],
    ["WORKFLOW_RUN_TRIGGER_NOT_MANUAL", "invalid_input"],
    ["WORKFLOW_RUN_TICKET_OUTSIDE_PROJECT", "invalid_input"],
    ["WORKFLOW_RUN_GITHUB_UNAVAILABLE", "unavailable"],
  ] as const)("maps %s to %s", async (serviceCode, code) => {
    const fail = await failure(
      "start_run",
      setup({
        service: {
          start: async () => {
            throw refuse(
              serviceCode,
              serviceCode === "WORKFLOW_RUN_REQUEST_REUSED"
                ? { runId: RUN_ID }
                : {},
            );
          },
        },
      }),
      { laneId: LANE_ID },
    );
    expect(fail).toMatchObject({ error: code, code: serviceCode });
  });

  // #1146-T6
  it("needs the control scope, and takes no workspace or unknown field", async () => {
    const start = vi.fn();
    expect(
      await failure(
        "start_run",
        setup({ service: { start } }, { scopes: ["factory:read"] }),
        {
          laneId: LANE_ID,
        },
      ),
    ).toMatchObject({ error: "insufficient_scope" });
    expect(
      await failure("start_run", setup({ service: { start } }), {
        laneId: LANE_ID,
        workspace: "other",
      }),
    ).toMatchObject({ error: "invalid_input" });
    expect(
      await failure("start_run", setup({ service: { start } }), {}),
    ).toMatchObject({ error: "invalid_input" });
    expect(start).not.toHaveBeenCalled();
  });

  // #1146-T7
  it("does not let an error that is no refusal of the service reach the client", async () => {
    const fail = await failure(
      "start_run",
      setup({
        service: {
          start: async () => {
            throw new Error("connection string postgres://secret");
          },
        },
      }),
      { laneId: LANE_ID },
    );
    expect(fail.error).toBe("internal_error");
    expect(JSON.stringify(fail)).not.toContain("secret");
  });
});

describe("get_run", () => {
  // #1146-T10
  it("answers the run with its steps, address and no open question", async () => {
    const get = vi.fn(async () =>
      run({ status: "succeeded", finishedAt: "2026-11-25T09:06:00.000Z" }),
    );
    const answer = await data("get_run", setup({ service: { get } }), {
      runId: RUN_ID,
    });
    expect(get).toHaveBeenCalledWith(LANE_ID, RUN_ID);
    expect(answer).toMatchObject({
      finished: true,
      waitingFor: [],
      run: { id: RUN_ID },
    });
  });

  // #1146-T11
  it("lists the open questions a run waits for, with what answer_run takes", async () => {
    const answer = await data(
      "get_run",
      setup({
        service: {
          get: async () =>
            run({ status: "waiting", steps: [waitingStep("s1", 2)] }),
        },
      }),
      { runId: RUN_ID },
    );
    expect(answer.waitingFor).toEqual([
      {
        stepRunId: "s1",
        n: 2,
        question: "Which database?",
        context: null,
        options: ["Postgres", "SQLite"],
      },
    ]);
  });

  // #1146-T12
  it("is not_found for a run of no lane of this workspace, without asking the run service", async () => {
    const get = vi.fn();
    expect(
      await failure(
        "get_run",
        setup({ service: { get }, lookup: async () => undefined }),
        {
          runId: RUN_ID,
        },
      ),
    ).toMatchObject({ error: "not_found" });
    expect(get).not.toHaveBeenCalled();
  });

  // #1146-T13
  it("maps the service's own not-found, and is allowed with the read scope", async () => {
    const context = setup(
      {
        service: {
          get: async () => {
            throw refuse("WORKFLOW_RUN_NOT_FOUND");
          },
        },
      },
      { scopes: ["factory:read"], role: "member" },
    );
    expect(await failure("get_run", context, { runId: RUN_ID })).toMatchObject({
      error: "not_found",
    });
  });
});

describe("list_runs", () => {
  const page = {
    runs: [
      {
        id: RUN_ID,
        workflowId: LANE_ID,
        laneName: "Implement",
        status: "running",
        nodesKey: "k1",
        steps: [{ id: "a", kind: "agent", status: "running", round: 1 }],
      },
    ],
    laneNodes: { k1: [] },
    nextCursor: "c2",
    now: "2026-11-25T10:00:00.000Z",
  };

  // #1146-T20
  it("passes the filters as the route's query takes them, and adds the address of each run", async () => {
    const listWorkspace = vi.fn(async () => page);
    const answer = await data(
      "list_runs",
      setup({ service: { listWorkspace } }),
      {
        status: "waiting",
        projectId: "p1",
        laneId: LANE_ID,
        cursor: "c1",
        limit: 10,
      },
    );
    expect(listWorkspace).toHaveBeenCalledWith({
      status: "waiting",
      project: "p1",
      lane: LANE_ID,
      cursor: "c1",
      limit: "10",
    });
    expect(answer).toEqual({
      runs: [
        {
          id: RUN_ID,
          workflowId: LANE_ID,
          laneName: "Implement",
          status: "running",
          steps: [{ id: "a", kind: "agent", status: "running", round: 1 }],
          url: `https://factory.example.test/w/acme/workflows/${LANE_ID}/runs/${RUN_ID}`,
        },
      ],
      nextCursor: "c2",
      now: "2026-11-25T10:00:00.000Z",
    });
  });

  // #1146-T21
  it("refuses a status that is none and maps a cursor the service refuses", async () => {
    const context = setup({
      service: {
        listWorkspace: async () => {
          throw refuse("WORKFLOW_RUN_REQUEST_INVALID");
        },
      },
    });
    expect(
      await failure("list_runs", context, { status: "bogus" }),
    ).toMatchObject({
      error: "invalid_input",
    });
    expect(await failure("list_runs", context, { cursor: "x" })).toMatchObject({
      error: "invalid_input",
      code: "WORKFLOW_RUN_REQUEST_INVALID",
    });
  });
});

describe("wait_for_run", () => {
  function clock() {
    let now = 0;
    return {
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    };
  }
  const waiter = (fake: clock) =>
    createToolRegistry([createWaitForRun(fake)], { audit: () => {} });
  type clock = ReturnType<typeof clock>;

  async function wait(
    statuses: Array<() => ReturnType<typeof run>>,
    args = {},
  ) {
    const fake = clock();
    const get = vi.fn(async () =>
      (statuses.shift() ?? statuses.at(-1) ?? run)(),
    );
    const context = setup({ service: { get } });
    const outcome = await waiter(fake).call("wait_for_run", context, {
      runId: RUN_ID,
      ...args,
    });
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.failure));
    return { answer: outcome.data, get, fake };
  }

  // #1146-T30
  it("returns at once for a run that finished", async () => {
    const { answer, get } = await wait([
      () => run({ status: "failed", errorCode: "step_failed" }),
    ]);
    expect(answer).toMatchObject({
      reason: "finished",
      finished: true,
      run: { status: "failed" },
    });
    expect(get).toHaveBeenCalledTimes(1);
  });

  // #1146-T31
  it("returns when the run needs an answer, with the question", async () => {
    const { answer } = await wait([
      () => run(),
      () => run({ status: "waiting", steps: [waitingStep("s9", 1)] }),
    ]);
    expect(answer).toMatchObject({ reason: "needs_input" });
    expect((answer.waitingFor as unknown[]).length).toBe(1);
  });

  // #1146-T32
  it("polls until the run finishes", async () => {
    const { answer, get, fake } = await wait([
      () => run(),
      () => run(),
      () => run({ status: "succeeded" }),
    ]);
    expect(answer).toMatchObject({ reason: "finished" });
    expect(get).toHaveBeenCalledTimes(3);
    expect(fake.now()).toBe(4000);
  });

  // #1146-T33
  it("gives up at the timeout and says the run goes on", async () => {
    const { answer, fake } = await wait([() => run()], { timeoutSeconds: 5 });
    expect(answer).toMatchObject({ reason: "timeout", finished: false });
    expect(fake.now()).toBe(5000);
  });

  // #1146-T34
  it("refuses a wait longer than the endpoint allows, and a run that is not there", async () => {
    const fake = clock();
    const context = setup({ lookup: async () => undefined });
    expect(
      (
        await waiter(fake).call("wait_for_run", context, {
          runId: RUN_ID,
          timeoutSeconds: 600,
        })
      ).ok,
    ).toBe(false);
    expect(
      await waiter(fake).call("wait_for_run", context, { runId: RUN_ID }),
    ).toMatchObject({ ok: false, failure: { error: "not_found" } });
  });
});

describe("get_step and get_step_log", () => {
  const withSteps = (
    steps = [step(), step({ id: "s2", jobId: null, kind: "action" })],
  ) => ({ get: async () => run({ steps }) });

  // #1146-T40
  it("answers one step with the id its agent log is read by", async () => {
    const answer = await data("get_step", setup({ service: withSteps() }), {
      runId: RUN_ID,
      stepId: "step-run-1",
    });
    expect(answer).toMatchObject({
      step: { id: "step-run-1", status: "succeeded" },
      agentRunId: "0a1b2c3d-0000-4000-8000-0000000000aa",
      runId: RUN_ID,
    });
  });

  // #1146-T41
  it("is not_found for a step the run does not have, and names the steps it has", async () => {
    expect(
      await failure("get_step", setup({ service: withSteps() }), {
        runId: RUN_ID,
        stepId: "nope",
      }),
    ).toMatchObject({ error: "not_found", steps: ["step-run-1", "s2"] });
  });

  // #1146-T42
  it("reads the log of an agent step from the cursor", async () => {
    const list = vi.fn(async () => ({
      steps: [{ partId: "p1", seq: 4, ordinal: 1, kind: "text", text: "hi" }],
      cursor: 4,
      hasMore: false,
    }));
    const answer = await data(
      "get_step_log",
      setup({ service: withSteps(), steps: { list } }),
      {
        runId: RUN_ID,
        stepId: "step-run-1",
        after: 3,
        limit: 50,
      },
    );
    expect(list).toHaveBeenCalledWith(
      "0a1b2c3d-0000-4000-8000-0000000000aa",
      3,
      50,
    );
    expect(answer).toMatchObject({
      cursor: 4,
      hasMore: false,
      stepStatus: "succeeded",
    });
  });

  // #1146-T43
  it("reads from the start with the largest page when no cursor is given", async () => {
    const list = vi.fn(async () => ({ steps: [], cursor: 0, hasMore: false }));
    await data(
      "get_step_log",
      setup({ service: withSteps(), steps: { list } }),
      {
        runId: RUN_ID,
        stepId: "step-run-1",
      },
    );
    expect(list).toHaveBeenCalledWith(
      "0a1b2c3d-0000-4000-8000-0000000000aa",
      0,
      200,
    );
  });

  // #1146-T44
  it("is not_found for a step with no agent turn and for a log the service does not have", async () => {
    const context = setup({
      service: withSteps(),
      steps: { list: async () => undefined },
    });
    expect(
      await failure("get_step_log", context, { runId: RUN_ID, stepId: "s2" }),
    ).toMatchObject({ error: "not_found" });
    expect(
      await failure("get_step_log", context, {
        runId: RUN_ID,
        stepId: "step-run-1",
      }),
    ).toMatchObject({ error: "not_found" });
  });

  // #1146-T45
  it("refuses a cursor that is not a whole number in range", async () => {
    const context = setup({
      service: withSteps(),
      steps: { list: async () => undefined },
    });
    for (const after of [-1, 1.5, 2 ** 40])
      expect(
        await failure("get_step_log", context, {
          runId: RUN_ID,
          stepId: "step-run-1",
          after,
        }),
      ).toMatchObject({ error: "invalid_input" });
  });

  // #1146-T46
  it("lists the MCP calls of an agent step, and is not_found for a step without a turn", async () => {
    const list = vi.fn(async () => ({ calls: [], cursor: 7, hasMore: false }));
    const context = setup({ service: withSteps(), calls: { list } });
    expect(
      await data("list_run_mcp_calls", context, {
        runId: RUN_ID,
        stepId: "step-run-1",
        after: 2,
      }),
    ).toMatchObject({ cursor: 7 });
    expect(list).toHaveBeenCalledWith(
      "0a1b2c3d-0000-4000-8000-0000000000aa",
      2,
      200,
    );
    expect(
      await failure("list_run_mcp_calls", context, {
        runId: RUN_ID,
        stepId: "s2",
      }),
    ).toMatchObject({ error: "not_found" });
  });
});

describe("cancel_run, discard_run, pause_run and resume_run", () => {
  const done = (outcome: string) => async () => ({
    run: run({ status: "discarded" }),
    outcome,
  });

  // #1146-T50
  it.each([
    ["cancel_run", "cancel", "discarded"],
    ["discard_run", "discard", "already_discarded"],
    ["pause_run", "pause", "changed"],
    ["resume_run", "resume", "unchanged"],
  ] as const)(
    "%s calls %s of the run service for the run's lane",
    async (tool, method, outcome) => {
      const fake = vi.fn(done(outcome));
      const answer = await data(tool, setup({ service: { [method]: fake } }), {
        runId: RUN_ID,
      });
      expect(fake).toHaveBeenCalledWith(LANE_ID, RUN_ID);
      expect(answer).toMatchObject({ outcome, run: { id: RUN_ID } });
    },
  );

  // #1146-T51
  it.each(["cancel_run", "discard_run", "pause_run", "resume_run"])(
    "%s needs the control scope and a run of this workspace",
    async (tool) => {
      const read = setup({ service: {} }, { scopes: ["factory:read"] });
      expect(await failure(tool, read, { runId: RUN_ID })).toMatchObject({
        error: "insufficient_scope",
      });
      const none = setup({ lookup: async () => undefined });
      expect(await failure(tool, none, { runId: RUN_ID })).toMatchObject({
        error: "not_found",
      });
    },
  );

  // #1146-T52
  it("maps a run the service no longer has", async () => {
    const context = setup({
      service: {
        cancel: async () => {
          throw refuse("WORKFLOW_RUN_NOT_FOUND");
        },
      },
    });
    expect(
      await failure("cancel_run", context, { runId: RUN_ID }),
    ).toMatchObject({
      error: "not_found",
    });
  });
});

describe("answer_run", () => {
  const waiting =
    (steps = [waitingStep("s1", 1)]) =>
    async () =>
      run({ status: "waiting", steps });
  const answered = async () => ({ run: run() });

  // #1146-T60
  it("answers the one open question without naming it, recording no GitHub login", async () => {
    const answer = vi.fn(answered);
    await data("answer_run", setup({ service: { get: waiting(), answer } }), {
      runId: RUN_ID,
      choice: 2,
      text: "because",
    });
    expect(answer).toHaveBeenCalledWith(
      { id: "user-ada", githubLogin: null },
      LANE_ID,
      RUN_ID,
      { question: { stepRunId: "s1", n: 1 }, choice: 2, text: "because" },
    );
  });

  // #1146-T61
  it("answers the question that is named, even when the run is not read", async () => {
    const get = vi.fn();
    const answer = vi.fn(answered);
    await data("answer_run", setup({ service: { get, answer } }), {
      runId: RUN_ID,
      stepRunId: "s7",
      n: 3,
      text: "yes",
    });
    expect(get).not.toHaveBeenCalled();
    expect((answer.mock.calls[0] as unknown[])[3]).toEqual({
      question: { stepRunId: "s7", n: 3 },
      text: "yes",
    });
  });

  // #1146-T62
  it("is a conflict when nothing is asked, and lists the questions when several are", async () => {
    const answer = vi.fn(answered);
    expect(
      await failure(
        "answer_run",
        setup({ service: { get: waiting([]), answer } }),
        { runId: RUN_ID, text: "x" },
      ),
    ).toMatchObject({ error: "conflict", code: "WORKFLOW_RUN_NOT_WAITING" });
    const several = await failure(
      "answer_run",
      setup({
        service: {
          get: waiting([waitingStep("s1", 1), waitingStep("s2", 1)]),
          answer,
        },
      }),
      { runId: RUN_ID, text: "x" },
    );
    expect(several).toMatchObject({ error: "invalid_input" });
    expect((several.waitingFor as unknown[]).length).toBe(2);
    expect(answer).not.toHaveBeenCalled();
  });

  // #1146-T63
  it("refuses half a question name", async () => {
    expect(
      await failure("answer_run", setup({ service: {} }), {
        runId: RUN_ID,
        stepRunId: "s1",
        text: "x",
      }),
    ).toMatchObject({ error: "invalid_input" });
  });

  // #1146-T64
  it.each([
    ["WORKFLOW_RUN_QUESTION_CHANGED", "conflict"],
    ["WORKFLOW_RUN_NOT_WAITING", "conflict"],
    ["WORKFLOW_RUN_ANSWER_INVALID", "invalid_input"],
  ] as const)("maps %s to %s", async (serviceCode, code) => {
    const context = setup({
      service: {
        get: waiting(),
        answer: async () => {
          throw refuse(serviceCode);
        },
      },
    });
    expect(
      await failure("answer_run", context, { runId: RUN_ID, text: "x" }),
    ).toMatchObject({
      error: code,
      code: serviceCode,
    });
  });

  // #1146-T65
  it("needs the control scope and a bounded answer", async () => {
    expect(
      await failure("answer_run", setup({}, { scopes: ["factory:read"] }), {
        runId: RUN_ID,
        text: "x",
      }),
    ).toMatchObject({ error: "insufficient_scope" });
    expect(
      await failure("answer_run", setup({}), {
        runId: RUN_ID,
        text: "x".repeat(4001),
      }),
    ).toMatchObject({ error: "invalid_input" });
    expect(
      await failure("answer_run", setup({}), { runId: RUN_ID, choice: 0 }),
    ).toMatchObject({ error: "invalid_input" });
  });
});
