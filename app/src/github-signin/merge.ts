// SPDX-License-Identifier: LicenseRef-Proprietary

// Merging the instance admin with an imported operator (docs/decisions/0001-editions-setup-and-accounts.md,
// section 2.5). In an existing installation the person who runs the instance exists twice after the short
// setup: as an imported user (a GitHub identity, no password) and as the instance admin (email and
// password). When the signed-in admin proves control of that GitHub identity (the authorization is done
// by the caller, link.ts), the imported user's memberships and history move to the admin, the higher role
// wins where both are members, the GitHub identity becomes the admin's, and the imported user's row is
// retired (deleted, with its sessions). One transaction, irreversible, all or nothing.
//
// The conditions are checked inside the transaction, against what is in the database at that moment:
// only a user marked as imported (`users.imported_at`) qualifies, never one created later; the user must
// have no credential besides the GitHub identity (no password); the acting user must be the instance
// admin and must not have a GitHub identity yet. Anything else changes nothing.
import type { Kysely, Transaction } from "kysely";
import { GITHUB_PROVIDER_ID } from "../auth/github-provider.ts";
import type { Database } from "../db/schema.ts";
import { WORKSPACE_ROLES, type WorkspaceRole } from "../db/workspace-roles.ts";

export const MERGE_ERROR_CODES = [
  /** The acting user is not the instance admin. */
  "merge_not_available",
  /** The GitHub identity belongs to nobody who qualifies: it is not an imported user's. */
  "identity_belongs_to_other_user",
  /** The user has another credential (a password): linking is refused, nothing moves. */
  "identity_has_other_credentials",
  /** The acting user has a GitHub identity already. */
  "already_linked",
] as const;
export type MergeErrorCode = (typeof MERGE_ERROR_CODES)[number];

export type MergeResult =
  { ok: true; movedMemberships: number } | { ok: false; error: MergeErrorCode };

/**
 * Every column that points to a user and what the merge does with it. A table that references `users` and
 * is not listed here fails `merge.integration.test.ts`, so a later feature that stores a user id (an
 * invitation's author, a billing owner) cannot forget the merge.
 *
 * - `move`: the rows are re-assigned to the acting user.
 * - `membership`: workspace members, merged by role.
 * - `ends`: the rows go with the retired user (a session, a token); nothing of the history.
 */
export const USER_REFERENCES: ReadonlyArray<{
  table: string;
  column: string;
  handling: "move" | "membership" | "ends";
}> = [
  { table: "sessions", column: "user_id", handling: "ends" },
  { table: "accounts", column: "user_id", handling: "ends" },
  { table: "password_reset_tokens", column: "user_id", handling: "ends" },
  { table: "email_verification_tokens", column: "user_id", handling: "ends" },
  { table: "signed_states", column: "user_id", handling: "ends" },
  { table: "plan_handoff_tokens", column: "user_id", handling: "ends" },
  { table: "workspace_members", column: "user_id", handling: "membership" },
  { table: "workspaces", column: "created_by", handling: "move" },
  { table: "instance_settings", column: "updated_by", handling: "move" },
  { table: "model_catalog_entries", column: "updated_by", handling: "move" },
  { table: "secrets", column: "updated_by", handling: "move" },
  { table: "workspace_secrets", column: "updated_by", handling: "move" },
  { table: "workspace_entitlements", column: "updated_by", handling: "move" },
  { table: "billing_profiles", column: "confirmed_by", handling: "move" },
  {
    table: "billing_workspace_settings",
    column: "updated_by",
    handling: "move",
  },
  { table: "implementer_sessions", column: "created_by", handling: "move" },
  { table: "implementer_turns", column: "created_by", handling: "move" },
  { table: "invitations", column: "invited_by", handling: "move" },
  { table: "invitations", column: "accepted_by", handling: "move" },
  {
    table: "installation_link_requests",
    column: "requested_by",
    handling: "move",
  },
  {
    table: "installation_link_requests",
    column: "decided_by",
    handling: "move",
  },
];

function higher(a: WorkspaceRole, b: WorkspaceRole): WorkspaceRole {
  // WORKSPACE_ROLES lists the roles from the most to the least powerful.
  return WORKSPACE_ROLES.indexOf(a) <= WORKSPACE_ROLES.indexOf(b) ? a : b;
}

export type MergeOptions = {
  /** The instance admin who proved control of the identity, and is signed in. */
  actingUserId: string;
  /** The numeric GitHub id the admin authorized, as text. */
  githubId: string;
  /** Tests only: runs inside the transaction after the data moved, and throws to simulate a failure. */
  beforeCommit?: (trx: Transaction<Database>) => Promise<void>;
};

/**
 * Merges the imported user who owns `githubId` into the acting admin, in one transaction. Returns a code
 * when a condition is not met, and rejects (after rolling back) when the database fails.
 */
