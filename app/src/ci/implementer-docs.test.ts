// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the documents of the Implementer (#768): the operator guide, the rollout in the bring-up checklist and in
// section 5.8 of the deployment guide, the lead's live smoke test, and the small corrections to older texts that the
// reviews of #772, #776 and #771 asked for. A document that names a variable, a key or a code that no code reads is a
// document that sends the operator to nothing, so every name the documents give is looked up in the repository.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { describeBranchReason } from "../runs/run-view.ts";
import { listTrackedFiles } from "./tracked-files.ts";
import { readText, repoRoot } from "./workflow-support.ts";

const guide = readText("docs/implementer.md");
const smoke = readText("docs/implementer-smoke-test.md");
const bringUp = readText("docs/factory-bring-up.md");
const deployment = readText("docs/deployment-vercel.md");

/** Whitespace collapsed, so a sentence wrapped over lines is still one sentence. */
const flat = (text: string): string => text.replace(/\s+/g, " ");

/** The text of one `## ` or `### ` section, from its heading up to the next heading of the same or a higher level. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const level = heading.match(/^#+/)?.[0].length ?? 2;
  const rest = text.slice(start + 1 + heading.length);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return next === -1 ? rest : rest.slice(0, next);
}

/** The rollout section of each document that carries it. */
const rollouts = [
  [
    "docs/factory-bring-up.md",
    section(bringUp, "## Switching on the Implementer (the rollout)"),
  ],
  [
    "docs/deployment-vercel.md",
    section(
      deployment,
      "#### Rollout of the Implementer (the order of the steps)",
    ),
  ],
] as const;

