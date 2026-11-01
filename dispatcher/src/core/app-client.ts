// SPDX-License-Identifier: LicenseRef-Proprietary

// The Dispatcher's calls to the App: the Dispatcher API (claim, release, version under /api/runners/v1,
// with the dispatcher credential) and the heartbeat of the Worker API (with the per-job credential).
// Every answer is read against the shapes of contracts/runner-api.v1.json; an answer of another shape,
// such as a previous release's legacy claim with a job input and a git token, is refused unread.
import { z } from "zod";
import type {
  KnownClaimFeature,
  KnownReleaseReason,
} from "../contracts/runner-api.ts";
import { CONTRACT_REVIEW_KINDS, type WireReviewKind } from "./types.ts";

/** The features of the App the split needs (`VersionResponse.features`). */
export const REQUIRED_APP_FEATURES = [
  "worker_api",
  "claim_by_job_id",
  "pool_cap",
  "release",
] as const;

/** #493: the feature of the App that has the call by which the Dispatcher reports the VM it created. */
export const VM_LIFECYCLE_FEATURE = "vm_lifecycle";

/**
 * What a claim of the Dispatcher names (`KnownClaimFeature`): the split answer, and (#498) that it reports the VM it creates,
 * so the App can tell a Dispatcher that measures billable minutes from one that does not before billing is switched on.
 */
const CLAIM_FEATURES: KnownClaimFeature[] = [
  "worker_credential",
  VM_LIFECYCLE_FEATURE,
];

export type ClaimedJob = {
  id: string;
  credential: string;
  reviewKind: WireReviewKind;
  heartbeatIntervalSeconds: number;
};

export type ClaimResult =
  | { kind: "claimed"; job: ClaimedJob }
  | { kind: "none" }
  | { kind: "busy"; retryAfterSeconds?: number }
  | { kind: "unavailable"; code: AppFailure; retryAfterSeconds?: number };

/** Stable codes for why a call to the App did not work; they are logged, never the App's own text. */
export const APP_FAILURES = [
  "app_unreachable",
  "app_error",
  "app_rejected",
  "app_too_old",
  "app_answer_invalid",
] as const;
export type AppFailure = (typeof APP_FAILURES)[number];

/** The statuses of a job in the App (`JobStateResponse`). A status not in this list is read as unknown. */
export const JOB_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "superseded",
  "cancelled",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** What the App said about a job. `unreadable` is every other case: no answer, a refusal, an App without the call. */
export type JobStateResult =
  | {
      kind: "known";
      status: JobStatus;
      /**
       * #397: a superseded job whose claim is still valid: its Worker is finishing the model requests in flight and
       * reporting what they cost. Present (true) only then.
       */
      draining?: true;
    }
  | { kind: "unreadable" };

export type HeartbeatResult = "ok" | "lease_lost" | "failed";
/**
 * #493: what the App said to the report of a VM. `recorded`: stored or already known. `transient`: worth repeating (no
 * answer, 429, 5xx). `refused`: the App will not take it (the claim ended, a wrong credential, an old App): not repeated.
 */
export type VmReportResult = "recorded" | "transient" | "refused";
/**
 * `ended`: 409, the job is over for this claim (it has its result, or was cancelled): expected after a Worker that
 * delivered its result and then exited with an error, and a no-op. `not_holder`: 401 or 404, the credential is not
 * the job's claim (a newer claim, a made-up one) or the job is unknown.
 */
export type ReleaseResult = "released" | "ended" | "not_holder" | "failed";
/** Why the core gives a job back: the Worker did not start (`launch_failed`), or it ended with an error after it did. */
export type ReleaseReason = KnownReleaseReason;

const splitClaim = z.object({
  version: z.literal(1),
  job: z.object({
    id: z.string().regex(/^[0-9a-fA-F-]{36}$/),
    credential: z.string().regex(/^crj_[A-Za-z0-9_-]{43}$/),
    reviewKind: z.enum(CONTRACT_REVIEW_KINDS),
    leaseExpiresAt: z.string(),
    heartbeatIntervalSeconds: z.number().int().min(1).max(3600),
  }),
});

