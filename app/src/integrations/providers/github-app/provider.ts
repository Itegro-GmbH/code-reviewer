// SPDX-License-Identifier: LicenseRef-Proprietary

// The GitHub App as an IntegrationProvider: one installation of our own app is one integration.
// Everything GitHub specific stays in this folder; the rest of the app sees normalized types only.
// See ../../README.md.
import { createHash } from "node:crypto";
import type { CapabilitySet } from "../../../capabilities/capability.ts";
import {
  validateConfigAgainstSchema,
  type ConfigSchema,
} from "../../config-schema.ts";
import { IntegrationError } from "../../errors.ts";
import { createGitAccess } from "../../normalized.ts";
import type { IntegrationProvider } from "../../provider.ts";
import type {
  DiscoveredConnection,
  Integration,
  RepoRef,
} from "../../types.ts";
import {
  createGithubAppClient,
  type GithubAppClient,
  type GithubAppClientOptions,
  type RemoteInstallation,
} from "./client.ts";
import type { GithubAppConfig } from "./config.ts";
import { GithubAppError } from "./errors.ts";
import { parseGithubEvent } from "./events.ts";
import {
  BRANCH_READ_TOKEN_PERMISSIONS,
  CHECK_TOKEN_PERMISSIONS,
  IMPLEMENTER_TOKEN_PERMISSIONS,
  JOB_TOKEN_PERMISSIONS,
  COMMENT_READ_TOKEN_PERMISSIONS,
  NOTICE_TOKEN_PERMISSIONS,
  VERDICT_TOKEN_PERMISSIONS,
  jobTokenRepositoryIds,
  toImplementerAccessError,
  toJobAccessError,
  toReadError,
  toWriteError,
} from "./job-access.ts";
import { isValidSignature } from "./webhook-signature.ts";
import { field, payloadProblems } from "./webhook-fields.ts";

const CONFIG_SCHEMA: ConfigSchema = {
  accountLogin: { type: "string" },
  accountId: { type: "number" },
  accountType: { type: "string" },
};

export type GithubAppProviderOptions = {
  /**
   * The settings, or a function that reads them. The provider is created when the app loads, so a
   * missing setting must not break anything else: it fails the call that needs GitHub, with
   * GITHUB_APP_CONFIG_INVALID, and works again once the settings are fixed. A function is asked on
   * every call and its answer is not remembered: a webhook secret or a key that the admin replaced
   * counts from the next request on, on every app instance (docs/decisions/0001-editions-setup-and-
   * accounts.md, section 2.10). Only the HTTP client is kept, for as long as the settings it was made
   * for are the settings in force.
   */
  config: GithubAppConfig | (() => GithubAppConfig | Promise<GithubAppConfig>);
  /** Replaces the HTTP client; for unit tests. */
  client?: GithubAppClient;
  /** Passed to the default client (a different fetch, clock or timeout). */
  clientOptions?: Omit<GithubAppClientOptions, "config">;
  /**
   * The capabilities of the deployment (#753), asked on every call. The token of the Implementer is made only where
   * `allowsReviewKind("implementer")` holds; left out, none is: the default is closed, so a provider wired without it, or a
   * deployment of another product (code-review.com) whose App was set to write by hand, can never mint a write token.
   */
  capabilities?: () => CapabilitySet;
};

function toDiscovered(installation: RemoteInstallation): DiscoveredConnection {
  return {
    externalId: installation.id,
    displayName: installation.accountLogin,
    config: {
      accountLogin: installation.accountLogin,
      accountId: installation.accountId,
      accountType: installation.accountType,
    },
    suspended: installation.suspended,
  };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.clone().json();
  } catch {
    return undefined;
  }
}

/** The token of a branch read: this one repository, contents read; refused for a repository of another integration. */
function branchReadScope(integration: Integration, repo: RepoRef) {
  const repositoryIds = jobTokenRepositoryIds(repo.externalId);
  if (repo.integrationId !== integration.id || repositoryIds === null)
    throw new IntegrationError(
      "INTEGRATION_ACCESS_SCOPE_REFUSED",
      "The repository does not belong to this integration or has no usable id.",
    );
  return { repositoryIds, permissions: BRANCH_READ_TOKEN_PERMISSIONS };
}

