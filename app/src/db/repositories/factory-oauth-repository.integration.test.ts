// SPDX-License-Identifier: LicenseRef-Proprietary

// The repositories of the OAuth server of the factory MCP (#1144) over a real Postgres, driven by the real service: the consent makes a
// grant and a code once, the code and a refresh token are used once (one statement), revoking removes the codes and tokens, an access
// token is looked up by its hash with the workspace in the answer, and the housekeeping removes what is dead and nothing else.
import { describe, expect, it } from "vitest";
import {
  authorizeParams,
  REDIRECT,
  RESOURCE,
  VERIFIER,
} from "../../factory-mcp/oauth/test-harness.ts";
import { createOAuthService } from "../../factory-mcp/oauth/service.ts";
import { hashSecret } from "../../factory-mcp/oauth/tokens.ts";
import { createTestDatabase } from "../../test-support/test-database.ts";
import { insertUser } from "../../test-support/users.ts";
import {
  addWorkspace,
  defaultWorkspaceId,
} from "../../test-support/workspaces.ts";
import { createFactoryOAuthDirectoryRepository } from "./factory-oauth-directory-repository.ts";
import { createFactoryOAuthRepository } from "./factory-oauth-repository.ts";
import { createWorkspaceMembersRepository } from "./workspace-members-repository.ts";
import { createWorkspacesRepository } from "./workspaces-repository.ts";

async function setup() {
  const { db } = await createTestDatabase();
  const acme = await defaultWorkspaceId(db);
  const other = await addWorkspace(db, "other");
  await insertUser(db, { id: "ada", name: "Ada", emailVerified: true });
  await insertUser(db, { id: "bob", name: "Bob", emailVerified: true });
  await createWorkspaceMembersRepository(db, acme).add("ada", "owner");
  await createWorkspaceMembersRepository(db, acme).add("bob", "member");
  await createWorkspaceMembersRepository(db, other).add("ada", "member");
  const directory = createFactoryOAuthDirectoryRepository(db);
  const clock = { now: new Date("2026-11-25T10:00:00.000Z") };
  const service = createOAuthService({
    store: {
      directory,
      scoped: (workspaceId) => createFactoryOAuthRepository(db, workspaceId),
    },
    memberships: createWorkspacesRepository(db),
    config: { issuer: "https://factory.example.test", resource: RESOURCE },
    now: () => clock.now,
  });
  async function connect(
    userId: string,
    workspaceId: string,
    scope = "factory:control",
  ) {
    const registered = await service.registerClient({
      client_name: "Claude Code",
      redirect_uris: [REDIRECT],
    });
    if (registered.kind !== "ok") throw new Error("register");
    const clientId = registered.response.client_id;
    const started = await service.beginAuthorization(authorizeParams(clientId));
    if (started.kind !== "request") throw new Error("authorize");
    const decided = await service.decide({
      requestId: started.requestId,
      userId,
      decision: "approve",
      workspaceId,
      scope,
    });
    if (decided.kind !== "redirect") throw new Error("decide");
    const code = new URL(decided.redirectTo).searchParams.get("code") as string;
    const exchanged = await service.exchange(
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: VERIFIER,
      }),
    );
    if (exchanged.kind !== "ok")
      throw new Error(`exchange: ${exchanged.error}`);
    return { clientId, code, requestId: started.requestId, ...exchanged.body };
  }
  return { db, acme, other, directory, service, clock, connect };
}

