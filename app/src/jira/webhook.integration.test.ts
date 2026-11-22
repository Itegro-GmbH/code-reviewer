// SPDX-License-Identifier: LicenseRef-Proprietary

// The inbound Jira webhook (#1039, epic #1034) against a real Postgres and the fake Atlassian: the factory registers its own webhook when a
// Jira source is set up, the fake CALLS the registered address as Jira does (a loopback server in front of the real handler), and what that
// does is read back from the tables: the run a status change starts, the ticket mirror, the refusals and the repeated delivery, the nightly
// extension and the deletion when the source goes. Atlassian's HTTP is the loopback fake only.
import { describe, expect, it } from "vitest";
import type { FakeJiraIssue } from "../../../fakes/atlassian/server.ts";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createJiraConnectionsRepository } from "../db/repositories/jira-connections-repository.ts";
import { createJiraWebhookDirectory } from "../db/repositories/jira-webhook-directory-repository.ts";
import { createJiraWebhooksRepository } from "../db/repositories/jira-webhooks-repository.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { createTrackerRepository } from "../db/repositories/tracker-repository.ts";
import { createWebhookDeliveriesRepository } from "../db/repositories/webhook-deliveries-repository.ts";
import { createWorkflowRunsRepository } from "../db/repositories/workflow-runs-repository.ts";
import { createWorkflowsRepository } from "../db/repositories/workflows-repository.ts";
import type { RepoRef } from "../integrations/types.ts";
import { createProjectService } from "../projects/service.ts";
import { handleJiraWebhooksCron } from "../cron/jira-webhooks.ts";
import { createJiraHarness } from "../test-support/jira-harness.ts";
import { startWebhookReceiver } from "../test-support/jira-webhook-receiver.ts";
import {
  createJiraStatusTrigger,
  jiraProjectView,
} from "../workflow-runs/jira-status-trigger.ts";
import { createJiraIssueReader } from "./issue-reader.ts";
import { createJiraMirror } from "./mirror.ts";
import { createJiraProjectReader } from "./projects.ts";
import { createJiraStatusDirectory } from "./status-directory.ts";
import {
  createJiraActivationHook,
  createJiraDeactivationHook,
} from "./project-hooks.ts";
import { createJiraTicketProvider } from "./ticket-provider.ts";
import { createJiraWebhookHandler } from "./webhook-handler.ts";
import {
  createJiraWebhookRegistrar,
  jiraWebhookUrl,
} from "./webhook-registrar.ts";
import { deriveWebhookSecret, hashWebhookSecret } from "./webhook-verify.ts";
import { createJiraWebhookApi } from "./webhooks-api.ts";

const APP_SECRET = "an-app-secret-for-tests";
const SITE = {
  id: "aaaaaaaa-0000-0000-0000-000000000001",
  url: "https://acme.atlassian.net",
  name: "acme",
};
const DAY = 24 * 60 * 60 * 1000;
const CRON_SECRET = "c".repeat(40);

const ISSUE: FakeJiraIssue = {
  id: "10042",
  key: "PROJ-7",
  summary: "Fix the login",
  description: {
    type: "doc",
    version: 1,
    content: [
      { type: "paragraph", content: [{ type: "text", text: "It fails." }] },
    ],
  },
  status: { name: "Ready for agent" },
  issueType: "Bug",
  assignee: { accountId: "acc-1", displayName: "Ada Lovelace" },
  labels: ["backend"],
};

const LANE = {
  version: 1,
  name: "Jira status lane",
  triggers: [
    { id: "ready", kind: "ticket.statusChanged", to: "Ready for agent" },
  ],
  steps: [
    {
      id: "implement",
      kind: "agent",
      profile: "worker",
      environment: "Python",
      instruction:
        "{{trigger.ticket.key}} {{trigger.ticket.title}} {{trigger.status.from}} to {{trigger.status.to}}",
    },
  ],
};

// #1058: a site whose user reads Jira in German: the REST API names the statuses in German, a webhook delivery with the name Jira keeps.
const GERMAN_STATUSES = [
  {
    id: "10100",
    name: "Zu erledigen",
    untranslatedName: "To Do",
    category: "new" as const,
  },
  { id: "10101", name: "In Arbeit", untranslatedName: "In Progress" },
  {
    id: "10102",
    name: "Erledigt",
    untranslatedName: "Done",
    category: "done" as const,
  },
];

