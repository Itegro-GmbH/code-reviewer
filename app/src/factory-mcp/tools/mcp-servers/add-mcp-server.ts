// SPDX-License-Identifier: LicenseRef-Proprietary

import { defineTool } from "../define.ts";
import { mcpRegistryService, serverAnswer, unwrap } from "./services.ts";
import { authArg, nameArg, transportArg, urlArg } from "./shared.ts";

export const addMcpServer = defineTool({
  name: "add_mcp_server",
  title: "Add an agent MCP server",
  description:
    "Registers a remote MCP server the agents of lane steps may use (assign it to a step in the lane document, see `get_lane_schema`). The address is checked as the web app checks it (https only, no private address). A server with OAuth is added unconnected: a person presses Connect in the web app. Header values are stored sealed and never shown again. Run `test_mcp_server` afterwards. A refusal is `invalid_input` with the field's rule in `details.code`. Owners and Admins only.",
  scope: "factory:control",
  action: "manage_mcp",
  input: {
    name: nameArg,
    transport: transportArg.default("streamable-http"),
    url: urlArg,
    auth: authArg.default({ kind: "none" }),
  },
  async handler(context, args) {
    const registry = context.services.use(mcpRegistryService);
    const server = unwrap(
      await registry.create(
        { id: context.user.id },
        {
          name: args.name,
          transport: args.transport,
          url: args.url,
          auth: args.auth,
        },
      ),
    );
    return serverAnswer(server);
  },
});
