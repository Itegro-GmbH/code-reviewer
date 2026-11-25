// SPDX-License-Identifier: LicenseRef-Proprietary

// The Claude Code OAuth token of a workspace (#1150), without a database: the one rule for a token, what a save refuses and keeps, that the
// answers carry no token, and the handlers of its routes (who may do what, what the test button says and does not do).
import { describe, expect, it, vi } from "vitest";
import { SecretValue } from "../secrets/secret-value.ts";
import type {
  WorkspaceSecretStatus,
  WorkspaceSecretStore,
} from "../secrets/workspace-store.ts";
import type { WorkspaceAccess } from "../workspaces/access.ts";
import {
  CLAUDE_CODE_TOKEN_BINDING,
  CLAUDE_CODE_TOKEN_SECRET_NAME,
  checkClaudeCodeToken,
  createClaudeCodeTokenService,
  hasKnownTokenShape,
  type ClaudeCodeTokenSecretName,
} from "./claude-code-token.ts";
import { createClaudeCodeTokenRouteHandlers } from "./claude-code-token-http.ts";

const TOKEN = "sk-ant-oat01-DUMMYDUMMYDUMMYDUMMYDUMMY0123456789-abcdef_WXYZ";
const OTHER = "sk-ant-oat01-OTHEROTHEROTHEROTHEROTHER0123456789-ghijkl_QRST";

/** A store in memory: it keeps what it is given and answers like the real one (the real one is proven in the integration test). */
function memoryStore(): WorkspaceSecretStore<ClaudeCodeTokenSecretName> & {
  held(): { value: string; binding: string } | undefined;
  breakIt(): void;
} {
  let row:
    { value: string; binding: string; lastFour: string | null } | undefined;
  let broken = false;
  const status = (name: string): WorkspaceSecretStatus =>
    row === undefined
      ? { name, state: "not_configured" }
      : broken
        ? {
            name,
            state: "undecryptable",
            binding: row.binding,
            code: "secret_undecryptable",
            updatedAt: "2026-11-25T00:00:00.000Z",
            updatedBy: "user-1",
          }
        : {
            name,
            state: "configured",
            binding: row.binding,
            lastFour: row.lastFour,
            keyVersion: 1,
            updatedAt: "2026-11-25T00:00:00.000Z",
            updatedBy: "user-1",
          };
  return {
    held: () => (row === undefined ? undefined : { ...row }),
    breakIt: () => {
      broken = true;
    },
    save: (_name, value, options) => {
      row = {
        value,
        binding: options.binding,
        lastFour: options.showLastFour === true ? value.slice(-4) : null,
      };
      return Promise.resolve({ ok: true });
    },
    status: (name) => Promise.resolve(status(name)),
    use: () =>
      Promise.resolve(
        row === undefined
          ? { ok: false, error: "secret_not_configured" }
          : broken
            ? { ok: false, error: "secret_undecryptable" }
            : {
                ok: true,
                value: new SecretValue(row.value),
                binding: row.binding,
              },
      ),
    remove: () => {
      const had = row !== undefined;
      row = undefined;
      return Promise.resolve(had);
    },
    take: () => Promise.reject(new Error("not used")),
    names: () =>
      Promise.resolve(row === undefined ? [] : [CLAUDE_CODE_TOKEN_SECRET_NAME]),
  };
}

describe("the rule for a Claude Code token", () => {
  // #1150-T01
  it("accepts one printable token and ignores whitespace around it", () => {
    expect(checkClaudeCodeToken(` ${TOKEN}\n`)).toEqual({
      ok: true,
      token: TOKEN,
    });
  });

  // #1150-T01
  it.each([
    ["whitespace inside", "sk-ant-oat01-abc def"],
    ["a line break inside", "sk-ant-oat01-abc\ndef"],
    ["a control character", "sk-ant-oat01-abc\u0007def"],
    ["a character that is not ASCII", "sk-ant-oat01-äbc"],
    ["more than 4096 characters", "k".repeat(4097)],
    ["nothing", "   "],
    ["not text", 12345],
  ])("refuses a token with %s", (_, value) => {
    expect(checkClaudeCodeToken(value)).toEqual({ ok: false });
  });

  // #1150-T01
  it("knows the shape of what `claude setup-token` prints, and no other", () => {
    expect(hasKnownTokenShape(TOKEN)).toBe(true);
    expect(hasKnownTokenShape("sk-or-v1-0123456789abcdef0123456789")).toBe(
      false,
    );
    expect(hasKnownTokenShape("sk-ant-oat01-short")).toBe(false);
  });
});

