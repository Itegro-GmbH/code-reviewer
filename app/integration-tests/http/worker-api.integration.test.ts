// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the Worker API (#320) through the real handlers and a real Postgres database: the split claim
// (a Dispatcher gets a per-job credential and no job input), the three Worker calls under
// `/api/workers/v1/jobs/:id` (details, heartbeat, result) and every rule around the credential: it is
// 256 bits, stored only as a hash, valid for its own job and its own claim only, never logged, and
// useless on the runner API. The legacy claim, which an old runner still uses, is pinned to be
// unchanged. The shape of the answers against the contract file is in
// compatibility/hosted-contracts.integration.test.ts.
import { sql } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import { T0 } from "../../src/test-support/jobs.ts";
import {
  startRunnerApiHarness,
  TEST_LLM_API_KEY,
  TEST_RUNNER_TOKEN,
  type RunnerApiHarness,
} from "../../src/test-support/runner-api-harness.ts";
import type { ModelCapabilityChecker } from "../../src/llm/model-capabilities.ts";
import { tableNames } from "../../src/test-support/tables.ts";

const MINUTE = 60 * 1000;
const CREDENTIAL_FORM = /^crj_[A-Za-z0-9_-]{43}$/;

afterEach(() => {
  vi.restoreAllMocks();
});

async function errorOf(response: Response) {
  return (await response.json()).error as {
    code: string;
    message: string;
    retryAfterSeconds?: number;
  };
}

/** Everything in the database as text, to look for a value anywhere. */
async function dumpDatabase(h: RunnerApiHarness): Promise<string> {
  const parts: string[] = [];
  for (const name of await tableNames(h.db)) {
    const { rows } = await sql`select * from ${sql.table(name)}`.execute(h.db);
    parts.push(JSON.stringify(rows));
  }
  return parts.join("\n");
}

/** Two held jobs (two pull requests), each with the credential of its own claim. */
async function twoWorkers(h: RunnerApiHarness) {
  const a = await h.enqueueNew({ prNumber: 7 });
  const claimA = await h.claimedSplit();
  const b = await h.enqueueNew({ prNumber: 8, headSha: "b".repeat(40) });
  const claimB = await h.claimedSplit();
  return {
    a: { id: a.id, credential: claimA.job.credential },
    b: { id: b.id, credential: claimB.job.credential },
  };
}

describe("a job from claim to result with a per-job credential", () => {
  // #320-T01
  it("is claimed by a Dispatcher, fetched, kept alive and delivered by the Worker, and the credential is in no log line", async () => {
    const spies = [
      vi.spyOn(console, "info").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "log").mockImplementation(() => undefined),
    ];
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();

    const claim = await h.claimedSplit();
    const credential = claim.job.credential;
    expect(claim.job.id).toBe(job.id);

    const details = await h.worker.details(job.id, credential);
    expect(details.status).toBe(200);
    expect(details.headers.get("cache-control")).toBe("no-store");
    const detailsBody = await details.json();
    expect(detailsBody).toMatchObject({
      version: 1,
      job: {
        id: job.id,
        heartbeatIntervalSeconds: 30,
        input: {
          command: "review",
          git: { provider: "github", botLogin: expect.any(String) },
          llm: { model: expect.any(String), apiKey: TEST_LLM_API_KEY },
        },
      },
    });
    expect(detailsBody.job).not.toHaveProperty("leaseToken");
    expect(detailsBody.job.input.git.token).toBe(h.issuedJobTokens()[0]);

    h.clock.advance(30 * 1000);
    const beat = await h.worker.heartbeat(job.id, credential);
    expect(beat.status).toBe(200);
    expect(await beat.json()).toStrictEqual({
      version: 1,
      job: {
        id: job.id,
        heartbeatAt: new Date(T0.getTime() + 30 * 1000).toISOString(),
        leaseExpiresAt: new Date(
          T0.getTime() + 30 * 1000 + 2 * MINUTE,
        ).toISOString(),
      },
    });

    const delivered = await h.worker.result(job.id, credential);
    expect(delivered.status).toBe(200);
    expect(await delivered.json()).toStrictEqual({
      version: 1,
      job: { id: job.id, status: "succeeded" },
      alreadyCompleted: false,
    });
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "succeeded",
      errorCode: null,
    });

    const logged = [
      ...h.logLines(),
      ...spies.flatMap((spy) => spy.mock.calls.map((call) => call.join(" "))),
    ].join("\n");
    expect(logged).toContain(job.id);
    expect(logged).not.toContain(credential);
    expect(logged).not.toContain(credential.slice(4));
  });
});

