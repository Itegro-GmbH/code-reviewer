// SPDX-License-Identifier: LicenseRef-Proprietary

// The privileged lane of the Sandbox-Launcher (#329-T09, T10): the local mode of the Sandbox double with a REAL Docker
// daemon and the REAL Worker image, against the fake App. It needs a daemon the user may use and an image built from
// the `sandbox` target (docker build --file runner/Dockerfile --target sandbox); it fails, naming the missing item,
// and never skips. `make test-sandbox-local` runs it, and the CI job `sandbox-local` does for pull requests that touch
// the Dispatcher or the runner.
//
//   SANDBOX_LOCAL_IMAGE      the image reference built locally (required)
//   SANDBOX_LOCAL_APP_HOST   where a container reaches this machine; the docker0 gateway 172.17.0.1 by default.
//                            The network guard of the test must allow it (TEST_ALLOWED_HOSTS); the make target does.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startDispatcherAppFake } from "../../../fakes/dispatcher-app/server.ts";
import type { DispatcherAppFake } from "../../../fakes/dispatcher-app/server.ts";
import { LocalSandboxService } from "../../../fakes/sandbox/local.ts";
import { createDispatcherCore } from "../core/dispatcher.ts";
import {
  DISPATCHER_TOKEN,
  recordingLogger,
  settingsFor,
  waitFor,
} from "../test-support/harness.ts";
import { systemClock } from "../core/clock.ts";
import { createCapabilityProbe } from "../probe/capability-probe.ts";
import { createSandboxCanary } from "./sandbox-canary.ts";
import { createSandboxLauncher } from "./sandbox.ts";

const IMAGE = process.env.SANDBOX_LOCAL_IMAGE;
const APP_HOST = process.env.SANDBOX_LOCAL_APP_HOST ?? "172.17.0.1";
const WORKER_RESULT_TIMEOUT_MS = 180_000;

function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8" });
}

let app: DispatcherAppFake;
let work: string | undefined;
let service: LocalSandboxService | undefined;

function workDirectory(): string {
  if (work === undefined)
    throw new Error("The work directory is not made yet.");
  return work;
}

beforeEach(async () => {
  if (IMAGE === undefined || IMAGE === "")
    throw new Error(
      "SANDBOX_LOCAL_IMAGE is not set: build the image (docker build --file runner/Dockerfile --target sandbox --tag code-reviewer-worker:local .) and name it",
    );
  try {
    docker("version", "--format", "{{.Server.Version}}");
  } catch {
    throw new Error("There is no Docker daemon this user may use.");
  }
  work = await mkdtemp(join(tmpdir(), "cr-privileged-"));
  app = await startDispatcherAppFake({
    host: "0.0.0.0",
    dispatcherToken: DISPATCHER_TOKEN,
  });
});
afterEach(async () => {
  await service?.stopAll();
  service = undefined;
  await app?.close();
  if (work !== undefined) await rm(work, { recursive: true, force: true });
});

