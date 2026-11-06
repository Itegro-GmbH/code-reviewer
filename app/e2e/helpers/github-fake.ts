// SPDX-License-Identifier: LicenseRef-Proprietary

// Helpers for the journeys that sign in: add an account to the fake GitHub that Playwright started
// next to the app, and walk through the sign in form the way a person does.
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { ownerIdFor } from "../../../fakes/github/registry";
import type { WorkspaceRole } from "../../src/db/workspace-roles";
import { e2eEnv } from "./e2e-env";

const run = promisify(execFile);
const ACCOUNTS_CHILD = resolve(
  process.cwd(),
  "src/test-support/e2e-accounts-child.ts",
);

export type GithubAccount = {
  id: number;
  login: string;
  name: string;
  /** The public profile email. Also the one verified primary address, unless `emails` says otherwise. */
  email: string | null;
  /** What `GET /user/emails` answers, when it should not be just the public email. */
  emails?: Array<{ email: string; primary: boolean; verified: boolean }>;
};

/** The apps a journey can sign an account into: the database of each. */
export type AppUnderTest = "main" | "pipeline" | "setup";
const DATABASES: Record<AppUnderTest, string> = {
  main: e2eEnv.databaseUrl,
  pipeline: e2eEnv.pipelineDatabaseUrl,
  setup: e2eEnv.setupDatabaseUrl,
};

/**
 * Puts a user into the database of an app the way the import of an existing installation leaves one: a user
 * who signed in with GitHub before accounts existed, a member of the default workspace (see
 * src/test-support/e2e-accounts-child.ts). The first sign in as that GitHub account is found by its numeric id.
 */
export async function importGithubUser(
  account: GithubAccount,
  app: AppUnderTest,
  role: "owner" | "admin" | "member" = "owner",
): Promise<void> {
  await run(
    process.execPath,
    [
      "--no-warnings",
      "--conditions=react-server",
      ACCOUNTS_CHILD,
      "import-user",
      DATABASES[app],
      JSON.stringify({
        githubId: account.id,
        login: account.login,
        name: account.name,
        role,
      }),
    ],
    { cwd: process.cwd() },
  );
}

/**
 * Each spec file owns its accounts (own id and login); nobody resets the fake while others run. With `app`,
 * the account also exists in that app as an imported user and a member (so a journey that signs in finds the
 * workspace); without, it is a GitHub account nobody here knows.
 */
export async function addGithubAccount(
  request: APIRequestContext,
  account: GithubAccount,
  app: AppUnderTest | null = "main",
  role: "owner" | "admin" | "member" = "owner",
): Promise<void> {
  const response = await request.post(`${e2eEnv.githubUrl}/__fake/users`, {
    data: account,
  });
  expect(response.status()).toBe(201);
  if (app !== null) await importGithubUser(account, app, role);
}

/**
 * Opens the app, signs in as `account` at the fake GitHub and waits for the signed in app (the user menu with
 * their name). Being on the allow list admits a person to the app, it does not give them a workspace: the
 * account is made a member of the workspace of the app (the first one) with `role`, the way the import of an
 * existing installation does, and the app is opened again. Pass `role: null` for a journey about the
 * account that has none.
 */
export async function signInThroughTheForm(
  page: Page,
  account: GithubAccount,
  options: { role?: WorkspaceRole | null } = {},
): Promise<void> {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await page.getByRole("button", { name: "Sign in with GitHub" }).click();
  await page
    .getByRole("button", { name: `Authorize ${account.login}` })
    .click();
  const role = options.role === undefined ? "owner" : options.role;
  if (role === null) {
    await expect(userMenuButton(page, account)).toBeVisible();
    return;
  }
  // Without a workspace the app shows the page that says so; with one it shows the projects.
  await expect(page).toHaveURL(/\/(no-access|w\/[a-z0-9-]+\/projects)$/);
  if (page.url().endsWith("/no-access")) {
    await joinWorkspace(page, account, role);
    await page.goto("/");
  }
  await expect(page).toHaveURL(/\/w\/[a-z0-9-]+\/projects$/);
  await expect(userMenuButton(page, account)).toBeVisible();
}

