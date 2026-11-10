// SPDX-License-Identifier: LicenseRef-Proprietary

// What vm-init reports on the guest's console while it boots (docker/vm/rootfs/vm-init): `VMINIT <name> uptime=<s> [key=value ...]`. The build
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
  /VMINIT ([a-z_]+) uptime=([0-9]+(?:\.[0-9]+)?)((?: [a-z_]+=\S*)*)\s*$/;

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
  for (const event of events)
    if (event.name === "check" && event.fields.result !== "ok")
      problems.push(`check ${event.fields.name ?? "?"} failed`);
  if (!events.some((event) => event.name === "check"))
    problems.push("check: none ran");
  if (!first("smoke_done")) problems.push("smoke_done: missing");
  else if (first("smoke_done")?.fields.ok !== "1")
    problems.push("smoke_done: ok=0");
  return { ok: problems.length === 0, problems };
}
