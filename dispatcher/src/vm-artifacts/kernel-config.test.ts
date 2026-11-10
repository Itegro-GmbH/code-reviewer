// SPDX-License-Identifier: LicenseRef-Proprietary

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..", "..", "..");
const fragment = readFileSync(
  join(REPO, "docker/vm/kernel/config.fragment"),
  "utf8",
);
const options = fragment
  .split("\n")
  .filter((line) => line.startsWith("CONFIG_"))
  .map((line) => {
    const [name = "", ...rest] = line.split("=");
    return { name, value: rest.join("=") };
  });

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** Runs verify-config.sh on a .config made of `lines`, against a base config that has none of the options. */
function verify(lines: string[]): { status: number | null; stderr: string } {
  dir = mkdtempSync(join(tmpdir(), "kconfig-"));
  writeFileSync(join(dir, ".config"), `${lines.join("\n")}\n`);
  writeFileSync(join(dir, "base.config"), "CONFIG_RT_GROUP_SCHED=y\n");
  const run = spawnSync(
    "bash",
    [
      join(REPO, "docker/vm/kernel/verify-config.sh"),
      join(dir, ".config"),
      join(dir, "base.config"),
      join(dir, "added.txt"),
    ],
    { encoding: "utf8" },
  );
  return { status: run.status, stderr: run.stderr };
}

/** The fragment as a finished .config would hold it: every option set to its value, `=n` ones as "is not set". */
const finished = options.map((o) =>
  o.value === "n" ? `# ${o.name} is not set` : `${o.name}=${o.value}`,
);

describe("the kernel configuration fragment", () => {
  // #976-T04
  it("turns RT_GROUP_SCHED off: with it the cpu controller cannot be enabled and vm-prepare.sh fails", () => {
    expect(options.find((o) => o.name === "CONFIG_RT_GROUP_SCHED")?.value).toBe(
      "n",
    );
  });

  // #976-T04
  it("asks for what Docker, Sysbox and the job disk need", () => {
    const wanted = [
      "CONFIG_USER_NS",
      "CONFIG_CGROUP_BPF",
      "CONFIG_SECCOMP_FILTER",
      "CONFIG_OVERLAY_FS",
      "CONFIG_FUSE_FS",
      "CONFIG_EXT4_FS",
      "CONFIG_VSOCKETS",
      "CONFIG_VIRTIO_VSOCKETS",
      "CONFIG_VIRTIO_BLK",
      "CONFIG_NFT_COMPAT",
      "CONFIG_IKCONFIG_PROC",
    ];
    for (const name of wanted)
      expect(options.find((o) => o.name === name)?.value, name).toBe("y");
  });

  // #976-T04
  it("names every option once, so that a later line cannot silently undo an earlier one", () => {
    const names = options.map((o) => o.name);
    expect(new Set(names).size).toBe(names.length);
  });

  // #976-T04
  it("has only lines that kconfig reads: an option, a comment or nothing", () => {
    for (const line of fragment.split("\n"))
      expect(line, line).toMatch(
        /^(CONFIG_[A-Z0-9_]+=(y|n|m|[0-9a-fx"]+)|##.*|)$/,
      );
  });

  // #976-T04
  it("is verified by the configuration script and again on the kernel that is published, so a cached kernel is held to the same rule", () => {
    const configure = readFileSync(
      join(REPO, "docker/vm/kernel/configure.sh"),
      "utf8",
    );
    const workflow = readFileSync(
      join(REPO, ".github/workflows/vm-artifacts.yml"),
      "utf8",
    );

    expect(configure).toContain("verify-config.sh");
    expect(workflow).toContain("docker/vm/kernel/verify-config.sh");
  });

  // #976-T04
  it("passes verify-config.sh for a configuration that has every option, and says which were added against the base", () => {
    const result = verify(finished);

    expect(result.status).toBe(0);
    expect(readFileSync(join(dir ?? "", "added.txt"), "utf8")).toContain(
      "CONFIG_RT_GROUP_SCHED=n (Firecracker base: y)",
    );
  });

  // #976-T04
  it("fails verify-config.sh when one option did not stick, and names it", () => {
    const without = finished.filter((line) => !line.startsWith("CONFIG_VETH="));
    const wrong = finished.map((line) =>
      line === "CONFIG_BRIDGE=y" ? "CONFIG_BRIDGE=m" : line,
    );

    const missing = verify(without);
    const changed = verify(wrong);

    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("MISSING CONFIG_VETH: wanted y");
    expect(changed.status).toBe(1);
    expect(changed.stderr).toContain(
      "MISSING CONFIG_BRIDGE: wanted y, got 'm'",
    );
  });

  // #976-T04
  it("fails verify-config.sh when RT_GROUP_SCHED is on", () => {
    const rt = finished.map((line) =>
      line.includes("CONFIG_RT_GROUP_SCHED") ? "CONFIG_RT_GROUP_SCHED=y" : line,
    );

    const result = verify(rt);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("wanted n, got 'y'");
  });
});
