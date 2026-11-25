// SPDX-License-Identifier: LicenseRef-Proprietary

// Slice #1147 (runners, agent MCP servers, models and costs): list_runners, get_runner, update_runner, create_runner_token, revoke_runner,
// list_mcp_servers, get_mcp_server, add_mcp_server, update_mcp_server, remove_mcp_server, test_mcp_server, list_models, get_budget,
// get_costs. Each tool is a file of its own below `../runners/`, `../mcp-servers/` and `../models/`; this file only lists them, and no other
// slice edits it. `set_monthly_limit` is deliberately not a tool: money stays with a person.
import type { FactoryTool } from "../define.ts";
import { addMcpServer } from "../mcp-servers/add-mcp-server.ts";
import { getMcpServer } from "../mcp-servers/get-mcp-server.ts";
import { listMcpServers } from "../mcp-servers/list-mcp-servers.ts";
import { removeMcpServer } from "../mcp-servers/remove-mcp-server.ts";
import { testMcpServer } from "../mcp-servers/test-mcp-server.ts";
import { updateMcpServer } from "../mcp-servers/update-mcp-server.ts";
import { getBudget } from "../models/get-budget.ts";
import { getCosts } from "../models/get-costs.ts";
import { listModels } from "../models/list-models.ts";
import { createRunnerToken } from "../runners/create-runner-token.ts";
import { getRunner } from "../runners/get-runner.ts";
import { listRunners } from "../runners/list-runners.ts";
import { revokeRunner } from "../runners/revoke-runner.ts";
import { updateRunner } from "../runners/update-runner.ts";

export const runnerMcpAndModelTools: readonly FactoryTool[] = [
  listRunners,
  getRunner,
  updateRunner,
  createRunnerToken,
  revokeRunner,
  listModels,
  listMcpServers,
  getMcpServer,
  addMcpServer,
  updateMcpServer,
  removeMcpServer,
  testMcpServer,
  getBudget,
  getCosts,
];
