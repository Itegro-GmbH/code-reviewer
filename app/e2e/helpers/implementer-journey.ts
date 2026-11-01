// SPDX-License-Identifier: LicenseRef-Proprietary

// What the Implementer's journeys of the privileged lane have in common (#767): the form a person fills in, the run the form
// leads to, the repository the agent works on (as the real Git objects the fake GitHub serves), the steps of the model's script,
// the fake registry behind the egress proxy, and the checks of what the runner did to Git and to GitHub.
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { createServer, type Server } from "node:https";
import { resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
import { createSelfSignedCertificate } from "../../../fakes/smtp/cert.ts";
import type { AgentToolCall } from "../../../fakes/llm/server.ts";
import { chooseOption } from "./settings-form";

/** The workspace of the first sign-in of the factory app. */
export const WORKSPACE = "default";
/** Where the Worker and its job wrapper write what the journeys read (the lane's own /run, a tmpfs). */
export const RECORDS = "/run/lane-implementer";
export const GIT_COMMANDS = `${RECORDS}/git-commands.jsonl`;

/** Keeps what the job wrapper wrote (the stacks of a job that hung, the git commands) with the report of the lane. */
export function keepRecords(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
  cpSync(RECORDS, directory, { recursive: true });
}

export function prepareRecords(): void {
  // Not emptied: Playwright starts a new worker after a failed journey and runs the setup again; the lane's /run is new for every run.
  mkdirSync(RECORDS, { recursive: true, mode: 0o755 });
}

// -- the repository ----------------------------------------------------------------------------------------------

const GIT_ENVIRONMENT = {
  HOME: "/nonexistent",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

/** A read-only Git command on the repository the fake GitHub serves (its `.git` directory). */
export function git(gitDirectory: string, ...args: string[]): string {
  const environment: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    ...GIT_ENVIRONMENT,
  };
  return execFileSync("git", ["--git-dir", gitDirectory, ...args], {
    encoding: "utf8",
    // Next's types make NODE_ENV a required variable; Git does not read it.
    env: environment as NodeJS.ProcessEnv,
  }).trim();
}

/** The commit a branch of the repository is at, or null when there is no such branch. */
export function tipOf(gitDirectory: string, branch: string): string | null {
  try {
    return git(gitDirectory, "rev-parse", "--verify", `refs/heads/${branch}`);
  } catch {
    return null;
  }
}

/** The subjects of the commits the branch has beyond the base, oldest first. */
export function subjectsAhead(
  gitDirectory: string,
  base: string,
  branch: string,
): string[] {
  return git(
    gitDirectory,
    "log",
    "--reverse",
    "--format=%s",
    `refs/heads/${base}..refs/heads/${branch}`,
  )
    .split("\n")
    .filter((line) => line !== "");
}

/** The shas of the commits the branch has beyond the base, oldest first. */
export function commitsAhead(
  gitDirectory: string,
  base: string,
  branch: string,
): string[] {
  return git(
    gitDirectory,
    "rev-list",
    "--reverse",
    `refs/heads/${base}..refs/heads/${branch}`,
  )
    .split("\n")
    .filter((line) => line !== "");
}

// -- the form ----------------------------------------------------------------------------------------------------

export type Task = {
  repository: string;
  branch: string;
  instruction: string;
  /** The model of the picker by its name, default `Lane Coder`. */
  model?: string;
  /** Dollars as a person types them. */
  costLimit?: string;
};

/** Fills in the form of the Implementer page as a person does, sends it, and returns the id of the run it leads to. */
export async function startTask(page: Page, task: Task): Promise<string> {
  await page.goto(`/w/${WORKSPACE}/implementer`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Implementer" }),
  ).toBeVisible();
  await chooseOption(page, "Repository", task.repository);
  // The default branch of the repository is chosen for the person.
  await expect(
    page.getByRole("combobox", { name: "Base branch", exact: true }),
  ).toContainText("trunk");
  await page
    .getByRole("textbox", { name: "New branch name", exact: true })
    .fill(task.branch);
  await page
    .getByRole("textbox", { name: "Task", exact: true })
    .fill(task.instruction);
  // By the start of the name: "Lane Coder" must not match "Claude Lane Coder".
  await chooseOption(
    page,
    "Model",
    new RegExp(
      `^${(task.model ?? "Lane Coder").replace(/[^A-Za-z0-9 ]/g, "\\$&")}`,
    ),
  );
  if (task.costLimit !== undefined)
    await page
      .getByRole("textbox", { name: "Cost limit (USD, optional)", exact: true })
      .fill(task.costLimit);
  await page.getByRole("button", { name: "Start task" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/w/${WORKSPACE}/runs/[0-9a-f-]{36}$`),
  );
  return new URL(page.url()).pathname.split("/").pop() ?? "";
}

export type RunData = {
  status: string;
  errorCode: string | null;
  usage: {
    model: string | null;
    totalTokens: number;
    aiCalls: number;
    costUsd: number | null;
  } | null;
  callTrace?: {
    modelCalls: Array<{
      promptTokens?: number | null;
      costUsd?: number | null;
      cacheRead?: number | null;
      cacheWrite?: number | null;
    }>;
  } | null;
  implementer?: {
    branch: string | null;
    baseBranch: string | null;
    summary: string | null;
    commits: { shown: Array<{ subject: string }>; more: number };
    files: { count: number; shown: Array<{ path: string; status: string }> };
    head: { shortSha: string } | null;
    pushedNote: string | null;
  };
};

/** The run as the page polls it. */
export async function runData(page: Page, runId: string): Promise<RunData> {
  const response = await page.request.get(`/api/w/${WORKSPACE}/runs/${runId}`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { run: RunData }).run;
}

const UNSETTLED = new Set(["queued", "running"]);

/** Waits until the run has ended, and returns it. */
export async function runEnded(
  page: Page,
  runId: string,
  timeoutMs = 240_000,
): Promise<RunData> {
  let last: RunData | undefined;
  await expect
    .poll(
      async () => {
        last = await runData(page, runId);
        return UNSETTLED.has(last.status);
      },
      { timeout: timeoutMs, intervals: [500, 1000, 2000] },
    )
    .toBe(false);
  if (last === undefined) throw new Error("The run was never read.");
  return last;
}

/**
 * Waits until the branch is on GitHub, and fails at once, with what the run says, when the run has ended without it (a task
 * that was refused or failed would otherwise be waited for until the test times out).
 */
export async function branchPushed(
  page: Page,
  runId: string,
  gitDirectory: string,
  branch: string,
  timeoutMs = 240_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (tipOf(gitDirectory, branch) !== null) return;
    const run = await runData(page, runId);
    if (!UNSETTLED.has(run.status))
      throw new Error(
        `The run ended ${run.status} (${run.errorCode ?? "no code"}) without the branch ${branch} on GitHub.`,
      );
    if (Date.now() > deadline)
      throw new Error(
        `The branch ${branch} was not on GitHub after ${String(timeoutMs)} ms; the run is ${run.status}.`,
      );
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
}

/**
 * Waits until the fake LLM holds a request (a script's `holdBefore`: the agent waits for the test), and fails at once when the
 * run ends first. What the journey has to see happen while the agent waits (a push) is waited for after this, and `release()`
 * lets the agent go on.
 */
export async function agentIsWaiting(
  llm: { heldCount(): number },
  page: Page,
  runId: string,
  timeoutMs = 80_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (llm.heldCount() > 0) return;
    const run = await runData(page, runId);
    if (!UNSETTLED.has(run.status))
      throw new Error(
        `The run ended ${run.status} (${run.errorCode ?? "no code"}) before the agent waited.`,
      );
    if (Date.now() > deadline)
      throw new Error("The agent did not come to the point it was to wait at.");
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
}

// -- the model's script ------------------------------------------------------------------------------------------

/** Where the agent's repository is in the container (the same path every turn). */
export const REPO_IN_CONTAINER = "/work/repo";

export const write = (name: string, content: string): AgentToolCall[] => [
  {
    name: "write",
    arguments: { filePath: `${REPO_IN_CONTAINER}/${name}`, content },
  },
];
export const bash = (command: string): AgentToolCall[] => [
  { name: "bash", arguments: { command, description: "run a command" } },
];
export const commit = (message: string): AgentToolCall[] =>
  bash(`git add -A && git commit -q -m '${message}'`);

/**
 * What an agent that looks for a secret runs, in the order of the issue: its environment and that of every process it can read,
 * the repository's configuration, git's configuration and remotes, the processes with their arguments, and the directories of
 * the container. Each command is announced, so that an empty answer is a result and not a gap.
 */
export const PROBE =
  [
    "env",
    "cat /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n'",
    "cat /work/repo/.git/config",
    "git config -l",
    "git remote -v",
    "ps -eo user,pid,args",
    "ls -la /run /work",
  ]
    .map((command) => `echo "== ${command.replaceAll('"', "'")}"; ${command}`)
    .join("; ") + "; echo '== end of the probe'";

/**
 * The same, while a push is going on: it commits, then looks (at most twelve seconds, every 20 ms) for a root process that runs
 * `git push` (the runner's mirror push), reads its arguments and tries to read its environment, where the token is, and says
 * what the system answered; then it runs the probe.
 */
export const PROBE_DURING_PUSH =
  "git add -A && git commit -q -m 'Add probe'; got=no; " +
  "for i in $(seq 1 600); do " +
  "for p in $(pgrep -u 0 -f ' push --porcelain '); do " +
  "c=$(tr '\\0' ' ' < /proc/$p/cmdline 2>&1 | head -c 400); " +
  "e=$(cat /proc/$p/environ 2>&1 | head -c 160); " +
  'case "$e" in *"Permission denied"*) ' +
  'echo "root push $p cmdline: $c"; echo "root push $p environ: $e"; got=yes;; esac; ' +
  "done; " +
  '[ "$got" = yes ] && break; sleep 0.02; done; ' +
  `echo "[push-seen] $got"; ${PROBE}`;

// -- what the runner did to Git ----------------------------------------------------------------------------------

type GitCommand = { time: number; argv: string[] };

/** The git commands the runner ran itself (root, on its mirror), as the job wrapper wrote them down. */
export function runnerGitCommands(): GitCommand[] {
  if (!existsSync(GIT_COMMANDS)) return [];
  return readFileSync(GIT_COMMANDS, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as GitCommand);
}

/**
 * The runner pushes the agent's branch and nothing else, and never with force. The fake GitHub refuses a forced update on
 * purpose (stricter than GitHub, which accepts it on a branch without protection), so what it accepts says nothing about the
 * runner: the command it ran does.
 */
export function expectRunnerPushedOnlyForward(
  commands: GitCommand[],
  branch: string,
): void {
  // `--git-dir /work/mirror.git -c gc.auto=0 ... push --porcelain <remote> <refspec>`: what follows `push` is the command.
  const pushes = commands.flatMap(({ argv }) => {
    const at = argv.indexOf("push");
    return at < 0 ? [] : [argv.slice(at)];
  });
  expect(pushes.length).toBeGreaterThan(0);
  const refspec = `refs/heads/${branch}:refs/heads/${branch}`;
  for (const rest of pushes) {
    // `push --porcelain <remote> <refspec>`: nothing else, in particular no force in any spelling and no deletion, and
    // the one refspec is the agent's branch to the same name, without a `+`.
    expect(rest.slice(0, 2)).toEqual(["push", "--porcelain"]);
    expect(rest, "a push is made of four words").toHaveLength(4);
    expect(rest[3]).toBe(refspec);
    expect(rest[2]).toMatch(/^https?:\/\/[^@\s]+$/);
    for (const argument of rest)
      expect(argument).not.toMatch(
        /^(-f|--force.*|--mirror|--delete|--prune|--tags|--all|--follow-tags|\+.*|:.*)$/,
      );
  }
}

/** Only the agent's own branch was pushed (the fake accepts a tag, a note or a fast-forward of the default branch). */
export function expectOnlyTheOwnBranch(
  pushes: Array<{ refs: string[] }>,
  branch: string,
): void {
  expect(pushes.length).toBeGreaterThan(0);
  for (const push of pushes)
    expect(push.refs).toEqual([`refs/heads/${branch}`]);
}

// -- the registry behind the egress proxy ------------------------------------------------------------------------

export type FakeRegistry = {
  port: number;
  /** `Host METHOD /path` of every request, oldest first. */
  requests(): string[];
  close(): Promise<void>;
};

/**
 * A package registry on loopback that answers over TLS (a certificate of its own, for `localhost`). The job wrapper
 * connects the egress proxy's tunnels to it, whatever name of the allowlist the agent asked for, so a request that reaches
 * it came through the proxy, and the `Host` header says for which name.
 */
export async function startFakeRegistry(): Promise<FakeRegistry> {
  const { key, cert } = createSelfSignedCertificate();
  const requests: string[] = [];
  const server: Server = createServer({ key, cert }, (request, response) => {
    requests.push(
      `${request.headers.host ?? ""} ${request.method ?? ""} ${request.url ?? ""}`,
    );
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        name: "left-pad",
        "dist-tags": { latest: "1.3.0" },
        fake: "registry",
      }),
    );
  });
  await new Promise<void>((resolveListening, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListening);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("The fake registry has no port.");
  return {
    port: address.port,
    requests: () => [...requests],
    close: () =>
      new Promise<void>((resolveClosed) => {
        server.close(() => resolveClosed());
        server.closeAllConnections();
      }),
  };
}

// -- what is left ------------------------------------------------------------------------------------------------

/** The directories the lane's `docker` stand-in made for the VMs of the jobs (`E2E_VM_ROOT`) that are still there. */
export function vmDirectories(root: string): string[] {
  return existsSync(root) ? readdirSync(root) : [];
}

/** The capabilities the engines of the jobs were handed (the job wrapper keeps them in a file nothing scans). */
export function capabilities(): string[] {
  return readdirSync(RECORDS)
    .filter((name) => name.endsWith(".scan.json.capabilities"))
    .flatMap((name) =>
      readFileSync(`${RECORDS}/${name}`, "utf8")
        .split("\n")
        .filter((line) => line !== ""),
    );
}

export type EngineScan = {
  /** Per place the job wrapper looked through at the end of a job: how many files, and how many held each secret. */
  roots: Record<string, { files: number; found: Record<string, number> }>;
};

/** What the job wrapper found when it looked through the places of a job at its end, one scan per job. */
export function engineScans(): EngineScan[] {
  const prefix = "git-commands.jsonl.";
  return readdirSync(RECORDS)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".scan.json"))
    .map(
      (name) =>
        JSON.parse(readFileSync(`${RECORDS}/${name}`, "utf8")) as EngineScan,
    );
}

/** The files the job wrapper wrote next to its records: its log, the engine's output, the stacks of a hung job. */
export function wrapperOutputs(): Record<string, string> {
  return Object.fromEntries(
    readdirSync(RECORDS)
      .filter((name) => /\.(job|engine|stacks)\.txt$/.test(name))
      .map((name) => [name, readFileSync(`${RECORDS}/${name}`, "utf8")]),
  );
}

// -- the container, from the lane ----------------------------------------------------------------------------------

/** The processes below `pid` (its children, their children, ...), as `/proc` says; the process itself is not in the list. */
export function descendantsOf(pid: number): number[] {
  const parents = new Map<number, number>();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      // `pid (comm) state ppid ...`: the name may hold spaces and brackets, so count from its closing bracket.
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      parents.set(Number(entry), Number(rest[1]));
    } catch {
      // The process ended while this looked.
    }
  }
  const found: number[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    const current = queue.shift() as number;
    for (const [child, parent] of parents)
      if (parent === current && !found.includes(child)) {
        found.push(child);
        queue.push(child);
      }
  }
  return found;
}

const mountNamespaceOf = (pid: number): string | null => {
  try {
    return readlinkSync(`/proc/${String(pid)}/ns/mnt`);
  } catch {
    return null;
  }
};

export type ContainerMount = {
  /** The id of the container's mount namespace (`mnt:[...]`), which the lane's own processes do not share. */
  namespace: string;
  /** The mount at /work as the container's own mountinfo has it. */
  work: { fstype: string; options: string[] } | null;
};

/**
 * What the container of a running Worker looks like from the lane: the mount namespace the stand-in's wrapper made (`unshare
 * --mount`) and the volume at /work in it, read from the mountinfo of a process of the Worker. A process of the lane itself
 * cannot see these mounts, which is why a check of "no /work mount left" reads this namespace while the Worker runs and then
 * looks for any process that still holds it.
 */
export function containerMountOf(workerPid: number): ContainerMount | null {
  const own = mountNamespaceOf(process.pid);
  // The wrapper `exec`s into `unshare --mount`, which `exec`s on: the stand-in's own process may be the one in the namespace.
  for (const pid of [workerPid, ...descendantsOf(workerPid)]) {
    const namespace = mountNamespaceOf(pid);
    if (namespace === null || namespace === own) continue;
    let work: ContainerMount["work"] = null;
    try {
      for (const line of readFileSync(
        `/proc/${String(pid)}/mountinfo`,
        "utf8",
      ).split("\n")) {
        // `id parent maj:min root mount-point options [optional...] - fstype source super-options`
        const fields = line.split(" ");
        if (fields[4] !== "/work") continue;
        const dash = fields.indexOf("-");
        work = {
          fstype: fields[dash + 1] ?? "",
          options: (fields[5] ?? "").split(","),
        };
      }
    } catch {
      continue;
    }
    return { namespace, work };
  }
  return null;
}

/** `pid args` of every process that is in one of the mount namespaces (a Worker's container ends with its last process). */
export function processesInNamespaces(namespaces: string[]): string[] {
  const found: string[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const namespace = mountNamespaceOf(Number(entry));
    if (namespace === null || !namespaces.includes(namespace)) continue;
    found.push(`${entry} ${processArguments(Number(entry))}`);
  }
  return found;
}

function processArguments(pid: number): string {
  try {
    return readFileSync(`/proc/${String(pid)}/cmdline`, "utf8")
      .split("\0")
      .join(" ")
      .trim();
  } catch {
    return "";
  }
}

/** What a Worker and its job leave when they end badly: the runner, the job wrapper, the engine, the git of the mirror, the user switch. */
const WORKER_PROCESSES =
  /code_reviewer_runner|code-reviewer-runner|run_job_against_fake_llm|opencode|setpriv|unshare|docker-worker|[ =]\/work\/(repo|mirror\.git|home|tmp)\b/;

/** Processes of the lane that belong to a Worker (root or the engine user) and have not ended. */
export function leftoverWorkerProcesses(): string[] {
  const found: string[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    const args = processArguments(Number(entry));
    if (WORKER_PROCESSES.test(args)) found.push(`${entry} ${args}`);
  }
  return found;
}

/** The path of this file's `fakes/implementer/run_job_against_fake_llm.py`. */
export const JOB_WRAPPER = resolve(
  process.cwd(),
  "../fakes/implementer/run_job_against_fake_llm.py",
);
