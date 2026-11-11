// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the two workflows of the Factory-Runner's program release (#1002): runner-program.yml builds the tarball (and, for a pull request, runs the
// installer lane against it) without any secret, and runner-program-release.yml (a tag, never anything else) is the only place that holds the signing
// key and the only one that can write. It reads the files as YAML; that the real installer takes the real tarball on a real systemd is verified by
// the lane's own runs.
import { describe, expect, it } from "vitest";
import {
  REPOSITORY,
  readText,
  readWorkflow,
  stepsOf,
  type Job,
} from "./workflow-support.ts";

const build = readWorkflow("runner-program.yml");
const release = readWorkflow("runner-program-release.yml");
const buildText = readText(".github/workflows/runner-program.yml");
const releaseText = readText(".github/workflows/runner-program-release.yml");
const ci = readWorkflow("ci.yml");

function job(workflow: { jobs: Record<string, Job> }, id: string): Job {
  const found = workflow.jobs[id];
  if (!found) throw new Error(`no job ${id}`);
  return found;
}

describe("the build workflow", () => {
  // #1002-T03
  it("is called by the CI workflow and by the release workflow, and runs nothing by itself", () => {
    expect(Object.keys(build.on).sort()).toEqual([
      "workflow_call",
      "workflow_dispatch",
    ]);
  });

  // #1002-T03
  it("holds no secret, no write permission and no login to a registry", () => {
    expect(build.permissions).toEqual({ contents: "read" });
    for (const id of Object.keys(build.jobs))
      expect(job(build, id).permissions, id).toBeUndefined();
    expect(buildText).not.toMatch(/secrets\./);
    expect(buildText).not.toMatch(
      /docker\/login-action|packages: write|contents: write/,
    );
    expect(buildText).not.toMatch(/SIGNING_KEY/);
  });

  // #1002-T03
  it("runs the installer lane for a pull request, with the real tarball, and builds once and hands the files on for a release", () => {
    const steps = stepsOf(job(build, "program"));
    const lane = steps.find((step) => step.run?.includes("runner/release/lane.sh"));
    const built = steps.find((step) =>
      step.run?.includes("runner/release/build_program.py"),
    );

    expect(lane?.if).toBe("${{ !inputs.for_release }}");
    expect(lane?.["continue-on-error"]).toBeUndefined();
    expect(built?.if).toBe("${{ inputs.for_release }}");
    expect(built?.run).toContain('--release "$RELEASE"');
    expect(built?.run).toContain('--commit "$(git rev-parse HEAD)"');
  });

  // #1002-T03
  it("builds only a tree that is the commit, and hands a release's files to the signing job through the Actions cache, never as an artifact", () => {
    const steps = stepsOf(job(build, "program"));
    const names = steps.map((step) => step.name ?? "");
    const save = steps.find((step) => step.uses?.startsWith("actions/cache/save"));

    expect(names.indexOf("The tree is the commit")).toBeLessThan(
      names.findIndex((name) => name.startsWith("Build the program tarball")),
    );
    expect(save?.if).toBe("${{ inputs.for_release }}");
    expect(String(save?.with?.key)).toContain("github.run_id");
    expect(buildText).not.toMatch(/upload-artifact/);
  });

  // #1002-T03
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
  // #1002-T01
  it("runs for a tag factory-runner-v<N> and for nothing else", () => {
    expect(release.on).toEqual({
      push: { tags: ["factory-runner-v*"] },
    });
  });

  // #1002-T01
  it("is the only workflow that reads the signing key, in one job of its own environment and one step of it", () => {
    expect(
      releaseText.match(/secrets\.RUNNER_PROGRAM_SIGNING_KEY/g),
    ).toHaveLength(1);
    expect(buildText).not.toContain("RUNNER_PROGRAM_SIGNING_KEY");
    expect(readText(".github/workflows/ci.yml")).not.toContain(
      "RUNNER_PROGRAM_SIGNING_KEY",
    );

    const signing = job(release, "release");
    expect(signing.environment).toBe("runner-program-release");
    const holders = stepsOf(signing).filter((step) =>
      JSON.stringify(step).includes("RUNNER_PROGRAM_SIGNING_KEY"),
    );
    expect(holders).toHaveLength(1);
    expect(holders[0]?.name).toBe("Sign the manifest");
    // The job that builds (downloads of pinned files, the bundled Python) has neither the key nor the environment.
    expect(job(release, "build").environment).toBeUndefined();
    expect(job(release, "number").environment).toBeUndefined();
  });

  // #1002-T01
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
    expect(releaseText).not.toMatch(/--draft=false|gh release edit/);
  });

  // #1002-T01
  it("refuses to sign with a key that is not the channel's, and checks what it publishes with the verifier of the installer's checks", () => {
    const steps = stepsOf(job(release, "release"));
    const names = steps.map((step) => step.name ?? "");
    const sign = steps.find((step) => step.name === "Sign the manifest");
    const verifyAt = names.findIndex((name) =>
      name.startsWith("Verify what is about to be published"),
    );

    expect(sign?.run).toContain("runner/release-channel.json");
    expect(sign?.run).toContain("openssl dgst -sha256 -sign");
    expect(verifyAt).toBeGreaterThan(names.indexOf("Sign the manifest"));
    const verify = String(steps[verifyAt]?.run);
    expect(verify).toContain("runner/release/verify-release.sh");
    expect(verify).toContain("--channel runner/release-channel.json");
    expect(verify).toContain('--commit "$GITHUB_SHA"');
    expect(verify).toContain('--min-release "$LAST"');
    expect(verify).toContain("--exact-dir");
    // The key file is removed after the signature and once more at the end, whatever happened.
    expect(sign?.run).toContain("rm -f");
    expect(steps.at(-1)?.if).toContain("always()");
  });

  // #1002-T01
  it("installs nothing and runs no third-party code in the job that holds the key", () => {
    const steps = stepsOf(job(release, "release"));

    for (const step of steps) {
      if (step.uses)
        expect(
          ["actions/checkout@v7", "actions/cache/restore@v4"],
          step.name,
        ).toContain(step.uses);
      expect(step.with?.cache, step.name).toBeUndefined();
      expect(step.run ?? "", step.name).not.toMatch(
        /\b(pnpm|npm|npx|yarn|pip|pip3|uv|uvx|cargo|go) |apt-get|docker (build|run)|curl [^\n|]*\| *(ba)?sh/,
      );
    }
    expect(releaseText).not.toMatch(/setup-node|setup-uv|setup-python|build-push-action/);
  });

  // #1002-T01
  it("starts only for a commit that is on main, before the build is paid for and before the key is asked for", () => {
    const guard = job(release, "guard");
    const run = stepsOf(guard)
      .map((step) => step.run ?? "")
      .join("\n");

    expect(guard.needs).toBe("number");
    expect(guard.environment).toBeUndefined();
    expect(run).toContain("compare/main...$GITHUB_SHA");
    expect(run).toMatch(/identical \| behind/);
    // By the API: no checkout, so no code of the tag runs for it.
    expect(
      stepsOf(guard).some((step) => step.uses?.startsWith("actions/checkout")),
    ).toBe(false);
    expect(job(release, "build").needs).toEqual(["number", "guard"]);
    expect(job(release, "build").uses).toBe(
      "./.github/workflows/runner-program.yml",
    );
    expect(job(release, "release").needs).toEqual(["number", "guard", "build"]);
    expect(job(release, "build").with?.for_release).toBe(true);
  });

  // #1002-T01
  it("takes a release number higher than every other release and a channel that names the assets the installer reads", () => {
    const steps = stepsOf(job(release, "release"));
    const names = steps.map((step) => step.name ?? "");
    const channel = steps.find((step) =>
      step.name?.startsWith("The channel names a key"),
    );
    const published = steps.find((step) => step.id === "published");
    const verify = steps.find((step) =>
      step.name?.startsWith("Verify what is about to be published"),
    );

    expect(channel?.run).toContain("runner/release-channel.json");
    expect(channel?.run).toContain(".publicKey");
    expect(channel?.run).toContain("runner-manifest.json");
    expect(channel?.run).toContain("runner-manifest.sig");
    expect(published?.run).toContain("gh release list");
    expect(published?.run).toMatch(/test "\$RELEASE" -gt "\$last"/);
    expect(names.indexOf(published?.name ?? "")).toBeLessThan(
      names.indexOf("Sign the manifest"),
    );
    expect(verify?.env?.LAST).toBe("${{ steps.published.outputs.last }}");
  });

  // #1002-T01
  it("pairs the program with the VM artifacts release it needs, before it signs: the release exists, its manifest verifies with the VM channel's key, and its commit is in this commit's history", () => {
    const steps = stepsOf(job(release, "release"));
    const names = steps.map((step) => step.name ?? "");
    const pair = steps.find((step) => step.id === "pair");

    expect(pair).toBeDefined();
    expect(names.indexOf(pair?.name ?? "")).toBeLessThan(
      names.indexOf("Sign the manifest"),
    );
    const run = String(pair?.run);
    expect(run).toContain("runner/release/pair.json");
    expect(run).toContain("vm-artifacts-v$needed");
    expect(run).toContain("docker/vm/release-channel.json");
    expect(run).toContain("openssl dgst -sha256 -verify");
    expect(run).toContain("compare/$vm_commit...$GITHUB_SHA");
    expect(run).toMatch(/identical \| ahead/);
    // The notes of the draft name the release the program needs.
    const draft = steps.find((step) => step.name?.startsWith("Draft release"));
    expect(draft?.env?.VM_RELEASE).toBe("${{ steps.pair.outputs.vm }}");
    expect(String(draft?.run)).toContain("Needs the VM artifacts release");
  });

  // #1002-T01
  it("publishes the files under the names the channel file and the installer read", () => {
    const draft = stepsOf(job(release, "release")).find((step) =>
      step.name?.startsWith("Draft release"),
    );
    const channel = JSON.parse(readText("runner/release-channel.json")) as Record<
      string,
      unknown
    >;

    expect(String(draft?.run)).toContain(`mv manifest.json ${channel.manifestAsset}`);
    expect(String(draft?.run)).toContain(`mv manifest.sig ${channel.signatureAsset}`);
  });

  // #1002-T01
  it("runs only in this repository", () => {
    expect(job(release, "number").if).toContain(REPOSITORY);
  });
});

describe("the CI workflow's part in it", () => {
  // #1002-T03
  it("calls the build workflow for a pull request that changes what the program is made of, and for nothing else", () => {
    const call = job(ci, "runner-program");

    expect(call.uses).toBe("./.github/workflows/runner-program.yml");
    const condition = String(call.if);
    expect(condition).toContain("github.event_name == 'pull_request'");
    expect(condition).toContain("needs.changes.outputs.program == 'true'");
    expect(condition).not.toContain("push");
    expect(condition).not.toContain("base_ref");
    expect(call.permissions).toEqual({ contents: "read" });
  });

  // #1002-T03
  it("is part of the aggregate check, and the scripts of the release are shellchecked with the installer", () => {
    expect(job(ci, "ci-passed").needs).toContain("runner-program");
    const shellcheck = stepsOf(job(ci, "runner-fast")).find((step) =>
      step.name?.startsWith("Shellcheck"),
    );

    expect(shellcheck?.run).toContain("install/install.sh");
    expect(shellcheck?.run).toContain("release/verify-release.sh");
    expect(shellcheck?.run).toContain("release/lane.sh");
  });
});
