// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down how CI proves the Worker image and its entry modes (#324): a job of its own builds the
// `sandbox` target, the only image of the project, and runs the smoke test; the smoke test proves the
// modes (`probe`, `worker-once`), the refusal of a missing or unknown mode and the stable reasons of a
// failed probe. Docker itself runs in CI; here the wiring is judged.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

type Step = {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
} & Record<string, unknown>;
type Job = {
  needs?: string | string[];
  if?: string;
  permissions?: Record<string, string>;
  steps?: Step[];
} & Record<string, unknown>;
type Workflow = { jobs: Record<string, Job> };

function read(path: string): string {
  return readFileSync(`${repoRoot}${path}`, "utf8");
}

const ci = parse(read(".github/workflows/ci.yml")) as Workflow;
const smoke = read("docker/smoke/runner.sh");
const makefile = read("Makefile");

function job(id: string): Job {
  const found = ci.jobs[id];
  if (!found) throw new Error(`ci.yml has no job "${id}"`);
  return found;
}

describe("the CI job of the Sandbox image", () => {
  const sandbox = () => job("image-runner-sandbox");

  // #324-T09
  it("builds the sandbox target, loads it and does not push", () => {
    const builds = (sandbox().steps ?? []).filter((step) =>
      step.uses?.startsWith("docker/build-push-action@"),
    );

    expect(builds.map((step) => step.with?.["target"])).toEqual(["sandbox"]);
    expect(builds[0]?.with).toMatchObject({
      context: ".",
      file: "runner/Dockerfile",
      load: true,
      push: false,
    });
    expect(builds[0]?.with?.["tags"]).toBe("code-reviewer-runner-sandbox:ci");
  });

  // #324-T09
  it("smoke tests the sandbox image it just built", () => {
    const commands = (sandbox().steps ?? []).flatMap((step) =>
      (step.run ?? "").split("\n").map((line) => line.trim()),
    );

    expect(commands).toContain(
      "docker/smoke/runner.sh code-reviewer-runner-sandbox:ci",
    );
  });

  // #324-T04: the smoke test runs the fake App, which is Node.
  it("has the Node version of the repository for the fake App", () => {
    const setup = (sandbox().steps ?? []).find((step) =>
      step.uses?.startsWith("actions/setup-node@"),
    );
    expect(setup?.with).toMatchObject({ "node-version-file": ".nvmrc" });
  });

  // #324-T09
  it("runs on pull requests that change the runner and on those into main, has no more rights and no login", () => {
    expect(sandbox().if).toContain("github.event_name == 'pull_request'");
    expect(sandbox().if).toContain("github.base_ref == 'main'");
    expect(sandbox().if).toContain("needs.changes.outputs.runner == 'true'");
    expect(sandbox().permissions).toBeUndefined();
    expect(JSON.stringify(sandbox())).not.toMatch(
      /docker\s+(push|login)|login-action/,
    );
  });

  // #324-T09
  it("is part of the aggregate check (no image is published, see images-workflow.test.ts)", () => {
    expect(job("ci-passed").needs).toContain("image-runner-sandbox");
  });

  it("is built and smoke tested by make test-images as well", () => {
    expect(makefile).toContain("--target sandbox");
    expect(makefile).toContain(
      "docker/smoke/runner.sh code-reviewer-runner-sandbox:local",
    );
  });
});

describe("the smoke test of the entry modes", () => {
  // #324-T01 #324-T03 #324-T04 #324-T08
  it("proves probe, worker-once and worker-reap, and the refusal of a missing or unknown mode", () => {
    expect(smoke).toContain("assert_probe pr-agent not_a_dynamic_runner");
    expect(smoke).toContain("worker_once_fake_app.py");
    expect(smoke).toContain("smoke-secret-mode-0123456789");
    expect(smoke).toContain("worker-reap");
  });

  // #761 (review of #777): the canary only calls the probe; a Dynamic review runs in the image itself.
  it("runs a real Dynamic review in the image with the production flags, against fakes that share the Worker's loopback", () => {
    expect(smoke).toContain(
      'python3 -B "$here/dynamic_job_fakes.py" "$image" "${dynamic_caps[@]}" "${dynamic_rootfs[@]}" "${dynamic_env[@]}"',
    );
    const driver = readFileSync(
      `${repoRoot}docker/smoke/dynamic_job_fakes.py`,
      "utf8",
    );
    // The runner takes plain http for loopback only: the fakes are in a container whose namespace the Worker joins.
    expect(driver).toContain('"--network", f"container:{name}"');
    expect(driver).toContain('"worker-once"');
    expect(driver).toContain('"StructuredOutput" in r.get("tools", [])');
    expect(driver).toContain("a credential of the job is in the output");
  });

  // #324-T01
  it("asks for the verdict of a container made with the production flags and expects opencode", () => {
    expect(smoke).toContain(
      'assert_probe "pr-agent,opencode" "" "${dynamic_caps[@]}" "${dynamic_rootfs[@]}" "${dynamic_env[@]}"',
    );
  });

  // #324-T02
  it("proves each missing property with its stable reason: capability, nft, writable root", () => {
    for (const reason of [
      "network_rules_not_installed",
      "capabilities_not_dropped",
      "root_filesystem_writable",
    ])
      expect(smoke, reason).toContain(`assert_probe pr-agent ${reason}`);
    // A probe never prints a value of its environment.
    expect(smoke).toContain(
      "a value of the environment is in the probe verdict",
    );
  });

  // #324-T09
  it("looks for a Dispatcher bundle in the image", () => {
    expect(smoke).toContain("/opt/code-reviewer/dispatcher");
  });

  // #324-T06
  it("checks the engines file: owned by root, mode 600, on the /run tmpfs", () => {
    expect(smoke).toContain("/run/code-reviewer-engines.json");
    expect(smoke).toContain("0:0 600");
    expect(smoke).toMatch(/\/run .* - tmpfs /);
  });
});
