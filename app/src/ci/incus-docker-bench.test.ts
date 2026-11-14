// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the Incus/Docker bench (#1013, tools/incus-docker-bench): the timing helpers never record a time for a command that failed or
// printed the wrong thing (the first spike's bench discarded the output of its `docker build`, so a failed build looked like the fastest one),
// the summary fails the job when a series has a failed or missing sample, the script refuses to run anywhere but GitHub Actions, and the
// workflow only starts on the bench's own files, holds no secret and pins its actions. The helpers run for real in a temporary directory against a
// stand-in `docker`; the bench itself needs Incus and runs only in CI.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readText, readWorkflow, repoRoot } from "./workflow-support.ts";

const BENCH = `${repoRoot}tools/incus-docker-bench/`;
const directories: string[] = [];
const scratch = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "cr-incus-bench-"));
  directories.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

type Samples = { rows: string[][]; status: number | null; stderr: string };

/** Runs `script` in bash with lib.sh sourced; returns the rows it recorded. */
function lib(script: string, env: Record<string, string> = {}): Samples {
  const dir = scratch();
  const out = join(dir, "samples.tsv");
  writeFileSync(out, "");
  const run = spawnSync(
    "bash",
    ["-c", `. "${BENCH}lib.sh"\nBENCH_VARIANT=v\n${script}`],
    {
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH ?? "",
        BENCH_OUT: out,
        ...env,
      },
      input: "data on stdin\n",
      encoding: "utf8",
    },
  );
  const rows = readFileSync(out, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"));
  return { rows, status: run.status, stderr: run.stderr };
}

/** A directory with a `docker` stand-in first in the PATH; FAKE_* choose what it does. */
function fakeDocker(): { path: string; log: string } {
  const dir = scratch();
  const log = join(dir, "calls.log");
  writeFileSync(
    join(dir, "docker"),
    `#!/bin/sh
echo "$*" >>"${log}"
case "$1" in
  build)
    [ "$FAKE_BUILD" = fail ] && { echo "RUN failed: exit 1" >&2; exit 1; }
    [ "$FAKE_BUILD" = noid ] && exit 0
    echo sha256:0123456789ab ;;
  image) [ "$FAKE_IMAGE" = missing ] && exit 1; exit 0 ;;
  run) echo "\${FAKE_RUN_OUTPUT:-built}" ;;
  rmi) : ;;
esac
`,
  );
  chmodSync(join(dir, "docker"), 0o755);
  return { path: dir, log };
}

const build = (fake: Record<string, string>): Samples => {
  const docker = fakeDocker();
  const result = lib("timed_build battery.build 1 tag /nonexistent", {
    PATH: `${docker.path}:${process.env.PATH}`,
    ...fake,
  });
  return result;
};

describe("the timing helpers record a time only for a command that did what it must", () => {
  // #1013-T01
  it("records the seconds of a command that exited 0", () => {
    const { rows, status } = lib("timed run.total 3 -- sleep 0.05");

    expect(status).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0].slice(0, 3)).toEqual(["v", "run.total", "3"]);
    expect(Number(rows[0][3])).toBeGreaterThanOrEqual(0.05);
  });

  // #1013-T01
  it("records FAILED and no time for a command that exited non-zero, and returns its status", () => {
    const { rows, status } = lib(
      "timed run.total 3 -- bash -c 'echo no image >&2; exit 7'",
    );

    expect(status).toBe(7);
    expect(rows).toEqual([
      ["v", "run.total", "3", "FAILED", "exit 7: no image"],
    ]);
  });

  // #1013-T01
  it("records FAILED for output that does not match the pattern, even when the command exited 0", () => {
    const { rows } = lib(
      "timed battery.compose-up 1 -e compose-up -- echo nothing",
    );

    expect(rows).toHaveLength(1);
    expect(rows[0][3]).toBe("FAILED");
    expect(rows[0][4]).toContain("does not match /compose-up/");
  });

  // #1013-T01
  it("closes stdin of the command (incus init hangs on an open pipe)", () => {
    const { rows } = lib(
      "timed s 1 -e '^eof$' -- bash -c 'read -r line && echo got || echo eof'",
    );

    expect(rows[0].slice(0, 4)).toEqual([
      "v",
      "s",
      "1",
      expect.stringMatching(/^\d+\.\d{3}$/),
    ]);
  });

  // #1013-T01
  it("keeps a note on one line, so a note cannot break the file's format", () => {
    const { rows } = lib(
      "timed x 1 -- bash -c 'printf \"a\\tb\\nc\\n\"; exit 1'",
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(5);
  });
});

