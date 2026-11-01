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
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
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
  bash,
  branchPushed,
  capabilities,
  commit,
  commitsAhead,
  engineScans,
  expectOnlyTheOwnBranch,
  expectRunnerPushedOnlyForward,
  JOB_WRAPPER,
  pause,
  prepareRecords,
  runData,
  runEnded,
  runnerGitCommands,
  startFakeRegistry,
  startTask,
  subjectsAhead,
  tipOf,
  vmDirectories,
  WORKSPACE,
  write,
  GIT_COMMANDS,
  keepRecords,
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
  const runs: string[] = [];
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
        // The push loop looks every two seconds: the first commit is on GitHub while the turn goes on.
        pause(8),
        write("farewell.txt", "Goodbye\n"),
        commit("Add farewell"),
      ],
      finalText: "Added hello.txt and farewell.txt, one commit each.",
    });
    await signInAsAdmin(page);

    const runId = await startTask(page, {
      repository: GADGETS.fullName,
      branch,
      instruction,
    });
    runs.push(runId);

    // During the turn: the first commit is on the branch at the fake GitHub while the run is still running.
    await branchPushed(page, runId, gadgets().path, branch, RUN_TIMEOUT);
    expect(subjectsAhead(gadgets().path, BASE, branch)).toEqual(["Add hello"]);
    expect((await runData(page, runId)).status).toBe("running");

    const ended = await runEnded(page, runId, RUN_TIMEOUT);
    expect(ended.status).toBe("succeeded");

    // At the end: both commits, in order, and the base branch never moved.
    expect(subjectsAhead(gadgets().path, BASE, branch)).toEqual([
      "Add hello",
      "Add farewell",
    ]);
    expect(tipOf(gadgets().path, BASE)).toBe(base);
    expect(commitsAhead(gadgets().path, BASE, branch)).toHaveLength(2);
    const pushes = await getPushes(request, GADGETS.fullName);
    expect(pushes.length).toBeGreaterThanOrEqual(2);
    expectOnlyTheOwnBranch(pushes, branch);
    expectRunnerPushedOnlyForward(runnerGitCommands(), branch);
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
    runs.push(runId);
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
    runs.push(runId);
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
  }) => {
    const theLlm = required(llm, "The fake LLM");
    const branch = "implementer/e05";
    const steps = [
      write("a.txt", "a\n"),
      commit("Add a"),
      pause(8),
      ...Array.from({ length: 20 }, (_, index) =>
        bash(`echo step ${String(index)}`),
      ),
    ];
    theLlm.scriptAgent({
      when: { lastUserContains: "[E05-COST]" },
      steps,
      finalText: "Done.",
    });
    await signInAsAdmin(page);

    const runId = await startTask(page, {
      repository: GADGETS.fullName,
      branch,
      instruction: "[E05-COST] Add a.txt and then keep checking things.",
      costLimit: "0.01",
    });
    runs.push(runId);
    // The commit is on GitHub; from now on the model's calls are large, and the limit is reached within a few of them.
    await branchPushed(page, runId, gadgets().path, branch, RUN_TIMEOUT);
    theLlm.setChatUsage({ promptTokens: 8000, completionTokens: 100 });
    const ended = await runEnded(page, runId, RUN_TIMEOUT);

    expect(ended.status).toBe("failed");
    expect(ended.errorCode).toBe("cost_limit_reached");
    expect(subjectsAhead(gadgets().path, BASE, branch)).toEqual(["Add a"]);
    expect(ended.implementer?.commits.shown.map((c) => c.subject)).toEqual([
      "Add a",
    ]);
    expect(ended.implementer?.pushedNote).toContain("pushed");
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
    theLlm.scriptAgent({
      when: { lastUserContains: "[E06-GUARD]" },
      steps: [
        write("a.txt", "a\n"),
        commit("First"),
        pause(8),
        bash("git commit --amend -q -m Amended; echo '[amend]' $?"),
        bash(`git checkout ${BASE}; echo '[checkout]' $?`),
        bash("git reset --hard HEAD~1; echo '[reset]' $?"),
        bash("git push origin HEAD; echo '[push]' $?"),
        write("b.txt", "b\n"),
        commit("Second"),
      ],
      finalText: "Tried a few things, then added b.txt.",
    });
    await signInAsAdmin(page);

    const runId = await startTask(page, {
      repository: GADGETS.fullName,
      branch,
      instruction: "[E06-GUARD] Add a.txt, then try to rewrite history.",
    });
    runs.push(runId);
    const ended = await runEnded(page, runId, RUN_TIMEOUT);

    expect(ended.status).toBe("succeeded");
    // Only forward: the first commit stays, the second follows it, nothing was rewritten.
    expect(subjectsAhead(gadgets().path, BASE, branch)).toEqual([
      "First",
      "Second",
    ]);
    expect(tipOf(gadgets().path, BASE)).toBe(base);
    // What the agent was told by each attempt: the hook said no to the rewrites, and there is no remote to push to.
    const shown = Object.values(
      required(theLlm.requests().at(-1), "The last request").toolResults,
    ).join("\n");
    for (const attempt of ["amend", "checkout", "reset", "push"])
      expect(shown, attempt).toMatch(new RegExp(`\\[${attempt}\\]\\s+[1-9]`));
    expect(shown.match(/code-reviewer-guard: /g)?.length ?? 0).toBeGreaterThan(
      1,
    );
    const pushes = await getPushes(request, GADGETS.fullName);
    expectOnlyTheOwnBranch(
      pushes.filter((entry) => entry.refs.some((ref) => ref.endsWith("e06"))),
      branch,
    );
    expectRunnerPushedOnlyForward(
      runnerGitCommands().filter((command) =>
        command.argv.join(" ").includes("e06"),
      ),
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
        pause(8),
        bash(
          "git -c core.hooksPath=/dev/null reset -q --hard HEAD~1 && echo bad > b.txt && git add -A && git -c core.hooksPath=/dev/null commit -q -m Bad; echo '[bypass]' $?",
        ),
        pause(10),
      ],
      finalText: "Done.",
    });
    await signInAsAdmin(page);

    const runId = await startTask(page, {
      repository: GADGETS.fullName,
      branch,
      instruction: "[E07-BYPASS] Add a.txt and then rewrite history.",
    });
    runs.push(runId);
    const ended = await runEnded(page, runId, RUN_TIMEOUT);

    expect(ended.status).toBe("failed");
    expect(ended.errorCode).toBe("branch_violation");
    // The branch on GitHub is the good commit, and the rewrite never got there.
    expect(subjectsAhead(gadgets().path, BASE, branch)).toEqual(["Good"]);
    const pushes = await getPushes(request, GADGETS.fullName);
    expectOnlyTheOwnBranch(
      pushes.filter((entry) => entry.refs.some((ref) => ref.endsWith("e07"))),
      branch,
    );
    expectRunnerPushedOnlyForward(
      runnerGitCommands().filter((command) =>
        command.argv.join(" ").includes("e07"),
      ),
      branch,
    );
    await expectQuiet();
  });

  // #767-E08
  test("E08 network: curl to a host off the list and a direct lookup fail, a registry of the list is reached through the proxy, nothing leaves loopback", async ({
    page,
  }) => {
    const theLlm = required(llm, "The fake LLM");
    const theRegistry = required(registry, "The fake registry");
    const branch = "implementer/e08";
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
    runs.push(runId);
    const ended = await runEnded(page, runId, RUN_TIMEOUT);

    expect(ended.status).toBe("succeeded");
    const shown = Object.values(
      required(theLlm.requests().at(-1), "The last request").toolResults,
    ).join("\n");
    expect(shown).not.toMatch(/\[proxy-refuses\]\s+0/);
    expect(shown).toMatch(/\[proxy-refuses\]\s+[1-9]/);
    expect(shown).toMatch(/\[direct\]\s+[1-9]/);
    expect(shown).toMatch(/\[lookup\]\s+[1-9]/);
    // The registry of the list answered through the proxy, and only it.
    expect(shown).toContain('"fake":"registry"');
    expect(shown).toMatch(/\[registry\]\s+0/);
    expect(theRegistry.requests()).toEqual([
      "registry.npmjs.org GET /left-pad",
    ]);
    await expectQuiet();
  });

  // #767-E11
  test("E11 prompt cache: the later calls read from the cache, and the cost of the run is the sum of its calls including the cache", async ({
    page,
  }) => {
    const theLlm = required(llm, "The fake LLM");
    const branch = "implementer/e11";
    theLlm.enablePromptCache(true);
    theLlm.scriptAgent({
      when: { lastUserContains: "[E11-CACHE]" },
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
      branch,
      instruction: "[E11-CACHE] Add c.txt.",
      model: "Claude Lane Coder",
    });
    runs.push(runId);
    const ended = await runEnded(page, runId, RUN_TIMEOUT);

    expect(ended.status).toBe("succeeded");
    // What the fake said every answer used (the title request too: the model proxy counts it): fresh input, what was read
    // from the cache, what was written to it, and the output, priced as the catalog prices the model (per million tokens).
    const answered = theLlm
      .requests()
      .flatMap((item) => (item.usage === undefined ? [] : [item.usage]));
    const cached = (usage: Record<string, unknown>) =>
      (usage.prompt_tokens_details as { cached_tokens?: number } | undefined)
        ?.cached_tokens ?? 0;
    const written = (usage: Record<string, unknown>) =>
      (
        usage.prompt_tokens_details as
          { cache_write_tokens?: number } | undefined
      )?.cache_write_tokens ?? 0;
    expect(answered.length).toBeGreaterThanOrEqual(4);
    expect(
      answered.slice(1).some((usage) => cached(usage) > 0),
      "a later call read from the cache",
    ).toBe(true);
    const expectedCost = answered.reduce((sum, usage) => {
      const prompt = Number(usage.prompt_tokens);
      const read = cached(usage);
      const wrote = written(usage);
      return (
        sum +
        ((prompt - read - wrote) * 0.5 +
          read * 0.05 +
          wrote * 0.625 +
          Number(usage.completion_tokens) * 2) /
          1_000_000
      );
    }, 0);
    expect(expectedCost).toBeGreaterThan(0);
    expect(ended.usage?.aiCalls).toBe(answered.length);
    expect(ended.usage?.costUsd).toBeCloseTo(expectedCost, 8);
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

    const runId = await startTask(page, {
      repository: GADGETS.fullName,
      branch,
      instruction: "[E12-TEXT] Change something.",
    });
    runs.push(runId);
    const ended = await runEnded(page, runId, RUN_TIMEOUT);

    expect(ended.status).toBe("failed");
    expect(ended.errorCode).toBe("agent_gave_up");
    expect(tipOf(gadgets().path, branch)).toBeNull();
    const pushes = await getPushes(request, GADGETS.fullName);
    expect(
      pushes.filter((entry) => entry.refs.some((ref) => ref.endsWith("e12"))),
    ).toEqual([]);
    await expectQuiet();
  });

  // #767-E09
  test("E09 no secret anywhere: not the installation token, the model key, the capability or the credential of a job", async ({
    page,
    request,
  }) => {
    const theDispatcher = required(dispatcher, "The Dispatcher");
    await signInAsAdmin(page);
    const tokens = await getIssuedInstallationTokens(request);
    expect(tokens.length).toBeGreaterThan(0);
    const secrets = [
      KEY,
      ...tokens,
      ...capabilities(),
      ...factorySecrets(),
      ...allSecrets(),
    ];
    expect(capabilities().length).toBeGreaterThan(0);

    const list = await page.request.get(`/api/w/${WORKSPACE}/runs`);
    expect(list.status()).toBe(200);
    const details = await Promise.all(
      runs.map(async (id) =>
        JSON.stringify(
          await (
            await page.request.get(`/api/w/${WORKSPACE}/runs/${id}`)
          ).json(),
        ),
      ),
    );
    await page.goto(`/w/${WORKSPACE}/runs`);
    const texts: Record<string, string> = {
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
      "what the model was shown": shownToTheModel.join("\n"),
    };
    for (const [name, text] of Object.entries(texts))
      for (const secret of secrets)
        expect(containsSecret(text, secret), `a credential is in ${name}`).toBe(
          false,
        );

    // The engine's own directories (OpenCode's data, cache and sessions), read at the end of every job.
    const scans = engineScans();
    expect(scans.length).toBeGreaterThan(0);
    for (const scan of scans) {
      expect(scan.files).toBeGreaterThan(0);
      expect(
        Object.entries(scan.found).filter(([, count]) => count > 0),
        "a secret is in the engine's directories",
      ).toEqual([]);
    }
  });

  // #767-E10
  test("E10 after the Workers end, no process of the engine user and no work volume is left, and the VMs are stopped", async () => {
    const theDispatcher = required(dispatcher, "The Dispatcher");
    await eventually(
      "the VMs of the jobs to be stopped",
      async () => vmDirectories(VM_ROOT).length === 0,
      60_000,
    );
    expect(engineProcesses()).toEqual([]);
    // The work volume is a mount of the container's own namespace: none of the lane's processes has one at /work.
    expect(readFileSync("/proc/self/mountinfo", "utf8")).not.toMatch(
      /\s\/work\s/,
    );
    // Every Worker ended by itself, with a result.
    const workers = theDispatcher
      .containers()
      .filter((container) => container.mode === "worker-once");
    expect(workers.length).toBeGreaterThanOrEqual(runs.length);
    assertGuardQuiet();
  });
});
