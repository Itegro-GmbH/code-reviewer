// SPDX-License-Identifier: LicenseRef-Proprietary

// The Cloudflare placement from the environment (#1158, epic #1157). Names only; a refusal names the variable and never the value.
//
// | Variable                    | Meaning                                                                                              | Default |
// |-----------------------------|------------------------------------------------------------------------------------------------------|---------|
// | CF_SANDBOX_URL              | The address of the Worker `cr-sandbox`: `https://host`, no path, query or credentials                  | none |
// | CF_SANDBOX_TOKEN            | The bearer token of its API (a secret, at least 32 characters, no space)                               | none |
// | CF_SANDBOX_INSTANCE_TYPES   | A map from a size in vCPUs to the Cloudflare instance type that runs it, `4=standard-4,8=custom-8:32768` (`:<MiB>`: its memory, #1178) | none |
// | CF_SANDBOX_SYSBOX_PROOF     | The Sysbox verdict of the Cloudflare image (`proven` or `unproven`): `unproven` keeps the Implementer out | `proven` |
//
// **All three of the first set or none.** With none the Dispatcher is as it was before #1158: it has no Cloudflare client, never names the
// claim feature `placement_cloudflare` and so never takes a job of that placement. One of them without the others is a mistake, not "off", and
// refuses the start: a Dispatcher that takes no Cloudflare job would look healthy. A larger size is a new entry of the map (`8=<type>:<MiB>`), nothing else.
import { ConfigError, read, type Environment } from "../config.ts";
import { claimFeaturesForPlacements } from "../core/claim-features.ts";
import type { KnownClaimFeature } from "../contracts/runner-api.ts";
import {
  createCfSandboxService,
  type CfHealth,
  type CfSandboxClient,
} from "./cf-sandbox.ts";
import type { CloudflarePlacement, SysboxProof } from "./sandbox.ts";

const PLAIN = /^[^\s\p{Cc}]+$/u;
const MIN_TOKEN_LENGTH = 32;
const INSTANCE_TYPE = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** The memory of an entry, in MiB (#1178): digits only, 1024 (the least the agent needs by itself) to 1,048,575. */
const MEMORY_MIB = /^[0-9]{4,7}$/;
const MIN_MEMORY_MIB = 1024;
/**
 * The memory of the instance types Cloudflare has that the Dispatcher knows (#1178): standard-4 is 4 vCPU / 12 GiB / 20 GB. A custom type names its memory in its
 * entry (`8=custom-8:32768`, the `memoryMib` of the Worker's `CUSTOM_INSTANCE_TYPES`; the two are one figure kept in two places).
 */
const KNOWN_INSTANCE_MEMORY_MIB: Readonly<Record<string, number>> = {
  "standard-4": 12288,
};
/** The sizes an environment may name (`environmentVcpus` of contracts/environment-sizes.v1.json): 1 vCPU leaves the agent no memory. */
const SIZES = [2, 4, 6, 8] as const;

/** How long a health answer is believed. The claim reads it for every poll, so it is short and cached. */
export const CLOUDFLARE_HEALTH_TTL_MS = 30_000;
/** How long a failed health read is remembered, so a Worker that is down does not make every claim wait for its timeout. */
export const CLOUDFLARE_HEALTH_FAILURE_TTL_MS = 10_000;

export type CloudflareFromEnvironment = {
  client: CfSandboxClient;
  /** What the Launcher needs (`createSandboxLauncher`): the cached health, the sizes and the Sysbox verdict. */
  placement: CloudflarePlacement;
  /** The cached health: the Worker's answer when it is usable (an image id, an instance type the Dispatcher has), else undefined. */
  health(): Promise<CfHealth | undefined>;
  /**
   * The claim features of this Dispatcher given those of its golden snapshot (`claimFeaturesForPlacements`), for every claim: the placement is named while
   * the Worker answers usably, and an image-gated feature only when both images list it.
   */
  claimFeatures(
    vercel: readonly KnownClaimFeature[],
  ): () => Promise<readonly KnownClaimFeature[]>;
  /** The token, for the logger's masker. */
  secrets: string[];
};

function parseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError("CF_SANDBOX_URL", "invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== "/" ||
    !PLAIN.test(value)
  )
    throw new ConfigError("CF_SANDBOX_URL", "invalid");
  return url.origin;
}

