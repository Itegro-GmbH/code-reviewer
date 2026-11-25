// SPDX-License-Identifier: LicenseRef-Proprietary

// The seam through which a tool reaches the app's own services (#1144, epic #1143). A tool never opens the database or reads a workspace from
// its arguments: it asks `context.services.use(factory)` for the service of the app that does the work (the same code the web app's routes
// call, so validation, budget and role rules are the app's), and the factory is handed a `ServiceScope`:
//
// - `access`: the SAME shape `withWorkspace` gives a route (`WorkspaceAccess`): the person, the workspace of the token, and the role the
//   person has now. The person is a session user WITHOUT instance rank (`isInstanceAdmin: false`, no GitHub identity): an AI app never acts
//   as the instance admin, whoever the person is;
// - `actor`: the person and the AI app, for the field of a write that stores who did it;
// - `database`: opened only when a factory asks for it, so a tool that only needs `access` costs no connection and a unit test needs none.
//
// A factory is a plain function (usually one line over the factory the app already has), kept in the tool's own folder, so no central file
// lists the services and two slices never edit the same line. `use` builds a service once per request however often a tool asks.
import type { Kysely } from "kysely";
import type { SessionUser } from "../../auth/access-policy.ts";
import type { WorkspaceAccess } from "../../workspaces/access.ts";
import type { Database } from "../../db/schema.ts";

/** Who did a write: the person, and the AI app that did it for them. */
export type ToolActor = {
  userId: string;
  userName: string;
  clientId: string;
  clientName: string;
  /** One line for a place that stores a name or a note: `Ada via Claude Code`. */
  label: string;
};

export type ServiceScope = {
  access: WorkspaceAccess;
  actor: ToolActor;
  database: () => Kysely<Database>;
};

export type ServiceFactory<T> = (scope: ServiceScope) => T;

export type ToolServices = {
  readonly scope: ServiceScope;
  /** The service the factory makes for this request's workspace and person; made once, then kept for the request. */
  use<T>(factory: ServiceFactory<T>): T;
};

export function createToolServices(scope: ServiceScope): ToolServices {
  const made = new Map<ServiceFactory<unknown>, unknown>();
  return {
    scope,
    use<T>(factory: ServiceFactory<T>): T {
      if (!made.has(factory)) made.set(factory, factory(scope));
      return made.get(factory) as T;
    },
  };
}

/** The person of a token as the app's own code sees a signed-in person: never the instance admin. */
export function sessionUserOf(user: {
  id: string;
  name: string;
  email: string;
}): SessionUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    isInstanceAdmin: false,
    githubLogin: null,
    githubId: null,
    image: null,
  };
}
