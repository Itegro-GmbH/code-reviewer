// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { FakeSandboxService } from "../../../fakes/vercel-sandbox/service.ts";
import { createLogger } from "../core/logger.ts";
import {
  IMAGE_ID,
  MANIFEST_HASH,
  MANIFEST_OK,
  OTHER_IMAGE_ID,
  PROBE_OK,
  SYSBOX_PREPARE_TEXT,
  SYSBOX_PROBE_OK,
  VM_PREPARE_TEXT,
  happyFake,
  testConfig,
  testInput,
} from "../test-support/snapshot-harness.ts";
import { SnapshotPipelineError } from "./errors.ts";
import type { SnapshotErrorCode } from "./errors.ts";
import { runPipeline } from "./pipeline.ts";
import {
  PATHS,
  STEPS,
  recordBaseManifestScript,
  scanScript,
} from "./scripts.ts";

const NOW = new Date("2026-10-15T18:00:00.000Z");

function run(
  fake: FakeSandboxService,
  input = testInput(),
  options: { signal?: AbortSignal } = {},
) {
  const lines: string[] = [];
  const logger = createLogger((line) => lines.push(line), []);
  const result = runPipeline(
    { service: fake, logger, clock: () => NOW, signal: options.signal },
    input,
  );
  return { result, lines };
}

async function failure(
  promise: Promise<unknown>,
): Promise<SnapshotPipelineError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SnapshotPipelineError);
    return error as SnapshotPipelineError;
  }
  throw new Error("the pipeline did not fail");
}

function expectNothingPublished(fake: FakeSandboxService) {
  expect(fake.liveSnapshotIds()).toEqual([]);
}

