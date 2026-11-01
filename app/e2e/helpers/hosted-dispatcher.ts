// SPDX-License-Identifier: LicenseRef-Proprietary

// Starts the Dispatcher of the hosted lane (#332) as a process of its own and gives the journeys what they need to
// steer and to look at it. The process is `dispatcher/src/test-support/hosted-e2e-main.ts`: the real Node entry and the
// real Sandbox-Launcher, over the local mode of the Sandbox double and `fakes/sandbox/bin/docker-worker.sh`, which runs
// the REAL Worker (`code-reviewer-runner worker-once`, or `probe`) as a local process where a container would be.
// "The Dispatcher is down" is this process not running; the app's address for it does not change.
//
// Everything the stand-in `docker` was asked is on disk (`hostedEnv.dockerDirectory`): the rendered flags of every
// container, the environment the Worker had, what it wrote to stderr (and stdout), its process id.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  appendFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { readContainers, type Container } from "./hosted-containers";
import { hostedEnv } from "./hosted-env";
import {
  assertTiktokenCache,
  quoted,
  tiktokenCacheDirectory,
} from "./runner-process";
import { waitUntil } from "./wait-until";

const DISPATCHER_DIRECTORY = resolve(process.cwd(), "../dispatcher");
const RUNNER_DIRECTORY = resolve(process.cwd(), "../runner");
const WRAPPER = resolve(
  process.cwd(),
  "../fakes/pr-agent/run_job_against_fake_llm.py",
);

const absolute = (path: string) => resolve(process.cwd(), path);

