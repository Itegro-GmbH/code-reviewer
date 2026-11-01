// SPDX-License-Identifier: LicenseRef-Proprietary

// An in-memory GithubAppClient for unit tests of the provider: no HTTP, no GitHub. It answers from
// plain data and records every call. (The real client is tested against the fake GitHub API.)
import type {
  CollaboratorPermission,
  GithubAppClient,
  IssueComment,
  PullRequestReview,
  ReadIssueComment,
  RemoteInstallation,
  RemoteRepository,
} from "./client.ts";
import { GithubAppError } from "./errors.ts";
import type { PullRequestRef } from "../../types.ts";

/** An installation the way a test writes it: the permissions it holds (#749) are empty unless it says. */
export type FakeRemoteInstallation = Omit<RemoteInstallation, "permissions"> &
  Partial<Pick<RemoteInstallation, "permissions">>;

const withPermissions = (
  installation: FakeRemoteInstallation,
): RemoteInstallation => ({ permissions: {}, ...installation });

export type FakeGithubAppClientData = {
  installations?: FakeRemoteInstallation[];
  repositories?: Record<string, RemoteRepository[]>;
  /** Pull requests by "owner/name". */
  pullRequests?: Record<string, PullRequestRef[]>;
  /** Permissions by "owner/name#login". */
  permissions?: Record<string, CollaboratorPermission>;
  token?: { token: string; expiresAt: string };
  /** Makes `mintInstallationToken` reject with this error. */
  mintFailure?: Error;
  /** Makes `revokeInstallationToken` reject with this error (the real one never rejects; for a test of a caller that must not trust that). */
  revokeFailure?: Error;
  /** Makes `listOpenPullRequests` reject with this error. */
  listPullRequestsFailure?: Error;
  /** Makes `createIssueComment` reject with this error. */
  commentFailure?: Error;
  /** Makes `listIssueComments` reject with this error. */
  listCommentsFailure?: Error;
  /** What `listIssueComments` answers, by "owner/name#number". */
  comments?: Record<string, IssueComment[]>;
  /** What `getIssueComment` answers, by "owner/name#id"; a comment not listed is not found (#657). */
  issueComments?: Record<string, ReadIssueComment>;
  /** Makes `getIssueComment` reject with this error (#657). */
  getCommentFailure?: Error;
  /** Makes `createCheckRun`, `updateCheckRun` and `findCheckRun` reject with this error (#405). */
  checkRunFailure?: Error;
  /** What `findCheckRun` answers; null (the default) finds none. */
  foundCheckRun?: { id: string } | null;
  /** Makes `createPullRequestReview` reject with this error (#405). */
  reviewFailure?: Error;
  /** What `listPullRequestReviews` answers, by "owner/name#number" (#405). */
  reviews?: Record<string, PullRequestReview[]>;
  /** Makes `getPullRequest` reject with this error (an unknown pull request is rejected anyway). */
  getPullRequestFailure?: Error;
  /** The default branch of every repository (#750). Default: main. */
  defaultBranch?: string;
  /** The branches of every repository, by name, each with its head commit (#750). Default: the default branch only. */
  branches?: Record<string, string>;
  /** Makes `getRepositoryFacts`, `listBranches` and `getBranch` reject with this error (#750). */
  branchReadFailure?: Error;
};

export type FakeGithubAppClient = GithubAppClient & {
  readonly calls: Array<{ method: string; args: unknown[] }>;
};

export const FAKE_PULL_REQUEST: PullRequestRef = {
  number: 7,
  title: "Add widget caching",
  url: "https://github.com/acme/widgets/pull/7",
  headSha: "1f3a5c7e9b2d4f60a8c1e3b5d7f90a2c4e6b8d01",
  baseRef: "main",
  headRef: "feature/caching",
  draft: false,
  state: "open",
  author: { login: "alice", externalId: "1001" },
};

