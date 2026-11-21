// SPDX-License-Identifier: LicenseRef-Proprietary

// The concrete runners of a workspace (#1105, ADR 0007) against a real Postgres: the hosted runners (one for each type of the provided
// Vercel Sandbox, made by the platform, fixed size, their own concurrency), the self-hosted ones, and the one name space across both tables
// (a runner cannot take the name of a type, a name is free again once its runner is revoked, a rename changes no id).
import { describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createTestDatabase } from "../../test-support/test-database.ts";
import { addUser } from "../../test-support/workspace-deletion-fixture.ts";
import {
  addWorkspace,
  defaultWorkspaceId,
} from "../../test-support/workspaces.ts";
import type { Announcement } from "../../runner-identity/announcement.ts";
import { createImplementerEnvironmentsRepository } from "./implementer-environments-repository.ts";
import {
  createNamedRunnersRepository,
  ensureHostedRunners,
} from "./named-runners-repository.ts";
import {
  createRunnerCredentialsRepository,
  type NewRunner,
} from "./runner-credentials-repository.ts";
import { createRunnersRepository } from "./runners-repository.ts";

const ANNOUNCEMENT: Announcement = {
  labels: ["linux"],
  baseVersion: "1.2.0",
  manifest: { harnesses: [], capabilities: [] },
  limits: {},
};

async function setup() {
  const { db } = await createTestDatabase();
  const idA = await defaultWorkspaceId(db);
  const idB = await addWorkspace(db, "other");
  await addUser(db, "u-1");
  let counter = 0;
  const newId = () => `id-${++counter}`;
  const options = { now: () => new Date("2026-11-21T10:00:00.000Z"), newId };
  await ensureHostedRunners(db, idA, options);
  await ensureHostedRunners(db, idB, options);
  return {
    db,
    idA,
    idB,
    named: createNamedRunnersRepository(db, idA),
    namedB: createNamedRunnersRepository(db, idB),
    runners: createRunnersRepository(db, idA, options),
    environments: createImplementerEnvironmentsRepository(db, idA, options),
    credentials: createRunnerCredentialsRepository(db, options),
    options,
  };
}

const runner = (hash: string, name: string): NewRunner => ({
  ...ANNOUNCEMENT,
  name,
  credentialHash: hash,
});

let tokens = 0;
async function register(
  s: Awaited<ReturnType<typeof setup>>,
  name: string,
  workspace = s.runners,
) {
  const hash = `token-${++tokens}`;
  await workspace.createToken(
    {
      tokenHash: hash,
      createdBy: "u-1",
      expiresAt: new Date("2026-11-21T11:00:00.000Z"),
    },
    20,
  );
  return s.credentials.redeem(hash, runner(`credential-${tokens}`, name));
}