/** Every process below `pid` and `pid` itself, found before anything is killed (a dead process has no children). */
function killTree(pid: number): void {
  const table = spawnSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" });
  const children = new Map<number, number[]>();
  for (const line of table.stdout.split("\n")) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (child === undefined || parent === undefined) continue;
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const all: number[] = [];
  const visit = (current: number) => {
    all.push(current);
    for (const child of children.get(current) ?? []) visit(child);
  };
  visit(pid);
  for (const target of all.reverse()) {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

export type { Container };

export type HostedDispatcher = {
  /** Everything the Dispatcher wrote to stdout and stderr so far. */
  output(): string;
  /** The containers started since the lane's records were last cleared, oldest first. */
  containers(): Container[];
  /** The Worker containers (`worker-once`) of one job. */
  workersOf(jobId: string): Container[];
  /** Keeps every Worker that starts from running until `holdWorkers(false)`: the VM is up, the Worker is not. */
  holdWorkers(on: boolean): void;
  /** The next `count` VM creations fail like a platform that is down. */
  failNextCreations(count: number): void;
  /**
   * From now on every Worker container lives past the hand-over and then ends with `exitCode`, without a result (a Worker
   * that took over and died); `null` lets them run again. Not the probe's container.
   */
  endWorkersWith(exitCode: number | null): void;
  /** Ends the whole tree of a container at once, like a container that is killed. */
  killContainer(container: Container): void;
  /** SIGTERM, then SIGKILL. Everything the process started is stopped with it. */
  stop(): Promise<void>;
};

export async function startHostedDispatcher(options: {
  /** The `llm.baseUrl` the jobs get, the address of the fake LLM (the app has no setting for it). */
  llmBaseUrl: string;
  /** `pr-agent` (Diff only) or `pr-agent,opencode`. Default: Diff only. */
  engines?: string;
  /** The pool cap the Dispatcher sends with every claim. Default 1, the pool of the lane (the app's sweep keeps to it too). */
  maxRunning?: number;
  /** What the container of a Dynamic job is given (the operator's model descriptor and cost limit). */
  dynamic?: { capabilities: string; maxCostUsd: string };
  /**
   * The names the `docker` stand-in takes out of the environment of `worker-once`. By default `RUNNER_DIFF_JOB_USER`:
   * this lane is not root with capabilities, so its Workers serve Diff jobs. The privileged lane passes none: its
   * Worker starts the way the container's does.
   */
  unsetForWorkerOnce?: string[];
  /**
   * Whether the Worker host and the job process run behind the runner's Python connect guard, which records every
   * connection in `hostedEnv.connectionLog` and refuses anything that is not loopback. Default true; the privileged lane
   * has the operating system's guard over everything instead.
   */
  connectGuard?: boolean;
  /** Whether the Worker needs the tiktoken encoding of PR-Agent (every lane that runs a Diff job). Default true. */
  tiktoken?: boolean;
  /** More variables for the process, for a lane that needs them (the privileged lane's wrapper). */
  environment?: Record<string, string>;
  /**
   * Further apps of the Dispatcher's registry (`DISPATCHER_APPS`, #730), next to the `reviewer` it always has (the first
   * app of the lane). With one, the Dispatcher also needs its operator credential. A kind named `implementer` makes it
   * serve that engine, and the Launcher advertise it.
   */
  apps?: Array<{
    id: string;
    url: string;
    kinds: string[];
    keyId: string;
    maxRunning: number;
    token: string;
    signingSecret: string;
  }>;
  operatorToken?: string;
  /** The files of this Dispatcher and its stand-in; by default the first journey's (`hostedEnv`). */
  records?: {
    dockerDirectory: string;
    controlDirectory: string;
    secretsDirectory: string;
    logFile: string;
  };
}): Promise<HostedDispatcher> {
  const python = join(RUNNER_DIRECTORY, ".venv/bin/python");
  const program = join(RUNNER_DIRECTORY, ".venv/bin/code-reviewer-runner");
  if (!existsSync(program))
    throw new Error(
      `The Worker is not installed (${program} is missing): run "make install" or "uv sync --locked" in runner/.`,
    );
  const tiktoken = options.tiktoken ?? true;
  const connectGuard = options.connectGuard ?? true;
  const guardDirectory = resolve(
    process.cwd(),
    "../runner/tests/engine/connect_guard",
  );
  const connectionLog = absolute(hostedEnv.connectionLog);
  if (tiktoken) assertTiktokenCache();
  const records = options.records ?? {
    dockerDirectory: hostedEnv.dockerDirectory,
    controlDirectory: hostedEnv.controlDirectory,
    secretsDirectory: hostedEnv.secretsDirectory,
    logFile: hostedEnv.logFiles.dispatcher,
  };
  mkdirSync(absolute(records.dockerDirectory), { recursive: true });
  mkdirSync(absolute(records.controlDirectory), { recursive: true });
  const gate = absolute(`${records.controlDirectory}/hold-workers`);
  rmSync(gate, { force: true });
  const exitFile = absolute(`${records.controlDirectory}/exit-workers`);
  rmSync(exitFile, { force: true });

  const environment: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: absolute(hostedEnv.directory),
    LANG: "C.UTF-8",
    // The Dispatcher's own settings (dispatcher/README.md, "Configuration").
    RUNNER_API_URL: hostedEnv.appUrl,
    RUNNER_TOKEN: hostedEnv.dispatcherToken,
    DISPATCHER_POOL_ID: hostedEnv.poolId,
    DISPATCHER_MAX_RUNNING: String(options.maxRunning ?? 1),
    DISPATCHER_ENGINES: options.engines ?? "pr-agent",
    DISPATCHER_JOB_TIMEOUT_SECONDS: "180",
    DISPATCHER_SIGNING_KEY_ID: hostedEnv.webhookKeyId,
    DISPATCHER_SIGNING_SECRET: hostedEnv.webhookSecret,
    DISPATCHER_SHUTDOWN_GRACE_SECONDS: "5",
    ...(options.apps === undefined
      ? {}
      : {
          DISPATCHER_APPS: JSON.stringify(
            options.apps.map(({ id, url, kinds, keyId, maxRunning }) => ({
              id,
              url,
              kinds,
              keyId,
              maxRunning,
            })),
          ),
          DISPATCHER_OPERATOR_TOKEN: options.operatorToken ?? "",
          ...Object.fromEntries(
            options.apps.flatMap((app) => {
              const name = app.id.toUpperCase().replaceAll("-", "_");
              return [
                [`DISPATCHER_APP_${name}_TOKEN`, app.token],
                [`DISPATCHER_APP_${name}_SIGNING_SECRET`, app.signingSecret],
              ];
            }),
          ),
        }),
    ...(options.dynamic === undefined
      ? {}
      : {
          RUNNER_DYNAMIC_CAPABILITIES: options.dynamic.capabilities,
          RUNNER_DYNAMIC_MAX_COST_USD: options.dynamic.maxCostUsd,
        }),
    // The test host and the `docker` stand-in (hosted-e2e-main.ts, docker-worker.sh).
    E2E_PORT: String(hostedEnv.dispatcherPort),
    E2E_IMAGE_ID: hostedEnv.imageId,
    E2E_CONTROL_DIR: absolute(records.controlDirectory),
    E2E_DOCKER_DIR: absolute(records.dockerDirectory),
    E2E_WORKER_COMMAND: program,
    E2E_WORKER_GATE: gate,
    E2E_WORKER_EXIT_FILE: exitFile,
    E2E_WORKER_ONCE_UNSET: (
      options.unsetForWorkerOnce ?? ["RUNNER_DIFF_JOB_USER"]
    ).join(" "),
    // What the image carries itself and the container is not given: the job command that adds the address of the fake
    // LLM to the job, and the tiktoken encoding PR-Agent counts tokens with.
    // The copy of every start document: what the logs are searched for (the per-job credential is in it).
    E2E_STDIN_COPY_DIR: absolute(records.secretsDirectory),
    E2E_WORKER_PASS_PR_AGENT_COMMAND: [
      python,
      WRAPPER,
      options.llmBaseUrl,
      ...(connectGuard ? [guardDirectory, connectionLog] : []),
    ]
      .map(quoted)
      .join(" "),
    ...(connectGuard
      ? {
          // The Worker host: its connections to the app. The job process gets the guard from the job command.
          E2E_WORKER_PASS_PYTHONPATH: guardDirectory,
          E2E_WORKER_PASS_ENGINE_CONNECT_LOG: connectionLog,
        }
      : {}),
    ...(tiktoken
      ? { E2E_WORKER_PASS_TIKTOKEN_CACHE_DIR: tiktokenCacheDirectory() }
      : {}),
    ...options.environment,
  };

  const child: ChildProcess = spawn(
    process.execPath,
    [
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      "src/test-support/hosted-e2e-main.ts",
    ],
    {
      cwd: DISPATCHER_DIRECTORY,
      // Next's types make NODE_ENV a required variable; the Dispatcher does not read it.
      env: environment as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  const logFile = absolute(records.logFile);
  const collect = (chunk: Buffer) => {
    output += chunk.toString("utf8");
    // Every Dispatcher of the run appends to one file, for the journey that reads every log at the end.
    appendFileSync(logFile, chunk);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  const exited = new Promise<void>((resolveExit) => {
    child.once("exit", () => resolveExit());
  });
  const isRunning = () => child.exitCode === null && child.signalCode === null;

  // A worker that ends without `stop()` must not leave a Dispatcher listening.
  const onExit = () => {
    if (isRunning()) child.kill("SIGKILL");
  };
  process.on("exit", onExit);

  const stop = async () => {
    process.removeListener("exit", onExit);
    if (!isRunning()) return;
    child.kill("SIGTERM");
    const killer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    await exited;
    clearTimeout(killer);
  };

  try {
    await waitUntil(
      "the Dispatcher to listen",
      () => output.includes('"event":"listening"') || !isRunning(),
      30_000,
    );
    if (!isRunning())
      throw new Error(`The Dispatcher ended at start. Its output:\n${output}`);
  } catch (error) {
    await stop();
    throw error;
  }

  return {
    output: () => output,
    containers: () => readContainers(absolute(records.dockerDirectory)),
    workersOf: (jobId) =>
      readContainers(absolute(records.dockerDirectory)).filter(
        (container) =>
          container.mode === "worker-once" &&
          container.name === `code-reviewer-worker-${jobId}`,
      ),
    holdWorkers(on) {
      if (on) writeFileSync(gate, "");
      else rmSync(gate, { force: true });
    },
    endWorkersWith(exitCode) {
      if (exitCode === null) rmSync(exitFile, { force: true });
      else writeFileSync(exitFile, String(exitCode));
    },
    failNextCreations(count) {
      writeFileSync(
        absolute(`${records.controlDirectory}/fail-create`),
        String(count),
      );
    },
    killContainer(container) {
      killTree(container.pid);
    },
    stop,
  };
}
