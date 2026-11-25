// SPDX-License-Identifier: LicenseRef-Proprietary

import { defineTool } from "../define.ts";
import { mcpRegistryService, findServer, serverAnswer } from "./services.ts";
import { serverIdArg } from "./shared.ts";

export const getMcpServer = defineTool({
  name: "get_mcp_server",
  title: "Get an agent MCP server",
  description:
    "One agent MCP server by id, with its `revision`, authentication, last test result and the tools the last successful test listed.",
  scope: "factory:read",
  input: { serverId: serverIdArg },
  async handler(context, args) {
    return serverAnswer(
      await findServer(context.services.use(mcpRegistryService), args.serverId),
    );
  },
});
