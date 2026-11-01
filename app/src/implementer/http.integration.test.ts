// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the handlers behind the four routes of the Implementer form (#755): they ask for the user first, check where the
// request comes from and what it carries, call the real service (real GitHub App provider against the fake GitHub, real queue,
// real Postgres database) and answer with a stable code and `Cache-Control: no-store`. The proxy in front and the workspace
// check are tested with the real route files in integration-tests/http/implementer-route-files.integration.test.ts.
import { describe, expect, it } from "vitest";
import type { SessionUser } from "../auth/access-policy.ts";
import {
  READ_ONLY,
  startImplementerHarness,
} from "../test-support/implementer-harness.ts";
import type { ImplementerModels } from "./models.ts";
import { createImplementerRouteHandlers } from "./http.ts";

const USER = {
  id: "user-1",
  githubLogin: "octocat",
  email: "octocat@example.test",
} as unknown as SessionUser;

async function setup(
  options: Parameters<typeof startImplementerHarness>[0] = {},
  requireUser: () => Promise<SessionUser> = async () => USER,
) {
  const app = await startImplementerHarness(options);
  const handlers = createImplementerRouteHandlers({
    requireUser,
    service: app.service,
  });
  const url = (path: string) =>
    `https://app.test/api/w/default/implementer/${path}`;
  const get = (path: string, headers: Record<string, string> = {}) =>
    path === "repositories"
      ? handlers.repositories(new Request(url(path), { headers }))
      : path === "models"
        ? handlers.models(new Request(url(path), { headers }))
        : handlers.branches(
            new Request(url(path), { headers }),
            path.split("/")[1] ?? "",
          );
  const post = (
    body: unknown,
    options: { headers?: Record<string, string> } = {},
  ) =>
    handlers.start(
      new Request(url("tasks"), {
        method: "POST",
        headers: options.headers ?? { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
  return { ...app, handlers, get, post };
}

describe("the lists of the form over HTTP", () => {
  // #755-T01
  it("answers the repositories with the write permission, uncached", async () => {
    const { get, repository } = await setup();

    const response = await get("repositories");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      repositories: [
        {
          id: repository.id,
          fullName: "acme/widgets",
          writeGranted: true,
          unwritable: null,
        },
      ],
    });
  });

  // #755-T01
  it("says a repository whose installation holds contents read only is not writable", async () => {
    const { get } = await setup({ accepted: READ_ONLY });

    const response = await get("repositories");

    expect(await response.json()).toMatchObject({
      repositories: [{ writeGranted: false, unwritable: "write_not_granted" }],
    });
  });

  // #755-T02
  it("answers the branches with the default first and named", async () => {
    const { get, repository } = await setup();

    const response = await get(`repositories/${repository.id}/branches`);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      defaultBranch: "main",
      branches: ["main"],
      truncated: false,
    });
  });

  // #755-T02
  it.each([
    [500, 503, "IMPLEMENTER_GITHUB_UNAVAILABLE"],
    [404, 409, "IMPLEMENTER_APP_NOT_INSTALLED"],
  ])(
    "answers GitHub failing with %i as %i %s, without a token or a raw answer",
    async (githubStatus, status, code) => {
      const { h, get, repository } = await setup();
      h.fake.fail({ pathIncludes: "/branches", status: githubStatus });

      const response = await get(`repositories/${repository.id}/branches`);
      const text = await response.text();

      expect(response.status).toBe(status);
      expect(JSON.parse(text)).toEqual({ error: code });
      for (const credential of h.fake.seenCredentials())
        expect(text).not.toContain(credential);
    },
  );

  // #755-T01
  it("answers 404 for a repository that is not the workspace's", async () => {
    const { get } = await setup();

    const response = await get("repositories/no-such-repository/branches");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "IMPLEMENTER_REPOSITORY_NOT_FOUND",
    });
  });

  // #791
  it("answers an id with a NUL byte (%00 in the address) as an unknown repository, not with a 500", async () => {
    const { get } = await setup();

    const response = await get(
      "repositories/a%00b/branches".replace("%00", "\u0000"),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "IMPLEMENTER_REPOSITORY_NOT_FOUND",
    });
  });

  // #755-T07
  it("answers the model options the service gives, uncached", async () => {
    const models: ImplementerModels = {
      options: async () => ({
        keyMode: "managed",
        entries: [
          {
            id: "entry-1",
            name: "Fast",
            description: null,
            providerLabel: "Acme AI",
          },
        ],
      }),
      check: async () => null,
    };
    const { get } = await setup({ models });

    const response = await get("models");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      keyMode: "managed",
      entries: [
        {
          id: "entry-1",
          name: "Fast",
          description: null,
          providerLabel: "Acme AI",
        },
      ],
    });
  });
});

