// SPDX-License-Identifier: LicenseRef-Proprietary

// The deploy canary (#331): a step of the release pipeline that calls `POST /probe` of a freshly deployed Dispatcher
// and fails the release when the Dynamic-Worker's canary does not pass. It sends the dispatcher credential to
// that one URL and nowhere else (no redirect is followed, http only to this machine), prints stable codes and the
// stable reasons of the contract and never the credential or any text the deployment sent.
//
//   exit 0  the deployment advertises every required engine from a probe that ran just now
//   exit 1  it does not, it could not be reached, or it answered something that is not a report: block the release
//   exit 2  wrong use (nothing was sent)
//
// The credential is `DISPATCHER_OPERATOR_TOKEN` in the environment (#730), else `RUNNER_TOKEN` while the Dispatcher has no
// operator token yet; never an argument (an argument shows up in process lists and logs).
//
// Which URL may get the credential is decided before any request to it: by a list of host names (a person at a
// terminal), by the platform (`verifyDeployment`: the Vercel API says the deployment behind the host belongs to the
// Dispatcher project and the team, which is what the release pipeline uses, because every staged deployment has a new
// host), or by both.
import { z } from "zod";
import type { Clock, Engine } from "../core/types.ts";
import { probeFailureCode } from "./failure-codes.ts";
import { PROBE_REASONS } from "./verdict.ts";

const HEALTH_INTERVAL_SECONDS = 5;
const DEFAULT_PROBE_TIMEOUT_SECONDS = 300;
const HOST_NAME = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const ENGINES: readonly Engine[] = ["pr-agent", "opencode"];
/**
 * Every engine the route can name in an answer. `implementer` is no default of the canary (the default stays the two
 * reviewer engines, so a deployment without the kind is unchanged), but a deployment that serves it has the route require
 * it (`report.required`), and the canary then blocks without it; `--engines` may also name it.
 */
const REPORTED_ENGINES: readonly Engine[] = [...ENGINES, "implementer"];
const PLATFORM_API = "https://api.vercel.com";

export type DeploymentCheck = {
  /** A Vercel access token. A secret. */
  token: string;
  teamId: string;
  projectId: string;
  /**
   * The commit the deployment must have been built from (`meta.githubCommitSha`, which the deploy step sets). Without
   * it any production deployment of the project and team qualifies.
   */
  expectedCommit?: string;
};

export type CanaryOptions = {
  /** The base URL of the Dispatcher deployment, for example `https://dispatcher.example`. */
  url: string;
  /** The dispatcher credential. A secret. */
  token: string;
  /**
   * The host names the credential may be sent to (exact, case does not matter, the port does not). When there is a
   * list, a URL whose host is not on it is refused before any request, this machine included; an empty list refuses
   * everything. Without one, any https host (or this machine) is allowed: for a person at a terminal, not for CI.
   */
  allowedHosts?: readonly string[];
  /**
   * Ask the platform whether the deployment behind the URL's host belongs to this project and team, before anything
   * is sent to it. The URL must then be https on the default port and name the deployment itself (not an alias or a
   * domain). `token` is a Vercel access token and goes to the platform's API only.
   */
  verifyDeployment?: DeploymentCheck;
  /** Only check the URL (the list, the platform): nothing is sent to the deployment, no credential needed. */
  checkOnly?: boolean;
  /** The engines the release needs; both by default. */
  requiredEngines?: readonly Engine[];
  /** How long to wait for the deployment to answer `GET /health` before the credential is sent. 0: one try. */
  healthWaitSeconds?: number;
  probeTimeoutSeconds?: number;
  /**
   * The Worker image id the deployment must report (`imageDigest` of the probe report), so that the canary proves the
   * image the pipeline built and not whichever one the project variables happen to name. Never printed.
   */
  expectedImageDigest?: string;
  /**
   * The snapshot id the deployment must report: with the image id it covers the whole pair, including a rebuild of
   * the same layers (same image id, new snapshot). Never printed.
   */
  expectedSnapshotId?: string;
  /** Platform deployment protection: sent as `x-vercel-protection-bypass`. A secret. */
  bypassSecret?: string;
  fetch?: typeof fetch;
  clock: Clock;
  write: (line: string) => void;
};

const DeploymentRecordSchema = z.object({
  url: z.string(),
  projectId: z.string(),
  ownerId: z.string(),
  target: z.string().nullish(),
  readyState: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).nullish(),
});
const COMMIT = /^[0-9a-f]{40}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const PLATFORM_ATTEMPTS = 3;
const PLATFORM_RETRY_MILLISECONDS = 2000;

