// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The trail of the project page starts at the QA area under the name its product gives it (#757): Projects for
// code-review.com, QA for the factory. The address of the area stays /projects in both.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { identityFor } from "../../product-identity/identities.ts";
import type { ProjectRowView } from "./list-view.ts";
import { ProjectPageHeader } from "./project-page-header.tsx";

afterEach(cleanup);

const ROW: ProjectRowView = {
  repositoryId: "repo-1",
  fullName: "acme/widgets",
  url: "https://github.com/acme/widgets",
  installation: "acme",
  status: "active",
  switchedOn: true,
  lastRun: null,
};

function trail() {
  return within(screen.getByRole("navigation", { name: "breadcrumb" }));
}

describe("the header of the project page", () => {
  // #757-T01
  it("starts the trail at Projects for code-review.com", () => {
    render(
      <ProjectPageHeader
        product={identityFor("code-review-com")}
        workspaceSlug="acme"
        row={ROW}
      />,
    );

    expect(
      trail().getByRole("link", { name: "Projects" }).getAttribute("href"),
    ).toBe("/w/acme/projects");
    expect(trail().queryByText("QA")).toBeNull();
  });

  // #757-T02
  it("starts the trail at QA for the factory, on the same address", () => {
    render(
      <ProjectPageHeader
        product={identityFor("factory")}
        workspaceSlug="acme"
        row={ROW}
      />,
    );

    expect(trail().getByRole("link", { name: "QA" }).getAttribute("href")).toBe(
      "/w/acme/projects",
    );
    expect(trail().queryByText("Projects")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "acme/widgets",
    );
  });
});
