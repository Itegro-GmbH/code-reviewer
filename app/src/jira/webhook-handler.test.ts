// SPDX-License-Identifier: LicenseRef-Proprietary

// The steps of the Jira webhook handler (#1039) with its collaborators replaced: the order of the refusals, what a claim does, and what a
// failure after the claim does. The whole path against real tables is in webhook.integration.test.ts.
import { createHash, createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  DirectoryJiraEndpoint,
  DirectoryJiraWebhook,
} from "../db/repositories/jira-webhook-directory-repository.ts";
import type { StoredJiraWebhook } from "../db/repositories/jira-webhooks-repository.ts";
import type { StoredProject } from "../db/repositories/projects-repository.ts";
import type { WebhookDeliveriesRepository } from "../db/repositories/webhook-deliveries-repository.ts";
import {
  createJiraWebhookHandler,
  type JiraWorkspaceCollaborators,
} from "./webhook-handler.ts";
import { deriveWebhookSecret, hashWebhookSecret } from "./webhook-verify.ts";

const SECRET = "a-secret-of-the-test-registration";

const REGISTRATION: DirectoryJiraWebhook = {
  id: "reg-1",
  workspaceId: "ws-1",
  projectId: "proj-1",
  connectionId: "conn-1",
  projectKey: "PROJ",
  secretHash: hashWebhookSecret(SECRET),
  pendingSecretHash: null,
  registrationAttempt: null,
  address: "project",
  status: "active",
  jiraWebhookId: "1001",
  expiresAt: "2026-12-14T00:00:00.000Z",
  registeredAt: "2026-11-14T00:00:00.000Z",
  bearerSeenAt: null,
  errorCode: null,
  createdAt: "",
  updatedAt: "",
  cloudId: "cloud-1",
  siteUrl: "https://acme.atlassian.net",
};

const APP_SECRET = "an-app-secret-for-tests";
const SHARED_SECRET = deriveWebhookSecret(APP_SECRET, "conn-1", 1);

/** The connection as the directory knows it (the shared address, #1131). */
const ENDPOINT: DirectoryJiraEndpoint = {
  connectionId: "conn-1",
  workspaceId: "ws-1",
  cloudId: "cloud-1",
  siteUrl: "https://acme.atlassian.net",
  generation: 1,
  bearerSeenAt: null,
};

/** The rows of the projects on that connection: registered under the shared address, no secret of their own. */
const SHARED_ROW: StoredJiraWebhook = {
  ...REGISTRATION,
  secretHash: null,
  address: "connection",
};

const PROJECT = {
  id: "proj-1",
  repositoryId: "repo-1",
  active: true,
  ticketSource: {
    provider: "jira",
    repositoryId: "repo-1",
    board: null,
    connectionId: "conn-1",
    projectKey: "PROJ",
  },
} as unknown as StoredProject;

const NOW_SECONDS = Math.floor(Date.parse("2026-11-14T12:00:00Z") / 1000);

/** A bearer token as Atlassian is documented to send one: signed with the client secret of the app. */
function bearer(claims: Record<string, unknown>, secret = "client-secret") {
  const part = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const head = part({ alg: "HS256", typ: "JWT" });
  const body = part(claims);
  const signature = createHmac("sha256", secret)
    .update(`${head}.${body}`)
    .digest("base64url");
  return `Bearer ${head}.${body}.${signature}`;
}

const payload = (over: Record<string, unknown> = {}) => ({
  timestamp: 1763116200000,
  webhookEvent: "jira:issue_updated",
  user: { accountId: "acc-1", displayName: "Grace" },
  issue: {
    id: "10042",
    key: "PROJ-7",
    fields: {
      summary: "Fix",
      status: { name: "Ready", statusCategory: { key: "indeterminate" } },
      updated: "2026-11-14T10:00:00.000+0000",
    },
  },
  changelog: {
    items: [{ field: "status", fromString: "To Do", toString: "Ready" }],
  },
  matchedWebhookIds: [1001],
  ...over,
});

