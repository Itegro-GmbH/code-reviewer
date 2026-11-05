// SPDX-License-Identifier: LicenseRef-Proprietary

// A fake of the GitHub REST API as a GitHub App uses it: installations, installation repositories,
// installation access tokens, pull requests and collaborator permissions. A real HTTP server that
// speaks GitHub's protocol, so the production client runs unchanged against it; only the base URL
// differs (`GITHUB_API_BASE_URL`). State is in memory. Dummy values only: the tokens it issues are
// random strings without meaning outside this process.
//
// It checks what GitHub checks: the App JWT must be signed with the app's key (RS256), name the app
// as issuer and not be expired; an installation token must have been issued here, not expired, and
// only reaches the repositories of its installation (narrowed by the `repositories` or
// `repository_ids` of the request) and only does what the permissions of the request allow. A token
// request may not ask for more than the app itself is granted (`setAppPermissions`).
//
// It is one part of the single fake GitHub (`server.ts`), which owns the HTTP server, the request
// log, the base URL and the failure injection; the sign in part (`oauth.ts`) sits next to it.
import { createPublicKey, randomBytes, verify } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFixtureBranches } from "./git-branches.ts";
import { basicToken, serveReceivePack, serveUploadPack } from "./git-http.ts";
import { readBody } from "./http.ts";
import {
  DEFAULT_ACCOUNT_PERMISSIONS,
  type AppRegistry,
  type FakeRegisteredApp,
} from "./registry.ts";
import {
  createChecksApi,
  type FakeCheckRun,
  type FakePullRequestReview,
} from "./checks-api.ts";
import { createActionsApi, type FakeIssue } from "./actions-api.ts";
import {
  BASE_SHA,
  createReviewApi,
  type FakeChangedFile,
  type FakeComment,
} from "./review-api.ts";

export type { FakeChangedFile, FakeComment } from "./review-api.ts";
export type { FakeIssue } from "./actions-api.ts";
export type { FakeCheckRun, FakePullRequestReview } from "./checks-api.ts";

export type FakeInstallation = {
  id: number;
  account: { login: string; id: number; type: "User" | "Organization" };
  suspended?: boolean;
};

export type FakeRepository = {
  id: number;
  /** "owner/name". */
  fullName: string;
  defaultBranch?: string;
  private?: boolean;
  /**
   * The `html_url` of the repository, when it is not `<web base>/<full name>`. The Implementer's journey (#767) gives its
   * repository an https address: the app clones from the repository's own https address, and the lane's fake GitHub speaks
   * plain http on loopback.
   */
  htmlUrl?: string;
};

export type FakePullRequest = {
  number: number;
  title: string;
  state: "open" | "closed";
  merged?: boolean;
  draft?: boolean;
  headSha: string;
  headRef: string;
  baseRef: string;
  author: { login: string; id: number };
  /** The description. Empty when omitted. */
  body?: string;
  /** The files the pull request changes, with their diffs. A small Python change when omitted. */
  files?: FakeChangedFile[];
};

/** The body of `POST /__fake/pull-requests`, or null when it is not one. */
function parsePullRequestControl(
  text: string,
): { repository: string; pullRequest: FakePullRequest } | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) return null;
  const { repository, pullRequest } = body as {
    repository?: unknown;
    pullRequest?: Partial<FakePullRequest> | null;
  };
  if (typeof repository !== "string" || repository === "") return null;
  if (typeof pullRequest !== "object" || pullRequest === null) return null;
  const valid =
    Number.isInteger(pullRequest.number) &&
    typeof pullRequest.title === "string" &&
    (pullRequest.state === "open" || pullRequest.state === "closed") &&
    typeof pullRequest.headSha === "string" &&
    typeof pullRequest.headRef === "string" &&
    typeof pullRequest.baseRef === "string" &&
    typeof pullRequest.author?.login === "string" &&
    typeof pullRequest.author.id === "number";
  return valid
    ? { repository, pullRequest: pullRequest as FakePullRequest }
    : null;
}

/** GitHub's permission names mapped to the level the app (or a token) holds. */
export type FakePermissions = Record<string, "read" | "write" | "admin">;

/** What an app registered like ours is granted unless a test narrows it. */
export const DEFAULT_FAKE_APP_PERMISSIONS: FakePermissions = {
  metadata: "read",
  contents: "read",
  pull_requests: "write",
  issues: "write",
  checks: "write",
};

export type FakeCollaboratorPermission = "admin" | "write" | "read" | "none";

/**
 * The GitHub App registered at the fake when it starts: what the App JWTs of the app under test are
 * checked with. Apps created through the manifest flow (`manifest.ts`) are registered in the shared
 * registry as well; both are checked by the key of the app a JWT names.
 */
export type FakeAppOptions = {
  /** The app registered at start; absent when only the manifest flow creates apps. */
  appId?: string;
  /** SPKI PEM of the app's key pair; JWTs are checked against it. */
  publicKeyPem?: string;
  /** The fake's clock in milliseconds since the epoch. Default Date.now. */
  now?: () => number;
  /**
   * The slug of the GitHub App: its comments are written as `<slug>[bot]`. Default "fake-app".
   */
  appSlug?: string;
  /**
   * The address the links in answers (`html_url`) point to, no trailing slash. Default
   * `https://github.test`, an address nothing listens on. A test that has the runner's PR-Agent
   * read a pull request needs links on the fake itself: the runner demands that the address of the
   * pull request and the API address of a job are on the same host.
   */
  webBase?: () => string;
  /** The address of the REST API in `url` fields. Default the same as `webBase`. */
  apiBase?: () => string;
  /** The address the links of comments point to (`html_url`), no trailing slash. Default `webBase`. */
  commentWebBase?: string;
};

