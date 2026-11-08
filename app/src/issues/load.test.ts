// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it, vi } from "vitest";
import { TrackerError } from "../tracker/errors.ts";
import { builtInLaneDocument } from "../workflows/built-in-lanes.ts";
import { loadIssuesPage } from "./load.ts";
import { ticketList, ticket } from "./test-fixtures.ts";

function deps(
  overrides: {
    project?: boolean;
    listIssues?: () => Promise<ReturnType<typeof ticketList>>;
    get?: (id: string) => Promise<unknown>;
  } = {},
) {
  const listIssues = vi.fn(
    overrides.listIssues ?? (async () => ticketList([ticket(1)])),
  );
  const list = vi.fn(async () => ({
    workflows: [
      { id: "wf-1", name: "Issue to PR", archivedAt: null },
      { id: "wf-old", name: "Old", archivedAt: "2026-11-01T00:00:00.000Z" },
      { id: "wf-broken", name: "Broken", archivedAt: null },
    ],
    maximum: 100,
  }));
  const get = vi.fn(
    overrides.get ??
      (async (id: string) => {
        if (id === "wf-broken") throw new Error("unreadable");
        return { document: builtInLaneDocument("issue-to-pr", "node") };
      }),
  );
  return {
    listIssues,
    list,
    get,
    deps: {
      projects: {
        findProject: async () =>
          overrides.project === false
            ? { project: null }
            : { project: { id: "p-1" } },
      },
      tracker: { listIssues },
      workflows: { list, get },
    } as unknown as Parameters<typeof loadIssuesPage>[1],
  };
}

describe("loading the Issues tab", () => {
  // #925-T16
  it("reads the tickets of the repository, open and closed, and the lanes that can start from an issue", async () => {
    const { deps: wired, listIssues, list, get } = deps();

    const data = await loadIssuesPage("repo-1", wired);

    expect(data.projectId).toBe("p-1");
    expect(data.initial?.items.map((item) => item.number)).toEqual([1]);
    expect(listIssues).toHaveBeenCalledWith("repo-1", {
      state: "all",
      limit: 200,
      offset: 0,
    });
    expect(list).toHaveBeenCalledWith("p-1");
    // The archived lane is not read; the one that cannot be read is left out.
    expect(get.mock.calls.map((call) => call[0])).toEqual([
      "wf-1",
      "wf-broken",
    ]);
    expect(data.lanes.map((lane) => lane.workflowId)).toEqual(["wf-1"]);
  });

  // #925-T17
  it("has no list and no lane for a repository that is no project", async () => {
    const { deps: wired, listIssues } = deps({ project: false });

    expect(await loadIssuesPage("repo-1", wired)).toEqual({
      projectId: null,
      initial: null,
      lanes: [],
    });
    expect(listIssues).not.toHaveBeenCalled();
  });

  // #925-T18
  it("has no list when the tickets are not mirrored, but still offers the lanes", async () => {
    const { deps: wired } = deps({
      listIssues: async () => {
        throw new TrackerError("TRACKER_PROJECT_NOT_ACTIVE", "not active");
      },
    });

    const data = await loadIssuesPage("repo-1", wired);

    expect(data.initial).toBeNull();
    expect(data.lanes).toHaveLength(1);
  });

  // #925-T19
  it("lets a failure that is no refusal of the mirror through", async () => {
    const { deps: wired } = deps({
      listIssues: async () => {
        throw new Error("database down");
      },
    });

    await expect(loadIssuesPage("repo-1", wired)).rejects.toThrow(
      "database down",
    );
  });
});
