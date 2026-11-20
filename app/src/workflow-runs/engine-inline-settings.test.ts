// SPDX-License-Identifier: LicenseRef-Proprietary

// #1105 (ADR 0007, release A step 1): an agent step that carries its settings itself instead of a `profile`. The engine builds the profile
// copy of the turn from the step (the lane's name and version stand where a profile's would), the step's run records no profile, the
// hosted settings go to the Implementer, and a step in `profile` form is untouched.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PROFILE_NAME_PATTERN } from "../profiles/limits.ts";
import type {
  StoredStepRun,
  StoredWorkflowRun,
  WorkflowRunsRepository,
} from "../db/repositories/workflow-runs-repository.ts";
import { createConnectorRegistry } from "./connectors.ts";
import { createWorkflowEngine, type EngineDependencies } from "./engine.ts";
import { STEP_STALE_MS } from "./limits.ts";

const NOW = new Date("2026-11-20T12:00:00.000Z");
const RUN_ID = "7f0c1b3e-aaaa-4bbb-8ccc-0123456789ab";

const ENVIRONMENTS = [
  { id: "env-vm", name: "vm", kind: "hosted" },
  { id: "env-box", name: "box", kind: "runner" },
];

type Json = Record<string, unknown>;

const OWN_MODEL = { provider: "anthropic", model: "claude-sonnet-5-5" };

/** A step with its settings written in it. */
const inlineStep = (fields: Json = {}): Json => ({
  id: "implement",
  kind: "agent",
  model: OWN_MODEL,
  canPush: true,
  instructions: "Standing text.",
  environment: "vm",
  instruction: "Build it.",
  ...fields,
});

const documentOf = (step: Json, name = "Issue to PR") => ({
  version: 1,
  name,
  trigger: { kind: "github.issueLabeled", label: "agent" },
  steps: [step],
});

/**
 * A run with one agent step. `claimed`: the step run exists and was claimed, so the engine starts its turn; otherwise the run has no step
 * row yet and the engine decides to add one (`addStep`).
 */
function harness(options: {
  step: Json;
  claimed?: boolean;
  laneName?: string;
}) {
  const run: StoredWorkflowRun = {
    id: RUN_ID,
    workspaceId: "w-1",
    workflowId: "wf-1",
    workflowVersion: 4,
    repositoryId: "repo-1",
    baseBranch: "main",
    triggerInput: "{}",
    status: "running",
    errorCode: null,
    budgetMicroUsd: 10_000_000,
    spentMicroUsd: 0,
    clientRequestId: "request-1",
    triggerKind: "github.issueLabeled",
    triggerId: null,
    ticketRef: null,
    createdBy: null,
    actorLogin: "octocat",
    cancelRequestedAt: null,
    failure: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    finishedAt: null,
    discardedAt: null,
    pauseRequestedAt: null,
  };
  const claimedStep: StoredStepRun = {
    id: "step-0",
    runId: RUN_ID,
    workspaceId: "w-1",
    position: 0,
    stepId: "implement",
    kind: "agent",
    status: "running",
    round: 1,
    // A step with settings of its own records no profile; one with a profile records which version it resolved.
    profile:
      options.step.profile === undefined
        ? null
        : { name: "worker", version: 3 },
    jobId: null,
    turnId: null,
    capMicroUsd: 5_000_000,
    costMicroUsd: null,
    costBasis: null,
    output: null,
    errorCode: null,
    errorMessage: null,
    ask: null,
    waitingOnCommentId: null,
    createdAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
    startedAt: new Date(NOW.getTime() - STEP_STALE_MS - 1).toISOString(),
    finishedAt: null,
  };
  const steps: StoredStepRun[] = options.claimed === false ? [] : [claimedStep];
  const addStep = vi.fn(async () => claimedStep);
  const settleOwnStep = vi.fn(async () => true);
  const finishStep = vi.fn();
  const runs: Partial<WorkflowRunsRepository> = {
    getRun: async () => run,
    listSteps: async () => steps.map((step) => ({ ...step })),
    claimStep: async () => ({ ...claimedStep }),
    attachTurn: async (_id, turn) => {
      claimedStep.jobId = turn.jobId;
      return true;
    },
    settleOwnStep,
    lockRun: async (_runId, work) =>
      work({
        run,
        steps,
        attachTurn: vi.fn(),
        addStep,
        addFinished: vi.fn(),
        finishStep,
        finishRun: vi.fn(),
        touch: vi.fn(),
      } as never),
  };
  const startTask = vi.fn<EngineDependencies["implementer"]["startTask"]>(
    async () => ({ runId: "job-implement", sessionId: "s-1", created: true }),
  );
  const findByName = vi.fn(async () => ({
    profile: { name: "worker" },
    version: { version: 3, content: { environmentId: "env-vm" } },
  }));
  const deps: EngineDependencies = {
    runs: runs as WorkflowRunsRepository,
    workflows: {
      getVersion: async () =>
        ({
          document: JSON.stringify(documentOf(options.step, options.laneName)),
          createdBy: "owner-1",
        }) as never,
    },
    members: { get: async () => ({}) as never },
    profiles: { findByName: findByName as never },
    environments: {
      listSummaries: async () => ENVIRONMENTS.map((e) => e as never),
    },
    implementer: {
      startTask,
      continueSession: vi.fn(),
      discardRequested: vi.fn(),
    },
    jobs: { requestCancel: vi.fn() },
    turns: {
      read: async () => ({ turnId: "turn-implement", ended: undefined }),
      findByRequest: async () => undefined,
    },
    connectors: createConnectorRegistry(),
    repositoryName: async () => "acme/app",
    now: () => NOW,
    log: () => undefined,
  };
  return {
    engine: createWorkflowEngine(deps),
    startTask,
    findByName,
    addStep,
    finishStep,
    settleOwnStep,
  };
}

