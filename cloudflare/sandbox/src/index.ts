// SPDX-License-Identifier: LicenseRef-Proprietary

// cr-sandbox (#1159, epic #1157): the Worker of the Cloudflare placement. `handler.ts` is the HTTP API of
// contracts/cf-sandbox.v1.json; one `CrSandboxVm` Durable Object and one Container per VM, one `CrSandboxRegistry` for listing and the cap.
import { readConfig } from "./config.ts";
import { handle } from "./handler.ts";
import { REGISTRY_NAME, type Env } from "./env.ts";

export { CrSandboxVm } from "./vm-do.ts";
export { CrSandboxRegistry } from "./registry-do.ts";
export { Door } from "./door.ts";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, {
      config: readConfig(env),
      token: env.CF_SANDBOX_TOKEN,
      registry: env.REGISTRY.getByName(REGISTRY_NAME),
      vm: (name) => env.VM.getByName(name),
      now: () => Date.now(),
    });
  },
} satisfies ExportedHandler<Env>;
