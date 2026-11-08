// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The frame of a project's cockpit (#925): the repository as the title with its state, the trail back to the projects, and the five tabs
// of the factory as links with the current one marked. The tabs' contents show the empty states of the prototype where the data comes later.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectRowView } from "./list-view.ts";
import { ProjectCockpit } from "./project-cockpit.tsx";
import { LanesTab, type LaneRow, TicketSourceCard } from "./project-tabs.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ROW: ProjectRowView = {
  repositoryId: "repo-1",
  projectId: "p-1",
  fullName: "acme/widgets",
  url: "https://github.com/acme/widgets",
  installation: "acme",
  status: "active",
  switchedOn: true,
  lastRun: null,
};

describe("the cockpit frame", () => {
  // #925
  it("has the title, the state, the trail and the five tabs of the factory as links, the current one marked", () => {
    render(
      <ProjectCockpit workspaceSlug="acme" row={ROW} tab="lanes">
        <p>content</p>
      </ProjectCockpit>,
    );

    expect(
      screen.getByRole("heading", { level: 1, name: "acme/widgets" }),
    ).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(
      within(screen.getByRole("navigation", { name: "breadcrumb" }))
        .getByRole("link", { name: "Projects" })
        .getAttribute("href"),
    ).toBe("/w/acme/projects");
    const tabs = within(screen.getByRole("navigation", { name: "Project" }));
    expect(
      tabs
        .getAllByRole("link")
        .map((link) => [
          link.textContent,
          link.getAttribute("href"),
          link.getAttribute("aria-current"),
        ]),
    ).toEqual([
      ["Issues", "/w/acme/projects/repo-1", null],
      ["ToDos", "/w/acme/projects/repo-1/todos", null],
      ["Runs", "/w/acme/projects/repo-1/runs", null],
      ["Lanes", "/w/acme/projects/repo-1/lanes", "page"],
      ["Setup", "/w/acme/projects/repo-1/setup", null],
    ]);
    expect(screen.getByText("content")).toBeTruthy();
  });

  // #925
  it("shows the number of open ToDos of the project on its ToDos tab, from the route of the sidebar's badge", async () => {
    const fetchMock = vi.fn(
      async (url: string) =>
        ({
          ok: true,
          json: async () => ({ open: 5, projects: { "p-1": 3, "p-2": 2 } }),
          url,
        }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ProjectCockpit workspaceSlug="acme" row={ROW} tab="">
        <p>content</p>
      </ProjectCockpit>,
    );

    expect(
      within(await screen.findByRole("link", { name: /ToDos/ })).getByText("3"),
    ).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/w/acme/todos/count");
  });

  // #925
  it("shows no number on the ToDos tab of a repository that is not a project yet", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ProjectCockpit
        workspaceSlug="acme"
        row={{ ...ROW, projectId: null }}
        tab=""
      >
        <p>content</p>
      </ProjectCockpit>,
    );

    expect(
      within(screen.getByRole("link", { name: /ToDos/ })).queryByText(/\d/),
    ).toBeNull();
  });
});

describe("the tabs", () => {
  // #925
  it("lists the lanes of the workspace with a link to each and a hint that they are shared", () => {
    const lane: LaneRow = {
      id: "wf-1",
      name: "issue-to-pr",
      version: 2,
      updatedAt: "2026-11-02T10:00:00.000Z",
    };
    render(<LanesTab workspaceSlug="acme" lanes={[lane]} />);

    expect(
      screen.getByRole("link", { name: "issue-to-pr" }).getAttribute("href"),
    ).toBe("/w/acme/workflows/wf-1");
    expect(screen.getByText(/starts from a label on a ticket/)).toBeTruthy();
    expect(
      screen.queryByRole("link", { name: "All lanes of the workspace" }),
    ).toBeNull();
    expect(
      screen.getByRole("link", { name: "send a task" }).getAttribute("href"),
    ).toBe("/w/acme/implementer");
  });

  // #925
  it("says there are no lanes yet", () => {
    render(<LanesTab workspaceSlug="acme" lanes={[]} />);

    expect(screen.getByText("No lanes yet")).toBeTruthy();
    expect(
      screen.queryByRole("link", { name: "All lanes of the workspace" }),
    ).toBeNull();
  });

  // #925
  it("shows the ticket source card in its own words, with the state of the repository", () => {
    const { rerender } = render(<TicketSourceCard row={ROW} />);

    expect(screen.getByText("GitHub issues")).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText("acme/widgets")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "acme/widgets on GitHub" })
        .getAttribute("href"),
    ).toBe("https://github.com/acme/widgets");

    rerender(<TicketSourceCard row={{ ...ROW, status: "unavailable" }} />);
    expect(screen.getByText("Unavailable")).toBeTruthy();
  });
});
