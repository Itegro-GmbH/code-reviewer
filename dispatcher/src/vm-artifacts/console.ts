// SPDX-License-Identifier: LicenseRef-Proprietary

// What vm-init reports on the guest's console while it boots (docker/vm/rootfs/vm-boot and vm-build-init): `VMINIT <name> uptime=<s> [key=value ...]`. The build
// and the smoke boot read the lines and decide from them (#976); the real vm-init (#977) reports the same milestones over vsock.

export type ConsoleEvent = {
  name: string;
  /** The guest's own uptime at the event, in seconds. */
  uptime: number;
  fields: Record<string, string>;
  /** Milliseconds since the Firecracker process started, taken on the host when the line was read. */
  hostMs?: number;
};

const EVENT =
  /VMINIT ([a-z_]+) uptime=([0-9]+(?:\.[0-9]+)?)((?: [a-z0-9_]+=\S*)*)\s*$/;

export function parseConsoleLine(line: string): ConsoleEvent | undefined {
  const match = EVENT.exec(line);
  if (!match) return undefined;
  const fields: Record<string, string> = {};
  for (const pair of (match[3] ?? "").trim().split(" ")) {
    const separator = pair.indexOf("=");
    if (separator > 0)
      fields[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return {
    name: match[1] ?? "",
    uptime: Number(match[2]),
    fields,
  };
}

/** What the guest's smoke mode must have run (docker/vm/rootfs/vm-build-init): a check that is absent counts as a failure. */
export const REQUIRED_CHECKS = [
  "root_read_only",
  "runc_container",
  "sysbox_container",
  "vsock_denied_agent",
  "vsock_allowed_control",
  "ia32_unavailable",
  "worker_probe",
] as const;

/**
 * The acceptance of the seed boot (it makes the data disk): the images were loaded and have an id, and the guest ended with `seed_done`, which it
 * says only after it stopped every daemon and took every mount of the disk down without an error. A `seed_failed` fails it whatever follows.
 */
export function evaluateSeed(events: readonly ConsoleEvent[]): SmokeVerdict {
  const problems: string[] = [];
  for (const failed of events.filter((event) => event.name === "seed_failed"))
    problems.push(
      `seed_failed: ${
        Object.entries(failed.fields)
          .map(([key, value]) => `${key}=${value}`)
          .join(" ") || "no reason"
      }`,
    );
  for (const failure of ["docker_failed", "sysbox_failed", "disk_failed"])
    if (events.some((event) => event.name === failure)) problems.push(failure);
  if (!events.some((event) => event.name === "seed_done"))
    problems.push("seed_done: missing");
  for (const role of ["worker", "agent"] as const) {
    const id = events.find(
      (event) => event.name === "image" && event.fields.role === role,
    )?.fields.id;
    if (!id || !/^sha256:[0-9a-f]{64}$/.test(id))
      problems.push(`image ${role}: no id`);
  }
  return { ok: problems.length === 0, problems };
}

export type SmokeOptions = {
  /** From the start of the Firecracker process to `docker_ready` (the spike measured 1.4 to 1.9 s on a nested-virtualization runner). */
  dockerReadyBudgetMs: number;
  /** The image ids the data disk was built with (the seed boot reported them). */
  expectedImages: { worker: string; agent: string };
};

export type SmokeVerdict = { ok: boolean; problems: string[] };

/** The acceptance of the smoke boot: dockerd ready in time, Sysbox ready, the data disk's images present, every check passed, and the guest finished. */
export function evaluateSmoke(
  events: readonly ConsoleEvent[],
  options: SmokeOptions,
): SmokeVerdict {
  const problems: string[] = [];
  const first = (name: string): ConsoleEvent | undefined =>
    events.find((event) => event.name === name);

  const docker = first("docker_ready");
  if (!docker) problems.push("docker_ready: missing");
  else {
    const ms = Math.round(docker.hostMs ?? docker.uptime * 1000);
    if (ms > options.dockerReadyBudgetMs)
      problems.push(
        `docker_ready: ${ms} ms is over the budget of ${options.dockerReadyBudgetMs} ms`,
      );
  }
  for (const failure of ["docker_failed", "sysbox_failed", "disk_failed"])
    if (first(failure)) problems.push(failure);
  if (!first("sysbox_ready")) problems.push("sysbox_ready: missing");

  for (const role of ["worker", "agent"] as const) {
    const seen = events.find(
      (event) => event.name === "image" && event.fields.role === role,
    );
    const wanted = options.expectedImages[role];
    if (!seen) problems.push(`image ${role}: missing`);
    else if (seen.fields.id !== wanted)
      problems.push(
        `image ${role}: ${seen.fields.id ?? ""} is not the data disk's ${wanted}`,
      );
  }
  // The decision of docs/runner.md ("The Docker image store"): the guest runs the containerd image store, as the hosted VM does.
  const store = first("store");
  if (!store) problems.push("store: missing");
  else if (!(store.fields.snapshotter ?? "").includes("containerd"))
    problems.push(
      `store: ${store.fields.snapshotter || "none"} is not the containerd image store`,
    );
  for (const required of REQUIRED_CHECKS)
    if (
      !events.some(
        (event) => event.name === "check" && event.fields.name === required,
      )
    )
      problems.push(`check ${required}: missing`);
  for (const event of events)
    if (event.name === "check" && event.fields.result !== "ok")
      problems.push(`check ${event.fields.name ?? "?"} failed`);
  if (!first("smoke_done")) problems.push("smoke_done: missing");
  else if (first("smoke_done")?.fields.ok !== "1")
    problems.push("smoke_done: ok=0");
  return { ok: problems.length === 0, problems };
}
