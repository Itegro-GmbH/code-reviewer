// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the golden snapshot workflow (.github/workflows/golden-snapshot.yml, #330): it never runs for a pull
// request, only one job holds the platform secrets and only one step of it reads them, and the commit is
// archived and checked out without credentials. It reads the file as YAML; that the platform accepts the run is
// verified by the first real run (docs/golden-snapshot.md).
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const source = readFileSync(
  `${repoRoot}.github/workflows/golden-snapshot.yml`,
  "utf8",
);

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  "working-directory"?: string;
  "continue-on-error"?: boolean;
} & Record<string, unknown>;
type Job = {
  if?: string;
  environment?: string;
  permissions?: Record<string, string>;
  steps: Step[];
  outputs?: Record<string, string>;
  "runs-on"?: string;
};
type Workflow = {
  on: {
    push?: { branches?: string[] };
    workflow_dispatch?: { inputs?: Record<string, unknown> };
  } & Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs: Record<string, Job>;
};

const workflow = parse(source) as Workflow;
const jobs = Object.values(workflow.jobs);
const job = workflow.jobs.build as Job;

function stepNamed(name: string): Step {
  const step = job.steps.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`no step "${name}"`);
  return step;
}

describe("golden snapshot workflow", () => {
  // #403-T13
  it("runs on demand and when the deployment workflow calls it, never for a pull request, and no longer for a push", () => {
    expect(Object.keys(workflow.on).sort()).toEqual([
      "workflow_call",
      "workflow_dispatch",
    ]);
    expect(source).not.toMatch(/pull_request|^\s+push:/m);
    // The variable that switched the automatic build on is retired: the deployment builds when it has to.
    expect(source).not.toContain("GOLDEN_SNAPSHOT_ENABLED");
    expect(source).not.toContain("pinned_snapshot");
  });

  // #403-T13
  it("gives the deployment the snapshot, the image id and the commit as outputs", () => {
    const outputs =
      (
        workflow.on.workflow_call as {
          outputs?: Record<string, { value: string }>;
        }
      ).outputs ?? {};
    expect(Object.keys(outputs).sort()).toEqual([
      "commit",
      "image-digest",
      "snapshot-id",
    ]);
    for (const output of Object.values(outputs))
      expect(output.value).toMatch(/^\$\{\{ jobs\.build\.outputs\./);
    const read = stepNamed("Read the record");
    expect(read.id).toBe("record");
    expect(read.run).toContain("jq -r .snapshotId");
    expect(read.run).toContain("jq -r .imageDigest");
    expect(job.outputs?.["snapshot-id"]).toBe(
      "${{ steps.record.outputs.snapshot-id }}",
    );
  });

  // #403-T22
  it("queues a rehearsal by hand apart from the build a deployment calls, so that neither replaces the other's pending run", () => {
    const group = String(workflow.concurrency?.group);
    expect(group).toContain("github.workflow == 'Golden snapshot'");
    expect(group).toContain("golden-snapshot-rehearsal");
    expect(group).toContain("golden-snapshot-deploy");
    // Neither is the group of the deployment, which would hold the called build behind its own caller.
    expect(group).not.toContain("deploy-production");
    expect(workflow.concurrency?.["cancel-in-progress"]).toBe(false);
  });

  // #403-T22
  it("passes the target only when one was given: the default lives in config.ts, which is an input of the snapshot", () => {
    const build = stepNamed("Build, check and record the snapshot");
    expect(build.run).toContain('if [ -n "$TARGET" ]; then');
    expect(build.run).toContain('args+=(--target "$TARGET")');
    expect(build.env?.TARGET).toBe("${{ inputs.target }}");
  });

  // #403-T17
  it("removes nothing of earlier runs and writes nothing to Infisical: the deployment does that after the promotion", () => {
    const build = stepNamed("Build, check and record the snapshot");
    expect(build.run).toContain("--skip-retention");
    expect(source).not.toMatch(
      /snapshot:ops|infisical-write-snapshot-pair|--pin-snapshot/,
    );
  });

  // #403-T05
  it("runs only from main, so a manual run on another branch cannot use the Infisical sign-in of the environment production", () => {
    const condition = String(job.if);

    expect(condition).toContain("github.ref == 'refs/heads/main'");
    expect(condition).not.toContain("development");
    // The ref condition is ANDed with the others, not an alternative to them.
    expect(condition).toMatch(
      /repository == '[^']+' && github\.ref == 'refs\/heads\/main'( \}\})?$/,
    );
    expect(condition.match(/github\.ref ==/g)).toHaveLength(1);
  });

  // #330-extra-workflow
  it("has one job, read-only for the repository, in a protected environment, with no OIDC or write permission", () => {
    expect(jobs).toHaveLength(1);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toEqual({ contents: "read" });
    expect(job.environment).toBe("production");
    expect(source).not.toMatch(/id-token|packages:\s*write|contents:\s*write/);
  });

  // #330-extra-workflow
  it("lets two runs queue instead of cancelling one that is building a snapshot", () => {
    expect(workflow.concurrency?.["cancel-in-progress"]).toBe(false);
    expect(workflow.concurrency?.group).toBeTruthy();
  });

  // #403-T06
  it("loads the platform credentials from Infisical after the install and just before the build step, which alone uses them", () => {
    const names = job.steps.map((step) => step.name);
    const load = job.steps.find(
      (step) => step.uses === "./.github/actions/infisical-ci-secrets",
    );
    expect(load?.with?.["secret-names"]).toBe(
      "VERCEL_TOKEN VERCEL_TEAM_ID VERCEL_DISPATCHER_PROJECT_ID",
    );
    const at = job.steps.findIndex((step) => step === load);
    expect(at).toBeGreaterThan(names.indexOf("Install dependencies"));
    expect(at).toBeLessThan(
      names.indexOf("Build, check and record the snapshot"),
    );
    expect(job.steps[0]?.uses).toMatch(/^actions\/checkout@/);
    // Only the Infisical sign-in reads a secret of GitHub.
    const withSecrets = job.steps.filter((step) =>
      JSON.stringify(step).includes("secrets."),
    );
    expect(withSecrets).toEqual([load]);
  });

  // #403-T06
  it("hands the build step the project id under the name the client reads, and no credential in a command line", () => {
    const build = stepNamed("Build, check and record the snapshot");
    expect(Object.keys(build.env ?? {}).sort()).toEqual([
      "TARGET",
      "VERCEL_PROJECT_ID",
    ]);
    expect(build.env?.VERCEL_PROJECT_ID).toBe(
      "${{ env.VERCEL_DISPATCHER_PROJECT_ID }}",
    );
    expect(build.run).not.toContain("secrets.");
    expect(build.run).not.toMatch(/echo[^\n]*VERCEL_/);
    expect(build.run).not.toMatch(/set -x|--debug|xtrace/);
  });

  // #330-T02
  it("passes the dispatch input through an environment variable, not into the shell text", () => {
    const build = stepNamed("Build, check and record the snapshot");
    expect(build.env?.TARGET).toContain("inputs.target");
    for (const step of job.steps)
      expect(step.run ?? "", step.name).not.toMatch(/\$\{\{\s*inputs\./);
  });

  // #330-extra-workflow
  it("checks the commit out without credentials, installs from the lockfile and archives the commit", () => {
    const checkout = job.steps.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
    expect(stepNamed("Install dependencies").run).toBe(
      "pnpm install --frozen-lockfile --filter code-reviewer-dispatcher...",
    );
    expect(
      stepNamed("Install dependencies")["working-directory"],
    ).toBeUndefined();
    expect(stepNamed("Archive the commit").run).toContain("git archive");
  });

  // #330-extra-workflow
  it("builds from the archive with the vm-prepare script of the commit and keeps the record as an artifact", () => {
    const build = stepNamed("Build, check and record the snapshot");
    expect(build["working-directory"]).toBe("dispatcher");
    expect(build.run).toContain("pnpm snapshot:build");
    expect(build.run).toContain("--vm-prepare ../docker/sandbox/vm-prepare.sh");
    expect(build.run).toContain('--commit "$GITHUB_SHA"');
    const upload = job.steps.find((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    expect(upload).toBeDefined();
    expect(String(upload?.with?.path)).toContain("golden-snapshot.json");
  });

  // #330-extra-workflow
  it("passes a vm-prepare script that exists in the repository (the one #325 owns)", () => {
    const build = stepNamed("Build, check and record the snapshot");
    const path = /--vm-prepare \.\.\/(\S+)/.exec(build.run ?? "")?.[1];
    expect(path).toBe("docker/sandbox/vm-prepare.sh");
    expect(existsSync(`${repoRoot}${path}`)).toBe(true);
  });

  // Sysbox, plan implementer-sandbox step 2
  it("passes the Sysbox boot script of the commit, which exists in the repository", () => {
    const build = stepNamed("Build, check and record the snapshot");
    const path = /--sysbox-prepare \.\.\/(\S+)/.exec(build.run ?? "")?.[1];
    expect(path).toBe("docker/sandbox/sysbox-prepare.sh");
    expect(existsSync(`${repoRoot}${path}`)).toBe(true);
  });

  // Sysbox, plan implementer-sandbox step 2: an unproven Sysbox is shown, never a failure (reviews do not use it)
  it("shows an unproven Sysbox as a warning annotation of the run and does not fail on it", () => {
    const show = stepNamed("Show the record");
    expect(show.run).toContain("::warning title=Sysbox unproven::");
    expect(show.run).toContain(".sysbox");
    expect(show.run).not.toMatch(/::error|exit 1/);
    // It says what really happens: only a failed install stops an Implementer launch, until the gate of plan step 4.
    expect(show.run).toContain("step 4");
    expect(show.run).not.toContain("will not start a Sysbox container");
  });

  // #330-extra-workflow
  it("does not ignore a failure of any step", () => {
    for (const step of job.steps)
      expect(step["continue-on-error"], step.name).toBeUndefined();
  });
});
