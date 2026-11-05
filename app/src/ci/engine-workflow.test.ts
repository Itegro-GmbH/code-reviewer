// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the structure of the engine workflow (.github/workflows/engine.yml), the one definition
// of the engine suite job that ci.yml and nightly.yml call: what it runs, that the suite runs
// without network, that it is read-only, without secrets, time limited and pinned. It reads the
// file as YAML; how GitHub runs it is verified by the CI runs themselves.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const source = readFileSync(`${repoRoot}.github/workflows/engine.yml`, "utf8");
const script = readFileSync(
  `${repoRoot}runner/scripts/run_engine_offline.sh`,
  "utf8",
);
const privilegedScript = readFileSync(
  `${repoRoot}runner/scripts/run_privileged_offline.sh`,
  "utf8",
);

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Job = {
  "timeout-minutes"?: number;
  strategy?: { "fail-fast"?: boolean; matrix?: Record<string, string[]> };
  permissions?: Record<string, string>;
  defaults?: { run?: { "working-directory"?: string } };
  steps?: Step[];
};
type Workflow = {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
};

const workflow = parse(source) as Workflow;
const engine = workflow.jobs.engine as Job;
const privileged = workflow.jobs.privileged as Job;
const steps = engine.steps ?? [];

function commandLines(job: Job = engine): string[] {
  return (job.steps ?? [])
    .flatMap((step) => (step.run ? step.run.split("\n") : []))
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

describe("engine workflow", () => {
  // CR-41-T15
  it("is only started by other workflows", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_call"]);
  });

  // #713-T01
  it("has three jobs: the PR-Agent and the OpenCode half of the engine suite as a matrix, and the privileged suite on a runner of its own", () => {
    expect(Object.keys(workflow.jobs)).toEqual(["engine", "privileged"]);
    expect(engine.strategy?.matrix).toEqual({ shard: ["pragent", "opencode"] });
    // A failed half must not hide the other: both halves report.
    expect(engine.strategy?.["fail-fast"]).toBe(false);
  });

  // CR-41-T15, #713-T01
  it("installs from the lockfile and runs its half of the suite with the marker through the offline script", () => {
    const lines = commandLines();
    // The shard reaches the shell through the environment, never through the text of the command.
    const run = 'scripts/run_engine_offline.sh --engine-shard="$ENGINE_SHARD"';
    const step = steps.find((candidate) => candidate.run === run);

    expect(lines).toContain("uv sync --locked");
    expect(lines).toContain(run);
    expect(step?.env).toEqual({ ENGINE_SHARD: "${{ matrix.shard }}" });
    expect(lines.indexOf("uv sync --locked")).toBeLessThan(lines.indexOf(run));
    expect(engine.defaults?.run?.["working-directory"]).toBe("runner");
    expect(lines.join("\n")).not.toContain("run_privileged_offline.sh");
  });

  // #713-T01
  it("runs the engine tests on four workers that each take whole files, from the explicit directory", () => {
    expect(script).toMatch(
      /pytest -m engine\b[^\n]*-n "\$\{TEST_MAX_WORKERS:-4\}"/,
    );
    expect(script).toContain("--dist loadfile");
    expect(script).toMatch(/--dist loadfile[^\n]* tests\/engine\b/);
  });

  // CR-41-T15
  it("runs pytest -m engine inside a network namespace after the tiktoken cache was filled", () => {
    expect(script).toContain("scripts/prime_tiktoken_cache.py");
    expect(script.indexOf("scripts/prime_tiktoken_cache.py")).toBeLessThan(
      script.indexOf("unshare --net"),
    );
    expect(script).toContain("pytest -m engine");
    expect(script).toContain("ip link set lo up");
    // The suite does not run as root, and the namespace is proven to have no way out.
    expect(script).toContain("setpriv --reuid");
    expect(script).toContain("is not isolated");
  });

  // CR-41 follow-up: the dropped root user must not be able to gain privileges again (setuid files).
  it("drops privileges for good before the suite starts", () => {
    expect(script).toMatch(/setpriv [^\n]*--no-new-privs/);
  });

  // #197-T02
  it("fetches the pinned OpenCode and installs ripgrep before the namespace, and caches the pin", () => {
    expect(script).toContain("scripts/fetch_opencode.py");
    expect(script.indexOf("scripts/fetch_opencode.py")).toBeLessThan(
      script.indexOf("unshare --net"),
    );
    // The engine needs a trusted ripgrep, or the pinned release downloads one on its first grep.
    expect(script).toContain("command -v rg");
    expect(commandLines().join("\n")).toContain("apt-get install");
    expect(commandLines().join("\n")).toContain("ripgrep");
    // The runner image carries nftables and libcap2-bin; the index refresh cost 10 to 53 s per job (#713).
    for (const job of [engine, privileged])
      expect(commandLines(job).join("\n")).not.toContain("apt-get update");

    const cache = steps.find(
      (step) =>
        step.uses?.startsWith("actions/cache@") &&
        String(step.with?.key).includes("opencode"),
    );
    expect(cache?.with?.path).toBe("~/.cache/code-reviewer/opencode");
    expect(String(cache?.with?.key)).toContain("opencode-pin.json");
  });

  // #856-T37
  it("fetches the pinned Claude Code before the namespace and caches it", () => {
    expect(script).toContain("scripts/fetch_claude_code.py");
    expect(script.indexOf("scripts/fetch_claude_code.py")).toBeLessThan(
      script.indexOf("unshare --net"),
    );

    const cache = steps.find(
      (step) =>
        step.uses?.startsWith("actions/cache@") &&
        String(step.with?.key).includes("claude-code"),
    );
    expect(cache?.with?.path).toBe("~/.cache/code-reviewer/claude-code");
    // The pin is the version and the digest in the layer's module, so the cache follows it.
    expect(String(cache?.with?.key)).toContain("claude_code/layer.py");
  });

  // #856-T37
  it("installs bubblewrap for the engine job and lets it make its namespace", () => {
    const text = commandLines(engine).join("\n");

    expect(text).toContain("install --yes --no-install-recommends bubblewrap");
    expect(text).toContain("kernel.apparmor_restrict_unprivileged_userns=0");
    expect(text).not.toContain("apt-get update");
  });

  // #197-T09, #713-T01
  it("runs the privileged suite in a job of its own, as root with the production capabilities and no network", () => {
    const lines = commandLines(privileged);

    expect(lines).toContain("uv sync --locked");
    expect(lines).toContain("scripts/run_privileged_offline.sh");
    expect(lines.indexOf("uv sync --locked")).toBeLessThan(
      lines.indexOf("scripts/run_privileged_offline.sh"),
    );
    expect(privileged.defaults?.run?.["working-directory"]).toBe("runner");
    // nftables is what the engine user's network rules are proven with, setcap what the execve phase needs.
    expect(lines.join("\n")).toContain("nftables");
    expect(lines.join("\n")).toContain("libcap2-bin");
    expect(lines.join("\n")).toContain("ripgrep");
    const cache = (privileged.steps ?? []).find((step) =>
      String(step.with?.key).includes("opencode"),
    );
    expect(cache?.with?.path).toBe("~/.cache/code-reviewer/opencode");
    // Root, but only with the capabilities of the hardened container spec (the container spec contract pins
    // the list), without new privileges, in a namespace that has loopback and no route out.
    expect(privilegedScript).toContain("sudo");
    expect(privilegedScript).toContain("unshare --net");
    expect(privilegedScript).toContain("ip link set lo up");
    expect(privilegedScript).toMatch(/setpriv[\s\\]+--bounding-set=-all/);
    expect(privilegedScript).toMatch(/--no-new-privs/);
    expect(privilegedScript).toContain("pytest -m privileged");
    // The pinned engine is fetched before the namespace, the only step with the internet.
    expect(privilegedScript).toContain("scripts/fetch_opencode.py");
    expect(privilegedScript.indexOf("scripts/fetch_opencode.py")).toBeLessThan(
      privilegedScript.indexOf("unshare --net"),
    );
  });

  // CR-41-T15
  it("caches the tiktoken encoding", () => {
    const cache = steps.find(
      (step) =>
        step.uses?.startsWith("actions/cache@") &&
        String(step.with?.key).includes("tiktoken"),
    );

    expect(cache?.with?.path).toBe("/tmp/data-gym-cache");
    expect(String(cache?.with?.key)).toContain("o200k_base");
  });

  // CR-41-T15
  it("grants the token read access to the contents only and uses no secrets", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(engine.permissions).toBeUndefined();
    expect(privileged.permissions).toBeUndefined();
    expect(source).not.toMatch(/secrets\./);
    expect(source).not.toMatch(/continue-on-error/);
  });

  // CR-41-T15
  it("limits the run time and pins the uv version and every third party action", () => {
    for (const job of [engine, privileged]) {
      expect(job["timeout-minutes"]).toBeGreaterThan(0);
      expect(job["timeout-minutes"]).toBeLessThanOrEqual(30);
    }
    const uses = [engine, privileged]
      .flatMap((job) => job.steps ?? [])
      .filter((step) => step.uses);
    for (const step of uses) {
      const action = String(step.uses);
      expect(action).toMatch(/@(v\d+(\.\d+){0,2}|[0-9a-f]{40})(\s|$)/);
      if (!action.startsWith("actions/"))
        expect(action).toMatch(/@[0-9a-f]{40}$/);
    }
    for (const job of [engine, privileged]) {
      const setupUv = (job.steps ?? []).find((step) =>
        step.uses?.startsWith("astral-sh/setup-uv@"),
      );
      expect(setupUv?.with?.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});
