// SPDX-License-Identifier: LicenseRef-Proprietary

// The handlers behind the run routes (#844): the user first, then where the request comes from and what it carries, then the service;
// a stable code and `Cache-Control: no-store` on every answer. The workspace and the right are checked by the route files
// (integration-tests/http/workflow-run-route-files.integration.test.ts).
import { describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../auth/access-policy.ts";
import { WORKFLOW_RUN_ERROR_STATUS, WorkflowRunError } from "./errors.ts";
import {
  START_BODY_MAX_BYTES,
  createWorkflowRunRouteHandlers,
} from "./http.ts";
import type { RunSummaryView, RunView, WorkflowRunService } from "./service.ts";

const USER = {
  id: "user-1",
  githubLogin: "octocat",
  email: "octocat@example.test",
} as unknown as SessionUser;

const SUMMARY: RunSummaryView = {
  id: "run-1",
  workflowId: "wf-1",
  workflowVersion: 2,
  trigger: "manual",
  status: "running",
  errorCode: null,
  cancelRequestedAt: null,
  actorLogin: "octocat",
  budgetUsd: 20,
  spentUsd: 0,
  createdAt: "2026-11-05T10:00:00.000Z",
  updatedAt: "2026-11-05T10:00:00.000Z",
  finishedAt: null,
};
const VIEW: RunView = {
  ...SUMMARY,
  repositoryId: "repo-1",
  baseBranch: "main",
  input: { repo: "acme/widgets" },
  steps: [],
};

function setup(overrides: Partial<WorkflowRunService> = {}) {
  const calls: string[] = [];
  const service: WorkflowRunService = {
    start: async (user, workflowId, body) => (
      calls.push(
        `start ${user.id} ${user.githubLogin} ${workflowId} ${JSON.stringify(body)}`,
      ),
      { run: VIEW, created: true }
    ),
    get: async (workflowId, runId) => (
      calls.push(`get ${workflowId} ${runId}`),
      VIEW
    ),
    list: async (workflowId) => (
      calls.push(`list ${workflowId}`),
      { runs: [SUMMARY] }
    ),
    cancel: async (workflowId, runId) => (
      calls.push(`cancel ${workflowId} ${runId}`),
      { run: VIEW, outcome: "requested" }
    ),
    ...overrides,
  };
  const requireUser = vi.fn(async () => USER);
  const handlers = createWorkflowRunRouteHandlers({ requireUser, service });
  const url = "https://app.test/api/w/default/workflows/wf-1/runs";
  const json = (body: unknown, headers: Record<string, string> = {}): Request =>
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { handlers, calls, requireUser, json, url };
}

describe("the workflow run handlers", () => {
  // #844-T170
  it("asks for the user first, on every call", async () => {
    const { handlers, requireUser, json, url } = setup();
    requireUser.mockRejectedValue(new Error("signed out"));

    for (const call of [
      () => handlers.start(json({}), "wf-1"),
      () => handlers.list(new Request(url), "wf-1"),
      () => handlers.get(new Request(url), "wf-1", "run-1"),
      () =>
        handlers.cancel(new Request(url, { method: "POST" }), "wf-1", "run-1"),
    ])
      await expect(call()).rejects.toThrow("signed out");
  });

  // #844-T171
  it("starts a run with the login of the user and answers 201 with the run, 200 for one that was made before", async () => {
    const { handlers, calls, json } = setup();

    const created = await handlers.start(
      json({ input: { repo: "acme/widgets" }, clientRequestId: "r1" }),
      "wf-1",
    );

    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    expect(await created.json()).toMatchObject({ run: { id: "run-1" } });
    expect(calls).toEqual([
      'start user-1 octocat wf-1 {"input":{"repo":"acme/widgets"},"clientRequestId":"r1"}',
    ]);

    const again = setup({
      start: async () => ({ run: VIEW, created: false }),
    });
    expect((await again.handlers.start(again.json({}), "wf-1")).status).toBe(
      200,
    );
  });

  // #844-T172
  it("records the email as the actor for an account without GitHub", async () => {
    const { handlers, calls, json, requireUser } = setup();
    requireUser.mockResolvedValue({
      ...USER,
      githubLogin: null,
    } as unknown as SessionUser);

    await handlers.start(json({}), "wf-1");

    expect(calls[0]).toContain("user-1 octocat@example.test wf-1");
  });

  // #844-T173
  it("reads a run and the runs of a workflow", async () => {
    const { handlers, calls, url } = setup();

    const run = await handlers.get(new Request(url), "wf-1", "run-1");
    const list = await handlers.list(new Request(url), "wf-1");

    expect(await run.json()).toMatchObject({ run: { id: "run-1" } });
    expect(await list.json()).toEqual({ runs: [SUMMARY] });
    expect(run.headers.get("cache-control")).toBe("no-store");
    expect(list.headers.get("cache-control")).toBe("no-store");
    expect(calls).toEqual(["get wf-1 run-1", "list wf-1"]);
  });

  // #844-T174
  it("refuses a request from another site before it looks at the body or calls the service", async () => {
    const { handlers, calls, json, url } = setup();

    const responses = [
      await handlers.start(
        json({}, { "sec-fetch-site": "cross-site" }),
        "wf-1",
      ),
      await handlers.list(
        new Request(url, { headers: { "sec-fetch-site": "cross-site" } }),
        "wf-1",
      ),
      await handlers.get(
        new Request(url, { headers: { "sec-fetch-site": "cross-site" } }),
        "wf-1",
        "run-1",
      ),
      await handlers.cancel(
        new Request(url, {
          method: "POST",
          headers: { "sec-fetch-site": "cross-site" },
        }),
        "wf-1",
        "run-1",
      ),
    ];

    for (const response of responses) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: "WORKFLOW_RUN_CROSS_SITE_REQUEST",
      });
    }
    expect(calls).toEqual([]);
  });

  // #844-T175
  it("refuses a body that is not JSON, one of another type and one that is too large", async () => {
    const { handlers, calls, url } = setup();
    const post = (init: RequestInit) =>
      handlers.start(new Request(url, { method: "POST", ...init }), "wf-1");

    const text = await post({
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    const broken = await post({
      headers: { "content-type": "application/json" },
      body: "{",
    });
    const large = await post({
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pad: "x".repeat(START_BODY_MAX_BYTES) }),
    });

    expect(text.status).toBe(415);
    expect(await text.json()).toMatchObject({
      error: "WORKFLOW_RUN_CONTENT_TYPE_UNSUPPORTED",
    });
    expect(broken.status).toBe(400);
    expect(await broken.json()).toMatchObject({
      error: "WORKFLOW_RUN_REQUEST_INVALID",
    });
    expect(large.status).toBe(413);
    expect(await large.json()).toMatchObject({
      error: "WORKFLOW_RUN_BODY_TOO_LARGE",
    });
    expect(calls).toEqual([]);
  });

  // #844-T176
  it("answers a refusal of the service with its code and status, and what the code carries", async () => {
    const cases: Array<[WorkflowRunError, Record<string, unknown>]> = [
      [
        new WorkflowRunError("WORKFLOW_RUN_REQUEST_REUSED", "reused", {
          runId: "run-0",
        }),
        { runId: "run-0" },
      ],
      [
        new WorkflowRunError("WORKFLOW_RUN_STEP_KIND_NOT_SUPPORTED", "kind", {
          step: { id: "again", kind: "loop" },
        }),
        { step: { id: "again", kind: "loop" } },
      ],
      [
        new WorkflowRunError("WORKFLOW_RUN_INPUT_INVALID", "input", {
          errors: [
            {
              path: "/repo",
              code: "wrong_type",
              message: "Expected a string.",
            },
          ],
        }),
        { errors: [{ path: "/repo", code: "wrong_type" }] },
      ],
      [new WorkflowRunError("WORKFLOW_RUN_WORKFLOW_NOT_FOUND", "none"), {}],
    ];
    for (const [error, extra] of cases) {
      const { handlers, json } = setup({
        start: async () => {
          throw error;
        },
      });

      const response = await handlers.start(json({}), "wf-1");

      expect(response.status).toBe(WORKFLOW_RUN_ERROR_STATUS[error.code]);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({
        error: error.code,
        message: error.message,
        ...extra,
      });
    }
  });

  // #844-T177
  it("does not catch a failure that is not a refusal", async () => {
    const { handlers, json } = setup({
      start: async () => {
        throw new Error("database is down");
      },
    });

    await expect(handlers.start(json({}), "wf-1")).rejects.toThrow(
      "database is down",
    );
  });
});

describe("cancelling a run", () => {
  const post = (url: string) => new Request(url, { method: "POST" });

  // #891-T50
  it("asks the service and answers 202 for a run that is told to stop, 200 for a repeat and for a run that is over, with the run", async () => {
    for (const [outcome, status] of [
      ["requested", 202],
      ["already_requested", 200],
      ["already_ended", 200],
    ] as const) {
      const { handlers, calls, url } = setup({
        cancel: async () => ({ run: VIEW, outcome }),
      });

      const response = await handlers.cancel(post(url), "wf-1", "run-1");

      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ run: VIEW, outcome });
      expect(calls).toEqual([]);
    }
    const { handlers, calls, url } = setup();
    await handlers.cancel(post(url), "wf-1", "run-1");
    expect(calls).toEqual(["cancel wf-1 run-1"]);
  });

  // #891-T51
  it("answers the stable code for a run that is not there", async () => {
    const { handlers, url } = setup({
      cancel: async () => {
        throw new WorkflowRunError(
          "WORKFLOW_RUN_NOT_FOUND",
          "There is no such run of this workflow.",
        );
      },
    });

    const response = await handlers.cancel(post(url), "wf-1", "run-9");

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: "WORKFLOW_RUN_NOT_FOUND",
    });
  });
});
