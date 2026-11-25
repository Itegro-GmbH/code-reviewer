// SPDX-License-Identifier: LicenseRef-Proprietary

// #1158 (epic #1157) against a real Postgres: a hosted runner has a placement, the Cloudflare ones exist only for the sizes the operator enabled, a turn on
// one requires the reserved label `cr:placement:cloudflare`, and that label is the platform identity's only for a claim that names the claim feature
// `placement_cloudflare`: a Dispatcher without the Cloudflare configuration never takes such a job, and a job of Vercel is claimed by every Dispatcher.
import { describe, expect, it } from "vitest";
import { sql } from "kysely";
import { sha } from "../../test-support/jobs.ts";
import { createRunsFixture } from "../../test-support/runs.ts";
import { addUser } from "../../test-support/workspace-deletion-fixture.ts";
import { addWorkspace } from "../../test-support/workspaces.ts";
import {
  createNamedRunnersRepository,
  ensureHostedRunners,
} from "./named-runners-repository.ts";

const ON = { CLOUDFLARE_RUNNER_SIZES: "4" };
const NOW = { now: () => new Date("2026-11-25T10:00:00.000Z") };

describe("the Cloudflare hosted runners of a workspace", () => {
  // #1158-R01
  it("do not exist while the operator enabled no size: the placement is off and the workspace has the four Vercel runners", async () => {
    const { db, workspaceId } = await createRunsFixture();
    await ensureHostedRunners(db, workspaceId, { ...NOW, env: {} });

    const list = await createNamedRunnersRepository(db, workspaceId, {
      ...NOW,
      env: {},
    }).list();

    expect(list.map((runner) => runner.name)).toEqual([
      "Vercel Sandbox 2 vCPU",
      "Vercel Sandbox 4 vCPU",
      "Vercel Sandbox 6 vCPU",
      "Vercel Sandbox 8 vCPU",
    ]);
  });

  // #1158-R02
  it("are made for the enabled sizes only, named by placement and size, beside the Vercel one of that size", async () => {
    const { db, workspaceId } = await createRunsFixture();
    await ensureHostedRunners(db, workspaceId, { ...NOW, env: ON });

    const list = await createNamedRunnersRepository(db, workspaceId, {
      ...NOW,
      env: ON,
    }).list();

    expect(
      list.map(
        (runner) =>
          runner.kind === "hosted" && [
            runner.name,
            runner.placement,
            runner.available,
          ],
      ),
    ).toEqual([
      ["Vercel Sandbox 2 vCPU", "vercel", true],
      ["Vercel Sandbox 4 vCPU", "vercel", true],
      ["Cloudflare Container 4 vCPU", "cloudflare", true],
      ["Vercel Sandbox 6 vCPU", "vercel", true],
      ["Vercel Sandbox 8 vCPU", "vercel", true],
    ]);
  });

  // #1158-R03
  it("are made again where the runners are read (the self-repair), and asking again makes nothing", async () => {
    const { db, workspaceId } = await createRunsFixture();
    await ensureHostedRunners(db, workspaceId, { ...NOW, env: {} });
    const named = createNamedRunnersRepository(db, workspaceId, {
      ...NOW,
      env: ON,
    });

    const first = await named.list();
    const second = await named.list();

    expect(first).toHaveLength(5);
    expect(second.map((runner) => runner.id)).toEqual(
      first.map((runner) => runner.id),
    );
  });

  // #1158-R04
  it("keep their row when the size is switched off later, and say they are unavailable", async () => {
    const { db, workspaceId } = await createRunsFixture();
    await ensureHostedRunners(db, workspaceId, { ...NOW, env: ON });
    const before = await createNamedRunnersRepository(db, workspaceId, {
      ...NOW,
      env: ON,
    }).list();
    const cloudflare = before.find(
      (runner) => runner.kind === "hosted" && runner.placement === "cloudflare",
    );
    if (cloudflare === undefined) throw new Error("no Cloudflare runner");

    const off = createNamedRunnersRepository(db, workspaceId, {
      ...NOW,
      env: {},
    });

    const after = await off.list();
    expect(after).toHaveLength(5);
    expect(after.find((runner) => runner.id === cloudflare.id)).toMatchObject({
      available: false,
      placement: "cloudflare",
    });
    expect(await off.find(cloudflare.id)).toMatchObject({ available: false });
  });

  // #1158-R05
  it("take another name when a runner of the workspace already has theirs", async () => {
    const { db, workspaceId } = await createRunsFixture();
    await addUser(db, "u-1");
    await sql`insert into runners (id, workspace_id, name, labels, base_version, manifest, limits, credential_hash, created_at, last_seen_at)
      values ('run-1', ${workspaceId}, 'cloudflare container 4 vcpu', '', '1.0.0', '{}', '{}', 'hash-1', 't', 't')`.execute(
      db,
    );

    await ensureHostedRunners(db, workspaceId, { ...NOW, env: ON });

    const names = (
      await createNamedRunnersRepository(db, workspaceId, {
        ...NOW,
        env: ON,
      }).list()
    ).map((runner) => runner.name);
    expect(names).toContain("Cloudflare Container 4 vCPU (hosted)");
  });

  // #1158-R06
  it("are made for a workspace made later, as the Vercel ones are", async () => {
    const { db } = await createRunsFixture();
    const later = await addWorkspace(db, "later");

    await ensureHostedRunners(db, later, { ...NOW, env: ON });

    const rows = await db
      .selectFrom("implementer_environments")
      .select(["placement", "vcpus"])
      .where("workspace_id", "=", later)
      .where("placement", "=", "cloudflare")
      .execute();
    expect(rows).toEqual([{ placement: "cloudflare", vcpus: 4 }]);
  });
});