describe("the Implementer documents exist and are linked", () => {
  // #768-T01
  it("has an operator guide, a smoke test and links between them and from the guides", () => {
    expect(existsSync(resolve(repoRoot, "docs/implementer.md"))).toBe(true);
    expect(
      existsSync(resolve(repoRoot, "docs/implementer-smoke-test.md")),
    ).toBe(true);
    expect(guide).toContain("](implementer-smoke-test.md)");
    expect(guide).toContain("](factory-bring-up.md)");
    expect(smoke).toContain("](implementer.md)");
    expect(smoke).toContain("](factory-bring-up.md)");
    expect(bringUp).toContain("](implementer.md)");
    expect(bringUp).toContain("](implementer-smoke-test.md)");
    expect(deployment).toContain("](implementer.md)");
    expect(deployment).toContain("](implementer-smoke-test.md)");
    expect(readText("README.md")).toContain("](docs/implementer.md)");
  });

  // #768-T01
  it("links only to files and headings that exist, and holds no em dash", () => {
    const anchorsOf = (text: string): Set<string> =>
      new Set(
        [...text.matchAll(/^#{1,6} (.+)$/gm)].map((match) =>
          (match[1] as string)
            .toLowerCase()
            .replace(/`/g, "")
            .replace(/[^a-z0-9 _-]/g, "")
            .replace(/ /g, "-"),
        ),
      );
    const broken: string[] = [];
    for (const [file, text] of [
      ["docs/implementer.md", guide],
      ["docs/implementer-smoke-test.md", smoke],
      ["docs/factory-bring-up.md", bringUp],
    ] as const) {
      expect(text, file).not.toContain("—");
      for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const link = match[1] as string;
        if (/^https?:/.test(link)) continue;
        const [target, anchor] = link.split("#") as [string, string?];
        const path =
          target === ""
            ? resolve(repoRoot, file)
            : resolve(repoRoot, "docs", target);
        if (!existsSync(path)) {
          broken.push(`${file}: ${link}`);
          continue;
        }
        if (anchor && !anchorsOf(readFileSync(path, "utf8")).has(anchor))
          broken.push(`${file}: ${link}`);
      }
    }
    expect(broken).toEqual([]);
  });
});

describe("every name the Implementer documents give exists in the code", () => {
  // The code the documents describe, not the tests: a test that spells a name proves nothing about the product, and this file
  // spells all of them.
  const files = listTrackedFiles(repoRoot).filter(
    (path) =>
      !path.startsWith("docs/") &&
      !path.endsWith(".md") &&
      !/\.test\.|\.integration\.|\.e2e\.|(^|\/)(tests?|integration-tests|e2e)\//.test(
        path,
      ),
  );
  const code = files.map((path) => readText(path)).join("\n");
  const folders = readText("tools/factory-bootstrap/factory-bootstrap.sh");

  /**
   * What a document names that something must read or write: environment variables and Infisical keys (`UPPER_SNAKE`), stable
   * codes and log events (`lower_snake`, or a lower case word that the text calls a log "line", like the `launched` line).
   */
  function names(text: string): string[] {
    const found = new Set<string>();
    for (const pattern of [
      /`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`/g,
      /`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g,
      /`([a-z]+)` (?:log )?line\b/g,
    ])
      for (const match of text.matchAll(pattern)) found.add(match[1] as string);
    return [...found];
  }

  /** The names of `text` that do not appear, as a whole word, in the code. */
  function unknownNames(text: string, corpus: string): string[] {
    return names(text).filter(
      (name) =>
        !new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(corpus),
    );
  }

  // #768-T02
  it("finds a name that no code has, in capitals, in lower case and as a log line", () => {
    expect(
      unknownNames(
        "`NOT_A_REAL_NAME` `not_a_real_code` the `nolaunch` line",
        code,
      ),
    ).toEqual(["NOT_A_REAL_NAME", "not_a_real_code", "nolaunch"]);
    // A whole word: a prefix of a real code is not the code.
    expect(unknownNames("`branch_exist`", code)).toEqual(["branch_exist"]);
    expect(
      unknownNames(
        "`branch_exists` `PRODUCT_MISMATCH` the `launched` line",
        code,
      ),
    ).toEqual([]);
  });

  // #768-T02
  it.each([
    ["docs/implementer.md", guide],
    ["docs/implementer-smoke-test.md", smoke],
    ["the rollout of docs/factory-bring-up.md", rollouts[0][1]],
    ["the rollout of docs/deployment-vercel.md", rollouts[1][1]],
  ])(
    "%s names only variables, keys, codes and log events that something reads",
    (_, text) => {
      expect(unknownNames(text, code)).toEqual([]);
      expect(names(text).length).toBeGreaterThan(0);
    },
  );

  // #768-T02
  it("names the Infisical folders of the rollout as the bootstrap tool has them", () => {
    for (const [file, text] of rollouts) {
      for (const folder of text.matchAll(/`(\/[a-z-]+)`/g)) {
        expect(folders, `${file}: ${folder[1]}`).toContain(
          `"${folder[1] as string}|`,
        );
      }
    }
  });

  // #768-T02
  it("names the workflow, the inputs and the repository variables of the rollout as they are", () => {
    const deploy = readText(".github/workflows/deploy-production.yml");
    for (const [file, text] of rollouts) {
      expect(text, file).toContain("*Deploy production*");
      for (const variable of ["FACTORY_EXPECTED_CAPABILITIES"])
        expect(deploy, variable).toContain(variable);
    }
    expect(readText(".github/workflows/deploy-production.yml")).toContain(
      "name: Deploy production",
    );
  });
});

describe("the rollout of the Implementer", () => {
  const steps = [
    "Release the code to `main`",
    "`DISPATCHER_APPS`",
    "`PRODUCT_CAPABILITIES`",
    "maximum cost per review",
    "Contents",
    "smoke test",
  ];

  // #768-T01
  it.each(rollouts)(
    "%s lists the keys and values, in the order of the epic",
    (_file, text) => {
      const flatText = flat(text);
      let at = -1;
      for (const step of steps) {
        const found = flatText.indexOf(step, at + 1);
        expect(found, step).toBeGreaterThan(at);
        at = found;
      }
      expect(flatText).toContain('["diff","dynamic","implementer"]');
      expect(flatText).toContain("`review,dynamic-review,implementer`");
      expect(flatText).toContain("`dynamic-review,implementer,review`");
      expect(flatText).toContain("`FACTORY_EXPECTED_CAPABILITIES`");
      expect(flatText).toContain("`DISPATCHER_WORKER_CONFIG`");
      expect(flatText).toContain("`/dispatcher`");
      expect(flatText).toContain("`/app-factory`");
      // The two that must change together, and what happens when only one does.
      expect(flatText).toContain("`PRODUCT_MISMATCH`");
      // An older Dispatcher refuses the unknown kind at start, which would be an outage of the reviewer.
      expect(flatText).toMatch(/refuses the (unknown )?kind/);
    },
  );

  // #768-T01
  it("gives every step of the bring-up checklist a check and a way back", () => {
    const text = rollouts[0][1];
    const table = text.split("\n").filter((line) => /^\| \d+ \|/.test(line));
    expect(table.length).toBeGreaterThanOrEqual(8);
    for (const row of table) {
      const cells = row.split("|").map((cell) => cell.trim());
      // | n | Step | Who | Check | Rollback |
      expect(cells.length, row).toBeGreaterThanOrEqual(7);
      expect(cells[4], row).not.toBe("");
      expect(cells[5], row).not.toBe("");
    }
    expect(flat(text)).toMatch(/Check/);
    expect(flat(text)).toMatch(/Rollback/);
  });

  // #768-T01
  it("says that the first deploy with the kind is the proof of the engine, how it fails and what that holds back", () => {
    for (const [file, text] of rollouts) {
      const flatText = flat(text);
      expect(flatText, file).toContain(
        "advertises `implementer` only when `DISPATCHER_APPS` names the kind",
      );
      expect(flatText, file).toContain("`POST /probe`");
      expect(flatText, file).toContain("`503`");
      expect(flatText, file).toContain("missing=implementer");
      expect(flatText, file).toContain("nothing staged in that run");
      expect(flatText, file).toContain("`kinds`");
    }
    // The canary does print what the docs quote, and the promotions do wait for it.
    expect(readText("dispatcher/src/probe/canary.ts")).toContain("missing=");
    const deploy = readText(".github/workflows/deploy-production.yml");
    for (const job of ["promote-app", "promote-factory", "promote-dispatcher"])
      expect(deploy.slice(deploy.indexOf(`\n  ${job}:`))).toMatch(
        /needs: \[[^\]]*canary/,
      );
    // No step is called safe without the exception.
    expect(flat(rollouts[0][1])).not.toContain("are safe");
  });

  // #768-T01
  it("makes the one-click App the main path, after the deploy of step 3, with the update by hand as the fallback", () => {
    const flatText = flat(rollouts[0][1]);
    expect(flatText).toContain(
      "Main path: one click in the admin portal, after step 3 is deployed",
    );
    expect(flatText).toContain("Never click before the deploy of step 3");
    expect(flatText).toContain("Fallback only");
    expect(flatText).toContain("Contents **Read and write**");
    expect(flatText).toContain("*Check the permissions* lists nothing missing");
    expect(flatText).toContain("Tenancy:** the factory is `multi`");
    expect(flatText).toContain("**public** App");
    expect(flatText).toContain("access to those repositories only");
    expect(flatText).toContain(
      "until an Owner or Admin who owns the GitHub account",
    );
    // What the code does: public for multi, the capability set read at the click.
    expect(
      readText("app/src/integrations/providers/github-app/manifest.ts"),
    ).toContain('public: tenancy === "multi"');
    expect(readText("app/src/github-config/shared.ts")).toContain(
      "capabilities: getCapabilities()",
    );
    const githubApp = flat(readText("docs/github-app.md"));
    expect(githubApp).toContain(
      "only after the deploy that puts `implementer` into `PRODUCT_CAPABILITIES` is live",
    );
    // The table of optional items says the same.
    expect(flat(bringUp)).toContain(
      "click only after the deploy that puts `implementer` into `PRODUCT_CAPABILITIES`",
    );
  });

  // #768-T01
  it("separates what is the owner's action from what is the lead's", () => {
    const flatText = flat(rollouts[0][1]);
    expect(flatText).toContain("accepts the new permissions");
    expect(flatText).toContain("existing");
    expect(flatText).toContain("approve the new GitHub permission");
  });

  // #768-T01
  it("states what removing the capability does to running and queued tasks, as the code does it", () => {
    const flatText = flat(rollouts[0][1]);
    expect(flatText).toContain(
      "A turn that is **running** keeps its lease and finishes",
    );
    expect(flatText).toContain("no longer switches off its write token");
    expect(flatText).toContain(
      "A turn that is **queued** is still sent to the Dispatcher",
    );
    expect(flatText).toContain("`no_capable_runner`");
    // The code the sentences rest on: the revoke and the retry ask for the capability, the sweep still sends.
    expect(readText("app/src/jobs/shared.ts")).toMatch(
      /allowed: \(\) => getCapabilities\(\)\.has\("implementer"\)/,
    );
    expect(readText("app/src/dispatch/sweep.ts")).toContain(
      'has("implementer") ? deps.writeTokens',
    );
    expect(readText("app/src/runner-api/claim.ts")).toContain(
      '"INTEGRATION_CAPABILITY_ABSENT"',
    );
  });

  // #768-T01
  it("says the cost maximum loosens the factory's own reviews, and how large the cap must be for two reviews and two tasks", () => {
    const flatText = flat(rollouts[0][1]);
    expect(flatText).toContain("cap of every job the factory claims");
    expect(flatText).toContain("the factory's own Dynamic and Diff reviews");
    expect(flatText).toContain("**at least 4**");
    expect(flat(rollouts[1][1])).toContain("every job the factory claims");
  });
});

describe("the documents match the merged runner job and canary (#765)", () => {
  const text = flat(guide);

  // #768-T01
  it("has no temporary section and names the open points with their issues", () => {
    for (const [file, doc] of [
      ["docs/implementer.md", guide],
      ["docs/implementer-smoke-test.md", smoke],
      ["docs/factory-bring-up.md", bringUp],
      ["docs/deployment-vercel.md", deployment],
    ] as const)
      expect(doc, file).not.toContain("State of the code");
    const open = flat(section(guide, "## Open points"));
    for (const issue of ["#745", "#768", "#784", "#797", "#799"])
      expect(open, issue).toContain(issue);
  });

  // #768-T01
  it.each(rollouts)(
    "%s states the proof of the engine as the canary does it",
    (_file, rollout) => {
      const flatText = flat(rollout);
      expect(flatText).toContain("implementer_probe_failed");
      expect(flatText).toContain("missing=implementer");
      expect(flatText).toContain("Dynamic verdict stands");
      expect(flatText).toContain("`DISPATCHER_PROBE_TIMEOUT_SECONDS`");
      expect(flatText).toContain("at or below 190");
      expect(flatText).toContain("260 seconds");
      expect(flatText).toContain("#797");
    },
  );

  // #768-T02
  it("states the numbers the canary code and the Dispatcher README have", () => {
    const readme = flat(readText("dispatcher/README.md"));
    expect(readme).toContain("is **260 s**");
    expect(readme).toContain("at or below 190");
    expect(readme).toContain("`IMPLEMENTER_PROBE_EXTRA_SECONDS`, 110 s");
    const canary = readText("dispatcher/src/launchers/sandbox-canary.ts");
    expect(canary).toContain("PROBE_RUN_TIMEOUT_MS = 60_000");
    expect(readText("dispatcher/src/launchers/sandbox.ts")).toMatch(
      /WORK_VOLUME_STEPS_SECONDS\s*=/,
    );
    expect(readText("dispatcher/src/probe/verdict.ts")).toContain(
      'IMPLEMENTER_PROBE_FAILED: ProbeReason = "implementer_probe_failed"',
    );
    expect(readText("dispatcher/src/probe/canary.ts")).toContain(
      "missing=${missing.join(",
    );
  });

  // #768-T01
  it("states the stop, the lease and the free codes as the runner has them", () => {
    expect(text).toContain("a grace of 120 seconds");
    expect(text).toContain("stop timeout is 150 seconds");
    expect(text).toContain("`runner_shutdown`");
    expect(text).toContain("never run twice");
    expect(text).toContain("#799");
    expect(readText("app/src/db/job-limits.ts")).toContain(
      "IMPLEMENTER_MAX_ATTEMPTS = 1",
    );
    expect(readText("dispatcher/src/launchers/container-spec.ts")).toContain(
      "stopTimeoutSeconds: 150",
    );
    const readme = flat(readText("runner/README.md"));
    expect(readme).toContain("grace of 120 s after SIGTERM");
    expect(readme).toContain("neither `maxCostUsd` nor `operatorMaxCostUsd`");
  });

  // #768-T01
  // #802
  it("describes the slow fleet listing as a warning that no longer stops claims, in the failure table and in the smoke test", () => {
    for (const doc of [guide, smoke]) {
      const flatDoc = flat(doc);
      expect(flatDoc).toContain("`fleet_list_failed`");
      expect(flatDoc).toContain("4 seconds");
      expect(flatDoc).toContain("`no_capable_runner`");
      expect(flatDoc).toContain("2026-11-01");
      expect(flatDoc).toContain("`fleet_listed`");
      expect(flatDoc).toContain("the claim goes on");
      expect(flatDoc).toContain("one day");
      // The claim no longer answers `unavailable` for a failed listing: the docs must not say it does.
      expect(flatDoc).not.toContain("the claim answers `unavailable`");
    }
    expect(flat(smoke)).toContain("What to look at");
    const dispatcher = readText("dispatcher/src/core/dispatcher.ts");
    expect(dispatcher).toContain("LIVE_VMS_TIMEOUT_MS = 4 * 1000");
    expect(dispatcher).toContain('logger.error("fleet_list_failed", {');
    expect(dispatcher).toContain("LIVE_VMS_STALE_MS = 60 * 1000");
    expect(readText("dispatcher/src/reaper/reaper.ts")).toContain(
      "RETENTION_MS = 24 * 3600 * 1000",
    );
    expect(readText("dispatcher/src/reaper/reaper.ts")).toContain(
      "MAX_DELETES_PER_RUN = 50",
    );
  });

  // #768-T01
  it("does not say that the cost default is 5 USD: it is 1 USD until the owner sets 5", () => {
    expect(text).not.toContain("5.00 USD by default");
    expect(text).toContain("the default is 1.00 USD until then");
    expect(flat(rollouts[0][1])).toContain(
      "to 5.00 USD, the owner's per-turn maximum; the default is 1.00 USD until then",
    );
  });
});

describe("the operator guide states what the owner decided", () => {
  const text = flat(guide);

  // #768-T01
  it.each([
    ["the cost maximum of a turn", "5.00 USD"],
    [
      "that any member may start a task",
      "Every member of a workspace may start a task",
    ],
    ["the models", "serve Dynamic Review"],
    ["no pushes to workflow files", "`.github/workflows/`"],
    ["the billing rate", "Dynamic rate"],
    [
      "the branch name of a turn that failed before it started",
      "keeps its branch name",
    ],
    ["the identity of the commits", "committer"],
    [
      "the plain statement of the risk",
      "any** branch forward, including the default branch",
    ],
    [
      "the lost work of a VM that dies",
      "a VM that dies before the end of the turn loses the work",
    ],
    ["no Go registry", "no Go module proxy"],
    ["the accepted exfiltration", "npm publish"],
    ["the issue that closes it", "#784"],
    ["the brake", "no step limit"],
  ])("%s", (_what, phrase) => {
    expect(text).toContain(phrase);
  });

  // #768-T01
  it("says the exfiltration through a registry is accepted for internal use on own repositories only", () => {
    const risks = flat(section(guide, "## What is accepted, and until when"));
    expect(risks).toContain("own repositories");
    expect(risks).toContain("internal use");
    expect(risks).toMatch(/#784 .*(closed|closes) before/);
    expect(risks).toContain("external users");
  });

  // #768-T01
  it("explains the terms, the data flow, the git rules, the network, the limits, the codes and what is out of scope", () => {
    for (const heading of [
      "## What it is",
      "## Session and Turn",
      "## The data flow",
      "## The git rules",
      "## Network in the agent phase",
      "## Limits",
      "## When a task fails",
      "## Out of scope",
      "## What is accepted, and until when",
    ])
      expect(guide, heading).toContain(`\n${heading}\n`);
    // Every stable code of the new failure family has a plain sentence in the table.
    for (const code of [
      "branch_exists",
      "base_branch_not_found",
      "clone_failed",
      "setup_failed",
      "agent_gave_up",
      "push_rejected",
      "branch_violation",
      "cost_limit_reached",
      "time_limit_reached",
      "git_write_not_granted",
      "implementer_engine_unavailable",
      "implementer_config_invalid",
      "no_capable_runner",
      "dispatch_unavailable",
      "timeout",
    ])
      expect(guide, code).toContain(`| \`${code}\` |`);
    for (const code of [
      "lease_lost",
      "runner_error",
      "dynamic_accounting_failed",
      "llm_unavailable",
    ])
      expect(guide, code).toContain(`\`${code}\``);
    expect(flat(guide)).toContain("`app/src/billing/outcome.ts`");
  });

  // The owner's git model (2026-11-02): git is free in the workspace, every local branch is pushed, nothing is forced.
  it("states the git model: free git, no remote, all local branches pushed at the end, no force, and the one place for a later rule", () => {
    const rules = flat(section(guide, "## The git rules"));
    for (const phrase of [
      "anything with git",
      "no remote and no credential",
      "pushes all local branches",
      "no `+`, no force",
      "`PUSH_EXCLUDED_BRANCHES`",
      "`select_branches`",
      "Nothing is pushed during the turn",
      "`non_fast_forward`",
      "`workflows_not_allowed`",
      "Root never runs git with the agent's repository",
      "`--upload-pack`",
      "`branchesDropped`",
      "capped at 4 MiB",
      "`<the task's branch>-leftover-<id>`",
    ])
      expect(rules, phrase).toContain(phrase);
    // What the guide says is what the code does.
    const policy = readText(
      "runner/src/code_reviewer_runner/implementer/push_policy.py",
    );
    expect(policy).toContain(
      "PUSH_EXCLUDED_BRANCHES: frozenset[str] = frozenset()",
    );
    expect(policy).toContain("def select_branches(");
    expect(policy).toContain("MAX_PUSHED_BRANCHES = 50");
    const workspace = readText(
      "runner/src/code_reviewer_runner/implementer/git_workspace.py",
    );
    expect(workspace).toContain(
      'f"--upload-pack={self._access.upload_pack()}"',
    );
    expect(workspace).toContain(
      '["push", "--porcelain", self.spec.clone_url, f"{scratch}:refs/heads/{name}"]',
    );
    expect(workspace).not.toContain("--force");
    expect(workspace).not.toContain("safe.directory=");
    expect(text).not.toContain("accident guard");
    expect(text).not.toContain("The committer check");
    for (const reason of [
      "non_fast_forward",
      "remote_rejected",
      "workflows_not_allowed",
      "provider_refused",
      "provider_error",
      "provider_unavailable",
      "timed_out",
      "unreadable",
      "not_a_commit",
      "out_of_time",
      "out_of_space",
      "excluded",
    ])
      expect(rules, reason).toContain(`\`${reason}\``);
    // Every word the runner can give for a branch is in the guide and has a sentence of its own on the Runs page.
    const words = [
      ...(workspace + policy).matchAll(/^REASON_[A-Z_]+ = "([a-z_]+)"$/gm),
    ]
      .map((found) => found[1] ?? "")
      .filter((word) => word !== "");
    expect(words.length).toBeGreaterThanOrEqual(11);
    for (const word of words) {
      expect(rules, word).toContain(`\`${word}\``);
      expect(describeBranchReason(word), word).not.toBe(
        "The branch was not pushed.",
      );
    }
  });

  // The guide says which branches the codes of the old model are gone for.
  it("says that branch_exists and branch_violation are no longer produced and that a refused branch is a rejected entry", () => {
    expect(text).toContain("| `branch_exists` | **No longer produced.**");
    expect(text).toContain("| `branch_violation` | **No longer produced**");
    expect(text).toContain("`non_fast_forward`");
    expect(readText("app/src/billing/outcome.ts")).toContain(
      'branch_exists: "free"',
    );
    const workspace = readText(
      "runner/src/code_reviewer_runner/implementer/git_workspace.py",
    );
    expect(workspace).toContain("REASON_NOT_FAST_FORWARD");
    expect(workspace).not.toContain("BRANCH_EXISTS");
    expect(workspace).not.toContain("BRANCH_VIOLATION");
  });

  // #768-T01
  it("states the limits the code has", () => {
    const claim = readText("app/src/runner-api/claim.ts");
    expect(claim).toContain("IMPLEMENTER_TIME_LIMIT_SECONDS = 3600");
    expect(text).toContain("3600 seconds");
    expect(readText("app/src/implementer/start-input.ts")).toContain("20_000");
    expect(text).toContain("20,000 characters");
    expect(
      readText("runner/src/code_reviewer_runner/implementer/session.py"),
    ).toContain("GRACE_SECONDS = 270.0");
    expect(text).toContain("270 seconds");
  });
});

describe("the live smoke test", () => {
  const text = flat(smoke);

  // #768-T01, #768-T03
  it("covers what the issue and the reviews ask for, each with what a pass is", () => {
    for (const phrase of [
      "snapshot size",
      "start time",
      "https clone",
      "GnuTLS",
      "billing route",
      "`404`",
      "nft",
      "`nosuid`",
      "through the shared Dispatcher",
      "A pass is",
      "throwaway repository",
      "Vercel Sandbox list",
      "the cost",
      "T03",
    ])
      expect(text, phrase).toContain(phrase);
  });

  // #768-T03
  it("gives the agent only commands the Worker image has, and names the error text each closed door must show", () => {
    const dockerfile = readText("runner/Dockerfile");
    // The image installs no program that the task would need to fetch a page, and no sudo.
    for (const program of ["curl", "wget", "sudo"])
      expect(dockerfile, program).not.toMatch(
        new RegExp(
          `install[^\\n]*(?<![A-Za-z0-9_-])${program}(?![A-Za-z0-9_-])`,
        ),
      );
    // What it does have, on the agent's PATH (the runner's trusted path); python3 is the base image's.
    expect(dockerfile).toContain("FROM ${PYTHON_IMAGE}");
    expect(dockerfile).toContain(
      "ln -s /opt/node/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm",
    );
    expect(
      readText("runner/src/code_reviewer_runner/implementer/git_process.py"),
    ).toContain('TRUSTED_PATH = "/usr/local/bin:/usr/bin:/bin"');
    const start = smoke.indexOf("```text");
    const block = smoke.slice(start, smoke.indexOf("\n  ```", start));
    const commands = block
      .split("\n")
      .filter((line) => /^ {2}\d+\. /.test(line))
      .map((line) => line.replace(/^ {2}\d+\. /, ""));
    expect(commands).toHaveLength(13);
    const available = new Set([
      "id",
      "git",
      "grep",
      "env",
      "python3",
      "npm",
      "cut",
    ]);
    for (const command of commands)
      for (const part of command
        .replace(/"[^"]*"|'[^']*'/g, "")
        .split(/;|\|/)) {
        const program = part
          .trim()
          .replace(/^env(?: -u \S+)+ /, "")
          .split(/\s+/)[0] as string;
        expect(available.has(program), command).toBe(true);
      }
    for (const error of [
      "Temporary failure in name resolution",
      "No route to host",
      "timed out",
      "Tunnel connection failed: 403 Forbidden",
      "CONNECT tunnel failed, response 403",
      "PONG",
      "does not appear to be a git repository",
    ])
      expect(text, error).toContain(error);
  });

  // #768-T03
  it("has a table of checks that each name a pass and a failure", () => {
    const rows = smoke.split("\n").filter((line) => /^\| S\d+ \|/.test(line));
    expect(rows.length).toBeGreaterThanOrEqual(12);
    for (const row of rows) {
      const cells = row.split("|").map((cell) => cell.trim());
      // | id | Check | How | A pass is | If it fails |
      expect(cells.length, row).toBeGreaterThanOrEqual(7);
      expect(cells[4], row).not.toBe("");
      expect(cells[5], row).not.toBe("");
    }
  });
});

describe("the corrections the reviews asked for", () => {
  // #772 review
  it("names the repository variable in the capability README and the bootstrap tool", () => {
    const readme = flat(readText("app/src/capabilities/README.md"));
    expect(readme).toContain("FACTORY_EXPECTED_CAPABILITIES");
    expect(readme).not.toContain(
      "compares the sorted list, `dynamic-review,review`",
    );
    const bootstrap = readText("tools/factory-bootstrap/factory-bootstrap.sh");
    const line = bootstrap
      .split("\n")
      .find((entry) => entry.includes("|PRODUCT_CAPABILITIES|"));
    expect(line).toContain("FACTORY_EXPECTED_CAPABILITIES");
    expect(line).not.toContain("exactly this set (health-factory checks it)");
  });

  // #776 review
  it("says in the GitHub App guide that the factory's Implementer needs Contents read and write", () => {
    const app = readText("docs/github-app.md");
    const row = app
      .split("\n")
      .find((line) => line.startsWith("| Contents (`contents`) | Read-only |"));
    expect(row).toBeDefined();
    expect(row).toContain("Implementer");
    const checklist = app
      .split("\n")
      .find((line) =>
        line.includes("Permissions: Pull requests Read and write"),
      );
    expect(checklist).toBeDefined();
    const after = flat(
      app.slice(app.indexOf(checklist as string), app.indexOf("- [ ] Events")),
    );
    expect(after).toContain("Contents Read and write");
    expect(after).toContain("Implementer");
  });

  // #776 review
  it("states in the present tense only what the app does: it refuses a repository without the permission", () => {
    const app = flat(readText("docs/github-app.md"));
    expect(app).toContain("the Implementer refuses the repository");
    const service = readText("app/src/implementer/service.ts");
    expect(service).toContain("IMPLEMENTER_WRITE_NOT_GRANTED");
    expect(readText("app/src/implementer/ui/messages.ts")).toContain(
      "approve the new GitHub permission",
    );
    expect(app).toContain("approve the new GitHub permission");
  });

  // #776 review
  it("keeps the comment of a discovered connection above its own type", () => {
    const types = readText("app/src/integrations/types.ts");
    const comment = types.indexOf(
      "A connection the platform itself can enumerate",
    );
    expect(comment).toBeGreaterThan(0);
    expect(types.slice(comment, comment + 400)).toContain(
      "export type DiscoveredConnection",
    );
    expect(types.indexOf("export type ConnectionPermissions")).toBeLessThan(
      comment,
    );
  });

  // #771 review
  it("says in both places that the locks on users, repositories and workspaces are held until the batch commits, and that lock_timeout is per statement", () => {
    for (const path of [
      "app/src/db/README.md",
      "app/src/db/migrations/20261030140000_create_implementer_sessions_and_turns.ts",
    ]) {
      const text = flat(readText(path).replace(/^\/\/ ?/gm, ""));
      expect(text, path).toContain("`users`, `repositories` and `workspaces`");
      expect(text, path).toContain("as the rest of the migration runs");
      expect(text, path).toContain("per statement");
      expect(text, path).toContain(
        path.endsWith(".md") ? "5 s" : "LOCK_TIMEOUT",
      );
    }
  });
});