async function world(options: { german?: boolean } = {}) {
  const h = await createJiraHarness({
    atlassian: {
      sites: [SITE],
      projects: {
        [SITE.id]: [
          {
            id: "10000",
            key: "PROJ",
            name: "Project",
            ...(options.german === true
              ? {
                  issueTypes: [
                    { id: "1", name: "Task", statuses: GERMAN_STATUSES },
                  ],
                }
              : {}),
          },
          { id: "10001", key: "NEW", name: "Next project" },
        ],
      },
    },
  });
  const workspace = await h.workspace("acme");
  const owner = await h.person("owner", {
    workspaceId: workspace.id,
    role: "owner",
  });
  await h.walk(owner, workspace, "owner");
  const [connection] = await h.jira.service.list(workspace.id);
  if (connection === undefined) throw new Error("not connected");
  h.atlassian.setIssues(SITE.id, [
    options.german === true
      ? { ...ISSUE, status: { name: "In Arbeit" } }
      : ISSUE,
  ]);

  const integration = await createIntegrationsRepository(
    h.db,
    workspace.id,
  ).create({
    type: "github_app",
    displayName: "acme",
    externalId: "4242",
    config: {},
  });
  const remote: RepoRef = {
    integrationId: integration.id,
    externalId: "1",
    fullName: "acme/shop",
    url: "https://github.test/acme/shop",
  };
  const repositories = createRepositoriesRepository(h.db, workspace.id);
  const remote2: RepoRef = {
    integrationId: integration.id,
    externalId: "2",
    fullName: "acme/blog",
    url: "https://github.test/acme/blog",
  };
  await repositories.reconcile(integration.id, [remote, remote2]);
  const listed = await repositories.list();
  const shop = listed.find((row) => row.fullName === "acme/shop");
  // A second project on the connection needs a repository of its own (one project per repository).
  const blog = listed.find((row) => row.fullName === "acme/blog");
  if (shop === undefined || blog === undefined)
    throw new Error("seeding failed");
  const repository = shop;
  const repository2 = blog;

  const projects = createProjectsRepository(h.db, workspace.id);
  const webhooks = createJiraWebhooksRepository(h.db, workspace.id, h.now);
  const tracker = createTrackerRepository(h.db, workspace.id);
  const runs = createWorkflowRunsRepository(h.db, workspace.id);
  const workflows = createWorkflowsRepository(h.db, workspace.id);
  const tokens = h.jira.tokensFor(workspace.id);
  const directory = createJiraWebhookDirectory(h.db);

  // The address the webhooks are registered with is the receiver's: the fake calls it, the real handler answers.
  let handler: (request: Request) => Promise<Response> = async () =>
    new Response("not ready", { status: 503 });
  const receiver = await startWebhookReceiver(() => handler);

  const registrar = createJiraWebhookRegistrar({
    webhooks,
    projects,
    api: createJiraWebhookApi({ tokens }),
    publicUrl: receiver.url,
    addressSecret: (connectionId, generation) =>
      deriveWebhookSecret(APP_SECRET, connectionId, generation),
    now: h.now,
    log: h.logs.push.bind(h.logs),
  });

  const connections = createJiraConnectionsRepository(h.db, workspace.id);
  const reader = createJiraIssueReader({
    tokens,
    siteUrlOf: async (id) => (await connections.get(id))?.siteUrl,
  });
  const provider = createJiraTicketProvider({ readerFor: async () => reader });
  const kicked: string[] = [];
  const statusesOf = createJiraStatusDirectory({
    reader: createJiraProjectReader({ tokens }),
  }).statusesOf;
  const statuses = createJiraStatusTrigger({
    statusesOf,
    runs,
    workflows,
    async projectOf(projectId) {
      const project = await projects.getById(projectId);
      return project === undefined ? undefined : jiraProjectView(project);
    },
    async repositoryOf(repositoryId) {
      const row = await repositories.get(repositoryId);
      return row === undefined
        ? undefined
        : { id: row.id, fullName: row.fullName, defaultBranch: "main" };
    },
    async readTicket(source, key) {
      const row = await repositories.get(source.repositoryId);
      if (row === undefined) return undefined;
      return (
        (await provider.readTicket?.(
          {
            integration: { ...integration, workspaceId: workspace.id },
            repo: remote,
            jira: {
              connectionId: source.connectionId,
              projectKey: source.projectKey,
            },
          },
          key,
        )) ?? undefined
      );
    },
    kick: (runId) => void kicked.push(runId),
    log: h.logs.push.bind(h.logs),
  });
  const logger = {
    info: (line: string) => h.logs.push(line),
    warn: (line: string) => h.logs.push(line),
    error: (line: string) => h.logs.push(line),
  };
  handler = createJiraWebhookHandler({
    directory,
    addressSecret: (connectionId, generation) =>
      deriveWebhookSecret(APP_SECRET, connectionId, generation),
    deliveries: createWebhookDeliveriesRepository(h.db),
    clientSecret: () => h.atlassian.clientSecret,
    workspace: () => ({
      registrations: webhooks,
      projects,
      repositoryName: async (id) => (await repositories.get(id))?.fullName,
      mirror: createJiraMirror({ tracker }),
      statusesOf: statusesOf,
      statuses,
    }),
    logger,
    // The fake signs its bearer tokens with the wall clock, the harness clock is the one the tests move: a token is judged by the first.
    now: () => new Date(),
  });

  const service = createProjectService({
    projects,
    hooks: {
      async onProjectDeactivated() {},
      onProjectActivated: createJiraActivationHook({
        tracker,
        projects,
        webhooks,
        registrar,
        log: h.logs.push.bind(h.logs),
      }),
      afterProjectDeactivated: createJiraDeactivationHook({ registrar }),
    },
  });

  async function createJiraProject(laneTo = "Ready for agent") {
    const project = await service.createProject(repository.id, null, {
      connectionId: connection.id,
      projectKey: "PROJ",
    });
    const lane = await workflows.create(
      {
        name: "Jira status lane",
        document: JSON.stringify({
          ...LANE,
          triggers: [{ id: "ready", kind: "ticket.statusChanged", to: laneTo }],
        }),
        createdBy: owner.id,
        projectId: project.id,
      },
      100,
    );
    if (!lane.ok) throw new Error("seeding failed");
    return project;
  }

  /** A second project, of the second repository, on the same Jira connection (Jira project `NEW`). */
  async function createSecondJiraProject() {
    return service.createProject(repository2.id, null, {
      connectionId: connection.id,
      projectKey: "NEW",
    });
  }

  const moveTo = (status: string, from = "To Do") => ({
    webhookEvent: "jira:issue_updated" as const,
    issueKey: "PROJ-7",
    changelog: [{ field: "status", fromString: from, toString: status }],
  });
  const runsOf = () =>
    h.db
      .selectFrom("workflow_runs")
      .selectAll()
      .where("workspace_id", "=", workspace.id)
      .execute();

  return {
    h,
    workspace,
    owner,
    connection,
    repository,
    repository2,
    projects,
    webhooks,
    tracker,
    registrar,
    service,
    receiver,
    directory,
    kicked,
    createJiraProject,
    createSecondJiraProject,
    moveTo,
    runsOf,
    async hook() {
      const [hook] = h.atlassian.webhooks();
      if (hook === undefined) throw new Error("no webhook registered");
      return hook;
    },
  };
}

