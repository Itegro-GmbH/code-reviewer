// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the two workflows of the Linux VM artifacts (#976): vm-artifacts.yml builds and smoke boots them without any secret, and
// vm-artifacts-release.yml (a tag, never anything else) is the only place that holds the signing key and the only one that can write. It reads
// the files as YAML; that the KVM runner boots the guest is verified by the runs themselves.
import { describe, expect, it } from "vitest";
import {
  REPOSITORY,
  readText,
  readWorkflow,
  stepsOf,
  type Job,
} from "./workflow-support.ts";

const build = readWorkflow("vm-artifacts.yml");
const release = readWorkflow("vm-artifacts-release.yml");
const buildText = readText(".github/workflows/vm-artifacts.yml");
const releaseText = readText(".github/workflows/vm-artifacts-release.yml");
const ci = readWorkflow("ci.yml");

function job(workflow: { jobs: Record<string, Job> }, id: string): Job {
  const found = workflow.jobs[id];
  if (!found) throw new Error(`no job ${id}`);
  return found;
}

describe("the build workflow", () => {
  // #976-T03
  it("is called by the CI workflow and by the release workflow, and runs nothing by itself", () => {
    expect(Object.keys(build.on).sort()).toEqual([
      "workflow_call",
      "workflow_dispatch",
    ]);
  });

  // #976-T03
  it("holds no secret, no write permission and no login to a registry", () => {
    expect(build.permissions).toEqual({ contents: "read" });
    for (const id of Object.keys(build.jobs))
      expect(job(build, id).permissions, id).toBeUndefined();
    expect(buildText).not.toMatch(/secrets\./);
    expect(buildText).not.toMatch(
      /docker\/login-action|packages: write|contents: write/,
    );
    expect(buildText).not.toMatch(/push: true/);
    // The key of the release is not here: the self-test signs with a throwaway one.
    expect(buildText).not.toMatch(/SIGNING_KEY/);
  });

  // #976-T03
  it("boots the guest in a smoke test after the data disk is made, and builds the manifest after that", () => {
    const names = stepsOf(job(build, "build")).map((step) => step.name ?? "");
    const at = (text: string): number =>
      names.findIndex((name) => name.includes(text));

    expect(at("Prepared Docker data disk")).toBeGreaterThan(-1);
    expect(at("Smoke boot")).toBeGreaterThan(at("Prepared Docker data disk"));
    expect(at("Manifest")).toBeGreaterThan(at("Smoke boot"));
    expect(at("Sign with a throwaway key")).toBeGreaterThan(at("Manifest"));
  });

  // #976-T03
  it("gives the smoke boot a budget for dockerd and has it fail the job", () => {
    const smoke = stepsOf(job(build, "build")).find((step) =>
      step.name?.startsWith("Smoke boot"),
    );

    expect(smoke?.run).toContain("--docker-ready-budget-ms");
    expect(smoke?.["continue-on-error"]).toBeUndefined();
  });

  // #976-T04
  it("verifies the kernel configuration on every run, also when the built kernel comes from the cache", () => {
    const steps = stepsOf(job(build, "kernel"));
    const configure = steps.findIndex((step) =>
      step.run?.includes("docker/vm/kernel/configure.sh"),
    );
    const restore = steps.findIndex((step) =>
      step.uses?.startsWith("actions/cache/restore"),
    );

    expect(configure).toBeGreaterThan(-1);
    expect(configure).toBeLessThan(restore);
    expect(steps[configure]?.if).toBeUndefined();
  });

  // #976-T04
  it("keys the kernel cache by every input of the kernel and saves it right after the build", () => {
    const steps = stepsOf(job(build, "kernel"));
    const restore = steps.find((step) =>
      step.uses?.startsWith("actions/cache/restore"),
    );
    const key = String(restore?.with?.key);

    expect(key).toContain("docker/vm/pins.env");
    expect(key).toContain("docker/vm/kernel/**");
    const names = steps.map((step) => step.name ?? step.uses ?? "");
    const built = names.findIndex((name) =>
      name.startsWith("Build the kernel"),
    );
    expect(names[built + 1]).toContain("Save the kernel to the cache");
  });

  // #976-T03
  it("pins every third-party action of the build to a commit", () => {
    for (const id of Object.keys(build.jobs))
      for (const step of stepsOf(job(build, id))) {
        if (!step.uses || step.uses.startsWith("actions/")) continue;
        expect(step.uses, `${id}: ${step.uses}`).toMatch(
          /@[0-9a-f]{40}( #.*)?$/,
        );
      }
  });
});

describe("the release workflow", () => {
  // #976-T01
  it("runs for a tag vm-artifacts-v<N> and for nothing else", () => {
    expect(release.on).toEqual({
      push: { tags: ["vm-artifacts-v*"] },
    });
  });

  // #976-T01
  it("is the only workflow that reads the signing key, in one job of its own environment and one step of it", () => {
    const holders = [
      [".github/workflows/vm-artifacts-release.yml", releaseText],
    ];
    for (const [path, text] of holders)
      expect(
        text.match(/secrets\.VM_ARTIFACTS_SIGNING_KEY/g),
        path,
      ).toHaveLength(1);
    expect(buildText).not.toContain("VM_ARTIFACTS_SIGNING_KEY");
    expect(readText(".github/workflows/ci.yml")).not.toContain(
      "VM_ARTIFACTS_SIGNING_KEY",
    );

    const signing = job(release, "release");
    expect(signing.environment).toBe("vm-artifacts-release");
    const holdersOfTheSecret = stepsOf(signing).filter((step) =>
      JSON.stringify(step).includes("VM_ARTIFACTS_SIGNING_KEY"),
    );
    expect(holdersOfTheSecret).toHaveLength(1);
    expect(holdersOfTheSecret[0]?.name).toBe("Sign the manifest");
    // The other jobs, the ones that run third-party code (apt, docker build), have neither the key nor the environment.
    expect(job(release, "build").environment).toBeUndefined();
    expect(job(release, "number").environment).toBeUndefined();
  });

  // #976-T01
  it("is the only job that writes, and it makes a draft the owner publishes", () => {
    expect(release.permissions).toEqual({ contents: "read" });
    expect(job(release, "release").permissions).toMatchObject({
      contents: "write",
    });
    expect(job(release, "build").permissions).toEqual({ contents: "read" });
    const create = stepsOf(job(release, "release")).find((step) =>
      step.run?.includes("gh release create"),
    );
    expect(create?.run).toContain("--draft");
    expect(create?.run).toContain("--verify-tag");
  });

  // #976-T01
  it("refuses to sign with a key that is not the channel's, and checks what it publishes with the verifier a host uses", () => {
    const steps = stepsOf(job(release, "release"));
    const names = steps.map((step) => step.name ?? "");
    const sign = steps.find((step) => step.name === "Sign the manifest");
    const verifyAt = names.findIndex((name) =>
      name.startsWith("Verify what is about to be published"),
    );

    expect(sign?.run).toContain("release-channel.json");
    expect(sign?.run).toContain("openssl dgst -sha256 -sign");
    expect(verifyAt).toBeGreaterThan(names.indexOf("Sign the manifest"));
    expect(steps[verifyAt]?.run).toContain("verify-main.ts");
    expect(steps[verifyAt]?.run).toContain(
      "--channel docker/vm/release-channel.json",
    );
    // The key file is removed after the signature and once more at the end, whatever happened.
    expect(sign?.run).toContain("rm -f");
    expect(steps.at(-1)?.if).toContain("always()");
  });

  // #976-T02
  it("compares the recipe with the hosted golden snapshot's record before it signs", () => {
    const names = stepsOf(job(release, "release")).map(
      (step) => step.name ?? "",
    );

    expect(
      names.indexOf("The hosted golden snapshot has the same recipe"),
    ).toBeGreaterThan(-1);
    expect(
      names.indexOf("The hosted golden snapshot has the same recipe"),
    ).toBeLessThan(names.indexOf("Sign the manifest"));
  });

  // #976-T01
  it("runs only in this repository", () => {
    expect(job(release, "number").if).toContain(REPOSITORY);
  });
});

describe("the CI workflow's part in it", () => {
  // #976-T03
  it("calls the build workflow for a pull request that changes what it is made from, and for nothing else", () => {
    const call = job(ci, "vm-artifacts");

    expect(call.uses).toBe("./.github/workflows/vm-artifacts.yml");
    const condition = String(call.if);
    expect(condition).toContain("github.event_name == 'pull_request'");
    expect(condition).toContain("needs.changes.outputs.vm == 'true'");
    expect(condition).not.toContain("push");
    expect(condition).not.toContain("base_ref");
    expect(call.permissions).toEqual({ contents: "read" });
  });
});
