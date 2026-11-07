// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the whole path of a review in a real browser, against a production build: a signed
// `pull_request` webhook reaches the app, the app queues a job, the REAL runner (the job loop, a
// process of its own) claims it and runs the REAL PR-Agent against the fake GitHub and a fake LLM,
// the review comment lands in the fake GitHub, and the run shows up as succeeded (or failed) on the
// Runs page. Nothing in between is replaced: the runner's strict validation of the job (the pull
// request and the API address on one host) runs as in production. The one thing added on the way is
// the address of the fake LLM, which the app has no setting for (fakes/pr-agent/
// run_job_against_fake_llm.py). What each piece does in detail is proven at lower levels (the engine
// suite for PR-Agent, the integration tests for the claim); this file proves they fit together.
import { expect, test, type Page } from "@playwright/test";
import { startLlmFake, type FakeLlm } from "../../../fakes/llm/server.ts";
import { review } from "../../../fakes/llm/canned.ts";
import { syncFromGithubAsAdmin } from "../helpers/admin-api";
import { e2eEnv, llmEnv } from "../helpers/e2e-env";
import {
  addGithubAccount,
  addGithubInstallation,
  GITHUB_APP_OWNER_ACCOUNT,
  addGithubPullRequest,
  getIssuedInstallationTokens,
  getPullRequestComments,
  signInThroughTheForm,
  type GithubAccount,
} from "../helpers/github-fake";
import { startRunner, type RunnerProcess } from "../helpers/runner-process";
import { deliverPullRequestEvent } from "../helpers/webhooks";

const account: GithubAccount = {
  id: 7400001,
  login: "pipeline-journey",
  name: "Pipeline Journey",
  email: "pipeline-journey@example.test",
};
const INSTALLATION_ID = 9500001;
// A project that is switched on, and a repository of the installation that never was.
const WIDGETS = { id: 9600001, fullName: "pipeline-journey/widgets" };
const DORMANT = { id: 9600002, fullName: "pipeline-journey/dormant" };
const OWNER = { login: account.login, id: account.id };
const REVIEW_MARKER = "<!-- pr-agent:review:full -->";
// The key an Owner saves for the workspace in the last journey: a dummy that must never show up anywhere.
const WORKSPACE_KEY = "sk-or-v1-e2e-workspace-key-of-the-pipeline-app-0001";
// A review through the real PR-Agent takes a few seconds; the first one also loads PR-Agent.
const RUN_TIMEOUT = { timeout: 120_000 };

// A retry of a failed journey starts the whole serial group again on the same app, fake GitHub and
// database: the account, the installation, the switched on project, the pull requests, the comments
// and the runs of the failed attempt are all still there. So every attempt works on pull requests
// of its own (the number moves by 100 per retry), and the setup in `beforeAll` accepts what an
// earlier attempt already did.
const prNumber = (base: number) => base + 100 * test.info().retry;
/** A head commit that is different for every pull request and every push (`variant`). */
const headSha = (variant: string, number: number) =>
  variant + String(number).padStart(39, "0");

// The tests share one runner, one fake LLM and the runs of the app, one after the other.
test.describe.configure({ mode: "serial" });

