// SPDX-License-Identifier: LicenseRef-Proprietary

// #1177 (epic #1175) against a real Postgres: a branch is "made by the lane" when a session of a run of the same workflow has it as the named
// branch of a `pushBranch` entry that started on a branch that did not exist, in the repository of that entry (any entry of the list). Another
// workflow, another repository, another branch, a session of one repository, an entry of a plain `repos` step (also one that works directly on
// its base), an entry that continued a branch it found, a session whose first turn ended `branch_exists` and a list that cannot be read do not count.
import { describe, expect, it } from "vitest";
import { sha } from "../../test-support/jobs.ts";
import { createRunsFixture } from "../../test-support/runs.ts";
import { addUser } from "../../test-support/workspace-deletion-fixture.ts";
import type { SessionRepo } from "../session-repos.ts";
import { createWorkflowRunsRepository } from "./workflow-runs-repository.ts";
import { createWorkflowsRepository } from "./workflows-repository.ts";

async function start() {
  const f = await createRunsFixture();
  await addUser(f.db, "user-1");
  const workflows = createWorkflowsRepository(f.db, f.workspaceId);
  const runs = createWorkflowRunsRepository(f.db, f.workspaceId);
  let n = 0;
  async function workflow(name: string) {
    const created = await workflows.create(
      { name, document: "{}", createdBy: "user-1" },
      100,
    );
    if (!created.ok) throw new Error("seeding failed");
    return created.workflow.id;
  }
  /** A run of the workflow with one agent step whose session works on `branch` (or on none of its own: a session of one repository). */
  async function session(
    workflowId: string,
    branch: string | undefined,
    kind: "created" | "continued" | "plain" = "created",
    entryBase = "main",
  ) {
    n += 1;
    const made = await runs.createRun({
      workflowId,
      workflowVersion: 1,
      repositoryId: f.repositoryId,
      baseBranch: "main",
      triggerInput: "{}",
      budgetMicroUsd: 20_000_000,
      clientRequestId: `run-${String(n)}`,
      createdBy: "user-1",
      actorLogin: "octocat",
    });
    const repos: SessionRepo[] | undefined =
      branch === undefined
        ? undefined
        : [
            {
              repositoryId: f.repositoryId,
              fullName: "acme/gadgets",
              name: "gadgets",
              base: entryBase,
              branch,
              ...(kind === "plain"
                ? {}
                : {
                    pushOnly: true as const,
                    expectExisting: kind === "continued",
                  }),
            },
          ];
    f.clock.advance(1000);
    const enqueued = await f.queue.enqueueImplementerTurn({
      repositoryId: f.repositoryId,
      baseBranch: "main",
      baseSha: sha("a"),
      branch: `workflow/${made.run.id}/work`,
      ...(repos === undefined ? {} : { repos }),
      instruction: "Do it.",
      modelChoice: { entryId: "entry-1" },
      costLimitCents: null,
      createdBy: "user-1",
      actorLogin: "octocat",
      clientRequestId: `wf-${made.run.id}-0`,
    });
    if (enqueued.status !== "created") throw new Error("not created");
    const step = await runs.lockRun(made.run.id, (lock) =>
      lock.addStep({
        position: 0,
        stepId: "work",
        kind: "agent",
        round: 1,
        profile: null,
        capMicroUsd: null,
      }),
    );
    if (step === undefined) throw new Error("seeding failed");
    await runs.claimStep(step.id);
    await runs.attachTurn(step.id, {
      jobId: enqueued.job.id,
      turnId: enqueued.turn.id,
    });
    return enqueued;
  }
  return { f, runs, workflow, session };
}

