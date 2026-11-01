// SPDX-License-Identifier: LicenseRef-Proprietary

// A stand-in for a real integration provider, so that jobs, the runner API and the UI can be built
// and tested without GitHub. It speaks a small made-up "platform format" in its webhooks (see
// `fakeWebhookRequest`) and translates it into the normalized types, exactly like a real provider.
// Its signature is modelled on the real contract: HMAC-SHA256 of the body, compared in constant time.
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  validateConfigAgainstSchema,
  type ConfigSchema,
} from "../integrations/config-schema.ts";
import { IntegrationError } from "../integrations/errors.ts";
import { createGitAccess } from "../integrations/normalized.ts";
import type { IntegrationProvider } from "../integrations/provider.ts";
import type {
  GitAccess,
  Integration,
  IntegrationEvent,
  PullRequestRef,
  RepoRef,
  ReviewTrigger,
} from "../integrations/types.ts";

/** What a provider does for a signal that has fired: no request, the neutral "unavailable" code. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted)
    throw new IntegrationError(
      "INTEGRATION_ACCESS_UNAVAILABLE",
      "The request was aborted.",
    );
}

export const FAKE_WEBHOOK_SECRET = "fake-webhook-secret";
export const FAKE_SIGNATURE_HEADER = "x-fake-signature-256";

const FAKE_CONFIG_SCHEMA: ConfigSchema = {
  accountLogin: { type: "string" },
  accountId: { type: "number" },
};

export type FakeRepo = { id: string; fullName: string };

export type FakeIntegrationProviderOptions = {
  repos?: FakeRepo[];
  webhookSecret?: string;
  /** Logins that may trigger a review; everyone may when omitted. */
  allowedActors?: string[];
  access?: Partial<GitAccess>;
  /** Makes `jobAccess` fail with this error (platform down, installation removed, ...). */
  jobAccessFailure?: Error;
  /** Makes `implementerAccess` fail with this error (#749), for example `INTEGRATION_ACCESS_PERMISSION_NOT_GRANTED`. */
  implementerAccessFailure?: Error;
  /** Whether `revokeImplementerAccess` says the token is off (#753). Default: yes. */
  revokeSucceeds?: boolean;
  /** Whether the connections have accepted the permission to write contents (#749). Default: no, so a test that forgets to set it does not pass as if write were granted. */
  contentsWrite?: boolean;
  /** The pull requests every repository has. Defaults to an open #7 and a draft #8. */
  pullRequests?: PullRequestRef[];
  /** The default branch every repository has (#750). Default: main. */
  defaultBranch?: string;
  /** The branches every repository has, by name, each with its head commit (#750). Default: just the default branch. */
  branches?: Record<string, string>;
};

export type FakeProviderCall = { method: string; args: unknown[] };

export type FakeIntegrationProvider = IntegrationProvider & {
  /** Every call, in order, for assertions. */
  readonly calls: FakeProviderCall[];
};

/** The made-up platform event the fake provider understands. */
export type FakeWebhookEvent = {
  action:
    | "opened"
    | "synchronize"
    | "comment"
    | "closed"
    | "installation_deleted"
    | "installation_repositories";
  /** The connection the delivery belongs to (like GitHub's `installation.id`). */
  installation: { id: string };
  repository: { id: string; full_name: string };
  number: number;
  head: { sha: string };
  sender: { login: string; id: string };
  comment?: { body: string; id?: string };
};

function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function signatureMatches(body: string, secret: string, given: string | null) {
  if (given === null) return false;
  const expected = Buffer.from(sign(body, secret));
  const actual = Buffer.from(given);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function buildRequest(body: string, signature: string): Request {
  return new Request("https://app.test/api/webhooks/github_app", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [FAKE_SIGNATURE_HEADER]: signature,
    },
    body,
  });
}

/** A delivery signed like the platform would (HMAC-SHA256 of the body with the secret). */
export function fakeWebhookRequest(
  event: FakeWebhookEvent,
  options: { secret?: string } = {},
): Request {
  const body = JSON.stringify(event);
  return buildRequest(body, sign(body, options.secret ?? FAKE_WEBHOOK_SECRET));
}

