// SPDX-License-Identifier: LicenseRef-Proprietary

// Slice #1147 (runners, agent MCP servers, models and costs): list_runners, get_runner, update_runner, create_runner_token, revoke_runner,
// list_mcp_servers, get_mcp_server, add_mcp_server, update_mcp_server, remove_mcp_server, test_mcp_server, list_models, get_budget,
// get_costs. Each tool is a file of its own below `../runners/`, `../mcp-servers/` and `../models/`; this file only lists them, and no other
// slice edits it.
import type { FactoryTool } from "../define.ts";

export const runnerMcpAndModelTools: readonly FactoryTool[] = [];
