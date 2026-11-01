// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the lane for the second App ("factory", #732) in .github/workflows/deploy-production.yml,
// rollback-production.yml and dispatcher-canary.yml. The lane is merged dormant: it runs only when the repository
// variable FACTORY_ENABLED is `true`, read once by the job `factory-flag`. Switched off, the pipeline of
// code-reviewer.com must do exactly what it did before (proved by evaluating the conditions of the jobs with and
// without the lane, not by matching text); switched on, the lane migrates its own database in a job of its own, stages,
// checks and promotes the second project, and no result of the lane (nor of its migration) can stop the release of the
// first App or of the Dispatcher. The shell of the new steps runs against stand-ins.
import { describe, expect, it } from "vitest";
import { CAPABILITIES } from "../capabilities/capability.ts";
import { runStep } from "./shell-support.ts";
import { simulate, type Scenario } from "./workflow-conditions.ts";
import {
  allActionFiles,
  isInfisicalLoad,
  needsOf,
  readText,
  readWorkflow,
  REPOSITORY,
  stepIndex,
  stepsOf,
  type Job,
  type Workflow,
} from "./workflow-support.ts";

const source = readText(".github/workflows/deploy-production.yml");
const workflow = readWorkflow("deploy-production.yml");
const rollback = readWorkflow("rollback-production.yml");
const canaryWorkflow = readWorkflow("dispatcher-canary.yml");
const job = (name: string): Job => {
  const found = workflow.jobs[name];
  if (!found) throw new Error(`no job "${name}"`);
  return found;
};

const FLAG_JOB = "factory-flag";
const FACTORY_JOBS = [
  "migrate-factory",
  "stage-factory",
  "health-factory",
  "apps-check",
  "promote-factory",
];
const REVIEWER_JOBS = Object.keys(workflow.jobs).filter(
  (name) => name !== FLAG_JOB && !FACTORY_JOBS.includes(name),
);
const WRITE_ACTION = "./.github/actions/infisical-write-snapshot-pair";

const reuse: Scenario = {
  outputs: { "snapshot-decide": { rebuild: "false", repair: "false" } },
};
const rebuild: Scenario = {
  outputs: { "snapshot-decide": { rebuild: "true", repair: "false" } },
};
/** What `factory-flag` outputs for a value of the variable (its shell is proved below). */
const flagged = (scenario: Scenario, enabled: string): Scenario => ({
  ...scenario,
  outputs: { ...scenario.outputs, [FLAG_JOB]: { enabled } },
});
const on = (scenario: Scenario): Scenario => flagged(scenario, "true");

/** The pipeline as it was before the lane: the flag and the factory jobs are gone, and so is every need on one of them. */
function withoutTheLane(): Workflow {
  const jobs: Workflow["jobs"] = {};
  for (const [name, found] of Object.entries(workflow.jobs)) {
    if (name === FLAG_JOB || FACTORY_JOBS.includes(name)) continue;
    const needs = needsOf(found).filter(
      (need) => need !== FLAG_JOB && !FACTORY_JOBS.includes(need),
    );
    jobs[name] = { ...found, needs };
  }
  return { ...workflow, jobs };
}

const SCENARIOS: Array<[string, Scenario]> = [
  ["a reused snapshot", reuse],
  ["a rebuilt snapshot", rebuild],
  ...[
    "fresh",
    "migrate",
    "snapshot-decide",
    "stage-app",
    "stage-dispatcher",
    "health-app",
    "canary",
    "promote-app",
    "promote-dispatcher",
    "persist",
  ].map((failing): [string, Scenario] => [
    `${failing} failing`,
    { ...rebuild, failing: [failing] },
  ]),
  ["a cancelled canary", { ...reuse, cancelling: ["canary"] }],
  ["a cancelled run", { ...reuse, cancelled: true }],
];

