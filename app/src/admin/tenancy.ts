// SPDX-License-Identifier: LicenseRef-Proprietary

// Changing the tenancy of the instance (docs/decisions/0001-editions-setup-and-accounts.md, section
// 2.3):
//
// - single to multi is always allowed; the workspace and its members stay as they are;
// - multi to single is allowed only while at most one workspace exists (a deleted one, #658, is not one). With none, the default
//   workspace is created and the acting admin becomes its Owner; with one, it stays as it is. With
//   more, the change is refused with the number of workspaces and nothing changes.
//
// The count, the workspace and the setting are one transaction, and a user creates a workspace in a
// transaction that reads the tenancy (src/workspaces/create-workspace.ts). Both take the workspace creation lock first
// (src/db/workspace-creation-lock.ts), so the two cannot interleave: whichever comes first decides, and the other
// sees its result. An instance can therefore never end up single-tenant with two workspaces.
import type { Kysely } from "kysely";
import { lockWorkspaceCreation } from "../db/workspace-creation-lock.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { ensureHostedRunners } from "../db/repositories/named-runners-repository.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import type { Database } from "../db/schema.ts";

export type Tenancy = "single" | "multi";

export type ChangeTenancyResult =
  | { ok: true; changed: boolean }
  | { ok: false; error: "too_many_workspaces"; count: number };

export type ChangeTenancyInput = {
  /** The admin who makes the change: recorded, and the Owner of a workspace the change creates. */
  actorId: string;
  tenancy: Tenancy;
  now?: () => Date;
  newId?: () => string;
};

/** What an instance with no tenancy setting is: the one-workspace kind. */
export const DEFAULT_TENANCY: Tenancy = "single";

export async function changeTenancy(
  db: Kysely<Database>,
  {
    actorId,
    tenancy,
    now = () => new Date(),
    newId = () => crypto.randomUUID(),
  }: ChangeTenancyInput,
): Promise<ChangeTenancyResult> {
  return db.transaction().execute(async (trx) => {
    await lockWorkspaceCreation(trx);
    const settings = createInstanceSettingsRepository(trx, now);
    const workspaces = createWorkspacesRepository(trx, now, newId);

    const current = (await settings.get("tenancy")) ?? DEFAULT_TENANCY;
    if (current === tenancy) return { ok: true, changed: false } as const;

    if (tenancy === "single") {
      // A deleted workspace (#658) is a tombstone, not a workspace: it is not counted, and with only tombstones left the
      // default workspace is made.
      const count = await workspaces.count();
      if (count > 1)
        return { ok: false, error: "too_many_workspaces", count } as const;
      if (count === 0) {
        const workspace = await workspaces.create({
          name: "Default workspace",
          slug: "default",
          createdBy: actorId,
        });
        await workspaces.addMember(workspace.id, actorId, "owner");
        await ensureHostedRunners(trx, workspace.id, { now });
      }
    }

    await settings.set("tenancy", tenancy, actorId);
    return { ok: true, changed: true } as const;
  });
}