describe("registering the webhook of a Jira source", () => {
  // #1039-T03
  it("registers a webhook for project = KEY when a project is created with a Jira source, under the address of its connection, and stores no secret", async () => {
    const w = await world();
    const project = await w.createJiraProject();

    const [hook] = w.h.atlassian.webhooks();
    expect(w.h.atlassian.webhooks()).toHaveLength(1);
    expect(hook).toMatchObject({
      cloudId: SITE.id,
      jql: "project = PROJ",
      events: [
        "jira:issue_created",
        "jira:issue_updated",
        "jira:issue_deleted",
        "comment_created",
      ],
    });
    const row = await w.webhooks.getByProject(project.id);
    expect(row).toMatchObject({
      status: "active",
      connectionId: w.connection.id,
      projectKey: "PROJ",
      jiraWebhookId: String(hook?.id),
      address: "connection",
      secretHash: null,
      errorCode: null,
    });
    const address = new URL(hook?.url ?? "");
    expect(address.pathname).toBe("/api/webhooks/jira");
    expect(address.searchParams.get("c")).toBe(w.connection.id);
    expect(address.searchParams.get("w")).toBeNull();
    const secret = address.searchParams.get("s") ?? "";
    expect(secret).toBe(deriveWebhookSecret(APP_SECRET, w.connection.id, 1));
    expect(secret.length).toBeGreaterThanOrEqual(40);
    // The secret is nowhere in the database.
    const stored = await w.h.db
      .selectFrom("jira_webhooks")
      .selectAll()
      .execute();
    expect(JSON.stringify(stored)).not.toContain(secret);
    // The token of the connection was used, never shown: no log line holds the secret or a token.
    for (const token of w.h.atlassian.issuedTokens())
      expect(w.h.logs.join("\n")).not.toContain(token);
    expect(w.h.logs.join("\n")).not.toContain(secret);
  });

  // #1039-T03
  it("extends a webhook that ends soon in the nightly job, and leaves a young one", async () => {
    const w = await world();
    const project = await w.createJiraProject();
    const hook = await w.hook();
    const cron = (now = w.h.clock.time) =>
      handleJiraWebhooksCron(
        new Request("https://factory.example.test/api/internal/jira-webhooks", {
          headers: { authorization: `Bearer ${CRON_SECRET}` },
        }),
        {
          env: { CRON_SECRET },
          enabled: () => true,
          targets: (limit) => w.directory.listProjects(limit),
          reconcile: (_workspaceId, projectId) =>
            w.registrar.reconcile(projectId),
          now: () => now,
          log: () => undefined,
        },
      ).then((response) => response.json() as Promise<Record<string, unknown>>);

    expect(await cron()).toMatchObject({
      status: "ok",
      webhooks: 1,
      unchanged: 1,
      extended: 0,
    });

    // The stored end of life is what the job looks at: Jira's own end is moved close and the row follows through the extension.
    const soon = new Date(w.h.clock.time + 3 * DAY).toISOString();
    w.h.atlassian.setWebhookExpiry(hook.id, soon);
    await w.h.db
      .updateTable("jira_webhooks")
      .set({ expires_at: soon })
      .where("project_id", "=", project.id)
      .execute();

    expect(await cron()).toMatchObject({ extended: 1, failed: 0 });
    const after = await w.webhooks.getByProject(project.id);
    expect(Date.parse(after?.expiresAt ?? "") - w.h.clock.time).toBeGreaterThan(
      20 * DAY,
    );
    expect(Date.parse((await w.hook()).expiresAt) - Date.now()).toBeGreaterThan(
      29 * DAY,
    );
  });

  // #1039
  it("is refused without the cron's credential and registers again a webhook that Jira lost", async () => {
    const w = await world();
    const project = await w.createJiraProject();
    const unauthorised = await handleJiraWebhooksCron(
      new Request("https://factory.example.test/api/internal/jira-webhooks"),
      {
        env: { CRON_SECRET },
        enabled: () => true,
        targets: async () => [],
        reconcile: async () => ({ outcome: "none" }),
      },
    );
    expect(unauthorised.status).toBe(401);

    const lost = await w.hook();
    w.h.atlassian.dropWebhook(lost.id);
    const stored = await w.webhooks.getByProject(project.id);
    await w.h.db
      .updateTable("jira_webhooks")
      .set({ expires_at: new Date(w.h.clock.time + DAY).toISOString() })
      .where("id", "=", stored?.id ?? "")
      .execute();
    expect(await w.registrar.reconcile(project.id)).toEqual({
      outcome: "registered",
    });
    const [again] = w.h.atlassian.webhooks();
    expect(again?.id).not.toBe(lost.id);
    expect((await w.webhooks.getByProject(project.id))?.jiraWebhookId).toBe(
      String(again?.id),
    );
  });

  // #1039-T03
  it("deletes the webhook at Jira and its row when the project is switched off", async () => {
    const w = await world();
    const project = await w.createJiraProject();
    expect(w.h.atlassian.webhooks()).toHaveLength(1);

    await w.service.deactivateProject(w.repository.id);

    expect(w.h.atlassian.webhooks()).toEqual([]);
    expect(await w.webhooks.getByProject(project.id)).toBeUndefined();
  });

  // #1039
  it("walks an active Jira project that has no webhook row at all, and registers it in the nightly job", async () => {
    const w = await world();
    const project = await w.createJiraProject();
    // The row never came to exist (the activation hook failed before it): the project is found by its source.
    await w.h.db
      .deleteFrom("jira_webhooks")
      .where("project_id", "=", project.id)
      .execute();
    const lost = await w.hook();
    w.h.atlassian.dropWebhook(lost.id);
    expect(await w.directory.listProjects(10)).toEqual([
      { workspaceId: w.workspace.id, projectId: project.id },
    ]);

    expect(await w.registrar.reconcile(project.id)).toEqual({
      outcome: "registered",
    });
    expect(w.h.atlassian.webhooks()).toHaveLength(1);
    // Listed once, whether it has a row or not.
    expect(await w.directory.listProjects(10)).toHaveLength(1);
  });

  // #1039
  it("keeps a failed registration on the row and registers it the next night", async () => {
    const w = await world();
    w.h.atlassian.failNext("/ex/jira/" + SITE.id + "/rest/api/3/webhook", {
      status: 503,
    });
    const project = await w.createJiraProject();
    expect(w.h.atlassian.webhooks()).toEqual([]);
    expect(await w.webhooks.getByProject(project.id)).toMatchObject({
      status: "pending",
      errorCode: "jira_unavailable",
    });
    expect(await w.registrar.reconcile(project.id)).toEqual({
      outcome: "registered",
    });
    expect(w.h.atlassian.webhooks()).toHaveLength(1);
  });

  // #1039
  it("says so when Jira's limit of five webhooks per connection is reached", async () => {
    const w = await world();
    // Five other registrations of the same app and user take all five that Jira allows.
    for (let i = 0; i < 5; i += 1)
      await createJiraWebhookApi({
        tokens: w.h.jira.tokensFor(w.workspace.id),
      }).register(w.connection.id, {
        // Jira allows one address per user, so the five carry the address the factory would use.
        url: jiraWebhookUrl(
          w.receiver.url,
          w.connection.id,
          deriveWebhookSecret(APP_SECRET, w.connection.id, 1),
        ),
        jql: `project = OTHER${String(i)}`,
        events: ["jira:issue_updated"],
      });
    const project = await w.createJiraProject();
    expect(await w.webhooks.getByProject(project.id)).toMatchObject({
      status: "pending",
      errorCode: "jira_webhook_limit",
    });
  });
});

