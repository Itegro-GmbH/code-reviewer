// SPDX-License-Identifier: LicenseRef-Proprietary

// The factory in a real browser (#951): every page of the factory is opened once and does its main action once, against a production build of
// the factory product (the capability `implementer`) next to the fake GitHub. Nothing real is reached: no model, no Dispatcher, no runner.
// The tickets of the project are the mirror the sync would have written and the run that waits for an answer is what a turn of an agent that
// asked leaves behind (src/test-support/e2e-factory-child.ts, through the real repositories); the project and the lane are made through the
// routes of the app. The details of each page (copy, validation, the routes) are proven as component and integration tests; this is the proof
// that the pages are wired together and open at all.
import { expect, test, type Page } from "@playwright/test";
import { syncFromGithubAsAdmin } from "../helpers/admin-api";
import { e2eEnv } from "../helpers/e2e-env";
import {
  addGithubIssue,
  LANE_DOCUMENT,
  mirrorTickets,
  repositoryIdOf,
  seedWaitingRun,
  signInAsFactoryAdmin,
} from "../helpers/factory";
import {
  addGithubInstallation,
  GITHUB_APP_OWNER_ACCOUNT,
} from "../helpers/github-fake";

const REPOSITORY = "factory-journey/widgets";
const QUESTION = "Which database should the cache use?";

// The journey builds on itself: the lane is started on the first ticket, discarded on the run page, and the question of the second ticket is
// answered from the ToDos page.
test.describe.configure({ mode: "serial" });

