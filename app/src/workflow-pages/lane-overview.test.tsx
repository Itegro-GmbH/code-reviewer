// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The lane page shows the lane as it is saved and nothing to edit (#1107, ADR 0007): name and description, the project, the triggers and
// the versions with who saved them and what each changed; version 1 says the lane's description, a version saved before change
// descriptions says so neutrally. Nothing on the page edits the lane.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LaneRunListView } from "../workflow-runs/lane-run-list.ts";
import { WorkflowError } from "../workflows/errors.ts";
import type { WorkflowView } from "../workflows/service.ts";
import { LaneOverview } from "./lane-overview.tsx";
import { loadWorkflowPage } from "./pages.tsx";
import { PAGE_COPY } from "./messages.ts";

afterEach(cleanup);

const RUNS = {
  runs: [],
  laneNodes: {},
  nextCursor: null,
  now: "",
} as LaneRunListView;

const DOC_V1 = {
  version: 1,
  name: "Issue to PR",
  description: "Implements a ticket and opens a pull request.",
  triggers: [{ id: "by-hand", kind: "manual", steps: [] }],
  steps: [],
};
const DOC_V3 = {
  ...DOC_V1,
  description: "Implements a ticket, has it reviewed and opens a pull request.",
  triggers: [
    { id: "by-hand", kind: "manual", steps: [] },
    { id: "label", kind: "ticket.labeled", label: "ready", steps: [] },
  ],
};

function view(over: Partial<WorkflowView> = {}): WorkflowView {
  return {
    id: "wf-1",
    projectId: "project-1",
    name: "Issue to PR",
    version: 3,
    createdAt: "2026-11-04T08:00:00.000Z",
    updatedAt: "2026-11-06T09:00:00.000Z",
    archivedAt: null,
    documentVersion: 3,
    document: DOC_V3,
    versions: [
      {
        version: 3,
        savedAt: "2026-11-06T09:00:00.000Z",
        savedBy: "user-2",
        changeDescription: "Added the label trigger.",
      },
      {
        version: 2,
        savedAt: "2026-11-05T09:00:00.000Z",
        savedBy: "user-1",
        changeDescription: null,
      },
      {
        version: 1,
        savedAt: "2026-11-04T08:00:00.000Z",
        savedBy: "user-1",
        changeDescription: null,
      },
    ],
    ...over,
  };
}

function deps(workflow: WorkflowView, first: unknown = DOC_V1) {
  const get = vi.fn(async (_id: string, version?: number) => {
    if (version === 1)
      return { ...workflow, documentVersion: 1, document: first };
    return workflow;
  });
  return {
    get,
    options: {
      workflows: { get },
      runs: { listWorkspace: async () => RUNS },
      projects: {
        listProjects: async () =>
          [
            {
              repository: { id: "repo-9", fullName: "acme/widgets" },
              project: { id: "project-1", active: true },
              status: "active",
            },
          ] as never,
      },
      authors: {
        list: async () => [
          { userId: "user-1", name: "Ada" },
          { userId: "user-2", name: "Grace" },
        ],
      },
    },
  };
}

async function pageOf(workflow: WorkflowView, first?: unknown) {
  const { options } = deps(workflow, first);
  const page = await loadWorkflowPage("wf-1", options);
  if (page.kind !== "ready") throw new Error("not ready");
  return page;
}

