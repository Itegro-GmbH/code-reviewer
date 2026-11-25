// SPDX-License-Identifier: LicenseRef-Proprietary

// A tool context for the unit tests of tools and of the registry. Test use only.
import type { WorkspaceRole } from "../../db/workspace-roles.ts";
import type { FactoryScope } from "../scopes.ts";
import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.ts";
import type { ToolActor, ToolContext } from "./context.ts";
import { createToolServices, sessionUserOf } from "./services.ts";

export function testContext(
  overrides: {
    role?: WorkspaceRole;
    scopes?: FactoryScope[];
    tools?: ToolContext["tools"];
    /** What `context.services` opens as the database; by default a test that asks for it fails, naming itself. */
    database?: () => Kysely<Database>;
  } = {},
): ToolContext {
  const user = { id: "user-ada", name: "Ada", email: "ada@example.test" };
  const workspace = { id: "ws-acme", slug: "acme", name: "Acme" };
  const role = overrides.role ?? "owner";
  const actor: ToolActor = {
    userId: "user-ada",
    userName: "Ada",
    clientId: "client-1",
    clientName: "Claude Code",
    label: "Ada via Claude Code",
  };
  const access = {
    user: sessionUserOf(user),
    workspace: {
      ...workspace,
      createdBy: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
    },
    role,
  };
  return {
    user,
    workspace,
    role,
    scopes: overrides.scopes ?? ["factory:control"],
    client: { id: "client-1", name: "Claude Code" },
    actor,
    access,
    services: createToolServices({
      access,
      actor,
      database:
        overrides.database ??
        (() => {
          throw new Error(
            "This test opened the database through context.services.",
          );
        }),
    }),
    connectedAt: "2026-11-25T09:00:00.000Z",
    accessTokenExpiresAt: "2026-11-25T10:15:00.000Z",
    environment: {
      productName: "Software Factory",
      capabilities: ["dynamic-review", "implementer", "review"],
      baseUrl: "https://factory.example.test",
    },
    tools: overrides.tools ?? [],
    now: () => new Date("2026-11-25T10:00:00.000Z"),
  };
}
