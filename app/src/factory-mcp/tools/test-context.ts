// SPDX-License-Identifier: LicenseRef-Proprietary

// A tool context for the unit tests of tools and of the registry. Test use only.
import type { WorkspaceRole } from "../../db/workspace-roles.ts";
import type { FactoryScope } from "../scopes.ts";
import type { ToolContext } from "./context.ts";

export function testContext(
  overrides: {
    role?: WorkspaceRole;
    scopes?: FactoryScope[];
    tools?: ToolContext["tools"];
  } = {},
): ToolContext {
  return {
    user: { id: "user-ada", name: "Ada", email: "ada@example.test" },
    workspace: { id: "ws-acme", slug: "acme", name: "Acme" },
    role: overrides.role ?? "owner",
    scopes: overrides.scopes ?? ["factory:control"],
    client: { id: "client-1", name: "Claude Code" },
    actor: {
      userId: "user-ada",
      userName: "Ada",
      clientId: "client-1",
      clientName: "Claude Code",
      label: "Ada via Claude Code",
    },
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
