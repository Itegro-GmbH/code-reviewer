// SPDX-License-Identifier: LicenseRef-Proprietary

// The checks on what a runner sends. Written by hand (no schema library at run time), and kept in
// line with contracts/runner-api.v1.json by the compatibility test, which runs a set of good and bad
// bodies through both and requires the same verdict. A refusal lists fields and reasons, never
// values: the bodies of these requests hold a lease token and a log.
import type {
  StoppedEarly,
  ClaimEngine,
  ClaimFeature,
  ClaimRequest,
  CompleteRequest,
  FieldError,
  FieldErrorCode,
  HeartbeatRequest,
  ReleaseRequest,
  VmStartRequest,
  FindingPriority,
  ImplementerResult,
  ReviewFindings,
  RunnerResult,
  RunnerUsage,
  WorkerResultRequest,
} from "./contract.ts";
import {
  CLAIM_ENGINES,
  CLAIM_FEATURES,
  DEFAULT_LLM_PROVIDERS,
  FINDING_PRIORITIES,
  IMPLEMENTER_FILE_STATUSES,
  IMPLEMENTER_RESULT_LIMITS,
  LLM_PROVIDER_ID_PATTERN,
  MAX_FINDING_COUNT,
  MAX_LLM_PROVIDERS,
  MAX_RUNNING_RANGE,
  RELEASE_RETRY_AFTER_RANGE,
  STOPPED_EARLY_REASONS,
  VM_NAME_PATTERN,
  VM_STARTED_AT_PATTERN,
  VM_TIMEOUT_SECONDS_RANGE,
} from "./contract.ts";
import { WORKER_CREDENTIAL_PATTERN } from "../jobs/worker-credential.ts";
import { checkCallTrace } from "./call-trace.ts";

export type Parsed<T> =
  { ok: true; value: T } | { ok: false; fields: FieldError[] };

/**
 * A result a runner or a Worker reported. `dropped` names the observability fields that were left out
 * because they were malformed (#541), by field path and never with a value: the rest of the result is
 * accepted, so the caller logs the note and goes on.
 */
export type ParsedResult<T> =
  | { ok: true; value: T; dropped: string[] }
  | { ok: false; fields: FieldError[] };

const JOB_ID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const RUNNER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/** The id used when a runner sends no `X-Runner-Id`; the id is for bookkeeping only. */
export const UNKNOWN_RUNNER_ID = "unknown";

export const LEASE_TOKEN_LENGTH = { min: 8, max: 256 } as const;
export const MAX_LOG_TAIL_CHARS = 8192;
export const MAX_ERROR_MESSAGE_CHARS = 2000;
export const MAX_ERROR_REASON_CHARS = 64;
export const MAX_COMMENT_URL_CHARS = 2048;
export const MAX_DURATION_MS = 604_800_000;
const MAX_MODEL_CHARS = 200;

export function parseJobId(value: string): boolean {
  return JOB_ID.test(value);
}

/** The runner id of the `X-Runner-Id` header (null when it is absent). */
export function parseRunnerId(header: string | null): Parsed<string> {
  if (header === null) return { ok: true, value: UNKNOWN_RUNNER_ID };
  if (!RUNNER_ID.test(header))
    return { ok: false, fields: [{ field: "X-Runner-Id", code: "invalid" }] };
  return { ok: true, value: header };
}

type Record_ = Record<string, unknown>;

/** The length JSON Schema counts: characters (code points), not UTF-16 units. */
function lengthOf(value: string): number {
  return [...value].length;
}