describe("a failed build must not look fast", () => {
  // #1013-T01
  it("records the time of a build that exited 0, printed an id, left the image and ran", () => {
    const { rows, status } = build({});

    expect(status).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0][3]).toMatch(/^\d+\.\d{3}$/);
  });

  // #1013-T01
  it("records FAILED and no time when docker build exits non-zero", () => {
    const { rows, status } = build({ FAKE_BUILD: "fail" });

    expect(status).not.toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0][3]).toBe("FAILED");
    expect(rows[0][4]).toContain("RUN failed: exit 1");
  });

  // #1013-T01
  it("records FAILED when the build exits 0 but prints no image id", () => {
    const { rows } = build({ FAKE_BUILD: "noid" });

    expect(rows[0][3]).toBe("FAILED");
    expect(rows[0][4]).toContain("no image id");
  });

  // #1013-T01
  it("records FAILED when no image is left after the build", () => {
    const { rows } = build({ FAKE_IMAGE: "missing" });

    expect(rows[0][3]).toBe("FAILED");
    expect(rows[0][4]).toContain("no image tag");
  });

  // #1013-T01
  it("records FAILED when a container of the image does not print what the Dockerfile wrote", () => {
    const { rows } = build({ FAKE_RUN_OUTPUT: "oops" });

    expect(rows[0][3]).toBe("FAILED");
    expect(rows[0][4]).toContain("not 'built'");
  });
});

