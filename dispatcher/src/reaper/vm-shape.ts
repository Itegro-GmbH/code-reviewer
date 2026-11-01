// SPDX-License-Identifier: LicenseRef-Proprietary

// Which listed VMs are ours (#364). The reaper may stop a VM only when it has exactly the shape of one the
// Sandbox-Launcher (#329) or the capability probe's canary (#331) creates; the platform's own filter (a name prefix and
// one tag) only narrows the listing and is never the check. Everything else in the project is not ours: the golden
// snapshot's builder and check VMs (they carry the same `app` tag, a `role` tag and `code-reviewer-golden-` names),
// another deployment's VMs, a person's. A VM that does not match is not touched, not asked about and not logged by name.
import { KNOWN_KINDS, LEGACY_APP_ID } from "../core/types.ts";
import type { ListedVm } from "../launchers/sandbox-service.ts";

/** The tag every VM of ours carries, and the one the listing is narrowed by. */
export const APP_TAG = "code-reviewer";
/**
 * The tag that names the app a job VM belongs to (#730): the id of the registry entry that claimed the job. A VM without it
 * was created before the Dispatcher served several apps, when `reviewer` was the only one.
 */
export const TENANT_TAG = "tenant";
/** The name prefix of every VM of ours (job VMs and canaries); the listing is narrowed by it. */
export const NAME_PREFIX = "cr-";

// The kinds are the Dispatcher's own list, so a kind that is served can always be stopped and reaped (#759).
const JOB_NAME = new RegExp(
  `^cr-(${KNOWN_KINDS.join("|")})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-[0-9a-f]{8}$`,
);
const CANARY_NAME = /^cr-canary-[0-9a-f]{8}$/;

export type VmShape =
  /**
   * The VM of one job; its job id is the one in the name and in the `job` tag. `appId` is the app its `tenant` tag names
   * (`reviewer` when there is none); it may name an app this Dispatcher does not serve, which callers treat as not theirs.
   */
  | { kind: "job"; jobId: string; appId: string }
  /** The VM of one capability probe: no job. */
  | { kind: "canary" };

/** What a listed VM is, or null when it is not one of ours. */
export function shapeOf(vm: ListedVm): VmShape | null {
  if (vm.tags.app !== APP_TAG) return null;
  // Ours are created `persistent: false`; the golden builder is persistent. A persistent VM is never ours to stop.
  if (vm.persistent === true) return null;
  const job = JOB_NAME.exec(vm.name);
  if (job !== null) {
    const [, kind, jobId] = job;
    return vm.tags.kind === kind && vm.tags.job === jobId && jobId !== undefined
      ? { kind: "job", jobId, appId: vm.tags[TENANT_TAG] ?? LEGACY_APP_ID }
      : null;
  }
  if (CANARY_NAME.test(vm.name))
    return vm.tags.kind === "canary" &&
      vm.tags.job === "canary" &&
      vm.tags.role === undefined
      ? { kind: "canary" }
      : null;
  return null;
}

/** A VM that is up or coming up; a VM the platform is already ending is left alone. */
export function isLive(vm: ListedVm): boolean {
  return vm.status === "running" || vm.status === "pending";
}
