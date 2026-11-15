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
import { hashWebhookSecret } from "./webhook-verify.ts";
import type { JiraWebhookApi } from "./webhooks-api.ts";

const NOW = new Date("2026-11-14T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
/** The registrar's clock, moved by the tests that let weeks pass. */
const clock = { now: NOW };

function memoryWebhooks(): JiraWebhooksRepository & {
  rows: Map<string, StoredJiraWebhook>;
} {
  const rows = new Map<string, StoredJiraWebhook>();
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
    async getByProject(projectId) {
      return rows.get(projectId);
    },
    async list() {
      return [...rows.values()];
    },
    async create(input) {
      if (rows.has(input.projectId)) return undefined;
      const row: StoredJiraWebhook = {
        ...input,
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
    async beginRegistration(id, pendingSecretHash, expectedJiraWebhookId) {
      const row = byId(id);
      if (
        row === undefined ||
        row.status === "removing" ||
        row.jiraWebhookId !== expectedJiraWebhookId
      )
        return false;
      return put(row, { pendingSecretHash });
    },
    async markRegistered(id, jiraWebhookId, expiresAt, pendingSecretHash) {
      const row = byId(id);
      if (
        row === undefined ||
        row.status === "removing" ||
        row.pendingSecretHash !== pendingSecretHash
      )
        return false;
      return put(row, {
        status: "active",
        secretHash: pendingSecretHash,
        pendingSecretHash: null,
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
  let current: StoredProject | undefined =
    project === "none" ? undefined : project;
  let n = 0;
  let secrets = 0;
  const registrar = createJiraWebhookRegistrar({
    webhooks,
    projects: { getById: async () => current },
    api,
    publicUrl: "https://app.example.test",
    now: () => clock.now,
    newId: () => `reg-${String((n += 1))}`,
    newSecret: () => `secret-${String((secrets += 1))}`,
    log: () => undefined,
  });
  clock.now = NOW;
  return {
    webhooks,
    registrar,
    calls,
    registered,
    setProject: (next: StoredProject | undefined) => (current = next),
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
  it("registers one webhook for project = KEY with the events the factory follows and an address that carries the registration and its secret", async () => {
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
    expect(url.searchParams.get("w")).toBe("reg-1");
    const row = t.webhooks.rows.get("p1");
    expect(row).toMatchObject({
      status: "active",
      jiraWebhookId: "1001",
      errorCode: null,
    });
    // Only the hash is stored.
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
  it("keeps a failed registration as a pending row with its code and tries again with a new secret", async () => {
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
    const firstHash = t.webhooks.rows.get("p1")?.secretHash;
    t.failWith(undefined);
    expect(await t.registrar.reconcile("p1")).toEqual({
      outcome: "registered",
    });
    expect(t.webhooks.rows.get("p1")).toMatchObject({
      status: "active",
      errorCode: null,
    });
    expect(t.webhooks.rows.get("p1")?.secretHash).not.toBe(firstHash);
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

const secretOf = (url: string | undefined) =>
  new URL(url ?? "https://x.test").searchParams.get("s") ?? "";

describe("two registrations at once", () => {
  // #1039
  it("leaves the row with the Jira id and the secret of ONE registration, and deletes the webhook of the other", async () => {
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
    // Jira's id and the secret belong together: the second registration's.
    expect(row).toMatchObject({
      status: "active",
      jiraWebhookId: "1002",
      pendingSecretHash: null,
    });
    expect(row?.secretHash).toBe(
      hashWebhookSecret(secretOf(t.registered[1]?.url)),
    );
    expect(row?.secretHash).not.toBe(
      hashWebhookSecret(secretOf(t.registered[0]?.url)),
    );
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
    expect(t.webhooks.rows.get("p1")?.pendingSecretHash).toBeNull();
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

describe("rotating the secret", () => {
  // #1039
  it("registers a new webhook with a new secret once the registration is older than the rotation age, and deletes the old webhook after", async () => {
    const t = setup();
    await t.registrar.reconcile("p1");
    const before = t.webhooks.rows.get("p1");
    if (before === undefined) throw new Error("no row");
    t.webhooks.rows.set("p1", {
      ...before,
      registeredAt: NOW.toISOString(),
      bearerSeenAt: NOW.toISOString(),
    });
    clock.now = new Date(NOW.getTime() + ROTATE_AFTER_MS + DAY);
    t.calls.length = 0;
    expect(await t.registrar.reconcile("p1")).toEqual({
      outcome: "registered",
    });
    // The new webhook exists before the old one goes: no moment without one.
    expect(t.calls).toEqual(["register", "remove:c1:1001"]);
    const row = t.webhooks.rows.get("p1");
    expect(row).toMatchObject({
      status: "active",
      jiraWebhookId: "1002",
      pendingSecretHash: null,
      // What a token proved of this registration is not forgotten by a rotation.
      bearerSeenAt: NOW.toISOString(),
    });
    expect(row?.secretHash).toBe(
      hashWebhookSecret(secretOf(t.registered[1]?.url)),
    );
    expect(row?.secretHash).not.toBe(before.secretHash);
    expect(row?.registeredAt).toBe(clock.now.toISOString());
    // And the next night it is young again.
    t.calls.length = 0;
    expect(await t.registrar.reconcile("p1")).toEqual({ outcome: "unchanged" });
  });

  // #1039
  it("keeps the old webhook, and extends it when it ends soon, when the rotation fails", async () => {
    const t = setup();
    await t.registrar.reconcile("p1");
    clock.now = new Date(NOW.getTime() + ROTATE_AFTER_MS + DAY);
    t.failRegisterWith("jira_webhook_limit");
    t.calls.length = 0;
    expect(await t.registrar.reconcile("p1")).toEqual({ outcome: "extended" });
    expect(t.calls).toEqual(["register", "extend:c1:1001"]);
    expect(t.webhooks.rows.get("p1")).toMatchObject({
      status: "active",
      jiraWebhookId: "1001",
    });
    // The old secret still works: it was not replaced.
    expect(t.webhooks.rows.get("p1")?.secretHash).toBe(
      hashWebhookSecret(secretOf(t.registered[0]?.url)),
    );
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
  // #1039
  it("is the app's address with the registration and the secret in the query", () => {
    expect(jiraWebhookUrl("https://app.example.test/", "reg", "sec")).toBe(
      "https://app.example.test/api/webhooks/jira?w=reg&s=sec",
    );
  });
});
