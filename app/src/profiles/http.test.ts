// SPDX-License-Identifier: LicenseRef-Proprietary

// The handlers behind the profile routes (#843): the user first, then where the request comes from and what it carries, then the
// service; a stable code and `Cache-Control: no-store` on every answer. The workspace and the role are checked by the route files
// (integration-tests/http/profile-route-files.integration.test.ts).
import { describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../auth/access-policy.ts";
import { issue } from "../workflows/issues.ts";
import { ProfileError } from "./errors.ts";
import { createProfileRouteHandlers } from "./http.ts";
import { PROFILE_BODY_MAX_BYTES } from "./limits.ts";
import type { ProfileService, ProfileView } from "./service.ts";

const USER = {
  id: "user-1",
  githubLogin: "octocat",
  email: "octocat@example.test",
} as unknown as SessionUser;

const VIEW: ProfileView = {
  id: "pr-1",
  name: "reviewer",
  version: 2,
  createdAt: "2026-11-04T08:00:00.000Z",
  updatedAt: "2026-11-04T09:00:00.000Z",
  archivedAt: null,
  documentVersion: 2,
  document: {
    name: "reviewer",
    description: "",
    model: { entryId: "e" },
    instructions: "",
    canPush: false,
    defaultResult: null,
    harness: "opencode",
    environment: "node",
  },
  versions: [
    { version: 2, savedAt: "2026-11-04T09:00:00.000Z" },
    { version: 1, savedAt: "2026-11-04T08:00:00.000Z" },
  ],
};

function setup(overrides: Partial<ProfileService> = {}) {
  const calls: string[] = [];
  const service: ProfileService = {
    validate: async (body) => (
      calls.push(`validate ${JSON.stringify(body)}`),
      { valid: true, errors: [], truncated: false }
    ),
    list: async () => (calls.push("list"), { profiles: [VIEW], maximum: 100 }),
    get: async (id, version) => (calls.push(`get ${id} ${version}`), VIEW),
    create: async (_user, body) => (
      calls.push(`create ${JSON.stringify(body)}`),
      VIEW
    ),
    update: async (_user, id, body, expected) => (
      calls.push(`update ${id} ${JSON.stringify(body)} ${expected}`),
      VIEW
    ),
    archive: async (id) => (calls.push(`archive ${id}`), VIEW),
    ...overrides,
  };
  const requireUser = vi.fn(async () => USER);
  const handlers = createProfileRouteHandlers({ requireUser, service });
  const url = "https://app.test/api/w/default/profiles";
  const json = (
    method: string,
    body: unknown,
    headers: Record<string, string> = {},
    query = "",
  ) =>
    new Request(`${url}${query}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { handlers, calls, requireUser, json, url };
}

describe("the profile handlers", () => {
  // #843-T100
  it("asks for the user first, on every call", async () => {
    const { handlers, requireUser, json, url } = setup();

    await handlers.list(new Request(url));
    await handlers.get(new Request(url), "pr-1");
    await handlers.validate(json("POST", {}));
    await handlers.create(json("POST", {}));
    await handlers.update(json("PUT", {}), "pr-1");
    await handlers.archive(new Request(url, { method: "DELETE" }), "pr-1");

    expect(requireUser).toHaveBeenCalledTimes(6);
  });

  // #843-T101
  it("lists, reads and answers with no-store", async () => {
    const { handlers, url } = setup();

    const list = await handlers.list(new Request(url));
    const one = await handlers.get(new Request(url), "pr-1");

    expect(list.headers.get("cache-control")).toBe("no-store");
    expect(await list.json()).toMatchObject({ maximum: 100 });
    expect(one.headers.get("cache-control")).toBe("no-store");
    expect(await one.json()).toEqual({ profile: VIEW });
  });

  // #843-T102
  it("passes the version asked for to the service, and refuses one that is no whole number", async () => {
    const { handlers, calls, url } = setup();

    await handlers.get(new Request(`${url}/pr-1?version=3`), "pr-1");
    const bad = await handlers.get(
      new Request(`${url}/pr-1?version=abc`),
      "pr-1",
    );

    expect(calls).toEqual(["get pr-1 3"]);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({
      error: "PROFILE_REQUEST_INVALID",
    });
  });

  // #843-T103
  it("creates with 201 from the body, which is the profile", async () => {
    const { handlers, calls, json } = setup();

    const created = await handlers.create(json("POST", { name: "x" }));

    expect(created.status).toBe(201);
    expect(calls).toEqual(['create {"name":"x"}']);
  });

  // #843-T104
  it("saves a new version and passes expectedVersion", async () => {
    const { handlers, calls, json } = setup();

    const saved = await handlers.update(
      json("PUT", { a: 1 }, {}, "?expectedVersion=2"),
      "pr-1",
    );

    expect(saved.status).toBe(200);
    expect(calls).toEqual(['update pr-1 {"a":1} 2']);
  });

  // #843-T105
  it("validates without storing, and a profile with problems is an answer, not an error", async () => {
    const errors = [issue("/model", "missing_field", "model is required")];
    const { handlers, json } = setup({
      validate: async () => ({ valid: false, errors, truncated: false }),
    });

    const response = await handlers.validate(json("POST", {}));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      valid: false,
      errors,
      truncated: false,
    });
  });

  // #843-T106
  it("refuses an invalid profile with 422 and the whole list of errors, and says whether it is cut", async () => {
    const errors = [
      issue("/name", "invalid_value", "no"),
      issue("/canPush", "wrong_type", "no"),
    ];
    const { handlers, json } = setup({
      create: async () => {
        throw new ProfileError("PROFILE_INVALID", "invalid", {
          errors,
          truncated: true,
        });
      },
    });

    const response = await handlers.create(json("POST", {}));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "PROFILE_INVALID",
      message: "invalid",
      errors,
      truncated: true,
    });
  });

  // #843-T107
  it.each([
    ["PROFILE_NAME_TAKEN", 409, {}],
    ["PROFILE_NAME_CHANGED", 422, {}],
    ["PROFILE_NOT_FOUND", 404, {}],
    ["PROFILE_VERSION_NOT_FOUND", 404, {}],
    ["PROFILE_LIMIT_REACHED", 409, { maximum: 100 }],
    ["PROFILE_ARCHIVE_LIMIT_REACHED", 409, { maximum: 1000 }],
    ["PROFILE_VERSION_LIMIT_REACHED", 409, { maximum: 200 }],
    ["PROFILE_VERSION_CONFLICT", 409, { current: 4 }],
    ["PROFILE_ARCHIVED", 409, {}],
  ] as const)(
    "answers %s with %i and its details",
    async (code, status, details) => {
      const { handlers, json } = setup({
        update: async () => {
          throw new ProfileError(code, "x", details);
        },
      });

      const response = await handlers.update(json("PUT", {}), "pr-1");

      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: code, ...details });
    },
  );

  // #843-T108
  it("refuses a request from another site before it reads anything", async () => {
    const { handlers, calls, json, url } = setup();

    const response = await handlers.create(
      json("POST", {}, { "sec-fetch-site": "cross-site" }),
    );
    const archive = await handlers.archive(
      new Request(`${url}/pr-1`, {
        method: "DELETE",
        headers: {
          origin: "https://evil.test",
          "sec-fetch-site": "cross-site",
        },
      }),
      "pr-1",
    );

    expect(response.status).toBe(403);
    expect(archive.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: "PROFILE_CROSS_SITE_REQUEST",
    });
    expect(calls).toEqual([]);
  });

  // #843-T109
  it("refuses a body that is not JSON, not application/json, or too large", async () => {
    const { handlers, calls, url } = setup();
    const post = (body: string, type = "application/json") =>
      new Request(url, {
        method: "POST",
        headers: { "content-type": type },
        body,
      });

    const notJson = await handlers.validate(post("{nope"));
    const wrongType = await handlers.validate(post("{}", "text/plain"));
    const tooLarge = await handlers.validate(
      post(`"${"x".repeat(PROFILE_BODY_MAX_BYTES)}"`),
    );

    expect([notJson.status, wrongType.status, tooLarge.status]).toEqual([
      400, 415, 413,
    ]);
    expect(await notJson.json()).toMatchObject({
      error: "PROFILE_REQUEST_INVALID",
    });
    expect(await wrongType.json()).toMatchObject({
      error: "PROFILE_CONTENT_TYPE_UNSUPPORTED",
    });
    expect(await tooLarge.json()).toMatchObject({
      error: "PROFILE_BODY_TOO_LARGE",
    });
    expect(calls).toEqual([]);
  });

  // #843-T110
  it("lets an error that is not its own through", async () => {
    const { handlers, url } = setup({
      list: async () => {
        throw new Error("database down");
      },
    });

    await expect(handlers.list(new Request(url))).rejects.toThrow(
      "database down",
    );
  });
});