function isRecord(value: unknown): value is Record_ {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// C0 controls other than tab, line feed and carriage return, and DEL. A NUL is refused by a Postgres text column, and none of
// these is text a person reads in a summary, a commit subject, a path or an id.
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** The text without its control characters (tab, line feed and carriage return stay). */
export function withoutControlCharacters(text: string): string {
  return text.replace(CONTROL_CHARACTERS, "");
}

/** Collects the refusals of one body while its fields are checked. */
class Checker {
  readonly fields: FieldError[] = [];
  /** Fields that were malformed and left out, not refused: observability the result does without. */
  readonly dropped: string[] = [];

  fail(field: string, code: FieldErrorCode): undefined {
    this.fields.push({ field, code });
    return undefined;
  }

  /**
   * `stripControls`: control characters are taken out of the text (see `withoutControlCharacters`). The maximum is judged on what
   * was sent, like the contract does, the minimum on what is left.
   */
  string(
    source: Record_,
    key: string,
    field: string,
    options: { min?: number; max: number; stripControls?: boolean },
  ): string | undefined {
    const value = source[key];
    if (value === undefined) return this.fail(field, "required");
    if (typeof value !== "string") return this.fail(field, "invalid");
    if (lengthOf(value) > options.max) return this.fail(field, "too_long");
    const text =
      options.stripControls === true ? withoutControlCharacters(value) : value;
    if (lengthOf(text) < (options.min ?? 0)) return this.fail(field, "invalid");
    return text;
  }

  /** A string that may be null or left out; `fallback` is what a missing value becomes. */
  optionalString(
    source: Record_,
    key: string,
    field: string,
    max: number,
  ): string | null | undefined {
    const value = source[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") return this.fail(field, "invalid");
    if (lengthOf(value) > max) return this.fail(field, "too_long");
    return value;
  }

  integer(
    source: Record_,
    key: string,
    field: string,
    max = Number.MAX_SAFE_INTEGER,
  ): number | undefined {
    const value = source[key];
    if (value === undefined) return this.fail(field, "required");
    if (
      !Number.isInteger(value) ||
      (value as number) < 0 ||
      (value as number) > max
    )
      return this.fail(field, "invalid");
    return value as number;
  }
}

function leaseTokenOf(check: Checker, body: Record_): string | undefined {
  return check.string(body, "leaseToken", "leaseToken", {
    min: LEASE_TOKEN_LENGTH.min,
    max: LEASE_TOKEN_LENGTH.max,
  });
}

/**
 * The optional claim body (#195): `{ engines: [...] }`. An absent or empty body is a previous-release
 * runner and means `pr-agent` only; the caller fills that in. `engines` must hold known, unique
 * engine names; unknown or duplicated ones are refused before anything is claimed, so a runner
 * cannot talk itself into a job it cannot run.
 */
export function parseClaimRequest(body: unknown): Parsed<ClaimRequest> {
  if (body === undefined) return { ok: true, value: {} };
  if (!isRecord(body))
    return { ok: false, fields: [{ field: "body", code: "invalid" }] };
  const check = new Checker();
  const raw = body.engines;
  let engines: ClaimEngine[] | undefined;
  if (raw === undefined) {
    engines = undefined;
  } else if (!Array.isArray(raw)) {
    check.fail("engines", "invalid");
  } else {
    const seen = new Set<string>();
    const accepted: ClaimEngine[] = [];
    if (raw.length === 0) check.fail("engines", "invalid");
    for (const entry of raw) {
      if (
        typeof entry !== "string" ||
        !CLAIM_ENGINES.some((known) => known === entry)
      ) {
        check.fail("engines", "invalid");
        continue;
      }
      if (seen.has(entry)) {
        check.fail("engines", "invalid");
        continue;
      }
      seen.add(entry);
      accepted.push(entry as ClaimEngine);
    }
    if (check.fields.length === 0) engines = accepted;
  }
  const features = parseFeatures(check, body.features);
  const llmProviders = parseLlmProviders(check, body.llmProviders);
  const jobId = parseClaimJobId(check, body.jobId);
  const maxRunning = parseMaxRunning(check, body.maxRunning);
  if (check.fields.length > 0) return { ok: false, fields: check.fields };
  return {
    ok: true,
    value: {
      ...(engines === undefined ? {} : { engines }),
      ...(features === undefined ? {} : { features }),
      ...(llmProviders === undefined ? {} : { llmProviders }),
      ...(jobId === undefined ? {} : { jobId }),
      ...(maxRunning === undefined ? {} : { maxRunning }),
    },
  };
}

/** #322: the job a Dispatcher wants; absent means the next due job. A present value must be a UUID. */
function parseClaimJobId(check: Checker, raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !JOB_ID.test(raw))
    return check.fail("jobId", "invalid");
  return raw;
}

/** #322: the pool cap; an integer from 1 to 1000. 0 is refused: a cap of 0 would refuse every claim. */
function parseMaxRunning(check: Checker, raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw < MAX_RUNNING_RANGE.min ||
    raw > MAX_RUNNING_RANGE.max
  )
    return check.fail("maxRunning", "invalid");
  return raw;
}

