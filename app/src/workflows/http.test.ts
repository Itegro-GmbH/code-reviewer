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
  projectId: "project-1",
  name: "Issue to PR",
  version: 2,
  createdAt: "2026-11-04T08:00:00.000Z",
  updatedAt: "2026-11-04T09:00:00.000Z",
  archivedAt: null,
  documentVersion: 2,
  document: { version: 1 },
  versions: [
    { version: 2, savedAt: "2026-11-04T09:00:00.000Z" },
    { version: 1, savedAt: "2026-11-04T08:00:00.000Z" },
  ],
};

const ARCHIVED: WorkflowView = {
  ...VIEW,
  archivedAt: "2026-11-04T10:00:00.000Z",
};

function setup(overrides: Partial<WorkflowService> = {}) {
  const calls: string[] = [];
  const service: WorkflowService = {
    validate: async (body) => (
      calls.push(`validate ${JSON.stringify(body)}`),
      { valid: true, errors: [], truncated: false, steps: 1, budgetUsd: 20 }
    ),
    scope: async (body) => (
      calls.push(`scope ${JSON.stringify(body)}`),
      { at: "/steps/0", entries: [], truncated: false, sampled: false }
    ),
    list: async (projectId) => (
      calls.push(`list ${projectId}`),
      { workflows: [VIEW], maximum: 100 }
    ),
    get: async (id, version) => (calls.push(`get ${id} ${version}`), VIEW),
    create: async (_user, projectId, body) => (
      calls.push(`create ${projectId} ${JSON.stringify(body)}`),
      VIEW
    ),
    copyBuiltIn: async () => [],
    update: async (_user, id, body, expected) => (
      calls.push(`update ${id} ${JSON.stringify(body)} ${expected}`),
      VIEW
    ),
    archive: async (id) => (calls.push(`archive ${id}`), ARCHIVED),
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
    await handlers.archive(new Request(url, { method: "DELETE" }), "wf-1");

    expect(requireUser).toHaveBeenCalledTimes(6);
  });

  // #927-T20
  it("answers the scope lookup with no-store, after the user, and refuses another site", async () => {
    const { handlers, calls, requireUser, json } = setup();

    const answered = await handlers.scope(
      json("POST", { document: {}, at: "/steps/0" }),
    );
    const cross = await handlers.scope(
      json(
        "POST",
        { document: {}, at: "/steps/0" },
        { "sec-fetch-site": "cross-site" },
      ),
    );

    expect(requireUser).toHaveBeenCalledTimes(2);
    expect(answered.headers.get("cache-control")).toBe("no-store");
    expect(await answered.json()).toMatchObject({ at: "/steps/0" });
    expect(calls).toEqual(['scope {"document":{},"at":"/steps/0"}']);
    expect(cross.status).toBe(403);
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
      json("POST", { version: 1, name: "x" }, {}, "?projectId=project-1"),
    );

    expect(created.status).toBe(201);
    expect(calls).toEqual(['create project-1 {"version":1,"name":"x"}']);
  });

  // #922-T20
  it("hands the projectId of the query to the list and to the create, and nothing when there is none", async () => {
    const { handlers, calls, json, url } = setup();

    await handlers.list(new Request(`${url}?projectId=project-1`));
    await handlers.list(new Request(url));
    await handlers.create(json("POST", {}));

    expect(calls).toEqual([
      "list project-1",
      "list undefined",
      "create undefined {}",
    ]);
  });

  // #922-T21
  it("answers a missing or unknown project with 400 and the request issue that names the available projects", async () => {
    const { handlers, url } = setup({
      list: async () => {
        throw new WorkflowError(
          "WORKFLOW_PROJECT_REQUIRED",
          "A lane belongs to a project: name it with projectId.",
          {
            issues: [
              {
                path: "projectId",
                code: "project_required",
                message: "projectId is required.",
                available: ["project-1"],
              },
            ],
          },
        );
      },
    });

    const refused = await handlers.list(new Request(url));

    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({
      error: "WORKFLOW_PROJECT_REQUIRED",
      issues: [
        {
          path: "projectId",
          code: "project_required",
          available: ["project-1"],
        },
      ],
    });
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
      truncated: false,
    });
  });

  // #833-M1-T373
  it("says on WORKFLOW_INVALID whether the list of errors is cut", async () => {
    const errors = [issue("/steps/0/profile", "profile_unknown", "no")];
    const { handlers, json } = setup({
      create: async () => {
        throw new WorkflowError("WORKFLOW_INVALID", "invalid", {
          errors,
          truncated: true,
        });
      },
    });

    const response = await handlers.create(json("POST", {}));

    expect(await response.json()).toMatchObject({ truncated: true });
  });

  // #833-M1-T187
  it.each([
    ["WORKFLOW_NAME_TAKEN", 409, {}],
    ["WORKFLOW_NOT_FOUND", 404, {}],
    ["WORKFLOW_VERSION_NOT_FOUND", 404, {}],
    ["WORKFLOW_LIMIT_REACHED", 409, { maximum: 100 }],
    ["WORKFLOW_ARCHIVE_LIMIT_REACHED", 409, { maximum: 1000 }],
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

describe("archiving a workflow", () => {
  // #833-M1-T357
  it("archives through the service and answers with the workflow, no-store", async () => {
    const { handlers, calls, url } = setup();

    const response = await handlers.archive(
      new Request(`${url}/wf-1`, { method: "DELETE" }),
      "wf-1",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ workflow: ARCHIVED });
    expect(calls).toEqual(["archive wf-1"]);
  });

  // #833-M1-T358
  it("refuses a request from another site, and says WORKFLOW_ARCHIVED with its status when the service does", async () => {
    const { handlers, calls, url } = setup({
      update: async () => {
        throw new WorkflowError(
          "WORKFLOW_ARCHIVED",
          "The workflow is archived.",
        );
      },
    });

    const foreign = await handlers.archive(
      new Request(`${url}/wf-1`, {
        method: "DELETE",
        headers: {
          origin: "https://evil.test",
          "sec-fetch-site": "cross-site",
        },
      }),
      "wf-1",
    );
    const update = await handlers.update(
      new Request(`${url}/wf-1`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      "wf-1",
    );

    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toMatchObject({
      error: "WORKFLOW_CROSS_SITE_REQUEST",
    });
    expect(calls).toEqual([]);
    expect(update.status).toBe(409);
    expect(await update.json()).toMatchObject({ error: "WORKFLOW_ARCHIVED" });
  });
});
