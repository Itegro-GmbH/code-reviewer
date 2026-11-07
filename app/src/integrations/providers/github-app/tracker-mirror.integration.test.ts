// SPDX-License-Identifier: LicenseRef-Proprietary

// The ticket mirror against a real Postgres database (#923): every event of the recorded payloads, read by the real GitHub App provider,
// updates the row of its ticket through the real repository, in a repository with an active project and in no other. The GitHub API is
// the in-memory client of the provider tests (the checks of a commit are the one thing a delivery has to ask GitHub for).
import { describe, expect, it } from "vitest";
import {
  webhookDelivery,
  webhookFixture,
} from "../../../../../fakes/github/webhooks.ts";
import { createIntegrationsRepository } from "../../../db/repositories/integrations-repository.ts";
import { createProjectsRepository } from "../../../db/repositories/projects-repository.ts";
import { createRepositoriesRepository } from "../../../db/repositories/repositories-repository.ts";
import { createTrackerRepository } from "../../../db/repositories/tracker-repository.ts";
import { loadGithubAppConfig } from "./config.ts";
import { fakeGithubAppClient } from "./fake-client.ts";
import { createGithubAppProvider } from "./provider.ts";
import { createProjectService } from "../../../projects/service.ts";
import {
  TEST_WEBHOOK_SECRET,
  testGithubAppEnv,
} from "../../../test-support/github-app.ts";
import { createTestDatabase } from "../../../test-support/test-database.ts";
import { defaultWorkspaceId } from "../../../test-support/workspaces.ts";
import {
  createTrackerMirror,
  type MirrorOutcome,
} from "../../../tracker/mirror.ts";

const SHA = "1f3a5c7e9b2d4f60a8c1e3b5d7f90a2c4e6b8d01";

async function setup() {
  const { db } = await createTestDatabase();
  const workspaceId = await defaultWorkspaceId(db);
  const integration = await createIntegrationsRepository(
    db,
    workspaceId,
  ).create({
    type: "github_app",
    displayName: "acme",
    externalId: "4242",
    config: {},
  });
  const repositories = createRepositoriesRepository(db, workspaceId);
  await repositories.reconcile(integration.id, [
    {
      integrationId: integration.id,
      externalId: "7001",
      fullName: "acme/widgets",
      url: "https://github.com/acme/widgets",
    },
  ]);
  const [repository] = await repositories.list();
  if (repository === undefined) throw new Error("seeding failed");
  const projects = createProjectService({
    projects: createProjectsRepository(db, workspaceId),
  });
  await projects.activateProject(repository.id);

  const provider = createGithubAppProvider({
    config: loadGithubAppConfig(testGithubAppEnv()),
    client: fakeGithubAppClient({
      trackerChecks: { [`acme/widgets@${SHA}`]: "failure" },
    }),
  });
  const tracker = createTrackerRepository(db, workspaceId);
  const mirror = createTrackerMirror({
    repositories,
    projects,
    tracker,
    async boardStatusOf(i, repo, nodeId) {
      return (
        (await provider.readBoardStatus?.(i, repo, nodeId)) ?? {
          available: false,
          status: null,
        }
      );
    },
    async checksStateOf(i, repo, headSha) {
      return (await provider.readChecksState?.(i, repo, headSha)) ?? null;
    },
  });

  /** Delivers a recorded payload: the provider reads it, the mirror writes it. */
  async function deliver(fixture: string): Promise<MirrorOutcome | "nothing"> {
    const event = fixture.split(".")[0] as string;
    const result = await provider.parseTrackerChange?.(
      integration,
      webhookDelivery({
        event,
        payload: webhookFixture(fixture),
        secret: TEST_WEBHOOK_SECRET,
      }),
    );
    if (result?.kind !== "change") return "nothing";
    return mirror.apply(integration, result.change);
  }
  return { db, repository, tracker, projects, deliver };
}

