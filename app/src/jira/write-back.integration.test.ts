// SPDX-License-Identifier: LicenseRef-Proprietary

// The write-back of the factory to Jira (#1040, epic #1034) against a real Postgres and the fake Atlassian: a lane's ticket actions (comment,
// labels, transition) through the real provider, writer and token handling in the order of the lane, the factory's own comment found again by its
// marker and edited in place, a comment `/answer` that reaches the answer taker through the real webhook handler, and the full read of a
// project into the mirror (paged, rebuilt). Atlassian's HTTP is the loopback fake only.
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
import { parseAnswerCommand } from "../integrations/comment-command.ts";
import type { RepoRef } from "../integrations/types.ts";
import { createProjectService } from "../projects/service.ts";
import { createJiraHarness } from "../test-support/jira-harness.ts";
import { startWebhookReceiver } from "../test-support/jira-webhook-receiver.ts";
import type { ActionCall } from "../workflow-runs/connectors.ts";
import { createGithubConnectors } from "../workflow-runs/github-connectors.ts";
import { adfToText } from "./adf.ts";
import { createJiraIssueReader } from "./issue-reader.ts";
import { createJiraIssueSearch } from "./issue-search.ts";
import { createJiraMirror } from "./mirror.ts";
import { createJiraProjectReader } from "./projects.ts";
import {
  createJiraActivationHook,
  createJiraDeactivationHook,
} from "./project-hooks.ts";
import { createJiraResync } from "./resync.ts";
import { createJiraTicketProvider } from "./ticket-provider.ts";
import { createJiraTicketWriter } from "./ticket-writer.ts";
import { createJiraWebhookHandler } from "./webhook-handler.ts";
import { createJiraWebhookRegistrar } from "./webhook-registrar.ts";
import { createJiraWebhookApi } from "./webhooks-api.ts";

const SITE = {
  id: "aaaaaaaa-0000-0000-0000-000000000001",
  url: "https://acme.atlassian.net",
  name: "acme",
};

const issue = (
  number: number,
  over: Partial<FakeJiraIssue> = {},
): FakeJiraIssue => ({
  id: String(10_000 + number),
  key: `PROJ-${String(number)}`,
  summary: `Issue ${String(number)}`,
  status: { name: "Ready for agent" },
  ...over,
});

const PROJECT_STATUSES = [
  { id: "1", name: "To Do", category: "new" as const },
  { id: "2", name: "Ready for agent" },
  { id: "3", name: "In Progress" },
  { id: "4", name: "In Review" },
  { id: "5", name: "Done", category: "done" as const },
];

// #1058: the same workflow as a site whose user reads Jira in German sees it: the REST API and the transitions name the statuses in German.
const GERMAN_STATUSES = [
  {
    id: "1",
    name: "Zu erledigen",
    untranslatedName: "To Do",
    category: "new" as const,
  },
  { id: "3", name: "In Arbeit", untranslatedName: "In Progress" },
  {
    id: "5",
    name: "Erledigt",
    untranslatedName: "Done",
    category: "done" as const,
  },
];