const ReportSchema = z.object({
  version: z.literal(1),
  status: z.enum(["passed", "denied", "failed"]),
  ok: z.boolean(),
  engines: z.array(z.string()).max(16),
  reasons: z.array(z.string()).max(64),
  failure: z.string().max(100).optional(),
  required: z.array(z.string()).max(16).optional(),
  imageDigest: z.string().max(100).optional(),
  snapshotId: z.string().max(130).optional(),
});
const SNAPSHOT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,127}$/;

export class CanaryUsageError extends Error {
  constructor(what: string) {
    super(what);
    this.name = "CanaryUsageError";
  }
}

const USAGE =
  "usage: probe:canary --url <https://dispatcher> [--allowed-hosts <host,host>] [--verify-vercel [--expect-commit <sha>]] [--check-only] [--engines pr-agent,opencode[,implementer]] [--wait-seconds <n>] [--timeout-seconds <n>]; the credential is DISPATCHER_OPERATOR_TOKEN in the environment, else RUNNER_TOKEN (before the Dispatcher has an operator token), the allowed hosts may also be CANARY_ALLOWED_HOSTS; CANARY_EXPECT_IMAGE_DIGEST is the image id the deployment must report; --verify-vercel reads VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID (the Dispatcher project) from the environment";

function seconds(value: string | undefined, name: string, max: number): number {
  const number = Number(value);
  if (
    value === undefined ||
    !Number.isInteger(number) ||
    number < 0 ||
    number > max
  )
    throw new CanaryUsageError(
      `${name} must be a whole number from 0 to ${max}`,
    );
  return number;
}

/** The options of a command line and its environment. Throws `CanaryUsageError` (never with a value of an argument). */
export function parseCanaryArguments(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Omit<CanaryOptions, "clock" | "write" | "fetch"> {
  const values = new Map<string, string>();
  let checkOnly = false;
  let verify = false;
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--check-only") {
      checkOnly = true;
      continue;
    }
    if (name === "--verify-vercel") {
      verify = true;
      continue;
    }
    const value = argv[index + 1];
    index += 1;
    if (
      name === undefined ||
      value === undefined ||
      ![
        "--url",
        "--engines",
        "--wait-seconds",
        "--timeout-seconds",
        "--allowed-hosts",
        "--expect-commit",
      ].includes(name)
    )
      throw new CanaryUsageError(USAGE);
    values.set(name, value);
  }
  const url = values.get("--url");
  if (url === undefined)
    throw new CanaryUsageError(`--url is required. ${USAGE}`);
  // The operator's credential opens `POST /probe` of a Dispatcher that has one; the reviewer's token still does until then.
  const operator = env.DISPATCHER_OPERATOR_TOKEN ?? "";
  const token = operator === "" ? (env.RUNNER_TOKEN ?? "") : operator;
  if (token === "" && !checkOnly)
    throw new CanaryUsageError(
      "DISPATCHER_OPERATOR_TOKEN (or RUNNER_TOKEN) is required (the credential of POST /probe)",
    );
  const listed = values.get("--allowed-hosts") ?? env.CANARY_ALLOWED_HOSTS;
  const allowedHosts =
    listed === undefined
      ? undefined
      : listed
          .split(",")
          .map((host) => host.trim().toLowerCase())
          .filter((host) => host !== "");
  if (allowedHosts?.some((host) => !HOST_NAME.test(host)))
    throw new CanaryUsageError(
      "--allowed-hosts takes host names, separated by commas",
    );

  const named = values.get("--engines");
  const requiredEngines = (
    named === undefined ? [...ENGINES] : named.split(",")
  ).map((engine) => {
    const known = REPORTED_ENGINES.find((candidate) => candidate === engine);
    if (known === undefined)
      throw new CanaryUsageError(
        "--engines takes pr-agent, opencode and implementer",
      );
    return known;
  });
  const bypass = env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const expectedCommit = values.get("--expect-commit");
  if (expectedCommit !== undefined && !verify)
    throw new CanaryUsageError("--expect-commit needs --verify-vercel");
  if (expectedCommit !== undefined && !COMMIT.test(expectedCommit))
    throw new CanaryUsageError("--expect-commit takes a full commit sha");
  const verifyDeployment = verify
    ? {
        ...deploymentCheckFrom(env),
        ...(expectedCommit === undefined ? {} : { expectedCommit }),
      }
    : undefined;
  const expectedImageDigest = env.CANARY_EXPECT_IMAGE_DIGEST;
  if (
    expectedImageDigest !== undefined &&
    expectedImageDigest !== "" &&
    !IMAGE_ID.test(expectedImageDigest)
  )
    throw new CanaryUsageError(
      "CANARY_EXPECT_IMAGE_DIGEST must be an image id (sha256:...)",
    );
  const expectedSnapshotId = env.CANARY_EXPECT_SNAPSHOT_ID;
  if (
    expectedSnapshotId !== undefined &&
    expectedSnapshotId !== "" &&
    !SNAPSHOT_ID.test(expectedSnapshotId)
  )
    throw new CanaryUsageError(
      "CANARY_EXPECT_SNAPSHOT_ID must be a snapshot id",
    );
  return {
    url,
    token,
    ...(allowedHosts === undefined ? {} : { allowedHosts }),
    ...(verifyDeployment === undefined ? {} : { verifyDeployment }),
    ...(expectedImageDigest === undefined || expectedImageDigest === ""
      ? {}
      : { expectedImageDigest }),
    ...(expectedSnapshotId === undefined || expectedSnapshotId === ""
      ? {}
      : { expectedSnapshotId }),
    ...(checkOnly ? { checkOnly } : {}),
    requiredEngines,
    healthWaitSeconds: values.has("--wait-seconds")
      ? seconds(values.get("--wait-seconds"), "--wait-seconds", 1800)
      : 120,
    probeTimeoutSeconds: values.has("--timeout-seconds")
      ? seconds(values.get("--timeout-seconds"), "--timeout-seconds", 1800)
      : DEFAULT_PROBE_TIMEOUT_SECONDS,
    ...(bypass === undefined || bypass === "" ? {} : { bypassSecret: bypass }),
  };
}