const FEATURE_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_FEATURES = 16;

/**
 * #279: what else the runner understands. Only the names this app knows are kept; an unknown one is
 * ignored, so a newer runner can name features an older app has never heard of. A list that is not a
 * list of plain names is refused like the contract does.
 */
function parseFeatures(
  check: Checker,
  raw: unknown,
): ClaimFeature[] | undefined {
  if (raw === undefined) return undefined;
  if (
    !Array.isArray(raw) ||
    raw.length > MAX_FEATURES ||
    !raw.every((entry) => typeof entry === "string" && FEATURE_NAME.test(entry))
  )
    return check.fail("features", "invalid");
  return CLAIM_FEATURES.filter((known) => raw.includes(known));
}

/**
 * #424: the LLM providers a runner can run. A list of slugs of the contract's form, at least one, no
 * duplicate, at most `MAX_LLM_PROVIDERS`; refused like the contract refuses it. A slug this app has no
 * adapter for is kept (a newer runner may know more than this app); deciding what to do with it is
 * the claim's business.
 */
function parseLlmProviders(check: Checker, raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.length > MAX_LLM_PROVIDERS ||
    !raw.every(
      (entry) =>
        typeof entry === "string" && LLM_PROVIDER_ID_PATTERN.test(entry),
    ) ||
    new Set(raw).size !== raw.length
  )
    return check.fail("llmProviders", "invalid");
  return [...(raw as string[])];
}

/**
 * #424: the providers a caller can run: what it advertised, or `DEFAULT_LLM_PROVIDERS`, which is all a
 * previous-release caller can run.
 */
export function callerLlmProviders(
  advertised: readonly string[] | undefined,
): readonly string[] {
  return advertised ?? DEFAULT_LLM_PROVIDERS;
}

/**
 * #424: the providers named in the `llmProviders` query parameter of the Worker's details call, a comma
 * separated list. Names that are no slugs are ignored (like unknown features), so a malformed value
 * never fails the call; `undefined` means the Worker named none, which `callerLlmProviders` reads as the default of an unlisted caller.
 */
export function parseWorkerLlmProviders(
  raw: string | null,
): string[] | undefined {
  if (raw === null) return undefined;
  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => LLM_PROVIDER_ID_PATTERN.test(name));
  const unique = [...new Set(names)].slice(0, MAX_LLM_PROVIDERS);
  return unique.length === 0 ? undefined : unique;
}

/**
 * #322: the body of the release. The credential is checked for its form only; it is never part of a
 * refusal, which names fields and reasons. Any reason of the right form is accepted: the app maps one it
 * does not know to `launch_failed` (it is stored as the error code of a job that fails).
 */
export function parseReleaseRequest(body: unknown): Parsed<ReleaseRequest> {
  if (!isRecord(body))
    return { ok: false, fields: [{ field: "body", code: "invalid" }] };
  const check = new Checker();
  const credential = body.credential;
  if (credential === undefined) check.fail("credential", "required");
  else if (
    typeof credential !== "string" ||
    !WORKER_CREDENTIAL_PATTERN.test(credential)
  )
    check.fail("credential", "invalid");
  const reason = body.reason;
  if (reason === undefined) check.fail("reason", "required");
  else if (typeof reason !== "string" || !ERROR_CODE.test(reason))
    check.fail("reason", "invalid");
  const retryAfter = body.retryAfterSeconds;
  if (
    retryAfter !== undefined &&
    (typeof retryAfter !== "number" ||
      !Number.isInteger(retryAfter) ||
      retryAfter < RELEASE_RETRY_AFTER_RANGE.min ||
      retryAfter > RELEASE_RETRY_AFTER_RANGE.max)
  )
    check.fail("retryAfterSeconds", "invalid");
  if (check.fields.length > 0) return { ok: false, fields: check.fields };
  return {
    ok: true,
    value: {
      credential: credential as string,
      reason: reason as string,
      ...(retryAfter === undefined
        ? {}
        : { retryAfterSeconds: retryAfter as number }),
    },
  };
}

