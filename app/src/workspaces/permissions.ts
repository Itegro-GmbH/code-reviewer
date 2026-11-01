// SPDX-License-Identifier: LicenseRef-Proprietary

// What each role may do in a workspace (docs/decisions/0001-editions-setup-and-accounts.md, section 2.6).
// The one matrix of the app, as pure functions: every route, page and service asks here, and the table in
// permissions.test.ts pins every action against every role, so a change of the matrix is a change of a
// test. The principle is that every action needs the lowest role that is safe.
//
// - Member: uses the workspace. Sees projects, runs, settings and the members, starts reviews and changes
//   the settings of a project.
// - Admin: everything a Member can, plus what the workspace is made of: connections, repositories (which
//   projects are switched on), the review defaults and the LLM key, and Members and their invitations
//   (invite, remove, revoke; Members only), the hand-over to the plan page of the operator, and the billing
//   profile and top-ups of the prepaid balance.
// - Owner: everything an Admin can, plus Admins and Owners (invite, change roles, remove) and renaming the
//   workspace and deleting it.
//
// Two rules sit outside the matrix because they depend on more than the role of the person who acts: the
// last Owner cannot leave, be removed or be demoted (src/workspaces/members.ts), and a person cannot act on
// a workspace they are not a member of at all (src/workspaces/access.ts).
import type { WorkspaceRole } from "../db/workspace-roles.ts";

/** The actions that need a role and nothing else. */
export const WORKSPACE_ACTIONS = [
  /** Pages, runs, projects and settings of the workspace. */
  "view",
  /** Start a review by hand. */
  "start_review",
  /** Send a task to the Implementer (#755; factory only, the routes do not exist elsewhere). */
  "start_implementer_task",
  /** Change the settings of one project. */
  "change_project_settings",
  /** Switch a project on or off: which repositories are reviewed (and paid for). */
  "manage_projects",
  /** Change the review defaults every project inherits. */
  "manage_review_defaults",
  /** Connections to git platforms: reading them from the platform, connecting one. */
  "manage_connections",
  /** The workspace's own LLM key. */
  "manage_llm_key",
  /** Be handed over to the operator-configured plan page (src/plan-handoff/). */
  "manage_plan",
  /** The billing profile and the top-up of the prepaid balance (ADR 0006; src/billing/). */
  "manage_billing",
  /** The list of members. */
  "view_members",
  /** The list of pending invitations (who is invited and with which role). */
  "view_invitations",
  /** Invite, resend and revoke (which roles, see `canInviteAs`). */
  "manage_invitations",
  /** Give a member another role. */
  "change_member_roles",
  /** Rename the workspace. */
  "rename_workspace",
  /** Delete the workspace with everything in it (#658; src/workspaces/delete-workspace.ts). */
  "delete_workspace",
] as const;
export type WorkspaceAction = (typeof WORKSPACE_ACTIONS)[number];

const RANK: Record<WorkspaceRole, number> = { member: 1, admin: 2, owner: 3 };

/** The lowest role that may do each action. */
export const MINIMUM_ROLE: Record<WorkspaceAction, WorkspaceRole> = {
  view: "member",
  start_review: "member",
  start_implementer_task: "member",
  change_project_settings: "member",
  manage_projects: "admin",
  manage_review_defaults: "admin",
  manage_connections: "admin",
  manage_llm_key: "admin",
  manage_plan: "admin",
  manage_billing: "admin",
  view_members: "member",
  view_invitations: "admin",
  manage_invitations: "admin",
  change_member_roles: "owner",
  rename_workspace: "owner",
  delete_workspace: "owner",
};

/** Whether `role` may do the action. */
export function can(role: WorkspaceRole, action: WorkspaceAction): boolean {
  return RANK[role] >= RANK[MINIMUM_ROLE[action]];
}

/**
 * Whether `actor` may invite somebody with `invitedRole`: an Owner with any role, an Admin Members only,
 * a Member nobody. Revoking an invitation needs the same right over the role it carries.
 */
export function canInviteAs(
  actor: WorkspaceRole,
  invitedRole: WorkspaceRole,
): boolean {
  if (actor === "owner") return true;
  return actor === "admin" && invitedRole === "member";
}

export function canRevokeInvitationOf(
  actor: WorkspaceRole,
  invitationRole: WorkspaceRole,
): boolean {
  return canInviteAs(actor, invitationRole);
}

/**
 * Whether `actor` may give a member another role. Only an Owner manages Admins and Owners, and raising a
 * Member to Admin is that: an Admin cannot hand out their own rank. (Whether the change would leave the
 * workspace without an Owner is a separate rule.)
 */
export function canChangeRole(actor: WorkspaceRole): boolean {
  return actor === "owner";
}

/**
 * Whether `actor` may remove somebody whose role is `target`: an Owner anybody, an Admin a Member, a Member
 * nobody. Leaving is every member's right and is not decided here.
 */
export function canRemoveMemberWithRole(
  actor: WorkspaceRole,
  target: WorkspaceRole,
): boolean {
  if (actor === "owner") return true;
  return actor === "admin" && target === "member";
}
