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
import {
  ToolError,
  failureOf,
  type ToolErrorCode,
  type ToolFailure,
} from "./errors.ts";

export type ToolOutcome =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; failure: ToolFailure };

/** One line of the audit trail of the tool calls: who did what in which workspace, and how it ended. Never an argument. */
export type ToolAuditEntry = {
  tool: string;
  scope: FactoryScope | null;
  workspaceId: string;
  userId: string;
  clientId: string;
  /** `ok`, or the error code the call ended with (`insufficient_scope`, `forbidden`, `not_found`, ...). */
  outcome: "ok" | ToolErrorCode;
  durationMs: number;
};

export type ToolRegistryOptions = {
  /** Where an unexpected failure of a tool is logged (the name of the tool; never what the exception said). */
  log?: (message: string, error: unknown) => void;
  /** Where the audit line of every call goes; by default one searchable line on the server's log. */
  audit?: (entry: ToolAuditEntry) => void;
};

const defaultLog: NonNullable<ToolRegistryOptions["log"]> = (message, error) =>
  console.error(message, error instanceof Error ? error.name : "unknown");

const defaultAudit: NonNullable<ToolRegistryOptions["audit"]> = (entry) =>
  console.info(`[factory-mcp] TOOL_CALL ${JSON.stringify(entry)}`);

export type ToolRegistry = {
  /** Every tool, in name order. */
  all(): readonly FactoryTool[];
  get(name: string): FactoryTool | undefined;
  /** The tools a token with these scopes may call. */
  listFor(scopes: readonly FactoryScope[]): readonly FactoryTool[];
  summaries(): readonly ToolSummary[];
  call(name: string, context: ToolContext, args: unknown): Promise<ToolOutcome>;
  /**
   * Writes the audit line of a call that never reached `call` (the endpoint refused it for its scope before the tool was looked at), so
   * every call has exactly one line.
   */
  audit(
    context: ToolContext,
    name: string,
    outcome: ToolAuditEntry["outcome"],
  ): void;
};

export function createToolRegistry(
  tools: readonly FactoryTool[],
  {
    log = defaultLog,
    audit: writeAudit = defaultAudit,
  }: ToolRegistryOptions = {},
): ToolRegistry {
  const byName = new Map<string, FactoryTool>();
  for (const tool of tools) {
    if (!TOOL_NAME_PATTERN.test(tool.name))
      throw new Error(
        `The tool name "${tool.name}" is not snake_case of at most 64 characters.`,
      );
    if (byName.has(tool.name))
      throw new Error(`The tool "${tool.name}" is registered twice.`);
    byName.set(tool.name, tool);
  }
  const sorted = [...byName.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  /** One audit line: who did what where and how it ended. The name is the tool's, or `unknown` for anything that is none; no argument is ever in it. */
  function record(
    context: ToolContext,
    name: string,
    outcome: ToolAuditEntry["outcome"],
    durationMs: number,
  ): void {
    const tool = byName.get(name);
    writeAudit({
      tool: tool === undefined ? "unknown" : tool.name,
      scope: tool === undefined ? null : tool.scope,
      workspaceId: context.workspace.id,
      userId: context.user.id,
      clientId: context.client.id,
      outcome,
      durationMs,
    });
  }

  const failure = (error: ToolError): ToolOutcome => ({
    ok: false,
    failure: failureOf(error),
  });

  return {
    all: () => sorted,
    get: (name) => byName.get(name),
    listFor: (scopes) =>
      sorted.filter((tool) => scopeSatisfies(scopes, tool.scope)),
    summaries: () =>
      sorted.map(({ name, title, description, scope }) => ({
        name,
        title,
        description,
        scope,
      })),

    audit(context, name, outcome) {
      record(context, name, outcome, 0);
    },

    async call(name, context, args) {
      const started = Date.now();
      const outcome = await execute(name, context, args);
      record(
        context,
        name,
        outcome.ok ? "ok" : outcome.failure.error,
        Date.now() - started,
      );
      return outcome;
    },
  };

  /** The call itself: the same steps for every tool, in this order. */
  async function execute(
    name: string,
    context: ToolContext,
    args: unknown,
  ): Promise<ToolOutcome> {
    {
      const tool = byName.get(name);
      if (tool === undefined)
        return failure(
          new ToolError("not_found", `There is no tool named ${name}.`),
        );
      if (!scopeSatisfies(context.scopes, tool.scope))
        return failure(
          new ToolError(
            "insufficient_scope",
            `The tool ${name} needs the scope ${tool.scope}; this connection has ${context.scopes.join(" ") || "none"}. Connect again and approve ${tool.scope}.`,
            {
              requiredScope: tool.scope,
            },
          ),
        );
      if (!can(context.role, tool.action))
        return failure(
          new ToolError(
            "forbidden",
            `Your role in this workspace (${context.role}) does not allow ${name}.`,
            {
              role: context.role,
            },
          ),
        );
      const parsed = tool.parse(args);
      if (!parsed.ok)
        return failure(
          new ToolError(
            "invalid_input",
            `The arguments of ${name} are not valid.`,
            { problems: parsed.problems },
          ),
        );
      try {
        return { ok: true, data: await tool.run(context, parsed.value) };
      } catch (error) {
        if (error instanceof ToolError) return failure(error);
        log(`[factory-mcp] TOOL_FAILED ${name}`, error);
        return failure(
          new ToolError(
            "internal_error",
            "The tool failed. Nothing was changed that the answer does not say.",
          ),
        );
      }
    }
  }
}
