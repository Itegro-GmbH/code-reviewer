// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the wiring of the privileged Dynamic e2e lane (#253): the CI job that runs it, the scripts that
// arrange its namespaces, its own Playwright configuration, and the rules it keeps (a private port pair, one
// build, the preflight before anything starts, the guard loaded before anything can connect, nothing
// skipped). That the lane works is its CI run; here the structure is judged, so a refactor cannot quietly drop
// a check or turn the lane into something that skips.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function read(path: string): string {
  return readFileSync(`${repoRoot}${path}`, "utf8");
}

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  "working-directory"?: string;
  "continue-on-error"?: boolean;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
} & Record<string, unknown>;
type Job = {
  needs?: string | string[];
  if?: string;
  "runs-on"?: string;
  "timeout-minutes"?: number;
  permissions?: Record<string, string>;
  steps?: Step[];
} & Record<string, unknown>;
type Workflow = {
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
};

const ci = parse(read(".github/workflows/ci.yml")) as Workflow;
const ciRaw = ci as Workflow & Record<string, unknown>;
const engineWorkflow = parse(read(".github/workflows/engine.yml")) as Workflow;
const wrapper = read("runner/scripts/run_dynamic_e2e.sh");
const namespace = read("runner/scripts/dynamic_e2e_namespace.sh");
const config = read("app/playwright.dynamic.config.ts");
const mainConfig = read("app/playwright.config.ts");

function lane(): Job {
  const found = ci.jobs["e2e-dynamic"];
  if (!found) throw new Error('ci.yml has no job "e2e-dynamic"');
  return found;
}

function steps(): Step[] {
  return lane().steps ?? [];
}