function deploymentCheckFrom(
  env: Readonly<Record<string, string | undefined>>,
): DeploymentCheck {
  const token = env.VERCEL_TOKEN ?? "";
  const teamId = env.VERCEL_TEAM_ID ?? "";
  const projectId = env.VERCEL_PROJECT_ID ?? "";
  for (const [name, value] of [
    ["VERCEL_TOKEN", token],
    ["VERCEL_TEAM_ID", teamId],
    ["VERCEL_PROJECT_ID", projectId],
  ] as const)
    if (value === "")
      throw new CanaryUsageError(`${name} is required with --verify-vercel`);
  return { token, teamId, projectId };
}

/**
 * The base of the Dispatcher, or undefined when the credential must not be sent there. With `strict` (the host is
 * proven by the platform) only the deployment's own https address qualifies: this machine and a port do not.
 */
function baseOf(input: string, strict: boolean): URL | undefined {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  const secure =
    url.protocol === "https:" ||
    (!strict && url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname));
  if (!secure) return undefined;
  if (strict && url.port !== "") return undefined;
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  )
    return undefined;
  if (url.pathname !== "/" && url.pathname !== "") return undefined;
  return url;
}

/**
 * Whether the platform says that the deployment this host names is a ready production deployment of the project and
 * the team (and of the expected commit, when one is given). The host is the deployment's own: an alias or a domain
 * answers with another `url`, and is refused. A 429 or a 5xx is not an answer about the deployment: it is asked again
 * a few times and then reported as unavailable. Only the platform's address ever sees the token; what it answers is
 * never printed.
 */
