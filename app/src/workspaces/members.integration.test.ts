// SPDX-License-Identifier: LicenseRef-Proprietary

// Who may change the members of a workspace, through the real service over a real Postgres database: nobody can
// hand out a rank, an Admin cannot touch an Owner or another Admin, and the last Owner stays. Every refusal
// leaves the table exactly as it was, and the role that counts is the one in the database at that moment.
import { describe, expect, it } from "vitest";
import {
  createWorkspaceHarness,
  type WorkspaceHarness,
} from "../test-support/workspace-harness.ts";

async function team() {
  const h = await createWorkspaceHarness();
  const workspace = await h.addWorkspace("acme");
  const owner = await h.addMember(workspace, "owner-1", "owner");
  const owner2 = await h.addMember(workspace, "owner-2", "owner");
  const admin = await h.addMember(workspace, "admin-1", "admin");
  const admin2 = await h.addMember(workspace, "admin-2", "admin");
  const member = await h.addMember(workspace, "member-1", "member");
  const member2 = await h.addMember(workspace, "member-2", "member");
  return { h, workspace, owner, owner2, admin, admin2, member, member2 };
}

async function roles(h: WorkspaceHarness, workspaceId: string) {
  return Object.fromEntries(
    (await h.workspaces.listForUser("owner-1")).length === 0
      ? []
      : (
          await h.db
            .selectFrom("workspace_members")
            .select(["user_id", "role"])
            .where("workspace_id", "=", workspaceId)
            .orderBy("user_id")
            .execute()
        ).map((row) => [row.user_id, row.role]),
  );
}

describe("changing the role of a member", () => {
  // #101-WM-27
  it("lets an Owner change the role of an Admin and of a Member", async () => {
    const { h, workspace } = await team();

    for (const [target, role] of [
      ["admin-1", "member"],
      ["member-1", "admin"],
      ["admin-2", "owner"],
    ] as const) {
      const result = await h.members.changeRole({
        workspaceId: workspace.id,
        actorId: "owner-1",
        targetUserId: target,
        role,
      });
      expect(result).toEqual({ ok: true, changed: true });
      expect(await h.roleOf(workspace.id, target)).toBe(role);
    }
  });

  // #101-WM-11
  it.each(["admin-1", "member-1"])(
    "refuses %s every role change, also one that raises a Member to Admin or lowers an Owner",
    async (actor) => {
      const { h, workspace } = await team();
      const before = await roles(h, workspace.id);

      for (const [target, role] of [
        ["member-2", "admin"],
        ["member-2", "owner"],
        [actor, "owner"],
        ["owner-2", "member"],
        ["admin-2", "member"],
      ] as const) {
        expect(
          await h.members.changeRole({
            workspaceId: workspace.id,
            actorId: actor,
            targetUserId: target,
            role,
          }),
          `${actor} sets ${target} to ${role}`,
        ).toEqual({ ok: false, error: "forbidden" });
      }

      expect(await roles(h, workspace.id)).toEqual(before);
    },
  );

  // #101-WM-09
  it("refuses to demote the only Owner and keeps the role", async () => {
    const h = await createWorkspaceHarness();
    const workspace = await h.addWorkspace("solo");
    await h.addMember(workspace, "only", "owner");
    await h.addMember(workspace, "other", "admin");

    const result = await h.members.changeRole({
      workspaceId: workspace.id,
      actorId: "only",
      targetUserId: "only",
      role: "admin",
    });

    expect(result).toEqual({ ok: false, error: "last_owner" });
    expect(await h.roleOf(workspace.id, "only")).toBe("owner");
  });

  // #101-WM-09
  it("lets an Owner demote themselves while another Owner remains, and then protects the last one", async () => {
    const { h, workspace } = await team();

    const first = await h.members.changeRole({
      workspaceId: workspace.id,
      actorId: "owner-1",
      targetUserId: "owner-1",
      role: "member",
    });
    const second = await h.members.changeRole({
      workspaceId: workspace.id,
      actorId: "owner-2",
      targetUserId: "owner-2",
      role: "admin",
    });

    expect(first).toEqual({ ok: true, changed: true });
    expect(second).toEqual({ ok: false, error: "last_owner" });
  });

  it("changes nothing and says so when the member has that role already", async () => {
    const { h, workspace } = await team();

    expect(
      await h.members.changeRole({
        workspaceId: workspace.id,
        actorId: "owner-1",
        targetUserId: "member-1",
        role: "member",
      }),
    ).toEqual({ ok: true, changed: false });
  });

  it("refuses a role that does not exist and a member who is not in the workspace", async () => {
    const { h, workspace } = await team();
    await h.addUser("stranger");

    expect(
      await h.members.changeRole({
        workspaceId: workspace.id,
        actorId: "owner-1",
        targetUserId: "member-1",
        role: "superuser",
      }),
    ).toEqual({ ok: false, error: "invalid_role" });
    expect(
      await h.members.changeRole({
        workspaceId: workspace.id,
        actorId: "owner-1",
        targetUserId: "stranger",
        role: "member",
      }),
    ).toEqual({ ok: false, error: "member_not_found" });
  });

  // #101-WM-07
  it("is not there for a person who is not a member of the workspace, however high their role is elsewhere", async () => {
    const { h, workspace } = await team();
    const other = await h.addWorkspace("other");
    await h.addMember(other, "other-owner", "owner");

    const result = await h.members.changeRole({
      workspaceId: workspace.id,
      actorId: "other-owner",
      targetUserId: "member-1",
      role: "owner",
    });

    expect(result).toEqual({ ok: false, error: "not_found" });
    expect(await h.roleOf(workspace.id, "member-1")).toBe("member");
  });

  it("uses the role the person has now, not the one they had when they signed in", async () => {
    const { h, workspace } = await team();
    await h.members.changeRole({
      workspaceId: workspace.id,
      actorId: "owner-1",
      targetUserId: "owner-2",
      role: "member",
    });

    const result = await h.members.changeRole({
      workspaceId: workspace.id,
      actorId: "owner-2",
      targetUserId: "member-1",
      role: "admin",
    });

    expect(result).toEqual({ ok: false, error: "forbidden" });
  });
});

