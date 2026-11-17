// SPDX-License-Identifier: LicenseRef-Proprietary

// How many MCP calls of one job the run's trace keeps (#1055). The same number as the calls one claim may make (`MCP_MAX_CALLS_PER_CLAIM`,
// `src/mcp/in-flight.ts`; `mcp-call-limits.test.ts` holds the two together), so a run that stays inside its limit is listed whole. Free of
// server-only code: the repository that enforces it and the page that says it both import it.
export const MAX_MCP_CALLS_RECORDED_PER_JOB = 2000;
