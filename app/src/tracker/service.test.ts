// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it, vi } from "vitest";
import type {
  RunLaneProgress,
  TicketRunSummary,
} from "../db/repositories/workflow-runs-repository.ts";
import { IntegrationError } from "../integrations/errors.ts";
import type { Integration } from "../integrations/types.ts";
import { TrackerError } from "./errors.ts";
import { trackOf } from "../workflow-pages/run-track.ts";
import { createFakeTrackerRepository } from "./fake-tracker-repository.ts";
import {
  createTrackerService,
  ticketRefOf,
  type JiraMirrorSync,
} from "./service.ts";

const REPOSITORY = {
  id: "r-1",
  integrationId: "i-1",
  externalId: "7001",
  fullName: "acme/widgets",
  url: "https://github.com/acme/widgets",
  active: true,
};

async function setup(
  options: {
    project?: boolean;
    /** The board the project chose (#937). */
    board?: { projectV2Id: string; statusFieldId: string };
    repositoryActive?: boolean;
    /** The provider of the project's ticket source (#1038); GitHub unless said. */
    provider?: string;
    integration?: Partial<Integration> | undefined;
    sync?: () => Promise<never>;
    /** What reads a Jira project into the mirror (#1040); left out: the service is wired without Jira. */
    jira?: JiraMirrorSync;
  } = {},
) {
  const tracker = createFakeTrackerRepository();
  const write = (number: number, overrides: Record<string, unknown> = {}) =>
    tracker.upsertItem("r-1", {
      provider: "github",
      repo: "acme/widgets",
      number,
      nodeId: `N_${number}`,
      kind: "issue",
      state: "open",
      stateReason: null,
      type: null,
      title: `Ticket ${number}`,
      bodyExcerpt: "",
      labels: [],
      assignees: [],
      closes: [],
      updatedAt: `2026-11-06T10:0${number % 10}:00.000Z`,
      ...overrides,
    });
  await write(1);
  await write(2, { state: "closed", stateReason: "completed" });
  await write(3, { kind: "pull_request", closes: [1] });
  await tracker.linkPullRequests("r-1");
  await tracker.saveSyncState("r-1", {
    lastFullSyncAt: "2026-11-06T09:00:00.000Z",
  });

  const summarizeTickets = vi.fn(
    async (refs: readonly string[]): Promise<TicketRunSummary[]> =>
      refs.includes(ticketRefOf("acme/widgets", 1))
        ? [
            {
              ticketRef: ticketRefOf("acme/widgets", 1),
              spentMicroUsd: 1_234_567,
              activeRun: {
                runId: "run-1",
                workflowId: "wf-1",
                workflowName: "Implement",
                stepId: "review",
                status: "running" as const,
              },
            },
          ]
        : [],
  );
  const laneProgressOfRuns = vi.fn(
    async (runIds: readonly string[]): Promise<RunLaneProgress[]> =>
      runIds.includes("run-1")
        ? [
            {
              runId: "run-1",
              workflowId: "wf-1",
              workflowVersion: 1,
              triggerId: "by-hand",
              triggerKind: "manual" as const,
              steps: [
                {
                  stepId: "implement",
                  kind: "agent" as const,
                  status: "succeeded" as const,
                  round: 1,
                },
                {
                  stepId: "review",
                  kind: "agent" as const,
                  status: "running" as const,
                  round: 1,
                },
              ],
              document: JSON.stringify({
                triggers: [{ id: "by-hand", kind: "manual" }],
                steps: [
                  { id: "implement", kind: "agent", description: "Implement" },
                  { id: "review", kind: "agent", description: "Review" },
                ],
              }),
            },
          ]
        : [],
  );
  const run = vi.fn(async () => ({
    status: "done" as const,
    next: null,
    written: 3,
    removed: 0,
    skipped: 0,
    boardAvailable: true,
  }));
  const service = createTrackerService({
    repositories: {
      get: async (id) =>
        id === "r-1"
          ? ({
              ...REPOSITORY,
              active: options.repositoryActive ?? true,
            } as never)
          : undefined,
    },
    integrations: {
      get: async () =>
        options.integration === undefined && "integration" in options
          ? undefined
          : ({
              id: "i-1",
              status: "active",
              ...options.integration,
            } as Integration),
    },
    projects: {
      getActiveProjectForRepository: async () =>
        options.project === false
          ? undefined
          : ({
              id: "p-1",
              ticketSource: {
                provider: options.provider ?? "github",
                repositoryId: "r-1",
                board: options.board ?? null,
                ...(options.provider === "jira"
                  ? { connectionId: "conn-1", projectKey: "PROJ" }
                  : {}),
              },
            } as never),
    },
    tracker,
    runs: { summarizeTickets, laneProgressOfRuns },
    sync: { run: options.sync ?? run },
    ...(options.jira === undefined ? {} : { jira: options.jira }),
  });
  return { service, run, summarizeTickets, laneProgressOfRuns, tracker };
}