describe("removing a member and leaving", () => {
  /** An AI app the person connected to the factory MCP in the workspace (#1144): a connected grant with its tokens. */
  async function connectApp(
    h: WorkspaceHarness,
    workspaceId: string,
    userId: string,
    id: string,
  ) {
    await h.db
      .insertInto("factory_oauth_clients")
      .values({
        id: `client-${id}`,
        name: "Claude Code",
        redirect_uris: "[]",
        created_at: "2026-11-25T08:00:00.000Z",
      })
      .onConflict((conflict) => conflict.doNothing())
      .execute();
    await h.db
      .insertInto("factory_oauth_grants")
      .values({
        id,
        workspace_id: workspaceId,
        user_id: userId,
        client_id: `client-${id}`,
        scope: "factory:control",
        resource: "https://factory.example.test/api/mcp",
        created_at: "2026-11-25T08:00:00.000Z",
        connected_at: "2026-11-25T08:00:01.000Z",
        last_used_at: null,
        revoked_at: null,
      })
      .execute();
    await h.db
      .insertInto("factory_oauth_tokens")
      .values({
        token_hash: `token-${id}`,
        grant_id: id,
        workspace_id: workspaceId,
        kind: "refresh",
        created_at: "2026-11-25T08:00:01.000Z",
        expires_at: "2099-01-01T00:00:00.000Z",
        used_at: null,
      })
      .execute();
  }

  async function grantsOf(h: WorkspaceHarness) {
    return h.db
      .selectFrom("factory_oauth_grants")
      .select(["id", "revoked_at"])
      .orderBy("id")
      .execute();
  }

  // #1144-T240
  it("revokes the AI apps a person connected when they are removed, and only theirs in this workspace", async () => {
    const { h, workspace } = await team();
    const other = await h.addWorkspace("other");
    await h.workspaces.addMember(other.id, "member-1", "member");
    await connectApp(h, workspace.id, "member-1", "mine");
    await connectApp(h, workspace.id, "member-2", "colleague");
    await connectApp(h, other.id, "member-1", "elsewhere");

    await h.members.remove({
      workspaceId: workspace.id,
      actorId: "admin-1",
      targetUserId: "member-1",
    });

    const grants = await grantsOf(h);
    expect(grants.map((g) => [g.id, g.revoked_at !== null])).toEqual([
      ["colleague", false],
      ["elsewhere", false],
      ["mine", true],
    ]);
    // Its codes and tokens are gone with it: a re-invitation does not bring the old grant back.
    expect(
      (
        await h.db
          .selectFrom("factory_oauth_tokens")
          .select("grant_id")
          .execute()
      )
        .map((t) => t.grant_id)
        .sort(),
    ).toEqual(["colleague", "elsewhere"]);
  });

  // #1144-T241
  it("revokes them when the person leaves by themselves too", async () => {
    const { h, workspace } = await team();
    await connectApp(h, workspace.id, "member-1", "mine");

    await h.members.remove({
      workspaceId: workspace.id,
      actorId: "member-1",
      targetUserId: "member-1",
    });

    expect((await grantsOf(h)).map((g) => g.revoked_at !== null)).toEqual([
      true,
    ]);
    expect(
      await h.db.selectFrom("factory_oauth_tokens").selectAll().execute(),
    ).toEqual([]);
  });

  // #1144-T242
  it("revokes nothing when the removal is refused", async () => {
    const { h, workspace } = await team();
    await connectApp(h, workspace.id, "owner-1", "owners");

    const result = await h.members.remove({
      workspaceId: workspace.id,
      actorId: "admin-1",
      targetUserId: "owner-1",
    });

    expect(result).toEqual({ ok: false, error: "forbidden" });
    expect((await grantsOf(h)).map((g) => g.revoked_at)).toEqual([null]);
  });

  // #101-WM-27
  it("lets an Owner remove an Owner while another Owner remains, an Admin and a Member", async () => {
    const { h, workspace } = await team();

    for (const target of ["owner-2", "admin-2", "member-2"]) {
      expect(
        await h.members.remove({
          workspaceId: workspace.id,
          actorId: "owner-1",
          targetUserId: target,
        }),
      ).toEqual({ ok: true, left: false });
      expect(await h.roleOf(workspace.id, target)).toBeUndefined();
    }
  });

  // #101-WM-27
  it("lets an Admin remove a Member", async () => {
    const { h, workspace } = await team();

    const result = await h.members.remove({
      workspaceId: workspace.id,
      actorId: "admin-1",
      targetUserId: "member-1",
    });

    expect(result).toEqual({ ok: true, left: false });
    expect(await h.roleOf(workspace.id, "member-1")).toBeUndefined();
  });

  // #101-WM-11
  it.each([
    ["admin-1", "owner-1"],
    ["admin-1", "owner-2"],
    ["admin-1", "admin-2"],
    ["member-1", "member-2"],
    ["member-1", "admin-1"],
    ["member-1", "owner-1"],
  ])("refuses %s to remove %s", async (actor, target) => {
    const { h, workspace } = await team();
    const before = await roles(h, workspace.id);

    const result = await h.members.remove({
      workspaceId: workspace.id,
      actorId: actor,
      targetUserId: target,
    });

    expect(result).toEqual({ ok: false, error: "forbidden" });
    expect(await roles(h, workspace.id)).toEqual(before);
  });

  // #101-WM-11
  it("answers a Member the same for a person who is not in the workspace as for one who is", async () => {
    const { h, workspace } = await team();
    await h.addUser("stranger");

    const result = await h.members.remove({
      workspaceId: workspace.id,
      actorId: "member-1",
      targetUserId: "stranger",
    });

    expect(result).toEqual({ ok: false, error: "forbidden" });
  });

  // #101-WM-09
  it.each(["owner", "admin", "member"] as const)(
    "lets a %s leave, and it ends their access",
    async (role) => {
      const { h, workspace } = await team();
      const actor = `${role}-1`;

      const result = await h.members.remove({
        workspaceId: workspace.id,
        actorId: actor,
        targetUserId: actor,
      });

      expect(result).toEqual({ ok: true, left: true });
      expect(await h.roleOf(workspace.id, actor)).toBeUndefined();
      expect(await h.workspaces.findMembership(actor, "acme")).toBeUndefined();
    },
  );

  // #101-WM-09
  it("refuses the only Owner to leave, and to be removed by themselves or by nobody else", async () => {
    const h = await createWorkspaceHarness();
    const workspace = await h.addWorkspace("solo");
    await h.addMember(workspace, "only", "owner");
    await h.addMember(workspace, "helper", "admin");

    const leaving = await h.members.remove({
      workspaceId: workspace.id,
      actorId: "only",
      targetUserId: "only",
    });
    const removedByAdmin = await h.members.remove({
      workspaceId: workspace.id,
      actorId: "helper",
      targetUserId: "only",
    });

    expect(leaving).toEqual({ ok: false, error: "last_owner" });
    expect(removedByAdmin).toEqual({ ok: false, error: "forbidden" });
    expect(await h.roleOf(workspace.id, "only")).toBe("owner");
  });

  // #101-WM-09
  it("lets one of two Owners leave and then keeps the other", async () => {
    const h = await createWorkspaceHarness();
    const workspace = await h.addWorkspace("duo");
    await h.addMember(workspace, "a", "owner");
    await h.addMember(workspace, "b", "owner");

    const first = await h.members.remove({
      workspaceId: workspace.id,
      actorId: "a",
      targetUserId: "a",
    });
    const second = await h.members.remove({
      workspaceId: workspace.id,
      actorId: "b",
      targetUserId: "b",
    });

    expect(first).toEqual({ ok: true, left: true });
    expect(second).toEqual({ ok: false, error: "last_owner" });
  });

  // #101-WM-07
  it("is not there for a person who is not a member, and removing a member of another workspace by id does nothing", async () => {
    const { h, workspace } = await team();
    const other = await h.addWorkspace("other");
    await h.addMember(other, "other-owner", "owner");

    const result = await h.members.remove({
      workspaceId: workspace.id,
      actorId: "other-owner",
      targetUserId: "member-1",
    });
    const wrongWorkspace = await h.members.remove({
      workspaceId: other.id,
      actorId: "other-owner",
      targetUserId: "member-1",
    });

    expect(result).toEqual({ ok: false, error: "not_found" });
    expect(wrongWorkspace).toEqual({ ok: false, error: "member_not_found" });
    expect(await h.roleOf(workspace.id, "member-1")).toBe("member");
  });
});

