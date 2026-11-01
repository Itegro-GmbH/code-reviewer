// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the documents of the Implementer (#768): the operator guide, the rollout in the bring-up checklist and in
// section 5.8 of the deployment guide, the lead's live smoke test, and the small corrections to older texts that the
// reviews of #772, #776 and #771 asked for. A document that names a variable, a key or a code that no code reads is a
// document that sends the operator to nothing, so every name the documents give is looked up in the repository.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
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
  const files = listTrackedFiles(repoRoot).filter(
    (path) => !path.startsWith("docs/") && !path.endsWith(".md"),
  );
  const code = files.map((path) => readText(path)).join("\n");
  const folders = readText("tools/factory-bootstrap/factory-bootstrap.sh");

  /** Environment variables, Infisical keys and stable codes written in capitals: `NAME_WITH_UNDERSCORE`. */
  function names(text: string): string[] {
    return [
      ...new Set(
        [...text.matchAll(/`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`/g)].map(
          (match) => match[1] as string,
        ),
      ),
    ];
  }

  // #768-T02
  it.each([
    ["docs/implementer.md", guide],
    ["docs/implementer-smoke-test.md", smoke],
    ["the rollout of docs/factory-bring-up.md", rollouts[0][1]],
    ["the rollout of docs/deployment-vercel.md", rollouts[1][1]],
  ])(
    "%s names only variables, keys and codes that something reads",
    (_, text) => {
      const unknown = names(text).filter((name) => !code.includes(name));
      expect(unknown).toEqual([]);
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
  it("says that the Launcher must advertise the engine, and what happens until it does", () => {
    for (const [file, text] of rollouts) {
      const flatText = flat(text);
      expect(flatText, file).toContain("`not_capable`");
      expect(flatText, file).toContain("advertise");
    }
  });

  // #768-T01
  it("separates what is the owner's action from what is the lead's", () => {
    const flatText = flat(rollouts[0][1]);
    expect(flatText).toContain("accept the new permissions");
    expect(flatText).toContain("existing App");
    expect(flatText).toContain("approve the new GitHub permission");
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
    ["the identity check", "committer"],
    ["no Go registry", "no Go module proxy"],
    ["the egress rule", "allowlist of package registries"],
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
    ])
      expect(guide, code).toContain(`| \`${code}\` |`);
  });

  // #768-T01
  it("lists the registries of the allowlist as the runner has them", () => {
    const policy = readText(
      "runner/src/code_reviewer_runner/implementer/egress_policy.py",
    );
    const block = policy.slice(policy.indexOf("DEFAULT_ALLOWLIST"));
    const hosts = [...block.matchAll(/"([a-z0-9.-]+\.[a-z]+)"/g)].map(
      (match) => match[1] as string,
    );
    expect(hosts.length).toBeGreaterThan(0);
    for (const host of hosts) expect(guide, host).toContain(`\`${host}\``);
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
    ).toContain("GRACE_SECONDS = 180.0");
    expect(text).toContain("180 seconds");
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
  it("says in both places that the locks on users, repositories and workspaces are held while the index waits for jobs", () => {
    for (const path of [
      "app/src/db/README.md",
      "app/src/db/migrations/20261030140000_create_implementer_sessions_and_turns.ts",
    ]) {
      const text = flat(readText(path).replace(/^\/\/ ?/gm, ""));
      expect(text, path).toMatch(
        /(reverse|the other way round)[^.]*(`users`, `repositories` and `workspaces`)|(`users`, `repositories` and `workspaces`)[^.]*(held|wait)/,
      );
      expect(text, path).toContain(
        path.endsWith(".md") ? "5 s" : "LOCK_TIMEOUT",
      );
    }
  });
});
