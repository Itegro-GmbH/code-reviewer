// SPDX-License-Identifier: LicenseRef-Proprietary

// Linking a GitHub identity to the signed-in account, and the one merge the decision record defines: the
// instance admin links the GitHub identity of an imported operator who has no other credential, and the two
// accounts become one. Against the fake GitHub (authorization with PKCE, the token, the profile) and a real
// database. Every refusal leaves the database exactly as it was; the merge is one transaction.
import { describe, expect, it } from "vitest";
import { githubIdentityLinked } from "../admin/github-identity.ts";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import { createSignedStates } from "../signed-state/state.ts";
import {
  OCTOCAT,
  TEST_AUTH_SECRET,
  TEST_BASE_URL,
  TEST_CLIENT_ID,
  TEST_CLIENT_SECRET,
} from "../test-support/auth-harness.ts";
import { startTestGithub } from "../test-support/github-fake.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import {
  seedImplementerRepository,
  startTask,
  taskOf,
} from "../test-support/implementer.ts";
import { insertUser } from "../test-support/users.ts";
import { defaultWorkspaceId } from "../test-support/workspaces.ts";
import {
  createLinkCallbackHandler,
  createStartLinkHandler,
} from "./link-http.ts";
import {
  createGithubLinkService,
  LINK_USER_MAX,
  type LinkActor,
} from "./link.ts";