// #1058: Jira localizes the status names it answers a REST call with (the user's language), a webhook delivery carries the names Jira keeps
// for every language. The lane's status is compared by the status's id, so either spelling starts it.
describe("a delivery of a Jira site whose user reads Jira in German", () => {
  async function movedToDo(laneTo: string) {
    const w = await world({ german: true });
    await w.createJiraProject(laneTo);
    const hook = await w.hook();
    // The person moves LAT-57 to "Zu erledigen"; the delivery says "To Do" (the id is the same).
    w.h.atlassian.setIssueStatus(SITE.id, "PROJ-7", { name: "Zu erledigen" });
    const answer = await w.h.atlassian.deliver(
      hook.id,
      w.moveTo("To Do", "In Progress"),
    );
    return { w, hook, answer };
  }

  // #1058-T01
  it("starts the lane that waits for the localized name the picker offers, and writes that name into the mirror", async () => {
    const { w, answer } = await movedToDo("Zu erledigen");

    expect(answer.body).toEqual({
      status: "accepted",
      outcome: "workflow_runs_started",
    });
    const runs = await w.runsOf();
    expect(runs).toHaveLength(1);
    const input = JSON.parse(String(runs[0]?.trigger_input)) as {
      ticket: { status: string };
      status: { from: string; to: string };
    };
    expect(input.ticket.status).toBe("Zu erledigen");
    expect(input.status).toEqual({ from: "In Arbeit", to: "Zu erledigen" });
    // #1058-T05: the mirror holds the name the picker and the resync use, not the one of the delivery.
    expect(await w.tracker.getItem(w.repository.id, 7)).toMatchObject({
      boardStatus: "Zu erledigen",
    });
  });

  // #1058-T02
  it("starts the lane that waits for the untranslated name too", async () => {
    const { w, answer } = await movedToDo("To Do");

    expect(answer.body).toEqual({
      status: "accepted",
      outcome: "workflow_runs_started",
    });
    expect(await w.runsOf()).toHaveLength(1);
  });

  // #1058-T03
  it("stops a late delivery for a status the issue no longer has, and one for another status than the lane waits for", async () => {
    const w = await world({ german: true });
    await w.createJiraProject("Zu erledigen");
    const hook = await w.hook();

    // The issue was moved on to "In Arbeit" before the delivery for "To Do" was handled: the stale guard reads that.
    const late = await w.h.atlassian.deliver(
      hook.id,
      w.moveTo("To Do", "In Progress"),
    );
    expect(late.body).toEqual({
      status: "accepted",
      outcome: "tracker_updated",
    });
    expect(await w.runsOf()).toEqual([]);

    // A move to "Erledigt" is not the lane's status.
    w.h.atlassian.setIssueStatus(SITE.id, "PROJ-7", { name: "Erledigt" });
    await w.h.atlassian.deliver(hook.id, w.moveTo("Done", "To Do"));
    expect(await w.runsOf()).toEqual([]);
  });
});

