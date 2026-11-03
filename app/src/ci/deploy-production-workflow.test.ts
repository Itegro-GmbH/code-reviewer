// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the production deployment of the hosted version (#403): .github/workflows/deploy-production.yml checks
// that the run is current, migrates the database, decides whether the golden snapshot is rebuilt (and rebuilds it),
// stages the App and then the Dispatcher with the Vercel CLI (a staged deployment takes no domain), checks the App's
// health, runs the Dispatcher canary on the staged Dispatcher and only then promotes both, one project at a time.
// Only after the Dispatcher is live is the snapshot pair written to Infisical, and only after that are old snapshots
// removed. A failure before the promotion leaves production on the old deployments and the old pair. It reads the
// files as YAML and runs the shell of the steps against stand-ins; that the platform accepts the run is verified by
// the first real one (docs/deployment-vercel.md, section 8).
import { describe, expect, it } from "vitest";
import { runStep } from "./shell-support.ts";
import {
  isInfisicalLoad,
  needsOf,
  readText,
  readWorkflow,
  runsVercel,
  stepIndex,
  stepsOf,
  type Job,
  REPOSITORY,
} from "./workflow-support.ts";

const source = readText(".github/workflows/deploy-production.yml");
const workflow = readWorkflow("deploy-production.yml");
const stageSource = readText(".github/workflows/vercel-stage.yml");
const stage = readWorkflow("vercel-stage.yml");
const stageJob = stage.jobs.stage as Job;
const job = (name: string): Job => {
  const found = workflow.jobs[name];
  if (!found) throw new Error(`no job "${name}"`);
  return found;
};
const REPOSITORY_GUARD = `github.repository == '${REPOSITORY}'`;
const MAIN_GUARD = "github.ref == 'refs/heads/main'";

