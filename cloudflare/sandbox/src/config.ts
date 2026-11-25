// SPDX-License-Identifier: LicenseRef-Proprietary

// What the Worker is configured with (wrangler.jsonc `vars`, the build's `--var` flags and the secret), read once per request.
// Adding a larger instance type later is configuration only: name it in INSTANCE_TYPES and, when it is not one of Cloudflare's own
// types, give its resources in CUSTOM_INSTANCE_TYPES.
export interface Config {
  instanceTypes: string[];
  customInstanceTypes: Record<
    string,
    { vcpu: number; memoryMib: number; diskMb: number }
  >;
  maxVms: number;
  imageVersion: string;
  workerFeatures: string[];
  workerImageId: string | null;
  agentImageId: string | null;
}

export interface ConfigEnv {
  INSTANCE_TYPES?: string;
  CUSTOM_INSTANCE_TYPES?: string;
  MAX_VMS?: string;
  IMAGE_VERSION?: string;
  WORKER_FEATURES?: string;
  WORKER_IMAGE_ID?: string;
  AGENT_IMAGE_ID?: string;
}

export const DEFAULT_INSTANCE_TYPES = ["standard-4"];
export const DEFAULT_MAX_VMS = 8;
const TYPE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const FEATURE = /^[a-z][a-z0-9_]{0,63}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

/** The list the Dispatcher's `parseWorkerFeatures` reads: comma separated, `none` or empty is the empty list, anything malformed is the empty list too (fail closed). */
export function parseFeatures(value: string | undefined): string[] {
  const text = (value ?? "").trim();
  if (text === "" || text === "none") return [];
  const names = text.split(",").map((name) => name.trim());
  if (names.length > 64 || names.some((name) => !FEATURE.test(name))) return [];
  return [...new Set(names)].sort();
}

function parseTypes(value: string | undefined): string[] {
  const names = (value ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  if (names.length === 0 || names.some((name) => !TYPE_NAME.test(name)))
    return DEFAULT_INSTANCE_TYPES;
  return [...new Set(names)];
}

function parseCustom(value: string | undefined): Config["customInstanceTypes"] {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return {};
    const out: Config["customInstanceTypes"] = {};
    for (const [name, spec] of Object.entries(parsed)) {
      const s = spec as {
        vcpu?: unknown;
        memoryMib?: unknown;
        diskMb?: unknown;
      };
      if (
        !TYPE_NAME.test(name) ||
        !Number.isInteger(s.vcpu) ||
        !Number.isInteger(s.memoryMib) ||
        !Number.isInteger(s.diskMb)
      )
        return {};
      out[name] = {
        vcpu: s.vcpu as number,
        memoryMib: s.memoryMib as number,
        diskMb: s.diskMb as number,
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function readConfig(env: ConfigEnv): Config {
  const max = Number(env.MAX_VMS);
  return {
    instanceTypes: parseTypes(env.INSTANCE_TYPES),
    customInstanceTypes: parseCustom(env.CUSTOM_INSTANCE_TYPES),
    maxVms:
      Number.isInteger(max) && max >= 1 && max <= 200 ? max : DEFAULT_MAX_VMS,
    imageVersion:
      env.IMAGE_VERSION && env.IMAGE_VERSION.length <= 64
        ? env.IMAGE_VERSION
        : "unknown",
    workerFeatures: parseFeatures(env.WORKER_FEATURES),
    workerImageId:
      env.WORKER_IMAGE_ID && IMAGE_ID.test(env.WORKER_IMAGE_ID)
        ? env.WORKER_IMAGE_ID
        : null,
    agentImageId:
      env.AGENT_IMAGE_ID && IMAGE_ID.test(env.AGENT_IMAGE_ID)
        ? env.AGENT_IMAGE_ID
        : null,
  };
}

/** The `instance` option of `container.start()`: Cloudflare's own type name, or the resources of a custom one. */
export function instanceOption(
  config: Config,
  name: string,
): string | { vcpu: number; memoryMib: number; diskMb: number } {
  return config.customInstanceTypes[name] ?? name;
}
