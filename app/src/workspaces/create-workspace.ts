// SPDX-License-Identifier: LicenseRef-Proprietary

// Creating a workspace on behalf of a user (docs/decisions/0001-editions-setup-and-accounts.md,
// sections 2.3 and 2.6). Only a multi-tenant instance lets users create workspaces; a single-tenant
// instance has the one workspace its setup made. The tenancy, the limit and the insert are one
// transaction, so none of them can interleave with a change of the tenancy (src/admin/tenancy.ts) or with
// another creation by the same person: an instance never ends up single-tenant with two workspaces, and
// nobody gets past "workspaces per user" by asking twice at once.
//
// Concurrency (#105): under Postgres' default isolation (READ COMMITTED) two requests with the same name could both see
// the slug free and both insert, and two requests of one person could both pass the limit. The transaction therefore takes
// the workspace creation lock first (src/db/workspace-creation-lock.ts), which serializes every creation and the switch of
// the tenancy (src/admin/tenancy.ts).
//
// This is the one place that creates a workspace for a user; the page, the route and the rate limit are
// around it (src/workspaces/service.ts).
import type { Kysely } from "kysely";
import { lockWorkspaceCreation } from "../db/workspace-creation-lock.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { ensureHostedRunners } from "../db/repositories/named-runners-repository.ts";
import {
  createWorkspacesRepository,
  type Workspace,
} from "../db/repositories/workspaces-repository.ts";
import type { Database } from "../db/schema.ts";
import { DEFAULT_MAX_WORKSPACES_PER_USER } from "./limits.ts";
import { slugFromName, uniqueSlug, validateWorkspaceName } from "./names.ts";

export const CREATE_WORKSPACE_ERROR_CODES = [
  /** The instance is single-tenant: it has the one workspace its setup made. */
  "multi_tenant_required",
  /** The person owns as many workspaces as the instance allows. */
  "workspace_limit_reached",
  /** The name is empty, too long or holds a control character. */
  "invalid_name",
] as const;
export type CreateWorkspaceError =
  (typeof CREATE_WORKSPACE_ERROR_CODES)[number];

export type CreateWorkspaceResult =
  | { ok: true; workspace: Workspace }
  | { ok: false; error: CreateWorkspaceError };

export async function createWorkspaceUnderTenancy(
  db: Kysely<Database>,
  input: {
    name: string;
    /** The slug to use; by default one is made from the name (and numbered when it is taken). */
    slug?: string;
    /** The user who creates it; becomes its Owner. */
    creatorId: string;
    now?: () => Date;
    newId?: () => string;
  },
): Promise<CreateWorkspaceResult> {
  const now = input.now ?? (() => new Date());
  const name = validateWorkspaceName(input.name);
  if (!name.ok) return { ok: false, error: "invalid_name" };

  return db.transaction().execute(async (trx) => {
    await lockWorkspaceCreation(trx);
    const settings = createInstanceSettingsRepository(trx, now);
    // No setting reads as single-tenant, like everywhere else: only multi lets users create.
    if ((await settings.get("tenancy")) !== "multi")
      return { ok: false, error: "multi_tenant_required" } as const;

    const workspaces = createWorkspacesRepository(trx, now, input.newId);
    const limit =
      (await settings.get("max_workspaces_per_user")) ??
      DEFAULT_MAX_WORKSPACES_PER_USER;
    if ((await workspaces.countOwnedBy(input.creatorId)) >= limit)
      return { ok: false, error: "workspace_limit_reached" } as const;

    const slug =
      input.slug ??
      (await uniqueSlug(slugFromName(name.name), (candidate) =>
        workspaces.slugExists(candidate),
      ));
    const workspace = await workspaces.create({
      name: name.name,
      slug,
      createdBy: input.creatorId,
    });
    await workspaces.addMember(workspace.id, input.creatorId, "owner");
    // #1105 (ADR 0007, decision 16): the hosted runners, one for each type of the provided Vercel Sandbox, from the first moment.
    await ensureHostedRunners(trx, workspace.id, { now });
    return { ok: true, workspace } as const;
  });
}