describe("the lane while FACTORY_ENABLED is not true", () => {
  // #732-T01
  it.each(SCENARIOS)(
    "leaves every job of the first App's pipeline exactly as it was, with %s, and skips the whole lane",
    (_name, scenario) => {
      const before = simulate(withoutTheLane(), scenario);
      const after = simulate(workflow, flagged(scenario, "false"));
      for (const name of REVIEWER_JOBS)
        expect(after[name], name).toBe(before[name]);
      for (const name of FACTORY_JOBS)
        expect(after[name], name).toBe("skipped");
      expect(after[FLAG_JOB]).toBe("success");
    },
  );

  // #732-T01
  it("skips the lane for an output that is anything but `true`, and runs it for `true`", () => {
    for (const value of ["false", "", "1", "yes", "true "]) {
      const result = simulate(workflow, flagged(reuse, value));
      for (const name of FACTORY_JOBS)
        expect(result[name], `${value}: ${name}`).toBe("skipped");
    }
    const enabled = simulate(workflow, on(reuse));
    for (const name of FACTORY_JOBS)
      expect(enabled[name], name).toBe("success");
  });

  // #732-T01
  it("keeps the needs of the first App's jobs, adding the lane only where the order needs it", () => {
    expect(needsOf(job("fresh"))).toEqual([]);
    expect(needsOf(job("migrate"))).toEqual(["fresh"]);
    expect(needsOf(job("snapshot-decide"))).toEqual(["migrate"]);
    expect(needsOf(job("stage-app"))).toEqual(["migrate"]);
    expect(needsOf(job("canary")).sort()).toEqual([
      "health-app",
      "snapshot-build",
      "snapshot-decide",
      "stage-dispatcher",
    ]);
    expect(needsOf(job("promote-app")).sort()).toEqual([
      "canary",
      "health-app",
      "stage-app",
      "stage-dispatcher",
    ]);
    expect(needsOf(job("promote-dispatcher")).sort()).toEqual([
      "canary",
      "health-app",
      "promote-app",
      "promote-factory",
      "stage-app",
      "stage-dispatcher",
    ]);
    // Nothing else of the first App's path knows the lane, the flag included.
    for (const name of REVIEWER_JOBS) {
      if (name === "promote-dispatcher" || name === "record") continue;
      expect(
        needsOf(job(name)).filter(
          (need) => need === FLAG_JOB || FACTORY_JOBS.includes(need),
        ),
        name,
      ).toEqual([]);
    }
  });

  // #732-T01
  it("leaves the first App's migration, canary and conditions exactly as they were", () => {
    for (const name of REVIEWER_JOBS)
      expect(String(job(name).if), name).not.toContain("FACTORY");
    // `migrate` is the migration of the first database and nothing else: no factory step, no condition on a step.
    const migrate = stepsOf(job("migrate"));
    expect(JSON.stringify(migrate)).not.toMatch(/FACTORY|factory/);
    expect(migrate.map((step) => step.name ?? step.uses)).toEqual([
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413",
      "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1",
      "Install dependencies",
      "Load the migrate role's database URL from Infisical",
      "Apply the migrations",
    ]);
    expect(migrate.filter((step) => step.if !== undefined)).toEqual([]);
    // The canary is called with the inputs it had: the credential is not chosen by the factory switch.
    expect(Object.keys(job("canary").with ?? {}).sort()).toEqual([
      "engines",
      "image_digest",
      "snapshot_id",
      "url",
    ]);
    expect(JSON.stringify(job("canary"))).not.toMatch(/FACTORY|factory|vars\./);
  });

  // #732-T01
  it("reads the variable once, in `factory-flag`, as the text `true`, and every factory job reads that job's output", () => {
    const uses = [...source.matchAll(/vars\.(\w+)/g)].map((m) => m[0]);
    // The switch, and (#748) the expected capability set of the health check, which only `health-factory` reads.
    expect(uses).toEqual([
      "vars.FACTORY_ENABLED",
      "vars.FACTORY_EXPECTED_CAPABILITIES",
    ]);
    const flag = job(FLAG_JOB);
    expect(stepsOf(flag)).toHaveLength(1);
    expect(stepsOf(flag)[0]?.env).toEqual({
      FACTORY_ENABLED: "${{ vars.FACTORY_ENABLED }}",
    });
    expect(flag.outputs).toEqual({
      enabled: "${{ steps.flag.outputs.enabled }}",
    });
    // No secret and no environment: it reads a repository variable and nothing else, and no reviewer job needs it.
    expect(JSON.stringify(flag)).not.toContain("secrets.");
    expect(flag.environment).toBeUndefined();
    expect(needsOf(flag)).toEqual([]);
    for (const name of FACTORY_JOBS) {
      expect(needsOf(job(name)), name).toContain(FLAG_JOB);
      expect(String(job(name).if), name).toContain(
        "needs.factory-flag.outputs.enabled == 'true'",
      );
    }
  });

  // #732-T01
  it("makes the output `true` for the text true and `false` for anything else, as a repository variable arrives", () => {
    const selector = {
      workflow: "deploy-production.yml",
      job: FLAG_JOB,
      step: "Read FACTORY_ENABLED",
    } as const;
    for (const [value, expected] of [
      ["true", "true"],
      ["false", "false"],
      ["", "false"],
      ["TRUE", "false"],
      ["1", "false"],
      ["true ", "false"],
    ] as const) {
      const run = runStep(selector, { env: { FACTORY_ENABLED: value } });
      expect(run.status, value).toBe(0);
      expect(run.output.trim(), value).toBe(`enabled=${expected}`);
    }
  });
});

