// SPDX-License-Identifier: LicenseRef-Proprietary

// The registry of the tools of the factory MCP: what `tools/list` shows for a token and how `tools/call` runs a tool. Built from a list of
// tools (`all.ts` is the list of the running server, tests make their own). A call goes through the same steps for every tool, so the
// refusals are uniform and a tool cannot forget one:
//
//   unknown name -> `not_found`; scope too small -> `insufficient_scope`; role too small -> `forbidden`; arguments that do not fit ->
//   `invalid_input`; the handler; a `ToolError` it throws -> that code; anything else -> `internal_error` (logged, never shown).
import { can } from "../../workspaces/permissions.ts";
import { scopeSatisfies, type FactoryScope } from "../scopes.ts";
import type { ToolContext, ToolSummary } from "./context.ts";
import { TOOL_NAME_PATTERN, type FactoryTool } from "./define.ts";
import { ToolError, failureOf, type ToolFailure } from "./errors.ts";

export type ToolOutcome =
  { ok: true; data: Record<string, unknown> } | { ok: false; failure: ToolFailure };

export type ToolRegistry = {
  /** Every tool, in name order. */
  all(): readonly FactoryTool[];
  get(name: string): FactoryTool | undefined;
  /** The tools a token with these scopes may call. */
  listFor(scopes: readonly FactoryScope[]): readonly FactoryTool[];
  summaries(): readonly ToolSummary[];
  call(name: string, context: ToolContext, args: unknown): Promise<ToolOutcome>;
};

export function createToolRegistry(
  tools: readonly FactoryTool[],
  log: (message: string, error: unknown) => void = (message, error) =>
    console.error(message, error instanceof Error ? error.name : "unknown"),
): ToolRegistry {
  const byName = new Map<string, FactoryTool>();
  for (const tool of tools) {
    if (!TOOL_NAME_PATTERN.test(tool.name))
      throw new Error(`The tool name "${tool.name}" is not snake_case of at most 64 characters.`);
    if (byName.has(tool.name)) throw new Error(`The tool "${tool.name}" is registered twice.`);
    byName.set(tool.name, tool);
  }
  const sorted = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));

  const failure = (error: ToolError): ToolOutcome => ({ ok: false, failure: failureOf(error) });

  return {
    all: () => sorted,
    get: (name) => byName.get(name),
    listFor: (scopes) => sorted.filter((tool) => scopeSatisfies(scopes, tool.scope)),
    summaries: () =>
      sorted.map(({ name, title, description, scope }) => ({ name, title, description, scope })),

    async call(name, context, args) {
      const tool = byName.get(name);
      if (tool === undefined)
        return failure(new ToolError("not_found", `There is no tool named ${name}.`));
      if (!scopeSatisfies(context.scopes, tool.scope))
        return failure(
          new ToolError("insufficient_scope", `The tool ${name} needs the scope ${tool.scope}; this connection has ${context.scopes.join(" ") || "none"}. Connect again and approve ${tool.scope}.`, {
            requiredScope: tool.scope,
          }),
        );
      if (!can(context.role, tool.action))
        return failure(
          new ToolError("forbidden", `Your role in this workspace (${context.role}) does not allow ${name}.`, {
            role: context.role,
          }),
        );
      const parsed = tool.parse(args);
      if (!parsed.ok)
        return failure(
          new ToolError("invalid_input", `The arguments of ${name} are not valid.`, { problems: parsed.problems }),
        );
      try {
        return { ok: true, data: await tool.run(context, parsed.value) };
      } catch (error) {
        if (error instanceof ToolError) return failure(error);
        log(`[factory-mcp] TOOL_FAILED ${name}`, error);
        return failure(new ToolError("internal_error", "The tool failed. Nothing was changed that the answer does not say."));
      }
    },
  };
}
