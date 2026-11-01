// SPDX-License-Identifier: LicenseRef-Proprietary

// What the operator configures, read from environment variables. A refusal names the variable and
// never the value: several of them are secrets.
//
// | Variable                                                    | Meaning                                              | Default |
// |-------------------------------------------------------------|------------------------------------------------------|---------|
// | RUNNER_API_URL                                              | Base URL of the App `reviewer`                       | required |
// | RUNNER_TOKEN                                                | The dispatcher credential of `reviewer` (the runner API token) | required |
// | DISPATCHER_MAX_RUNNING                                      | The pool cap of `reviewer` (1 to 1000)               | required |
// | DISPATCHER_SIGNING_KEY_ID / DISPATCHER_SIGNING_SECRET       | The key `reviewer` signs the wake-up call with       | required |
// | DISPATCHER_SIGNING_KEY_ID_PREVIOUS / ..._SECRET_PREVIOUS    | The previous key, accepted while rotating            | none |
// | DISPATCHER_POOL_ID                                          | Sent as X-Runner-Id; the App counts the pool by it   | dispatcher |
// | DISPATCHER_ENGINES                                          | Engines to serve, `pr-agent,opencode,implementer`; the job kinds of `reviewer` follow, and never include `implementer` (#759) | `pr-agent,opencode`, plus `implementer` when an app of `DISPATCHER_APPS` names the kind |
// | DISPATCHER_JOB_TIMEOUT_SECONDS                              | How long a Worker of Diff or Dynamic may live (60 to 21600) | 1200 |
// | DISPATCHER_WORKER_CONFIG                                    | JSON `{diff?, dynamic?, implementer?}`: container memory, launcher options; `implementer` also `timeoutSeconds` (60 to 21600, default 3600) | none |
// | DISPATCHER_APPS (#730)                                      | JSON array of further apps: `{id, url, kinds, keyId, maxRunning, poolId?}`; `kinds` out of `diff`, `dynamic`, `implementer` | none: only `reviewer` |
// | DISPATCHER_APP_<ID>_TOKEN                                   | Per further app (id upper-cased, `-` as `_`): its dispatcher credential | required per app |
// | DISPATCHER_APP_<ID>_SIGNING_SECRET                          | Per further app: the secret its wake-up and stop calls are signed with | required per app |
// | DISPATCHER_APP_<ID>_SIGNING_SECRET_PREVIOUS / ..._PREVIOUS_KEY_ID | Per further app: the previous key, accepted while rotating | none |
// | DISPATCHER_OPERATOR_TOKEN (#730)                            | The credential of `POST /probe` and `POST /apps/check` (at least 32 characters) | none: `/probe` still takes the `reviewer` token while `reviewer` is the only app; required with `DISPATCHER_APPS` |
// | CRON_SECRET (Vercel entry)                                  | The secret of the platform's cron for the reaper route (#364), at least 32 characters, distinct from every other secret | none: the route refuses everyone |
// | DISPATCHER_SHUTDOWN_GRACE_SECONDS (Node entry)              | How long launches may finish after SIGTERM (0 to 600) | 60 |
import { z } from "zod";
import {
  ENGINE_BY_KIND,
  KNOWN_KINDS,
  LEGACY_APP_ID,
  REVIEWER_KINDS,
  type AppSettings,
  type CoreSettings,
  type Engine,
  type ReviewKind,
} from "./core/types.ts";
import type { AppSigningKey } from "./triggers/signature.ts";

export const CONFIG_REASONS = [
  "required",
  "invalid",
  "too_short",
  "not_distinct",
  "duplicate",
] as const;
export type ConfigReason = (typeof CONFIG_REASONS)[number];

export class ConfigError extends Error {
  readonly variable: string;
  readonly reason: ConfigReason;
  /** Which entry of a list the refusal is about (an app id and a field); never a value. */
  readonly detail?: string;

  constructor(variable: string, reason: ConfigReason, detail?: string) {
    super(
      `${variable} is ${reason.replace("_", " ")}${detail === undefined ? "" : ` (${detail})`}`,
    );
    this.name = "ConfigError";
    this.variable = variable;
    this.reason = reason;
    if (detail !== undefined) this.detail = detail;
  }
}

