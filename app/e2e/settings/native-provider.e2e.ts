// SPDX-License-Identifier: LicenseRef-Proprietary

// A workspace on its own key uses a provider of the models.dev catalog for Dynamic Review, in a real browser (#555-T10): the
// Owner searches the providers on the LLM access page, saves a key for one that is neither OpenRouter nor Anthropic, picks its
// provider and one of its tool-calling models for Dynamic Review in the project settings, sees what bounds a run without a
// price, saves, and finds the pair after a reload. The catalog is filled by the real fetch with the committed fixture and no
// network (src/test-support/e2e-models-dev-child.ts). The key is in no address, no page and no answer.
// Then a pull request is opened and a script plays the Dynamic runner, as the journey of the operator catalog does: the job is
// handed out with the chosen provider and model, the workspace's own key of that provider, the entry of the model with the address
// the catalog trusts for it, and the cost policy of an own key; the script reports the run and the Runs page shows it succeeded.
// Not in this journey: the native engine itself running that job. It needs root and an https upstream at a public address, which
// the browser lane has not (the privileged lane, #581); the claim is also proven at its level
// (integration-tests/http/runner-api-native-own.integration.test.ts).
import { expect, test, type Page } from "@playwright/test";
import {
  changeAdminSetting,
  syncFromGithubAsAdmin,
} from "../helpers/admin-api";
import { e2eEnv } from "../helpers/e2e-env";
import {
  addGithubAccount,
  addGithubInstallation,
  addGithubPullRequest,
  GITHUB_APP_OWNER_ACCOUNT,
  signInThroughTheForm,
  type GithubAccount,
} from "../helpers/github-fake";
import { fetchModelsDevCatalog } from "../helpers/models-dev";
import { chooseOption, openSection } from "../helpers/settings-form";
import {
  dynamicRunnerScript,
  type ClaimedDynamicJob,
  type DynamicRunnerScript,
} from "../helpers/runner-api";
import { deliverPullRequestEvent } from "../helpers/webhooks";

const account: GithubAccount = {
  id: 7300050,
  login: "native-provider-journey",
  name: "Native Provider Journey",
  email: "native-provider-journey@example.test",
};
const REPOSITORY = "native-provider-journey/widgets";
// A key that must never show up anywhere but in the body of the request that sets it.
const KEY = "sk-deepseek-e2e-workspace-key-0123456789abcdefabcd";
const INSTALLATION_ID = 9100050;
const REPOSITORY_ID = 9200050;
// The address the committed catalog fixture states for DeepSeek: trusted on first sight, the destination of the key.
const DEEPSEEK_ADDRESS = "https://api.deepseek.com";

test.describe.configure({ mode: "serial" });

/** Claims the Dynamic job as a runner that can run a native job would, once the webhook has made it. */
async function claimDynamicJob(
  runner: DynamicRunnerScript,
): Promise<ClaimedDynamicJob> {
  let claimed: ClaimedDynamicJob | null = null;
  await expect
    .poll(
      async () => {
        claimed = await runner.claim([
          "dynamic_capabilities",
          "dynamic_cost_policy",
        ]);
        return claimed !== null;
      },
      { timeout: 60_000, intervals: [500, 1_000] },
    )
    .toBe(true);
  if (claimed === null) throw new Error("No Dynamic job was handed out.");
  return claimed;
}

async function openProject(page: Page) {
  await page
    .getByRole("link", { name: "Projects", exact: true })
    .first()
    .click();
  await page.getByRole("link", { name: REPOSITORY, exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: REPOSITORY }),
  ).toBeVisible();
}