const VM_START_FIELDS = [
  "credential",
  "vmName",
  "startedAt",
  "timeoutSeconds",
] as const;

/**
 * #493: the body of the report of a VM start. Closed: a field that is not listed is refused (by name, never by value), so
 * a Dispatcher cannot slip anything else through. The credential is checked for its form only and is never part of a
 * refusal.
 */
export function parseVmStartRequest(body: unknown): Parsed<VmStartRequest> {
  if (!isRecord(body))
    return { ok: false, fields: [{ field: "body", code: "invalid" }] };
  const check = new Checker();
  for (const key of Object.keys(body))
    if (!(VM_START_FIELDS as readonly string[]).includes(key))
      check.fail("body", "invalid");
  const credential = body.credential;
  if (credential === undefined) check.fail("credential", "required");
  else if (
    typeof credential !== "string" ||
    !WORKER_CREDENTIAL_PATTERN.test(credential)
  )
    check.fail("credential", "invalid");
  const vmName = body.vmName;
  if (vmName === undefined) check.fail("vmName", "required");
  else if (typeof vmName !== "string" || !VM_NAME_PATTERN.test(vmName))
    check.fail("vmName", "invalid");
  const startedAt = body.startedAt;
  if (startedAt === undefined) check.fail("startedAt", "required");
  else if (
    typeof startedAt !== "string" ||
    !VM_STARTED_AT_PATTERN.test(startedAt) ||
    Number.isNaN(Date.parse(startedAt))
  )
    check.fail("startedAt", "invalid");
  const timeout = body.timeoutSeconds;
  if (timeout === undefined) check.fail("timeoutSeconds", "required");
  else if (
    typeof timeout !== "number" ||
    !Number.isInteger(timeout) ||
    timeout < VM_TIMEOUT_SECONDS_RANGE.min ||
    timeout > VM_TIMEOUT_SECONDS_RANGE.max
  )
    check.fail("timeoutSeconds", "invalid");
  if (check.fields.length > 0) return { ok: false, fields: check.fields };
  return {
    ok: true,
    value: {
      credential: credential as string,
      vmName: vmName as string,
      startedAt: startedAt as string,
      timeoutSeconds: timeout as number,
    },
  };
}

export function parseHeartbeatRequest(body: unknown): Parsed<HeartbeatRequest> {
  if (!isRecord(body))
    return { ok: false, fields: [{ field: "body", code: "invalid" }] };
  const check = new Checker();
  const leaseToken = leaseTokenOf(check, body);
  if (check.fields.length > 0 || leaseToken === undefined)
    return { ok: false, fields: check.fields };
  return { ok: true, value: { leaseToken } };
}

