// SPDX-License-Identifier: LicenseRef-Proprietary

// The `docker` stand-in of the hosted end-to-end lane (fakes/sandbox/bin/docker-worker.sh, #332) behind the local mode
// of the Sandbox double, with the flags the real renderer makes and a small program in place of the Worker. The lane's
// journeys rely on it being what a container is to the Worker: the entry mode and the start document arrive, the
// environment is closed, a flag it does not know is refused, a held container does not start, and the end of a container
// ends everything it runs, also a process in a session of its own. A stand-in that did less would let the journeys pass
// for the wrong reason, so it is proven here first.
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
import { LocalSandboxService } from "../../../fakes/sandbox/local.ts";
import { waitFor } from "../test-support/harness.ts";
import { renderDockerRunArguments } from "./container.ts";
import {
  IMPLEMENTER_CONTAINER_SPEC,
  SANDBOX_LAUNCHER_ADDITIONS,
  WORKER_CONTAINER_SPEC,
} from "./container-spec.ts";

const DOCKER_WORKER = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "fakes",
  "sandbox",
  "bin",
  "docker-worker.sh",
);
const IMAGE_ID = `sha256:${"e".repeat(64)}`;
const NAME = "code-reviewer-worker-00000000-0000-4000-8000-0000000000aa";
const START_DOCUMENT =
  '{"appUrl":"http://127.0.0.1:1","jobId":"j","credential":"crj_dummy"}\n';

let directory: string;
let records: string;
let worker: string;
let local: LocalSandboxService | undefined;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cr-docker-worker-"));
  records = join(directory, "records");
  worker = join(directory, "worker.sh");
  await mkdir(records);
  await mkdir(join(directory, "vms"));
});
afterEach(async () => {
  await local?.stopAll();
  local = undefined;
  await rm(directory, { recursive: true, force: true });
});

/** The program that stands in for the image's entry point: `<program> <mode>`. */
async function program(body: string): Promise<void> {
  await writeFile(worker, `#!/usr/bin/env bash\nset -u\n${body}\n`);
  await chmod(worker, 0o755);
}

async function vmWith(extra: Record<string, string> = {}) {
  local = new LocalSandboxService({
    dockerBin: DOCKER_WORKER,
    root: join(directory, "vms"),
    environment: {
      E2E_DOCKER_DIR: records,
      E2E_IMAGE_ID: IMAGE_ID,
      E2E_WORKER_COMMAND: worker,
      ...extra,
    },
  });
  return local.create({
    name: "vm-a",
    snapshotId: "snap",
    region: "fra1",
    vcpus: 1,
    timeoutMs: 60_000,
    tags: {},
    persistent: false,
  });
}

function flags(mode: string, environment: Record<string, string> = {}) {
  return renderDockerRunArguments(WORKER_CONTAINER_SPEC, {
    image: IMAGE_ID,
    name: NAME,
    environment,
    command: [mode],
    // The flags of the Sandbox-Launcher, all of them: the stand-in must know every one.
    additions: SANDBOX_LAUNCHER_ADDITIONS,
  });
}

function recorded(suffix: string): string[] {
  return readdirSync(records)
    .filter((file) => file.endsWith(suffix))
    .sort();
}

