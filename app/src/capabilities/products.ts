// SPDX-License-Identifier: LicenseRef-Proprietary

// The products this codebase is deployed as, and which capabilities each may have (#731). `PRODUCT_CAPABILITIES`
// can only narrow `allowed`; unset, a product gets its `default`, so the deployment that exists today (code-review.com)
// needs no new setting. The `allowed` list is the code wall: `implementer` is allowed by `factory` only and is in no
// `default`, so an unset `PRODUCT_CAPABILITIES` never turns it on and no setting can make code-review.com start it (#747).
import {
  CAPABILITIES,
  createCapabilitySet,
  isCapability,
  requiredCapability,
  type Capability,
  type CapabilitySet,
} from "./capability.ts";

export const PRODUCT_IDS = ["code-review-com", "factory"] as const;
export type ProductId = (typeof PRODUCT_IDS)[number];

export const DEFAULT_PRODUCT_ID: ProductId = "code-review-com";

type ProductDefinition = {
  allowed: readonly Capability[];
  default: readonly Capability[];
};

export const PRODUCTS: Readonly<Record<ProductId, ProductDefinition>> = {
  "code-review-com": {
    allowed: ["review", "dynamic-review", "billing"],
    default: ["review", "dynamic-review", "billing"],
  },
  factory: {
    allowed: ["review", "dynamic-review", "billing", "implementer"],
    default: ["review", "dynamic-review"],
  },
};

/** The capability every capability set contains. */
const ALWAYS_NEEDED: Capability = "review";

export const PRODUCT_ENV = "PRODUCT_ID";
export const CAPABILITIES_ENV = "PRODUCT_CAPABILITIES";

type Env = Readonly<Record<string, string | undefined>>;

export type CapabilityConfig =
  | { ok: true; product: ProductId; capabilities: CapabilitySet }
  | { ok: false; problems: string[] };

function isProductId(value: string): value is ProductId {
  return (PRODUCT_IDS as readonly string[]).includes(value);
}

/**
 * The product and capability set the environment asks for, or what is wrong with it. The problems name the
 * variables and, for a capability that exists but is not allowed here, its name; a value that is not a known name is
 * never repeated (a variable that holds something else must not end up in a log).
 */
export function resolveCapabilityConfig(env: Env): CapabilityConfig {
  const problems: string[] = [];
  const productValue = env[PRODUCT_ENV]?.trim() ?? "";
  let product = DEFAULT_PRODUCT_ID;
  if (productValue !== "") {
    if (isProductId(productValue)) product = productValue;
    else
      problems.push(
        `${PRODUCT_ENV} is not a product of this codebase (known: ${PRODUCT_IDS.join(", ")})`,
      );
  }
  const definition = PRODUCTS[product];

  const listValue = env[CAPABILITIES_ENV]?.trim() ?? "";
  if (listValue === "") {
    return problems.length > 0
      ? { ok: false, problems }
      : {
          ok: true,
          product,
          capabilities: createCapabilitySet(definition.default),
        };
  }

  const chosen = new Set<Capability>();
  let emptyEntry = false;
  for (const raw of listValue.split(",")) {
    const name = raw.trim();
    if (name === "") {
      if (!emptyEntry)
        problems.push(
          `${CAPABILITIES_ENV} has an empty entry (a stray comma?); name the capabilities as a comma-separated list`,
        );
      emptyEntry = true;
      continue;
    }
    if (!isCapability(name)) {
      problems.push(
        `${CAPABILITIES_ENV} names a capability that does not exist (known: ${CAPABILITIES.join(", ")})`,
      );
      continue;
    }
    if (!definition.allowed.includes(name)) {
      problems.push(
        `${CAPABILITIES_ENV} names "${name}", which product ${product} does not allow (allowed: ${definition.allowed.join(", ")})`,
      );
      continue;
    }
    chosen.add(name);
  }
  let reviewReported = false;
  for (const capability of chosen) {
    const needed = requiredCapability(capability);
    if (needed !== undefined && !chosen.has(needed)) {
      problems.push(
        `${CAPABILITIES_ENV} has "${capability}" but not "${needed}", which it needs`,
      );
      if (needed === ALWAYS_NEEDED) reviewReported = true;
    }
  }
  // Every deployment reviews; the other capabilities are additions to it.
  if (chosen.size > 0 && !chosen.has(ALWAYS_NEEDED) && !reviewReported)
    problems.push(
      `${CAPABILITIES_ENV} does not name "${ALWAYS_NEEDED}", which every deployment needs`,
    );
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, product, capabilities: createCapabilitySet(chosen) };
}

/** The problems of the settings, for the check at start (src/deploy/startup.ts). Empty when they are fine. */
export function capabilityConfigProblems(env: Env): string[] {
  const config = resolveCapabilityConfig(env);
  return config.ok ? [] : config.problems;
}