function parseUsage(
  check: Checker,
  value: unknown,
): RunnerUsage | null | undefined {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) return check.fail("result.usage", "invalid");
  const before = check.fields.length;
  const prefix = "result.usage.";
  const model =
    value.model === null
      ? null
      : check.string(value, "model", `${prefix}model`, {
          max: MAX_MODEL_CHARS,
        });
  const promptTokens = check.integer(
    value,
    "promptTokens",
    `${prefix}promptTokens`,
  );
  const completionTokens = check.integer(
    value,
    "completionTokens",
    `${prefix}completionTokens`,
  );
  const totalTokens = check.integer(
    value,
    "totalTokens",
    `${prefix}totalTokens`,
  );
  const aiCalls = check.integer(value, "aiCalls", `${prefix}aiCalls`);
  const fallbackUsed = value.fallbackUsed;
  if (typeof fallbackUsed !== "boolean")
    check.fail(`${prefix}fallbackUsed`, "invalid");
  const costUsd = value.costUsd;
  const costOk =
    costUsd === null ||
    (typeof costUsd === "number" && costUsd >= 0 && Number.isFinite(costUsd));
  if (!costOk) check.fail(`${prefix}costUsd`, "invalid");
  const stoppedEarly = value.stoppedEarly ?? null;
  const stoppedOk =
    stoppedEarly === null ||
    (typeof stoppedEarly === "string" &&
      (STOPPED_EARLY_REASONS as readonly string[]).includes(stoppedEarly));
  if (!stoppedOk) check.fail(`${prefix}stoppedEarly`, "invalid");
  const limitExceededBy = value.limitExceededBy;
  const excessOk =
    limitExceededBy === undefined ||
    (typeof limitExceededBy === "number" &&
      limitExceededBy > 0 &&
      Number.isFinite(limitExceededBy));
  if (!excessOk) check.fail(`${prefix}limitExceededBy`, "invalid");
  // The per-call trace (#541) is observability: a trace that is not the contract's is dropped and the usage,
  // the cost and the verdict of the run are kept. The runner leaves it out for a run without one.
  const callTrace =
    value.callTrace === undefined ? undefined : checkCallTrace(value.callTrace);
  if (value.callTrace !== undefined && callTrace === undefined)
    check.dropped.push(`${prefix}callTrace`);
  if (
    check.fields.length > before ||
    model === undefined ||
    promptTokens === undefined ||
    completionTokens === undefined ||
    totalTokens === undefined ||
    aiCalls === undefined ||
    typeof fallbackUsed !== "boolean" ||
    !costOk ||
    !stoppedOk ||
    !excessOk
  )
    return undefined;
  return {
    model,
    promptTokens,
    completionTokens,
    totalTokens,
    aiCalls,
    fallbackUsed,
    costUsd: costUsd as number | null,
    stoppedEarly: stoppedEarly as StoppedEarly | null,
    ...(limitExceededBy === undefined
      ? {}
      : { limitExceededBy: limitExceededBy as number }),
    ...(callTrace === undefined ? {} : { callTrace }),
  };
}

/** The findings of a successful review (#405): null or absent is "not said", the same as for a runner that never sent it. */
function parseFindings(
  check: Checker,
  value: unknown,
): ReviewFindings | null | undefined {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) return check.fail("result.findings", "invalid");
  const before = check.fields.length;
  const prefix = "result.findings.";
  for (const key of Object.keys(value))
    if (key !== "open" && key !== "bySeverity" && key !== "incomplete")
      check.fail(`${prefix}${key}`, "invalid");
  const open = check.integer(value, "open", `${prefix}open`, MAX_FINDING_COUNT);
  const counts = value.bySeverity;
  let bySeverity: ReviewFindings["bySeverity"] | undefined;
  if (counts === undefined) check.fail(`${prefix}bySeverity`, "required");
  else if (counts === null) bySeverity = null;
  else if (!isRecord(counts)) check.fail(`${prefix}bySeverity`, "invalid");
  else {
    const read: Partial<Record<FindingPriority, number>> = {};
    for (const key of Object.keys(counts))
      if (!(FINDING_PRIORITIES as readonly string[]).includes(key))
        check.fail(`${prefix}bySeverity.${key}`, "invalid");
    for (const priority of FINDING_PRIORITIES) {
      const count = check.integer(
        counts,
        priority,
        `${prefix}bySeverity.${priority}`,
        MAX_FINDING_COUNT,
      );
      if (count !== undefined) read[priority] = count;
    }
    if (FINDING_PRIORITIES.every((priority) => read[priority] !== undefined))
      bySeverity = read as Record<FindingPriority, number>;
  }
  const incomplete = value.incomplete;
  if (incomplete !== undefined && typeof incomplete !== "boolean")
    check.fail(`${prefix}incomplete`, "invalid");
  if (
    check.fields.length > before ||
    open === undefined ||
    bySeverity === undefined
  )
    return undefined;
  return { open, bySeverity, ...(incomplete === true ? { incomplete } : {}) };
}

