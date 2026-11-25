// SPDX-License-Identifier: LicenseRef-Proprietary

import { z } from "zod";
import { defineTool } from "../define.ts";
import { ToolError } from "../errors.ts";
import type { McpServerView } from "../../../mcp/service.ts";
import {
  findServer,
  mcpRegistryService,
  serverAnswer,
  unwrap,
} from "./services.ts";
import {
  authArg,
  nameArg,
  serverIdArg,
  transportArg,
  urlArg,
} from "./shared.ts";

/** What the stored server says about its authentication, as the form of an edit repeats it: headers and a client are kept, not re-entered. */
function currentAuth(server: McpServerView): Record<string, unknown> {
  if (server.auth === "header")
    return {
      kind: "header",
      headers: server.headers.map((name) => ({ name, keep: true })),
    };
  if (server.auth === "oauth") {
    const oauth = server.oauth;
    return oauth?.clientId
      ? {
          kind: "oauth",
          clientId: oauth.clientId,
          issuer: oauth.clientIssuer,
          ...(oauth.hasClientSecret ? { keepClientSecret: true } : {}),
        }
      : { kind: "oauth" };
  }
  return { kind: "none" };
}

export const updateMcpServer = defineTool({
  name: "update_mcp_server",
  title: "Change an agent MCP server",
  description:
    "Changes the name, transport, address or authentication of an agent MCP server; leave out what stays. Without `auth`, the stored headers (or OAuth client) are kept; changing the address or transport needs every header value again (`invalid_input`, `mcp_header_value_required`). `expectedRevision` (the `revision` from `get_mcp_server`) makes a change over somebody else's a `conflict`; left out, the current revision is used. Owners and Admins only.",
  scope: "factory:control",
  action: "manage_mcp",
  input: {
    serverId: serverIdArg,
    name: nameArg.optional(),
    transport: transportArg.optional(),
    url: urlArg.optional(),
    auth: authArg.optional(),
    expectedRevision: z.number().int().min(1).optional(),
  },
  async handler(context, args) {
    if (
      args.name === undefined &&
      args.transport === undefined &&
      args.url === undefined &&
      args.auth === undefined
    )
      throw new ToolError(
        "invalid_input",
        "Give at least one of `name`, `transport`, `url` or `auth` to change.",
      );
    const registry = context.services.use(mcpRegistryService);
    const current = await findServer(registry, args.serverId);
    return serverAnswer(
      unwrap(
        await registry.update(args.serverId, {
          name: args.name ?? current.name,
          transport: args.transport ?? current.transport,
          url: args.url ?? current.url,
          auth: args.auth ?? currentAuth(current),
          revision: args.expectedRevision ?? current.revision,
        }),
      ),
    );
  },
});