async function writeTicket(
  tracker: ReturnType<typeof createFakeTrackerRepository>,
  number: number,
  kind: "issue" | "pull_request",
  state: "open" | "closed",
  closes: number[],
  updatedAt: string,
) {
  await tracker.upsertItem("r-1", {
    provider: "github",
    repo: "acme/widgets",
    number,
    nodeId: `N_${number}`,
    kind,
    state,
    stateReason: null,
    type: null,
    title: `Ticket ${number}`,
    bodyExcerpt: "",
    labels: [],
    assignees: [],
    closes,
    updatedAt,
  });
}

const OPEN = { state: "open", limit: 100, offset: 0 } as const;

describe("the list of the tickets of a project's repository", () => {
  // #923-T54
  it("lists the open tickets with the run that is going on and what the runs spent, read at the time of the question", async () => {
    const { service, summarizeTickets } = await setup();

    const list = await service.listIssues("r-1", OPEN);

    expect(summarizeTickets).toHaveBeenCalledWith([
      "github:acme/widgets#3",
      "github:acme/widgets#1",
    ]);
    expect(list).toMatchObject({
      repositoryId: "r-1",
      repo: "acme/widgets",
      sync: { lastFullSyncAt: "2026-11-06T09:00:00.000Z", inProgress: false },
    });
    expect(list.items.map((item) => item.number)).toEqual([3, 1]);
    expect(list.items[1]).toEqual({
      key: "1",
      number: 1,
      kind: "issue",
      state: "open",
      stateReason: null,
      type: null,
      title: "Ticket 1",
      bodyExcerpt: "",
      labels: [],
      assignees: [],
      boardStatus: null,
      parentNumber: null,
      pullRequests: [3],
      pullRequestStates: { 3: "open" },
      checksState: null,
      updatedAt: "2026-11-06T10:01:00.000Z",
      syncedAt: expect.any(String),
      url: "https://github.com/acme/widgets/issues/1",
      lane: {
        runId: "run-1",
        workflowId: "wf-1",
        name: "Implement",
        step: "review",
        status: "running",
        // #1080-T01: the nodes of the lane version and the step summaries, for the board's track.
        nodes: [
          expect.objectContaining({ id: "implement", note: "Implement" }),
          expect.objectContaining({ id: "review", note: "Review" }),
        ],
        steps: [
          { id: "implement", kind: "agent", status: "succeeded", round: 1 },
          { id: "review", kind: "agent", status: "running", round: 1 },
        ],
      },
      costUsd: 1.234567,
    });
  });

  // #1080-T02
  it("reads the progress of all the active runs of the page in one call, and asks for no run when none is active", async () => {
    const { service, laneProgressOfRuns, summarizeTickets } = await setup();

    await service.listIssues("r-1", OPEN);

    expect(laneProgressOfRuns).toHaveBeenCalledTimes(1);
    expect(laneProgressOfRuns).toHaveBeenCalledWith(["run-1"]);

    laneProgressOfRuns.mockClear();
    summarizeTickets.mockResolvedValueOnce([]);
    await service.listIssues("r-1", OPEN);
    expect(laneProgressOfRuns).toHaveBeenCalledWith([]);
  });

  // #1080-T03
  it("shows no track for a run whose lane version cannot be read, and still names the lane", async () => {
    const { service, laneProgressOfRuns } = await setup();
    laneProgressOfRuns.mockResolvedValueOnce([
      {
        runId: "run-1",
        workflowId: "wf-1",
        workflowVersion: 1,
        triggerId: "by-hand",
        triggerKind: "manual" as const,
        steps: [],
        document: null as never,
      },
    ]);

    const list = await service.listIssues("r-1", OPEN);

    expect(list.items[1]?.lane).toMatchObject({
      name: "Implement",
      nodes: [],
      steps: [],
    });
  });

  // #1080-T04
  it("gives the board the nodes and steps of a run in a nested loop, with an onFailure step and a question that waits, so its track is the run page's", async () => {
    const { service, laneProgressOfRuns, summarizeTickets } = await setup();
    summarizeTickets.mockResolvedValueOnce([
      {
        ticketRef: ticketRefOf("acme/widgets", 1),
        spentMicroUsd: 0,
        activeRun: {
          runId: "run-1",
          workflowId: "wf-1",
          workflowName: "Nested",
          stepId: "work",
          status: "waiting" as const,
        },
      },
    ]);
    laneProgressOfRuns.mockResolvedValueOnce([
      {
        runId: "run-1",
        workflowId: "wf-nested",
        workflowVersion: 2,
        triggerId: "by-hand",
        triggerKind: "manual" as const,
        steps: [
          { stepId: "plan", kind: "agent", status: "succeeded", round: 1 },
          { stepId: "work", kind: "agent", status: "succeeded", round: 1 },
          { stepId: "deep", kind: "action", status: "succeeded", round: 1 },
          { stepId: "inner", kind: "loop", status: "succeeded", round: 1 },
          // the second round of the outer loop: the agent asks, and waits
          { stepId: "work", kind: "agent", status: "waiting", round: 2 },
          // a step of `onFailure` belongs to no node
          { stepId: "notify", kind: "action", status: "succeeded", round: 1 },
        ] as const,
        document: JSON.stringify({
          triggers: [{ id: "by-hand", kind: "manual" }],
          steps: [
            { id: "plan", kind: "agent" },
            {
              id: "outer",
              kind: "loop",
              maxRounds: 3,
              body: [
                { id: "work", kind: "agent" },
                {
                  id: "inner",
                  kind: "loop",
                  maxRounds: 2,
                  body: [{ id: "deep", kind: "action" }],
                },
              ],
            },
            { id: "ship", kind: "action", connector: "pr.merge" },
          ],
          onFailure: [{ id: "notify", kind: "action" }],
        }),
      },
    ]);

    const lane = (await service.listIssues("r-1", OPEN)).items[1]?.lane;

    expect(lane?.nodes.map((node) => node.id)).toEqual([
      "plan",
      "outer",
      "ship",
    ]);
    const track = trackOf(lane?.nodes ?? [], lane?.steps ?? [], "waiting");
    expect(
      track.steps.map((step) => [step.id, step.state, step.rounds]),
    ).toEqual([
      ["plan", "done", 1],
      // the outer loop has begun its second round, and its agent waits for the answer
      ["outer", "waiting", 2],
      ["ship", "not_reached", 1],
    ]);
    expect(track.current).toBe(1);
  });

  // #1080-T05
  it("parses the lane version once for every ticket on it and on the next poll", async () => {
    const { service, laneProgressOfRuns, summarizeTickets } = await setup();
    const document = JSON.stringify({
      triggers: [{ id: "by-hand", kind: "manual" }],
      steps: [{ id: "only", kind: "agent" }],
    });
    const progress = (runId: string) => ({
      runId,
      workflowId: "wf-shared",
      workflowVersion: 7,
      triggerId: "by-hand",
      triggerKind: "manual" as const,
      steps: [],
      document,
    });
    const active = (ref: string, runId: string) => ({
      ticketRef: ref,
      spentMicroUsd: 0,
      activeRun: {
        runId,
        workflowId: "wf-shared",
        workflowName: "Shared",
        stepId: "only",
        status: "running" as const,
      },
    });
    const both = [
      active(ticketRefOf("acme/widgets", 3), "run-3"),
      active(ticketRefOf("acme/widgets", 1), "run-1"),
    ];
    summarizeTickets.mockResolvedValue(both);
    laneProgressOfRuns.mockResolvedValue([
      progress("run-3"),
      progress("run-1"),
    ]);

    const first = await service.listIssues("r-1", OPEN);
    const second = await service.listIssues("r-1", OPEN);

    const nodes = first.items.map((item) => item.lane?.nodes);
    expect(nodes[0]).toHaveLength(1);
    expect(nodes[1]).toBe(nodes[0]);
    expect(second.items[0]?.lane?.nodes).toBe(nodes[0]);
  });

  // #1080-T06
  it("reads a lane version again when the same id names another document", async () => {
    const { service, laneProgressOfRuns, summarizeTickets } = await setup();
    const progress = (steps: string[]) => ({
      runId: "run-1",
      workflowId: "wf-edited",
      workflowVersion: 1,
      triggerId: "by-hand",
      triggerKind: "manual" as const,
      steps: [],
      document: JSON.stringify({
        triggers: [{ id: "by-hand", kind: "manual" }],
        steps: steps.map((id) => ({ id, kind: "agent" })),
      }),
    });
    summarizeTickets.mockResolvedValue([
      {
        ticketRef: ticketRefOf("acme/widgets", 1),
        spentMicroUsd: 0,
        activeRun: {
          runId: "run-1",
          workflowId: "wf-edited",
          workflowName: "Edited",
          stepId: null,
          status: "running" as const,
        },
      },
    ]);
    laneProgressOfRuns.mockResolvedValueOnce([progress(["a"])]);
    const one = await service.listIssues("r-1", OPEN);
    laneProgressOfRuns.mockResolvedValueOnce([progress(["a", "b"])]);
    const two = await service.listIssues("r-1", OPEN);

    expect(one.items[1]?.lane?.nodes.map((node) => node.id)).toEqual(["a"]);
    expect(two.items[1]?.lane?.nodes.map((node) => node.id)).toEqual([
      "a",
      "b",
    ]);
  });

  // #954
  it("tells the state of a linked pull request the page does not hold, from the mirror", async () => {
    const { service, tracker } = await setup();
    await writeTicket(
      tracker,
      4,
      "pull_request",
      "open",
      [6],
      "2026-11-01T10:04:00.000Z",
    );
    await writeTicket(
      tracker,
      5,
      "pull_request",
      "closed",
      [6],
      "2026-11-01T10:05:00.000Z",
    );
    await writeTicket(
      tracker,
      6,
      "issue",
      "open",
      [],
      "2026-11-06T10:06:00.000Z",
    );
    await tracker.linkPullRequests("r-1");

    // Only the newest ticket: its pull requests are not on the page.
    const list = await service.listIssues("r-1", {
      state: "open",
      limit: 1,
      offset: 0,
    });

    expect(list.items.map((item) => item.number)).toEqual([6]);
    expect(list.items[0]?.pullRequests).toEqual([4, 5]);
    expect(list.items[0]?.pullRequestStates).toEqual({
      4: "open",
      5: "closed",
    });
  });

  // #954
  it("leaves the state of a linked pull request out when the mirror does not hold it", async () => {
    const { service, tracker } = await setup();
    await writeTicket(
      tracker,
      7,
      "issue",
      "open",
      [],
      "2026-11-06T10:07:00.000Z",
    );
    await writeTicket(
      tracker,
      8,
      "pull_request",
      "open",
      [7],
      "2026-11-06T10:08:00.000Z",
    );
    await tracker.linkPullRequests("r-1");
    await tracker.deleteItem("r-1", 8, "2026-11-06T10:09:00.000Z");

    const list = await service.listIssues("r-1", OPEN);

    const seven = list.items.find((entry) => entry.number === 7);
    expect(seven?.pullRequests).toEqual([8]);
    expect(seven?.pullRequestStates).toEqual({});
  });

  // #923-T55
  it("has no lane and no cost for a ticket without a run, and the address of a pull request", async () => {
    const { service } = await setup();

    const list = await service.listIssues("r-1", OPEN);

    expect(list.items[0]).toMatchObject({
      number: 3,
      kind: "pull_request",
      lane: null,
      costUsd: 0,
      url: "https://github.com/acme/widgets/pull/3",
    });
  });

  // #923-T56
  it.each([
    ["closed", [2]],
    ["all", [3, 2, 1]],
  ] as const)("lists %s tickets", async (state, numbers) => {
    const { service } = await setup();

    const list = await service.listIssues("r-1", {
      state,
      limit: 100,
      offset: 0,
    });

    expect(list.items.map((item) => item.number)).toEqual(numbers);
  });

  // #923-T57
  it("pages the list", async () => {
    const { service } = await setup();

    const list = await service.listIssues("r-1", {
      state: "all",
      limit: 1,
      offset: 1,
    });

    expect(list.items.map((item) => item.number)).toEqual([2]);
  });

  // #923-T58
  it("says that a sync is under way", async () => {
    const { service, tracker } = await setup();
    await tracker.saveSyncState("r-1", {
      cursor: '{"phase":"issues","page":2}',
    });

    expect((await service.listIssues("r-1", OPEN)).sync.inProgress).toBe(true);
  });

  // #932-T21
  it("says when a row was last written, so that a sync with nothing delivered since can be told", async () => {
    const { service, tracker } = await setup();
    const { lastFullSyncAt, lastWriteAt } = (
      await service.listIssues("r-1", OPEN)
    ).sync;
    // The rows of the test were written after the sync it names: a delivery arrived since.
    expect(lastWriteAt).toEqual(expect.any(String));
    expect(lastWriteAt && lastFullSyncAt && lastWriteAt > lastFullSyncAt).toBe(
      true,
    );
    expect(lastWriteAt).toBe(await tracker.newestWriteAt("r-1"));

    tracker.clear();
    expect(await tracker.newestWriteAt("r-1")).toBeNull();
  });

  // #937-T60
  it("tells where the cache stands without reading a ticket, and refuses what the list refuses", async () => {
    const { service, summarizeTickets, tracker } = await setup();

    const sync = await service.syncState("r-1");

    expect(sync).toEqual((await service.listIssues("r-1", OPEN)).sync);
    expect(sync.lastFullSyncAt).toBe("2026-11-06T09:00:00.000Z");
    summarizeTickets.mockClear();
    await service.syncState("r-1");
    expect(summarizeTickets).not.toHaveBeenCalled();
    await tracker.saveSyncState("r-1", { cursor: '{"phase":"issues"}' });
    expect((await service.syncState("r-1")).inProgress).toBe(true);
    await expect(service.syncState("nope")).rejects.toMatchObject({
      code: "TRACKER_REPOSITORY_NOT_FOUND",
    });
    const off = await setup({ project: false });
    await expect(off.service.syncState("r-1")).rejects.toMatchObject({
      code: "TRACKER_PROJECT_NOT_ACTIVE",
    });
  });

  // #923-T59
  it.each([
    ["an id that is no repository", "nope", {}, "TRACKER_REPOSITORY_NOT_FOUND"],
    ["no id at all", "", {}, "TRACKER_REPOSITORY_NOT_FOUND"],
    [
      "a repository the platform does not list",
      "r-1",
      { repositoryActive: false },
      "TRACKER_REPOSITORY_NOT_FOUND",
    ],
    [
      "a repository without an active project",
      "r-1",
      { project: false },
      "TRACKER_PROJECT_NOT_ACTIVE",
    ],
  ])("refuses %s", async (_name, id, options, code) => {
    const { service } = await setup(options);

    await expect(service.listIssues(id, OPEN)).rejects.toMatchObject({ code });
    await expect(service.sync(id)).rejects.toBeInstanceOf(TrackerError);
  });
});