const COMMIT_SHA = /^[0-9a-f]{40}$/;
const MAX_COMMIT_SUBJECT_CHARS = 500;
const MAX_FILE_PATH_CHARS = 4096;
const MAX_OPENCODE_SESSION_ID_CHARS = 200;
const MAX_OPENCODE_VERSION_CHARS = 64;

/** The keys of `source` that are not in `allowed`, refused under `prefix`: these objects are closed. */
function refuseUnknownKeys(
  check: Checker,
  source: Record_,
  allowed: readonly string[],
  prefix: string,
): void {
  for (const key of Object.keys(source))
    if (!allowed.includes(key)) check.fail(`${prefix}${key}`, "invalid");
}

function commitSha(
  check: Checker,
  source: Record_,
  key: string,
  field: string,
): string | undefined {
  const value = check.string(source, key, field, { max: 40 });
  if (value !== undefined && !COMMIT_SHA.test(value))
    return check.fail(field, "invalid");
  return value;
}

/** The commits of an implementer block: closed objects, at most `IMPLEMENTER_RESULT_LIMITS.commits`. */
function parseImplementerCommits(
  check: Checker,
  value: unknown,
  field: string,
): ImplementerResult["commits"] | undefined {
  if (value === undefined) return check.fail(field, "required");
  if (!Array.isArray(value)) return check.fail(field, "invalid");
  if (value.length > IMPLEMENTER_RESULT_LIMITS.commits)
    return check.fail(field, "too_long");
  const before = check.fields.length;
  const commits: ImplementerResult["commits"] = [];
  value.forEach((entry: unknown, index) => {
    const where = `${field}[${String(index)}]`;
    if (!isRecord(entry)) {
      check.fail(where, "invalid");
      return;
    }
    refuseUnknownKeys(check, entry, ["sha", "subject"], `${where}.`);
    const sha = commitSha(check, entry, "sha", `${where}.sha`);
    const subject = check.string(entry, "subject", `${where}.subject`, {
      max: MAX_COMMIT_SUBJECT_CHARS,
      stripControls: true,
    });
    if (sha !== undefined && subject !== undefined)
      commits.push({ sha, subject });
  });
  return check.fields.length > before ? undefined : commits;
}

/** The changed files of an implementer block: closed objects, at most `IMPLEMENTER_RESULT_LIMITS.filesChanged`. */
function parseImplementerFiles(
  check: Checker,
  value: unknown,
  field: string,
): ImplementerResult["filesChanged"] | undefined {
  if (value === undefined) return check.fail(field, "required");
  if (!Array.isArray(value)) return check.fail(field, "invalid");
  if (value.length > IMPLEMENTER_RESULT_LIMITS.filesChanged)
    return check.fail(field, "too_long");
  const before = check.fields.length;
  const files: ImplementerResult["filesChanged"] = [];
  value.forEach((entry: unknown, index) => {
    const where = `${field}[${String(index)}]`;
    if (!isRecord(entry)) {
      check.fail(where, "invalid");
      return;
    }
    refuseUnknownKeys(check, entry, ["path", "status"], `${where}.`);
    const path = check.string(entry, "path", `${where}.path`, {
      min: 1,
      max: MAX_FILE_PATH_CHARS,
      stripControls: true,
    });
    const status = entry.status;
    const statusOk =
      typeof status === "string" &&
      (IMPLEMENTER_FILE_STATUSES as readonly string[]).includes(status);
    if (!statusOk)
      check.fail(
        `${where}.status`,
        status === undefined ? "required" : "invalid",
      );
    if (path !== undefined && statusOk)
      files.push({
        path,
        status: status as ImplementerResult["filesChanged"][number]["status"],
      });
  });
  return check.fields.length > before ? undefined : files;
}

