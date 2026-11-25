// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ALL_TOOLS } from "./all.ts";
import { defineTool, TOOL_NAME_PATTERN } from "./define.ts";
import { ToolError } from "./errors.ts";
import { createToolRegistry } from "./registry.ts";
import { testContext } from "./test-context.ts";

const echo = defineTool({
  name: "echo",
  title: "Echo",
  description: "Reads.",
  scope: "factory:read",
  input: { text: z.string().max(10) },
  async handler(_context, { text }) {
    return { text };
  },
});
const write = defineTool({
  name: "write_thing",
  title: "Write",
  description: "Changes something.",
  scope: "factory:control",
  action: "manage_workflows",
  input: {},
  async handler(context) {
    return { by: context.actor.label };
  },
});
const broken = defineTool({
  name: "broken",
  title: "Broken",
  description: "Throws.",
  scope: "factory:read",
  input: {},
  async handler() {
    throw new Error("secret detail: password=hunter2");
  },
});
const refuses = defineTool({
  name: "refuses",
  title: "Refuses",
  description: "Refuses.",
  scope: "factory:read",
  input: {},
  async handler() {
    throw new ToolError("conflict", "The lane changed since you read it.", { currentVersion: 4 });
  },
});

function registry(logged: string[] = []) {
  return createToolRegistry([echo, write, broken, refuses], (message) => logged.push(message));
}

describe("the tool registry", () => {
  // #1144-T120
  it("lists for a read token only the tools that look, and for a control token all of them", () => {
    const r = registry();
    expect(r.listFor(["factory:read"]).map((t) => t.name)).toEqual(["broken", "echo", "refuses"]);
    expect(r.listFor(["factory:control"]).map((t) => t.name)).toEqual(["broken", "echo", "refuses", "write_thing"]);
    expect(r.listFor([])).toEqual([]);
  });

  // #1144-T121
  it("lets a read scope call a read tool, and a control scope call it too", async () => {
    const r = registry();
    for (const scopes of [["factory:read"], ["factory:control"]] as const)
      expect(await r.call("echo", testContext({ scopes: [...scopes] }), { text: "hi" })).toEqual({
        ok: true,
        data: { text: "hi" },
      });
  });

  // #1144-T122
  it("refuses a read scope that calls a write tool, with the scope that is needed", async () => {
    const outcome = await registry().call("write_thing", testContext({ scopes: ["factory:read"] }), {});
    expect(outcome).toMatchObject({
      ok: false,
      failure: { error: "insufficient_scope", requiredScope: "factory:control" },
    });
  });

  // #1144-T123
  it("applies the role on top of the scope: a Member with control cannot save, an Admin can", async () => {
    const r = registry();
    expect(await r.call("write_thing", testContext({ role: "member" }), {})).toMatchObject({
      ok: false,
      failure: { error: "forbidden", role: "member" },
    });
    expect(await r.call("write_thing", testContext({ role: "admin" }), {})).toEqual({
      ok: true,
      data: { by: "Ada via Claude Code" },
    });
  });

  // #1144-T124
  it("answers invalid arguments with the problems, and refuses a field the tool does not name", async () => {
    const r = registry();
    const tooLong = await r.call("echo", testContext(), { text: "x".repeat(11) });
    expect(tooLong).toMatchObject({ ok: false, failure: { error: "invalid_input", problems: [expect.stringContaining("text")] } });
    const extra = await r.call("echo", testContext(), { text: "ok", workspace: "other" });
    expect(extra).toMatchObject({ ok: false, failure: { error: "invalid_input" } });
    const missing = await r.call("echo", testContext(), undefined);
    expect(missing).toMatchObject({ ok: false, failure: { error: "invalid_input" } });
  });

  // #1144-T125
  it("passes a tool's own refusal through with its code and details", async () => {
    expect(await registry().call("refuses", testContext(), {})).toEqual({
      ok: false,
      failure: { error: "conflict", message: "The lane changed since you read it.", currentVersion: 4 },
    });
  });

  // #1144-T126
  it("hides what an unexpected failure said, and logs it", async () => {
    const logged: string[] = [];
    const outcome = await registry(logged).call("broken", testContext(), {});
    expect(outcome).toMatchObject({ ok: false, failure: { error: "internal_error" } });
    expect(JSON.stringify(outcome)).not.toContain("hunter2");
    expect(logged).toEqual(["[factory-mcp] TOOL_FAILED broken"]);
  });

  // #1144-T127
  it("answers an unknown tool as not_found", async () => {
    expect(await registry().call("nope", testContext(), {})).toMatchObject({
      ok: false,
      failure: { error: "not_found" },
    });
  });

  // #1144-T128
  it("refuses a duplicate name and a name that is not snake_case", () => {
    expect(() => createToolRegistry([echo, echo])).toThrow(/twice/);
    const bad = defineTool({ name: "Bad-Name", title: "x", description: "x", scope: "factory:read", input: {}, async handler() { return {}; } });
    expect(() => createToolRegistry([bad])).toThrow(/snake_case/);
  });

  // #1144-T129
  it("gives a tool a JSON Schema of its arguments for tools/list", () => {
    expect(echo.inputSchema).toMatchObject({
      type: "object",
      properties: { text: { type: "string", maxLength: 10 } },
      required: ["text"],
      additionalProperties: false,
    });
    expect(echo.inputSchema).not.toHaveProperty("$schema");
  });
});

describe("the tools of the server", () => {
  // #1144-T130
  it("have unique snake_case names, a description, and a scope", () => {
    const names = ALL_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of ALL_TOOLS) {
      expect(tool.name).toMatch(TOOL_NAME_PATTERN);
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.description.length).toBeLessThanOrEqual(900);
      expect(["factory:read", "factory:control"]).toContain(tool.scope);
    }
    expect(() => createToolRegistry(ALL_TOOLS)).not.toThrow();
  });

  // #1144-T131
  it("hold the orientation tools, all of them read only", () => {
    const orientation = ["describe_factory", "get_lane_schema", "whoami"];
    for (const name of orientation)
      expect(ALL_TOOLS.find((tool) => tool.name === name)?.scope).toBe("factory:read");
  });
});