export async function mergeImportedUser(
  db: Kysely<Database>,
  { actingUserId, githubId, beforeCommit }: MergeOptions,
): Promise<MergeResult> {
  return db.transaction().execute(async (trx): Promise<MergeResult> => {
    const actor = await trx
      .selectFrom("users")
      .select(["id", "is_instance_admin", "github_login", "image"])
      .where("id", "=", actingUserId)
      .executeTakeFirst();
    if (actor === undefined || actor.is_instance_admin !== 1)
      return { ok: false, error: "merge_not_available" };

    const identity = await trx
      .selectFrom("accounts")
      .select(["id", "user_id"])
      .where("provider_id", "=", GITHUB_PROVIDER_ID)
      .where("account_id", "=", githubId)
      .executeTakeFirst();
    if (identity === undefined || identity.user_id === actingUserId)
      return { ok: false, error: "identity_belongs_to_other_user" };

    const source = await trx
      .selectFrom("users")
      .select(["id", "imported_at", "github_login", "image"])
      .where("id", "=", identity.user_id)
      .executeTakeFirst();
    if (source === undefined)
      return { ok: false, error: "identity_belongs_to_other_user" };

    // A user who can sign in another way (a password) is not merged, whoever they are: linking is refused
    // and nothing moves.
    const other = await trx
      .selectFrom("accounts")
      .select("id")
      .where("user_id", "=", source.id)
      .where("id", "!=", identity.id)
      .execute();
    if (other.length > 0)
      return { ok: false, error: "identity_has_other_credentials" };
    // Only a user the import marked qualifies; a user created later never does.
    if (source.imported_at === null)
      return { ok: false, error: "identity_belongs_to_other_user" };

    const actorIdentity = await trx
      .selectFrom("accounts")
      .select("id")
      .where("user_id", "=", actingUserId)
      .where("provider_id", "=", GITHUB_PROVIDER_ID)
      .executeTakeFirst();
    if (actorIdentity !== undefined)
      return { ok: false, error: "already_linked" };

    // Memberships: the higher role wins where both are members; nobody ends up twice.
    const sourceMemberships = await trx
      .selectFrom("workspace_members")
      .select(["workspace_id", "role"])
      .where("user_id", "=", source.id)
      .execute();
    for (const membership of sourceMemberships) {
      const own = await trx
        .selectFrom("workspace_members")
        .select("role")
        .where("workspace_id", "=", membership.workspace_id)
        .where("user_id", "=", actingUserId)
        .executeTakeFirst();
      if (own === undefined) {
        await trx
          .updateTable("workspace_members")
          .set({ user_id: actingUserId })
          .where("workspace_id", "=", membership.workspace_id)
          .where("user_id", "=", source.id)
          .execute();
        continue;
      }
      const role = higher(
        own.role as WorkspaceRole,
        membership.role as WorkspaceRole,
      );
      if (role !== own.role)
        await trx
          .updateTable("workspace_members")
          .set({ role })
          .where("workspace_id", "=", membership.workspace_id)
          .where("user_id", "=", actingUserId)
          .execute();
      await trx
        .deleteFrom("workspace_members")
        .where("workspace_id", "=", membership.workspace_id)
        .where("user_id", "=", source.id)
        .execute();
    }

    // The history that names the user.
    await trx
      .updateTable("workspaces")
      .set({ created_by: actingUserId })
      .where("created_by", "=", source.id)
      .execute();
    await trx
      .updateTable("instance_settings")
      .set({ updated_by: actingUserId })
      .where("updated_by", "=", source.id)
      .execute();
    await trx
      .updateTable("model_catalog_entries")
      .set({ updated_by: actingUserId })
      .where("updated_by", "=", source.id)
      .execute();
    await trx
      .updateTable("secrets")
      .set({ updated_by: actingUserId })
      .where("updated_by", "=", source.id)
      .execute();

    await trx
      .updateTable("workspace_secrets")
      .set({ updated_by: actingUserId })
      .where("updated_by", "=", source.id)
      .execute();
    await trx
      .updateTable("workspace_entitlements")
      .set({ updated_by: actingUserId })
      .where("updated_by", "=", source.id)
      .execute();
    // Who confirmed that the billing profile is a business's: the time and the terms stay, the author must not become null.
    await trx
      .updateTable("billing_profiles")
      .set({ confirmed_by: actingUserId })
      .where("confirmed_by", "=", source.id)
      .execute();

    // Who set the monthly limit: the audit pointer stays with a person, not null.
    await trx
      .updateTable("billing_workspace_settings")
      .set({ updated_by: actingUserId })
      .where("updated_by", "=", source.id)
      .execute();

    // Who started an Implementer task (#751): the author stays with a person, not null.
    await trx
      .updateTable("implementer_sessions")
      .set({ created_by: actingUserId })
      .where("created_by", "=", source.id)
      .execute();
    await trx
      .updateTable("implementer_turns")
      .set({ created_by: actingUserId })
      .where("created_by", "=", source.id)
      .execute();

    await trx
      .updateTable("invitations")
      .set({ invited_by: actingUserId })
      .where("invited_by", "=", source.id)
      .execute();
    await trx
      .updateTable("invitations")
      .set({ accepted_by: actingUserId })
      .where("accepted_by", "=", source.id)
      .execute();
    // The requests to link an installation that the operator made or decided.
    await trx
      .updateTable("installation_link_requests")
      .set({ requested_by: actingUserId })
      .where("requested_by", "=", source.id)
      .execute();
    await trx
      .updateTable("installation_link_requests")
      .set({ decided_by: actingUserId })
      .where("decided_by", "=", source.id)
      .execute();

    // The identity becomes the admin's, and the admin shows the login it carries.
    await trx
      .updateTable("accounts")
      .set({ user_id: actingUserId })
      .where("id", "=", identity.id)
      .execute();
    await trx
      .updateTable("users")
      .set({
        github_login: source.github_login ?? actor.github_login,
        image: actor.image ?? source.image,
      })
      .where("id", "=", actingUserId)
      .execute();

    if (beforeCommit !== undefined) await beforeCommit(trx);

    // Retired: the row goes, with its sessions and tokens (they end with the user).
    await trx.deleteFrom("users").where("id", "=", source.id).execute();
    return { ok: true, movedMemberships: sourceMemberships.length };
  });
}
