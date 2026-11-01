// SPDX-License-Identifier: LicenseRef-Proprietary

// The fake App for the Dispatcher and the Worker (#318): it speaks the Dispatcher API (claim, release,
// version under /api/runners/v1) and the Worker API (job details, heartbeat, result under
// /api/workers/v1) with the bodies of the contract examples, and fails on script: a status code and
// body, a delay, a lease that is lost. Nothing is random and nothing reads the clock but `now`, so a
// scripted run is the same every time. The Worker (#323), the Dispatcher (#327) and the journeys (#332)
// run against it; it has no database, no secret and no network beyond its own port.
//
// Node runs this file as it is (type stripping): relative imports with the .ts extension and no
// TypeScript-only runtime syntax. It reads the examples of contracts/ from disk, so its answers cannot
// drift from them (app/integration-tests/fakes checks every answer against the schemas).
//
// The Dispatcher API also answers the state of a job (`GET /api/runners/v1/jobs/{id}`, #364); a test sets the
// state with `setJobStatus` (or `POST /__fake/job-status`) and scripts the route `job_state` like any other.
//
// Control API (JSON, no authentication: loopback and test only), for suites that run it as a process
// (main.ts):
//   GET  /__fake/health                         200 once the server is up
//   POST /__fake/enqueue   {id?, reviewKind?}   adds a queued job, answers {id}
//   POST /__fake/script    {route, steps}       the next requests of that route get the steps in order
//   POST /__fake/lose-lease {jobId}             heartbeat and result of that job answer 409
//   POST /__fake/supersede {jobId}              the heartbeats of that job answer `superseded: true` (to a
//                                               Worker that named the feature `supersede`), with a lease
//                                               ending SUPERSEDED_CLAIM_SECONDS after the call (not extended)
//   POST /__fake/job-status {jobId, status}     sets the status the job state call answers
//   GET  /__fake/requests                       every call so far: {method, route, jobId, status}
//   GET  /__fake/results[?jobId=<id>]           the results delivered so far
//   POST /__fake/reset                          forgets jobs, scripts and the log
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { join } from "node:path";
import { keepConnectionsOpen } from "../keep-alive.ts";

const CONTRACTS = join(import.meta.dirname, "..", "..", "contracts");
const FIXTURES = join(import.meta.dirname, "..", "fixtures");

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

const LEASE_SECONDS = 120;
/** The claim of a superseded run (`claimSeconds` of `SupersedeTiming` in the contract). */
const SUPERSEDED_CLAIM_SECONDS = 240;
const HEARTBEAT_SECONDS = 30;
const MAX_ATTEMPTS = 3;
const MAX_BODY_BYTES = 64 * 1024;
const UUID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SHUTDOWN_CODES = ["runner_shutdown", "launch_failed"];

export type Route =
  | "claim"
  | "release"
  | "vm"
  | "version"
  | "job_state"
  | "job"
  | "heartbeat"
  | "result";
const ROUTES: readonly Route[] = [
  "claim",
  "release",
  "vm",
  "version",
  "job_state",
  "job",
  "heartbeat",
  "result",
];

/** One scripted reaction to the next request of a route. */
export type Step = {
  /** Wait this long first (through `sleep`, so a test can make it instant). */
  delayMs?: number;
  /** Answer with this status instead of handling the request. */
  status?: number;
  /** The body of that answer; the contract's error body for the status when absent. */
  body?: unknown;
  /** Adds `Retry-After` and `retryAfterSeconds` to the answer. */
  retryAfterSeconds?: number;
};

export type ReviewKind = "diff" | "dynamic" | "implementer";
/** The engine that runs a job of each kind: a claim only gets a job whose engine it advertised. */
const ENGINE_OF_KIND: Record<ReviewKind, string> = {
  diff: "pr-agent",
  dynamic: "opencode",
  implementer: "implementer",
};
const JOB_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "superseded",
  "cancelled",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export type EnqueueOptions = {
  id?: string;
  reviewKind?: ReviewKind;
  input?: Record<string, unknown>;
};

export type LoggedRequest = {
  method: string;
  route: Route;
  jobId: string | null;
  status: number;
};

export type DispatcherAppFakeOptions = {
  host?: string;
  /** 0 (the default) picks a free port. */
  port?: number;
  /** The dispatcher credential (RUNNER_TOKEN) the Dispatcher API accepts. */
  dispatcherToken?: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  appVersion?: string;
};