describe("a delivery of Jira", () => {
  // #1039-T01
  it("starts one run with the ticket filled and writes the issue into the mirror when a signed delivery moves it into the lane's status", async () => {
    const w = await world();
    const project = await w.createJiraProject();
    const hook = await w.hook();

    const answer = await w.h.atlassian.deliver(
      hook.id,
      w.moveTo("Ready for agent"),
    );

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      status: "accepted",
      outcome: "workflow_runs_started",
    });
    const runs = await w.runsOf();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      trigger_kind: "ticket.statusChanged",
      trigger_id: "ready",
      ticket_ref: "jira:acme/shop#PROJ-7",
      repository_id: w.repository.id,
      actor_login: "Ada Lovelace",
    });
    const input = JSON.parse(String(runs[0]?.trigger_input)) as {
      ticket: Record<string, unknown>;
      status: Record<string, unknown>;
    };
    expect(input.ticket).toMatchObject({
      key: "PROJ-7",
      title: "Fix the login",
      body: "It fails.",
      url: "https://acme.atlassian.net/browse/PROJ-7",
      status: "Ready for agent",
      type: "Bug",
      labels: ["backend"],
      assignees: ["Ada Lovelace"],
    });
    expect(input.status).toEqual({ from: "To Do", to: "Ready for agent" });
    expect(w.kicked).toHaveLength(1);
    expect(await w.tracker.getItem(w.repository.id, 7)).toMatchObject({
      provider: "jira",
      key: "PROJ-7",
      title: "Fix the login",
      boardStatus: "Ready for agent",
      repo: "acme/shop",
    });
    expect(project.ticketSource.provider).toBe("jira");
  });

  // #1039-T02
  it("refuses a delivery without the secret of its connection, with another one, or from an unknown connection, and starts nothing", async () => {
    const w = await world();
    await w.createJiraProject();
    const hook = await w.hook();
    const address = new URL(hook.url);
    const secret = address.searchParams.get("s") ?? "";
    const connection = address.searchParams.get("c") ?? "";
    const send = (url: string) =>
      w.h.atlassian.deliver(hook.id, { ...w.moveTo("Ready for agent"), url });

    const noSecret = new URL(hook.url);
    noSecret.searchParams.delete("s");
    const wrongSecret = new URL(hook.url);
    wrongSecret.searchParams.set("s", `${secret.slice(0, -1)}x`);
    const unknown = new URL(hook.url);
    unknown.searchParams.set("c", `${connection}-nope`);
    const bare = new URL(hook.url);
    bare.search = "";

    for (const url of [noSecret, wrongSecret, unknown, bare]) {
      const answer = await send(url.toString());
      expect(answer.status).toBe(401);
      expect(answer.body).toEqual({ error: "JIRA_WEBHOOK_UNAUTHORIZED" });
    }
    // A bearer token that is not signed with the client secret refuses a delivery that has the right secret.
    const forged = await w.h.atlassian.deliver(hook.id, {
      ...w.moveTo("Ready for agent"),
      bearer: "wrong",
    });
    expect(forged.status).toBe(401);
    expect(await w.runsOf()).toEqual([]);
    expect(await w.tracker.getItem(w.repository.id, 7)).toBeUndefined();
    // No log line repeats the secret.
    expect(w.h.logs.join("\n")).not.toContain(secret);
  });

  // #1039-T02
  it("accepts a delivery without a bearer token on the secret alone, and handles a repeated delivery once", async () => {
    const w = await world();
    await w.createJiraProject();
    const hook = await w.hook();
    const delivery = {
      ...w.moveTo("Ready for agent"),
      bearer: "none" as const,
      identifier: "same-delivery",
    };

    const first = await w.h.atlassian.deliver(hook.id, delivery);
    const second = await w.h.atlassian.deliver(hook.id, delivery);

    expect(first.body).toEqual({
      status: "accepted",
      outcome: "workflow_runs_started",
    });
    expect(second).toMatchObject({
      status: 200,
      body: { status: "accepted", outcome: "duplicate" },
    });
    expect(await w.runsOf()).toHaveLength(1);
    expect(w.kicked).toHaveLength(1);
  });

  // #1039
  it("starts nothing for a move into another status, but mirrors the issue", async () => {
    const w = await world();
    await w.createJiraProject();
    const hook = await w.hook();
    w.h.atlassian.setIssueStatus(SITE.id, "PROJ-7", { name: "In Progress" });

    const answer = await w.h.atlassian.deliver(
      hook.id,
      w.moveTo("In Progress"),
    );

    expect(answer.body).toEqual({
      status: "accepted",
      outcome: "tracker_updated",
    });
    expect(await w.runsOf()).toEqual([]);
    expect(await w.tracker.getItem(w.repository.id, 7)).toMatchObject({
      boardStatus: "In Progress",
    });
  });

  // #1039-T01
  it("does not start a run for a late delivery whose status the issue no longer has", async () => {
    const w = await world();
    await w.createJiraProject();
    const hook = await w.hook();
    // The issue was moved on after the delivery was made.
    w.h.atlassian.setIssueStatus(SITE.id, "PROJ-7", { name: "In Progress" });

    const answer = await w.h.atlassian.deliver(
      hook.id,
      w.moveTo("Ready for agent"),
    );

    expect(answer.status).toBe(200);
    expect(await w.runsOf()).toEqual([]);
    expect(w.h.logs.join("\n")).toContain("no longer has the status");
  });

  // #1039
  it("starts a run whoever made the change, also the factory's own account", async () => {
    const w = await world();
    await w.createJiraProject();
    const hook = await w.hook();
    const answer = await w.h.atlassian.deliver(hook.id, {
      ...w.moveTo("Ready for agent"),
      user: { accountId: "712020:the-factory", displayName: "Code Reviewer" },
    });
    expect(answer.body).toMatchObject({ outcome: "workflow_runs_started" });
    expect((await w.runsOf())[0]?.actor_login).toBe("Code Reviewer");
  });

  // #1039
  it("handles creation, comment and deletion of an issue in the mirror, and ignores events it does not follow", async () => {
    const w = await world();
    await w.createJiraProject();
    const hook = await w.hook();

    const created = await w.h.atlassian.deliver(hook.id, {
      webhookEvent: "jira:issue_created",
      issueKey: "PROJ-7",
    });
    expect(created.body).toMatchObject({ outcome: "tracker_updated" });
    expect(await w.tracker.getItem(w.repository.id, 7)).toMatchObject({
      key: "PROJ-7",
    });
    const commented = await w.h.atlassian.deliver(hook.id, {
      webhookEvent: "comment_created",
      issueKey: "PROJ-7",
    });
    expect(commented.status).toBe(200);
    // A creation starts no lane, even into the lane's status: it is no change of status.
    expect(await w.runsOf()).toEqual([]);

    const deleted = await w.h.atlassian.deliver(hook.id, {
      webhookEvent: "jira:issue_deleted",
      issueKey: "PROJ-7",
      timestamp: Date.now() + 60_000,
    });
    expect(deleted.body).toMatchObject({ outcome: "tracker_updated" });
    expect(await w.tracker.getItem(w.repository.id, 7)).toBeUndefined();
  });

  // #1039
  it("ignores a delivery once the project is switched off or has another source, and a registration that is being removed", async () => {
    const w = await world();
    const project = await w.createJiraProject();
    const hook = await w.hook();
    await w.projects.deactivate(w.repository.id, async () => undefined);

    const answer = await w.h.atlassian.deliver(
      hook.id,
      w.moveTo("Ready for agent"),
    );
    expect(answer.body).toEqual({ status: "accepted", outcome: "ignored" });
    expect(await w.runsOf()).toEqual([]);

    // A registration that is being removed is no project to route a delivery to.
    await w.webhooks.markRemoving(project.id);
    const removed = await w.h.atlassian.deliver(
      hook.id,
      w.moveTo("Ready for agent"),
    );
    expect(removed.body).toEqual({ status: "accepted", outcome: "ignored" });
    expect(await w.runsOf()).toEqual([]);
  });

  // #1039
  it("clears the GitHub rows of the repository when its project switches to a Jira project, and keeps the Jira rows", async () => {
    const w = await world();
    // The repository had GitHub issues in the mirror (its project was on GitHub before).
    await w.tracker.upsertItem(w.repository.id, {
      provider: "github",
      repo: "acme/shop",
      number: 7,
      nodeId: "gh-node",
      kind: "issue",
      state: "open",
      stateReason: null,
      type: null,
      title: "A GitHub issue",
      bodyExcerpt: "",
      labels: [],
      assignees: [],
      closes: [],
      updatedAt: "2026-11-01T00:00:00.000Z",
    });
    expect(await w.tracker.getItem(w.repository.id, 7)).toMatchObject({
      provider: "github",
    });

    await w.createJiraProject();
    expect(await w.tracker.getItem(w.repository.id, 7)).toBeUndefined();

    // The first Jira row takes the number the GitHub row had.
    const hook = await w.hook();
    await w.h.atlassian.deliver(hook.id, w.moveTo("Ready for agent"));
    expect(await w.tracker.getItem(w.repository.id, 7)).toMatchObject({
      provider: "jira",
    });
  });
});