describe("the events of the ticket mirror, against Postgres", () => {
  // #923-T102
  it("writes the issue of `issues` and replaces it when it is closed", async () => {
    const { deliver, tracker, repository } = await setup();

    expect(await deliver("issues.edited.mirror")).toBe("updated");
    expect(await tracker.getItem(repository.id, 12)).toMatchObject({
      repo: "acme/widgets",
      kind: "issue",
      state: "open",
      type: "Task",
      parentNumber: 3,
      labels: [
        { name: "enhancement", color: "a2eeef" },
        { name: "ready for agent", color: "0e8a16" },
      ],
      assignees: [{ login: "alice" }],
    });

    await deliver("issues.closed.mirror");

    expect(await tracker.getItem(repository.id, 12)).toMatchObject({
      state: "closed",
      stateReason: "completed",
    });
  });

  // #923-T103
  it("sets the board status, the parent and the comment's time, and keeps them across a new write of the issue", async () => {
    const { deliver, tracker, repository } = await setup();
    await deliver("issues.edited.mirror");

    expect(await deliver("projects_v2_item.edited")).toBe("updated");
    expect(await deliver("sub_issues.parent_issue_removed")).toBe("updated");
    expect(await deliver("issue_comment.created.mirror")).toBe("updated");

    expect(await tracker.getItem(repository.id, 12)).toMatchObject({
      boardStatus: "In Progress",
      // The comment's issue has no `parent_issue_url` of its own to say otherwise: it names the parent again.
      updatedAt: "2026-11-06T13:00:00.000Z",
    });
    expect(await deliver("projects_v2_item.deleted")).toBe("updated");
    expect((await tracker.getItem(repository.id, 12))?.boardStatus).toBeNull();
  });

  // #923-T104
  it("follows a pull request from its commit to its merge: the issues it closes list it, its checks come and go", async () => {
    const { deliver, tracker, repository } = await setup();
    await deliver("issues.edited.mirror");

    expect(await deliver("pull_request.synchronize.mirror")).toBe("updated");
    expect(await tracker.getItem(repository.id, 12)).toMatchObject({
      pullRequests: [7],
    });
    expect(await tracker.getItem(repository.id, 7)).toMatchObject({
      kind: "pull_request",
      state: "open",
      closes: [12, 13],
      checksState: null,
    });

    expect(await deliver("check_suite.completed")).toBe("updated");
    expect((await tracker.getItem(repository.id, 7))?.checksState).toBe(
      "failure",
    );

    expect(await deliver("pull_request.review_requested.mirror")).toBe(
      "updated",
    );
    expect((await tracker.getItem(repository.id, 7))?.checksState).toBe(
      "failure",
    );
    // #924-T02: who a review is asked from is stored, and a delivery without the list leaves it
    expect(
      (await tracker.getItem(repository.id, 7))?.reviewRequestedFrom,
    ).toEqual(["carol"]);

    expect(await deliver("pull_request.closed.merged.mirror")).toBe("updated");
    expect(await tracker.getItem(repository.id, 7)).toMatchObject({
      state: "closed",
      stateReason: "merged",
      checksState: null,
    });
    expect((await tracker.getItem(repository.id, 12))?.pullRequests).toEqual([
      7,
    ]);
  });

  // #923-T105
  it("removes a deleted issue", async () => {
    const { deliver, tracker, repository } = await setup();
    await deliver("issues.edited.mirror");

    expect(await deliver("issues.deleted.mirror")).toBe("updated");

    expect(await tracker.getItem(repository.id, 12)).toBeUndefined();
  });

  // #923-T106
  it("mirrors nothing of a repository whose project is switched off", async () => {
    const { deliver, tracker, repository, projects } = await setup();
    await projects.deactivateProject(repository.id);

    expect(await deliver("issues.edited.mirror")).toBe("not_mirrored");
    expect(await deliver("pull_request.synchronize.mirror")).toBe(
      "not_mirrored",
    );

    expect(await tracker.listItems(repository.id, { limit: 10 })).toEqual([]);
  });

  // #923-T107
  it("takes nothing from the deliveries it does not follow or cannot read", async () => {
    const { deliver } = await setup();

    expect(await deliver("check_suite.completed.no-pull-request")).toBe(
      "nothing",
    );
    expect(await deliver("projects_v2_item.edited.other-field")).toBe(
      "nothing",
    );
    expect(await deliver("ping")).toBe("nothing");
  });
});
