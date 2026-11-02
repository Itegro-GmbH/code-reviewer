// SPDX-License-Identifier: LicenseRef-Proprietary

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// The real entry file, run by Node as `pnpm snapshot:build` runs it. It must load (types stripped, the
// platform SDK imported lazily) and refuse a wrong call before it touches the platform: no token is set here
// and a run that reached the platform would fail differently (and the network guard of the tests would not
// reach a child process, so the point is that these cases never get that far).
const MAIN = join(import.meta.dirname, "main.ts");
const work = mkdtempSync(join(tmpdir(), "snapshot-main-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function main(args: string[], env: Record<string, string> = {}) {
  return spawnSync(
    process.execPath,
    ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", MAIN, ...args],
    {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", ...env },
      timeout: 20_000,
    },
  );
}

describe("the snapshot:build entry file", () => {
  // #330-extra-main
  it("exits with 2 and names the missing option when called without arguments", () => {
    const result = main([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--context");
    expect(result.stdout).toBe("");
  });

  // #330-extra-main
  it("exits with 2 before any platform call when an input file is missing, and leaves no record", () => {
    const out = join(work, "record.json");
    const result = main([
      "--context",
      join(work, "missing.tgz"),
      "--vm-prepare",
      join(work, "missing.sh"),
      "--sysbox-prepare",
      join(work, "missing-sysbox.sh"),
      "--out",
      out,
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--context");
    expect(existsSync(out)).toBe(false);
  });

  // #745
  it("names --sysbox-prepare when only that script is missing, and leaves no record", () => {
    const out = join(work, "record-sysbox.json");
    const context = join(work, "context-sysbox.tgz");
    const script = join(work, "vm-prepare-sysbox.sh");
    writeFileSync(context, "x");
    writeFileSync(script, "#!/bin/sh\n");
    const result = main([
      "--context",
      context,
      "--vm-prepare",
      script,
      "--sysbox-prepare",
      join(work, "missing-sysbox.sh"),
      "--out",
      out,
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--sysbox-prepare");
    expect(existsSync(out)).toBe(false);
  });

  // #330-extra-main
  it("refuses a token without its team and project, naming the variable and not the token", () => {
    const context = join(work, "context.tgz");
    const script = join(work, "vm-prepare.sh");
    writeFileSync(context, "x");
    writeFileSync(script, "#!/bin/sh\n");
    const result = main(
      [
        "--context",
        context,
        "--vm-prepare",
        script,
        "--sysbox-prepare",
        script,
        "--out",
        join(work, "r.json"),
      ],
      { VERCEL_TOKEN: "dummy-token-for-the-entry-test-0123456789" },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("VERCEL_TEAM_ID");
    expect(result.stderr).not.toContain("dummy-token-for-the-entry-test");
  });
});
