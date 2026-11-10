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

  // #978-T05
  it("runs the launcher lane after the smoke boot: the local Dispatcher's launcher starts a job in a VM, as a normal user in a delegated cgroup", () => {
    const steps = stepsOf(job(build, "build"));
    const names = steps.map((step) => step.name ?? "");
    const lane = steps.find((step) => step.name?.startsWith("Launcher lane"));

    expect(lane).toBeDefined();
    const at = (text: string): number =>
      names.findIndex((name) => name.startsWith(text));
    expect(at("Launcher lane")).toBeGreaterThan(at("Smoke boot"));
    expect(at("Launcher lane")).toBeLessThan(at("Manifest"));
    expect(lane?.["continue-on-error"]).toBeUndefined();
    const script = String(lane?.run);
    // The test itself runs as the runner's user, never as root: only the TAP and the transient unit are made with sudo.
    expect(script).toContain("-p Delegate=yes");
    expect(script).toContain('-p User="$USER"');
    expect(script).toContain("run --frozen pytest -m kvm tests/kvm");
    expect(script).not.toMatch(/sudo [^\n]*pytest/);
    expect(script).toContain("tuntap add dev fctap0");
    for (const variable of [
      "KVM_VM_KERNEL",
      "KVM_VM_ROOTFS",
      "KVM_VM_BASE_DISK",
      "KVM_VM_IMAGES",
      "KVM_VM_STATE_DIR",
    ])
      expect(script).toContain(variable);
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

  // #976-T04
  it("never takes the kernel of a release from the cache: the cache steps run for pull requests only, and the build runs when nothing was restored", () => {
    const steps = stepsOf(job(build, "kernel"));
    const restore = steps.find((step) =>
      step.uses?.startsWith("actions/cache/restore"),
    );
    const save = steps.find((step) =>
      step.uses?.startsWith("actions/cache/save"),
    );
    const built = steps.find((step) =>
      step.name?.startsWith("Build the kernel"),
    );

    expect(build.on.workflow_call).toMatchObject({
      inputs: { for_release: { type: "boolean", default: false } },
    });
    expect(String(restore?.if)).toContain("!inputs.for_release");
    expect(String(save?.if)).toContain("!inputs.for_release");
    // A skipped restore leaves `cache-hit` empty, which is not 'true': the kernel is built.
    expect(String(built?.if)).toContain("cache-hit != 'true'");
    expect(String(built?.if)).not.toContain("for_release");
  });

  // #976-T03
  it("keeps the data disk out of every workflow artifact and every artifact short-lived", () => {
    const uploads = Object.keys(build.jobs).flatMap((id) =>
      stepsOf(job(build, id))
        .filter((step) => step.uses?.startsWith("actions/upload-artifact"))
        .map((step) => ({ id, step })),
    );

    expect(uploads.length).toBeGreaterThan(0);
    for (const { id, step } of uploads) {
      const path = String(step.with?.path);
      expect(path, `${id}: ${step.name ?? step.with?.name}`).not.toMatch(
        /data-out|dockerdata|\/release(\s|$)|rootfs-out/,
      );
      expect(step.with?.name).not.toBe("vm-artifacts");
      expect(
        Number(step.with?.["retention-days"]),
        String(step.with?.name),
      ).toBeLessThanOrEqual(3);
    }
    // Nothing downloads an artifact of the release's files either.
    expect(releaseText).not.toContain("download-artifact");
    expect(buildText).not.toMatch(/name: vm-artifacts\s*$/m);
  });

  // #976-T01
  it("hands the release's files to the signing job through the cache, for a release only, under a key of this run", () => {
    const save = stepsOf(job(build, "build")).find((step) =>
      step.uses?.startsWith("actions/cache/save"),
    );
    const restore = stepsOf(job(release, "release")).find((step) =>
      step.uses?.startsWith("actions/cache/restore"),
    );

    expect(String(save?.if)).toContain("inputs.for_release");
    expect(save?.with?.path).toBe("${{ env.VM_WORK }}/release");
    expect(String(save?.with?.key)).toContain("github.run_id");
    expect(restore?.with?.path).toBe(save?.with?.path);
    expect(restore?.with?.key).toBe(save?.with?.key);
    expect(restore?.with?.["fail-on-cache-miss"]).toBe(true);
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
    // The jobs that run third-party code at build time (`build`: apt, docker build, the kernel's tools) have neither the key nor the environment;
    // the job that has them installs with --ignore-scripts and builds nothing (the test below).
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
  it("compares this commit's recipe with the hosted golden snapshot's record before it signs, and says what the step does", () => {
    const steps = stepsOf(job(release, "release"));
    const names = steps.map((step) => step.name ?? "");
    const compare = names.findIndex((name) =>
      name.startsWith("Compare this commit's recipe"),
    );

    expect(compare).toBeGreaterThan(-1);
    expect(compare).toBeLessThan(names.indexOf("Sign the manifest"));
    expect(names[compare]).toContain("image ids reported, not enforced");
    expect(steps[compare]?.run).toContain("compare-main.ts");
    // The image ids are the owner's decision: the flag that enforces them is not passed.
    expect(steps[compare]?.run).not.toContain("--require-images");
    expect(releaseText).not.toContain(
      "The hosted golden snapshot has the same recipe",
    );
  });

  // #976-T01
  it("runs no lifecycle script of a dependency in the job that holds the key", () => {
    const steps = stepsOf(job(release, "release"));
    const installs = steps.filter((step) => step.run?.includes("pnpm install"));

    expect(installs).toHaveLength(1);
    expect(installs[0]?.run).toContain("--frozen-lockfile");
    expect(installs[0]?.run).toContain("--ignore-scripts");
    // No cache of dependencies a pull request could have written, and no other way to run a package's script.
    for (const step of steps) {
      expect(step.with?.cache, step.name).toBeUndefined();
      expect(step.run ?? "", step.name).not.toMatch(
        /\bpnpm (run|exec|dlx)|(^|[\s;&|])(npx|yarn) |(^|[\s;&|])npm (install|ci|run)/,
      );
    }
    // And it builds nothing: the third-party code of the build (apt, docker) is the job `build`.
    expect(releaseText).not.toMatch(/apt-get|docker build|build-push-action/);
  });

  // #976-T01
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
    expect(job(release, "release").needs).toEqual(["number", "guard", "build"]);
    expect(job(release, "build").with?.for_release).toBe(true);
  });

  // #976-T01
  it("takes a release number higher than every other release and a channel file of this repository", () => {
    const steps = stepsOf(job(release, "release"));
    const names = steps.map((step) => step.name ?? "");
    const channel = steps.find((step) =>
      step.name?.startsWith("The channel is this repository's"),
    );
    const published = steps.find((step) => step.id === "published");
    const verify = steps.find((step) =>
      step.name?.startsWith("Verify what is about to be published"),
    );

    expect(channel?.run).toContain("$GITHUB_REPOSITORY");
    expect(channel?.run).toContain(".repository");
    expect(channel?.run).toContain(".manifestAsset");
    expect(channel?.run).toContain(".signatureAsset");
    expect(published?.run).toContain("gh release list");
    expect(published?.run).toMatch(/test "\$RELEASE" -gt "\$last"/);
    expect(names.indexOf(published?.name ?? "")).toBeLessThan(
      names.indexOf("Sign the manifest"),
    );
    // The verifier is held to it too: strictly higher than the last release, and nothing in the directory that was not signed.
    expect(verify?.run).toContain('--min-release "$LAST"');
    expect(verify?.run).toContain("--exact-dir");
    expect(verify?.env?.LAST).toBe("${{ steps.published.outputs.last }}");
  });

  // #976-T01
  it("points the GPL source offer at a stable address, not at 'the archive'", () => {
    expect(releaseText).toContain("https://snapshot.ubuntu.com/ubuntu/");
    expect(releaseText).toContain("build date");
    expect(releaseText).not.toMatch(/Ubuntu's archive/);
    expect(releaseText).toContain(".builtAt");
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

  // #978-T05
  it("runs the build, with the launcher lane in it, when the launcher, vm-init or the lane change", () => {
    const filter = readText(".github/workflows/ci.yml");

    for (const path of [
      "runner/src/code_reviewer_runner/factory_runner/firecracker/**",
      "runner/src/code_reviewer_runner/vm_init/**",
      "runner/vm-init/**",
      "runner/tests/kvm/**",
    ])
      expect(filter, path).toContain(path);
  });
});