export type Settings = {
  core: CoreSettings;
  /** `CRON_SECRET`: what the reaper's cron route (#364) accepts. Absent: the route refuses every caller. */
  cronSecret: string | undefined;
  /**
   * Why a set `CRON_SECRET` was not taken (never its value). It refuses the start only where the route is mounted,
   * so a snapshot is configured (compose.ts); elsewhere the variable is ignored with a warning.
   */
  cronSecretProblem?: ConfigError;
  /**
   * The keys of every app (#730), each naming the app it belongs to: the sender is the key. Per app the current key
   * first, then the previous one if there is one; the keys of `reviewer` (the legacy variables) come first.
   */
  signingKeys: AppSigningKey[];
  /**
   * `DISPATCHER_OPERATOR_TOKEN`: the credential of `POST /probe` and `POST /apps/check` (#730). Absent: `/probe` is still
   * opened by the token of `reviewer` (the rollout fallback) and `/apps/check` refuses everyone.
   */
  operatorToken: string | undefined;
  shutdownGraceSeconds: number;
};

export type Environment = Readonly<Record<string, string | undefined>>;

const KEY_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const POOL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/;
const APP_ID = /^[a-z][a-z0-9-]{0,23}$/;
/** What `DISPATCHER_ENGINES` may name. */
const ENGINES: readonly Engine[] = ["pr-agent", "opencode", "implementer"];
/** The engines served when nothing is configured (#759: `implementer` is added for the apps of the registry that name it). */
const DEFAULT_ENGINES: readonly Engine[] = ["pr-agent", "opencode"];
const MIN_SECRET_LENGTH = 32;
const MAX_APPS = 16;
const MIN_JOB_TIMEOUT_SECONDS = 60;
const MAX_JOB_TIMEOUT_SECONDS = 21600;
const CONTROL_OR_SPACE = /[\s\p{Cc}]/u;

export function read(env: Environment, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function required(env: Environment, name: string): string {
  const value = read(env, name);
  if (value === undefined) throw new ConfigError(name, "required");
  return value;
}

export function integer(
  env: Environment,
  name: string,
  range: { min: number; max: number; fallback?: number },
): number {
  const raw = read(env, name);
  if (raw === undefined) {
    if (range.fallback === undefined) throw new ConfigError(name, "required");
    return range.fallback;
  }
  const value = Number(raw);
  if (!/^\d{1,9}$/.test(raw) || value < range.min || value > range.max)
    throw new ConfigError(name, "invalid");
  return value;
}

/** The URL rules of an App's base address; `refuse` says what to throw (the variable that held it). */
function parseAppUrl(raw: string, refuse: () => ConfigError): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw refuse();
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw refuse();
  return raw.replace(/\/+$/, "");
}

/** The address as the platform sees it (host in lower case, default port dropped, no trailing slash): what two apps are compared by. */
function addressOf(url: string): string {
  return new URL(url).href.replace(/\/+$/, "");
}

function appUrl(env: Environment): string {
  const raw = required(env, "RUNNER_API_URL");
  return parseAppUrl(raw, () => new ConfigError("RUNNER_API_URL", "invalid"));
}

function token(env: Environment): string {
  const value = required(env, "RUNNER_TOKEN");
  if (CONTROL_OR_SPACE.test(value))
    throw new ConfigError("RUNNER_TOKEN", "invalid");
  return value;
}

/** A secret of its own: at least 32 characters and no control character or space. */
function secret(env: Environment, name: string): string {
  const value = required(env, name);
  if (value.length < MIN_SECRET_LENGTH)
    throw new ConfigError(name, "too_short");
  if (CONTROL_OR_SPACE.test(value)) throw new ConfigError(name, "invalid");
  return value;
}

function key(
  env: Environment,
  idName: string,
  secretName: string,
  appId: string,
): AppSigningKey {
  const kid = required(env, idName);
  if (!KEY_ID.test(kid)) throw new ConfigError(idName, "invalid");
  return { kid, secret: secret(env, secretName), appId };
}

/** The keys of `reviewer`: the legacy variables, unchanged. */
function legacySigningKeys(env: Environment): {
  keys: AppSigningKey[];
  names: string[];
} {
  const keys = [
    key(
      env,
      "DISPATCHER_SIGNING_KEY_ID",
      "DISPATCHER_SIGNING_SECRET",
      LEGACY_APP_ID,
    ),
  ];
  const names = ["DISPATCHER_SIGNING_SECRET"];
  const previousId = read(env, "DISPATCHER_SIGNING_KEY_ID_PREVIOUS");
  const previousSecret = read(env, "DISPATCHER_SIGNING_SECRET_PREVIOUS");
  if (previousId !== undefined || previousSecret !== undefined) {
    keys.push(
      key(
        env,
        "DISPATCHER_SIGNING_KEY_ID_PREVIOUS",
        "DISPATCHER_SIGNING_SECRET_PREVIOUS",
        LEGACY_APP_ID,
      ),
    );
    names.push("DISPATCHER_SIGNING_SECRET_PREVIOUS");
  }
  return { keys, names };
}

