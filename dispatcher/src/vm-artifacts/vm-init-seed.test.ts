// SPDX-License-Identifier: LicenseRef-Proprietary

// The seed boot makes the data disk: the guest loads the images, and the disk must then be left clean (#976). `docker/vm/rootfs/vm-build-init` is a
// shell script that only a KVM guest can run, so what can be checked here is its shape: the seed branch stops every daemon that writes to the
// disk (Docker, containerd and the two Sysbox daemons), checks every unmount, and says `seed_done` only after the last one succeeded. The
// real run is the CI job `VM artifacts`, whose seed boot fails without `seed_done`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = readFileSync(
  join(import.meta.dirname, "..", "..", "..", "docker/vm/rootfs/vm-build-init"),
  "utf8",
);
const seed = SCRIPT.slice(
  SCRIPT.indexOf("  seed)"),
  SCRIPT.indexOf("  smoke)"),
);
const lines = seed.split("\n");
const at = (pattern: RegExp): number =>
  lines.findIndex((line) => pattern.test(line));

describe("the seed branch of vm-init", () => {
  // #976-T03
  it("stops the Sysbox daemons as well as Docker, and waits for them, before it unmounts anything", () => {
    const firstUnmount = at(/seed_unmount/);

    expect(firstUnmount).toBeGreaterThan(-1);
    const stopLoop = lines.findIndex((line) => /for daemon in /.test(line));
    expect(stopLoop).toBeGreaterThan(-1);
    expect(stopLoop).toBeLessThan(firstUnmount);
    expect(lines[stopLoop]).toMatch(/dockerd sysbox-fs sysbox-mgr/);
    expect(seed).toMatch(/pkill -TERM -x "\$daemon"/);
    // And once more for all of them together, with containerd: the seed fails when any is left.
    const left = at(/pgrep -x '[^']*containerd[^']*sysbox-mgr[^']*sysbox-fs/);
    expect(left).toBeGreaterThan(-1);
    expect(left).toBeLessThan(firstUnmount);
    expect(seed).toContain("reason=daemon_not_stopped");
  });

  // #976-T03
  it("unmounts the seed drive, every directory of the job disk and the job disk, each through the checked helper", () => {
    const loop = seed.match(/for target in ([^;]+); do/);

    expect(loop?.[1]?.trim().split(/\s+/)).toEqual([
      "/seed",
      "/var/lib/sysboxfs",
      "/var/lib/sysbox",
      "/var/lib/containerd",
      "/var/lib/docker",
      "/jobdisk",
    ]);
    // Never a bare `umount` in the branch, and none anywhere that ignores a failure.
    expect(seed).not.toMatch(/(^|[^_])umount\b/m);
    expect(SCRIPT).not.toMatch(/umount[^\n]*\|\| true/);
    expect(SCRIPT).toMatch(
      /seed_unmount\(\) \{\n\s*umount -R "\$1"[^\n]*\|\| seed_fail reason=umount/,
    );
  });

  // #976-T03
  it("says seed_done once, after the last unmount, and every failure says seed_failed and powers off", () => {
    const done = at(/say seed_done/);
    const lastUnmount = at(/seed_unmount "\$target"/);

    expect(seed.match(/say seed_done/g)).toHaveLength(1);
    expect(lastUnmount).toBeGreaterThan(-1);
    expect(done).toBeGreaterThan(lastUnmount);
    expect(SCRIPT).toMatch(
      /seed_fail\(\) \{\n\s*say seed_failed "\$@"\n\s*power_off\n\s*exit 1\n\}/,
    );
    // No way out of the branch with a failure that does not go through seed_fail.
    expect(seed).not.toContain("say seed_failed");
  });
});
