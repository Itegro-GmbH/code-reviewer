// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import {
  RELEASE_BOOT_ARGS,
  RELEASE_INIT_COMMAND,
  firecrackerConfig,
  kernelCommandLine,
} from "./boot.ts";
import {
  evaluateSmoke,
  parseConsoleLine,
  type ConsoleEvent,
} from "./console.ts";

const spec = {
  kernelPath: "/w/vmlinux",
  rootfsPath: "/w/rootfs.ext4",
  dataDiskPath: "/w/data.ext4",
  mode: "smoke" as const,
  vcpus: 2,
  memMib: 4096,
  console: true,
};

describe("the kernel command line", () => {
  // #976-T03
  it("boots the root file system read-only on the first drive with docker-init as PID 1 and vm-init after the --", () => {
    const line = kernelCommandLine({ ...spec, console: false });

    expect(line).toContain("root=/dev/vda ro rootfstype=ext4");
    expect(line).toContain("reboot=k");
    expect(line).toContain("init=/usr/bin/docker-init");
    expect(line.endsWith("-- /usr/local/sbin/vm-init")).toBe(true);
    expect(line).toContain("vm.mode=smoke");
  });

  // #976-T03
  it("has no console in a release (it costs 0.3 to 0.4 s of every boot) and one when asked for", () => {
    expect(RELEASE_BOOT_ARGS).toContain("8250.nr_uarts=0");
    expect(RELEASE_BOOT_ARGS).not.toContain("console=");
    expect(kernelCommandLine({ ...spec, console: false })).not.toContain(
      "console=ttyS0",
    );

    const withConsole = kernelCommandLine(spec);
    expect(withConsole).toContain("console=ttyS0");
    expect(withConsole).toContain("8250.nr_uarts=1");
    expect(withConsole).not.toContain("8250.nr_uarts=0");
    expect(withConsole).not.toContain("quiet");
  });

  it("puts the job's own parameters before the --, where the kernel reads them", () => {
    const line = kernelCommandLine(spec);

    expect(line.indexOf("vm.mode=smoke")).toBeLessThan(line.indexOf(" -- "));
    expect(RELEASE_INIT_COMMAND).toBe(
      "/usr/bin/docker-init -- /usr/local/sbin/vm-init",
    );
  });
});

describe("the Firecracker configuration", () => {
  it("has the root file system read-only, the data disk writable and no network", () => {
    const config = firecrackerConfig(spec);

    expect(config.drives).toEqual([
      {
        drive_id: "rootfs",
        path_on_host: "/w/rootfs.ext4",
        is_root_device: true,
        is_read_only: true,
      },
      {
        drive_id: "data",
        path_on_host: "/w/data.ext4",
        is_root_device: false,
        is_read_only: false,
      },
    ]);
    expect(config["network-interfaces"]).toEqual([]);
    expect(config["machine-config"]).toEqual({
      vcpu_count: 2,
      mem_size_mib: 4096,
      smt: false,
    });
    expect(config["boot-source"].kernel_image_path).toBe("/w/vmlinux");
  });

  it("adds the seed disk read-only as the third drive", () => {
    const config = firecrackerConfig({
      ...spec,
      mode: "seed",
      seedDiskPath: "/w/seed.ext4",
    });

    expect(config.drives[2]).toEqual({
      drive_id: "seed",
      path_on_host: "/w/seed.ext4",
      is_root_device: false,
      is_read_only: true,
    });
  });
});

describe("the events of vm-init on the console", () => {
  it("reads an event line with its fields", () => {
    expect(
      parseConsoleLine(
        "[    1.2] VMINIT check uptime=3.41 name=runc_container result=ok",
      ),
    ).toEqual({
      name: "check",
      uptime: 3.41,
      fields: { name: "runc_container", result: "ok" },
    });
  });

  it("ignores a console line that is not an event, and an event line it cannot read", () => {
    expect(
      parseConsoleLine(
        "VMINIT check uptime=7.5 name=worker_probe result=ok output_b64=eyJ4IjoxfQ==",
      )?.fields.output_b64,
    ).toBe("eyJ4IjoxfQ==");
    expect(parseConsoleLine("random kernel output VMINIT")).toBeUndefined();
    expect(parseConsoleLine("VMINIT docker_ready")).toBeUndefined();
    expect(parseConsoleLine("")).toBeUndefined();
  });
});