describe("the production deployment workflow", () => {
  // #403-T05
  it("runs for a push to main and on demand, and for nothing else", () => {
    expect(Object.keys(workflow.on).sort()).toEqual([
      "push",
      "workflow_dispatch",
    ]);
    expect((workflow.on.push as { branches?: string[] }).branches).toEqual([
      "main",
    ]);
  });

  // #403-T08
  it("lets deployments queue one behind the other and never cancels one in progress", () => {
    expect(workflow.concurrency).toEqual({
      group: "deploy-production",
      "cancel-in-progress": false,
    });
    for (const name of Object.keys(workflow.jobs))
      expect(job(name).concurrency, name).toBeUndefined();
  });

  // #403-T07
  it("has the jobs of the pipeline, in the order they are written", () => {
    expect(Object.keys(workflow.jobs)).toEqual([
      "fresh",
      "migrate",
      // The dormant factory lane's switch and migration (#732): jobs of their own, the first App's `migrate` stays as it was.
      "factory-flag",
      "migrate-factory",
      "snapshot-decide",
      "snapshot-build",
      "stage-app",
      "stage-dispatcher",
      // The dormant factory lane (#732, factory-lane-workflow.test.ts) sits among them, never in front of them.
      "stage-factory",
      "health-app",
      "health-factory",
      "canary",
      "apps-check",
      "promote-app",
      "promote-factory",
      "promote-dispatcher",
      "persist",
      "cleanup",
      "discard",
      "record",
    ]);
  });

  // #403-T07
  it("migrates only after the run is known to be current, and decides about the snapshot after the migration", () => {
    expect(needsOf(job("fresh"))).toEqual([]);
    expect(needsOf(job("migrate"))).toEqual(["fresh"]);
    expect(needsOf(job("snapshot-decide"))).toEqual(["migrate"]);
    expect(needsOf(job("snapshot-build"))).toEqual(["snapshot-decide"]);
    expect(needsOf(job("stage-app"))).toEqual(["migrate"]);
  });

  // #403-T13
  it("builds the snapshot only when the decision says so, with the golden snapshot workflow", () => {
    const build = job("snapshot-build");
    expect(build.uses).toBe("./.github/workflows/golden-snapshot.yml");
    expect(String(build.if)).toContain(
      "needs.snapshot-decide.outputs.rebuild == 'true'",
    );
    expect(String(build.if)).toContain(REPOSITORY_GUARD);
  });

  // #403-T13
  it("stages the Dispatcher only with a pair: the one just built or the one in use, never none", () => {
    const dispatcher = job("stage-dispatcher");
    expect(needsOf(dispatcher).sort()).toEqual([
      "snapshot-build",
      "snapshot-decide",
      "stage-app",
    ]);
    const condition = String(dispatcher.if);
    // The snapshot job may be skipped (nothing to rebuild) but not failed.
    expect(condition).toContain(
      "needs.snapshot-build.result == 'success' || needs.snapshot-build.result == 'skipped'",
    );
    expect(condition).toContain("needs.stage-app.result == 'success'");
    expect(condition).toContain("needs.snapshot-decide.result == 'success'");
    for (const [name, output] of [
      ["snapshot-id", "snapshot-id"],
      ["image-digest", "image-digest"],
      ["snapshot-commit", "commit"],
      ["sysbox-proof", "sysbox"],
    ] as const)
      expect(dispatcher.with?.[name]).toBe(
        `\${{ needs.snapshot-build.outputs.${output} || needs.snapshot-decide.outputs.${output} }}`,
      );
    expect(job("stage-app").with?.["snapshot-id"]).toBeUndefined();
  });

  // #403-T07
  it("proves the staged App and the staged Dispatcher before anything is promoted, and the canary checks the image of the pair", () => {
    expect(needsOf(job("health-app"))).toEqual(["stage-app"]);
    expect(needsOf(job("canary")).sort()).toEqual([
      "health-app",
      "snapshot-build",
      "snapshot-decide",
      "stage-dispatcher",
    ]);
    const canary = job("canary");
    expect(canary.uses).toBe("./.github/workflows/dispatcher-canary.yml");
    expect(canary.with?.url).toBe("${{ needs.stage-dispatcher.outputs.url }}");
    expect(canary.with?.image_digest).toBe(
      "${{ needs.snapshot-build.outputs.image-digest || needs.snapshot-decide.outputs.image-digest }}",
    );
    // #408-T01: the environment's secrets reach a called workflow only when the caller passes them (called-workflow-secrets.test.ts).
    expect(canary.secrets).not.toBe("inherit");
    expect(String(canary.if)).toContain(
      "needs.stage-dispatcher.result == 'success'",
    );
    expect(String(canary.if)).toContain("needs.health-app.result == 'success'");
  });

  // #403-T07
  it("promotes the App and then the Dispatcher, each only after both stages, the health check and the canary", () => {
    const required = ["stage-app", "stage-dispatcher", "health-app", "canary"];
    for (const name of ["promote-app", "promote-dispatcher"])
      for (const need of required)
        expect(needsOf(job(name)), name).toContain(need);
    expect(needsOf(job("promote-dispatcher"))).toContain("promote-app");
    // The jobs in front of the promotion take the implicit success(), so a failure upstream skips them.
    for (const name of ["health-app", "stage-app"])
      expect(String(job(name).if), name).not.toMatch(
        /always\(\)|failure\(\)|cancelled\(\)|success\(\)/,
      );
    // The promotions need a status function to run when the snapshot job was skipped (#480), so they check every job
    // they need instead, and never run after a failure or a cancel (deploy-production-promotion.test.ts).
    for (const name of ["promote-app", "promote-dispatcher"]) {
      expect(String(job(name).if), name).toContain("!cancelled()");
      expect(String(job(name).if), name).not.toMatch(
        /always\(\)|failure\(\)|success\(\)|(?<!!)cancelled\(\)/,
      );
    }
  });

  // #403-T19
  it("writes the pair to Infisical only after the Dispatcher is live, and removes old snapshots only after that", () => {
    const persist = job("persist");
    expect(needsOf(persist)).toContain("promote-dispatcher");
    expect(String(persist.if)).toContain(
      "needs.promote-dispatcher.result == 'success'",
    );
    // Only when something changed: a rebuild, or variables that are behind the live pair.
    expect(String(persist.if)).toContain(
      "needs.snapshot-decide.outputs.rebuild == 'true'",
    );
    expect(String(persist.if)).toContain(
      "needs.snapshot-decide.outputs.repair == 'true'",
    );

    // The cleanup follows every promotion of the Dispatcher, after persist when persist had something to do. The
    // keep list makes it safe to repeat, and it clears what an earlier run could not.
    const cleanup = job("cleanup");
    expect(needsOf(cleanup)).toContain("persist");
    expect(needsOf(cleanup)).toContain("promote-dispatcher");
    const condition = String(cleanup.if);
    expect(condition).toContain("needs.promote-dispatcher.result == 'success'");
    expect(condition).toContain(
      "needs.persist.result == 'success' || needs.persist.result == 'skipped'",
    );
    // A persist that failed holds the cleanup back.
    expect(condition).not.toMatch(/persist\.result != /);
  });

  // #403-T19
  it("keeps the new snapshot and the previous one when it cleans up, and takes the pair of the run from its outputs", () => {
    const step = stepsOf(job("cleanup")).find((s) =>
      (s.run ?? "").includes("snapshot:ops cleanup"),
    );
    // The snapshot the run built, or, when nothing was rebuilt, the one it reuses.
    expect(step?.env?.NEW_SNAPSHOT_ID).toBe(
      "${{ needs.snapshot-build.outputs.snapshot-id || needs.snapshot-decide.outputs.snapshot-id }}",
    );
    expect(step?.env?.PREVIOUS_SNAPSHOT_ID).toBe(
      "${{ needs.snapshot-decide.outputs.previous-snapshot-id }}",
    );
    expect(step?.run).toContain(
      'KEEP_SNAPSHOT_IDS="${NEW_SNAPSHOT_ID} ${PREVIOUS_SNAPSHOT_ID}"',
    );
    expect(step?.env?.DISCARD_SNAPSHOT_ID).toBeUndefined();
  });

  // #403-T19
  it("discards the snapshot of a run that built one and did not get live, and only then", () => {
    const discard = job("discard");
    const condition = String(discard.if);
    expect(condition).toContain("always()");
    expect(condition).toContain("needs.snapshot-build.result == 'success'");
    // Only when the promotion never started. After a failure or a cancel the outcome is unknown (a promotion that
    // timed out can still land), and the snapshot is left to the next cleanup, which keeps the live one.
    expect(condition).toContain("needs.promote-dispatcher.result == 'skipped'");
    expect(condition).not.toContain("promote-dispatcher.result != ");
    expect(condition).not.toContain("'failure'");
    const step = stepsOf(discard).find((s) =>
      (s.run ?? "").includes("snapshot:ops cleanup"),
    );
    expect(step?.env?.DISCARD_SNAPSHOT_ID).toBe(
      "${{ needs.snapshot-build.outputs.snapshot-id }}",
    );
    // It keeps what production runs now.
    expect(step?.run).toContain('KEEP_SNAPSHOT_IDS="${PREVIOUS_SNAPSHOT_ID}"');
  });

  // #403-T05
  it("guards every job with the repository and the main branch, in the job and not in a branch filter", () => {
    for (const [name, found] of Object.entries(workflow.jobs)) {
      const condition = String(found.if);
      expect(condition, name).toContain(REPOSITORY_GUARD);
      expect(condition, name).toContain(MAIN_GUARD);
      expect(condition.match(/github\.ref\b/g), name).toHaveLength(1);
      expect(condition, name).not.toMatch(/startsWith|contains\(github\.ref/);
    }
    const guard = String(stageJob.if);
    expect(guard).toContain(REPOSITORY_GUARD);
    expect(guard).toContain(MAIN_GUARD);
    expect(Object.keys(stage.on)).toEqual(["workflow_call"]);
  });

  // #403-T05
  it("holds nothing but read access to the repository, and writes deployments only where it records them", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(source).not.toMatch(/id-token|packages:\s*write|contents:\s*write/);
    const writers = Object.entries(workflow.jobs)
      .filter(([, found]) => found.permissions?.deployments === "write")
      .map(([name]) => name);
    expect(writers.sort()).toEqual([
      "record",
      "stage-app",
      "stage-dispatcher",
      "stage-factory",
    ]);
    for (const found of [...Object.values(workflow.jobs), stageJob])
      expect(found.permissions?.contents, found.name).toBe("read");
  });

  // #403-T06
  it("runs every job that signs in to Infisical in the environment production", () => {
    for (const name of [
      "migrate",
      "migrate-factory",
      "snapshot-decide",
      "health-app",
      "health-factory",
      "apps-check",
      "promote-app",
      "promote-factory",
      "promote-dispatcher",
      "persist",
      "cleanup",
      "discard",
    ])
      expect(job(name).environment, name).toBe("production");
    expect(stageJob.environment).toBe("production");
    expect(readWorkflow("dispatcher-canary.yml").jobs.canary?.environment).toBe(
      "production",
    );
    expect(readWorkflow("golden-snapshot.yml").jobs.build?.environment).toBe(
      "production",
    );
    expect(source).not.toMatch(/secrets: inherit/);
  });

  // #403-T06
  it("loads credentials after the dependencies are installed, in every job that installs any, and the read jobs never write to Infisical", () => {
    for (const [name, found] of Object.entries(workflow.jobs)) {
      const steps = stepsOf(found);
      const load = stepIndex(found, isInfisicalLoad);
      const install = steps.findIndex((s) =>
        /pnpm install --frozen-lockfile --filter \S+\.\.\./.test(s.run ?? ""),
      );
      if (load >= 0 && install >= 0)
        expect(load, name).toBeGreaterThan(install);
    }
  });

  // #403-T07
  it("migrates the database first with the migrate role's URL from Infisical, before anything is deployed", () => {
    const migrate = job("migrate");
    const load = stepIndex(migrate, isInfisicalLoad);
    const run = stepIndex(migrate, (step) =>
      (step.run ?? "").includes("pnpm --dir app migrate"),
    );
    const install = stepIndex(migrate, (step) =>
      (step.run ?? "").includes(
        "pnpm install --frozen-lockfile --filter code-reviewer-app...",
      ),
    );
    expect(install).toBeGreaterThanOrEqual(0);
    expect(load).toBeGreaterThan(install);
    expect(run).toBeGreaterThan(load);
    expect(stepsOf(migrate)[load]?.with?.["secret-names"]).toBe(
      "DATABASE_URL_MIGRATE",
    );
    expect(JSON.stringify(stepsOf(migrate)[run])).not.toContain("secrets.");
    expect(source).not.toMatch(/\bDATABASE_URL:/);
  });

  // #403-T08
  it("stages the App and then the Dispatcher with the same reusable workflow, each from the commit that triggered the run", () => {
    for (const [name, directory, project] of [
      ["stage-app", "app", "VERCEL_APP_PROJECT_ID"],
      ["stage-dispatcher", "dispatcher", "VERCEL_DISPATCHER_PROJECT_ID"],
    ] as const) {
      const found = job(name);
      expect(found.uses).toBe("./.github/workflows/vercel-stage.yml");
      expect(found.with).toMatchObject({
        project: name === "stage-app" ? "app" : "dispatcher",
        directory,
        "project-id-secret": project,
        ref: "${{ github.sha }}",
      });
      expect(found.secrets).not.toBe("inherit");
    }
  });

  // #403-T08
  it("installs the Vercel CLI from the committed lockfile in every job that runs it, never from the registry's latest", () => {
    for (const file of [
      "vercel-stage.yml",
      "deploy-production.yml",
      "rollback-production.yml",
    ]) {
      const text = readText(`.github/workflows/${file}`);
      expect(text, file).not.toMatch(
        /(?<!p)npm install|vercel@|VERCEL_CLI_VERSION/,
      );
      const parsed = readWorkflow(file);
      for (const [name, found] of Object.entries(parsed.jobs)) {
        const steps = stepsOf(found);
        const first = steps.findIndex((s) =>
          /(^|[\s(])vercel (pull|build|deploy|promote|rollback)\b/m.test(
            s.run ?? "",
          ),
        );
        if (first < 0) continue;
        const cli = steps.findIndex(
          (s) => s.uses === "./.github/actions/vercel-cli",
        );
        expect(cli, `${file}: ${name}`).toBeGreaterThanOrEqual(0);
        expect(cli, `${file}: ${name}`).toBeLessThan(first);
      }
    }
  });

  // #403-T08
  it("installs the dependencies, then the CLI, then loads the credentials, then pulls, builds without the token and deploys", () => {
    const steps = stepsOf(stageJob);
    const at = (command: string) =>
      steps.findIndex((step) => runsVercel(step, command));
    const install = steps.findIndex((s) =>
      /pnpm install --frozen-lockfile --filter "\.\/\$DIRECTORY\.\.\."/.test(
        s.run ?? "",
      ),
    );
    const load = stepIndex(stageJob, isInfisicalLoad);
    expect(install).toBeGreaterThanOrEqual(0);
    // The install scripts of the dependencies run before the token is in the environment.
    expect(load).toBeGreaterThan(install);
    expect(at("pull")).toBeGreaterThan(load);
    expect(at("build")).toBeGreaterThan(at("pull"));
    expect(at("deploy")).toBeGreaterThan(at("build"));
    expect(steps[at("pull")]?.run).toContain(
      "vercel pull --yes --environment=production",
    );
    expect(steps[at("build")]?.run).toContain("vercel build --prod");
    // The build runs the project's code (next build, bundlers, plugins): it must not see the token.
    expect(steps[at("build")]?.run).toBe(
      "env -u VERCEL_TOKEN vercel build --prod",
    );
    expect(steps[at("build")]?.env?.VERCEL_TOKEN).toBeUndefined();
    expect(steps[at("pull")]?.env?.VERCEL_TOKEN).toBeUndefined();
    expect(steps[at("deploy")]?.env?.VERCEL_TOKEN).toBeUndefined();
    const deploy = steps[at("deploy")]?.run ?? "";
    expect(deploy).toContain("vercel deploy --prebuilt --prod --skip-domain");
    expect(deploy).toContain("--json");
    expect(deploy).not.toContain("--force");
    expect(
      steps.slice(0, load).some((step) => (step.run ?? "").includes("vercel ")),
    ).toBe(false);
  });

  // #724-T03
  it("checks after the build and before the upload that every file the built functions list is in the checkout", () => {
    const steps = stepsOf(stageJob);
    const build = steps.findIndex((step) => runsVercel(step, "build"));
    const deploy = steps.findIndex((step) => runsVercel(step, "deploy"));
    const check = steps.findIndex((step) =>
      (step.run ?? "").includes("tools/vercel/check-build-output.mjs"),
    );
    expect(check).toBeGreaterThan(build);
    expect(check).toBeLessThan(deploy);
    expect(steps[check]?.run?.trim()).toBe(
      'node tools/vercel/check-build-output.mjs "$DIRECTORY"',
    );
    expect(steps[check]?.env?.DIRECTORY).toBe("${{ inputs.directory }}");
    expect(steps[check]?.["continue-on-error"]).toBeUndefined();
  });

  // #403-T08
  it("passes the credentials to the CLI as environment variables and never as arguments", () => {
    expect(stageSource).not.toMatch(/vercel [^\n]*--token/);
    const exportStep = stepsOf(stageJob).find((step) =>
      (step.run ?? "").includes("VERCEL_ORG_ID"),
    );
    expect(exportStep?.run).toContain("VERCEL_ORG_ID=${VERCEL_TEAM_ID}");
  });

  // #403-T08
  it("records the deployments on GitHub per project, and closes each with what happened to that project", () => {
    const record = job("record");
    expect(needsOf(record).sort()).toEqual([
      "promote-app",
      "promote-dispatcher",
      "promote-factory",
      "stage-app",
      "stage-dispatcher",
      "stage-factory",
    ]);
    expect(String(record.if)).toContain("always()");
    const script = stepsOf(record).find((step) =>
      step.uses?.startsWith("actions/github-script@"),
    );
    expect(script?.env?.APP_RESULT).toBe("${{ needs.promote-app.result }}");
    expect(script?.env?.DISPATCHER_RESULT).toBe(
      "${{ needs.promote-dispatcher.result }}",
    );
    expect(String(script?.with?.script)).toContain("createDeploymentStatus");
    const create = stepsOf(stageJob).filter((step) =>
      step.uses?.startsWith("actions/github-script@"),
    );
    expect(
      create.some((step) =>
        String(step.with?.script).includes("createDeployment("),
      ),
    ).toBe(true);
  });

  // #403-T08
  it("promotes in a job of its own per project, with the pinned CLI, in the project's own credentials", () => {
    for (const [name, project, url] of [
      ["promote-app", "VERCEL_APP_PROJECT_ID", "stage-app"],
      [
        "promote-dispatcher",
        "VERCEL_DISPATCHER_PROJECT_ID",
        "stage-dispatcher",
      ],
    ] as const) {
      const found = job(name);
      const steps = stepsOf(found);
      const load = stepIndex(found, isInfisicalLoad);
      const promote = steps.findIndex((step) => runsVercel(step, "promote"));
      expect(load).toBeGreaterThanOrEqual(0);
      expect(promote).toBeGreaterThan(load);
      expect(steps[load]?.with?.["secret-names"]).toBe(
        `VERCEL_TOKEN VERCEL_TEAM_ID ${project}`,
      );
      expect(steps[promote]?.env?.DEPLOYMENT_URL).toBe(
        `\${{ needs.${url}.outputs.url }}`,
      );
      expect(steps[promote]?.env?.VERCEL_PROJECT_ID).toBe(
        `\${{ env.${project} }}`,
      );
      expect(steps[promote]?.env?.VERCEL_ORG_ID).toBe(
        "${{ env.VERCEL_TEAM_ID }}",
      );
      expect(steps[promote]?.run).toContain('vercel promote "$DEPLOYMENT_URL"');
    }
    for (const found of [...Object.values(workflow.jobs), stageJob])
      for (const step of stepsOf(found))
        expect(step["continue-on-error"], step.name).toBeUndefined();
  });

  // #403-T05
  it("checks out the commit that triggered the run, without credentials", () => {
    for (const found of [...Object.values(workflow.jobs), stageJob]) {
      const checkout = stepsOf(found).find((step) =>
        step.uses?.startsWith("actions/checkout@"),
      );
      if (checkout === undefined) continue;
      expect(checkout.with?.["persist-credentials"]).toBe(false);
      expect(String(checkout.with?.ref)).toMatch(/github\.sha|inputs\.ref/);
    }
  });

  // #403-T08
  it("passes values to the shell as environment variables only", () => {
    for (const found of [...Object.values(workflow.jobs), stageJob])
      for (const step of stepsOf(found))
        expect(step.run ?? "", step.name).not.toContain("${{");
  });
});

describe("the shell of the pipeline", () => {
  const COMMIT = "2".repeat(40);

  describe("the check that the run is current", () => {
    const selector = {
      action: "check-current-commit",
      step: "Compare with the head of main",
    } as const;
    const gh = (head: string) => ({ gh: `echo '${head}'` });

    // #403-T20
    it("passes for the head of main", () => {
      expect(
        runStep(selector, {
          env: { GITHUB_SHA: COMMIT, ALLOW_STALE: "false" },
          stubs: gh(COMMIT),
        }).status,
      ).toBe(0);
    });

    // #403-T20
    it("refuses an older commit, with nothing deployed", () => {
      const run = runStep(selector, {
        env: { GITHUB_SHA: COMMIT, ALLOW_STALE: "false" },
        stubs: gh("3".repeat(40)),
      });

      expect(run.status).toBe(1);
      expect(run.stdout).toContain("A newer commit is on main");
    });

    // #403-T20
    it("lets a deliberate manual run deploy an older commit, with a warning", () => {
      const run = runStep(selector, {
        env: { GITHUB_SHA: COMMIT, ALLOW_STALE: "true" },
        stubs: gh("3".repeat(40)),
      });

      expect(run.status).toBe(0);
      expect(run.stdout).toContain("::warning::");
    });

    // #403-T20
    it("refuses when the head of main cannot be read, rather than deploy", () => {
      const run = runStep(selector, {
        env: { GITHUB_SHA: COMMIT, ALLOW_STALE: "true" },
        stubs: { gh: "exit 1" },
      });

      expect(run.status).not.toBe(0);
    });
  });

  describe("the health check of the staged App", () => {
    const selector = {
      workflow: "deploy-production.yml",
      job: "health-app",
      step: "Check /api/health of the staged App",
    } as const;
    const env = {
      DEPLOYMENT_URL: "https://example-abc.vercel.app",
      VERCEL_APP_AUTOMATION_BYPASS_SECRET: "bypass-secret-not-real-0123456789",
    };
    /** A curl that answers `status` with `body` for every call. */
    const curl = (status: string, body: string) => ({
      curl: `out=""; while [ $# -gt 0 ]; do if [ "$1" = "--output" ]; then out="$2"; fi; shift; done\nprintf '%s' '${body}' > "$out"\nprintf '%s' '${status}'`,
    });

    // #403-T20
    it("passes on 200 with status ok", () => {
      const run = runStep(selector, {
        env,
        stubs: curl("200", '{"status":"ok"}'),
      });

      expect(run.status).toBe(0);
      expect(run.calls.filter((call) => call.startsWith("curl"))).toHaveLength(
        1,
      );
    });

    // #403-T20
    it("stops at once on SCHEMA_BEHIND, naming it, without trying again", () => {
      const run = runStep(selector, {
        env,
        stubs: curl("503", '{"status":"error","code":"SCHEMA_BEHIND"}'),
      });

      expect(run.status).toBe(1);
      expect(run.stdout).toContain("SCHEMA_BEHIND");
      expect(run.calls.filter((call) => call.startsWith("curl"))).toHaveLength(
        1,
      );
    });

    // #403-T20
    it.each([
      ["a 200 whose body is not ok", "200", '{"status":"error"}'],
      ["a 200 whose body is not JSON", "200", "<html>sign in</html>"],
      ["a 503 with no code", "503", '{"status":"error"}'],
      ["a login page", "401", "<html>"],
      ["a redirect", "307", ""],
    ])("fails after twelve tries on %s", (_name, status, body) => {
      const run = runStep(selector, { env, stubs: curl(status, body) });

      expect(run.status).toBe(1);
      expect(run.calls.filter((call) => call.startsWith("curl"))).toHaveLength(
        12,
      );
      expect(run.stdout).toContain("did not report a healthy state");
      // Nothing of the body is printed.
      expect(run.stdout + run.stderr).not.toContain("sign in");
    });

    // #403-T20
    it("does not follow redirects and keeps the bypass secret out of the arguments", () => {
      const run = runStep(selector, {
        env,
        stubs: curl("200", '{"status":"ok"}'),
      });

      const call = run.calls.find((c) => c.startsWith("curl")) ?? "";
      expect(call).not.toMatch(/--location|\s-L(\s|$)/);
      expect(call).not.toContain(env.VERCEL_APP_AUTOMATION_BYPASS_SECRET);
      expect(call).toMatch(/--header @\S+bypass-header/);
      expect(run.stdout + run.stderr).not.toContain(
        env.VERCEL_APP_AUTOMATION_BYPASS_SECRET,
      );
    });

    // #403-T20
    it("recovers when the App answers after a cold start", () => {
      const run = runStep(selector, {
        env,
        stubs: {
          curl: `out=""; while [ $# -gt 0 ]; do if [ "$1" = "--output" ]; then out="$2"; fi; shift; done\nn=$(wc -l < "$CALLS_FILE")\nif [ "$n" -lt 3 ]; then printf '%s' '{}' > "$out"; printf '502'; else printf '%s' '{"status":"ok"}' > "$out"; printf '200'; fi`,
        },
      });

      expect(run.status).toBe(0);
    });

    // #403-T20
    it.each([
      "http://example-abc.vercel.app",
      "https://example.com",
      "https://example-abc.vercel.app.evil.example",
      "https://example-abc.vercel.app/",
      "",
    ])("never sends the secret to %j", (url) => {
      const run = runStep(selector, {
        env: { ...env, DEPLOYMENT_URL: url },
        stubs: curl("200", '{"status":"ok"}'),
      });

      expect(run.status).toBe(1);
      expect(run.calls.filter((call) => call.startsWith("curl"))).toEqual([]);
    });

    // #403-T20
    it("fits in the job's time", () => {
      const timeout = job("health-app")["timeout-minutes"] ?? 0;
      // twelve tries of at most 15 s plus 10 s, with room for the checkout and the sign-in
      expect(timeout).toBeGreaterThanOrEqual((12 * 25) / 60 + 5);
    });
  });

  describe("the staging of a deployment", () => {
    const selector = {
      workflow: "vercel-stage.yml",
      job: "stage",
      step: "Deploy the build, staged",
    } as const;
    const DIGEST = `sha256:${"a".repeat(64)}`;
    const env = {
      COMMIT_SHA: COMMIT,
      REPOSITORY: "example/repository",
      REPOSITORY_OWNER: "example",
      SNAPSHOT_ID: "",
      IMAGE_DIGEST: "",
      SNAPSHOT_COMMIT: "",
      SYSBOX_PROOF: "",
    };
    const vercel = (document: string) => ({
      vercel: `printf '%s\\n' '${document}'`,
    });
    const GOOD = JSON.stringify({
      id: "dpl_example0001",
      url: "https://example-abc.vercel.app",
      target: "production",
      readyState: "READY",
    });

    // #403-T08
    it("stages a production deployment without a domain and reports its address and id", () => {
      const run = runStep(selector, { env, stubs: vercel(GOOD) });

      expect(run.status).toBe(0);
      expect(run.output).toContain("url=https://example-abc.vercel.app\n");
      expect(run.output).toContain("vercel-id=dpl_example0001\n");
      const call = run.calls.find((c) => c.startsWith("vercel deploy")) ?? "";
      expect(call).toContain("--prebuilt --prod --skip-domain");
      expect(call).toContain("--json");
      expect(call).toContain(`githubCommitSha=${COMMIT}`);
      expect(call).not.toContain("--env");
      expect(call).not.toMatch(/--token|--force/);
    });

    // #403-T13
    it("gives the Dispatcher's deployment the pair of the run as run-time variables and as meta, and nothing else", () => {
      const run = runStep(selector, {
        env: {
          ...env,
          SNAPSHOT_ID: "snap_example01",
          IMAGE_DIGEST: DIGEST,
          SNAPSHOT_COMMIT: COMMIT,
          SYSBOX_PROOF: "proven",
        },
        stubs: vercel(GOOD),
      });

      expect(run.status).toBe(0);
      const call = run.calls.find((c) => c.startsWith("vercel deploy")) ?? "";
      expect(call).toContain("--env SANDBOX_SNAPSHOT_ID=snap_example01");
      // #745-T02: the verdict is set with the snapshot id, as a variable and as meta, in the same deployment.
      expect(call).toContain("--env SANDBOX_SYSBOX_PROOF=proven");
      expect(call).toContain("--meta sandboxSysboxProof=proven");
      expect(call).toContain(`--env SANDBOX_IMAGE_DIGEST=${DIGEST}`);
      expect(call).toContain("--meta sandboxSnapshotId=snap_example01");
      expect(call).toContain(`--meta sandboxImageDigest=${DIGEST}`);
      expect(call).toContain(`--meta sandboxSnapshotCommit=${COMMIT}`);
      expect(call.match(/--env /g)).toHaveLength(3);
    });

    // #403-T13
    it.each([
      ["only an id", { SNAPSHOT_ID: "snap_example01" }],
      // #745-T02: a verdict is part of the pair; neither a pair without one nor one without the pair is deployed
      [
        "a pair without a verdict",
        {
          SNAPSHOT_ID: "snap_example01",
          IMAGE_DIGEST: DIGEST,
          SNAPSHOT_COMMIT: COMMIT,
        },
      ],
      [
        "a verdict that is neither proven nor unproven",
        {
          SNAPSHOT_ID: "snap_example01",
          IMAGE_DIGEST: DIGEST,
          SNAPSHOT_COMMIT: COMMIT,
          SYSBOX_PROOF: "unrecorded",
        },
      ],
      ["a verdict without the pair", { SYSBOX_PROOF: "proven" }],
      [
        "a digest that is not an image id",
        {
          SNAPSHOT_ID: "snap_example01",
          IMAGE_DIGEST: "latest",
          SNAPSHOT_COMMIT: COMMIT,
        },
      ],
      [
        "a short commit",
        {
          SNAPSHOT_ID: "snap_example01",
          IMAGE_DIGEST: DIGEST,
          SNAPSHOT_COMMIT: "abc",
        },
      ],
      [
        "an id with a space",
        {
          SNAPSHOT_ID: "snap x",
          IMAGE_DIGEST: DIGEST,
          SNAPSHOT_COMMIT: COMMIT,
        },
      ],
    ])("refuses %s before it deploys anything", (_name, pair) => {
      const run = runStep(selector, {
        env: { ...env, ...pair },
        stubs: vercel(GOOD),
      });

      expect(run.status).toBe(1);
      expect(run.calls.filter((c) => c.startsWith("vercel"))).toEqual([]);
    });

    // #403-T08
    it.each([
      [
        "a host that is not a deployment address",
        JSON.stringify({ id: "dpl_example0001", url: "https://example.com" }),
      ],
      ["no id", JSON.stringify({ url: "https://example-abc.vercel.app" })],
      ["something that is not JSON", "deployed!"],
      [
        "an error document",
        JSON.stringify({ status: "error", reason: "deploy_failed" }),
      ],
    ])("fails on %s, with nothing in the output", (_name, document) => {
      const run = runStep(selector, { env, stubs: vercel(document) });

      expect(run.status).not.toBe(0);
      expect(run.output).toBe("");
    });
  });

  describe("the checks of the Infisical action", () => {
    const configure = {
      action: "infisical-ci-secrets",
      step: "Check the Infisical configuration",
    } as const;
    const base = {
      SECRET_NAMES: "VERCEL_TOKEN VERCEL_TEAM_ID",
      INFISICAL_CLIENT_ID: "id",
      INFISICAL_CLIENT_SECRET: "client-secret-value-not-real-0123",
      INFISICAL_DOMAIN: "https://infisical.example.com",
      INFISICAL_PROJECT_SLUG: "slug",
      CONSEQUENCE: "Nothing is deployed.",
    };

    // #403-T06
    it("accepts four settings, an https domain and one to six well formed names", () => {
      const run = runStep(configure, { env: base });

      expect(run.status).toBe(0);
      expect(run.output).toContain("name_1=VERCEL_TOKEN\n");
      expect(run.output).toContain("name_2=VERCEL_TEAM_ID\n");
      expect(run.output).toContain("name_3=\n");
    });

    // #403-T06
    it.each([
      [
        "a domain over http",
        { INFISICAL_DOMAIN: "http://infisical.example.com" },
      ],
      [
        "a domain with a path",
        { INFISICAL_DOMAIN: "https://infisical.example.com/api" },
      ],
      [
        "a domain with credentials",
        { INFISICAL_DOMAIN: "https://user@infisical.example.com" },
      ],
      ["a missing client secret", { INFISICAL_CLIENT_SECRET: "" }],
      ["a missing project slug", { INFISICAL_PROJECT_SLUG: "" }],
      ["seven names", { SECRET_NAMES: "A_1 A_2 A_3 A_4 A_5 A_6 A_7" }],
      ["no name", { SECRET_NAMES: "" }],
      ["a name in lower case", { SECRET_NAMES: "vercel_token" }],
      ["a name with a path", { SECRET_NAMES: "../ci/TOKEN" }],
      ["a name twice", { SECRET_NAMES: "VERCEL_TOKEN VERCEL_TOKEN" }],
    ])("refuses %s, with an error and without a secret", (_name, change) => {
      const run = runStep(configure, { env: { ...base, ...change } });

      expect(run.status).toBe(1);
      expect(run.stdout).toContain("::error::");
      expect(run.stdout + run.stderr).not.toContain(
        base.INFISICAL_CLIENT_SECRET,
      );
    });

    // #403-T06
    it("says what a failure means for the job when a setting is missing", () => {
      const run = runStep(configure, {
        env: { ...base, INFISICAL_CLIENT_SECRET: "" },
      });

      expect(run.stdout).toContain("Nothing is deployed.");
    });

    // #403-T06
    it("names the settings that are missing", () => {
      const run = runStep(configure, {
        env: { ...base, INFISICAL_CLIENT_ID: "", INFISICAL_DOMAIN: "" },
      });

      expect(run.stdout).toContain("INFISICAL_CLIENT_ID");
      expect(run.stdout).toContain("INFISICAL_DOMAIN");
    });

    // #403-T06
    it("fails on an empty loaded value, naming the key and never a value", () => {
      const check = {
        action: "infisical-ci-secrets",
        step: "Check the loaded values",
      } as const;
      const env = {
        SECRET_NAMES: "VERCEL_TOKEN VERCEL_TEAM_ID",
        CONSEQUENCE: "Nothing is deployed.",
        VERCEL_TOKEN: "token-value-not-real",
        VERCEL_TEAM_ID: "",
      };

      const run = runStep(check, { env });

      expect(run.status).toBe(1);
      expect(run.stdout).toContain("VERCEL_TEAM_ID");
      expect(run.stdout + run.stderr).not.toContain("token-value-not-real");
      expect(
        runStep(check, { env: { ...env, VERCEL_TEAM_ID: "team" } }).status,
      ).toBe(0);
    });
  });
});

describe("the freshness check, where a partial re-run cannot skip it", () => {
  const CHECK = "./.github/actions/check-current-commit";

  // #403-T23
  it("is a step of the first job and of every job that promotes or writes the pair, before the step that acts", () => {
    expect(stepsOf(job("fresh")).some((step) => step.uses === CHECK)).toBe(
      true,
    );
    for (const [name, acts] of [
      [
        "promote-app",
        (s: { run?: string }) => (s.run ?? "").includes("vercel promote"),
      ],
      [
        "promote-dispatcher",
        (s: { run?: string }) => (s.run ?? "").includes("vercel promote"),
      ],
    ] as const) {
      const steps = stepsOf(job(name));
      const check = steps.findIndex((step) => step.uses === CHECK);
      expect(check, name).toBeGreaterThanOrEqual(0);
      expect(check, name).toBeLessThan(steps.findIndex(acts));
      expect(steps[check]?.with?.["allow-stale"], name).toBe(
        "${{ inputs.allow_stale }}",
      );
    }
    const persist = stepsOf(job("persist"));
    expect(
      persist.findIndex((step) => step.uses === CHECK),
    ).toBeGreaterThanOrEqual(0);
    expect(persist.findIndex((step) => step.uses === CHECK)).toBeLessThan(
      persist.findIndex(
        (step) =>
          step.uses === "./.github/actions/infisical-write-snapshot-pair",
      ),
    );
  });

  // #403-T23
  it("is a composite action that reads the head of main with the job's own token and takes the override as an input only", () => {
    const text = readText(".github/actions/check-current-commit/action.yml");
    expect(text).toContain("github-token");
    expect(text).toContain("allow-stale");
    expect(text).not.toMatch(/secrets\./);
    expect(text).not.toContain("${{ inputs.allow-stale }}\n        run");
  });

  // #403-T23
  it("lets only a manual run override it: the input does not exist for a push", () => {
    const inputs = (
      workflow.on.workflow_dispatch as { inputs: Record<string, unknown> }
    ).inputs;
    expect(Object.keys(inputs)).toContain("allow_stale");
    expect(Object.keys(workflow.on.push as object)).toEqual(["branches"]);
  });
});

describe("the shell of the stage that carries a pair", () => {
  const COMMIT = "2".repeat(40);
  const DIGEST = `sha256:${"a".repeat(64)}`;

  describe("the build", () => {
    const selector = {
      workflow: "vercel-stage.yml",
      job: "stage",
      step: "Build",
    } as const;

    // #403-T24
    it("runs with no Vercel token in its environment, whatever the job's environment holds", () => {
      const run = runStep(selector, {
        env: {
          VERCEL_TOKEN: "token-not-real-0123456789",
          VERCEL_TEAM_ID: "team_example",
        },
        stubs: {
          vercel:
            'if [ -n "${VERCEL_TOKEN+x}" ]; then echo token-present > "$STUB_DIR/seen"; else echo token-absent > "$STUB_DIR/seen"; fi',
        },
      });

      expect(run.status).toBe(0);
      expect(run.read("bin/seen").trim()).toBe("token-absent");
      // The rest of the environment is still there: the team and project ids are not secrets.
      expect(run.calls[0]).toBe("vercel build --prod");
    });
  });

  describe("the check that the snapshot exists", () => {
    const stage = stepsOf(stageJob);
    const exists = stage.find((step) =>
      (step.run ?? "").includes("snapshot:ops exists"),
    );

    // #403-T21
    it("runs for a deployment that carries a pair, after the credentials are loaded and before anything is pulled or built", () => {
      expect(exists).toBeDefined();
      expect(exists?.if).toContain("inputs.snapshot-id != ''");
      expect(exists?.env?.PAIR_SNAPSHOT_ID).toBe("${{ inputs.snapshot-id }}");
      const at = stage.indexOf(exists as (typeof stage)[number]);
      expect(at).toBeGreaterThan(stepIndex(stageJob, isInfisicalLoad));
      expect(at).toBeLessThan(
        stage.findIndex((step) => runsVercel(step, "pull")),
      );
      expect(exists?.run).toBe("pnpm --dir dispatcher snapshot:ops exists");
    });
  });

  describe("the deployment document of the CLI", () => {
    const selector = {
      workflow: "vercel-stage.yml",
      job: "stage",
      step: "Deploy the build, staged",
    } as const;
    const env = {
      COMMIT_SHA: COMMIT,
      REPOSITORY: "example/repository",
      REPOSITORY_OWNER: "example",
      SNAPSHOT_ID: "",
      IMAGE_DIGEST: "",
      SNAPSHOT_COMMIT: "",
      SYSBOX_PROOF: "",
    };
    const vercel = (document: string, status = 0) => ({
      vercel: `printf '%s\\n' '${document}'\nexit ${String(status)}`,
    });
    const doc = (overrides: Record<string, unknown> = {}) =>
      JSON.stringify({
        id: "dpl_example0001",
        url: "https://example-abc.vercel.app",
        target: "production",
        readyState: "READY",
        ...overrides,
      });

    // #403-T24
    it.each([
      ["a preview", { target: null }],
      ["a deployment that is not ready", { readyState: "ERROR" }],
      ["a deployment of another target", { target: "staging" }],
    ])("fails on %s before the canary has to", (_name, overrides) => {
      const run = runStep(selector, { env, stubs: vercel(doc(overrides)) });

      expect(run.status).not.toBe(0);
      expect(run.output).toBe("");
    });

    // #403-T24
    it("names the CLI's error in the log, a stable code only, when the deployment failed", () => {
      const error = JSON.stringify({
        status: "error",
        reason: "deploy_failed",
        message: "Something with a secret-looking-value-0123456789 inside",
      });
      const run = runStep(selector, { env, stubs: vercel(error, 1) });

      expect(run.status).not.toBe(0);
      expect(run.stdout + run.stderr).toContain("deploy_failed");
      expect(run.stdout + run.stderr).not.toContain("secret-looking-value");
    });

    // #403-T24
    it("says it could not read the document when there is none, without a code it made up", () => {
      const run = runStep(selector, { env, stubs: vercel("deployed!", 1) });

      expect(run.status).not.toBe(0);
      expect(run.stdout).toContain("::error::");
      expect(run.stdout + run.stderr).not.toContain("deployed!");
    });

    // #403-T08
    it("still reports a ready production deployment", () => {
      const run = runStep(selector, {
        env: {
          ...env,
          SNAPSHOT_ID: "snap_example01",
          IMAGE_DIGEST: DIGEST,
          SNAPSHOT_COMMIT: COMMIT,
          SYSBOX_PROOF: "unproven",
        },
        stubs: vercel(doc()),
      });

      expect(run.status).toBe(0);
      expect(run.output).toContain("url=https://example-abc.vercel.app\n");
    });
  });
});

describe("the canary and the rollback, the other places a snapshot has to exist", () => {
  // #403-T21
  it("checks that the snapshot exists before the canary runs, so that a re-run of failed jobs after a discard says what is wrong", () => {
    const canaryWorkflow = readWorkflow("dispatcher-canary.yml");
    const steps = stepsOf(canaryWorkflow.jobs.canary as Job);
    const check = steps.find((step) =>
      (step.run ?? "").includes("snapshot:ops exists"),
    );
    expect(check?.if).toContain("inputs.snapshot_id != ''");
    expect(check?.env?.PAIR_SNAPSHOT_ID).toBe("${{ inputs.snapshot_id }}");
    expect(steps.indexOf(check as (typeof steps)[number])).toBeLessThan(
      steps.findIndex((step) => step.name === "Run the canary"),
    );
    expect(steps.findIndex((step) => isInfisicalLoad(step))).toBeLessThan(
      steps.indexOf(check as (typeof steps)[number]),
    );
    expect(job("canary").with?.snapshot_id).toBe(
      "${{ needs.snapshot-build.outputs.snapshot-id || needs.snapshot-decide.outputs.snapshot-id }}",
    );
    const canary = steps.find((step) => step.name === "Run the canary");
    expect(canary?.env?.CANARY_EXPECT_SNAPSHOT_ID).toBe(
      "${{ inputs.snapshot_id }}",
    );
  });

  // #403-T21
  it("refuses a rollback of the Dispatcher whose snapshot is gone, before anything is rolled back", () => {
    const steps = stepsOf(
      Object.values(readWorkflow("rollback-production.yml").jobs)[0] as Job,
    );
    const dispatcher = steps.find((step) =>
      step.name?.startsWith("Check that the Dispatcher deployment"),
    );
    expect(dispatcher?.run).toBe(
      'pnpm --dir dispatcher snapshot:ops verify --deployment "$DEPLOYMENT" --check-snapshot',
    );
    const app = steps.find((step) =>
      step.name?.startsWith("Check that the App deployment"),
    );
    expect(app?.run).not.toContain("--check-snapshot");
  });
});