describe("the golden snapshot pipeline", () => {
  // #330-T01
  it("runs its steps in order and returns the record with the snapshot id and the image digest", async () => {
    const fake = happyFake();
    const { result } = run(fake);
    const { record } = await result;

    const builder = "code-reviewer-golden-builder-20261015T180000Z";
    const check = "code-reviewer-golden-check-20261015T180000Z";
    expect(fake.events.filter((event) => !event.startsWith("write:"))).toEqual([
      `create:${builder}`,
      `exec:${STEPS.recordBaseManifest}`,
      `exec:${STEPS.installDocker}`,
      `exec:${STEPS.installSysbox}`,
      `exec:${STEPS.writeDaemonConfig}`,
      `exec:${STEPS.installHostScripts}`,
      `exec:${STEPS.startDaemon}`,
      `exec:${STEPS.buildImage}`,
      `exec:${STEPS.inspectImage}`,
      `exec:${STEPS.cleanBuilder}`,
      `exec:${STEPS.checkNoContainers}`,
      `exec:${STEPS.stopDaemon}`,
      `snapshot:${record.snapshotId}`,
      `create:${check}`,
      `exec:${STEPS.scanFilesystem}`,
      `exec:${STEPS.startDaemonCheck}`,
      `exec:${STEPS.inspectRestoredImage}`,
      `exec:${STEPS.probe}`,
      `exec:${STEPS.sysboxProbe}`,
      `destroy:${check}`,
    ]);
    expect(fake.events.filter((event) => event.startsWith("write:"))).toEqual([
      `write:${PATHS.daemonJson}`,
      `write:${PATHS.vmPrepare}`,
      `write:${PATHS.sysboxPrepare}`,
      `write:${PATHS.context}`,
    ]);
    expect(record).toEqual({
      version: 1,
      snapshotId: [...fake.snapshots.keys()][0],
      imageDigest: IMAGE_ID,
      builtAt: "2026-10-15T18:00:00.000Z",
      region: "fra1",
      target: "sandbox",
      commit: "0123456789abcdef0123456789abcdef01234567",
      sysbox: "proven",
    });
    expect(fake.liveSnapshotIds()).toEqual([record.snapshotId]);
  });

  it("creates the builder in fra1 and the check VM from the snapshot without persistence", async () => {
    const fake = happyFake();
    const { record } = await run(fake).result;
    const builder = fake.vms.get(
      "code-reviewer-golden-builder-20261015T180000Z",
    );
    const check = fake.vms.get("code-reviewer-golden-check-20261015T180000Z");
    expect(builder?.options).toMatchObject({
      region: "fra1",
      vcpus: 2,
      persistent: true,
      tags: { app: "code-reviewer", role: "golden-builder" },
    });
    expect(builder?.options.source).toBeUndefined();
    expect(check?.options).toMatchObject({
      region: "fra1",
      persistent: false,
      source: { type: "snapshot", snapshotId: record.snapshotId },
      tags: { app: "code-reviewer", role: "golden-check" },
    });
    // The builder holds the snapshot, so it stays; the check VM is gone and took no snapshot with it.
    expect(builder?.state).toBe("stopped");
    expect(check?.state).toBe("deleted");
    expect(fake.snapshots.get(record.snapshotId)?.status).toBe("created");
  });

  it("takes the snapshot without an expiry", async () => {
    const fake = happyFake();
    await run(fake).result;
    expect(fake.requestText()).toMatch(
      /snapshot code-reviewer-golden-builder-\S+ \{"expirationMs":0\}/,
    );
  });

  it("uploads the commit, the daemon configuration and vm-prepare.sh as they are", async () => {
    const fake = happyFake();
    await run(fake).result;
    const builder = fake.vms.get(
      "code-reviewer-golden-builder-20261015T180000Z",
    );
    expect(builder?.files.get(PATHS.vmPrepare)).toBe(VM_PREPARE_TEXT);
    expect(
      JSON.parse(builder?.files.get(PATHS.daemonJson) ?? "{}"),
    ).toMatchObject({ ipv6: false });
    expect(builder?.files.get(PATHS.context)?.length).toBe(7);
  });

  // #330-T02
  it("gives no command an environment: no credential reaches a VM", async () => {
    const fake = happyFake();
    await run(fake).result;
    expect(fake.calls.length).toBeGreaterThan(10);
    for (const call of fake.calls)
      expect(call.env ?? {}, call.label).toEqual({});
  });

  // #330-T02
  it("logs step names and stable codes, never the output of a VM", async () => {
    const fake = happyFake();
    fake.onExec(STEPS.installDocker, {
      stdout: "apt says SECRET-LOOKING-OUTPUT-123",
      stderr: "stderr-text-456",
    });
    const { result, lines } = run(fake);
    await result;
    const text = lines.join("\n");
    expect(text).toContain(STEPS.installDocker);
    expect(text).not.toContain("SECRET-LOOKING-OUTPUT-123");
    expect(text).not.toContain("stderr-text-456");
  });

  // #330-T03
  it("fails when the image in the restored snapshot is not the one that was built, and records nothing", async () => {
    const fake = happyFake();
    fake.onExec(STEPS.inspectRestoredImage, { stdout: `${OTHER_IMAGE_ID}\n` });
    const error = await failure(run(fake).result);
    expect(error.code).toBe("image_digest_mismatch");
    expect(error.step).toBe(STEPS.inspectRestoredImage);
    expect(error.detail.join(" ")).not.toContain(IMAGE_ID);
    expectNothingPublished(fake);
    expect(fake.callsFor(STEPS.probe)).toHaveLength(0);
  });

  // #330-T03
  it.each([
    "",
    "latest\n",
    "sha256:abc\n",
    `${IMAGE_ID}\nextra\n`,
    `${IMAGE_ID.toUpperCase()}\n`,
  ])(
    "refuses an image id that is not one sha256 digest (%j) before any snapshot is taken",
    async (stdout) => {
      const fake = happyFake();
      fake.onExec(STEPS.inspectImage, { stdout });
      const error = await failure(run(fake).result);
      expect(error.code).toBe("image_digest_invalid");
      expect(fake.events.some((event) => event.startsWith("snapshot:"))).toBe(
        false,
      );
      expectNothingPublished(fake);
    },
  );

  // #330-T04
  it("fails when a container exists at snapshot time, before the daemon is stopped or a snapshot is taken", async () => {
    const fake = happyFake();
    fake.onExec(STEPS.checkNoContainers, { stdout: "3f2a9c1d7b00\n" });
    const error = await failure(run(fake).result);
    expect(error.code).toBe("containers_present");
    expect(error.detail).toEqual(["1"]);
    expect(fake.callsFor(STEPS.stopDaemon)).toHaveLength(0);
    expect(fake.events.some((event) => event.startsWith("snapshot:"))).toBe(
      false,
    );
    expectNothingPublished(fake);
    expect(
      fake.vms.get("code-reviewer-golden-builder-20261015T180000Z")?.state,
    ).toBe("deleted");
  });

  it("fails with its own code when the daemon cannot be asked for its containers", async () => {
    const fake = happyFake();
    fake.onExec(STEPS.checkNoContainers, { exitCode: 1 });
    const error = await failure(run(fake).result);
    expect(error.code).toBe("daemon_query_failed");
    expect(fake.events.some((event) => event.startsWith("snapshot:"))).toBe(
      false,
    );
  });

  it("fails when the daemon does not stop, and takes no snapshot", async () => {
    const fake = happyFake();
    fake.onExec(STEPS.stopDaemon, {
      exitCode: 1,
      stderr: "dockerd still running",
    });
    const error = await failure(run(fake).result);
    expect(error.code).toBe("daemon_not_stopped");
    expect(fake.events.some((event) => event.startsWith("snapshot:"))).toBe(
      false,
    );
  });

  // #357-T10
  it("records the base manifest as the first command of the builder, before anything is installed", async () => {
    const fake = happyFake();
    await run(fake).result;
    const [first, second] = fake.calls;
    expect(first?.label).toBe(STEPS.recordBaseManifest);
    expect(first?.sudo).toBe(true);
    expect(first?.script).toBe(recordBaseManifestScript());
    expect(second?.label).toBe(STEPS.installDocker);
    // The scan reads the very file the record step wrote.
    expect(first?.script).toContain(PATHS.baseManifest);
    const scanCall = fake.callsFor(STEPS.scanFilesystem)[0];
    expect(scanCall?.script).toBe(
      scanScript({ manifestSha256: MANIFEST_HASH }),
    );
    expect(scanCall?.script).toContain(PATHS.baseManifest);
    expect(scanCall?.script).toContain(PATHS.vmPrepareInstalled);
    expect(fake.callsFor(STEPS.recordBaseManifest)).toHaveLength(1);
  });

  // #357-T17
  it("pins the manifest hash the record step printed, outside the VM, and has the scan check it", async () => {
    const fake = happyFake();
    const hash = "d".repeat(64);
    fake.onExec(STEPS.recordBaseManifest, {
      stdout: `MANIFEST_SHA256 ${hash}\n`,
    });
    await run(fake).result;
    const script = fake.callsFor(STEPS.scanFilesystem)[0]?.script ?? "";
    expect(script).toBe(scanScript({ manifestSha256: hash }));
    expect(script).toContain(`'${hash}'`);
    expect(script).toContain("sha256sum --check");
  });

  // #357-T17
  it.each([
    ["no output", ""],
    ["no hash", "recorded\n"],
    ["a short hash", `MANIFEST_SHA256 ${"a".repeat(63)}\n`],
    ["an upper case hash", `MANIFEST_SHA256 ${"A".repeat(64)}\n`],
    ["a hash with a suffix", `MANIFEST_SHA256 ${"a".repeat(64)} x\n`],
  ])(
    "fails closed when the record step prints %s: no snapshot, builder removed",
    async (_what, stdout) => {
      const fake = happyFake();
      fake.onExec(STEPS.recordBaseManifest, { stdout });
      const error = await failure(run(fake).result);
      expect(error.code).toBe("base_manifest_failed");
      expect(error.step).toBe(STEPS.recordBaseManifest);
      expect(fake.events.some((event) => event.startsWith("snapshot:"))).toBe(
        false,
      );
      expectNothingPublished(fake);
    },
  );

  // #357-T11
  it("fails closed when the base manifest cannot be recorded: no snapshot, builder removed", async () => {
    const fake = happyFake();
    fake.onExec(STEPS.recordBaseManifest, { exitCode: 44 });
    const error = await failure(run(fake).result);
    expect(error.code).toBe("base_manifest_failed");
    expect(error.step).toBe(STEPS.recordBaseManifest);
    expect(fake.callsFor(STEPS.installDocker)).toHaveLength(0);
    expect(fake.events.some((event) => event.startsWith("snapshot:"))).toBe(
      false,
    );
    expect(
      fake.vms.get("code-reviewer-golden-builder-20261015T180000Z")?.state,
    ).toBe("deleted");
    expectNothingPublished(fake);
  });

  it.each<[string, { exitCode: number }, SnapshotErrorCode]>([
    [STEPS.installDocker, { exitCode: 100 }, "docker_install_failed"],
    [STEPS.installDocker, { exitCode: 42 }, "docker_version_mismatch"],
    [STEPS.writeDaemonConfig, { exitCode: 1 }, "daemon_config_failed"],
    [STEPS.installHostScripts, { exitCode: 1 }, "host_prepare_failed"],
    [STEPS.startDaemon, { exitCode: 1 }, "host_prepare_failed"],
    [STEPS.buildImage, { exitCode: 1 }, "image_build_failed"],
    [STEPS.inspectImage, { exitCode: 1 }, "image_build_failed"],
  ])(
    "a failing %s (%j) ends in %s and removes the builder with its snapshots",
    async (label, answer, code) => {
      const fake = happyFake();
      fake.onExec(label, answer);
      const error = await failure(run(fake).result);
      expect(error.code).toBe(code);
      expect(
        fake.vms.get("code-reviewer-golden-builder-20261015T180000Z")?.state,
      ).toBe("deleted");
      expectNothingPublished(fake);
    },
  );

  it("keeps the tail of a failed build in the error, scrubbed of control characters and bounded", async () => {
    const fake = happyFake();
    const noise = `${"x".repeat(5000)}\u001b[31mred\u001b[0m\nERROR: failed to solve`;
    fake.onExec(STEPS.buildImage, { exitCode: 1, stderr: noise });
    const error = await failure(run(fake).result);
    const text = error.detail.join("\n");
    expect(text).toContain("failed to solve");
    expect(text).not.toContain("\u001b");
    expect(text.length).toBeLessThan(2100);
  });

  it("fails when the snapshot call fails", async () => {
    const fake = happyFake();
    fake.failNextSnapshot(new Error("quota"));
    const error = await failure(run(fake).result);
    expect(error.code).toBe("snapshot_failed");
    expect(
      fake.vms.get("code-reviewer-golden-builder-20261015T180000Z")?.state,
    ).toBe("deleted");
  });

  it("fails when the snapshot is not created", async () => {
    const fake = happyFake();
    fake.setNextSnapshotStatus("failed");
    const error = await failure(run(fake).result);
    expect(error.code).toBe("snapshot_failed");
    expectNothingPublished(fake);
  });

  it("fails when the snapshot is not in fra1: snapshots are region-bound", async () => {
    const fake = new FakeSandboxService({ snapshotRegions: ["iad1"] });
    fake.onExec(STEPS.recordBaseManifest, { stdout: MANIFEST_OK });
    fake.onExec(STEPS.inspectImage, { stdout: `${IMAGE_ID}\n` });
    const error = await failure(run(fake).result);
    expect(error.code).toBe("snapshot_region_mismatch");
    expectNothingPublished(fake);
  });

  it("fails when the builder cannot be created", async () => {
    const fake = happyFake();
    fake.failNextCreate(new Error("not allowed"));
    const error = await failure(run(fake).result);
    expect(error.code).toBe("builder_create_failed");
  });

  it("fails when the check VM cannot be created, and deletes the snapshot", async () => {
    const fake = happyFake();
    fake.onExec(STEPS.checkNoContainers, () => {
      // The builder is up; the next create is the check VM.
      fake.failNextCreate(new Error("capacity"));
      return { stdout: "" };
    });
    const error = await failure(run(fake).result);
    expect(error.code).toBe("check_vm_failed");
    expectNothingPublished(fake);
  });

  it("warns when the check VM cannot be deleted and still returns the record", async () => {
    const fake = happyFake();
    fake.failDestroyOf("code-reviewer-golden-check-20261015T180000Z");
    const { record, warnings } = await run(fake).result;
    expect(record.snapshotId).toBeTruthy();
    expect(warnings).toEqual(["check_vm_not_deleted"]);
  });

  describe("the final scan", () => {
    // #330-T06
    it("fails closed on a finding, deletes the snapshot and records nothing", async () => {
      const fake = happyFake();
      fake.onExec(STEPS.scanFilesystem, {
        stdout:
          "FINDING secret_file /home/ubuntu/.env\nFINDING job_data /var/lib/docker/containers/abc\nSCAN_DONE\n",
      });
      const error = await failure(run(fake).result);
      expect(error.code).toBe("scan_findings");
      expect(error.detail).toEqual([
        "secret_file /home/ubuntu/.env",
        "job_data /var/lib/docker/containers/abc",
      ]);
      expectNothingPublished(fake);
      expect(fake.callsFor(STEPS.probe)).toHaveLength(0);
    });

    // #330-T06
    it.each([
      "",
      "garbage\n",
      "FINDING nothing\n",
      "SCAN_DONE\nFINDING secret_file /home/ubuntu/.env\n",
    ])("fails closed on output without the end marker (%j)", async (stdout) => {
      const fake = happyFake();
      fake.onExec(STEPS.scanFilesystem, { stdout });
      const error = await failure(run(fake).result);
      expect(error.code).toBe("scan_unreadable");
      expectNothingPublished(fake);
    });

    it("fails closed when the scan itself fails", async () => {
      const fake = happyFake();
      fake.onExec(STEPS.scanFilesystem, { exitCode: 2, stdout: "SCAN_DONE\n" });
      const error = await failure(run(fake).result);
      expect(error.code).toBe("scan_unreadable");
      expectNothingPublished(fake);
    });
  });

  describe("the self-check probe of the restored snapshot", () => {
    it("runs after the scan and the digest check, in the check VM", async () => {
      const fake = happyFake();
      await run(fake).result;
      const probe = fake.callsFor(STEPS.probe)[0];
      expect(probe?.vm).toBe("code-reviewer-golden-check-20261015T180000Z");
      expect(probe?.sudo).toBe(true);
      expect(probe?.script).toContain("'net.ipv6.conf.all.disable_ipv6=1'");
    });

    // #330-extra-probe
    it("never publishes a snapshot whose Dynamic self-check does not advertise opencode", async () => {
      const fake = happyFake();
      fake.onExec(STEPS.probe, {
        stdout:
          '{"version":1,"engines":["pr-agent"],"reasons":["network_rules_not_installed"]}\n',
      });
      const error = await failure(run(fake).result);
      expect(error.code).toBe("engine_missing");
      expect(error.detail).toEqual(["opencode", "network_rules_not_installed"]);
      expectNothingPublished(fake);
      expect(
        fake.vms.get("code-reviewer-golden-builder-20261015T180000Z")?.state,
      ).toBe("deleted");
    });

    // #330-extra-probe
    it("keeps only stable reason codes from a verdict, so a value in it never reaches the error", async () => {
      const fake = happyFake();
      // Joined at run time: the tracked-secrets check rejects a token-shaped literal in the source.
      const looksLikeAKey = ["sk", "or", "v1", "0123456789abcdef0123"].join(
        "-",
      );
      fake.onExec(STEPS.probe, {
        stdout: `{"version":1,"engines":["pr-agent"],"reasons":["${looksLikeAKey}","root_filesystem_writable"]}\n`,
      });
      const error = await failure(run(fake).result);
      expect(error.code).toBe("engine_missing");
      expect(error.detail.join(" ")).not.toContain("sk-or-v1");
      expect(error.detail).toContain("root_filesystem_writable");
    });

    // #330-extra-probe
    it.each([
      ["not JSON", "hello\n"],
      ["no output", ""],
      [
        "another version",
        '{"version":2,"engines":["opencode"],"reasons":[]}\n',
      ],
      [
        "an unknown key",
        '{"version":1,"engines":["pr-agent","opencode"],"reasons":[],"env":{"A":"b"}}\n',
      ],
      [
        "engines of the wrong type",
        '{"version":1,"engines":"opencode","reasons":[]}\n',
      ],
    ])("fails closed on a verdict that is %s", async (_name, stdout) => {
      const fake = happyFake();
      fake.onExec(STEPS.probe, { stdout });
      const error = await failure(run(fake).result);
      expect(error.code).toBe("probe_unreadable");
      expectNothingPublished(fake);
    });

    // #330-extra-probe
    it("reads the verdict from the last line, so log lines before it do not matter", async () => {
      const fake = happyFake();
      fake.onExec(STEPS.probe, { stdout: `some log line\n${PROBE_OK}` });
      await expect(run(fake).result).resolves.toBeDefined();
    });

    it("fails when the probe command fails or times out", async () => {
      const fake = happyFake();
      fake.onExec(STEPS.probe, { exitCode: 124, stdout: PROBE_OK });
      const error = await failure(run(fake).result);
      expect(error.code).toBe("probe_failed");
      expectNothingPublished(fake);
    });

    // #330-extra-probe
    it("requires only the engines the configuration names", async () => {
      const fake = happyFake();
      fake.onExec(STEPS.probe, {
        stdout: '{"version":1,"engines":["pr-agent"],"reasons":[]}\n',
      });
      const input = testInput({
        config: testConfig({ requiredEngines: ["pr-agent"] }),
      });
      await expect(run(fake, input).result).resolves.toBeDefined();
    });

    it("fails when vm-prepare does not bring the daemon up in the restored VM", async () => {
      const fake = happyFake();
      fake.onExec(STEPS.startDaemonCheck, { exitCode: 1 });
      const error = await failure(run(fake).result);
      expect(error.code).toBe("host_prepare_failed");
      expectNothingPublished(fake);
    });
  });

  describe("after a failure", () => {
    it("deletes the check VM too", async () => {
      const fake = happyFake();
      fake.onExec(STEPS.probe, { exitCode: 1 });
      await failure(run(fake).result);
      expect(
        fake.vms.get("code-reviewer-golden-check-20261015T180000Z")?.state,
      ).toBe("deleted");
    });

    it("names what it could not remove", async () => {
      const fake = happyFake();
      fake.onExec(STEPS.probe, { exitCode: 1 });
      fake.failDestroyOf("code-reviewer-golden-builder-20261015T180000Z");
      const error = await failure(run(fake).result);
      expect(error.code).toBe("probe_failed");
      expect(error.cleanupFailures).toEqual([
        "code-reviewer-golden-builder-20261015T180000Z",
      ]);
    });
  });

  // Sysbox is for the Implementer only (plan implementer-sandbox, step 2). The snapshot is shared by every kind of job, so
  // nothing Sysbox does may stop it: reviews must keep getting their snapshot, as #797 asks of the Implementer's proof.
  describe("Sysbox, which never holds back the snapshot", () => {
    const BUILDER = "code-reviewer-golden-builder-20261015T180000Z";
    const CHECK = "code-reviewer-golden-check-20261015T180000Z";

    it("installs it in the builder before the daemon configuration is written over the package's edit, and puts both host scripts in the snapshot", async () => {
      const fake = happyFake();
      await run(fake).result;

      const events = fake.events;
      expect(events.indexOf(`exec:${STEPS.installSysbox}`)).toBeGreaterThan(
        events.indexOf(`exec:${STEPS.installDocker}`),
      );
      expect(events.indexOf(`exec:${STEPS.installSysbox}`)).toBeLessThan(
        events.indexOf(`write:${PATHS.daemonJson}`),
      );
      const install = fake.callsFor(STEPS.installSysbox)[0];
      expect(install?.vm).toBe(BUILDER);
      expect(install?.sudo).toBe(true);
      expect(fake.vms.get(BUILDER)?.files.get(PATHS.sysboxPrepare)).toBe(
        SYSBOX_PREPARE_TEXT,
      );
      expect(fake.vms.get(BUILDER)?.files.get(PATHS.vmPrepare)).toBe(
        VM_PREPARE_TEXT,
      );
    });

    it("proves it in the check VM after the Worker's own self-check and records it as proven", async () => {
      const fake = happyFake();
      const { record, warnings } = await run(fake).result;

      const proof = fake.callsFor(STEPS.sysboxProbe)[0];
      expect(proof?.vm).toBe(CHECK);
      expect(proof?.sudo).toBe(true);
      expect(fake.events.indexOf(`exec:${STEPS.sysboxProbe}`)).toBeGreaterThan(
        fake.events.indexOf(`exec:${STEPS.probe}`),
      );
      expect(record.sysbox).toBe("proven");
      expect(warnings).toEqual([]);
    });

    it("records the snapshot as unproven and warns, but still returns it, when the install fails", async () => {
      const fake = happyFake();
      fake.onExec(STEPS.installSysbox, {
        exitCode: 41,
        stderr: "the Sysbox package is not the pinned one\n",
      });
      const { result, lines } = run(fake);
      const { record, warnings } = await result;

      expect(record.sysbox).toBe("unproven");
      expect(warnings).toEqual(["sysbox_install_failed"]);
      expect(fake.liveSnapshotIds()).toEqual([record.snapshotId]);
      // Nothing to prove: the check VM does not run the proof of a package that is not there.
      expect(fake.callsFor(STEPS.sysboxProbe)).toHaveLength(0);
      const warning = lines.find((line) =>
        line.includes('"event":"sysbox_install_failed"'),
      );
      expect(warning).toContain("exit 41");
      expect(warning).toContain("is not the pinned one");
    });

    it("records the snapshot as unproven and names the reasons when the proof finds a problem", async () => {
      const fake = happyFake();
      fake.onExec(STEPS.sysboxProbe, {
        stdout:
          "SYSBOX_PROBE ok boot\nSYSBOX_PROBE fail sysbox_inner_docker_failed\nSYSBOX_PROBE_DONE\n",
      });
      const { result, lines } = run(fake);
      const { record, warnings } = await result;

      expect(record.sysbox).toBe("unproven");
      expect(warnings).toEqual(["sysbox_probe_failed"]);
      expect(fake.liveSnapshotIds()).toEqual([record.snapshotId]);
      expect(
        lines.find((line) => line.includes('"event":"sysbox_probe_failed"')),
      ).toContain("sysbox_inner_docker_failed");
    });

    it.each([
      ["a proof that leaks", "SYSBOX_PROBE fail sysbox_network_not_isolated"],
      [
        "a proof that could not pull its image",
        "SYSBOX_PROBE fail sysbox_probe_image_unavailable",
      ],
      ["a boot step that failed", "SYSBOX_PROBE fail sysbox_mgr_not_ready"],
    ])("does not take %s for a pass", async (_name, line) => {
      const fake = happyFake();
      fake.onExec(STEPS.sysboxProbe, {
        stdout: `${line}\nSYSBOX_PROBE_DONE\n`,
      });
      const { record } = await run(fake).result;
      expect(record.sysbox).toBe("unproven");
    });

    it("does not take a proof that did not finish for a pass", async () => {
      const fake = happyFake();
      fake.onExec(STEPS.sysboxProbe, { stdout: "SYSBOX_PROBE ok boot\n" });
      const { record, warnings } = await run(fake).result;
      expect(record.sysbox).toBe("unproven");
      expect(warnings).toEqual(["sysbox_probe_failed"]);
    });

    it("warns, and does not fail, when the proof command itself fails", async () => {
      const fake = happyFake();
      fake.onExec(STEPS.sysboxProbe, { exitCode: 124 });
      const { record, warnings } = await run(fake).result;
      expect(record.sysbox).toBe("unproven");
      expect(warnings).toEqual(["sysbox_probe_failed"]);
    });

    it("still ends the run when it is cancelled during the Sysbox install", async () => {
      const fake = happyFake();
      const abort = new AbortController();
      fake.onExec(STEPS.installSysbox, () => {
        abort.abort();
        throw new Error("The operation was aborted");
      });
      const error = await failure(
        run(fake, testInput(), { signal: abort.signal }).result,
      );
      expect(error.code).toBe("cancelled");
      expect(fake.vms.get(BUILDER)?.state).toBe("deleted");
    });

    it("leaves the Worker's own proof as strict as it was: a Sysbox that works does not excuse a missing engine", async () => {
      const fake = happyFake();
      fake.onExec(STEPS.probe, {
        stdout: '{"version":1,"engines":["pr-agent"],"reasons":[]}\n',
      });
      const error = await failure(run(fake).result);
      expect(error.code).toBe("engine_missing");
      expectNothingPublished(fake);
    });
  });

  it("stops at the next step when the signal aborts, and cleans up", async () => {
    const fake = happyFake();
    const abort = new AbortController();
    fake.onExec(STEPS.buildImage, () => {
      abort.abort();
      return {};
    });
    const error = await failure(
      run(fake, testInput(), { signal: abort.signal }).result,
    );
    expect(error.code).toBe("cancelled");
    expect(fake.callsFor(STEPS.inspectImage)).toHaveLength(0);
    expect(
      fake.vms.get("code-reviewer-golden-builder-20261015T180000Z")?.state,
    ).toBe("deleted");
  });

  it("reports cancelled, not the step's code, when the abort ends a command with an error", async () => {
    const fake = happyFake();
    const abort = new AbortController();
    fake.onExec(STEPS.buildImage, () => {
      abort.abort();
      throw new Error("The operation was aborted");
    });
    const error = await failure(
      run(fake, testInput(), { signal: abort.signal }).result,
    );
    expect(error.code).toBe("cancelled");
    expect(error.step).toBe(STEPS.buildImage);
    expect(
      fake.vms.get("code-reviewer-golden-builder-20261015T180000Z")?.state,
    ).toBe("deleted");
  });

  it("turns a failure of the pipeline's own code into a stable code, and still cleans up", async () => {
    const fake = happyFake();
    const logger = {
      info: (event: string, fields?: Record<string, unknown>) => {
        if (
          fields?.step === STEPS.cleanBuilder &&
          fields.exitCode !== undefined
        )
          throw new Error("logger broke");
      },
      warn: () => {},
      error: () => {},
    };
    const error = await failure(
      runPipeline({ service: fake, logger, clock: () => NOW }, testInput()),
    );
    expect(error.code).toBe("unexpected_error");
    expect(error.message).not.toContain("logger broke");
    expect(
      fake.vms.get("code-reviewer-golden-builder-20261015T180000Z")?.state,
    ).toBe("deleted");
  });

  it("does not start when the signal is already aborted", async () => {
    const fake = happyFake();
    const abort = new AbortController();
    abort.abort();
    const error = await failure(
      run(fake, testInput(), { signal: abort.signal }).result,
    );
    expect(error.code).toBe("cancelled");
    expect(fake.events).toEqual([]);
  });
});