describe("the claim of a turn on a Cloudflare runner", () => {
  async function start() {
    const f = await createRunsFixture();
    await addUser(f.db, "user-1");
    await ensureHostedRunners(f.db, f.workspaceId, { ...NOW, env: ON });
    const environments = await f.db
      .selectFrom("implementer_environments")
      .select(["id", "name", "vcpus", "placement"])
      .where("workspace_id", "=", f.workspaceId)
      .where("concurrency", "is not", null)
      .execute();
    const runner = (placement: string, vcpus: number) => {
      const found = environments.find(
        (row) => row.placement === placement && row.vcpus === vcpus,
      );
      if (found === undefined || found.vcpus === null)
        throw new Error("no runner");
      return {
        id: found.id,
        name: found.name,
        vcpus: found.vcpus,
        setupScript: "",
      };
    };
    let counter = 0;
    async function enqueue(placement: string) {
      counter += 1;
      f.clock.advance(1000);
      const enqueued = await f.queue.enqueueImplementerTurn({
        repositoryId: f.repositoryId,
        baseBranch: "main",
        baseSha: sha("a"),
        branch: `workflow/run/step${String(counter)}`,
        instruction: "Do it.",
        modelChoice: { entryId: "entry-1" },
        costLimitCents: null,
        environment: runner(placement, 4),
        createdBy: "user-1",
        actorLogin: "octocat",
        clientRequestId: `request-${String(counter)}`,
      });
      if (enqueued.status !== "created") throw new Error("not created");
      return enqueued;
    }
    return { f, enqueue };
  }

  // #1158-R10
  it("requires `cr:managed`, its size and the placement label; a turn on Vercel does not require the placement", async () => {
    const { enqueue } = await start();

    const cloudflare = await enqueue("cloudflare");
    const vercel = await enqueue("vercel");

    expect(cloudflare.job.requiredLabels).toEqual([
      "cr:managed",
      "cr:size-4",
      "cr:placement:cloudflare",
    ]);
    expect(vercel.job.requiredLabels).toEqual(["cr:managed", "cr:size-4"]);
  });

  // #1158-R11
  it("goes only to a claim that names the feature; any other leaves it queued and takes the next job, a turn on Vercel goes to both", async () => {
    const { f, enqueue } = await start();
    const cloudflare = await enqueue("cloudflare");
    const vercel = await enqueue("vercel");

    const without = await f.queue.claimNext("runner-1", ["implementer"], {
      workerCredential: true,
    });
    expect(without?.job.id).toBe(vercel.job.id);
    // Nothing else for it: the turn waits, nothing fails.
    expect(
      await f.queue.claimNext("runner-1", ["implementer"], {
        workerCredential: true,
      }),
    ).toBeNull();
    expect((await f.queue.get(cloudflare.job.id))?.status).toBe("queued");

    const named = await f.queue.claimNext("runner-2", ["implementer"], {
      workerCredential: true,
      acceptsPlacementCloudflare: true,
    });
    expect(named?.job.id).toBe(cloudflare.job.id);
  });

  // #1158-R12
  it("is claimed in its turn by a claim that names the feature, which also takes the turns on Vercel", async () => {
    const { f, enqueue } = await start();
    const first = await enqueue("vercel");
    const second = await enqueue("cloudflare");

    const options = {
      workerCredential: true,
      acceptsPlacementCloudflare: true,
    } as const;
    const a = await f.queue.claimNext("runner-1", ["implementer"], options);
    const b = await f.queue.claimNext("runner-1", ["implementer"], options);

    expect([a?.job.id, b?.job.id]).toEqual([first.job.id, second.job.id]);
  });
});
