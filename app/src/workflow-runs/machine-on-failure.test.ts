// SPDX-License-Identifier: LicenseRef-Proprietary

// #902: the state machine around `onFailure`. A run that would end `failed` or `cancelled` first records how it ended (`begin_failure`),
// stays `running` while the steps of `onFailure` run one after the other, and then ends the way it was going to. A step of `onFailure`
// that fails does not stop the others and does not change the end; a cancel asked for meanwhile changes nothing either.
import { describe, expect, it } from "vitest";
import {
  contextOf,
  nextMove,
  type FailureRecord,
  type MachineNode,
  type MachineState,
  type MachineStep,
} from "./machine.ts";

const NOW = new Date("2026-11-06T12:00:00.000Z");
const at = (secondsAgo: number): string =>
  new Date(NOW.getTime() - secondsAgo * 1000).toISOString();

const agent = (id: string): MachineNode => ({ kind: "agent", id });
const action = (id: string): MachineNode => ({ kind: "action", id });
const branch = (
  id: string,
  then: MachineNode[],
  otherwise: MachineNode[] = [],
): MachineNode => ({ kind: "if", id, then, else: otherwise });
const loop = (id: string, body: MachineNode[]): MachineNode => ({
  kind: "loop",
  id,
  maxRounds: 2,
  body,
});

function step(stepId: string, patch: Partial<MachineStep> = {}): MachineStep {
  return {
    stepId,
    status: "succeeded",
    kind: "agent",
    hasJob: true,
    createdAt: at(600),
    startedAt: at(600),
    ...patch,
  };
}

const done = (stepId: string, kind: MachineStep["kind"] = "agent") =>
  step(stepId, { kind, hasJob: kind === "agent" });
const broke = (stepId: string, errorCode: string, errorMessage = "It broke.") =>
  step(stepId, { status: "failed", errorCode, errorMessage });
const act = (stepId: string, patch: Partial<MachineStep> = {}) =>
  step(stepId, { kind: "action", hasJob: false, ...patch });

const ON_FAILURE = [action("comment"), action("unlabel")];

function state(patch: Partial<MachineState> = {}): MachineState {
  return {
    runStatus: "running",
    cancelRequested: false,
    budgetMicroUsd: 20_000_000,
    spentMicroUsd: 0,
    steps: [],
    nodes: [agent("plan"), agent("build")],
    onFailure: ON_FAILURE,
    failure: null,
    holds: () => {
      throw new Error("no condition is asked in this test");
    },
    now: NOW,
    staleMs: 120_000,
    giveUpMs: 3_600_000,
    ...patch,
  };
}

const FAILED_STEP: FailureRecord = {
  status: "failed",
  errorCode: "step_failed",
  stepId: "build",
  code: "no_result",
  message: "It broke.",
};