describe("the claim with the feature worker_credential", () => {
  // #320-T02
  it("hands out the credential and no input, no git token and no model key", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();

    const response = await h.claimSplit();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    const body = JSON.parse(text);
    expect(Object.keys(body.job).sort()).toStrictEqual([
      "credential",
      "heartbeatIntervalSeconds",
      "id",
      "leaseExpiresAt",
      "reviewKind",
      // #971: the size label the job requires.
      "sizeLabel",
    ]);
    expect(body).toMatchObject({
      version: 1,
      job: {
        id: job.id,
        reviewKind: "diff",
        heartbeatIntervalSeconds: 30,
        leaseExpiresAt: new Date(T0.getTime() + 2 * MINUTE).toISOString(),
      },
    });
    expect(body.job.credential).toMatch(CREDENTIAL_FORM);
    expect(text).not.toContain("input");
    expect(text).not.toContain("leaseToken");
    expect(text).not.toContain(TEST_LLM_API_KEY);
    // No installation token for the job was created, so none can be in the answer.
    expect(h.issuedJobTokens()).toStrictEqual([]);
    for (const token of h.fake.issuedInstallationTokens())
      expect(text).not.toContain(token);
    // And the model key is not remembered yet: it is revealed by the first fetch.
    expect(await h.claimedKeys.keysOf(job.id)).toStrictEqual([]);
  });

  // #320-T02
  it("is 204 when nothing is due and without a credential for a dispatcher that sent a wrong token", async () => {
    const h = await startRunnerApiHarness();

    expect((await h.claimSplit()).status).toBe(204);
    await h.enqueueNew();
    const refused = await h.claimSplit({ token: "wrong" });

    expect(refused.status).toBe(401);
    expect(
      await h.queue.get((await h.snapshotJobs())[0]?.id ?? ""),
    ).toMatchObject({
      status: "queued",
    });
  });

  // #320-T14
  it("carries 256 random bits, differs per claim and is stored only as a hash", async () => {
    const h = await startRunnerApiHarness();
    const first = await h.enqueueNew({ prNumber: 7 });
    const second = await h.enqueueNew({ prNumber: 8, headSha: "b".repeat(40) });

    const a = (await h.claimedSplit()).job.credential;
    const b = (await h.claimedSplit()).job.credential;

    expect(a).toMatch(CREDENTIAL_FORM);
    expect(b).toMatch(CREDENTIAL_FORM);
    expect(a).not.toBe(b);
    expect(Buffer.from(a.slice(4), "base64url")).toHaveLength(32);
    // What the database holds for the claim is not the credential, nor anything it can be read from.
    const stored = await h.tokenOf(first.id);
    expect(stored).not.toContain(a.slice(4));
    expect(stored).toMatch(/^wc1:[0-9a-f]{64}$/);
    const dump = await dumpDatabase(h);
    expect(dump).not.toContain(a);
    expect(dump).not.toContain(a.slice(4));
    expect(dump).not.toContain(b.slice(4));
    expect(await h.tokenOf(second.id)).not.toBe(stored);
  });

  // #320-T15
  it("keeps the guard, the LLM check and the pull request check at claim, before any credential exists", async () => {
    const guarded = await startRunnerApiHarness({
      guard: {
        check: async () => ({ allow: false, errorCode: "project_deactivated" }),
      },
    });
    const refusedJob = await guarded.enqueueNew();
    expect((await guarded.claimSplit()).status).toBe(204);
    expect(await guarded.queue.get(refusedJob.id)).toMatchObject({
      status: "failed",
      errorCode: "project_deactivated",
    });

    const noKey = await startRunnerApiHarness({ llmKey: null });
    const noKeyJob = await noKey.enqueueNew();
    expect((await noKey.claimSplit()).status).toBe(204);
    expect(await noKey.queue.get(noKeyJob.id)).toMatchObject({
      status: "failed",
      errorCode: "llm_not_configured",
    });

    const closed = await startRunnerApiHarness();
    const closedJob = await closed.enqueueNew({ prNumber: 9 });
    expect((await closed.claimSplit()).status).toBe(204);
    expect(await closed.queue.get(closedJob.id)).toMatchObject({
      status: "failed",
      errorCode: "pull_request_closed",
    });

    for (const h of [guarded, noKey, closed])
      expect(h.issuedJobTokens()).toStrictEqual([]);
  });

  // #320-T15
  it("gives the job back with a 503 when GitHub cannot be read at claim, as the legacy claim does", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    h.fake.fail({ pathIncludes: "/access_tokens", status: 503, times: 1 });

    const response = await h.claimSplit();

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "queued",
      attempts: 1,
    });
  });

  // #320-T16
  it("tells a Dispatcher the review kind of a Dynamic job and still hands out no input", async () => {
    const h = await startRunnerApiHarness({ projects: true });
    await h.projectService.activateProject(h.repositoryId);
    await h.reviewSettings.updateProjectSettings(h.repositoryId, {
      reviewKind: "dynamic",
      dynamicModel: "vendor/dynamic-model",
    });
    await h.enqueueNew();

    const claim = await h.claimedSplit({ engines: ["pr-agent", "opencode"] });

    expect(claim.job.reviewKind).toBe("dynamic");
    expect(claim.job).not.toHaveProperty("input");
    expect(h.issuedJobTokens()).toStrictEqual([]);
  });

  // #320-T16
  it("does not hand a Dynamic job to a Dispatcher that does not advertise the engine, as before", async () => {
    const h = await startRunnerApiHarness({ projects: true });
    await h.projectService.activateProject(h.repositoryId);
    await h.reviewSettings.updateProjectSettings(h.repositoryId, {
      reviewKind: "dynamic",
      dynamicModel: "vendor/dynamic-model",
    });
    const job = await h.enqueueNew();

    expect((await h.claimSplit()).status).toBe(204);
    expect(await h.queue.get(job.id)).toMatchObject({ status: "queued" });
  });
});