describe("the full sync of a repository", () => {
  // #923-T60
  it("runs the sync of the repository's integration with the budget it is given", async () => {
    const { service, run } = await setup();

    const progress = await service.sync("r-1", { maxPages: 2, deadline: 5 });

    expect(progress.status).toBe("done");
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ id: "i-1" }),
      expect.objectContaining({ id: "r-1", fullName: "acme/widgets" }),
      { maxPages: 2, deadline: 5 },
    );
  });

  // #937-T40
  it("hands the sync the board the project chose, and none when it chose none", async () => {
    const chosen = await setup({
      board: { projectV2Id: "PVT_1", statusFieldId: "PVTSSF_1" },
    });
    await chosen.service.sync("r-1", { maxPages: 2 });
    expect(chosen.run).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { maxPages: 2, boardId: "PVT_1" },
    );

    const none = await setup();
    await none.service.sync("r-1");
    expect(none.run).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      {},
    );
  });

  // #923-T61
  it.each(["disconnected", "disabled"] as const)(
    "does not ask GitHub for an installation that is %s",
    async (status) => {
      const { service, run } = await setup({ integration: { status } });

      await expect(service.sync("r-1")).rejects.toMatchObject({
        code: "TRACKER_INTEGRATION_UNAVAILABLE",
      });
      expect(run).not.toHaveBeenCalled();
    },
  );

  // #932-R23
  it("keeps the code of the platform's failure on the error, so that the nightly resync can tell a rate limit", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { service } = await setup({
      sync: async () => {
        throw new IntegrationError(
          "INTEGRATION_ACCESS_RATE_LIMITED",
          "GitHub rate limit reached.",
        );
      },
    });

    await expect(service.sync("r-1")).rejects.toMatchObject({
      code: "TRACKER_SYNC_FAILED",
      providerCode: "INTEGRATION_ACCESS_RATE_LIMITED",
    });
    error.mockRestore();
  });

  // #923-T62
  it("answers a failure of GitHub with one code and tells the log nothing but the code", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { service } = await setup({
      sync: async () => {
        throw Object.assign(new Error("token ghs_secret in the message"), {
          code: "INTEGRATION_ACCESS_UNAVAILABLE",
        });
      },
    });

    await expect(service.sync("r-1")).rejects.toMatchObject({
      code: "TRACKER_SYNC_FAILED",
    });
    expect(error.mock.calls.flat().join(" ")).not.toContain("ghs_secret");
    error.mockRestore();
  });
});