/** A delivery whose body was changed after it was signed. */
export function tamperedFakeWebhookRequest(event: FakeWebhookEvent): Request {
  const signature = sign(JSON.stringify(event), FAKE_WEBHOOK_SECRET);
  return buildRequest(
    JSON.stringify({ ...event, number: event.number + 1 }),
    signature,
  );
}

export function fakeIntegration(
  overrides: Partial<Integration> = {},
): Integration {
  return {
    id: "integration-1",
    workspaceId: "workspace-1",
    type: "github_app",
    displayName: "Fake integration",
    externalId: "installation-1",
    config: { accountLogin: "acme", accountId: 5 },
    credentials: null,
    webhookSecret: null,
    status: "active",
    createdAt: "2026-10-10T08:00:00.000Z",
    updatedAt: "2026-10-10T08:00:00.000Z",
    ...overrides,
  };
}

// Every comment without an id of its own gets a new one, so two comments never look like one.
let commentCounter = 0;

const COMMAND_PATTERN = /^\s*\/(review)(?=\s|$)/i;

const DEFAULT_PULL_REQUESTS: PullRequestRef[] = [
  {
    number: 7,
    title: "Add widgets",
    url: "https://fake.test/pull/7",
    headSha: "abc123",
    baseRef: "main",
    headRef: "feature-7",
    draft: false,
    state: "open",
    author: { login: "alice", externalId: "1" },
  },
  {
    number: 8,
    title: "Work in progress",
    url: "https://fake.test/pull/8",
    headSha: "def456",
    baseRef: "main",
    headRef: "feature-8",
    draft: true,
    state: "open",
    author: { login: "bob", externalId: "2" },
  },
];

