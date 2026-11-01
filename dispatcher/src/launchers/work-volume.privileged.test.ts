// SPDX-License-Identifier: LicenseRef-Proprietary

// The privileged lane of the Implementer's container profile (#760): the steps that make the work volume
// (`workVolumeCommands`) run for real, as root on this machine with `sudo -n`, and the container of the profile
// (`renderDockerRunArguments`) runs on a REAL Docker daemon with the real Worker image. It proves what no double can: that
// the volume really is a mount with `nosuid,nodev` and without `noexec`, that a program copied onto it runs, that the
// root filesystem is read-only and `/tmp` cannot run a program, and that the daemon applied the memory and process limits
// of the profile. It needs a daemon the user may use, passwordless `sudo` and the image of the `sandbox` target
// (`SANDBOX_LOCAL_IMAGE`); it fails, naming the missing item, and never skips. `make test-sandbox-local` runs it.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  renderDockerRunArguments,
  workVolumeCommands,
  workVolumeName,
} from "./container.ts";
import { IMPLEMENTER_CONTAINER_SPEC } from "./container-spec.ts";

const IMAGE = process.env.SANDBOX_LOCAL_IMAGE;

function run(command: string, args: readonly string[]): string {
  return execFileSync(command, [...args], { encoding: "utf8" });
}

let root: string;
let volume: string;

beforeEach(() => {
  if (IMAGE === undefined || IMAGE === "")
    throw new Error(
      "SANDBOX_LOCAL_IMAGE is not set: build the image (docker build --file runner/Dockerfile --target sandbox --tag code-reviewer-worker:local .) and name it",
    );
  try {
    run("docker", ["version", "--format", "{{.Server.Version}}"]);
  } catch {
    throw new Error("There is no Docker daemon this user may use.");
  }
  try {
    run("sudo", ["-n", "true"]);
  } catch {
    throw new Error(
      "There is no passwordless sudo: the work volume is mounted as root.",
    );
  }
  const suffix = randomBytes(4).toString("hex");
  root = `/var/lib/cr-work-test-${suffix}`;
  volume = workVolumeName(`privileged-${suffix}`);
});

afterEach(() => {
  const quietly = (command: string, args: readonly string[]) => {
    try {
      run(command, args);
    } catch {
      // Already gone.
    }
  };
  quietly("docker", ["rm", "--force", `${volume}-container`]);
  quietly("docker", ["volume", "rm", "--force", volume]);
  quietly("sudo", ["-n", "umount", `${root}/${volume}`]);
  quietly("sudo", ["-n", "rm", "-rf", root]);
});

/** What the container prints: marker lines the assertions read. */
const SCRIPT = [
  "grep ' /work ' /proc/self/mountinfo | sed 's/^/WORK_MOUNT /'",
  "cp /bin/true /work/program && /work/program && echo WORK_EXEC_OK",
  "touch /rootfile 2>/dev/null && echo ROOT_WRITABLE || echo ROOT_READ_ONLY",
  "cp /bin/true /tmp/program 2>/dev/null; /tmp/program 2>/dev/null && echo TMP_EXEC_OK || echo TMP_NO_EXEC",
  "echo PIDS_MAX $(cat /sys/fs/cgroup/pids.max)",
  "echo MEMORY_MAX $(cat /sys/fs/cgroup/memory.max)",
].join("; ");

describe("the Implementer's container profile on a real daemon", () => {
  // #760-T07
  it("mounts the work volume with nosuid and nodev where a program runs, and keeps the root and /tmp from running one", () => {
    for (const command of workVolumeCommands(IMPLEMENTER_CONTAINER_SPEC, {
      name: volume,
      root,
    })) {
      const printed =
        command.cmd === "docker"
          ? run(command.cmd, command.args)
          : run("sudo", ["-n", command.cmd, ...command.args]);
      // The Launcher's own check of the mount options, on a real kernel's mountinfo.
      if (command.check !== undefined)
        expect(command.check(printed), command.label).toBe(true);
    }

    const rendered = renderDockerRunArguments(IMPLEMENTER_CONTAINER_SPEC, {
      image: IMAGE ?? "",
      name: `${volume}-container`,
      workVolume: volume,
      command: ["-c", SCRIPT],
    });
    // The image's entry point is the Worker; the test runs a shell in the container the profile renders.
    const at = rendered.indexOf(IMAGE ?? "");
    const args = [
      ...rendered.slice(0, at),
      "--entrypoint",
      "sh",
      ...rendered.slice(at),
    ];
    const output = run("docker", args);

    const mount = /^WORK_MOUNT .*$/m.exec(output)?.[0] ?? "";
    expect(mount).toMatch(/ rw[ ,]/);
    expect(mount).toContain("nosuid");
    expect(mount).toContain("nodev");
    expect(mount).not.toContain("noexec");
    expect(output).toContain("WORK_EXEC_OK");
    expect(output).toContain("ROOT_READ_ONLY");
    expect(output).toContain("TMP_NO_EXEC");
    expect(output).toContain("PIDS_MAX 2048");
    expect(output).toContain(`MEMORY_MAX ${3 * 1024 ** 3}`);
  });
});
