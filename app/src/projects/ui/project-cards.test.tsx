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

import type { ProjectsApi } from "./api.ts";
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
  function fakeApi() {
    const setActive = vi.fn<ProjectsApi["setActive"]>(async (repositoryId) => ({
      ok: true,
      data: { repositoryId, projectId: "p1", active: true, changed: true },
    }));
    const api: ProjectsApi = { setActive, sync: vi.fn<ProjectsApi["sync"]>() };
    return { api, setActive };
  }

  // #925
  it("offers the repositories that are no project yet as the ticket source, and the board disabled with its hint", async () => {
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
      within(dialog).getByText("Boards come with the ticket source."),
    ).toBeTruthy();
  });

  // #925
  it("switches the chosen repository on and opens its cockpit", async () => {
    const user = userEvent.setup();
    const { api, setActive } = fakeApi();
    render(
      <NewProjectDialog
        workspaceSlug="acme"
        choices={[{ repositoryId: "repo-2", fullName: "acme/api" }]}
        api={api}
      />,
    );
    await user.click(screen.getByRole("button", { name: "New project" }));
    const dialog = screen.getByRole("dialog", { name: "New project" });
    const create = within(dialog).getByRole("button", {
      name: "Create and read from GitHub",
    });
    expect((create as HTMLButtonElement).disabled).toBe(true);

    await user.selectOptions(
      within(dialog).getByLabelText("Ticket source (one)"),
      "repo-2",
    );
    await user.click(create);

    await waitFor(() => expect(setActive).toHaveBeenCalledWith("repo-2", true));
    await waitFor(() =>
      expect(navigation.push).toHaveBeenCalledWith("/w/acme/projects/repo-2"),
    );
  });

  // #925
  it("says what went wrong and stays open when the route refuses", async () => {
    const user = userEvent.setup();
    const api: ProjectsApi = {
      setActive: async () => ({
        ok: false,
        status: 503,
        code: "NETWORK_ERROR",
        issues: [],
      }),
      sync: vi.fn<ProjectsApi["sync"]>(),
    };
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
      "repo-2",
    );
    await user.click(
      within(dialog).getByRole("button", {
        name: "Create and read from GitHub",
      }),
    );

    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    expect(navigation.push).not.toHaveBeenCalled();
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