describe("retention in the pipeline", () => {
  // #330-T05
  it("deletes the older builders after the new snapshot passed, keeping the current and one previous", async () => {
    const fake = happyFake();
    const s1 = fake.seedBuilder(
      "code-reviewer-golden-builder-20260101T000000Z",
      1,
    );
    const s2 = fake.seedBuilder(
      "code-reviewer-golden-builder-20260201T000000Z",
      2,
    );
    const s3 = fake.seedBuilder(
      "code-reviewer-golden-builder-20260301T000000Z",
      3,
    );
    const { record, warnings } = await run(fake).result;
    expect(warnings).toEqual([]);
    const live = fake.liveSnapshotIds();
    // The new one (newest by the clock of the fake) and the newest older one stay.
    expect(live).toContain(record.snapshotId);
    expect(live).toHaveLength(2);
    expect(live).not.toContain(s1);
    expect(live).not.toContain(s2);
    expect(
      fake.vms.get("code-reviewer-golden-builder-20260301T000000Z")?.state,
    ).toBe("stopped");
    expect(s3).toBeDefined();
  });

  // #330-T05
  it("keeps a pinned snapshot, the one in use, when a newer build failed its canary", async () => {
    const fake = happyFake();
    const old = fake.seedBuilder(
      "code-reviewer-golden-builder-20260101T000000Z",
      1,
    );
    fake.seedBuilder("code-reviewer-golden-builder-20260201T000000Z", 2);
    fake.seedBuilder("code-reviewer-golden-builder-20260301T000000Z", 3);
    const input = testInput({
      config: testConfig({ pinnedSnapshotIds: [old ?? "none"] }),
    });
    const { record } = await run(fake, input).result;
    const live = fake.liveSnapshotIds();
    expect(live).toContain(old);
    expect(live).toContain(record.snapshotId);
  });

  // #330-T05
  it("does not touch the previous snapshots when the new one fails", async () => {
    const fake = happyFake();
    const s1 = fake.seedBuilder(
      "code-reviewer-golden-builder-20260101T000000Z",
      1,
    );
    const s2 = fake.seedBuilder(
      "code-reviewer-golden-builder-20260201T000000Z",
      2,
    );
    const s3 = fake.seedBuilder(
      "code-reviewer-golden-builder-20260301T000000Z",
      3,
    );
    fake.onExec(STEPS.probe, { exitCode: 1 });
    await failure(run(fake).result);
    expect(fake.liveSnapshotIds().sort()).toEqual([s1, s2, s3].sort());
  });

  it("reports a failed retention as a warning and still returns the record", async () => {
    const fake = happyFake();
    fake.seedBuilder("code-reviewer-golden-builder-20260101T000000Z", 1);
    fake.seedBuilder("code-reviewer-golden-builder-20260201T000000Z", 2);
    fake.seedBuilder("code-reviewer-golden-builder-20260301T000000Z", 3);
    fake.failDestroyOf("code-reviewer-golden-builder-20260101T000000Z");
    const { record, warnings } = await run(fake).result;
    expect(record.snapshotId).toBeTruthy();
    expect(warnings).toEqual(["retention_failed"]);
  });

  // #365-T05
  it("reports a listing that fails as a warning, deletes nothing and still returns the record", async () => {
    // What the platform's 400 on a name prefix without the name sort looked like to the pipeline.
    class RefusingList extends FakeSandboxService {
      override async listBuilders(): Promise<never> {
        throw new Error("Status code 400 is not ok");
      }
    }
    const fake = new RefusingList();
    fake.onExec(STEPS.recordBaseManifest, { stdout: MANIFEST_OK });
    fake.onExec(STEPS.inspectImage, { stdout: `${IMAGE_ID}\n` });
    fake.onExec(STEPS.checkNoContainers, { stdout: "" });
    fake.onExec(STEPS.scanFilesystem, { stdout: "SCAN_DONE\n" });
    fake.onExec(STEPS.inspectRestoredImage, { stdout: `${IMAGE_ID}\n` });
    fake.onExec(STEPS.probe, { stdout: PROBE_OK });
    fake.onExec(STEPS.sysboxProbe, { stdout: SYSBOX_PROBE_OK });
    const old = fake.seedBuilder(
      "code-reviewer-golden-builder-20260101T000000Z",
      1,
    );
    fake.seedBuilder("code-reviewer-golden-builder-20260201T000000Z", 2);
    fake.seedBuilder("code-reviewer-golden-builder-20260301T000000Z", 3);
    const { record, warnings } = await run(fake).result;
    expect(record.snapshotId).toBeTruthy();
    expect(warnings).toEqual(["retention_failed"]);
    // Nothing was removed: the seeded builders and their snapshots, and the new one, are all still there.
    expect(fake.liveSnapshotIds()).toHaveLength(4);
    expect(fake.liveSnapshotIds()).toContain(old);
    expect(
      fake.events.filter((event) =>
        event.startsWith("destroy:code-reviewer-golden-builder-"),
      ),
    ).toEqual([]);
  });

  it("reports a builder with an unknown snapshot as a warning and leaves it alone", async () => {
    const fake = happyFake();
    fake.seedBuilder("code-reviewer-golden-builder-20260101T000000Z", 1, false);
    const { warnings } = await run(fake).result;
    expect(warnings).toEqual(["builder_without_snapshot"]);
    expect(
      fake.vms.get("code-reviewer-golden-builder-20260101T000000Z")?.state,
    ).toBe("stopped");
  });
});