test.describe("a pull request on its way to a review comment", () => {
  // Undefined when `beforeAll` failed before it got that far; `afterAll` still runs.
  let llm: FakeLlm | undefined;
  let runner: RunnerProcess | undefined;

  test.beforeAll(async ({ browser, baseURL }) => {
    if (baseURL === undefined)
      throw new Error("The jobs project has no baseURL.");
    llm = await startLlmFake();
    runner = await startRunner({
      appUrl: baseURL,
      llmBaseUrl: llm.baseUrl,
    });

    // The setup a person does once: install the app for the account, sign in, sync and switch the
    // first repository on. The other one stays off.
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    await addGithubAccount(context.request, account, "pipeline");
    await addGithubInstallation(
      context.request,
      {
        id: INSTALLATION_ID,
        account: GITHUB_APP_OWNER_ACCOUNT,
      },
      [WIDGETS, DORMANT],
    );
    await syncFromGithubAsAdmin(baseURL);
    await signInThroughTheForm(page, account);
    // The LLM key of the workspace, saved the way an Owner does it in the settings (the server has none in its
    // environment). The last journey of the group replaces it and puts this one back.
    await saveWorkspaceKey(page, llmEnv.apiKey);
    const row = page.getByRole("row").filter({ hasText: WIDGETS.fullName });
    await expect(row).toBeVisible();
    // A retry finds the project switched on already: clicking the switch again would turn it off.
    if ((await row.getByText("Active", { exact: true }).count()) === 0)
      await row
        .getByRole("switch", { name: `Review ${WIDGETS.fullName}` })
        .click();
    await expect(row.getByText("Active", { exact: true })).toBeVisible();
    await expect(
      page
        .getByRole("row")
        .filter({ hasText: DORMANT.fullName })
        .getByText("Active", { exact: true }),
    ).toHaveCount(0);
    await context.close();
  });

  test.beforeEach(() => {
    fakeLlm().reset();
  });

  test.afterAll(async () => {
    await runner?.stop();
    await llm?.close();
  });

  function fakeLlm(): FakeLlm {
    if (llm === undefined) throw new Error("The fake LLM was not started.");
    return llm;
  }

  function runnerOutput(): string {
    if (runner === undefined) throw new Error("The runner was not started.");
    return runner.output();
  }

  /** The rows of the Runs page that belong to a pull request. */
  function runsOf(page: Page, repository: string, number: number) {
    return page
      .locator("[data-run-id]")
      .filter({ hasText: repository })
      .filter({ hasText: `#${String(number)}` });
  }

  async function openRuns(page: Page) {
    await signInThroughTheForm(page, account);
    await page.getByRole("link", { name: "Runs", exact: true }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Runs" }),
    ).toBeVisible();
  }

  // CR-47-T01
  test("@smoke a person opens a pull request and the real runner posts one review comment, which the Runs page shows as succeeded", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const number = prNumber(7);
    const head = headSha("1", number);
    await addGithubPullRequest(request, WIDGETS.fullName, {
      number,
      title: "Add a greeting helper",
      headSha: head,
    });
    await openRuns(page);

    const answer = await deliverPullRequestEvent(request, {
      action: "opened",
      installationId: INSTALLATION_ID,
      repository: { ...WIDGETS, owner: OWNER },
      number,
      title: "Add a greeting helper",
      headSha: head,
    });
    expect(answer).toEqual({ status: "accepted", outcome: "trigger_enqueued" });

    const run = runsOf(page, WIDGETS.fullName, number);
    await expect(run.locator("[data-status]")).toContainText(
      "Succeeded",
      RUN_TIMEOUT,
    );
    await expect(run).toContainText("Automatic");

    // Exactly one comment, written by the bot of the app, holding the review of the model.
    const comments = await getPullRequestComments(
      request,
      WIDGETS.fullName,
      number,
    );
    expect(comments).toHaveLength(1);
    expect(comments[0]?.login).toBe(e2eEnv.githubBotLogin);
    expect(comments[0]?.body).toContain(REVIEW_MARKER);
    expect(comments[0]?.body).toContain("Missing input check (first run)");
    expect(comments[0]?.revision).toBe(1);

    // The model was asked once, with the key of the workspace, about the diff of the fake GitHub.
    const asked = fakeLlm().requests();
    expect(asked).toHaveLength(1);
    expect(asked[0]?.authorization).toBe(`Bearer ${llmEnv.apiKey}`);
    expect(asked[0]?.model).toContain(llmEnv.model);
    expect(asked[0]?.prompt).toContain("greeting.py");

    // Neither key nor token is in the runner's output or on the run's page.
    await expectNoCredentials(page, request, runnerOutput());
  });

  // CR-47-T02
  test("a push to the same pull request updates the comment in place and posts no second one", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const number = prNumber(7);
    const head = headSha("2", number);
    fakeLlm().setReply("review", review("second run"));
    await addGithubPullRequest(request, WIDGETS.fullName, {
      number,
      title: "Add a greeting helper",
      headSha: head,
    });
    const [first] = await getPullRequestComments(
      request,
      WIDGETS.fullName,
      number,
    );
    expect(first?.revision).toBe(1);
    await openRuns(page);

    const answer = await deliverPullRequestEvent(request, {
      action: "synchronize",
      installationId: INSTALLATION_ID,
      repository: { ...WIDGETS, owner: OWNER },
      number,
      title: "Add a greeting helper",
      headSha: head,
    });
    expect(answer).toEqual({ status: "accepted", outcome: "trigger_enqueued" });

    // The push is a second run of the same pull request; both are done when the comment was edited.
    const runs = runsOf(page, WIDGETS.fullName, number);
    await expect(runs).toHaveCount(2, RUN_TIMEOUT);
    await expect(runs.nth(0).locator("[data-status]")).toContainText(
      "Succeeded",
      RUN_TIMEOUT,
    );
    await expect(runs.nth(1).locator("[data-status]")).toContainText(
      "Succeeded",
      RUN_TIMEOUT,
    );

    const comments = await getPullRequestComments(
      request,
      WIDGETS.fullName,
      number,
    );
    expect(comments).toHaveLength(1);
    expect(comments[0]?.id).toBe(first?.id);
    expect(comments[0]?.revision).toBe(2);
    expect(comments[0]?.body).toContain("second run");
    expect(fakeLlm().requests()).toHaveLength(1);
  });

  // CR-47-T03
  test("a pull request in a repository that is not switched on starts no job and gets no comment", async ({
    page,
    request,
  }) => {
    const number = prNumber(3);
    const head = headSha("3", number);
    await addGithubPullRequest(request, DORMANT.fullName, {
      number,
      title: "Rename a variable",
      headSha: head,
    });
    await openRuns(page);

    const answer = await deliverPullRequestEvent(request, {
      action: "opened",
      installationId: INSTALLATION_ID,
      repository: { ...DORMANT, owner: OWNER },
      number,
      title: "Rename a variable",
      headSha: head,
    });

    // The app decided at the door: no job, so nothing for a runner to pick up.
    expect(answer).toEqual({
      status: "accepted",
      outcome: "project_not_active",
    });
    await page.reload();
    await expect(runsOf(page, DORMANT.fullName, number)).toHaveCount(0);
    expect(
      await getPullRequestComments(request, DORMANT.fullName, number),
    ).toEqual([]);
    expect(fakeLlm().requests()).toHaveLength(0);
  });

  // CR-47-T04
  test("a model that answers with an error fails the run with a stable code, posts no review and leaks no key", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const number = prNumber(8);
    const head = headSha("4", number);
    fakeLlm().failWith({ status: 429, message: "slow down" });
    fakeLlm().quoteKeyInErrors(true);
    await addGithubPullRequest(request, WIDGETS.fullName, {
      number,
      title: "Add a farewell helper",
      headSha: head,
    });
    await openRuns(page);

    await deliverPullRequestEvent(request, {
      action: "opened",
      installationId: INSTALLATION_ID,
      repository: { ...WIDGETS, owner: OWNER },
      number,
      title: "Add a farewell helper",
      headSha: head,
    });

    const run = runsOf(page, WIDGETS.fullName, number);
    await expect(run.locator("[data-status]")).toContainText(
      "Failed",
      RUN_TIMEOUT,
    );
    await run
      .getByRole("link", { name: `${WIDGETS.fullName} #${String(number)}` })
      .click();
    // The Runs list stays mounted (hidden) behind the run page; its row carries the same failure
    // sentence, so every assertion of the page is scoped to the visible run detail.
    const detail = page
      .locator('[data-slot="run-detail"]')
      .filter({ visible: true });
    await expect(detail.getByText("llm_rate_limit")).toBeVisible();
    await expect(
      detail.getByText("The AI provider is limiting requests right now."),
    ).toBeVisible();

    // The run page has no log (#657): neither the error text of the model nor the key is on it.
    await expect(detail.getByText("Incorrect API key provided")).toHaveCount(0);

    // The model really was asked with the key (so the error text did quote it) ...
    const asked = fakeLlm().requests();
    expect(asked.length).toBeGreaterThan(0);
    expect(
      asked.every((item) => item.authorization === `Bearer ${llmEnv.apiKey}`),
    ).toBe(true);
    // ... and no review reached the pull request.
    const comments = await getPullRequestComments(
      request,
      WIDGETS.fullName,
      number,
    );
    expect(
      comments.filter((item) => item.body.includes(REVIEW_MARKER)),
    ).toEqual([]);
    await expectNoCredentials(page, request, runnerOutput());
  });

  // #104-LK-13
  test("a key saved for the workspace in the settings is the key a review is asked with, instead of the key saved before", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const number = prNumber(9);
    const head = headSha("5", number);
    await addGithubPullRequest(request, WIDGETS.fullName, {
      number,
      title: "Add a salutation helper",
      headSha: head,
    });
    await signInThroughTheForm(page, account);
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await page.getByRole("link", { name: "LLM", exact: true }).click();
    await expect(page).toHaveURL(/\/w\/default\/settings\/llm$/);
    const form = page.getByRole("form", { name: "OpenRouter LLM key" });
    await form.getByLabel("API key").fill(WORKSPACE_KEY);
    await form.getByRole("button", { name: "Save key" }).click();
    // The state the server holds now (not the message, which is shown for a moment).
    await expect(
      form.getByText(`A key is saved (ends in ${WORKSPACE_KEY.slice(-4)})`),
    ).toBeVisible();

    try {
      await page.getByRole("link", { name: "Runs", exact: true }).click();
      const answer = await deliverPullRequestEvent(request, {
        action: "opened",
        installationId: INSTALLATION_ID,
        repository: { ...WIDGETS, owner: OWNER },
        number,
        title: "Add a salutation helper",
        headSha: head,
      });
      expect(answer).toEqual({
        status: "accepted",
        outcome: "trigger_enqueued",
      });
      const run = runsOf(page, WIDGETS.fullName, number);
      await expect(run.locator("[data-status]")).toContainText(
        "Succeeded",
        RUN_TIMEOUT,
      );

      // The model was asked with the key that was saved last and not with the one saved before.
      const asked = fakeLlm().requests();
      expect(asked).toHaveLength(1);
      expect(asked[0]?.authorization).toBe(`Bearer ${WORKSPACE_KEY}`);
      expect(asked[0]?.authorization).not.toContain(llmEnv.apiKey);
      await expectNoCredentials(page, request, runnerOutput(), [WORKSPACE_KEY]);
    } finally {
      // A retry of the group starts with the key the other journeys use.
      await saveWorkspaceKey(page, llmEnv.apiKey);
    }
  });
});