describe("renaming the workspace", () => {
  // #101-WM-27
  it("lets an Owner rename it and keeps the address", async () => {
    const { h, workspace } = await team();

    const result = await h.members.rename({
      workspaceId: workspace.id,
      actorId: "owner-1",
      name: "  New name  ",
    });

    expect(result).toEqual({ ok: true, name: "New name" });
    expect(await h.workspaces.get(workspace.id)).toMatchObject({
      name: "New name",
      slug: "acme",
    });
  });

  // #101-WM-11
  it.each(["admin-1", "member-1"])("refuses %s to rename it", async (actor) => {
    const { h, workspace } = await team();

    const result = await h.members.rename({
      workspaceId: workspace.id,
      actorId: actor,
      name: "Hijacked",
    });

    expect(result).toEqual({ ok: false, error: "forbidden" });
    expect((await h.workspaces.get(workspace.id))?.name).toBe("Workspace acme");
  });

  it("refuses an empty name, one with a line break, and a person from outside", async () => {
    const { h, workspace } = await team();
    await h.addUser("stranger");

    for (const name of ["", "A\r\nB", "x".repeat(81)])
      expect(
        await h.members.rename({
          workspaceId: workspace.id,
          actorId: "owner-1",
          name,
        }),
      ).toEqual({ ok: false, error: "invalid_name" });
    expect(
      await h.members.rename({
        workspaceId: workspace.id,
        actorId: "stranger",
        name: "Fine",
      }),
    ).toEqual({ ok: false, error: "not_found" });
  });
});

describe("the members list", () => {
  async function addAccount(
    h: WorkspaceHarness,
    userId: string,
    providerId: string,
    accountId: string,
  ) {
    const at = h.now().toISOString();
    await h.db
      .insertInto("accounts")
      .values({
        id: `${providerId}-${userId}`,
        account_id: accountId,
        provider_id: providerId,
        user_id: userId,
        access_token: null,
        refresh_token: null,
        id_token: null,
        access_token_expires_at: null,
        refresh_token_expires_at: null,
        scope: null,
        password: null,
        created_at: at,
        updated_at: at,
      })
      .execute();
  }

  // #638-T01
  it("carries the GitHub account id of a member who signs in with GitHub, and none for anybody else", async () => {
    const { h, workspace } = await team();
    await addAccount(h, "owner-1", "github", "4711");
    await addAccount(h, "admin-1", "credential", "admin-1");

    const members = await h.members.list(workspace.id);

    const ids = Object.fromEntries(
      members.map((m) => [m.userId, m.githubAccountId]),
    );
    expect(ids["owner-1"]).toBe("4711");
    expect(ids["admin-1"]).toBeNull();
    expect(ids["member-1"]).toBeNull();
    expect(members).toHaveLength(6);
  });
});