describe("a project whose tickets the mirror cannot read (#1038, #1040)", () => {
  // #1038
  it("neither lists, nor reads the state of, nor syncs the issues of its repository when no Jira sync is wired: those are not its tickets", async () => {
    const { service, run } = await setup({ provider: "jira" });

    for (const call of [
      () => service.listIssues("r-1", { state: "open", limit: 10, offset: 0 }),
      () => service.syncState("r-1"),
      () => service.sync("r-1"),
    ])
      await expect(call()).rejects.toMatchObject({
        code: "TRACKER_SOURCE_NOT_MIRRORED",
      });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("the tickets of a project on a Jira project (#1040)", () => {
  const jiraSync = (sync?: JiraMirrorSync["sync"]): JiraMirrorSync => ({
    siteUrlOf: async () => "https://acme.atlassian.net/",
    sync:
      sync ??
      (async () => ({
        status: "done" as const,
        next: null,
        written: 2,
        removed: 1,
        skipped: 0,
        boardAvailable: false,
      })),
  });

  // #1040-T04
  it("reads the project through its Jira connection, never through the installation or the GitHub sync", async () => {
    const calls: unknown[] = [];
    const { service, run } = await setup({
      provider: "jira",
      integration: undefined,
      jira: jiraSync(async (target, options) => {
        calls.push([target, options]);
        return {
          status: "done",
          next: null,
          written: 2,
          removed: 1,
          skipped: 0,
          boardAvailable: false,
        };
      }),
    });

    const progress = await service.sync("r-1", { resume: true });

    expect(progress).toMatchObject({ status: "done", written: 2, removed: 1 });
    expect(calls).toEqual([
      [
        {
          repositoryId: "r-1",
          repoFullName: "acme/widgets",
          connectionId: "conn-1",
          projectKey: "PROJ",
        },
        { resume: true },
      ],
    ]);
    expect(run).not.toHaveBeenCalled();
  });

  // #1040-T04
  it("lists the Jira issues with their key, their site address and the lane that is on them, by the ticket reference of the Jira provider", async () => {
    const { service, tracker, summarizeTickets } = await setup({
      provider: "jira",
      jira: jiraSync(),
    });
    await tracker.upsertItem("r-1", {
      provider: "jira",
      repo: "acme/widgets",
      key: "PROJ-7",
      number: 7,
      nodeId: "jira:10007",
      kind: "issue",
      state: "open",
      stateReason: null,
      type: "Task",
      title: "Jira issue",
      bodyExcerpt: "",
      labels: [],
      assignees: [],
      closes: [],
      updatedAt: "2026-11-14T10:00:00.000Z",
      boardStatus: "Ready for agent",
    });

    const list = await service.listIssues("r-1", {
      state: "open",
      limit: 10,
      offset: 0,
    });

    expect(list.provider).toBe("jira");
    const item = list.items.find((entry) => entry.key === "PROJ-7");
    expect(item).toMatchObject({
      key: "PROJ-7",
      number: 7,
      boardStatus: "Ready for agent",
      url: "https://acme.atlassian.net/browse/PROJ-7",
    });
    expect(summarizeTickets.mock.calls[0]?.[0]).toContain(
      "jira:acme/widgets#PROJ-7",
    );
  });

  // #1040-T04
  it("fails a sync Jira cannot do with the stable code of the failure and never what Jira said", async () => {
    const failure = Object.assign(new Error("secret detail"), {
      providerCode: "jira_unavailable",
    });
    const { service } = await setup({
      provider: "jira",
      jira: jiraSync(async () => {
        throw failure;
      }),
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const error = await service.sync("r-1").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TrackerError);
    expect(error).toMatchObject({
      code: "TRACKER_SYNC_FAILED",
      providerCode: "jira_unavailable",
    });
    expect(String((error as Error).message)).not.toContain("secret detail");
  });
});
