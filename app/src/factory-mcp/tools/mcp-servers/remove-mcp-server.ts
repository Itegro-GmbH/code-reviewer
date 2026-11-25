// SPDX-License-Identifier: LicenseRef-Proprietary

import { defineTool } from "../define.ts";
import { mcpRegistryService, unwrap } from "./services.ts";
import { serverIdArg } from "./shared.ts";

export const removeMcpServer = defineTool({
  name: "remove_mcp_server",
  title: "Remove an agent MCP server",
  description:
    "Removes an agent MCP server. Refused as `conflict` while a lane uses it: `details.lanes` names the lanes (id, name, project) to change first. Owners and Admins only.",
  scope: "factory:control",
  action: "manage_mcp",
  input: { serverId: serverIdArg },
  async handler(context, args) {
    unwrap(
      await context.services.use(mcpRegistryService).remove(args.serverId),
    );
    return { removed: true, serverId: args.serverId };
  },
});
