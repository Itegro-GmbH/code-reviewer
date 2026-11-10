// SPDX-License-Identifier: LicenseRef-Proprietary

// The guest's init of every boot (#978): `docker/vm/rootfs/vm-boot`. Only a KVM guest can run it, so what is checked here is its shape: a job's VM
// (`vm.mode=run`) starts the real vm-init and runs NO prepare script (vm-init runs them in the hosted order), the build-only boots hand over to the
// placeholder that keeps them, and the root file system gets the real vm-init from runner/vm-init/install.sh, never the placeholder. The real run
// is the CI job `VM artifacts` (smoke boot) and its launcher lane (a job in a VM).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RELEASE_INIT_COMMAND } from "./boot.ts";

const REPO = join(import.meta.dirname, "..", "..", "..");
const read = (path: string): string => readFileSync(join(REPO, path), "utf8");
const BOOT = read("docker/vm/rootfs/vm-boot");
const BUILD_INIT = read("docker/vm/rootfs/vm-build-init");
const BUILD = read("docker/vm/rootfs/build.sh");
const code = (script: string): string =>
  script
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

describe("the guest init of every boot", () => {
  // #978-T14
  it("is what the release starts after docker-init", () => {
    expect(RELEASE_INIT_COMMAND).toBe(
      "/usr/bin/docker-init -- /usr/local/sbin/vm-boot",
    );
  });

  // #978-T14
  it("runs no prepare script: vm-init does, in the hosted order", () => {
    expect(code(BOOT)).not.toMatch(/vm-prepare\.sh|sysbox-prepare\.sh/);
    expect(code(BOOT)).not.toMatch(/dockerd/);
  });

  // #978-T14
  it("starts vm-init for a job's VM, powers the VM off when it returns, and hands the build-only boots to the placeholder", () => {
    const run = BOOT.slice(BOOT.indexOf("  run)"), BOOT.indexOf("  *)"));

    expect(run).toMatch(/^\s*vm-init$/m);
    expect(run).toMatch(/vm_init_returned[\s\S]*power_off/);
    expect(BOOT).toMatch(/exec \/usr\/local\/sbin\/vm-build-init/);
  });

  // #978-T14
  it("puts the work volume's directory on the job disk and sets up the network from the command line", () => {
    expect(BOOT).toMatch(
      /mount --bind \/jobdisk\/code-reviewer-work \/var\/lib\/code-reviewer-work/,
    );
    expect(BOOT).toMatch(/getarg vm\.ip/);
    expect(BOOT).toMatch(/getarg vm\.gw/);
    expect(BOOT).toMatch(/ip route add default via/);
  });

  // #978-T14
  it("keeps the placeholder only for the build-only boots", () => {
    expect(BUILD_INIT).toMatch(/seed\)/);
    expect(BUILD_INIT).toMatch(/smoke\)/);
    expect(BUILD_INIT).not.toMatch(/^\s*run\)/m);
    expect(code(BUILD_INIT)).toMatch(/vm-prepare\.sh/);
    expect(code(BUILD_INIT)).toMatch(/sysbox-prepare\.sh/);
  });

  // #978-T14
  it("is built into the root file system next to the real vm-init, and the placeholder is not vm-init", () => {
    expect(BUILD).toContain('"$REPO_DIR/runner/vm-init/install.sh" "$root"');
    expect(BUILD).toContain('"$root/usr/local/sbin/vm-boot"');
    expect(BUILD).toContain('"$root/usr/local/sbin/vm-build-init"');
    expect(BUILD).not.toMatch(/install[^\n]*rootfs\/vm-init"/);
  });
});
