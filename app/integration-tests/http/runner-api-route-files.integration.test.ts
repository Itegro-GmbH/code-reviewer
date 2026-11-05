// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the real route files of the runner API with the wiring the running server uses: the
// database opened at start, the registry configured from the environment, the settings read from
// RUNNER_TOKEN and LLM_*. A pull request delivery goes in through the webhook route and comes out
// through claim, heartbeat and complete, so the pieces are proven to be connected. The details of each
// behavior are in runner-api-claim, -report and -security.integration.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startGithubFake,
  type FakeGithub,
} from "../../../fakes/github/server.ts";
import {
  webhookDelivery,
  webhookFixture,
} from "../../../fakes/github/webhooks.ts";
import { createRepositoriesRepository } from "../../src/db/repositories/repositories-repository.ts";
import { closeDatabase, getDatabase } from "../../src/db/startup.ts";
import {
  TEST_APP_ID,
  TEST_WEBHOOK_SECRET,
  testAppKeys,
  testGithubAppEnv,
} from "../../src/test-support/github-app.ts";
import { projectServiceFor } from "../../src/projects/shared.ts";
import {
  saveDefaultWorkspaceLlmKey,
  saveGithubAppFromEnv,
} from "../../src/test-support/server-credentials.ts";
import { openRouteTestDatabase } from "../../src/test-support/test-database.ts";
import {
  defaultWorkspaceId,
  linkTestInstallation,
  markInstanceSetUp,
} from "../../src/test-support/workspaces.ts";

// #395: what the routes start between two sweeps; here the two entry points are spies.
const maintenance = vi.hoisted(() => ({
  touched: vi.fn(),
  jobEnded: vi.fn(),
}));
vi.mock("../../src/dispatch/maintenance-shared.ts", () => maintenance);

const RUNNER_TOKEN = "route-file-runner-token-91ac-5d2e8b7f0c14";
const LLM_KEY = "route-file-llm-key-77de";
const HEAD = "1f3a5c7e9b2d4f60a8c1e3b5d7f90a2c4e6b8d01";

type Webhook = typeof import("../../src/app/api/webhooks/github-app/route.ts");
type Claim = typeof import("../../src/app/api/runners/v1/claim/route.ts");
type Heartbeat =
  typeof import("../../src/app/api/runners/v1/jobs/[id]/heartbeat/route.ts");
type Complete =
  typeof import("../../src/app/api/runners/v1/jobs/[id]/complete/route.ts");
type Release =
  typeof import("../../src/app/api/runners/v1/jobs/[id]/release/route.ts");
type Version = typeof import("../../src/app/api/runners/v1/version/route.ts");
type JobState =
  typeof import("../../src/app/api/runners/v1/jobs/[id]/route.ts");
type WorkerDetails =
  typeof import("../../src/app/api/workers/v1/jobs/[id]/route.ts");
type WorkerHeartbeat =
  typeof import("../../src/app/api/workers/v1/jobs/[id]/heartbeat/route.ts");
type WorkerResult =
  typeof import("../../src/app/api/workers/v1/jobs/[id]/result/route.ts");
type Steps =
  typeof import("../../src/app/api/runners/v1/jobs/[id]/steps/route.ts");
type WorkerSteps =
  typeof import("../../src/app/api/workers/v1/jobs/[id]/steps/route.ts");
type WorkerSession =
  typeof import("../../src/app/api/workers/v1/jobs/[id]/session/route.ts");
type WorkerResumeSession =
  typeof import("../../src/app/api/workers/v1/jobs/[id]/resume-session/route.ts");

const fakes: FakeGithub[] = [];

