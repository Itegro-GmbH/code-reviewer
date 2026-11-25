// SPDX-License-Identifier: LicenseRef-Proprietary

// The role action each LLM key route file asks of `withWorkspace` (#426), pinned on its own: the handlers of
// src/llm/http.ts are replaced by ones that answer 200 to everyone, so a Member is refused only if the route file
// itself asks for `manage_llm_key`. The handlers repeat that check (llm-keys-route.integration.test.ts covers it);
// this test is for the day a refactor drops that second line and the route files stand alone.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionLookup } from "../../src/auth/session-user.ts";
import { createWorkspacesRepository } from "../../src/db/repositories/workspaces-repository.ts";
import { closeDatabase, getDatabase } from "../../src/db/startup.ts";
import { signedInMember } from "../../src/test-support/session-lookup.ts";
import { openRouteTestDatabase } from "../../src/test-support/test-database.ts";
import type { WorkspaceRole } from "../../src/db/workspace-roles.ts";

const session = vi.hoisted(() => ({
  currentLookup: vi.fn<() => Promise<SessionLookup>>(),
}));
const reached = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("@/auth/session", () => ({ currentLookup: session.currentLookup }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => undefined,
}));
// Handlers that never check a role: whatever the route file lets through is answered 200.
vi.mock("@/llm/http", () => {
  const answer = (name: string) => async () => {
    reached.calls.push(name);
    return Response.json({ reached: name });
  };
  return {
    createLlmKeyRouteHandlers: () => ({
      get: answer("get"),
      put: answer("put"),
      remove: answer("remove"),
      test: answer("test"),
    }),
  };
});
// #1150: the handlers of the Claude Code token, the same way.
vi.mock("@/llm/claude-code-token-http", () => {
  const answer = (name: string) => async () => {
    reached.calls.push(name);
    return Response.json({ reached: name });
  };
  return {
    createClaudeCodeTokenRouteHandlers: () => ({
      get: answer("get"),
      put: answer("put"),
      remove: answer("remove"),
      test: answer("test"),
    }),
  };
});
vi.mock("@/llm/shared", () => ({
  getWorkspaceLlm: () => ({
    keyServiceFor: () => ({}),
    claudeCodeTokenFor: () => ({}),
  }),
  getLlmKeyTester: () => ({}),
}));

const APP_SECRET = "llm-keys-route-actions-secret-0123456789-0123";

afterEach(async () => {
  reached.calls.length = 0;
  vi.unstubAllEnvs();
  await closeDatabase();
});

type Handler = (request: Request, context: never) => Promise<Response>;
type RouteFile = Record<"GET" | "PUT" | "DELETE" | "POST", Handler | undefined>;

async function start() {
  vi.stubEnv("APP_SECRET", APP_SECRET);
  await openRouteTestDatabase();
  vi.resetModules();
  const db = getDatabase();
  const alpha = await createWorkspacesRepository(db).create({
    name: "Alpha",
    slug: "alpha",
    createdBy: null,
  });
  const people: Record<WorkspaceRole, SessionLookup> = {
    owner: await signedInMember(db, {
      id: "owner-alpha",
      workspaceId: alpha.id,
      role: "owner",
    }),
    admin: await signedInMember(db, {
      id: "admin-alpha",
      workspaceId: alpha.id,
      role: "admin",
    }),
    member: await signedInMember(db, {
      id: "member-alpha",
      workspaceId: alpha.id,
      role: "member",
    }),
  };
  const files: Record<string, RouteFile> = {
    "/llm-keys/openrouter":
      (await import("../../src/app/api/w/[workspace]/llm-keys/[provider]/route.ts")) as unknown as RouteFile,
    "/llm-keys/openrouter/test":
      (await import("../../src/app/api/w/[workspace]/llm-keys/[provider]/test/route.ts")) as unknown as RouteFile,
    "/llm-keys/claude-code":
      (await import("../../src/app/api/w/[workspace]/llm-keys/claude-code/route.ts")) as unknown as RouteFile,
    "/llm-keys/claude-code/test":
      (await import("../../src/app/api/w/[workspace]/llm-keys/claude-code/test/route.ts")) as unknown as RouteFile,
    "/llm-key":
      (await import("../../src/app/api/w/[workspace]/llm-key/route.ts")) as unknown as RouteFile,
    "/llm-key/test":
      (await import("../../src/app/api/w/[workspace]/llm-key/test/route.ts")) as unknown as RouteFile,
  };
  const call = (
    role: WorkspaceRole,
    path: string,
    method: "GET" | "PUT" | "DELETE" | "POST",
  ) => {
    session.currentLookup.mockResolvedValue(people[role]);
    const handler = files[path]?.[method];
    if (handler === undefined) throw new Error(`${method} ${path} is missing`);
    return handler(
      new Request(`https://app.test/api/w/alpha${path}`, { method }),
      {
        params: Promise.resolve({ workspace: "alpha", provider: "openrouter" }),
      } as never,
    );
  };
  return { call };
}

describe("the role action of the LLM key route files", () => {
  // #426-T04
  it.each([
    ["/llm-keys/openrouter", "PUT"],
    ["/llm-keys/openrouter", "DELETE"],
    ["/llm-keys/openrouter/test", "POST"],
    // #1150-T03
    ["/llm-keys/claude-code", "PUT"],
    ["/llm-keys/claude-code", "DELETE"],
    ["/llm-keys/claude-code/test", "POST"],
    ["/llm-key", "PUT"],
    ["/llm-key", "DELETE"],
    ["/llm-key/test", "POST"],
  ] as const)(
    "refuse a Member on %s %s before any handler runs, and serve an Admin and an Owner",
    async (path, method) => {
      const t = await start();

      const refused = await t.call("member", path, method);
      expect(refused.status).toBe(403);
      expect(reached.calls).toEqual([]);

      for (const role of ["admin", "owner"] as const)
        expect((await t.call(role, path, method)).status).toBe(200);
      expect(reached.calls).toHaveLength(2);
    },
  );

  // #426-T04
  it.each([
    "/llm-keys/openrouter",
    "/llm-keys/claude-code",
    "/llm-key",
  ] as const)(
    "let a Member read %s (the action is view, not manage_llm_key)",
    async (path) => {
      const t = await start();

      const read = await t.call("member", path, "GET");

      expect(read.status).toBe(200);
      expect(reached.calls).toEqual(["get"]);
    },
  );
});