/** Like the real client: a signal that has fired means no request and GITHUB_APP_UNAVAILABLE. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted)
    throw new GithubAppError(
      "GITHUB_APP_UNAVAILABLE",
      "GitHub could not be reached.",
    );
}

export function fakeGithubAppClient(
  data: FakeGithubAppClientData = {},
): FakeGithubAppClient {
  const calls: FakeGithubAppClient["calls"] = [];
  const record = (method: string, ...args: unknown[]) =>
    calls.push({ method, args });
  const pullRequests = data.pullRequests ?? {
    "acme/widgets": [FAKE_PULL_REQUEST],
  };

  const branchesOf = (): Record<string, string> =>
    data.branches ?? { [data.defaultBranch ?? "main"]: "a".repeat(40) };

  return {
    calls,
    async getApp() {
      record("getApp");
      return {
        id: "424242",
        slug: "code-reviewer-test",
        owner: { id: 1, login: "acme" },
        permissions: {},
      };
    },
    async listInstallations() {
      record("listInstallations");
      return (data.installations ?? []).map(withPermissions);
    },
    async getInstallation(installationId) {
      record("getInstallation", installationId);
      const found = (data.installations ?? []).find(
        (item) => item.id === installationId,
      );
      return found === undefined ? null : withPermissions(found);
    },
    async listInstallationRepositories(installationId) {
      record("listInstallationRepositories", installationId);
      return (
        data.repositories?.[installationId] ?? [
          {
            externalId: "7001",
            fullName: "acme/widgets",
            url: "https://github.com/acme/widgets",
          },
        ]
      );
    },
    async getPullRequest(installationId, repoFullName, prNumber, signal) {
      record(
        "getPullRequest",
        installationId,
        repoFullName,
        prNumber,
        ...(signal === undefined ? [] : [signal]),
      );
      throwIfAborted(signal);
      if (data.getPullRequestFailure) throw data.getPullRequestFailure;
      const found = (pullRequests[repoFullName] ?? []).find(
        (pr) => pr.number === prNumber,
      );
      if (found === undefined)
        throw new GithubAppError("GITHUB_APP_NOT_FOUND", "Not found", {
          status: 404,
        });
      return found;
    },
    async listOpenPullRequests(installationId, repoFullName, signal) {
      record(
        "listOpenPullRequests",
        installationId,
        repoFullName,
        ...(signal === undefined ? [] : [signal]),
      );
      throwIfAborted(signal);
      if (data.listPullRequestsFailure) throw data.listPullRequestsFailure;
      return (pullRequests[repoFullName] ?? []).filter(
        (pr) => pr.state === "open",
      );
    },
    async getRepositoryFacts(installationId, scope, repoFullName, signal) {
      record(
        "getRepositoryFacts",
        installationId,
        scope,
        repoFullName,
        ...(signal === undefined ? [] : [signal]),
      );
      throwIfAborted(signal);
      if (data.branchReadFailure) throw data.branchReadFailure;
      return { defaultBranch: data.defaultBranch ?? "main" };
    },
    async listBranches(installationId, scope, repoFullName, signal) {
      record(
        "listBranches",
        installationId,
        scope,
        repoFullName,
        ...(signal === undefined ? [] : [signal]),
      );
      throwIfAborted(signal);
      if (data.branchReadFailure) throw data.branchReadFailure;
      const defaultBranch = data.defaultBranch ?? "main";
      const all = [
        defaultBranch,
        ...Object.keys(branchesOf())
          .filter((name) => name !== defaultBranch)
          .sort(),
      ];
      return { names: all.slice(0, 100), truncated: all.length > 100 };
    },
    async getBranch(installationId, scope, repoFullName, name, signal) {
      record(
        "getBranch",
        installationId,
        scope,
        repoFullName,
        name,
        ...(signal === undefined ? [] : [signal]),
      );
      throwIfAborted(signal);
      if (data.branchReadFailure) throw data.branchReadFailure;
      const sha = branchesOf()[name];
      return sha === undefined ? null : { sha };
    },
    async getCollaboratorPermission(installationId, repoFullName, login) {
      record("getCollaboratorPermission", installationId, repoFullName, login);
      return data.permissions?.[`${repoFullName}#${login}`] ?? "none";
    },
    async listIssueComments(installationId, scope, repoFullName, prNumber) {
      record(
        "listIssueComments",
        installationId,
        scope,
        repoFullName,
        prNumber,
      );
      if (data.listCommentsFailure) throw data.listCommentsFailure;
      return data.comments?.[`${repoFullName}#${prNumber}`] ?? [];
    },
    async getIssueComment(
      installationId,
      scope,
      repoFullName,
      commentId,
      signal,
    ) {
      record(
        "getIssueComment",
        installationId,
        scope,
        repoFullName,
        commentId,
        ...(signal === undefined ? [] : [signal]),
      );
      throwIfAborted(signal);
      if (data.getCommentFailure) throw data.getCommentFailure;
      return data.issueComments?.[`${repoFullName}#${commentId}`] ?? null;
    },
    async createIssueComment(
      installationId,
      scope,
      repoFullName,
      prNumber,
      body,
    ) {
      record(
        "createIssueComment",
        installationId,
        scope,
        repoFullName,
        prNumber,
        body,
      );
      if (data.commentFailure) throw data.commentFailure;
      return { id: "5001" };
    },
    async createCheckRun(installationId, scope, repoFullName, input) {
      record("createCheckRun", installationId, scope, repoFullName, input);
      if (data.checkRunFailure) throw data.checkRunFailure;
      return { id: "9001" };
    },
    async updateCheckRun(
      installationId,
      scope,
      repoFullName,
      checkRunId,
      input,
    ) {
      record(
        "updateCheckRun",
        installationId,
        scope,
        repoFullName,
        checkRunId,
        input,
      );
      if (data.checkRunFailure) throw data.checkRunFailure;
    },
    async findCheckRun(installationId, scope, repoFullName, lookup) {
      record("findCheckRun", installationId, scope, repoFullName, lookup);
      if (data.checkRunFailure) throw data.checkRunFailure;
      return data.foundCheckRun ?? null;
    },
    async createPullRequestReview(
      installationId,
      scope,
      repoFullName,
      prNumber,
      input,
    ) {
      record(
        "createPullRequestReview",
        installationId,
        scope,
        repoFullName,
        prNumber,
        input,
      );
      if (data.reviewFailure) throw data.reviewFailure;
      return { id: "6001" };
    },
    async listPullRequestReviews(
      installationId,
      scope,
      repoFullName,
      prNumber,
    ) {
      record(
        "listPullRequestReviews",
        installationId,
        scope,
        repoFullName,
        prNumber,
      );
      if (data.reviewFailure) throw data.reviewFailure;
      return data.reviews?.[`${repoFullName}#${prNumber}`] ?? [];
    },
    async dismissPullRequestReview(
      installationId,
      scope,
      repoFullName,
      prNumber,
      reviewId,
      message,
    ) {
      record(
        "dismissPullRequestReview",
        installationId,
        scope,
        repoFullName,
        prNumber,
        reviewId,
        message,
      );
      if (data.reviewFailure) throw data.reviewFailure;
    },
    async revokeInstallationToken(token) {
      record("revokeInstallationToken", token);
      if (data.revokeFailure) throw data.revokeFailure;
      return true;
    },
    async mintInstallationToken(installationId, scope) {
      record("mintInstallationToken", installationId, scope);
      if (data.mintFailure) throw data.mintFailure;
      return (
        data.token ?? {
          token: "ghs_unit_test_token",
          expiresAt: "2026-10-10T13:00:00.000Z",
        }
      );
    },
  };
}