describe("switching a project from one Jira project to another", () => {
  // #1039
  it("clears the rows of the first, so that NEW-7 is written although OLD-7 held the number 7, and registers a webhook for the second", async () => {
    const w = await world();
    w.h.atlassian.setIssues(SITE.id, [
      ISSUE,
      { ...ISSUE, id: "10099", key: "NEW-7" },
    ]);
    const project = await w.createJiraProject();
    const first = await w.hook();
    await w.h.atlassian.deliver(first.id, w.moveTo("Ready for agent"));
    expect(await w.tracker.getItem(w.repository.id, 7)).toMatchObject({
      key: "PROJ-7",
    });

    // Switched off (the webhook goes) and on again with the other Jira project.
    await w.service.deactivateProject(w.repository.id);
    await w.service.createProject(w.repository.id, null, {
      connectionId: w.connection.id,
      projectKey: "NEW",
    });
    expect(await w.tracker.getItem(w.repository.id, 7)).toBeUndefined();
    const [second] = w.h.atlassian.webhooks();
    expect(w.h.atlassian.webhooks()).toHaveLength(1);
    expect(second).toMatchObject({ jql: "project = NEW" });

    const answer = await w.h.atlassian.deliver(second?.id ?? 0, {
      ...w.moveTo("Ready for agent"),
      issueKey: "NEW-7",
    });
    expect(answer.status).toBe(200);
    expect(await w.tracker.getItem(w.repository.id, 7)).toMatchObject({
      provider: "jira",
      key: "NEW-7",
    });
    expect((await w.webhooks.getByProject(project.id))?.projectKey).toBe("NEW");
  });
});

describe("trust on first use of the bearer token", () => {
  // #1039
  it("refuses a delivery without a token once a token that verified was seen, and still refuses a wrong one", async () => {
    const w = await world();
    await w.createJiraProject();
    const hook = await w.hook();
    expect(
      (await w.webhooks.getEndpoint(w.connection.id))?.bearerSeenAt,
    ).toBeNull();

    // Before any token was seen the secret alone is enough.
    const early = await w.h.atlassian.deliver(hook.id, {
      ...w.moveTo("Ready for agent"),
      bearer: "none",
    });
    expect(early.status).toBe(200);
    expect(
      (await w.webhooks.getEndpoint(w.connection.id))?.bearerSeenAt,
    ).toBeNull();

    const signed = await w.h.atlassian.deliver(
      hook.id,
      w.moveTo("Ready for agent"),
    );
    expect(signed.status).toBe(200);
    expect(
      (await w.webhooks.getEndpoint(w.connection.id))?.bearerSeenAt,
    ).not.toBeNull();

    const bare = await w.h.atlassian.deliver(hook.id, {
      ...w.moveTo("Ready for agent"),
      bearer: "none",
    });
    expect(bare.status).toBe(401);
    expect(w.h.logs.join("\n")).toContain("bearer_missing");
    const wrong = await w.h.atlassian.deliver(hook.id, {
      ...w.moveTo("Ready for agent"),
      bearer: "wrong",
    });
    expect(wrong.status).toBe(401);
    const again = await w.h.atlassian.deliver(
      hook.id,
      w.moveTo("Ready for agent"),
    );
    expect(again.status).toBe(200);
  });
});