function setup(
  options: {
    registration?: DirectoryJiraWebhook | undefined;
    claim?: "claimed" | "duplicate" | "in_progress";
    statusFails?: boolean;
    mirrorFails?: boolean;
    project?: StoredProject | undefined;
    configured?: boolean;
    /** The connection of the shared address; left out: the one of the tests (`ENDPOINT`). */
    endpoint?: DirectoryJiraEndpoint | undefined;
    /** What the workspace holds under the shared address (`SHARED_ROW`s); left out: none. */
    rows?: StoredJiraWebhook[];
    /** The projects by id, for a delivery that reaches several; left out: `PROJECT` (or `options.project`). */
    projects?: Record<string, StoredProject>;
    /** The app secret does not resolve (so no address secret can be derived). */
    addressSecretFails?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const deliveries: WebhookDeliveriesRepository = {
    async claim(id) {
      calls.push(`claim:${id}`);
      const status = options.claim ?? "claimed";
      return status === "claimed"
        ? { status, token: "token-1" }
        : ({ status } as never);
    },
    async complete(id, _token, outcome) {
      calls.push(`complete:${id}:${outcome}`);
    },
    async release(id) {
      calls.push(`release:${id}`);
    },
  };
  const statuses = vi.fn(async () => {
    if (options.statusFails === true) throw new Error("db gone");
    return { matched: 1, started: 1, existing: 0, skipped: 0, busy: 0 };
  });
  const apply = vi.fn(async () => {
    if (options.mirrorFails === true) throw new Error("db gone");
    return "updated" as const;
  });
  const markBearerSeen = vi.fn(async () => true);
  const markEndpointBearerSeen = vi.fn(async () => true);
  const collaborators: JiraWorkspaceCollaborators = {
    registrations: {
      markBearerSeen,
      markEndpointBearerSeen,
      listByProjectKey: async (connectionId, projectKey) =>
        (options.rows ?? []).filter(
          (row) =>
            row.connectionId === connectionId && row.projectKey === projectKey,
        ),
    },
    projects: {
      getById: async (id) =>
        options.projects !== undefined
          ? options.projects[id]
          : "project" in options
            ? options.project
            : PROJECT,
    },
    repositoryName: async () => "acme/shop",
    mirror: { apply },
    statuses: { start: statuses },
  };
  const lines: string[] = [];
  const handler = createJiraWebhookHandler({
    directory: {
      findById: async (id) =>
        id === "reg-1"
          ? "registration" in options
            ? options.registration
            : REGISTRATION
          : undefined,
      findConnection: async (id) =>
        id === "conn-1"
          ? "endpoint" in options
            ? options.endpoint
            : ENDPOINT
          : undefined,
    },
    addressSecret: (connectionId, generation) => {
      if (options.addressSecretFails === true)
        throw new Error("APP_SECRET is not set");
      return deriveWebhookSecret(APP_SECRET, connectionId, generation);
    },
    deliveries,
    clientSecret: () =>
      options.configured === false ? undefined : "client-secret",
    workspace: () => collaborators,
    logger: {
      info: (line) => lines.push(line),
      warn: (line) => lines.push(line),
      error: (line) => lines.push(line),
    },
    maxBodyBytes: 4096,
    now: () => new Date("2026-11-14T12:00:00Z"),
  });
  const request = (
    body: unknown = payload(),
    over: { query?: string; headers?: Record<string, string> } = {},
  ) =>
    new Request(
      `https://factory.example.test/api/webhooks/jira?${over.query ?? `w=reg-1&s=${SECRET}`}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-atlassian-webhook-identifier": "id-1",
          ...over.headers,
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      },
    );
  return {
    handler,
    request,
    calls,
    statuses,
    apply,
    lines,
    markBearerSeen,
    markEndpointBearerSeen,
  };
}

describe("the Jira webhook handler", () => {
  // #1039
  it("answers 404 where the Atlassian app is not configured, before it reads anything", async () => {
    const t = setup({ configured: false });
    const response = await t.handler(t.request());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "JIRA_WEBHOOK_NOT_CONFIGURED",
    });
    expect(t.calls).toEqual([]);
  });

  // #1039
  it("refuses a body over the limit with 413 and a body that is no JSON with 400, none of it claimed", async () => {
    const t = setup();
    expect((await t.handler(t.request("x".repeat(5000)))).status).toBe(413);
    const bad = await t.handler(t.request("{not json"));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "JIRA_WEBHOOK_BODY_NOT_JSON" });
    expect(t.calls).toEqual([]);
  });

  // #1039
  it("verifies the address before it reads the body: a wrong secret is 401 even for a body over the limit", async () => {
    const t = setup();
    const response = await t.handler(
      t.request("x".repeat(5000), { query: "w=reg-1&s=wrong" }),
    );
    expect(response.status).toBe(401);
    expect(t.calls).toEqual([]);
  });

  // #1039
  it("does not hard-fail a delivery without a usable identifier header (Jira treats a 4xx as final): it is claimed under a hash of the body, the same body under the same claim", async () => {
    const claims: string[] = [];
    const request = (body: unknown, headers: Record<string, string> = {}) =>
      new Request(
        `https://factory.example.test/api/webhooks/jira?w=reg-1&s=${SECRET}`,
        { method: "POST", headers, body: JSON.stringify(body) },
      );
    const t = setup();
    for (const [body, headers] of [
      [payload(), {}],
      [payload(), { "x-atlassian-webhook-identifier": "../x" }],
      [payload({ timestamp: 2 }), {}],
    ] as const) {
      const response = await t.handler(request(body, headers));
      expect(response.status).toBe(200);
    }
    for (const call of t.calls)
      if (call.startsWith("claim:")) claims.push(call);
    const hash = (body: unknown) =>
      createHash("sha256")
        .update(JSON.stringify(body))
        .digest("hex")
        .slice(0, 32);
    expect(claims).toEqual([
      `claim:jira-reg-1-b-${hash(payload())}`,
      `claim:jira-reg-1-b-${hash(payload())}`,
      `claim:jira-reg-1-b-${hash(payload({ timestamp: 2 }))}`,
    ]);
    expect(t.lines.join("\n")).toContain("body hash");
  });

  // #1039-T02
  it("refuses with one answer whether the registration is unknown, being removed, or the secret is wrong, and claims nothing", async () => {
    for (const t of [
      setup({ registration: undefined }),
      setup({ registration: { ...REGISTRATION, status: "removing" } }),
    ]) {
      const response = await t.handler(t.request());
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: "JIRA_WEBHOOK_UNAUTHORIZED",
      });
      expect(t.calls).toEqual([]);
    }
    const t = setup();
    for (const query of [
      "w=reg-1&s=wrong",
      "w=reg-1",
      "s=" + SECRET,
      "w=../reg-1&s=" + SECRET,
    ]) {
      const response = await t.handler(t.request(payload(), { query }));
      expect(response.status).toBe(401);
    }
    expect(t.calls).toEqual([]);
    expect(t.lines.join("\n")).not.toContain(SECRET);
  });

  // #1039
  it("answers 200 for an event it does not follow, and for a delivery that names other webhooks, without a claim", async () => {
    const t = setup();
    expect(
      await (
        await t.handler(
          t.request({ webhookEvent: "sprint_started", timestamp: 1 }),
        )
      ).json(),
    ).toEqual({ status: "accepted", outcome: "ignored" });
    expect(
      await (
        await t.handler(t.request(payload({ matchedWebhookIds: [999] })))
      ).json(),
    ).toEqual({ status: "accepted", outcome: "ignored" });
    expect(t.calls).toEqual([]);
  });

  // #1039-T02
  it("claims the delivery under the registration and Jira's identifier and answers a duplicate without acting", async () => {
    const t = setup({ claim: "duplicate" });
    const response = await t.handler(t.request());
    expect(await response.json()).toEqual({
      status: "accepted",
      outcome: "duplicate",
    });
    expect(t.calls).toEqual(["claim:jira-reg-1-id-1"]);
    expect(t.apply).not.toHaveBeenCalled();
    expect(t.statuses).not.toHaveBeenCalled();
  });

  // #1039
  it("answers 409 while another request holds the claim, so that Jira retries", async () => {
    const t = setup({ claim: "in_progress" });
    const response = await t.handler(t.request());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "JIRA_WEBHOOK_IN_PROGRESS",
    });
  });

  // #1039-T01
  it("mirrors the issue, starts the lanes of the status change and completes the claim with the outcome", async () => {
    const t = setup();
    const response = await t.handler(t.request());
    expect(await response.json()).toEqual({
      status: "accepted",
      outcome: "workflow_runs_started",
    });
    expect(t.statuses).toHaveBeenCalledWith("reg-1-id-1", {
      projectId: "proj-1",
      connectionId: "conn-1",
      projectKey: "PROJ",
      issueKey: "PROJ-7",
      from: "To Do",
      to: "Ready",
      actor: { accountId: "acc-1", name: "Grace" },
    });
    expect(t.calls).toEqual([
      "claim:jira-reg-1-id-1",
      "complete:jira-reg-1-id-1:workflow_runs_started",
    ]);
  });

  // #1039
  it("ignores an issue of another Jira project, a project that is off or has another source, without starting anything", async () => {
    const other = setup();
    const foreign = payload();
    (foreign.issue as { key: string }).key = "OTHER-1";
    expect(await (await other.handler(other.request(foreign))).json()).toEqual({
      status: "accepted",
      outcome: "ignored",
    });
    expect(other.statuses).not.toHaveBeenCalled();

    for (const project of [
      undefined,
      { ...PROJECT, active: false } as StoredProject,
      {
        ...PROJECT,
        ticketSource: {
          provider: "github",
          repositoryId: "repo-1",
          board: null,
        },
      } as StoredProject,
    ]) {
      const t = setup({ project });
      expect(await (await t.handler(t.request())).json()).toEqual({
        status: "accepted",
        outcome: "ignored",
      });
      expect(t.statuses).not.toHaveBeenCalled();
      expect(t.apply).not.toHaveBeenCalled();
    }
  });

  // #1039-T02
  it("releases the claim and answers 503 when the lanes cannot be started, so that Jira retries and the same delivery is tried again", async () => {
    const t = setup({ statusFails: true });
    const response = await t.handler(t.request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "JIRA_WEBHOOK_PROCESSING_FAILED",
    });
    expect(t.calls).toEqual([
      "claim:jira-reg-1-id-1",
      "release:jira-reg-1-id-1",
    ]);
  });

  // #1039
  it("goes on with the trigger when only the mirror fails, and is tried again when nothing else came of the delivery", async () => {
    const goesOn = setup({ mirrorFails: true });
    expect(await (await goesOn.handler(goesOn.request())).json()).toEqual({
      status: "accepted",
      outcome: "workflow_runs_started",
    });
    const onlyMirror = setup({ mirrorFails: true });
    const response = await onlyMirror.handler(
      onlyMirror.request(payload({ changelog: { items: [] } })),
    );
    expect(response.status).toBe(503);
    expect(onlyMirror.calls.at(-1)).toBe("release:jira-reg-1-id-1");
  });

  // #1039
  it("notes the first bearer token that verifies, once, and never for a delivery without one", async () => {
    const claims = { exp: NOW_SECONDS + 300 };
    const first = setup();
    expect(
      (
        await first.handler(
          first.request(payload(), {
            headers: { authorization: bearer(claims) },
          }),
        )
      ).status,
    ).toBe(200);
    expect(first.markBearerSeen).toHaveBeenCalledWith("reg-1");

    const noToken = setup();
    await noToken.handler(noToken.request());
    expect(noToken.markBearerSeen).not.toHaveBeenCalled();

    const seen = setup({
      registration: {
        ...REGISTRATION,
        bearerSeenAt: "2026-11-14T00:00:00.000Z",
      },
    });
    await seen.handler(
      seen.request(payload(), { headers: { authorization: bearer(claims) } }),
    );
    expect(seen.markBearerSeen).not.toHaveBeenCalled();
  });

  // #1039
  it("refuses a delivery without a token once one was seen, and a token that does not verify always", async () => {
    const seen = setup({
      registration: {
        ...REGISTRATION,
        bearerSeenAt: "2026-11-14T00:00:00.000Z",
      },
    });
    expect((await seen.handler(seen.request())).status).toBe(401);
    expect(seen.calls).toEqual([]);
    expect(seen.lines.join("\n")).toContain("bearer_missing");

    const wrong = bearer({ exp: NOW_SECONDS + 300 }, "other-secret");
    for (const t of [setup(), seen]) {
      const response = await t.handler(
        t.request(payload(), { headers: { authorization: wrong } }),
      );
      expect(response.status).toBe(401);
      expect(t.calls).toEqual([]);
    }
  });

  // #1039
  it("accepts the secret of a registration under way next to the current one", async () => {
    const t = setup({
      registration: {
        ...REGISTRATION,
        pendingSecretHash: hashWebhookSecret("next-secret"),
      },
    });
    for (const secret of [SECRET, "next-secret"])
      expect(
        (
          await t.handler(
            t.request(payload(), { query: `w=reg-1&s=${secret}` }),
          )
        ).status,
      ).toBe(200);
  });
});