describe("the details of a job", () => {
  // #424-T08: the route does not use the list yet (it is #432's claim and fetch resolver), so this pins
  // only what must hold for every shape of it: the call is not refused and the job is unchanged. That a
  // newer Worker's list is read is asserted by `parseWorkerLlmProviders` (requests.test.ts) and by the
  // runner sending it (test_runner_api_client.py); #432 adds the assertion on the route.
  it.each([
    ["without the providers", undefined],
    ["with the provider of a previous-release Worker", "openrouter"],
    [
      "with a provider this app has no adapter for",
      "openrouter,a_future_provider",
    ],
    ["with a malformed list", "OpenRouter,,x"],
  ])(
    "answers the details request %s with the same job: OpenRouter",
    async (_name, providers) => {
      const h = await startRunnerApiHarness();
      const job = await h.enqueueNew();
      const claim = await h.claimedSplit();

      const response = await h.worker.details(
        job.id,
        claim.job.credential,
        "dynamic_capabilities",
        undefined,
        providers,
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.job.input.llm.provider).toBe("openrouter");
    },
  );

  // #320-T17
  it("mints the git token and reveals the model key at fetch, and remembers the key then", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    const claim = await h.claimedSplit();
    expect(h.issuedJobTokens()).toHaveLength(0);

    const response = await h.worker.details(job.id, claim.job.credential);

    const body = await response.json();
    expect(h.issuedJobTokens()).toHaveLength(1);
    expect(body.job.input.git.token).toBe(h.issuedJobTokens()[0]);
    expect(body.job.input.llm.apiKey).toBe(TEST_LLM_API_KEY);
    expect(body.job.tokenExpiresAt).toEqual(expect.any(String));
    expect(await h.claimedKeys.keysOf(job.id)).toStrictEqual([
      TEST_LLM_API_KEY,
    ]);
  });

  // #320-T05
  it("is allowed three times per claim, each with a fresh token, and refused the fourth time", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    const { job: claimed } = await h.claimedSplit();

    const tokens: string[] = [];
    for (let fetch = 0; fetch < 3; fetch += 1) {
      const response = await h.worker.details(job.id, claimed.credential);
      expect(response.status).toBe(200);
      tokens.push((await response.json()).job.input.git.token);
    }
    expect(new Set(tokens).size).toBe(3);
    const before = h.issuedJobTokens().length;

    const fourth = await h.worker.details(job.id, claimed.credential);

    expect(fourth.status).toBe(401);
    expect((await errorOf(fourth)).code).toBe("WORKER_CREDENTIAL_INVALID");
    expect(h.issuedJobTokens()).toHaveLength(before);
    expect(await h.queue.get(job.id)).toMatchObject({ status: "running" });
    // The job itself goes on: the Worker that fetched keeps its lease.
    expect((await h.worker.heartbeat(job.id, claimed.credential)).status).toBe(
      200,
    );
  });

  // #320-T05
  it("counts the fetches again for a new claim of the same job", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    const first = await h.claimedSplit();
    for (let fetch = 0; fetch < 3; fetch += 1)
      await h.worker.details(job.id, first.job.credential);
    h.clock.advance(3 * MINUTE);

    const second = await h.claimedSplit();

    expect(second.job.id).toBe(job.id);
    expect((await h.worker.details(job.id, second.job.credential)).status).toBe(
      200,
    );
  });

  // #320-T18
  it("sends the capabilities of a Dynamic job only to a Worker that names the feature", async () => {
    const checker: ModelCapabilityChecker = {
      check: async () => ({
        outcome: "supported",
        capabilities: {
          tools: true,
          toolChoice: true,
          toolChoiceRequired: true,
          responseFormat: true,
          structuredOutputs: true,
          maxCompletionTokens: 393_216,
          smallestCompletionTokens: 131_072,
          contextLength: 1_048_576,
          inputUsdPerMtok: "0.6",
          outputUsdPerMtok: "2.4",
        },
      }),
    };
    const h = await startRunnerApiHarness({
      projects: true,
      modelCapabilities: checker,
    });
    await h.projectService.activateProject(h.repositoryId);
    await h.reviewSettings.updateProjectSettings(h.repositoryId, {
      reviewKind: "dynamic",
      dynamicModel: "vendor/dynamic-model",
    });
    await h.enqueueNew();
    const claim = await h.claimedSplit({ engines: ["pr-agent", "opencode"] });

    const without = await (
      await h.worker.details(claim.job.id, claim.job.credential)
    ).json();
    const unknown = await (
      await h.worker.details(
        claim.job.id,
        claim.job.credential,
        "a_future_feature",
      )
    ).json();
    const withFeature = await (
      await h.worker.details(
        claim.job.id,
        claim.job.credential,
        "a_future_feature,dynamic_capabilities",
      )
    ).json();

    expect(without.job.input.reviewKind).toBe("dynamic");
    expect(without.job.input.dynamic).not.toHaveProperty("capabilities");
    expect(unknown.job.input.dynamic).not.toHaveProperty("capabilities");
    expect(withFeature.job.input.dynamic.capabilities).toMatchObject({
      toolChoiceRequired: true,
      contextWindowTokens: 1_048_576,
    });
    expect(withFeature.job.input.base).toMatchObject({
      repository: h.repository.fullName,
      baseRef: "main",
    });
  });

  // #320-T06
  it("ends the job with a stable code and answers 409 RUNNER_JOB_ENDED when the installation was removed", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    const claim = await h.claimedSplit();
    h.fake.removeInstallation(4242);

    const response = await h.worker.details(job.id, claim.job.credential);

    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("RUNNER_JOB_ENDED");
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "git_connection_gone",
    });
    // The Worker is told to stop for good: the credential is of no use any more.
    expect(
      (await h.worker.heartbeat(job.id, claim.job.credential)).status,
    ).toBe(409);
  });

  // #320-T06
  it("also ends the job when the pull request cannot be read because the installation is gone", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    const claim = await h.claimedSplit();
    h.fake.removeInstallation(4242);
    // The cached read token has expired, so reading the pull request asks for a new one.
    h.githubClock.advance(2 * 60 * 60 * 1000);

    const response = await h.worker.details(job.id, claim.job.credential);

    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("RUNNER_JOB_ENDED");
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "git_connection_gone",
    });
  });

  // #320-T06
  it("ends the job when the LLM access went away between claim and fetch", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    const claim = await h.claimedSplit();
    await h.setLlmKey(null);

    const response = await h.worker.details(job.id, claim.job.credential);

    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("RUNNER_JOB_ENDED");
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "llm_not_configured",
    });
    expect(h.issuedJobTokens()).toStrictEqual([]);
  });

  // #320-T06
  it("cancels the job when the project was switched off between claim and fetch", async () => {
    let allow = true;
    const h = await startRunnerApiHarness({
      guard: {
        check: async () =>
          allow
            ? { allow: true }
            : {
                allow: false,
                outcome: "cancel",
                errorCode: "project_deactivated",
              },
      },
    });
    const job = await h.enqueueNew();
    const claim = await h.claimedSplit();
    allow = false;

    const response = await h.worker.details(job.id, claim.job.credential);

    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("RUNNER_JOB_ENDED");
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "cancelled",
      errorCode: "project_deactivated",
    });
    expect(h.issuedJobTokens()).toStrictEqual([]);
  });

  // #320-T07
  it("releases the job with an attempt counted and answers 503 with Retry-After when GitHub is unavailable", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    const claim = await h.claimedSplit();
    h.fake.fail({ pathIncludes: "/access_tokens", status: 503, times: 1 });

    const response = await h.worker.details(job.id, claim.job.credential);

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await errorOf(response)).toMatchObject({
      code: "RUNNER_GIT_ACCESS_UNAVAILABLE",
      retryAfterSeconds: 30,
    });
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "queued",
      attempts: 1,
      runnerId: null,
      runAfter: new Date(T0.getTime() + 30 * 1000).toISOString(),
    });
    // The released claim's credential is dead.
    expect((await h.worker.details(job.id, claim.job.credential)).status).toBe(
      401,
    );
  });

  // #320-T07
  it("fails the job on the last allowed attempt instead of giving it back for ever", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    h.fake.fail({ pathIncludes: "/access_tokens", status: 503 });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const claimed = await h.claimSplit();
      if (claimed.status === 200) {
        const { job: split } = await claimed.json();
        expect((await h.worker.details(job.id, split.credential)).status).toBe(
          503,
        );
      }
      h.clock.advance(60 * 1000);
    }

    expect(await h.queue.get(job.id)).toMatchObject({ status: "failed" });
  });

  // #320-T19
  it("answers 500 without any detail, gives the job back and logs no secret when something unexpected fails", async () => {
    let broken = false;
    const h = await startRunnerApiHarness({
      jobOptions: {
        optionsFor: async () => {
          if (broken) throw new Error("database is locked crj_leak");
          return { env: {} };
        },
      },
    });
    const job = await h.enqueueNew();
    const claim = await h.claimedSplit();
    broken = true;

    const response = await h.worker.details(job.id, claim.job.credential);

    expect(response.status).toBe(500);
    expect((await errorOf(response)).code).toBe("RUNNER_INTERNAL_ERROR");
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "queued",
      attempts: 1,
    });
    const logged = h.logLines().join("\n");
    expect(logged).not.toContain("crj_leak");
    expect(logged).not.toContain(claim.job.credential);
  });
});