async function setup(options: { failMergeAfterMove?: boolean } = {}) {
  const { db } = await createTestDatabase();
  const github = await startTestGithub();
  github.addUser(OCTOCAT);
  const clock = { at: new Date("2026-10-12T10:00:00.000Z") };
  const now = () => clock.at;
  const signedStates = createSignedStates({
    db,
    appSecret: TEST_AUTH_SECRET,
    now,
  });
  const service = createGithubLinkService({
    db,
    signedStates,
    rateLimits: createRateLimitsRepository(db, now),
    authorization: async () => ({
      clientId: TEST_CLIENT_ID,
      clientSecret: TEST_CLIENT_SECRET,
    }),
    publicUrl: TEST_BASE_URL,
    oauthBaseUrl: github.baseUrl,
    apiBaseUrl: github.baseUrl,
    now,
    log: () => undefined,
    ...(options.failMergeAfterMove === true
      ? {
          mergeHooks: {
            beforeCommit: async () => {
              throw new Error("injected failure halfway through the merge");
            },
          },
        }
      : {}),
  });
  const workspaces = createWorkspacesRepository(db);
  const workspace = { id: await defaultWorkspaceId(db) };

  /** The whole linking as a person does it: start, authorize at GitHub as `who`, come back. */
  async function link(actor: LinkActor, who: string | number = OCTOCAT.login) {
    const started = await service.start(actor);
    if (!started.ok) throw new Error(`did not start: ${started.error}`);
    const back = await github.authorize(started.url, who);
    return service.complete(actor, {
      code: back.searchParams.get("code"),
      state: back.searchParams.get("state"),
      error: back.searchParams.get("error"),
    });
  }

  return {
    db,
    github,
    service,
    clock,
    signedStates,
    workspaces,
    workspace,
    link,
  };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

const ADMIN: LinkActor = { id: "admin", sessionId: "session-admin" };

/** The instance admin (a password) and the imported operator (the GitHub identity of the fake, no password). */
async function adminAndImportedOperator(ctx: Ctx) {
  await insertUser(ctx.db, {
    id: "admin",
    email: "admin@example.test",
    emailVerified: true,
    isInstanceAdmin: true,
    passwordHash: "admin-hash",
  });
  await insertUser(ctx.db, {
    id: "operator",
    email: `${String(OCTOCAT.id)}@users.noreply.github.com`,
    githubLogin: "octocat",
    githubId: String(OCTOCAT.id),
    importedAt: "2026-10-11T08:00:00.000Z",
  });
}

async function snapshot(ctx: Ctx) {
  const [users, accounts, members, workspaces, sessions] = await Promise.all([
    ctx.db.selectFrom("users").selectAll().orderBy("id").execute(),
    ctx.db
      .selectFrom("accounts")
      .select(["id", "user_id", "provider_id", "account_id"])
      .orderBy("id")
      .execute(),
    ctx.db
      .selectFrom("workspace_members")
      .selectAll()
      .orderBy("workspace_id")
      .orderBy("user_id")
      .execute(),
    ctx.db.selectFrom("workspaces").selectAll().orderBy("id").execute(),
    ctx.db.selectFrom("sessions").selectAll().orderBy("id").execute(),
  ]);
  return { users, accounts, members, workspaces, sessions };
}

describe("merging the instance admin with an imported operator", () => {
  // #102-GH-23
  it("moves memberships and history to the admin, keeps the higher role, retires the operator and lets the admin switch to GitHub only", async () => {
    const ctx = await setup();
    await adminAndImportedOperator(ctx);
    await ctx.workspaces.addMember(ctx.workspace.id, "admin", "owner");
    const second = await ctx.workspaces.create({
      name: "Second",
      slug: "second",
      createdBy: "operator",
    });
    await ctx.workspaces.addMember(second.id, "operator", "member");
    await ctx.db
      .updateTable("workspaces")
      .set({ created_by: "operator" })
      .where("id", "=", ctx.workspace.id)
      .execute();
    await ctx.workspaces.addMember(ctx.workspace.id, "operator", "member");
    await ctx.db
      .insertInto("instance_settings")
      .values({
        key: "tenancy",
        value: '"single"',
        updated_by: "operator",
        updated_at: "2026-10-11T08:00:00.000Z",
      })
      .execute();
    // The invitations the operator sent or accepted are history that names the user, like the rest.
    await ctx.db
      .insertInto("invitations")
      .values({
        id: "inv-1",
        workspace_id: ctx.workspace.id,
        email: "someone@example.test",
        role: "member",
        token_hash: "a".repeat(64),
        invited_by: "operator",
        created_at: "2026-10-11T08:00:00.000Z",
        expires_at: "2026-10-18T08:00:00.000Z",
        accepted_at: "2026-10-11T09:00:00.000Z",
        accepted_by: "operator",
        revoked_at: null,
      })
      .execute();
    // The requests to link an installation that the operator made or decided are history as well.
    await ctx.db
      .insertInto("installation_link_requests")
      .values({
        id: "request-1",
        workspace_id: ctx.workspace.id,
        requested_by: "operator",
        requester_github_login: "octocat",
        installation_id: "4242",
        account_login: "acme",
        account_type: "Organization",
        account_id: "5001",
        status: "approved",
        token_can_access: 1,
        role_result: "unreadable",
        role_detail: "forbidden",
        created_at: "2026-10-11T08:00:00.000Z",
        decided_at: "2026-10-11T09:00:00.000Z",
        decided_by: "operator",
      })
      .execute();
    // The operator saved the LLM key of the workspace: who saved it is history that names the user too (#104).
    await ctx.db
      .insertInto("workspace_secrets")
      .values({
        workspace_id: ctx.workspace.id,
        name: "llm_api_key",
        binding: "openrouter",
        ciphertext: "x",
        nonce: "y",
        key_version: 1,
        last_four: null,
        updated_by: "operator",
        updated_at: "2026-10-11T08:00:00.000Z",
      })
      .execute();
    // The same for the entitlements the operator saved for the workspace (#271).
    await ctx.db
      .insertInto("workspace_entitlements")
      .values({
        workspace_id: ctx.workspace.id,
        plan_label: "team",
        key_mode: "own",
        limits: "{}",
        period_start: "2026-10-01T00:00:00.000Z",
        suspended: 0,
        suspension_code: null,
        updated_at: "2026-10-11T08:00:00.000Z",
        updated_by: "operator",
      })
      .execute();
    expect(await githubIdentityLinked(ctx.db, "admin")).toBe(false);

    const result = await ctx.link(ADMIN);

    expect(result).toEqual({ ok: true, outcome: "merged" });
    expect(
      (
        await ctx.db
          .selectFrom("workspace_entitlements")
          .select("updated_by")
          .executeTakeFirstOrThrow()
      ).updated_by,
    ).toBe("admin");
    expect(
      await ctx.db
        .selectFrom("installation_link_requests")
        .select(["requested_by", "decided_by"])
        .execute(),
    ).toEqual([{ requested_by: "admin", decided_by: "admin" }]);
    expect(
      (
        await ctx.db
          .selectFrom("workspace_secrets")
          .select("updated_by")
          .executeTakeFirstOrThrow()
      ).updated_by,
    ).toBe("admin");
    const invitation = await ctx.db
      .selectFrom("invitations")
      .select(["invited_by", "accepted_by"])
      .where("id", "=", "inv-1")
      .executeTakeFirstOrThrow();
    expect(invitation).toEqual({ invited_by: "admin", accepted_by: "admin" });
    const after = await snapshot(ctx);
    expect(after.users.map((user) => user.id)).toEqual(["admin"]);
    expect(after.users[0]).toMatchObject({
      github_login: "octocat",
      email: "admin@example.test",
    });
    expect(
      after.accounts
        .map((a) => [a.user_id, a.provider_id, a.account_id])
        .sort(),
    ).toEqual([
      ["admin", "credential", "admin"],
      ["admin", "github", String(OCTOCAT.id)],
    ]);
    // Both memberships are the admin's now, once each; the admin keeps owner where both were members.
    expect(
      after.members.map((m) => [m.workspace_id, m.user_id, m.role]),
    ).toEqual(
      expect.arrayContaining([
        [ctx.workspace.id, "admin", "owner"],
        [second.id, "admin", "member"],
      ]),
    );
    expect(after.members).toHaveLength(2);
    expect(after.workspaces.every((w) => w.created_by !== "operator")).toBe(
      true,
    );
    const setting = await ctx.db
      .selectFrom("instance_settings")
      .select("updated_by")
      .where("key", "=", "tenancy")
      .executeTakeFirstOrThrow();
    expect(setting.updated_by).toBe("admin");
    expect(await githubIdentityLinked(ctx.db, "admin")).toBe(true);
  });

  // #501-T15
  it("keeps who confirmed the billing profile: the confirmation moves to the admin when the operator is retired", async () => {
    const ctx = await setup();
    await adminAndImportedOperator(ctx);
    await ctx.db
      .insertInto("billing_profiles")
      .values({
        workspace_id: ctx.workspace.id,
        legal_name: "Example GmbH",
        country: "DE",
        address_line1: "Teststrasse 1",
        address_line2: null,
        postal_code: "10115",
        city: "Berlin",
        vat_id: null,
        confirmed_at: "2026-10-11T08:30:00.000Z",
        confirmed_by: "operator",
        terms_version: "2026-10-01",
        customer_adapter: null,
        customer_ref: null,
        created_at: "2026-10-11T08:00:00.000Z",
        updated_at: "2026-10-11T08:30:00.000Z",
      })
      .execute();

    expect(await ctx.link(ADMIN)).toEqual({ ok: true, outcome: "merged" });

    expect(
      await ctx.db
        .selectFrom("billing_profiles")
        .select(["confirmed_by", "confirmed_at", "terms_version"])
        .execute(),
    ).toEqual([
      {
        confirmed_by: "admin",
        confirmed_at: "2026-10-11T08:30:00.000Z",
        terms_version: "2026-10-01",
      },
    ]);
  });

  // #499-T04
  it("keeps who set the monthly limit: the author moves to the admin when the operator is retired", async () => {
    const ctx = await setup();
    await adminAndImportedOperator(ctx);
    await ctx.db
      .insertInto("billing_workspace_settings")
      .values({
        workspace_id: ctx.workspace.id,
        monthly_limit_micro_usd: 50_000_000,
        updated_by: "operator",
        updated_at: "2026-10-11T08:30:00.000Z",
      })
      .execute();

    expect(await ctx.link(ADMIN)).toEqual({ ok: true, outcome: "merged" });

    expect(
      await ctx.db
        .selectFrom("billing_workspace_settings")
        .select(["updated_by", "monthly_limit_micro_usd"])
        .execute(),
    ).toEqual([{ updated_by: "admin", monthly_limit_micro_usd: "50000000" }]);
  });

  // #751-T05
  it("keeps who started an Implementer task: session and turn move to the admin when the operator is retired", async () => {
    const ctx = await setup();
    await adminAndImportedOperator(ctx);
    const seed = await seedImplementerRepository(ctx.db, ctx.workspace.id, "w");
    await startTask(
      ctx.db,
      ctx.workspace.id,
      taskOf(seed, { createdBy: "operator" }),
      seed.repoUrl,
    );

    expect(await ctx.link(ADMIN)).toEqual({ ok: true, outcome: "merged" });

    expect(
      await ctx.db
        .selectFrom("implementer_sessions")
        .select("created_by")
        .execute(),
    ).toEqual([{ created_by: "admin" }]);
    expect(
      await ctx.db
        .selectFrom("implementer_turns")
        .select("created_by")
        .execute(),
    ).toEqual([{ created_by: "admin" }]);
  });

  // #102-GH-25
  it("keeps the higher role where both are members, in either direction, without a duplicate membership", async () => {
    const ctx = await setup();
    await adminAndImportedOperator(ctx);
    const other = await ctx.workspaces.create({
      name: "Other",
      slug: "other",
      createdBy: null,
    });
    await ctx.workspaces.addMember(ctx.workspace.id, "admin", "member");
    await ctx.workspaces.addMember(ctx.workspace.id, "operator", "owner");
    await ctx.workspaces.addMember(other.id, "admin", "owner");
    await ctx.workspaces.addMember(other.id, "operator", "admin");

    const result = await ctx.link(ADMIN);

    expect(result.ok).toBe(true);
    const members = await ctx.db
      .selectFrom("workspace_members")
      .select(["workspace_id", "user_id", "role"])
      .orderBy("workspace_id")
      .execute();
    expect(members).toHaveLength(2);
    expect(members.find((m) => m.workspace_id === ctx.workspace.id)).toEqual({
      workspace_id: ctx.workspace.id,
      user_id: "admin",
      role: "owner",
    });
    expect(members.find((m) => m.workspace_id === other.id)).toEqual({
      workspace_id: other.id,
      user_id: "admin",
      role: "owner",
    });
  });

  // #102-GH-24
  it("refuses the identity of a user who has a password, with a clear code, and moves nothing", async () => {
    const ctx = await setup();
    await adminAndImportedOperator(ctx);
    await insertUser(ctx.db, {
      id: "with-password",
      email: "x@example.test",
      passwordHash: "x-hash",
      importedAt: "2026-10-11T08:00:00.000Z",
      githubId: "9999",
    });
    ctx.github.addUser({
      id: 9999,
      login: "with-password",
      name: "P",
      email: "x@example.test",
    });
    await ctx.workspaces.addMember(ctx.workspace.id, "with-password", "member");
    const before = await snapshot(ctx);

    const result = await ctx.link(ADMIN, "with-password");

    expect(result).toEqual({
      ok: false,
      error: "identity_has_other_credentials",
    });
    expect(await snapshot(ctx)).toEqual(before);
  });

  // #102-GH-25
  it("is not available to anybody but the instance admin, and not for a user the import did not mark", async () => {
    const ctx = await setup();
    await adminAndImportedOperator(ctx);
    await insertUser(ctx.db, {
      id: "member",
      email: "member@example.test",
      emailVerified: true,
      passwordHash: "m-hash",
    });
    await insertUser(ctx.db, {
      id: "later",
      email: "later@example.test",
      githubLogin: "later",
      githubId: "7777",
      emailVerified: true,
    });
    ctx.github.addUser({
      id: 7777,
      login: "later",
      name: "L",
      email: "later@example.test",
    });
    const before = await snapshot(ctx);

    const byMember = await ctx.link({ id: "member", sessionId: "s" });
    // A user created later (not imported), by the admin.
    const notImported = await ctx.link(ADMIN, "later");

    expect(byMember).toMatchObject({
      ok: false,
      error: "identity_belongs_to_other_user",
    });
    expect(notImported).toMatchObject({
      ok: false,
      error: "identity_belongs_to_other_user",
    });
    expect(await snapshot(ctx)).toEqual(before);
  });

  // #102-GH-28
  it("changes nothing when the merge fails halfway: all or nothing", async () => {
    const ctx = await setup({ failMergeAfterMove: true });
    await adminAndImportedOperator(ctx);
    await ctx.workspaces.addMember(ctx.workspace.id, "admin", "member");
    await ctx.workspaces.addMember(ctx.workspace.id, "operator", "owner");
    await ctx.db
      .updateTable("workspaces")
      .set({ created_by: "operator" })
      .execute();
    const before = await snapshot(ctx);

    const result = await ctx.link(ADMIN);

    expect(result).toMatchObject({ ok: false, error: "unavailable" });
    expect(await snapshot(ctx)).toEqual(before);
  });

  // #102-GH-28
  it("changes nothing without the GitHub authorization of the identity: no state, a used state, a refused code, a cancelled authorization", async () => {
    const ctx = await setup();
    await adminAndImportedOperator(ctx);
    const before = await snapshot(ctx);
    const started = await ctx.service.start(ADMIN);
    if (!started.ok) throw new Error("did not start");
    const back = await ctx.github.authorize(started.url, "octocat");
    const query = {
      code: back.searchParams.get("code"),
      state: back.searchParams.get("state"),
      error: null,
    };
    const second = await ctx.service.start(ADMIN);
    if (!second.ok) throw new Error("did not start");
    const cancelled = await ctx.github.deny(second.url);

    const results = [
      await ctx.service.complete(ADMIN, {
        code: "x",
        state: null,
        error: null,
      }),
      await ctx.service.complete(ADMIN, { code: "x", state: "", error: null }),
      await ctx.service.complete(ADMIN, {
        ...query,
        code: "a-code-github-never-issued",
      }),
      await ctx.service.complete(ADMIN, {
        code: cancelled.searchParams.get("code"),
        state: cancelled.searchParams.get("state"),
        error: cancelled.searchParams.get("error"),
      }),
    ];

    expect(results.map((r) => (r.ok ? "ok" : r.error))).toEqual([
      "state_invalid",
      "state_invalid",
      "authorization_failed",
      "access_denied",
    ]);
    expect(await snapshot(ctx)).toEqual(before);
    // The state of the refused code was used up with it: the real code cannot be tried again.
    expect(await ctx.service.complete(ADMIN, query)).toMatchObject({
      ok: false,
      error: "state_invalid",
    });
    expect(await snapshot(ctx)).toEqual(before);
  });

  it("covers every table that refers to a user, so a later feature cannot forget the merge", async () => {
    const { db } = await createTestDatabase();
    const { sql } = await import("kysely");
    const { rows } = await sql<{
      table: string;
      column: string;
    }>`select cl.relname as "table", a.attname as "column"
      from pg_constraint c
      join pg_class cl on cl.oid = c.conrelid
      join pg_class target on target.oid = c.confrelid
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
      where c.contype = 'f' and target.relname = 'users' and cl.relnamespace = 'public'::regnamespace`.execute(
      db,
    );
    const found = rows.filter((row) => !row.table.startsWith("kysely_"));
    const { USER_REFERENCES } = await import("./merge.ts");

    expect(found.map((f) => `${f.table}.${f.column}`).sort()).toEqual(
      USER_REFERENCES.map((r) => `${r.table}.${r.column}`).sort(),
    );
  });
});

describe("linking a GitHub identity to an account", () => {
  async function passwordUser(ctx: Ctx, id = "person") {
    await insertUser(ctx.db, {
      id,
      email: `${id}@example.test`,
      emailVerified: true,
      passwordHash: `${id}-hash`,
    });
    return { id, sessionId: `session-${id}` } satisfies LinkActor;
  }

  it("links an identity nobody has to the signed-in account and shows its login", async () => {
    const ctx = await setup();
    const person = await passwordUser(ctx);

    const result = await ctx.link(person);

    expect(result).toEqual({ ok: true, outcome: "linked" });
    const account = await ctx.db
      .selectFrom("accounts")
      .selectAll()
      .where("provider_id", "=", "github")
      .executeTakeFirstOrThrow();
    expect(account).toMatchObject({
      user_id: "person",
      account_id: String(OCTOCAT.id),
      access_token: null,
      refresh_token: null,
    });
    const user = await ctx.db
      .selectFrom("users")
      .select(["github_login", "email"])
      .where("id", "=", "person")
      .executeTakeFirstOrThrow();
    expect(user).toEqual({
      github_login: "octocat",
      email: "person@example.test",
    });
  });

  it("does not need the GitHub address to match the one of the account: the person is signed in", async () => {
    const ctx = await setup();
    const person = await passwordUser(ctx);

    const result = await ctx.link(person);

    expect(result.ok).toBe(true);
    expect(OCTOCAT.email).not.toBe("person@example.test");
  });

  it("is a no-op for an identity the account has already", async () => {
    const ctx = await setup();
    const person = await passwordUser(ctx);
    await ctx.link(person);

    const again = await ctx.link(person);

    expect(again).toEqual({
      ok: true,
      outcome: "already_linked",
    });
    expect(
      await ctx.db
        .selectFrom("accounts")
        .select("id")
        .where("provider_id", "=", "github")
        .execute(),
    ).toHaveLength(1);
  });

  it("refuses a second GitHub account for an account that has one already", async () => {
    const ctx = await setup();
    ctx.github.addUser({
      id: 2002,
      login: "second",
      name: "S",
      email: "s@example.test",
    });
    const person = await passwordUser(ctx);
    await ctx.link(person, "octocat");

    const result = await ctx.link(person, "second");

    expect(result).toMatchObject({ ok: false, error: "already_linked" });
  });

  it("never links an identity that belongs to another user, whatever the addresses say", async () => {
    const ctx = await setup();
    const owner = await passwordUser(ctx, "owner");
    await ctx.link(owner);
    const thief = await passwordUser(ctx, "thief");
    const before = await snapshot(ctx);

    const result = await ctx.link(thief);

    expect(result).toMatchObject({
      ok: false,
      error: "identity_belongs_to_other_user",
    });
    expect(await snapshot(ctx)).toEqual(before);
  });

  it("lets only one of two requests that link the same identity at the same moment win", async () => {
    const ctx = await setup();
    const a = await passwordUser(ctx, "a");
    const b = await passwordUser(ctx, "b");
    const [startedA, startedB] = await Promise.all([
      ctx.service.start(a),
      ctx.service.start(b),
    ]);
    if (!startedA.ok || !startedB.ok) throw new Error("did not start");
    const [backA, backB] = await Promise.all([
      ctx.github.authorize(startedA.url, "octocat"),
      ctx.github.authorize(startedB.url, "octocat"),
    ]);
    const callback = (actor: LinkActor, back: URL) =>
      ctx.service.complete(actor, {
        code: back.searchParams.get("code"),
        state: back.searchParams.get("state"),
        error: null,
      });

    const results = await Promise.all([callback(a, backA), callback(b, backB)]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(
      await ctx.db
        .selectFrom("accounts")
        .select("id")
        .where("provider_id", "=", "github")
        .execute(),
    ).toHaveLength(1);
  });
});

describe("the state of the linking", () => {
  it("is bound to the person and the session that started it, works once and expires", async () => {
    const ctx = await setup();
    await insertUser(ctx.db, {
      id: "person",
      passwordHash: "h",
      emailVerified: true,
    });
    await insertUser(ctx.db, {
      id: "someone",
      passwordHash: "h",
      emailVerified: true,
    });
    const actor: LinkActor = { id: "person", sessionId: "s1" };
    const startedFor = async () => {
      const started = await ctx.service.start(actor);
      if (!started.ok) throw new Error("did not start");
      const back = await ctx.github.authorize(started.url, "octocat");
      return {
        code: back.searchParams.get("code"),
        state: back.searchParams.get("state"),
        error: null,
      };
    };
    const foreign = await startedFor();
    const otherSession = await startedFor();
    const expired = await startedFor();
    const used = await startedFor();

    expect(
      await ctx.service.complete({ id: "someone", sessionId: "s1" }, foreign),
    ).toMatchObject({ ok: false, error: "state_invalid" });
    expect(
      await ctx.service.complete(
        { id: "person", sessionId: "s2" },
        otherSession,
      ),
    ).toMatchObject({ ok: false, error: "state_invalid" });
    expect(await ctx.service.complete(actor, used)).toMatchObject({ ok: true });
    expect(await ctx.service.complete(actor, used)).toMatchObject({
      ok: false,
      error: "state_invalid",
    });
    ctx.clock.at = new Date(ctx.clock.at.getTime() + 11 * 60 * 1000);
    expect(await ctx.service.complete(actor, expired)).toMatchObject({
      ok: false,
      error: "state_invalid",
    });
  });

  it("starts at GitHub with PKCE, the client id and the callback address, and no secret or scope in the address", async () => {
    const ctx = await setup();
    await insertUser(ctx.db, { id: "person", passwordHash: "h" });

    const started = await ctx.service.start({
      id: "person",
      sessionId: "s1",
    });

    if (!started.ok) throw new Error("did not start");
    const url = new URL(started.url);
    expect(url.origin).toBe(ctx.github.baseUrl);
    expect(url.searchParams.get("client_id")).toBe(TEST_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${TEST_BASE_URL}/api/auth/callback/github`,
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
    expect(url.searchParams.get("scope")).toBeNull();
    expect(started.url).not.toContain(TEST_CLIENT_SECRET);
  });

  it("is limited per person", async () => {
    const ctx = await setup();
    await insertUser(ctx.db, { id: "person", passwordHash: "h" });
    const actor: LinkActor = { id: "person", sessionId: "s1" };

    const results = [];
    for (let i = 0; i < LINK_USER_MAX + 2; i += 1)
      results.push(await ctx.service.start(actor));

    expect(results.filter((r) => r.ok)).toHaveLength(LINK_USER_MAX);
    expect(results.at(-1)).toMatchObject({ ok: false, error: "rate_limited" });
  });

  it("lets a dozen people each use their own allowance without running into the instance limit", async () => {
    const ctx = await setup();

    const results = [];
    for (let person = 0; person < 12; person += 1) {
      const id = `person-${String(person)}`;
      await insertUser(ctx.db, { id, passwordHash: "h" });
      for (let i = 0; i < LINK_USER_MAX; i += 1)
        results.push(await ctx.service.start({ id, sessionId: `s-${id}` }));
    }

    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("refuses a start while the user authorization is not configured", async () => {
    const ctx = await setup();
    const none = createGithubLinkService({
      db: ctx.db,
      signedStates: ctx.signedStates,
      rateLimits: createRateLimitsRepository(ctx.db),
      authorization: async () => null,
      publicUrl: TEST_BASE_URL,
      oauthBaseUrl: ctx.github.baseUrl,
      apiBaseUrl: ctx.github.baseUrl,
    });

    expect(await none.start(ADMIN)).toEqual({
      ok: false,
      error: "github_not_configured",
    });
  });
});

describe("the handlers of the linking", () => {
  async function handlers() {
    const ctx = await setup();
    await insertUser(ctx.db, {
      id: "person",
      passwordHash: "h",
      emailVerified: true,
    });
    const session = {
      current: { userId: "person", sessionId: "s1" } as {
        userId: string;
        sessionId: string;
      } | null,
    };
    const callback = createLinkCallbackHandler({
      session: async () => session.current,
      service: ctx.service,
    });
    const start = createStartLinkHandler({
      requireUser: async () => ({ id: "person" }) as never,
      sessionId: async () => "s1",
      service: ctx.service,
    });
    return { ctx, session, callback, start };
  }

  it("answers the address of GitHub's authorization page to a same-site JSON request", async () => {
    const { start } = await handlers();

    const response = await start(
      new Request("https://app.test/api/account/github/link", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://app.test",
          host: "app.test",
        },
        body: "{}",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()) as { ok: boolean }).toMatchObject({
      ok: true,
    });
  });

  it("refuses a cross-site request to start", async () => {
    const { start } = await handlers();

    const response = await start(
      new Request("https://app.test/api/account/github/link", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "sec-fetch-site": "cross-site",
        },
        body: "{}",
      }),
    );

    expect(response.status).toBe(403);
  });

  it("takes only the callbacks whose state is one of ours, and leaves the rest to Better Auth", async () => {
    const { callback } = await handlers();

    const better = await callback(
      new Request(
        "https://app.test/api/auth/callback/github?code=c&state=abcdefghijklmnopqrstuvwxyz012345",
      ),
    );
    const otherPath = await callback(
      new Request("https://app.test/api/auth/callback/other?code=c&state=a.b"),
    );

    expect(better).toBeNull();
    expect(otherPath).toBeNull();
  });

  it("sends the person to a fixed page with a code from its own list, whatever extra parameters the address carries", async () => {
    const { ctx, callback } = await handlers();
    const actor: LinkActor = { id: "person", sessionId: "s1" };
    const started = await ctx.service.start(actor);
    if (!started.ok) throw new Error("did not start");
    const back = await ctx.github.authorize(started.url, "octocat");
    back.searchParams.set("redirect", "https://evil.example/");
    back.searchParams.set("next", "//evil.example");

    const response = await callback(
      new Request(`https://app.test${back.pathname}${back.search}`),
    );

    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toBe("/account?github=linked");
    expect(response?.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("reports a refusal as a code of the list and a fixed page, never text from the request", async () => {
    const { callback } = await handlers();

    const response = await callback(
      new Request(
        "https://app.test/api/auth/callback/github?code=c&state=forged.value",
      ),
    );

    expect(response?.headers.get("location")).toBe(
      "/account?github_error=state_invalid",
    );
  });

  it("sends a browser without a session to the login page and exchanges nothing", async () => {
    const { ctx, session, callback } = await handlers();
    session.current = null;
    const before = ctx.github.requests().length;

    const response = await callback(
      new Request(
        "https://app.test/api/auth/callback/github?code=c&state=forged.value",
      ),
    );

    expect(response?.headers.get("location")).toBe("/login");
    expect(ctx.github.requests().length).toBe(before);
  });
});
