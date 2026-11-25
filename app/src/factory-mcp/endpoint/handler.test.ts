// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ACME,
  ADA,
  BOB,
  ISSUER,
  RESOURCE,
  connect,
  createWorld,
  type TestWorld,
} from "../oauth/test-harness.ts";
import { ACCESS_TOKEN_TTL_MS } from "../oauth/service.ts";
import { ALL_TOOLS } from "../tools/all.ts";
import { defineTool } from "../tools/define.ts";
import { createToolRegistry, type ToolAuditEntry } from "../tools/registry.ts";
import { createMcpEndpoint } from "./handler.ts";

/** A tool that changes something, which only a control token and an Admin may call. */
const saveThing = defineTool({
  name: "save_thing",
  title: "Save a thing",
  description: "Test only: a write that records its actor.",
  scope: "factory:control",
  action: "manage_workflows",
  input: { name: z.string() },
  async handler(context, { name }) {
    return { saved: name, by: context.actor.label };
  },
});

/** A tool that shows what the services seam hands a tool: the token's workspace, person and role, and the actor. */
const whereAmI = defineTool({
  name: "where_am_i",
  title: "Where am I",
  description: "Test only: reads what context.services hands a tool.",
  scope: "factory:read",
  input: {},
  async handler(context) {
    const scope = context.services.use((s) => s);
    return {
      workspace: scope.access.workspace.slug,
      workspaceId: scope.access.workspace.id,
      user: scope.access.user.id,
      instanceAdmin: scope.access.user.isInstanceAdmin,
      role: scope.access.role,
      actor: scope.actor.label,
    };
  },
});

function setup() {
  const world = createWorld();
  const audit: ToolAuditEntry[] = [];
  const endpoint = createMcpEndpoint({
    service: world.service,
    database: () => {
      throw new Error("no database in this test");
    },
    registry: createToolRegistry([...ALL_TOOLS, saveThing, whereAmI], {
      audit: (entry) => audit.push(entry),
    }),
    baseUrl: ISSUER,
    environment: {
      productName: "Software Factory",
      capabilities: ["implementer", "review"],
    },
    now: () => world.clock.now,
  });
  return { world, endpoint, audit };
}

const HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

