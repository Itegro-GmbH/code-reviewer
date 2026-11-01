// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins the permission matrix of the workspace roles (docs/decisions/0001-editions-setup-and-accounts.md,
// section 2.6), table driven: every action against every role, and every action on a member against
// every pair of roles. The expected values are written out here, not derived from the code under test, so
// a change of the matrix has to change a test.
import { describe, expect, it } from "vitest";
import {
  can,
  canChangeRole,
  canInviteAs,
  canRemoveMemberWithRole,
  canRevokeInvitationOf,
  MINIMUM_ROLE,
  WORKSPACE_ACTIONS,
  type WorkspaceAction,
} from "./permissions.ts";
import { WORKSPACE_ROLES, type WorkspaceRole } from "../db/workspace-roles.ts";

// "yes" for the roles that may do the action, in the order member, admin, owner.
const MATRIX: Record<WorkspaceAction, [boolean, boolean, boolean]> = {
  view: [true, true, true],
  start_review: [true, true, true],
  // #755-T14: every member may start an Implementer task (one line to raise it).
  start_implementer_task: [true, true, true],
  // #588-T42: a Member saves the settings of a project, but confirming or moving the pinned address of its catalog provider is
  // `manage_llm_key` (below).
  change_project_settings: [true, true, true],
  manage_projects: [false, true, true],
  manage_review_defaults: [false, true, true],
  manage_connections: [false, true, true],
  manage_llm_key: [false, true, true],
  // #284-T06: Manage plan is for the people who can act on a refusal notice, not for a Member.
  manage_plan: [false, true, true],
  // #501-T04: the billing profile and the top-up are for the people who pay, never for a Member.
  manage_billing: [false, true, true],
  view_members: [true, true, true],
  view_invitations: [false, true, true],
  manage_invitations: [false, true, true],
  change_member_roles: [false, false, true],
  rename_workspace: [false, false, true],
  // #658-T02: deleting the workspace is the Owner's alone.
  delete_workspace: [false, false, true],
};

const ORDER: WorkspaceRole[] = ["member", "admin", "owner"];

describe("who confirms the address of a catalog provider (#588)", () => {
  // #588-T42
  it("is decided by the LLM key right: the roles that hold the key confirm the address a key is sent to, a Member does not", () => {
    expect(can("member", "change_project_settings")).toBe(true);
    expect(ORDER.map((role) => can(role, "manage_llm_key"))).toEqual([
      false,
      true,
      true,
    ]);
  });
});

describe("the permission matrix", () => {
  // #101-WM-08
  it("covers every action, so a new action cannot be left out of the table", () => {
    expect(Object.keys(MATRIX).sort()).toEqual([...WORKSPACE_ACTIONS].sort());
    expect(Object.keys(MINIMUM_ROLE).sort()).toEqual(
      [...WORKSPACE_ACTIONS].sort(),
    );
  });

  // #101-WM-08
  it.each(
    WORKSPACE_ACTIONS.flatMap((action) =>
      ORDER.map(
        (role, index) => [action, role, MATRIX[action][index]] as const,
      ),
    ),
  )("answers %s for the role %s with %s", (action, role, expected) => {
    expect(can(role, action)).toBe(expected);
  });
});

// Rows: actor; columns: the role of the invitation or of the target, in the order member, admin, owner.
const INVITE: Record<WorkspaceRole, [boolean, boolean, boolean]> = {
  member: [false, false, false],
  admin: [true, false, false],
  owner: [true, true, true],
};
const REMOVE: Record<WorkspaceRole, [boolean, boolean, boolean]> = {
  member: [false, false, false],
  admin: [true, false, false],
  owner: [true, true, true],
};

describe("the rules that depend on the role of the other person", () => {
  // #101-WM-08, #101-WM-11
  it.each(
    ORDER.flatMap((actor) =>
      ORDER.map(
        (invited, index) => [actor, invited, INVITE[actor][index]] as const,
      ),
    ),
  )(
    "lets the %s invite somebody with the role %s: %s",
    (actor, invited, expected) => {
      expect(canInviteAs(actor, invited)).toBe(expected);
      expect(canRevokeInvitationOf(actor, invited)).toBe(expected);
    },
  );

  // #101-WM-08, #101-WM-11
  it.each(
    ORDER.flatMap((actor) =>
      ORDER.map(
        (target, index) => [actor, target, REMOVE[actor][index]] as const,
      ),
    ),
  )(
    "lets the %s remove a member with the role %s: %s",
    (actor, target, expected) => {
      expect(canRemoveMemberWithRole(actor, target)).toBe(expected);
    },
  );

  // #101-WM-08, #101-WM-11
  it("lets only an Owner change roles, so nobody can hand out a rank above their own", () => {
    expect(WORKSPACE_ROLES.filter((role) => canChangeRole(role))).toEqual([
      "owner",
    ]);
  });
});