/** Runs a logged `docker run` line again and says how it ended, for the message of a test that failed (CI only). */
function diagnose(line: string): string {
  try {
    const out = execFileSync("docker", line.split(" "), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return `again: exit 0, stdout ${out.slice(0, 600)}`;
  } catch (error) {
    const failed = error as { status?: number; stderr?: string };
    return `again: exit ${String(failed.status)}, stderr ${(failed.stderr ?? "").slice(0, 1200)}`;
  }
}

/** A `docker` that logs its arguments and runs the real one, so the test can read the flags that were used. */
async function loggingDocker(): Promise<{ bin: string; log: string }> {
  const bin = join(workDirectory(), "docker-logged.sh");
  const log = join(workDirectory(), "docker-args.log");
  await writeFile(
    bin,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${log}'\nexec docker "$@"\n`,
  );
  await chmod(bin, 0o755);
  return { bin, log };
}

function build(bin: string) {
  const imageId = docker(
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    IMAGE ?? "",
  ).trim();
  service = new LocalSandboxService({ dockerBin: bin, root: workDirectory() });
  const logger = recordingLogger();
  const port = new URL(app.url).port;
  const launcher = createSandboxLauncher({
    service,
    snapshotId: "snap_local_mode",
    imageDigest: imageId,
    imageReference: IMAGE ?? "",
    logger,
    handoverSeconds: 5,
  });
  const core = createDispatcherCore({
    settings: settingsFor(`http://${APP_HOST}:${port}`, {
      engines: ["pr-agent"],
      jobTimeoutSeconds: 120,
    }),
    launcher,
    logger,
  });
  return { core, launcher, logger };
}

async function runJob(core: ReturnType<typeof build>["core"]): Promise<string> {
  const jobId = app.enqueue({ reviewKind: "diff" });
  const handled = await core.handle({
    appId: "reviewer",
    jobId,
    reviewKind: "diff",
  });
  expect(handled.outcome).toBe("started");
  if (handled.outcome === "started") await handled.background;
  await waitFor(
    () => app.results(jobId).length > 0,
    "the Worker's result",
    WORKER_RESULT_TIMEOUT_MS,
  );
  // Nothing in the Launcher ends the VM after the hand-over (#487): the App's stop call does, here the test.
  await service?.stopAll();
  return jobId;
}

describe("the Sandbox-Launcher in local mode with a real Docker daemon", () => {
  // #329-T09
  it("runs the Worker container with the rendered flags and the Worker delivers a result to the fake App", async () => {
    const { bin, log } = await loggingDocker();
    const { core, logger } = build(bin);

    const jobId = await runJob(core);

    const used = await readFile(log, "utf8");
    for (const flag of [
      "--cap-drop ALL",
      "--security-opt no-new-privileges:true",
      "--read-only",
      "--sysctl net.ipv6.conf.all.disable_ipv6=1",
      "--memory 1536m",
      "--pids-limit 512",
    ])
      expect(used).toContain(flag);
    expect(used).not.toContain("--privileged");
    expect(used).not.toContain("--volume");
    expect(app.results(jobId).length).toBeGreaterThan(0);
    expect(logger.text()).not.toContain("crj_");
  });

  // #329-T10
  it("leaves nothing of job A for job B: no container, no VM directory", async () => {
    const { bin } = await loggingDocker();
    const { core } = build(bin);

    const jobA = await runJob(core);
    const directoryA = [...(service?.directories.values() ?? [])][0] ?? "";
    expect(
      docker("ps", "--all", "--quiet", "--filter", `name=${jobA}`).trim(),
    ).toBe("");
    expect(existsSync(directoryA)).toBe(false);

    const jobB = await runJob(core);
    expect(jobB).not.toBe(jobA);
    expect(
      docker(
        "ps",
        "--all",
        "--quiet",
        "--filter",
        "name=code-reviewer-worker-",
      ).trim(),
    ).toBe("");
    expect(service?.running()).toStrictEqual([]);
  });

  // #331-T10
  it("runs the canary probe in the real image with the real flags and reads a verdict from it", async () => {
    const { bin } = await loggingDocker();
    build(bin);
    const imageId = docker(
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      IMAGE ?? "",
    ).trim();
    const logger = recordingLogger();
    const probe = createCapabilityProbe({
      run: createSandboxCanary({
        service: service as LocalSandboxService,
        snapshotId: "snap_local_mode",
        imageDigest: imageId,
        imageReference: IMAGE ?? "",
        logger,
        config: {},
      }),
      clock: systemClock,
      now: () => Date.now(),
      logger,
      timeoutMs: WORKER_RESULT_TIMEOUT_MS,
    });

    const outcome = await probe.refresh();

    // The container ran with the flags of a Dynamic-Worker and printed a verdict of the contract. Whether
    // `opencode` passes depends on the host's kernel (this lane runs on a CI host); what must hold is that the
    // probe ran, was read, and that none of the hardening of the container itself is what it names.
    expect(outcome.status).not.toBe("failed");
    expect(outcome.engines).toContain("pr-agent");
    for (const reason of [
      "root_filesystem_writable",
      "capabilities_not_dropped",
      "not_root_supervisor",
    ])
      expect(outcome.reasons).not.toContain(reason);
    expect(outcome.status === "passed").toBe(
      outcome.engines.includes("opencode"),
    );
    expect(service?.running()).toStrictEqual([]);
  });

  // #765-D1: the Implementer's half of the canary, on a real daemon and the real image.
  it("runs the Implementer's probe too, in the real image with the work volume, for a deployment that serves the kind", async () => {
    const { bin, log } = await loggingDocker();
    build(bin);
    const volumes = join(workDirectory(), "volumes");
    await mkdir(join(volumes, "code-reviewer-work-canary-privcanary"), {
      recursive: true,
    });
    const imageId = docker(
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      IMAGE ?? "",
    ).trim();
    const logger = recordingLogger();
    const probe = createCapabilityProbe({
      run: createSandboxCanary({
        service: service as LocalSandboxService,
        snapshotId: "snap_local_mode",
        imageDigest: imageId,
        imageReference: IMAGE ?? "",
        logger,
        config: {},
        implementer: { config: {} },
        // The local mode does not make the directory behind the work volume (its `mkdir` and `mount` steps are only
        // recorded), and `docker volume create` is real here: the test makes the directory a VM would have made.
        workVolumeRoot: volumes,
        newSuffix: () => "privcanary",
      }),
      clock: systemClock,
      now: () => Date.now(),
      logger,
      timeoutMs: WORKER_RESULT_TIMEOUT_MS,
    });

    const outcome = await probe.refresh();

    // Both containers ran with their own flags: the Dynamic one without a work volume, the Implementer's with it, and
    // each printed a verdict the canary could read. Whether `opencode` and `implementer` pass depends on the host's
    // kernel; what must hold is that the second probe ran, was read, and that `implementer` never stands without
    // `opencode`.
    const runs = (await readFile(log, "utf8"))
      .split("\n")
      .filter((line) => line.startsWith("run "));
    expect(runs).toHaveLength(2);
    expect(runs[0]).not.toContain("type=volume");
    expect(runs[1]).toMatch(
      /--mount type=volume,source=code-reviewer-work-canary-[a-z0-9]+,target=\/work/,
    );
    expect(runs[1]).toContain("RUNNER_IMPLEMENTER_WORK_DIR=/work");
    expect(outcome.status).not.toBe("failed");
    expect(outcome.engines).toContain("pr-agent");
    if (outcome.engines.includes("implementer"))
      expect(outcome.engines).toContain("opencode");
    expect(
      logger.text().includes("canary_implementer_probe_failed")
        ? `the second probe failed: ${logger.text()}\n${diagnose(runs[1] ?? "")}`
        : "",
    ).toBe("");
    expect(service?.running()).toStrictEqual([]);
    try {
      docker("volume", "rm", "--force", "code-reviewer-work-canary-privcanary");
    } catch {
      // Nothing of it is left to remove.
    }
  });
});
