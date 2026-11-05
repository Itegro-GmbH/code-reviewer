// SPDX-License-Identifier: LicenseRef-Proprietary

// The handlers behind `POST .../implementer/sessions/:sessionId/turns` and `GET .../runs/:id/continuation` (#841): the user first, where
// the request comes from and what it carries, then the real service on a real database, and a stable code with `Cache-Control: no-store`.
import { describe, expect, it } from "vitest";
import type { SessionUser } from "../auth/access-policy.ts";
import { createImplementerRepository } from "../db/repositories/implementer-repository.ts";
import {
  startImplementerHarness,
  type ImplementerHarness,
} from "../test-support/implementer-harness.ts";
import { createImplementerRouteHandlers } from "./http.ts";

const USER = {
  id: "user-1",
  githubLogin: "octocat",
  email: "octocat@example.test",
} as unknown as SessionUser;

async function setup() {
  const app = await startImplementerHarness();
  const handlers = createImplementerRouteHandlers({
    requireUser: async () => USER,
    service: app.service,
  });
  const post = (
    sessionId: string,
    body: unknown,
    headers: Record<string, string> = { "content-type": "application/json" },
  ) =>
    handlers.continueSession(
      new Request(
        `https://app.test/api/w/default/implementer/sessions/${sessionId}/turns`,
        {
          method: "POST",
          headers,
          body: typeof body === "string" ? body : JSON.stringify(body),
        },
      ),
      sessionId,
    );
  const continuation = (runId: string) =>
    handlers.continuation(
      new Request(`https://app.test/api/w/default/runs/${runId}/continuation`),
      runId,
    );
  return { ...app, handlers, post, continuation };
}

/** A first turn that ended with a pushed head, its branch on the fake GitHub. */
async function idle(f: ImplementerHarness) {
  const started = await f.service.startTask(USERLIKE, f.body());
  await f.h.db
    .updateTable("jobs")
    .set({ status: "succeeded", finished_at: "2026-11-05T10:00:00.000Z" })
    .where("id", "=", started.runId)
    .execute();
  await createImplementerRepository(f.h.db, f.h.workspaceId).recordTurnResult(
    started.sessionId,
    { headCommit: "c".repeat(40), opencode: null, summary: null },
  );
  f.h.fake.addPullRequest("acme/widgets", {
    number: 1,
    title: "x",
    state: "open",
    headSha: "c".repeat(40),
    headRef: "implementer/abc123",
    baseRef: "main",
    author: { login: "alice", id: 1 },
  });
  return started;
}
const USERLIKE = { id: "user-1", githubLogin: "octocat" };

const ask = (overrides: Record<string, unknown> = {}) => ({
  instruction: "Now add a test.",
  clientRequestId: "follow-1",
  ...overrides,
});

describe("continuing a session over HTTP", () => {
  // #841-H01
  it("answers 201 with the new run for an idle session, then 200 with the same run for the same request", async () => {
    const f = await setup();
    const first = await idle(f);

    const created = await f.post(first.sessionId, ask());
    const body = (await created.json()) as Record<string, unknown>;
    const again = await f.post(first.sessionId, ask());

    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({
      status: "started",
      sessionId: first.sessionId,
      turnNumber: 2,
    });
    expect(typeof body.runId).toBe("string");
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ runId: body.runId });
  });

  // #841-H02 (owner decision 5)
  it("answers 202 for an instruction queued behind a running turn and 409 IMPLEMENTER_SESSION_BUSY for a second one", async () => {
    const f = await setup();
    const first = await f.service.startTask(USERLIKE, f.body());

    const queued = await f.post(first.sessionId, ask());
    const busy = await f.post(
      first.sessionId,
      ask({ clientRequestId: "follow-2", instruction: "Another." }),
    );

    expect(queued.status).toBe(202);
    expect(await queued.json()).toMatchObject({
      status: "queued",
      runId: null,
      turnNumber: null,
    });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: "IMPLEMENTER_SESSION_BUSY" });
  });

  // #841-H03
  it("answers 409 IMPLEMENTER_BRANCH_GONE when the branch was deleted on GitHub", async () => {
    const f = await setup();
    const first = await f.service.startTask(USERLIKE, f.body());
    await f.h.db
      .updateTable("jobs")
      .set({ status: "succeeded", finished_at: "2026-11-05T10:00:00.000Z" })
      .where("id", "=", first.runId)
      .execute();
    await createImplementerRepository(f.h.db, f.h.workspaceId).recordTurnResult(
      first.sessionId,
      { headCommit: "c".repeat(40), opencode: null, summary: null },
    );

    const response = await f.post(first.sessionId, ask());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "IMPLEMENTER_BRANCH_GONE" });
  });

  // #841-H04
  it("answers 404 IMPLEMENTER_SESSION_NOT_FOUND for a session nobody has", async () => {
    const f = await setup();

    const response = await f.post("no-such-session", ask());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "IMPLEMENTER_SESSION_NOT_FOUND",
    });
  });

  // #841-H05
  it("answers 400 with the field errors, 415 for a body that is not JSON and 403 for a cross-site request, writing nothing", async () => {
    const f = await setup();
    const first = await idle(f);
    const before = await f.counts();

    const invalid = await f.post(first.sessionId, { clientRequestId: "r" });
    const notJson = await f.post(first.sessionId, "x", {
      "content-type": "text/plain",
    });
    const crossSite = await f.post(first.sessionId, ask(), {
      "content-type": "application/json",
      "sec-fetch-site": "cross-site",
    });

    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: "IMPLEMENTER_REQUEST_INVALID",
      issues: [{ field: "instruction", code: "required" }],
    });
    expect(notJson.status).toBe(415);
    expect(crossSite.status).toBe(403);
    expect(await f.counts()).toEqual(before);
  });

  // #841-H06
  it("answers 422 EXCEEDS_OPERATOR_MAXIMUM with the maximum", async () => {
    const f = await setup();
    const first = await idle(f);

    const response = await f.post(
      first.sessionId,
      ask({ costLimitCents: 501 }),
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: "EXCEEDS_OPERATOR_MAXIMUM",
      maximumCents: 500,
    });
  });
});

describe("the facts of the Continue form over HTTP", () => {
  // #841-H07
  it("answers the defaults of the newest turn, uncached, and 404 for a run that is not the newest turn", async () => {
    const f = await setup();
    const first = await f.service.startTask(USERLIKE, f.body());

    const response = await f.continuation(first.runId);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      sessionId: first.sessionId,
      turnNumber: 1,
      sessionStatus: "running",
      queued: null,
    });
    expect((await f.continuation("no-such-run")).status).toBe(404);
  });
});
