// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the project list and the settings pages in a real browser, against a production build
// next to the fake GitHub: a person syncs the repositories of an installation, switches one on,
// changes a review setting and finds it after a reload, sees the cost warning of a pricey model, and
// changes the global defaults that a project without its own value then follows. The details of each
// piece (copy, validation, the routes) are proven as component and integration tests.
import { expect, test } from "@playwright/test";
import { syncFromGithubAsAdmin } from "../helpers/admin-api";
import {
  addGithubAccount,
  addGithubInstallation,
  GITHUB_APP_OWNER_ACCOUNT,
  signInThroughTheForm,
  type GithubAccount,
} from "../helpers/github-fake";
import { e2eEnv } from "../helpers/e2e-env";
import { chooseOption, openSection } from "../helpers/settings-form";

const account: GithubAccount = {
  id: 7300002,
  login: "projects-journey",
  name: "Projects Journey",
  email: "projects-journey@example.test",
};
const REPOSITORY = "projects-journey/widgets";

// One repository, switched on in the first journey and used by the ones after it.
test.describe.configure({ mode: "serial" });

test.describe("the project list and the settings pages", () => {
  test.beforeAll(async ({ request }) => {
    await addGithubAccount(request, account);
    await addGithubInstallation(
      request,
      {
        id: 9100001,
        account: GITHUB_APP_OWNER_ACCOUNT,
      },
      [{ id: 9200001, fullName: REPOSITORY }],
    );
  });

  // The global defaults are shared by every spec of the run: put them back as they were found.
  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage({ baseURL: e2eEnv.appUrl });
    await signInThroughTheForm(page, account);
    const response = await page.request.put("/api/w/default/review-settings", {
      data: { settings: {} },
    });
    expect(response.status()).toBe(200);
    await page.close();
  });

  // CR-34-T14, CR-24-T12
  test("@smoke a person syncs the repository, switches it on, changes a setting, reloads and finds it, and switches it off again", async ({
    page,
  }) => {
    // The installation is found by the synchronization of the whole instance, which is the instance admin's
    // (it sits on the App's own account, so it is attached to the one workspace). The person here owns the
    // workspace and does not run the instance: their page has the button that reads their own connections.
    await syncFromGithubAsAdmin(e2eEnv.appUrl);
    await signInThroughTheForm(page, account);
    await expect(
      page.getByRole("heading", { level: 1, name: "Projects" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Sync from GitHub" }),
    ).toBeVisible();

    const row = page.getByRole("row").filter({ hasText: REPOSITORY });
    await expect(row.getByText("Inactive")).toBeVisible();

    await row.getByRole("switch", { name: `Review ${REPOSITORY}` }).click();
    await expect(row.getByText("Active", { exact: true })).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("row").filter({ hasText: REPOSITORY }).getByRole("switch"),
    ).toHaveAttribute("aria-checked", "true");

    await page.getByRole("link", { name: REPOSITORY, exact: true }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: REPOSITORY }),
    ).toBeVisible();
    await page
      .getByLabel("Most findings per review", { exact: true })
      .fill("12");
    await page.getByRole("button", { name: "Save review settings" }).click();
    await expect(page.getByRole("status")).toContainText("Saved.");
    await page.reload();
    await expect(
      page.getByLabel("Most findings per review", { exact: true }),
    ).toHaveValue("12");

    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Projects" })
      .click();
    const again = page.getByRole("row").filter({ hasText: REPOSITORY });
    await again.getByRole("switch", { name: `Review ${REPOSITORY}` }).click();
    await expect(again.getByText("Inactive")).toBeVisible();
    await page.reload();
    await expect(
      page
        .getByRole("row")
        .filter({ hasText: REPOSITORY })
        .getByText("Inactive"),
    ).toBeVisible();
  });

  // #103-IB-13
  test("@smoke a person who owns the workspace runs the Sync from GitHub button and reads their own connections", async ({
    page,
  }) => {
    await signInThroughTheForm(page, account);

    await page.getByRole("button", { name: "Sync from GitHub" }).click();

    await expect(page.getByRole("status")).toContainText(
      "No new repositories.",
    );
    await expect(
      page.getByRole("row").filter({ hasText: REPOSITORY }),
    ).toBeVisible();
  });

  // #101-WM-08
  test("the instance admin, who is an Owner of the workspace too, runs the same button there", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel("Email address").fill(e2eEnv.adminEmail);
    await page.getByLabel("Password").fill(e2eEnv.adminPassword);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/w\/default\/projects$/);

    await page.getByRole("button", { name: "Sync from GitHub" }).click();
    await expect(page.getByRole("status")).toContainText(/repositor/);
  });

  // CR-34-T14
  test("a person who picks a pricey model sees the cost warning, still saves and sees it again after a reload", async ({
    page,
  }) => {
    await signInThroughTheForm(page, account);
    await page.getByRole("link", { name: REPOSITORY, exact: true }).click();

    await openSection(page, "LLM");
    await chooseOption(page, "Model", "anthropic/claude-sonnet-5.5");
    await openSection(page, "Limits");
    await expect(
      page.getByText(/is above the warning level of \$0\.10/),
    ).toBeVisible();
    await page.getByRole("button", { name: "Save review settings" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Saved." }),
    ).toBeVisible();
    await page.reload();

    await openSection(page, "LLM");
    await expect(page.getByRole("combobox", { name: "Model" })).toHaveText(
      "anthropic/claude-sonnet-5.5",
    );
    await openSection(page, "Limits");
    await expect(
      page.getByText(/is above the warning level of \$0\.10/),
    ).toBeVisible();
  });

  // #666-T06
  test("a person sets a cost limit per review, finds it and its wording after a reload, and takes it away again", async ({
    page,
  }) => {
    await signInThroughTheForm(page, account);
    await page.getByRole("link", { name: REPOSITORY, exact: true }).click();
    await openSection(page, "Limits");
    const limit = () =>
      page
        .getByLabel("Cost limit per review (USD)", { exact: true })
        .filter({ visible: true });
    const field = () => page.locator("[data-field]", { has: limit() });

    await expect(field()).toContainText(
      "A review stops when it reaches this amount, at most $1.00.",
    );
    // #689: an empty field means up to the maximum, and the field says so.
    await expect(limit()).toHaveAttribute("placeholder", "Max $1.00");
    // A limit above the maximum is refused with the maximum named, and nothing is saved.
    await limit().fill("2");
    await page.getByRole("button", { name: "Save review settings" }).click();
    await expect(field()).toContainText(
      "The maximum cost per review is $1.00. Enter that or less.",
    );
    await limit().fill("0.75");
    await page.getByRole("button", { name: "Save review settings" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Saved." }),
    ).toBeVisible();
    await page.reload();

    await openSection(page, "Limits");
    await expect(limit()).toHaveValue("0.75");
    await expect(page.getByText(/the limit is \$0\.75/)).toBeVisible();

    await limit().fill("");
    await page.getByRole("button", { name: "Save review settings" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Saved." }),
    ).toBeVisible();
    await page.reload();
    await openSection(page, "Limits");
    await expect(limit()).toHaveValue("");
  });

  // CR-34-T14
  test("a person changes a global default and the project they opened before, which has no value of its own for it, shows the new one", async ({
    page,
  }) => {
    await signInThroughTheForm(page, account);
    // The project page is visited first: Next keeps it mounted (hidden) while the person is
    // elsewhere and shows it again later, which must not bring back the old value.
    await page.getByRole("link", { name: REPOSITORY, exact: true }).click();
    await openSection(page, "Limits");
    const budget = () =>
      page
        .getByLabel("Cost limit per review (USD)", { exact: true })
        .filter({ visible: true });
    await expect(budget()).toHaveValue("");
    await expect(
      page
        .locator("[data-field]", { has: budget() })
        .getByText("Built-in value"),
    ).toBeVisible();

    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Settings", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { level: 1, name: "General" }),
    ).toBeVisible();
    // The review defaults are their own sub-page (#178).
    await page
      .getByRole("link", { name: "Review defaults", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Review defaults" }),
    ).toBeVisible();
    await openSection(page, "Limits");
    await budget().fill("0.60");
    await page.getByRole("button", { name: "Save review defaults" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Saved." }),
    ).toBeVisible();
    // No reload here: it would drop the pages Next keeps mounted, which is what this step is about.
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Projects" })
      .click();
    await page.getByRole("link", { name: REPOSITORY, exact: true }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: REPOSITORY }),
    ).toBeVisible();
    await openSection(page, "Limits");
    await expect(budget()).toHaveValue("0.60");
    await expect(
      page
        .locator("[data-field]", { has: budget() })
        .getByText("Global default"),
    ).toBeVisible();
    await page.reload();
    await openSection(page, "Limits");
    await expect(budget()).toHaveValue("0.60");
  });

  // CR-34-T09, #101-WM-08, #104-LK-13
  test("the Settings page tells the Owner that the LLM is not configured and where to add a key, and nothing of the server's variables, in a browser too", async ({
    page,
    browser,
  }) => {
    await signInThroughTheForm(page, account);

    await page.getByRole("link", { name: "Settings", exact: true }).click();
    // The page left behind stays in the document, hidden, with its own copy of the hint.
    await expect(
      page.getByRole("heading", { level: 1, name: "General" }),
    ).toBeVisible();

    // The workspace has no key: the hint links to the LLM sub-page, where an Owner fills the form.
    await expect(
      page.getByText("LLM not configured").filter({ visible: true }),
    ).toBeVisible();
    await page
      .getByRole("link", { name: "Add a key in the settings" })
      .filter({ visible: true })
      .click();
    await expect(page).toHaveURL(/\/w\/default\/settings\/llm$/);
    await expect(
      page.getByRole("form", { name: "OpenRouter LLM key" }),
    ).toBeVisible();
    await expect(page.getByText(/LLM_API_KEY|GITHUB_APP/)).toHaveCount(0);

    // The instance admin no longer reads about a missing server variable: the key is the workspace's.
    const context = await browser.newContext({ baseURL: e2eEnv.appUrl });
    const admin = await context.newPage();
    await admin.goto("/login");
    await admin.getByLabel("Email address").fill(e2eEnv.adminEmail);
    await admin.getByLabel("Password").fill(e2eEnv.adminPassword);
    await admin.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(admin).toHaveURL(/\/w\/default\/projects$/);
    await admin.goto("/w/default/settings");
    await expect(
      admin.getByRole("heading", { level: 1, name: "General" }),
    ).toBeVisible();
    await expect(admin.getByText("LLM key missing")).toHaveCount(0);
    await context.close();
  });

  test.describe("on a narrow window", () => {
    test.use({ viewport: { width: 375, height: 812 } });

    test("the project list and a settings form do not scroll sideways", async ({
      page,
    }) => {
      await signInThroughTheForm(page, account);
      await expect(
        page.getByRole("row").filter({ hasText: REPOSITORY }),
      ).toBeVisible();
      const overflow = () =>
        page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        );
      expect(await overflow()).toBeLessThanOrEqual(0);

      await page.getByRole("link", { name: REPOSITORY, exact: true }).click();
      await openSection(page, "Limits");
      await expect(
        page.getByLabel("Cost limit per review (USD)", { exact: true }),
      ).toBeVisible();

      expect(await overflow()).toBeLessThanOrEqual(0);
    });
  });

  // #655: the Review column holds the switch and the play button side by side; at the widths of a
  // small laptop and a tablet, in both colour schemes, they stay inside their cell and the table
  // does not need a sideways scroll.
  for (const width of [1024, 768]) {
    for (const colorScheme of ["light", "dark"] as const) {
      test.describe(`at ${String(width)}px, ${colorScheme}`, () => {
        test.use({ viewport: { width, height: 800 }, colorScheme });

        test("the switch and the play button fit the Review column", async ({
          page,
        }, testInfo) => {
          await signInThroughTheForm(page, account);
          const row = page.getByRole("row").filter({ hasText: REPOSITORY });
          await expect(row).toBeVisible();
          const cell = row.getByRole("cell").last();
          const play = cell.getByRole("button", {
            name: `Start a review of ${REPOSITORY}`,
          });
          await expect(play).toBeVisible();
          await expect(cell.getByRole("switch")).toBeVisible();

          const [cellBox, playBox, switchBox] = await Promise.all([
            cell.boundingBox(),
            play.boundingBox(),
            cell.getByRole("switch").boundingBox(),
          ]);
          expect(cellBox).not.toBeNull();
          expect(playBox).not.toBeNull();
          expect(switchBox).not.toBeNull();
          const right = (box: typeof cellBox) =>
            (box?.x ?? 0) + (box?.width ?? 0);
          expect(right(playBox)).toBeLessThanOrEqual(right(cellBox));
          expect(right(switchBox)).toBeLessThanOrEqual((playBox?.x ?? 0) + 1);
          // One line: the two controls sit side by side.
          expect(
            Math.abs((playBox?.y ?? 0) - (switchBox?.y ?? 0)),
          ).toBeLessThan(24);

          // The page never scrolls sideways; the table itself fits at 1024px and scrolls inside its
          // card (not the page) on a narrower window.
          const sideways = await page.evaluate(() => ({
            page:
              document.documentElement.scrollWidth >
              document.documentElement.clientWidth,
            table: (() => {
              const container = document.querySelector(
                '[data-slot="table-container"]',
              );
              return container
                ? container.scrollWidth > container.clientWidth
                : false;
            })(),
          }));
          expect(sideways.page).toBe(false);
          expect(sideways.table).toBe(width < 1024);
          await page.screenshot({
            path: testInfo.outputPath(
              `projects-${String(width)}-${colorScheme}.png`,
            ),
          });
        });
      });
    }
  }
});