describe("the lane while FACTORY_ENABLED is true", () => {
  // #732-T02
  it("runs the whole lane, in parallel with the first App's stages, when everything succeeds", () => {
    const result = simulate(workflow, on(reuse));
    for (const name of Object.keys(workflow.jobs))
      if (name === "snapshot-build" || name === "persist" || name === "discard")
        expect(result[name], name).toBe("skipped");
      else expect(result[name], name).toBe("success");
    expect(needsOf(job("migrate-factory")).sort()).toEqual([
      "factory-flag",
      "fresh",
    ]);
    expect(needsOf(job("stage-factory")).sort()).toEqual([
      "factory-flag",
      "migrate-factory",
    ]);
    expect(needsOf(job("health-factory")).sort()).toEqual([
      "factory-flag",
      "stage-factory",
    ]);
  });

  // #732-T02
  it("migrates the factory database in a job of its own, and the first App's `migrate` knows nothing of it", () => {
    const migrate = job("migrate-factory");
    const steps = stepsOf(migrate);
    const names = steps.map((step) => step.name);
    const load = names.indexOf(
      "Load the factory migrate role's database URL from Infisical",
    );
    const apply = names.indexOf("Apply the migrations to the factory database");
    expect(load).toBeGreaterThan(names.indexOf("Install dependencies"));
    expect(apply).toBeGreaterThan(load);
    expect(migrate.environment).toBe("production");
    const factoryLoad = steps[load];
    expect(isInfisicalLoad(factoryLoad ?? {})).toBe(true);
    expect(factoryLoad?.with?.["secret-names"]).toBe(
      "DATABASE_URL_MIGRATE_FACTORY",
    );
    // The same command against the other database: the factory's URL is mapped to the name the command reads.
    expect(steps[apply]?.run).toBe("pnpm --dir app migrate");
    expect(steps[apply]?.env).toEqual({
      DATABASE_URL_MIGRATE: "${{ env.DATABASE_URL_MIGRATE_FACTORY }}",
    });
    expect(JSON.stringify(steps[apply])).not.toContain("secrets.");
    // It never holds the first App's database URL (`migrate` never holds the factory's: no `factory` in its steps, above).
    for (const step of steps.filter(isInfisicalLoad))
      expect(step.with?.["secret-names"]).not.toBe("DATABASE_URL_MIGRATE");
    // Nothing of the first App's path needs it, whatever it does (and the next test runs it failing).
    for (const name of REVIEWER_JOBS)
      expect(needsOf(job(name)), name).not.toContain("migrate-factory");
    // Only the factory's own chain follows it.
    expect(
      Object.keys(workflow.jobs).filter((name) =>
        needsOf(job(name)).includes("migrate-factory"),
      ),
    ).toEqual(["stage-factory"]);
  });

  // #732-T02
  it("keeps the time limit of every job of the lane short, because promote-dispatcher waits for the lane to finish", () => {
    const limit = (name: string) => Number(job(name)["timeout-minutes"]);
    expect(limit(FLAG_JOB)).toBeLessThanOrEqual(2);
    expect(limit("migrate-factory")).toBeLessThanOrEqual(15);
    expect(limit("health-factory")).toBeLessThanOrEqual(10);
    expect(limit("apps-check")).toBeLessThanOrEqual(5);
    expect(limit("promote-factory")).toBeLessThanOrEqual(10);
  });

  // #732-T02
  it("stages, checks and promotes the second project with its own keys only, never one of another project", () => {
    // `apps-check` talks to the Dispatcher, so it holds the Dispatcher's keys and the operator credential (below).
    expect(
      stepsOf(job("apps-check")).find(isInfisicalLoad)?.with?.["secret-names"],
    ).toBe(
      "DISPATCHER_OPERATOR_TOKEN VERCEL_DISPATCHER_AUTOMATION_BYPASS_SECRET",
    );
    for (const name of FACTORY_JOBS.filter((found) => found !== "apps-check")) {
      const found = job(name);
      const loaded = stepsOf(found)
        .filter(isInfisicalLoad)
        .flatMap((step) => String(step.with?.["secret-names"]).split(" "));
      for (const key of loaded)
        expect(key, `${name}: ${key}`).not.toMatch(
          /^VERCEL_(APP|DISPATCHER)_|^DATABASE_URL_MIGRATE$|^RUNNER_TOKEN$/,
        );
    }
    expect(job("stage-factory").uses).toBe(
      "./.github/workflows/vercel-stage.yml",
    );
    expect(job("stage-factory").with).toEqual({
      project: "factory",
      directory: "app",
      "project-id-secret": "VERCEL_FACTORY_PROJECT_ID",
      ref: "${{ github.sha }}",
    });
    expect(
      stepsOf(job("health-factory")).find(isInfisicalLoad)?.with?.[
        "secret-names"
      ],
    ).toBe("VERCEL_FACTORY_AUTOMATION_BYPASS_SECRET");
    const promote = stepsOf(job("promote-factory"));
    expect(promote.find(isInfisicalLoad)?.with?.["secret-names"]).toBe(
      "VERCEL_TOKEN VERCEL_TEAM_ID VERCEL_FACTORY_PROJECT_ID",
    );
    const promoteStep = promote.find((step) =>
      (step.run ?? "").includes("vercel promote"),
    );
    expect(promoteStep?.env).toEqual({
      DEPLOYMENT_URL: "${{ needs.stage-factory.outputs.url }}",
      VERCEL_ORG_ID: "${{ env.VERCEL_TEAM_ID }}",
      VERCEL_PROJECT_ID: "${{ env.VERCEL_FACTORY_PROJECT_ID }}",
    });
    // The freshness check is a step of the job that promotes, before the promotion.
    const check = promote.findIndex(
      (step) => step.uses === "./.github/actions/check-current-commit",
    );
    expect(check).toBeGreaterThanOrEqual(0);
    expect(check).toBeLessThan(promote.indexOf(promoteStep as never));
    // The staged address is the staged factory's, from the stage job of the same lane.
    expect(String(job("health-factory").steps?.[2]?.env?.DEPLOYMENT_URL)).toBe(
      "${{ needs.stage-factory.outputs.url }}",
    );
  });

  // #732-T02
  it("promotes the second App only after the first App, the health check, the Apps of the Dispatcher and the canary", () => {
    expect(needsOf(job("promote-factory")).sort()).toEqual([
      "apps-check",
      "canary",
      "factory-flag",
      "health-factory",
      "promote-app",
      "stage-factory",
    ]);
    const condition = String(job("promote-factory").if);
    for (const need of needsOf(job("promote-factory")).filter(
      (found) => found !== FLAG_JOB,
    ))
      expect(condition, need).toContain(`needs.${need}.result == 'success'`);
    expect(condition).toContain("!cancelled()");
    expect(condition).not.toMatch(/\.result != |skipped/);
    // The Apps check runs on the staged Dispatcher that the canary proved.
    expect(needsOf(job("apps-check")).sort()).toEqual([
      "canary",
      "factory-flag",
      "stage-dispatcher",
    ]);
  });

  // #732-T02
  it.each([
    [
      "its migration fails",
      "migrate-factory",
      ["stage-factory", "health-factory", "promote-factory"],
    ],
    [
      "staging the second App fails",
      "stage-factory",
      ["health-factory", "promote-factory"],
    ],
    ["its health check fails", "health-factory", ["promote-factory"]],
    ["the check of the Apps fails", "apps-check", ["promote-factory"]],
  ])(
    "promotes nothing of the second App when %s",
    (_name, failing, skipped) => {
      const result = simulate(workflow, on({ ...reuse, failing: [failing] }));
      for (const name of skipped) expect(result[name], name).toBe("skipped");
    },
  );

  // #732-T02
  it("promotes nothing at all when the canary fails, the second App included", () => {
    const result = simulate(workflow, on({ ...reuse, failing: ["canary"] }));
    for (const name of [
      "promote-app",
      "promote-factory",
      "promote-dispatcher",
      "apps-check",
    ])
      expect(result[name], name).toBe("skipped");
  });
});

