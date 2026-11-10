// SPDX-License-Identifier: LicenseRef-Proprietary

// Rules that hold for every GitHub Actions file of the repository, the hosted deployment pipeline (#403) first:
// every third-party action is pinned to a commit (and every action of the pipeline, GitHub's own included, because
// those jobs hold the credentials of production), nothing runs on `pull_request_target`, the Infisical sign-in is
// read from secrets only (this repository is public: a variable is world-readable) and only in the environment
// `production`, and the one write path to Infisical is used by two jobs and no other.
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  allActionFiles,
  isInfisicalLoad,
  type CompositeAction,
  type Job,
  type Workflow,
} from "./workflow-support.ts";

const files = allActionFiles();

/** The workflows that hold the credentials of production, and the composite actions they use. */
const PIPELINE = [
  ".github/workflows/deploy-production.yml",
  ".github/workflows/vercel-stage.yml",
  ".github/workflows/rollback-production.yml",
  ".github/workflows/dispatcher-canary.yml",
  ".github/workflows/golden-snapshot.yml",
];
const isPipeline = (path: string): boolean =>
  PIPELINE.includes(path) || path.startsWith(".github/actions/");

const WRITE_ACTION = "./.github/actions/infisical-write-snapshot-pair";

/** Every `uses:` of a workflow or a composite action. */
function usesOf(text: string): string[] {
  const document = parse(text) as Workflow | CompositeAction;
  const steps =
    "jobs" in document
      ? Object.values(document.jobs).flatMap((job) => job.steps ?? [])
      : document.runs.steps;
  const calls =
    "jobs" in document
      ? Object.values(document.jobs).flatMap((job) =>
          job.uses === undefined ? [] : [job.uses],
        )
      : [];
  return [
    ...steps.flatMap((step) => (step.uses === undefined ? [] : [step.uses])),
    ...calls,
  ];
}

