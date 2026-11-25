// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { ALL_TOOLS } from "../all.ts";
import { createToolRegistry } from "../registry.ts";
import { testContext } from "../test-context.ts";

const registry = createToolRegistry(ALL_TOOLS);
const context = (overrides: Parameters<typeof testContext>[0] = {}) =>
  testContext({ tools: registry.summaries(), ...overrides });

async function data(
  name: string,
  args: unknown,
  overrides: Parameters<typeof testContext>[0] = {},
) {
  const outcome = await registry.call(name, context(overrides), args);
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.failure));
  return outcome.data;
}

describe("whoami", () => {
  // #1144-T140
  it("says who acts, in which workspace, with which role and scope, through which app", async () => {
    expect(await data("whoami", {})).toMatchObject({
      user: { id: "user-ada", name: "Ada", email: "ada@example.test" },
      workspace: { slug: "acme", name: "Acme" },
      role: "owner",
      scope: ["factory:control"],
      client: { id: "client-1", name: "Claude Code" },
      connectedAt: "2026-11-25T09:00:00.000Z",
    });
  });

  // #1144-T141
  it("shows the role and scope of the token it is called with", async () => {
    expect(
      await data("whoami", {}, { role: "member", scopes: ["factory:read"] }),
    ).toMatchObject({
      role: "member",
      scope: ["factory:read"],
    });
  });

  // #1144-T142
  it("takes no arguments, not even a workspace to look at", async () => {
    const outcome = await registry.call("whoami", context(), {
      workspace: "other",
    });
    expect(outcome).toMatchObject({
      ok: false,
      failure: { error: "invalid_input" },
    });
  });
});

describe("describe_factory", () => {
  // #1144-T143
  it("explains the concepts, the rules and what stays out of MCP", async () => {
    const answer = (await data("describe_factory", {})) as Record<
      string,
      unknown
    >;
    expect(answer).toMatchObject({
      product: "Software Factory",
      workspace: { slug: "acme" },
      you: { role: "owner", mayControl: true, maySaveLanes: true },
    });
    const terms = (answer.concepts as { term: string }[]).map((c) => c.term);
    expect(terms).toEqual(
      expect.arrayContaining([
        "workspace",
        "project",
        "lane",
        "run",
        "ToDo",
        "runner",
      ]),
    );
    expect((answer.notViaMcp as string[]).join(" ")).toMatch(/LLM keys/);
    expect((answer.notViaMcp as string[]).join(" ")).toMatch(/billing/);
  });

  // #1144-T144
  it("lists every tool and whether the scope lets this connection call it", async () => {
    type Listed = {
      tools: { name: string; scope: string; callable: boolean }[];
      you: { mayControl: boolean };
    };
    // Each tool is judged by the scope it declares, so a slice that adds a control tool changes nothing here.
    const read = (await data(
      "describe_factory",
      {},
      { scopes: ["factory:read"] },
    )) as Listed;
    expect(read.you.mayControl).toBe(false);
    expect(read.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["whoami", "describe_factory", "get_lane_schema"]),
    );
    expect(read.tools.map((t) => t.name).sort()).toEqual(
      ALL_TOOLS.map((tool) => tool.name).sort(),
    );
    for (const tool of read.tools)
      expect([tool.name, tool.callable]).toEqual([
        tool.name,
        tool.scope === "factory:read",
      ]);
    const control = (await data(
      "describe_factory",
      {},
      { scopes: ["factory:control"] },
    )) as Listed;
    for (const tool of control.tools)
      expect([tool.name, tool.callable]).toEqual([tool.name, true]);
  });

  // #1144-T145
  it("says a Member cannot save lanes even with control", async () => {
    const answer = (await data("describe_factory", {}, { role: "member" })) as {
      you: { maySaveLanes: boolean };
    };
    expect(answer.you.maySaveLanes).toBe(false);
  });
});

describe("get_lane_schema", () => {
  // #1144-T146
  it("answers an overview with the way to write a lane, the validator's limits, triggers and connectors", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the overview is a large JSON document read field by field
    const answer = (await data("get_lane_schema", {})) as Record<string, any>;
    expect(answer.howToWriteOne.join(" ")).toMatch(/validate/i);
    expect(answer.limits).toMatchObject({
      stepsPerDocument: 50,
      turnTimeLimitMinutes: { min: 15, max: 60, default: 60 },
    });
    expect(answer.triggerKinds).toEqual(
      expect.arrayContaining(["manual", "ticket.labeled", "schedule"]),
    );
    expect(answer.triggerKinds).not.toContain("github.issueLabeled");
    expect(answer.connectors.map((c: { name: string }) => c.name)).toEqual(
      expect.arrayContaining(["pullRequest.open", "ticket.comment"]),
    );
    expect(answer.document).toContain("| `steps` |");
    const sections = answer.sections.map((s: { section: string }) => s.section);
    expect(sections).toEqual(
      expect.arrayContaining([
        "schema",
        "result_schema",
        "example",
        "five-kinds-of-node",
        "error-codes",
      ]),
    );
    expect(answer.readNext.map((r: { section: string }) => r.section)).toEqual([
      "the-document",
      "five-kinds-of-node",
      "references-and-data-flow",
      "conditions",
      "result-schemas",
      "error-codes",
    ]);
    // Small enough to read first.
    expect(JSON.stringify(answer).length).toBeLessThan(40_000);
  });

  // #1144-T147
  it("hands out the JSON Schema, the result schema and a complete example", async () => {
    const schema = (await data("get_lane_schema", { section: "schema" })) as {
      format: string;
      content: { $defs: { Workflow: { properties: { steps: unknown } } } };
    };
    expect(schema.format).toBe("json");
    expect(schema.content.$defs.Workflow.properties.steps).toBeDefined();
    const result = (await data("get_lane_schema", {
      section: "result_schema",
    })) as { content: unknown };
    expect(result.content).toBeTruthy();
    const example = (await data("get_lane_schema", { section: "example" })) as {
      content: { version: number; steps: unknown[] };
    };
    expect(example.content.version).toBe(1);
    expect(example.content.steps.length).toBeGreaterThan(0);
  });

  // #1144-T148
  it("hands out a chapter, and a part of a long chapter on its own", async () => {
    const chapter = (await data("get_lane_schema", {
      section: "five-kinds-of-node",
    })) as { content: string };
    const part = (await data("get_lane_schema", {
      section: "five-kinds-of-node/the-agent-step-kind-agent",
    })) as { content: string; title: string };
    expect(chapter.content).toContain("### The agent step");
    expect(part.title).toBe('The agent step (`"kind": "agent"`)');
    expect(part.content.length).toBeLessThan(chapter.content.length);
    expect(chapter.content).toContain(part.content);
  });

  // #1144-T149
  it("answers an unknown section as not_found and names the sections that exist", async () => {
    const outcome = await registry.call("get_lane_schema", context(), {
      section: "nope",
    });
    expect(outcome).toMatchObject({
      ok: false,
      failure: {
        error: "not_found",
        sections: expect.arrayContaining(["schema", "example", "conditions"]),
      },
    });
  });
});
