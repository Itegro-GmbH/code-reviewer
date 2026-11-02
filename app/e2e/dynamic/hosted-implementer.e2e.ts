// SPDX-License-Identifier: LicenseRef-Proprietary

// The Implementer through the factory deployment in the privileged lane (#767): a person fills in the form of the Implementer
// page, the app queues the task and wakes the REAL Dispatcher (which serves the factory app as an entry of its registry, with
// the kind `implementer`), whose Sandbox-Launcher starts the REAL Worker in the Implementer's container profile (root with the
// capabilities of the hardened spec, a read-only root, a work volume at /work, git 2.53 and the guard files). The Worker
// clones the repository from the fake GitHub, runs the pinned OpenCode as the engine user behind the nft rules, the model proxy
// and the egress proxy, and pushes the agent's commits to the fake GitHub. The model is the fake LLM, which plays the agent
// from a script; nothing else is replaced but the last hops (the job wrapper `fakes/implementer/run_job_against_fake_llm.py`
// puts the model's provider and the package registries on loopback, the only place the lane has) and the container itself.
//
// Journeys E01 to E12 are here; E13, the wall of code-review.com, is proven by the lower-level tests that the table of the pull
// request names. Every journey sends its task through the form (not the API); the agent's behaviour is the script of the fake
// LLM. The texts of the scripts do not overlap: a script answers the first request whose last user message holds its marker,
// so every instruction carries a marker of its own and none of them holds a phrase another script waits for.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { Client } from "pg";
import {
  createGitRepository,
  type GitRepository,
} from "../../../fakes/github/git-fixture.ts";
import { startLlmFake, type FakeLlm } from "../../../fakes/llm/server.ts";
import { syncFromGithubAsAdmin } from "../helpers/admin-api";
import {
  assertGuardQuiet,
  engineProcesses,
} from "../helpers/dynamic-lane-guard";
import { e2eEnv } from "../helpers/e2e-env";
import {
  addGithubGitRepository,
  addGithubInstallation,
  getGithubRequests,
  getIssuedInstallationTokens,
  getPushes,
  GITHUB_APP_OWNER_ACCOUNT,
  setGithubAppPermissions,
} from "../helpers/github-fake";
import {
  startHostedDispatcher,
  type HostedDispatcher,
} from "../helpers/hosted-dispatcher";
import {
  factoryDatabaseUrls,
  factoryEnv,
  factorySecrets,
  hostedEnv,
} from "../helpers/hosted-env";
import {
  eventually,
  runDeployCanary,
  signInAsAdmin,
} from "../helpers/hosted-instance";
import { required } from "../helpers/hosted-journey";
import { allSecrets, containsSecret } from "../helpers/hosted-secrets";
import {
  agentIsWaiting,
  bash,
  branchPushed,
  capabilities,
  commit,
  commitsAhead,
  containerMountOf,
  engineScans,
  expectRunnerPushedOnlyForward,
  JOB_WRAPPER,
  leftoverWorkerProcesses,
  PROBE,
  PROBE_DURING_PUSH,
  prepareRecords,
  processesInNamespaces,
  runData,
  runEnded,
  runnerGitCommands,
  startFakeRegistry,
  startTask,
  subjectsAhead,
  tipOf,
  vmDirectories,
  WORKSPACE,
  wrapperOutputs,
  write,
  GIT_COMMANDS,
  keepRecords,
  noteNamespace,
  notedNamespaces,
  type ContainerMount,
  type FakeRegistry,
} from "../helpers/implementer-journey";
import { fetchModelsDevCatalog } from "../helpers/models-dev";
import { quoted } from "../helpers/runner-process";
import { chooseOption } from "../helpers/settings-form";

const WRAPPER = resolve(
  process.cwd(),
  "../runner/scripts/dynamic_e2e_worker_container.sh",
);
const VM_ROOT = "/run/hosted-vms";
const PYTHON = resolve(process.cwd(), "../runner/.venv/bin/python");

const INSTALLATION_ID = 9500767;
// The app clones from the repository's own https address, and the lane's fake GitHub speaks plain http on loopback: the repository
// states an https address on the fake's host and port, which the job wrapper turns into http for the one git command that talks to it.
const GADGETS = {
  id: 9600767,
  fullName: "hosted-implementer/gadgets",
  htmlUrl: `${e2eEnv.githubUrl.replace("http://", "https://")}/hosted-implementer/gadgets`,
};
const BASE = "trunk";
const KEY = "sk-deepseek-e2e-implementer-key-0123456789abcdef0123";
// The workspace of E14 saves this key for Anthropic, a provider of the registry, for the length of that journey.
const ANTHROPIC_KEY = "dummy-anthropic-e2e-implementer-key-0123456789abcdef";
// One run of the agent takes a few seconds of the model's script and the pinned engine's start, a push and the end of the turn.
const RUN_TIMEOUT = 80_000;
const FIXTURE = "../fakes/fixtures/models-dev/implementer-lane.json";
const LEFTOVER_PHRASE = "commit your changes now";
const SYSTEM_COMMIT = "Implementer: uncommitted changes of the turn";