describe("rotating the address in the nightly job", () => {
  const cron = (w: Awaited<ReturnType<typeof world>>) =>
    handleJiraWebhooksCron(
      new Request("https://factory.example.test/api/internal/jira-webhooks", {
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
      {
        env: { CRON_SECRET },
        enabled: () => true,
        targets: (limit) => w.directory.listProjects(limit),
        reconcile: (_workspaceId, projectId) =>
          w.registrar.reconcile(projectId),
        now: () => w.h.clock.time,
        log: () => undefined,
      },
    ).then((response) => response.json() as Promise<Record<string, unknown>>);

  // #1131-T07
  it("registers every webhook of the connection again after 25 days under a new secret, and the old address is refused", async () => {
    const w = await world();
    const project = await w.createJiraProject();
    const second = await w.createSecondJiraProject();
    const [first, other] = w.h.atlassian.webhooks();
    if (first === undefined || other === undefined)
      throw new Error("no webhooks");
    expect(first.url).toBe(other.url);
    expect(
      await w.h.atlassian.deliver(first.id, w.moveTo("Ready for agent")),
    ).toMatchObject({ status: 200 });
    const before = await w.webhooks.getEndpoint(w.connection.id);
    expect(before).toMatchObject({ generation: 1 });
    expect(before?.bearerSeenAt).not.toBeNull();

    w.h.clock.time += 26 * DAY;
    // Both projects are walked: the first one's reconcile rotates for the connection, the second finds its webhook fresh.
    expect(await cron(w)).toMatchObject({ failed: 0 });

    const fresh = w.h.atlassian.webhooks();
    expect(fresh).toHaveLength(2);
    expect(fresh.map((hook) => hook.id)).not.toContain(first.id);
    expect(fresh[0]?.url).toBe(fresh[1]?.url);
    expect(fresh[0]?.url).not.toBe(first.url);
    for (const id of [project.id, second.id])
      expect(await w.webhooks.getByProject(id)).toMatchObject({
        status: "active",
        address: "connection",
        errorCode: null,
      });
    const after = await w.webhooks.getEndpoint(w.connection.id);
    expect(after).toMatchObject({ generation: 2 });
    // What a token proved stays proven: the rotation did not start trust over.
    expect(after?.bearerSeenAt).toBe(before?.bearerSeenAt);

    const target = fresh.find((hook) => hook.jql === "project = PROJ");
    const viaNew = await w.h.atlassian.deliver(target?.id ?? 0, {
      ...w.moveTo("Ready for agent"),
      identifier: "after-rotation",
    });
    expect(viaNew.status).toBe(200);
    // The address of the old webhook, secret included, is refused.
    const viaOld = await w.h.atlassian.deliver(target?.id ?? 0, {
      ...w.moveTo("Ready for agent"),
      url: first.url,
    });
    expect(viaOld.status).toBe(401);
    // And the next night it is young.
    expect(await cron(w)).toMatchObject({ registered: 0, failed: 0 });
    expect(w.h.atlassian.webhooks()).toHaveLength(2);
  });
});

describe("the compare-and-set of a registration, against the real table", () => {
  // #1039
  it("lets only the registration whose marker is still the row's mark it done, and not one that began over a changed Jira id", async () => {
    const w = await world();
    const project = await w.createJiraProject();
    const row = await w.webhooks.getByProject(project.id);
    if (row === undefined) throw new Error("no row");

    // Two registrations began on the row they both read (Jira id as it is): the second one's marker is the row's.
    expect(
      await w.webhooks.beginRegistration(
        row.id,
        "attempt-a",
        row.jiraWebhookId,
      ),
    ).toBe(true);
    expect(
      await w.webhooks.beginRegistration(
        row.id,
        "attempt-b",
        row.jiraWebhookId,
      ),
    ).toBe(true);
    expect(
      await w.webhooks.markRegistered(
        row.id,
        "7001",
        new Date(w.h.clock.time + 30 * DAY).toISOString(),
        "attempt-a",
      ),
    ).toBe(false);
    expect(
      await w.webhooks.markRegistered(
        row.id,
        "7002",
        new Date(w.h.clock.time + 30 * DAY).toISOString(),
        "attempt-b",
      ),
    ).toBe(true);
    expect(await w.webhooks.getByProject(project.id)).toMatchObject({
      jiraWebhookId: "7002",
      secretHash: null,
      registrationAttempt: null,
    });
    // A registration that read the row before that (it expected the old Jira id) does not begin over it.
    expect(
      await w.webhooks.beginRegistration(
        row.id,
        "attempt-c",
        row.jiraWebhookId,
      ),
    ).toBe(false);
    // A row that is being removed is not registered or begun.
    await w.webhooks.markRemoving(project.id);
    expect(
      await w.webhooks.beginRegistration(row.id, "attempt-d", "7002"),
    ).toBe(false);
    expect(
      await w.webhooks.markRegistered(
        row.id,
        "7003",
        new Date(w.h.clock.time + 30 * DAY).toISOString(),
        "attempt-d",
      ),
    ).toBe(false);
    // The first token of a connection is noted once.
    expect(await w.webhooks.markEndpointBearerSeen(w.connection.id)).toBe(true);
    expect(await w.webhooks.markEndpointBearerSeen(w.connection.id)).toBe(
      false,
    );
  });
});

describe("two projects on one Jira connection (#1131)", () => {
  // #1131-T01
  it("registers a second project with the same address and routes the deliveries of both to their own project", async () => {
    const w = await world();
    w.h.atlassian.setIssues(SITE.id, [
      ISSUE,
      { ...ISSUE, id: "10050", key: "NEW-3", summary: "Another project's" },
    ]);
    const first = await w.createJiraProject();
    const second = await w.createSecondJiraProject();

    const hooks = w.h.atlassian.webhooks();
    expect(hooks.map((hook) => hook.jql)).toEqual([
      "project = PROJ",
      "project = NEW",
    ]);
    // Jira accepts only one address per user: both carry the same.
    expect(hooks[0]?.url).toBe(hooks[1]?.url);
    for (const project of [first, second])
      expect(await w.webhooks.getByProject(project.id)).toMatchObject({
        status: "active",
        errorCode: null,
      });

    // A delivery of each webhook is mirrored into the repository of ITS project.
    const toFirst = await w.h.atlassian.deliver(
      hooks[0]?.id ?? 0,
      w.moveTo("Ready for agent"),
    );
    expect(toFirst.status).toBe(200);
    const toSecond = await w.h.atlassian.deliver(hooks[1]?.id ?? 0, {
      webhookEvent: "jira:issue_updated",
      issueKey: "NEW-3",
      changelog: [
        { field: "status", fromString: "To Do", toString: "In Progress" },
      ],
    });
    expect(toSecond.status).toBe(200);
    expect(await w.tracker.getItem(w.repository.id, 7)).toMatchObject({
      key: "PROJ-7",
    });
    expect(await w.tracker.getItem(w.repository2.id, 3)).toMatchObject({
      key: "NEW-3",
    });
    expect(await w.tracker.getItem(w.repository.id, 3)).toBeUndefined();
    expect(await w.tracker.getItem(w.repository2.id, 7)).toBeUndefined();
  });

  // #1131-T10
  it("moves a project registered under its own address, and registers the pending second one, in the next reconcile, without a manual write", async () => {
    const w = await world();
    w.h.atlassian.setIssues(SITE.id, [
      ISSUE,
      { ...ISSUE, id: "10050", key: "NEW-3", summary: "Another project's" },
    ]);
    const api = createJiraWebhookApi({
      tokens: w.h.jira.tokensFor(w.workspace.id),
    });
    // The state live before the fix: the first project registered under its own address (`?w=&s=`), the second one pending after Jira's refusal.
    const activated = async (repositoryId: string, projectKey: string) => {
      const result = await w.projects.activate(repositoryId, {
        jira: { connectionId: w.connection.id, projectKey },
      });
      if (result.kind !== "activated") throw new Error("seeding failed");
      return result.project;
    };
    const first = await activated(w.repository.id, "PROJ");
    const second = await activated(w.repository2.id, "NEW");
    const oldSecret = "old-secret-of-the-first-project";
    const oldAddress = `${w.receiver.url}/api/webhooks/jira?w=old-1&s=${oldSecret}`;
    const made = await api.register(w.connection.id, {
      url: oldAddress,
      jql: "project = PROJ",
      events: ["jira:issue_created", "jira:issue_updated"],
    });
    if (!made.ok) throw new Error("seeding failed");
    await w.webhooks.create({
      id: "old-1",
      projectId: first.id,
      connectionId: w.connection.id,
      projectKey: "PROJ",
      legacySecretHash: hashWebhookSecret(oldSecret),
    });
    await w.h.db
      .updateTable("jira_webhooks")
      .set({
        status: "active",
        jira_webhook_id: made.webhookId,
        expires_at: new Date(w.h.clock.time + 20 * DAY).toISOString(),
        registered_at: new Date(w.h.clock.time).toISOString(),
      })
      .where("id", "=", "old-1")
      .execute();
    await w.webhooks.create({
      id: "old-2",
      projectId: second.id,
      connectionId: w.connection.id,
      projectKey: "NEW",
      legacySecretHash: hashWebhookSecret("old-secret-of-the-second"),
    });
    await w.webhooks.markError("old-2", "jira_webhook_rejected");
    const [oldHook] = w.h.atlassian.webhooks();
    if (oldHook === undefined) throw new Error("seeding failed");

    // The deploy changes nothing by itself: the old address is accepted.
    const before = await w.h.atlassian.deliver(
      oldHook.id,
      w.moveTo("Ready for agent"),
    );
    expect(before.status).toBe(200);

    // The next reconcile of the pending project (the nightly job, or a switch of the project) moves both.
    expect(await w.registrar.reconcile(second.id)).toEqual({
      outcome: "registered",
    });
    const hooks = w.h.atlassian.webhooks();
    expect(hooks.map((hook) => hook.jql).sort()).toEqual([
      "project = NEW",
      "project = PROJ",
    ]);
    expect(hooks[0]?.url).toBe(hooks[1]?.url);
    expect(new URL(hooks[0]?.url ?? "").searchParams.get("c")).toBe(
      w.connection.id,
    );
    for (const id of ["old-1", "old-2"])
      expect(
        await w.h.db
          .selectFrom("jira_webhooks")
          .selectAll()
          .where("id", "=", id)
          .executeTakeFirst(),
      ).toMatchObject({
        status: "active",
        address: "connection",
        secret_hash: null,
        error_code: null,
      });

    // Both projects receive their deliveries on the shared address, and the old address is refused now.
    const forNew = hooks.find((hook) => hook.jql === "project = NEW");
    const answer = await w.h.atlassian.deliver(forNew?.id ?? 0, {
      webhookEvent: "jira:issue_updated",
      issueKey: "NEW-3",
      changelog: [
        { field: "status", fromString: "To Do", toString: "In Progress" },
      ],
    });
    expect(answer.status).toBe(200);
    expect(await w.tracker.getItem(w.repository2.id, 3)).toMatchObject({
      key: "NEW-3",
    });
    const forFirst = hooks.find((hook) => hook.jql === "project = PROJ");
    const viaOld = await w.h.atlassian.deliver(forFirst?.id ?? 0, {
      ...w.moveTo("Ready for agent"),
      url: oldAddress,
    });
    expect(viaOld.status).toBe(401);
  });

  // #1131
  it("reads the single-address refusal of Jira as a code of its own", async () => {
    const w = await world();
    // Another address of the same user holds the one Jira allows (a webhook that is not this factory's).
    await createJiraWebhookApi({
      tokens: w.h.jira.tokensFor(w.workspace.id),
    }).register(w.connection.id, {
      url: `${w.receiver.url}/someone-elses`,
      jql: "project = OTHER",
      events: ["jira:issue_updated"],
    });
    const project = await w.createJiraProject();
    expect(await w.webhooks.getByProject(project.id)).toMatchObject({
      status: "pending",
      errorCode: "jira_webhook_url_conflict",
    });
  });
});

describe("a deletion Jira refuses", () => {
  // #1039
  it("removes the row after a 403, so that the project is not stuck, although the webhook stays at Jira until it ends", async () => {
    const w = await world();
    const project = await w.createJiraProject();
    w.h.atlassian.failNext("/ex/jira/" + SITE.id + "/rest/api/3/webhook", {
      status: 403,
    });
    await w.service.deactivateProject(w.repository.id);
    expect(await w.webhooks.getByProject(project.id)).toBeUndefined();
    expect(w.h.atlassian.webhooks()).toHaveLength(1);
  });
});
