// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The projects page of the factory (#925): one card per repository with the ticket source in GitHub's own words and the numbers that
// have no data yet shown as "–", a link to the cockpit, the empty state with the way to the GitHub App, and the "New project" dialog
// that turns a repository into a project.
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigation.push, refresh: () => undefined }),
}));

import type { NewProjectApi } from "./api.ts";
import type { ProjectRowView } from "./list-view.ts";
import { NewProjectDialog } from "./new-project-dialog.tsx";
import { ProjectCards } from "./project-cards.tsx";

afterEach(() => {
  cleanup();
  navigation.push.mockReset();
});

function row(overrides: Partial<ProjectRowView> = {}): ProjectRowView {
  return {
    repositoryId: "repo-1",
    projectId: "p-1",
    fullName: "acme/widgets",
    url: "https://github.com/acme/widgets",
    installation: "acme",
    status: "active",
    switchedOn: true,
    lastRun: null,
    ...overrides,
  };
}

describe("the project cards", () => {
  // #925
  it("shows a card per repository with its name, its ticket source and a dash for what needs the ticket source", () => {
    render(
      <ProjectCards
        workspaceSlug="acme"
        canConnect
        view={{
          rows: [row(), row({ repositoryId: "repo-2", fullName: "acme/api" })],
        }}
      />,
    );

    expect(
      screen.getByRole("heading", { level: 2, name: "All projects · 2" }),
    ).toBeTruthy();
    const card = screen.getByRole("link", { name: /acme\/widgets/ });
    expect(card.getAttribute("href")).toBe("/w/acme/projects/repo-1");
    expect(within(card).getByText("Issues of acme/widgets")).toBeTruthy();
    expect(within(card).getByText("Open issues –")).toBeTruthy();
    expect(within(card).getByText("Lanes running –")).toBeTruthy();
    expect(within(card).getByText("Waits for you –")).toBeTruthy();
    expect(within(card).getByText("Active")).toBeTruthy();
  });

  // #925
  it("shows a card only for a repository that is switched on, and says so when none is", () => {
    const { rerender } = render(
      <ProjectCards
        workspaceSlug="acme"
        canConnect
        view={{
          rows: [
            row(),
            row({
              repositoryId: "repo-2",
              fullName: "acme/api",
              status: "inactive",
              switchedOn: false,
            }),
          ],
        }}
      />,
    );

    expect(
      screen.getByRole("heading", { level: 2, name: "All projects · 1" }),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: /acme\/api/ })).toBeNull();

    rerender(
      <ProjectCards
        workspaceSlug="acme"
        canConnect
        view={{ rows: [row({ status: "inactive", switchedOn: false })] }}
      />,
    );
    expect(screen.getByText("No project yet")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /acme\/widgets/ })).toBeNull();
  });

  // #925
  it("encodes the id of the repository in the address of the cockpit", () => {
    render(
      <ProjectCards
        workspaceSlug="acme"
        canConnect
        view={{ rows: [row({ repositoryId: "a b/c" })] }}
      />,
    );

    expect(
      screen.getByRole("link", { name: /acme\/widgets/ }).getAttribute("href"),
    ).toBe("/w/acme/projects/a%20b%2Fc");
  });

  // #925
  it("renders a hostile repository name as text", () => {
    render(
      <ProjectCards
        workspaceSlug="acme"
        canConnect
        view={{ rows: [row({ fullName: "<img src=x onerror=alert(1)>/x" })] }}
      />,
    );

    expect(document.querySelector("img")).toBeNull();
    expect(screen.getAllByText(/<img src=x/).length).toBeGreaterThan(0);
  });

  // #925
  it("leads to the GitHub App page of the settings when there is no repository", () => {
    render(
      <ProjectCards workspaceSlug="acme" canConnect view={{ rows: [] }} />,
    );

    expect(
      screen.getByRole("link", { name: "Connect GitHub" }).getAttribute("href"),
    ).toBe("/w/acme/settings/integrations");
  });
});