test.describe("a task on its way from the form of the Implementer to a branch on GitHub", () => {
  let llm: FakeLlm | undefined;
  let dispatcher: HostedDispatcher | undefined;
  let registry: FakeRegistry | undefined;
  let directory: string | undefined;
  let repository: GitRepository | undefined;
  let base = "";
  // What the model was shown in every journey so far: the fake's log is cleared before each one.
  const shownToTheModel: string[] = [];

  test.beforeAll(async ({ browser, baseURL }) => {
    if (baseURL === undefined)
      throw new Error("The factory project has no baseURL.");
    prepareRecords();
    llm = await startLlmFake({ port: e2eEnv.modelLlmFakePort });
    registry = await startFakeRegistry();
    dispatcher = await startHostedDispatcher({
      llmBaseUrl: llm.baseUrl,
      engines: "pr-agent,opencode,implementer",
      maxRunning: 1,
      tiktoken: false,
      // The lane's own guard is the operating system's, over every process (assertGuardQuiet below).
      connectGuard: false,
      unsetForWorkerOnce: [],
      dynamic: {
        capabilities: JSON.stringify({
          tool_choice_required: true,
          structured_output: true,
          max_output_tokens: 4096,
          input_usd_per_mtok: 1,
          output_usd_per_mtok: 4,
        }),
        maxCostUsd: "1",
      },
      // The registry of the Dispatcher: the factory app, with the kind that makes the Launcher advertise `implementer`.
      apps: [
        {
          id: factoryEnv.registryId,
          url: factoryEnv.appUrl,
          kinds: ["diff", "dynamic", "implementer"],
          keyId: factoryEnv.webhookKeyId,
          maxRunning: 1,
          token: factoryEnv.dispatcherToken,
          signingSecret: factoryEnv.webhookSecret,
        },
      ],
      operatorToken: factoryEnv.operatorToken,
      records: {
        dockerDirectory: factoryEnv.dockerDirectory,
        controlDirectory: factoryEnv.controlDirectory,
        secretsDirectory: hostedEnv.secretsDirectory,
        logFile: factoryEnv.logFiles.dispatcher,
      },
      environment: {
        E2E_WORKER_WRAPPER: WRAPPER,
        E2E_WORKER_PATH:
          "/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin",
        E2E_VM_ROOT: VM_ROOT,
        E2E_WORKER_PASS_PYTHONDONTWRITEBYTECODE: "1",
        // The Worker's job command: the real entry point of the runner with the model's provider and the registries on
        // loopback, and the record of the runner's own git commands.
        E2E_WORKER_PASS_PR_AGENT_COMMAND: [
          PYTHON,
          JOB_WRAPPER,
          llm.baseUrl,
          String(registry.port),
          GIT_COMMANDS,
        ]
          .map(quoted)
          .join(" "),
        // A task may take an hour in production; the lane's journeys take seconds, with room for a slow runner.
        DISPATCHER_WORKER_CONFIG: JSON.stringify({
          implementer: { timeoutSeconds: 600 },
        }),
      },
    });

    // The repository of the tasks: a default branch that is not `main`, as real Git objects the fake GitHub serves.
    directory = mkdtempSync(join(tmpdir(), "cr-lane-implementer-repo-"));
    repository = createGitRepository(join(directory, "gadgets"), {
      defaultBranch: BASE,
    });
    base = repository.commit(
      { "README.md": "# gadgets\n", "src/app.txt": "one\n" },
      "Base",
    );

    // The setup a person does once: the App with Contents: write is installed for the repository, the app reads it, the
    // workspace saves its key for the catalog provider, and the catalog holds the models of the journeys.
    const context = await browser.newContext({ baseURL });
    try {
      const page = await context.newPage();
      await setGithubAppPermissions(context.request, {
        metadata: "read",
        contents: "write",
        pull_requests: "write",
        issues: "write",
        checks: "write",
      });
      await addGithubInstallation(
        context.request,
        { id: INSTALLATION_ID, account: GITHUB_APP_OWNER_ACCOUNT },
        [GADGETS],
      );
      await addGithubGitRepository(
        context.request,
        GADGETS.fullName,
        repository.path,
      );
      await fetchModelsDevCatalog(factoryDatabaseUrls().app, FIXTURE);
      await syncFromGithubAsAdmin(baseURL);
      await signInAsAdmin(page);
      const saved = await page.request.put(
        `/api/w/${WORKSPACE}/llm-keys/deepseek`,
        { data: { apiKey: KEY } },
      );
      expect(saved.status(), await saved.text()).toBe(200);
    } finally {
      await context.close();
    }
  });

  // The lane has a limit of 25 minutes for twelve journeys: a journey that does not end in two minutes is a failure, not a wait
  // (E01 also runs the deploy canary first).
  test.beforeEach(({}, testInfo) => {
    testInfo.setTimeout(testInfo.title.startsWith("E01") ? 240_000 : 90_000);
    required(llm, "The fake LLM").reset();
  });

  test.afterEach(async ({}, testInfo) => {
    // A failed journey keeps what the model was asked and what the Dispatcher said, next to the screenshot.
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach("model-requests.json", {
        body: JSON.stringify(
          required(llm, "The fake LLM")
            .requests()
            .map((item) => ({
              model: item.model,
              tools: item.tools.length,
              prompt: item.prompt.slice(-600),
              toolResults: Object.values(item.toolResults).map((text) =>
                text.slice(0, 300),
              ),
            })),
          null,
          2,
        ),
        contentType: "application/json",
      });
    }
    for (const item of required(llm, "The fake LLM").requests())
      shownToTheModel.push(
        `${item.prompt}\n${Object.values(item.toolResults).join("\n")}`,
      );
  });

  test.afterAll(async () => {
    // Whatever the journeys left of the job wrapper's records goes with the report (the lane's /run does not outlive it).
    keepRecords(`${factoryEnv.directory}/records`);
    try {
      await dispatcher?.stop();
    } finally {
      await registry?.close();
      await llm?.close();
      if (directory !== undefined)
        rmSync(directory, { recursive: true, force: true });
    }
  });

  /** After a task: nothing of the engine's user is running, and nothing reached beyond loopback. */
  async function expectQuiet(): Promise<void> {
    await eventually(
      "the engine's processes to be gone",
      async () => engineProcesses().length === 0,
    );
    assertGuardQuiet();
  }

  /**
   * The container of the Worker that runs now, as the lane sees it: its own mount namespace, and the volume at /work in it. Read
   * while the agent waits, because a process of the lane cannot see the mounts of a container that has ended.
   */
  function observeContainer(): ContainerMount {
    const worker = required(
      required(dispatcher, "The Dispatcher")
        .containers()
        .filter((container) => container.mode === "worker-once")
        .at(-1),
      "The Worker",
    );
    const mount = containerMountOf(worker.pid);
    if (mount === null)
      throw new Error(
        "The container of the Worker has no namespace of its own.",
      );
    noteNamespace(mount.namespace);
    return mount;
  }

  /** Every push the fake GitHub received for the repository since `before` pushes were counted: any ref, not only the branch. */
  async function pushesSince(
    request: APIRequestContext,
    before: number,
  ): Promise<Array<{ repository: string; refs: string[] }>> {
    return (await getPushes(request, GADGETS.fullName)).slice(before);
  }

  /** The pushes of a journey are the agent's branch and nothing else: no tag, no note, no other branch, whatever the fake accepts. */
  function expectOnlyPushesOf(
    pushes: Array<{ refs: string[] }>,
    branch: string,
  ): void {
    expect(pushes.length).toBeGreaterThan(0);
    for (const push of pushes)
      expect(push.refs).toEqual([`refs/heads/${branch}`]);
  }

  function gadgets(): GitRepository {
    return required(repository, "The repository");
  }

  async function jobCount(): Promise<number> {
    const client = new Client({ connectionString: factoryDatabaseUrls().app });
    await client.connect();
    try {
      const { rows } = await client.query<{ count: string }>(
        "select count(*) from jobs",
      );
      return Number(rows[0]?.count ?? "0");
    } finally {
      await client.end();
    }
  }

  // #767-E01
  test("E01 the form preselects the default branch; the task is accepted, run by the Worker, and its two commits are on the branch, pushed during the turn and at the end", async ({
    page,
    request,
  }) => {
    const theLlm = required(llm, "The fake LLM");
    const theDispatcher = required(dispatcher, "The Dispatcher");
    const branch = "implementer/e01";
    // The release gate, as the pipeline runs it for a deployment that serves the Implementer: the probe container in the
    // Implementer's profile vouches for `implementer` as well, and the dispatch below runs no probe of its own.
    const canary = await runDeployCanary(150, {
      token: factoryEnv.operatorToken,
      engines: "pr-agent,opencode,implementer",
    });
    expect(
      canary.code,
      `${canary.output}\n${theDispatcher.output()}\n${theDispatcher
        .containers()
        .map((container) => container.log())
        .join("\n")}`,
    ).toBe(0);
    expect(canary.output).toContain("canary: passed");
    expect(canary.output).toContain("implementer");
    const instruction =
      "[E01-HAPPY] Add the files hello.txt and farewell.txt, each in a commit of its own.";
    theLlm.scriptAgent({
      when: { lastUserContains: "[E01-HAPPY]" },
      steps: [
        write("hello.txt", "Hello\n"),
        commit("Add hello"),
        write("farewell.txt", "Goodbye\n"),
        commit("Add farewell"),
      ],
      // The agent waits before its third step, until the first commit is on GitHub (the test releases it).
      holdBefore: [2],
      finalText: "Added hello.txt and farewell.txt, one commit each.",
    });
    await signInAsAdmin(page);
    const pushesBefore = (await getPushes(request, GADGETS.fullName)).length;
    const commandsBefore = runnerGitCommands().length;

    const runId = await startTask(page, {
      repository: GADGETS.fullName,
      branch,
      instruction,
    });

    // During the turn: the first commit is on the branch at the fake GitHub while the agent waits and the run is running.
    await agentIsWaiting(theLlm, page, runId, RUN_TIMEOUT);
    await branchPushed(page, runId, gadgets().path, branch, RUN_TIMEOUT);
    expect(subjectsAhead(gadgets().path, BASE, branch)).toEqual(["Add hello"]);
    expect((await runData(page, runId)).status).toBe("running");
    // The volume of the container, from the lane: a fresh tmpfs at /work that the engine's programs may run from.
    const mount = observeContainer();
    expect(mount.work?.fstype).toBe("tmpfs");
    expect(mount.work?.options).toEqual(
      expect.arrayContaining(["rw", "nosuid", "nodev"]),
    );
    expect(mount.work?.options).not.toContain("noexec");
    theLlm.release();

    const ended = await runEnded(page, runId, RUN_TIMEOUT);
    expect(ended.status).toBe("succeeded");

    // At the end: both commits, in order, and the base branch never moved.
    expect(subjectsAhead(gadgets().path, BASE, branch)).toEqual([
      "Add hello",
      "Add farewell",
    ]);
    expect(tipOf(gadgets().path, BASE)).toBe(base);
    expect(commitsAhead(gadgets().path, BASE, branch)).toHaveLength(2);
    const pushes = await pushesSince(request, pushesBefore);
    expect(pushes.length).toBeGreaterThanOrEqual(2);
    expectOnlyPushesOf(pushes, branch);
    expectRunnerPushedOnlyForward(
      runnerGitCommands().slice(commandsBefore),
      branch,
    );
    // No pull request was opened, read or asked for in this repository (the fake is shared with the earlier journey's repository).
    const asked = await getGithubRequests(request);
    expect(
      asked.filter(
        (entry) =>
          entry.path.includes(`/${GADGETS.fullName}`) &&
          /\/pulls?(\/|$)/.test(entry.path),
      ),
    ).toEqual([]);

    // The Runs page: kind, repository, branch, commits, summary, model, duration.
    await page.goto(`/w/${WORKSPACE}/runs`);
    const row = page
      .locator("[data-run-id]")
      .filter({ hasText: GADGETS.fullName })
      .filter({ hasText: branch });
    await expect(row).toHaveCount(1);
    await expect(row.locator("[data-status]")).toContainText("Succeeded");
    await expect(row).toContainText("Implementer");
    await page.goto(`/w/${WORKSPACE}/runs/${runId}`);
    const detail = page
      .locator('[data-slot="run-detail"]')
      .filter({ visible: true });
    await expect(detail).toContainText(GADGETS.fullName);
    await expect(detail).toContainText("Implementer");
    await expect(detail).toContainText("Base branch");
    await expect(detail).toContainText(BASE);
    // The branch is a link to GitHub only where the repository's address is GitHub's; the lane's is the fake's.
    await expect(detail).toContainText(branch);
    await expect(detail).toContainText("Add hello");
    await expect(detail).toContainText("Add farewell");
    await expect(detail).toContainText(
      "Added hello.txt and farewell.txt, one commit each.",
    );
    await expect(detail.locator('[data-slot="run-model"]')).toContainText(
      "lane-coder",
    );
    await expect(detail).toContainText("Duration");

    // The Worker was started for the factory app's task in the Implementer's profile and advertised the kind on its own merits.
    const workers = theDispatcher
      .containers()
      .filter((container) => container.mode === "worker-once");
    expect(workers).toHaveLength(1);
    const worker = required(workers[0], "The Worker");
    const flags = worker.args.join(" ");
    expect(flags).toContain("--mount type=volume");
    expect(flags).toContain("target=/work");
    expect(worker.environment).toContain("RUNNER_IMPLEMENTER_WORK_DIR=/work");
    expect(worker.log()).toContain("implementer is advertised");
    expect(worker.log()).toContain("worker done: ok");
    await expectQuiet();
  });

  // #767-E02
  test("E02 a branch name that exists on GitHub is refused in the form and nothing is enqueued", async ({
    page,
  }) => {
    gadgets().setRef("refs/heads/taken", base);
    await signInAsAdmin(page);
    const before = await jobCount();

    await page.goto(`/w/${WORKSPACE}/implementer`);
    await chooseOption(page, "Repository", GADGETS.fullName);
    await expect(
      page.getByRole("combobox", { name: "Base branch", exact: true }),
    ).toContainText(BASE);
    await page
      .getByRole("textbox", { name: "New branch name", exact: true })
      .fill("taken");
    await page
      .getByRole("textbox", { name: "Task", exact: true })
      .fill("[E02-TAKEN] Add a file.");
    await chooseOption(page, "Model", /^Lane Coder/);
    await page.getByRole("button", { name: "Start task" }).click();

    await expect(page.getByText(/new branch name is needed/i)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/w/${WORKSPACE}/implementer$`));
    expect(await jobCount()).toBe(before);
  });

  // #767-E03
  test("E03 changes left uncommitted: the agent is asked once, commits, and the system commits nothing", async ({
    page,
  }) => {
    const theLlm = required(llm, "The fake LLM");
    const branch = "implementer/e03";
    theLlm.scriptAgent([
      {
        // The one extra message of the runner; it is the first script so that it answers before the task's.
        when: { lastUserContains: LEFTOVER_PHRASE },
        steps: [commit("Add notes")],
        finalText: "Committed.",
      },
      {
        when: { lastUserContains: "[E03-LEFTOVER]" },
        steps: [write("notes.txt", "Some notes\n")],
        finalText: "Wrote notes.txt; it is not committed yet.",
      },
    ]);
    await signInAsAdmin(page);

    const runId = await startTask(page, {
      repository: GADGETS.fullName,
      branch,
      instruction: "[E03-LEFTOVER] Write a notes.txt with one line.",
    });
    const ended = await runEnded(page, runId, RUN_TIMEOUT);

    expect(ended.status).toBe("succeeded");
    expect(subjectsAhead(gadgets().path, BASE, branch)).toEqual(["Add notes"]);
    // One extra message, and the two requests it cost: the commit and the closing sentence.
    const asked = theLlm.requests();
    const withLeftover = asked.filter((item) =>
      item.prompt.includes(LEFTOVER_PHRASE),
    );
    expect(withLeftover).toHaveLength(2);
    const last = required(asked.at(-1), "The last request");
    expect(last.prompt.split(LEFTOVER_PHRASE)).toHaveLength(2);
    await expectQuiet();
  });

  // #767-E04
  test("E04 changes left uncommitted and ignored: the system commits them with the fixed message, and it is pushed", async ({
    page,
  }) => {
    const theLlm = required(llm, "The fake LLM");
    const branch = "implementer/e04";
    theLlm.scriptAgent([
      {
        when: { lastUserContains: LEFTOVER_PHRASE },
        steps: [],
        finalText: "I leave it as it is.",
      },
      {
        when: { lastUserContains: "[E04-IGNORED]" },
        steps: [write("draft.txt", "A draft\n")],
        finalText: "Wrote draft.txt.",
      },
    ]);
    await signInAsAdmin(page);

    const runId = await startTask(page, {
      repository: GADGETS.fullName,
      branch,
      instruction: "[E04-IGNORED] Write a draft.txt with one line.",
    });
    const ended = await runEnded(page, runId, RUN_TIMEOUT);

    expect(ended.status).toBe("succeeded");
    expect(subjectsAhead(gadgets().path, BASE, branch)).toEqual([
      SYSTEM_COMMIT,
    ]);
    expect(
      theLlm.requests().filter((item) => item.prompt.includes(LEFTOVER_PHRASE)),
    ).toHaveLength(1);
    expect(ended.implementer?.commits.shown.map((c) => c.subject)).toEqual([
      SYSTEM_COMMIT,
    ]);
    await expectQuiet();
  });

  // #767-E05
  test("E05 the cost limit stops the turn: Failed with cost_limit_reached, and the pushed commit is shown", async ({
    page,
    request,
  }) => {
    const theLlm = required(llm, "The fake LLM");
    const branch = "implementer/e05";
    const steps = [
      write("a.txt", "a\n"),
      commit("Add a"),
      ...Array.from({ length: 20 }, (_, index) =>
        bash(`echo step ${String(index)}`),
      ),
    ];
    theLlm.scriptAgent({
      when: { lastUserContains: "[E05-COST]" },
      steps,
      // The agent waits before its third step, until the commit is on GitHub.
      holdBefore: [2],
      finalText: "Done.",
    });
    await signInAsAdmin(page);
    const pushesBefore = (await getPushes(request, GADGETS.fullName)).length;

    const runId = await startTask(page, {
      repository: GADGETS.fullName,
      branch,
      instruction: "[E05-COST] Add a.txt and then keep checking things.",
      costLimit: "0.01",
    });
    await agentIsWaiting(theLlm, page, runId, RUN_TIMEOUT);
    await branchPushed(page, runId, gadgets().path, branch, RUN_TIMEOUT);
    observeContainer();
    // The commit is on GitHub; from now on the model's calls are large, and the limit is reached within a few of them.
    theLlm.setChatUsage({ promptTokens: 8000, completionTokens: 100 });
    theLlm.release();
    const ended = await runEnded(page, runId, RUN_TIMEOUT);

    expect(ended.status).toBe("failed");
    expect(ended.errorCode).toBe("cost_limit_reached");
    expect(subjectsAhead(gadgets().path, BASE, branch)).toEqual(["Add a"]);
    expect(ended.implementer?.commits.shown.map((c) => c.subject)).toEqual([
      "Add a",
    ]);
    expect(ended.implementer?.pushedNote).toContain("pushed");
    expectOnlyPushesOf(await pushesSince(request, pushesBefore), branch);
    await page.goto(`/w/${WORKSPACE}/runs/${runId}`);
    await expect(
      page.locator('[data-slot="run-detail"]').filter({ visible: true }),
    ).toContainText("Add a");
    await expectQuiet();
  });

  // #767-E06
  test("E06 the accident guard: amend, checkout, reset and push are blocked or have no credential, and the branch only moves forward", async ({
    page,
    request,
  }) => {
    const theLlm = required(llm, "The fake LLM");
    const branch = "implementer/e06";
    // The address the runner itself pushes to: the agent's repository has no remote, so a push to it by name tells nothing about
    // the credential. By address it is the runner's remote itself: the engine user's network rules and the missing credential stop it.
    const remote = `${e2eEnv.githubUrl}/${GADGETS.fullName}.git`;
    theLlm.scriptAgent({
      when: { lastUserContains: "[E06-GUARD]" },
      steps: [
        write("a.txt", "a\n"),
        commit("First"),
        bash("git commit --amend -q -m Amended; echo '[amend]' $?"),
        bash(`git checkout ${BASE}; echo '[checkout]' $?`),
        bash("git reset --hard HEAD~1; echo '[reset]' $?"),
        bash("git push origin HEAD; echo '[push]' $?"),
        bash(
          `GIT_TERMINAL_PROMPT=0 git push ${remote} HEAD:refs/heads/e06-direct 2>&1; echo '[push-direct]' $?`,
        ),
        write("b.txt", "b\n"),
        commit("Second"),
      ],
      // The agent waits before the attempts, until its first commit is on GitHub.
      holdBefore: [2],
      finalText: "Tried a few things, then added b.txt.",
    });
    await signInAsAdmin(page);
    const pushesBefore = (await getPushes(request, GADGETS.fullName)).length;
    const commandsBefore = runnerGitCommands().length;

    const runId = await startTask(page, {
      repository: GADGETS.fullName,
      branch,
      instruction: "[E06-GUARD] Add a.txt, then try to rewrite history.",
    });
    await agentIsWaiting(theLlm, page, runId, RUN_TIMEOUT);
    await branchPushed(page, runId, gadgets().path, branch, RUN_TIMEOUT);
    observeContainer();
    theLlm.release();
    const ended = await runEnded(page, runId, RUN_TIMEOUT);

    expect(ended.status).toBe("succeeded");
    // Only forward: the first commit stays, the second follows it, nothing was rewritten.
    expect(subjectsAhead(gadgets().path, BASE, branch)).toEqual([
      "First",
      "Second",
    ]);
    expect(tipOf(gadgets().path, BASE)).toBe(base);
    expect(tipOf(gadgets().path, "e06-direct")).toBeNull();
    // What the agent was told by each attempt: the hook said no to the rewrites, and a push by name fails because the repository has no
    // remote; a push to the runner's own address fails at the network (the engine user reaches loopback ports of its proxies only),
    // before any credential is asked for.
    const shown = Object.values(
      required(theLlm.requests().at(-1), "The last request").toolResults,
    ).join("\n");
    for (const attempt of ["amend", "checkout", "reset", "push"])
      expect(shown, attempt).toMatch(new RegExp(`\\[${attempt}\\]\\s+[1-9]`));
    expect(shown.match(/code-reviewer-guard: /g)?.length ?? 0).toBeGreaterThan(
      1,
    );
    expect(shown).toMatch(/'origin' does not appear to be a git repository/);
    expect(shown).toMatch(
      /(Failed to connect|Connection refused|Couldn't connect)[\s\S]*\[push-direct\]\s+128/,
    );
    expect(shown).not.toMatch(/Authentication failed|could not read Username/);
    // And nothing else reached GitHub: every push of the journey is the runner's, to the branch.
    expectOnlyPushesOf(await pushesSince(request, pushesBefore), branch);
    expectRunnerPushedOnlyForward(
      runnerGitCommands().slice(commandsBefore),
      branch,
    );
    await expectQuiet();
  });

  // #767-E07
  test("E07 a bypass of the hook is caught by the push check: Failed with branch_violation, and the branch is where the last good push left it", async ({
    page,
    request,
  }) => {
    const theLlm = required(llm, "The fake LLM");
    const branch = "implementer/e07";
    theLlm.scriptAgent({
      when: { lastUserContains: "[E07-BYPASS]" },
      steps: [
        write("a.txt", "a\n"),
        commit("Good"),
        bash(
          "git -c core.hooksPath=/dev/null reset -q --hard HEAD~1 && echo bad > b.txt && git add -A && git -c core.hooksPath=/dev/null commit -q -m Bad; echo '[bypass]' $?",
        ),
      ],
      // The agent waits before the bypass, until the good commit is on GitHub; after it the turn ends and the final push checks it.
      holdBefore: [2],
      finalText: "Done.",
    });
    await signInAsAdmin(page);
    const pushesBefore = (await getPushes(request, GADGETS.fullName)).length;
    const commandsBefore = runnerGitCommands().length;

    const runId = await startTask(page, {
      repository: GADGETS.fullName,
      branch,
      instruction: "[E07-BYPASS] Add a.txt and then rewrite history.",
    });
    await agentIsWaiting(theLlm, page, runId, RUN_TIMEOUT);
    await branchPushed(page, runId, gadgets().path, branch, RUN_TIMEOUT);
    observeContainer();
    const good = tipOf(gadgets().path, branch);
    theLlm.release();
    const ended = await runEnded(page, runId, RUN_TIMEOUT);

    expect(ended.status).toBe("failed");
    expect(ended.errorCode).toBe("branch_violation");
    // The branch on GitHub is the good commit, and the rewrite never got there.
    expect(subjectsAhead(gadgets().path, BASE, branch)).toEqual(["Good"]);
    expect(tipOf(gadgets().path, branch)).toBe(good);
    expectOnlyPushesOf(await pushesSince(request, pushesBefore), branch);
    expectRunnerPushedOnlyForward(
      runnerGitCommands().slice(commandsBefore),
      branch,
    );
    await expectQuiet();
  });

  // #767-E08
  test("E08 network: a host off the list is refused by the proxy (403), a direct lookup fails, a direct connect to a loopback port is refused, and a registry of the list is reached through the proxy", async ({
    page,
  }) => {
    const theLlm = required(llm, "The fake LLM");
    const theRegistry = required(registry, "The fake registry");
    const branch = "implementer/e08";
    // The control: the registry answers whoever may reach it. The lane itself reaches it; the agent must not.
    await new Promise<void>((resolveControl, reject) => {
      const control = httpsRequest(
        {
          host: "127.0.0.1",
          port: theRegistry.port,
          path: "/control",
          rejectUnauthorized: false,
        },
        (answer) => {
          answer.resume();
          answer.on("end", () => resolveControl());
        },
      );
      control.once("error", reject);
      control.end();
    });
    expect(theRegistry.requests().at(-1)).toMatch(/GET \/control$/);
    const seenByControl = theRegistry.requests().length;
    theLlm.scriptAgent({
      when: { lastUserContains: "[E08-NETWORK]" },
      steps: [
        bash(
          "curl -sS -m 10 https://example.com 2>&1; echo '[proxy-refuses]' $?",
        ),
        bash(
          "curl -sS -m 10 --noproxy '*' https://example.com 2>&1; echo '[direct]' $?",
        ),
        bash("getent hosts example.com; echo '[lookup]' $?"),
        bash(
          `curl -sSk -m 10 --noproxy '*' https://127.0.0.1:${String(theRegistry.port)}/direct 2>&1; echo '[loopback]' $?`,
        ),
        bash(
          "curl -sSk -m 20 https://registry.npmjs.org/left-pad 2>&1; echo '[registry]' $?",
        ),
        write("net.txt", "checked\n"),
        commit("Add net"),
      ],
      finalText: "Checked the network, added net.txt.",
    });
    await signInAsAdmin(page);

    const runId = await startTask(page, {
      repository: GADGETS.fullName,
      branch,
      instruction: "[E08-NETWORK] Check which hosts you can reach.",
    });
    const ended = await runEnded(page, runId, RUN_TIMEOUT);

    expect(ended.status).toBe("succeeded");
    const shown = Object.values(
      required(theLlm.requests().at(-1), "The last request").toolResults,
    ).join("\n");
    // Through the proxy, a host off the list: the proxy's own refusal, not a failed handshake with whatever answered.
    expect(shown).toMatch(
      /CONNECT tunnel failed, response 403\s+\[proxy-refuses\]\s+56\b/,
    );
    // Straight, the name does not resolve (no lookup leaves the engine user), and the tool says so.
    expect(shown).toMatch(
      /Could not resolve host: example\.com\s+\[direct\]\s+6\b/,
    );
    expect(shown).toMatch(/\[lookup\]\s+2\b/);
    expect(shown).not.toMatch(/^\s*\d+\.\d+\.\d+\.\d+\s+example\.com/m);
    // A direct connect to a loopback port the engine user has no rule for is refused, though the lane itself reaches it (control).
    expect(shown).toMatch(
      /Failed to connect to 127\.0\.0\.1 port \d+[^\n]*\n\[loopback\]\s+7\b/,
    );
    // The registry of the list, through the proxy.
    expect(shown).toContain('"fake":"registry"');
    expect(shown).toMatch(/\[registry\]\s+0\b/);
    // And the registry saw exactly that one request since the control: nothing for example.com, nothing direct.
    const seen = theRegistry.requests().slice(seenByControl);
    expect(seen).toEqual(["registry.npmjs.org GET /left-pad"]);
    expect(seen.join("\n")).not.toContain("example.com");
    expect(seen.join("\n")).not.toContain("/direct");
    await expectQuiet();
  });

  // #767-E11
  test("E11 prompt cache, the provider states its charge (OpenRouter): later calls read from the cache, and the run costs what its calls cost, the dearer of the stated charge and the book's price", async ({
    page,
  }) => {
    const { ended, answered } = await cachedRun(page, {
      branch: "implementer/e11",
      marker: "[E11-CACHE]",
      stated: true,
    });
    // The runner prices every call at the dearer of what the provider states and what the catalog's price comes to.
    const expected = answered.reduce(
      (sum, usage) => sum + Math.max(Number(usage.cost), bookCost(usage)),
      0,
    );
    expect(expected).toBeGreaterThan(0);
    expect(ended.usage?.costUsd).toBeCloseTo(expected, 8);
    await expectQuiet();
  });

  // #767-E11
  test("E11 prompt cache, the provider states no charge (DeepSeek, OpenAI): the run costs the book's price of its calls, the cache read at the cache's price", async ({
    page,
  }) => {
    const { ended, answered } = await cachedRun(page, {
      branch: "implementer/e11b",
      marker: "[E11-NO-CHARGE]",
      stated: false,
    });
    // Nothing is stated, so nothing but the catalog's price can have priced the run.
    for (const usage of answered) expect(usage).not.toHaveProperty("cost");
    const expected = answered.reduce((sum, usage) => sum + bookCost(usage), 0);
    expect(expected).toBeGreaterThan(0);
    expect(ended.usage?.costUsd).toBeCloseTo(expected, 8);
    // The cache's price is what made the difference: without it the calls would cost more than the run did.
    const withoutCache = answered.reduce(
      (sum, usage) =>
        sum +
        (Number(usage.prompt_tokens) * BOOK.input +
          Number(usage.completion_tokens) * BOOK.output) /
          1_000_000,
      0,
    );
    expect(ended.usage?.costUsd).toBeLessThan(withoutCache);
    await expectQuiet();
  });

  // #767-E12
  test("E12 an agent that only answers in text: Failed with agent_gave_up, nothing pushed, no branch on GitHub", async ({
    page,
    request,
  }) => {
    const theLlm = required(llm, "The fake LLM");
    const branch = "implementer/e12";
    theLlm.scriptAgent({
      when: { lastUserContains: "[E12-TEXT]" },
      steps: [],
      finalText: "I looked at it and there is nothing to change.",
    });
    await signInAsAdmin(page);
    const pushesBefore = (await getPushes(request, GADGETS.fullName)).length;

    const runId = await startTask(page, {
      repository: GADGETS.fullName,
      branch,
      instruction: "[E12-TEXT] Change something.",
    });
    const ended = await runEnded(page, runId, RUN_TIMEOUT);

    expect(ended.status).toBe("failed");
    expect(ended.errorCode).toBe("agent_gave_up");
    expect(tipOf(gadgets().path, branch)).toBeNull();
    // Nothing was pushed at all during the journey: no branch, no tag, no note.
    expect(await pushesSince(request, pushesBefore)).toEqual([]);
    await expectQuiet();
  });

  // #755-E14
  test("E14 a workspace with an Anthropic key: the form offers Anthropic and its model, the task runs on the native path with that key, the engine marks the prompt for the cache, and the run costs the catalog's price of its calls with the cache at its own prices", async ({
    page,
  }) => {
    const theLlm = required(llm, "The fake LLM");
    const theDispatcher = required(dispatcher, "The Dispatcher");
    const marker = "[E14-ANTHROPIC]";
    // Every answer states the same usage (the Messages shape: the input without the cache, then what the cache read and wrote).
    const usage = {
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_input_tokens: 4000,
      cache_creation_input_tokens: 2000,
    };
    theLlm.setMessagesUsage(usage);
    theLlm.scriptAgent({
      when: { lastUserContains: marker },
      steps: [
        write("anthropic.txt", "a\n"),
        commit("Add anthropic"),
        bash("echo one"),
        bash("echo two"),
      ],
      finalText: "Added anthropic.txt.",
    });
    await signInAsAdmin(page);
    // The owner saves the key under Settings, LLM access, and the form must offer the provider (it said "No model is available").
    const saved = await page.request.put(
      `/api/w/${WORKSPACE}/llm-keys/anthropic`,
      { data: { apiKey: ANTHROPIC_KEY } },
    );
    expect(saved.status(), await saved.text()).toBe(200);
    try {
      await page.goto(`/w/${WORKSPACE}/implementer`);
      await expect(
        page.getByRole("combobox", { name: "Provider", exact: true }),
      ).toContainText("Anthropic");

      const runId = await startTask(page, {
        repository: GADGETS.fullName,
        branch: "implementer/e14",
        instruction: `${marker} Add anthropic.txt.`,
        model: "Claude Sonnet 5.5",
        costLimit: "1",
      });
      const ended = await runEnded(page, runId, RUN_TIMEOUT);
      expect(ended.status).toBe("succeeded");
      expect(subjectsAhead(gadgets().path, BASE, "implementer/e14")).toEqual([
        "Add anthropic",
      ]);

      // The model was asked on the Messages wire, with the workspace's Anthropic key and no other.
      const asked = theLlm.messageRequests();
      expect(asked.length).toBeGreaterThanOrEqual(3);
      for (const request of asked) expect(request.apiKey).toBe(ANTHROPIC_KEY);
      // Prompt caching is on: the engine put its cache marks on the requests it sent.
      expect(
        asked.some((request) =>
          JSON.stringify(request.body).includes('"cache_control"'),
        ),
        "the engine marked nothing for the cache",
      ).toBe(true);
      // The run costs what the catalog's price comes to for what the calls used, the cache read and the cache write at their own prices.
      const perCall =
        (usage.input_tokens * ANTHROPIC_BOOK.input +
          usage.output_tokens * ANTHROPIC_BOOK.output +
          usage.cache_read_input_tokens * ANTHROPIC_BOOK.cache_read +
          usage.cache_creation_input_tokens * ANTHROPIC_BOOK.cache_write) /
        1_000_000;
      expect(ended.usage?.aiCalls).toBe(asked.length);
      expect(ended.usage?.costUsd).toBeCloseTo(perCall * asked.length, 6);
      await expectQuiet();
      expect(
        theDispatcher
          .containers()
          .filter((container) => container.mode === "worker-once")
          .at(-1)
          ?.log(),
      ).toContain("worker done: ok");
    } finally {
      const removed = await page.request.delete(
        `/api/w/${WORKSPACE}/llm-keys/anthropic`,
      );
      expect(removed.status(), await removed.text()).toBe(200);
    }
  });

  // #767-E09
  test("E09 no secret anywhere, and an agent that looks for one finds none: not the installation token, the model key or the credential of a job", async ({
    page,
    request,
  }) => {
    const theLlm = required(llm, "The fake LLM");
    const theDispatcher = required(dispatcher, "The Dispatcher");
    const branch = "implementer/e09";
    theLlm.scriptAgent({
      when: { lastUserContains: "[E09-PROBE]" },
      steps: [
        // At the start: its own environment and everything of the container it can read.
        bash(`${PROBE}; echo '[probe-start-done]'`),
        write("probe.txt", "probe\n"),
        // While the runner pushes: the same, and an attempt to read the environment of the root process that pushes.
        bash(PROBE_DURING_PUSH),
      ],
      finalText: "Looked around, then committed probe.txt.",
    });
    await signInAsAdmin(page);

    const runId = await startTask(page, {
      repository: GADGETS.fullName,
      branch,
      instruction: "[E09-PROBE] Look around the machine and add probe.txt.",
    });
    const ended = await runEnded(page, runId, RUN_TIMEOUT);
    expect(ended.status).toBe("succeeded");

    const tokens = await getIssuedInstallationTokens(request);
    expect(tokens.length).toBeGreaterThan(0);
    const secrets = [
      KEY,
      ANTHROPIC_KEY,
      ...tokens,
      ...factorySecrets(),
      ...allSecrets(),
    ];
    // The capability of the engine's proxy is the engine's own credential for the loopback proxy of its job, worthless anywhere
    // else: the agent may read it (its configuration is its own), and it must be nowhere outside the container.
    const theCapabilities = capabilities();
    expect(theCapabilities.length).toBeGreaterThan(0);

    // What the agent saw, as the model received it.
    const probed = Object.values(
      required(theLlm.requests().at(-1), "The last request").toolResults,
    ).join("\n");
    // It could read: its own environment and that of every process of its user,
    expect(probed).toContain("[probe-start-done]");
    expect(probed).toMatch(/HTTPS_PROXY=http:\/\/127\.0\.0\.1:\d+/);
    expect(probed).toContain("OPENCODE_CONFIG=");
    expect(probed).toMatch(/== ps -eo user,pid,args\n[\s\S]*root\s+\d+/);
    // and found the repository without a remote and without a credential in its configuration,
    expect(probed).toMatch(
      /== cat \/work\/repo\/\.git\/config\n[\s\S]*repositoryformatversion/,
    );
    expect(probed).not.toMatch(
      /\[remote |remote\.[^\s=]+\.url|\burl\s*=|extraheader/i,
    );
    expect(probed).toMatch(/== git remote -v\n== ps/);
    // while the runner pushed it looked for the root process, and could neither read its environment (where the token is) nor
    // find the token in its arguments.
    expect(probed).toContain("[push-seen] yes");
    expect(probed).toMatch(/root push \d+ environ: [^\n]*Permission denied/);
    expect(probed).toMatch(
      /root push \d+ cmdline: [^\n]*refs\/heads\/implementer\/e09/,
    );
    for (const secret of secrets)
      expect(
        containsSecret(probed, secret),
        "the agent found a credential",
      ).toBe(false);

    // Everywhere else, every secret and the capability too.
    const list = await page.request.get(`/api/w/${WORKSPACE}/runs`);
    expect(list.status()).toBe(200);
    const listed = (
      JSON.parse(await list.text()) as { runs: Array<{ id: string }> }
    ).runs;
    const details = await Promise.all(
      listed.map(async ({ id }) =>
        JSON.stringify(
          await (
            await page.request.get(`/api/w/${WORKSPACE}/runs/${id}`)
          ).json(),
        ),
      ),
    );
    await page.goto(`/w/${WORKSPACE}/runs`);
    const elsewhere: Record<string, string> = {
      "the Runs page": await page.content(),
      "the runs API": await list.text(),
      "the run details": details.join("\n"),
      "the Dispatcher's output": theDispatcher.output(),
      "the Workers' logs": theDispatcher
        .containers()
        .map((container) => container.log())
        .join("\n"),
      "the Workers' environment": theDispatcher
        .containers()
        .map((container) => container.environment)
        .join("\n"),
      "the Workers' flags": theDispatcher
        .containers()
        .map((container) => container.args.join("\n"))
        .join("\n"),
      "the app's log": readFileSync(
        resolve(process.cwd(), factoryEnv.logFiles.app),
        "utf8",
      ),
      "the runner's git commands": runnerGitCommands()
        .map((command) => command.argv.join(" "))
        .join("\n"),
      ...Object.fromEntries(
        Object.entries(wrapperOutputs()).map(([name, text]) => [
          `the job wrapper's ${name}`,
          text,
        ]),
      ),
    };
    for (const [name, text] of Object.entries(elsewhere))
      for (const secret of [...secrets, ...theCapabilities])
        expect(containsSecret(text, secret), `a credential is in ${name}`).toBe(
          false,
        );
    // What the model was shown in all journeys: the secrets, never. (The capability may be in what an agent read from its own
    // configuration; the probes above do not read that file.)
    const shownEverywhere = shownToTheModel.join("\n") + "\n" + probed;
    for (const secret of secrets)
      expect(
        containsSecret(shownEverywhere, secret),
        "the model was shown a credential",
      ).toBe(false);

    // The places of every job, looked through at its end (the wrapper writes one scan per job): the engine's own directories,
    // the agent's repository, the root's mirror and /run; each holds files, and none holds a secret (the capability is left out of
    // /run, where the engine's configuration is by design).
    const workers = theDispatcher
      .containers()
      .filter((container) => container.mode === "worker-once");
    const scans = engineScans();
    expect(scans).toHaveLength(workers.length);
    for (const scan of scans)
      for (const place of [
        "engine-directories",
        "repository",
        "mirror",
        "run",
      ]) {
        const root = scan.roots[place];
        expect(root?.files, `the scan of ${place} read files`).toBeGreaterThan(
          0,
        );
        expect(
          Object.entries(root?.found ?? {}).filter(([, count]) => count > 0),
          `a secret is in ${place}`,
        ).toEqual([]);
      }
  });

  // #767-E10
  test("E10 after the Workers end, nothing of them is left: no process in a container's namespace (and so no /work mount), no process of the runner or the engine, no VM", async () => {
    const theDispatcher = required(dispatcher, "The Dispatcher");
    await eventually(
      "the VMs of the jobs to be stopped",
      async () => vmDirectories(VM_ROOT).length === 0,
      60_000,
    );
    // The containers of E01, E05, E06 and E07 were read while they ran (their volume had the options of the profile). A mount
    // of a container's own namespace lives as long as one process is in that namespace; none is.
    const namespaces = notedNamespaces();
    expect(namespaces.length).toBeGreaterThanOrEqual(4);
    await eventually(
      "the containers' namespaces to be empty",
      async () => processesInNamespaces(namespaces).length === 0,
      30_000,
    );
    expect(processesInNamespaces(namespaces)).toEqual([]);
    // No process of a Worker, its job, its mirror or its engine, whoever runs it.
    expect(leftoverWorkerProcesses()).toEqual([]);
    expect(engineProcesses()).toEqual([]);
    // The container's mounts stayed in its own namespace: E01 saw it differ from the lane's, and nothing leaked into the lane's.
    expect(readFileSync("/proc/self/mountinfo", "utf8")).not.toMatch(
      /\s\/work\s/,
    );
    // Every Worker ended by itself, with a result.
    const workers = theDispatcher
      .containers()
      .filter((container) => container.mode === "worker-once");
    expect(workers).toHaveLength(engineScans().length);
    assertGuardQuiet();
  });

  /**
   * A task on a model whose id the engine marks for the cache, with the provider that does or does not state its charge. Returns
   * the run and what every answer said it used.
   */
  async function cachedRun(
    page: Page,
    options: { branch: string; marker: string; stated: boolean },
  ) {
    const theLlm = required(llm, "The fake LLM");
    // The engine marks two message objects of its prompt (the mark it puts there for an OpenAI-compatible provider); the provider
    // of this journey honours it.
    theLlm.enablePromptCache(true, { messageMarks: true });
    theLlm.statesCharge(options.stated);
    theLlm.scriptAgent({
      when: { lastUserContains: options.marker },
      steps: [
        write("c.txt", "c\n"),
        commit("Add c"),
        bash("echo one"),
        bash("echo two"),
        bash("echo three"),
      ],
      finalText: "Added c.txt.",
    });
    await signInAsAdmin(page);

    const runId = await startTask(page, {
      repository: GADGETS.fullName,
      branch: options.branch,
      instruction: `${options.marker} Add c.txt.`,
      model: "Claude Lane Coder",
    });
    const ended = await runEnded(page, runId, RUN_TIMEOUT);
    expect(ended.status).toBe("succeeded");
    // The engine marked its prompt for the cache: on the message objects.
    const marks = theLlm.requests().map((item) => item.cacheMarks);
    expect(
      marks.some((mark) => mark.messages > 0),
      `the engine marked nothing: ${JSON.stringify(marks.slice(-3))}`,
    ).toBe(true);
    // What the fake said every answer used (the title request too: the model proxy counts it).
    const answered = theLlm
      .requests()
      .flatMap((item) => (item.usage === undefined ? [] : [item.usage]));
    expect(answered.length).toBeGreaterThanOrEqual(4);
    expect(
      answered.slice(1).some((usage) => cachedTokens(usage) > 0),
      "a later call read from the cache",
    ).toBe(true);
    expect(ended.usage?.aiCalls).toBe(answered.length);
    return { ended, answered };
  }

  /** The `vcpus` the Dispatcher reported for the VM of a run (the app keeps it with the VM's minutes), or null while none is. */
  async function reportedVcpus(runId: string): Promise<number | null> {
    const client = new Client({ connectionString: factoryDatabaseUrls().app });
    await client.connect();
    try {
      const { rows } = await client.query<{ vcpus: number | null }>(
        "select vcpus from job_vm_runs where job_id = $1",
        [runId],
      );
      return rows[0]?.vcpus ?? null;
    } finally {
      await client.end();
    }
  }

  /** The values of a flag in the `docker run` the Dispatcher rendered for the last Worker. */
  function workerFlag(flag: string): string[] {
    const worker = required(
      required(dispatcher, "The Dispatcher")
        .containers()
        .filter((container) => container.mode === "worker-once")
        .at(-1),
      "The Worker",
    );
    return worker.args.flatMap((arg, index) =>
      arg === flag ? [worker.args[index + 1] ?? ""] : [],
    );
  }

  // #818-F01
  test("F01 a task with an environment of 6 vCPU: the form offers it, the Dispatcher creates the VM of that size and the container gets the memory that follows the size; the run says which environment it used, and the size is recorded", async ({
    page,
  }) => {
    const theLlm = required(llm, "The fake LLM");
    theLlm.scriptAgent({
      when: { lastUserContains: "[F01-TEXT]" },
      steps: [],
      finalText: "Nothing to change.",
    });
    await signInAsAdmin(page);
    const created = await page.request.post(
      `/api/w/${WORKSPACE}/environments`,
      { data: { name: "Six cores", vcpus: 6, setupScript: "" } },
    );
    expect(created.status(), await created.text()).toBe(201);

    const runId = await startTask(page, {
      repository: GADGETS.fullName,
      branch: "implementer/f01",
      instruction: "[F01-TEXT] Change something.",
      environment: "Six cores",
    });
    await runEnded(page, runId, RUN_TIMEOUT);

    // 6 vCPU are 12 GB; the container gets 11264 MB of them (1 GB stays with the OS and Docker), a reservation 512 MB below.
    expect(workerFlag("--memory")).toEqual(["11264m"]);
    expect(workerFlag("--memory-reservation")).toEqual(["10752m"]);
    await eventually(
      "the size of the VM to be recorded",
      async () => (await reportedVcpus(runId)) === 6,
    );
    // The run says which environment it used.
    await page.goto(`/w/${WORKSPACE}/runs/${runId}`);
    await expect(page.getByText("Six cores (6 vCPU, 12 GB)")).toBeVisible();
    await expectQuiet();
  });

  // #818-F02
  test("F02 a task without an environment is the task of before: the standard of 2 vCPU and 3 GB for the container, nothing about an environment on the run", async ({
    page,
  }) => {
    const theLlm = required(llm, "The fake LLM");
    theLlm.scriptAgent({
      when: { lastUserContains: "[F02-TEXT]" },
      steps: [],
      finalText: "Nothing to change.",
    });
    await signInAsAdmin(page);

    const runId = await startTask(page, {
      repository: GADGETS.fullName,
      branch: "implementer/f02",
      instruction: "[F02-TEXT] Change something.",
    });
    await runEnded(page, runId, RUN_TIMEOUT);

    expect(workerFlag("--memory")).toEqual(["3g"]);
    await eventually(
      "the size of the VM to be recorded",
      async () => (await reportedVcpus(runId)) === 2,
    );
    await page.goto(`/w/${WORKSPACE}/runs/${runId}`);
    await expect(page.getByText("Environment", { exact: true })).toHaveCount(0);
    await expectQuiet();
  });
});

