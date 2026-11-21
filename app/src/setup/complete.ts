// SPDX-License-Identifier: LicenseRef-Proprietary

// Completion of the first-run setup (docs/decisions/0001-editions-setup-and-accounts.md, section
// 2.2, point 4): one transaction that creates the instance admin, stores the choices, creates or
// uses the workspace the tenancy calls for, and marks the instance as set up. Two people finishing at
// the same moment cannot both win: the transaction takes the setup lock first (src/db/setup-lock.ts), so the second finds the marker set and gets
// `already_set_up`, and a transaction that fails rolls back whatever it did.
//
// The password is hashed before the transaction opens, never inside it: hashing is slow on purpose
// and a write transaction must not be held open across it. The hash is Better Auth's (its
// credential account format), so the sign in with email and password verifies it.
import type { Kysely } from "kysely";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { ensureHostedRunners } from "../db/repositories/named-runners-repository.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import { formatTimestamp } from "../db/codecs.ts";
import { lockSetupCompletion } from "../db/setup-lock.ts";
import type { Database } from "../db/schema.ts";
import { CREDENTIAL_PROVIDER_ID } from "../auth/session-user.ts";
import { SetupError } from "./errors.ts";
import type { SetupInput } from "./input.ts";

export type CompleteSetupDependencies = {
  db: Kysely<Database>;
  /** Better Auth's password hash (`context.password.hash`). */
  hashPassword: (password: string) => Promise<string>;
  /**
   * Whether the sign in would accept this admin: the address and the password pass the rules of
   * Better Auth's sign in, and the hash verifies. Asked before anything is written, so an admin who
   * could never sign in is not created on an instance whose setup is then over.
   */
  checkCredential: (credential: {
    email: string;
    password: string;
    hash: string;
  }) => Promise<boolean>;
  now?: () => Date;
  newId?: () => string;
};

export type CompletedSetup = {
  userId: string;
  /** The workspace the admin became a member of, or null (multi-tenant without one to join). */
  workspaceId: string | null;
};

export async function completeSetup(
  {
    db,
    hashPassword,
    checkCredential,
    now = () => new Date(),
    newId = () => crypto.randomUUID(),
  }: CompleteSetupDependencies,
  input: SetupInput,
): Promise<CompletedSetup> {
  const passwordHash = await hashPassword(input.admin.password);
  if (
    !(await checkCredential({
      email: input.admin.email,
      password: input.admin.password,
      hash: passwordHash,
    }))
  )
    throw new SetupError("admin_unusable");

  return db.transaction().execute(async (trx) => {
    await lockSetupCompletion(trx);
    const at = now();
    const timestamp = formatTimestamp(at);
    const settings = createInstanceSettingsRepository(trx, () => at);
    const workspaces = createWorkspacesRepository(trx, () => at, newId);

    // The marker, read inside the transaction that will set it.
    if ((await settings.get("setup_completed_at")) != null)
      throw new SetupError("already_set_up");

    const taken = await trx
      .selectFrom("users")
      .select("id")
      .where("email", "=", input.admin.email)
      .executeTakeFirst();
    if (taken !== undefined) throw new SetupError("email_in_use");

    const userId = newId();
    await trx
      .insertInto("users")
      .values({
        id: userId,
        name: input.admin.email.split("@")[0] ?? input.admin.email,
        email: input.admin.email,
        // The sign-up rule and the verification belong to later issues; without a mail server no
        // address can be verified, and the admin keeps access to /admin either way.
        email_verified: 0,
        image: null,
        github_login: null,
        imported_at: null,
        is_instance_admin: 1,
        org_checked_at: null,
        org_checked_for: null,
        created_at: timestamp,
        updated_at: timestamp,
      })
      .execute();
    await trx
      .insertInto("accounts")
      .values({
        id: newId(),
        // Better Auth's credential account: the account id is the user id.
        account_id: userId,
        provider_id: CREDENTIAL_PROVIDER_ID,
        user_id: userId,
        access_token: null,
        refresh_token: null,
        id_token: null,
        access_token_expires_at: null,
        refresh_token_expires_at: null,
        scope: null,
        password: passwordHash,
        created_at: timestamp,
        updated_at: timestamp,
      })
      .execute();

    // The workspace, by tenancy. An installation from before the setup already has its workspace
    // (made by the migration, filled by the import); a fresh one has none.
    let workspaceId: string | null = null;
    const existing = await workspaces.findDefault();
    if (input.tenancy === "single") {
      // One workspace for the whole instance, and the admin owns it (also when it was imported and
      // has owners already).
      const workspace =
        existing ??
        (await workspaces.create({
          name: "Default workspace",
          slug: "default",
          createdBy: userId,
        }));
      await workspaces.addMember(workspace.id, userId, "owner");
      // #1105 (ADR 0007, decision 16): the hosted runners (the migration made them for a workspace that existed before; asked again, nothing).
      await ensureHostedRunners(trx, workspace.id, { now: () => at });
      workspaceId = workspace.id;
    } else if (
      existing !== undefined &&
      !(await workspaces.hasOwner(existing.id))
    ) {
      // Multi-tenant: an imported workspace the import left without an Owner gets the admin as its
      // Owner, so it can be managed. A fresh multi-tenant instance has no workspace until somebody
      // creates one.
      await workspaces.addMember(existing.id, userId, "owner");
      workspaceId = existing.id;
    }

    await settings.set("tenancy", input.tenancy, userId);
    await settings.set("sign_up_rule", input.signUp, userId);
    await settings.set("setup_completed_at", timestamp, userId);

    return { userId, workspaceId };
  });
}
