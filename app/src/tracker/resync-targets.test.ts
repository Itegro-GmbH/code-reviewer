// SPDX-License-Identifier: LicenseRef-Proprietary

// Which projects the nightly resync walks (#932): the active projects of the workspaces whose installation is active, each read through
// the repositories of its own workspace.
import { describe, expect, it, vi } from "vitest";
import type { ProjectListEntry } from "../db/repositories/projects-repository.ts";
import { listResyncTargets } from "./resync-targets.ts";

function entry(
  id: string,
  overrides: {
    status?: ProjectListEntry["status"];
    integrationStatus?: ProjectListEntry["repository"]["integration"]["status"];
  } = {},
): ProjectListEntry {
  return {
    repository: {
      id,
      externalId: `ext-${id}`,
      fullName: `acme/${id}`,
      url: `https://github.com/acme/${id}`,
      available: true,
      integration: {
        id: `i-of-${id}`,
        type: "github_app",
        displayName: "Acme",
        status: overrides.integrationStatus ?? "active",
      },
    },
    project: null,
    status: overrides.status ?? "active",
  };
}

function setup(
  projects: Record<string, ProjectListEntry[] | Error>,
  integrations: { workspaceId: string; status: string }[],
) {
  const listProjects = vi.fn(async (workspaceId: string) => {
    const found = projects[workspaceId];
    if (found instanceof Error) throw found;
    return found ?? [];
  });
  const getSyncState = vi.fn(
    async (workspaceId: string, repositoryId: string) =>
      repositoryId === "r-synced"
        ? {
            repositoryId,
            projectId: null,
            cursor: null,
            startedAt: null,
            lastFullSyncAt: "2026-11-06T03:00:00.000Z",
            updatedAt: "2026-11-06T03:01:00.000Z",
          }
        : repositoryId === "r-cut"
          ? {
              repositoryId,
              projectId: null,
              cursor: '{"phase":"issues","page":2}',
              startedAt: "2026-11-06T03:00:00.000Z",
              lastFullSyncAt: null,
              updatedAt: "2026-11-06T03:04:00.000Z",
            }
          : undefined,
  );
  const logFailure = vi.fn();
  const run = () =>
    listResyncTargets({
      integrations: async () => integrations as never,
      projectsOf: listProjects,
      syncStateOf: getSyncState,
      logFailure,
    });
  return { run, listProjects, getSyncState, logFailure };
}

describe("the projects of the nightly resync", () => {
  // #932-T30
  it("lists the active projects of active installations, and leaves out the others", async () => {
    const { run } = setup(
      {
        "w-1": [
          entry("r-active"),
          entry("r-off", { status: "inactive" }),
          entry("r-suspended", { integrationStatus: "disabled" }),
        ],
        "w-2": [entry("r-other")],
      },
      [
        { workspaceId: "w-1", status: "active" },
        { workspaceId: "w-2", status: "active" },
        { workspaceId: "w-3", status: "disabled" },
      ],
    );

    const targets = await run();

    expect(targets.map((t) => [t.workspaceId, t.repositoryId])).toEqual([
      ["w-1", "r-active"],
      ["w-2", "r-other"],
    ]);
  });

  // #932-T31
  it("reads the projects and the sync state through the workspace of each project, once per workspace", async () => {
    const { run, listProjects, getSyncState } = setup(
      { "w-1": [entry("r-1"), entry("r-2")], "w-2": [entry("r-3")] },
      [
        { workspaceId: "w-1", status: "active" },
        // Two installations of one workspace: the workspace is listed once.
        { workspaceId: "w-1", status: "active" },
        { workspaceId: "w-2", status: "active" },
      ],
    );

    await run();

    expect(listProjects.mock.calls.map(([w]) => w)).toEqual(["w-1", "w-2"]);
    expect(getSyncState.mock.calls).toEqual([
      ["w-1", "r-1"],
      ["w-1", "r-2"],
      ["w-2", "r-3"],
    ]);
  });

  // #932-T32
  it("goes on with the other workspaces when one cannot be read, and logs it by its id", async () => {
    const { run, logFailure } = setup(
      {
        "w-1": new Error("postgres://user:password@host/db"),
        "w-2": [entry("r-3")],
      },
      [
        { workspaceId: "w-1", status: "active" },
        { workspaceId: "w-2", status: "active" },
      ],
    );

    const targets = await run();

    expect(targets.map((t) => t.repositoryId)).toEqual(["r-3"]);
    expect(logFailure).toHaveBeenCalledTimes(1);
    const line = String(logFailure.mock.calls[0]?.[0]);
    expect(line).toContain("workspace=w-1");
    expect(line).not.toContain("password");
  });

  // #932-T33
  it("says when a project was last attempted and whether its last sync did not end", async () => {
    const { run } = setup(
      { "w-1": [entry("r-synced"), entry("r-cut"), entry("r-new")] },
      [{ workspaceId: "w-1", status: "active" }],
    );

    const targets = await run();

    expect(targets).toEqual([
      expect.objectContaining({
        repositoryId: "r-synced",
        integrationId: "i-of-r-synced",
        lastAttemptAt: "2026-11-06T03:01:00.000Z",
        unfinished: false,
      }),
      expect.objectContaining({
        repositoryId: "r-cut",
        lastAttemptAt: "2026-11-06T03:04:00.000Z",
        unfinished: true,
      }),
      expect.objectContaining({
        repositoryId: "r-new",
        lastAttemptAt: null,
        unfinished: false,
      }),
    ]);
  });
});