/** The saved agent session of an implementer block: null, or a closed object with both fields. */
function parseImplementerOpencode(
  check: Checker,
  value: unknown,
  field: string,
): ImplementerResult["opencode"] | undefined {
  if (value === undefined) return check.fail(field, "required");
  if (value === null) return null;
  if (!isRecord(value)) return check.fail(field, "invalid");
  const before = check.fields.length;
  refuseUnknownKeys(check, value, ["sessionId", "version"], `${field}.`);
  const sessionId = check.string(value, "sessionId", `${field}.sessionId`, {
    min: 1,
    max: MAX_OPENCODE_SESSION_ID_CHARS,
    stripControls: true,
  });
  const version = check.string(value, "version", `${field}.version`, {
    min: 1,
    max: MAX_OPENCODE_VERSION_CHARS,
    stripControls: true,
  });
  if (
    check.fields.length > before ||
    sessionId === undefined ||
    version === undefined
  )
    return undefined;
  return { sessionId, version };
}

/**
 * The implementer block of a result (#754, `ImplementerResult` in the contract): closed, every field required, the bounds of the
 * schema. Absent is "no block" (a failure before the runner had a repository, and every job that is not a turn); `null` is not
 * a block and is refused, as the contract has no null for it. Whether the job may or must carry one is decided with the job
 * (`implementer-report.ts`). The text fields lose their control characters (a NUL cannot be stored); the invariants the contract
 * states in words are checked: `pushed` never without a head commit, and the head commit is the last commit when commits are listed.
 */
function parseImplementerResult(
  check: Checker,
  value: unknown,
): ImplementerResult | null | undefined {
  if (value === undefined) return null;
  const field = "result.implementer";
  if (!isRecord(value)) return check.fail(field, "invalid");
  const before = check.fields.length;
  const prefix = `${field}.`;
  refuseUnknownKeys(
    check,
    value,
    [
      "baseCommit",
      "headCommit",
      "pushed",
      "commits",
      "filesChanged",
      "summary",
      "opencode",
    ],
    prefix,
  );
  const baseCommit = commitSha(
    check,
    value,
    "baseCommit",
    `${prefix}baseCommit`,
  );
  const headCommit =
    value.headCommit === null
      ? null
      : commitSha(check, value, "headCommit", `${prefix}headCommit`);
  const pushed = value.pushed;
  if (typeof pushed !== "boolean")
    check.fail(
      `${prefix}pushed`,
      pushed === undefined ? "required" : "invalid",
    );
  const commits = parseImplementerCommits(
    check,
    value.commits,
    `${prefix}commits`,
  );
  const filesChanged = parseImplementerFiles(
    check,
    value.filesChanged,
    `${prefix}filesChanged`,
  );
  const summary = check.string(value, "summary", `${prefix}summary`, {
    max: IMPLEMENTER_RESULT_LIMITS.summaryChars,
    stripControls: true,
  });
  const opencode = parseImplementerOpencode(
    check,
    value.opencode,
    `${prefix}opencode`,
  );
  if (typeof pushed === "boolean" && headCommit !== undefined) {
    if (pushed && headCommit === null) check.fail(`${prefix}pushed`, "invalid");
    const last = commits?.at(-1);
    if (last !== undefined && last.sha !== headCommit)
      check.fail(`${prefix}headCommit`, "invalid");
  }
  if (
    check.fields.length > before ||
    baseCommit === undefined ||
    headCommit === undefined ||
    typeof pushed !== "boolean" ||
    commits === undefined ||
    filesChanged === undefined ||
    summary === undefined ||
    opencode === undefined
  )
    return undefined;
  return {
    baseCommit,
    headCommit,
    pushed,
    commits,
    filesChanged,
    summary,
    opencode,
  };
}

