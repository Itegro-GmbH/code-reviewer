// SPDX-License-Identifier: LicenseRef-Proprietary

// #1092 (epic #1090, ADR 0006) against a real Postgres: the repositories of a session of several repositories are stored with the session and
// read back as the first turn resolved them, and a turn of such a session is a candidate of the claim only for a caller that named the claim
// feature `implementer_multi_repo`: for any other it waits in the queue (no error, no attempt, nothing ends), and the turns of a single repository
// are claimed by every caller as before.
import { describe, expect, it } from "vitest";
import { sha } from "../../test-support/jobs.ts";
import { createRunsFixture } from "../../test-support/runs.ts";
import { addUser } from "../../test-support/workspace-deletion-fixture.ts";
import type { SessionRepo } from "../session-repos.ts";

async function start() {
  const f = await createRunsFixture();
  await addUser(f.db, "user-1");
  let counter = 0;
  async function enqueue(repos?: SessionRepo[]) {
    counter += 1;
    f.clock.advance(1000);
    const enqueued = await f.queue.enqueueImplementerTurn({
      repositoryId: f.repositoryId,
      baseBranch: "main",
      baseSha: sha("a"),
      branch: `workflow/run/step${String(counter)}`,
      ...(repos === undefined ? {} : { repos }),
      instruction: "Do it.",
      modelChoice: { entryId: "entry-1" },
      costLimitCents: null,
      createdBy: "user-1",
      actorLogin: "octocat",
      clientRequestId: `request-${String(counter)}`,
    });
    if (enqueued.status !== "created") throw new Error("not created");
    return enqueued;
  }
  return { f, enqueue };
}

describe("the repositories of a session", () => {
  // #1092-T80
  it("are stored with the session and read back as they were resolved; a session of one repository has none", async () => {
    const { f, enqueue } = await start();
    const repos: SessionRepo[] = [
      {
        repositoryId: f.repositoryId,
        fullName: "acme/gadgets",
        name: "gadgets",
        base: "main",
        branch: "feature/x",
      },
      {
        repositoryId: "other",
        fullName: "acme/lib",
        name: "lib",
        base: "develop",
        branch: "develop",
      },
    ];

    const multi = await enqueue(repos);
    const single = await enqueue();

    expect(multi.session.repos).toEqual(repos);
    expect(single.session.repos).toBeNull();
    // Two sessions may work on the same working branch: the unique key of the session is its own name.
    const again = await enqueue(repos);
    expect(again.session.repos).toEqual(repos);
  });
});

describe("the claim of a turn on several repositories", () => {
  const repos = (id: string): SessionRepo[] => [
    {
      repositoryId: id,
      fullName: "acme/gadgets",
      name: "gadgets",
      base: "main",
      branch: "main",
    },
  ];

  // #1092-T81
  it("goes only to a caller that named the feature; any other leaves it queued and takes the next job", async () => {
    const { f, enqueue } = await start();
    const multi = await enqueue(repos(f.repositoryId));
    const single = await enqueue();

    const old = await f.queue.claimNext("runner-1", ["implementer"]);
    expect(old?.job.id).toBe(single.job.id);
    // Nothing else for the old caller: the turn waits, nothing fails.
    expect(await f.queue.claimNext("runner-1", ["implementer"])).toBeNull();
    expect((await f.queue.get(multi.job.id))?.status).toBe("queued");

    const modern = await f.queue.claimNext("runner-2", ["implementer"], {
      acceptsMultiRepo: true,
    });
    expect(modern?.job.id).toBe(multi.job.id);
  });

  // #1092-T82
  it("is taken in its turn by a caller that named the feature, which also takes the single-repository turns", async () => {
    const { f, enqueue } = await start();
    const first = await enqueue();
    const second = await enqueue(repos(f.repositoryId));

    const a = await f.queue.claimNext("runner-1", ["implementer"], {
      acceptsMultiRepo: true,
    });
    const b = await f.queue.claimNext("runner-1", ["implementer"], {
      acceptsMultiRepo: true,
    });
    expect([a?.job.id, b?.job.id]).toEqual([first.job.id, second.job.id]);
  });
});
