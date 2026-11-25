// SPDX-License-Identifier: LicenseRef-Proprietary

// The clocks of a VM, as pure functions: when the Durable Object's alarm next runs, when a VM is overdue, which VMs a listing holds.
import type { ListFilter, Tags } from "./validate.ts";

/** The alarm runs this often: it is the activity that keeps a Container up (code inside the Container is not), and a silent job needs it. */
export const ALARM_INTERVAL_MS = 45_000;
/** The Container's inactivity timeout, set at every start and again whenever the Durable Object restarts (spike finding): above the alarm interval. */
export const INACTIVITY_TIMEOUT_MS = 120_000;
/** How long `POST /v1/vms` may take in all (boot, CA, image load) before the VM is given up. */
export const BOOT_TIMEOUT_MS = 290_000;
/** The registry sweeps this often. */
export const SWEEP_INTERVAL_MS = 5 * 60_000;
/** A VM that is still `pending` this long was never finished (the caller or the Worker died): it is destroyed. */
export const PENDING_MAX_MS = 10 * 60_000;
/** The registry destroys a VM this long after its own deadline, the second line behind the VM's own alarm. */
export const OVERDUE_GRACE_MS = 5 * 60_000;

export type AlarmPlan =
  { action: "destroy" } | { action: "keep"; atMs: number };

/** At the deadline the VM is destroyed; before it the alarm runs again after the interval, or at the deadline when that is sooner. */
export function planAlarm(
  nowMs: number,
  deadlineMs: number,
  intervalMs: number = ALARM_INTERVAL_MS,
): AlarmPlan {
  if (nowMs >= deadlineMs) return { action: "destroy" };
  return { action: "keep", atMs: Math.min(nowMs + intervalMs, deadlineMs) };
}

export type VmStatus = "pending" | "running";

export type VmEntry = {
  name: string;
  instanceType: string;
  createdAtMs: number;
  status: VmStatus;
  timeoutMs: number;
  tags: Tags;
};

export function matchesFilter(entry: VmEntry, filter: ListFilter): boolean {
  if (!entry.name.startsWith(filter.namePrefix)) return false;
  if (filter.tag === null) return true;
  return entry.tags[filter.tag.key] === filter.tag.value;
}

/** The entries the registry itself ends: pending for too long, or past their deadline by the grace. */
export function overdueEntries(
  entries: readonly VmEntry[],
  nowMs: number,
): VmEntry[] {
  return entries.filter((entry) => {
    if (
      entry.status === "pending" &&
      nowMs - entry.createdAtMs > PENDING_MAX_MS
    )
      return true;
    return nowMs > entry.createdAtMs + entry.timeoutMs + OVERDUE_GRACE_MS;
  });
}