function rpc(
  token: string | null,
  body: unknown,
  extra: Record<string, string> = {},
  url = RESOURCE,
) {
  return new Request(url, {
    method: "POST",
    headers: {
      ...HEADERS,
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...extra,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const call = (id: number, name: string, args: unknown = {}) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

async function json(response: Response) {
  // The shape of each answer is asserted where it is read.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a test reads many different JSON-RPC answers
  return (await response.json()) as Record<string, any>;
}

describe("authentication of /api/mcp", () => {
  // #1144-T160
  it("answers a request without a token with 401 and the address of the resource metadata (RFC 9728)", async () => {
    const { endpoint } = setup();
    const response = await endpoint.handle(rpc(null, call(1, "whoami")));
    expect(response.status).toBe(401);
    const challenge = response.headers.get("www-authenticate") as string;
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain(
      `resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/api/mcp"`,
    );
    expect(challenge).not.toContain("error=");
  });

  // #1144-T161
  it("refuses a token that is not one of ours, and one that is only in the address", async () => {
    const { endpoint, world } = setup();
    const { accessToken } = await connect(world);
    const garbage = await endpoint.handle(rpc("garbage", call(1, "whoami")));
    expect(garbage.status).toBe(401);
    expect(garbage.headers.get("www-authenticate")).toContain(
      'error="invalid_token"',
    );
    const inAddress = await endpoint.handle(
      rpc(
        null,
        call(1, "whoami"),
        {},
        `${RESOURCE}?access_token=${accessToken}`,
      ),
    );
    expect(inAddress.status).toBe(401);
    const wrongScheme = await endpoint.handle(
      rpc(null, call(1, "whoami"), { authorization: `Basic ${accessToken}` }),
    );
    expect(wrongScheme.status).toBe(401);
  });

  // #1144-T162
  it("refuses an expired token", async () => {
    const { endpoint, world } = setup();
    const { accessToken } = await connect(world);
    world.advance(ACCESS_TOKEN_TTL_MS + 1000);
    const response = await endpoint.handle(rpc(accessToken, call(1, "whoami")));
    expect(response.status).toBe(401);
    expect(await json(response)).toMatchObject({ error: "invalid_token" });
  });

  // #1144-T163
  it("refuses a revoked token at once", async () => {
    const { endpoint, world } = setup();
    const { accessToken, refreshToken } = await connect(world);
    expect(
      (await endpoint.handle(rpc(accessToken, call(1, "whoami")))).status,
    ).toBe(200);
    await world.service.revoke(refreshToken);
    expect(
      (await endpoint.handle(rpc(accessToken, call(2, "whoami")))).status,
    ).toBe(401);
  });

  // #1144-T164
  it("refuses a token that was issued for another audience", async () => {
    const { endpoint, world } = setup();
    const { accessToken } = await connect(world);
    const [grant] = [...world.store.state.grants.values()];
    world.store.state.grants.set(grant!.id, {
      ...grant!,
      resource: "https://other.example/api/mcp",
    });
    const response = await endpoint.handle(rpc(accessToken, call(1, "whoami")));
    expect(response.status).toBe(401);
    expect(await json(response)).toMatchObject({ error: "invalid_token" });
  });

  // #1144-T165
  it("refuses a token of somebody who is no longer a member of its workspace", async () => {
    const { endpoint, world } = setup();
    const { accessToken } = await connect(world, { user: BOB.id });
    world.members.delete(`${BOB.id}:${ACME.id}`);
    expect(
      (await endpoint.handle(rpc(accessToken, call(1, "whoami")))).status,
    ).toBe(401);
  });

  // #1144-T166
  it("takes neither a cookie nor a token from a request that is not a POST", async () => {
    const { endpoint, world } = setup();
    const { accessToken } = await connect(world);
    const get = await endpoint.handle(
      new Request(RESOURCE, {
        method: "GET",
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "text/event-stream",
        },
      }),
    );
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toContain("POST");
    const noToken = await endpoint.handle(
      new Request(RESOURCE, {
        method: "GET",
        headers: { cookie: "session=abc" },
      }),
    );
    expect(noToken.status).toBe(401);
    const options = await endpoint.handle(
      new Request(RESOURCE, { method: "OPTIONS" }),
    );
    expect(options.status).toBe(204);
  });
});

describe("the MCP protocol on /api/mcp", () => {
  async function connected(
    world: TestWorld,
    options: Parameters<typeof connect>[1] = {},
  ) {
    return (await connect(world, options)).accessToken;
  }

  // #1144-T170
  it("answers initialize with the server's name and the tools capability", async () => {
    const { endpoint, world } = setup();
    const token = await connected(world);
    const response = await endpoint.handle(
      rpc(token, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await json(response);
    expect(body.result.serverInfo.name).toBe("software-factory");
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.instructions).toContain("whoami");
  });

  // #1144-T171
  it("lists to a read token only the tools that look, and to a control token the ones that change too", async () => {
    const { endpoint, world } = setup();
    const names = async (token: string) =>
      (
        await json(
          await endpoint.handle(
            rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/list" }),
          ),
        )
      ).result.tools.map((t: { name: string }) => t.name);
    const read = await names(await connected(world, { scope: "factory:read" }));
    // Judged by each tool's declared scope, so a slice that adds a tool (of either scope) changes nothing here.
    const declared = [...ALL_TOOLS, saveThing, whereAmI];
    const byScope = (scopes: string[]) =>
      declared
        .filter((tool) => scopes.includes(tool.scope))
        .map((tool) => tool.name)
        .sort((x, y) => x.localeCompare(y));
    expect(read).toEqual(byScope(["factory:read"]));
    expect(read).toContain("whoami");
    expect(read).not.toContain("save_thing");
    const control = await names(
      await connected(world, { scope: "factory:control" }),
    );
    expect(control).toEqual(byScope(["factory:read", "factory:control"]));
    expect(control).toContain("save_thing");
  });

  // #1144-T172
  it("describes each tool with a JSON Schema and marks the reading ones read only", async () => {
    const { endpoint, world } = setup();
    const token = await connected(world);
    const body = await json(
      await endpoint.handle(
        rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/list" }),
      ),
    );
    const byName = Object.fromEntries(
      body.result.tools.map((t: { name: string }) => [t.name, t]),
    );
    expect(byName.get_lane_schema.inputSchema.properties.section).toBeDefined();
    expect(byName.whoami.annotations.readOnlyHint).toBe(true);
    expect(byName.save_thing.annotations.readOnlyHint).toBe(false);
  });

  // #1144-T173
  it("runs a tool as the person of the token, in the workspace of the token", async () => {
    const { endpoint, world } = setup();
    const token = await connected(world);
    const body = await json(
      await endpoint.handle(rpc(token, call(1, "whoami"))),
    );
    expect(body.result.isError).toBeUndefined();
    expect(body.result.structuredContent).toMatchObject({
      user: { id: ADA.id },
      workspace: { slug: "acme" },
      role: "owner",
      scope: ["factory:control"],
      client: { name: "Claude Code" },
    });
    expect(JSON.parse(body.result.content[0].text)).toEqual(
      body.result.structuredContent,
    );
  });

  // #1144-T174
  it("lets no argument choose another workspace", async () => {
    const { endpoint, world } = setup();
    const token = await connected(world);
    const body = await json(
      await endpoint.handle(
        rpc(token, call(1, "whoami", { workspace: "side" })),
      ),
    );
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent).toMatchObject({
      error: "invalid_input",
    });
  });

  // #1144-T175
  it("answers 403 insufficient_scope, asking for control, when a read token calls a write tool", async () => {
    const { endpoint, world } = setup();
    const token = await connected(world, { scope: "factory:read" });
    const response = await endpoint.handle(
      rpc(token, call(1, "save_thing", { name: "x" })),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain(
      'error="insufficient_scope"',
    );
    expect(response.headers.get("www-authenticate")).toContain(
      'scope="factory:control"',
    );
    expect(await json(response)).toMatchObject({
      error: "insufficient_scope",
      requiredScope: "factory:control",
    });
  });

  // #1144-T176
  it("also finds the write tool inside a batch", async () => {
    const { endpoint, world } = setup();
    const token = await connected(world, { scope: "factory:read" });
    const response = await endpoint.handle(
      rpc(token, [call(1, "whoami"), call(2, "save_thing", { name: "x" })]),
    );
    expect(response.status).toBe(403);
  });

  // #1144-T177
  it("applies the role on top of a control scope: a Member's write tool is refused as a tool error, an Owner's runs", async () => {
    const { endpoint, world } = setup();
    const owner = await connected(world, { scope: "factory:control" });
    const ok = await json(
      await endpoint.handle(
        rpc(owner, call(1, "save_thing", { name: "lane" })),
      ),
    );
    expect(ok.result.structuredContent).toEqual({
      saved: "lane",
      by: "Ada via Claude Code",
    });
    const member = await connected(world, {
      user: BOB.id,
      scope: "factory:control",
    });
    const refused = await json(
      await endpoint.handle(
        rpc(member, call(2, "save_thing", { name: "lane" })),
      ),
    );
    expect(refused.result.isError).toBe(true);
    expect(refused.result.structuredContent).toMatchObject({
      error: "forbidden",
      role: "member",
    });
  });

  // #1144-T178
  it("follows a role that changed after the consent", async () => {
    const { endpoint, world } = setup();
    const token = await connected(world, { scope: "factory:control" });
    world.members.set(`${ADA.id}:${ACME.id}`, "member");
    const refused = await json(
      await endpoint.handle(
        rpc(token, call(1, "save_thing", { name: "lane" })),
      ),
    );
    expect(refused.result.structuredContent).toMatchObject({
      error: "forbidden",
    });
  });

  // #1144-T179
  it("answers an unknown tool as a tool error and a body that is not JSON as a parse error", async () => {
    const { endpoint, world } = setup();
    const token = await connected(world);
    const unknown = await json(
      await endpoint.handle(rpc(token, call(1, "nope"))),
    );
    expect(unknown.result.structuredContent).toMatchObject({
      error: "not_found",
    });
    const broken = await endpoint.handle(rpc(token, "{"));
    expect(broken.status).toBe(400);
    expect(await json(broken)).toMatchObject({ error: { code: -32700 } });
  });

  // #1144-T180
  it("refuses a body over a megabyte", async () => {
    const { endpoint, world } = setup();
    const token = await connected(world);
    const response = await endpoint.handle(
      rpc(token, call(1, "whoami", { padding: "x".repeat(1024 * 1024 + 10) })),
    );
    expect(response.status).toBe(413);
  });

  // #1144-T181
  it("answers get_lane_schema through the protocol, with an error for a section that does not exist", async () => {
    const { endpoint, world } = setup();
    const token = await connected(world);
    const overview = await json(
      await endpoint.handle(rpc(token, call(1, "get_lane_schema"))),
    );
    expect(overview.result.structuredContent.howToWriteOne).toBeTruthy();
    const missing = await json(
      await endpoint.handle(
        rpc(token, call(2, "get_lane_schema", { section: "nope" })),
      ),
    );
    expect(missing.result.isError).toBe(true);
    expect(missing.result.structuredContent.error).toBe("not_found");
  });
});

describe("what a tool can reach and what is written about its call", () => {
  // #1144-T280
  it("gives a tool the services of the token's workspace and person, with no instance rank", async () => {
    const { endpoint, world } = setup();
    const token = (await connect(world, { scope: "factory:read" })).accessToken;
    const body = await json(
      await endpoint.handle(rpc(token, call(1, "where_am_i"))),
    );
    expect(body.result.structuredContent).toEqual({
      workspace: "acme",
      workspaceId: ACME.id,
      user: ADA.id,
      instanceAdmin: false,
      role: "owner",
      actor: "Ada via Claude Code",
    });
  });

  // #1144-T281
  it("writes one audit line for each call, including the one refused for its scope, and no argument", async () => {
    const { endpoint, world, audit } = setup();
    const read = (await connect(world, { scope: "factory:read" })).accessToken;
    await endpoint.handle(rpc(read, call(1, "whoami")));
    await endpoint.handle(
      rpc(read, call(2, "save_thing", { name: "hunter2" })),
    );
    await endpoint.handle(
      rpc(read, call(3, "get_lane_schema", { section: "nope" })),
    );
    expect(audit.map((line) => [line.tool, line.outcome])).toEqual([
      ["whoami", "ok"],
      ["save_thing", "insufficient_scope"],
      ["get_lane_schema", "not_found"],
    ]);
    expect(audit[0]).toMatchObject({
      workspaceId: ACME.id,
      userId: ADA.id,
      scope: "factory:read",
    });
    expect(audit[0]?.clientId).toMatch(/\S+/);
    expect(JSON.stringify(audit)).not.toContain("hunter2");
  });

  // #1144-T282
  it("writes no line for a request that is no tool call", async () => {
    const { endpoint, world, audit } = setup();
    const token = (await connect(world)).accessToken;
    await endpoint.handle(
      rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/list" }),
    );
    await endpoint.handle(rpc("garbage", call(2, "whoami")));
    expect(audit).toEqual([]);
  });
});
