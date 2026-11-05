// SPDX-License-Identifier: LicenseRef-Proprietary

// The registration tokens and the runners of customers' machines (#854) against a real Postgres: a token is used once and only
// while it lasts (two runners racing for it: one wins), the exchange makes the runner of the token's workspace in the same
// transaction, a runner is found by its credential's hash until it is revoked, a renewal keeps the previous credential until the new
// one is used, and nothing crosses workspaces.
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test-support/test-database.ts";
import { addUser } from "../../test-support/workspace-deletion-fixture.ts";
import {
  addWorkspace,
  defaultWorkspaceId,
} from "../../test-support/workspaces.ts";
import type { Announcement } from "../../runner-identity/announcement.ts";
import {
  createRunnerCredentialsRepository,
  type NewRunner,
} from "./runner-credentials-repository.ts";
import { createRunnersRepository } from "./runners-repository.ts";

const ANNOUNCEMENT: Announcement = {
  labels: ["gpu", "linux"],
  baseVersion: "1.2.0",
  manifest: {
    harnesses: { opencode: { version: "1.19.0", ready: true } },
    capabilities: ["agent-docker"],
  },
  limits: { cpus: 8 },
};

async function setup() {
  const { db } = await createTestDatabase();
  const idA = await defaultWorkspaceId(db);
  const idB = await addWorkspace(db, "other");
  await addUser(db, "u-1");
  let clock = new Date("2026-11-05T12:00:00.000Z");
  const now = () => clock;
  let counter = 0;
  const newId = () => `id-${++counter}`;
  const options = { now, newId };
  return {
    db,
    idA,
    idB,
    a: createRunnersRepository(db, idA, options),
    b: createRunnersRepository(db, idB, options),
    credentials: createRunnerCredentialsRepository(db, options),
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

const token = (hash: string, expiresAt = "2026-11-05T13:00:00.000Z") => ({
  tokenHash: hash,
  createdBy: "u-1",
  expiresAt: new Date(expiresAt),
});
const runner = (hash: string, name = "box"): NewRunner => ({
  ...ANNOUNCEMENT,
  name,
  credentialHash: hash,
});

describe("a registration token", () => {
  // #854-T100
  it("is exchanged for a runner of its workspace, and what the runner announced is kept as announced", async () => {
    const { a, b, credentials, idA } = await setup();
    await a.createToken(token("t1"), 20);

    const redeemed = await credentials.redeem("t1", runner("c1", "build-box"));

    expect(redeemed).toMatchObject({
      ok: true,
      runner: {
        id: "id-2",
        workspaceId: idA,
        name: "build-box",
        labels: ["gpu", "linux"],
        baseVersion: "1.2.0",
        manifest: ANNOUNCEMENT.manifest,
        limits: { cpus: 8 },
        createdAt: "2026-11-05T12:00:00.000Z",
        lastSeenAt: "2026-11-05T12:00:00.000Z",
        revokedAt: null,
      },
    });
    expect((await a.list()).map((entry) => entry.name)).toEqual(["build-box"]);
    expect(await b.list()).toEqual([]);
  });

  // #854-T101
  it("works once: the second exchange is refused and makes no runner", async () => {
    const { a, db, credentials } = await setup();
    await a.createToken(token("t1"), 20);
    await credentials.redeem("t1", runner("c1"));

    const second = await credentials.redeem("t1", runner("c2", "second"));

    expect(second).toEqual({ ok: false, reason: "invalid_token" });
    expect(await db.selectFrom("runners").select("name").execute()).toEqual([
      { name: "box" },
    ]);
  });

  // #854-T102
  it("is refused when it expired, and when nobody made it, with the same answer", async () => {
    const { a, advance, credentials } = await setup();
    await a.createToken(token("t1", "2026-11-05T13:00:00.000Z"), 20);

    advance(60 * 60 * 1000 + 1);

    expect(await credentials.redeem("t1", runner("c1"))).toEqual({
      ok: false,
      reason: "invalid_token",
    });
    expect(await credentials.redeem("never-made", runner("c2"))).toEqual({
      ok: false,
      reason: "invalid_token",
    });
  });

  // #854-T103
  it("is stored as the hash it was given and carries the member who made it", async () => {
    const { a, db, idA } = await setup();

    const made = await a.createToken(token("t1"), 20);

    expect(made).toEqual({
      ok: true,
      id: "id-1",
      expiresAt: "2026-11-05T13:00:00.000Z",
    });
    expect(
      await db.selectFrom("runner_registration_tokens").selectAll().execute(),
    ).toEqual([
      {
        id: "id-1",
        workspace_id: idA,
        token_hash: "t1",
        created_by: "u-1",
        created_at: "2026-11-05T12:00:00.000Z",
        expires_at: "2026-11-05T13:00:00.000Z",
        used_at: null,
        runner_id: null,
      },
    ]);
  });

  // #854-T104
  it("is made only while the workspace holds fewer unused ones than the maximum; a used or an expired one does not count", async () => {
    const { a, advance, credentials } = await setup();
    expect(await a.createToken(token("t1"), 2)).toMatchObject({ ok: true });
    expect(await a.createToken(token("t2"), 2)).toMatchObject({ ok: true });

    expect(await a.createToken(token("t3"), 2)).toEqual({
      ok: false,
      reason: "limit_reached",
    });
    await credentials.redeem("t1", runner("c1"));
    expect(await a.createToken(token("t3"), 2)).toMatchObject({ ok: true });
    advance(2 * 60 * 60 * 1000);
    expect(await a.createToken(token("t4"), 2)).toMatchObject({ ok: true });
  });

  // #854-T105
  it("is used by exactly one of two exchanges that run at the same moment", async () => {
    const { a, credentials } = await setup();
    await a.createToken(token("t1"), 20);

    const outcomes = await Promise.all([
      credentials.redeem("t1", runner("c1", "one")),
      credentials.redeem("t1", runner("c2", "two")),
      credentials.redeem("t1", runner("c3", "three")),
    ]);

    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(await a.list()).toHaveLength(1);
  });
});

describe("the credential of a runner", () => {
  async function registered() {
    const world = await setup();
    await world.a.createToken(token("t1"), 20);
    const redeemed = await world.credentials.redeem("t1", runner("c1"));
    if (!redeemed.ok) throw new Error("seeding failed");
    return { ...world, runnerId: redeemed.runner.id };
  }

  // #854-T106
  it("finds the runner and sets last seen to now", async () => {
    const { credentials, advance, runnerId } = await registered();
    advance(90_000);

    const found = await credentials.authenticate("c1");

    expect(found).toMatchObject({
      id: runnerId,
      lastSeenAt: "2026-11-05T12:01:30.000Z",
    });
    expect(await credentials.authenticate("c-unknown")).toBeUndefined();
  });

  // #854-T107
  it("finds nothing once the runner is revoked, at once, and a second revoke finds no runner", async () => {
    const { a, credentials, runnerId } = await registered();

    expect(await a.revoke(runnerId)).toBe(true);

    expect(await credentials.authenticate("c1")).toBeUndefined();
    expect(await a.revoke(runnerId)).toBe(false);
    expect(await a.list()).toEqual([]);
  });

  // #854-T108
  it("is not revoked by another workspace", async () => {
    const { b, credentials, runnerId } = await registered();

    expect(await b.revoke(runnerId)).toBe(false);

    expect(await credentials.authenticate("c1")).toMatchObject({
      id: runnerId,
    });
  });

  // #854-T109
  it("takes the renewed credential, keeps the previous one until the new one is used, and then retires it", async () => {
    const { credentials, runnerId } = await registered();

    expect(await credentials.renew(runnerId, "c1", "c2")).toBe(true);

    // The answer with c2 may have been lost: c1 still works.
    expect(await credentials.authenticate("c1")).toMatchObject({
      id: runnerId,
    });
    expect(await credentials.authenticate("c2")).toMatchObject({
      id: runnerId,
    });
    expect(await credentials.authenticate("c1")).toBeUndefined();
    expect(await credentials.authenticate("c2")).toMatchObject({
      id: runnerId,
    });
  });

  // #854-T110
  it("is not renewed by someone who does not hold it or for a revoked runner", async () => {
    const { a, credentials, runnerId } = await registered();

    expect(await credentials.renew(runnerId, "wrong", "c2")).toBe(false);
    await a.revoke(runnerId);
    expect(await credentials.renew(runnerId, "c1", "c2")).toBe(false);
    expect(await credentials.authenticate("c2")).toBeUndefined();
  });

  // #854-T111
  it("replaces labels, base version, manifest and limits when the runner announces, and not those of a revoked runner", async () => {
    const { a, credentials, runnerId } = await registered();

    expect(
      await credentials.announce(runnerId, {
        labels: ["arm"],
        baseVersion: "1.3.0",
        manifest: { harnesses: {}, capabilities: [] },
        limits: {},
      }),
    ).toBe(true);

    expect(await a.list()).toMatchObject([
      {
        labels: ["arm"],
        baseVersion: "1.3.0",
        manifest: { harnesses: {}, capabilities: [] },
        limits: {},
      },
    ]);
    await a.revoke(runnerId);
    expect(await credentials.announce(runnerId, ANNOUNCEMENT)).toBe(false);
  });
});