async function world(
  options: {
    searchPageSize?: number;
    statuses?: typeof PROJECT_STATUSES | typeof GERMAN_STATUSES;
  } = {},
) {
  const h = await createJiraHarness({
    atlassian: {
      sites: [SITE],
      searchPageSize: options.searchPageSize ?? 100,
      projects: {
        [SITE.id]: [
          {
            id: "10000",
            key: "PROJ",
            name: "Project",
            issueTypes: [
              {
                id: "1",
                name: "Task",
                statuses: options.statuses ?? PROJECT_STATUSES,
              },
            ],
          },
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
  h.atlassian.setIssues(SITE.id, [issue(7)]);

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
  await repositories.reconcile(integration.id, [remote]);
  const [repository] = await repositories.list();
  if (repository === undefined) throw new Error("seeding failed");

  const projects = createProjectsRepository(h.db, workspace.id);
  const webhooks = createJiraWebhooksRepository(h.db, workspace.id, h.now);
  const tracker = createTrackerRepository(h.db, workspace.id);
  const connections = createJiraConnectionsRepository(h.db, workspace.id);
  const tokens = h.jira.tokensFor(workspace.id);
  const siteUrlOf = async (id: string) => (await connections.get(id))?.siteUrl;
  const accountIdOf = async (id: string) =>
    (await connections.get(id))?.accountId;

  const writer = createJiraTicketWriter({
    tokens,
    siteUrlOf,
    accountIdOf,
    statuses: createJiraProjectReader({ tokens }),
  });
  const provider = createJiraTicketProvider({
    readerFor: async () => createJiraIssueReader({ tokens, siteUrlOf }),
    writerFor: async () => writer,
  });
  const jiraScope = {
    integration: { ...integration, workspaceId: workspace.id },
    repo: remote,
    jira: { connectionId: connection.id, projectKey: "PROJ" },
  };
  const connectors = createGithubConnectors({
    targetOf: async () => undefined,
    ticketTargetOf: async () => ({ provider, scope: jiraScope }),
  });
  let n = 0;
  const run = (name: string, inputs: Record<string, unknown>, key?: string) => {
    const connector = connectors.find((candidate) => candidate.name === name);
    if (connector === undefined) throw new Error(`no connector ${name}`);
    n += 1;
    const call: ActionCall = {
      workspaceId: workspace.id,
      runId: "run-1",
      stepId: `step-${String(n)}`,
      repository: { id: repository.id, fullName: "acme/shop" },
      baseBranch: "main",
      inputs,
      idempotencyKey: key ?? `wf-run-1-${String(n)}`,
      stepCreatedAt: new Date(Date.now() - 60_000).toISOString(),
      signal: new AbortController().signal,
    };
    return connector.run(call);
  };

  return {
    h,
    workspace,
    owner,
    connection,
    repository,
    remote,
    integration,
    projects,
    webhooks,
    tracker,
    tokens,
    siteUrlOf,
    writer,
    provider,
    jiraScope,
    run,
    repositories,
    async receiverFor(handler: (request: Request) => Promise<Response>) {
      return startWebhookReceiver(() => handler);
    },
  };
}

describe("moving a ticket of a site whose user reads Jira in German", () => {
  // #1058-T04
  it("finds the transition by the status, whether the lane names it in German or in English", async () => {
    const w = await world({ statuses: GERMAN_STATUSES });
    w.h.atlassian.setIssues(SITE.id, [
      issue(7, { status: { name: "Zu erledigen" } }),
    ]);

    // The transitions Jira offers name their target in German; the lane says "In Arbeit".
    expect(
      await w.run("ticket.setStatus", {
        ticket: "PROJ-7",
        status: "In Arbeit",
      }),
    ).toEqual({ status: "In Arbeit" });
    expect(w.h.atlassian.statusOf(SITE.id, "PROJ-7")).toBe("In Arbeit");

    // The untranslated name finds the same status; the ticket is in it already, so nothing is moved.
    const before = w.h.atlassian
      .requests()
      .filter((r) => r.method === "POST").length;
    expect(
      await w.run("ticket.setStatus", {
        ticket: "PROJ-7",
        status: "In Progress",
      }),
    ).toEqual({ status: "In Arbeit" });
    expect(
      w.h.atlassian.requests().filter((r) => r.method === "POST").length,
    ).toBe(before);

    // And a move by the untranslated name from another status.
    expect(
      await w.run("ticket.setStatus", { ticket: "PROJ-7", status: "Done" }),
    ).toEqual({ status: "Erledigt" });
    expect(w.h.atlassian.statusOf(SITE.id, "PROJ-7")).toBe("Erledigt");
  });

  // #1058-T04
  it("names a status of the workflow that no transition leads to by its id, in either language, and a status the workflow lacks as unknown", async () => {
    const w = await world({ statuses: GERMAN_STATUSES });
    w.h.atlassian.setIssues(SITE.id, [
      issue(7, { status: { name: "Zu erledigen" } }),
    ]);
    w.h.atlassian.setTransitions(SITE.id, [
      { id: "21", name: "Start", to: "In Progress", from: ["To Do"] },
    ]);

    await expect(
      w.run("ticket.setStatus", { ticket: "PROJ-7", status: "Erledigt" }),
    ).rejects.toMatchObject({ code: "ticket_status_unreachable" });
    await expect(
      w.run("ticket.setStatus", { ticket: "PROJ-7", status: "Done" }),
    ).rejects.toMatchObject({ code: "ticket_status_unreachable" });
    await expect(
      w.run("ticket.setStatus", { ticket: "PROJ-7", status: "Blocked" }),
    ).rejects.toMatchObject({ code: "ticket_status_unknown" });
  });
});

describe("the ticket actions of a lane on a Jira ticket", () => {
  // #1040-T01
  it("comments, moves and labels through a fake Jira, in the order of the lane, with the key of the ticket", async () => {
    const w = await world();
    const { atlassian } = w.h;
    atlassian.setIssues(SITE.id, [issue(7)]);

    // The order of "Issue to PR (status)": in progress, a label, a comment, in review.
    expect(
      await w.run("ticket.setStatus", {
        ticket: "PROJ-7",
        status: "In Progress",
      }),
    ).toEqual({ status: "In Progress" });
    expect(
      await w.run("ticket.labels", {
        ticket: "PROJ-7",
        add: ["agent working"],
      }),
    ).toEqual({ labels: ["agent-working"] });
    const commented = await w.run("ticket.comment", {
      ticket: "PROJ-7",
      body: "**Done.** See [the PR](https://github.test/acme/shop/pull/3).",
    });
    expect(commented).toMatchObject({ existing: false });
    expect(String(commented.url)).toMatch(
      /^https:\/\/acme\.atlassian\.net\/browse\/PROJ-7\?focusedCommentId=\d+$/,
    );
    expect(
      await w.run("ticket.setStatus", {
        ticket: "PROJ-7",
        status: "In Review",
      }),
    ).toEqual({ status: "In Review" });

    expect(atlassian.statusOf(SITE.id, "PROJ-7")).toBe("In Review");
    expect(atlassian.labelsOf(SITE.id, "PROJ-7")).toEqual(["agent-working"]);
    // The comment is ADF, written as the connected account, and carries no marker text.
    const [comment] = atlassian.comments(SITE.id, "PROJ-7");
    expect(comment?.author.accountId).toBe("712020:fake-account");
    const body = JSON.stringify(comment?.body);
    expect(body).toContain('"type":"doc"');
    expect(body).toContain("Done.");
    expect(body).not.toContain("<!--");
    // The writes reached Jira in the order of the lane.
    const writes = atlassian
      .requests()
      .filter((r) => r.method !== "GET" && r.path.includes("/issue/PROJ-7"))
      .map((r) => `${r.method} ${r.path.replace(/^.*\/issue\/PROJ-7/, "")}`);
    expect(writes).toEqual([
      "POST /transitions",
      "PUT ",
      "POST /comment",
      "POST /transitions",
    ]);
  });

  // #1040-T01
  it("takes the key of the ticket object a lane hands in, and refuses a key of another Jira project", async () => {
    const w = await world();
    w.h.atlassian.setIssues(SITE.id, [issue(7)]);

    await expect(
      w.run("ticket.comment", { ticket: "OTHER-1", body: "hello" }),
    ).rejects.toMatchObject({ code: "ticket_not_found" });
    expect(
      await w.run("ticket.comment", { ticket: "PROJ-7", body: "hello" }),
    ).toMatchObject({ existing: false });
  });

  // #1040-T01
  it("does not comment twice for a step that is made again, and finds the comment by its marker even after other comments", async () => {
    const w = await world();
    const { atlassian } = w.h;
    const first = await w.run(
      "ticket.comment",
      { ticket: "PROJ-7", body: "Stopped." },
      "wf-run-1-start",
    );
    atlassian.addComment(SITE.id, "PROJ-7", { body: "a person writes" });

    const again = await w.run(
      "ticket.comment",
      { ticket: "PROJ-7", body: "Stopped." },
      "wf-run-1-start",
    );

    expect(again).toMatchObject({ existing: true, url: first.url });
    expect(atlassian.comments(SITE.id, "PROJ-7")).toHaveLength(2);
    // Another step is another comment.
    await w.run(
      "ticket.comment",
      { ticket: "PROJ-7", body: "Next." },
      "wf-run-1-next",
    );
    expect(atlassian.comments(SITE.id, "PROJ-7")).toHaveLength(3);
  });

  // #1040-T01
  it("does not take a comment of a person that holds the marker text for the factory's own", async () => {
    const w = await world();
    const { atlassian } = w.h;
    atlassian.addComment(SITE.id, "PROJ-7", {
      body: "<!-- wf-run-1-start -->",
      author: { accountId: "someone-else", displayName: "Eve" },
    });

    const result = await w.run(
      "ticket.comment",
      { ticket: "PROJ-7", body: "Stopped." },
      "wf-run-1-start",
    );

    expect(result).toMatchObject({ existing: false });
  });

  // #1040-T01
  it("edits the factory's own comment in place (the question that was answered) and replaces its marker", async () => {
    const w = await world();
    const { atlassian } = w.h;
    const posted = await w.provider.commentOnTicket?.(
      w.jiraScope,
      "PROJ-7",
      "<!-- factory ask run=r1 step=implement q=1 -->\nThe agent has a question",
      { marker: "<!-- factory ask run=r1 step=implement q=1 -->" },
    );
    expect(posted?.id).toBeDefined();

    await w.provider.updateTicketComment?.(
      w.jiraScope,
      "PROJ-7",
      posted?.id ?? "",
      "<!-- factory answered run=r1 step=implement q=1 -->\nThe agent had a question",
    );

    const [comment] = atlassian.comments(SITE.id, "PROJ-7");
    expect(JSON.stringify(comment?.body)).toContain("The agent had a question");
    expect(comment?.properties).toEqual([
      {
        key: "factory.markers",
        value: {
          markers: ["<!-- factory answered run=r1 step=implement q=1 -->"],
        },
      },
    ]);
    expect(atlassian.comments(SITE.id, "PROJ-7")).toHaveLength(1);
    // A comment that is not there is a stable failure.
    await expect(
      w.provider.updateTicketComment?.(w.jiraScope, "PROJ-7", "999999", "x"),
    ).rejects.toMatchObject({ code: "ticket_not_found" });
  });

  // #1040-T01
  it("writes hostile Markdown that Jira's schema accepts (no heading, rule or quote in a quote), and a comment that begins with /answer is no answer", async () => {
    const w = await world();
    const { atlassian } = w.h;
    atlassian.setIssues(SITE.id, [issue(7)]);

    await w.run("ticket.comment", {
      ticket: "PROJ-7",
      body: `> # Heading\n> ---\n> > deep\n${">".repeat(5000)}x`,
    });
    await w.run("ticket.comment", { ticket: "PROJ-7", body: "/answer 1" });

    const [quoted, command] = atlassian.comments(SITE.id, "PROJ-7");
    expect(adfToText(quoted?.body)).toContain("Heading");
    expect(parseAnswerCommand(adfToText(command?.body))).toBeNull();
    expect(adfToText(command?.body)).toContain("answer 1");
  });

  // #1040-T01
  it("removes and adds labels (a label with a space is written with a hyphen) and answers every label of the ticket", async () => {
    const w = await world();
    w.h.atlassian.setIssues(SITE.id, [
      issue(7, { labels: ["agent-working", "backend"] }),
    ]);

    const result = await w.run("ticket.labels", {
      ticket: "PROJ-7",
      add: ["agent waiting"],
      remove: ["agent working"],
    });

    expect(result).toEqual({ labels: ["backend", "agent-waiting"] });
  });

  // #1040-T01
  it("leaves a ticket that is in the status where it is, without a transition", async () => {
    const w = await world();
    const before = w.h.atlassian.requests().length;

    expect(
      await w.run("ticket.setStatus", {
        ticket: "PROJ-7",
        status: "ready for AGENT",
      }),
    ).toEqual({ status: "Ready for agent" });

    const posts = w.h.atlassian
      .requests()
      .slice(before)
      .filter((r) => r.method === "POST");
    expect(posts).toEqual([]);
  });

  // #1040-T01
  it("ends a move to a status no transition leads to with a stable code that names the ones that are reachable, a status the workflow lacks with another, and a missing ticket with a third", async () => {
    const w = await world();
    w.h.atlassian.setTransitions(SITE.id, [
      { id: "21", name: "Start", to: "In Progress", from: ["Ready for agent"] },
      { id: "22", name: "Finish", to: "Done", from: ["In Progress"] },
    ]);

    await expect(
      w.run("ticket.setStatus", { ticket: "PROJ-7", status: "In Review" }),
    ).rejects.toMatchObject({
      code: "ticket_status_unreachable",
      message: expect.stringContaining("In Progress"),
    });
    await expect(
      w.run("ticket.setStatus", { ticket: "PROJ-7", status: "Blocked" }),
    ).rejects.toMatchObject({
      code: "ticket_status_unknown",
      message: expect.stringContaining("In Review"),
    });
    await expect(
      w.run("ticket.setStatus", { ticket: "PROJ-99", status: "Done" }),
    ).rejects.toMatchObject({ code: "ticket_not_found" });
    expect(w.h.atlassian.statusOf(SITE.id, "PROJ-7")).toBe("Ready for agent");
  });

  // #1040-T01
  it("ends a transition that needs a field the factory cannot fill with ticket_rejected", async () => {
    const w = await world();
    w.h.atlassian.setTransitions(SITE.id, [
      { id: "31", name: "Resolve", to: "Done", requiresFields: true },
    ]);

    await expect(
      w.run("ticket.setStatus", { ticket: "PROJ-7", status: "Done" }),
    ).rejects.toMatchObject({ code: "ticket_rejected" });
  });

  // #1040-T01
  it("fails with codes for a broken connection and a site that does not answer, never with what Jira said", async () => {
    const w = await world();
    w.h.atlassian.failNext(
      `/ex/jira/${SITE.id}/rest/api/3/issue/PROJ-7/comment`,
      {
        status: 500,
        body: { errorMessages: ["secret detail about Eve"] },
      },
    );

    const failure = await w
      .run("ticket.comment", { ticket: "PROJ-7", body: "x" })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "ticket_unavailable" });
    expect(String((failure as Error).message)).not.toContain("secret detail");
    expect(String((failure as Error).message)).toContain("may have happened");

    w.h.atlassian.revokeGrants();
    w.h.atlassian.expireAccessTokens();
    await expect(
      w.run("ticket.labels", { ticket: "PROJ-7", add: ["x"] }),
    ).rejects.toMatchObject({ code: "ticket_connection_broken" });
  });
});

describe("the full read of a project into the mirror", () => {
  // #1040-T04
  it("rebuilds the mirror of a Jira source from the pages of the JQL search, and cleans an issue that moved out of the project", async () => {
    const w = await world({ searchPageSize: 2 });
    const { atlassian } = w.h;
    atlassian.setIssues(
      SITE.id,
      [1, 2, 3, 4, 5].map((n) =>
        issue(n, {
          status: {
            name: n === 4 ? "Done" : "To Do",
            category: n === 4 ? "done" : "new",
          },
        }),
      ),
    );
    const resync = createJiraResync({
      tracker: w.tracker,
      search: createJiraIssueSearch({
        tokens: w.tokens,
        siteUrlOf: w.siteUrlOf,
      }),
      mirror: createJiraMirror({ tracker: w.tracker }),
    });
    const target = {
      repositoryId: w.repository.id,
      repoFullName: "acme/shop",
      connectionId: w.connection.id,
      projectKey: "PROJ",
    };

    const first = await resync.run(target);

    expect(first).toMatchObject({ status: "done", written: 5, removed: 0 });
    const rows = await w.tracker.listItems(w.repository.id, { limit: 50 });
    expect(rows.map((row) => row.key).sort()).toEqual([
      "PROJ-1",
      "PROJ-2",
      "PROJ-3",
      "PROJ-4",
      "PROJ-5",
    ]);
    expect(rows.find((row) => row.key === "PROJ-4")).toMatchObject({
      state: "closed",
      boardStatus: "Done",
      provider: "jira",
      repo: "acme/shop",
    });
    // Three pages of two, as the fake pages them.
    const searches = atlassian
      .requests()
      .filter((r) => r.path.endsWith("/search/jql"));
    expect(searches).toHaveLength(3);
    const state = await w.tracker.getSyncState(w.repository.id, "jira");
    expect(state).toMatchObject({ cursor: null });
    expect(state?.lastFullSyncAt).not.toBeNull();
    // GitHub's own sync state is not touched.
    expect(await w.tracker.getSyncState(w.repository.id)).toBeUndefined();

    // PROJ-3 is moved to another project and PROJ-6 is new: the next read cleans the first and brings the second.
    // The rows carry the database's own clock, so the second read starts after the first one wrote.
    await new Promise((resolve) => setTimeout(resolve, 20));
    atlassian.setIssues(
      SITE.id,
      [1, 2, 4, 5, 6].map((n) => issue(n)),
    );
    const second = await resync.run(target);

    expect(second).toMatchObject({ status: "done", removed: 1 });
    expect(
      (await w.tracker.listItems(w.repository.id, { limit: 50 }))
        .map((row) => row.key)
        .sort(),
    ).toEqual(["PROJ-1", "PROJ-2", "PROJ-4", "PROJ-5", "PROJ-6"]);
  });
});

describe("an answer in a Jira comment", () => {
  async function withWebhook() {
    const w = await world();
    const answers: unknown[] = [];
    const taken = { value: "answered" as "answered" | "not_taken" };
    let handler: (request: Request) => Promise<Response> = async () =>
      new Response("not ready", { status: 503 });
    const receiver = await w.receiverFor((request) => handler(request));
    const registrar = createJiraWebhookRegistrar({
      webhooks: w.webhooks,
      projects: w.projects,
      api: createJiraWebhookApi({ tokens: w.tokens }),
      publicUrl: receiver.url,
      now: w.h.now,
      log: w.h.logs.push.bind(w.h.logs),
    });
    handler = createJiraWebhookHandler({
      directory: createJiraWebhookDirectory(w.h.db),
      deliveries: createWebhookDeliveriesRepository(w.h.db),
      clientSecret: () => w.h.atlassian.clientSecret,
      workspace: () => ({
        registrations: w.webhooks,
        projects: w.projects,
        repositoryName: async (id) => (await w.repositories.get(id))?.fullName,
        mirror: createJiraMirror({ tracker: w.tracker }),
        answers: {
          async answer(_delivery, answer) {
            answers.push(answer);
            return taken.value === "answered"
              ? { outcome: "answered", runId: "run-1" }
              : { outcome: "not_taken", reason: "stale" };
          },
        },
      }),
      logger: {
        info: (line) => w.h.logs.push(line),
        warn: (line) => w.h.logs.push(line),
        error: (line) => w.h.logs.push(line),
      },
      now: () => new Date(),
    });
    const service = createProjectService({
      projects: w.projects,
      hooks: {
        async onProjectDeactivated() {},
        onProjectActivated: createJiraActivationHook({
          tracker: w.tracker,
          projects: w.projects,
          webhooks: w.webhooks,
          registrar,
          log: w.h.logs.push.bind(w.h.logs),
        }),
        afterProjectDeactivated: createJiraDeactivationHook({ registrar }),
      },
    });
    await service.createProject(w.repository.id, null, {
      connectionId: w.connection.id,
      projectKey: "PROJ",
    });
    const [hook] = w.h.atlassian.webhooks();
    if (hook === undefined) throw new Error("no webhook registered");
    return { w, answers, taken, hook };
  }

  const comment = (body: string, over: Record<string, unknown> = {}) => ({
    webhookEvent: "comment_created" as const,
    issueKey: "PROJ-7",
    comment: { id: "20001", body, adf: true },
    ...over,
  });

  // #1040-T03
  it("hands a comment that begins with /answer to the answer taker with the repository, the key, the option and the commenter", async () => {
    const { w, answers, hook } = await withWebhook();

    const result = await w.h.atlassian.deliver(
      hook.id,
      comment("/answer 2 and log it", { identifier: "d-1" }),
    );

    expect(result).toMatchObject({
      status: 200,
      body: { outcome: "ticket_answered" },
    });
    expect(answers).toEqual([
      {
        repositoryId: w.repository.id,
        issueKey: "PROJ-7",
        comment: expect.objectContaining({
          id: "20001",
          author: expect.objectContaining({ accountId: "712020:a-person" }),
        }),
        choice: 2,
        text: "and log it",
        raw: "2 and log it",
      },
    ]);
  });

  // #1040-T03
  it("takes a comment of a webhook that sends the text as it is, as well as ADF", async () => {
    const { w, answers, hook } = await withWebhook();

    await w.h.atlassian.deliver(
      hook.id,
      comment("/answer Use Redis", {
        identifier: "d-2",
        comment: { id: "20002", body: "/answer Use Redis" },
      }),
    );

    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ raw: "Use Redis" });
  });

  // #1040-T03
  it("ignores a comment that does not begin with /answer (the factory's own question says how to answer, and the record of an answer begins otherwise) and a comment of an app", async () => {
    const { w, answers, hook } = await withWebhook();

    for (const [index, body] of [
      "The agent has a question. Reply with `/answer <n>`",
      "Answer by @Ada: 2",
      "thanks, /answer 1 later",
    ].entries())
      await w.h.atlassian.deliver(
        hook.id,
        comment(body, { identifier: `d-3-${String(index)}` }),
      );
    await w.h.atlassian.deliver(
      hook.id,
      comment("/answer 1", {
        identifier: "d-3-app",
        comment: {
          id: "20003",
          body: "/answer 1",
          author: {
            accountId: "app-1",
            displayName: "A bot",
            accountType: "app",
          },
        },
      }),
    );

    expect(answers).toEqual([]);
  });

  // #1040-T03
  it("answers 200 and not final for an answer that was not taken, so that a redelivery looks at it again", async () => {
    const { w, answers, taken, hook } = await withWebhook();
    taken.value = "not_taken";

    const first = await w.h.atlassian.deliver(
      hook.id,
      comment("/answer 1", { identifier: "d-4" }),
    );
    taken.value = "answered";
    const second = await w.h.atlassian.deliver(
      hook.id,
      comment("/answer 1", { identifier: "d-4" }),
    );

    expect(first.body).toMatchObject({ outcome: "no_answer_taken" });
    expect(second.body).toMatchObject({ outcome: "ticket_answered" });
    expect(answers).toHaveLength(2);
  });
});