describe("the lane never stops the first App's release", () => {
  // The flag itself is the first of them: a runner that cannot read a variable must not stop a release either.
  const LANE_FAILURES = [FLAG_JOB, ...FACTORY_JOBS].map(
    (name) => [name] as const,
  );

  // #732-T03
  it.each(LANE_FAILURES)(
    "promotes the first App and the Dispatcher, writes the pair and cleans up when %s fails",
    (failing) => {
      const clean = simulate(withoutTheLane(), rebuild);
      const result = simulate(workflow, on({ ...rebuild, failing: [failing] }));
      for (const name of REVIEWER_JOBS) {
        // The run's record job ends in `success` in both; every other job is what it is without the lane.
        expect(result[name], name).toBe(clean[name]);
      }
      expect(result["promote-app"]).toBe("success");
      expect(result["promote-dispatcher"]).toBe("success");
      expect(result.persist).toBe("success");
      expect(result.cleanup).toBe("success");
    },
  );

  // #732-T03
  it("promotes the first App and the Dispatcher when the second App's promotion is cancelled", () => {
    const result = simulate(
      workflow,
      on({ ...reuse, cancelling: ["promote-factory"] }),
    );
    expect(result["promote-factory"]).toBe("cancelled");
    expect(result["promote-app"]).toBe("success");
    // A cancel is a cancel of the run: nothing after it starts, as for any other job.
    expect(result["promote-dispatcher"]).toBe("skipped");
  });

  // #732-T03
  it("has a Dispatcher promotion whose condition does not depend on any job of the lane", () => {
    const condition = String(job("promote-dispatcher").if);
    for (const name of [FLAG_JOB, ...FACTORY_JOBS])
      expect(condition, name).not.toContain(name);
    expect(condition).not.toMatch(/FACTORY|factory/);
    for (const name of ["promote-app", "persist", "cleanup", "discard"])
      expect(String(job(name).if), name).not.toMatch(/factory|apps-check/);
    expect(String(job("promote-app").if)).not.toMatch(/factory|apps-check/);
  });

  // #732-T03
  it("promotes in the order the App, the second App, the Dispatcher", () => {
    expect(needsOf(job("promote-factory"))).toContain("promote-app");
    expect(needsOf(job("promote-dispatcher"))).toContain("promote-factory");
    expect(needsOf(job("promote-dispatcher"))).toContain("promote-app");
  });

  // #732-T03
  it("records the second project's deployment when it was staged, and nothing when the lane is off", () => {
    expect(needsOf(job("record"))).toEqual(
      expect.arrayContaining(["stage-factory", "promote-factory"]),
    );
    const script = stepsOf(job("record")).find((step) =>
      step.uses?.startsWith("actions/github-script@"),
    );
    expect(script?.env?.FACTORY_RESULT).toBe(
      "${{ needs.promote-factory.result }}",
    );
    expect(String(script?.with?.script)).toContain("['factory'");
    // A stage that did not run has no deployment id, and the loop skips it.
    expect(String(script?.with?.script)).toContain("if (!id) continue;");
  });
});

describe("the secrets and the write path in the lane", () => {
  const files = [
    ["deploy-production.yml", workflow],
    ["rollback-production.yml", rollback],
    ["dispatcher-canary.yml", canaryWorkflow],
  ] as const;

  // #732-T04
  it("passes the four Infisical secrets by name to every step and call that needs them, and never inherits", () => {
    for (const [file, parsed] of files)
      for (const [name, found] of Object.entries(parsed.jobs)) {
        expect(found.secrets, `${file}:${name}`).not.toBe("inherit");
        for (const step of stepsOf(found).filter(isInfisicalLoad))
          expect(
            {
              "client-id": step.with?.["client-id"],
              "client-secret": step.with?.["client-secret"],
              domain: step.with?.domain,
              "project-slug": step.with?.["project-slug"],
            },
            `${file}:${name}: ${step.name}`,
          ).toEqual({
            "client-id": "${{ secrets.INFISICAL_CLIENT_ID }}",
            "client-secret": "${{ secrets.INFISICAL_CLIENT_SECRET }}",
            domain: "${{ secrets.INFISICAL_DOMAIN }}",
            "project-slug": "${{ secrets.INFISICAL_PROJECT_SLUG }}",
          });
      }
    expect(job("stage-factory").secrets).toEqual({
      INFISICAL_CLIENT_ID: "${{ secrets.INFISICAL_CLIENT_ID }}",
      INFISICAL_CLIENT_SECRET: "${{ secrets.INFISICAL_CLIENT_SECRET }}",
      INFISICAL_DOMAIN: "${{ secrets.INFISICAL_DOMAIN }}",
      INFISICAL_PROJECT_SLUG: "${{ secrets.INFISICAL_PROJECT_SLUG }}",
    });
    expect(source).not.toMatch(/secrets: inherit/);
  });

  // #732-T04
  it("runs every job of the lane that signs in in the environment production, restricted to this repository on main", () => {
    for (const name of FACTORY_JOBS) {
      const condition = String(job(name).if);
      expect(condition, name).toContain(`github.repository == '${REPOSITORY}'`);
      expect(condition, name).toContain("github.ref == 'refs/heads/main'");
      expect(condition.match(/github\.ref\b/g), name).toHaveLength(1);
      if (job(name).uses === undefined)
        expect(job(name).environment, name).toBe("production");
    }
  });

  // #732-T05
  it("keeps the write path to Infisical in `persist` and the rollback, and gives the lane none of it", () => {
    const users = Object.entries(workflow.jobs)
      .filter(([, found]) =>
        stepsOf(found).some((step) => step.uses === WRITE_ACTION),
      )
      .map(([name]) => name);
    expect(users).toEqual(["persist"]);
    expect(
      Object.entries(rollback.jobs)
        .filter(([, found]) =>
          stepsOf(found).some((step) => step.uses === WRITE_ACTION),
        )
        .map(([name]) => name),
    ).toEqual(["rollback"]);
    // The pair is the Dispatcher's: the second App's rollback never writes it, and the lane's jobs never feed `persist`.
    const write = stepsOf(Object.values(rollback.jobs)[0] as Job).find(
      (step) => step.uses === WRITE_ACTION,
    );
    expect(write?.if).toBe("${{ inputs.dispatcher_deployment != '' }}");
    expect(
      needsOf(job("persist")).filter((need) => FACTORY_JOBS.includes(need)),
    ).toEqual([]);
    expect(source).not.toMatch(/snapshot:ops\s+persist|persistPair/);
  });
});