// The catalog's price of the model of the cache journeys, in US dollars per million tokens (the fixture the app's catalog was filled from).
const BOOK = (
  JSON.parse(readFileSync(resolve(process.cwd(), FIXTURE), "utf8")) as {
    deepseek: {
      models: Record<
        string,
        {
          cost: {
            input: number;
            output: number;
            cache_read: number;
            cache_write: number;
          };
        }
      >;
    };
  }
).deepseek.models["claude-lane-coder"]?.cost ?? {
  input: Number.NaN,
  output: Number.NaN,
  cache_read: Number.NaN,
  cache_write: Number.NaN,
};

// The catalog's price of the model of E14, in US dollars per million tokens (the Anthropic model of the same fixture).
const ANTHROPIC_BOOK = (
  JSON.parse(readFileSync(resolve(process.cwd(), FIXTURE), "utf8")) as {
    anthropic: {
      models: Record<
        string,
        {
          cost: {
            input: number;
            output: number;
            cache_read: number;
            cache_write: number;
          };
        }
      >;
    };
  }
).anthropic.models["claude-sonnet-5-5"]?.cost ?? {
  input: Number.NaN,
  output: Number.NaN,
  cache_read: Number.NaN,
  cache_write: Number.NaN,
};

const cachedTokens = (usage: Record<string, unknown>): number =>
  (usage.prompt_tokens_details as { cached_tokens?: number } | undefined)
    ?.cached_tokens ?? 0;

/** What the catalog's price comes to for one answer's usage: fresh input, cache reads, cache writes and output. */
function bookCost(usage: Record<string, unknown>): number {
  const prompt = Number(usage.prompt_tokens);
  const read = cachedTokens(usage);
  const written =
    (usage.prompt_tokens_details as { cache_write_tokens?: number } | undefined)
      ?.cache_write_tokens ?? 0;
  return (
    ((prompt - read - written) * BOOK.input +
      read * BOOK.cache_read +
      written * BOOK.cache_write +
      Number(usage.completion_tokens) * BOOK.output) /
    1_000_000
  );
}