test.describe("a provider of the catalog for Dynamic Review", () => {
  test.beforeAll(async ({ request }) => {
    await fetchModelsDevCatalog(e2eEnv.databaseUrl);
    await addGithubAccount(request, account);
    await addGithubInstallation(
      request,
      { id: INSTALLATION_ID, account: GITHUB_APP_OWNER_ACCOUNT },
      [{ id: REPOSITORY_ID, fullName: REPOSITORY }],
    );
    await syncFromGithubAsAdmin(e2eEnv.appUrl);
  });

  // #555-T10
  test("an Owner saves a key for a catalog provider, picks one of its models for Dynamic Review, and finds it after a reload", async ({
    page,
  }) => {
    const requestedUrls: string[] = [];
    page.on("request", (request) => requestedUrls.push(request.url()));
    await signInThroughTheForm(page, account);

    // The providers of the catalog, searchable, next to the two cards of the registry.
    await page.getByRole("link", { name: "Settings" }).first().click();
    await page.getByRole("link", { name: "LLM", exact: true }).first().click();
    await expect(
      page.getByRole("heading", { level: 2, name: "Other providers" }),
    ).toBeVisible();
    const providers = page.getByRole("list", { name: "Providers" });
    await page.getByLabel("Search providers").fill("deep");
    await expect(providers.getByRole("listitem")).toHaveCount(1);
    await providers.getByRole("button", { name: /DeepSeek/ }).click();

    // The key form of that provider: write-only, shown as saved with its last four characters.
    const form = page.getByRole("form", { name: "DeepSeek LLM key" });
    await expect(form).toBeVisible();
    await form.getByLabel("API key").fill(KEY);
    await form.getByRole("button", { name: "Save key" }).click();
    await expect(
      form.getByText(`A key is saved (ends in ${KEY.slice(-4)})`),
    ).toBeVisible();
    await expect(providers.getByText("Key saved")).toBeVisible();
    await page.screenshot({
      path: "test-results/native-provider-llm-access.png",
    });

    // The project: Dynamic Review, the provider with a key, one of its models.
    await openProject(page);
    await page.getByRole("radio", { name: "Dynamic Review" }).click();
    await openSection(page, "LLM");
    await chooseOption(page, "Provider", /^DeepSeek/);
    await chooseOption(page, "Model", /DeepSeek V4 Pro/);
    await expect(page.getByTestId("cost-note")).toContainText("models.dev");
    await page.screenshot({
      path: "test-results/native-provider-project-settings.png",
    });

    await page.getByRole("button", { name: "Save review settings" }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Switch to Dynamic Review" })
      .click();
    await expect(
      page.getByRole("status").filter({ hasText: "Saved." }),
    ).toBeVisible();

    // After a reload the same pair is there, and the provider's key is nowhere.
    await page.reload();
    await openSection(page, "LLM");
    await expect(
      page.getByRole("combobox", { name: "Provider", exact: true }),
    ).toContainText("DeepSeek");
    await expect(page.getByRole("combobox", { name: "Model" })).toContainText(
      "DeepSeek V4 Pro",
    );
    expect(await page.content()).not.toContain(KEY);
    for (const url of requestedUrls) expect(url).not.toContain(KEY);
  });

  // #555-T10
  test("a review of a pull request is handed out with the chosen model, the workspace's own key and the catalog's address, and succeeds", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    // The instance admin allows Dynamic Review: the job is pinned as Dynamic and ends `dynamic_review_disabled` otherwise.
    await changeAdminSetting(e2eEnv.appUrl, {
      dynamicReview: { enabled: true },
    });
    await signInThroughTheForm(page, account);
    // The project is switched on (a project that was never activated runs no review).
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Projects" })
      .click();
    const row = page.getByRole("row").filter({ hasText: REPOSITORY });
    await row.getByRole("switch", { name: `Review ${REPOSITORY}` }).click();
    await expect(row.getByText("Active", { exact: true })).toBeVisible();

    await addGithubPullRequest(request, REPOSITORY, {
      number: 1,
      title: "Change number 1",
      headSha: "b".repeat(40),
    });
    const answer = await deliverPullRequestEvent(request, {
      action: "opened",
      installationId: INSTALLATION_ID,
      repository: {
        id: REPOSITORY_ID,
        fullName: REPOSITORY,
        owner: {
          login: GITHUB_APP_OWNER_ACCOUNT.login,
          id: GITHUB_APP_OWNER_ACCOUNT.id,
        },
      },
      number: 1,
      title: "Change number 1",
      headSha: "b".repeat(40),
    });
    expect(answer).toEqual({ status: "accepted", outcome: "trigger_enqueued" });

    const runner = await dynamicRunnerScript(e2eEnv.appUrl);
    try {
      const job = await claimDynamicJob(runner);
      expect(job.llm).toMatchObject({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKey: KEY,
      });
      expect(job.dynamic.cost?.keyMode).toBe("own");
      expect(job.dynamic.modelEntry).toMatchObject({
        providerId: "deepseek",
        modelId: "deepseek-v4-pro",
        upstreamBaseUrl: DEEPSEEK_ADDRESS,
      });
      await runner.complete(job, { model: job.dynamic.model });
    } finally {
      await runner.dispose();
    }

    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Runs" })
      .click();
    await expect(
      page
        .locator("[data-run-id]")
        .filter({ hasText: REPOSITORY })
        .locator("[data-status]"),
    ).toContainText("Succeeded", { timeout: 60_000 });
    expect(await page.content()).not.toContain(KEY);
  });
});
