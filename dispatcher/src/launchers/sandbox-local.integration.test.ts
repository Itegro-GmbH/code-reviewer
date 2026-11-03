// SPDX-License-Identifier: LicenseRef-Proprietary

// The Sandbox-Launcher against the local mode of the Sandbox double (fakes/sandbox/local.ts) with a stand-in
// `docker` executable: real processes, real pipes, a real temporary directory per "VM". No Docker daemon is needed;
// the same flow against a real daemon and the real image is sandbox-local.privileged.test.ts.
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSandboxService } from "../../../fakes/sandbox/local.ts";
import { LaunchError, type LaunchSpec } from "../core/types.ts";
import { recordingLogger } from "../test-support/harness.ts";
import {
  ENTRY_MODE_WORKER_ONCE,
  renderDockerRunArguments,
} from "./container.ts";
import {
  IMPLEMENTER_CONTAINER_SPEC,
  SANDBOX_LAUNCHER_ADDITIONS,
  WORKER_CONTAINER_SPEC,
} from "./container-spec.ts";
import { createSandboxLauncher } from "./sandbox.ts";

const FAKE_DOCKER = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "fakes",
  "sandbox",
  "bin",
  "fake-docker.sh",
);
const IMAGE_ID = `sha256:${"e".repeat(64)}`;
const JOB_A = "00000000-0000-4000-8000-0000000000aa";
const JOB_B = "00000000-0000-4000-8000-0000000000bb";
const CREDENTIAL_A = "crj_dummy-credential-for-job-A-0123456789abcdef";
const CREDENTIAL_B = "crj_dummy-credential-for-job-B-0123456789abcdef";

let records: string;
let vms: string;
let local: LocalSandboxService | undefined;

beforeEach(async () => {
  records = await mkdtemp(join(tmpdir(), "cr-records-"));
  vms = await mkdtemp(join(tmpdir(), "cr-vms-"));
});
afterEach(async () => {
  await local?.stopAll();
  local = undefined;
  await rm(records, { recursive: true, force: true });
  await rm(vms, { recursive: true, force: true });
});

function launcher(runSeconds: number, exitCode = 0) {
  local = new LocalSandboxService({
    dockerBin: FAKE_DOCKER,
    root: vms,
    environment: {
      FAKE_DOCKER_DIR: records,
      FAKE_DOCKER_IMAGE_ID: IMAGE_ID,
      FAKE_DOCKER_RUN_SECONDS: String(runSeconds),
      FAKE_DOCKER_EXIT: String(exitCode),
    },
  });
  const logger = recordingLogger();
  return {
    local,
    logger,
    launcher: createSandboxLauncher({
      service: local,
      snapshotId: "snap_dummy_golden_0001",
      imageDigest: IMAGE_ID,
      logger,
      handoverSeconds: 1,
    }),
  };
}

function spec(jobId: string, credential: string): LaunchSpec {
  return {
    appId: "reviewer",
    appUrl: "http://127.0.0.1:9",
    jobId,
    credential,
    kind: "diff",
    timeoutSeconds: 1200,
    config: {},
  };
}

async function recorded(suffix: string): Promise<string[]> {
  const names = (await readdir(records)).filter((name) =>
    name.endsWith(suffix),
  );
  return Promise.all(
    names.map((name) => readFile(join(records, name), "utf8")),
  );
}

