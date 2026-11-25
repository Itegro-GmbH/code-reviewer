// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it, vi } from "vitest";
import type { McpServerView } from "../../../mcp/service.ts";
import { call, contextWith, data, failure } from "../runs/test-support.ts";
import { mcpRegistryService } from "./services.ts";

const server = (over: Partial<McpServerView> = {}): McpServerView => ({
  id: "m1",
  name: "Docs",
  transport: "streamable-http",
  url: "https://docs.example.test/mcp",
  auth: "header",
  headers: ["Authorization"],
  revision: 4,
  status: "ok",
  testedAt: "2026-11-25T09:00:00.000Z",
  testErrorCode: null,
  tools: null,
  oauth: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-20T00:00:00.000Z",
  ...over,
});

function setup(
  service: Record<string, unknown>,
  overrides: Parameters<typeof contextWith>[1] = {},
) {
  return contextWith([[mcpRegistryService as never, service]], overrides);
}

describe("list_mcp_servers and get_mcp_server", () => {
  // #1147-T10
  it("lists the servers (names of headers only) for a Member, and gets one by id", async () => {
    const list = async () => [server(), server({ id: "m2", name: "Other" })];
    const context = setup(
      { list },
      { role: "member", scopes: ["factory:read"] },
    );
    const listed = await data("list_mcp_servers", context, {});
    expect(listed.servers).toHaveLength(2);
    expect(JSON.stringify(listed)).not.toContain("value");
    expect(
      await data("get_mcp_server", context, { serverId: "m2" }),
    ).toMatchObject({ server: { id: "m2" } });
    expect(
      await failure("get_mcp_server", context, { serverId: "none" }),
    ).toMatchObject({ error: "not_found" });
  });
});

describe("add_mcp_server", () => {
  // #1147-T11
  it("adds through the registry with the person as actor and the form the route takes", async () => {
    const create = vi.fn(async () => ({ ok: true as const, value: server() }));
    const answer = await data("add_mcp_server", setup({ create }), {
      name: "Docs",
      url: "https://docs.example.test/mcp",
      auth: {
        kind: "header",
        headers: [{ name: "Authorization", value: "Bearer abc" }],
      },
    });
    expect(create).toHaveBeenCalledWith(
      { id: "user-ada" },
      {
        name: "Docs",
        transport: "streamable-http",
        url: "https://docs.example.test/mcp",
        auth: {
          kind: "header",
          headers: [{ name: "Authorization", value: "Bearer abc" }],
        },
      },
    );
    expect(answer).toMatchObject({ server: { id: "m1" } });
    expect(JSON.stringify(answer)).not.toContain("Bearer abc");
  });

  // #1147-T12
  it("maps refusals: a bad address is invalid_input with the code, a taken name conflict, a full workspace limit_reached", async () => {
    const refuse = (error: string) => ({
      create: async () => ({ ok: false as const, error }),
    });
    const args = { name: "Docs", url: "https://x.example.test" };
    expect(
      await failure("add_mcp_server", setup(refuse("mcp_url_private")), args),
    ).toMatchObject({
      error: "invalid_input",
      code: "mcp_url_private",
    });
    expect(
      await failure("add_mcp_server", setup(refuse("mcp_name_taken")), args),
    ).toMatchObject({ error: "conflict" });
    expect(
      await failure("add_mcp_server", setup(refuse("mcp_limit_reached")), args),
    ).toMatchObject({ error: "limit_reached" });
    expect(
      await failure("add_mcp_server", setup({}, { role: "member" }), args),
    ).toMatchObject({ error: "forbidden" });
    expect(
      (
        await call(
          "add_mcp_server",
          setup({}, { scopes: ["factory:read"] }),
          args,
        )
      ).ok,
    ).toBe(false);
  });
});

describe("update_mcp_server", () => {
  // #1147-T13
  it("keeps the stored headers and the current revision when only the name changes", async () => {
    const update = vi.fn(async () => ({
      ok: true as const,
      value: server({ name: "Docs 2", revision: 5 }),
    }));
    const answer = await data(
      "update_mcp_server",
      setup({ list: async () => [server()], update }),
      {
        serverId: "m1",
        name: "Docs 2",
      },
    );
    expect(update).toHaveBeenCalledWith("m1", {
      name: "Docs 2",
      transport: "streamable-http",
      url: "https://docs.example.test/mcp",
      auth: {
        kind: "header",
        headers: [{ name: "Authorization", keep: true }],
      },
      revision: 4,
    });
    expect(answer).toMatchObject({ server: { revision: 5 } });
  });

  // #1147-T14
  it("a stale expectedRevision is conflict, a call with nothing to change is invalid_input", async () => {
    const update = async () => ({
      ok: false as const,
      error: "mcp_server_changed",
    });
    const context = setup({ list: async () => [server()], update });
    expect(
      await failure("update_mcp_server", context, {
        serverId: "m1",
        name: "x",
        expectedRevision: 1,
      }),
    ).toMatchObject({ error: "conflict", code: "mcp_server_changed" });
    expect(
      await failure("update_mcp_server", context, { serverId: "m1" }),
    ).toMatchObject({ error: "invalid_input" });
    expect(
      await failure("update_mcp_server", context, {
        serverId: "none",
        name: "x",
      }),
    ).toMatchObject({ error: "not_found" });
  });
});

describe("remove_mcp_server and test_mcp_server", () => {
  // #1147-T15
  it("removes a server, and a server a lane uses is conflict naming the lanes", async () => {
    const ok = {
      remove: async () => ({
        ok: true as const,
        value: { removed: true as const },
      }),
    };
    expect(
      await data("remove_mcp_server", setup(ok), { serverId: "m1" }),
    ).toEqual({ removed: true, serverId: "m1" });
    const inUse = {
      remove: async () => ({
        ok: false as const,
        error: "mcp_server_in_use",
        lanes: [
          { id: "l1", name: "Issue to PR", projectName: "App", extra: 1 },
        ],
      }),
    };
    expect(
      await failure("remove_mcp_server", setup(inUse), { serverId: "m1" }),
    ).toMatchObject({
      error: "conflict",
      code: "mcp_server_in_use",
      lanes: [{ id: "l1", name: "Issue to PR", projectName: "App" }],
    });
  });

  // #1147-T16
  it("tests a server and returns its status and tools; a rate limit is limit_reached with the wait", async () => {
    const test = vi.fn(async () => ({
      ok: true as const,
      value: server({ status: "ok" }),
    }));
    expect(
      await data("test_mcp_server", setup({ test }), { serverId: "m1" }),
    ).toMatchObject({ server: { status: "ok" } });
    const limited = {
      test: async () => ({
        ok: false as const,
        error: "rate_limited",
        retryAfterSeconds: 42,
      }),
    };
    expect(
      await failure("test_mcp_server", setup(limited), { serverId: "m1" }),
    ).toMatchObject({
      error: "limit_reached",
      retryAfterSeconds: 42,
    });
  });
});
