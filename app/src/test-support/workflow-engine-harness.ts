// SPDX-License-Identifier: LicenseRef-Proprietary

// Everything a test of the workflow engine needs (#844): the Implementer harness (a real Postgres database, the fake GitHub API, the
// real service and job queue), a workspace with the profiles `worker` (may push) and `reviewer` (may not), the environment `Python`,
// a place to save workflows, the engine and the run service wired to them, and a way to end the turn of a step the way a runner does.
// The model check is the harness's stand-in; what a turn does inside its VM is not simulated: a test ends the turn with the report a
// runner would send (`finishTurn`).
import type { ActionConnector } from "../workflow-runs/connectors.ts";
import { createConnectorRegistry } from "../workflow-runs/connectors.ts";
import {
  createWorkflowEngine,
  type AskChannel,
} from "../workflow-runs/engine.ts";
import { createTurnReader } from "../workflow-runs/turn-reader.ts";
import type { TokenPrice } from "../workflow-runs/turn-facts.ts";
import {
  createWorkflowRunService,
  type WorkflowRunService,
} from "../workflow-runs/service.ts";
import { createImplementerEnvironmentsRepository } from "../db/repositories/implementer-environments-repository.ts";
import { createImplementerRepository } from "../db/repositories/implementer-repository.ts";
import { createJobsRepository } from "../db/repositories/jobs-repository.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { createWorkflowRunsRepository } from "../db/repositories/workflow-runs-repository.ts";
import { createWorkflowsRepository } from "../db/repositories/workflows-repository.ts";
import { createWorkspaceMembersRepository } from "../db/repositories/workspace-members-repository.ts";
import { createResolver } from "../workflows/resolver.ts";
import { validateWorkflow } from "../workflows/validate.ts";
import type { JsonValue } from "../integrations/types.ts";
import { sha } from "./jobs.ts";
import { REVIEWER_PROFILE } from "./reviewer-profile.ts";
import { USER, startImplementerHarness } from "./implementer-harness.ts";

export { USER };

const PROFILE = {
  description: "Works on a branch.",
  model: { entryId: "entry-1" },
  instructions: "Work carefully.",
  costLimitCents: null,
  canPush: true,
  defaultResult: null,
};

/** A manual workflow that declares the repository and one more input. */
export const MANUAL_TRIGGER = {
  kind: "manual",
  input: {
    type: "object",
    required: ["repo", "topic"],
    properties: { repo: { type: "string" }, topic: { type: "string" } },
  },
} as const;

export const SUMMARY_RESULT = {
  type: "object",
  required: ["summary"],
  properties: { summary: { type: "string" } },
} as const;

/** Two agent steps: the second works with what the first yielded. */
export function twoAgentSteps(): Record<string, unknown> {
  return {
    version: 1,
    name: "Two agents",
    trigger: MANUAL_TRIGGER,
    steps: [
      {
        id: "plan",
        kind: "agent",
        profile: "worker",
        environment: "Python",
        instruction: "Plan the work on {{trigger.input.topic}}.",
        result: SUMMARY_RESULT,
      },
      {
        id: "build",
        kind: "agent",
        profile: "worker",
        environment: "Python",
        instruction:
          "Build it on {{plan.branch}} after this plan: {{plan.summary}}",
      },
    ],
  };
}

export type TurnReport = {
  /** Default true. */
  ok?: boolean;
  errorCode?: string;
  costUsd?: number | null;
  /** A turn on a customer device's login (#856): no cost, the basis `subscription` and the estimate at API prices (null: none). */
  subscription?: {
    estimatedCostUsd: number | null;
    /** Only the report says so; the profile of the step is not on the harness claude-code (what any runner could write). */
    onlyClaimed?: true;
  };
  /** The token counts of the usage; default 1 and 1. */
  tokens?: { prompt: number; completion: number };
  /** What the finish tool stored; none when the turn has no schema or the agent never called it. */
  agentResult?: JsonValue;
  /** #920: the question the turn ended with instead of a result. */
  agentAsk?: JsonValue;
  pushed?: boolean;
  commits?: string[];
  headCommit?: string | null;
  /** The claim of a turn a test took before (`claimTurn`): the report is made for that job, not for the oldest that waits. */
  claimed?: { job: { id: string }; leaseToken: string };
};