describe("the Sandbox-Launcher in local mode", () => {
  // #329-T09
  it("runs the rendered docker run in a VM directory and delivers the start document on the pipe", async () => {
    const { launcher: sandbox, local: service } = launcher(2);

    await sandbox.launch(
      spec(JOB_A, CREDENTIAL_A),
      new AbortController().signal,
    );

    const [args] = await recorded(".args");
    expect(args?.trimEnd().split("\n")).toStrictEqual(
      renderDockerRunArguments(WORKER_CONTAINER_SPEC, {
        image: IMAGE_ID,
        name: `code-reviewer-worker-${JOB_A}`,
        environment: {
          HOME: "/home/runner",
          RUNNER_DIFF_JOB_USER: "10001:10001",
          RUNNER_JOB_TIMEOUT_SECONDS: "1200",
        },
        command: [ENTRY_MODE_WORKER_ONCE],
        overrides: {
          memory: { limit: "1536m", reservation: "1280m" },
        },
        additions: SANDBOX_LAUNCHER_ADDITIONS,
      }),
    );
    const [stdin] = await recorded(".stdin");
    expect(JSON.parse(stdin ?? "")).toStrictEqual({
      appUrl: "http://127.0.0.1:9",
      jobId: JOB_A,
      credential: CREDENTIAL_A,
    });
    // The command ran in the VM's own directory.
    const [cwd] = await recorded(".cwd");
    expect(cwd?.trim()).toContain(
      service.directories.get(service.created[0] ?? "") ?? "?",
    );
  });

  // #760-T06
  it("runs an implementer job with the profile: the work volume is made in the VM, then the container with the volume mounted", async () => {
    const { launcher: sandbox, local: service } = launcher(2);

    await sandbox.launch(
      { ...spec(JOB_A, CREDENTIAL_A), kind: "implementer" },
      new AbortController().signal,
    );

    const [args] = await recorded(".args");
    expect(args?.trimEnd().split("\n")).toStrictEqual(
      renderDockerRunArguments(IMPLEMENTER_CONTAINER_SPEC, {
        image: IMAGE_ID,
        name: `code-reviewer-worker-${JOB_A}`,
        workVolume: `code-reviewer-work-${JOB_A}`,
        environment: {
          HOME: "/home/runner",
          RUNNER_DIFF_JOB_USER: "10001:10001",
          RUNNER_IMPLEMENTER_AGENT_MEMORY_MB: "2048",
          RUNNER_IMPLEMENTER_MODEL_DOOR: "docker",
          RUNNER_IMPLEMENTER_SANDBOX_PROOF: "unproven",
          RUNNER_IMPLEMENTER_WORK_DIR: "/work",
          RUNNER_JOB_TIMEOUT_SECONDS: "1200",
        },
        command: [ENTRY_MODE_WORKER_ONCE],
        overrides: { memory: { limit: "768m", reservation: "512m" } },
        additions: SANDBOX_LAUNCHER_ADDITIONS,
      }),
    );
    // The daemon's client was asked for the volume before the container ran.
    expect(await readFile(join(records, "commands.log"), "utf8")).toContain(
      `volume create --driver local --opt type=none --opt device=/var/lib/code-reviewer-work/code-reviewer-work-${JOB_A} --opt o=rbind code-reviewer-work-${JOB_A}`,
    );
    // Local mode has no mounts of its own: the host steps succeed without a trace in the "VM" directory.
    expect(
      await readdir(service.directories.get(service.created[0] ?? "") ?? ""),
    ).toStrictEqual([]);
  });

  // #329-T02
  it("keeps the credential out of the argument list, the environment and the files of the VM", async () => {
    const { launcher: sandbox, local: service } = launcher(2);

    await sandbox.launch(
      spec(JOB_A, CREDENTIAL_A),
      new AbortController().signal,
    );

    const dir = service.directories.get(service.created[0] ?? "") ?? "";
    // While the job runs the "VM" holds no file at all.
    expect(await readdir(dir)).toStrictEqual([]);
    for (const suffix of [".args", ".env"])
      for (const text of await recorded(suffix))
        expect(text).not.toContain(CREDENTIAL_A);
    expect((await recorded(".stdin")).join("")).toContain(CREDENTIAL_A);
  });

  // #329-T07, #487-T01
  it("removes the VM directory and the container when the VM is stopped by name (the App's stop call does this)", async () => {
    const { launcher: sandbox, local: service } = launcher(2);

    await sandbox.launch(
      spec(JOB_A, CREDENTIAL_A),
      new AbortController().signal,
    );
    const dir = service.directories.get(service.created[0] ?? "") ?? "";
    expect(existsSync(dir)).toBe(true);
    // Nothing in the Launcher ends the VM after the hand-over (#487): the Dispatcher stops it on the App's signal.
    expect(service.running()).toStrictEqual(service.created);
    await service.stop(service.created[0] ?? "");

    expect(existsSync(dir)).toBe(false);
    expect(service.running()).toStrictEqual([]);
    expect(await readFile(join(records, "commands.log"), "utf8")).toContain(
      `rm --force code-reviewer-worker-${JOB_A}`,
    );
  });

  // #329-T10
  it("shows nothing of job A to job B when two jobs run in a row", async () => {
    const { launcher: sandbox, local: service } = launcher(2);

    await sandbox.launch(
      spec(JOB_A, CREDENTIAL_A),
      new AbortController().signal,
    );
    await service.stop(service.created[0] ?? "");
    await rm(join(records, "commands.log"), { force: true });
    for (const name of await readdir(records))
      if (name.startsWith("run-")) await rm(join(records, name));
    await sandbox.launch(
      spec(JOB_B, CREDENTIAL_B),
      new AbortController().signal,
    );

    const [first, second] = service.created;
    const [dirA, dirB] = [first, second].map(
      (name) => service.directories.get(name ?? "") ?? "",
    );
    expect(dirA).not.toBe(dirB);
    expect(existsSync(dirA ?? "")).toBe(false);
    expect(await readdir(dirB ?? "")).toStrictEqual([]);
    // What B's container client was given holds nothing of A.
    for (const suffix of [".args", ".env", ".stdin", ".cwd"])
      for (const text of await recorded(suffix)) {
        expect(text).not.toContain(CREDENTIAL_A);
        expect(text).not.toContain(JOB_A);
        expect(text).not.toContain(dirA ?? "?");
      }
  });

  // #329-T07
  it("fails the launch and removes the VM when the container ends with an error", async () => {
    const { launcher: sandbox, local: service } = launcher(0, 2);

    const error = await sandbox
      .launch(spec(JOB_A, CREDENTIAL_A), new AbortController().signal)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(LaunchError);
    expect((error as LaunchError).code).toBe("worker_exited_early");
    expect(
      existsSync(service.directories.get(service.created[0] ?? "") ?? ""),
    ).toBe(false);
  });

  // #329-T08
  it("kills the container and removes the VM when the launch is aborted", async () => {
    const { launcher: sandbox, local: service } = launcher(30);
    const stop = new AbortController();
    const ended = sandbox
      .launch(spec(JOB_A, CREDENTIAL_A), stop.signal)
      .catch((thrown: unknown) => thrown);
    await new Promise((resolve) => setTimeout(resolve, 300));

    stop.abort();
    const error = await ended;

    expect((error as LaunchError).code).toBe("launch_aborted");
    const log = await readFile(join(records, "commands.log"), "utf8");
    expect(log).toContain(`kill code-reviewer-worker-${JOB_A}`);
    expect(log).toContain(`rm --force code-reviewer-worker-${JOB_A}`);
    expect(service.running()).toStrictEqual([]);
    expect(
      existsSync(service.directories.get(service.created[0] ?? "") ?? ""),
    ).toBe(false);
  });

  // #329-T06
  it("refuses the VM when the image id is not the configured one", async () => {
    const { local: service, logger } = launcher(0);
    const sandbox = createSandboxLauncher({
      service,
      snapshotId: "snap_dummy_golden_0001",
      imageDigest: `sha256:${"f".repeat(64)}`,
      logger,
      handoverSeconds: 1,
    });

    const error = await sandbox
      .launch(spec(JOB_A, CREDENTIAL_A), new AbortController().signal)
      .catch((thrown: unknown) => thrown);

    expect((error as LaunchError).code).toBe("image_mismatch");
    expect(await recorded(".args")).toStrictEqual([]);
    expect(service.running()).toStrictEqual([]);
  });

  // #487-T09
  it("lists the VMs it created, with the tags and the status the platform would report, and stops one by name", async () => {
    const { launcher: sandbox, local: service } = launcher(2);
    await sandbox.launch(
      { ...spec(JOB_A, CREDENTIAL_A), kind: "dynamic" },
      new AbortController().signal,
    );
    const name = service.created[0] ?? "";

    const before = await service.list({
      namePrefix: "cr-dynamic-",
      tags: { app: "code-reviewer" },
    });
    await service.stop(name);
    const after = await service.list({
      namePrefix: "cr-dynamic-",
      tags: { app: "code-reviewer" },
    });

    expect(before).toMatchObject([
      {
        name,
        status: "running",
        persistent: false,
        tags: { app: "code-reviewer", kind: "dynamic", job: JOB_A },
      },
    ]);
    expect(after).toMatchObject([{ name, status: "stopped" }]);
    expect(
      await service.list({ namePrefix: "cr-diff-", tags: {} }),
    ).toStrictEqual([]);
  });

  // #802-T10
  it("deletes a VM by name: it is stopped and no longer listed, and deleting it again is not an error", async () => {
    const { launcher: sandbox, local: service } = launcher(2);
    await sandbox.launch(
      { ...spec(JOB_A, CREDENTIAL_A), kind: "dynamic" },
      new AbortController().signal,
    );
    const name = service.created[0] ?? "";

    await service.delete(name);
    await service.delete(name);

    expect(service.running()).toStrictEqual([]);
    expect(await service.list({ namePrefix: "cr-", tags: {} })).toStrictEqual(
      [],
    );
  });
});