describe("the token service", () => {
  // #1150-T02
  it("saves the token under the name and the binding of its slot and answers with the last four characters only", async () => {
    const store = memoryStore();
    const service = createClaudeCodeTokenService({ store });

    const saved = await service.save(TOKEN, "user-1");

    expect(saved).toEqual({
      ok: true,
      changed: true,
      status: {
        state: "configured",
        lastFour: TOKEN.slice(-4),
        updatedAt: expect.any(String),
        updatedBy: "user-1",
      },
    });
    expect(JSON.stringify(saved)).not.toContain(TOKEN.slice(0, -4));
    expect(store.held()?.binding).toBe(CLAUDE_CODE_TOKEN_BINDING);
  });

  // #1150-T02
  it("keeps the stored token for an empty field, and asks for one when there is none", async () => {
    const service = createClaudeCodeTokenService({ store: memoryStore() });
    expect(await service.save("", "user-1")).toEqual({
      ok: false,
      issues: [{ field: "token", code: "token_required" }],
    });
    await service.save(TOKEN, "user-1");

    const kept = await service.save("  ", "user-2");

    expect(kept).toMatchObject({ ok: true, changed: false });
    expect(await service.tokenForJob()).toEqual({
      state: "token",
      token: TOKEN,
    });
  });

  // #1150-T02
  it("replaces the token and removes it", async () => {
    const service = createClaudeCodeTokenService({ store: memoryStore() });
    await service.save(TOKEN, "user-1");
    await service.save(OTHER, "user-1");
    expect(await service.tokenForJob()).toEqual({
      state: "token",
      token: OTHER,
    });

    expect(await service.remove()).toBe(true);
    expect(await service.remove()).toBe(false);
    expect(await service.tokenForJob()).toEqual({ state: "none" });
    expect(await service.status()).toEqual({ state: "not_configured" });
  });

  // #1150-T02
  it("refuses a token the runner would refuse and stores nothing", async () => {
    const store = memoryStore();
    const service = createClaudeCodeTokenService({ store });

    expect(await service.save("two tokens", "user-1")).toEqual({
      ok: false,
      issues: [{ field: "token", code: "token_invalid" }],
    });
    expect(store.held()).toBeUndefined();
  });

  // #1150-T02
  it("says a token that cannot be read is unreadable and never hands out a wrong one", async () => {
    const store = memoryStore();
    const service = createClaudeCodeTokenService({ store });
    await service.save(TOKEN, "user-1");
    store.breakIt();

    expect(await service.status()).toMatchObject({ state: "unreadable" });
    expect(await service.tokenForJob()).toEqual({ state: "unreadable" });
  });

  // #1150-T02
  it("never uses a token that was stored for something else", async () => {
    const store = memoryStore();
    await store.save(CLAUDE_CODE_TOKEN_SECRET_NAME, TOKEN, {
      binding: "openrouter",
      updatedBy: null,
    });

    const revealed = await createClaudeCodeTokenService({ store }).reveal();

    expect(revealed).toEqual({ ok: false, reason: "token_binding_mismatch" });
  });
});

function access(role: "owner" | "admin" | "member"): WorkspaceAccess {
  return {
    role,
    user: { id: "user-1" },
    workspace: { id: "ws-1" },
  } as unknown as WorkspaceAccess;
}

function json(body: unknown): Request {
  return new Request("https://example.test/api", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("the routes of the token", () => {
  async function handlers() {
    const store = memoryStore();
    const token = createClaudeCodeTokenService({ store });
    return {
      store,
      token,
      routes: createClaudeCodeTokenRouteHandlers({ token }),
    };
  }

  // #1150-T03
  it("lets a Member see whether a token exists and nothing else, and an Admin its last four characters", async () => {
    const { token, routes } = await handlers();
    await token.save(TOKEN, "user-1");

    const member = await (await routes.get(json({}), access("member"))).json();
    const admin = await (await routes.get(json({}), access("admin"))).json();

    expect(member).toEqual({
      canManage: false,
      token: { state: "configured" },
    });
    expect(admin).toMatchObject({
      canManage: true,
      token: { state: "configured", lastFour: TOKEN.slice(-4) },
    });
    expect(JSON.stringify([member, admin])).not.toContain(TOKEN.slice(0, -4));
  });

  // #1150-T03
  it("refuses a Member to save, remove and test", async () => {
    const { routes } = await handlers();
    for (const call of [routes.put, routes.remove, routes.test]) {
      const response = await call(json({ token: TOKEN }), access("member"));
      expect(response.status).toBe(403);
    }
  });

  // #1150-T03
  it("saves from the body, answers without the token and keeps nothing for a refused one", async () => {
    const { store, routes } = await handlers();

    const refused = await routes.put(
      json({ token: "two tokens" }),
      access("owner"),
    );
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({
      error: "invalid_input",
      issues: [{ field: "token", code: "token_invalid" }],
    });
    expect(store.held()).toBeUndefined();

    const saved = await routes.put(json({ token: TOKEN }), access("admin"));
    expect(saved.status).toBe(200);
    expect(saved.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(await saved.json())).not.toContain(
      TOKEN.slice(0, -4),
    );
    expect(store.held()?.value).toBe(TOKEN);
  });

  // #1150-T04
  it("tests the shape of a typed token, or of the stored one, and sends nothing anywhere", async () => {
    const fetched = vi.spyOn(globalThis, "fetch");
    const { token, routes } = await handlers();

    const typed = await routes.test(json({ token: TOKEN }), access("admin"));
    expect(await typed.json()).toEqual({
      ok: true,
      verified: false,
      format: "known",
    });

    const unusual = await routes.test(
      json({ token: "abc123" }),
      access("admin"),
    );
    expect(await unusual.json()).toEqual({
      ok: true,
      verified: false,
      format: "unknown",
    });

    const none = await routes.test(json({}), access("admin"));
    expect(none.status).toBe(422);
    expect(await none.json()).toEqual({
      error: "invalid_input",
      issues: [{ field: "token", code: "token_required" }],
    });

    await token.save(TOKEN, "user-1");
    const stored = await routes.test(json({}), access("admin"));
    expect(await stored.json()).toEqual({
      ok: true,
      verified: false,
      format: "known",
    });

    const broken = await routes.test(
      json({ token: "two tokens" }),
      access("admin"),
    );
    expect(broken.status).toBe(422);
    expect(fetched).not.toHaveBeenCalled();
    fetched.mockRestore();
  });
});