/** The name of a secret variable of an app of `DISPATCHER_APPS`: the id upper-cased, `-` as `_`. */
export function appVariable(appId: string, suffix: string): string {
  return `DISPATCHER_APP_${appId.toUpperCase().replaceAll("-", "_")}_${suffix}`;
}

const registryEntry = z.strictObject({
  id: z.string().regex(APP_ID),
  url: z.string(),
  kinds: z.array(z.string()).min(1),
  keyId: z.string().regex(KEY_ID),
  maxRunning: z.number().int().min(1).max(1000),
  poolId: z.string().regex(POOL_ID).optional(),
});

type RegistryApp = {
  app: AppSettings;
  keys: AppSigningKey[];
  /** The variable of each secret in `keys` (for a refusal), and of the app's token. */
  keyVariables: string[];
  tokenVariable: string;
};

function registryApps(env: Environment): RegistryApp[] {
  const raw = read(env, "DISPATCHER_APPS");
  if (raw === undefined) return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ConfigError("DISPATCHER_APPS", "invalid");
  }
  if (!Array.isArray(json) || json.length === 0 || json.length > MAX_APPS)
    throw new ConfigError("DISPATCHER_APPS", "invalid");
  const apps: RegistryApp[] = [];
  for (const [index, entry] of json.entries()) {
    const parsed = registryEntry.safeParse(entry);
    if (!parsed.success)
      throw new ConfigError(
        "DISPATCHER_APPS",
        "invalid",
        `entry ${index}: ${parsed.error.issues[0]?.path.join(".") || "shape"}`,
      );
    const { id, kinds, keyId, maxRunning } = parsed.data;
    if (id === LEGACY_APP_ID)
      throw new ConfigError("DISPATCHER_APPS", "duplicate", `${id}: reserved`);
    if (apps.some((other) => other.app.id === id))
      throw new ConfigError("DISPATCHER_APPS", "duplicate", `${id}: id`);
    const unique = [...new Set(kinds)];
    if (
      !unique.every((kind): kind is ReviewKind =>
        (KNOWN_KINDS as readonly string[]).includes(kind),
      )
    )
      throw new ConfigError("DISPATCHER_APPS", "invalid", `${id}: kinds`);
    const url = parseAppUrl(
      parsed.data.url,
      () => new ConfigError("DISPATCHER_APPS", "invalid", `${id}: url`),
    );

    const tokenVariable = appVariable(id, "TOKEN");
    const dispatcherToken = secret(env, tokenVariable);
    const secretName = appVariable(id, "SIGNING_SECRET");
    const keys: AppSigningKey[] = [
      { kid: keyId, secret: secret(env, secretName), appId: id },
    ];
    const keyVariables = [secretName];
    const previousSecretName = appVariable(id, "SIGNING_SECRET_PREVIOUS");
    const previousIdName = appVariable(id, "SIGNING_SECRET_PREVIOUS_KEY_ID");
    if (
      read(env, previousSecretName) !== undefined ||
      read(env, previousIdName) !== undefined
    ) {
      keys.push(key(env, previousIdName, previousSecretName, id));
      keyVariables.push(previousSecretName);
    }
    apps.push({
      app: {
        id,
        url,
        token: dispatcherToken,
        poolId: parsed.data.poolId ?? id,
        maxRunning,
        kinds: unique,
      },
      keys,
      keyVariables,
      tokenVariable,
    });
  }
  return apps;
}

/**
 * Every secret of the deployment is distinct from every other (a credential of one app must never open another app,
 * the operator's route or the cron route), and no two keys, no two apps and no two URLs are the same. The refusal names
 * the variable of the later one.
 */
