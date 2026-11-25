// SPDX-License-Identifier: LicenseRef-Proprietary

// Test use only: a tool context whose services are fakes, for the tests of the run, ToDo and ticket tools (#1146).
import type { RunView, StepView } from "../../../workflow-runs/service.ts";
import { ALL_TOOLS } from "../all.ts";
import type { ToolContext } from "../context.ts";
import { createToolRegistry } from "../registry.ts";
import type { ServiceFactory } from "../services.ts";
import { testContext } from "../test-context.ts";

export const registry = createToolRegistry(ALL_TOOLS, { audit: () => {} });

/** A context whose `services.use(factory)` answers the fake given for that factory (and the real one for any other). */
export function contextWith(
  fakes: ReadonlyArray<readonly [ServiceFactory<never>, unknown]>,
  overrides: Parameters<typeof testContext>[0] = {},
): ToolContext {
  const base = testContext({ tools: registry.summaries(), ...overrides });
  const map = new Map<unknown, unknown>(fakes);
  return {
    ...base,
    services: {
      scope: base.services.scope,
      use: <T>(factory: ServiceFactory<T>): T =>
        (map.has(factory) ? map.get(factory) : base.services.use(factory)) as T,
    },
  };
}

export async function call(name: string, context: ToolContext, args: unknown) {
  return registry.call(name, context, args);
}

export async function data(name: string, context: ToolContext, args: unknown) {
  const outcome = await call(name, context, args);
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.failure));
  return outcome.data as Record<string, unknown>;
}

export async function failure(
  name: string,
  context: ToolContext,
  args: unknown,
) {
  const outcome = await call(name, context, args);
  if (outcome.ok)
    throw new Error(`${name} succeeded: ${JSON.stringify(outcome.data)}`);
  return outcome.failure;
}

export const RUN_ID = "0a1b2c3d-0000-4000-8000-000000000001";
export const LANE_ID = "lane-implement";

export function step(overrides: Partial<StepView> = {}): StepView {
  return {
    id: "step-run-1",
    position: 1,
    kind: "agent",
    status: "succeeded",
    round: 1,
    profile: null,
    jobId: "0a1b2c3d-0000-4000-8000-0000000000aa",
    turnId: null,
    costUsd: 0.12,
    costBasis: "reported",
    output: { summary: "done" },
    ask: null,
    waitingOnCommentId: null,
    errorCode: null,
    errorMessage: null,
    createdAt: "2026-11-25T09:00:00.000Z",
    startedAt: "2026-11-25T09:00:01.000Z",
    finishedAt: "2026-11-25T09:05:00.000Z",
    ...overrides,
  };
}

export function waitingStep(
  id: string,
  n: number,
  question = "Which database?",
): StepView {
  return step({
    id,
    status: "waiting",
    ask: {
      question,
      options: ["Postgres", "SQLite"],
      n,
      state: "open",
    },
  });
}

export function run(overrides: Partial<RunView> = {}): RunView {
  return {
    id: RUN_ID,
    workflowId: LANE_ID,
    workflowVersion: 3,
    trigger: "manual",
    triggerId: "manual",
    status: "running",
    errorCode: null,
    cancelRequestedAt: null,
    discardedAt: null,
    pauseRequestedAt: null,
    actorLogin: "Ada via Claude Code",
    budgetUsd: 5,
    spentUsd: 0.12,
    createdAt: "2026-11-25T09:00:00.000Z",
    updatedAt: "2026-11-25T09:05:00.000Z",
    finishedAt: null,
    repositoryId: "repo-1",
    baseBranch: "main",
    input: {},
    steps: [step()],
    ...overrides,
  };
}