async function verifiedByPlatform(
  host: string,
  check: DeploymentCheck,
  request: typeof fetch,
  clock: Clock,
): Promise<"verified" | "not_verified" | "unavailable"> {
  const address = new URL(
    `/v13/deployments/${encodeURIComponent(host)}`,
    PLATFORM_API,
  );
  address.searchParams.set("teamId", check.teamId);
  let answer: Response | undefined;
  for (let attempt = 1; attempt <= PLATFORM_ATTEMPTS; attempt += 1) {
    try {
      answer = await request(address, {
        headers: { authorization: `Bearer ${check.token}` },
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      answer = undefined;
    }
    const retry =
      answer === undefined || answer.status === 429 || answer.status >= 500;
    if (!retry) break;
    if (attempt < PLATFORM_ATTEMPTS)
      await clock.sleep(PLATFORM_RETRY_MILLISECONDS);
  }
  if (answer === undefined || answer.status === 429 || answer.status >= 500)
    return "unavailable";
  if (answer.status !== 200) return "not_verified";
  let record: z.infer<typeof DeploymentRecordSchema>;
  try {
    record = DeploymentRecordSchema.parse(await answer.json());
  } catch {
    return "not_verified";
  }
  const commit = record.meta?.githubCommitSha;
  const matches =
    record.url.toLowerCase() === host &&
    record.projectId === check.projectId &&
    record.ownerId === check.teamId &&
    record.target === "production" &&
    record.readyState === "READY" &&
    (check.expectedCommit === undefined || commit === check.expectedCommit);
  return matches ? "verified" : "not_verified";
}

/** Runs the canary and returns the exit status. */
export async function runCanary(options: CanaryOptions): Promise<0 | 1 | 2> {
  const { write } = options;
  const base = baseOf(options.url, options.verifyDeployment !== undefined);
  if (base === undefined) {
    write(
      "canary: canary_url_invalid (https, or http to this machine; no path, query or credentials)",
    );
    return 2;
  }
  if (
    options.allowedHosts !== undefined &&
    !options.allowedHosts.includes(base.hostname.toLowerCase())
  ) {
    write(
      "canary: canary_host_not_allowed (the host is not on the list of hosts the credential may be sent to)",
    );
    return 2;
  }
  const request = options.fetch ?? fetch;
  if (options.verifyDeployment !== undefined) {
    const verdict = await verifiedByPlatform(
      base.hostname.toLowerCase(),
      options.verifyDeployment,
      request,
      options.clock,
    );
    if (verdict === "unavailable") {
      write(
        "canary: canary_verification_unavailable (the platform could not be asked), the release is blocked",
      );
      return 1;
    }
    if (verdict === "not_verified") {
      write(
        "canary: canary_deployment_not_verified (the platform does not say that this deployment belongs to the Dispatcher project and team)",
      );
      return 2;
    }
  }
  if (options.checkOnly === true) {
    write("canary: the URL is allowed");
    return 0;
  }
  const required = options.requiredEngines ?? ENGINES;
  const bypass: Record<string, string> =
    options.bypassSecret === undefined
      ? {}
      : { "x-vercel-protection-bypass": options.bypassSecret };
  const at = (path: string) => new URL(path, base).toString();

  // 1. The deployment answers. The credential is not sent until it does, and never to /health.
  const tries =
    Math.ceil((options.healthWaitSeconds ?? 0) / HEALTH_INTERVAL_SECONDS) + 1;
  let ready = false;
  for (let attempt = 1; attempt <= tries && !ready; attempt += 1) {
    try {
      const answer = await request(at("/health"), {
        headers: bypass,
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      ready = answer.status === 200;
    } catch {
      ready = false;
    }
    if (!ready && attempt < tries)
      await options.clock.sleep(HEALTH_INTERVAL_SECONDS * 1000);
  }
  if (!ready) {
    write("canary: deployment_not_ready, nothing was sent but GET /health");
    return 1;
  }

  // 2. The probe, forced.
  let answer: Response;
  try {
    answer = await request(at("/probe"), {
      method: "POST",
      headers: { ...bypass, authorization: `Bearer ${options.token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(
        (options.probeTimeoutSeconds ?? DEFAULT_PROBE_TIMEOUT_SECONDS) * 1000,
      ),
    });
  } catch {
    write("canary: probe_unreachable, the release is blocked");
    return 1;
  }
  if (answer.status !== 200 && answer.status !== 503) {
    write(`canary: refused (status ${answer.status}), the release is blocked`);
    return 1;
  }
  let report: z.infer<typeof ReportSchema>;
  try {
    report = ReportSchema.parse(await answer.json());
  } catch {
    write(
      `canary: canary_unreadable (status ${answer.status}), the release is blocked`,
    );
    return 1;
  }

  // Only what the contract lists is printed: a value shaped like a secret in the answer goes nowhere.
  const known = (engine: string): engine is Engine =>
    REPORTED_ENGINES.some((candidate) => candidate === engine);
  const engines = report.engines.filter(known);
  const reasons = report.reasons.filter((reason) =>
    PROBE_REASONS.some((known) => known === reason),
  );
  const details = [
    `engines=${engines.join(",") === "" ? "none" : engines.join(",")}`,
    ...(reasons.length === 0 ? [] : [`reasons=${reasons.join(",")}`]),
    ...(report.failure === undefined
      ? []
      : [`failure=${probeFailureCode(report.failure)}`]),
  ].join(" ");
  // What the route required counts too: a canary that asks for less than the Dispatcher serves would otherwise block without a reason.
  const demanded = [...required, ...(report.required ?? []).filter(known)];
  const missing = [...new Set(demanded)].filter(
    (engine) => !engines.includes(engine),
  );
  if (answer.status === 200 && report.ok && missing.length === 0) {
    // The probe passed; was it the pair the pipeline built? No id is printed.
    if (
      (options.expectedImageDigest !== undefined &&
        report.imageDigest !== options.expectedImageDigest) ||
      (options.expectedSnapshotId !== undefined &&
        report.snapshotId !== options.expectedSnapshotId)
    ) {
      write(
        `canary: canary_image_mismatch (the deployment does not report the image this run built), the release is blocked`,
      );
      return 1;
    }
    write(`canary: ${report.status} ${details}`);
    return 0;
  }
  write(
    `canary: ${report.status} ${details}${missing.length === 0 ? "" : ` missing=${missing.join(",")}`}, the release is blocked`,
  );
  return 1;
}