export type FakeTokenRequest = {
  installationId: number;
  repositories: string[] | null;
  repositoryIds: number[] | null;
  permissions: Record<string, string> | null;
};

/** What the GitHub App part of the fake offers a test (see `FakeGithub` in `server.ts` for the whole). */
export type FakeGithubAppControls = {
  addInstallation(installation: FakeInstallation): void;
  /** The installations the fake has now (what the installation page offers and the user listing filters). */
  installations(): FakeInstallation[];
  /**
   * The "Setup URL" of the app registered at start: where the installation page sends the person after
   * "Install" (with `installation_id`, `setup_action` and the `state` it was opened with). Apps created through
   * the manifest flow use the one in their manifest. Null: the installation page refuses.
   */
  setAppSetupUrl(url: string | null): void;
  /** What uninstalling the app does: the installation and everything behind it disappears. */
  removeInstallation(id: number): void;
  suspendInstallation(id: number, suspended: boolean): void;
  setRepositories(installationId: number, repositories: FakeRepository[]): void;
  /**
   * Leaves these repositories out of the pages of `/installation/repositories` while `total_count`
   * still counts them, like a page boundary that skipped one while the list changed.
   */
  omitFromListings(installationId: number, repositoryIds: number[]): void;
  /** Adds a raw record to `/app/installations`, for example one whose account has no login. */
  addRawInstallationRecord(record: Record<string, unknown>): void;
  addRepository(installationId: number, repository: FakeRepository): void;
  removeRepository(installationId: number, repositoryId: number): void;
  /** Adds a pull request; one with the same number in the same repository is replaced. */
  addPullRequest(repoFullName: string, pullRequest: FakePullRequest): void;
  /**
   * Serves the Git repository in this directory (a `.git` directory, see `git-fixture.ts`) over smart HTTP as
   * `<base url>/<owner>/<name>.git`, to an installation token that reaches the repository. Replaces an earlier one.
   */
  addGitRepository(repoFullName: string, path: string): void;
  /** Changes fields of an added pull request, like a push (`headSha`) or a close (`state`). */
  updatePullRequest(
    repoFullName: string,
    number: number,
    changes: Partial<Omit<FakePullRequest, "number">>,
  ): void;
  setCollaboratorPermission(
    repoFullName: string,
    login: string,
    permission: FakeCollaboratorPermission,
  ): void;
  /**
   * Adds a branch with its head commit to a repository that is not served as Git (`addGitRepository`): what `POST /pulls` takes as
   * `head` or `base` (#844). The default branch and the heads of the added pull requests are there anyway.
   */
  addBranch(repoFullName: string, name: string, sha: string): void;
  /** Adds an issue (a number, a title, labels); numbers are shared with the pull requests of the repository (#844). */
  addIssue(repoFullName: string, issue: FakeIssue): void;
  /** The labels an issue or pull request has now, in the order they were added (#844). */
  issueLabels(repoFullName: string, number: number): string[];
  /** The comments below an issue that is no pull request, oldest first (#844). */
  issueComments(
    repoFullName: string,
    number: number,
  ): { id: number; body: string; login: string }[];
  /** The comments below a pull request, oldest first. */
  pullRequestComments(repoFullName: string, number: number): FakeComment[];
  /** Writes a comment below a pull request, by default as the bot of the app. */
  addPullRequestComment(
    repoFullName: string,
    number: number,
    body: string,
    login?: string,
  ): FakeComment;
  /** The check runs of a repository, oldest first, each with the history of its states (#405). */
  checkRuns(repoFullName: string): FakeCheckRun[];
  /** The reviews submitted on a pull request, oldest first (#405). */
  pullRequestReviews(
    repoFullName: string,
    number: number,
  ): FakePullRequestReview[];
  /** Submits a review as another person, for example a human reviewer (#405). */
  addPullRequestReview(
    repoFullName: string,
    number: number,
    review: { login: string; event: string; body?: string; commitId?: string },
  ): FakePullRequestReview;
  /** Each reviewer's latest review that is not a comment: what GitHub counts for the merge (#405). */
  pullRequestReviewDecisions(
    repoFullName: string,
    number: number,
  ): Record<string, "APPROVED" | "CHANGES_REQUESTED">;
  /** The permissions the app itself is granted; token requests may not exceed them (422). */
  setAppPermissions(permissions: FakePermissions): void;
  /**
   * The permissions this installation has accepted (#749): what `GET /app/installations/:id` reports, and a ceiling
   * for its tokens next to the app's own, so a permission the app was raised to but the installation has not approved
   * yet is refused with 422, like GitHub. Without a call the installation holds whatever the app is granted.
   */
  setInstallationPermissions(
    installationId: number,
    permissions: FakePermissions,
  ): void;
  /**
   * The account and organization permissions (`emails`, `members`) the user tokens of the app
   * registered at start hold, and what `GET /app` reports for them. Default: both read-only. Without
   * `emails`, `GET /user/emails` answers 404 for a user token, like GitHub for an app that lacks it.
   */
  setAppAccountPermissions(permissions: FakePermissions): void;
  /**
   * Merges these fields into every access token answer from now on (null stops it): a misbehaving
   * GitHub that reports a token as broader than it was asked for, for example
   * `{ repository_selection: "all" }`. The token itself is still limited as requested.
   */
  answerTokensWith(patch: Record<string, unknown> | null): void;
  /** Answers 401 to every App JWT, as when the key or app id of the app is wrong. */
  rejectAppJwts(reject: boolean): void;
  /**
   * The body of every access token request that was accepted for a look, in order: `repositories`
   * (names), `repository_ids` and `permissions`, each null when the request did not send it.
   */
  tokenRequests(): FakeTokenRequest[];
  /** Every installation token issued so far. */
  issuedInstallationTokens(): string[];
  /** Every installation token switched off with `DELETE /installation/token`, in order. */
  revokedInstallationTokens(): string[];
  /**
   * Every push received (`git-receive-pack`), in order: the repository and the names of the refs the client asked
   * to update, whether or not Git accepted them (the branch endpoints tell what is there). No tokens, no objects.
   */
  pushes(): FakePush[];
};

