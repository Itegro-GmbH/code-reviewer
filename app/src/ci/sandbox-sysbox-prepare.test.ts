// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down docker/sandbox/sysbox-prepare.sh (plan implementer-sandbox, step 2): the boot steps that make a Sandbox VM able to
// run a Sysbox container. Whether they work on a real VM is the golden snapshot's own proof (dispatcher/src/snapshot,
// `sysboxProbeScript`); here the script runs against stand-ins for the tools and the kernel's files in a temporary directory,
// and what must not drift is fixed: the order of the steps, that each failure has its own name and exit status, that a second
// run leaves a running pair alone, and that nothing is changed that is not needed.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const path = `${repoRoot}docker/sandbox/sysbox-prepare.sh`;
const script = readFileSync(path, "utf8");
const code = script
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");

describe("docker/sandbox/sysbox-prepare.sh", () => {
  it("is executable and stops on any error", () => {
    expect(statSync(path).mode & 0o111).not.toBe(0);
    expect(script.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    expect(code).toContain("set -euo pipefail");
  });

  it("holds no secret and no host-specific name", () => {
    expect(script).not.toMatch(/token|secret|password|credential/i);
  });

  it("does not touch the cgroup layout vm-prepare.sh made: it only reads it", () => {
    expect(code).not.toMatch(/>\s*"?\$cgroup_root/);
    expect(code).not.toContain("cgroup.procs");
  });
});

type Fixture = {
  dir: string;
  env: Record<string, string>;
  file: (name: string) => string;
};

describe("docker/sandbox/sysbox-prepare.sh against stand-ins", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const dir of roots.splice(0)) {
      // The stand-in daemons are background processes of the test: they are ended with it.
      const pids = join(dir, "pids");
      if (existsSync(pids))
        for (const pid of readFileSync(pids, "utf8").split("\n"))
          if (pid !== "") spawnSync("kill", [pid], { stdio: "ignore" });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function stand(bin: string, name: string, body: string) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }

  /**
   * A VM that vm-prepare.sh has prepared: the cgroup root with its controllers, a tun device, the mounts of the platform
   * over /proc/kcore and /proc/keys, and a Docker that lists the runtime. `daemons: false` leaves out the stand-in of one.
   */
  function fixture(
    options: {
      omit?: string;
      controllers?: string;
      mounts?: string;
      daemonReady?: { mgr?: boolean; fs?: boolean };
      /** The manager answers only after the script has waited this many times (its `sleep 0.1`), and the waits are counted in `sleeps`. */
      mgrAfterWaits?: number;
      runtimes?: string;
    } = {},
  ): Fixture {
    const dir = mkdtempSync(join(tmpdir(), "sysbox-prepare-"));
    roots.push(dir);
    const bin = join(dir, "bin");
    const run = join(dir, "run");
    mkdirSync(bin);
    mkdirSync(run);
    mkdirSync(join(dir, "cgroup"));
    mkdirSync(join(dir, "log"));
    mkdirSync(join(dir, "running"));
    const file = (name: string) => join(dir, name);
    writeFileSync(
      file("cgroup/cgroup.subtree_control"),
      `${options.controllers ?? "cpuset cpu io memory pids"}\n`,
    );
    writeFileSync(file("tun"), "");
    chmodSync(file("tun"), 0o600);
    writeFileSync(
      file("mountinfo"),
      options.mounts ??
        "30 25 0:6 / /proc/kcore ro,relatime - devtmpfs devtmpfs ro\n31 25 0:6 / /proc/keys ro,relatime - devtmpfs devtmpfs ro\n32 25 0:7 / /proc/sys rw - proc proc rw\n",
    );
    writeFileSync(
      file("sysctl.conf"),
      "fs.inotify.max_user_watches = 1048576\n",
    );

    // The tools that change the machine record what they are asked and do nothing else.
    stand(
      bin,
      "umount",
      `echo "umount $*" >> "${dir}/calls"; if [ -f "${dir}/umount-fails" ]; then exit 32; fi; for node in "$@"; do grep -v " $node " "${dir}/mountinfo" > "${dir}/mountinfo.new"; mv "${dir}/mountinfo.new" "${dir}/mountinfo"; done`,
    );
    stand(
      bin,
      "sysctl",
      `echo "sysctl $*" >> "${dir}/calls"; if [ -f "${dir}/sysctl-fails" ]; then exit 255; fi; if [ -f "${dir}/sysctl-write-fails" ] && [ "$2" = "-w" ]; then exit 255; fi`,
    );
    stand(
      bin,
      "docker",
      `echo "docker $*" >> "${dir}/calls"; echo '${options.runtimes ?? '{"runc":{},"sysbox-runc":{}}'}'`,
    );
    stand(bin, "pgrep", `[ -f "${dir}/running/$2" ]`);
    // A daemon: marks itself running (what the stand-in pgrep answers from), records its start and, when it is ready, owns a socket.
    const daemon = (name: string, socket: string, ready: boolean) =>
      stand(
        bin,
        name,
        `echo "start ${name}" >> "${dir}/calls"; touch "${dir}/running/${name}"
${ready ? `python3 -c 'import socket, sys, time; s = socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); time.sleep(30)' "${run}/${socket}" &` : "sleep 30 &"}
echo $! >> "${dir}/pids"
wait`,
      );
    if (options.mgrAfterWaits !== undefined) {
      // The wait of the script, counted instead of slept; the manager binds its socket once the count has been reached.
      stand(
        bin,
        "sleep",
        `if [ "$1" != 0.1 ]; then exec /bin/sleep "$@"; fi
echo wait >> "${dir}/sleeps"
if [ "$(wc -l < "${dir}/sleeps")" -ge ${options.mgrAfterWaits} ]; then touch "${dir}/go"; fi
exec /bin/sleep 0.01`,
      );
      stand(
        bin,
        "sysbox-mgr",
        `echo "start sysbox-mgr" >> "${dir}/calls"; touch "${dir}/running/sysbox-mgr"
python3 -c 'import os, socket, sys, time
while not os.path.exists(sys.argv[2]): time.sleep(0.01)
s = socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); time.sleep(30)' "${run}/sysmgr.sock" "${dir}/go" &
echo $! >> "${dir}/pids"
wait`,
      );
    } else if (options.omit !== "sysbox-mgr")
      daemon("sysbox-mgr", "sysmgr.sock", options.daemonReady?.mgr ?? true);
    if (options.omit !== "sysbox-fs")
      daemon("sysbox-fs", "sysfs.sock", options.daemonReady?.fs ?? true);
    if (options.omit !== "sysbox-runc") stand(bin, "sysbox-runc", "exit 0");

    return {
      dir,
      file,
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        SYSBOX_PREPARE_CGROUP_ROOT: file("cgroup"),
        SYSBOX_PREPARE_TUN: file("tun"),
        SYSBOX_PREPARE_MOUNTINFO: file("mountinfo"),
        SYSBOX_PREPARE_SYSCTL_CONF: file("sysctl.conf"),
        SYSBOX_PREPARE_RUN_DIR: run,
        SYSBOX_PREPARE_LOG_DIR: file("log"),
        SYSBOX_PREPARE_WAIT_TENTHS: "30",
      },
    };
  }

  function run(fx: Fixture) {
    const result = spawnSync("bash", [path], {
      env: { ...process.env, ...fx.env },
      encoding: "utf8",
      timeout: 20_000,
    });
    const calls = existsSync(fx.file("calls"))
      ? readFileSync(fx.file("calls"), "utf8").trim().split("\n")
      : [];
    return { status: result.status, stderr: result.stderr, calls };
  }

  it("does the steps in order, ends 0 and leaves both daemons running", () => {
    const fx = fixture();

    const result = run(fx);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(statSync(fx.file("tun")).mode & 0o777).toBe(0o666);
    // The mounts first, then the limits, then the manager, then the file system: sysbox-fs asks the manager.
    expect(result.calls).toStrictEqual([
      "umount /proc/kcore",
      "umount /proc/keys",
      `sysctl -q -e -p ${fx.file("sysctl.conf")}`,
      "sysctl -q -w fs.file-max=2147483647",
      "start sysbox-mgr",
      "start sysbox-fs",
      "docker info --format {{json .Runtimes}}",
    ]);
  });

  it("leaves a pair that is already running alone: no restart under a container, nothing unmounted twice", () => {
    const fx = fixture();
    expect(run(fx).status).toBe(0);
    writeFileSync(fx.file("calls"), "");

    const second = run(fx);

    expect(second.status).toBe(0);
    expect(second.calls).toStrictEqual([""]);
  });

  it("unmounts only what is mounted", () => {
    const fx = fixture({
      mounts: "30 25 0:6 / /proc/kcore ro,relatime - devtmpfs devtmpfs ro\n",
    });

    const result = run(fx);

    expect(result.status).toBe(0);
    expect(result.calls.filter((call) => call.startsWith("umount"))).toEqual([
      "umount /proc/kcore",
    ]);
  });

  it("does not try to unmount a path that only appears as part of another one", () => {
    const fx = fixture({
      mounts: "30 25 0:6 / /proc/kcore-backup ro - devtmpfs devtmpfs ro\n",
    });

    run(fx);

    expect(readFileSync(fx.file("calls"), "utf8")).not.toContain("umount");
  });

  describe("fails loudly, with a name and an exit status of its own, and does nothing after the failed step", () => {
    it("names the package that is missing", () => {
      const result = run(fixture({ omit: "sysbox-fs" }));
      expect(result.status).toBe(10);
      expect(result.stderr).toContain(
        "sysbox-prepare: sysbox_not_installed sysbox-fs",
      );
      expect(result.calls).toStrictEqual([]);
    });

    it("names a cgroup root vm-prepare.sh did not prepare, before it changes anything", () => {
      const fx = fixture({ controllers: "cpuset cpu io" });
      const result = run(fx);
      expect(result.status).toBe(20);
      expect(result.stderr).toContain("sysbox_cgroup_not_ready memory");
      expect(statSync(fx.file("tun")).mode & 0o777).toBe(0o600);
      expect(result.calls).toStrictEqual([]);
    });

    it("names a tun device it cannot open up", () => {
      const fx = fixture();
      rmSync(fx.file("tun"));
      const result = run(fx);
      expect(result.status).toBe(21);
      expect(result.stderr).toContain("sysbox_tun_failed");
      expect(result.calls).toStrictEqual([]);
    });

    it("names the mount it could not remove", () => {
      const fx = fixture();
      writeFileSync(fx.file("umount-fails"), "");
      const result = run(fx);
      expect(result.status).toBe(22);
      expect(result.stderr).toContain("sysbox_proc_unmount_failed /proc/kcore");
      expect(result.calls.some((call) => call.startsWith("start"))).toBe(false);
    });

    it("names a limit the kernel refused", () => {
      const fx = fixture();
      writeFileSync(fx.file("sysctl-fails"), "");
      const result = run(fx);
      expect(result.status).toBe(23);
      expect(result.stderr).toContain("sysbox_sysctl_failed");
      expect(result.calls.some((call) => call.startsWith("start"))).toBe(false);
    });

    // #745 step 6: the VM's table of open files (437,305 entries on a 4 GB VM) was filled by one root process of the agent in
    // about ten seconds with a tenth of its memory limit, and the calls of Control began to fail. The table is made too big to
    // fill, so that the agent's memory limit is what stops it.
    it("makes the table of open files too big for the agent's memory limit to let it fill", () => {
      const result = run(fixture());
      expect(result.calls).toContain("sysctl -q -w fs.file-max=2147483647");
      expect(code).toContain("fs.file-max");
    });

    it("names a size of the table of open files the kernel refused, and starts no daemon", () => {
      const fx = fixture();
      writeFileSync(fx.file("sysctl-write-fails"), "");
      const result = run(fx);
      expect(result.status).toBe(23);
      expect(result.stderr).toContain("sysbox_sysctl_failed fs.file-max");
      expect(result.calls.some((call) => call.startsWith("start"))).toBe(false);
    });

    it("names a manager that never answers and shows the end of its log, and does not start the file system", () => {
      const fx = fixture({ daemonReady: { mgr: false } });
      const result = run(fx);
      expect(result.status).toBe(24);
      expect(result.stderr).toContain("sysbox_mgr_not_ready");
      expect(result.calls).not.toContain("start sysbox-fs");
    });

    it("names a file system service that never answers", () => {
      const result = run(fixture({ daemonReady: { fs: false } }));
      expect(result.status).toBe(25);
      expect(result.stderr).toContain("sysbox_fs_not_ready");
    });

    it("shares one wait between the two daemons, so a slow sysbox-fs is named and not cut off by the launcher's timeout", () => {
      // 30 waits for both (SYSBOX_PREPARE_WAIT_TENTHS=30): the manager takes 20 of them, the file system never answers.
      const fx = fixture({ mgrAfterWaits: 20, daemonReady: { fs: false } });

      const result = run(fx);

      expect(result.status).toBe(25);
      expect(result.stderr).toContain("sysbox_fs_not_ready");
      const waits = readFileSync(fx.file("sleeps"), "utf8").trim().split("\n");
      expect(waits.length).toBeLessThanOrEqual(30);
      expect(waits.length).toBeGreaterThanOrEqual(29);
    });

    it("names a Docker that does not list the runtime", () => {
      const result = run(fixture({ runtimes: '{"runc":{}}' }));
      expect(result.status).toBe(26);
      expect(result.stderr).toContain("sysbox_runtime_not_registered");
    });
  });
});
