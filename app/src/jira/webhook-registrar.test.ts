// SPDX-License-Identifier: LicenseRef-Proprietary

// The life of the webhooks the factory registers itself (#1039): registering when a Jira source is set up, extending close to expiry,
// registering again when Jira lost one, and deleting when the source goes.
import { describe, expect, it } from "vitest";
import type {
  JiraWebhooksRepository,
  StoredJiraWebhook,
} from "../db/repositories/jira-webhooks-repository.ts";
import type { StoredProject } from "../db/repositories/projects-repository.ts";
import {
  EXTEND_WITHIN_MS,
  ROTATE_AFTER_MS,
  createJiraWebhookRegistrar,
  jiraWebhookUrl,
  type ReconcileResult,
} from "./webhook-registrar.ts";
import { deriveWebhookSecret } from "./webhook-verify.ts";
import type { JiraWebhookApi } from "./webhooks-api.ts";

const APP_SECRET = "an-app-secret-for-tests";
const NOW = new Date("2026-11-14T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
/** The registrar's clock, moved by the tests that let weeks pass. */
const clock = { now: NOW };

type Endpoint = {
  generation: number;
  addressAt: string | null;
  bearerSeenAt: string | null;
};

function memoryWebhooks(): JiraWebhooksRepository & {
  rows: Map<string, StoredJiraWebhook>;
  endpoints: Map<string, Endpoint>;
} {
  const rows = new Map<string, StoredJiraWebhook>();
  const endpoints = new Map<string, Endpoint>([
    ["c1", { generation: 1, addressAt: null, bearerSeenAt: null }],
  ]);
  const byId = (id: string) => [...rows.values()].find((row) => row.id === id);
  const put = (
    row: StoredJiraWebhook | undefined,
    change: Partial<StoredJiraWebhook>,
  ) => {
    if (row === undefined) return false;
    rows.set(row.projectId, { ...row, ...change });
    return true;
  };
  return {
    rows,
    endpoints,
    async getByProject(projectId) {
      return rows.get(projectId);
    },
    async list() {
      return [...rows.values()];
    },
    async listByProjectKey(connectionId, projectKey) {
      return [...rows.values()].filter(
        (row) =>
          row.connectionId === connectionId &&
          row.projectKey === projectKey &&
          row.status !== "removing",
      );
    },
    async getEndpoint(connectionId) {
      const endpoint = endpoints.get(connectionId);
      return endpoint === undefined ? undefined : { connectionId, ...endpoint };
    },
    async markEndpointBearerSeen(connectionId) {
      const endpoint = endpoints.get(connectionId);
      if (endpoint === undefined || endpoint.bearerSeenAt !== null)
        return false;
      endpoint.bearerSeenAt = clock.now.toISOString();
      return true;
    },
    // The same effects as the SQL of the real repository.
    async moveToSharedAddress(connectionId, options) {
      const endpoint = endpoints.get(connectionId);
      if (
        endpoint === undefined ||
        endpoint.generation !== options.expectedGeneration
      )
        return false;
      if (options.rotate) endpoint.generation += 1;
      endpoint.addressAt = clock.now.toISOString();
      for (const row of [...rows.values()]) {
        if (row.connectionId !== connectionId) continue;
        if (row.status === "removing") rows.delete(row.projectId);
        else if (row.jiraWebhookId !== null)
          rows.set(row.projectId, {
            ...row,
            status: "pending",
            address: "connection",
            secretHash: null,
            pendingSecretHash: null,
            registrationAttempt: null,
            jiraWebhookId: null,
            expiresAt: null,
            registeredAt: null,
          });
      }
      return true;
    },
    async create(input) {
      if (rows.has(input.projectId)) return undefined;
      const { legacySecretHash, ...rest } = input;
      const row: StoredJiraWebhook = {
        ...rest,
        secretHash: legacySecretHash ?? null,
        address: legacySecretHash === undefined ? "connection" : "project",
        registrationAttempt: null,
        pendingSecretHash: null,
        workspaceId: "ws",
        status: "pending",
        jiraWebhookId: null,
        expiresAt: null,
        registeredAt: null,
        bearerSeenAt: null,
        errorCode: null,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      };
      rows.set(input.projectId, row);
      return row;
    },
    // The same conditions as the SQL of the real repository.
    async beginRegistration(id, attempt, expectedJiraWebhookId) {
      const row = byId(id);
      if (
        row === undefined ||
        row.status === "removing" ||
        row.jiraWebhookId !== expectedJiraWebhookId
      )
        return false;
      return put(row, { registrationAttempt: attempt });
    },
    async markRegistered(id, jiraWebhookId, expiresAt, attempt) {
      const row = byId(id);
      if (
        row === undefined ||
        row.status === "removing" ||
        row.registrationAttempt !== attempt
      )
        return false;
      const others = [...rows.values()].some(
        (other) =>
          other.connectionId === row.connectionId &&
          other.id !== id &&
          other.status === "active" &&
          other.address === "connection",
      );
      const endpoint = endpoints.get(row.connectionId);
      if (endpoint !== undefined && !(others && endpoint.addressAt !== null))
        endpoint.addressAt = clock.now.toISOString();
      return put(row, {
        status: "active",
        address: "connection",
        secretHash: null,
        pendingSecretHash: null,
        registrationAttempt: null,
        jiraWebhookId,
        expiresAt,
        registeredAt: clock.now.toISOString(),
        errorCode: null,
      });
    },
    async markBearerSeen(id) {
      const row = byId(id);
      return (
        row !== undefined &&
        row.bearerSeenAt === null &&
        put(row, { bearerSeenAt: clock.now.toISOString() })
      );
    },
    async markExtended(id, expiresAt) {
      return put(byId(id), { expiresAt, errorCode: null });
    },
    async markError(id, errorCode) {
      return put(byId(id), { errorCode });
    },
    async markRemoving(projectId) {
      return put(rows.get(projectId), { status: "removing" });
    },
    async remove(id) {
      const row = byId(id);
      return row !== undefined && rows.delete(row.projectId);
    },
  };
}

const jiraProject = (over: Partial<StoredProject> = {}): StoredProject => ({
  id: "p1",
  repositoryId: "r1",
  active: true,
  ticketSource: {
    provider: "jira",
    repositoryId: "r1",
    board: null,
    connectionId: "c1",
    projectKey: "PROJ",
  },
  settings: {},
  createdAt: "",
  updatedAt: "",
  ...over,
});

function setup(project: StoredProject | undefined | "none" = jiraProject()) {
  const webhooks = memoryWebhooks();
  const calls: string[] = [];
  const registered: {
    connectionId: string;
    url: string;
    jql: string;
    events: readonly string[];
  }[] = [];
  let nextId = 1000;
  let apiFailure:
    | {
        error:
          | "jira_webhook_limit"
          | "jira_webhook_url_conflict"
          | "jira_unavailable"
          | "jira_webhook_gone"
          | "jira_forbidden";
      }
    | undefined;
  let registerFailure: "jira_webhook_limit" | "jira_unavailable" | undefined;
  let whileRegistering: (call: number) => Promise<void> = async () => undefined;
  let listed: { id: string; jql: string; expiresAt: string }[] = [];
  const api: JiraWebhookApi = {
    async register(connectionId, webhook) {
      calls.push("register");
      registered.push({ connectionId, ...webhook });
      if (registerFailure !== undefined)
        return { ok: false, error: registerFailure };
      if (apiFailure !== undefined && apiFailure.error !== "jira_webhook_gone")
        return { ok: false, error: apiFailure.error };
      nextId += 1;
      const webhookId = String(nextId);
      await whileRegistering(registered.length);
      return { ok: true, webhookId };
    },
    async list(connectionId) {
      calls.push(`list:${connectionId}`);
      return { ok: true, webhooks: listed };
    },
    async extend(connectionId, ids) {
      calls.push(`extend:${connectionId}:${ids.join(",")}`);
      if (apiFailure !== undefined)
        return { ok: false, error: apiFailure.error };
      return {
        ok: true,
        expiresAt: new Date(NOW.getTime() + 30 * DAY).toISOString(),
      };
    },
    async remove(connectionId, ids) {
      calls.push(`remove:${connectionId}:${ids.join(",")}`);
      if (apiFailure !== undefined && apiFailure.error !== "jira_webhook_gone")
        return { ok: false, error: apiFailure.error };
      return { ok: true };
    },
  };
  const projects = new Map<string, StoredProject>(
    project === "none" ? [] : [[project.id, project]],
  );
  let n = 0;
  let attempts = 0;
  const registrar = createJiraWebhookRegistrar({
    webhooks,
    projects: { getById: async (id) => projects.get(id) },
    api,
    publicUrl: "https://app.example.test",
    addressSecret: (connectionId, generation) =>
      deriveWebhookSecret(APP_SECRET, connectionId, generation),
    now: () => clock.now,
    newId: () => `reg-${String((n += 1))}`,
    newAttempt: () => `attempt-${String((attempts += 1))}`,
    log: () => undefined,
  });
  clock.now = NOW;
  return {
    webhooks,
    registrar,
    calls,
    registered,
    setProject: (next: StoredProject) => projects.set(next.id, next),
    /** Another project (by default one of the same connection). */
    addProject: (next: StoredProject) => projects.set(next.id, next),
    failWith: (error: typeof apiFailure) => (apiFailure = error),
    failRegisterWith: (error: typeof registerFailure) =>
      (registerFailure = error),
    /** Runs while a registration is at Jira (after it made the webhook, before it answers); `call` counts the registrations. */
    during: (hook: typeof whileRegistering) => (whileRegistering = hook),
    jiraHas: (webhooks: typeof listed) => (listed = webhooks),
  };
}

describe("registering when a Jira source is set up", () => {
  // #1039-T03
  it("registers one webhook for project = KEY with the events the factory follows and the address of the connection with its derived secret", async () => {
    const t = setup();
    expect(await t.registrar.reconcile("p1")).toEqual({
      outcome: "registered",
    });
    expect(t.registered).toHaveLength(1);
    const call = t.registered[0];
    expect(call?.connectionId).toBe("c1");
    expect(call?.jql).toBe("project = PROJ");
    expect(call?.events).toEqual([
      "jira:issue_created",
      "jira:issue_updated",
      "jira:issue_deleted",
      "comment_created",
    ]);
    const url = new URL(call?.url ?? "");
    expect(url.origin + url.pathname).toBe(
      "https://app.example.test/api/webhooks/jira",
    );
    expect(url.searchParams.get("c")).toBe("c1");
    expect(url.searchParams.get("w")).toBeNull();
    expect(url.searchParams.get("s")).toBe(
      deriveWebhookSecret(APP_SECRET, "c1", 1),
    );
    const row = t.webhooks.rows.get("p1");
    expect(row).toMatchObject({
      status: "active",
      address: "connection",
      jiraWebhookId: "1001",
      errorCode: null,
    });
    // The secret is derived and never stored: nothing of it is in the row.
    expect(JSON.stringify(row)).not.toContain(url.searchParams.get("s") ?? "x");
    expect(row?.expiresAt).toBe(
      new Date(NOW.getTime() + 30 * DAY).toISOString(),
    );
  });

  // #1039-T03
  it("does nothing the second time and registers nothing for a project that has no Jira source", async () => {
    const t = setup();
    await t.registrar.reconcile("p1");
    expect(await t.registrar.reconcile("p1")).toEqual({ outcome: "unchanged" });
    expect(t.registered).toHaveLength(1);

    const github = setup(
      jiraProject({
        ticketSource: { provider: "github", repositoryId: "r1", board: null },
      }),
    );
    expect(await github.registrar.reconcile("p1")).toEqual({ outcome: "none" });
    expect(github.calls).toEqual([]);
    const off = setup(jiraProject({ active: false }));
    expect(await off.registrar.reconcile("p1")).toEqual({ outcome: "none" });
  });

  // #1039
  it("keeps a failed registration as a pending row with its code and tries again", async () => {
    const t = setup();
    t.failWith({ error: "jira_webhook_limit" });
    expect(await t.registrar.reconcile("p1")).toEqual({
      outcome: "failed",
      error: "jira_webhook_limit",
    });
    expect(t.webhooks.rows.get("p1")).toMatchObject({
      status: "pending",
      errorCode: "jira_webhook_limit",
      jiraWebhookId: null,
    });
    t.failWith(undefined);
    expect(await t.registrar.reconcile("p1")).toEqual({
      outcome: "registered",
    });
    expect(t.webhooks.rows.get("p1")).toMatchObject({
      status: "active",
      errorCode: null,
    });
  });

  // #1039
  it("fails when the connection is none of the workspace's", async () => {
    const t = setup();
    t.webhooks.create = async () => undefined;
    expect(await t.registrar.reconcile("p1")).toEqual({
      outcome: "failed",
      error: "jira_connection_not_found",
    });
  });
});

describe("extending", () => {
  // #1039-T03
  it("extends a webhook that ends within the window and leaves a young one alone", async () => {
    const t = setup();
    await t.registrar.reconcile("p1");
    t.calls.length = 0;
    expect(await t.registrar.reconcile("p1")).toEqual({ outcome: "unchanged" });
    expect(t.calls).toEqual([]);

    const row = t.webhooks.rows.get("p1");
    if (row === undefined) throw new Error("no row");
    t.webhooks.rows.set("p1", {
      ...row,
      expiresAt: new Date(
        NOW.getTime() + EXTEND_WITHIN_MS - 1000,
      ).toISOString(),
    });
    expect(await t.registrar.reconcile("p1")).toEqual({ outcome: "extended" });
    expect(t.calls).toEqual(["extend:c1:1001"]);
    expect(t.webhooks.rows.get("p1")?.expiresAt).toBe(
      new Date(NOW.getTime() + 30 * DAY).toISOString(),
    );
  });

  // #1039
  it("registers again when Jira no longer knows the webhook", async () => {
    const t = setup();
    await t.registrar.reconcile("p1");
    const row = t.webhooks.rows.get("p1");
    if (row === undefined) throw new Error("no row");
    t.webhooks.rows.set("p1", {
      ...row,
      expiresAt: new Date(NOW.getTime() - DAY).toISOString(),
    });
    let first = true;
    const original = t.registrar;
    // Jira answers "gone" to the extension once.
    t.failWith({ error: "jira_webhook_gone" });
    expect(await original.reconcile("p1")).toEqual({ outcome: "registered" });
    first = false;
    expect(first).toBe(false);
    expect(t.registered).toHaveLength(2);
    expect(t.webhooks.rows.get("p1")?.jiraWebhookId).toBe("1002");
  });

  // #1039
  it("records a failed extension on the row and tries again next time", async () => {
    const t = setup();
    await t.registrar.reconcile("p1");
    const row = t.webhooks.rows.get("p1");
    if (row === undefined) throw new Error("no row");
    t.webhooks.rows.set("p1", {
      ...row,
      expiresAt: new Date(NOW.getTime() + DAY).toISOString(),
    });
    t.failWith({ error: "jira_unavailable" });
    expect(await t.registrar.reconcile("p1")).toEqual({
      outcome: "failed",
      error: "jira_unavailable",
    });
    expect(t.webhooks.rows.get("p1")).toMatchObject({
      status: "active",
      errorCode: "jira_unavailable",
    });
    t.failWith(undefined);
    expect(await t.registrar.reconcile("p1")).toEqual({ outcome: "extended" });
    expect(t.webhooks.rows.get("p1")?.errorCode).toBeNull();
  });
});

describe("removing and changing the source", () => {
  // #1039-T03
  it("deletes the webhook at Jira and then the row when the project is switched off", async () => {
    const t = setup();
    await t.registrar.reconcile("p1");
    t.calls.length = 0;
    t.setProject(jiraProject({ active: false }));
    expect(await t.registrar.reconcile("p1")).toEqual({ outcome: "removed" });
    expect(t.calls).toEqual(["remove:c1:1001"]);
    expect(t.webhooks.rows.size).toBe(0);
  });

  // #1039-T03
  it("deletes the webhook when the source is no longer a Jira project", async () => {
    const t = setup();
    await t.registrar.reconcile("p1");
    t.setProject(
      jiraProject({
        ticketSource: { provider: "github", repositoryId: "r1", board: null },
      }),
    );
    expect(await t.registrar.reconcile("p1")).toEqual({ outcome: "removed" });
    expect(t.webhooks.rows.size).toBe(0);
  });

  // #1039
  it("keeps the row as removing when the deletion fails and finishes it next time", async () => {
    const t = setup();
    await t.registrar.reconcile("p1");
    t.setProject(jiraProject({ active: false }));
    t.failWith({ error: "jira_unavailable" });
    expect(await t.registrar.reconcile("p1")).toEqual({
      outcome: "failed",
      error: "jira_unavailable",
    });
    expect(t.webhooks.rows.get("p1")).toMatchObject({
      status: "removing",
      errorCode: "jira_unavailable",
    });
    t.failWith(undefined);
    expect(await t.registrar.reconcile("p1")).toEqual({ outcome: "removed" });
    expect(t.webhooks.rows.size).toBe(0);
  });

  // #1039
  it("replaces the webhook when the project points at another Jira project", async () => {
    const t = setup();
    await t.registrar.reconcile("p1");
    t.setProject(
      jiraProject({
        ticketSource: {
          provider: "jira",
          repositoryId: "r1",
          board: null,
          connectionId: "c1",
          projectKey: "OTHER",
        },
      }),
    );
    expect(await t.registrar.reconcile("p1")).toEqual({
      outcome: "registered",
    });
    expect(t.calls.filter((call) => call.startsWith("remove"))).toEqual([
      "remove:c1:1001",
    ]);
    expect(t.registered.at(-1)?.jql).toBe("project = OTHER");
    expect(t.webhooks.rows.get("p1")).toMatchObject({
      projectKey: "OTHER",
      status: "active",
    });
  });

  // #1039
  it("answers none for a project that never had a webhook", async () => {
    const t = setup("none");
    expect(await t.registrar.reconcile("p1")).toEqual({ outcome: "none" });
  });
});

describe("two registrations at once", () => {
  // #1039
  it("leaves the row with the Jira id of ONE registration, and deletes the webhook of the other", async () => {
    const t = setup();
    let inner: Promise<ReconcileResult> | undefined;
    // The first registration is at Jira (its webhook made) when the second one runs through, start to end.
    t.during(async (call) => {
      if (call !== 1) return;
      inner = t.registrar.reconcile("p1");
      await inner;
    });
    const first = await t.registrar.reconcile("p1");
    expect(await inner).toEqual({ outcome: "registered" });
    expect(first).toEqual({ outcome: "none" });
    expect(t.registered).toHaveLength(2);

    const row = t.webhooks.rows.get("p1");
    // The second registration's webhook is the row's.
    expect(row).toMatchObject({
      status: "active",
      jiraWebhookId: "1002",
      registrationAttempt: null,
    });
    // The first one's webhook is taken back at Jira, so it does not eat one of the five.
    expect(t.calls.filter((call) => call.startsWith("remove"))).toEqual([
      "remove:c1:1001",
    ]);
  });

  // #1039
  it("deletes the webhook it made when the row is being removed meanwhile", async () => {
    const t = setup();
    t.during(async () => {
      await t.webhooks.markRemoving("p1");
    });
    expect(await t.registrar.reconcile("p1")).toEqual({ outcome: "none" });
    expect(t.calls).toContain("remove:c1:1001");
    expect(t.webhooks.rows.get("p1")).toMatchObject({
      status: "removing",
      jiraWebhookId: null,
    });
  });

  // #1039
  it("does not start over a registration that finished since the row was read", async () => {
    const t = setup();
    await t.registrar.reconcile("p1");
    const stale = t.webhooks.rows.get("p1");
    if (stale === undefined) throw new Error("no row");
    // Another reconcile replaced the webhook after `stale` was read: the Jira id this one expects is gone.
    t.webhooks.rows.set("p1", { ...stale, jiraWebhookId: "2000" });
    expect(
      await t.webhooks.beginRegistration("reg-1", "x", stale.jiraWebhookId),
    ).toBe(false);
    expect(t.webhooks.rows.get("p1")?.registrationAttempt).toBeNull();
  });
});

describe("a registration whose outcome is unknown", () => {
  // #1039
  it("deletes the webhooks it left at Jira, found by their filter and the time, before it registers again", async () => {
    const t = setup();
    t.failRegisterWith("jira_unavailable");
    expect(await t.registrar.reconcile("p1")).toEqual({
      outcome: "failed",
      error: "jira_unavailable",
    });
    t.failRegisterWith(undefined);
    t.calls.length = 0;
    const ends = new Date(NOW.getTime() + 30 * DAY).toISOString();
    t.jiraHas([
      // What the timed-out call left: this project, ending 30 days after the attempt.
      { id: "900", jql: "project = PROJ", expiresAt: ends },
      // Another project's, and one of this filter that was made at another time: not ours to delete.
      { id: "901", jql: "project = OTHER", expiresAt: ends },
      {
        id: "902",
        jql: "project = PROJ",
        expiresAt: new Date(NOW.getTime() + 12 * DAY).toISOString(),
      },
    ]);
    expect(await t.registrar.reconcile("p1")).toEqual({
      outcome: "registered",
    });
    expect(t.calls).toEqual(["list:c1", "remove:c1:900", "register"]);
  });

  // #1039
  it("never deletes a webhook a row of the workspace knows", async () => {
    const t = setup();
    t.failRegisterWith("jira_unavailable");
    await t.registrar.reconcile("p1");
    t.failRegisterWith(undefined);
    t.calls.length = 0;
    // The row of ANOTHER project has webhook 900 on the same connection and key.
    t.webhooks.rows.set("other", {
      ...(t.webhooks.rows.get("p1") as StoredJiraWebhook),
      id: "other-reg",
      projectId: "other",
      jiraWebhookId: "900",
      status: "active",
    });
    t.jiraHas([
      {
        id: "900",
        jql: "project = PROJ",
        expiresAt: new Date(NOW.getTime() + 30 * DAY).toISOString(),
      },
    ]);
    await t.registrar.reconcile("p1");
    expect(t.calls).toEqual(["list:c1", "register"]);
  });

  // #1039
  it("does not look for orphans after a failure that cannot have made a webhook", async () => {
    const t = setup();
    t.failRegisterWith("jira_webhook_limit");
    await t.registrar.reconcile("p1");
    t.failRegisterWith(undefined);
    t.calls.length = 0;
    await t.registrar.reconcile("p1");
    expect(t.calls).toEqual(["register"]);
  });
});

describe("rotating the address", () => {
  const second = () =>
    jiraProject({
      id: "p2",
      ticketSource: {
        provider: "jira",
        repositoryId: "r1",
        board: null,
        connectionId: "c1",
        projectKey: "SECOND",
      },
    });

  // #1131-T07
  it("deletes every webhook of the connection once its address is older than the rotation age and registers them all again under the next generation", async () => {
    const t = setup();
    t.addProject(second());
    await t.registrar.reconcile("p1");
    await t.registrar.reconcile("p2");
    const before = t.webhooks.endpoints.get("c1");
    expect(before).toMatchObject({
      generation: 1,
      addressAt: NOW.toISOString(),
    });
    t.webhooks.endpoints.set("c1", {
      ...(before as Endpoint),
      bearerSeenAt: NOW.toISOString(),
    });
    clock.now = new Date(NOW.getTime() + ROTATE_AFTER_MS + DAY);
    t.calls.length = 0;
    t.registered.length = 0;
    expect(await t.registrar.reconcile("p1")).toEqual({
      outcome: "registered",
    });
    // Jira refuses a second address while one exists: all go first, then all come back.
    expect(t.calls).toEqual(["remove:c1:1001,1002", "register", "register"]);
    expect(t.registered.map((call) => call.jql)).toEqual([
      "project = PROJ",
      "project = SECOND",
    ]);
    const addresses = t.registered.map((call) => new URL(call.url));
    expect(new Set(addresses.map((url) => url.toString())).size).toBe(1);
    expect(addresses[0]?.searchParams.get("s")).toBe(
      deriveWebhookSecret(APP_SECRET, "c1", 2),
    );
    expect(addresses[0]?.searchParams.get("s")).not.toBe(
      deriveWebhookSecret(APP_SECRET, "c1", 1),
    );
    expect(t.webhooks.endpoints.get("c1")).toMatchObject({
      generation: 2,
      addressAt: clock.now.toISOString(),
      // What a token proved of this connection is not forgotten by a rotation.
      bearerSeenAt: NOW.toISOString(),
    });
    expect(t.webhooks.rows.get("p1")).toMatchObject({ status: "active" });
    expect(t.webhooks.rows.get("p2")).toMatchObject({ status: "active" });
    // And the next night it is young again.
    t.calls.length = 0;
    expect(await t.registrar.reconcile("p1")).toEqual({ outcome: "unchanged" });
    expect(t.calls).toEqual([]);
  });

  // #1131-T07
  it("leaves the webhooks as they are when the deletion of a rotation fails, and rotates on the next try", async () => {
    const t = setup();
    await t.registrar.reconcile("p1");
    clock.now = new Date(NOW.getTime() + ROTATE_AFTER_MS + DAY);
    t.failWith({ error: "jira_unavailable" });
    t.calls.length = 0;
    // The deletion fails (and so does the extension that follows, which Jira's answer is all of here): nothing else changed.
    expect(await t.registrar.reconcile("p1")).toEqual({
      outcome: "failed",
      error: "jira_unavailable",
    });
    expect(t.calls).toEqual(["remove:c1:1001", "extend:c1:1001"]);
    expect(t.webhooks.endpoints.get("c1")?.generation).toBe(1);
    expect(t.webhooks.rows.get("p1")).toMatchObject({
      status: "active",
      jiraWebhookId: "1001",
    });
    // Jira answers again: the webhook is extended, and the rotation is tried next.
    t.failWith(undefined);
    t.calls.length = 0;
    expect(await t.registrar.reconcile("p1")).toEqual({
      outcome: "registered",
    });
    expect(t.webhooks.endpoints.get("c1")?.generation).toBe(2);
  });
});

describe("one address for the projects of a connection", () => {
  const project = (id: string, projectKey: string, connectionId = "c1") =>
    jiraProject({
      id,
      ticketSource: {
        provider: "jira",
        repositoryId: "r1",
        board: null,
        connectionId,
        projectKey,
      },
    });

  // #1131-T01
  it("registers a second project of the connection with the same address and its own filter", async () => {
    const t = setup();
    t.addProject(project("p2", "SECOND"));
    expect(await t.registrar.reconcile("p1")).toEqual({
      outcome: "registered",
    });
    expect(await t.registrar.reconcile("p2")).toEqual({
      outcome: "registered",
    });
    expect(t.registered.map((call) => call.jql)).toEqual([
      "project = PROJ",
      "project = SECOND",
    ]);
    expect(t.registered[0]?.url).toBe(t.registered[1]?.url);
    // Nothing was deleted to make room: the first webhook stays.
    expect(t.calls.filter((call) => call.startsWith("remove"))).toEqual([]);
    expect(t.webhooks.rows.get("p1")?.jiraWebhookId).toBe("1001");
    expect(t.webhooks.rows.get("p2")?.jiraWebhookId).toBe("1002");
    // The address is as old as its first webhook, not as its last.
    expect(t.webhooks.endpoints.get("c1")?.addressAt).toBe(NOW.toISOString());
  });

  // #1131-T01
  it("gives a project of another connection the address of that connection", async () => {
    const t = setup();
    t.webhooks.endpoints.set("c2", {
      generation: 1,
      addressAt: null,
      bearerSeenAt: null,
    });
    t.addProject(project("p2", "SECOND", "c2"));
    await t.registrar.reconcile("p1");
    await t.registrar.reconcile("p2");
    const urls = t.registered.map((call) => new URL(call.url));
    expect(urls.map((url) => url.searchParams.get("c"))).toEqual(["c1", "c2"]);
    expect(urls[0]?.searchParams.get("s")).not.toBe(
      urls[1]?.searchParams.get("s"),
    );
  });

  // #1131-T08
  it("records Jira's refusal of a second address as a code of its own", async () => {
    const t = setup();
    t.failWith({ error: "jira_webhook_url_conflict" });
    expect(await t.registrar.reconcile("p1")).toEqual({
      outcome: "failed",
      error: "jira_webhook_url_conflict",
    });
    expect(t.webhooks.rows.get("p1")).toMatchObject({
      status: "pending",
      errorCode: "jira_webhook_url_conflict",
    });
  });
});

describe("a connection with webhooks under their own address (before #1131)", () => {
  /** A live row as it was: registered under its own address, with a secret hash of its own. */
  function legacyRow(
    t: ReturnType<typeof setup>,
    projectId: string,
    projectKey: string,
    jiraWebhookId: string | null,
  ) {
    t.webhooks.rows.set(projectId, {
      id: `old-${projectId}`,
      workspaceId: "ws",
      projectId,
      connectionId: "c1",
      projectKey,
      secretHash: "a".repeat(64),
      pendingSecretHash: null,
      registrationAttempt: null,
      address: "project",
      status: jiraWebhookId === null ? "pending" : "active",
      jiraWebhookId,
      expiresAt:
        jiraWebhookId === null
          ? null
          : new Date(NOW.getTime() + 20 * DAY).toISOString(),
      registeredAt: jiraWebhookId === null ? null : NOW.toISOString(),
      bearerSeenAt: null,
      errorCode: jiraWebhookId === null ? "jira_webhook_rejected" : null,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
  }
  const second = () =>
    jiraProject({
      id: "p2",
      ticketSource: {
        provider: "jira",
        repositoryId: "r1",
        board: null,
        connectionId: "c1",
        projectKey: "TBP",
      },
    });

  // #1131-T06
  it("moves the live project to the shared address and registers the pending one in the same reconcile", async () => {
    const t = setup();
    t.addProject(second());
    legacyRow(t, "p1", "PROJ", "555");
    legacyRow(t, "p2", "TBP", null);
    // The pending project's reconcile is the one that comes (the project switch-on, or the nightly job).
    expect(await t.registrar.reconcile("p2")).toEqual({
      outcome: "registered",
    });
    // Jira allows one address: the old webhook goes before any new one is registered.
    expect(t.calls).toEqual(["remove:c1:555", "register", "register"]);
    expect(t.registered.map((call) => call.jql).sort()).toEqual([
      "project = PROJ",
      "project = TBP",
    ]);
    expect(t.registered[0]?.url).toBe(t.registered[1]?.url);
    expect(t.webhooks.rows.get("p1")).toMatchObject({
      address: "connection",
      status: "active",
      secretHash: null,
      errorCode: null,
    });
    expect(t.webhooks.rows.get("p2")).toMatchObject({
      address: "connection",
      status: "active",
      secretHash: null,
      errorCode: null,
    });
    // The secret was never used: no rotation, the first generation.
    expect(t.webhooks.endpoints.get("c1")?.generation).toBe(1);
  });

  // #1131-T06
  it("moves the live project at its own reconcile when nothing else is waiting", async () => {
    const t = setup();
    legacyRow(t, "p1", "PROJ", "555");
    expect(await t.registrar.reconcile("p1")).toEqual({
      outcome: "registered",
    });
    expect(t.calls).toEqual(["remove:c1:555", "register"]);
    expect(await t.registrar.reconcile("p1")).toEqual({ outcome: "unchanged" });
  });

  // #1131-T06
  it("leaves the old webhook, and everything waiting behind it, when its deletion fails, and moves on the next try", async () => {
    const t = setup();
    t.addProject(second());
    legacyRow(t, "p1", "PROJ", "555");
    legacyRow(t, "p2", "TBP", null);
    t.failWith({ error: "jira_unavailable" });
    const failed = await t.registrar.reconcile("p2");
    expect(failed).toMatchObject({ outcome: "failed" });
    expect(t.webhooks.rows.get("p1")).toMatchObject({
      address: "project",
      status: "active",
      jiraWebhookId: "555",
    });
    t.failWith(undefined);
    t.calls.length = 0;
    expect(await t.registrar.reconcile("p2")).toEqual({
      outcome: "registered",
    });
    expect(t.webhooks.rows.get("p1")?.address).toBe("connection");
  });

  // #1131-T06
  it("registers a pending project of the old shape under the shared address when nothing is registered yet", async () => {
    const t = setup();
    legacyRow(t, "p1", "PROJ", null);
    expect(await t.registrar.reconcile("p1")).toEqual({
      outcome: "registered",
    });
    expect(t.calls).toEqual(["register"]);
    expect(t.webhooks.rows.get("p1")).toMatchObject({
      address: "connection",
      secretHash: null,
      status: "active",
    });
  });
});

describe("a deletion Jira refuses", () => {
  // #1039
  it("removes the row anyway after a 401 or 403, so that the new source can register (Jira ends the webhook within 30 days)", async () => {
    const t = setup();
    await t.registrar.reconcile("p1");
    t.setProject(jiraProject({ active: false }));
    t.failWith({ error: "jira_forbidden" });
    expect(await t.registrar.reconcile("p1")).toEqual({ outcome: "removed" });
    expect(t.webhooks.rows.size).toBe(0);
  });

  // #1039
  it("keeps the row as removing when Jira is only unreachable", async () => {
    const t = setup();
    await t.registrar.reconcile("p1");
    t.setProject(jiraProject({ active: false }));
    t.failWith({ error: "jira_unavailable" });
    expect(await t.registrar.reconcile("p1")).toMatchObject({
      outcome: "failed",
    });
    expect(t.webhooks.rows.get("p1")?.status).toBe("removing");
  });
});

describe("the address", () => {
  // #1131
  it("is the app's address with the connection and the secret in the query", () => {
    expect(jiraWebhookUrl("https://app.example.test/", "conn", "sec")).toBe(
      "https://app.example.test/api/webhooks/jira?c=conn&s=sec",
    );
  });
});
