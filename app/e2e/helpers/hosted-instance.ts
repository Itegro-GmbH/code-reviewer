// SPDX-License-Identifier: LicenseRef-Proprietary

// What a person does once at an app of the hosted lane (#332) and what the journeys do to it all the time: sign in
// as the instance admin (the lane's apps have no GitHub sign-in set up: the database is Postgres), install the GitHub
// App for the repositories at the fake GitHub, sync, save the workspace's LLM key and switch a project on, and the app's own
// cron: the sweep (`GET /api/internal/dispatch-sweep`, #328).
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  expect,
  type APIRequestContext,
  type Browser,
  type Page,
} from "@playwright/test";
import { syncFromGithubAsAdmin } from "./admin-api";
import { e2eEnv, llmEnv } from "./e2e-env";
import { addGithubInstallation, GITHUB_APP_OWNER_ACCOUNT } from "./github-fake";
import { hostedEnv } from "./hosted-env";
import { chooseOption, openSection } from "./settings-form";
import { rememberSecret } from "./hosted-secrets";

/** The owner of the repositories the journeys review: the account the fake reports as the owner of the App. */
export const OWNER = {
  login: GITHUB_APP_OWNER_ACCOUNT.login,
  id: GITHUB_APP_OWNER_ACCOUNT.id,
};

/** Signs in as the instance admin through the same route as the sign in form; the page's cookies hold the session. */
export async function signInAsAdmin(page: Page): Promise<void> {
  const signedIn = await page.request.post("/api/auth/sign-in/email", {
    data: { email: e2eEnv.adminEmail, password: e2eEnv.adminPassword },
  });
  expect(signedIn.status(), await signedIn.text()).toBe(200);
  // The session cookie must be nowhere but the browser: the scans of the lane search for it.
  for (const cookie of await page.context().cookies())
    if (/session/i.test(cookie.name))
      rememberSecret("session-cookie", cookie.value);
  await page.goto("/");
  await expect(page).toHaveURL(/\/w\/[a-z0-9-]+\/projects$/);
}

/** Saves the LLM key of the first workspace, as an Owner does in the settings (the account is signed in). */
export async function saveWorkspaceKey(
  page: Page,
  apiKey: string,
): Promise<void> {
  const saved = await page.request.put("/api/w/default/llm-key", {
    data: { provider: llmEnv.provider, apiKey },
  });
  expect(saved.status(), await saved.text()).toBe(200);
}

/** Switches the project of a repository on in the projects page, unless it already is. */
export async function switchProjectOn(
  page: Page,
  fullName: string,
): Promise<void> {
  await page.goto("/");
  const row = page.getByRole("row").filter({ hasText: fullName });
  await expect(row).toBeVisible();
  if ((await row.getByText("Active", { exact: true }).count()) === 0)
    await row.getByRole("switch", { name: `Review ${fullName}` }).click();
  await expect(row.getByText("Active", { exact: true })).toBeVisible();
  // A project that is switched on starts as Dynamic Review where the instance has it on (#656); the journeys that review a pull request
  // as a Diff Review start from that kind, and the ones that want Dynamic Review choose it (`chooseDynamicReview`).
  await row.getByRole("link", { name: fullName, exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: fullName }),
  ).toBeVisible();
  if (await page.getByRole("radio", { name: "Dynamic Review" }).isChecked()) {
    await page.getByRole("radio", { name: "Diff Review" }).click();
    await page.getByRole("button", { name: "Save review settings" }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Switch to Diff Review" })
      .click();
    await expect(page.getByRole("status")).toContainText("Saved.");
  }
}

/**
 * The one-time setup of a person: the GitHub App is installed for these repositories at the fake, the app reads them,
 * the workspace has its LLM key and the projects of `active` are switched on (the other repositories stay off).
 * Returns the signed-in page's context closed: the journeys sign in again where they need a page.
 */
