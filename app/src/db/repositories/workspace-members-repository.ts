// SPDX-License-Identifier: LicenseRef-Proprietary

// Access to the members of ONE workspace (the table `workspace_members`): who belongs to it and with which
// role. Created for a workspace like every repository of customer data (src/db/README.md, "Workspace
// scoping"); the questions that start from a user are in workspaces-repository.ts. The rules about who may
// change whom live in src/workspaces/members.ts; this module only reads and writes rows, and the methods
// that change a role or remove a member say whether a row was changed so the caller can tell a member from
// a stranger.
import "server-only";
import type { Kysely } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import { isWorkspaceRole, type WorkspaceRole } from "../workspace-roles.ts";
import type { WorkspaceId } from "../workspace-scope.ts";
import type { Database } from "../schema.ts";

export type Member = {
  userId: string;
  /** The display name of the account. Untrusted text. */
  name: string;
  email: string;
  role: WorkspaceRole;
  /** ISO 8601 text in UTC. */
  joinedAt: string;
  /** The numeric id of the member's GitHub account, as text, for the avatar; null without one (#638). */
  githubAccountId: string | null;
};

export type WorkspaceMembersRepository = {
  /** Every member, in the order they joined. */
  list(): Promise<Member[]>;
  /** One member, or undefined when the user does not belong to this workspace. */
  get(userId: string): Promise<Member | undefined>;
  /** The current GitHub login of every member, in the order they joined (`ticket.requestReview` with "project members", #917). */
  githubLogins(): Promise<string[]>;
  /** How many Owners the workspace has. */
  countOwners(): Promise<number>;
  /**
   * Makes the user a member with the role. A user who is a member already keeps their role (nothing is
   * downgraded or promoted by a second invitation); the answer says which of the two happened.
   */
  add(userId: string, role: WorkspaceRole): Promise<"added" | "existing">;
  /** Gives the member another role. False when the user is not a member. */
  setRole(userId: string, role: WorkspaceRole): Promise<boolean>;
  /** Takes the user out. False when the user is not a member. */
  remove(userId: string): Promise<boolean>;
  /**
   * Takes the lock that serializes changes of the members of this workspace for the rest of the
   * transaction (a write to the workspace row, which every other change of the members waits for).
   * Call it first in a transaction that reads the owners and then changes them.
   */
  lock(): Promise<void>;
};

export function createWorkspaceMembersRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  now: () => Date = () => new Date(),
): WorkspaceMembersRepository {
  function members() {
    return (
      db
        .selectFrom("workspace_members")
        .innerJoin("users", "users.id", "workspace_members.user_id")
        // At most one GitHub account per user (the unique index accounts_user_provider).
        .leftJoin("accounts", (join) =>
          join
            .onRef("accounts.user_id", "=", "users.id")
            .on("accounts.provider_id", "=", "github"),
        )
        .select([
          "workspace_members.user_id as user_id",
          "workspace_members.role as role",
          "workspace_members.created_at as joined_at",
          "users.name as name",
          "users.email as email",
          "accounts.account_id as github_account_id",
        ])
        .where("workspace_members.workspace_id", "=", workspaceId)
    );
  }

  function toMember(row: {
    user_id: string;
    role: string;
    joined_at: string;
    name: string;
    email: string;
    github_account_id: string | null;
  }): Member {
    if (!isWorkspaceRole(row.role))
      throw new Error(`The database holds an unknown role "${row.role}".`);
    return {
      userId: row.user_id,
      name: row.name,
      email: row.email,
      role: row.role,
      joinedAt: row.joined_at,
      githubAccountId: row.github_account_id,
    };
  }

  return {
    async list() {
      const rows = await members()
        .orderBy("workspace_members.created_at")
        .orderBy("workspace_members.user_id")
        .execute();
      return rows.map(toMember);
    },

    async get(userId) {
      const row = await members()
        .where("workspace_members.user_id", "=", userId)
        .executeTakeFirst();
      return row === undefined ? undefined : toMember(row);
    },

    async githubLogins() {
      const rows = await db
        .selectFrom("workspace_members")
        .innerJoin("users", "users.id", "workspace_members.user_id")
        .select("users.github_login as github_login")
        .where("workspace_members.workspace_id", "=", workspaceId)
        .orderBy("workspace_members.created_at")
        .orderBy("workspace_members.user_id")
        .execute();
      return rows.flatMap((row) =>
        typeof row.github_login === "string" && row.github_login !== ""
          ? [row.github_login]
          : [],
      );
    },

    async countOwners() {
      const row = await db
        .selectFrom("workspace_members")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .where("workspace_id", "=", workspaceId)
        .where("role", "=", "owner")
        .executeTakeFirstOrThrow();
      return Number(row.count);
    },

    async add(userId, role) {
      const result = await db
        .insertInto("workspace_members")
        .values({
          workspace_id: workspaceId,
          user_id: userId,
          role,
          created_at: formatTimestamp(now()),
        })
        .onConflict((conflict) =>
          conflict.columns(["workspace_id", "user_id"]).doNothing(),
        )
        .executeTakeFirst();
      return Number(result.numInsertedOrUpdatedRows ?? 0) === 1
        ? "added"
        : "existing";
    },

    async setRole(userId, role) {
      const result = await db
        .updateTable("workspace_members")
        .set({ role })
        .where("workspace_id", "=", workspaceId)
        .where("user_id", "=", userId)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },

    async remove(userId) {
      const result = await db
        .deleteFrom("workspace_members")
        .where("workspace_id", "=", workspaceId)
        .where("user_id", "=", userId)
        .executeTakeFirst();
      return Number(result.numDeletedRows) === 1;
    },

    async lock() {
      await db
        .updateTable("workspaces")
        .set((eb) => ({ id: eb.ref("id") }))
        .where("id", "=", workspaceId)
        .execute();
    },
  };
}