/** One push as the fake saw it. */
export type FakePush = { repository: string; refs: string[] };

export type AppPart = {
  controls: FakeGithubAppControls;
  /**
   * Answers the request when the path belongs to the GitHub App API; false when it does not.
   * `bearer` is the credential the request carried, `reply` sends an answer (late, if the injected
   * failure asks for that).
   */
  handle(context: {
    request: IncomingMessage;
    response: ServerResponse;
    url: URL;
    bearer: string | undefined;
    reply: (status: number, body: unknown) => Promise<void>;
    /** Puts the names of the refs a push asked to update on the entry of this request in the request log. */
    logRefs: (refs: string[]) => void;
  }): Promise<boolean>;
  /** Removes all state of the App API. */
  reset(): void;
};

type IssuedToken = {
  installationId: number;
  /** The repositories the token reaches; null means every repository of the installation. */
  repositoryIds: number[] | null;
  permissions: FakePermissions;
  expiresAtMs: number;
};

const LEVELS = ["read", "write", "admin"] as const;
const levelOf = (level: unknown): number =>
  LEVELS.findIndex((candidate) => candidate === level);

const TOKEN_LIFETIME_MS = 60 * 60 * 1000;
const MAX_PER_PAGE = 100;

function pageOf<T>(items: T[], query: URLSearchParams): T[] {
  const perPage = Math.min(
    Math.max(Number(query.get("per_page")) || 30, 1),
    MAX_PER_PAGE,
  );
  const page = Math.max(Number(query.get("page")) || 1, 1);
  return items.slice((page - 1) * perPage, page * perPage);
}

const DEFAULT_WEB_BASE = "https://github.test";

function accountJson(account: FakeInstallation["account"], webBase: string) {
  return {
    login: account.login,
    id: account.id,
    type: account.type,
    html_url: `${webBase}/${account.login}`,
  };
}

function repositoryJson(repository: FakeRepository, webBase: string) {
  const [owner = ""] = repository.fullName.split("/");
  const ownerId = 9000 + owner.length;
  return {
    id: repository.id,
    name: repository.fullName.split("/")[1],
    full_name: repository.fullName,
    private: repository.private ?? false,
    html_url: repository.htmlUrl ?? `${webBase}/${repository.fullName}`,
    default_branch: repository.defaultBranch ?? "main",
    owner: { login: owner, id: ownerId },
  };
}

function base64urlDecode(text: string): Buffer {
  return Buffer.from(text, "base64url");
}

