// SPDX-License-Identifier: LicenseRef-Proprietary

// Where this Dispatcher is reached from outside (#745, step 7): the address a VM's Control container calls to have its network
// policy narrowed (`POST /network`). `DISPATCHER_PUBLIC_URL` when the operator sets it; otherwise the production address the
// platform gives every deployment (`VERCEL_PROJECT_PRODUCTION_URL`, a host without a scheme). Neither: undefined, and the
// deployment has no network switch (the Worker reports that the VM's policy was not changed; the door still enforces the rule).
// The address is an origin and nothing more: the route is mounted at the root of this Dispatcher (`compose.ts`), so a path prefix
// would make every call of every turn go to a place that has no route. A configured path is refused at start-up instead.
import { ConfigError, read, type Environment } from "../config.ts";

export const NETWORK_ROUTE_PATH = "/network";

export function publicUrlOf(env: Environment): string | undefined {
  const configured = read(env, "DISPATCHER_PUBLIC_URL");
  if (configured !== undefined) {
    let url: URL;
    try {
      url = new URL(configured);
    } catch {
      throw new ConfigError("DISPATCHER_PUBLIC_URL", "invalid");
    }
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    )
      throw new ConfigError("DISPATCHER_PUBLIC_URL", "invalid");
    if (url.pathname !== "/")
      throw new ConfigError(
        "DISPATCHER_PUBLIC_URL",
        "invalid",
        "an origin without a path: the network route is served at the root",
      );
    return url.origin;
  }
  const production = read(env, "VERCEL_PROJECT_PRODUCTION_URL");
  if (production === undefined || !/^[a-z0-9.-]{3,253}$/i.test(production))
    return undefined;
  return `https://${production.toLowerCase()}`;
}