function assertDistinct(input: {
  legacyToken: string;
  legacyKeys: { keys: AppSigningKey[]; names: string[] };
  legacyUrl: string;
  extra: RegistryApp[];
  operatorToken: string | undefined;
}): void {
  const secrets: Array<{ name: string; value: string }> = [
    { name: "RUNNER_TOKEN", value: input.legacyToken },
  ];
  const kids = new Set<string>();
  const urls = new Set<string>([addressOf(input.legacyUrl)]);
  const claim = (name: string, value: string) => {
    if (secrets.some((other) => other.value === value))
      throw new ConfigError(name, "not_distinct");
    secrets.push({ name, value });
  };
  input.legacyKeys.keys.forEach((signing, index) => {
    const name = input.legacyKeys.names[index] ?? "DISPATCHER_SIGNING_SECRET";
    claim(name, signing.secret);
    if (kids.has(signing.kid)) throw new ConfigError(name, "not_distinct");
    kids.add(signing.kid);
  });
  for (const entry of input.extra) {
    const address = addressOf(entry.app.url);
    if (urls.has(address))
      throw new ConfigError(
        "DISPATCHER_APPS",
        "duplicate",
        `${entry.app.id}: url`,
      );
    urls.add(address);
    claim(entry.tokenVariable, entry.app.token);
    entry.keys.forEach((signing, index) => {
      const name = entry.keyVariables[index] ?? entry.tokenVariable;
      claim(name, signing.secret);
      if (kids.has(signing.kid))
        throw new ConfigError(
          "DISPATCHER_APPS",
          "duplicate",
          `${entry.app.id}: key id`,
        );
      kids.add(signing.kid);
    });
  }
  if (input.operatorToken !== undefined)
    claim("DISPATCHER_OPERATOR_TOKEN", input.operatorToken);
}

function operatorToken(env: Environment): string | undefined {
  if (read(env, "DISPATCHER_OPERATOR_TOKEN") === undefined) return undefined;
  return secret(env, "DISPATCHER_OPERATOR_TOKEN");
}

/** The cron secret: a secret of its own, so no other credential opens the reaper's route and it opens nothing else. */
function cronSecret(
  env: Environment,
  others: readonly string[],
): string | undefined {
  const value = read(env, "CRON_SECRET");
  if (value === undefined) return undefined;
  if (value.length < MIN_SECRET_LENGTH)
    throw new ConfigError("CRON_SECRET", "too_short");
  if (CONTROL_OR_SPACE.test(value))
    throw new ConfigError("CRON_SECRET", "invalid");
  if (others.includes(value))
    throw new ConfigError("CRON_SECRET", "not_distinct");
  return value;
}

function cronSecretOf(
  env: Environment,
  others: readonly string[],
): { cronSecret: string | undefined; cronSecretProblem?: ConfigError } {
  try {
    return { cronSecret: cronSecret(env, others) };
  } catch (error) {
    if (error instanceof ConfigError)
      return { cronSecret: undefined, cronSecretProblem: error };
    throw error;
  }
}

/** The engines the operator named, or undefined when `DISPATCHER_ENGINES` is not set. */
function namedEngines(env: Environment): Engine[] | undefined {
  const raw = read(env, "DISPATCHER_ENGINES");
  if (raw === undefined) return undefined;
  const names = raw.split(",").map((name) => name.trim());
  const unique = [...new Set(names)];
  if (
    !unique.every((name): name is Engine =>
      (ENGINES as readonly string[]).includes(name),
    )
  )
    throw new ConfigError("DISPATCHER_ENGINES", "invalid");
  return unique;
}

/** The engines this deployment serves: the named ones, else the default and `implementer` when an app of the registry has the kind. */
function enginesOf(
  named: Engine[] | undefined,
  registry: readonly RegistryApp[],
): Engine[] {
  if (named !== undefined) return named;
  const implementing = registry.some((entry) =>
    entry.app.kinds.includes("implementer"),
  );
  return implementing
    ? [...DEFAULT_ENGINES, "implementer"]
    : [...DEFAULT_ENGINES];
}

const memorySize = z.string().regex(/^[0-9]+[mg]$/);
const kindConfig = z.strictObject({
  container: z
    .strictObject({
      memory: z
        .strictObject({
          limit: memorySize.optional(),
          reservation: memorySize.optional(),
          swap: memorySize.optional(),
        })
        .optional(),
    })
    .optional(),
  launcher: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional(),
});
const workerConfig = z.strictObject({
  diff: kindConfig.optional(),
  dynamic: kindConfig.optional(),
  implementer: kindConfig
    .extend({
      timeoutSeconds: z
        .number()
        .int()
        .min(MIN_JOB_TIMEOUT_SECONDS)
        .max(MAX_JOB_TIMEOUT_SECONDS)
        .optional(),
    })
    .optional(),
});