/** The database of the app a page is open at (the apps of a run each have their own). */
function databaseOf(page: Page): string {
  const origin = new URL(page.url()).origin;
  const file =
    origin === e2eEnv.pipelineAppUrl
      ? e2eEnv.pipelineDatabaseUrl
      : origin === e2eEnv.signupAppUrl
        ? e2eEnv.signupDatabaseUrl
        : origin === e2eEnv.multiAppUrl
          ? e2eEnv.multiDatabaseUrl
          : origin === e2eEnv.operatorAppUrl
            ? e2eEnv.operatorDatabaseUrl
            : origin === e2eEnv.catalogAppUrl
              ? e2eEnv.catalogDatabaseUrl
              : e2eEnv.databaseUrl;
  return file;
}

/** Makes the account a member of a workspace of the app the page is open at (the first one by default). */
export async function joinWorkspace(
  page: Page,
  /** The account by its GitHub login, or by the address of an account that signed up with email. */
  account: { login: string } | { email: string },
  role: WorkspaceRole,
  workspace?: string,
): Promise<void> {
  await run(
    process.execPath,
    [
      "--no-warnings",
      "--conditions=react-server",
      resolve(process.cwd(), "src/test-support/e2e-membership-child.ts"),
      "join",
      databaseOf(page),
      JSON.stringify({ ...account, role, workspace }),
    ],
    { cwd: process.cwd() },
  );
}

/** The button of the user menu in the header, named after the person. */
export function userMenuButton(page: Page, account: { name: string }) {
  return page.getByRole("button", { name: account.name });
}

/**
 * Opens the user menu, presses "Sign out" and waits until the sign-out is done. The menu item submits a server
 * action that ends the session and then redirects to the login page, so the login page is the proof that the
 * session is gone. Returning earlier lets the next step (a `goto`, the next account signing in) cancel the
 * action in flight and land on the still signed in app (#907).
 */
export async function signOutThroughTheMenu(
  page: Page,
  account: { name: string },
): Promise<void> {
  await userMenuButton(page, account).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
}

export type GithubInstallation = {
  id: number;
  account: { login: string; id: number; type: "User" | "Organization" };
};

/**
 * The account the GitHub App of the apps under test belongs to (the fake reports it as the owner of the App).
 * In a single-tenant instance whose App is private, an installation on it is attached to the one workspace
 * without a person connecting it; an installation on any other account is only noted as unclaimed
 * (docs/decisions/0001-editions-setup-and-accounts.md, section 2.9). The journeys of the single-tenant apps
 * install the App here, so the synchronization finds their repositories the way it does for an operator who
 * installs their own App on their own account.
 */
export const GITHUB_APP_OWNER_ACCOUNT = {
  login: "fake-owner",
  id: ownerIdFor("fake-owner"),
  type: "User",
} as const;

/**
 * Installs the GitHub App for an account at the fake, with these repositories (replacing the ones
 * of an installation that exists). Each spec file owns its installations, like its accounts. The app
 * learns about them at its next sync (the "Sync from GitHub" button).
 */
export async function addGithubInstallation(
  request: APIRequestContext,
  installation: GithubInstallation,
  repositories: Array<{ id: number; fullName: string; htmlUrl?: string }>,
): Promise<void> {
  const response = await request.post(
    `${e2eEnv.githubUrl}/__fake/installations`,
    { data: { installation, repositories } },
  );
  expect(response.status()).toBe(201);
}

/**
 * Says where GitHub sends the person after they installed the App (the "Setup URL" of the App registered at the
 * fake). The apps under test share that one App, so a journey that connects GitHub sets it to the app it uses.
 */
export async function setGithubAppSetupUrl(
  request: APIRequestContext,
  url: string,
): Promise<void> {
  const response = await request.post(
    `${e2eEnv.githubUrl}/__fake/app-setup-url`,
    { data: { url } },
  );
  expect(response.status()).toBe(201);
}

/**
 * Makes an account a member of an organization at the fake. `role` is the one GitHub reports: `admin` for an
 * owner of the organization, `member` for everybody else.
 */
export async function addGithubOrgMember(
  request: APIRequestContext,
  member: { org: string; login: string; role?: "admin" | "member" },
): Promise<void> {
  const response = await request.post(
    `${e2eEnv.githubUrl}/__fake/org-members`,
    {
      data: member,
    },
  );
  expect(response.status()).toBe(201);
}

/**
 * Makes the roles in an organization unreadable for the user tokens of the App (GitHub refuses them), like an
 * organization whose owners did not accept the permission "Members" for the App.
 */
