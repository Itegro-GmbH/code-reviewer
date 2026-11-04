// SPDX-License-Identifier: LicenseRef-Proprietary

// The handlers behind the workflow routes (#833): the user first, then where the request comes from and what it carries, then the
// service; a stable code and `Cache-Control: no-store` on every answer. The workspace and the role are checked by the route files
// (integration-tests/http/workflow-route-files.integration.test.ts).
import { describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../auth/access-policy.ts";
import { WorkflowError } from "./errors.ts";
import { createWorkflowRouteHandlers } from "./http.ts";
import { issue } from "./issues.ts";
import { DOCUMENT_MAX_BYTES } from "./limits.ts";
import type { WorkflowService, WorkflowView } from "./service.ts";

const USER = {
  id: "user-1",
  githubLogin: "octocat",
  email: "octocat@example.test",
} as unknown as SessionUser;

const VIEW: WorkflowView = {
  id: "wf-1",
  name: "Issue to PR",
  version: 2,
  createdAt: "2026-11-04T08:00:00.000Z",
  updatedAt: "2026-11-04T09:00:00.000Z",
  documentVersion: 2,
  document: { version: 1 },
  versions: [
    { version: 2, savedAt: "2026-11-04T09:00:00.000Z" },
    { version: 1, savedAt: "2026-11-04T08:00:00.000Z" },
  ],
};

function setup(overrides: Partial<WorkflowService> = {}) {
  const calls: string[] = [];
  const service: WorkflowService = {
    validate: async (body) => (
      calls.push(`validate ${JSON.stringify(body)}`),
      { valid: true, errors: [], truncated: false, steps: 1, budgetUsd: 20 }
    ),
    list: async () => (calls.push("list"), { workflows: [VIEW], maximum: 100 }),
    get: async (id, version) => (calls.push(`get ${id} ${version}`), VIEW),
    create: async (_user, body) => (
      calls.push(`create ${JSON.stringify(body)}`),
      VIEW
    ),
    update: async (_user, id, body, expected) => (
      calls.push(`update ${id} ${JSON.stringify(body)} ${expected}`),
      VIEW
    ),
    ...overrides,
  };
  const requireUser = vi.fn(async () => USER);
  const handlers = createWorkflowRouteHandlers({ requireUser, service });
  const url = "https://app.test/api/w/default/workflows";
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

describe("the workflow handlers", () => {
  // #833-M1-T180
  it("asks for the user first, on every call", async () => {
    const { handlers, requireUser, json, url } = setup();

    await handlers.list(new Request(url));
    await handlers.get(new Request(url), "wf-1");
    await handlers.validate(json("POST", {}));
    await handlers.create(json("POST", {}));
    await handlers.update(json("PUT", {}), "wf-1");

    expect(requireUser).toHaveBeenCalledTimes(5);
  });

  // #833-M1-T181
  it("lists, reads and answers with no-store", async () => {
    const { handlers, url } = setup();

    const list = await handlers.list(new Request(url));
    const one = await handlers.get(new Request(url), "wf-1");

    expect(list.headers.get("cache-control")).toBe("no-store");
    expect(await list.json()).toMatchObject({ maximum: 100 });
    expect(one.headers.get("cache-control")).toBe("no-store");
    expect(await one.json()).toEqual({ workflow: VIEW });
  });

  // #833-M1-T182
  it("passes the version asked for to the service, and refuses one that is no whole number", async () => {
    const { handlers, calls, url } = setup();

    await handlers.get(new Request(`${url}/wf-1?version=3`), "wf-1");
    const bad = await handlers.get(
      new Request(`${url}/wf-1?version=abc`),
      "wf-1",
    );

    expect(calls).toEqual(["get wf-1 3"]);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({
      error: "WORKFLOW_REQUEST_INVALID",
    });
  });

  // #833-M1-T183
  it("creates with 201 from the body, which is the document", async () => {
    const { handlers, calls, json } = setup();

    const created = await handlers.create(
      json("POST", { version: 1, name: "x" }),
    );

    expect(created.status).toBe(201);
    expect(calls).toEqual(['create {"version":1,"name":"x"}']);
  });

  // #833-M1-T184
  it("saves a new version and passes expectedVersion", async () => {
    const { handlers, calls, json } = setup();

    const saved = await handlers.update(
      json("PUT", { a: 1 }, {}, "?expectedVersion=2"),
      "wf-1",
    );

    expect(saved.status).toBe(200);
    expect(calls).toEqual(['update wf-1 {"a":1} 2']);
  });

  // #833-M1-T185
  it("validates without storing, and a document with problems is an answer, not an error", async () => {
    const errors = [issue("/steps/0/id", "missing_field", "'id' is required")];
    const { handlers, json } = setup({
      validate: async () => ({
        valid: false,
        errors,
        truncated: false,
        steps: 1,
      }),
    });

    const response = await handlers.validate(json("POST", {}));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      valid: false,
      errors,
      truncated: false,
      steps: 1,
    });
  });

  // #833-M1-T186
  it("refuses an invalid document with 422 and the whole list of errors", async () => {
    const errors = [
      issue("/steps/0/profile", "profile_unknown", "no", ["implementer"]),
      issue("/trigger/kind", "unknown_trigger_kind", "no", ["manual"]),
    ];
    const { handlers, json } = setup({
      create: async () => {
        throw new WorkflowError("WORKFLOW_INVALID", "invalid", { errors });
      },
    });

    const response = await handlers.create(json("POST", {}));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "WORKFLOW_INVALID",
      message: "invalid",
      errors,
    });
  });

  // #833-M1-T187
  it.each([
    ["WORKFLOW_NAME_TAKEN", 409, {}],
    ["WORKFLOW_NOT_FOUND", 404, {}],
    ["WORKFLOW_VERSION_NOT_FOUND", 404, {}],
    ["WORKFLOW_LIMIT_REACHED", 409, { maximum: 100 }],
    ["WORKFLOW_VERSION_LIMIT_REACHED", 409, { maximum: 200 }],
    ["WORKFLOW_VERSION_CONFLICT", 409, { current: 4 }],
  ] as const)(
    "answers %s with %i and its details",
    async (code, status, details) => {
      const { handlers, json } = setup({
        update: async () => {
          throw new WorkflowError(code, "x", details);
        },
      });

      const response = await handlers.update(json("PUT", {}), "wf-1");

      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: code, ...details });
    },
  );

  // #833-M1-T188
  it("refuses a request from another site before it reads anything", async () => {
    const { handlers, calls, json } = setup();

    const response = await handlers.create(
      json("POST", {}, { "sec-fetch-site": "cross-site" }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: "WORKFLOW_CROSS_SITE_REQUEST",
    });
    expect(calls).toEqual([]);
  });

  // #833-M1-T189
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
      post(`"${"x".repeat(DOCUMENT_MAX_BYTES)}"`),
    );

    expect([notJson.status, wrongType.status, tooLarge.status]).toEqual([
      400, 415, 413,
    ]);
    expect(await notJson.json()).toMatchObject({
      error: "WORKFLOW_REQUEST_INVALID",
    });
    expect(await wrongType.json()).toMatchObject({
      error: "WORKFLOW_CONTENT_TYPE_UNSUPPORTED",
    });
    expect(await tooLarge.json()).toMatchObject({
      error: "WORKFLOW_BODY_TOO_LARGE",
    });
    expect(calls).toEqual([]);
  });

  // #833-M1-T190
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