export function createAppPart(
  options: FakeAppOptions,
  registry: AppRegistry,
): AppPart {
  const now = options.now ?? Date.now;
  const webBase = options.webBase ?? (() => DEFAULT_WEB_BASE);
  const apiBase = options.apiBase ?? webBase;
  const { commentWebBase } = options;
  const review = createReviewApi({
    webBase,
    apiBase,
    ...(commentWebBase === undefined
      ? {}
      : { commentWebBase: () => commentWebBase }),
    botLogin: `${options.appSlug ?? "fake-app"}[bot]`,
  });

  const actions = createActionsApi({
    webBase,
    apiBase,
    botLogin: `${options.appSlug ?? "fake-app"}[bot]`,
  });
  /** Branches a test added (`addBranch`), by repository. */
  const addedBranches = new Map<string, Map<string, string>>();

  const checks = createChecksApi({
    webBase,
    apiBase,
    botLogin: `${options.appSlug ?? "fake-app"}[bot]`,
    now,
  });

  const installations = new Map<number, FakeInstallation>();
  // What an installation has accepted, when a test says (#749); the app's permissions otherwise.
  const installationPermissions = new Map<number, FakePermissions>();
  const repositories = new Map<number, FakeRepository[]>();
  const pullRequests = new Map<string, FakePullRequest[]>();
  // Every head a pull request has had ("owner/name#7"): a review may name any of its commits (#405).
  const commits = new Map<string, Set<string>>();
  const noteCommit = (repoFullName: string, number: number, sha: string) => {
    const key = `${repoFullName}#${number}`;
    commits.set(key, new Set([...(commits.get(key) ?? []), sha]));
  };
  const gitRepositories = new Map<string, string>();
  const permissions = new Map<string, FakeCollaboratorPermission>();
  const tokens = new Map<string, IssuedToken>();
  const issuedTokens: string[] = [];
  const revoked: string[] = [];
  const tokenRequests: FakeTokenRequest[] = [];
  let appPermissions: FakePermissions = { ...DEFAULT_FAKE_APP_PERMISSIONS };
  const pushes: FakePush[] = [];

  /** What an installation holds: the app's permissions, cut down to what the installation accepted. */
  function permissionsOfInstallation(installationId: number): FakePermissions {
    const accepted = installationPermissions.get(installationId);
    if (accepted === undefined) return { ...appPermissions };
    return Object.fromEntries(
      Object.entries(appPermissions).flatMap(([name, level]) => {
        const held = accepted[name];
        if (held === undefined) return [];
        return [[name, levelOf(held) < levelOf(level) ? held : level]];
      }),
    ) as FakePermissions;
  }
  const omitted = new Map<number, number[]>();
  const rawInstallationRecords: Record<string, unknown>[] = [];
  let jwtsRejected = false;
  let tokenAnswerPatch: Record<string, unknown> | null = null;

  /** The app an App JWT is valid for: signed with its key, naming it as issuer, not expired. */
  function appForJwt(token: string): FakeRegisteredApp | undefined {
    if (jwtsRejected) return undefined;
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    const [header, payload, signature] = parts as [string, string, string];
    try {
      const claims = JSON.parse(base64urlDecode(payload).toString("utf8")) as {
        iss?: unknown;
        iat?: unknown;
        exp?: unknown;
      };
      if (typeof claims.iss !== "string" && typeof claims.iss !== "number")
        return undefined;
      const app = registry.byId(String(claims.iss));
      if (app?.publicKeyPem == null) return undefined;
      const signed = verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        createPublicKey(app.publicKeyPem),
        base64urlDecode(signature),
      );
      if (!signed) return undefined;
      const seconds = now() / 1000;
      return typeof claims.exp === "number" &&
        typeof claims.iat === "number" &&
        claims.exp > seconds &&
        claims.iat <= seconds &&
        claims.exp - claims.iat <= 600
        ? app
        : undefined;
    } catch {
      return undefined;
    }
  }

  const jwtIsValid = (token: string): boolean => appForJwt(token) !== undefined;

  const isStartApp = (app: FakeRegisteredApp): boolean =>
    app.id === options.appId;

  function installationToken(token: string): IssuedToken | undefined {
    const issued = tokens.get(token);
    if (issued === undefined || issued.expiresAtMs <= now()) return undefined;
    return installations.has(issued.installationId) ? issued : undefined;
  }

  /** The repository with the default branch of its Git fixture, when it has one (`git-branches.ts`). */
  function followingFixture(repo: FakeRepository): FakeRepository {
    const directory = gitRepositories.get(repo.fullName);
    if (directory === undefined) return repo;
    // A journey that is over removes its fixture and leaves the registration: the repository then keeps its own default
    // branch (the listing of an installation must not fail for the sake of another journey's repository, #767).
    let defaultBranch: string | null = null;
    try {
      defaultBranch = readFixtureBranches(directory).defaultBranch;
    } catch {
      return repo;
    }
    return defaultBranch === null ? repo : { ...repo, defaultBranch };
  }

  function reposVisibleTo(token: IssuedToken): FakeRepository[] {
    const all = repositories.get(token.installationId) ?? [];
    if (token.repositoryIds === null) return all.map(followingFixture);
    const allowed = token.repositoryIds;
    return all
      .filter((repo) => allowed.includes(repo.id))
      .map(followingFixture);
  }

  /**
   * The branches of a repository: those of its Git fixture, or, where the test registered none, the default
   * branch and the branches the pull requests of the repository name (the head at the head commit of the pull
   * request, every other at `BASE_SHA`).
   */
  function branchesOf(
    repo: FakeRepository,
    prs: FakePullRequest[],
  ): { name: string; sha: string }[] {
    const directory = gitRepositories.get(repo.fullName);
    if (directory !== undefined) return readFixtureBranches(directory).branches;
    const byName = new Map<string, string>([
      [repo.defaultBranch ?? "main", BASE_SHA],
    ]);
    for (const pr of prs) {
      if (!byName.has(pr.baseRef)) byName.set(pr.baseRef, BASE_SHA);
      byName.set(pr.headRef, pr.headSha);
    }
    for (const [name, sha] of addedBranches.get(repo.fullName) ?? [])
      byName.set(name, sha);
    return [...byName]
      .map(([name, sha]) => ({ name, sha }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** Does the token hold at least this level of the permission? */
  function mayDo(
    token: IssuedToken,
    permission: string,
    level: "read" | "write",
  ): boolean {
    return levelOf(token.permissions[permission]) >= levelOf(level);
  }

  async function handle(
    context: Parameters<AppPart["handle"]>[0],
  ): Promise<boolean> {
    let answered = false;
    await route(context, async (status, body) => {
      answered = true;
      await context.reply(status, body);
    });
    return answered || context.response.writableEnded;
  }

  // Answers through `send`; a path that is not part of the GitHub App API is left unanswered.
  async function route(
    context: Parameters<AppPart["handle"]>[0],
    send: (status: number, body: unknown) => Promise<void>,
  ): Promise<void> {
    const { request, url, bearer, response } = context;
    const path = url.pathname;
    const method = request.method ?? "GET";

    const unauthorized = () => send(401, { message: "Bad credentials" });
    const notFound = () => send(404, { message: "Not Found" });

    // Control endpoint for a test that runs the fake as its own process (Playwright): installs the
    // app for an account with these repositories, or replaces the repositories of an installation
    // that exists already. The body is `{ installation, repositories }` (the in-process controls
    // `addInstallation` and `setRepositories`, in one request).
    if (path === "/__fake/installations" && method === "POST") {
      const body = JSON.parse(await readBody(request)) as {
        installation: FakeInstallation;
        repositories: FakeRepository[];
      };
      if (!installations.has(body.installation.id))
        controls.addInstallation(body.installation);
      controls.setRepositories(body.installation.id, body.repositories);
      return send(201, { ok: true });
    }

    // Control endpoint for a test that runs the fake as its own process (Playwright): what the registered App is
    // granted (`setAppPermissions`), as `{ permissions: { contents: "write", ... } }`. The Implementer's journey (#767)
    // raises Contents to write, as the App of a factory deployment asks for it.
    if (path === "/__fake/app-permissions" && method === "POST") {
      const body = JSON.parse(await readBody(request)) as {
        permissions?: unknown;
      };
      const given = body.permissions;
      if (
        typeof given !== "object" ||
        given === null ||
        !Object.values(given).every(
          (level) => level === "read" || level === "write" || level === "admin",
        )
      )
        return send(400, { message: "Invalid body" });
      controls.setAppPermissions(given as FakePermissions);
      return send(201, { ok: true });
    }

    // Control endpoint for a test that runs the fake as its own process (Playwright): the setup URL of the
    // app registered at start, `{ url }` (null clears it).
    if (path === "/__fake/app-setup-url" && method === "POST") {
      const body = JSON.parse(await readBody(request)) as { url?: unknown };
      if (body.url !== null && typeof body.url !== "string")
        return send(400, { message: "Invalid body" });
      controls.setAppSetupUrl(body.url);
      return send(201, { ok: true });
    }

    // Control endpoint for a test that runs the fake as its own process (Playwright): adds a pull
    // request (`addPullRequest`), replacing one with the same number. The body is
    // `{ repository: "owner/name", pullRequest: FakePullRequest }`.
    if (path === "/__fake/pull-requests" && method === "POST") {
      const body = parsePullRequestControl(await readBody(request));
      if (body === null) return send(400, { message: "Invalid body" });
      controls.addPullRequest(body.repository, body.pullRequest);
      return send(201, { ok: true });
    }

    // Control endpoint for a test that runs the fake as its own process (Playwright): serves a Git
    // repository (`addGitRepository`). The body is `{ repository: "owner/name", path }`, the path of a `.git`
    // directory on this machine.
    if (path === "/__fake/git-repositories" && method === "POST") {
      const body = JSON.parse(await readBody(request)) as {
        repository?: unknown;
        path?: unknown;
      };
      if (typeof body.repository !== "string" || typeof body.path !== "string")
        return send(400, { message: "Invalid body" });
      controls.addGitRepository(body.repository, body.path);
      return send(201, { ok: true });
    }

    // Git over HTTP: the way the runner's checkout reads a pull request (`git-upload-pack`, needs Contents: read)
    // and the way the Implementer's turn publishes its branch (`git-receive-pack`, needs Contents: write). The
    // token is the Basic password.
    const gitMatch =
      /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(
        path,
      );
    if (gitMatch) {
      const gitToken = basicToken(request.headers.authorization);
      const gitIssued =
        gitToken === undefined ? undefined : installationToken(gitToken);
      if (gitIssued === undefined) {
        // Like GitHub, the challenge names Basic: a client with URL credentials or a credential helper answers it and
        // retries, and only `http.extraHeader` gets through without it.
        response.writeHead(401, {
          "content-type": "application/json",
          "www-authenticate": 'Basic realm="GitHub"',
        });
        response.end(JSON.stringify({ message: "Bad credentials" }));
        return;
      }
      const gitName = `${gitMatch[1]}/${gitMatch[2]}`;
      const visible = reposVisibleTo(gitIssued).find(
        (repo) => repo.fullName === gitName,
      );
      const directory = gitRepositories.get(gitName);
      if (visible === undefined || directory === undefined) return notFound();
      const advertise = gitMatch[3] === "info/refs";
      const service = advertise ? url.searchParams.get("service") : gitMatch[3];
      if (service !== "git-upload-pack" && service !== "git-receive-pack")
        return notFound();
      const pushing = service === "git-receive-pack";
      if (!mayDo(gitIssued, "contents", pushing ? "write" : "read"))
        return send(403, { message: "Resource not accessible by integration" });
      if (advertise !== (method === "GET")) return notFound();
      if (!pushing) {
        await serveUploadPack(request, response, directory, advertise);
        return;
      }
      const refs = await serveReceivePack(
        request,
        response,
        directory,
        advertise,
      );
      // Only a POST with a command is a push. The client's 4-byte probe of a request over 1 MB (it asks whether the
      // server takes the body at all) names no ref and is neither recorded nor listed.
      if (!advertise && refs.length > 0) {
        pushes.push({ repository: gitName, refs });
        context.logRefs(refs);
      }
      return;
    }

    // Control endpoint for a test that runs the fake as its own process (Playwright): the pushes received, as
    // `{ pushes }`, of one repository when `?repository=owner/name` is given (`pushes`).
    if (path === "/__fake/pushes" && method === "GET") {
      const repository = url.searchParams.get("repository");
      return send(200, {
        pushes: controls
          .pushes()
          .filter(
            (push) => repository === null || push.repository === repository,
          ),
      });
    }

    // Control endpoint for a test that runs the fake as its own process (Playwright): the comments
    // below a pull request, as `?repository=owner/name&number=7`.
    if (path === "/__fake/comments" && method === "GET") {
      const repository = url.searchParams.get("repository") ?? "";
      const number = Number(url.searchParams.get("number"));
      if (repository === "" || !Number.isInteger(number))
        return send(400, { message: "Invalid query" });
      return send(200, review.comments(repository, number));
    }

    // Control endpoints for a test that runs the fake as its own process (Playwright): the check runs of a
    // repository (`?repository=owner/name`) and the reviews of a pull request (`&number=7`) with the decision
    // GitHub would count (#405).
    if (path === "/__fake/check-runs" && method === "GET") {
      const repository = url.searchParams.get("repository") ?? "";
      if (repository === "") return send(400, { message: "Invalid query" });
      return send(200, checks.checkRuns(repository));
    }
    if (path === "/__fake/reviews" && method === "GET") {
      const repository = url.searchParams.get("repository") ?? "";
      const number = Number(url.searchParams.get("number"));
      if (repository === "" || !Number.isInteger(number))
        return send(400, { message: "Invalid query" });
      return send(200, {
        reviews: checks.reviews(repository, number),
        decisions: checks.reviewDecisions(repository, number),
      });
    }

    // Control endpoint for a test that runs the fake as its own process (Playwright): every
    // installation token issued so far, so a test can search outputs for them.
    if (path === "/__fake/installation-tokens" && method === "GET")
      return send(200, issuedTokens);

    // App JWT endpoints
    // The app itself, as GitHub describes it to its own JWT: id, slug, owner and what it is granted.
    // A person who types the credentials of an app by hand is checked against this answer.
    if (path === "/app" && method === "GET") {
      const app = bearer === undefined ? undefined : appForJwt(bearer);
      if (app === undefined) return unauthorized();
      return send(200, {
        id: Number(app.id),
        slug: app.slug,
        name: app.name,
        owner: { login: app.ownerLogin, id: app.ownerId, type: "User" },
        description: "",
        external_url: webBase(),
        html_url: `${webBase()}/apps/${app.slug}`,
        permissions: isStartApp(app)
          ? { ...appPermissions, ...app.accountPermissions }
          : { ...app.permissions, ...app.accountPermissions },
        events: app.events,
      });
    }

    if (path === "/app/installations" && method === "GET") {
      if (bearer === undefined || !jwtIsValid(bearer)) return unauthorized();
      const list: unknown[] = [...installations.values()].map(
        (installation) => ({
          id: installation.id,
          account: accountJson(installation.account, webBase()),
          suspended_at: installation.suspended ? "2026-10-01T00:00:00Z" : null,
          app_id: Number(appForJwt(bearer)?.id),
          permissions: permissionsOfInstallation(installation.id),
        }),
      );
      list.push(...rawInstallationRecords);
      return send(200, pageOf(list, url.searchParams));
    }

    const installationMatch = /^\/app\/installations\/(\d+)$/.exec(path);
    if (installationMatch && method === "GET") {
      if (bearer === undefined || !jwtIsValid(bearer)) return unauthorized();
      const installation = installations.get(Number(installationMatch[1]));
      if (installation === undefined) return notFound();
      return send(200, {
        id: installation.id,
        account: accountJson(installation.account, webBase()),
        suspended_at: installation.suspended ? "2026-10-01T00:00:00Z" : null,
        app_id: Number(appForJwt(bearer)?.id),
        permissions: permissionsOfInstallation(installation.id),
      });
    }

    const tokenMatch = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(
      path,
    );
    if (tokenMatch && method === "POST") {
      if (bearer === undefined || !jwtIsValid(bearer)) return unauthorized();
      const installationId = Number(tokenMatch[1]);
      const installation = installations.get(installationId);
      if (installation === undefined) return notFound();
      if (installation.suspended)
        return send(403, { message: "This installation is suspended" });

      const body = await readBody(request);
      let names: string[] | null = null;
      let ids: number[] | null = null;
      let requested: Record<string, string> | null = null;
      if (body !== "") {
        const parsed = JSON.parse(body) as {
          repositories?: unknown;
          repository_ids?: unknown;
          permissions?: unknown;
        };
        if (Array.isArray(parsed.repositories))
          names = parsed.repositories.map(String);
        if (Array.isArray(parsed.repository_ids))
          ids = parsed.repository_ids.map(Number);
        if (
          typeof parsed.permissions === "object" &&
          parsed.permissions !== null
        )
          requested = Object.fromEntries(
            Object.entries(parsed.permissions).map(([key, level]) => [
              key,
              String(level),
            ]),
          );
      }
      tokenRequests.push({
        installationId,
        repositories: names,
        repositoryIds: ids,
        permissions: requested,
      });

      // Like GitHub: a repository the installation does not have is refused as a whole (422), and
      // so is a permission the app does not hold at that level. Nothing broader is issued instead.
      const known = repositories.get(installationId) ?? [];
      const unknownName =
        names !== null &&
        names.some(
          (name) => !known.some((repo) => repo.fullName.split("/")[1] === name),
        );
      const unknownId =
        ids !== null &&
        ids.some(
          (id) =>
            !Number.isInteger(id) || !known.some((repo) => repo.id === id),
        );
      if (unknownName || unknownId)
        return send(422, {
          message:
            "There is at least one repository that does not exist or is not accessible",
        });
      const held = permissionsOfInstallation(installationId);
      if (
        requested !== null &&
        Object.entries(requested).some(
          ([key, level]) =>
            levelOf(level) < 0 || levelOf(level) > levelOf(held[key]),
        )
      )
        return send(422, {
          message:
            "The permissions requested are not granted to this installation",
        });

      let reach: number[] | null = null;
      if (names !== null || ids !== null)
        reach = known
          .filter(
            (repo) =>
              (names?.includes(repo.fullName.split("/")[1] ?? "") ?? false) ||
              (ids?.includes(repo.id) ?? false),
          )
          .map((repo) => repo.id);
      const granted: FakePermissions =
        requested === null ? { ...held } : (requested as FakePermissions);

      const token = `ghs_fake${randomBytes(16).toString("hex")}`;
      const expiresAtMs = now() + TOKEN_LIFETIME_MS;
      tokens.set(token, {
        installationId,
        repositoryIds: reach,
        permissions: granted,
        expiresAtMs,
      });
      issuedTokens.push(token);
      return send(201, {
        token,
        expires_at: new Date(expiresAtMs).toISOString(),
        permissions: granted,
        repository_selection: reach === null ? "all" : "selected",
        ...(reach === null
          ? {}
          : {
              repositories: known
                .filter((repo) => reach.includes(repo.id))
                .map((repo) =>
                  repositoryJson(followingFixture(repo), webBase()),
                ),
            }),
        ...tokenAnswerPatch,
      });
    }

    // Installation token endpoints
    const issued = bearer === undefined ? undefined : installationToken(bearer);

    if (path === "/installation/token" && method === "DELETE") {
      if (issued === undefined || bearer === undefined) return unauthorized();
      tokens.delete(bearer);
      revoked.push(bearer);
      response.writeHead(204);
      response.end();
      return;
    }

    if (path === "/installation/repositories" && method === "GET") {
      if (issued === undefined) return unauthorized();
      const all = reposVisibleTo(issued);
      const hidden = omitted.get(issued.installationId) ?? [];
      const listed = all.filter((repo) => !hidden.includes(repo.id));
      return send(200, {
        total_count: all.length,
        repositories: pageOf(listed, url.searchParams).map((repo) =>
          repositoryJson(repo, webBase()),
        ),
      });
    }

    const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    if (repoMatch) {
      if (issued === undefined) return unauthorized();
      const fullName = `${repoMatch[1]}/${repoMatch[2]}`;
      const repository = reposVisibleTo(issued).find(
        (repo) => repo.fullName === fullName,
      );
      if (repository === undefined) return notFound();
      const rest = repoMatch[3] ?? "";
      const prs = pullRequests.get(fullName) ?? [];

      const forbidden = () =>
        send(403, { message: "Resource not accessible by integration" });

      if (rest === "/pulls" && method === "GET") {
        if (!mayDo(issued, "pull_requests", "read")) return forbidden();
        const state = url.searchParams.get("state") ?? "open";
        // `head=owner:branch` and `base=branch` narrow the list, as on GitHub (#844).
        const head = url.searchParams
          .get("head")
          ?.split(":")
          .slice(1)
          .join(":");
        const base = url.searchParams.get("base");
        const matching = prs.filter(
          (pr) =>
            (state === "all" || pr.state === state) &&
            (head === undefined || pr.headRef === head) &&
            (base === null || pr.baseRef === base),
        );
        return send(
          200,
          pageOf(matching, url.searchParams).map((pr) =>
            review.pullRequestJson(repository, pr),
          ),
        );
      }
      const permissionMatch = /^\/collaborators\/([^/]+)\/permission$/.exec(
        rest,
      );
      if (permissionMatch && method === "GET") {
        if (!mayDo(issued, "metadata", "read")) return forbidden();
        const login = decodeURIComponent(permissionMatch[1] ?? "");
        const permission =
          permissions.get(`${fullName}#${login.toLowerCase()}`) ?? "none";
        return send(200, {
          permission,
          user: { login },
        });
      }

      // Opening a pull request, issues and their labels (#844).
      const actionsAnswer = await actions.handle({
        method,
        rest,
        query: url.searchParams,
        repository,
        pullRequestNumbers: prs.map((pr) => pr.number),
        openPullRequest: (head, base) =>
          prs.find(
            (pr) =>
              pr.state === "open" && pr.headRef === head && pr.baseRef === base,
          )?.number,
        branches: () => branchesOf(repository, prs),
        defaultBranch: repository.defaultBranch ?? "main",
        body: () => readBody(request),
        mayDo: (names, level) =>
          names.some((name) => mayDo(issued, name, level)),
        createPullRequest(fields) {
          const pullRequest: FakePullRequest = {
            number: fields.number,
            title: fields.title,
            body: fields.body,
            state: "open",
            draft: fields.draft,
            headSha: fields.headSha,
            headRef: fields.headRef,
            baseRef: fields.baseRef,
            author: { login: `${options.appSlug ?? "fake-app"}[bot]`, id: 1 },
          };
          controls.addPullRequest(fullName, pullRequest);
          return review.pullRequestJson(repository, pullRequest);
        },
      });
      if (actionsAnswer !== undefined)
        return send(actionsAnswer.status, actionsAnswer.body);

      // Check runs and pull request reviews (#405).
      const checksAnswer = await checks.handle({
        method,
        rest,
        query: url.searchParams,
        repository,
        pullRequests: prs,
        commitsOf: (number) =>
          commits.get(`${fullName}#${number}`) ?? new Set(),
        body: () => readBody(request),
        mayDo: (names, level) =>
          names.some((name) => mayDo(issued, name, level)),
      });
      if (checksAnswer !== undefined)
        return send(checksAnswer.status, checksAnswer.body);

      // The rest is what a reviewer reads and writes: one pull request, its files, comments, ...
      const answer = await review.handle({
        method,
        rest,
        query: url.searchParams,
        repository,
        pullRequests: prs,
        branches: () => branchesOf(repository, prs),
        body: () => readBody(request),
        mayDo: (names, level) =>
          names.some((name) => mayDo(issued, name, level)),
        changePullRequest(number, changes) {
          const changed = prs.map((pr) =>
            pr.number === number ? { ...pr, ...changes } : pr,
          );
          pullRequests.set(fullName, changed);
          return changed.find((pr) => pr.number === number) as FakePullRequest;
        },
      });
      if (answer === undefined) return;
      if (answer.status === 204) {
        response.writeHead(204);
        response.end();
        return;
      }
      return send(answer.status, answer.body);
    }

    // Calls a reviewer makes that name no repository.
    if (issued !== undefined && method === "GET" && path === "/rate_limit") {
      const window = {
        limit: 5000,
        remaining: 4999,
        reset: 4102444800,
        used: 1,
      };
      return send(200, {
        resources: { core: window, graphql: window },
        rate: window,
      });
    }
    if (
      issued !== undefined &&
      method === "POST" &&
      (path === "/graphql" || path === "/api/graphql")
    ) {
      // PR-Agent asks for the review threads of the pull request; there are none.
      return send(200, {
        data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
      });
    }
  }

  const controls: FakeGithubAppControls = {
    addInstallation(installation) {
      installations.set(installation.id, installation);
      if (!repositories.has(installation.id))
        repositories.set(installation.id, []);
    },
    installations: () => [...installations.values()],
    setAppSetupUrl(url) {
      const start = options.appId && registry.byId(options.appId);
      if (start) start.setupUrl = url;
    },
    removeInstallation(id) {
      installations.delete(id);
      installationPermissions.delete(id);
      repositories.delete(id);
    },
    suspendInstallation(id, suspended) {
      const installation = installations.get(id);
      if (installation) installation.suspended = suspended;
    },
    setRepositories(installationId, list) {
      repositories.set(installationId, [...list]);
    },
    omitFromListings(installationId, repositoryIds) {
      omitted.set(installationId, [...repositoryIds]);
    },
    addRawInstallationRecord(record) {
      rawInstallationRecords.push(record);
    },
    addRepository(installationId, repository) {
      const list = repositories.get(installationId) ?? [];
      repositories.set(installationId, [
        ...list.filter((item) => item.id !== repository.id),
        repository,
      ]);
    },
    removeRepository(installationId, repositoryId) {
      repositories.set(
        installationId,
        (repositories.get(installationId) ?? []).filter(
          (item) => item.id !== repositoryId,
        ),
      );
    },
    addPullRequest(repoFullName, pullRequest) {
      noteCommit(repoFullName, pullRequest.number, pullRequest.headSha);
      pullRequests.set(repoFullName, [
        ...(pullRequests.get(repoFullName) ?? []).filter(
          (existing) => existing.number !== pullRequest.number,
        ),
        pullRequest,
      ]);
    },
    addGitRepository(repoFullName, path) {
      gitRepositories.set(repoFullName, path);
    },
    updatePullRequest(repoFullName, number, changes) {
      const existing = pullRequests.get(repoFullName) ?? [];
      if (!existing.some((pr) => pr.number === number))
        throw new Error(`no pull request ${number} in ${repoFullName}`);
      if (changes.headSha !== undefined)
        noteCommit(repoFullName, number, changes.headSha);
      pullRequests.set(
        repoFullName,
        existing.map((pr) =>
          pr.number === number ? { ...pr, ...changes } : pr,
        ),
      );
    },
    setCollaboratorPermission(repoFullName, login, permission) {
      permissions.set(`${repoFullName}#${login.toLowerCase()}`, permission);
    },
    addBranch(repoFullName, name, sha) {
      const branches = addedBranches.get(repoFullName) ?? new Map();
      branches.set(name, sha);
      addedBranches.set(repoFullName, branches);
    },
    addIssue: (repoFullName, issue) => actions.addIssue(repoFullName, issue),
    issueLabels: (repoFullName, number) => actions.labels(repoFullName, number),
    issueComments: (repoFullName, number) =>
      actions.issueComments(repoFullName, number),
    pullRequestComments: (repoFullName, number) =>
      review.comments(repoFullName, number),
    addPullRequestComment: (repoFullName, number, body, login) =>
      review.addComment(repoFullName, number, body, login),
    checkRuns: (repoFullName) => checks.checkRuns(repoFullName),
    pullRequestReviews: (repoFullName, number) =>
      checks.reviews(repoFullName, number),
    addPullRequestReview: (repoFullName, number, review) =>
      checks.addReview(repoFullName, number, review),
    pullRequestReviewDecisions: (repoFullName, number) =>
      checks.reviewDecisions(repoFullName, number),
    setAppPermissions(permissions) {
      appPermissions = { ...permissions };
    },
    setInstallationPermissions(installationId, permissions) {
      installationPermissions.set(installationId, { ...permissions });
    },
    setAppAccountPermissions(permissions) {
      const start = options.appId && registry.byId(options.appId);
      if (start) start.accountPermissions = { ...permissions };
    },
    answerTokensWith(patch) {
      tokenAnswerPatch = patch;
    },
    rejectAppJwts(reject) {
      jwtsRejected = reject;
    },
    tokenRequests: () => [...tokenRequests],
    issuedInstallationTokens: () => [...issuedTokens],
    revokedInstallationTokens: () => [...revoked],
    pushes: () => pushes.map((push) => ({ ...push, refs: [...push.refs] })),
  };

  return {
    controls,
    handle,
    reset() {
      installations.clear();
      repositories.clear();
      pullRequests.clear();
      commits.clear();
      gitRepositories.clear();
      permissions.clear();
      review.reset();
      actions.reset();
      addedBranches.clear();
      checks.reset();
      omitted.clear();
      rawInstallationRecords.length = 0;
      tokens.clear();
      issuedTokens.length = 0;
      revoked.length = 0;
      tokenRequests.length = 0;
      pushes.length = 0;
      jwtsRejected = false;
      tokenAnswerPatch = null;
      appPermissions = { ...DEFAULT_FAKE_APP_PERMISSIONS };
      installationPermissions.clear();
      const start = options.appId && registry.byId(options.appId);
      if (start) {
        start.accountPermissions = { ...DEFAULT_ACCOUNT_PERMISSIONS };
        start.setupUrl = null;
      }
    },
  };
}