describe("the rollback of the second App", () => {
  const rollbackJob = Object.values(rollback.jobs)[0] as Job;
  const steps = stepsOf(rollbackJob);
  const named = (name: string) => {
    const step = steps.find((candidate) => candidate.name === name);
    if (!step) throw new Error(`no step "${name}"`);
    return step;
  };

  // #732-T06
  it("touches the second project only when it is given a deployment for it, and the other two only when they are", () => {
    const factory = steps.filter(
      (step) =>
        JSON.stringify(step).includes("factory_deployment") &&
        step.name !== "Check the inputs",
    );
    expect(factory.map((step) => step.name)).toEqual([
      "Load the factory project id from Infisical",
      "Check that the factory deployment is a production deployment of the factory App",
      "Roll the factory App back",
    ]);
    for (const step of factory)
      expect(step.if).toBe("${{ inputs.factory_deployment != '' }}");
    for (const [name, input] of [
      ["Roll the App back", "app_deployment"],
      ["Roll the Dispatcher back", "dispatcher_deployment"],
    ] as const)
      expect(named(name).if).toBe(`\${{ inputs.${input} != '' }}`);
    // Nothing else of the factory leaks into the steps of the other two.
    for (const step of steps.filter((s) => !factory.includes(s)))
      expect(JSON.stringify(step), step.name).not.toContain("FACTORY_PROJECT");
  });

  // #732-T06
  it("checks that the deployment is a ready production deployment of the second project before anything is rolled back", () => {
    const check = named(
      "Check that the factory deployment is a production deployment of the factory App",
    );
    expect(check.run).toBe(
      'pnpm --dir dispatcher snapshot:ops verify --deployment "$DEPLOYMENT"',
    );
    expect(check.env).toEqual({
      DEPLOYMENT: "${{ inputs.factory_deployment }}",
      VERCEL_PROJECT_ID: "${{ env.VERCEL_FACTORY_PROJECT_ID }}",
    });
    const firstRollback = steps.findIndex((step) =>
      /vercel rollback/.test(step.run ?? ""),
    );
    expect(steps.indexOf(check)).toBeLessThan(firstRollback);
    expect(
      steps.indexOf(named("Load the factory project id from Infisical")),
    ).toBeLessThan(steps.indexOf(check));
    // The check itself, which refuses a deployment of another project or team, is `snapshot:ops verify`
    // (dispatcher/src/snapshot/vercel-api.test.ts, ops-cli.test.ts: "another project").
    const rolled = named("Roll the factory App back");
    expect(rolled.env?.VERCEL_PROJECT_ID).toBe(
      "${{ env.VERCEL_FACTORY_PROJECT_ID }}",
    );
    expect(rolled.run).toBe('vercel rollback "$DEPLOYMENT" --yes --timeout 5m');
  });

  // #732-T06
  it("accepts a rollback of the second App alone, and refuses a wrong value for it", () => {
    const selector = {
      workflow: "rollback-production.yml",
      job: "rollback",
      step: "Check the inputs",
    } as const;
    const alone = { APP_DEPLOYMENT: "", DISPATCHER_DEPLOYMENT: "" };
    expect(
      runStep(selector, {
        env: { ...alone, FACTORY_DEPLOYMENT: "dpl_example0001" },
      }).status,
    ).toBe(0);
    for (const bad of ["latest", "--yes", "https://example.com", "dpl_x"]) {
      const run = runStep(selector, {
        env: { ...alone, FACTORY_DEPLOYMENT: bad },
      });
      expect(run.status, bad).toBe(1);
      expect(run.stdout, bad).toContain("::error::");
    }
    expect(
      runStep(selector, { env: { ...alone, FACTORY_DEPLOYMENT: "" } }).status,
    ).toBe(1);
  });

  // #732-T06
  it("reads the second project's id only when it is needed, so the other rollbacks do not depend on a key of the lane", () => {
    const main = steps.find(
      (step) =>
        isInfisicalLoad(step) &&
        step.name?.startsWith("Load the Vercel credentials"),
    );
    expect(main?.with?.["secret-names"]).toBe(
      "VERCEL_TOKEN VERCEL_TEAM_ID VERCEL_APP_PROJECT_ID VERCEL_DISPATCHER_PROJECT_ID",
    );
    expect(stepIndex(rollbackJob, isInfisicalLoad)).toBeGreaterThanOrEqual(0);
  });
});