describe("the docker stand-in of the hosted lane", () => {
  // #332-T01
  it("runs the entry mode with the start document on stdin, records the flags and gives the Worker a closed environment", async () => {
    await program(
      `cat >"${directory}/stdin"; env | sort >"${directory}/env"; printf '%s' "$1" >"${directory}/mode"`,
    );
    const vm = await vmWith({
      E2E_WORKER_PASS_PR_AGENT_COMMAND: "python wrapper",
      E2E_LEAK: "must-not-reach-the-worker",
    });
    const started = await vm.start({
      label: "worker",
      cmd: "docker",
      args: flags("worker-once", { RUNNER_JOB_TIMEOUT_SECONDS: "180" }),
    });

    await started.writeStdin(START_DOCUMENT);
    await started.closeStdin();
    const result = await started.wait();

    expect(result.exitCode).toBe(0);
    expect(await readFile(join(directory, "stdin"), "utf8")).toBe(
      START_DOCUMENT,
    );
    expect(await readFile(join(directory, "mode"), "utf8")).toBe("worker-once");
    const environment = await readFile(join(directory, "env"), "utf8");
    expect(environment).toContain("RUNNER_JOB_TIMEOUT_SECONDS=180");
    expect(environment).toContain("PR_AGENT_COMMAND=python wrapper");
    expect(environment).not.toContain("E2E_");
    expect(environment).not.toContain("must-not-reach-the-worker");
    const [argsFile] = recorded(".args");
    const recordedArguments = (
      await readFile(join(records, argsFile ?? ""), "utf8")
    ).split("\n");
    expect(recordedArguments).toEqual(
      expect.arrayContaining([
        "--cap-drop",
        "ALL",
        "--read-only",
        IMAGE_ID,
        "worker-once",
      ]),
    );
  });

  // #760-T06
  it("understands the flags of the implementer profile and still refuses a mount or a volume it does not know", async () => {
    await program('printf "%s" "$1" >"' + directory + '/mode"');
    const vm = await vmWith();
    const rendered = renderDockerRunArguments(IMPLEMENTER_CONTAINER_SPEC, {
      image: IMAGE_ID,
      name: NAME,
      workVolume: "code-reviewer-work-job-1",
      command: ["worker-once"],
      additions: SANDBOX_LAUNCHER_ADDITIONS,
    });

    const accepted = await vm.exec({
      label: "w",
      cmd: "docker",
      args: rendered,
    });
    const volume = await vm.exec({
      label: "v",
      cmd: "docker",
      args: [
        ...rendered.slice(0, -2),
        "--volume",
        "/:/host",
        IMAGE_ID,
        "worker-once",
      ],
    });
    const bound = await vm.exec({
      label: "b",
      cmd: "docker",
      args: [
        ...rendered.slice(0, -2),
        "-v",
        "/:/host",
        IMAGE_ID,
        "worker-once",
      ],
    });

    expect(accepted.exitCode).toBe(0);
    expect(rendered).toContain("--mount");
    expect(await readFile(join(directory, "mode"), "utf8")).toBe("worker-once");
    expect(volume.exitCode).toBe(125);
    expect(volume.stderr).toContain("unknown flag --volume");
    expect(bound.exitCode).toBe(125);
    expect(bound.stderr).toContain("unknown flag -v");
    const bind = await vm.exec({
      label: "m",
      cmd: "docker",
      args: [
        ...rendered.slice(0, -2),
        "--mount",
        "type=bind,source=/,target=/host",
        IMAGE_ID,
        "worker-once",
      ],
    });
    expect(bind.exitCode).toBe(125);
    expect(bind.stderr).toContain("unknown mount type=bind");

    // The stand-in matches the one mount the renderer makes, not a family of them: a comma or an equals sign in the
    // name would add an option, and `*` of a glob would let it through.
    const withoutMount = rendered
      .slice(0, -2)
      .filter(
        (arg, index, all) => arg !== "--mount" && all[index - 1] !== "--mount",
      );
    const allowed = await vm.exec({
      label: "m",
      cmd: "docker",
      args: [
        ...withoutMount,
        "--mount",
        "type=volume,source=code-reviewer-work-a.b_c-1,target=/work",
        IMAGE_ID,
        "worker-once",
      ],
    });
    expect(allowed.exitCode).toBe(0);
    // One mount only: a second one, also a good one, is refused.
    const twice = await vm.exec({
      label: "m",
      cmd: "docker",
      args: [
        ...rendered.slice(0, -2),
        "--mount",
        "type=volume,source=code-reviewer-work-a,target=/work",
        IMAGE_ID,
        "worker-once",
      ],
    });
    expect(twice.exitCode).toBe(125);
    for (const mount of [
      "type=volume,source=code-reviewer-work-a,readonly=false,target=/work",
      "type=volume,source=code-reviewer-work-a,bind-propagation=rshared,target=/work",
      "type=volume,source=code-reviewer-work-a,volume-opt=o=suid,target=/work",
      "type=volume,source=code-reviewer-work-a,target=/,target=/work",
      "type=volume,source=code-reviewer-work-a=b,target=/work",
      "type=volume,source=code-reviewer-work-,target=/work",
      "type=volume,source=code-reviewer-work-a,target=/work,readonly",
      "type=volume,source=other,target=/work",
      "type=volume,source=code-reviewer-work-a b,target=/work",
      "type=volume,source=code-reviewer-work-a,target=/work\n",
    ]) {
      const refused = await vm.exec({
        label: "m",
        cmd: "docker",
        args: [...withoutMount, "--mount", mount, IMAGE_ID, "worker-once"],
      });
      expect(refused.exitCode, mount).toBe(125);
      expect(refused.stderr, mount).toContain("unknown mount");
    }
  });

  // #332-T09
  it("takes the names of E2E_WORKER_ONCE_UNSET out of worker-once and keeps them for probe, whose stdout is the verdict", async () => {
    await program(
      `env | sort >"${directory}/env-$1"; echo '{"engines":["pr-agent"],"reasons":[]}'`,
    );
    const environment = { RUNNER_DIFF_JOB_USER: "10001:10001" };
    const vm = await vmWith({ E2E_WORKER_ONCE_UNSET: "RUNNER_DIFF_JOB_USER" });

    await (
      await vm.start({
        label: "w",
        cmd: "docker",
        args: flags("worker-once", environment),
      })
    ).wait();
    const probe = await vm.exec({
      label: "p",
      cmd: "docker",
      args: flags("probe", environment),
    });

    expect(
      await readFile(join(directory, "env-worker-once"), "utf8"),
    ).not.toContain("RUNNER_DIFF_JOB_USER");
    expect(await readFile(join(directory, "env-probe"), "utf8")).toContain(
      "RUNNER_DIFF_JOB_USER=10001:10001",
    );
    expect(probe.stdout.trim()).toBe('{"engines":["pr-agent"],"reasons":[]}');
  });

  // #332-T01
  it("refuses a flag it does not know, like a daemon refuses one it does not", async () => {
    await program("true");
    const vm = await vmWith();

    const result = await vm.exec({
      label: "w",
      cmd: "docker",
      args: [
        ...flags("worker-once").slice(0, -2),
        "--privileged",
        IMAGE_ID,
        "worker-once",
      ],
    });

    expect(result.exitCode).toBe(125);
    expect(result.stderr).toContain("unknown flag --privileged");
    expect(recorded(".args")).toEqual([]);
  });

  // #332-T10
  it("copies the start document of a worker-once to the directory it is given, and still hands it to the Worker", async () => {
    await program(`cat >"${directory}/stdin"`);
    const copies = join(directory, "copies");
    const vm = await vmWith({ E2E_STDIN_COPY_DIR: copies });
    const started = await vm.start({
      label: "worker",
      cmd: "docker",
      args: flags("worker-once"),
    });

    await started.writeStdin(START_DOCUMENT);
    await started.closeStdin();
    await started.wait();

    expect(await readFile(join(directory, "stdin"), "utf8")).toBe(
      START_DOCUMENT,
    );
    const [copy] = readdirSync(copies);
    expect(await readFile(join(copies, copy ?? ""), "utf8")).toBe(
      START_DOCUMENT,
    );
    // Never in the records of the stand-in, which every log scan reads.
    expect(
      recorded(".args").concat(recorded(".env"), recorded(".log")),
    ).not.toContain(copy);
    const [environment] = recorded(".env");
    expect(
      await readFile(join(records, environment ?? ""), "utf8"),
    ).not.toContain("crj_dummy");
  });

  // #332-T08
  it("keeps the Worker from starting while the gate file exists and starts it when it is gone", async () => {
    await program(`touch "${directory}/started"`);
    const gate = join(directory, "gate");
    await writeFile(gate, "");
    const vm = await vmWith({ E2E_WORKER_GATE: gate });
    const started = await vm.start({
      label: "w",
      cmd: "docker",
      args: flags("worker-once"),
    });

    await waitFor(
      () => recorded(".args").length === 1,
      "the container to be recorded",
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(existsSync(join(directory, "started"))).toBe(false);
    await rm(gate);

    expect((await started.wait()).exitCode).toBe(0);
    expect(existsSync(join(directory, "started"))).toBe(true);
  });

  // #380-T03
  it("has written .name, .pid and .env as soon as .args is listed, also for a container that is held", async () => {
    await program("true");
    const gate = join(directory, "gate");
    await writeFile(gate, "");
    const vm = await vmWith({ E2E_WORKER_GATE: gate });
    const started = await vm.start({
      label: "w",
      cmd: "docker",
      args: flags("worker-once"),
    });

    await waitFor(
      () => recorded(".args").length === 1,
      "the container to be recorded",
    );
    expect(recorded(".name")).toHaveLength(1);
    expect(recorded(".pid")).toHaveLength(1);
    expect(recorded(".env")).toHaveLength(1);
    expect(recorded(".tmp")).toEqual([]);
    await rm(gate);
    await started.wait();
  });

  // #332-T06
  it("ends everything a container runs when it is removed, also a process in a session of its own", async () => {
    await program(
      `setsid bash -c 'echo $$ >"${directory}/lonely.pid"; exec sleep 60' &\necho $$ >"${directory}/main.pid"\nexec sleep 60`,
    );
    const vm = await vmWith();
    const started = await vm.start({
      label: "w",
      cmd: "docker",
      args: flags("worker-once"),
    });
    await waitFor(
      () =>
        existsSync(join(directory, "lonely.pid")) &&
        existsSync(join(directory, "main.pid")),
      "both processes to run",
    );
    const alive = (file: string) => {
      try {
        process.kill(Number(readFileSyncTrim(join(directory, file))), 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive("lonely.pid")).toBe(true);

    const removed = await vm.exec({
      label: "rm",
      cmd: "docker",
      args: ["rm", "--force", NAME],
    });

    expect(removed.exitCode).toBe(0);
    expect((await started.wait()).exitCode).toBe(137);
    await waitFor(
      () => !alive("lonely.pid") && !alive("main.pid"),
      "the processes to be gone",
    );
  });
});

function readFileSyncTrim(path: string): string {
  return readFileSync(path, "utf8").trim();
}
