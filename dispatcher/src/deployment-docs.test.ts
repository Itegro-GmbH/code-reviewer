// SPDX-License-Identifier: LicenseRef-Proprietary

// Keeps the deployment guide (docs/deployment-vercel.md) and dispatcher/.env.example in step with what the
// Dispatcher reads (#333). Every variable the code reads is a placeholder in .env.example and a row of the guide's
// Dispatcher table (the FIRST cell names it: a mention in another row's text does not count), the table names no variable
// the code does not read, its Required and Secret columns, ranges and defaults are what the code does when it is run with
// those values, the "different from every other secret" claims are refused by the code, and the commands and names the
// guide gives for the snapshot and the canary exist.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadSettings } from "./config.ts";
import { sandboxFromEnvironment } from "./launchers/sandbox-env.ts";
import { VM_TIMEOUT_MARGIN_SECONDS } from "./launchers/sandbox.ts";

const ROOT = join(import.meta.dirname, "..");
const REPO = join(ROOT, "..");

function read(path: string): string {
  return readFileSync(join(REPO, path), "utf8");
}

const guide = read("docs/deployment-vercel.md");
const envExample = read("dispatcher/.env.example");

/** The text of a section from its heading to the next heading of the same or a higher level. */
function section(heading: string): string {
  const level = /^#+/.exec(heading)?.[0].length ?? 2;
  const start = guide.indexOf(`\n${heading}\n`);
  if (start === -1) throw new Error(`the guide has no "${heading}" section`);
  const rest = guide.slice(start + 1);
  const next = new RegExp(`\\n#{1,${String(level)}} `).exec(
    rest.slice(heading.length),
  );
  return next === null ? rest : rest.slice(0, heading.length + next.index);
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory())
      return ["contracts", "test-support", "fixtures", "testdata"].includes(
        entry,
      )
        ? []
        : sourceFiles(path);
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
}

/**
 * Variables the code still accepts, only to warn that they are retired (#479): they are not settings any more, so they
 * are neither a placeholder in .env.example nor a row of the guide's table.
 */
const RETIRED_VARIABLES = ["DISPATCHER_PROBE_TTL_SECONDS"];

/** Every variable the Dispatcher's source reads from its environment, the deploy canary and the snapshot command too. */
function variablesRead(): Set<string> {
  const names = new Set<string>();
  const add = (source: string, pattern: RegExp): void => {
    for (const match of source.matchAll(pattern))
      for (const name of match.slice(1)) if (name) names.add(name);
  };
  for (const file of sourceFiles(join(ROOT, "src"))) {
    const source = readFileSync(file, "utf8");
    add(source, /\b(?:read|required|integer)\(\s*env,\s*"([A-Z][A-Z0-9_]+)"/g);
    add(source, /\bkey\(\s*env,\s*"([A-Z][A-Z0-9_]+)",\s*"([A-Z][A-Z0-9_]+)"/g);
    add(source, /\benv\.([A-Z][A-Z0-9_]+)/g);
    add(source, /\bdeps\.env\.([A-Z][A-Z0-9_]+)/g);
    add(source, /\bmissing: "([A-Z][A-Z0-9_]+)"/g);
  }
  for (const retired of RETIRED_VARIABLES) names.delete(retired);
  return names;
}

/** Every variable named in .env.example, set, shown in a comment, or noted as `# NAME: ...`. */
function documented(): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of envExample.split("\n")) {
    const assignment = /^#?\s?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (assignment) result.set(assignment[1] ?? "", assignment[2] ?? "");
    const note = /^# ([A-Z][A-Z0-9_]*): \S/.exec(line);
    if (note) result.set(note[1] ?? "", "");
  }
  return result;
}

type Row = { names: string[]; required: string; secret: string; text: string };