describe("the New project dialog", () => {
  const BOARDS = [
    {
      projectV2Id: "PVT_board1",
      number: 1,
      title: "Roadmap",
      hasStatusField: true,
      statuses: ["Todo", "Done"],
    },
    {
      projectV2Id: "PVT_board2",
      number: 2,
      title: "Loose list",
      hasStatusField: false,
      statuses: [],
    },
  ];

  function fakeApi(
    boards: ReturnType<NewProjectApi["boards"]> = Promise.resolve({
      ok: true,
      data: { available: true, boards: BOARDS },
    }),
  ) {
    const createProject = vi.fn<NewProjectApi["createProject"]>(
      async (body) => ({
        ok: true,
        data: {
          project: { id: "p1", repositoryId: body.repositoryId, active: true },
          lanes: body.lanes.map((key) => ({ key, ok: true, workflowId: key })),
        },
      }),
    );
    const boardsCall = vi.fn<NewProjectApi["boards"]>(() => boards);
    const api: NewProjectApi = { boards: boardsCall, createProject };
    return { api, createProject, boardsCall };
  }

  async function openAndChoose(
    api: NewProjectApi,
    repository = "repo-2",
  ): Promise<HTMLElement> {
    const user = userEvent.setup();
    render(
      <NewProjectDialog
        workspaceSlug="acme"
        choices={[{ repositoryId: "repo-2", fullName: "acme/api" }]}
        api={api}
      />,
    );
    await user.click(screen.getByRole("button", { name: "New project" }));
    const dialog = screen.getByRole("dialog", { name: "New project" });
    await user.selectOptions(
      within(dialog).getByLabelText("Ticket source (one)"),
      repository,
    );
    return dialog;
  }

  // #925
  it("offers the repositories that are no project yet as the ticket source, and the board disabled until one is chosen", async () => {
    const user = userEvent.setup();
    render(
      <NewProjectDialog
        workspaceSlug="acme"
        choices={[{ repositoryId: "repo-2", fullName: "acme/api" }]}
        api={fakeApi().api}
      />,
    );

    await user.click(screen.getByRole("button", { name: "New project" }));

    const dialog = screen.getByRole("dialog", { name: "New project" });
    const source = within(dialog).getByLabelText("Ticket source (one)");
    expect(
      within(source as HTMLElement)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual([
      "Choose a repository",
      "GitHub issues of acme/api",
      "Jira project (later)",
    ]);
    const board = within(dialog).getByLabelText("Board (optional)");
    expect((board as HTMLSelectElement).disabled).toBe(true);
    expect(
      within(dialog).getByText(
        "Choose a repository first: its boards are read from GitHub.",
      ),
    ).toBeTruthy();
  });

  // #922-T30
  it("reads the boards of the chosen repository and offers them, a board without a Status field disabled", async () => {
    const { api, boardsCall } = fakeApi();
    const dialog = await openAndChoose(api);

    const board = (await within(dialog).findByLabelText(
      "Board (optional)",
    )) as HTMLSelectElement;
    await waitFor(() => expect(board.disabled).toBe(false));

    expect(boardsCall).toHaveBeenCalledWith("repo-2");
    expect(
      within(board)
        .getAllByRole("option")
        .map((option) => [
          option.textContent,
          (option as HTMLOptionElement).disabled,
        ]),
    ).toEqual([
      ["None", false],
      ["#1 Roadmap", false],
      ["#2 Loose list (no Status field)", true],
    ]);
  });

  // #922-T31
  it("creates the project with the board and the built-in lanes that are ticked, and opens its cockpit", async () => {
    const user = userEvent.setup();
    const { api, createProject } = fakeApi();
    const dialog = await openAndChoose(api);
    const create = within(dialog).getByRole("button", {
      name: "Create and read from GitHub",
    });
    const board = (await within(dialog).findByLabelText(
      "Board (optional)",
    )) as HTMLSelectElement;
    await waitFor(() => expect(board.disabled).toBe(false));

    await user.selectOptions(board, "PVT_board1");
    await user.click(within(dialog).getByLabelText("Review a pull request"));
    await user.click(create);

    await waitFor(() =>
      expect(createProject).toHaveBeenCalledWith({
        repositoryId: "repo-2",
        board: { projectV2Id: "PVT_board1" },
        lanes: ["issue-to-pr"],
      }),
    );
    await waitFor(() =>
      expect(navigation.push).toHaveBeenCalledWith("/w/acme/projects/repo-2"),
    );
  });

  // #922-T32
  it("creates a project without a board when the repository has none, and with both lanes by default", async () => {
    const user = userEvent.setup();
    const { api, createProject } = fakeApi(
      Promise.resolve({ ok: true, data: { available: true, boards: [] } }),
    );
    const dialog = await openAndChoose(api);
    expect(
      await within(dialog).findByText(
        "This repository has no board. A project works without one.",
      ),
    ).toBeTruthy();

    await user.click(
      within(dialog).getByRole("button", {
        name: "Create and read from GitHub",
      }),
    );

    await waitFor(() =>
      expect(createProject).toHaveBeenCalledWith({
        repositoryId: "repo-2",
        board: null,
        lanes: ["issue-to-pr", "review-a-pull-request"],
      }),
    );
  });

  // #922-T33
  it("says the boards cannot be read when the App may not read them, and still creates a project", async () => {
    const { api } = fakeApi(
      Promise.resolve({ ok: true, data: { available: false, boards: [] } }),
    );
    const dialog = await openAndChoose(api);

    expect(
      await within(dialog).findByText(/did not let the App read the boards/),
    ).toBeTruthy();
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Create and read from GitHub",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  // #922-T34
  it("stays open and names the lanes that could not be copied, with the way to the project", async () => {
    const user = userEvent.setup();
    const { api, createProject } = fakeApi();
    createProject.mockResolvedValueOnce({
      ok: true,
      data: {
        project: { id: "p1", repositoryId: "repo-2", active: true },
        lanes: [
          { key: "issue-to-pr", ok: false, code: "WORKFLOW_INVALID" },
          { key: "review-a-pull-request", ok: true, workflowId: "w1" },
        ],
      },
    });
    const dialog = await openAndChoose(api);

    await user.click(
      within(dialog).getByRole("button", {
        name: "Create and read from GitHub",
      }),
    );

    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    expect(within(dialog).getByRole("alert").textContent).toContain(
      "Issue to PR",
    );
    expect(navigation.push).not.toHaveBeenCalled();
    await user.click(
      within(dialog).getByRole("button", { name: "Open the project" }),
    );
    expect(navigation.push).toHaveBeenCalledWith("/w/acme/projects/repo-2");
  });

  // #925
  it("says what went wrong and stays open when the route refuses", async () => {
    const user = userEvent.setup();
    const { api, createProject } = fakeApi();
    createProject.mockResolvedValueOnce({
      ok: false,
      status: 503,
      code: "NETWORK_ERROR",
      issues: [],
    });
    const dialog = await openAndChoose(api);
    await user.click(
      within(dialog).getByRole("button", {
        name: "Create and read from GitHub",
      }),
    );

    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    expect(navigation.push).not.toHaveBeenCalled();
  });

  // #925
  it("is disabled with the reason beside it when the GitHub App is not configured", () => {
    render(
      <NewProjectDialog
        workspaceSlug="acme"
        choices={[{ repositoryId: "repo-2", fullName: "acme/api" }]}
        blockedReason="The GitHub App is not configured."
        api={fakeApi().api}
      />,
    );

    const button = screen.getByRole("button", { name: "New project" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute("aria-describedby")).toBe(
      screen.getByText("The GitHub App is not configured.").id,
    );
  });

  // #925
  it("says every repository already is a project when there is none to choose", async () => {
    const user = userEvent.setup();
    render(
      <NewProjectDialog
        workspaceSlug="acme"
        choices={[]}
        api={fakeApi().api}
      />,
    );

    await user.click(screen.getByRole("button", { name: "New project" }));

    expect(
      screen.getByText(
        "Every repository of the GitHub App already is a project.",
      ),
    ).toBeTruthy();
  });
});