export function createGithubAppProvider(
  options: GithubAppProviderOptions,
): IntegrationProvider {
  let resolvedClient:
    { fingerprint: string; client: GithubAppClient } | undefined;

  async function getConfig(): Promise<GithubAppConfig> {
    return typeof options.config === "function"
      ? await options.config()
      : options.config;
  }

  // What the client was made from. The key is hashed, so nothing secret is kept as a string.
  function fingerprintOf(config: GithubAppConfig): string {
    return [
      config.appId,
      config.slug,
      config.apiBaseUrl,
      createHash("sha256").update(config.privateKey).digest("hex"),
    ].join("\n");
  }

  async function getClient(): Promise<GithubAppClient> {
    // Reading the settings first makes an injected client fail like the real one when they are bad.
    const config = await getConfig();
    if (options.client) return options.client;
    const fingerprint = fingerprintOf(config);
    if (resolvedClient?.fingerprint !== fingerprint)
      resolvedClient = {
        fingerprint,
        client: createGithubAppClient({ ...options.clientOptions, config }),
      };
    return resolvedClient.client;
  }

  async function hasWriteAccess(
    installationId: string,
    repoFullName: string,
    login: string,
  ): Promise<boolean> {
    const permission = await (
      await getClient()
    ).getCollaboratorPermission(installationId, repoFullName, login);
    return permission === "admin" || permission === "write";
  }

  return {
    type: "github_app",
    connect: { kind: "install_redirect" },

    validateConfig(config) {
      return validateConfigAgainstSchema(CONFIG_SCHEMA, config);
    },

    async discoverConnections() {
      return (await (await getClient()).listInstallations()).map(toDiscovered);
    },

    async findConnection(externalId) {
      const installation = await (
        await getClient()
      ).getInstallation(externalId);
      return installation === null ? null : toDiscovered(installation);
    },

    async ownerAccount() {
      const { owner } = await (await getClient()).getApp();
      return owner === null
        ? null
        : { externalId: String(owner.id), login: owner.login };
    },

    async listRepositories(integration) {
      const remote = await (
        await getClient()
      ).listInstallationRepositories(integration.externalId);
      return remote.map((repo): RepoRef => ({
        integrationId: integration.id,
        externalId: repo.externalId,
        fullName: repo.fullName,
        url: repo.url,
      }));
    },

    async verifyWebhook(_integration, request) {
      // The bytes as received, not decoded text: the signature covers exactly these.
      const body = new Uint8Array(await request.clone().arrayBuffer());
      return isValidSignature(
        body,
        request.headers.get("x-hub-signature-256"),
        (await getConfig()).webhookSecret,
      );
    },

    async identifyWebhook(request) {
      const payload = await readJson(request);
      if (payloadProblems("installation", payload).includes("installation.id"))
        return null;
      return { externalId: String(field<number>(payload, "installation.id")) };
    },

    async parseEvent(integration, request) {
      const payload = await readJson(request);
      if (payload === undefined)
        return { kind: "ignored", reason: "the body is not valid JSON" };
      return parseGithubEvent({
        integrationId: integration.id,
        eventName: request.headers.get("x-github-event") ?? "",
        payload,
        hasWriteAccess: (repoFullName, login) =>
          hasWriteAccess(integration.externalId, repoFullName, login),
        async headShaOf(repoFullName, prNumber) {
          const pr = await (
            await getClient()
          ).getPullRequest(integration.externalId, repoFullName, prNumber);
          return pr.headSha;
        },
      });
    },

    async canTrigger(integration, trigger) {
      // Pull request events start a review whoever caused them (forks included).
      if (trigger.kind !== "command") return true;
      return hasWriteAccess(
        integration.externalId,
        trigger.repo.fullName,
        trigger.actor.login,
      );
    },

    async jobAccess(integration, repo) {
      // A fresh token for exactly this repository on every call, never cached or shared between
      // jobs. A failure is an IntegrationError with a stable code; nothing broader is tried instead.
      try {
        const config = await getConfig();
        const repositoryIds = jobTokenRepositoryIds(repo.externalId);
        if (repo.integrationId !== integration.id || repositoryIds === null)
          throw new IntegrationError(
            "INTEGRATION_ACCESS_SCOPE_REFUSED",
            "The repository does not belong to this integration or has no usable id.",
          );
        const minted = await (
          await getClient()
        ).mintInstallationToken(integration.externalId, {
          repositoryIds,
          permissions: JOB_TOKEN_PERMISSIONS,
        });
        return createGitAccess({
          provider: "github",
          baseUrl: config.apiBaseUrl,
          token: minted.token,
          authType: "token",
          botLogin: `${config.slug}[bot]`,
          expiresAt: minted.expiresAt,
        });
      } catch (error) {
        throw toJobAccessError(error);
      }
    },

    async implementerAccess(integration, repo) {
      // The gate of this method itself (#753), before the settings or GitHub are touched: the manifest is a second wall,
      // not the first. Asked on every call.
      if (options.capabilities?.().allowsReviewKind("implementer") !== true)
        throw new IntegrationError(
          "INTEGRATION_CAPABILITY_ABSENT",
          "This deployment does not offer the Implementer.",
        );
      // Like `jobAccess`: a fresh token for exactly this repository on every call, never cached or shared. The
      // permission is the Implementer's (contents write, metadata read); a 422 because the installation has not
      // accepted it is its own stable code, and nothing broader is tried instead.
      try {
        const config = await getConfig();
        const repositoryIds = jobTokenRepositoryIds(repo.externalId);
        if (repo.integrationId !== integration.id || repositoryIds === null)
          throw new IntegrationError(
            "INTEGRATION_ACCESS_SCOPE_REFUSED",
            "The repository does not belong to this integration or has no usable id.",
          );
        const minted = await (
          await getClient()
        ).mintInstallationToken(integration.externalId, {
          repositoryIds,
          permissions: IMPLEMENTER_TOKEN_PERMISSIONS,
        });
        return createGitAccess({
          provider: "github",
          baseUrl: config.apiBaseUrl,
          token: minted.token,
          authType: "token",
          botLogin: `${config.slug}[bot]`,
          expiresAt: minted.expiresAt,
        });
      } catch (error) {
        throw toImplementerAccessError(error);
      }
    },

    async revokeImplementerAccess(_integration, token) {
      // Never rejects (see the provider interface): a failure to read the settings or to reach GitHub is "not off", and the caller
      // keeps the token to try again.
      try {
        return await (await getClient()).revokeInstallationToken(token);
      } catch {
        return false;
      }
    },

    async installationPermissions(integration) {
      try {
        const installation = await (
          await getClient()
        ).getInstallation(integration.externalId);
        if (installation === null)
          throw new IntegrationError(
            "INTEGRATION_ACCESS_CONNECTION_GONE",
            "The installation no longer exists.",
          );
        return { contentsWrite: installation.permissions.contents === "write" };
      } catch (error) {
        throw toReadError(error);
      }
    },

    async postPullRequestNotice(integration, repo, prNumber, notice) {
      try {
        const repositoryIds = jobTokenRepositoryIds(repo.externalId);
        if (repo.integrationId !== integration.id || repositoryIds === null)
          throw new IntegrationError(
            "INTEGRATION_ACCESS_SCOPE_REFUSED",
            "The repository does not belong to this integration or has no usable id.",
          );
        const scope = { repositoryIds, permissions: NOTICE_TOKEN_PERMISSIONS };
        const client = await getClient();
        if (notice.lookForEarlierSince !== undefined) {
          const botLogin = `${(await getConfig()).slug}[bot]`;
          const earlier = await client.listIssueComments(
            integration.externalId,
            scope,
            repo.fullName,
            prNumber,
            { since: notice.lookForEarlierSince },
          );
          // Only the app's own comment counts: anybody can copy a marker into theirs.
          if (
            earlier.some(
              (comment) =>
                comment.authorLogin === botLogin &&
                comment.body.includes(notice.marker),
            )
          )
            return "already_there";
        }
        await client.createIssueComment(
          integration.externalId,
          scope,
          repo.fullName,
          prNumber,
          notice.body,
        );
        return "posted";
      } catch (error) {
        throw toReadError(error);
      }
    },

    async readReviewComment(integration, repo, commentId, signal) {
      try {
        const repositoryIds = jobTokenRepositoryIds(repo.externalId);
        if (repo.integrationId !== integration.id || repositoryIds === null)
          throw new IntegrationError(
            "INTEGRATION_ACCESS_SCOPE_REFUSED",
            "The repository does not belong to this integration or has no usable id.",
          );
        const comment = await (
          await getClient()
        ).getIssueComment(
          integration.externalId,
          { repositoryIds, permissions: COMMENT_READ_TOKEN_PERMISSIONS },
          repo.fullName,
          commentId,
          signal,
        );
        if (comment === null) return null;
        // Only the app's own comment counts: anybody can write a comment, and this one is shown as what the run posted.
        const botLogin = `${(await getConfig()).slug}[bot]`;
        return comment.authorLogin === botLogin
          ? {
              body: comment.body,
              below:
                comment.below === null
                  ? null
                  : {
                      repoFullName: comment.below.repoFullName,
                      number: comment.below.number,
                    },
            }
          : null;
      } catch (error) {
        throw toReadError(error);
      }
    },

    async publishReviewCheck(integration, repo, check, known, signal) {
      try {
        const repositoryIds = jobTokenRepositoryIds(repo.externalId);
        if (repo.integrationId !== integration.id || repositoryIds === null)
          throw new IntegrationError(
            "INTEGRATION_ACCESS_SCOPE_REFUSED",
            "The repository does not belong to this integration or has no usable id.",
          );
        const scope = { repositoryIds, permissions: CHECK_TOKEN_PERMISSIONS };
        const client = await getClient();
        const fields = {
          status: check.status,
          externalId: check.jobId,
          ...(check.conclusion === undefined
            ? {}
            : { conclusion: check.conclusion }),
          ...(check.detailsUrl === undefined
            ? {}
            : { detailsUrl: check.detailsUrl }),
          output: { title: check.title, summary: check.summary },
        } as const;
        let checkRunId = known.checkRunId;
        if (checkRunId === null && known.mayExist)
          checkRunId =
            (
              await client.findCheckRun(
                integration.externalId,
                scope,
                repo.fullName,
                {
                  headSha: check.headSha,
                  name: check.name,
                  externalId: check.jobId,
                },
                signal,
              )
            )?.id ?? null;
        if (checkRunId !== null) {
          await client.updateCheckRun(
            integration.externalId,
            scope,
            repo.fullName,
            checkRunId,
            fields,
            signal,
          );
          return { checkRunId };
        }
        if (known.createIfMissing === false) return { checkRunId: null };
        const created = await client.createCheckRun(
          integration.externalId,
          scope,
          repo.fullName,
          { name: check.name, headSha: check.headSha, ...fields },
          signal,
        );
        return { checkRunId: created.id };
      } catch (error) {
        throw toWriteError(error);
      }
    },

    async submitReviewVerdict(
      integration,
      repo,
      prNumber,
      verdict,
      options,
      signal,
    ) {
      try {
        const repositoryIds = jobTokenRepositoryIds(repo.externalId);
        if (repo.integrationId !== integration.id || repositoryIds === null)
          throw new IntegrationError(
            "INTEGRATION_ACCESS_SCOPE_REFUSED",
            "The repository does not belong to this integration or has no usable id.",
          );
        const scope = { repositoryIds, permissions: VERDICT_TOKEN_PERMISSIONS };
        const client = await getClient();
        if (options.lookForEarlier) {
          const botLogin = `${(await getConfig()).slug}[bot]`;
          const earlier = (
            await client.listPullRequestReviews(
              integration.externalId,
              scope,
              repo.fullName,
              prNumber,
              signal,
            )
          ).find(
            // Only the app's own review counts: anybody can copy a marker into theirs.
            (review) =>
              review.authorLogin === botLogin &&
              review.body.includes(verdict.marker),
          );
          if (earlier !== undefined)
            return { outcome: "already_there" as const, reviewId: earlier.id };
        }
        const created = await client.createPullRequestReview(
          integration.externalId,
          scope,
          repo.fullName,
          prNumber,
          {
            commitId: verdict.headSha,
            body: verdict.body,
            event: verdict.event === "approve" ? "APPROVE" : "REQUEST_CHANGES",
          },
          signal,
        );
        return { outcome: "submitted" as const, reviewId: created.id };
      } catch (error) {
        throw toWriteError(error);
      }
    },

    async withdrawReviewVerdict(integration, repo, prNumber, options, signal) {
      try {
        const repositoryIds = jobTokenRepositoryIds(repo.externalId);
        if (repo.integrationId !== integration.id || repositoryIds === null)
          throw new IntegrationError(
            "INTEGRATION_ACCESS_SCOPE_REFUSED",
            "The repository does not belong to this integration or has no usable id.",
          );
        const scope = { repositoryIds, permissions: VERDICT_TOKEN_PERMISSIONS };
        const client = await getClient();
        const botLogin = `${(await getConfig()).slug}[bot]`;
        // Only the app's own reviews that carry its marker count: a review of anybody else is never touched, whatever
        // its text says. The latest of them that still counts (an approval or a request for changes) decides whether
        // there is anything to take back; then every request of the app that stands is dismissed, not only the latest,
        // because GitHub may count an earlier one of the same reviewer again once the latest is gone.
        const own = (
          await client.listPullRequestReviews(
            integration.externalId,
            scope,
            repo.fullName,
            prNumber,
            signal,
          )
        ).filter(
          (review) =>
            review.authorLogin === botLogin &&
            review.body.includes(options.markerPrefix) &&
            (review.state === "APPROVED" ||
              review.state === "CHANGES_REQUESTED"),
        );
        const latest = own.at(-1);
        if (latest === undefined || latest.state !== "CHANGES_REQUESTED")
          return { outcome: "nothing_to_dismiss" as const, reviewId: null };
        for (const standing of own.filter(
          (review) => review.state === "CHANGES_REQUESTED",
        ))
          await client.dismissPullRequestReview(
            integration.externalId,
            scope,
            repo.fullName,
            prNumber,
            standing.id,
            options.message,
            signal,
          );
        return { outcome: "dismissed" as const, reviewId: latest.id };
      } catch (error) {
        throw toWriteError(error);
      }
    },

    async getPullRequest(integration, repo, prNumber, signal) {
      try {
        return await (
          await getClient()
        ).getPullRequest(
          integration.externalId,
          repo.fullName,
          prNumber,
          signal,
        );
      } catch (error) {
        // A 404 of the call itself is a pull request that does not exist; a 404 of the token request
        // is an installation that is gone, which `toReadError` reports as such. Everything else
        // leaves as a provider neutral code too.
        if (
          error instanceof GithubAppError &&
          error.code === "GITHUB_APP_NOT_FOUND" &&
          !error.duringTokenRequest
        )
          throw new IntegrationError(
            "INTEGRATION_PULL_REQUEST_NOT_FOUND",
            `Pull request ${prNumber} does not exist in ${repo.fullName}.`,
            { cause: error },
          );
        throw toReadError(error);
      }
    },

    async getRepositoryFacts(integration, repo, signal) {
      try {
        return await (
          await getClient()
        ).getRepositoryFacts(
          integration.externalId,
          branchReadScope(integration, repo),
          repo.fullName,
          signal,
        );
      } catch (error) {
        throw toReadError(error);
      }
    },

    async listBranches(integration, repo, signal) {
      try {
        return await (
          await getClient()
        ).listBranches(
          integration.externalId,
          branchReadScope(integration, repo),
          repo.fullName,
          signal,
        );
      } catch (error) {
        throw toReadError(error);
      }
    },

    async getBranch(integration, repo, name, signal) {
      try {
        return await (
          await getClient()
        ).getBranch(
          integration.externalId,
          branchReadScope(integration, repo),
          repo.fullName,
          name,
          signal,
        );
      } catch (error) {
        throw toReadError(error);
      }
    },

    async listOpenPullRequests(integration, repo, signal) {
      // Failures leave as provider neutral codes (the installation is gone, access is refused, GitHub
      // is down), so the page that lists the pull requests never has to know GitHub's error codes.
      try {
        return await (
          await getClient()
        ).listOpenPullRequests(integration.externalId, repo.fullName, signal);
      } catch (error) {
        throw toReadError(error);
      }
    },
  };
}
