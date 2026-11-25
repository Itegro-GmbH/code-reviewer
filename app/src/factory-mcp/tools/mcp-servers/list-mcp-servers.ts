// SPDX-License-Identifier: LicenseRef-Proprietary

import { defineTool } from "../define.ts";
import { mcpRegistryService } from "./services.ts";

export const listMcpServers = defineTool({
  name: "list_mcp_servers",
  title: "List agent MCP servers",
  description:
    "The remote MCP servers of the workspace that the agents of lane steps may use: name, address, transport, authentication, the NAMES of the headers (never a value), the revision, the last connection test and the tools it listed, and for OAuth whether somebody connected it. Not this factory's own MCP server.",
  scope: "factory:read",
  input: {},
  async handler(context) {
    return { servers: await context.services.use(mcpRegistryService).list() };
  },
});
