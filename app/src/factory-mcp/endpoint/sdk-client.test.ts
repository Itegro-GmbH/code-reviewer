// SPDX-License-Identifier: LicenseRef-Proprietary

// A real MCP client (the official SDK's, over Streamable HTTP) against the endpoint handler: what Claude Code, Cursor and the others do
// is initialize, send `notifications/initialized`, list the tools and call one, with the bearer token on every request. The `fetch` of the
// client is routed to the handler, so no network is used.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import {
  ISSUER,
  RESOURCE,
  connect,
  createWorld,
} from "../oauth/test-harness.ts";
import { ALL_TOOLS } from "../tools/all.ts";
import { createToolRegistry } from "../tools/registry.ts";
import { createMcpEndpoint } from "./handler.ts";

function clientFor(accessToken: string | null) {
  const world = createWorld();
  const endpoint = createMcpEndpoint({
    service: world.service,
    registry: createToolRegistry(ALL_TOOLS),
    baseUrl: ISSUER,
    database: () => {
      throw new Error("no database in this test");
    },
    environment: {
      productName: "Software Factory",
      capabilities: ["implementer"],
    },
    now: () => world.clock.now,
  });
  const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), {
    requestInit:
      accessToken === null
        ? {}
        : { headers: { authorization: `Bearer ${accessToken}` } },
    fetch: (input, init) => endpoint.handle(new Request(input, init)),
  });
  return {
    world,
    client: new Client({ name: "test-client", version: "1.0.0" }),
    transport,
  };
}

describe("the official MCP client against /api/mcp", () => {
  // #1144-T220
  it("initializes, lists the tools and calls one", async () => {
    const world = createWorld();
    const { accessToken } = await connect(world);
    const endpoint = createMcpEndpoint({
      service: world.service,
      registry: createToolRegistry(ALL_TOOLS),
      baseUrl: ISSUER,
      database: () => {
        throw new Error("no database in this test");
      },
      environment: {
        productName: "Software Factory",
        capabilities: ["implementer"],
      },
      now: () => world.clock.now,
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(RESOURCE), {
        requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
        fetch: (input, init) => endpoint.handle(new Request(input, init)),
      }),
    );
    expect(client.getServerVersion()?.name).toBe("software-factory");
    expect(client.getInstructions()).toContain("describe_factory");

    const listed = await client.listTools();
    // The connection approved control, so it lists every tool of the server (judged by the registry, not by a fixed list).
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(
      ALL_TOOLS.map((tool) => tool.name).sort(),
    );
    expect(listed.tools.map((tool) => tool.name)).toContain("whoami");

    const result = await client.callTool({ name: "whoami", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      workspace: { slug: "acme" },
      role: "owner",
    });
    await client.close();
  });

  // #1144-T221
  it("is refused with an authorization error when it brings no token", async () => {
    const { client, transport } = clientFor(null);
    await expect(client.connect(transport)).rejects.toThrow();
  });
});