export type DispatcherAppFake = {
  url: string;
  enqueue(options?: EnqueueOptions): string;
  script(route: Route, steps: Step[]): void;
  loseLease(jobId: string): void;
  /** A newer push replaced the run: its heartbeats answer `superseded` and the lease is not extended (#396). */
  supersede(jobId: string): void;
  /** Sets the status the job state call answers for a job (the App's other statuses than a claim reaches). */
  setJobStatus(jobId: string, status: JobStatus): void;
  results(jobId: string): unknown[];
  /** #493: the VMs the Dispatcher reported for a job, in order (`VmStartRequest` without the credential). */
  vms(jobId: string): Array<Record<string, unknown>>;
  requests(): LoggedRequest[];
  reset(): void;
  close(): Promise<void>;
};

type JobState = {
  id: string;
  reviewKind: ReviewKind;
  input: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  claims: number;
  credential: string | null;
  runnerId: string | null;
  leaseLost: boolean;
  /** #396: the App superseded the run; only a Worker that named the feature is told. */
  superseded: boolean;
  supersedeFeature: boolean;
  /** The end of the claim of a superseded run; its heartbeats keep it (the App sets it once, at the push). */
  leaseEndsAt: string | null;
  results: Array<Record<string, unknown>>;
  /** #493: the VMs reported for the job. */
  vms: Array<Record<string, unknown>>;
};

type Reply = {
  status: number;
  body?: unknown;
  retryAfterSeconds?: number;
};

const ERROR_BY_STATUS: Record<number, [string, string]> = {
  400: ["RUNNER_REQUEST_INVALID", "The request is not valid."],
  404: ["RUNNER_JOB_NOT_FOUND", "There is no such job."],
  409: ["RUNNER_LEASE_LOST", "The caller does not hold this job."],
  413: ["RUNNER_BODY_TOO_LARGE", "The request body is too large."],
  503: [
    "RUNNER_GIT_ACCESS_UNAVAILABLE",
    "Credentials for the job could not be created right now. Try again later.",
  ],
};

function errorReply(
  status: number,
  code?: string,
  retryAfterSeconds?: number,
): Reply {
  const [defaultCode, message] = ERROR_BY_STATUS[status] ?? [
    "RUNNER_INTERNAL_ERROR",
    "The request could not be handled.",
  ];
  return {
    status,
    retryAfterSeconds,
    body: {
      error: {
        code: code ?? defaultCode,
        message,
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      },
    },
  };
}

/** 256 bits as the contract's credential: `crj_` and 43 characters, the same for the same job and claim. */
function credentialFor(jobId: string, claim: number): string {
  const digest = createHash("sha256")
    .update(`fake-credential:${jobId}:${claim}`)
    .digest("base64url");
  return `crj_${digest.slice(0, 43)}`;
}

function bearer(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (header === undefined || !header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

async function readBody(
  request: IncomingMessage,
): Promise<{ text: string } | "too_large"> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return "too_large";
    chunks.push(buffer);
  }
  return { text: Buffer.concat(chunks).toString("utf8") };
}