describe("the hosted runners of a workspace", () => {
  // #1105-R70
  it("are one for each type the platform offers an environment, smallest first, with a fixed size, the operator's default concurrency and no maker", async () => {
    const { named, db, idA } = await setup();

    expect(await named.list()).toEqual([
      expect.objectContaining({
        kind: "hosted",
        name: "Vercel Sandbox 2 vCPU",
        vcpus: 2,
        concurrency: 2,
      }),
      expect.objectContaining({ name: "Vercel Sandbox 4 vCPU", vcpus: 4 }),
      expect.objectContaining({ name: "Vercel Sandbox 6 vCPU", vcpus: 6 }),
      expect.objectContaining({ name: "Vercel Sandbox 8 vCPU", vcpus: 8 }),
    ]);
    const rows = await db
      .selectFrom("implementer_environments")
      .select(["created_by", "kind", "setup_script", "network_mode"])
      .where("workspace_id", "=", idA)
      .execute();
    expect(rows).toHaveLength(4);
    for (const row of rows)
      expect(row).toEqual({
        created_by: null,
        kind: "hosted",
        setup_script: "",
        network_mode: "off",
      });
  });

  // #1105-R71
  it("are made once: asking again makes nothing, and the operator's number is the concurrency of the rows it makes", async () => {
    const { db, named, options } = await setup();
    const third = await addWorkspace(db, "third");
    await ensureHostedRunners(db, third, {
      ...options,
      env: { HOSTED_RUNNER_DEFAULT_CONCURRENCY: "6" },
    });
    await ensureHostedRunners(db, third, options);

    const namedThird = createNamedRunnersRepository(db, third);
    const list = await namedThird.list();
    expect(list).toHaveLength(4);
    for (const entry of list)
      expect(entry).toMatchObject({ kind: "hosted", concurrency: 6 });
    expect(await named.list()).toHaveLength(4);
  });

  // #1105-R72
  it("are at most one for each type and workspace, by the database too", async () => {
    const { db, idA } = await setup();

    await expect(
      sql`insert into implementer_environments (id, workspace_id, name, vcpus, kind, concurrency, created_at, updated_at)
        values ('dup', ${idA}, 'Another 4', 4, 'hosted', 1, 't', 't')`.execute(
        db,
      ),
    ).rejects.toThrow();
    // An environment of a person with the same size is no hosted runner and has no such limit.
    await sql`insert into implementer_environments (id, workspace_id, name, vcpus, kind, created_by, created_at, updated_at)
      values ('mine', ${idA}, 'Mine 4', 4, 'hosted', 'u-1', 't', 't')`.execute(
      db,
    );
  });

  // #1105-R73
  it("are no environment of a person: not listed, not counted against the bound, not changed and not deleted through the environments", async () => {
    const { named, environments } = await setup();
    const [first] = await named.list();
    if (first === undefined) throw new Error("no hosted runner");

    expect(await environments.list()).toEqual([]);
    expect(await environments.listSummaries()).toEqual([]);
    expect(await environments.get(first.id)).toBeUndefined();
    expect(
      await environments.update(first.id, {
        name: "Renamed",
        vcpus: 8,
        setupScript: "x",
      }),
    ).toEqual({ ok: false, reason: "not_found" });
    expect(await environments.remove(first.id)).toBe(false);
    // Four hosted runners do not use up a bound of one.
    expect(
      await environments.create(
        { name: "Mine", vcpus: 4, setupScript: "", createdBy: "u-1" },
        1,
      ),
    ).toMatchObject({ ok: true });
    // And a name they have is taken.
    expect(
      await environments.create(
        {
          name: "vercel sandbox 2 vcpu",
          vcpus: 2,
          setupScript: "",
          createdBy: "u-1",
        },
        50,
      ),
    ).toEqual({ ok: false, reason: "name_taken" });
  });

  // #1105-R74
  it("take another name when a person's environment or a runner already has theirs, and never take it from its owner", async () => {
    const { db, options } = await setup();
    const fresh = await addWorkspace(db, "fresh");
    const environments = createImplementerEnvironmentsRepository(
      db,
      fresh,
      options,
    );
    await environments.create(
      {
        name: "Vercel Sandbox 4 vCPU",
        vcpus: 4,
        setupScript: "x",
        createdBy: "u-1",
      },
      50,
    );
    await ensureHostedRunners(db, fresh, options);

    const names = (await createNamedRunnersRepository(db, fresh).list()).map(
      (entry) => entry.name,
    );
    expect(names).toEqual([
      "Vercel Sandbox 2 vCPU",
      "Vercel Sandbox 4 vCPU (hosted)",
      "Vercel Sandbox 6 vCPU",
      "Vercel Sandbox 8 vCPU",
    ]);
    expect((await environments.list()).map((entry) => entry.name)).toEqual([
      "Vercel Sandbox 4 vCPU",
    ]);
  });

  // #1105-R75
  it("have a concurrency that is set within bounds, for a hosted runner of the workspace only", async () => {
    const { named, namedB } = await setup();
    const [first] = await named.list();
    const [firstOfB] = await namedB.list();
    if (first === undefined || firstOfB === undefined)
      throw new Error("no hosted runner");

    expect(await named.setHostedConcurrency(first.id, 9)).toBe(true);
    expect(await named.find(first.id)).toMatchObject({ concurrency: 9 });
    for (const bad of [0, -1, 1.5, 101])
      expect(await named.setHostedConcurrency(first.id, bad)).toBe(false);
    expect(await named.setHostedConcurrency(firstOfB.id, 3)).toBe(false);
    expect(await namedB.find(firstOfB.id)).toMatchObject({ concurrency: 2 });
  });
});