describe("the shared address of a connection (#1131)", () => {
  const shared = (secret = SHARED_SECRET) => `c=conn-1&s=${secret}`;
  const second = {
    ...PROJECT,
    id: "proj-2",
    ticketSource: {
      provider: "jira",
      repositoryId: "repo-1",
      board: null,
      connectionId: "conn-1",
      projectKey: "SECOND",
    },
  } as unknown as StoredProject;
  const secondRow: StoredJiraWebhook = {
    ...SHARED_ROW,
    id: "reg-2",
    projectId: "proj-2",
    projectKey: "SECOND",
    jiraWebhookId: "1002",
  };
  const issueOf = (key: string, matched: number[]) => {
    const body = payload({ matchedWebhookIds: matched });
    (body.issue as { key: string }).key = key;
    return body;
  };

  // #1131-T02
  it("routes a delivery to the project of the Jira project its issue belongs to", async () => {
    const t = setup({
      rows: [SHARED_ROW, secondRow],
      projects: { "proj-1": PROJECT, "proj-2": second },
    });
    const first = await t.handler(
      t.request(issueOf("PROJ-7", [1001]), { query: shared() }),
    );
    expect(await first.json()).toEqual({
      status: "accepted",
      outcome: "workflow_runs_started",
    });
    const other = await t.handler(
      t.request(issueOf("SECOND-3", [1002]), { query: shared() }),
    );
    expect(await other.json()).toEqual({
      status: "accepted",
      outcome: "workflow_runs_started",
    });
    expect(t.statuses).toHaveBeenNthCalledWith(
      1,
      "reg-1-id-1",
      expect.objectContaining({ projectId: "proj-1", issueKey: "PROJ-7" }),
    );
    expect(t.statuses).toHaveBeenNthCalledWith(
      2,
      "reg-2-id-1",
      expect.objectContaining({
        projectId: "proj-2",
        projectKey: "SECOND",
        issueKey: "SECOND-3",
      }),
    );
    expect(t.calls).toEqual([
      "claim:jira-reg-1-id-1",
      "complete:jira-reg-1-id-1:workflow_runs_started",
      "claim:jira-reg-2-id-1",
      "complete:jira-reg-2-id-1:workflow_runs_started",
    ]);
  });

  // #1131-T02
  it("answers 200 and does nothing for a Jira project no project of the connection has a webhook for", async () => {
    const t = setup({ rows: [SHARED_ROW] });
    const response = await t.handler(
      t.request(issueOf("STRANGER-1", []), { query: shared() }),
    );
    expect(await response.json()).toEqual({
      status: "accepted",
      outcome: "ignored",
    });
    expect(t.calls).toEqual([]);
    expect(t.statuses).not.toHaveBeenCalled();
  });

  // #1131-T03
  it("refuses an unknown connection, a missing or wrong secret and the secret of another generation, claiming nothing", async () => {
    const t = setup({ rows: [SHARED_ROW] });
    for (const query of [
      "c=nobody&s=" + SHARED_SECRET,
      "c=conn-1",
      "c=conn-1&s=wrong",
      "c=conn-1&s=" + deriveWebhookSecret(APP_SECRET, "conn-1", 2),
      "c=conn-1&s=" + deriveWebhookSecret(APP_SECRET, "conn-2", 1),
      "c=../conn-1&s=" + SHARED_SECRET,
      // The secret of a per-project address is nothing on this one.
      "c=conn-1&s=" + SECRET,
    ]) {
      const response = await t.handler(t.request(payload(), { query }));
      expect(response.status, query).toBe(401);
      expect(await response.json()).toEqual({
        error: "JIRA_WEBHOOK_UNAUTHORIZED",
      });
    }
    expect(t.calls).toEqual([]);
    expect(t.lines.join("\n")).not.toContain(SHARED_SECRET);
  });

  // #1131-T03
  it("refuses with the one 401 when the app secret does not resolve, instead of failing with an uncaught 500", async () => {
    const t = setup({ rows: [SHARED_ROW], addressSecretFails: true });
    const response = await t.handler(
      t.request(payload(), { query: "c=conn-1&s=" + SHARED_SECRET }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "JIRA_WEBHOOK_UNAUTHORIZED",
    });
    expect(t.calls).toEqual([]);
    expect(t.lines.join("\n")).toContain("address secret is not available");
  });

  // #1131-T03
  it("verifies the address before it reads the body", async () => {
    const t = setup({ rows: [SHARED_ROW] });
    const response = await t.handler(
      t.request("x".repeat(5000), { query: "c=conn-1&s=wrong" }),
    );
    expect(response.status).toBe(401);
  });

  // #1131-T03
  it("treats the bearer token per connection: noted once, refused when it is missing after one was seen, refused when it does not verify", async () => {
    const claims = { exp: NOW_SECONDS + 300 };
    const first = setup({ rows: [SHARED_ROW] });
    expect(
      (
        await first.handler(
          first.request(payload(), {
            query: shared(),
            headers: { authorization: bearer(claims) },
          }),
        )
      ).status,
    ).toBe(200);
    expect(first.markEndpointBearerSeen).toHaveBeenCalledWith("conn-1");
    expect(first.markBearerSeen).not.toHaveBeenCalled();

    const seen = setup({
      rows: [SHARED_ROW],
      endpoint: { ...ENDPOINT, bearerSeenAt: "2026-11-14T00:00:00.000Z" },
    });
    expect(
      (await seen.handler(seen.request(payload(), { query: shared() }))).status,
    ).toBe(401);
    expect(seen.lines.join("\n")).toContain("bearer_missing");
    const wrong = bearer(claims, "other-secret");
    expect(
      (
        await seen.handler(
          seen.request(payload(), {
            query: shared(),
            headers: { authorization: wrong },
          }),
        )
      ).status,
    ).toBe(401);
    await seen.handler(
      seen.request(payload(), {
        query: shared(),
        headers: { authorization: bearer(claims) },
      }),
    );
    expect(seen.markEndpointBearerSeen).not.toHaveBeenCalled();
  });

  // #1131-T04
  it("still accepts the per-project address of a registration that has not moved yet", async () => {
    const t = setup({ rows: [SHARED_ROW] });
    const response = await t.handler(t.request());
    expect(await response.json()).toEqual({
      status: "accepted",
      outcome: "workflow_runs_started",
    });
    expect(t.calls[0]).toBe("claim:jira-reg-1-id-1");
  });

  // #1131-T05
  it("refuses the per-project address of a registration that moved to the shared one", async () => {
    for (const registration of [
      { ...REGISTRATION, address: "connection", secretHash: null } as const,
      { ...REGISTRATION, address: "project", secretHash: null } as const,
    ]) {
      const t = setup({ registration });
      const response = await t.handler(t.request());
      expect(response.status).toBe(401);
      expect(t.calls).toEqual([]);
    }
  });

  // #1131-T12
  it("handles every project that names the same Jira project, each under its own claim, when Jira names both webhooks", async () => {
    const twin = {
      ...PROJECT,
      id: "proj-2",
    } as unknown as StoredProject;
    const twinRow: StoredJiraWebhook = {
      ...SHARED_ROW,
      id: "reg-2",
      projectId: "proj-2",
      jiraWebhookId: "1002",
    };
    const t = setup({
      rows: [SHARED_ROW, twinRow],
      projects: { "proj-1": PROJECT, "proj-2": twin },
    });
    const response = await t.handler(
      t.request(issueOf("PROJ-7", [1001, 1002]), { query: shared() }),
    );
    expect(response.status).toBe(200);
    expect(t.statuses).toHaveBeenCalledTimes(2);
    expect(t.statuses).toHaveBeenCalledWith(
      "reg-1-id-1",
      expect.objectContaining({ projectId: "proj-1" }),
    );
    expect(t.statuses).toHaveBeenCalledWith(
      "reg-2-id-1",
      expect.objectContaining({ projectId: "proj-2" }),
    );
    expect(t.calls.filter((call) => call.startsWith("claim:"))).toEqual([
      "claim:jira-reg-1-id-1",
      "claim:jira-reg-2-id-1",
    ]);
  });

  // #1131-T12
  it("hands a delivery that names one webhook to that project only, and a failure of one project to Jira", async () => {
    const twin = { ...PROJECT, id: "proj-2" } as unknown as StoredProject;
    const twinRow: StoredJiraWebhook = {
      ...SHARED_ROW,
      id: "reg-2",
      projectId: "proj-2",
      jiraWebhookId: "1002",
    };
    const only = setup({
      rows: [SHARED_ROW, twinRow],
      projects: { "proj-1": PROJECT, "proj-2": twin },
    });
    await only.handler(
      only.request(issueOf("PROJ-7", [1002]), { query: shared() }),
    );
    expect(only.statuses).toHaveBeenCalledTimes(1);
    expect(only.statuses).toHaveBeenCalledWith(
      "reg-2-id-1",
      expect.objectContaining({ projectId: "proj-2" }),
    );

    const failing = setup({
      rows: [SHARED_ROW, twinRow],
      projects: { "proj-1": PROJECT, "proj-2": twin },
      statusFails: true,
    });
    const response = await failing.handler(
      failing.request(issueOf("PROJ-7", [1001, 1002]), { query: shared() }),
    );
    expect(response.status).toBe(503);
    // Both were tried and both claims released: Jira retries the delivery.
    expect(failing.calls).toContain("release:jira-reg-1-id-1");
    expect(failing.calls).toContain("release:jira-reg-2-id-1");
  });
});
