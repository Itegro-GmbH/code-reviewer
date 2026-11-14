// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the encrypted secret store of a workspace against a real Postgres database: the LLM key goes in
// encrypted and comes back exactly, a ciphertext copied to another workspace or another name is worthless,
// a value that cannot be read is a stable state and never an exception, one workspace never sees the secret
// of another, and the saved value is in no status and no result that can be printed.
import { inspect } from "node:util";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../test-support/test-database.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import { createWorkspaceSecretStore } from "./workspace-store.ts";

const APP_SECRET = "workspace-store-app-secret-0123456789-01234";
const KEY = "sk-or-v1-dummy-0123456789abcdef0123456789abcdef";

async function start() {
  const { db } = await createTestDatabase();
  const a = await addWorkspace(db, "alpha");
  const b = await addWorkspace(db, "beta");
  await sql`insert into users (id, name, email, email_verified, created_at, updated_at)
    values ('admin-1', 'Admin', 'admin@example.test', 0, '2026-10-12T00:00:00.000Z', '2026-10-12T00:00:00.000Z')`.execute(
    db,
  );
  const storeOf = (workspaceId: string, appSecret: string = APP_SECRET) =>
    createWorkspaceSecretStore({ db, workspaceId, appSecret });
  return { db, a, b, storeOf };
}

describe("saving and using a workspace secret", () => {
  // #104-LK-03
  it("returns exactly the value that was saved, with what it was made for", async () => {
    const { a, storeOf } = await start();
    const store = storeOf(a);

    await store.save("llm_api_key", KEY, {
      binding: "openrouter",
      updatedBy: "admin-1",
      showLastFour: true,
    });
    const used = await store.use("llm_api_key");

    expect(used.ok && used.value.reveal()).toBe(KEY);
    expect(used.ok && used.binding).toBe("openrouter");
    expect(await store.status("llm_api_key")).toMatchObject({
      state: "configured",
      binding: "openrouter",
      lastFour: KEY.slice(-4),
      keyVersion: 1,
      updatedBy: "admin-1",
    });
  });

  // #104-LK-03
  it("stores the value encrypted: the columns do not contain it, and a new nonce is used every time", async () => {
    const { db, a, storeOf } = await start();
    const store = storeOf(a);

    await store.save("llm_api_key", KEY, {
      binding: "openrouter",
      updatedBy: null,
    });
    const first = await db
      .selectFrom("workspace_secrets")
      .selectAll()
      .executeTakeFirstOrThrow();
    await store.save("llm_api_key", KEY, {
      binding: "openrouter",
      updatedBy: null,
    });
    const second = await db
      .selectFrom("workspace_secrets")
      .selectAll()
      .executeTakeFirstOrThrow();

    expect(JSON.stringify(first)).not.toContain(KEY);
    expect(second.ciphertext).not.toBe(first.ciphertext);
    expect(second.nonce).not.toBe(first.nonce);
    expect(first.last_four).toBeNull();
  });

  it("refuses an empty value and keeps the old one", async () => {
    const { a, storeOf } = await start();
    const store = storeOf(a);
    await store.save("llm_api_key", KEY, {
      binding: "openrouter",
      updatedBy: null,
    });

    expect(
      await store.save("llm_api_key", "   ", {
        binding: "openrouter",
        updatedBy: null,
      }),
    ).toEqual({ ok: false, error: "secret_empty" });
    const used = await store.use("llm_api_key");
    expect(used.ok && used.value.reveal()).toBe(KEY);
  });

  it("prints a placeholder where the value would show by accident", async () => {
    const { a, storeOf } = await start();
    const store = storeOf(a);
    await store.save("llm_api_key", KEY, {
      binding: "openrouter",
      updatedBy: null,
      showLastFour: true,
    });
    const used = await store.use("llm_api_key");
    const status = await store.status("llm_api_key");

    for (const printed of [
      String(used),
      JSON.stringify(used),
      inspect(used, { depth: 5 }),
      JSON.stringify(status),
    ]) {
      expect(printed).not.toContain(KEY);
      expect(printed).not.toContain(KEY.slice(0, -4));
    }
  });
});

