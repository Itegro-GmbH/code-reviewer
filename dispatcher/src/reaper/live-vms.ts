// SPDX-License-Identifier: LicenseRef-Proprietary

// The Dispatcher's own count of the job VMs that are up, per app (#730): one listing of the project's VMs, each checked with
// the reaper's rule (`shapeOf`) and counted for the app its `tenant` tag names (no tag: `reviewer`). A canary, a golden
// builder, a lookalike and a VM the platform is already ending are not counted. The core reuses the answer for a few seconds.
//
// Every listing that answers logs `fleet_listed` with `ms` (how long the platform took) and `count` (the VMs it returned,
// stopped ones included: they are what makes it slow, #802), so the margin to the claim's four seconds is visible. The
// core shares one listing between the claims of a few seconds, so this is at most one line per listing.
import type { LiveVmCounter, Logger } from "../core/types.ts";
import type { SandboxFleet } from "../launchers/sandbox-service.ts";
import { APP_TAG, NAME_PREFIX, isLive, shapeOf } from "./vm-shape.ts";

export function liveJobVmsByApp(
  fleet: Pick<SandboxFleet, "list">,
  options: { logger?: Logger; now?: () => number } = {},
): LiveVmCounter {
  const now = options.now ?? (() => Date.now());
  return async (signal) => {
    const startedAt = now();
    const listed = await fleet.list(
      { namePrefix: NAME_PREFIX, tags: { app: APP_TAG } },
      signal,
    );
    options.logger?.info("fleet_listed", {
      ms: now() - startedAt,
      count: listed.length,
    });
    const counts = new Map<string, number>();
    for (const vm of listed) {
      const shape = shapeOf(vm);
      if (shape?.kind !== "job" || !isLive(vm)) continue;
      counts.set(shape.appId, (counts.get(shape.appId) ?? 0) + 1);
    }
    return counts;
  };
}
