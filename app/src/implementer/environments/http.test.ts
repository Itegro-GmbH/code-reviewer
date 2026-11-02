// SPDX-License-Identifier: LicenseRef-Proprietary

// The handlers behind the environment routes (#818): the user first, then where the request comes from and what it carries, then
// the service; a stable code and `Cache-Control: no-store` on every answer. The workspace and the role are checked by the route
// files (integration-tests/http/environment-route-files.integration.test.ts).
import { describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../../auth/access-policy.ts";
import { EnvironmentError } from "./errors.ts";
import {
  createEnvironmentRouteHandlers,
  ENVIRONMENT_REQUEST_MAX_BYTES,
} from "./http.ts";
import type { EnvironmentService, EnvironmentView } from "./service.ts";

const USER = {
  id: "user-1",
  githubLogin: "octocat",
  email: "octocat@example.test",
} as unknown as SessionUser;

const VIEW: EnvironmentView = {
  id: "env-1",
  name: "Node 22",
  vcpus: 4,
  memoryGb: 8,
  setupScript: "npm ci",
  createdAt: "2026-11-02T08:00:00.000Z",
  updatedAt: "2026-11-02T08:00:00.000Z",
};

function setup(overrides: Partial<EnvironmentService> = {}) {
  const calls: string[] = [];
  const service: EnvironmentService = {
    list: async () => (
      calls.push("list"),
      { environments: [VIEW], maximum: 50 }
    ),
    get: async () => (calls.push("get"), VIEW),
    create: async (_user, body) => (
      calls.push(`create ${JSON.stringify(body)}`),
      VIEW
    ),
    update: async (id, body) => (
      calls.push(`update ${id} ${JSON.stringify(body)}`),
      VIEW
    ),
    remove: async (id) => void calls.push(`remove ${id}`),
    ...overrides,
  };
  const requireUser = vi.fn(async () => USER);
  const handlers = createEnvironmentRouteHandlers({ requireUser, service });
  const url = "https://app.test/api/w/default/environments";
  const json = (
    method: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    new Request(url, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { handlers, calls, requireUser, json, url };
}

describe("the environment handlers", () => {
  // #818-T08
  it("answers the list uncached", async () => {
    const { handlers, url } = setup();

    const response = await handlers.list(new Request(url));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      environments: [VIEW],
      maximum: 50,
    });
  });

  // #818-T08
  it("creates with 201 and the environment", async () => {
    const { handlers, json, calls } = setup();

    const response = await handlers.create(
      json("POST", { name: "Node 22", vcpus: 4 }),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ environment: VIEW });
    expect(calls).toEqual([
      `create ${JSON.stringify({ name: "Node 22", vcpus: 4 })}`,
    ]);
  });

  // #818-T08
  it("changes with 200 and deletes with 200 and a body the page can read", async () => {
    const { handlers, json, calls } = setup();

    const updated = await handlers.update(
      json("PUT", { name: "x", vcpus: 2 }),
      "env-1",
    );
    const removed = await handlers.remove(
      new Request("https://app.test/x", { method: "DELETE" }),
      "env-1",
    );

    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({ environment: VIEW });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ removed: true });
    expect(removed.headers.get("cache-control")).toBe("no-store");
    expect(calls).toEqual([
      `update env-1 ${JSON.stringify({ name: "x", vcpus: 2 })}`,
      "remove env-1",
    ]);
  });

  // #818-T08
  it("asks for the user before it looks at anything else", async () => {
    const { handlers, requireUser } = setup();
    requireUser.mockRejectedValueOnce(
      new Error("redirected to the login page"),
    );

    await expect(
      handlers.create(
        new Request("https://app.test/x", {
          method: "POST",
          headers: { "sec-fetch-site": "cross-site" },
        }),
      ),
    ).rejects.toThrow("redirected to the login page");
  });

  // #818-T08
  it.each(["POST", "PUT", "DELETE"] as const)(
    "refuses a cross-site %s before the service is called",
    async (method) => {
      const { handlers, calls } = setup();
      const request = new Request("https://app.test/x", {
        method,
        headers: {
          "content-type": "application/json",
          "sec-fetch-site": "cross-site",
        },
        body: method === "DELETE" ? null : "{}",
      });

      const response =
        method === "POST"
          ? await handlers.create(request)
          : method === "PUT"
            ? await handlers.update(request, "env-1")
            : await handlers.remove(request, "env-1");

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: "ENVIRONMENT_CROSS_SITE_REQUEST",
      });
      expect(calls).toEqual([]);
    },
  );

  // #818-T08
  it("refuses a body that is not JSON, not valid or too large", async () => {
    const { handlers, calls, url } = setup();

    const notJson = await handlers.create(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "{}",
      }),
    );
    const broken = await handlers.create(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
    );
    const large = await handlers.create(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "x".repeat(ENVIRONMENT_REQUEST_MAX_BYTES + 1),
      }),
    );

    expect(notJson.status).toBe(415);
    expect(await notJson.json()).toEqual({
      error: "ENVIRONMENT_CONTENT_TYPE_UNSUPPORTED",
    });
    expect(broken.status).toBe(400);
    expect(await broken.json()).toEqual({
      error: "ENVIRONMENT_REQUEST_INVALID",
    });
    expect(large.status).toBe(413);
    expect(await large.json()).toEqual({ error: "ENVIRONMENT_BODY_TOO_LARGE" });
    expect(calls).toEqual([]);
  });

  // #818-T08
  it("holds a script of 64 KB whose every byte is an escape in the JSON", async () => {
    // 65536 control characters, each written as the six characters \u001b: the largest honest body.
    expect(ENVIRONMENT_REQUEST_MAX_BYTES).toBeGreaterThan(6 * 65536);
  });

  // #818-T08
  it("answers a refusal of the service with its status, code and details, never a message", async () => {
    const { handlers, json } = setup({
      create: async () => {
        throw new EnvironmentError(
          "ENVIRONMENT_REQUEST_INVALID",
          "secret detail",
          {
            issues: [{ field: "vcpus", code: "invalid" }],
          },
        );
      },
      update: async () => {
        throw new EnvironmentError("ENVIRONMENT_NAME_TAKEN", "x");
      },
      remove: async () => {
        throw new EnvironmentError("ENVIRONMENT_NOT_FOUND", "x");
      },
    });

    const invalid = await handlers.create(json("POST", {}));
    const taken = await handlers.update(json("PUT", {}), "env-1");
    const missing = await handlers.remove(
      new Request("https://app.test/x", { method: "DELETE" }),
      "nope",
    );

    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: "ENVIRONMENT_REQUEST_INVALID",
      issues: [{ field: "vcpus", code: "invalid" }],
    });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({ error: "ENVIRONMENT_NAME_TAKEN" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "ENVIRONMENT_NOT_FOUND" });
  });

  // #818-T08
  it("names the maximum when the workspace is full", async () => {
    const { handlers, json } = setup({
      create: async () => {
        throw new EnvironmentError("ENVIRONMENT_LIMIT_REACHED", "x", {
          maximum: 50,
        });
      },
    });

    const response = await handlers.create(json("POST", {}));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "ENVIRONMENT_LIMIT_REACHED",
      maximum: 50,
    });
  });

  // #818-T08
  it("lets an unexpected failure through, so the platform answers 500", async () => {
    const { handlers, json } = setup({
      create: async () => {
        throw new Error("database is gone");
      },
    });

    await expect(
      handlers.create(json("POST", { name: "x", vcpus: 2 })),
    ).rejects.toThrow("database is gone");
  });
});
