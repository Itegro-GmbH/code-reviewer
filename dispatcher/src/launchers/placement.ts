// SPDX-License-Identifier: LicenseRef-Proprietary

// Two platforms behind one port (#1158, epic #1157): a Dispatcher that has the Cloudflare configuration launches a hosted job on a Cloudflare Container
// and every other one on the Vercel Sandbox, with one Launcher, one stop route, one network switch and one reaper. The name of a Cloudflare VM carries
// the placement (`cr-<kind>-<job id>-cf-<8 hex>`, `cloudflareVmName`), so a call that has only a name reaches the right fleet without any memory
// of its own: this Dispatcher runs as a function that is gone after a request.
//
// Failures stay apart. A call for a Vercel VM never waits for Cloudflare, and a listing that asks both fleets still answers with Vercel's when
// Cloudflare cannot be listed (a warning is logged): a Cloudflare outage must not stop the reaper or the stop of the jobs of the platform that
// was here first. A Cloudflare VM that is missed that way ends by itself at its own timeout (the Worker destroys it), and the next listing finds it.
import type { Logger } from "../core/types.ts";
import type { NetworkPolicy } from "../network/rule.ts";
import type {
  ListFilter,
  ListedVm,
  Placement,
  SandboxCreateOptions,
  SandboxFleet,
  SandboxService,
} from "./sandbox-service.ts";

/** The marker of a Cloudflare VM in its name: `-cf-` and the eight hex characters of the suffix, at the end. */
const CLOUDFLARE_NAME = /-cf-[0-9a-f]{8}$/;

/** The unique part of a Cloudflare VM's name (`jobVmName` puts it last): `cf-` and the eight hex characters. */
export function cloudflareSuffix(suffix: string): string {
  return `cf-${suffix}`;
}

/** The placement a VM name carries: Cloudflare for the marker, Vercel for every other name (the canary's and a VM made before #1158 too). */
export function placementOfVmName(name: string): Placement {
  return CLOUDFLARE_NAME.test(name) ? "cloudflare" : "vercel";
}

export type PlacementPlatformOptions = {
  vercel: SandboxService & SandboxFleet;
  /** Absent: the Cloudflare placement is off and every call goes to Vercel, as before #1158. */
  cloudflare?: SandboxService & SandboxFleet;
  logger: Logger;
};

export function createPlacementPlatform(
  options: PlacementPlatformOptions,
): SandboxService & SandboxFleet {
  const { vercel, cloudflare, logger } = options;
  if (cloudflare === undefined) return vercel;
  const fleetOf = (name: string) =>
    placementOfVmName(name) === "cloudflare" ? cloudflare : vercel;
  return {
    create(createOptions: SandboxCreateOptions, signal) {
      return (
        createOptions.placement === "cloudflare" ? cloudflare : vercel
      ).create(createOptions, signal);
    },
    stop: (name) => fleetOf(name).stop(name),
    delete: (name) => fleetOf(name).delete(name),
    setNetworkPolicy: (name, policy: NetworkPolicy) =>
      fleetOf(name).setNetworkPolicy(name, policy),
    async list(filter: ListFilter, signal): Promise<readonly ListedVm[]> {
      const [fromVercel, fromCloudflare] = await Promise.allSettled([
        vercel.list(filter, signal),
        cloudflare.list(filter, signal),
      ]);
      // Vercel's failure is the failure of the listing, as it always was.
      if (fromVercel.status === "rejected") throw fromVercel.reason;
      if (fromCloudflare.status === "rejected") {
        logger.warn("cloudflare_list_failed", {
          code:
            typeof fromCloudflare.reason === "object" &&
            fromCloudflare.reason !== null &&
            "kind" in fromCloudflare.reason
              ? String(fromCloudflare.reason.kind)
              : "unknown",
        });
        return fromVercel.value;
      }
      return [...fromVercel.value, ...fromCloudflare.value];
    },
  };
}
