// SPDX-License-Identifier: LicenseRef-Proprietary

// The steps of the Jira webhook handler (#1039) with its collaborators replaced: the order of the refusals, what a claim does, and what a
// failure after the claim does. The whole path against real tables is in webhook.integration.test.ts.
import { createHash, createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { DirectoryJiraWebhook } from "../db/repositories/jira-webhook-directory-repository.ts";
import type { StoredProject } from "../db/repositories/projects-repository.ts";
import type { WebhookDeliveriesRepository } from "../db/repositories/webhook-deliveries-repository.ts";
import {
  createJiraWebhookHandler,
  type JiraWorkspaceCollaborators,
} from "./webhook-handler.ts";
import { hashWebhookSecret } from "./webhook-verify.ts";

const SECRET = "a-secret-of-the-test-registration";

const REGISTRATION: DirectoryJiraWebhook = {
  id: "reg-1",
  workspaceId: "ws-1",
  projectId: "proj-1",
  connectionId: "conn-1",
  projectKey: "PROJ",
  secretHash: hashWebhookSecret(SECRET),
  pendingSecretHash: null,
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
    labelsFail?: boolean;
    labelsMatch?: boolean;
    mirrorFails?: boolean;
    project?: StoredProject | undefined;
    configured?: boolean;
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
  const labels = vi.fn(async () => {
    if (options.labelsFail === true) throw new Error("db gone");
    return options.labelsMatch === false
      ? { matched: 0, started: 0, existing: 0, skipped: 0, busy: 0 }
      : { matched: 1, started: 1, existing: 0, skipped: 0, busy: 0 };
  });
  const apply = vi.fn(async () => {
    if (options.mirrorFails === true) throw new Error("db gone");
    return "updated" as const;
  });
  const markBearerSeen = vi.fn(async () => true);
  const collaborators: JiraWorkspaceCollaborators = {
    registrations: { markBearerSeen },
    projects: {
      getById: async () => ("project" in options ? options.project : PROJECT),
    },
    repositoryName: async () => "acme/shop",
    mirror: { apply },
    statuses: { start: statuses },
    labels: { start: labels },
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
    labels,
    apply,
    lines,
    markBearerSeen,
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

  // #1129-T08
  it("hands the labels an update added to the label starter and answers that runs started", async () => {
    const t = setup();
    const body = payload({
      changelog: {
        items: [
          {
            field: "labels",
            fromString: "backend",
            toString: "backend ready-for-agent",
          },
        ],
      },
    });
    expect(await (await t.handler(t.request(body))).json()).toEqual({
      status: "accepted",
      outcome: "workflow_runs_started",
    });
    expect(t.labels).toHaveBeenCalledWith("reg-1-id-1", {
      projectId: "proj-1",
      connectionId: "conn-1",
      projectKey: "PROJ",
      issueKey: "PROJ-7",
      labels: ["ready-for-agent"],
      actor: { accountId: "acc-1", name: "Grace" },
    });
    // No status item: the status starter is not asked.
    expect(t.statuses).not.toHaveBeenCalled();
    expect(t.calls).toEqual([
      "claim:jira-reg-1-id-1",
      "complete:jira-reg-1-id-1:workflow_runs_started",
    ]);
  });

  // #1129-T01
  it("does not ask the label starter for a removed label, a status change or a comment", async () => {
    const removed = setup();
    await removed.handler(
      removed.request(
        payload({
          changelog: {
            items: [
              {
                field: "labels",
                fromString: "backend ready-for-agent",
                toString: "backend",
              },
            ],
          },
        }),
      ),
    );
    const moved = setup();
    await moved.handler(moved.request());
    expect(removed.labels).not.toHaveBeenCalled();
    expect(moved.labels).not.toHaveBeenCalled();
  });

  // #1129-T03
  it("hands the labels of a created issue to the label starter", async () => {
    const t = setup({ labelsMatch: false });
    const created = payload({ webhookEvent: "jira:issue_created" });
    delete (created as { changelog?: unknown }).changelog;
    (created.issue.fields as Record<string, unknown>).labels = [
      "ready-for-agent",
    ];
    expect(await (await t.handler(t.request(created))).json()).toEqual({
      status: "accepted",
      outcome: "tracker_updated",
    });
    expect(t.labels).toHaveBeenCalledWith(
      "reg-1-id-1",
      expect.objectContaining({ labels: ["ready-for-agent"] }),
    );
  });

  // #1129
  it("releases the claim and answers 503 when the lanes of a label cannot be started", async () => {
    const t = setup({ labelsFail: true });
    const body = payload({
      changelog: {
        items: [{ field: "labels", fromString: null, toString: "x" }],
      },
    });
    const response = await t.handler(t.request(body));
    expect(response.status).toBe(503);
    expect(t.calls).toEqual([
      "claim:jira-reg-1-id-1",
      "release:jira-reg-1-id-1",
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