async function startRoutes() {
  // The production code reads the real clock, so the fake does too.
  const fake = await startGithubFake({
    appId: TEST_APP_ID,
    publicKeyPem: testAppKeys().publicKey,
  });
  fakes.push(fake);
  const env: Record<string, string | undefined> = {
    ...testGithubAppEnv({
      GITHUB_API_BASE_URL: fake.baseUrl,
      ALLOW_TEST_GITHUB_ENDPOINTS: "true",
    }),
    RUNNER_TOKEN,
    // The master key: the key of a claim is remembered encrypted in the database.
    APP_SECRET: "route-file-app-secret-0123456789-0123456789",
    LLM_MODEL: "vendor/test-model",
  };
  for (const [name, value] of Object.entries(env))
    if (value !== undefined) vi.stubEnv(name, value);
  await openRouteTestDatabase();
  // A deployment that is in use has been set up (the first-run setup decides about workspaces).
  await markInstanceSetUp(getDatabase());
  await saveGithubAppFromEnv(getDatabase(), env);
  await saveDefaultWorkspaceLlmKey(
    getDatabase(),
    env.APP_SECRET ?? "",
    LLM_KEY,
  );
  // The registry reads the credentials on first use, so every test loads the routes anew.
  vi.resetModules();
  return {
    fake,
    webhook:
      (await import("../../src/app/api/webhooks/github-app/route.ts")) as Webhook,
    claim:
      (await import("../../src/app/api/runners/v1/claim/route.ts")) as Claim,
    heartbeat:
      (await import("../../src/app/api/runners/v1/jobs/[id]/heartbeat/route.ts")) as Heartbeat,
    complete:
      (await import("../../src/app/api/runners/v1/jobs/[id]/complete/route.ts")) as Complete,
    release:
      (await import("../../src/app/api/runners/v1/jobs/[id]/release/route.ts")) as Release,
    version:
      (await import("../../src/app/api/runners/v1/version/route.ts")) as Version,
    jobState:
      (await import("../../src/app/api/runners/v1/jobs/[id]/route.ts")) as JobState,
    workerDetails:
      (await import("../../src/app/api/workers/v1/jobs/[id]/route.ts")) as WorkerDetails,
    workerHeartbeat:
      (await import("../../src/app/api/workers/v1/jobs/[id]/heartbeat/route.ts")) as WorkerHeartbeat,
    workerResult:
      (await import("../../src/app/api/workers/v1/jobs/[id]/result/route.ts")) as WorkerResult,
    steps:
      (await import("../../src/app/api/runners/v1/jobs/[id]/steps/route.ts")) as Steps,
    workerSteps:
      (await import("../../src/app/api/workers/v1/jobs/[id]/steps/route.ts")) as WorkerSteps,
    workerSession:
      (await import("../../src/app/api/workers/v1/jobs/[id]/session/route.ts")) as WorkerSession,
    workerResumeSession:
      (await import("../../src/app/api/workers/v1/jobs/[id]/resume-session/route.ts")) as WorkerResumeSession,
  };
}

/** A pull request delivery that the webhook route turns into a waiting job. */
async function queueJobThroughWebhook(
  routes: Awaited<ReturnType<typeof startRoutes>>,
) {
  routes.fake.addInstallation({
    id: 4242,
    account: { login: "acme", id: 5001, type: "Organization" },
  });
  routes.fake.setRepositories(4242, [{ id: 7001, fullName: "acme/widgets" }]);
  // A person of the workspace linked the installation (the binding); nothing is made from a delivery alone.
  await linkTestInstallation(
    getDatabase(),
    await defaultWorkspaceId(getDatabase()),
    { id: "4242", accountLogin: "acme", accountId: 5001 },
  );
  routes.fake.addPullRequest("acme/widgets", {
    number: 7,
    title: "Add widget caching",
    state: "open",
    headSha: HEAD,
    headRef: "feature/caching",
    baseRef: "main",
    author: { login: "alice", id: 1001 },
  });
  for (const [event, fixture] of [
    ["installation", "installation.created"],
    ["pull_request", "pull_request.opened"],
  ] as const) {
    expect(
      (
        await routes.webhook.POST(
          webhookDelivery({
            event,
            payload: webhookFixture(fixture),
            secret: TEST_WEBHOOK_SECRET,
          }),
        )
      ).status,
    ).toBe(202);
    if (event === "installation") {
      // The repository must be a project before its pull requests are reviewed.
      const [repository] = await createRepositoriesRepository(
        getDatabase(),
        await defaultWorkspaceId(getDatabase()),
      ).list();
      await projectServiceFor(
        await defaultWorkspaceId(getDatabase()),
      ).activateProject(repository!.id);
    }
  }
}

