// SPDX-License-Identifier: LicenseRef-Proprietary

// Finds the VMs of one job (#487). The App tells the Dispatcher that a job's claim has ended; the Dispatcher stops the
// VMs it created for that job and nothing else. The job id is a UUID the route has already validated, and it is used
// only inside a name prefix of our own naming scheme (`cr-<kind>-<job id>-`, launchers/sandbox.ts) together with the tag
// the Launcher puts on every VM. The platform's listing only narrows: every VM it returns is checked again with the
// reaper's rule (`shapeOf`), so a VM that is not exactly one of our job VMs of this job, a canary, a persistent VM,
// a lookalike or one the platform is already ending is never returned. With several apps (#730) a VM is returned only to
// the app its `tenant` tag names (no tag: `reviewer`): a stop signed by one app can never end a VM of another.
import { KNOWN_KINDS, LEGACY_APP_ID, REVIEWER_KINDS } from "../core/types.ts";
import type { SandboxFleet } from "../launchers/sandbox-service.ts";
import { APP_TAG, isLive, shapeOf } from "../reaper/vm-shape.ts";

export class StopLookupError extends Error {
  readonly code = "STOP_LIST_FAILED";

  constructor() {
    super("STOP_LIST_FAILED");
    this.name = "StopLookupError";
  }
}

/**
 * The kinds a VM of the app `appId` can have. The app `reviewer` never has `implementer` (#759): listing its prefix could
 * never find a VM, only fail. Any other app gets every kind, not the kinds it has now: its list may have been narrowed
 * since a VM started, and that VM must still be stopped. A VM an older Dispatcher started is named like one of these.
 */
function kindsOf(appId: string): readonly (typeof KNOWN_KINDS)[number][] {
  return appId === LEGACY_APP_ID ? REVIEWER_KINDS : KNOWN_KINDS;
}

/** The names of the live VMs of `jobId` that this Dispatcher's Launcher created for the app `appId`. */
export async function findJobVms(
  fleet: Pick<SandboxFleet, "list">,
  jobId: string,
  appId: string,
): Promise<string[]> {
  const id = jobId.toLowerCase();
  const names = new Set<string>();
  try {
    for (const kind of kindsOf(appId)) {
      const listed = await fleet.list({
        namePrefix: `cr-${kind}-${id}-`,
        tags: { app: APP_TAG },
      });
      for (const vm of listed) {
        const shape = shapeOf(vm);
        if (
          shape?.kind === "job" &&
          shape.jobId === id &&
          shape.appId === appId &&
          vm.tags.kind === kind &&
          isLive(vm)
        )
          names.add(vm.name);
      }
    }
  } catch {
    // The platform's own text is not ours to keep.
    throw new StopLookupError();
  }
  return [...names];
}