test.describe("the pages of the factory", () => {
  let repositoryId = "";
  let laneId = "";
  let waitingRunId = "";
  // The address of the run the lane made on the first issue.
  let startedRunPath = "";

  const projectPath = (segment = "") =>
    `/w/default/projects/${repositoryId}${segment === "" ? "" : `/${segment}`}`;

  async function openProject(page: Page, segment = "") {
    await signInAsFactoryAdmin(page);
    await page.goto(projectPath(segment));
  }

  test.beforeAll(async ({ request }) => {
    // One sync and three child processes that load the repositories: on a loaded CI runner that can take longer than a test's default.
    test.setTimeout(180_000);
    await addGithubInstallation(
      request,
      { id: 9100051, account: GITHUB_APP_OWNER_ACCOUNT },
      [{ id: 9200051, fullName: REPOSITORY }],
    );
    // The two issues of the project, at GitHub: a lane that starts on one reads it there, and the answer is written below the other.
    await addGithubIssue(request, REPOSITORY, {
      number: 1,
      title: "Cache the build",
      body: "The build is slow.",
    });
    await addGithubIssue(request, REPOSITORY, {
      number: 2,
      title: "Choose the database",
      body: "We need a store.",
    });
    await syncFromGithubAsAdmin(e2eEnv.factoryAppUrl);
    repositoryId = await repositoryIdOf(REPOSITORY);

    await signInAsFactoryAdmin(request);
    const project = await request.post("/api/w/default/projects", {
      data: { repositoryId },
    });
    expect(project.status(), await project.text()).toBe(201);
    const { project: made } = (await project.json()) as {
      project: { id: string };
    };
    const lane = await request.post(
      `/api/w/default/workflows?projectId=${made.id}`,
      { data: LANE_DOCUMENT },
    );
    expect(lane.status(), await lane.text()).toBe(201);
    laneId = ((await lane.json()) as { workflow: { id: string } }).workflow.id;

    await mirrorTickets(REPOSITORY, [
      { number: 1, title: "Cache the build", body: "The build is slow." },
      {
        number: 2,
        title: "Choose the database",
        body: "We need a store.",
        labels: ["agent implement"],
      },
      { number: 3, title: "Update the readme", type: "Task" },
    ]);
    waitingRunId = await seedWaitingRun({
      repository: REPOSITORY,
      workflowId: laneId,
      ticket: 2,
      question: QUESTION,
      options: ["SQLite", "Postgres"],
      context: "The cache has to survive a restart.",
    });
  });

  // #951
  test("@smoke the Issues tab shows the mirror, opens an issue, and starts a lane from the start dialog", async ({
    page,
  }) => {
    await openProject(page);
    const board = page.getByRole("table", { name: "Issues" });
    await expect(board.getByRole("row")).toHaveCount(4);
    // The issue that waits for an answer says so, and the drawer shows it in GitHub's own words.
    await expect(
      page.getByRole("link", { name: "Answer the question on issue #2" }),
    ).toBeVisible();
    await board.getByRole("button", { name: /Update the readme/ }).click();
    const drawer = page.getByRole("dialog");
    await expect(
      drawer.getByText("Details of this issue, in GitHub's own words."),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();

    await page
      .getByRole("button", { name: "Start a lane on issue #1" })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Start a lane on issue #1",
    });
    await expect(
      dialog.getByRole("radio", { name: LANE_DOCUMENT.name }),
    ).toBeChecked();
    await dialog.getByRole("button", { name: "Start", exact: true }).click();

    // The run is made and its page opens.
    await expect(page).toHaveURL(
      new RegExp(`/w/default/workflows/${laneId}/runs/[^/]+$`),
    );
    startedRunPath = new URL(page.url()).pathname;
    expect(startedRunPath).not.toContain(waitingRunId);
  });

  // #951
  test("@smoke the run page discards the run", async ({ page }) => {
    await signInAsFactoryAdmin(page);
    await page.goto(startedRunPath);
    await page.getByRole("button", { name: "Discard this run" }).click();
    await expect(
      page.getByText(
        "Discarded: no longer active, nothing counts against the ticket.",
      ),
    ).toBeVisible();
  });

  // #951
  test("@smoke the ToDos page answers the question of the waiting run", async ({
    page,
  }) => {
    await signInAsFactoryAdmin(page);
    await page.goto("/w/default/todos");
    await page
      .getByRole("list", { name: "Open ToDos" })
      .getByRole("button")
      .first()
      .click();
    const panel = page.getByRole("complementary");
    await expect(panel.getByText(QUESTION)).toBeVisible();
    await panel.getByRole("radio", { name: /Postgres/ }).check();
    await panel.getByRole("button", { name: "Answer", exact: true }).click();
    await expect(
      panel.getByText("The answer went to the agent as a new turn"),
    ).toBeVisible();
    await expect(page.getByText("Done · 1")).toBeVisible();
  });

  // #951
  test("@smoke the lane builder saves a version with one value from the picker", async ({
    page,
  }) => {
    await openProject(page, "lanes");
    await page
      .getByRole("table", { name: "Lanes" })
      .getByRole("link", { name: LANE_DOCUMENT.name })
      .click();
    // The only step of the lane is open in the inspector.
    await expect(page.getByRole("region", { name: "Inspector" })).toBeVisible();
    await page
      .getByRole("button", { name: "Insert a value into body" })
      .click();
    const picker = page.getByRole("dialog", { name: "Values for body" });
    await picker
      .getByRole("option")
      .and(page.locator('[data-reference="trigger.ticket.title"]'))
      .click();
    await page.getByRole("button", { name: "Save as v2" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();

    // The version is the one the route holds now: the picker's value is in the saved text.
    const saved = await page.request.get(`/api/w/default/workflows/${laneId}`);
    expect(saved.status()).toBe(200);
    const { workflow } = (await saved.json()) as {
      workflow: {
        version: number;
        document: { steps: Array<{ body?: string }> };
      };
    };
    expect(workflow.version).toBe(2);
    expect(workflow.document.steps[0]?.body).toContain(
      "{{trigger.ticket.title}}",
    );
  });

  // #951
  test("@smoke the tabs of the project open: ToDos, Runs, Lanes and Setup", async ({
    page,
  }) => {
    await openProject(page);
    const tabs = page.getByRole("navigation", { name: "Project" });
    for (const name of ["ToDos", "Runs", "Lanes", "Setup"]) {
      await tabs.getByRole("link", { name }).click();
      await expect(tabs.getByRole("link", { name })).toHaveAttribute(
        "aria-current",
        "page",
      );
    }
    // The Setup tab shows the one ticket source of the project.
    await expect(
      page.getByRole("heading", { name: "Ticket source" }),
    ).toBeVisible();
    await expect(
      page.getByText("GitHub issues", { exact: true }),
    ).toBeVisible();
  });

  // #951
  test("@smoke Profiles, Runners and Settings open from the sidebar", async ({
    page,
  }) => {
    await signInAsFactoryAdmin(page);
    await page.goto("/w/default/todos");
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav.getByRole("link")).toHaveText([
      /^ToDos/,
      "Projects",
      "Runs",
      "Profiles",
      "Runners",
      "Settings",
    ]);

    await nav.getByRole("link", { name: "Profiles" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Profiles" }),
    ).toBeVisible();
    await nav.getByRole("link", { name: "Runners" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Runners" }),
    ).toBeVisible();
    await nav.getByRole("link", { name: "Settings" }).click();
    const sections = page.getByRole("navigation", {
      name: "Settings sections",
    });
    for (const name of ["Integrations", "Members"]) {
      await sections.getByRole("link", { name, exact: true }).click();
      await expect(
        sections.getByRole("link", { name, exact: true }),
      ).toHaveAttribute("aria-current", "page");
    }
  });
});
