// SPDX-License-Identifier: LicenseRef-Proprietary

// What a tool gets with every call: who is calling (the person, the workspace, the role the person has now, the scope they approved, the AI
// app), the facts of the deployment, and the actor to record on a write. Built per request by the endpoint from the verified token; a tool never
// reads a workspace or a user from its arguments.
import type { WorkspaceRole } from "../../db/workspace-roles.ts";
import type { FactoryScope } from "../scopes.ts";
import type { Principal } from "../oauth/service.ts";

/** Who did a write: the person, and the AI app that did it for them. */
export type ToolActor = {
  userId: string;
  userName: string;
  clientId: string;
  clientName: string;
  /** One line for a place that stores a name or a note: `Ada via Claude Code`. */
  label: string;
};

/** One tool as `describe_factory` lists it. */
export type ToolSummary = {
  name: string;
  title: string;
  description: string;
  scope: FactoryScope;
};

export type ToolContext = {
  user: { id: string; name: string; email: string };
  workspace: { id: string; slug: string; name: string };
  /** The role the person has in the workspace now. */
  role: WorkspaceRole;
  /** What the person approved. A tool needing `factory:read` is allowed by `factory:control` too. */
  scopes: readonly FactoryScope[];
  client: { id: string; name: string };
  /** The person and the app, for the field of a write that stores who did it. The app's own user id fields take `user.id`. */
  actor: ToolActor;
  connectedAt: string | null;
  accessTokenExpiresAt: string;
  /** The facts of this deployment. */
  environment: {
    productName: string;
    capabilities: readonly string[];
    baseUrl: string;
  };
  /** Every tool of the server, for the ones that describe the server. */
  tools: readonly ToolSummary[];
  now: () => Date;
};

export function actorOf(principal: Principal): ToolActor {
  return {
    userId: principal.user.id,
    userName: principal.user.name,
    clientId: principal.client.id,
    clientName: principal.client.name,
    label: `${principal.user.name} via ${principal.client.name}`,
  };
}
