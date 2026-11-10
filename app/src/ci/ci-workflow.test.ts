// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the structure of the CI workflow (.github/workflows/ci.yml) so that a refactor cannot
// quietly drop a check, swallow a failure, widen permissions or unpin an action. It reads the
// file as YAML; how GitHub actually runs it is verified by the CI runs themselves.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const workflowSource = readFileSync(
  `${repoRoot}.github/workflows/ci.yml`,
  "utf8",
);

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
} & Record<string, unknown>;
type Job = {
  name?: string;
  uses?: string;
  needs?: string | string[];
  if?: string;
  "timeout-minutes"?: number;
  permissions?: Record<string, string>;
  defaults?: { run?: { "working-directory"?: string } };
  steps?: Step[];
  outputs?: Record<string, string>;
} & Record<string, unknown>;
type Workflow = {
  on: {
    pull_request?: { branches?: string[] };
    push?: { branches?: string[] };
  } & Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: string | boolean };
  jobs: Record<string, Job>;
};

// The names of the two pnpm workspace projects (app/package.json, dispatcher/package.json): installs filter by them.
const APP_PACKAGE = "code-reviewer-app";
const DISPATCHER_PACKAGE = "code-reviewer-dispatcher";

const workflow = parse(workflowSource) as Workflow;
const jobs = Object.entries(workflow.jobs);

function steps(job: Job): Step[] {
  return job.steps ?? [];
}

function runCommands(job: Job): string[] {
  return steps(job).flatMap((step) => (step.run ? [step.run] : []));
}

// Every command line of every run step, trimmed, so a test can match a whole command instead of
// a substring ("pnpm test" must not be satisfied by "pnpm test:int").
function commandLines(job: Job): string[] {
  return runCommands(job).flatMap((command) =>
    command
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
  );
}

function allRunCommands(): string[] {
  return jobs.flatMap(([, job]) => runCommands(job));
}

// Every `uses:` of a step: the actions of other repositories. A local action (`./.github/actions/<name>`, a
// composite action of this repository) is part of the commit under test and cannot be pinned.
function allUses(): string[] {
  return jobs.flatMap(([, job]) =>
    steps(job).flatMap((step) =>
      step.uses && !step.uses.startsWith("./") ? [step.uses] : [],
    ),
  );
}

function localUses(): string[] {
  return jobs.flatMap(([, job]) =>
    steps(job).flatMap((step) =>
      step.uses?.startsWith("./") ? [step.uses] : [],
    ),
  );
}

function jobNamed(id: string): Job {
  const job = workflow.jobs[id];
  if (!job) throw new Error(`workflow has no job "${id}"`);
  return job;
}