describe("the health check of the staged second App", () => {
  const selector = {
    workflow: "deploy-production.yml",
    job: "health-factory",
    step: "Check /api/health of the staged factory App",
  } as const;
  const env = {
    DEPLOYMENT_URL: "https://example-abc.vercel.app",
    VERCEL_FACTORY_AUTOMATION_BYPASS_SECRET:
      "bypass-secret-not-real-0123456789",
    EXPECTED_PRODUCT: "factory",
    EXPECTED_CAPABILITIES: "dynamic-review,review",
  };
  const curl = (status: string, body: string) => ({
    curl: `out=""; while [ $# -gt 0 ]; do if [ "$1" = "--output" ]; then out="$2"; fi; shift; done\nprintf '%s' '${body}' > "$out"\nprintf '%s' '${status}'`,
  });
  const health = (product: unknown, capabilities: unknown) =>
    JSON.stringify({ status: "ok", product, capabilities });
  const curls = (calls: string[]) =>
    calls.filter((call) => call.startsWith("curl"));

  const checkStep = () =>
    stepsOf(job("health-factory")).find(
      (candidate) => candidate.name === selector.step,
    );
  const stagedWith = (capabilities: string[]) =>
    curl("200", health("factory", capabilities));

  it("pins the expected product and capability set in the job, not in the shell text", () => {
    const step = checkStep();
    expect(step?.env?.EXPECTED_PRODUCT).toBe("factory");
    expect(step?.run).not.toContain("${{");
  });

  // #748-T01
  it("takes the expected capability set from the repository variable and falls back to today's set when it is unset", () => {
    const expression = String(checkStep()?.env?.EXPECTED_CAPABILITIES);
    expect(expression).toBe(
      "${{ vars.FACTORY_EXPECTED_CAPABILITIES || 'dynamic-review,review' }}",
    );
    // Unset (or empty) the `||` yields the literal of today; the literal is the only one in the job.
    expect(expression.match(/'([^']*)'/)?.[1]).toBe("dynamic-review,review");
    expect(
      stepsOf(job("health-factory")).filter((step) =>
        JSON.stringify(step).includes("dynamic-review,review"),
      ),
    ).toHaveLength(1);
    // The graph and the conditions of the job are what they were.
    expect(needsOf(job("health-factory")).sort()).toEqual([
      "factory-flag",
      "stage-factory",
    ]);
    expect(job("health-factory")["timeout-minutes"]).toBe(10);
  });

  // #748-T05
  it("reads the variable in the health-factory job only, and no other job or file depends on a factory result through it", () => {
    const name = "FACTORY_EXPECTED_CAPABILITIES";
    const holders = Object.entries(workflow.jobs)
      .filter(([, candidate]) => JSON.stringify(candidate).includes(name))
      .map(([jobName]) => jobName);
    expect(holders).toEqual(["health-factory"]);
    // Within the job, one step reads it, in its environment.
    expect(
      stepsOf(job("health-factory")).filter((step) =>
        String(step.env?.EXPECTED_CAPABILITIES).includes(`vars.${name}`),
      ),
    ).toHaveLength(1);
    expect([
      ...source.matchAll(/vars\.FACTORY_EXPECTED_CAPABILITIES/g),
    ]).toHaveLength(1);
    // Nowhere else in the repository: no other workflow, no composite action.
    const files = allActionFiles()
      .filter(([, text]) => text.includes(name))
      .map(([path]) => path);
    expect(files).toEqual([".github/workflows/deploy-production.yml"]);
    expect(needsOf(job("promote-dispatcher"))).not.toContain("health-factory");
  });

  // #748-T03
  it("knows exactly the capability names of the app, so a new name cannot be added in one place only", () => {
    const listed = /^ *KNOWN_CAPABILITIES="([^"]*)"$/m.exec(
      checkStep()?.run ?? "",
    )?.[1];
    expect(listed).toBeDefined();
    expect((listed ?? "").split(" ").sort()).toEqual([...CAPABILITIES].sort());
  });

  // #748-T02
  it("passes when the variable names the new set and the staged App reports it, in any order", () => {
    const withVariable = {
      ...env,
      EXPECTED_CAPABILITIES: "dynamic-review,implementer,review",
    };
    for (const capabilities of [
      ["dynamic-review", "implementer", "review"],
      ["review", "implementer", "dynamic-review"],
      ["implementer", "review", "dynamic-review"],
    ]) {
      const run = runStep(selector, {
        env: withVariable,
        stubs: stagedWith(capabilities),
      });
      expect(run.status, capabilities.join()).toBe(0);
      expect(curls(run.calls)).toHaveLength(1);
      // #768: the header file exists after a pass, so its absence after a failure (below) means something.
      expect(run.read("bypass-header")).toContain("x-vercel-protection-bypass");
    }
  });

  // #748-T03
  it.each([
    ["unsorted", "review,dynamic-review"],
    ["unsorted with the new name", "dynamic-review,review,implementer"],
    ["an unknown name", "dynamic-review,review,hunter2"],
    ["an empty entry in the middle", "dynamic-review,,review"],
    ["a trailing comma", "dynamic-review,review,"],
    ["a leading comma", ",dynamic-review,review"],
    ["a duplicate", "dynamic-review,review,review"],
    ["a space after the comma", "dynamic-review, review"],
    ["a space around the value", " dynamic-review,review "],
    ["upper case", "Dynamic-Review,review"],
    ["a separator other than a comma", "dynamic-review;review"],
    ["only a comma", ","],
    ["whitespace only", " "],
    ["a newline inside", "dynamic-review\nreview"],
  ])("fails before any request on a variable with %s", (_name, value) => {
    const run = runStep(selector, {
      env: { ...env, EXPECTED_CAPABILITIES: value },
      stubs: stagedWith(["dynamic-review", "review"]),
    });
    expect(run.status).toBe(1);
    expect(curls(run.calls)).toEqual([]);
    expect(run.stdout).toContain("::error::");
    expect(run.stdout).toContain("FACTORY_EXPECTED_CAPABILITIES");
    expect(run.stdout).not.toContain("PRODUCT_MISMATCH");
    // The bypass secret is not read before the check and never printed.
    expect(run.stdout + run.stderr).not.toContain(
      env.VERCEL_FACTORY_AUTOMATION_BYPASS_SECRET,
    );
    // #768: the header file that holds it is not even written after the failure (the order of the step is pinned here).
    expect(() => run.read("bypass-header")).toThrow("no file bypass-header");
  });

  // #748-T03
  it("does not pass a workflow command or a line break from the variable into the log", () => {
    const hostile = "x\n::error::injected\n::add-mask::y";
    const run = runStep(selector, {
      env: { ...env, EXPECTED_CAPABILITIES: hostile },
      stubs: stagedWith(["dynamic-review", "review"]),
    });
    expect(run.status).toBe(1);
    expect(curls(run.calls)).toEqual([]);
    const errors = run.stdout
      .split("\n")
      .filter((line) => line.startsWith("::"));
    expect(errors).toHaveLength(1);
    expect(run.stdout).not.toContain("::add-mask");
    expect(() => run.read("bypass-header")).toThrow("no file bypass-header");
  });

  // #748-T04
  it.each([
    [
      "the variable names the new set and the App reports the old one",
      "dynamic-review,implementer,review",
      ["dynamic-review", "review"],
    ],
    [
      "the variable is unset (today's set) and the App reports the new one",
      "dynamic-review,review",
      ["dynamic-review", "implementer", "review"],
    ],
  ])(
    "fails at once with PRODUCT_MISMATCH when %s",
    (_name, expected, reported) => {
      const run = runStep(selector, {
        env: { ...env, EXPECTED_CAPABILITIES: expected },
        stubs: stagedWith(reported),
      });
      expect(run.status).toBe(1);
      expect(run.stdout).toContain("PRODUCT_MISMATCH");
      expect(run.stdout).toContain(expected);
      expect(curls(run.calls)).toHaveLength(1);
    },
  );

  // #732-T02
  it("passes on 200 with status ok, the product factory and exactly the capabilities of the second App, in any order", () => {
    for (const capabilities of [
      ["review", "dynamic-review"],
      ["dynamic-review", "review"],
    ]) {
      const run = runStep(selector, {
        env,
        stubs: curl("200", health("factory", capabilities)),
      });
      expect(run.status).toBe(0);
      expect(curls(run.calls)).toHaveLength(1);
    }
  });

  // #732-T07
  it("fails at once on a staged App that reports the product code-review-com, without trying again", () => {
    const run = runStep(selector, {
      env,
      stubs: curl(
        "200",
        health("code-review-com", ["billing", "dynamic-review", "review"]),
      ),
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("PRODUCT_MISMATCH");
    expect(run.stdout).toContain("code-review-com");
    expect(curls(run.calls)).toHaveLength(1);
  });

  // #732-T07
  it.each([
    [
      "the right product with a capability too many",
      health("factory", ["billing", "dynamic-review", "review"]),
    ],
    [
      "the right product with a capability missing",
      health("factory", ["review"]),
    ],
    [
      "no product at all (an App without the capability set)",
      JSON.stringify({ status: "ok" }),
    ],
    [
      "capabilities that are not a list",
      health("factory", "review,dynamic-review"),
    ],
    [
      "a product that is not text",
      health({ name: "factory" }, ["review", "dynamic-review"]),
    ],
  ])("fails on %s", (_name, body) => {
    const run = runStep(selector, { env, stubs: curl("200", body) });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("PRODUCT_MISMATCH");
    expect(curls(run.calls)).toHaveLength(1);
  });

  // #732-T02
  it("stops at once on SCHEMA_BEHIND, and retries twelve times on anything else, as the first App's check does", () => {
    const behind = runStep(selector, {
      env,
      stubs: curl("503", '{"status":"error","code":"SCHEMA_BEHIND"}'),
    });
    expect(behind.status).toBe(1);
    expect(behind.stdout).toContain("SCHEMA_BEHIND");
    expect(curls(behind.calls)).toHaveLength(1);
    const down = runStep(selector, { env, stubs: curl("502", "<html>") });
    expect(down.status).toBe(1);
    expect(curls(down.calls)).toHaveLength(12);
    expect(down.stdout + down.stderr).not.toContain("<html>");
  });

  // #732-T02
  it("keeps the bypass secret out of the arguments and the output, and sends it only to a deployment address", () => {
    const run = runStep(selector, {
      env,
      stubs: curl("200", health("factory", ["review", "dynamic-review"])),
    });
    const call = curls(run.calls)[0] ?? "";
    expect(call).not.toContain(env.VERCEL_FACTORY_AUTOMATION_BYPASS_SECRET);
    expect(call).not.toMatch(/--location|\s-L(\s|$)/);
    expect(call).toMatch(/--header @\S+bypass-header/);
    expect(run.stdout + run.stderr).not.toContain(
      env.VERCEL_FACTORY_AUTOMATION_BYPASS_SECRET,
    );
    for (const url of [
      "http://example-abc.vercel.app",
      "https://example.com",
      "",
    ]) {
      const refused = runStep(selector, {
        env: { ...env, DEPLOYMENT_URL: url },
        stubs: curl("200", health("factory", ["review", "dynamic-review"])),
      });
      expect(refused.status, url).toBe(1);
      expect(curls(refused.calls), url).toEqual([]);
    }
  });
});

