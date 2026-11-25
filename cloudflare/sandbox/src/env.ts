// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ConfigEnv } from "./config.ts";
import type { CrSandboxRegistry } from "./registry-do.ts";
import type { CrSandboxVm } from "./vm-do.ts";

/** The bindings of wrangler.jsonc, the secret and the build's variables. */
export interface Env extends ConfigEnv {
  VM: DurableObjectNamespace<CrSandboxVm>;
  REGISTRY: DurableObjectNamespace<CrSandboxRegistry>;
  /** `wrangler secret put CF_SANDBOX_TOKEN`, at least 32 characters. */
  CF_SANDBOX_TOKEN?: string;
}

export const REGISTRY_NAME = "global";