describe("the summary", () => {
  const summarize = (lines: string[][]) => {
    const dir = scratch();
    const file = join(dir, "samples.tsv");
    writeFileSync(file, lines.map((line) => line.join("\t")).join("\n") + "\n");
    return spawnSync("python3", ["-I", `${BENCH}summarize.py`, file], {
      encoding: "utf8",
    });
  };

  // #1013-T01
  it("gives the median, the minimum, the maximum and the first run of a series", () => {
    const result = summarize([
      ["a", "run.total", "0", "3.000", ""],
      ["a", "run.total", "1", "2.000", ""],
      ["a", "run.total", "2", "1.000", ""],
      ["a", "run.total", "3", "9.000", ""],
      ["a", "run.total", "n", "3", "expect"],
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "| run.total | 3 | 2.00 | 1.00 | 9.00 | 3.00 |",
    );
  });

  // #1013-T01
  it("fails, and says which sample, when a series that is not a control has a FAILED", () => {
    const result = summarize([
      [
        "a",
        "battery.build-3layers",
        "1",
        "FAILED",
        "docker build exit 1: boom",
      ],
      ["a", "battery.build-3layers", "2", "0.200", ""],
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("FAILED: these numbers are not a result");
    expect(result.stdout).toContain(
      "a battery.build-3layers: 1 failed sample(s)",
    );
    expect(result.stdout).toContain("1/2 FAILED");
  });

  // #1013-T01
  it("fails when a series has fewer good samples than it promised", () => {
    const result = summarize([
      ["a", "run.total", "1", "2.000", ""],
      ["a", "run.total", "n", "12", "expect"],
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("1 good samples, 12 expected");
  });

  // #1013-T01
  it("lets a control fail: it is what the bench tries to find out with", () => {
    const result = summarize([
      ["a", "run.total", "1", "2.000", ""],
      ["a", "ctl.ctr", "0", "FAILED", "no such image"],
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ctl.ctr");
  });

  // #1013-T01
  it("compares the variants in one table", () => {
    const result = summarize([
      ["a", "run.total", "1", "2.000", ""],
      ["b", "run.total", "1", "0.500", ""],
    ]);

    expect(result.stdout).toContain("| metric | a | b |");
    expect(result.stdout).toContain("| run.total | 2.00 | 0.50 |");
  });
});

describe("the bench script", () => {
  // #1013-T01
  it("refuses to run outside GitHub Actions: it installs a package and changes the firewall", () => {
    const run = spawnSync("bash", [`${BENCH}bench.sh`], {
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH ?? "",
        BENCH_DIR: scratch(),
      },
      encoding: "utf8",
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("refusing to run outside GitHub Actions");
  });

  // #1013-T01
  it("starts every Docker run with --pull=never, so that a missing image is a failure and not a pull in the timing", () => {
    const guest = readText("tools/incus-docker-bench/guest.sh");
    const runs = guest
      .split("\n")
      .filter(
        (line) =>
          /docker (run|create)\b/.test(line) &&
          !/^\s*(#|record|echo|printf)/.test(line),
      );

    expect(runs.length).toBeGreaterThan(0);
    for (const line of runs) expect(line, line).toContain("--pull=never");
  });
});

describe("the workflow", () => {
  const workflow = readWorkflow("incus-docker-bench.yml");
  const source = readText(".github/workflows/incus-docker-bench.yml");
  const steps = workflow.jobs.bench.steps ?? [];

  // #1013-T01
  it("starts on a manual run and on a pull request that changes the bench's own files only", () => {
    const on = workflow.on as Record<string, { paths?: string[] } | null>;

    expect(Object.keys(on).sort()).toEqual([
      "pull_request",
      "workflow_dispatch",
    ]);
    expect(on.pull_request?.paths).toEqual([
      "tools/incus-docker-bench/**",
      ".github/workflows/incus-docker-bench.yml",
    ]);
  });

  // #1013-T01
  it("runs on a GitHub-hosted ubuntu-24.04 runner with a time limit and a read-only token, and no secret", () => {
    expect(workflow.jobs.bench["runs-on"]).toBe("ubuntu-24.04");
    expect(workflow.jobs.bench["timeout-minutes"]).toBeGreaterThan(0);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(source).not.toMatch(/secrets\./);
    expect(Object.keys(workflow.on)).not.toContain("pull_request_target");
  });

  // #1013-T01
  it("shellchecks the bench before it runs it, and runs the script as root through sudo", () => {
    const run = steps.map((step) => step.run ?? "");

    expect(
      run.findIndex((text) =>
        text.includes("shellcheck tools/incus-docker-bench/*.sh"),
      ),
    ).toBeGreaterThanOrEqual(0);
    expect(run.findIndex((text) => text.includes("shellcheck"))).toBeLessThan(
      run.findIndex(
        (text) => text.includes("sudo ") && text.includes("bench.sh"),
      ),
    );
  });

  // #1013-T01
  it("keeps the numbers even when the bench failed", () => {
    const upload = steps.find((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );

    expect(upload?.if).toContain("always()");
  });
});

describe("the pins of the bench", () => {
  const script = readText("tools/incus-docker-bench/bench.sh");

  // #1013-T01
  it("installs the Incus package of the #1005 re-measure, by its full version, and checks the key's fingerprint and every download's sha256", () => {
    expect(script).toContain("INCUS_VERSION='1:7.6-ubuntu24.04-202611072126'");
    expect(script).toMatch(/ZABBLY_KEY_FPR='[0-9A-F]{40}'/);
    for (const name of ["DOCKER", "BUILDX", "COMPOSE"])
      expect(script).toMatch(new RegExp(`${name}_SHA='[0-9a-f]{64}'`));
  });
});