describe("an agent step with settings of its own, in the engine (#1105)", () => {
  // #1105-T30
  it("starts the turn with the model of the step and a profile copy built from it, under the name and version of the lane", async () => {
    const app = harness({ step: inlineStep() });

    await app.engine.advance(RUN_ID);

    expect(app.startTask).toHaveBeenCalledTimes(1);
    const [, body, options] = app.startTask.mock.calls[0] ?? [];
    expect(body).toMatchObject({
      environmentId: "env-vm",
      model: OWN_MODEL,
    });
    // No profile reference: the Implementer reads no profile for it.
    expect(body).not.toHaveProperty("profile");
    expect(options).toMatchObject({
      workflowStep: true,
      inline: {
        profile: {
          id: "workflow:wf-1",
          // The lane's name as a slug: the wire contract takes lower case, digits, `_` and `-` only.
          name: "issue-to-pr",
          version: 4,
          instructions: "Standing text.",
          canPush: true,
          harness: "opencode",
        },
      },
    });
    expect(app.findByName).not.toHaveBeenCalled();
  });

  // #1105-T40
  it("sends a profile name the wire contract accepts, whatever the lane is called", async () => {
    // The pattern the app checks is the one the contract (and the Worker) enforce.
    const contract = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "../../../contracts/runner-api.v1.json"),
        "utf8",
      ),
    ) as {
      $defs: {
        ImplementerProfile: { properties: { name: { pattern: string } } };
      };
    };
    const wire = new RegExp(
      contract.$defs.ImplementerProfile.properties.name.pattern,
    );
    expect(wire.source).toBe(PROFILE_NAME_PATTERN.source);

    const names = [
      "Issue to PR",
      "  Ünïcode & Symbols!  ",
      "!!! ???",
      "",
      "x".repeat(100),
      "A".repeat(63) + " b-c",
      "_-Lead",
    ];
    const sent: unknown[] = [];
    for (const laneName of names) {
      const app = harness({ step: inlineStep(), laneName });
      await app.engine.advance(RUN_ID);
      const [, , options] = app.startTask.mock.calls[0] ?? [];
      sent.push(options?.inline?.profile.name);
    }

    expect(sent).toHaveLength(names.length);
    for (const name of sent) expect(name).toMatch(wire);
    expect(sent.slice(0, 5)).toEqual([
      "issue-to-pr",
      "n-code-symbols",
      "lane",
      "lane",
      "x".repeat(64),
    ]);
  });

  // #1105-T31
  it("hands the setup script and the network rule of the step on, the rule in its stored form", async () => {
    const app = harness({
      step: inlineStep({
        setupScript: "npm ci\n",
        network: { mode: "list", hosts: ["Registry.NPMJS.org"] },
      }),
    });

    await app.engine.advance(RUN_ID);

    expect(app.startTask.mock.calls[0]?.[2]?.inline).toMatchObject({
      setupScript: "npm ci\n",
      network: { mode: "list", hosts: ["registry.npmjs.org"] },
    });
  });

  // #1105-T32
  it("takes canPush false and the harness claude-code as the step says them", async () => {
    const app = harness({
      step: inlineStep({
        canPush: false,
        instructions: undefined,
        harness: "claude-code",
        model: { provider: "claude-code", model: "sonnet" },
        environment: "box",
      }),
    });

    await app.engine.advance(RUN_ID);

    expect(app.startTask.mock.calls[0]?.[1]).toMatchObject({
      environmentId: "env-box",
      model: { provider: "claude-code", model: "sonnet" },
    });
    expect(app.startTask.mock.calls[0]?.[2]?.inline?.profile).toMatchObject({
      canPush: false,
      instructions: "",
      harness: "claude-code",
    });
  });

  // #1105-T33
  it("runs in the environment the step names, and ends the step without a turn when it is not one of the workspace", async () => {
    const app = harness({ step: inlineStep({ environment: "gone" }) });

    await app.engine.advance(RUN_ID);

    expect(app.startTask).not.toHaveBeenCalled();
    expect(app.settleOwnStep).toHaveBeenCalledWith(
      "step-0",
      expect.objectContaining({ errorCode: "environment_not_found" }),
    );
  });

  // #1105-T34
  it("ends the step with agent_settings_invalid, before a turn exists, when the settings do not read", async () => {
    const app = harness({ step: inlineStep({ canPush: "yes" }) });

    await app.engine.advance(RUN_ID);

    expect(app.startTask).not.toHaveBeenCalled();
    expect(app.settleOwnStep).toHaveBeenCalledWith(
      "step-0",
      expect.objectContaining({ errorCode: "agent_settings_invalid" }),
    );
  });

  // #1105-T35
  it("writes the step run without a profile and does not end it as profile_not_found", async () => {
    const app = harness({ step: inlineStep(), claimed: false });

    await app.engine.advance(RUN_ID);

    expect(app.addStep).toHaveBeenCalledWith(
      expect.objectContaining({ stepId: "implement", profile: null }),
    );
    expect(app.finishStep).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ errorCode: "profile_not_found" }),
    );
    expect(app.findByName).not.toHaveBeenCalled();
  });

  // #1105-T36
  it("leaves a step in profile form as it was: the profile is resolved and the Implementer gets its reference", async () => {
    const app = harness({
      step: {
        id: "implement",
        kind: "agent",
        profile: "worker",
        instruction: "Build it.",
      },
    });

    await app.engine.advance(RUN_ID);

    expect(app.startTask.mock.calls[0]?.[1]).toMatchObject({
      environmentId: "env-vm",
      profile: "worker@3",
    });
    expect(app.startTask.mock.calls[0]?.[2]).not.toHaveProperty("inline");
  });

  // #1105-T37
  it("ends a step that names neither as profile_not_found, as a document the validator never saved", async () => {
    const app = harness({
      step: {
        id: "implement",
        kind: "agent",
        environment: "vm",
        instruction: "Build it.",
      },
      claimed: false,
    });
    app.addStep.mockResolvedValueOnce({ id: "step-0" } as never);

    await app.engine.advance(RUN_ID);

    expect(app.finishStep).toHaveBeenCalledWith(
      "step-0",
      expect.objectContaining({ errorCode: "profile_not_found" }),
    );
    expect(app.startTask).not.toHaveBeenCalled();
  });
});