describe("the names of the runners of a workspace", () => {
  // #1105-R76
  it("cannot be the name of a hosted runner, or of another runner, whatever the case; the token is not used then", async () => {
    const s = await setup();

    for (const name of ["Vercel Sandbox 4 vCPU", "vercel sandbox 4 VCPU"])
      expect(await register(s, name)).toEqual({
        ok: false,
        reason: "name_taken",
      });
    expect(await register(s, "DevBox")).toMatchObject({ ok: true });
    expect(await register(s, "devbox")).toEqual({
      ok: false,
      reason: "name_taken",
    });
    // A refused name used no token: the same token registers the runner under another name.
    const used = await s.db
      .selectFrom("runner_registration_tokens")
      .select(["used_at"])
      .execute();
    expect(used.filter((row) => row.used_at === null)).toHaveLength(3);
    // Another workspace has its own names.
    expect(
      await register(
        s,
        "DevBox",
        createRunnersRepository(s.db, s.idB, s.options),
      ),
    ).toMatchObject({ ok: true });
  });

  // #1105-R77
  it("are free again once the runner is revoked, which is how a DevBox registers again", async () => {
    const s = await setup();
    const first = await register(s, "DevBox");
    if (!first.ok) throw new Error("not registered");

    expect(await s.runners.revoke(first.runner.id)).toBe(true);
    const again = await register(s, "DevBox");

    expect(again).toMatchObject({ ok: true });
    // A new id: a lane that named the old one does not name this runner.
    if (again.ok) expect(again.runner.id).not.toBe(first.runner.id);
    expect(
      (await s.named.list()).filter((entry) => entry.kind === "self_hosted"),
    ).toHaveLength(1);
    expect(await s.named.find(first.runner.id)).toMatchObject({
      kind: "self_hosted",
      revokedAt: expect.any(String),
    });
  });

  // #1105-R78
  it("hold across the tables in the database's own index only among runners that are not revoked", async () => {
    const s = await setup();
    const first = await register(s, "Box");
    if (!first.ok) throw new Error("not registered");
    const insert = (id: string, name: string) =>
      sql`insert into runners (id, workspace_id, name, labels, base_version, manifest, limits, credential_hash, created_at, last_seen_at)
        values (${id}, ${s.idA}, ${name}, '', '1.0.0', '{}', '{}', ${`hash-${id}`}, 't', 't')`.execute(
        s.db,
      );

    await expect(insert("x1", "BOX")).rejects.toThrow();
    await s.runners.revoke(first.runner.id);
    await insert("x2", "BOX");
  });

  // #1105-R79
  it("can be changed by a rename that keeps the id, refuses a name that is taken and a runner that is revoked, and frees the old name", async () => {
    const s = await setup();
    const box = await register(s, "Box");
    const other = await register(s, "Other");
    if (!box.ok || !other.ok) throw new Error("not registered");

    expect(await s.runners.rename(box.runner.id, "Build box")).toBe("renamed");
    expect(await s.named.find(box.runner.id)).toMatchObject({
      id: box.runner.id,
      name: "Build box",
    });
    // Its own name in another case is its own to take.
    expect(await s.runners.rename(box.runner.id, "BUILD BOX")).toBe("renamed");
    expect(await s.runners.rename(box.runner.id, "other")).toBe("name_taken");
    expect(await s.runners.rename(box.runner.id, "Vercel Sandbox 8 vCPU")).toBe(
      "name_taken",
    );
    // The name it had is free for another.
    expect(await register(s, "Box")).toMatchObject({ ok: true });
    await s.runners.revoke(other.runner.id);
    expect(await s.runners.rename(other.runner.id, "Alive again")).toBe(
      "not_found",
    );
    expect(await s.runners.rename("nope", "Anything")).toBe("not_found");
  });

  // #1105-R7A
  it("are listed by the named runners with the hosted ones first and a revoked runner left out, though it can still be found by its id", async () => {
    const s = await setup();
    const zeta = await register(s, "zeta");
    const alpha = await register(s, "Alpha");
    const gone = await register(s, "Gone");
    if (!zeta.ok || !alpha.ok || !gone.ok) throw new Error("not registered");
    await s.runners.revoke(gone.runner.id);

    const names = (await s.named.list()).map((entry) => entry.name);

    expect(names).toEqual([
      "Vercel Sandbox 2 vCPU",
      "Vercel Sandbox 4 vCPU",
      "Vercel Sandbox 6 vCPU",
      "Vercel Sandbox 8 vCPU",
      "Alpha",
      "zeta",
    ]);
    expect(await s.named.find(gone.runner.id)).toMatchObject({ name: "Gone" });
    expect(await s.named.find("nowhere")).toBeUndefined();
    expect(await s.named.find("a\u0000b")).toBeUndefined();
  });
});