type WorkerConfigs = {
  workerConfig: CoreSettings["workerConfig"];
  implementerTimeoutSeconds?: number;
};

/** The worker configuration per kind. The timeout of the Implementer is the core's, so it is not part of what a Launcher gets. */
function workerConfigs(env: Environment): WorkerConfigs {
  const raw = read(env, "DISPATCHER_WORKER_CONFIG");
  if (raw === undefined) return { workerConfig: { diff: {}, dynamic: {} } };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ConfigError("DISPATCHER_WORKER_CONFIG", "invalid");
  }
  const parsed = workerConfig.safeParse(json);
  if (!parsed.success)
    throw new ConfigError("DISPATCHER_WORKER_CONFIG", "invalid");
  const { diff, dynamic, implementer } = parsed.data;
  if (implementer === undefined)
    return { workerConfig: { diff: diff ?? {}, dynamic: dynamic ?? {} } };
  const { timeoutSeconds, ...launch } = implementer;
  return {
    workerConfig: {
      diff: diff ?? {},
      dynamic: dynamic ?? {},
      implementer: launch,
    },
    ...(timeoutSeconds === undefined
      ? {}
      : { implementerTimeoutSeconds: timeoutSeconds }),
  };
}

function poolId(env: Environment): string {
  const value = read(env, "DISPATCHER_POOL_ID") ?? "dispatcher";
  if (!POOL_ID.test(value))
    throw new ConfigError("DISPATCHER_POOL_ID", "invalid");
  return value;
}

export function loadSettings(env: Environment): Settings {
  const dispatcherToken = token(env);
  const legacy = legacySigningKeys(env);
  const named = namedEngines(env);
  const url = appUrl(env);
  const extra = registryApps(env);
  const configuredEngines = enginesOf(named, extra);
  const operator = operatorToken(env);
  // `POST /probe` starts canary VMs: with several apps no app's credential, the reviewer's included, may open it.
  if (extra.length > 0 && operator === undefined)
    throw new ConfigError(
      "DISPATCHER_OPERATOR_TOKEN",
      "required",
      "with DISPATCHER_APPS",
    );
  assertDistinct({
    legacyToken: dispatcherToken,
    legacyKeys: legacy,
    legacyUrl: url,
    extra,
    operatorToken: operator,
  });
  const reviewer: AppSettings = {
    id: LEGACY_APP_ID,
    url,
    token: dispatcherToken,
    poolId: poolId(env),
    maxRunning: integer(env, "DISPATCHER_MAX_RUNNING", { min: 1, max: 1000 }),
    // The kinds whose engine the deployment is configured to serve: with the default, both. Never `implementer` (#759),
    // whatever the engines say: only an app of the registry can be given that kind.
    kinds: REVIEWER_KINDS.filter((kind) =>
      configuredEngines.includes(ENGINE_BY_KIND[kind]),
    ),
  };
  if (reviewer.kinds.length === 0)
    throw new ConfigError("DISPATCHER_ENGINES", "invalid");
  const keys = [...legacy.keys, ...extra.flatMap((entry) => entry.keys)];
  // The literals are read by app/src/billing/hold.test.ts (the hold of the App follows this default).
  const jobTimeoutSeconds = integer(env, "DISPATCHER_JOB_TIMEOUT_SECONDS", {
    min: 60,
    max: 21600,
    fallback: 1200,
  });
  const configured = workerConfigs(env);
  return {
    core: {
      apps: [reviewer, ...extra.map((entry) => entry.app)],
      engines: configuredEngines,
      jobTimeoutSeconds,
      ...(configured.implementerTimeoutSeconds === undefined
        ? {}
        : { implementerTimeoutSeconds: configured.implementerTimeoutSeconds }),
      launchDeadlineSeconds: 300,
      workerConfig: configured.workerConfig,
    },
    ...cronSecretOf(env, [
      dispatcherToken,
      ...keys.map((signing) => signing.secret),
      ...extra.map((entry) => entry.app.token),
      ...(operator === undefined ? [] : [operator]),
    ]),
    signingKeys: keys,
    operatorToken: operator,
    shutdownGraceSeconds: integer(env, "DISPATCHER_SHUTDOWN_GRACE_SECONDS", {
      min: 0,
      max: 600,
      fallback: 60,
    }),
  };
}
