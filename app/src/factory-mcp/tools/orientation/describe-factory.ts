// SPDX-License-Identifier: LicenseRef-Proprietary

import { can } from "../../../workspaces/permissions.ts";
import { scopeSatisfies } from "../../scopes.ts";
import { defineTool } from "../define.ts";
import { CONCEPTS, NOT_VIA_MCP, RULES } from "./factory-guide.ts";

export const describeFactory = defineTool({
  name: "describe_factory",
  title: "Describe the factory",
  description:
    "Explains the factory to you: what projects, lanes, runs, ToDos and runners are, the rules of this connection, what cannot be done through MCP, and every tool with whether you can call it now.",
  scope: "factory:read",
  input: {},
  async handler(context) {
    const tools = context.tools.map((tool) => {
      const byScope = scopeSatisfies(context.scopes, tool.scope);
      return {
        name: tool.name,
        scope: tool.scope,
        description: tool.description,
        callable: byScope,
      };
    });
    return {
      product: context.environment.productName,
      capabilities: [...context.environment.capabilities],
      workspace: { slug: context.workspace.slug, name: context.workspace.name },
      you: {
        role: context.role,
        scope: [...context.scopes],
        mayControl: scopeSatisfies(context.scopes, "factory:control"),
        maySaveLanes:
          scopeSatisfies(context.scopes, "factory:control") &&
          can(context.role, "manage_workflows"),
      },
      concepts: CONCEPTS,
      rules: RULES,
      notViaMcp: NOT_VIA_MCP,
      tools,
      next: "Call get_lane_schema to learn how a lane document is written.",
    };
  },
});
