// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// Pins the runs filter: it writes the filter into the query string of the page and it takes the
// filter back from the server, so the controls follow a reset or the Back button without a remount key.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  pathname: "/w/acme/runs",
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigation.push, replace: navigation.replace }),
  usePathname: () => navigation.pathname,
}));

import { RunsFilterToolbar } from "./runs-filter.tsx";

afterEach(cleanup);

beforeEach(() => {
  navigation.push.mockClear();
});

const projects = [
  { id: "repo-1", name: "acme/widgets" },
  { id: "repo-2", name: "acme/gadgets" },
];

describe("the runs filter", () => {
  // #175-T01
  it("applies the filter through the query string of the page", async () => {
    const user = userEvent.setup();
    render(
      <RunsFilterToolbar
        workspaceSlug="acme"
        filter={{}}
        projects={projects}
      />,
    );

    await user.click(screen.getByLabelText("Project"));
    await user.click(
      await screen.findByRole("option", { name: "acme/widgets" }),
    );

    expect(navigation.push).toHaveBeenCalledWith(
      "/w/acme/runs?view=agents&repository=repo-1",
      { scroll: false },
    );
  });

  // #1078-T50: with the capability `implementer` the page opens on the Lane runs tab, so a filter chosen on the Agent runs tab has to say
  // `view=agents`, or it lands on the other tab.
  it("keeps the Agent runs tab when a filter is picked or cleared", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <RunsFilterToolbar
        workspaceSlug="acme"
        filter={{}}
        projects={projects}
      />,
    );

    await user.click(screen.getByLabelText("Status"));
    await user.click(await screen.findByRole("option", { name: "Failed" }));
    expect(navigation.push).toHaveBeenLastCalledWith(
      "/w/acme/runs?view=agents&status=failed",
      { scroll: false },
    );

    rerender(
      <RunsFilterToolbar
        workspaceSlug="acme"
        filter={{ repositoryId: "repo-1", status: "failed" }}
        projects={projects}
      />,
    );
    await user.click(screen.getByLabelText("Status"));
    await user.click(
      await screen.findByRole("option", { name: "All statuses" }),
    );
    expect(navigation.push).toHaveBeenLastCalledWith(
      "/w/acme/runs?view=agents&repository=repo-1",
      { scroll: false },
    );

    await user.click(screen.getByLabelText("Project"));
    await user.click(
      await screen.findByRole("option", { name: "All projects" }),
    );
    expect(navigation.push).toHaveBeenLastCalledWith(
      "/w/acme/runs?view=agents&status=failed",
      { scroll: false },
    );
  });

  // The toolbar labels its two controls visibly and gives them a 44px touch target.
  it("labels both controls visibly and gives them a 44px target", () => {
    render(
      <RunsFilterToolbar
        workspaceSlug="acme"
        filter={{}}
        projects={projects}
      />,
    );

    const project = screen.getByRole("combobox", { name: "Project" });
    const status = screen.getByRole("combobox", { name: "Status" });
    expect(screen.getByText("Project")).toBeTruthy();
    expect(screen.getByText("Status")).toBeTruthy();
    expect(project.className).toContain("min-h-11");
    expect(status.className).toContain("min-h-11");
  });

  // #175-T01
  it("carries both filters and offers a reset that drops them", () => {
    render(
      <RunsFilterToolbar
        workspaceSlug="acme"
        filter={{ repositoryId: "repo-2", status: "failed" }}
        projects={projects}
      />,
    );

    expect(
      screen.getByRole("link", { name: "Reset filter" }).getAttribute("href"),
    ).toBe("/w/acme/runs?view=agents");
  });

  // #175-T01
  it("moves the controls with the filter it is handed, without a remount key", () => {
    const { rerender } = render(
      <RunsFilterToolbar
        workspaceSlug="acme"
        filter={{}}
        projects={projects}
      />,
    );
    expect(screen.getByLabelText("Project").textContent).toContain(
      "All projects",
    );
    expect(screen.getByLabelText("Status").textContent).toContain(
      "All statuses",
    );

    rerender(
      <RunsFilterToolbar
        workspaceSlug="acme"
        filter={{ repositoryId: "repo-1", status: "failed" }}
        projects={projects}
      />,
    );

    expect(screen.getByLabelText("Project").textContent).toContain(
      "acme/widgets",
    );
    expect(screen.getByLabelText("Status").textContent).toContain("Failed");
  });
});