describe("a credential and what it is valid for", () => {
  // #320-T03
  it("is refused on another job, on every Worker call, and nothing changes", async () => {
    const h = await startRunnerApiHarness();
    const { a, b } = await twoWorkers(h);
    const before = await h.snapshotJobs();
    const issued = h.issuedJobTokens().length;

    for (const response of [
      await h.worker.details(b.id, a.credential),
      await h.worker.heartbeat(b.id, a.credential),
      await h.worker.result(b.id, a.credential),
    ]) {
      expect(response.status).toBe(401);
      expect((await errorOf(response)).code).toBe("WORKER_CREDENTIAL_INVALID");
    }

    expect(await h.snapshotJobs()).toStrictEqual(before);
    expect(h.issuedJobTokens()).toHaveLength(issued);
    expect(await h.claimedKeys.keysOf(b.id)).toStrictEqual([]);
    // Each credential still works for its own job.
    expect((await h.worker.heartbeat(b.id, b.credential)).status).toBe(200);
    expect((await h.worker.heartbeat(a.id, a.credential)).status).toBe(200);
  });

  // #320-T03
  it("answers the same 401 for an unknown job, a wrong credential and a missing one", async () => {
    const h = await startRunnerApiHarness();
    const { a } = await twoWorkers(h);
    const unknown = "11111111-2222-4333-8444-555555555555";
    const wrong = `crj_${"A".repeat(43)}`;

    const answers = await Promise.all(
      [
        h.worker.details(unknown, a.credential),
        h.worker.details(a.id, wrong),
        h.worker.details(a.id, null),
        h.worker.heartbeat(unknown, a.credential),
        h.worker.result(unknown, a.credential),
      ].map(async (pending) => {
        const response = await pending;
        return [response.status, await response.text()];
      }),
    );

    for (const answer of answers) expect(answer).toStrictEqual(answers[0]);
    expect(answers[0]?.[0]).toBe(401);
  });

  // #320-T04
  it("is refused when it is the dispatcher credential on a Worker route", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    await h.claimedSplit();
    const before = await h.snapshotJobs();

    for (const response of [
      await h.worker.details(job.id, TEST_RUNNER_TOKEN),
      await h.worker.heartbeat(job.id, TEST_RUNNER_TOKEN),
      await h.worker.result(job.id, TEST_RUNNER_TOKEN),
    ]) {
      expect(response.status).toBe(401);
      expect((await errorOf(response)).code).toBe("WORKER_CREDENTIAL_INVALID");
    }

    expect(await h.snapshotJobs()).toStrictEqual(before);
  });

  // #320-T04
  it("is refused on the runner API: as the bearer of claim, heartbeat and complete, and as a lease token", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    await h.enqueueNew({ prNumber: 8, headSha: "b".repeat(40) });
    const { job: claimed } = await h.claimedSplit();
    const before = await h.snapshotJobs();

    const asBearer = [
      await h.claimSplit({ token: claimed.credential }),
      await h.claim({ token: claimed.credential }),
      await h.heartbeat(job.id, "x".repeat(20), { token: claimed.credential }),
      await h.complete(
        job.id,
        "x".repeat(20),
        {},
        { token: claimed.credential },
      ),
    ];
    for (const response of asBearer) {
      expect(response.status).toBe(401);
      expect((await errorOf(response)).code).toBe("RUNNER_UNAUTHORIZED");
    }
    // The Dispatcher itself holds the credential: it is still not a lease token of the runner API.
    const asLeaseToken = [
      await h.heartbeat(job.id, claimed.credential),
      await h.complete(job.id, claimed.credential),
    ];
    for (const response of asLeaseToken) {
      expect(response.status).toBe(409);
      expect((await errorOf(response)).code).toBe("RUNNER_LEASE_LOST");
    }

    expect(await h.snapshotJobs()).toStrictEqual(before);
  });

  // #320-T04
  it("is not satisfied by the lease token of a legacy claim, nor by its credential-shaped spelling", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    const legacy = await h.claimed();
    const stored = await h.tokenOf(job.id);

    for (const secret of [
      legacy.job.leaseToken,
      `crj_${legacy.job.leaseToken}`,
      `crj_${stored}`,
      stored,
    ]) {
      const response = await h.worker.heartbeat(job.id, secret);
      expect(response.status).toBe(401);
    }
    expect((await h.heartbeat(job.id, legacy.job.leaseToken)).status).toBe(200);
  });

  // #320-T09
  it("is rejected once the lease expired and the job was claimed again, and the new one works", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    const old = (await h.claimedSplit()).job.credential;
    await h.worker.details(job.id, old);
    h.clock.advance(3 * MINUTE);

    const fresh = (await h.claimedSplit()).job.credential;

    expect(fresh).not.toBe(old);
    for (const response of [
      await h.worker.details(job.id, old),
      await h.worker.heartbeat(job.id, old),
      await h.worker.result(job.id, old),
    ])
      expect(response.status).toBe(401);
    expect(await h.queue.get(job.id)).toMatchObject({ status: "running" });
    expect((await h.worker.heartbeat(job.id, fresh)).status).toBe(200);
    expect((await h.worker.details(job.id, fresh)).status).toBe(200);
    expect((await h.worker.result(job.id, fresh)).status).toBe(200);
  });

  // #320-T09
  it("is rejected once the lease expired even before anyone claimed the job again", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    const credential = (await h.claimedSplit()).job.credential;
    h.clock.advance(3 * MINUTE);
    await h.queue.expireStaleJobs();

    expect((await h.worker.heartbeat(job.id, credential)).status).toBe(401);
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "queued",
      attempts: 1,
    });
  });

  // #320-T20
  it("is valid after the final state for a repeat of the same result only", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    const { job: claimed } = await h.claimedSplit();
    await h.worker.details(job.id, claimed.credential);
    expect((await h.worker.result(job.id, claimed.credential)).status).toBe(
      200,
    );

    for (const response of [
      await h.worker.details(job.id, claimed.credential),
      await h.worker.heartbeat(job.id, claimed.credential),
    ]) {
      expect(response.status).toBe(409);
      expect((await errorOf(response)).code).toBe("RUNNER_JOB_ENDED");
    }
    expect(h.issuedJobTokens()).toHaveLength(1);
    const repeated = await h.worker.result(job.id, claimed.credential);
    expect(repeated.status).toBe(200);
    expect(await queueStatus(h, job.id)).toBe("succeeded");
  });

  // #320-T20
  it("is refused with RUNNER_JOB_ENDED for a job the app cancelled", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    const { job: claimed } = await h.claimedSplit();
    await h.queue.cancelClaimed(
      job.id,
      await h.tokenOf(job.id),
      "project_deactivated",
    );

    for (const response of [
      await h.worker.details(job.id, claimed.credential),
      await h.worker.heartbeat(job.id, claimed.credential),
      await h.worker.result(job.id, claimed.credential),
    ]) {
      expect(response.status).toBe(409);
      expect((await errorOf(response)).code).toBe("RUNNER_JOB_ENDED");
    }
  });

  // #320-T21
  it("fails a job past the hard limit at its next heartbeat and tells the Worker the job ended", async () => {
    const h = await startRunnerApiHarness({
      limits: { maxRuntimeMs: 10 * MINUTE },
    });
    const job = await h.enqueueNew();
    const { job: claimed } = await h.claimedSplit();
    for (let minute = 0; minute < 12; minute += 1) {
      h.clock.advance(MINUTE);
      const response = await h.worker.heartbeat(job.id, claimed.credential);
      if (response.status !== 200) {
        expect(response.status).toBe(409);
        expect((await errorOf(response)).code).toBe("RUNNER_JOB_ENDED");
        break;
      }
    }

    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "timeout",
    });
  });

  // #320-T21
  it("answers a heartbeat without a body, with an empty object and with a body it ignores", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    const { job: claimed } = await h.claimedSplit();

    for (const body of ["", "{}", '{"leaseToken":"ignored","x":1}']) {
      const response = await h.worker.heartbeat(
        job.id,
        claimed.credential,
        body,
      );
      expect(response.status).toBe(200);
    }
  });
});