const ev = (
  name: string,
  uptime: number,
  fields: Record<string, string> = {},
): ConsoleEvent => ({ name, uptime, fields, hostMs: uptime * 1000 });

const WORKER = `sha256:${"a".repeat(64)}`;
const AGENT = `sha256:${"b".repeat(64)}`;
const good: ConsoleEvent[] = [
  ev("init_up", 0.9),
  ev("disk_ready", 1),
  ev("docker_ready", 1.9),
  ev("sysbox_ready", 2.3),
  ev("store", 2.4, {
    driver: "overlayfs",
    snapshotter: "io.containerd.snapshotter.v1",
  }),
  ev("image", 2.5, { role: "worker", tag: "w:golden", id: WORKER }),
  ev("image", 2.5, { role: "agent", tag: "a:golden", id: AGENT }),
  ev("check", 3, { name: "root_read_only", result: "ok" }),
  ev("check", 3, { name: "runc_container", result: "ok" }),
  ev("check", 4, { name: "sysbox_container", result: "ok" }),
  ev("check", 5, { name: "worker_probe", result: "ok", output_b64: "e30=" }),
  ev("smoke_done", 6, { ok: "1" }),
];
const options = {
  dockerReadyBudgetMs: 10_000,
  expectedImages: { worker: WORKER, agent: AGENT },
};

describe("the verdict of the smoke boot", () => {
  // #976-T03
  it("passes when dockerd is ready within the budget, Sysbox is ready, both images are the data disk's and every check passed", () => {
    expect(evaluateSmoke(good, options)).toEqual({ ok: true, problems: [] });
  });

  // #976-T03
  it("fails when dockerd was not ready, or not within the budget", () => {
    const never = good.filter((e) => e.name !== "docker_ready");
    const slow = good.map((e) =>
      e.name === "docker_ready" ? ev("docker_ready", 11) : e,
    );

    expect(evaluateSmoke(never, options).problems).toContain(
      "docker_ready: missing",
    );
    expect(evaluateSmoke(slow, options).problems).toContain(
      "docker_ready: 11000 ms is over the budget of 10000 ms",
    );
  });

  // #976-T03
  it("fails for docker_failed, sysbox_failed and a check that failed", () => {
    const bad = [
      ...good.filter((e) => e.name !== "docker_ready"),
      ev("docker_failed", 2),
      ev("check", 5, { name: "worker_probe", result: "fail", tail: "x" }),
    ];

    const result = evaluateSmoke(bad, options);

    expect(result.ok).toBe(false);
    expect(result.problems).toContain("docker_failed");
    expect(result.problems).toContain("check worker_probe failed");
  });

  // #976-T03
  it("fails when the images in the guest are not the ones the data disk was built with", () => {
    const result = evaluateSmoke(good, {
      ...options,
      expectedImages: { worker: WORKER, agent: `sha256:${"c".repeat(64)}` },
    });

    expect(result.problems).toEqual([
      `image agent: ${AGENT} is not the data disk's sha256:${"c".repeat(64)}`,
    ]);
  });

  // #976-T03
  it("fails when the guest never says it is done", () => {
    const cut = good.filter((e) => e.name !== "smoke_done");

    expect(evaluateSmoke(cut, options).problems).toContain(
      "smoke_done: missing",
    );
  });

  // #976-T03
  it("fails when the guest runs another image store than the hosted one's containerd store", () => {
    const overlay2 = good.map((e) =>
      e.name === "store"
        ? ev("store", 2.4, { driver: "overlay2", snapshotter: "" })
        : e,
    );

    expect(evaluateSmoke(overlay2, options).problems).toEqual([
      "store: none is not the containerd image store",
    ]);
  });

  // #976-T03
  it("fails when a check the guest must run never ran, the Worker's self-check among them", () => {
    const without = good.filter(
      (e) => !(e.name === "check" && e.fields.name === "worker_probe"),
    );

    expect(evaluateSmoke(without, options).problems).toEqual([
      "check worker_probe: missing",
    ]);
  });
});