describe("one workspace and another", () => {
  // #104-LK-05
  it("never shows the secret of another workspace", async () => {
    const { a, b, storeOf } = await start();
    await storeOf(a).save("llm_api_key", KEY, {
      binding: "openrouter",
      updatedBy: null,
    });

    expect(await storeOf(b).status("llm_api_key")).toEqual({
      name: "llm_api_key",
      state: "not_configured",
    });
    expect(await storeOf(b).use("llm_api_key")).toEqual({
      ok: false,
      error: "secret_not_configured",
    });
    expect(await storeOf(b).remove("llm_api_key")).toBe(false);
    expect((await storeOf(a).use("llm_api_key")).ok).toBe(true);
  });

  // #104-LK-05
  it("keeps the secrets of two workspaces apart", async () => {
    const { a, b, storeOf } = await start();
    await storeOf(a).save("llm_api_key", `${KEY}-A`, {
      binding: "openrouter",
      updatedBy: null,
    });
    await storeOf(b).save("llm_api_key", `${KEY}-B`, {
      binding: "openrouter",
      updatedBy: null,
    });

    const [usedA, usedB] = await Promise.all([
      storeOf(a).use("llm_api_key"),
      storeOf(b).use("llm_api_key"),
    ]);
    expect(usedA.ok && usedA.value.reveal()).toBe(`${KEY}-A`);
    expect(usedB.ok && usedB.value.reveal()).toBe(`${KEY}-B`);
  });

  // #104-LK-03
  it("does not decrypt a row copied to another workspace", async () => {
    const { db, a, b, storeOf } = await start();
    await storeOf(a).save("llm_api_key", KEY, {
      binding: "openrouter",
      updatedBy: null,
    });
    // Somebody with write access to the database copies the sealed row into workspace B.
    await db
      .insertInto("workspace_secrets")
      .columns([
        "workspace_id",
        "name",
        "binding",
        "ciphertext",
        "nonce",
        "key_version",
        "last_four",
        "updated_by",
        "updated_at",
      ])
      .expression((eb) =>
        eb
          .selectFrom("workspace_secrets")
          .select([
            eb.val(b).as("workspace_id"),
            "name",
            "binding",
            "ciphertext",
            "nonce",
            "key_version",
            "last_four",
            "updated_by",
            "updated_at",
          ])
          .where("workspace_id", "=", a),
      )
      .execute();

    expect(await storeOf(b).use("llm_api_key")).toEqual({
      ok: false,
      error: "secret_undecryptable",
    });
    expect(await storeOf(b).status("llm_api_key")).toMatchObject({
      state: "undecryptable",
      code: "secret_undecryptable",
    });
  });

  // #104-LK-03
  it("does not decrypt with another APP_SECRET and says so with a code, without throwing", async () => {
    const { a, storeOf } = await start();
    await storeOf(a).save("llm_api_key", KEY, {
      binding: "openrouter",
      updatedBy: null,
    });
    const other = storeOf(a, "another-app-secret-0123456789-0123456789");

    expect(await other.use("llm_api_key")).toEqual({
      ok: false,
      error: "secret_undecryptable",
    });
    expect(await other.status("llm_api_key")).toMatchObject({
      state: "undecryptable",
      binding: "openrouter",
    });
  });

  it("hands a secret out once: of two takes at the same time only one gets it", async () => {
    const { db, a, storeOf } = await start();
    await storeOf(a).save("one_use", "the-pending-value", {
      binding: "jira_pending",
      updatedBy: null,
    });

    const taken = await Promise.all([
      storeOf(a).take("one_use"),
      storeOf(a).take("one_use"),
      storeOf(a).take("one_use"),
    ]);

    expect(taken.filter((t) => t.ok)).toHaveLength(1);
    const winner = taken.find((t) => t.ok);
    expect(winner?.ok && winner.value.reveal()).toBe("the-pending-value");
    expect(winner?.ok && winner.binding).toBe("jira_pending");
    expect(taken.filter((t) => !t.ok)).toEqual([
      { ok: false, error: "secret_not_configured" },
      { ok: false, error: "secret_not_configured" },
    ]);
    expect(
      await db.selectFrom("workspace_secrets").selectAll().execute(),
    ).toEqual([]);
  });

  it("takes a secret of its own workspace only, and a secret that cannot be read is gone too", async () => {
    const { a, b, storeOf } = await start();
    await storeOf(a).save("one_use", "value", {
      binding: "x",
      updatedBy: null,
    });

    expect(await storeOf(b).take("one_use")).toEqual({
      ok: false,
      error: "secret_not_configured",
    });
    expect(
      await storeOf(a, "another-app-secret-0123456789-0123456789").take(
        "one_use",
      ),
    ).toMatchObject({ ok: false, error: "secret_undecryptable" });
    expect((await storeOf(a).status("one_use")).state).toBe("not_configured");
  });

  it("goes away with its workspace", async () => {
    const { db, a, storeOf } = await start();
    await storeOf(a).save("llm_api_key", KEY, {
      binding: "openrouter",
      updatedBy: null,
    });

    await db.deleteFrom("workspaces").where("id", "=", a).execute();

    expect(
      await db.selectFrom("workspace_secrets").selectAll().execute(),
    ).toEqual([]);
  });
});