describe("CI workflow triggers and jobs", () => {
  // CR-16-T01, trigger changed by #129
  it("runs on pull requests into development and main and on pushes to development and main", () => {
    expect(workflow.on.pull_request?.branches).toEqual(["development", "main"]);
    expect(workflow.on.push?.branches).toEqual(["development", "main"]);
  });

  // CR-16-T01
  it("checks formatting, lint, types, unit tests and the production build of the app", () => {
    const lines = commandLines(jobNamed("app-fast"));

    for (const command of [
      "pnpm format:check",
      "pnpm lint",
      "pnpm typecheck",
      "pnpm test",
    ]) {
      expect(lines, command).toContain(command);
    }
  });

  // #724-T03
  it("builds the App with the pinned Vercel CLI from the repository root, as the deployment does, and checks the upload", () => {
    const job = jobNamed("app-fast");
    const all = steps(job);
    const install = all.findIndex(
      (step) => step.uses === "./.github/actions/vercel-cli",
    );
    const build = all.findIndex((step) => step.run?.includes("vercel build"));
    const check = all.findIndex((step) =>
      step.run?.includes("tools/vercel/check-build-output.mjs"),
    );

    expect(install).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(install);
    expect(check).toBeGreaterThan(build);
    // Not `pnpm build`: the CLI runs `next build` itself, once.
    expect(commandLines(job)).not.toContain("pnpm build");
    expect(all[build]?.["working-directory"]).toBe("${{ github.workspace }}");
    const run = all[build]?.run ?? "";
    expect(run).toContain("vercel build --prod --yes");
    expect(run).toContain('"framework":"nextjs"');
    expect(run).toContain('"rootDirectory":"app"');
    expect(run).not.toMatch(/--token|VERCEL_TOKEN|secrets\./);
    expect(JSON.stringify(all[build]?.env ?? {})).not.toMatch(
      /secrets\.|TOKEN/,
    );
    expect(all[build]?.["continue-on-error"]).toBeUndefined();
    expect(all[check]?.run?.trim()).toBe(
      "node tools/vercel/check-build-output.mjs app",
    );
    expect(all[check]?.["continue-on-error"]).toBeUndefined();
  });

  // #105-PG-04, moved to app-int by #641
  it("runs the database integration tests against a Postgres service container", () => {
    const job = jobNamed("app-int");
    const services = job.services as
      Record<string, { image?: string }> | undefined;
    const integration = steps(job).find((step) =>
      step.run?.startsWith("pnpm test:int"),
    );
    const environment = integration?.env as Record<string, string> | undefined;

    expect(services?.postgres?.image).toMatch(/^postgres:/);
    expect(environment?.TEST_DATABASE_URL).toMatch(/^postgres:\/\//);
  });

  // CR-16-T01
  it("checks lint, formatting, types and the unit, integration and contract tests of the runner", () => {
    const lines = commandLines(jobNamed("runner-fast"));

    for (const command of [
      "uv run ruff check . ../fakes",
      "uv run ruff format --check . ../fakes",
      "uv run pyright",
      "uv run pytest -m unit",
      'uv run pytest -m "integration or contract"',
    ]) {
      expect(lines, command).toContain(command);
    }
  });

  // #124
  it("lints and type-checks the Python under fakes/ with the runner's tools, in make verify and in CI", () => {
    const makefile = readFileSync(`${repoRoot}Makefile`, "utf8");
    const pyproject = readFileSync(`${repoRoot}runner/pyproject.toml`, "utf8");

    // CI and make verify run the same commands (`$(RUNNER) run` is `uv run` inside runner/).
    expect(makefile).toContain("$(RUNNER) run ruff check . ../fakes\n");
    expect(makefile).toContain(
      "$(RUNNER) run ruff format --check . ../fakes\n",
    );
    // Pyright takes its files from the pyproject include, for both entry points.
    const include = /\[tool\.pyright\][^[]*?include = \[([^\]]*)\]/.exec(
      pyproject,
    );
    expect(include?.[1]).toContain('"../fakes"');
  });

  // CR-41-T15
  it("runs the engine suite through the shared engine workflow in its own job", () => {
    const job = jobNamed("engine");

    expect(job.needs).toBe("changes");
    expect(job.uses).toBe("./.github/workflows/engine.yml");
    expect(job.steps).toBeUndefined();
  });

  // CR-41-T15, #713
  it("runs the engine job for pull requests that change what the engine suite tests and for pull requests into main, never for pushes or app-only changes", () => {
    const condition = String(jobNamed("engine").if);

    expect(condition).toContain("github.event_name == 'pull_request'");
    expect(condition).toContain("github.base_ref == 'main'");
    expect(condition).toContain("needs.changes.outputs.engine == 'true'");
    expect(condition).not.toContain("needs.changes.outputs.runner");
    expect(condition).not.toContain("needs.changes.outputs.app");
    expect(condition).not.toContain("github.event_name == 'push'");
  });

  // CR-41-T15
  it("keeps the engine job read-only and without secrets", () => {
    const job = jobNamed("engine");

    expect(job.permissions).toEqual({ contents: "read" });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(JSON.stringify(job)).not.toContain("secrets.");
    expect(job).not.toHaveProperty("secrets");
  });

  // CR-16-T01, browser install changed by #641
  it("runs the browser smoke tests against the production build with the browser installed", () => {
    const lines = commandLines(jobNamed("e2e"));

    expect(lines).toContain("pnpm exec playwright install chromium");
    expect(lines).toContain("pnpm test:e2e --grep @smoke --grep-invert @flaky");
    expect(lines).toContain("pnpm test:e2e --grep-invert @flaky");
  });

  // CR-47 (the journey with the real runner)
  it("installs the runner and the tiktoken encoding before the browser journeys, from the lockfile and the cache", () => {
    const job = jobNamed("e2e");
    const names = steps(job).map((step) => step.name ?? step.uses ?? "");
    const install = steps(job).find((step) => step.run === "uv sync --locked");
    const prime = steps(job).find((step) =>
      step.run?.includes("scripts/prime_tiktoken_cache.py"),
    );
    const firstJourney = names.findIndex((name) =>
      name.startsWith("Run the smoke journeys"),
    );

    expect(install?.["working-directory"]).toBe("runner");
    expect(prime?.["working-directory"]).toBe("runner");
    const position = (prefix: string) =>
      names.findIndex((name) => name.startsWith(prefix));
    // uv before it is used, the cache restored before the script that fills it, both before the
    // journeys.
    expect(position("astral-sh/setup-uv@")).toBeGreaterThanOrEqual(0);
    expect(position("astral-sh/setup-uv@")).toBeLessThan(
      position("Install the runner"),
    );
    expect(position("Restore the tiktoken encoding")).toBeGreaterThanOrEqual(0);
    expect(position("Restore the tiktoken encoding")).toBeLessThan(
      position("Prime the tiktoken cache"),
    );
    expect(position("Install the runner")).toBeLessThan(firstJourney);
    expect(position("Prime the tiktoken cache")).toBeLessThan(firstJourney);
    expect(
      steps(job).some(
        (step) =>
          step.uses?.startsWith("actions/cache@") &&
          step.with?.path === "/tmp/data-gym-cache",
      ),
    ).toBe(true);
  });

  // CR-47 (the journey with the real runner)
  it("runs the browser journeys for runner changes too, because one of them runs the real runner", () => {
    const condition = String(jobNamed("e2e").if);

    expect(condition).toContain("needs.changes.outputs.app == 'true'");
    expect(condition).toContain("needs.changes.outputs.runner == 'true'");
  });

  // CR-16-T01
  it("lints the workflow files with actionlint", () => {
    const commands = runCommands(jobNamed("actionlint")).join("\n");

    expect(commands).toContain("actionlint");
    expect(
      readFileSync(`${repoRoot}.github/actionlint.yaml`, "utf8"),
    ).toContain("self-hosted-runner");
  });
});

describe("CI time limits", () => {
  const browserJobs = ["e2e", "e2e-hosted", "e2e-dynamic"];

  // #641-T01, three shards by #905
  it("runs the integration tests outside app-fast, in three shards of their own job", () => {
    const job = jobNamed("app-int");
    const matrix = (job.strategy as { matrix?: { shard?: number[] } }).matrix;

    expect(commandLines(jobNamed("app-fast")).join("\n")).not.toContain(
      "pnpm test:int",
    );
    expect(matrix?.shard).toEqual([1, 2, 3]);
    expect(commandLines(job)).toContain('pnpm test:int --shard="$SHARD/3"');
    expect(job.name).toBe("App: integration tests (${{ matrix.shard }}/3)");
    expect(
      steps(job).find((step) => step.run?.startsWith("pnpm test:int"))?.env,
    ).toMatchObject({ SHARD: "${{ matrix.shard }}" });
    expect(jobNamed("ci-passed").needs).toContain("app-int");
  });

  // #641-T01
  it("restores the browser from the cache and installs it without the apt packages, under a time limit of its own", () => {
    for (const id of browserJobs) {
      const jobSteps = steps(jobNamed(id));
      const cache = jobSteps.find(
        (step) => step.with?.path === "~/.cache/ms-playwright",
      );
      const install = jobSteps.find(
        (step) => step.run === "pnpm exec playwright install chromium",
      );

      expect(cache?.with?.key, id).toContain(
        "steps.playwright.outputs.version",
      );
      expect(install?.["timeout-minutes"], id).toBeLessThanOrEqual(5);
      expect(jobSteps.indexOf(cache!), id).toBeLessThan(
        jobSteps.indexOf(install!),
      );
      expect(runCommands(jobNamed(id)).join("\n"), id).not.toContain(
        "--with-deps",
      );
    }
  });
});

describe("CI contract types check", () => {
  // #318-T02
  it("checks the generated contract types in the app job, after the typecheck", () => {
    const lines = commandLines(jobNamed("app-fast"));

    expect(lines).toContain("pnpm contracts:check");
    expect(lines.indexOf("pnpm contracts:check")).toBeGreaterThan(
      lines.indexOf("pnpm typecheck"),
    );
  });

  // #318-T02
  it("is part of make verify, so the check can be run before opening a pull request", () => {
    const makefile = readFileSync(`${repoRoot}Makefile`, "utf8");

    expect(makefile).toMatch(/^verify: .*\bcheck-contracts\b/m);
    expect(makefile).toMatch(
      /^check-contracts:\n\t\$\(APP\) contracts:check$/m,
    );
    expect(makefile).toMatch(
      /^generate-contracts:\n\t\$\(APP\) contracts:generate$/m,
    );
  });
});

describe("CI license job", () => {
  // #118-T01
  it("installs both parts from their lockfiles and runs the dependency license check", () => {
    const job = jobNamed("licenses");
    const lines = commandLines(job);
    const install = `pnpm install --frozen-lockfile --filter ${APP_PACKAGE}... --filter ${DISPATCHER_PACKAGE}...`;

    // One workspace, one lockfile (#724): a single install covers the app and the Dispatcher.
    expect(lines).toContain(install);
    expect(lines).toContain("uv sync --locked");
    expect(lines).toContain("pnpm licenses:check");
    // Installing comes first: the check reads the metadata of what is installed.
    expect(lines.indexOf("pnpm licenses:check")).toBeGreaterThan(
      lines.indexOf("uv sync --locked"),
    );
    expect(lines.indexOf("pnpm licenses:check")).toBeGreaterThan(
      lines.indexOf(install),
    );
    expect(
      steps(job).find((step) => step.run === "uv sync --locked")?.[
        "working-directory"
      ],
    ).toBe("runner");
  });

  // #118-T01
  it("runs for code changes of either part and for every pull request into main and push", () => {
    const condition = String(jobNamed("licenses").if);

    expect(condition).toContain("github.event_name == 'push'");
    expect(condition).toContain("github.base_ref == 'main'");
    expect(condition).toContain("needs.changes.outputs.app == 'true'");
    expect(condition).toContain("needs.changes.outputs.runner == 'true'");
  });

  // #118-T01, #118-T04
  it("also checks the SPDX headers and the tests of the license policy, because the app tests that hold them are skipped for a runner-only pull request", () => {
    const lines = commandLines(jobNamed("licenses"));

    expect(lines).toContain("pnpm spdx:check");
    expect(lines).toContain(
      "pnpm exec vitest run --project unit src/ci/license-check",
    );
  });

  // #118-T01
  it("runs for a change that only touches THIRD_PARTY_LICENSES.md, which the Markdown exclusions of the app and runner filters skip", () => {
    const filterStep = steps(jobNamed("changes")).find(
      (step) => step.id === "filter",
    );
    const filters = parse(String(filterStep?.with?.filters)) as Record<
      string,
      string[]
    >;

    expect(filters.licenses).toEqual(["THIRD_PARTY_LICENSES.md"]);
    expect(jobNamed("changes").outputs).toHaveProperty("licenses");
    expect(String(jobNamed("licenses").if)).toContain(
      "needs.changes.outputs.licenses == 'true'",
    );
  });

  // #696
  it("also runs for a change to website/, because a website-only pull request skips app-fast and the checks of the whole tree must not be skipped with it", () => {
    expect(String(jobNamed("licenses").if)).toContain(
      "needs.changes.outputs.website == 'true'",
    );
  });

  // #696
  it("runs the scans of the whole tree: tracked secrets, repository identity, billing cleanup and legacy variables", () => {
    const scan = commandLines(jobNamed("licenses")).find((line) =>
      line.includes("src/ci/tracked-secrets"),
    );

    expect(scan).toBe(
      "pnpm exec vitest run --project unit src/ci/tracked-secrets src/ci/repository-identity src/ci/billing-cleanup src/ci/legacy-variables",
    );
    for (const test of [
      "tracked-secrets",
      "repository-identity",
      "billing-cleanup",
      "legacy-variables",
    ])
      expect(existsSync(`${repoRoot}app/src/ci/${test}.test.ts`), test).toBe(
        true,
      );
  });

  // #118-T01
  it("is a required part of the aggregate check, so a red license check blocks the merge", () => {
    expect(jobNamed("ci-passed").needs).toContain("licenses");
  });

  // #118-T01
  it("is part of make verify, so the check can be run before opening a pull request", () => {
    const makefile = readFileSync(`${repoRoot}Makefile`, "utf8");

    expect(makefile).toMatch(/^verify: .*\bcheck-licenses\b/m);
    expect(makefile).toMatch(/^check-licenses:\n\t\$\(APP\) licenses:check$/m);
  });
});

describe("CI Dispatcher job", () => {
  // #327 (CI wiring)
  it("checks formatting, lint, types and the unit and integration tests of the Dispatcher from the workspace lockfile", () => {
    const job = jobNamed("dispatcher-fast");
    const lines = commandLines(job);
    const install = `pnpm install --frozen-lockfile --filter ${DISPATCHER_PACKAGE}...`;

    expect(job.defaults?.run?.["working-directory"]).toBe("dispatcher");
    for (const command of [
      install,
      "pnpm format:check",
      "pnpm lint",
      "pnpm typecheck",
      "pnpm test",
      "pnpm test:int",
    ]) {
      expect(lines, command).toContain(command);
    }
    expect(lines.indexOf(install)).toBeLessThan(lines.indexOf("pnpm test"));
    // The pnpm version is the root package.json's (the action's default), the cache key the one lockfile.
    expect(
      steps(job).find((step) => step.uses?.startsWith("pnpm/action-setup@"))
        ?.with,
    ).toBeUndefined();
    expect(
      steps(job).find((step) => step.uses?.startsWith("actions/setup-node@"))
        ?.with?.["cache-dependency-path"],
    ).toBe("pnpm-lock.yaml");
  });

  // #724-T03
  it("also builds the Dispatcher from the repository root with its root directory, as the deployment does, and checks the upload", () => {
    const all = steps(jobNamed("dispatcher-fast"));
    const own = all.findIndex(
      (step) =>
        step.run?.includes("vercel build") && !step["working-directory"],
    );
    const build = all.findIndex(
      (step) =>
        step.run?.includes("vercel build") &&
        step["working-directory"] === "${{ github.workspace }}",
    );
    const run = all[build]?.run ?? "";

    expect(own).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(own);
    expect(run).toContain("vercel build --prod --yes");
    expect(run).toContain('"framework":"hono"');
    expect(run).toContain('"rootDirectory":"dispatcher"');
    expect(run).toContain(
      "node tools/vercel/check-build-output.mjs dispatcher",
    );
    expect(run).not.toMatch(/--token|VERCEL_TOKEN|secrets\./);
    expect(all[build]?.["continue-on-error"]).toBeUndefined();
  });

  // #327 (CI wiring)
  it("runs for Dispatcher changes, for every pull request into main and for pushes, and is part of the aggregate check", () => {
    const condition = String(jobNamed("dispatcher-fast").if);

    expect(condition).toContain("github.event_name == 'push'");
    expect(condition).toContain("github.base_ref == 'main'");
    expect(condition).toContain("needs.changes.outputs.dispatcher == 'true'");
    expect(jobNamed("dispatcher-fast").needs).toBe("changes");
    expect(jobNamed("ci-passed").needs).toContain("dispatcher-fast");
    expect(jobNamed("changes").outputs).toHaveProperty("dispatcher");
  });

  // #327 (CI wiring)
  it("installs the Dispatcher's dependencies in the license job and runs it for Dispatcher changes", () => {
    const job = jobNamed("licenses");
    const install = steps(job).find(
      (step) => step.name === "Install the app and dispatcher dependencies",
    );

    expect(install?.["working-directory"]).toBeUndefined();
    expect(install?.run).toBe(
      `pnpm install --frozen-lockfile --filter ${APP_PACKAGE}... --filter ${DISPATCHER_PACKAGE}...`,
    );
    expect(steps(job).indexOf(install as Step)).toBeLessThan(
      steps(job).findIndex((step) => step.run === "pnpm licenses:check"),
    );
    expect(String(job.if)).toContain(
      "needs.changes.outputs.dispatcher == 'true'",
    );
  });

  // #327 (CI wiring)
  it("is wired into every make target that covers a part, and into make verify through them", () => {
    const makefile = readFileSync(`${repoRoot}Makefile`, "utf8");

    expect(makefile).toMatch(/^lint: .*\blint-dispatcher\b/m);
    expect(makefile).toMatch(/^typecheck: .*\btypecheck-dispatcher\b/m);
    expect(makefile).toMatch(/^test-unit: .*\btest-unit-dispatcher\b/m);
    expect(makefile).toMatch(/^verify: lint typecheck /m);
    expect(makefile).toContain("$(DISPATCHER) test:int\n");
    // One workspace, one lockfile (#724): `make install` is a single root install, not one per project.
    expect(makefile).toMatch(/^install:\n\tpnpm install --frozen-lockfile\n/m);
  });
});

describe("CI workflow aggregate check", () => {
  // CR-16-T02
  it("provides one final job that waits for every other job and always runs", () => {
    const aggregate = jobNamed("ci-passed");
    const others = Object.keys(workflow.jobs).filter(
      (id) => id !== "ci-passed",
    );

    expect([...(aggregate.needs as string[])].sort()).toEqual(
      [...others].sort(),
    );
    expect(aggregate.if).toBe("${{ always() }}");
  });

  // CR-16-T04
  it("fails the aggregate job when any job failed or was cancelled", () => {
    const failStep = steps(jobNamed("ci-passed")).find((step) =>
      step.run?.includes("exit 1"),
    );

    expect(failStep?.if).toContain("contains(needs.*.result, 'failure')");
    expect(failStep?.if).toContain("contains(needs.*.result, 'cancelled')");
  });

  // CR-16-T09
  it("does not fail the aggregate job on skipped jobs", () => {
    const failStep = steps(jobNamed("ci-passed")).find((step) =>
      step.run?.includes("exit 1"),
    );

    expect(failStep?.if).not.toContain("skipped");
  });

  // CR-41-T15
  it("waits for the engine job, blocks on its failure and accepts it skipped", () => {
    const aggregate = jobNamed("ci-passed");
    const failStep = steps(aggregate).find((step) =>
      step.run?.includes("exit 1"),
    );

    expect(aggregate.needs).toContain("engine");
    expect(failStep?.if).toContain("contains(needs.*.result, 'failure')");
    expect(failStep?.if).not.toContain("skipped");
  });

  // CR-16-T04
  it("runs the app, runner, browser and workflow jobs independently so one red job stops no other", () => {
    for (const id of [
      "app-fast",
      "app-int",
      "runner-fast",
      "engine",
      "e2e",
      "licenses",
      "actionlint",
    ]) {
      expect(jobNamed(id).needs, id).toBe("changes");
    }
  });
});

describe("CI workflow path filter", () => {
  const filterStep = steps(jobNamed("changes")).find(
    (step) => step.id === "filter",
  );
  const filters = parse(String(filterStep?.with?.filters)) as Record<
    string,
    string[]
  >;

  // dorny/paths-filter with predicate-quantifier "every": a changed file counts for a filter when
  // it matches every pattern, so "**" plus negations reads "anything except ...". Globs are
  // translated by hand because the action matches dotfiles and node:path does not.
  function matches(pattern: string, file: string): boolean {
    const negated = pattern.startsWith("!");
    const source = (negated ? pattern.slice(1) : pattern)
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*\//g, "\u0000")
      .replace(/\*\*/g, "\u0001")
      .replace(/\*/g, "[^/]*")
      .replace(/\u0000/g, "(?:.*/)?")
      .replace(/\u0001/g, ".*");
    return new RegExp(`^${source}$`).test(file) !== negated;
  }

  // {a,b} lists alternatives (micromatch, as in the action): the only way to say "or" under the
  // quantifier "every".
  function alternatives(pattern: string): string[] {
    const braces = /\{([^{}]*)\}/.exec(pattern);
    if (!braces) return [pattern];
    return (braces[1] ?? "")
      .split(",")
      .flatMap((choice) => alternatives(pattern.replace(braces[0], choice)));
  }

  function touched(filter: string, file: string): boolean {
    return (filters[filter] ?? []).every((pattern) =>
      alternatives(pattern).some((choice) => matches(choice, file)),
    );
  }

  // CR-16-T09
  it("skips both sides for a change to a Markdown file at the top level", () => {
    expect(touched("app", "README.md")).toBe(false);
    expect(touched("runner", "README.md")).toBe(false);
  });

  // CR-16-T09
  it("keeps Markdown inside app in the app filter because Prettier checks it", () => {
    expect(touched("app", "app/AGENTS.md")).toBe(true);
    expect(touched("runner", "app/AGENTS.md")).toBe(false);
  });

  // CR-16-T09
  it("sends a runner-only change to the runner side only", () => {
    expect(touched("runner", "runner/src/code_reviewer_runner/cli.py")).toBe(
      true,
    );
    expect(touched("app", "runner/src/code_reviewer_runner/cli.py")).toBe(
      false,
    );
    expect(touched("runner", "runner/docs/notes.md")).toBe(false);
  });

  // CR-16-T09
  it("sends a change to a shared file to both sides", () => {
    for (const file of [
      ".nvmrc",
      "Makefile",
      ".github/workflows/ci.yml",
      "fakes/github/server.ts",
    ]) {
      expect(touched("app", file), `app ${file}`).toBe(true);
      expect(touched("runner", file), `runner ${file}`).toBe(true);
    }
  });

  // #327 (CI wiring)
  it("sends a Dispatcher change, and a change to the contracts or the fakes it reads, to the Dispatcher job, and an app-only or runner-only change not", () => {
    for (const file of [
      "dispatcher/src/app.ts",
      "dispatcher/README.md",
      "contracts/dispatch-webhook.v1.json",
      "fakes/dispatcher-app/server.ts",
      "Makefile",
    ])
      expect(touched("dispatcher", file), file).toBe(true);
    for (const file of [
      "app/src/db/index.ts",
      "runner/src/code_reviewer_runner/cli.py",
      "README.md",
    ])
      expect(touched("dispatcher", file), file).toBe(false);
  });

  // #713
  it("sends only a change to the runner, the fakes, the contracts or the engine workflow to the engine job", () => {
    for (const file of [
      "runner/src/code_reviewer_runner/cli.py",
      "runner/tests/engine/test_engine_cost.py",
      "runner/uv.lock",
      "fakes/github/server.ts",
      "contracts/dispatch-webhook.v1.json",
      ".github/workflows/engine.yml",
    ])
      expect(touched("engine", file), file).toBe(true);
    // The 24 % of merged commits that ran 21 minutes of engine tests without touching any of these.
    for (const file of [
      "app/src/db/index.ts",
      "dispatcher/src/app.ts",
      "website/src/pages/index.astro",
      "README.md",
      "Makefile",
      "docs/golden-snapshot.md",
      ".github/workflows/ci.yml",
      ".github/workflows/nightly.yml",
    ])
      expect(touched("engine", file), file).toBe(false);
  });

  // #976
  it("sends only a change to the VM artifacts, the golden snapshot's recipe they run or their workflow to the KVM job", () => {
    for (const file of [
      "docker/vm/kernel/config.fragment",
      "docker/vm/rootfs/build.sh",
      "docker/sandbox/vm-prepare.sh",
      "dispatcher/src/vm-artifacts/verify.ts",
      "dispatcher/src/snapshot/config.ts",
      "dispatcher/src/snapshot/scripts.ts",
      ".github/workflows/vm-artifacts.yml",
    ])
      expect(touched("vm", file), file).toBe(true);
    for (const file of [
      "app/src/db/index.ts",
      "dispatcher/src/app.ts",
      "dispatcher/src/snapshot/pipeline.ts",
      "runner/src/code_reviewer_runner/cli.py",
      "docs/runner.md",
      "README.md",
      ".github/workflows/ci.yml",
      ".github/workflows/vm-artifacts-release.yml",
    ])
      expect(touched("vm", file), file).toBe(false);
  });

  // #696
  it("sends a change that touches website/ to the website job, whatever else it touches, and a change outside website/ not", () => {
    for (const file of [
      "website/src/pages/index.astro",
      "website/pnpm-lock.yaml",
      "website/README.md",
    ])
      expect(touched("website", file), file).toBe(true);
    for (const file of [
      "app/src/db/index.ts",
      "README.md",
      "THIRD_PARTY_LICENSES.md",
    ])
      expect(touched("website", file), file).toBe(false);
  });

  // #696
  it("sends a change that only touches website/ to no heavy job: not app, not Dispatcher, not runner, not licenses, not workflows", () => {
    for (const file of [
      "website/src/pages/index.astro",
      "website/src/lib/analytics.ts",
      "website/public/videos/code-review-demo-v3.mp4",
      "website/pnpm-lock.yaml",
      "website/README.md",
    ])
      for (const filter of [
        "app",
        "dispatcher",
        "runner",
        "licenses",
        "workflows",
      ])
        expect(touched(filter, file), `${filter} ${file}`).toBe(false);
  });

  // #696
  it("still sends a change outside website/ to the same jobs as before when it touches website/ too", () => {
    expect(touched("app", "app/src/db/index.ts")).toBe(true);
    expect(touched("runner", "runner/src/code_reviewer_runner/cli.py")).toBe(
      true,
    );
    expect(touched("dispatcher", "dispatcher/src/app.ts")).toBe(true);
    expect(touched("app", "Makefile")).toBe(true);
  });

  // CR-16-T09
  it("lints the workflow files when anything under .github changes", () => {
    expect(filters.workflows).toEqual([".github/**"]);
  });
});

describe("CI workflow failure handling", () => {
  // CR-16-T03
  it("never lets a job or a step continue on error", () => {
    const flags: string[] = [];
    for (const [id, job] of jobs) {
      if (job["continue-on-error"] !== undefined) flags.push(id);
      for (const step of steps(job)) {
        if (step["continue-on-error"] !== undefined)
          flags.push(`${id}/${step.name ?? step.uses}`);
      }
    }

    expect(flags).toEqual([]);
    expect(workflowSource).not.toMatch(/continue-on-error/);
  });

  // CR-16-T03
  it("never swallows a failing command in a run step", () => {
    const swallowing = allRunCommands().filter((command) =>
      /\|\|\s*(true\b|:(\s|$)|exit\s+0\b)|\bset\s+\+e\b/.test(command),
    );

    expect(swallowing).toEqual([]);
  });
});

describe("CI workflow security", () => {
  // CR-16-T05
  it("grants the token read access to the repository contents only", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    for (const [id, job] of jobs) {
      for (const [scope, level] of Object.entries(job.permissions ?? {})) {
        expect(["read", "none"], `${id} permission ${scope}`).toContain(level);
      }
    }
  });

  // CR-16-T05
  it("uses no repository secrets and no privileged pull request trigger", () => {
    expect(workflowSource).not.toMatch(/secrets\./);
    expect(Object.keys(workflow.on)).not.toContain("pull_request_target");
    expect(Object.keys(workflow.on).sort()).toEqual(["pull_request", "push"]);
  });

  // CR-16-T06
  it("pins every action to a major version or a commit hash and never to a moving branch", () => {
    const uses = allUses();
    const pinned =
      /^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@(v\d+(\.\d+){0,2}|[0-9a-f]{40})(\s|$)/;

    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) {
      expect(action, action).toMatch(pinned);
      expect(action).not.toMatch(/@(main|master|latest)\b/);
    }
  });

  // CR-16-T06
  it("pins every action that is not maintained by GitHub to a commit hash", () => {
    const thirdParty = allUses().filter(
      (action) => !action.startsWith("actions/"),
    );

    expect(thirdParty.length).toBeGreaterThan(0);
    for (const action of thirdParty) {
      expect(action, action).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  // #412-T02
  it("calls only local actions that are in the repository", () => {
    for (const action of localUses())
      expect(
        existsSync(`${repoRoot}${action.slice(2)}/action.yml`),
        action,
      ).toBe(true);
  });

  // CR-16-T06
  it("pins every Docker image started by a run step to an image digest", () => {
    const dockerLines = allRunCommands()
      .flatMap((command) => command.split("\n"))
      .filter((line) => /\bdocker\s+(run|pull|create)\b/.test(line));

    expect(dockerLines.length).toBeGreaterThan(0);
    for (const line of dockerLines) {
      expect(line, line).toMatch(/\S+@sha256:[0-9a-f]{64}/);
    }
  });
});

describe("CI workflow installation and runtimes", () => {
  // CR-16-T07
  it("installs the app from its lockfile and the runner from uv.lock", () => {
    const appCommands = ["app-fast", "e2e"].flatMap((id) =>
      runCommands(jobNamed(id)),
    );
    const runnerCommands = runCommands(jobNamed("runner-fast"));

    expect(appCommands.join("\n")).toContain("pnpm install --frozen-lockfile");
    expect(runnerCommands.join("\n")).toContain("uv sync --locked");
    for (const command of allRunCommands()) {
      expect(command).not.toMatch(/pnpm install(?!.*--frozen-lockfile)/);
      expect(command).not.toMatch(/uv sync(?!.*--locked)/);
    }
  });

  // CR-16-T07
  it("takes the Node version from .nvmrc and the Python version from the runner project", () => {
    // The landing page is its own project with its own Node version (website/.nvmrc, #696).
    const setupNodeSteps = jobs.flatMap(([id, job]) =>
      steps(job)
        .filter((step) => step.uses?.startsWith("actions/setup-node@"))
        .map((step) => ({ id, step })),
    );

    expect(setupNodeSteps.length).toBeGreaterThan(0);
    for (const { id, step } of setupNodeSteps) {
      expect(step.with?.["node-version-file"], id).toBe(
        id === "website" ? "website/.nvmrc" : ".nvmrc",
      );
      expect(step.with).not.toHaveProperty("node-version");
    }
    expect(workflowSource).not.toMatch(/\bnode-version:/);
    expect(workflowSource).not.toMatch(/\bpython-version:/);
    expect(jobNamed("runner-fast").defaults?.run?.["working-directory"]).toBe(
      "runner",
    );
    expect(readFileSync(`${repoRoot}.nvmrc`, "utf8").trim()).toMatch(/^\d+/);
  });

  // CR-16-T07
  it("pins the uv version used by the runner job", () => {
    const setupUv = steps(jobNamed("runner-fast")).find((step) =>
      step.uses?.startsWith("astral-sh/setup-uv@"),
    );

    expect(setupUv?.with?.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  // CR-16-T07
  it("calls a reusable workflow only from the engine job, the one job exempt from its own time limit", () => {
    expect(
      jobs.filter(([, job]) => job.uses).map(([id, job]) => [id, job.uses]),
    ).toEqual([["engine", "./.github/workflows/engine.yml"]]);
  });

  // CR-16-T07
  it("limits the run time of every job", () => {
    // Only the job that calls the engine workflow is exempt: a job that calls a reusable workflow
    // cannot have its own limit, and the called workflow has one (engine-workflow.test.ts). Any
    // other job still needs a limit of its own.
    const exempt = (job: Job) => job.uses === "./.github/workflows/engine.yml";
    for (const [id, job] of jobs.filter(([, job]) => !exempt(job))) {
      expect(job["timeout-minutes"], `${id} timeout`).toBeGreaterThan(0);
      expect(job["timeout-minutes"], `${id} timeout`).toBeLessThanOrEqual(30);
    }
  });
});

describe("CI workflow concurrency", () => {
  // CR-16-T08
  it("cancels a superseded run for a pull request", () => {
    const cancel = workflow.concurrency?.["cancel-in-progress"];

    expect(workflow.concurrency?.group).toContain("github.ref");
    expect(cancel).toBe("${{ github.event_name == 'pull_request' }}");
  });

  // CR-16-T08
  it("gives every pushed commit its own concurrency group so no push run is cancelled or replaced", () => {
    const group = String(workflow.concurrency?.group);

    expect(group).toContain("github.event_name == 'push' && github.sha");
    expect(group).toContain("|| github.ref");
  });
});