export async function makeGithubMembershipUnreadable(
  request: APIRequestContext,
  org: string,
): Promise<void> {
  const response = await request.post(
    `${e2eEnv.githubUrl}/__fake/org-unreadable`,
    {
      data: { org },
    },
  );
  expect(response.status()).toBe(201);
}

export type GithubPullRequest = {
  number: number;
  title: string;
  state?: "open" | "closed";
  draft?: boolean;
  /** The head commit. Derived from the number when omitted, so every pull request has its own. */
  headSha?: string;
  author?: { login: string; id: number };
  /** The description. Empty when omitted. */
  body?: string;
};

/**
 * Puts a pull request into a repository of the fake GitHub (replacing one with the same number). The
 * head commit is derived from the number, so every pull request has its own.
 */
export async function addGithubPullRequest(
  request: APIRequestContext,
  repositoryFullName: string,
  pullRequest: GithubPullRequest,
): Promise<void> {
  const response = await request.post(
    `${e2eEnv.githubUrl}/__fake/pull-requests`,
    {
      data: {
        repository: repositoryFullName,
        pullRequest: {
          state: "open",
          headSha: String(pullRequest.number).padStart(40, "a"),
          headRef: `feature/${String(pullRequest.number)}`,
          baseRef: "main",
          author: { login: "alice", id: 1001 },
          ...pullRequest,
        },
      },
    },
  );
  expect(response.status()).toBe(201);
}

/**
 * Has the fake GitHub serve a Git repository (a `.git` directory made with `fakes/github/git-fixture.ts`) over
 * smart HTTP as `<fake>/<owner>/<name>.git`, the way the runner's checkout reads a pull request.
 */
export async function addGithubGitRepository(
  request: APIRequestContext,
  repositoryFullName: string,
  path: string,
): Promise<void> {
  const response = await request.post(
    `${e2eEnv.githubUrl}/__fake/git-repositories`,
    { data: { repository: repositoryFullName, path } },
  );
  expect(response.status()).toBe(201);
}

/** Sets what the App registered at the fake is granted (a factory deployment's App holds Contents: write, #749). */
export async function setGithubAppPermissions(
  request: APIRequestContext,
  permissions: Record<string, "read" | "write" | "admin">,
): Promise<void> {
  const response = await request.post(
    `${e2eEnv.githubUrl}/__fake/app-permissions`,
    { data: { permissions } },
  );
  expect(response.status(), await response.text()).toBe(201);
}

/** Every push the fake GitHub received for a repository, oldest first: the repository and the ref names of each. */
export async function getPushes(
  request: APIRequestContext,
  repositoryFullName: string,
): Promise<Array<{ repository: string; refs: string[] }>> {
  const response = await request.get(
    `${e2eEnv.githubUrl}/__fake/pushes?repository=${encodeURIComponent(repositoryFullName)}`,
  );
  expect(response.status()).toBe(200);
  return (
    (await response.json()) as {
      pushes: Array<{ repository: string; refs: string[] }>;
    }
  ).pushes;
}

/** Method and path of every request the fake GitHub received (a push also names its refs); no credential is in it. */
export async function getGithubRequests(
  request: APIRequestContext,
): Promise<Array<{ method: string; path: string; refs?: string[] }>> {
  const response = await request.get(`${e2eEnv.githubUrl}/__fake/requests`);
  expect(response.status()).toBe(200);
  return (
    (await response.json()) as {
      requests: Array<{ method: string; path: string; refs?: string[] }>;
    }
  ).requests;
}

export type GithubComment = {
  id: number;
  body: string;
  login: string;
  htmlUrl: string;
  /** 1 when written, plus one for every edit. */
  revision: number;
};

/** The comments below a pull request at the fake GitHub, oldest first. */
export async function getPullRequestComments(
  request: APIRequestContext,
  repositoryFullName: string,
  number: number,
): Promise<GithubComment[]> {
  const response = await request.get(`${e2eEnv.githubUrl}/__fake/comments`, {
    params: { repository: repositoryFullName, number },
  });
  expect(response.status()).toBe(200);
  return (await response.json()) as GithubComment[];
}

/** Every installation token the fake GitHub has issued so far (to search outputs for them). */
export async function getIssuedInstallationTokens(
  request: APIRequestContext,
): Promise<string[]> {
  const response = await request.get(
    `${e2eEnv.githubUrl}/__fake/installation-tokens`,
  );
  expect(response.status()).toBe(200);
  return (await response.json()) as string[];
}
