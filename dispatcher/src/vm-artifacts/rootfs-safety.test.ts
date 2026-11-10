// SPDX-License-Identifier: LicenseRef-Proprietary

// The root file system is built as root in a chroot with /dev, /proc and a devpts bind-mounted into it. A `rm -rf` of that tree while one of
// those is still mounted would delete the host's devices, so the removal is guarded (#976): it refuses while anything under the tree is
// mounted, and never crosses into another file system. The guard is tested here against a stand-in `findmnt` that lists the mounts (it needs
// no root); build.sh is read for the rest.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..", "..", "..");
const LIB = join(REPO, "docker/vm/lib.sh");
const BUILD = readFileSync(join(REPO, "docker/vm/rootfs/build.sh"), "utf8");

let work: string;
let tree: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "rootfs-safety-"));
  tree = join(work, "root");
  mkdirSync(join(tree, "dev", "pts"), { recursive: true });
  writeFileSync(join(tree, "dev", "keep.txt"), "x");
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

/** Runs `remove_tree <dir>` with a `findmnt` that prints `mounts` (one target per line), or fails when `mounts` is null. */
function removeTree(
  dir: string,
  mounts: string[] | null,
): { status: number | null; stderr: string } {
  const bin = join(work, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "findmnt"),
    mounts === null
      ? "#!/bin/sh\nexit 1\n"
      : `#!/bin/sh\ncat <<'MOUNTS'\n${mounts.join("\n")}\nMOUNTS\n`,
  );
  chmodSync(join(bin, "findmnt"), 0o755);
  const run = spawnSync(
    "bash",
    ["-c", `. "$1"; remove_tree "$2"`, "_", LIB, dir],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    },
  );
  return { status: run.status, stderr: run.stderr };
}

describe("removing the root file system's tree", () => {
  // #976-T03
  it("refuses while anything under the tree is mounted, and deletes nothing", () => {
    for (const mounted of [
      [`${tree}/dev`],
      [`${tree}/dev/pts`, `${tree}/proc`],
      [tree],
    ]) {
      const run = removeTree(tree, ["/", "/home", ...mounted]);

      expect(run.status, mounted.join(" ")).not.toBe(0);
      expect(run.stderr).toContain("still mounted");
      expect(existsSync(join(tree, "dev", "keep.txt"))).toBe(true);
    }
  });

  // #976-T03
  it("refuses when it cannot tell what is mounted", () => {
    const run = removeTree(tree, null);

    expect(run.status).not.toBe(0);
    expect(existsSync(join(tree, "dev", "keep.txt"))).toBe(true);
  });

  // #976-T03
  it("deletes the tree when only other directories are mounted, also ones whose name starts like the tree's", () => {
    const run = removeTree(tree, [
      "/",
      `${tree}-other/proc`,
      `${tree}2`,
      join(work, "elsewhere"),
    ]);

    expect(run.status).toBe(0);
    expect(existsSync(tree)).toBe(false);
  });

  // #976-T03
  it("refuses a path that is empty, the root, relative, or has a space or a backslash in it (findmnt escapes those)", () => {
    for (const bad of ["", "/", "root", `${work}/a b`, `${work}/a\\b`]) {
      const run = removeTree(bad, []);

      expect(run.status, JSON.stringify(bad)).not.toBe(0);
    }
    expect(existsSync(join(tree, "dev", "keep.txt"))).toBe(true);
  });
});

describe("build.sh", () => {
  // #976-T03
  it("never runs `rm -rf` without --one-file-system, and removes the whole tree only through the guard", () => {
    const removals = BUILD.split("\n").filter((line) =>
      /\brm -[a-z]*r/.test(line),
    );

    expect(removals.length).toBeGreaterThan(0);
    for (const line of removals) {
      expect(line, line).toMatch(/--one-file-system/);
    }
    expect(BUILD).not.toMatch(/rm -rf "\$root"/);
    expect(BUILD.match(/remove_tree "\$root"/g)).toHaveLength(2);
  });

  // #976-T03
  it("takes the mounts down before the tree is packed or removed, and checks that they went", () => {
    const cleanup = BUILD.slice(
      BUILD.indexOf("cleanup() {"),
      BUILD.indexOf("trap cleanup EXIT"),
    );

    expect(cleanup).toContain("umount");
    expect(cleanup).not.toContain("|| true");
    expect(BUILD).toMatch(/mounted_under "\$root"/);
  });
});