export function fakeIntegrationProvider(
  options: FakeIntegrationProviderOptions = {},
): FakeIntegrationProvider {
  const repos = options.repos ?? [
    { id: "100", fullName: "acme/widgets" },
    { id: "101", fullName: "acme/gadgets" },
  ];
  const secret = options.webhookSecret ?? FAKE_WEBHOOK_SECRET;
  const pullRequests = options.pullRequests ?? DEFAULT_PULL_REQUESTS;
  const defaultBranch = options.defaultBranch ?? "main";
  const branches = options.branches ?? { [defaultBranch]: "a".repeat(40) };
  const calls: FakeProviderCall[] = [];
  const record = (method: string, ...args: unknown[]) =>
    calls.push({ method, args });

  const toRepoRef = (integrationId: string, repo: FakeRepo): RepoRef => ({
    integrationId,
    externalId: repo.id,
    fullName: repo.fullName,
    url: `https://fake.test/${repo.fullName}`,
  });

  return {
    calls,
    type: "github_app",
    connect: { kind: "install_redirect" },

    validateConfig(config) {
      record("validateConfig", config);
      return validateConfigAgainstSchema(FAKE_CONFIG_SCHEMA, config);
    },

    async listRepositories(integration) {
      record("listRepositories", integration);
      return repos.map((repo) => toRepoRef(integration.id, repo));
    },

    async verifyWebhook(integration, request) {
      record("verifyWebhook", integration, request);
      const body = await request.clone().text();
      return signatureMatches(
        body,
        secret,
        request.headers.get(FAKE_SIGNATURE_HEADER),
      );
    },

    async identifyWebhook(request) {
      record("identifyWebhook", request);
      const event = (await request.clone().json()) as FakeWebhookEvent;
      return { externalId: event.installation.id };
    },

    async parseEvent(integration, request): Promise<IntegrationEvent> {
      record("parseEvent", integration, request);
      const event = (await request.clone().json()) as FakeWebhookEvent;

      if (event.action === "installation_deleted")
        return {
          kind: "installation_changed",
          externalId: event.installation.id,
          action: "deleted",
        };
      if (event.action === "installation_repositories")
        return {
          kind: "installation_changed",
          externalId: event.installation.id,
          action: "repositories_changed",
        };

      const repo = toRepoRef(integration.id, {
        id: event.repository.id,
        fullName: event.repository.full_name,
      });
      const base = {
        repo,
        prNumber: event.number,
        prUrl: `${repo.url}/pull/${event.number}`,
        headSha: event.head.sha,
        actor: { login: event.sender.login, externalId: event.sender.id },
      };

      if (event.action === "opened")
        return {
          kind: "review_trigger",
          trigger: {
            ...base,
            kind: "opened",
            command: null,
            args: null,
            draft: false,
            state: "open",
          },
        };
      if (event.action === "synchronize")
        return {
          kind: "review_trigger",
          trigger: {
            ...base,
            kind: "updated",
            command: null,
            args: null,
            draft: false,
            state: "open",
          },
        };
      if (event.action === "comment") {
        const match = COMMAND_PATTERN.exec(event.comment?.body ?? "");
        if (match === null)
          return { kind: "ignored", reason: "the comment is not a command" };
        return {
          kind: "review_trigger",
          trigger: {
            ...base,
            kind: "command",
            command: "review",
            args: "",
            commentId: event.comment?.id ?? `comment-${(commentCounter += 1)}`,
          },
        };
      }
      return {
        kind: "ignored",
        reason: `the action "${event.action}" is not used`,
      };
    },

    async canTrigger(integration, trigger: ReviewTrigger) {
      record("canTrigger", integration, trigger);
      if (options.allowedActors === undefined) return true;
      return options.allowedActors.includes(trigger.actor.login);
    },

    async jobAccess(integration, repo) {
      record("jobAccess", integration, repo);
      if (options.jobAccessFailure) throw options.jobAccessFailure;
      return createGitAccess({
        provider: "github",
        baseUrl: "https://fake.test/api",
        token: `fake-token-for-${repo.fullName}`,
        authType: "token",
        botLogin: "fake-reviewer[bot]",
        expiresAt: "2026-10-10T13:00:00.000Z",
        ...options.access,
      });
    },

    async implementerAccess(integration, repo) {
      record("implementerAccess", integration, repo);
      if (options.implementerAccessFailure)
        throw options.implementerAccessFailure;
      return createGitAccess({
        provider: "github",
        baseUrl: "https://fake.test/api",
        token: `fake-write-token-for-${repo.fullName}`,
        authType: "token",
        botLogin: "fake-reviewer[bot]",
        expiresAt: "2026-10-10T13:00:00.000Z",
        ...options.access,
      });
    },

    async revokeImplementerAccess(integration, token) {
      record("revokeImplementerAccess", integration, token);
      return options.revokeSucceeds ?? true;
    },

    async installationPermissions(integration) {
      record("installationPermissions", integration);
      return { contentsWrite: options.contentsWrite ?? false };
    },

    async getPullRequest(integration, repo, prNumber, signal) {
      record("getPullRequest", integration, repo, prNumber);
      throwIfAborted(signal);
      const found = pullRequests.find((pr) => pr.number === prNumber);
      if (found === undefined)
        throw new IntegrationError(
          "INTEGRATION_PULL_REQUEST_NOT_FOUND",
          `No pull request #${prNumber} in ${repo.fullName}.`,
        );
      return { ...found, url: `${repo.url}/pull/${found.number}` };
    },

    async getRepositoryFacts(integration, repo, signal) {
      record("getRepositoryFacts", integration, repo);
      throwIfAborted(signal);
      return { defaultBranch };
    },

    async listBranches(integration, repo, signal) {
      record("listBranches", integration, repo);
      throwIfAborted(signal);
      const all = [
        defaultBranch,
        ...Object.keys(branches)
          .filter((name) => name !== defaultBranch)
          .sort(),
      ];
      return { names: all.slice(0, 100), truncated: all.length > 100 };
    },

    async getBranch(integration, repo, name, signal) {
      record("getBranch", integration, repo, name);
      throwIfAborted(signal);
      const sha = branches[name];
      return sha === undefined ? null : { sha };
    },

    async listOpenPullRequests(integration, repo, signal) {
      record("listOpenPullRequests", integration, repo);
      throwIfAborted(signal);
      return pullRequests
        .filter((pr) => pr.state === "open")
        .map((pr) => ({ ...pr, url: `${repo.url}/pull/${pr.number}` }));
    },
  };
}
