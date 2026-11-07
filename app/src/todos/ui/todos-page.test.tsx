// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The ToDos page (#925): the two lists of the prototype with their empty states.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TodosPageContent } from "./todos-page.tsx";

afterEach(cleanup);

describe("the ToDos page", () => {
  // #925
  it("has an Open and a Done list, empty until the answer flow exists, with the way to the projects", () => {
    render(<TodosPageContent workspaceSlug="acme" />);

    expect(
      screen.getByRole("heading", { level: 2, name: "Open · 0" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 2, name: "Done · 0" }),
    ).toBeTruthy();
    expect(screen.getByText("Nothing waits for you")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Open the projects" })
        .getAttribute("href"),
    ).toBe("/w/acme/projects");
    expect(
      screen.getByText(/Whoever answers first continues the run/),
    ).toBeTruthy();
  });
});