async function queueStatus(h: RunnerApiHarness, jobId: string) {
  return (await h.queue.get(jobId))?.status;
}

describe("the result", () => {
  // #320-T08
  it("answers 200 alreadyCompleted for the same result again and 409 for another one", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    const { job: claimed } = await h.claimedSplit();
    await h.worker.details(job.id, claimed.credential);

    const first = await h.worker.result(job.id, claimed.credential);
    const same = await h.worker.result(job.id, claimed.credential);
    const other = await h.worker.result(job.id, claimed.credential, {
      logTail: "another log",
    });

    expect(await first.json()).toStrictEqual({
      version: 1,
      job: { id: job.id, status: "succeeded" },
      alreadyCompleted: false,
    });
    expect(same.status).toBe(200);
    expect(await same.json()).toStrictEqual({
      version: 1,
      job: { id: job.id, status: "succeeded" },
      alreadyCompleted: true,
    });
    expect(other.status).toBe(409);
    expect((await errorOf(other)).code).toBe("RUNNER_RESULT_CONFLICT");
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "succeeded",
      result: expect.objectContaining({ logTail: "review published" }),
    });
  });

  // #320-T08
  it("stores a failed result with its code and maps a code it does not know to unknown", async () => {
    const h = await startRunnerApiHarness();
    const failing = await h.enqueueNew();
    const { job: claimed } = await h.claimedSplit();

    const response = await h.worker.result(failing.id, claimed.credential, {
      ok: false,
      errorCode: "llm_timeout",
      errorMessage: "the model took too long",
    });

    expect(await response.json()).toMatchObject({
      job: { status: "failed" },
      alreadyCompleted: false,
    });
    expect(await h.queue.get(failing.id)).toMatchObject({
      status: "failed",
      errorCode: "llm_timeout",
    });
  });

  // #320-T22
  it.each(["runner_shutdown", "launch_failed"])(
    "gives the job back instead of storing it for %s, with an attempt counted",
    async (errorCode) => {
      const h = await startRunnerApiHarness();
      const job = await h.enqueueNew();
      const { job: claimed } = await h.claimedSplit();

      const response = await h.worker.result(job.id, claimed.credential, {
        ok: false,
        errorCode,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toStrictEqual({
        version: 1,
        job: { id: job.id, status: "queued" },
        alreadyCompleted: false,
      });
      expect(await h.queue.get(job.id)).toMatchObject({
        status: "queued",
        attempts: 1,
        result: null,
      });
      // The claim is over: the credential is dead and a new claim gets a new one.
      expect((await h.worker.result(job.id, claimed.credential)).status).toBe(
        401,
      );
      expect((await h.claimedSplit()).job.id).toBe(job.id);
    },
  );

  // #320-T22
  it("fails the job on the last allowed attempt when a shutdown is reported", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { job: claimed } = await h.claimedSplit();
      await h.worker.result(job.id, claimed.credential, {
        ok: false,
        errorCode: "launch_failed",
      });
    }
    const { job: last } = await h.claimedSplit();

    const response = await h.worker.result(job.id, last.credential, {
      ok: false,
      errorCode: "launch_failed",
    });

    expect(await response.json()).toMatchObject({ job: { status: "failed" } });
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "launch_failed",
    });
  });

  // #320-T11
  it("masks secrets in the log, including the model key remembered at fetch after it was rotated", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    const { job: claimed } = await h.claimedSplit();
    const details = await (
      await h.worker.details(job.id, claimed.credential)
    ).json();
    const gitToken: string = details.job.input.git.token;
    const rotated = "rotated-llm-key-9a8b7c6d5e4f";
    await h.setLlmKey(rotated);

    const response = await h.worker.result(job.id, claimed.credential, {
      logTail: [
        `key ${TEST_LLM_API_KEY}`,
        `new key ${rotated}`,
        `token ${gitToken}`,
        `runner ${TEST_RUNNER_TOKEN}`,
        `credential ${claimed.credential}`,
        `Authorization: Bearer ${claimed.credential}`,
      ].join("\n"),
      errorMessage: `failed with ${TEST_LLM_API_KEY}`,
    });

    expect(response.status).toBe(200);
    const stored = JSON.stringify((await h.queue.get(job.id))?.result);
    for (const secret of [
      TEST_LLM_API_KEY,
      rotated,
      TEST_RUNNER_TOKEN,
      claimed.credential,
      claimed.credential.slice(4),
    ])
      expect(stored).not.toContain(secret);
    expect(stored).toContain("[redacted]");
  });

  // #320-T11
  it("masks the model key remembered at fetch when another app instance serves the result", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    const { job: claimed } = await h.claimedSplit();
    await h.worker.details(job.id, claimed.credential);
    await h.setLlmKey("rotated-llm-key-9a8b7c6d5e4f");
    const other = h.anotherInstance();

    await h.worker.result(
      job.id,
      claimed.credential,
      { logTail: `old key ${TEST_LLM_API_KEY}` },
      other.workerApi,
    );

    expect(JSON.stringify((await h.queue.get(job.id))?.result)).not.toContain(
      TEST_LLM_API_KEY,
    );
  });

  // #320-T12
  it("refuses a body over 64 KiB with 413 before parsing it, on result and heartbeat, and changes nothing", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    const { job: claimed } = await h.claimedSplit();
    const before = await h.snapshotJobs();
    const notJson = "x".repeat(64 * 1024 + 1);

    for (const response of [
      await h.worker.result(job.id, claimed.credential, notJson),
      await h.worker.heartbeat(job.id, claimed.credential, notJson),
      await h.worker.result(
        job.id,
        claimed.credential,
        JSON.stringify({ result: { padding: "y".repeat(65 * 1024) } }),
      ),
    ]) {
      expect(response.status).toBe(413);
      expect((await errorOf(response)).code).toBe("RUNNER_BODY_TOO_LARGE");
    }

    expect(await h.snapshotJobs()).toStrictEqual(before);
  });

  // #320-T12
  it("checks the credential before it reads a large body", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    await h.claimedSplit();

    const response = await h.worker.result(
      job.id,
      `crj_${"B".repeat(43)}`,
      "x".repeat(70 * 1024),
    );

    expect(response.status).toBe(401);
  });

  // #320-T23
  it("refuses a body that is not a result with 400 and the names of the fields, never values", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    const { job: claimed } = await h.claimedSplit();

    for (const body of ["not json", "[]", "{}", '{"result":{"ok":"yes"}}']) {
      const response = await h.worker.result(job.id, claimed.credential, body);
      expect(response.status).toBe(400);
      const error = await errorOf(response);
      expect(error.code).toBe("RUNNER_REQUEST_INVALID");
    }
    expect(await h.queue.get(job.id)).toMatchObject({ status: "running" });
  });

  // #320-T23
  it("refuses a job id that is not a UUID with 400", async () => {
    const h = await startRunnerApiHarness();
    const { job: claimed } = await (async () => {
      await h.enqueueNew();
      return h.claimedSplit();
    })();

    const response = await h.worker.details("not-a-uuid", claimed.credential);

    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe("RUNNER_REQUEST_INVALID");
  });
});

