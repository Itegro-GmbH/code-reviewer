// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The factory's Projects page hands the Jira connections of the workspace to the "New project" dialog (#1038): with one, the Jira project
// option is there to choose; without, it says to connect a site first.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: () => undefined }),
}));

import { describeConfigStatus } from "../../config-status/status.ts";
import { getProductIdentity } from "../../product-identity/current.ts";
import { testGithubAppStatus } from "../../test-support/github-app.ts";
import { ProjectsPageContent } from "./projects-page.tsx";

afterEach(cleanup);

async function openDialog(
  jiraConnections?: Parameters<
    typeof ProjectsPageContent
  >[0]["jiraConnections"],
) {
  const user = userEvent.setup();
  render(
    <ProjectsPageContent
      product={getProductIdentity()}
      workspaceSlug="acme"
      cards
      data={{
        list: {
          rows: [
            {
              repositoryId: "repo-2",
              projectId: null,
              fullName: "acme/api",
              url: null,
              installation: "acme",
              status: "inactive",
              switchedOn: false,
              lastRun: null,
            },
          ],
        },
        config: describeConfigStatus({}, testGithubAppStatus()),
      }}
      {...(jiraConnections === undefined ? {} : { jiraConnections })}
    />,
  );
  await user.click(screen.getByRole("button", { name: "New project" }));
  const dialog = screen.getByRole("dialog", { name: "New project" });
  return within(
    within(dialog).getByLabelText("Ticket source (one)"),
  ).getAllByRole("option");
}

describe("the Projects page and the Jira connections", () => {
  // #1038-T01
  it("offers the Jira project option to choose when the workspace has a connection", async () => {
    const options = await openDialog([
      {
        id: "conn-1",
        siteName: "acme",
        siteUrl: "https://acme.atlassian.net",
        broken: false,
      },
    ]);

    expect(
      options.map((option) => [
        option.textContent,
        (option as HTMLOptionElement).disabled,
      ]),
    ).toEqual([
      ["Choose a repository", false],
      ["GitHub issues of acme/api", false],
      ["Jira project", false],
    ]);
  });

  // #1038
  it("says to connect a site first when the workspace has none", async () => {
    const options = await openDialog();

    expect(
      options.map((option) => [
        option.textContent,
        (option as HTMLOptionElement).disabled,
      ]),
    ).toContainEqual([
      "Jira project (connect a Jira site in the settings first)",
      true,
    ]);
  });
});
