// SPDX-License-Identifier: LicenseRef-Proprietary

import { defineTool } from "../define.ts";
import { mcpRegistryService, serverAnswer, unwrap } from "./services.ts";
import { serverIdArg } from "./shared.ts";

export const testMcpServer = defineTool({
  name: "test_mcp_server",
  title: "Test an agent MCP server",
  description:
    "Connects to the server as an MCP client from this factory, stores the result for the server's current revision and returns the server with `status`, `testErrorCode` and the `tools` it listed. A failed connection is a normal answer (`status` says so); a lane step with an MCP server that lists no tools fails, so test before assigning. Limited per workspace (`limit_reached` with `retryAfterSeconds`). Owners and Admins only.",
  scope: "factory:control",
  action: "manage_mcp",
  input: { serverId: serverIdArg },
  async handler(context, args) {
    return serverAnswer(
      unwrap(
        await context.services.use(mcpRegistryService).test(args.serverId),
      ),
    );
  },
});