describe("starting a task over HTTP", () => {
  // #755-T03
  it("answers 201 with the run and the session, and writes the three rows for the signed in person", async () => {
    const { h, post, body, counts } = await setup();

    const response = await post(body());

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const answer = (await response.json()) as { runId: string };
    expect(answer).toEqual({
      runId: expect.any(String),
      sessionId: expect.any(String),
    });
    expect(await counts()).toEqual({ jobs: 1, sessions: 1, turns: 1 });
    const job = await h.db
      .selectFrom("jobs")
      .select(["id", "actor_login"])
      .executeTakeFirstOrThrow();
    expect(job).toEqual({ id: answer.runId, actor_login: "octocat" });
  });

  // #755-T03
  it("answers 200 with the same ids for a repeated client request id", async () => {
    const { post, body, counts } = await setup();
    const first = await (await post(body())).json();

    const response = await post(body());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(first);
    expect(await counts()).toEqual({ jobs: 1, sessions: 1, turns: 1 });
  });

  it("takes the person from the session and ignores one named in the body", async () => {
    const { h, post, body } = await setup();

    await post(body({ actorLogin: "mallory", createdBy: "mallory" }));

    expect(
      await h.db.selectFrom("jobs").select("actor_login").executeTakeFirst(),
    ).toEqual({ actor_login: "octocat" });
    expect(
      await h.db
        .selectFrom("implementer_sessions")
        .select("created_by")
        .executeTakeFirst(),
    ).toEqual({ created_by: "user-1" });
  });

  // #791
  it("answers an id with a NUL byte in the body as an unknown repository", async () => {
    const { post, body, counts } = await setup();

    const response = await post(body({ repositoryId: "a\u0000b" }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "IMPLEMENTER_REPOSITORY_NOT_FOUND",
    });
    expect(await counts()).toEqual({ jobs: 0, sessions: 0, turns: 0 });
  });

  // #791
  it("answers 409 IMPLEMENTER_BRANCH_CONFLICT for a folder of an existing branch", async () => {
    const { h, post, body } = await setup();
    h.fake.addPullRequest("acme/widgets", {
      number: 1,
      title: "x",
      state: "open",
      headSha: "1".repeat(40),
      headRef: "feature",
      baseRef: "main",
      author: { login: "alice", id: 1 },
    });

    const response = await post(body({ branch: "feature/new" }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "IMPLEMENTER_BRANCH_CONFLICT",
    });
  });

  // #755-T04
  it("answers 409 IMPLEMENTER_BRANCH_EXISTS with a message that asks for a new branch name, and writes nothing", async () => {
    const { post, body, counts } = await setup();
    await post(body());

    const response = await post(body({ clientRequestId: "request-2" }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "IMPLEMENTER_BRANCH_EXISTS",
    });
    expect(await counts()).toEqual({ jobs: 1, sessions: 1, turns: 1 });
  });

  // #756 (review of #793)
  it("answers 409 IMPLEMENTER_REQUEST_REUSED with the run of the first task for an id that made another task", async () => {
    const { post, body } = await setup();
    const first = (await (await post(body())).json()) as { runId: string };

    const response = await post(body({ instruction: "Another task." }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "IMPLEMENTER_REQUEST_REUSED",
      runId: first.runId,
    });
  });

  // #755-T04
  it("answers 404 IMPLEMENTER_BASE_BRANCH_NOT_FOUND for an unknown base branch", async () => {
    const { post, body } = await setup();

    const response = await post(body({ baseBranch: "nope" }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "IMPLEMENTER_BASE_BRANCH_NOT_FOUND",
    });
  });

  // #755-T08
  it("answers 409 IMPLEMENTER_WRITE_NOT_GRANTED without the write permission", async () => {
    const { post, body, counts } = await setup({ accepted: READ_ONLY });

    const response = await post(body());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "IMPLEMENTER_WRITE_NOT_GRANTED",
    });
    expect(await counts()).toEqual({ jobs: 0, sessions: 0, turns: 0 });
  });

  // #755-T07
  it("answers 422 IMPLEMENTER_MODEL_NOT_ALLOWED with the reason", async () => {
    const { post, body } = await setup({
      models: {
        options: async () => ({ keyMode: "unreadable" }),
        check: async () => "no_key",
      },
    });

    const response = await post(body());

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "IMPLEMENTER_MODEL_NOT_ALLOWED",
      reason: "no_key",
    });
  });

  // #755-T12
  it("answers 422 EXCEEDS_OPERATOR_MAXIMUM with the maximum", async () => {
    const { post, body, counts } = await setup({ operatorCostLimitCents: 300 });

    const response = await post(body({ costLimitCents: 301 }));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "EXCEEDS_OPERATOR_MAXIMUM",
      maximumCents: 300,
    });
    expect(await counts()).toEqual({ jobs: 0, sessions: 0, turns: 0 });
  });

  // #755-T06
  it("answers 400 with the field errors, and writes nothing", async () => {
    const { post, body, counts } = await setup();

    const response = await post(body({ instruction: "", branch: "-x" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "IMPLEMENTER_REQUEST_INVALID",
      issues: [
        { field: "branch", code: "leading_dash" },
        { field: "instruction", code: "required" },
      ],
    });
    expect(await counts()).toEqual({ jobs: 0, sessions: 0, turns: 0 });
  });

  // #755-T09
  it("answers 400 for a body that is not JSON, and for JSON that is not an object", async () => {
    const { post } = await setup();

    for (const text of ["{not json", "[1,2]", "null", '"text"']) {
      const response = await post(text);
      expect(response.status, text).toBe(400);
      expect((await response.json()).error, text).toBe(
        "IMPLEMENTER_REQUEST_INVALID",
      );
    }
  });

  // #755-T09
  it("answers 415 when the body is not declared as JSON", async () => {
    const { post, body, counts } = await setup();

    const response = await post(JSON.stringify(body()), {
      headers: { "content-type": "text/plain" },
    });

    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({
      error: "IMPLEMENTER_CONTENT_TYPE_UNSUPPORTED",
    });
    expect(await counts()).toEqual({ jobs: 0, sessions: 0, turns: 0 });
  });

  // #755-T09
  it("answers 413 for a body over 64 KB", async () => {
    const { post, body, counts } = await setup();

    const response = await post(body({ instruction: "x".repeat(70_000) }));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "IMPLEMENTER_BODY_TOO_LARGE",
    });
    expect(await counts()).toEqual({ jobs: 0, sessions: 0, turns: 0 });
  });

  // #755-T09
  it("takes an instruction of 20,000 characters, which is inside the limit", async () => {
    const { post, body } = await setup();

    const response = await post(body({ instruction: "x".repeat(20_000) }));

    expect(response.status).toBe(201);
  });

  // #755-T09
  it.each<Record<string, string>>([
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
    { origin: "https://evil.test" },
  ])(
    "answers 403 for a request from another site (%j), and writes nothing",
    async (site) => {
      const { h, get, post, body, counts } = await setup();
      const before = h.fake.requests().length;

      const response = await post(body(), {
        headers: { "content-type": "application/json", ...site },
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: "IMPLEMENTER_CROSS_SITE_REQUEST",
      });
      expect((await get("repositories", site)).status).toBe(403);
      expect((await get("models", site)).status).toBe(403);
      expect(h.fake.requests()).toHaveLength(before);
      expect(await counts()).toEqual({ jobs: 0, sessions: 0, turns: 0 });
    },
  );

  // #755-T09
  it("asks for the user before it reads anything, and a refusal reaches the caller", async () => {
    const refusal = new Error("NEXT_REDIRECT");
    const { h, post, body, get, counts } = await setup({}, async () => {
      throw refusal;
    });
    const before = h.fake.requests().length;

    await expect(post(body())).rejects.toBe(refusal);
    await expect(get("repositories")).rejects.toBe(refusal);
    await expect(get("models")).rejects.toBe(refusal);
    await expect(get("repositories/x/branches")).rejects.toBe(refusal);

    expect(h.fake.requests()).toHaveLength(before);
    expect(await counts()).toEqual({ jobs: 0, sessions: 0, turns: 0 });
  });
});