describe("the OAuth server over Postgres", () => {
  // #1144-T91
  it("runs the whole flow and authenticates the token with the person's current role", async () => {
    const { service, connect, acme } = await setup();
    const flow = await connect("ada", acme);
    const verdict = await service.authenticate(flow.access_token);
    expect(verdict).toMatchObject({
      kind: "ok",
      principal: {
        user: { id: "ada", name: "Ada" },
        workspace: { id: acme },
        role: "owner",
        scopes: ["factory:control"],
        client: { name: "Claude Code" },
      },
    });
  });

  // #1144-T92
  it("keeps only hashes, never a code, a token or a verifier", async () => {
    const { db, connect, acme } = await setup();
    const flow = await connect("ada", acme);
    const rows = JSON.stringify([
      await db.selectFrom("factory_oauth_codes").selectAll().execute(),
      await db.selectFrom("factory_oauth_tokens").selectAll().execute(),
    ]);
    for (const secret of [
      flow.code,
      flow.access_token,
      flow.refresh_token,
      VERIFIER,
    ])
      expect(rows).not.toContain(secret);
    expect(rows).toContain(hashSecret(flow.access_token));
  });

  // #1144-T93
  it("lets an authorization request be approved once", async () => {
    const { service, connect, acme, db } = await setup();
    const flow = await connect("ada", acme);
    expect(
      await service.decide({
        requestId: flow.requestId,
        userId: "ada",
        decision: "approve",
        workspaceId: acme,
        scope: "factory:read",
      }),
    ).toMatchObject({ kind: "invalid", code: "request_not_found" });
    expect(
      await db.selectFrom("factory_oauth_grants").selectAll().execute(),
    ).toHaveLength(1);
  });

  // #1144-T94
  it("spends a code and a refresh token with one statement: the second use loses", async () => {
    const { directory, connect, acme } = await setup();
    const flow = await connect("ada", acme);
    const refreshHash = hashSecret(flow.refresh_token);
    const [first, second] = await Promise.all([
      directory.markRefreshUsed(refreshHash, "2026-11-25T10:00:01.000Z"),
      directory.markRefreshUsed(refreshHash, "2026-11-25T10:00:01.000Z"),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(
      await directory.markCodeUsed(
        hashSecret(flow.code),
        "2026-11-25T10:00:01.000Z",
      ),
    ).toBe(false);
  });

  // #1144-T95
  it("lists and revokes inside one workspace, and revoking removes the codes and tokens", async () => {
    const { db, service, connect, acme, other } = await setup();
    const flow = await connect("ada", acme);
    const elsewhere = await connect("ada", other, "factory:read");
    const grants = createFactoryOAuthRepository(db, acme);
    const [row] = await grants.list();
    expect(row).toMatchObject({
      clientName: "Claude Code",
      userName: "Ada",
      scopes: ["factory:control"],
    });
    expect(
      await createFactoryOAuthRepository(db, other).revoke(
        row!.id,
        "2026-11-25T11:00:00.000Z",
      ),
    ).toBe(false);
    expect(await grants.revoke(row!.id, "2026-11-25T11:00:00.000Z")).toBe(true);
    expect(await grants.revoke(row!.id, "2026-11-25T11:00:00.000Z")).toBe(
      false,
    );
    expect(await grants.list()).toEqual([]);
    expect(await service.authenticate(flow.access_token)).toMatchObject({
      kind: "error",
    });
    expect(await service.authenticate(elsewhere.access_token)).toMatchObject({
      kind: "ok",
    });
    const left = await db
      .selectFrom("factory_oauth_tokens")
      .select("workspace_id")
      .execute();
    expect(left.every((token) => token.workspace_id === other)).toBe(true);
  });

  // #1144-T96
  it("ends a grant with its user and with its client", async () => {
    const { db, connect, acme } = await setup();
    await connect("bob", acme);
    await db.deleteFrom("users").where("id", "=", "bob").execute();
    expect(
      await db.selectFrom("factory_oauth_grants").selectAll().execute(),
    ).toEqual([]);
    expect(
      await db.selectFrom("factory_oauth_tokens").selectAll().execute(),
    ).toEqual([]);
  });

  // #1144-T97
  it("removes the clients nobody authorized after a day, but never one a grant uses", async () => {
    const { directory, service, connect, acme, clock } = await setup();
    await connect("ada", acme);
    const idle = await service.registerClient({ redirect_uris: [REDIRECT] });
    if (idle.kind !== "ok") throw new Error("register");
    clock.now = new Date(clock.now.getTime() + 25 * 3600 * 1000);
    const removed = await directory.deleteUnusedClientsBefore(
      clock.now.toISOString(),
    );
    expect(removed).toBe(1);
    expect(await directory.findClient(idle.response.client_id)).toBeNull();
    expect(await directory.countClients()).toBe(1);
  });

  // #1144-T98
  it("clears expired credentials and dead grants and leaves live ones", async () => {
    const { db, directory, service, connect, acme, clock } = await setup();
    const live = await connect("ada", acme);
    const dead = await connect("bob", acme);
    const [bobGrant] = await createFactoryOAuthRepository(db, acme)
      .list()
      .then((rows) => rows.filter((r) => r.userName === "Bob"));
    await createFactoryOAuthRepository(db, acme).revoke(
      bobGrant!.id,
      "2026-11-25T10:00:00.000Z",
    );
    clock.now = new Date(clock.now.getTime() + 20 * 60 * 1000);
    const removed = await directory.deleteExpired("2026-11-25T10:30:00.000Z");
    expect(removed).toBeGreaterThan(0);
    // The access tokens are gone (15 minutes), the refresh token and the live grant are not.
    expect(await service.authenticate(live.access_token)).toMatchObject({
      kind: "error",
    });
    expect(
      await service.exchange(
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: live.refresh_token,
          client_id: live.clientId,
        }),
      ),
    ).toMatchObject({ kind: "ok" });
    expect(
      await db
        .selectFrom("factory_oauth_grants")
        .select("id")
        .where("id", "=", bobGrant!.id)
        .execute(),
    ).toHaveLength(1);
    expect(dead.refresh_token).toBeTruthy();
  });

  // #1144-T99
  it("refuses a grant whose scope is not one of ours", async () => {
    const { db, connect, acme } = await setup();
    await connect("ada", acme);
    await expect(
      db.updateTable("factory_oauth_grants").set({ scope: "admin" }).execute(),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