describe("an old runner and the legacy claim", () => {
  // #320-T10
  it("gets exactly the legacy answer, byte for byte, without the feature", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();

    const response = await h.claim();

    const text = await response.text();
    const stored = await h.tokenOf(job.id);
    const [gitToken] = h.issuedJobTokens();
    expect(gitToken).toBeDefined();
    const botLogin = JSON.parse(text).job.input.git.botLogin;
    const baseUrl = JSON.parse(text).job.input.git.baseUrl;
    const prUrl = JSON.parse(text).job.input.prUrl;
    expect(text).toBe(
      JSON.stringify({
        version: 1,
        job: {
          id: job.id,
          leaseToken: stored,
          leaseExpiresAt: new Date(T0.getTime() + 2 * MINUTE).toISOString(),
          heartbeatIntervalSeconds: 30,
          tokenExpiresAt: JSON.parse(text).job.tokenExpiresAt,
          input: {
            prUrl,
            command: "review",
            git: { provider: "github", baseUrl, token: gitToken, botLogin },
            llm: {
              provider: "openrouter",
              model: "vendor/test-model",
              apiKey: TEST_LLM_API_KEY,
              // #689: the token budget the app decides, last of the legacy keys.
              maxTokens: 100000,
            },
            env: {},
          },
        },
      }),
    );
    expect(await h.claimedKeys.keysOf(job.id)).toStrictEqual([
      TEST_LLM_API_KEY,
    ]);
  });

  // #320-T10
  it("is not given the split answer for a feature it did not name, nor for a misspelled one", async () => {
    const h = await startRunnerApiHarness();
    await h.enqueueNew();

    const response = await h.claim({
      engines: ["pr-agent"],
      features: ["dynamic_capabilities", "worker_credentials"],
    });

    const body = await response.json();
    expect(body.job.leaseToken).toEqual(expect.any(String));
    expect(body.job.input.command).toBe("review");
    expect(body.job).not.toHaveProperty("credential");
  });

  // #320-T10
  it("keeps a lease token in the form of the legacy claim: 256 random bits, not a credential", async () => {
    const h = await startRunnerApiHarness();
    await h.enqueueNew();

    const body = await h.claimed();

    expect(body.job.leaseToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.job.leaseToken).not.toMatch(/^crj_/);
    expect((await h.heartbeat(body.job.id, body.job.leaseToken)).status).toBe(
      200,
    );
  });

  // #320-T10
  it("completes a legacy job with its lease token as before, also a runner_shutdown", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    const body = await h.claimed();

    const response = await h.complete(job.id, body.job.leaseToken, {
      ok: false,
      errorCode: "runner_shutdown",
    });

    expect(await response.json()).toMatchObject({ job: { status: "queued" } });
  });

  // #320-T10
  it("keeps launch_failed an ordinary failed result on the legacy complete call", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    const body = await h.claimed();

    const response = await h.complete(job.id, body.job.leaseToken, {
      ok: false,
      errorCode: "launch_failed",
    });

    // The legacy complete call stores it as a failed result, as before.
    expect(await response.json()).toMatchObject({ job: { status: "failed" } });
  });
});
