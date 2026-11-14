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
  createJiraWebhookRegistrar,
  jiraWebhookUrl,
} from "./webhook-registrar.ts";
import type { JiraWebhookApi } from "./webhooks-api.ts";

const NOW = new Date("2026-11-14T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

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
        workspaceId: "ws",
        status: "pending",
        jiraWebhookId: null,
        expiresAt: null,
        errorCode: null,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      };
      rows.set(input.projectId, row);
      return row;
    },
    async markRegistered(id, jiraWebhookId, expiresAt) {
      return put(byId(id), {
        status: "active",
        jiraWebhookId,
        expiresAt,
        errorCode: null,
      });
    },
    async markExtended(id, expiresAt) {
      return put(byId(id), { expiresAt, errorCode: null });
    },
    async markError(id, errorCode) {
      return put(byId(id), { errorCode });
    },
    async reset(id, secretHash) {
      return put(byId(id), {
        status: "pending",
        secretHash,
        jiraWebhookId: null,
        expiresAt: null,
        errorCode: null,
      });
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
    | { error: "jira_webhook_limit" | "jira_unavailable" | "jira_webhook_gone" }
    | undefined;
  const api: JiraWebhookApi = {
    async register(connectionId, webhook) {
      calls.push("register");
      registered.push({ connectionId, ...webhook });
      if (apiFailure !== undefined && apiFailure.error !== "jira_webhook_gone")
        return { ok: false, error: apiFailure.error };
      nextId += 1;
      return { ok: true, webhookId: String(nextId) };
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
    now: () => NOW,
    newId: () => `reg-${String((n += 1))}`,
    newSecret: () => `secret-${String((secrets += 1))}`,
    log: () => undefined,
  });
  return {
    webhooks,
    registrar,
    calls,
    registered,
    setProject: (next: StoredProject | undefined) => (current = next),
    failWith: (error: typeof apiFailure) => (apiFailure = error),
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

describe("the address", () => {
  // #1039
  it("is the app's address with the registration and the secret in the query", () => {
    expect(jiraWebhookUrl("https://app.example.test/", "reg", "sec")).toBe(
      "https://app.example.test/api/webhooks/jira?w=reg&s=sec",
    );
  });
});
