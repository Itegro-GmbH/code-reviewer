// SPDX-License-Identifier: LicenseRef-Proprietary

// What switching a project on does to the ticket mirror's rows (#1039): the rows of the source it left must go, or a Jira row of another
// project (`OLD-7`) takes the primary key `(repository, number)` that the first row of the new one (`NEW-7`) needs.
import { describe, expect, it } from "vitest";
import type { StoredJiraWebhook } from "../db/repositories/jira-webhooks-repository.ts";
import type { StoredProject } from "../db/repositories/projects-repository.ts";
import { createFakeTrackerRepository } from "../tracker/fake-tracker-repository.ts";
import { createJiraActivationHook } from "./project-hooks.ts";
import { createJiraMirror } from "./mirror.ts";
import type { JiraIssue } from "./issue.ts";

const TARGET = { repositoryId: "repo-1", repoFullName: "acme/widgets" };

const issue = (key: string, over: Partial<JiraIssue> = {}): JiraIssue => ({
  id: key.replace(/\D/g, ""),
  key,
  projectKey: key.slice(0, key.lastIndexOf("-")),
  number: Number(key.slice(key.lastIndexOf("-") + 1)),
  title: `Issue ${key}`,
  body: "",
  status: "To Do",
  statusCategory: "new",
  type: "Task",
  assignees: [],
  labels: [],
  url: "",
  updatedAt: "2026-11-14T10:00:00.000Z",
  ...over,
});

const project = (connectionId: string, projectKey: string): StoredProject =>
  ({
    id: "p1",
    repositoryId: "repo-1",
    active: true,
    ticketSource: {
      provider: "jira",
      repositoryId: "repo-1",
      board: null,
      connectionId,
      projectKey,
    },
  }) as unknown as StoredProject;

function setup(options: {
  project: StoredProject;
  webhook?: Partial<StoredJiraWebhook>;
}) {
  const tracker = createFakeTrackerRepository();
  const reconciled: string[] = [];
  const hook = createJiraActivationHook({
    tracker,
    projects: { getById: async () => options.project },
    webhooks: {
      getByProject: async () =>
        options.webhook === undefined
          ? undefined
          : ({
              connectionId: "c1",
              projectKey: "OLD",
              ...options.webhook,
            } as StoredJiraWebhook),
    },
    registrar: {
      reconcile: async (id) => {
        reconciled.push(id);
        return { outcome: "registered" };
      },
    },
    log: () => undefined,
  });
  const mirror = createJiraMirror({ tracker });
  const write = (key: string) =>
    mirror.apply(TARGET, {
      kind: "issue_changed",
      event: "updated",
      issue: issue(key),
      matchedWebhookIds: [],
    });
  const activated = () =>
    hook({
      projectId: "p1",
      repositoryId: "repo-1",
      ticketProvider: "jira",
    });
  return { tracker, hook, write, activated, reconciled };
}

describe("switching a project to a Jira source", () => {
  // #1039
  it("clears the rows of another Jira project, so that NEW-7 does not meet OLD-7 on the number 7", async () => {
    const t = setup({
      project: project("c1", "NEW"),
      webhook: { connectionId: "c1", projectKey: "OLD" },
    });
    await t.write("OLD-7");
    await t.write("OLD-8");
    await t.activated();
    expect(await t.tracker.getItem("repo-1", 7)).toBeUndefined();
    expect(await t.write("NEW-7")).toBe("updated");
    expect(await t.tracker.getItem("repo-1", 7)).toMatchObject({
      key: "NEW-7",
    });
    expect(await t.tracker.getItem("repo-1", 8)).toBeUndefined();
    expect(t.reconciled).toEqual(["p1"]);
  });

  // #1039
  it("keeps the rows of the same Jira project and connection", async () => {
    const t = setup({
      project: project("c1", "PROJ"),
      webhook: { connectionId: "c1", projectKey: "PROJ" },
    });
    await t.write("PROJ-7");
    await t.activated();
    expect(await t.tracker.getItem("repo-1", 7)).toMatchObject({
      key: "PROJ-7",
    });
  });

  // #1039
  it("clears every Jira row when the connection changed, whatever the project key", async () => {
    const t = setup({
      project: project("c2", "PROJ"),
      webhook: { connectionId: "c1", projectKey: "PROJ" },
    });
    await t.write("PROJ-7");
    await t.activated();
    expect(await t.tracker.getItem("repo-1", 7)).toBeUndefined();
  });

  // #1039
  it("does not take a project key for the start of another (PRO does not keep PROJ-7)", async () => {
    const t = setup({ project: project("c1", "PRO") });
    await t.write("PROJ-7");
    await t.activated();
    expect(await t.tracker.getItem("repo-1", 7)).toBeUndefined();
  });
});

describe("rows of two providers on one number", () => {
  // #1039
  it("is looked at, deleted and re-parented by provider, so a Jira delivery never touches a GitHub row of the same number", async () => {
    const t = setup({ project: project("c1", "PROJ") });
    await t.tracker.upsertItem("repo-1", {
      provider: "github",
      repo: "acme/widgets",
      key: "7",
      number: 7,
      nodeId: "I_7",
      kind: "issue",
      state: "open",
      stateReason: null,
      type: null,
      title: "A GitHub issue",
      bodyExcerpt: "",
      labels: [],
      assignees: [],
      closes: [],
      updatedAt: "2026-11-14T10:00:00.000Z",
    });
    expect(await t.tracker.getItem("repo-1", 7, "jira")).toBeUndefined();
    expect(
      await t.tracker.deleteItem(
        "repo-1",
        7,
        "2026-11-14T11:00:00.000Z",
        "jira",
      ),
    ).toBe(false);
    expect(
      await t.tracker.setParent(
        "repo-1",
        7,
        1,
        "2026-11-14T11:00:00.000Z",
        "jira",
      ),
    ).toBe(false);
    expect(await t.tracker.getItem("repo-1", 7, "github")).toMatchObject({
      title: "A GitHub issue",
    });
  });
});