export async function startEngineHarness(
  options: {
    connectors?: readonly ActionConnector[];
    /** #920: where a question is shown and an answer acknowledged. */
    asks?: AskChannel;
    operatorCostLimitCents?: number;
    maxBudgetUsd?: number;
    /** The catalog price of the model of a turn; left out: no turn has a price. */
    priceOf?: () => Promise<TokenPrice | undefined>;
    actionTimeoutMs?: number;
    /** The most connections the pool of the database opens; a test of the engine under a small pool sets it. */
    poolMax?: number;
    /** The tickets the platform answers for (#916), by `owner/name#number`; a ticket that is not listed does not exist. */
    tickets?: Record<
      string,
      {
        number: number;
        title: string;
        body: string;
        url: string;
        labels: string[];
        assignees: string[];
        type: string;
      }
    >;
  } = {},
) {
  const app = await startImplementerHarness({
    ...(options.poolMax === undefined ? {} : { poolMax: options.poolMax }),
    ...(options.operatorCostLimitCents === undefined
      ? {}
      : { operatorCostLimitCents: options.operatorCostLimitCents }),
  });
  const { h } = app;
  const workspaceId = h.workspaceId;

  const worker = await app.profiles.create(
    { name: "worker", content: PROFILE, createdBy: USER.id },
    100,
  );
  const reviewer = await app.profiles.create(
    {
      name: "reviewer",
      content: {
        ...PROFILE,
        ...REVIEWER_PROFILE,
        // The repository keeps the schema as text.
        defaultResult: JSON.stringify(REVIEWER_PROFILE.defaultResult),
      },
      createdBy: USER.id,
    },
    100,
  );
  if (!worker.ok || !reviewer.ok) throw new Error("seeding failed");
  const environments = createImplementerEnvironmentsRepository(
    h.db,
    workspaceId,
  );
  const environment = await environments.create(
    { name: "Python", vcpus: 4, setupScript: "", createdBy: USER.id },
    50,
  );
  if (!environment.ok) throw new Error("seeding failed");

  const workflows = createWorkflowsRepository(h.db, workspaceId);
  // The project of the repository "acme/widgets" (#922): the lanes of a test belong to it, so a label on a ticket of that repository starts
  // them and a run is held to that repository.
  const projects = createProjectsRepository(h.db, workspaceId);
  const activated = await projects.activate(app.repository.id, { board: null });
  if (activated.kind !== "activated") throw new Error("seeding failed");
  const project = activated.project;
  // The owner of the workflows of a test is a member of the workspace; a test that wants them gone removes them.
  const members = createWorkspaceMembersRepository(h.db, workspaceId);
  await members.add(USER.id, "member");
  let clock = new Date("2026-11-05T10:00:00.000Z");
  const now = () => clock;
  const runs = createWorkflowRunsRepository(h.db, workspaceId, { now });
  const jobs = createJobsRepository(h.db, workspaceId);
  const turns = createImplementerRepository(h.db, workspaceId);

  const turnReader = createTurnReader({
    jobs,
    turns,
    ...(options.priceOf === undefined ? {} : { priceOf: options.priceOf }),
  });
  const engineLines: string[] = [];
  const engine = createWorkflowEngine({
    runs,
    workflows,
    members,
    profiles: app.profiles,
    environments,
    implementer: app.service,
    jobs,
    turns: turnReader,
    connectors: createConnectorRegistry(options.connectors ?? []),
    ...(options.asks === undefined ? {} : { asks: options.asks }),
    repositoryName: async (id) => (await h.repositories.get(id))?.fullName,
    now,
    ...(options.actionTimeoutMs === undefined
      ? {}
      : { actionTimeoutMs: options.actionTimeoutMs }),
    log: (line) => engineLines.push(line),
  });

  const kicked: string[] = [];
  const service: WorkflowRunService = createWorkflowRunService({
    runs,
    engine,
    workflows,
    projects,
    repositoryName: async (id) => (await h.repositories.get(id))?.fullName,
    async resolveRepository(fullName) {
      const found = (await h.repositories.list({ active: true })).find(
        (candidate) =>
          candidate.fullName.toLowerCase() === fullName.toLowerCase(),
      );
      return found === undefined
        ? undefined
        : { id: found.id, fullName: found.fullName, defaultBranch: "main" };
    },
    async readTicket(repositoryId, number) {
      const repository = await h.repositories.get(repositoryId);
      if (repository === undefined) return undefined;
      return options.tickets?.[`${repository.fullName}#${String(number)}`];
    },
    kick: (runId) => void kicked.push(runId),
    ...(options.maxBudgetUsd === undefined
      ? {}
      : { maxBudgetUsd: options.maxBudgetUsd }),
  });

  /** Saves a workflow the way the service does: only a document the validator accepts. */
  async function saveWorkflow(document: Record<string, unknown>) {
    const profiles = [
      { name: "worker", versions: [1], facts: { 1: { canPush: true } } },
      { name: "reviewer", versions: [1], facts: { 1: { canPush: false } } },
    ];
    const checked = validateWorkflow(
      document,
      createResolver({ profiles, environments: [{ name: "Python" }] }),
      { maxBudgetUsd: options.maxBudgetUsd ?? 100 },
    );
    if (!checked.valid)
      throw new Error(
        `the test workflow is invalid: ${JSON.stringify(checked.errors)}`,
      );
    const saved = await workflows.create(
      {
        name: String(document.name),
        document: JSON.stringify(document),
        createdBy: USER.id,
        projectId: project.id,
      },
      100,
    );
    if (!saved.ok) throw new Error("seeding failed");
    return saved.workflow;
  }

  const start = (
    workflowId: string,
    overrides: {
      /** The id of the trigger to start (#916); left out, the one that can be started. */
      trigger?: string;
      input?: Record<string, unknown>;
      clientRequestId?: string;
    } = {},
  ) =>
    service.start(USER, workflowId, {
      ...(overrides.trigger === undefined
        ? {}
        : { trigger: overrides.trigger }),
      input: overrides.input ?? { repo: "acme/widgets", topic: "caching" },
      clientRequestId: overrides.clientRequestId ?? "run-1",
    });

  let claimed = 0;
  /**
   * Ends the turn of the oldest job that waits, the way the queue ends a turn a runner reports: claims it, then completes it with the
   * report. Returns the job id. The engine is NOT told: a test calls `engine.jobEnded` (as the runner API's hook does) or lets the
   * sweep find it.
   */
  async function finishTurn(report: TurnReport = {}): Promise<string> {
    claimed += 1;
    const lease =
      report.claimed ??
      (await app.queue.claimNext("runner-a", ["implementer"]));
    if (lease === null) throw new Error("no turn waits for a runner");
    const head = report.headCommit === undefined ? sha("c") : report.headCommit;
    const result = {
      ok: report.ok ?? true,
      durationMs: 1000,
      commentUrl: null,
      errorCode: report.errorCode ?? null,
      errorMessage: null,
      logTail: "",
      logTruncated: false,
      usage:
        report.costUsd === null && report.tokens === undefined
          ? null
          : {
              model: null,
              promptTokens: report.tokens?.prompt ?? 1,
              completionTokens: report.tokens?.completion ?? 1,
              totalTokens:
                (report.tokens?.prompt ?? 1) + (report.tokens?.completion ?? 1),
              aiCalls: 1,
              fallbackUsed: false,
              costUsd:
                report.subscription !== undefined || report.costUsd === null
                  ? null
                  : (report.costUsd ?? 0.5),
              stoppedEarly: null,
              ...(report.subscription === undefined
                ? {}
                : {
                    costBasis: "subscription",
                    estimatedCostUsd: report.subscription.estimatedCostUsd,
                  }),
            },
      implementer: {
        baseCommit: sha("a"),
        headCommit: head,
        pushed: report.pushed ?? true,
        commits: (report.commits ?? (head === null ? [] : [head])).map(
          (commit) => ({ sha: commit, subject: "Work" }),
        ),
        filesChanged: [],
        summary: "Done.",
        opencode: { sessionId: `ses_${String(claimed)}`, version: "1.19.0" },
        ...(report.agentResult === undefined
          ? {}
          : { agentResult: report.agentResult }),
        ...(report.agentAsk === undefined ? {} : { agentAsk: report.agentAsk }),
      },
    };
    const outcome =
      report.ok === false
        ? {
            ok: false as const,
            errorCode: report.errorCode ?? "unknown",
            result,
          }
        : { ok: true as const, result };
    // The app takes a subscription from the harness of the step's profile, never from the report: the step of such a report has it.
    if (
      report.subscription !== undefined &&
      report.subscription.onlyClaimed === undefined
    )
      await h.db
        .updateTable("implementer_turns")
        .set({ profile_harness: "claude-code" })
        .where("job_id", "=", lease.job.id)
        .execute();
    const done = await app.queue.complete(
      lease.job.id,
      lease.leaseToken,
      outcome,
    );
    if (done.status !== "completed")
      throw new Error(`the turn was not completed: ${done.status}`);
    return lease.job.id;
  }

  /** Claims the oldest turn that waits, the way a runner does: it runs, and a test reports it later (`finishTurn({ claimed })`). */
  async function claimTurn() {
    const lease = await app.queue.claimNext("runner-a", ["implementer"]);
    if (lease === null) throw new Error("no turn waits for a runner");
    return lease;
  }

  return {
    ...app,
    workspaceId,
    claimTurn,
    workflows,
    members,
    runs,
    environments,
    turnReader,
    implementerService: app.service,
    engine,
    service,
    kicked,
    engineLines,
    environment: environment.environment,
    project,
    saveWorkflow,
    start,
    finishTurn,
    now,
    advanceClock(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
    /** The run and its steps, straight from the tables. */
    async stateOf(runId: string) {
      const run = await runs.getRun(runId);
      if (run === undefined) throw new Error("no such run");
      return { run, steps: await runs.listSteps(runId) };
    },
    /** The jobs that wait for a runner, oldest first. */
    async waitingJobs() {
      return h.db
        .selectFrom("jobs")
        .select(["id", "status"])
        .where("status", "in", ["queued"])
        .orderBy("created_at")
        .execute();
    },
  };
}

export type EngineHarness = Awaited<ReturnType<typeof startEngineHarness>>;