/**
 * The sizes with their instance type and memory. An entry is `<vCPUs>=<type>` or `<vCPUs>=<type>:<MiB>`: the old form stays valid. Without a memory the type's
 * is the table's (standard-4), else 2048 MiB per vCPU, the cautious figure of before #1178 (an operator who names no memory for a bigger type gets less than it has).
 */
function parseInstanceTypes(value: string): {
  types: Map<number, string>;
  memoryMb: Map<number, number>;
} {
  const types = new Map<number, string>();
  const memoryMb = new Map<number, number>();
  for (const entry of value.split(",")) {
    const [size, spelled, ...more] = entry
      .split("=")
      .map((part) => part.trim());
    const [type, memory, ...extra] = (spelled ?? "")
      .split(":")
      .map((part) => part.trim());
    if (
      size === undefined ||
      type === undefined ||
      more.length > 0 ||
      extra.length > 0 ||
      !/^[0-9]{1,2}$/.test(size) ||
      !(SIZES as readonly number[]).includes(Number(size)) ||
      !INSTANCE_TYPE.test(type) ||
      (memory !== undefined &&
        (!MEMORY_MIB.test(memory) || Number(memory) < MIN_MEMORY_MIB)) ||
      types.has(Number(size))
    )
      throw new ConfigError("CF_SANDBOX_INSTANCE_TYPES", "invalid");
    types.set(Number(size), type);
    memoryMb.set(
      Number(size),
      memory !== undefined
        ? Number(memory)
        : (KNOWN_INSTANCE_MEMORY_MIB[type] ?? Number(size) * 2048),
    );
  }
  return { types, memoryMb };
}

/**
 * The Cloudflare placement, or undefined when none of the three variables is set. `fetch` and `now` are for a test.
 */
export function cloudflareFromEnvironment(
  env: Environment,
  options: { fetch?: typeof fetch; now?: () => number } = {},
): CloudflareFromEnvironment | undefined {
  const url = read(env, "CF_SANDBOX_URL");
  const token = read(env, "CF_SANDBOX_TOKEN");
  const types = read(env, "CF_SANDBOX_INSTANCE_TYPES");
  if (url === undefined && token === undefined && types === undefined)
    return undefined;
  // One or two of the three is a mistake, not "off".
  if (url === undefined) throw new ConfigError("CF_SANDBOX_URL", "required");
  if (token === undefined)
    throw new ConfigError("CF_SANDBOX_TOKEN", "required");
  if (types === undefined)
    throw new ConfigError("CF_SANDBOX_INSTANCE_TYPES", "required");
  const baseUrl = parseUrl(url);
  if (token.length < MIN_TOKEN_LENGTH || !PLAIN.test(token))
    throw new ConfigError("CF_SANDBOX_TOKEN", "invalid");
  const { types: instanceTypes, memoryMb } = parseInstanceTypes(types);
  const proof = read(env, "CF_SANDBOX_SYSBOX_PROOF");
  if (proof !== undefined && proof !== "proven" && proof !== "unproven")
    throw new ConfigError("CF_SANDBOX_SYSBOX_PROOF", "invalid");
  const sysboxProof: SysboxProof = proof === "unproven" ? "unproven" : "proven";

  const client = createCfSandboxService({
    baseUrl,
    token,
    instanceTypes,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const now = options.now ?? (() => Date.now());
  const configuredTypes = new Set(instanceTypes.values());

  let cached: { until: number; value: CfHealth | undefined } | undefined;
  async function health(): Promise<CfHealth | undefined> {
    if (cached !== undefined && cached.until > now()) return cached.value;
    let value: CfHealth | undefined;
    try {
      const answer = await client.health();
      // Usable only with an image id to check the VM against and a type the Dispatcher has: otherwise no job could be launched.
      value =
        answer.workerImageId !== undefined &&
        answer.instanceTypes.some((type) => configuredTypes.has(type))
          ? answer
          : undefined;
    } catch {
      value = undefined;
    }
    cached = {
      until:
        now() +
        (value === undefined
          ? CLOUDFLARE_HEALTH_FAILURE_TTL_MS
          : CLOUDFLARE_HEALTH_TTL_MS),
      value,
    };
    return value;
  }

  return {
    client,
    health,
    placement: {
      health,
      sizes: [...instanceTypes.keys()].sort((a, b) => a - b),
      memoryMb,
      sysboxProof,
    },
    claimFeatures: (vercel) => async () => {
      const current = await health();
      return claimFeaturesForPlacements(
        vercel,
        current?.workerFeatures,
        current !== undefined,
      );
    },
    secrets: [token],
  };
}
