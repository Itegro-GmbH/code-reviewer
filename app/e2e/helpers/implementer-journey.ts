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
/** A pause that lets the push loop (it looks every two seconds) publish what is committed while the turn goes on. */
export const pause = (seconds: number): AgentToolCall[] =>
  bash(`sleep ${String(seconds)}`);

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
  const pushes = commands.filter((command) => command.argv[0] === "push");
  expect(pushes.length).toBeGreaterThan(0);
  const refspec = `refs/heads/${branch}:refs/heads/${branch}`;
  for (const { argv } of pushes) {
    expect(argv, "a push names the branch it pushes").toContain(refspec);
    // `push --porcelain <remote> <refspec>`: nothing else, in particular no force in any spelling and no deletion.
    expect(argv.slice(0, 2)).toEqual(["push", "--porcelain"]);
    expect(argv).toHaveLength(4);
    for (const argument of argv) {
      expect(argument).not.toMatch(
        /^(-f|--force.*|--mirror|--delete|--prune|--tags|--all|--follow-tags|\+.*|:.*)$/,
      );
    }
    expect(argv[3]).toBe(refspec);
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
  files: number;
  directories: string[];
  found: Record<string, number>;
};

/** What the job wrapper found when it looked through the engine's directories at the end of each job, one scan per job. */
export function engineScans(): EngineScan[] {
  const prefix = "git-commands.jsonl.";
  return readdirSync(RECORDS)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".scan.json"))
    .map(
      (name) =>
        JSON.parse(readFileSync(`${RECORDS}/${name}`, "utf8")) as EngineScan,
    );
}

/** The path of this file's `fakes/implementer/run_job_against_fake_llm.py`. */
export const JOB_WRAPPER = resolve(
  process.cwd(),
  "../fakes/implementer/run_job_against_fake_llm.py",
);