describe("the check of the Apps of the staged Dispatcher", () => {
  const selector = {
    workflow: "deploy-production.yml",
    job: "apps-check",
    step: "Ask the staged Dispatcher about its Apps",
  } as const;
  const env = {
    DISPATCHER_URL: "https://example-dispatcher.vercel.app",
    VERCEL_DISPATCHER_AUTOMATION_BYPASS_SECRET: "bypass-not-real-0123456789",
    DISPATCHER_OPERATOR_TOKEN: "operator-token-not-real-0123456789",
  };
  const curl = (status: string, body: string) => ({
    curl: `out=""; while [ $# -gt 0 ]; do if [ "$1" = "--output" ]; then out="$2"; fi; shift; done\nprintf '%s' '${body}' > "$out"\nprintf '%s' '${status}'`,
  });
  const apps = (...list: Array<Record<string, unknown>>) =>
    JSON.stringify({ apps: list });
  const reviewer = {
    id: "reviewer",
    reachable: true,
    credentialAccepted: true,
    missingFeatures: [],
  };
  const factory = { ...reviewer, id: "factory" };

  it("passes when every App is reachable and accepts its credential", () => {
    const run = runStep(selector, {
      env,
      stubs: curl("200", apps(reviewer, factory)),
    });
    expect(run.status).toBe(0);
  });

  it("posts to /apps/check with both credentials in a header file, never in an argument, and prints no secret", () => {
    const run = runStep(selector, {
      env,
      stubs: curl("200", apps(reviewer, factory)),
    });
    const call = run.calls.find((c) => c.startsWith("curl")) ?? "";
    expect(call).toContain("--request POST");
    expect(call).toContain(`${env.DISPATCHER_URL}/apps/check`);
    expect(call).toMatch(/--header @\S+apps-check-headers/);
    expect(call).not.toMatch(/--location|\s-L(\s|$)/);
    for (const secret of [
      env.VERCEL_DISPATCHER_AUTOMATION_BYPASS_SECRET,
      env.DISPATCHER_OPERATOR_TOKEN,
    ]) {
      expect(call).not.toContain(secret);
      expect(run.stdout + run.stderr).not.toContain(secret);
    }
    expect(run.read("apps-check-headers")).toContain(
      `authorization: Bearer ${env.DISPATCHER_OPERATOR_TOKEN}`,
    );
  });

  it.each([
    [
      "an App that cannot be reached",
      apps(reviewer, { ...factory, reachable: false }),
      "app_unreachable: factory",
    ],
    [
      "an App that rejects its credential",
      apps({ ...reviewer, credentialAccepted: false }, factory),
      "app_rejected: reviewer",
    ],
  ])("fails on %s, naming the code and the App", (_name, body, expected) => {
    const run = runStep(selector, { env, stubs: curl("200", body) });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain(`::error::${expected}`);
  });

  it("only warns about a missing feature, because the live Apps are still the previous release", () => {
    const run = runStep(selector, {
      env,
      stubs: curl(
        "200",
        apps(reviewer, { ...factory, missingFeatures: ["a-feature"] }),
      ),
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("::warning::app_missing_features: factory");
    expect(run.stdout).not.toContain("a-feature");
  });

  it("prints an App id only when it looks like one, and never a body", () => {
    const run = runStep(selector, {
      env,
      stubs: curl(
        "200",
        apps({ ...factory, id: "x\nwith an injected line", reachable: false }),
      ),
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("::error::app_unreachable: ?");
    expect(run.stdout).not.toContain("injected");
  });

  it.each([
    ["a 401", "401", "{}"],
    ["a 404 (a Dispatcher without the route)", "404", "{}"],
    ["no list of Apps", "200", "{}"],
    ["an empty list of Apps", "200", apps()],
    ["something that is not JSON", "200", "<html>sign in</html>"],
  ])("fails on %s, with a stable code and no body", (_name, status, body) => {
    const run = runStep(selector, { env, stubs: curl(status, body) });
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/::error::apps_check_(failed|unreadable)/);
    expect(run.stdout + run.stderr).not.toContain("sign in");
  });

  it.each([
    "http://example-dispatcher.vercel.app",
    "https://example.com",
    "https://example-dispatcher.vercel.app/",
    "",
  ])("never sends the credentials to %j", (url) => {
    const run = runStep(selector, {
      env: { ...env, DISPATCHER_URL: url },
      stubs: curl("200", apps(reviewer)),
    });
    expect(run.status).toBe(1);
    expect(run.calls.filter((c) => c.startsWith("curl"))).toEqual([]);
  });

  it("is a job of the lane that needs the canary, so the URL it sends the operator credential to was proven to be the Dispatcher's", () => {
    expect(needsOf(job("apps-check"))).toContain("canary");
    expect(String(job("apps-check").if)).toContain(
      "needs.canary.result == 'success'",
    );
  });
});

describe("the canary and the Dispatcher's operator credential", () => {
  const canary = canaryWorkflow.jobs.canary as Job;
  const steps = stepsOf(canary);

  // #732-T01
  it("takes the credential whenever /ci has one, whatever the factory switch says: no input, no condition on a variable", () => {
    for (const trigger of ["workflow_dispatch", "workflow_call"] as const) {
      const inputs = (
        canaryWorkflow.on[trigger] as { inputs: Record<string, unknown> }
      ).inputs;
      expect(Object.keys(inputs), trigger).not.toContain("operator_token");
    }
    expect(JSON.stringify(canaryWorkflow)).not.toMatch(
      /FACTORY|factory|vars\./,
    );
    const load = steps.find((step) =>
      step.name?.startsWith("Load the operator credential"),
    );
    expect(load?.if).toBeUndefined();
    expect(load?.with?.["secret-names"]).toBe("DISPATCHER_OPERATOR_TOKEN");
    // The call of the canary passes the inputs it always had, and nothing about the lane.
    expect(Object.keys(job("canary").with ?? {}).sort()).toEqual([
      "engines",
      "image_digest",
      "snapshot_id",
      "url",
    ]);
  });
});