function commands(): string[] {
  return steps().flatMap((step) =>
    (step.run ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
  );
}

/** The position of the first line of a script that contains the text; fails when there is none. */
function at(script: string, text: string): number {
  const index = script.indexOf(text);
  expect(index, `"${text}" in the script`).toBeGreaterThanOrEqual(0);
  return index;
}

describe("the CI job of the privileged Dynamic e2e lane", () => {
  // #253-C01
  it("runs the lane through its script, for every change of the app or the runner and for main", () => {
    expect(commands()).toContain("scripts/run_dynamic_e2e.sh");
    const run = steps().find((step) =>
      step.run?.includes("scripts/run_dynamic_e2e.sh"),
    );
    expect(run?.["working-directory"]).toBe("runner");
    expect(lane().if).toContain("needs.changes.outputs.app == 'true'");
    expect(lane().if).toContain("needs.changes.outputs.runner == 'true'");
    expect(lane().if).toContain("github.base_ref == 'main'");
    expect(lane().if).toContain("github.event_name == 'push'");
  });

  // #253-C02
  it("is a required part of the aggregate check, so a red lane blocks the merge", () => {
    expect(ci.jobs["ci-passed"]?.needs).toContain("e2e-dynamic");
  });

  // #253-C03
  it("never lets a failure pass: no continue-on-error, no skipped step, no filter on its tests", () => {
    for (const step of steps())
      expect(step["continue-on-error"]).toBeUndefined();
    expect(commands().join("\n")).not.toMatch(/--grep|\|\| true/);
    expect(wrapper + namespace).not.toMatch(/\|\| true/);
  });

  // #253-C04
  it("installs what the lane needs from the lockfiles and the pins: nftables, the browser, the runner, the pinned OpenCode", () => {
    const text = steps()
      .map((step) => `${step.uses ?? ""} ${step.run ?? ""}`)
      .join("\n");

    expect(text).toContain("pnpm install --frozen-lockfile");
    expect(text).toContain("playwright install chromium");
    expect(text).toContain("uv sync --locked");
    expect(text).toMatch(/apt-get install .*nftables/);
    // The pinned `rg` and OpenCode come from the fetch scripts (size and SHA-256 of the pin files), never from apt.
    expect(text).not.toMatch(/apt-get install .*ripgrep/);
    const cache = steps().find((step) =>
      String(step.with?.path ?? "").includes("code-reviewer/opencode"),
    );
    const engineCache = (engineWorkflow.jobs.engine?.steps ?? []).find((step) =>
      String(step.with?.path ?? "").includes("code-reviewer/opencode"),
    );
    expect(cache?.with?.key).toBe(engineCache?.with?.key);
  });

  // #253-C05
  it("is read-only, without secrets, time limited and pinned like the other jobs", () => {
    expect(lane().permissions ?? { contents: "read" }).toEqual({
      contents: "read",
    });
    expect(lane()["timeout-minutes"]).toBeLessThanOrEqual(25);
    expect(JSON.stringify(lane())).not.toContain("secrets.");
    for (const step of steps())
      if (step.uses?.includes("/") && !step.uses.startsWith("actions/"))
        expect(step.uses, step.uses).toMatch(/@[0-9a-f]{40}/);
  });

  // #253-C06
  it("never runs on a self-hosted runner, on pull_request_target, with a secret or with a write permission", () => {
    // The lane runs the code of the pull request as root (sudo, the namespace script, the Python runner),
    // so what makes that safe is the GitHub-hosted, ephemeral VM, a fork token without write access and no
    // secret. Moving the job to a self-hosted runner, to a privileged trigger or giving it a secret or a
    // write permission would take that away; this test makes it fail.
    const runsOn = JSON.stringify(lane()["runs-on"] ?? "");
    expect(runsOn).not.toMatch(/self-hosted/i);
    expect(lane()["runs-on"]).toMatch(/^(ubuntu|windows|macos)-[\w.-]+$/);

    const triggers = JSON.stringify((ciRaw as { on?: unknown }).on ?? {});
    expect(triggers).not.toContain("pull_request_target");
    expect(triggers).not.toContain("workflow_run");

    expect(JSON.stringify(lane())).not.toMatch(/secrets\.|secrets:/);
    expect(JSON.stringify(ciRaw)).not.toMatch(/secrets\.|secrets:/);

    // The job's own permissions (or, without any, the workflow's) are read only.
    const effective = lane().permissions ?? ciRaw.permissions ?? {};
    expect(Object.keys(effective).length).toBeGreaterThan(0);
    for (const [scope, level] of Object.entries(effective))
      expect(level, `permission ${scope}`).toMatch(/^(read|none)$/);
    expect(ciRaw.permissions).toEqual({ contents: "read" });
  });

  // #253-C07
  it("checks out without keeping the git credentials in the workspace, like the other jobs that run repository code as root", () => {
    for (const [name, job] of [
      ["e2e-dynamic", lane()],
      ["engine", engineWorkflow.jobs.engine],
    ] as const) {
      const checkouts = (job?.steps ?? []).filter((step) =>
        step.uses?.startsWith("actions/checkout@"),
      );
      expect(checkouts.length, name).toBeGreaterThan(0);
      for (const checkout of checkouts)
        expect(checkout.with?.["persist-credentials"], name).toBe(false);
    }
  });

  // #253-C05
  it("keeps the reports of a failing lane, with the log of the runner and of the app", () => {
    const upload = steps().find((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );

    expect(upload?.if).toContain("failure()");
    expect(String(upload?.with?.path)).toContain("app/test-results");
    expect(String(upload?.with?.path)).toContain("app/playwright-report");
  });
});

describe("the scripts of the lane", () => {
  // #253-N01
  it("run the lane as root in a network namespace of its own, with a pid namespace that ends everything with it", () => {
    expect(wrapper).toContain("set -euo pipefail");
    expect(wrapper).toContain(
      "unshare --net --mount --pid --fork --mount-proc",
    );
    expect(wrapper).toContain("sudo --preserve-env");
    expect(wrapper).toContain("scripts/dynamic_e2e_namespace.sh");
    expect(namespace).toContain("set -euo pipefail");
  });

  // #253-N05
  it("install the fetched tools from a copy that only root can change, never straight from the user's cache", () => {
    // The fetch scripts leave the files in a directory of the invoking user. Root copies them into the lane's
    // own tmpfs (root owned, mode 0700, mounted in this mount namespace only) and installs from the copy, so
    // nothing can swap a file between the check and the install. The pin check (self-check, preflight) stays.
    const copy = at(namespace, 'cp "$LANE_OPENCODE_BIN"');
    expect(namespace).toContain('cp "$LANE_RIPGREP_BIN"');
    expect(namespace).not.toMatch(
      /install\b[^\n]*"\$LANE_(OPENCODE|RIPGREP)_BIN"/,
    );
    expect(namespace).toMatch(
      /install -d -m 0700 -o root -g root "\$STAGE\/tools"/,
    );
    expect(copy).toBeLessThan(at(namespace, "/usr/local/bin/opencode"));
  });

  // #253-N06
  it("give the files that root created in the user's tree back to the invoking user, however the lane ends", () => {
    expect(wrapper).toMatch(/trap [^\n]*give_back[^\n]* EXIT/);
    expect(wrapper).toMatch(
      /give_back\(\) \{[\s\S]*sudo[^\n]*find[^\n]*-user root[^\n]*chown -h/,
    );
    // Both trees the lane writes to: the app (test-results, playwright-report, .next/cache) and the runner.
    expect(wrapper).toMatch(/find "\$APP_DIR" "\$RUNNER_DIR"/);
  });

  // #253-N02
  it("load the network guard before anything can connect, then check the lane, and only then run the journeys", () => {
    const guard = at(namespace, "nft -f");
    const route = at(namespace, "ip route add default");
    const tools = at(namespace, "/usr/local/bin/opencode");
    const preflight = at(namespace, "dynamic-preflight-command.ts");
    const playwright = at(
      namespace,
      "playwright test -c playwright.dynamic.config.ts",
    );
    const lastWord = at(namespace, "dynamic-lane-guard-command.ts");

    expect(guard).toBeLessThan(route);
    expect(tools).toBeLessThan(preflight);
    expect(preflight).toBeLessThan(playwright);
    expect(playwright).toBeLessThan(lastWord);
    // Loopback is the only network; the way out leads into a veth pair nothing answers on.
    expect(namespace).toContain("ip link set lo up");
    expect(namespace).toContain("e2e/dynamic/guard.nft");
  });

  // #253-N03
  it("stage the tools where the Dynamic image has them, in this namespace only, and add the engine user", () => {
    expect(namespace).toContain("/usr/local/bin/rg");
    expect(namespace).toContain("/opt/code-reviewer/pins");
    expect(namespace).toContain("opencode-pin.json");
    expect(namespace).toContain("ripgrep-pin.json");
    expect(namespace).toContain("10101:cr-engine");
    expect(namespace).toContain("10001:cr-job");
    expect(namespace).toMatch(/mount -t overlay .* \/usr\/local\/bin/);
    expect(namespace).toMatch(/mount --bind .* \/etc\/passwd/);
    // The host is not changed: no useradd, no copy into /usr/local/bin outside of the overlay.
    expect(namespace).not.toMatch(/useradd|groupadd/);
  });

  // #253-N04
  it("fetch the pinned OpenCode and ripgrep, make the one build, and keep to a private port pair", () => {
    expect(wrapper).toContain("scripts/fetch_opencode.py");
    expect(wrapper).toContain("scripts/fetch_ripgrep.py");
    // The pinned git of the Implementer (#767): built from the verified source, never taken from the host.
    expect(wrapper).toContain("scripts/build_lane_git.sh");
    expect(wrapper.match(/pnpm build/g)).toHaveLength(1);
    expect(wrapper).toContain("E2E_REUSE_BUILD");
    expect(wrapper).toMatch(/3000:\*/);
    expect(wrapper).toMatch(/3100:\*/);
    expect(config).toMatch(/port === 3000 \|\| port === 3100/);
    // The configuration itself never builds: it starts the build that was made.
    expect(config).not.toMatch(/pnpm build|next build/);
  });

  // #253-N05
  it("end by checking that no process of the lane is left and by reading the guard once more", () => {
    expect(namespace).toContain("Processes of the lane are still running");
    expect(namespace).toMatch(/dynamic-lane-guard-command\.ts/);
    expect(namespace.trimEnd().endsWith('exit "$status"')).toBe(true);
  });
});

describe("the Playwright configuration of the lane", () => {
  // #253-N06
  it("is separate from the one of the other journeys, which never run the lane and are never run by it", () => {
    expect(config).toContain('testDir: "e2e/dynamic"');
    expect(config).toContain("playwright.config.ts");
    expect(mainConfig).toMatch(/testIgnore:[\s\S]*\/e2e\\\/dynamic\\\//);
    expect(mainConfig).not.toContain("e2e/dynamic");
  });

  // #253-N07
  it("runs one worker, has the preflight as its global setup and starts the fake GitHub and the hosted journey's app (#332)", () => {
    expect(config).toContain("workers: 1");
    expect(config).toContain(
      'globalSetup: "./e2e/dynamic/preflight.global-setup.ts"',
    );
    // The fake GitHub, the hosted journey's app, and the factory's app of the Implementer's journeys (#767).
    expect(config.match(/command:/g)).toHaveLength(3);
    expect(config).toContain("fakes/github/main.ts");
    expect(config).toContain("next start");
  });

  // #767
  it("starts the factory app of the Implementer's journeys from the same build, with its own database, port and credentials", () => {
    expect(config).toContain('PRODUCT_ID: "factory"');
    expect(config).toContain(
      'PRODUCT_CAPABILITIES: "review,dynamic-review,implementer"',
    );
    expect(config).toContain("factoryDatabase.app");
    expect(config).toContain("factoryEnv.appPort");
    expect(config).toContain("RUNNER_TOKEN: factoryEnv.dispatcherToken");
    expect(config).toContain("RUNNER_WEBHOOK_SECRET: factoryEnv.webhookSecret");
    // One build for both apps; the second never builds.
    expect(config).not.toMatch(/pnpm build|next build/);
    // The journeys run one after the other: the Implementer's after the hosted one, which has the Dispatcher's port.
    expect(config).toMatch(
      /name: "implementer"[\s\S]*dependencies: \["prepare-factory", "guard", "hosted"\]/,
    );
  });

  // #253-N08
  it("does not turn on the Dynamic Review gate of any shipped configuration", () => {
    // The lane turns it on in its own database through the admin API (the journey), nowhere else.
    expect(config).not.toMatch(/dynamic_review|DYNAMIC_REVIEW/);
    const shipped = read(
      "contracts/examples/worker-container/WorkerContainerSpec.json",
    );
    expect(shipped).not.toMatch(/dynamic_review|dynamicReview/);
  });
});

describe("what the Implementer's journeys add to the lane (#767)", () => {
  const container = read("runner/scripts/dynamic_e2e_worker_container.sh");
  const journey = read("app/e2e/dynamic/hosted-implementer.e2e.ts");

  // #767
  it("builds the pinned git in the CI job and caches it, from headers installed by apt and nothing else of the host", () => {
    const text = steps()
      .map((step) => `${step.uses ?? ""} ${step.run ?? ""}`)
      .join("\n");

    expect(text).toMatch(/apt-get install .*libcurl4-openssl-dev/);
    const cache = steps().find((step) =>
      String(step.with?.path ?? "").includes("code-reviewer/lane-git"),
    );
    expect(String(cache?.with?.key)).toContain("runner/git-pin.json");
    expect(String(cache?.with?.key)).toContain("build_lane_git.sh");
    const script = read("runner/scripts/build_lane_git.sh");
    // The same release and the same variables as the Worker image's git-build stage.
    expect(script).toContain("fetch_toolchain.py --component git");
    const dockerfile = read("runner/Dockerfile");
    for (const variable of [
      "INSTALL_SYMLINKS=1",
      "NO_GETTEXT=1",
      "NO_PERL=1",
      "NO_PYTHON=1",
      "NO_TCLTK=1",
      "NO_EXPAT=1",
      "NO_LIBPCRE2=1",
      "NO_OPENSSL=1",
    ]) {
      expect(script, variable).toContain(variable);
      expect(dockerfile, variable).toContain(variable);
    }
  });

  // #767
  it("installs git, the guard files and the mount point of the work volume in the namespace, root-owned", () => {
    expect(namespace).toContain('"$LANE_GIT_TREE/usr/local/$directory/."');
    expect(namespace).toMatch(/--no-preserve=ownership/);
    expect(namespace).toMatch(
      /install -m 0755 -o root -g root .*guard\/reference-transaction.*guard_matrix\.sh" \/opt\/code-reviewer\/guard\//,
    );
    expect(namespace).toContain("mkdir /work");
    // The preflight names what is missing before any journey starts.
    expect(read("app/e2e/helpers/dynamic-preflight.ts")).toContain(
      "/opt/code-reviewer/guard",
    );
  });

  // #767
  it("gives each container a fresh work volume of its own, read-write, nosuid, nodev and executable, before the root goes read-only", () => {
    expect(container).toMatch(
      /mount -t tmpfs -o rw,nosuid,nodev,exec,size=3g,mode=0755 tmpfs "\$RUNNER_IMPLEMENTER_WORK_DIR"/,
    );
    expect(at(container, "make_work_volume ||")).toBeLessThan(
      at(container, "make_root_read_only ||"),
    );
  });

  // #767
  it("runs the journeys on a Dispatcher whose registry names the kind implementer, with the Worker started as the container is, and without filter, skip or retry", () => {
    expect(journey).toContain('kinds: ["diff", "dynamic", "implementer"]');
    expect(journey).toContain("unsetForWorkerOnce: []");
    expect(journey).toContain("E2E_WORKER_WRAPPER: WRAPPER");
    expect(journey).toContain("operatorToken: factoryEnv.operatorToken");
    expect(journey).not.toMatch(/\.skip|\.fixme|\.only|test\.slow|retries/);
    expect(journey).not.toMatch(/mode: "serial"/);
    // One test per journey of the issue, named by its case.
    for (let number = 1; number <= 12; number += 1)
      expect(journey).toContain(`E${String(number).padStart(2, "0")} `);
  });
});