function parseObject(text: string): Record<string, unknown> | null {
  if (text.trim() === "") return {};
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function startDispatcherAppFake(
  options: DispatcherAppFakeOptions = {},
): Promise<DispatcherAppFake> {
  const dispatcherToken = options.dispatcherToken ?? "fake-dispatcher-token";
  const now = options.now ?? (() => new Date());
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const appVersion = options.appVersion ?? "0.0.0-fake";

  const legacyClaim = readJson(
    join(CONTRACTS, "examples", "ClaimResponse.json"),
  );
  const exampleJob = legacyClaim.job as Record<string, unknown>;
  const defaultInputs: Record<ReviewKind, Record<string, unknown>> = {
    diff: exampleJob.input as Record<string, unknown>,
    dynamic: readJson(join(FIXTURES, "dynamic-review-job.json")),
    implementer: readJson(
      join(CONTRACTS, "examples", "implementer", "RunnerJobInput.json"),
    ),
  };
  const versionExample = readJson(
    join(CONTRACTS, "examples", "VersionResponse.json"),
  );

  const jobs = new Map<string, JobState>();
  const scripts = new Map<Route, Step[]>();
  let log: LoggedRequest[] = [];
  let counter = 0;

  function iso(offsetSeconds = 0): string {
    return new Date(now().getTime() + offsetSeconds * 1000).toISOString();
  }

  function enqueue(enqueueOptions: EnqueueOptions = {}): string {
    counter += 1;
    const id =
      enqueueOptions.id ??
      `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
    const reviewKind = enqueueOptions.reviewKind ?? "diff";
    jobs.set(id, {
      id,
      reviewKind,
      input: structuredClone(enqueueOptions.input ?? defaultInputs[reviewKind]),
      status: "queued",
      attempts: 0,
      claims: 0,
      credential: null,
      runnerId: null,
      leaseLost: false,
      superseded: false,
      supersedeFeature: false,
      leaseEndsAt: null,
      results: [],
      vms: [],
    });
    return id;
  }

  function requeue(job: JobState): "queued" | "failed" {
    job.credential = null;
    job.runnerId = null;
    job.attempts += 1;
    job.status = job.attempts >= MAX_ATTEMPTS ? "failed" : "queued";
    return job.status === "failed" ? "failed" : "queued";
  }

  function handleClaim(body: Record<string, unknown>, runnerId: string): Reply {
    const fields: Array<{ field: string; code: string }> = [];
    const engines = body.engines;
    if (
      engines !== undefined &&
      (!Array.isArray(engines) ||
        engines.length === 0 ||
        engines.some(
          (e) => e !== "pr-agent" && e !== "opencode" && e !== "implementer",
        ))
    )
      fields.push({ field: "engines", code: "invalid" });
    const features = body.features;
    if (
      features !== undefined &&
      (!Array.isArray(features) || features.some((f) => typeof f !== "string"))
    )
      fields.push({ field: "features", code: "invalid" });
    const jobId = body.jobId;
    if (jobId !== undefined && !(typeof jobId === "string" && UUID.test(jobId)))
      fields.push({ field: "jobId", code: "invalid" });
    const maxRunning = body.maxRunning;
    if (
      maxRunning !== undefined &&
      !(
        typeof maxRunning === "number" &&
        Number.isInteger(maxRunning) &&
        maxRunning >= 1 &&
        maxRunning <= 1000
      )
    )
      fields.push({ field: "maxRunning", code: "invalid" });
    if (fields.length > 0) {
      const reply = errorReply(400);
      (reply.body as { error: Record<string, unknown> }).error.fields = fields;
      return reply;
    }

    const advertised = new Set<string>(
      Array.isArray(engines) ? (engines as string[]) : ["pr-agent"],
    );
    const split =
      Array.isArray(features) && features.includes("worker_credential");
    if (typeof maxRunning === "number") {
      const running = [...jobs.values()].filter(
        (job) => job.status === "running" && job.runnerId === runnerId,
      ).length;
      if (running >= maxRunning) return { status: 204 };
    }
    const job = [...jobs.values()].find(
      (candidate) =>
        candidate.status === "queued" &&
        (jobId === undefined || candidate.id === jobId) &&
        advertised.has(ENGINE_OF_KIND[candidate.reviewKind]),
    );
    if (job === undefined) return { status: 204 };

    job.status = "running";
    job.claims += 1;
    job.leaseLost = false;
    job.superseded = false;
    job.supersedeFeature = false;
    job.leaseEndsAt = null;
    job.runnerId = runnerId;
    job.credential = credentialFor(job.id, job.claims);
    if (split)
      return {
        status: 200,
        body: {
          version: 1,
          job: {
            id: job.id,
            credential: job.credential,
            reviewKind: job.reviewKind,
            leaseExpiresAt: iso(LEASE_SECONDS),
            heartbeatIntervalSeconds: HEARTBEAT_SECONDS,
          },
        },
      };
    return {
      status: 200,
      body: {
        version: 1,
        job: {
          id: job.id,
          leaseToken: `fake-lease-token-${job.claims}`,
          leaseExpiresAt: iso(LEASE_SECONDS),
          heartbeatIntervalSeconds: HEARTBEAT_SECONDS,
          tokenExpiresAt: exampleJob.tokenExpiresAt,
          input: job.input,
        },
      },
    };
  }

  function handleRelease(jobId: string, body: Record<string, unknown>): Reply {
    const job = jobs.get(jobId);
    if (job === undefined) return errorReply(404);
    if (
      job.credential === null ||
      body.credential !== job.credential ||
      typeof body.reason !== "string"
    )
      return errorReply(401, "WORKER_CREDENTIAL_INVALID");
    // Like the App: a job that has its result is not given back, and its result stands (#375).
    if (job.status === "succeeded" || job.status === "failed")
      return errorReply(409, "RUNNER_JOB_ENDED");
    const status = requeue(job);
    return { status: 200, body: { version: 1, job: { id: job.id, status } } };
  }

  /** #493: like the App: the dispatcher token and the credential of the running claim, a closed body, the first report wins. */
  function handleVm(jobId: string, body: Record<string, unknown>): Reply {
    const job = jobs.get(jobId);
    if (job === undefined) return errorReply(404);
    const known = ["credential", "vmName", "startedAt", "timeoutSeconds"];
    if (
      Object.keys(body).some((key) => !known.includes(key)) ||
      typeof body.vmName !== "string" ||
      typeof body.startedAt !== "string" ||
      typeof body.timeoutSeconds !== "number"
    )
      return errorReply(400);
    if (job.credential === null || body.credential !== job.credential)
      return errorReply(401, "WORKER_CREDENTIAL_INVALID");
    if (job.status !== "running") return errorReply(409, "RUNNER_JOB_ENDED");
    const replayed = job.vms.some((vm) => vm.vmName === body.vmName);
    if (!replayed)
      job.vms.push({
        vmName: body.vmName,
        startedAt: body.startedAt,
        timeoutSeconds: body.timeoutSeconds,
      });
    return {
      status: 200,
      body: { version: 1, status: replayed ? "replayed" : "recorded" },
    };
  }

  function handleJobState(jobId: string): Reply {
    const job = jobs.get(jobId);
    if (job === undefined) return errorReply(404);
    return {
      status: 200,
      body: { version: 1, job: { id: job.id, status: job.status } },
    };
  }

  function workerJob(
    jobId: string,
    credential: string | null,
  ): JobState | Reply {
    const job = jobs.get(jobId);
    // The same answer for an unknown job and a wrong credential: it says nothing about which jobs exist.
    if (
      job === undefined ||
      credential === null ||
      job.credential === null ||
      credential !== job.credential
    )
      return errorReply(401, "WORKER_CREDENTIAL_INVALID");
    if (job.leaseLost) return errorReply(409, "RUNNER_LEASE_LOST");
    return job;
  }

  function handleDetails(job: JobState, features: string[]): Reply {
    const input = structuredClone(job.input);
    const dynamic = input.dynamic as Record<string, unknown> | undefined;
    // An optional job field reaches only a Worker that names the feature (the input is closed).
    if (dynamic !== undefined && !features.includes("dynamic_capabilities"))
      delete dynamic.capabilities;
    job.supersedeFeature = features.includes("supersede");
    return {
      status: 200,
      body: {
        version: 1,
        job: {
          id: job.id,
          leaseExpiresAt: iso(LEASE_SECONDS),
          heartbeatIntervalSeconds: HEARTBEAT_SECONDS,
          tokenExpiresAt: exampleJob.tokenExpiresAt,
          input,
        },
      },
    };
  }

  function handleResult(job: JobState, body: Record<string, unknown>): Reply {
    const result = body.result;
    if (
      typeof result !== "object" ||
      result === null ||
      typeof (result as Record<string, unknown>).ok !== "boolean"
    )
      return errorReply(400);
    const stored = result as Record<string, unknown>;
    if (
      job.status === "succeeded" ||
      job.status === "failed" ||
      (job.status === "superseded" && job.results.length > 0)
    ) {
      const same = JSON.stringify(job.results[0]) === JSON.stringify(stored);
      return same
        ? {
            status: 200,
            body: {
              version: 1,
              job: { id: job.id, status: job.status },
              alreadyCompleted: true,
            },
          }
        : errorReply(409, "RUNNER_RESULT_CONFLICT");
    }
    if (SHUTDOWN_CODES.includes(String(stored.errorCode))) {
      const status = requeue(job);
      return {
        status: 200,
        body: {
          version: 1,
          job: { id: job.id, status },
          alreadyCompleted: false,
        },
      };
    }
    // A run the App superseded (and whose holder was told) keeps its status: the report is taken once (#397).
    const supersededRun = job.superseded && job.supersedeFeature;
    job.results.push(stored);
    job.status = supersededRun
      ? "superseded"
      : stored.ok === true
        ? "succeeded"
        : "failed";
    return {
      status: 200,
      body: {
        version: 1,
        job: { id: job.id, status: job.status },
        alreadyCompleted: false,
      },
    };
  }

  /** What one request does, before the script's reaction is applied. Returns the route for the log. */
  async function dispatch(
    request: IncomingMessage,
    url: URL,
  ): Promise<{ route: Route | null; jobId: string | null; reply: Reply }> {
    const method = request.method ?? "GET";
    const path = url.pathname;
    const none = (reply: Reply) => ({ route: null, jobId: null, reply });
    const runnerMatch =
      /^\/api\/runners\/v1\/(claim|version|jobs\/([^/]+)\/(?:release|vm)|jobs\/([^/]+))$/.exec(
        path,
      );
    const workerMatch =
      /^\/api\/workers\/v1\/jobs\/([^/]+)(?:\/(heartbeat|result))?$/.exec(path);
    if (runnerMatch === null && workerMatch === null)
      return none(errorReply(404));

    const credential = bearer(request);
    if (runnerMatch !== null) {
      const name = runnerMatch[1] ?? "";
      const stateJob = runnerMatch[3] ?? null;
      const route: Route =
        stateJob !== null
          ? "job_state"
          : name.endsWith("/vm")
            ? "vm"
            : name.startsWith("jobs/")
              ? "release"
              : (name as Route);
      const jobId = stateJob ?? runnerMatch[2] ?? null;
      const expectedMethod =
        route === "version" || route === "job_state" ? "GET" : "POST";
      if (method !== expectedMethod)
        return { route, jobId, reply: errorReply(404) };
      if (route === "version" && credential !== dispatcherToken) {
        // #322: a Worker may send its job credential, together with the id of its job.
        const named = url.searchParams.get("jobId");
        const held = named === null ? undefined : jobs.get(named);
        if (
          held === undefined ||
          credential === null ||
          held.credential === null ||
          credential !== held.credential
        )
          return {
            route,
            jobId: named,
            reply: errorReply(401, "RUNNER_UNAUTHORIZED"),
          };
        const scripted = await applyScript(route);
        return {
          route,
          jobId: named,
          reply: scripted ?? {
            status: 200,
            body: { ...versionExample, appVersion },
          },
        };
      }
      if (credential !== dispatcherToken)
        return { route, jobId, reply: errorReply(401, "RUNNER_UNAUTHORIZED") };
      const runnerId = String(request.headers["x-runner-id"] ?? "default");
      const step = await applyScript(route);
      if (step !== null) return { route, jobId, reply: step };
      if (route === "version")
        return {
          route,
          jobId,
          reply: {
            status: 200,
            body: { ...versionExample, appVersion },
          },
        };
      if (route === "job_state")
        return { route, jobId, reply: handleJobState(jobId ?? "") };
      const raw = await readBody(request);
      if (raw === "too_large") return { route, jobId, reply: errorReply(413) };
      const body = parseObject(raw.text);
      if (body === null) return { route, jobId, reply: errorReply(400) };
      return {
        route,
        jobId,
        reply:
          route === "claim"
            ? handleClaim(body, runnerId)
            : route === "vm"
              ? handleVm(jobId ?? "", body)
              : handleRelease(jobId ?? "", body),
      };
    }

    const jobId = workerMatch?.[1] ?? "";
    const suffix = workerMatch?.[2];
    const route: Route = suffix === undefined ? "job" : (suffix as Route);
    const expectedMethod = route === "job" ? "GET" : "POST";
    if (method !== expectedMethod)
      return { route, jobId, reply: errorReply(404) };
    const job = workerJob(jobId, credential);
    if (!("id" in job)) return { route, jobId, reply: job };
    const step = await applyScript(route);
    if (step !== null) return { route, jobId, reply: step };
    if (route === "job") {
      const features = (url.searchParams.get("features") ?? "")
        .split(",")
        .filter((name) => name !== "");
      return { route, jobId, reply: handleDetails(job, features) };
    }
    const raw = await readBody(request);
    if (raw === "too_large") return { route, jobId, reply: errorReply(413) };
    const body = parseObject(raw.text);
    if (body === null) return { route, jobId, reply: errorReply(400) };
    if (route === "heartbeat") {
      const superseded = job.superseded && job.supersedeFeature;
      return {
        route,
        jobId,
        reply: {
          status: 200,
          body: {
            version: 1,
            job: {
              id: job.id,
              heartbeatAt: iso(),
              // A superseded run's lease is not extended: the drain ends before it (#396).
              leaseExpiresAt:
                superseded && job.leaseEndsAt !== null
                  ? job.leaseEndsAt
                  : iso(LEASE_SECONDS),
              ...(superseded ? { superseded: true } : {}),
            },
          },
        },
      };
    }
    return { route, jobId, reply: handleResult(job, body) };
  }

  /** The reaction scripted for the next request of the route: null to go on handling it normally. */
  async function applyScript(route: Route): Promise<Reply | null> {
    const step = scripts.get(route)?.shift();
    if (step === undefined) return null;
    if (step.delayMs !== undefined) await sleep(step.delayMs);
    if (step.status === undefined) return null;
    const reply = errorReply(step.status, undefined, step.retryAfterSeconds);
    if (step.body !== undefined) reply.body = step.body;
    if (step.status < 400 && step.body === undefined) delete reply.body;
    return reply;
  }

  function send(response: ServerResponse, reply: Reply): void {
    const headers: Record<string, string> = { "cache-control": "no-store" };
    if (reply.retryAfterSeconds !== undefined)
      headers["retry-after"] = String(reply.retryAfterSeconds);
    if (reply.body === undefined) {
      response.writeHead(reply.status, headers);
      response.end();
      return;
    }
    headers["content-type"] = "application/json";
    response.writeHead(reply.status, headers);
    response.end(JSON.stringify(reply.body));
  }

  async function control(request: IncomingMessage, url: URL): Promise<Reply> {
    const name = url.pathname.slice("/__fake/".length);
    const method = request.method ?? "GET";
    if (name === "health" && method === "GET")
      return { status: 200, body: { ok: true } };
    if (name === "requests" && method === "GET")
      return { status: 200, body: log };
    if (name === "results" && method === "GET") {
      const jobId = url.searchParams.get("jobId");
      const found = [...jobs.values()]
        .filter((job) => jobId === null || job.id === jobId)
        .flatMap((job) => job.results);
      return { status: 200, body: found };
    }
    if (method !== "POST") return errorReply(404);
    const raw = await readBody(request);
    const body = raw === "too_large" ? null : parseObject(raw.text);
    if (body === null) return errorReply(400);
    if (name === "reset") {
      fake.reset();
      return { status: 200, body: { ok: true } };
    }
    if (name === "enqueue") {
      const kind = body.reviewKind;
      const id = enqueue({
        id: typeof body.id === "string" ? body.id : undefined,
        reviewKind:
          kind === "dynamic" || kind === "implementer" ? kind : "diff",
      });
      return { status: 200, body: { id } };
    }
    if (name === "script") {
      const route = body.route;
      if (!ROUTES.includes(route as Route) || !Array.isArray(body.steps))
        return errorReply(400);
      fake.script(route as Route, body.steps as Step[]);
      return { status: 200, body: { ok: true } };
    }
    if (
      name === "job-status" &&
      typeof body.jobId === "string" &&
      JOB_STATUSES.includes(body.status as JobStatus)
    ) {
      fake.setJobStatus(body.jobId, body.status as JobStatus);
      return { status: 200, body: { ok: true } };
    }
    if (name === "supersede" && typeof body.jobId === "string") {
      fake.supersede(body.jobId);
      return { status: 200, body: { ok: true } };
    }
    if (name === "lose-lease" && typeof body.jobId === "string") {
      fake.loseLease(body.jobId);
      return { status: 200, body: { ok: true } };
    }
    return errorReply(404);
  }

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname.startsWith("/__fake/")) {
        send(response, await control(request, url));
        return;
      }
      const { route, jobId, reply } = await dispatch(request, url);
      if (route !== null)
        log.push({
          method: request.method ?? "GET",
          route,
          jobId,
          status: reply.status,
        });
      send(response, reply);
    })().catch(() => {
      send(response, errorReply(500));
    });
  });

  const fake: DispatcherAppFake = {
    url: "",
    enqueue,
    script(route, steps) {
      scripts.set(route, [...(scripts.get(route) ?? []), ...steps]);
    },
    loseLease(jobId) {
      const job = jobs.get(jobId);
      if (job !== undefined) job.leaseLost = true;
    },
    supersede(jobId) {
      const job = jobs.get(jobId);
      if (job === undefined) return;
      job.superseded = true;
      job.leaseEndsAt = iso(SUPERSEDED_CLAIM_SECONDS);
    },
    setJobStatus(jobId, status) {
      const job = jobs.get(jobId);
      if (job !== undefined) job.status = status;
    },
    results(jobId) {
      return structuredClone(jobs.get(jobId)?.results ?? []);
    },
    vms(jobId) {
      return structuredClone(jobs.get(jobId)?.vms ?? []);
    },
    requests() {
      return structuredClone(log);
    },
    reset() {
      jobs.clear();
      scripts.clear();
      log = [];
      counter = 0;
    },
    close() {
      return new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      });
    },
  };

  keepConnectionsOpen(server);
  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve),
  );
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("The fake App did not get a TCP address.");
  fake.url = `http://${options.host ?? "127.0.0.1"}:${address.port}`;
  return fake;
}
