// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it, vi } from "vitest";
import { IntegrationError } from "../integrations/errors.ts";
import type { Integration } from "../integrations/types.ts";
import { TrackerError } from "./errors.ts";
import { createFakeTrackerRepository } from "./fake-tracker-repository.ts";
import { createTrackerService, ticketRefOf } from "./service.ts";

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
    repositoryActive?: boolean;
    integration?: Partial<Integration> | undefined;
    sync?: () => Promise<never>;
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

  const summarizeTickets = vi.fn(async (refs: readonly string[]) =>
    refs.includes(ticketRefOf("acme/widgets", 1))
      ? [
          {
            ticketRef: ticketRefOf("acme/widgets", 1),
            spentMicroUsd: 1_234_567,
            activeRun: {
              runId: "run-1",
              workflowName: "Implement",
              stepId: "review",
              status: "running" as const,
            },
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
        options.project === false ? undefined : ({ id: "p-1" } as never),
    },
    tracker,
    runs: { summarizeTickets },
    sync: { run: options.sync ?? run },
  });
  return { service, run, summarizeTickets, tracker };
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
      checksState: null,
      updatedAt: "2026-11-06T10:01:00.000Z",
      syncedAt: expect.any(String),
      url: "https://github.com/acme/widgets/issues/1",
      lane: {
        runId: "run-1",
        name: "Implement",
        step: "review",
        status: "running",
      },
      costUsd: 1.234567,
    });
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