function workerRequest(
  path: string,
  credential: string,
  options: { method?: string; body?: unknown } = {},
): Request {
  return new Request(`https://app.test/api/workers/v1/${path}`, {
    method: options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${credential}`,
    },
    body: options.body === undefined ? null : JSON.stringify(options.body),
  });
}

function runnerRequest(
  action: string,
  body: unknown,
  headers: Record<string, string> = {
    authorization: `Bearer ${RUNNER_TOKEN}`,
    "x-runner-id": "runner-a",
  },
): Request {
  return new Request(`https://app.test/api/runners/v1/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? null : JSON.stringify(body),
  });
}

beforeEach(() => {
  maintenance.touched.mockClear();
  maintenance.jobEnded.mockClear();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeDatabase();
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
});

describe("the runner API route files", () => {
  // #322-T01
  it("claims a job by its id, answers the version call and gives the job back through the route files", async () => {
    const routes = await startRoutes();
    await queueJobThroughWebhook(routes);
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${RUNNER_TOKEN}`,
      "x-runner-id": "dispatcher-a",
    };

    const version = await routes.version.GET(
      new Request("https://app.test/api/runners/v1/version", { headers }),
    );
    expect(version.status).toBe(200);
    expect(version.headers.get("cache-control")).toBe("no-store");
    expect(await version.json()).toMatchObject({
      version: 1,
      features: [
        "worker_api",
        "claim_by_job_id",
        "pool_cap",
        "release",
        "vm_lifecycle",
        "implementer_steps",
        "implementer_snapshot",
      ],
    });
    const anonymous = await routes.version.GET(
      new Request("https://app.test/api/runners/v1/version"),
    );
    expect(anonymous.status).toBe(401);

    const [{ id }] = (await getDatabase()
      .selectFrom("jobs")
      .select("id")
      .execute()) as [{ id: string }];
    const claim = await routes.claim.POST(
      runnerRequest(
        "claim",
        {
          engines: ["pr-agent"],
          features: ["worker_credential"],
          jobId: id,
          maxRunning: 2,
        },
        headers,
      ),
    );
    expect(claim.status).toBe(200);
    const { job } = await claim.json();
    expect(job.id).toBe(id);

    const released = await routes.release.POST(
      runnerRequest(
        `jobs/${job.id}/release`,
        { credential: job.credential, reason: "launch_failed" },
        headers,
      ),
      { params: Promise.resolve({ id: job.id }) },
    );
    expect(released.status).toBe(200);
    expect(await released.json()).toStrictEqual({
      version: 1,
      job: { id, status: "queued" },
    });
    expect(
      await getDatabase()
        .selectFrom("jobs")
        .select(["status", "attempts"])
        .execute(),
    ).toStrictEqual([{ status: "queued", attempts: 1 }]);
  });

  // #364-T25
  it("answers the state of a job to the dispatcher credential through the route file, and refuses anyone else", async () => {
    const routes = await startRoutes();
    await queueJobThroughWebhook(routes);
    const [{ id }] = (await getDatabase()
      .selectFrom("jobs")
      .select("id")
      .execute()) as [{ id: string }];
    const call = (headers: Record<string, string>) =>
      routes.jobState.GET(
        new Request(`https://app.test/api/runners/v1/jobs/${id}`, { headers }),
        { params: Promise.resolve({ id }) },
      );

    const known = await call({ authorization: `Bearer ${RUNNER_TOKEN}` });
    const anonymous = await call({});

    expect(known.status).toBe(200);
    expect(known.headers.get("cache-control")).toBe("no-store");
    expect(await known.json()).toStrictEqual({
      version: 1,
      job: { id, status: "queued" },
    });
    expect(anonymous.status).toBe(401);
  });

  it("answers 500 in the usual form, not cacheable, when the database cannot be reached", async () => {
    const routes = await startRoutes();
    await closeDatabase();
    vi.stubEnv("DATABASE_URL", "postgres://app:secret@127.0.0.1:1/app");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await routes.claim.POST(runnerRequest("claim", undefined));

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).error.code).toBe("RUNNER_INTERNAL_ERROR");
  });

  it("takes a job that came in through the webhook route from claim to complete", async () => {
    const routes = await startRoutes();
    await queueJobThroughWebhook(routes);

    const claim = await routes.claim.POST(runnerRequest("claim", undefined));

    expect(claim.status).toBe(200);
    expect(claim.headers.get("cache-control")).toBe("no-store");
    const { job } = await claim.json();
    expect(job.input).toMatchObject({
      prUrl: "https://github.test/acme/widgets/pull/7",
      command: "review",
      llm: {
        provider: "openrouter",
        model: "vendor/test-model",
        apiKey: LLM_KEY,
      },
    });
    expect(job.input.git.token).toMatch(/^ghs_fake/);

    const context = { params: Promise.resolve({ id: job.id }) };
    const beat = await routes.heartbeat.POST(
      runnerRequest(`jobs/${job.id}/heartbeat`, { leaseToken: job.leaseToken }),
      context,
    );
    const done = await routes.complete.POST(
      runnerRequest(`jobs/${job.id}/complete`, {
        leaseToken: job.leaseToken,
        result: {
          ok: true,
          durationMs: 1200,
          commentUrl: null,
          errorCode: null,
          logTail: "done",
        },
      }),
      context,
    );

    expect([beat.status, done.status]).toStrictEqual([200, 200]);
    expect(
      await getDatabase().selectFrom("jobs").select("status").execute(),
    ).toStrictEqual([{ status: "succeeded" }]);
  });

  // #745-T50
  it("answers the steps call of both doors in the usual form: a claim is needed on each, and a diff job takes no steps", async () => {
    const routes = await startRoutes();
    await queueJobThroughWebhook(routes);
    const claim = await routes.claim.POST(runnerRequest("claim", undefined));
    const { job } = await claim.json();
    const context = { params: Promise.resolve({ id: job.id }) };
    const records = [
      { kind: "text", partId: "prt_1", seq: 1, text: "Thinking" },
    ];

    const noToken = await routes.steps.POST(
      runnerRequest(
        `jobs/${job.id}/steps`,
        { leaseToken: job.leaseToken, records },
        {},
      ),
      context,
    );
    const diffJob = await routes.steps.POST(
      runnerRequest(`jobs/${job.id}/steps`, {
        leaseToken: job.leaseToken,
        records,
      }),
      context,
    );
    const workerNoCredential = await routes.workerSteps.POST(
      new Request(`https://app.test/api/workers/v1/jobs/${job.id}/steps`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ records }),
      }),
      context,
    );

    expect(noToken.status).toBe(401);
    expect(diffJob.status).toBe(400);
    expect(diffJob.headers.get("cache-control")).toBe("no-store");
    expect(workerNoCredential.status).toBe(401);
  });

  // #839-T50
  it("answers the snapshot call of the Worker API in the usual form: a credential is needed, and a diff job takes no snapshot", async () => {
    const routes = await startRoutes();
    await queueJobThroughWebhook(routes);
    const claim = await routes.claim.POST(
      new Request("https://app.test/api/runners/v1/claim", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${RUNNER_TOKEN}`,
          "x-runner-id": "dispatcher-a",
        },
        body: JSON.stringify({
          engines: ["pr-agent"],
          features: ["worker_credential"],
        }),
      }),
    );
    const { job } = await claim.json();
    const context = { params: Promise.resolve({ id: job.id }) };
    const url = `https://app.test/api/workers/v1/jobs/${job.id}/session?part=0&parts=1&bytes=3&rawBytes=9&sha256=${"a".repeat(64)}&opencodeVersion=1.19.0`;
    const put = (credential?: string) =>
      routes.workerSession.PUT(
        new Request(url, {
          method: "PUT",
          headers: {
            "content-type": "application/octet-stream",
            ...(credential === undefined
              ? {}
              : { authorization: `Bearer ${credential}` }),
          },
          body: new Uint8Array(3),
        }),
        context,
      );

    const noCredential = await put();
    const runnerToken = await put(RUNNER_TOKEN);
    const diffJob = await put(job.credential);

    expect(noCredential.status).toBe(401);
    expect(runnerToken.status).toBe(401);
    expect(diffJob.status).toBe(400);
    expect(diffJob.headers.get("cache-control")).toBe("no-store");
    expect(await diffJob.json()).toMatchObject({
      error: { fields: [{ field: "jobId", code: "invalid" }] },
    });
  });

  // #840-T50
  it("answers the resume-session call of the Worker API in the usual form: a credential is needed, and a diff job reads no snapshot", async () => {
    const routes = await startRoutes();
    await queueJobThroughWebhook(routes);
    const claim = await routes.claim.POST(
      new Request("https://app.test/api/runners/v1/claim", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${RUNNER_TOKEN}`,
          "x-runner-id": "dispatcher-a",
        },
        body: JSON.stringify({
          engines: ["pr-agent"],
          features: ["worker_credential"],
        }),
      }),
    );
    const { job } = await claim.json();
    const context = { params: Promise.resolve({ id: job.id }) };
    const url = `https://app.test/api/workers/v1/jobs/${job.id}/resume-session?part=0`;
    const get = (credential?: string) =>
      routes.workerResumeSession.GET(
        new Request(url, {
          method: "GET",
          headers:
            credential === undefined
              ? {}
              : { authorization: `Bearer ${credential}` },
        }),
        context,
      );

    const noCredential = await get();
    const runnerToken = await get(RUNNER_TOKEN);
    const diffJob = await get(job.credential);

    expect(noCredential.status).toBe(401);
    expect(runnerToken.status).toBe(401);
    expect(diffJob.status).toBe(400);
    expect(diffJob.headers.get("cache-control")).toBe("no-store");
    expect(await diffJob.json()).toMatchObject({
      error: { fields: [{ field: "jobId", code: "invalid" }] },
    });
  });

  // #320-T01
  it("takes a job from a split claim to its result through the Worker API route files, and keeps both doors apart", async () => {
    const routes = await startRoutes();
    await queueJobThroughWebhook(routes);

    const claim = await routes.claim.POST(
      new Request("https://app.test/api/runners/v1/claim", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${RUNNER_TOKEN}`,
          "x-runner-id": "dispatcher-a",
        },
        body: JSON.stringify({
          engines: ["pr-agent"],
          features: ["worker_credential"],
        }),
      }),
    );

    expect(claim.status).toBe(200);
    const { job } = await claim.json();
    expect(job).not.toHaveProperty("input");
    expect(job.credential).toMatch(/^crj_[A-Za-z0-9_-]{43}$/);
    const context = { params: Promise.resolve({ id: job.id }) };

    // The dispatcher credential does not open the Worker API.
    const refused = await routes.workerDetails.GET(
      workerRequest(`jobs/${job.id}`, RUNNER_TOKEN),
      context,
    );
    expect(refused.status).toBe(401);
    expect((await refused.json()).error.code).toBe("WORKER_CREDENTIAL_INVALID");

    const details = await routes.workerDetails.GET(
      workerRequest(
        `jobs/${job.id}?features=dynamic_capabilities`,
        job.credential,
      ),
      context,
    );
    expect(details.status).toBe(200);
    expect(details.headers.get("cache-control")).toBe("no-store");
    const body = await details.json();
    expect(body.job.input).toMatchObject({
      command: "review",
      llm: { apiKey: LLM_KEY },
    });
    expect(body.job.input.git.token).toMatch(/^ghs_fake/);

    const beat = await routes.workerHeartbeat.POST(
      workerRequest(`jobs/${job.id}/heartbeat`, job.credential, {
        method: "POST",
        body: {},
      }),
      context,
    );
    const done = await routes.workerResult.POST(
      workerRequest(`jobs/${job.id}/result`, job.credential, {
        method: "POST",
        body: {
          result: {
            ok: true,
            durationMs: 1200,
            commentUrl: null,
            errorCode: null,
            logTail: "done",
          },
        },
      }),
      context,
    );

    expect([beat.status, done.status]).toStrictEqual([200, 200]);
    expect(
      await getDatabase().selectFrom("jobs").select("status").execute(),
    ).toStrictEqual([{ status: "succeeded" }]);
  });

  it("refuses every route without the runner token and says 204 when nothing is waiting", async () => {
    const routes = await startRoutes();
    const noToken = { "x-runner-id": "runner-a" };
    const id = "11111111-2222-4333-8444-555555555555";
    const context = { params: Promise.resolve({ id }) };

    const answers = [
      await routes.claim.POST(runnerRequest("claim", undefined, noToken)),
      await routes.heartbeat.POST(
        runnerRequest(`jobs/${id}/heartbeat`, {}, noToken),
        context,
      ),
      await routes.complete.POST(
        runnerRequest(`jobs/${id}/complete`, {}, noToken),
        context,
      ),
    ];
    const none = await routes.claim.POST(runnerRequest("claim", undefined));

    expect(answers.map((answer) => answer.status)).toStrictEqual([
      401, 401, 401,
    ]);
    expect(none.status).toBe(204);
  });
});

describe("what the route files start between two sweeps (#395)", () => {
  // #395-T09
  it("reports a job a Dispatcher gave back, and a job a runner completed, and starts the repair work on a heartbeat", async () => {
    const routes = await startRoutes();
    await queueJobThroughWebhook(routes);
    // The deliveries that queued the job started the repair work themselves (webhook route tests).
    maintenance.touched.mockClear();
    const [{ id }] = (await getDatabase()
      .selectFrom("jobs")
      .select("id")
      .execute()) as [{ id: string }];
    const dispatcher = {
      "content-type": "application/json",
      authorization: `Bearer ${RUNNER_TOKEN}`,
      "x-runner-id": "dispatcher-a",
    };
    const split = await routes.claim.POST(
      runnerRequest(
        "claim",
        { engines: ["pr-agent"], features: ["worker_credential"], jobId: id },
        dispatcher,
      ),
    );
    const { job } = await split.json();

    // The Dispatcher gives the job back after a launch that failed.
    await routes.release.POST(
      runnerRequest(
        `jobs/${job.id}/release`,
        { credential: job.credential, reason: "launch_failed" },
        dispatcher,
      ),
      { params: Promise.resolve({ id: job.id }) },
    );
    expect(maintenance.jobEnded).toHaveBeenCalledWith({
      jobId: id,
      repositoryId: expect.any(String),
      prNumber: 7,
      requeued: true,
    });
    expect(maintenance.touched).not.toHaveBeenCalled();

    // A runner takes it, beats and completes it.
    const claim = await routes.claim.POST(runnerRequest("claim", undefined));
    const claimed = (await claim.json()).job;
    await routes.heartbeat.POST(
      runnerRequest(`jobs/${id}/heartbeat`, { leaseToken: claimed.leaseToken }),
      { params: Promise.resolve({ id }) },
    );
    expect(maintenance.touched).toHaveBeenCalledTimes(1);
    maintenance.jobEnded.mockClear();
    const done = await routes.complete.POST(
      runnerRequest(`jobs/${id}/complete`, {
        leaseToken: claimed.leaseToken,
        result: {
          ok: true,
          durationMs: 5,
          commentUrl: null,
          errorCode: null,
          errorMessage: null,
          logTail: "",
          logTruncated: false,
          usage: null,
        },
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(done.status).toBe(200);
    expect(maintenance.jobEnded).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: id, requeued: false }),
    );
  });
});
