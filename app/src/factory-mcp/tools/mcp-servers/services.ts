// SPDX-License-Identifier: LicenseRef-Proprietary

// The services of the agent MCP server tools (#1147): the SAME registry the routes below `/api/w/:workspace/mcp/servers` use, for the
// workspace of the token. OAuth "Connect" stays in the web app (a person signs in at the server's authorization page).
import { MCP_INPUT_CODES, type McpErrorCode } from "../../../mcp/errors.ts";
import type {
  McpServerView,
  McpService,
  McpServiceResult,
} from "../../../mcp/service.ts";
import { mcpServiceFor } from "../../../mcp/shared.ts";
import { ToolError, type ToolErrorCode } from "../errors.ts";
import type { ServiceFactory } from "../services.ts";

export const mcpRegistryService: ServiceFactory<McpService> = ({ access }) =>
  mcpServiceFor(access.workspace.id);

const INPUT_CODES: ReadonlySet<string> = new Set(MCP_INPUT_CODES);

function codeOf(error: McpErrorCode): ToolErrorCode {
  if (INPUT_CODES.has(error))
    return error === "mcp_name_taken" ? "conflict" : "invalid_input";
  switch (error) {
    case "forbidden":
      return "forbidden";
    case "mcp_server_not_found":
      return "not_found";
    case "mcp_server_in_use":
    case "mcp_server_changed":
      return "conflict";
    case "mcp_limit_reached":
    case "rate_limited":
      return "limit_reached";
    case "mcp_revision_required":
      return "invalid_input";
    case "unavailable":
      return "unavailable";
    default:
      return "invalid_input";
  }
}

/**
 * The value of a registry answer, or a `ToolError` for its refusal: the service's code stays in `details.code` (`mcp_url_private`,
 * `mcp_name_taken`, ...), a server a lane still uses is `conflict` with the `lanes` that name it, a refused test is `limit_reached` with
 * `retryAfterSeconds`.
 */
export function unwrap<T>(result: McpServiceResult<T>): T {
  if (result.ok) return result.value;
  throw new ToolError(codeOf(result.error), messageOf(result.error), {
    code: result.error,
    ...(result.lanes === undefined
      ? {}
      : {
          lanes: result.lanes.map((lane) => ({
            id: lane.id,
            name: lane.name,
            projectName: lane.projectName,
          })),
        }),
    ...(result.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: result.retryAfterSeconds }),
  });
}

function messageOf(code: McpErrorCode): string {
  switch (code) {
    case "mcp_server_not_found":
      return "There is no such MCP server in this workspace.";
    case "mcp_server_in_use":
      return "A lane still uses this MCP server; take it out of the lanes named in `lanes` first.";
    case "mcp_server_changed":
      return "The server was changed meanwhile: read it again (`get_mcp_server`) and retry.";
    case "mcp_limit_reached":
      return "The workspace holds the most MCP servers it may.";
    case "rate_limited":
      return "Too many connection tests; try again after `retryAfterSeconds`.";
    case "mcp_name_taken":
      return "The workspace has an MCP server of this name.";
    case "forbidden":
      return "The role does not allow managing MCP servers.";
    case "unavailable":
      return "The registry could not be reached; nothing was done. Try again.";
    case "mcp_revision_required":
      return "The change needs the revision it was made from.";
    default:
      return `The server's entry is refused (${code}). The code names the field and the rule.`;
  }
}

export async function findServer(
  registry: McpService,
  id: string,
): Promise<McpServerView> {
  const found = (await registry.list()).find((server) => server.id === id);
  if (found === undefined)
    throw new ToolError(
      "not_found",
      "There is no such MCP server in this workspace.",
    );
  return found;
}

/** A server as the tools answer it: the registry's own view (the NAMES of the headers, never a value). */
export function serverAnswer(server: McpServerView): Record<string, unknown> {
  return { server };
}
