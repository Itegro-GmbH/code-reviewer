// SPDX-License-Identifier: LicenseRef-Proprietary

// How a tool of the factory MCP is written (epic #1143). One tool is one file that exports `defineTool({...})`:
//
// - `name`: snake_case, unique, at most 64 characters (the registry test holds it);
// - `scope`: `factory:read` for a tool that only looks, `factory:control` for one that changes anything. The endpoint refuses a call whose
//   token lacks the scope before the tool runs (HTTP 403 `insufficient_scope`), and the registry checks again;
// - `action`: the workspace action the person's ROLE must allow (`src/workspaces/permissions.ts`), by default `view`. The role is the one the
//   person has NOW (read per request), so a demoted person loses the tool at once. Scope and role both have to allow: a scope never gives more
//   than the role does;
// - `input`: a zod shape; the registry validates the arguments and answers `invalid_input` with the problems, the handler gets typed values;
// - `handler(context, args)`: calls the SAME services the app's own routes call (never SQL), so validation, budget and role rules are the
//   app's. It returns a plain object (JSON), or throws a `ToolError`. A write records `context.actor` where the app stores an actor.
import { z } from "zod";
import type { WorkspaceAction } from "../../workspaces/permissions.ts";
import type { FactoryScope } from "../scopes.ts";
import type { ToolContext } from "./context.ts";

export type ToolDefinition<Shape extends z.ZodRawShape> = {
  name: string;
  /** A short title for a person looking at the list of tools. */
  title: string;
  /** What the tool does and when to use it, written for an AI: one to three sentences. */
  description: string;
  scope: FactoryScope;
  /** The role requirement; `view` (every member) when left out. */
  action?: WorkspaceAction;
  input: Shape;
  handler: (
    context: ToolContext,
    args: z.infer<z.ZodObject<Shape>>,
  ) => Promise<Record<string, unknown>>;
};

/** A tool as the registry stores it: the arguments are checked by `parse`, then `run` takes them. */
export type FactoryTool = {
  name: string;
  title: string;
  description: string;
  scope: FactoryScope;
  action: WorkspaceAction;
  /** The JSON Schema of the arguments, for `tools/list`. */
  inputSchema: Record<string, unknown>;
  /** The problems of the arguments as short sentences, or the values. */
  parse(
    args: unknown,
  ): { ok: true; value: unknown } | { ok: false; problems: string[] };
  run(context: ToolContext, args: unknown): Promise<Record<string, unknown>>;
};

export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export function defineTool<Shape extends z.ZodRawShape>(
  definition: ToolDefinition<Shape>,
): FactoryTool {
  const schema = z.object(definition.input).strict();
  const { $schema: _dialect, ...inputSchema } = z.toJSONSchema(schema, {
    io: "input",
  });
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    scope: definition.scope,
    action: definition.action ?? "view",
    inputSchema,
    parse(args) {
      const parsed = schema.safeParse(args ?? {});
      if (parsed.success) return { ok: true, value: parsed.data };
      return {
        ok: false,
        problems: parsed.error.issues
          .slice(0, 10)
          .map(
            (issue) =>
              `${issue.path.length === 0 ? "arguments" : issue.path.join(".")}: ${issue.message}`,
          ),
      };
    },
    run: (context, args) =>
      definition.handler(
        context,
        args as z.infer<z.ZodObject<Shape>>,
      ),
  };
}