describe("the GitHub Actions files", () => {
  it("find the workflows and the composite actions", () => {
    const paths = files.map(([path]) => path);
    expect(paths).toContain(".github/workflows/ci.yml");
    expect(paths).toContain(".github/workflows/deploy-production.yml");
    expect(paths).toContain(".github/actions/infisical-ci-secrets/action.yml");
    expect(paths).toContain(
      ".github/actions/infisical-write-snapshot-pair/action.yml",
    );
    expect(paths).toContain(".github/actions/vercel-cli/action.yml");
  });

  // #403-T04
  it("pin every third-party action to a full commit SHA, and the first-party ones to a version", () => {
    for (const [path, text] of files)
      for (const uses of usesOf(text)) {
        if (uses.startsWith("./")) continue;
        if (uses.startsWith("actions/")) {
          expect(uses, `${path}: ${uses}`).toMatch(
            /^actions\/[\w-]+(\/(restore|save))?@(v\d+|[0-9a-f]{40})$/,
          );
          continue;
        }
        expect(uses, `${path}: ${uses}`).toMatch(/@[0-9a-f]{40}$/);
      }
  });

  // #403-T04
  it("pin every action of the deployment pipeline to a commit, GitHub's own included: those jobs hold production's credentials", () => {
    let checked = 0;
    for (const [path, text] of files) {
      if (!isPipeline(path)) continue;
      for (const uses of usesOf(text)) {
        if (uses.startsWith("./")) continue;
        checked += 1;
        expect(uses, `${path}: ${uses}`).toMatch(/@[0-9a-f]{40}$/);
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  // #403-T04
  it("restore no cache in the jobs that build what is promoted or hold production's credentials", () => {
    for (const [path, text] of files)
      if (isPipeline(path))
        expect(text, path).not.toMatch(/^\s+cache(-dependency-path)?:/m);
  });

  // #403-T05
  it("never run on pull_request_target", () => {
    for (const [path, text] of files) {
      if (!path.includes("/workflows/")) continue;
      const workflow = parse(text) as Workflow;
      expect(Object.keys(workflow.on), path).not.toContain(
        "pull_request_target",
      );
    }
  });

  // #403-T06
  it("read the Infisical sign-in from secrets only, never from a variable", () => {
    for (const [path, text] of files) {
      expect(text, path).not.toMatch(/vars\.INFISICAL/);
      for (const match of text.matchAll(/secrets\.(INFISICAL_\w+)/g))
        expect(
          [
            "INFISICAL_CLIENT_ID",
            "INFISICAL_CLIENT_SECRET",
            "INFISICAL_DOMAIN",
            "INFISICAL_PROJECT_SLUG",
          ],
          path,
        ).toContain(match[1]);
    }
  });

  // #403-T06
  it("use one machine identity: no second client id or secret anywhere", () => {
    for (const [path, text] of files)
      expect(text, path).not.toMatch(
        /INFISICAL_\w*SNAPSHOT\w*|INFISICAL_(WRITE|ADMIN)\w*/,
      );
  });

  // #403-T06
  it("sign in to Infisical only in a job of the environment production, with all four values from secrets", () => {
    let signIns = 0;
    for (const [path, text] of files) {
      if (!path.includes("/workflows/")) continue;
      const workflow = parse(text) as Workflow;
      for (const [name, job] of Object.entries(workflow.jobs) as Array<
        [string, Job]
      >) {
        for (const step of job.steps ?? []) {
          if (!isInfisicalLoad(step) && step.uses !== WRITE_ACTION) continue;
          signIns += 1;
          expect(job.environment, `${path}: ${name}`).toBe("production");
          expect(step.with?.["client-id"]).toBe(
            "${{ secrets.INFISICAL_CLIENT_ID }}",
          );
          expect(step.with?.["client-secret"]).toBe(
            "${{ secrets.INFISICAL_CLIENT_SECRET }}",
          );
          expect(step.with?.domain).toBe("${{ secrets.INFISICAL_DOMAIN }}");
          expect(step.with?.["project-slug"]).toBe(
            "${{ secrets.INFISICAL_PROJECT_SLUG }}",
          );
        }
        // Nothing else uses the environment: it is the one that holds the sign-in. The one other environment is the VM artifacts' release
        // (#976), which holds the signing key of that release and no Infisical sign-in (the loop above fails for any job that has both).
        if (job.environment !== undefined)
          expect(
            job.environment === "production" ||
              (path === ".github/workflows/vm-artifacts-release.yml" &&
                job.environment === "vm-artifacts-release"),
            `${path}: ${name}`,
          ).toBe(true);
      }
    }
    expect(signIns).toBeGreaterThanOrEqual(10);
  });

  // #403-T19
  it("use the write path to Infisical in the persist job and the rollback job, and nowhere else", () => {
    const users: string[] = [];
    for (const [path, text] of files) {
      if (path.includes("infisical-write-snapshot-pair")) continue;
      // The command behind the write path, written out anywhere else, would be a second way in.
      if (path !== ".github/actions/infisical-write-snapshot-pair/action.yml")
        expect(text, path).not.toMatch(/snapshot:ops\s+persist|persistPair/);
      if (!path.includes("/workflows/")) continue;
      const workflow = parse(text) as Workflow;
      for (const [name, job] of Object.entries(workflow.jobs) as Array<
        [string, Job]
      >)
        if ((job.steps ?? []).some((step) => step.uses === WRITE_ACTION))
          users.push(`${path.split("/").pop()}:${name}`);
    }
    expect(users.sort()).toEqual([
      "deploy-production.yml:persist",
      "rollback-production.yml:rollback",
    ]);
  });

  // #403-T19
  it("keep the write path out of every job that only reads /ci: the read-only jobs never call it", () => {
    for (const [path, text] of files) {
      if (!path.includes("/workflows/")) continue;
      const workflow = parse(text) as Workflow;
      for (const [name, job] of Object.entries(workflow.jobs) as Array<
        [string, Job]
      >) {
        const steps = job.steps ?? [];
        if (!steps.some((step) => step.uses === WRITE_ACTION)) continue;
        // A job that writes does not also load credentials it has no use for, except the rollback, which reads the
        // Vercel credentials to roll back and to look the pair up.
        if (name === "persist")
          expect(steps.some(isInfisicalLoad), `${path}: ${name}`).toBe(false);
      }
    }
  });

  // #403-T06
  it("keep the Vercel and Infisical values out of command lines and of the shell text", () => {
    for (const [path, text] of files) {
      const document = parse(text) as Workflow | CompositeAction;
      const steps =
        "jobs" in document
          ? Object.values(document.jobs).flatMap((job) => job.steps ?? [])
          : document.runs.steps;
      for (const step of steps) {
        const run = step.run ?? "";
        expect(run, `${path}: ${step.name}`).not.toContain("${{");
        expect(run, `${path}: ${step.name}`).not.toMatch(
          /--token|set -x|--debug|xtrace/,
        );
      }
    }
  });
});