describe("the branches a lane worked on", () => {
  // #1177-T50
  it("knows a branch a session of a run of the workflow worked on, in the repository", async () => {
    const { f, runs, workflow, session } = await start();
    const lane = await workflow("Handoff");
    await session(lane, "agent/handoff");

    expect(
      await runs.laneWorkedOnBranch(lane, f.repositoryId, "agent/handoff"),
    ).toBe(true);
  });

  // #1177-T51
  it("does not know another branch, another repository, another workflow or a session of one repository", async () => {
    const { f, runs, workflow, session } = await start();
    const lane = await workflow("Handoff");
    const other = await workflow("Other lane");
    await session(lane, "agent/handoff");
    await session(other, "agent/theirs");
    await session(lane, undefined);

    expect(
      await runs.laneWorkedOnBranch(lane, f.repositoryId, "agent/other"),
    ).toBe(false);
    expect(
      await runs.laneWorkedOnBranch(
        lane,
        "no-such-repository",
        "agent/handoff",
      ),
    ).toBe(false);
    expect(
      await runs.laneWorkedOnBranch(lane, f.repositoryId, "agent/theirs"),
    ).toBe(false);
    expect(
      await runs.laneWorkedOnBranch(other, f.repositoryId, "agent/handoff"),
    ).toBe(false);
    expect(await runs.laneWorkedOnBranch(lane, f.repositoryId, "main")).toBe(
      false,
    );
  });

  // #1177-T52
  it("skips a stored list that cannot be read instead of failing", async () => {
    const { f, runs, workflow, session } = await start();
    const lane = await workflow("Handoff");
    const broken = await session(lane, "agent/broken");
    await session(lane, "agent/handoff");
    await f.db
      .updateTable("implementer_sessions")
      .set({ repos: "{not json" })
      .where("id", "=", broken.session.id)
      .execute();

    expect(
      await runs.laneWorkedOnBranch(lane, f.repositoryId, "agent/handoff"),
    ).toBe(true);
    expect(
      await runs.laneWorkedOnBranch(lane, f.repositoryId, "agent/broken"),
    ).toBe(false);
  });

  // #1177-T53
  it("does not count a plain repos entry, direct work on a base, a continued branch or a session that ended branch_exists", async () => {
    const { f, runs, workflow, session } = await start();
    const lane = await workflow("Handoff");
    await session(lane, "agent/plain", "plain");
    await session(lane, "release", "created", "release");
    await session(lane, "agent/continued", "continued");
    const raced = await session(lane, "agent/raced");
    await f.db
      .updateTable("jobs")
      .set({ status: "failed", error_code: "branch_exists" })
      .where("id", "=", raced.job.id)
      .execute();

    for (const branch of [
      "agent/plain",
      "release",
      "agent/continued",
      "agent/raced",
    ])
      expect(
        await runs.laneWorkedOnBranch(lane, f.repositoryId, branch),
        branch,
      ).toBe(false);
  });

  // #1177-T54
  it("finds the repository inside the entry, not only the first one of the session, and any number of sessions", async () => {
    const { f, runs, workflow, session } = await start();
    const lane = await workflow("Handoff");
    const made = await session(lane, "agent/second");
    await f.db
      .updateTable("implementer_sessions")
      .set({
        repos: JSON.stringify([
          {
            repositoryId: "other-repository",
            fullName: "acme/other",
            name: "other",
            base: "main",
            branch: "agent/first",
          },
          {
            repositoryId: f.repositoryId,
            fullName: "acme/gadgets",
            name: "gadgets",
            base: "main",
            branch: "agent/second",
            pushOnly: true,
            expectExisting: false,
          },
        ]),
      })
      .where("id", "=", made.session.id)
      .execute();
    for (let i = 0; i < 3; i += 1)
      await session(lane, `agent/later-${String(i)}`);

    expect(
      await runs.laneWorkedOnBranch(lane, f.repositoryId, "agent/second"),
    ).toBe(true);
  });

  // #1177-T55
  it("matches a branch name that has LIKE characters literally", async () => {
    const { f, runs, workflow, session } = await start();
    const lane = await workflow("Handoff");
    await session(lane, "agent/a_b%c");

    expect(
      await runs.laneWorkedOnBranch(lane, f.repositoryId, "agent/a_b%c"),
    ).toBe(true);
    expect(
      await runs.laneWorkedOnBranch(lane, f.repositoryId, "agent/aXbYc"),
    ).toBe(false);
  });
});