/** The claim answer of the split, or null for anything else (the legacy answer included). */
export function parseSplitClaim(body: unknown): ClaimedJob | null {
  const parsed = splitClaim.safeParse(body);
  if (!parsed.success) return null;
  const { id, credential, reviewKind, heartbeatIntervalSeconds } =
    parsed.data.job;
  return { id, credential, reviewKind, heartbeatIntervalSeconds };
}

const jobStateAnswer = z.object({
  version: z.literal(1),
  job: z.object({
    id: z.string(),
    status: z.enum(JOB_STATUSES),
    draining: z.boolean().optional(),
  }),
});

const versionAnswer = z.object({
  version: z.literal(1),
  features: z.array(z.string()),
});

export type AppClientOptions = {
  appUrl: string;
  token: string;
  poolId: string;
  fetch: typeof fetch;
  /** Per request; the claim happens while the sender of the wake-up call waits, so it is short. */
  requestTimeoutMs?: number;
};

export type ClaimRequestBody = {
  engines: readonly string[];
  jobId?: string;
  maxRunning: number;
};

const DEFAULT_TIMEOUT_MS = 5000;

function retryAfterOf(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (header === null || !/^\d{1,6}$/.test(header)) return undefined;
  return Number(header);
}

export function createAppClient(options: AppClientOptions) {
  const timeout = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = options.appUrl.replace(/\/+$/, "");

  async function send(
    path: string,
    init: {
      method: "GET" | "POST";
      bearer: string;
      body?: unknown;
      runnerId?: boolean;
    },
  ): Promise<Response | null> {
    try {
      return await options.fetch(`${base}${path}`, {
        method: init.method,
        headers: {
          authorization: `Bearer ${init.bearer}`,
          accept: "application/json",
          ...(init.body === undefined
            ? {}
            : { "content-type": "application/json" }),
          ...(init.runnerId === true ? { "x-runner-id": options.poolId } : {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        redirect: "error",
        signal: AbortSignal.timeout(timeout),
      });
    } catch {
      return null;
    }
  }

  type Failure = Extract<ClaimResult, { kind: "busy" | "unavailable" }>;
  function failure(response: Response | null): Failure {
    if (response === null)
      return { kind: "unavailable", code: "app_unreachable" };
    const retryAfterSeconds = retryAfterOf(response);
    if (response.status === 429) return { kind: "busy", retryAfterSeconds };
    if (response.status >= 500)
      return { kind: "unavailable", code: "app_error", retryAfterSeconds };
    return { kind: "unavailable", code: "app_rejected" };
  }

  return {
    /** Does the App have what the split needs? An App without the version route is a previous release. */
    async checkVersion(): Promise<
      | { ok: true; features: readonly string[] }
      | {
          ok: false;
          code: AppFailure;
          retryAfterSeconds?: number;
          /** #730: with `app_too_old` because of the answer, the features of the split that it lacks. */
          missingFeatures?: string[];
        }
    > {
      const response = await send("/api/runners/v1/version", {
        method: "GET",
        bearer: options.token,
      });
      if (response === null) return { ok: false, code: "app_unreachable" };
      if (response.status === 404) return { ok: false, code: "app_too_old" };
      if (response.status !== 200) {
        const failed = failure(response);
        return {
          ok: false,
          code: failed.kind === "unavailable" ? failed.code : "app_error",
          retryAfterSeconds: failed.retryAfterSeconds,
        };
      }
      const parsed = versionAnswer.safeParse(
        await response.json().catch(() => null),
      );
      if (!parsed.success) return { ok: false, code: "app_answer_invalid" };
      const missing = REQUIRED_APP_FEATURES.filter(
        (feature) => !parsed.data.features.includes(feature),
      );
      return missing.length === 0
        ? { ok: true, features: parsed.data.features }
        : { ok: false, code: "app_too_old", missingFeatures: [...missing] };
    },

    /**
     * The status of a job (`GET /jobs/{id}`, #364). Anything but a valid answer for this very job is `unreadable`:
     * an App of a previous release has no such route, and a caller that cannot read the state must not act on it.
     */
    async jobState(jobId: string): Promise<JobStateResult> {
      const response = await send(
        `/api/runners/v1/jobs/${encodeURIComponent(jobId)}`,
        { method: "GET", bearer: options.token },
      );
      if (response === null || response.status !== 200)
        return { kind: "unreadable" };
      const parsed = jobStateAnswer.safeParse(
        await response.json().catch(() => null),
      );
      if (!parsed.success || parsed.data.job.id !== jobId)
        return { kind: "unreadable" };
      return {
        kind: "known",
        status: parsed.data.job.status,
        ...(parsed.data.job.draining === true
          ? { draining: true as const }
          : {}),
      };
    },

    async claim(body: ClaimRequestBody): Promise<ClaimResult> {
      const response = await send("/api/runners/v1/claim", {
        method: "POST",
        bearer: options.token,
        runnerId: true,
        body: { ...body, features: CLAIM_FEATURES },
      });
      if (
        response === null ||
        (response.status !== 200 && response.status !== 204)
      )
        return failure(response);
      if (response.status === 204) return { kind: "none" };
      const job = parseSplitClaim(await response.json().catch(() => null));
      // An answer that is not the split one is never read further: it may hold a job input and a git token.
      if (job === null)
        return { kind: "unavailable", code: "app_answer_invalid" };
      return { kind: "claimed", job };
    },

    async heartbeat(
      jobId: string,
      credential: string,
    ): Promise<HeartbeatResult> {
      const response = await send(
        `/api/workers/v1/jobs/${encodeURIComponent(jobId)}/heartbeat`,
        {
          method: "POST",
          bearer: credential,
          body: {},
        },
      );
      if (response === null) return "failed";
      if (response.status === 200) return "ok";
      // The credential is no longer the job's, the lease is gone or the App ended the job: nothing to keep alive.
      if ([401, 404, 409].includes(response.status)) return "lease_lost";
      return "failed";
    },

    /**
     * #493: tells the App that this VM was created for the claim the credential holds (`VmStartRequest`). The answer is
     * reduced to what decides a repeat; its body is never read.
     */
    async reportVm(
      jobId: string,
      credential: string,
      vm: { name: string; startedAt: Date; timeoutSeconds: number },
    ): Promise<VmReportResult> {
      const response = await send(
        `/api/runners/v1/jobs/${encodeURIComponent(jobId)}/vm`,
        {
          method: "POST",
          bearer: options.token,
          body: {
            credential,
            vmName: vm.name,
            startedAt: vm.startedAt.toISOString(),
            timeoutSeconds: vm.timeoutSeconds,
          },
        },
      );
      if (response === null) return "transient";
      void response.body?.cancel().catch(() => undefined);
      if (response.status === 200) return "recorded";
      if (response.status === 429 || response.status >= 500) return "transient";
      return "refused";
    },

    async release(
      jobId: string,
      credential: string,
      reason: ReleaseReason,
      retryAfterSeconds: number,
    ): Promise<ReleaseResult> {
      const response = await send(
        `/api/runners/v1/jobs/${encodeURIComponent(jobId)}/release`,
        {
          method: "POST",
          bearer: options.token,
          body: { credential, reason, retryAfterSeconds },
        },
      );
      if (response === null) return "failed";
      if (response.status === 200) return "released";
      if (response.status === 409) return "ended";
      if ([401, 404].includes(response.status)) return "not_holder";
      return "failed";
    },
  };
}

export type AppClient = ReturnType<typeof createAppClient>;