/** Saves the LLM key of the first workspace, as an Owner does in the settings (the account is signed in). */
async function saveWorkspaceKey(page: Page, apiKey: string): Promise<void> {
  const saved = await page.request.put("/api/w/default/llm-key", {
    data: { provider: llmEnv.provider, apiKey },
  });
  expect(saved.status(), await saved.text()).toBe(200);
}

/** The LLM key and every installation token are nowhere in the page, the runner's output or the run data. */
async function expectNoCredentials(
  page: Page,
  request: import("@playwright/test").APIRequestContext,
  runnerOutput: string,
  moreSecrets: string[] = [],
): Promise<void> {
  const tokens = await getIssuedInstallationTokens(request);
  expect(tokens.length).toBeGreaterThan(0);
  const secrets = [
    llmEnv.apiKey,
    e2eEnv.runnerToken,
    ...tokens,
    ...moreSecrets,
  ];
  const runs = await page.request.get("/api/w/default/runs");
  expect(runs.status()).toBe(200);
  const texts = {
    "the page": await page.content(),
    "the runs API": await runs.text(),
    "the runner output": runnerOutput,
  };
  for (const [name, text] of Object.entries(texts))
    for (const secret of secrets)
      expect(text, `a credential is in ${name}`).not.toContain(secret);
}