function parseResult(check: Checker, value: unknown): RunnerResult | undefined {
  if (!isRecord(value)) return check.fail("result", "invalid");
  const before = check.fields.length;

  const ok = value.ok;
  if (ok === undefined) check.fail("result.ok", "required");
  else if (typeof ok !== "boolean") check.fail("result.ok", "invalid");
  const durationMs = check.integer(
    value,
    "durationMs",
    "result.durationMs",
    MAX_DURATION_MS,
  );
  const logTail = check.string(value, "logTail", "result.logTail", {
    max: MAX_LOG_TAIL_CHARS,
  });
  const errorMessage = check.optionalString(
    value,
    "errorMessage",
    "result.errorMessage",
    MAX_ERROR_MESSAGE_CHARS,
  );
  const errorReason = check.optionalString(
    value,
    "errorReason",
    "result.errorReason",
    MAX_ERROR_REASON_CHARS,
  );
  if (typeof errorReason === "string" && !ERROR_CODE.test(errorReason))
    check.fail("result.errorReason", "invalid");
  const commentUrl = check.optionalString(
    value,
    "commentUrl",
    "result.commentUrl",
    MAX_COMMENT_URL_CHARS,
  );
  if (typeof commentUrl === "string" && !/^https?:\/\//.test(commentUrl))
    check.fail("result.commentUrl", "invalid");

  // `errorCode` has to be given (as null for a good run) and must agree with `ok`.
  const errorCode = value.errorCode;
  if (errorCode === undefined) check.fail("result.errorCode", "required");
  else if (
    errorCode !== null &&
    (typeof errorCode !== "string" || !ERROR_CODE.test(errorCode))
  )
    check.fail("result.errorCode", "invalid");
  else if (
    typeof ok === "boolean" &&
    (ok ? errorCode !== null : errorCode === null)
  )
    check.fail("result.errorCode", "invalid");

  const logTruncated = value.logTruncated;
  if (logTruncated !== undefined && typeof logTruncated !== "boolean")
    check.fail("result.logTruncated", "invalid");
  const usage = parseUsage(check, value.usage);
  const findings = parseFindings(check, value.findings);
  const implementer = parseImplementerResult(check, value.implementer);

  if (
    check.fields.length > before ||
    typeof ok !== "boolean" ||
    durationMs === undefined ||
    logTail === undefined ||
    errorMessage === undefined ||
    commentUrl === undefined ||
    usage === undefined ||
    findings === undefined ||
    implementer === undefined ||
    (errorCode !== null && typeof errorCode !== "string")
  )
    return undefined;
  return {
    ok,
    durationMs,
    commentUrl,
    errorCode,
    errorMessage,
    ...(typeof errorReason === "string" ? { errorReason } : {}),
    logTail,
    logTruncated: logTruncated === true,
    usage,
    ...(findings === null ? {} : { findings }),
    ...(implementer === null ? {} : { implementer }),
  };
}

export function parseCompleteRequest(
  body: unknown,
): ParsedResult<CompleteRequest> {
  if (!isRecord(body))
    return { ok: false, fields: [{ field: "body", code: "invalid" }] };
  const check = new Checker();
  const leaseToken = leaseTokenOf(check, body);
  const result =
    body.result === undefined
      ? check.fail("result", "required")
      : parseResult(check, body.result);
  if (
    check.fields.length > 0 ||
    leaseToken === undefined ||
    result === undefined
  )
    return { ok: false, fields: check.fields };
  return { ok: true, value: { leaseToken, result }, dropped: check.dropped };
}

/** #320: the body of the Worker's result call: the result alone, the credential identifies the job. */
export function parseWorkerResultRequest(
  body: unknown,
): ParsedResult<WorkerResultRequest> {
  if (!isRecord(body))
    return { ok: false, fields: [{ field: "body", code: "invalid" }] };
  const check = new Checker();
  const result =
    body.result === undefined
      ? check.fail("result", "required")
      : parseResult(check, body.result);
  if (check.fields.length > 0 || result === undefined)
    return { ok: false, fields: check.fields };
  return { ok: true, value: { result }, dropped: check.dropped };
}

/**
 * #320: the features named in the `features` query parameter of the Worker's details call, a comma
 * separated list with the same meaning as `features` of a claim. Only the names this app knows are kept;
 * anything else is ignored, so a newer Worker can name features an older app has never heard of.
 */
export function parseWorkerFeatures(raw: string | null): ClaimFeature[] {
  if (raw === null) return [];
  const names = raw.split(",").map((name) => name.trim());
  return CLAIM_FEATURES.filter((known) => names.includes(known));
}