/** The rows of a table of the guide: the names in the FIRST cell, then Required, Secret and the text. */
function rowsOf(text: string): Row[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .map((line) => {
      const cells = line
        .slice(1, line.endsWith("|") ? -1 : undefined)
        .split(/(?<!\\)\|/)
        .map((cell) => cell.trim());
      return {
        names: [...(cells[0] ?? "").matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map(
          (match) => match[1] as string,
        ),
        required: cells[1] ?? "",
        secret: cells[2] ?? "",
        text: cells.slice(3).join(" | "),
      };
    });
}

const VALID = {
  RUNNER_API_URL: "https://reviews.example.com",
  RUNNER_TOKEN: "t".repeat(40),
  DISPATCHER_MAX_RUNNING: "2",
  DISPATCHER_SIGNING_KEY_ID: "k1",
  DISPATCHER_SIGNING_SECRET: "s".repeat(40),
};
const SNAPSHOT = {
  SANDBOX_SNAPSHOT_ID: "snap_test_one",
  SANDBOX_IMAGE_DIGEST: `sha256:${"a".repeat(64)}`,
};
const NO_SDK = () => Promise.reject(new Error("the SDK is not loaded here"));

const QUIET = { info() {}, warn() {}, error() {} };

/** Everything a deployment does with its variables at start: the settings, the Launcher and, with the snapshot, its own checks. */
function start(env: Record<string, string>): void {
  const settings = loadSettings({ ...VALID, ...env });
  if (settings.cronSecretProblem !== undefined)
    throw settings.cronSecretProblem;
  sandboxFromEnvironment({ ...VALID, ...SNAPSHOT, ...env }, NO_SDK).launcher({
    settings,
    logger: QUIET,
    background: () => undefined,
  });
}

function accepted(env: Record<string, string>): boolean {
  try {
    start(env);
    return true;
  } catch (error) {
    if (error instanceof ConfigError) return false;
    throw error;
  }
}

function refusedFor(env: Record<string, string>): string | undefined {
  try {
    start(env);
    return undefined;
  } catch (error) {
    if (error instanceof ConfigError)
      return `${error.variable}:${error.reason}`;
    throw error;
  }
}

const SECRET_NAME = /SECRET|TOKEN/;

describe("dispatcher/.env.example", () => {
  // #333-T02
  it("lists every variable the Dispatcher reads, as a placeholder", () => {
    const present = documented();

    const missing = [...variablesRead()].filter((name) => !present.has(name));

    expect(variablesRead().size).toBeGreaterThan(20);
    expect(missing).toEqual([]);
  });

  // #333-T02
  it("lists no variable the Dispatcher does not read", () => {
    const read = variablesRead();

    expect([...documented().keys()].filter((name) => !read.has(name))).toEqual(
      [],
    );
  });

  // #333-T02, #333-T03
  it("holds no value for a secret and no real host, token or id", () => {
    for (const [name, value] of documented()) {
      if (SECRET_NAME.test(name)) expect(value, name).toBe("");
      expect(value, name).not.toMatch(
        /ghp_|github_pat_|sk-|snap_[A-Za-z0-9]|prj_|team_[A-Za-z0-9]/,
      );
    }
    expect(documented().get("SANDBOX_SNAPSHOT_ID")).toBe("");
    expect(documented().get("SANDBOX_IMAGE_DIGEST")).toBe("");
    expect(envExample).not.toMatch(/sha256:[0-9a-f]{64}/);
  });

  // #479-T07
  it("has no placeholder for a retired variable, and says in a comment that it is retired", () => {
    for (const name of RETIRED_VARIABLES) {
      expect(documented().has(name), name).toBe(false);
      expect(envExample, name).toMatch(
        new RegExp(`Retired \\(#479\\): ${name}`),
      );
    }
  });

  // #333-T02
  it("keeps the required variables uncommented, and they load once the secrets are filled in", () => {
    for (const name of Object.keys(VALID))
      expect(envExample, name).toMatch(new RegExp(`^${name}=`, "m"));
    expect(loadSettings(VALID).core.apps[0]?.maxRunning).toBe(2);
  });
});

describe("the Dispatcher section of the guide", () => {
  const table = section("### 3.2 The Dispatcher project");
  const rows = rowsOf(table);
  const row = (name: string): Row => {
    const found = rows.find((candidate) => candidate.names.includes(name));
    if (!found) throw new Error(`no row for ${name} in the Dispatcher table`);
    return found;
  };
  const named = rows.flatMap((candidate) => candidate.names);

  // #333-T02
  it("has a row for every variable the deployed Dispatcher reads: the first cell names it", () => {
    const deployed = [...variablesRead()].filter(
      (name) =>
        ![
          "CANARY_ALLOWED_HOSTS",
          "CANARY_EXPECT_IMAGE_DIGEST",
          "CANARY_EXPECT_SNAPSHOT_ID",
          "PAIR_SNAPSHOT_ID",
          "PAIR_IMAGE_DIGEST",
          "PAIR_COMMIT",
          "PAIR_SYSBOX",
          "KEEP_SNAPSHOT_IDS",
          "DISCARD_SNAPSHOT_ID",
          "INFISICAL_DOMAIN",
          "INFISICAL_CLIENT_ID",
          "INFISICAL_CLIENT_SECRET",
          "INFISICAL_PROJECT_SLUG",
          "VERCEL_AUTOMATION_BYPASS_SECRET",
          "DISPATCHER_SHUTDOWN_GRACE_SECONDS",
          "VERCEL_OIDC_TOKEN",
        ].includes(name),
    );

    expect(deployed.filter((name) => !named.includes(name))).toEqual([]);
  });

  // #479-T07
  it("has no row for a retired variable and states that it is retired", () => {
    for (const name of RETIRED_VARIABLES) {
      expect(named, name).not.toContain(name);
      expect(table, name).toContain(`**Retired:** \`${name}\``);
    }
  });

  // #333-T04
  it("names in the first cell no variable the code does not read", () => {
    const read = variablesRead();

    expect(rows.length).toBeGreaterThan(15);
    expect(named.filter((name) => !read.has(name))).toEqual([]);
  });

  // #333-T04
  it("says Required exactly where the code requires a variable", () => {
    const requiredByCode = Object.keys(VALID);
    for (const name of requiredByCode) {
      const without = { ...VALID } as Record<string, string | undefined>;
      delete without[name];
      expect(() => loadSettings(without), name).toThrow(ConfigError);
      expect(row(name).required, name).toBe("yes");
    }
    // Everything else loads without it and is not marked a plain "yes".
    for (const candidate of rows) {
      for (const name of candidate.names) {
        if (requiredByCode.includes(name)) continue;
        expect(
          ["SANDBOX_SNAPSHOT_ID", "CRON_SECRET"].includes(name) ||
            candidate.required !== "yes",
          name,
        ).toBe(true);
      }
    }
    // The two that are needed for a working deployment, though the code starts without them, do what the guide says.
    expect(sandboxFromEnvironment(VALID, NO_SDK).secrets).toEqual([]);
    expect(
      sandboxFromEnvironment(VALID, NO_SDK).launcher({
        settings: loadSettings(VALID),
        logger: QUIET,
        background: () => undefined,
      }).launch,
    ).toBeTypeOf("function");
    expect(loadSettings(VALID).cronSecret).toBeUndefined();
    expect(row("SANDBOX_SNAPSHOT_ID").required).toBe("yes");
    expect(row("CRON_SECRET").required).toMatch(/^yes, with the snapshot$/);
    expect(row("SANDBOX_IMAGE_DIGEST").required).toBe("with the snapshot");
    expect(() =>
      sandboxFromEnvironment(
        { ...VALID, SANDBOX_SNAPSHOT_ID: SNAPSHOT.SANDBOX_SNAPSHOT_ID },
        NO_SDK,
      ),
    ).toThrow(ConfigError);
  });

  // #333-T04
  it("marks as secret what the code masks and what is named like a secret, and nothing else", () => {
    const masked = [
      "RUNNER_TOKEN",
      "DISPATCHER_SIGNING_SECRET",
      "DISPATCHER_SIGNING_SECRET_PREVIOUS",
      "CRON_SECRET",
      "VERCEL_TOKEN",
    ];
    for (const name of masked)
      expect(row(name).secret, name).toMatch(/\*\*yes\*\*/);
    for (const candidate of rows)
      for (const name of candidate.names) {
        const isSecret = /^\*\*yes\*\*/.test(candidate.secret);
        const namedLikeOne = SECRET_NAME.test(name);
        // A row of several names (a key id with its secret, the token with its team and project) is marked as a whole:
        // it is secret when one of its names is named like a secret.
        if (candidate.names.length > 1) {
          expect(isSecret, name).toBe(
            candidate.names.some((each) => SECRET_NAME.test(each)),
          );
          continue;
        }
        expect(isSecret, name).toBe(namedLikeOne);
      }
  });

  // #333-T04
  it("states the range and the default of every number, and the code refuses one step outside the range", () => {
    const numbers: Array<{
      name: string;
      min: number;
      max: number;
      fallback?: number;
    }> = [
      { name: "DISPATCHER_MAX_RUNNING", min: 1, max: 1000 },
      {
        name: "DISPATCHER_JOB_TIMEOUT_SECONDS",
        min: 60,
        max: 21600,
        fallback: 1200,
      },
      { name: "SANDBOX_HANDOVER_SECONDS", min: 1, max: 120, fallback: 20 },
      {
        name: "DISPATCHER_PROBE_REUSE_SECONDS",
        min: 0,
        max: 600,
        fallback: 60,
      },
      {
        name: "DISPATCHER_PROBE_TIMEOUT_SECONDS",
        min: 30,
        max: 600,
        fallback: 150,
      },
    ];
    for (const { name, min, max, fallback } of numbers) {
      const text = row(name).text;
      expect(text, name).toContain(`${String(min)} to ${String(max)}`);
      if (fallback !== undefined)
        expect(text, name).toMatch(
          new RegExp(`default \\*{0,2}${String(fallback)}\\*{0,2}[.;]`),
        );
      expect(
        accepted({ [name]: String(min) }),
        `${name} at ${String(min)}`,
      ).toBe(true);
      expect(
        accepted({ [name]: String(max) }),
        `${name} at ${String(max)}`,
      ).toBe(true);
      expect(accepted({ [name]: String(max + 1) }), `${name} above`).toBe(
        false,
      );
      if (min > 0)
        expect(accepted({ [name]: String(min - 1) }), `${name} below`).toBe(
          false,
        );
    }
    // The margin: at most 3600, at least 180 and 150 above the hand-over time; the default is the code's.
    const margin = row("SANDBOX_VM_TIMEOUT_MARGIN_SECONDS").text;
    expect(margin).toContain(
      "At most 3600, at least 180 and 150 above the hand-over time",
    );
    expect(margin).toMatch(
      new RegExp(`default ${String(VM_TIMEOUT_MARGIN_SECONDS)}\\.`),
    );
    expect(accepted({ SANDBOX_VM_TIMEOUT_MARGIN_SECONDS: "180" })).toBe(true);
    expect(accepted({ SANDBOX_VM_TIMEOUT_MARGIN_SECONDS: "179" })).toBe(false);
    expect(accepted({ SANDBOX_VM_TIMEOUT_MARGIN_SECONDS: "3600" })).toBe(true);
    expect(accepted({ SANDBOX_VM_TIMEOUT_MARGIN_SECONDS: "3601" })).toBe(false);
    expect(
      accepted({
        SANDBOX_HANDOVER_SECONDS: "60",
        SANDBOX_VM_TIMEOUT_MARGIN_SECONDS: "209",
      }),
    ).toBe(false);
    expect(
      accepted({
        SANDBOX_HANDOVER_SECONDS: "60",
        SANDBOX_VM_TIMEOUT_MARGIN_SECONDS: "210",
      }),
    ).toBe(true);
  });

  // #333-T04
  it("states the other defaults of the code", () => {
    const { core } = loadSettings(VALID);

    expect(core.launchDeadlineSeconds).toBe(300);
    expect(row("DISPATCHER_JOB_TIMEOUT_SECONDS").text).toContain(
      "(at most 300 s)",
    );
    expect(core.apps[0]?.poolId).toBe("dispatcher");
    expect(row("DISPATCHER_POOL_ID").text).toContain("Default `dispatcher`");
    expect(core.engines).toEqual(["pr-agent", "opencode"]);
    expect(row("DISPATCHER_ENGINES").text).toContain("(default both)");
    expect(row("RUNNER_DYNAMIC_CAPABILITIES").text).toContain(
      "at most 4096 characters",
    );
    expect(
      accepted({ RUNNER_DYNAMIC_CAPABILITIES: `{"a":"${"x".repeat(4100)}"}` }),
    ).toBe(false);
  });

  // #333-T04
  it("states that the secrets differ, and the code refuses a copy", () => {
    const token = VALID.RUNNER_TOKEN;
    const cron = "c".repeat(40);

    expect(refusedFor({ DISPATCHER_SIGNING_SECRET: token })).toBe(
      "DISPATCHER_SIGNING_SECRET:not_distinct",
    );
    expect(refusedFor({ CRON_SECRET: token })).toBe("CRON_SECRET:not_distinct");
    expect(refusedFor({ CRON_SECRET: VALID.DISPATCHER_SIGNING_SECRET })).toBe(
      "CRON_SECRET:not_distinct",
    );
    expect(refusedFor({ CRON_SECRET: "short" })).toBe("CRON_SECRET:too_short");
    expect(refusedFor({ CRON_SECRET: cron })).toBeUndefined();
    expect(row("DISPATCHER_SIGNING_SECRET").text).toContain(
      "different from `RUNNER_TOKEN`",
    );
    expect(row("CRON_SECRET").text).toContain(
      "different from `RUNNER_TOKEN` and every signing secret",
    );
    expect(row("CRON_SECRET").text).toContain(
      "do not reuse the App project's `CRON_SECRET`",
    );
  });

  // #333-T04
  it("says what an unset snapshot does and that the snapshot and the digest go together", () => {
    expect(row("SANDBOX_SNAPSHOT_ID").text).toMatch(
      /Unset, the Dispatcher has no Launcher and claims nothing/,
    );
    // The pipeline sets the two together; nobody changes one without the other.
    expect(row("SANDBOX_IMAGE_DIGEST").text).toMatch(/sets the two together/i);
    expect(
      sandboxFromEnvironment(VALID, NO_SDK).launcher({
        settings: loadSettings(VALID),
        logger: QUIET,
        background: () => undefined,
      }),
    ).toMatchObject({ capabilities: expect.any(Function) });
  });

  // #333-T04
  it("tells that the cap of the Dispatcher and the App's cap must be the same number, and both ranges are 1 to 1000", () => {
    expect(row("DISPATCHER_MAX_RUNNING").text).toMatch(
      /equal the App's `RUNNER_DISPATCH_MAX_RUNNING`/,
    );
    expect(section("### 3.1 The App project")).toMatch(
      /RUNNER_DISPATCH_MAX_RUNNING`[^\n]*equal the Dispatcher's `DISPATCHER_MAX_RUNNING`/,
    );
    expect(read("app/src/dispatch/sweep-settings.ts")).toMatch(
      /MAX_RUNNING_RANGE = \{ min: 1, max: 1000 \}/,
    );
  });
});

describe("the commands and names the guide gives", () => {
  const dispatcherPackage = JSON.parse(read("dispatcher/package.json")) as {
    scripts: Record<string, string>;
  };
  const appPackage = JSON.parse(read("app/package.json")) as {
    scripts: Record<string, string>;
  };
  const snapshotWorkflow = read(".github/workflows/golden-snapshot.yml");
  const canaryWorkflow = read(".github/workflows/dispatcher-canary.yml");

  // #333-T04
  it("uses scripts that exist", () => {
    expect(guide).toContain("pnpm --dir app migrate");
    expect(guide).toContain("pnpm --dir app setup-code");
    expect(appPackage.scripts).toHaveProperty("migrate");
    expect(appPackage.scripts).toHaveProperty("setup-code");
    expect(dispatcherPackage.scripts).toHaveProperty("snapshot:build");
    expect(dispatcherPackage.scripts).toHaveProperty("probe:canary");
  });

  // #333-T04
  // #403-T11
  it("names the workflows, environments, secrets, inputs and variables as they are", () => {
    // The environments of the former pipeline are retired: the guide says so, and no workflow uses them.
    for (const name of ["hosted-snapshot", "hosted-canary"]) {
      expect(guide).toContain(name);
      expect(snapshotWorkflow).not.toContain(name);
      expect(canaryWorkflow).not.toContain(name);
    }
    expect(snapshotWorkflow).toContain("environment: production");
    expect(canaryWorkflow).toContain("environment: production");
    for (const secret of [
      "VERCEL_TOKEN",
      "VERCEL_TEAM_ID",
      "VERCEL_DISPATCHER_PROJECT_ID",
    ]) {
      expect(snapshotWorkflow).toContain(secret);
      expect(guide).toContain(secret);
    }
    for (const secret of [
      "RUNNER_TOKEN",
      "VERCEL_DISPATCHER_AUTOMATION_BYPASS_SECRET",
    ]) {
      expect(canaryWorkflow).toContain(secret);
      expect(guide).toContain(secret);
    }
    // The list of hosts is retired.
    expect(canaryWorkflow).not.toContain("DISPATCHER_CANARY_HOSTS");
    expect(canaryWorkflow).toContain("--verify-vercel");
    // The variable that switched the automatic build on is retired.
    expect(snapshotWorkflow).not.toContain("GOLDEN_SNAPSHOT_ENABLED");
    // The inputs: `target` of the snapshot workflow (in its own runbook), `rebuild_snapshot` and `canary_engines` of the
    // deployment, and the ones of the canary workflow.
    expect(snapshotWorkflow).toContain("target:");
    expect(read("docs/golden-snapshot.md")).toContain("`target`");
    const deployWorkflow = read(".github/workflows/deploy-production.yml");
    for (const input of ["rebuild_snapshot", "canary_engines", "allow_stale"]) {
      expect(deployWorkflow).toContain(`${input}:`);
      expect(guide).toContain(`\`${input}\``);
    }
    for (const input of ["url", "engines"]) {
      expect(canaryWorkflow).toContain(`${input}:`);
      expect(guide).toContain(`\`${input}\``);
    }
    expect(guide).toContain("DISPATCHER_CANARY_HOSTS");
    expect(guide).toContain("GOLDEN_SNAPSHOT_ENABLED");
    expect(read("docs/golden-snapshot.md")).toContain("golden-snapshot-record");
  });

  // #333-T04
  it("states the function limit and the region of dispatcher/vercel.json", () => {
    const config = JSON.parse(read("dispatcher/vercel.json")) as {
      regions: string[];
      functions: Record<string, { maxDuration: number }>;
    };

    expect(config.regions).toEqual(["fra1"]);
    expect(guide).toContain("`fra1`");
    expect(guide).toContain(
      `\`maxDuration\` of **${String(config.functions["src/index.ts"]?.maxDuration)} seconds**`,
    );
  });
});