describe("loadWorkflowPage", () => {
  // #1107-T10
  it("reads the description, the project, the triggers and the versions of the saved lane", async () => {
    const page = await pageOf(view());

    expect(page.lane.description).toBe(
      "Implements a ticket, has it reviewed and opens a pull request.",
    );
    expect(page.lane.project).toEqual({
      name: "acme/widgets",
      repositoryId: "repo-9",
    });
    expect(page.lane.triggers).toHaveLength(2);
    expect(page.lane.triggers[0]).toContain("By hand");
    expect(page.lane.triggers[1]).toContain("ready");
    expect(page.lane.readable).toBe(true);
    expect(page.lane.versions.map((row) => row.version)).toEqual([3, 2, 1]);
  });

  // #1107-T11
  it("names the author by member name and leaves one who is no member any more unnamed", async () => {
    const { options } = deps(view());
    const page = await loadWorkflowPage("wf-1", {
      ...options,
      authors: { list: async () => [{ userId: "user-2", name: "Grace" }] },
    });
    if (page.kind !== "ready") throw new Error("not ready");

    expect(page.lane.versions.map((row) => row.author)).toEqual([
      "Grace",
      null,
      null,
    ]);
  });

  // #1107-T12
  it("gives version 1 the lane's description as version 1 said it, and a later version its change description", async () => {
    const page = await pageOf(view());

    const [three, two, one] = page.lane.versions;
    expect(three?.text).toBe("Added the label trigger.");
    expect(two?.text).toBeNull();
    expect(one?.text).toBe("Implements a ticket and opens a pull request.");
  });

  // #1107-T13
  it("reads version 1 from the lane itself when version 1 is the current one, and survives a lane that lost it", async () => {
    const only = view({
      version: 1,
      documentVersion: 1,
      document: DOC_V1,
      versions: [view().versions[2]!],
    });
    const { get, options } = deps(only);
    await loadWorkflowPage("wf-1", options);
    expect(get).toHaveBeenCalledTimes(1);

    const lost = deps(view());
    lost.get.mockImplementation(async (_id: string, version?: number) => {
      if (version === 1)
        throw new WorkflowError(
          "WORKFLOW_VERSION_NOT_FOUND",
          "The workflow has no such version.",
        );
      return view();
    });
    const page = await loadWorkflowPage("wf-1", lost.options);
    if (page.kind !== "ready") throw new Error("not ready");
    expect(page.lane.versions[2]?.text).toBeNull();
  });

  // #1107-T14
  it("is a lane page without a project name or author names when the services are left out", async () => {
    const { options } = deps(view());
    const page = await loadWorkflowPage("wf-1", {
      workflows: options.workflows,
      runs: options.runs,
    });
    if (page.kind !== "ready") throw new Error("not ready");

    expect(page.lane.project).toBeNull();
    expect(page.lane.versions.every((row) => row.author === null)).toBe(true);
  });

  // #1107-T15
  it("marks a saved document that is no lane as unreadable instead of failing", async () => {
    const page = await pageOf(view({ document: "not a lane" }), "not a lane");

    expect(page.lane.readable).toBe(false);
    expect(page.lane.description).toBeNull();
    expect(page.lane.triggers).toEqual([]);
  });
});

describe("LaneOverview", () => {
  // #1107-T20
  it("shows the description, the project, the triggers and every version with its author and change description", async () => {
    const page = await pageOf(view());

    render(
      <LaneOverview
        workspaceSlug="acme"
        data={page.lane}
        current={3}
        archived={false}
      />,
    );

    expect(
      screen.getByText(
        "Implements a ticket, has it reviewed and opens a pull request.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "acme/widgets" }).getAttribute("href"),
    ).toBe("/w/acme/projects/repo-9");
    const items = within(
      screen.getByRole("list", { name: "Versions" }),
    ).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]?.textContent).toContain("Version 3 · current");
    expect(items[0]?.textContent).toContain("2026-11-06 09:00 UTC");
    expect(items[0]?.textContent).toContain("Grace");
    expect(items[0]?.textContent).toContain("Added the label trigger.");
    expect(items[1]?.textContent).toContain("Ada");
    expect(items[2]?.textContent).toContain(
      `${PAGE_COPY.versionFirst} Implements a ticket and opens a pull request.`,
    );
  });

  // #1107-T21
  it("says neutrally that a version saved before change descriptions has none", async () => {
    const page = await pageOf(view());

    render(
      <LaneOverview
        workspaceSlug="acme"
        data={page.lane}
        current={3}
        archived={false}
      />,
    );

    const second = screen
      .getAllByRole("listitem")
      .find((item) => item.getAttribute("data-version") === "2");
    expect(second?.textContent).toContain(PAGE_COPY.versionNoChangeDescription);
  });

  // #1107-T22
  it("has nothing to edit: no form field, no save, no builder", async () => {
    const page = await pageOf(view());

    const { container } = render(
      <LaneOverview
        workspaceSlug="acme"
        data={page.lane}
        current={3}
        archived
      />,
    );

    expect(
      container.querySelectorAll("input, textarea, select, button"),
    ).toHaveLength(0);
    expect(screen.queryByText(/Save as/)).toBeNull();
    expect(screen.getByText(PAGE_COPY.laneArchived)).toBeTruthy();
  });

  // #1107-T23
  it("shows text from the lane as text, never as markup", async () => {
    const page = await pageOf(
      view({
        versions: [
          {
            version: 2,
            savedAt: "2026-11-06T09:00:00.000Z",
            savedBy: "user-1",
            changeDescription: "<img src=x onerror=alert(1)> **bold**",
          },
          view().versions[2]!,
        ],
      }),
    );

    const { container } = render(
      <LaneOverview
        workspaceSlug="acme"
        data={page.lane}
        current={2}
        archived={false}
      />,
    );

    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain(
      "<img src=x onerror=alert(1)> **bold**",
    );
  });
});