export async function setUpReviewedRepositories(
  browser: Browser,
  baseURL: string,
  options: {
    installationId: number;
    repositories: Array<{ id: number; fullName: string }>;
    active: string[];
  },
): Promise<void> {
  const context = await browser.newContext({ baseURL });
  try {
    const page = await context.newPage();
    await addGithubInstallation(
      context.request,
      { id: options.installationId, account: GITHUB_APP_OWNER_ACCOUNT },
      options.repositories,
    );
    await syncFromGithubAsAdmin(baseURL);
    await signInAsAdmin(page);
    await saveWorkspaceKey(page, llmEnv.apiKey);
    for (const fullName of options.active)
      await switchProjectOn(page, fullName);
  } finally {
    await context.close();
  }
}

/**
 * Chooses Dynamic Review for a project in its settings page, the way a person does (the instance admin has turned the
 * gate on before): the model they choose (one the dropdown lists) is the one the engine asks the fake LLM for. The account is signed in.
 */
export async function chooseDynamicReview(
  page: Page,
  fullName: string,
  model: string,
): Promise<void> {
  await page.goto("/");
  await page.getByRole("link", { name: fullName, exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: fullName }),
  ).toBeVisible();
  const dynamic = page.getByRole("radio", { name: "Dynamic Review" });
  await dynamic.click();
  await openSection(page, "LLM");
  await chooseOption(page, "Model", model);
  await page.getByRole("button", { name: "Save review settings" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Switch to Dynamic Review" })
    .click();
  await expect(page.getByRole("status")).toContainText("Saved.");
  await page.reload();
  await expect(dynamic).toBeChecked();
}

const run = promisify(execFile);

/**
 * Runs the deploy canary (`pnpm probe:canary`, the release gate of #331) against the Dispatcher the way the pipeline does:
 * the credential is in the environment and nowhere else. Resolves with the exit code and everything it printed.
 */
export async function runDeployCanary(
  timeoutSeconds: number,
  options: { token?: string; engines?: string } = {},
): Promise<{ code: number; output: string }> {
  // A Dispatcher that serves several apps opens `/probe` to its operator's credential only (`DISPATCHER_OPERATOR_TOKEN`); the
  // one of the first app is the reviewer's own, and is the default.
  const credential =
    options.token === undefined
      ? { RUNNER_TOKEN: hostedEnv.dispatcherToken }
      : { DISPATCHER_OPERATOR_TOKEN: options.token };
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      [
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
        "src/probe/canary-main.ts",
        "--url",
        hostedEnv.dispatcherUrl,
        "--allowed-hosts",
        "127.0.0.1",
        ...(options.engines === undefined
          ? []
          : ["--engines", options.engines]),
        "--wait-seconds",
        "30",
        "--timeout-seconds",
        String(timeoutSeconds),
      ],
      {
        cwd: resolve(process.cwd(), "../dispatcher"),
        env: { ...process.env, ...credential },
      },
    );
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    const failure = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: typeof failure.code === "number" ? failure.code : -1,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
    };
  }
}

export type SweepAnswer = {
  status: string;
  expired?: Record<string, number>;
  givenUp?: number;
  revived?: number;
  sent?: number;
  cleanedUp?: boolean;
};

/** One run of the app's cron sweep, as the platform's cron calls it (`Authorization: Bearer <CRON_SECRET>`). */
export async function runSweep(
  request: APIRequestContext,
): Promise<SweepAnswer> {
  const response = await request.get(
    `${hostedEnv.appUrl}/api/internal/dispatch-sweep`,
    { headers: { authorization: `Bearer ${hostedEnv.cronSecret}` } },
  );
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as SweepAnswer;
}

/** Waits for an asynchronous condition. */
export async function eventually(
  what: string,
  condition: () => Promise<boolean>,
  timeoutMs = 60_000,
): Promise<void> {
  let holds = false;
  const deadline = Date.now() + timeoutMs;
  while (!holds) {
    holds = await condition();
    if (holds) return;
    if (Date.now() > deadline)
      throw new Error(
        `Timed out after ${String(timeoutMs)} ms waiting for ${what}.`,
      );
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