describe("a run that would end failed or cancelled, with onFailure steps", () => {
  // #902-T20
  it("records the failure of a step first, with its id, its code and a short message", () => {
    expect(
      nextMove(
        state({
          steps: [done("plan"), broke("build", "no_result", "x".repeat(900))],
        }),
      ),
    ).toEqual({
      move: "begin_failure",
      failure: {
        ...FAILED_STEP,
        message: `${"x".repeat(299)}…`,
      },
    });
  });

  // #902-T21
  it("ends as before when the workflow has no onFailure steps", () => {
    expect(
      nextMove(
        state({
          onFailure: [],
          steps: [done("plan"), broke("build", "no_result")],
        }),
      ),
    ).toEqual({
      move: "finish_run",
      status: "failed",
      errorCode: "step_failed",
    });
  });

  // #902-T22
  it("does not run them after a run that succeeded", () => {
    expect(nextMove(state({ steps: [done("plan"), done("build")] }))).toEqual({
      move: "finish_run",
      status: "succeeded",
      errorCode: null,
    });
  });

  // #902-T23
  it("records a budget that cannot pay the next agent step, naming that step", () => {
    expect(
      nextMove(state({ steps: [done("plan")], spentMicroUsd: 19_995_000 })),
    ).toEqual({
      move: "begin_failure",
      failure: {
        status: "failed",
        errorCode: "budget_exhausted",
        stepId: "build",
        code: "budget_exhausted",
        message: expect.stringContaining("budget") as unknown as string,
      },
    });
  });

  // #902-T24
  it("records a condition that cannot be told, naming the control step", () => {
    expect(
      nextMove(
        state({
          nodes: [branch("gate", [agent("plan")])],
          holds: () => {
            throw new Error("missing");
          },
        }),
      ),
    ).toMatchObject({
      move: "begin_failure",
      failure: {
        status: "failed",
        errorCode: "condition_failed",
        stepId: "gate",
        code: "condition_failed",
      },
    });
  });

  // #902-T25
  it("does not run them for rows that do not fit the document: nothing there can be trusted", () => {
    expect(nextMove(state({ steps: [done("build")] }))).toEqual({
      move: "finish_run",
      status: "failed",
      errorCode: "document_unusable",
    });
  });

  // #902-T26
  it("records a run that was cancelled before any step: no step, the code cancelled", () => {
    expect(nextMove(state({ cancelRequested: true }))).toEqual({
      move: "begin_failure",
      failure: {
        status: "cancelled",
        errorCode: null,
        stepId: "",
        code: "cancelled",
        message: "The run was cancelled.",
      },
    });
  });

  // #902-T27
  it("records a run that was cancelled while its agent ran, once that agent has stopped", () => {
    expect(
      nextMove(
        state({
          cancelRequested: true,
          steps: [done("plan"), broke("build", "cancelled", "Stopped.")],
        }),
      ),
    ).toEqual({
      move: "begin_failure",
      failure: {
        status: "cancelled",
        errorCode: null,
        stepId: "build",
        code: "cancelled",
        message: "Stopped.",
      },
    });
    // The step ended through the task of its own (no request on the run): still a cancel.
    expect(
      nextMove(state({ steps: [done("plan"), broke("build", "cancelled")] })),
    ).toMatchObject({
      move: "begin_failure",
      failure: { status: "cancelled", stepId: "build" },
    });
  });

  // #902-T28
  it("still asks a running agent to stop first: the failure is recorded when it has stopped", () => {
    expect(
      nextMove(
        state({
          cancelRequested: true,
          steps: [done("plan"), step("build", { status: "running" })],
        }),
      ),
    ).toEqual({ move: "cancel_job", position: 1 });
  });
});

