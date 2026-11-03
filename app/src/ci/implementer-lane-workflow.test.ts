// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down how CI proves a whole Implementer turn (#745, step 4): a job of its own builds the Worker image and the agent
// image, and runs runner/tests/lane as root on the runner's Docker daemon, under runc (CI has no Sysbox). Docker itself
// runs in CI; here the wiring is judged.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

type Step = {
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
} & Record<string, unknown>;
type Job = {
  needs?: string | string[];
  if?: string;
  permissions?: Record<string, string>;
  "timeout-minutes"?: number;
  steps?: Step[];
} & Record<string, unknown>;
type Workflow = { jobs: Record<string, Job> };

const read = (path: string): string =>
  readFileSync(`${repoRoot}${path}`, "utf8");
const ci = parse(read(".github/workflows/ci.yml")) as Workflow;

function lane(): Job {
  const found = ci.jobs["implementer-lane"];
  if (!found) throw new Error('ci.yml has no job "implementer-lane"');
  return found;
}

const steps = (): Step[] => lane().steps ?? [];

describe("the CI job of the Implementer lane", () => {
  // #745-T28
  it("builds the sandbox and the agent target and runs the lane as root, under runc, with the images it built", () => {
    const builds = steps().filter((step) =>
      step.uses?.startsWith("docker/build-push-action@"),
    );
    expect(builds.map((step) => step.with?.target)).toEqual([
      "sandbox",
      "agent",
    ]);
    for (const build of builds) {
      expect(build.with?.load).toBe(true);
      expect(build.with?.push).toBe(false);
    }
    const run = steps().find((step) => step.run?.includes("tests/lane"));
    expect(run?.run).toContain("sudo -E");
    expect(run?.run).toContain("-m lane");
    expect(run?.env).toMatchObject({
      LANE_WORKER_IMAGE: builds[0]?.with?.tags,
      LANE_AGENT_IMAGE: builds[1]?.with?.tags,
      LANE_RUNTIME: "runc",
    });
    // The runner is installed from its lockfile before the lane runs.
    const install = steps().findIndex(
      (step) => step.run === "uv sync --locked",
    );
    expect(install).toBeGreaterThanOrEqual(0);
    expect(install).toBeLessThan(steps().indexOf(run as Step));
  });

  // #745-T28
  it("runs for pull requests that change the runner, and every pull request into main", () => {
    const condition = String(lane().if);

    expect(condition).toContain("github.event_name == 'pull_request'");
    expect(condition).toContain("github.base_ref == 'main'");
    expect(condition).toContain("needs.changes.outputs.runner == 'true'");
    expect(lane().needs).toBe("changes");
  });

  // #745-T28
  it("has no secret, no login, no push and no more rights than the image jobs, and room for the image builds", () => {
    expect(lane().permissions).toBeUndefined();
    expect(JSON.stringify(lane())).not.toMatch(
      /secrets\.|docker\s+(push|login)|login-action|pull_request_target/,
    );
    expect(lane()["timeout-minutes"]).toBeGreaterThanOrEqual(30);
    expect(
      steps().find((step) => step.uses?.startsWith("actions/checkout@"))?.with,
    ).toMatchObject({ "persist-credentials": false });
  });

  // #745-T28
  it("is part of the aggregate check, so a red lane blocks the merge", () => {
    expect(ci.jobs["ci-passed"]?.needs).toContain("implementer-lane");
  });

  // #745-T28
  it("is a make target that builds both targets and runs the lane as root", () => {
    const makefile = read("Makefile");
    const recipe = makefile.slice(makefile.indexOf("\ntest-lane:"));

    expect(recipe).toContain(
      "--target sandbox --tag code-reviewer-worker:lane",
    );
    expect(recipe).toContain("--target agent --tag code-reviewer-agent:lane");
    expect(recipe).toContain("sudo -E");
    expect(recipe).toContain("-m lane tests/lane");
  });

  // #745-T28: the journeys of the lane are the ones of the plan that still mean something
  it("holds the journeys of the plan's table that belong to the agent in a container of its own", () => {
    const text = [
      "runner/tests/lane/test_implementer_turn.py",
      "runner/tests/lane/test_implementer_git.py",
      "runner/tests/lane/test_reader_hostile.py",
    ]
      .map(read)
      .join("\n");

    for (const journey of [
      "E01",
      "E03",
      "E04",
      "E05",
      "E06",
      "E07",
      "E09",
      "E12",
      "E15",
    ])
      expect(text, journey).toContain(`# #745-${journey}\n`);
  });
});