describe("the steps of onFailure", () => {
  const failing = (patch: Partial<MachineState> = {}) =>
    state({
      steps: [done("plan"), broke("build", "no_result")],
      failure: FAILED_STEP,
      ...patch,
    });

  // #902-T30
  it("start with the first one, an action that costs nothing", () => {
    expect(nextMove(failing())).toEqual({
      move: "add_step",
      position: 2,
      stepId: "comment",
      kind: "action",
      round: 1,
      capMicroUsd: null,
    });
  });

  // #902-T31
  it("go on one after the other and run even when the budget is used up", () => {
    expect(
      nextMove(
        failing({
          steps: [
            done("plan"),
            broke("build", "budget_exhausted"),
            act("comment"),
          ],
          spentMicroUsd: 99_000_000,
        }),
      ),
    ).toMatchObject({ move: "add_step", position: 3, stepId: "unlabel" });
  });

  // #902-T32
  it("wait for the one that runs, and execute the one that is written", () => {
    const rows = [done("plan"), broke("build", "no_result")];

    expect(
      nextMove(
        failing({ steps: [...rows, act("comment", { status: "pending" })] }),
      ),
    ).toEqual({ move: "execute", position: 2, takeOver: false });
    expect(
      nextMove(
        failing({
          steps: [
            ...rows,
            act("comment", { status: "running", startedAt: at(5) }),
          ],
        }),
      ),
    ).toEqual({ move: "idle" });
    expect(
      nextMove(
        failing({
          steps: [
            ...rows,
            act("comment", { status: "running", startedAt: at(600) }),
          ],
        }),
      ),
    ).toEqual({ move: "fail_step", position: 2, code: "action_interrupted" });
  });

  // #902-T33
  it("end the run the way it was going to end, failed or cancelled, once the last has run", () => {
    const rows = [done("plan"), broke("build", "no_result")];

    expect(
      nextMove(failing({ steps: [...rows, act("comment"), act("unlabel")] })),
    ).toEqual({
      move: "finish_run",
      status: "failed",
      errorCode: "step_failed",
    });
    expect(
      nextMove(
        failing({
          failure: {
            status: "cancelled",
            errorCode: null,
            stepId: "build",
            code: "cancelled",
            message: "Stopped.",
          },
          steps: [...rows, act("comment"), act("unlabel")],
        }),
      ),
    ).toEqual({ move: "finish_run", status: "cancelled", errorCode: null });
  });

  // #902-T34
  it("do not stop when one of them fails: the next one runs, and the end is the same", () => {
    const rows = [
      done("plan"),
      broke("build", "no_result"),
      act("comment", { status: "failed", errorCode: "github_not_found" }),
    ];

    expect(nextMove(failing({ steps: rows }))).toMatchObject({
      move: "add_step",
      stepId: "unlabel",
    });
    expect(
      nextMove(
        failing({
          steps: [
            ...rows,
            act("unlabel", { status: "failed", errorCode: "action_failed" }),
          ],
        }),
      ),
    ).toEqual({
      move: "finish_run",
      status: "failed",
      errorCode: "step_failed",
    });
  });

  // #902-T35
  it("ignore a cancel asked for meanwhile: the run ends failed, the steps still run", () => {
    const rows = [done("plan"), broke("build", "no_result")];

    expect(
      nextMove(
        failing({
          cancelRequested: true,
          steps: [...rows, act("comment", { status: "pending" })],
        }),
      ),
    ).toEqual({ move: "execute", position: 2, takeOver: false });
    expect(
      nextMove(
        failing({
          cancelRequested: true,
          steps: [...rows, act("comment"), act("unlabel")],
        }),
      ),
    ).toEqual({
      move: "finish_run",
      status: "failed",
      errorCode: "step_failed",
    });
  });

  // #902-T36
  it("take an if over the facts: it writes its decision and skips the other branch", () => {
    const holds = (nodeId: string): boolean => nodeId === "which";

    expect(
      nextMove(
        failing({
          onFailure: [
            branch("which", [action("said")], [action("other")]),
            action("last"),
          ],
          holds,
        }),
      ),
    ).toEqual({
      move: "add_if",
      position: 2,
      stepId: "which",
      round: 1,
      taken: "then",
      skipped: [{ stepId: "other", kind: "action", round: 1 }],
    });
    expect(
      nextMove(
        failing({
          onFailure: [
            branch("which", [action("said")], [action("other")]),
            action("last"),
          ],
          steps: [
            done("plan"),
            broke("build", "no_result"),
            act("which", { kind: "if", taken: "then" }),
            act("other", { status: "skipped" }),
            act("said"),
          ],
          holds,
        }),
      ),
    ).toMatchObject({ move: "add_step", stepId: "last", position: 5 });
  });

  // #902-T37
  it("end the run, without a new failure, when a condition of onFailure cannot be told", () => {
    expect(
      nextMove(
        failing({
          onFailure: [branch("which", [action("said")])],
          holds: () => {
            throw new Error("missing");
          },
        }),
      ),
    ).toEqual({
      move: "finish_run",
      status: "failed",
      errorCode: "step_failed",
    });
  });

  // #902-T38
  it("never start an agent or a loop, whatever the document holds", () => {
    expect(
      nextMove(failing({ onFailure: [agent("again"), action("comment")] })),
    ).toEqual({
      move: "finish_run",
      status: "failed",
      errorCode: "step_failed",
    });
    expect(
      nextMove(failing({ onFailure: [loop("retry", [action("comment")])] })),
    ).toEqual({
      move: "finish_run",
      status: "failed",
      errorCode: "step_failed",
    });
  });

  // #902-T39
  it("do nothing once the run is over", () => {
    expect(nextMove(failing({ runStatus: "failed" }))).toEqual({
      move: "idle",
    });
  });
});

describe("where a step of onFailure is", () => {
  // #902-T40
  it("is told for the rows after the failure with the rows of the workflow left out", () => {
    const rows = [
      done("plan"),
      broke("build", "no_result"),
      act("which", { kind: "if", taken: "then" }),
      act("other", { status: "skipped" }),
      act("said"),
    ];
    const onFailure = [
      branch("which", [action("said")], [action("other")]),
      action("last"),
    ];
    const nodes = [agent("plan"), agent("build")];

    expect(contextOf(nodes, onFailure, rows, 4)).toEqual({
      loopId: null,
      loopRound: 1,
      previous: {},
    });
    expect(contextOf(nodes, onFailure, rows, 0)).toBeDefined();
    expect(contextOf(nodes, [action("x")], rows, 4)).toBeUndefined();
  });
});
