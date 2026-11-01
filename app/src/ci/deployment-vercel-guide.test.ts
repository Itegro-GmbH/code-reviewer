// SPDX-License-Identifier: LicenseRef-Proprietary

// Keeps docs/deployment-vercel.md (the guide for the hosted deployment on Vercel) and docs/dispatcher.md in step
// with the files and the code they describe (#333). The App table of the guide is checked against the CODE, not only
// against .env.example: every variable the hosted-relevant source files read has a row (the first cell names it) or is on the
// guide's list of variables that are not set; the Required and Secret columns are what the code does when it is run
// without the variable; ranges and defaults come from the code's own constants; the crons and durations are those of the
// vercel.json files; each step of the first deployment contains what belongs to it; the error codes exist; the links
// resolve; the README and the other deployment guides link to the guide; and none of the public files holds an account
// id, a snapshot id, a digest, a secret shape, a price, a company name or a real host name. What only a real deployment
// can show is listed in the guide's section 8 and stays manual.
import { getProductIdentity } from "../product-identity/current.ts";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadAuthConfig } from "../auth/config.ts";
import { refuseUnlessCron } from "../cron/auth.ts";
import { resolveAppSecret } from "../crypto/app-secret.ts";
import {
  DEFAULT_POOL_MAX,
  MAX_POOL_MAX,
  loadDatabaseConfig,
} from "../db/config.ts";
import { findDeploymentConfigProblems } from "../deploy/startup.ts";
import {
  MIN_DISPATCH_SECRET_LENGTH,
  OTHER_CREDENTIAL_VARIABLES,
  dispatchConfigProblems,
} from "../dispatch/config.ts";
import {
  DEFAULT_GIVE_UP_SECONDS,
  GIVE_UP_SECONDS_RANGE,
  MAX_RUNNING_RANGE,
  loadSweepSettings,
} from "../dispatch/sweep-settings.ts";
import { LLM_DEFAULT_VARIABLES } from "../llm/config.ts";
import { operatorTokenProblem } from "../operator-api/token.ts";
import { errorCopy } from "../runs/error-copy.ts";
import { SETUP_CODE_TTL_MS } from "../setup/code-store.ts";
import { DEBOUNCE_VARIABLE } from "../webhooks/debounce-config.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function read(path: string): string {
  return readFileSync(`${repoRoot}${path}`, "utf8");
}

const guide = read("docs/deployment-vercel.md");
const dispatcherDoc = read("docs/dispatcher.md");
const envExample = read(".env.example");
const readme = read("README.md");

/**
 * The text of the section with the given heading, up to the next heading of the same or a higher level. Lines inside a
 * code fence are never headings (a shell comment starts with `# `).
 */
function section(heading: string): string {
  const level = /^#+/.exec(heading)?.[0].length ?? 2;
  const lines = guide.split("\n");
  const start = lines.indexOf(heading);
  if (start === -1) throw new Error(`the guide has no "${heading}" section`);
  let inFence = false;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (line.startsWith("```")) inFence = !inFence;
    if (inFence) continue;
    const match = /^(#{1,6}) /.exec(line);
    if (match && (match[1] as string).length <= level) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** Every variable named in .env.example, set or only shown in a comment. */
function envExampleVariables(): Set<string> {
  return new Set(
    [
      ...envExample.matchAll(/^#?\s?([A-Z][A-Z0-9_]*)=/gm),
      ...envExample.matchAll(/^# ([A-Z][A-Z0-9_]*): \S/gm),
    ].map((match) => match[1] as string),
  );
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

/** Line breaks and runs of white space as one space, so a sentence can be wrapped anywhere in the guide. */
const flat = (text: string): string => text.replace(/\s+/g, " ");

const GOOD_TOKEN = "r".repeat(40);
const WEBHOOK = {
  RUNNER_TOKEN: GOOD_TOKEN,
  RUNNER_DISPATCH: "webhook",
  RUNNER_WEBHOOK_URL: "https://dispatcher.example.com/dispatch",
  RUNNER_WEBHOOK_SECRET: "w".repeat(40),
};

describe("the App section of the guide against the code", () => {
  const appSection = section("### 3.1 The App project");
  const appTable = appSection.split(
    "Not set in the project, on purpose:",
  )[0] as string;
  const rows = rowsOf(appTable);
  const row = (name: string): Row => {
    const found = rows.find((candidate) => candidate.names.includes(name));
    if (!found) throw new Error(`no row for ${name} in the App table`);
    return found;
  };
  const named = rows.flatMap((candidate) => candidate.names);
  const notSet = appSection.split(
    "Not set in the project, on purpose:",
  )[1] as string;

  /** Every variable the files that decide the hosted App's behavior read, and the code's own lists of them. */
  function variablesOfTheCode(): Set<string> {
    const files = [
      "app/src/dispatch/config.ts",
      "app/src/dispatch/sweep-settings.ts",
      "app/src/cron/auth.ts",
      "app/src/db/config.ts",
      "app/src/llm/config.ts",
      "app/src/operator-api/token.ts",
      "app/src/runner-api/token-auth.ts",
      "app/src/auth/config.ts",
      "app/src/crypto/app-secret.ts",
      "app/src/deploy/startup.ts",
    ];
    const names = new Set<string>();
    for (const file of files) {
      const source = read(file);
      for (const match of source.matchAll(
        /\benv\.([A-Z][A-Z0-9_]+)|\(\s*env,\s*"([A-Z][A-Z0-9_]+)"|\benv\[\s*"([A-Z][A-Z0-9_]+)"\s*\]|\brequired\(\s*env,\s*"([A-Z][A-Z0-9_]+)"/g,
      ))
        for (const name of match.slice(1)) if (name) names.add(name);
    }
    for (const name of [
      ...LLM_DEFAULT_VARIABLES,
      ...OTHER_CREDENTIAL_VARIABLES,
    ])
      names.add(name);
    names.add("APP_SECRET");
    names.add("BETTER_AUTH_URL");
    return names;
  }

  /** A name is "not set" when the guide's list says so, by name or by a prefix like `GITHUB_*`. */
  function onTheNotSetList(name: string): boolean {
    const heads = notSet
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2).split(":")[0] as string);
    return [...heads.join(" ").matchAll(/`([A-Z][A-Z0-9_]*\*?)`/g)].some(
      (match) => {
        const entry = match[1] as string;
        return entry.endsWith("*")
          ? name.startsWith(entry.slice(0, -1))
          : name === entry;
      },
    );
  }

  // #333-T02, #333-T04
  it("has a row for every variable the code reads, or says it is not set", () => {
    const missing = [...variablesOfTheCode()].filter(
      (name) => !named.includes(name) && !onTheNotSetList(name),
    );

    expect(variablesOfTheCode().size).toBeGreaterThan(20);
    expect(missing).toEqual([]);
  });

  // #333-T02
  it("is covered by .env.example, which holds a placeholder for every variable of a row", () => {
    const known = envExampleVariables();

    expect(named.filter((name) => !known.has(name))).toEqual([]);
    expect(rows.length).toBeGreaterThan(15);
  });

  // #333-T04
  it("does not give a row to a variable that the guide says is not set", () => {
    expect(named.filter((name) => onTheNotSetList(name))).toEqual([]);
  });

  // #333-T04
  it("says Required where the code refuses to start or to serve without the variable", () => {
    const base = {
      APP_SECRET: "m".repeat(40),
      BETTER_AUTH_URL: "https://reviews.example.com",
      DATABASE_URL: "postgres://app:pw@db.example.com/db",
      RUNNER_TOKEN: GOOD_TOKEN,
    };
    const without = (name: string): Record<string, string | undefined> => ({
      ...base,
      [name]: undefined,
    });

    expect(resolveAppSecret(without("APP_SECRET")).ok).toBe(false);
    expect(() => loadAuthConfig(without("BETTER_AUTH_URL"))).toThrow(
      /BETTER_AUTH_URL/,
    );
    expect(() => loadDatabaseConfig(without("DATABASE_URL"))).toThrow(
      /Postgres/i,
    );
    expect(
      findDeploymentConfigProblems(without("RUNNER_TOKEN")).join(" "),
    ).toContain("RUNNER_TOKEN");
    const cron = new Request(
      "https://app.example.com/api/internal/dispatch-sweep",
    );
    expect(refuseUnlessCron(cron, {})?.status).toBe(401);
    for (const name of [
      "APP_SECRET",
      "BETTER_AUTH_URL",
      "DATABASE_URL",
      "RUNNER_TOKEN",
      "CRON_SECRET",
    ])
      expect(row(name).required, name).toMatch(/^yes/);
    // RUNNER_DISPATCH is `poll` without it: the guide asks for it in step 5 only.
    expect(dispatchConfigProblems({})).toEqual([]);
    expect(row("RUNNER_DISPATCH").required).toContain("in step 5");
  });

  // #333-T04
  it("says what a webhook mode needs, and which of its variables are optional", () => {
    const problems = dispatchConfigProblems({ RUNNER_DISPATCH: "webhook" });

    expect(problems.join(" ")).toContain("RUNNER_WEBHOOK_URL");
    expect(problems.join(" ")).toContain("RUNNER_WEBHOOK_SECRET");
    expect(row("RUNNER_WEBHOOK_URL").required).toBe("with `webhook`");
    expect(row("RUNNER_WEBHOOK_SECRET").required).toBe("with `webhook`");
    // The key id (default k1), the previous key and the bypass token are not needed.
    expect(dispatchConfigProblems(WEBHOOK)).toEqual([]);
    expect(row("RUNNER_WEBHOOK_KEY_ID").required).toBe("optional");
    expect(row("RUNNER_WEBHOOK_KEY_ID").text).toContain("default `k1`");
    expect(row("RUNNER_WEBHOOK_SECRET_PREVIOUS").required).toBe("optional");
    expect(row("RUNNER_WEBHOOK_BYPASS_TOKEN").required).toBe(
      "only if the Dispatcher is protected",
    );
    expect(
      dispatchConfigProblems({
        ...WEBHOOK,
        RUNNER_WEBHOOK_SECRET_PREVIOUS: "p".repeat(40),
      }).join(" "),
    ).toContain("RUNNER_WEBHOOK_KEY_ID_PREVIOUS");
    expect(row("RUNNER_WEBHOOK_SECRET_PREVIOUS").text).toContain(
      "both or neither",
    );
    // The optional ones of the plain App do not stop it from starting.
    expect(findDeploymentConfigProblems({ RUNNER_TOKEN: GOOD_TOKEN })).toEqual(
      [],
    );
    for (const name of [
      "DATABASE_POOL_MAX",
      "RUNNER_DISPATCH_GIVE_UP_SECONDS",
      "OPERATOR_API_TOKEN",
    ])
      expect(row(name).required, name).toBe("optional");
    expect(row("RUNNER_DISPATCH_MAX_RUNNING").required).toBe("**set it**");
  });

  // #333-T04
  it("marks as secret every credential the code knows and what is named like one, and nothing else", () => {
    const credentials = OTHER_CREDENTIAL_VARIABLES.filter((name) =>
      named.includes(name),
    );

    expect(credentials).toEqual(
      expect.arrayContaining([
        "RUNNER_TOKEN",
        "APP_SECRET",
        "OPERATOR_API_TOKEN",
        "CRON_SECRET",
      ]),
    );
    for (const name of credentials)
      expect(row(name).secret, name).toMatch(/^\*\*yes\*\*/);
    for (const candidate of rows)
      for (const name of candidate.names) {
        const isSecret = /^\*\*yes\*\*/.test(candidate.secret);
        // The database URL carries a password; every other secret is named like one.
        const expected =
          name === "DATABASE_URL" ||
          candidate.names.some((each) =>
            /(?:SECRET|TOKEN)(?:_PREVIOUS)?$/.test(each),
          );
        expect(isSecret, name).toBe(expected);
      }
  });

  // #333-T04
  it("states the ranges and defaults of the code", () => {
    expect(row("DATABASE_POOL_MAX").text).toContain(
      `1 to ${String(MAX_POOL_MAX)}, default ${String(DEFAULT_POOL_MAX)}.`,
    );
    const pool = (value: string) =>
      loadDatabaseConfig({
        DATABASE_URL: "postgres://app:pw@db.example.com/db",
        DATABASE_POOL_MAX: value,
      });
    expect(pool(String(MAX_POOL_MAX))).toMatchObject({
      poolMax: MAX_POOL_MAX,
    });
    expect(() => pool(String(MAX_POOL_MAX + 1))).toThrow();
    expect(() => pool("0")).toThrow();

    expect(row("RUNNER_DISPATCH_GIVE_UP_SECONDS").text).toContain(
      `${String(GIVE_UP_SECONDS_RANGE.min)} to ${String(GIVE_UP_SECONDS_RANGE.max)}, default **${String(DEFAULT_GIVE_UP_SECONDS)}** in webhook mode, off in poll mode, \`0\` turns it off`,
    );
    expect(loadSweepSettings({ ...WEBHOOK }).giveUpMs).toBe(
      DEFAULT_GIVE_UP_SECONDS * 1000,
    );
    expect(loadSweepSettings({}).giveUpMs).toBeNull();
    expect(
      loadSweepSettings({ ...WEBHOOK, RUNNER_DISPATCH_GIVE_UP_SECONDS: "0" })
        .giveUpMs,
    ).toBeNull();
    expect(row("RUNNER_DISPATCH_MAX_RUNNING").text).toContain(
      `${String(MAX_RUNNING_RANGE.min)} to ${String(MAX_RUNNING_RANGE.max)}`,
    );
    expect(
      loadSweepSettings({
        ...WEBHOOK,
        RUNNER_DISPATCH_MAX_RUNNING: String(MAX_RUNNING_RANGE.max),
      }).maxRunning,
    ).toBe(MAX_RUNNING_RANGE.max);
    expect(
      loadSweepSettings({
        ...WEBHOOK,
        RUNNER_DISPATCH_MAX_RUNNING: String(MAX_RUNNING_RANGE.max + 1),
      }).maxRunning,
    ).toBeNull();

    for (const name of [
      "APP_SECRET",
      "RUNNER_TOKEN",
      "CRON_SECRET",
      "RUNNER_WEBHOOK_SECRET",
      "OPERATOR_API_TOKEN",
    ])
      expect(row(name).text, name).toContain(
        `At least ${String(MIN_DISPATCH_SECRET_LENGTH)} characters`,
      );
    expect(
      operatorTokenProblem({ OPERATOR_API_TOKEN: "x".repeat(31) }),
    ).not.toBeNull();
    expect(
      operatorTokenProblem({ OPERATOR_API_TOKEN: "x".repeat(32) }),
    ).toBeNull();
    expect(
      dispatchConfigProblems({
        ...WEBHOOK,
        RUNNER_WEBHOOK_SECRET: "x".repeat(31),
      }).length,
    ).toBeGreaterThan(0);
    expect(row("LLM_MODEL").text).toContain("`anthropic/claude-haiku-5.5`");
  });

  // #333-T04
  it("states that the signing secret differs from every other credential, and the code refuses a copy", () => {
    for (const name of OTHER_CREDENTIAL_VARIABLES)
      expect(
        dispatchConfigProblems({
          ...WEBHOOK,
          [name]: WEBHOOK.RUNNER_WEBHOOK_SECRET,
        }).join(" "),
        name,
      ).toContain(name);
    expect(section("### Generating the secrets")).toContain(
      "different from every other secret",
    );
    expect(row("RUNNER_WEBHOOK_SECRET").text).toContain(
      "Different from every other secret",
    );
    expect(row("RUNNER_WEBHOOK_BYPASS_TOKEN").text).toContain(
      "Different from the signing secret",
    );
  });

  // #333-T04
  it("states the setup code's lifetime", () => {
    expect(
      section(
        "### Step 4. The setup code, then the first-run setup in the browser",
      ),
    ).toMatch(
      new RegExp(`valid for ${String(SETUP_CODE_TTL_MS / 60_000)}\\s+minutes`),
    );
  });

  // #333-T04
  it("keeps DATABASE_URL_MIGRATE out of the project's variables and DATABASE_URL off a transaction pooler", () => {
    expect(named).not.toContain("DATABASE_URL_MIGRATE");
    expect(onTheNotSetList("DATABASE_URL_MIGRATE")).toBe(true);
    expect(row("DATABASE_URL").text).toContain(
      "A direct or session-mode connection, never a transaction pooler",
    );
    expect(guide).toContain("withPostgresAdvisoryLock");
    expect(guide).toContain("#371");
  });
});

describe("the hosted deployment guide and vercel.json", () => {
  const appConfig = JSON.parse(read("app/vercel.json")) as {
    regions: string[];
    crons: Array<{ path: string; schedule: string }>;
  };
  const dispatcherConfig = JSON.parse(read("dispatcher/vercel.json")) as {
    regions: string[];
    functions: Record<string, { maxDuration: number }>;
    crons: Array<{ path: string; schedule: string }>;
  };

  // #333-T04
  it("names the region of both projects", () => {
    expect(appConfig.regions).toEqual(["fra1"]);
    expect(dispatcherConfig.regions).toEqual(["fra1"]);
    expect(guide).toContain("`fra1`");
  });

  // #333-T04
  it("names the crons of the App and of the Dispatcher and the function limit", () => {
    for (const { path } of appConfig.crons)
      expect(guide, path).toContain(`\`${path}\``);
    const sweep = appConfig.crons.find(({ path }) =>
      path.endsWith("dispatch-sweep"),
    );
    expect(sweep?.schedule).toBe("0 */2 * * *");
    expect(guide).toMatch(/every\s+2\s+hours/);
    expect(guide).toContain(
      `\`maxDuration\` of **${String(dispatcherConfig.functions["src/index.ts"]?.maxDuration)} seconds**`,
    );
    expect(guide).toContain("beta limit");
    expect(dispatcherConfig.crons).toEqual([
      { path: "/api/cron/reap-sandboxes", schedule: "*/5 * * * *" },
    ]);
    expect(guide).toContain("`/api/cron/reap-sandboxes`");
    expect(guide).toMatch(/every 5\s+minutes/);
  });
});

describe("the hosted deployment guide as a procedure", () => {
  const TITLES = [
    "Migrate the database",
    "Put the variables into Infisical (still in poll mode)",
    "First deployment",
    "The setup code, then the first-run setup in the browser",
    "Switch the App to webhook mode",
    "Smoke test: a Diff review, then a Dynamic review",
  ];
  const step = (number: number): string =>
    section(`### Step ${String(number)}. ${TITLES[number - 1] as string}`);

  // #333-T01
  it("has the steps of the first deployment in the order the work asks for", () => {
    const headings = [...guide.matchAll(/^### (Step \d+\. .+)$/gm)].map(
      (match) => match[1] as string,
    );

    expect(headings).toEqual(
      TITLES.map((title, index) => `Step ${String(index + 1)}. ${title}`),
    );
  });

  // #333-T01
  // #403-T11
  it("puts into each step what belongs to it, and the webhook only into step 5", () => {
    expect(step(1)).toContain("pnpm --dir app migrate");
    expect(step(1)).toContain("read -rs");
    expect(step(1)).not.toContain("setup-code");

    // Poll mode first: the App is configured with its cron secret and its address, without any webhook variable.
    expect(step(2)).toContain("`BETTER_AUTH_URL`");
    expect(step(2)).toContain("`CRON_SECRET`");
    expect(step(2)).toContain("production domain");
    expect(flat(step(2))).toContain(
      "**except** the `RUNNER_DISPATCH` and `RUNNER_WEBHOOK_*` ones",
    );
    expect(step(2)).not.toContain("RUNNER_DISPATCH=webhook");
    expect(step(2)).not.toContain("RUNNER_WEBHOOK_URL=");
    // The Dispatcher's variables go in too, and the snapshot keys are left to the pipeline.
    expect(step(2)).toContain("`RUNNER_API_URL`");
    expect(step(2)).toContain("`DISPATCHER_MAX_RUNNING`");
    expect(flat(step(2))).toContain(
      "**Leave the three `SANDBOX_SNAPSHOT_*` keys unset**",
    );

    // The first deployment is the workflow: snapshot, canary and promotion included, nothing by hand.
    expect(step(3)).toContain("*Deploy production*");
    expect(step(3)).toContain("`persist`");
    expect(step(3)).toContain("`cleanup`");
    expect(flat(step(3))).toContain("*Dispatcher canary*");
    expect(flat(step(3))).toContain("asks the Vercel API");
    expect(flat(step(3))).toContain("`canary_image_mismatch`");
    expect(step(3)).toContain("POST /probe");
    expect(step(3)).toContain("`SCHEMA_BEHIND`");
    expect(step(3)).toContain("`CRON_SECRET`");
    expect(step(3)).not.toContain("vercel deploy --prebuilt --prod\n");

    expect(step(4)).toContain("pnpm --dir app setup-code");
    expect(step(4)).toContain("/api/webhooks/github-app");
    expect(step(4)).toContain("`/admin/llm`");

    for (const name of [
      "RUNNER_DISPATCH=webhook",
      "RUNNER_WEBHOOK_URL=https://<dispatcher>/dispatch",
      "RUNNER_WEBHOOK_SECRET",
      "RUNNER_WEBHOOK_KEY_ID",
      "RUNNER_DISPATCH_MAX_RUNNING",
    ])
      expect(step(5), name).toContain(name);
    expect(step(5)).toContain("`dispatch_unavailable`");
    expect(step(5)).toContain("Switch soon after step 4");
    expect(step(5)).toContain("RUNNER_DISPATCH_GIVE_UP_SECONDS");
    for (const earlier of [1, 2, 3, 4])
      expect(step(earlier)).not.toContain("RUNNER_DISPATCH=webhook");

    expect(step(6).indexOf("**Diff.**")).toBeGreaterThanOrEqual(0);
    expect(step(6).indexOf("**Diff.**")).toBeLessThan(
      step(6).indexOf("**Dynamic.**"),
    );
    expect(step(6)).toContain("**Done when:**");
  });

  // #333-T01
  it("explains the database roles with the guide's commands and the safe way to generate secrets", () => {
    const needs = section("## 2. What you need first");

    expect(needs).toContain("version 15 or newer");
    expect(needs).toContain(
      "grant usage, create on schema public to cr_migrate",
    );
    expect(needs).toContain("alter default privileges in schema public");
    expect(needs).not.toContain("alter default privileges for role");
    expect(needs).toContain(
      "grant select, insert, update, delete on all tables in schema public to cr_app",
    );
    expect(needs).toContain("openssl rand -hex 32");
    expect(needs).toContain("transaction pooler");
    expect(flat(needs)).toContain("pooler in **session mode**");
    expect(guide).not.toContain("migrate role's URL first");
    expect(guide).toContain("app/src/db/role-split.integration.test.ts");
    // No secret is typed into a command line or written as an assignment with a value.
    expect(guide).not.toMatch(
      /(?:APP_SECRET|RUNNER_TOKEN|PASSWORD|_PW|SECRET)=['"][^$<'"\s]/,
    );
    expect(guide).not.toMatch(/echo [^\n|]*\| *(?:vercel|gh) /);
  });

  // #333-T04
  it("describes the release path with a staged production deployment, not a preview", () => {
    const rebuild = section(
      "### 5.1 The golden snapshot: built, wired in and cleaned up by the pipeline",
    );

    expect(flat(rebuild)).toContain(
      "`vercel deploy --env SANDBOX_SNAPSHOT_ID=...",
    );
    expect(rebuild).toContain("**Promote**");
    expect(rebuild).toContain("`--skip-retention`");
    expect(rebuild).not.toMatch(/Deploy the Dispatcher to a preview/);
  });

  // #333-T04
  it("documents the operator's key and managed workspaces as merged", () => {
    const keys = section(
      "### 3.5 LLM keys: a workspace's own, or the operator's",
    );

    expect(keys).toContain("`/admin/llm`");
    expect(keys).toContain('`keyMode: "managed"`');
    expect(keys).toContain("PUT /api/operator/v1/workspaces/{id}/entitlements");
    expect(keys).toContain("Upgrade every App instance first");
    expect(keys).toContain("`llm_not_configured`");
    expect(keys).toContain("`operator_key_missing`");
    // #432: the model of a managed workspace is a catalog entry's, not the instance default; the tiers go away with #434.
    expect(keys).toContain("`managed_model_unavailable`");
    expect(keys).toContain("catalog");
    expect(keys).toContain("#434");
    expect(keys).not.toContain("is yours, per tier");
    expect(flat(keys)).toContain(
      "`LLM_MODEL` and `LLM_MAX_TOKENS` are not used",
    );
    expect(flat(keys)).not.toContain("`LLM_MODEL` and `LLM_MAX_TOKENS` apply");
    expect(guide).not.toMatch(/#276[^\n]*pending/i);
    expect(guide).not.toMatch(/until it merges, every workspace/);
    expect(read("app/src/llm/README.md")).toContain("/admin/llm");
    expect(read("app/src/operator-api/README.md")).toContain(
      "Upgrade every app instance before setting any workspace to `managed`",
    );
  });

  // #395-T02
  it("says that the cron is a sparse safety net, why it is sparse, what the normal flow does without it and how late each abnormal case can be", () => {
    const needs = flat(section("## 2. What you need first"));
    const sweep = flat(section("### 5.7 What depends on the 2 hour sweep"));
    const overview = flat(section("## 1. What you are deploying"));
    const appReadme = flat(read("app/src/dispatch/README.md"));

    expect(needs).toContain(
      "The 2 hour cron is a safety net, and it is required.",
    );
    expect(needs).toContain("The normal path does not depend on it");
    expect(overview).toContain("scales to zero");
    expect(overview).toContain("**The normal flow never waits for it**");
    expect(needs).toContain(
      "A plan that allows only daily crons cannot run this deployment",
    );
    // The per-duty timing: what is done at once, and what can be up to two hours late.
    expect(sweep).toContain(
      "**The normal flow, without the sweep (webhook mode):**",
    );
    expect(sweep).toContain("There is no debounce.");
    expect(sweep).toContain("repeats it up to three more times");
    expect(sweep).toContain("When a job ends");
    expect(sweep).toContain(
      "**Only the sweep (and so up to about 2 hours late)",
    );
    for (const abnormal of [
      "`dispatch_unavailable`",
      "`not_capable`",
      "A refusal notice whose post failed",
      "up to 2 hours",
    ])
      expect(sweep, abnormal).toContain(abnormal);
    expect(guide).not.toMatch(/per-minute/);
    expect(guide).not.toMatch(/once a minute/);
    expect(guide).not.toContain("push-triggered reviews never start");
    expect(guide).not.toContain(DEBOUNCE_VARIABLE);
    // Leases do not stop expiring without the cron: every claim expires the lapsed ones, so it is late, not never.
    expect(read("app/src/db/repositories/runner-jobs-repository.ts")).toMatch(
      /async claimNext[\s\S]{0,500}await expire\(trx, current(, \w+)*\)/,
    );
    expect(
      flat(
        section("### Step 6. Smoke test: a Diff review, then a Dynamic review"),
      ),
    ).toContain("**Push to the open pull request**");
    // What the guide says is what the App's own documentation says about the sweep and the normal flow.
    expect(appReadme).toContain(
      "`GET /api/internal/dispatch-sweep`, **every 2 hours**",
    );
    expect(appReadme).toContain("Between two sweeps");
    expect(appReadme).not.toContain("the 90 second debounce");
  });

  // #333-e2e
  it("points to the hosted e2e lane that exists, no longer calls #332 pending, and states what still relies on the lease after #375", () => {
    const limits = flat(section("## 8. Known limits and what is not verified"));
    const ci = read(".github/workflows/ci.yml");

    expect(ci).toMatch(/^ {2}e2e-hosted:/m);
    expect(read("Makefile")).toMatch(/^test-e2e-hosted:/m);
    expect(read("TESTING.md")).toContain("Hosted e2e lane");
    expect(limits).toContain("the lane **`e2e-hosted`** (#332;");
    expect(limits).toContain("`make test-e2e-hosted`");
    expect(limits).toContain("`E2E_DATABASE_URL`");
    expect(guide).not.toMatch(/#332[^\n]*pending/i);
    expect(guide).not.toMatch(/pending[^\n]*#332/i);
    // #487: the Dispatcher holds no supervision after the hand-over, so the lease is what finds a Worker that died.
    expect(limits).toContain(
      "A Worker that dies still holds its slot until its lease lapses",
    );
    expect(limits).toContain("`lease_expired`");
    expect(limits).not.toContain("`worker_wait_failed`");
    expect(limits).not.toContain("follow-up #375");
    expect(section("## 9. Follow-ups")).not.toContain("- #375:");
    expect(limits).toContain("on **your** Postgres provider");
  });

  // #333-db-readme
  it("no longer relies on the platform holding traffic back from a deployment that is ahead of the database", () => {
    const readmeOfTheDatabase = flat(read("app/src/db/README.md"));

    expect(readmeOfTheDatabase).not.toContain(
      "keeps routing to the previous deployment",
    );
    expect(readmeOfTheDatabase).toContain(
      "nothing makes the platform hold traffic back",
    );
    expect(
      flat(section("### 5.6 Updating the App or the Dispatcher")),
    ).toContain("Do not rely on the platform to hold traffic back");
  });

  // #333-T04
  it("covers the operations: pin, rotation, the three codes and rollback", () => {
    const operations = section("## 5. Operations");

    expect(operations).toContain("`snapshot-decide`");
    expect(operations).toContain("### 5.2 Rotating secrets");
    for (const code of ["dispatch_unavailable", "launch_failed"])
      expect(operations, code).toContain(`\`${code}\``);
    expect(guide).toContain("## 7. Rolling back");
  });

  // #333-T04
  it("explains codes that exist: the two on the Runs pages have a text, and no code of the retired per-instance probe is left", () => {
    const copy = errorCopy(getProductIdentity());
    expect(copy).toHaveProperty("dispatch_unavailable");
    expect(copy).toHaveProperty("launch_failed");
    // #479: the Dispatcher runs no probe on a dispatch, so `capability_not_proven` is not raised any more.
    expect(guide).not.toContain("capability_not_proven");
    expect(guide).not.toContain("withCapabilityProbe");
  });

  // #479-T12
  it("has a row for the signal that a hosted container cannot be hardened, and does not promise that the function limit is never reached", () => {
    const codes = section(
      "### 5.3 Reading what the Runs page and the logs say",
    );
    const text = flat(guide);

    expect(codes).toMatch(/\| Runs page \| `dynamic_engine_unavailable` \|/);
    expect(flat(codes)).toContain("run the canary against it");
    expect(text).not.toContain("are never reached");
    expect(flat(read("docs/dynamic-review.md"))).toContain(
      "Run the deploy canary on the live deployment",
    );
  });

  // #479-T08
  it("states that the deploy canary is the only proof, and that DISPATCHER_PROBE_TTL_SECONDS is retired", () => {
    const text = flat(guide);

    expect(text).toContain("The canary is the only proof");
    expect(text).toContain("deprecated_setting");
    expect(text).toMatch(/\*\*Retired:\*\* `DISPATCHER_PROBE_TTL_SECONDS`/);
    // No row of the variable table is left for it: nothing is set by the operator any more.
    expect(text).not.toContain("| `DISPATCHER_PROBE_TTL_SECONDS` |");
    expect(text).not.toContain(
      "held in memory for `DISPATCHER_PROBE_TTL_SECONDS`",
    );
  });

  // #333-T01
  it("names the prerequisites: plan limits, Postgres with two roles, a separate GitHub App, two projects and the two environments", () => {
    const needs = section("## 2. What you need first");

    expect(needs).toContain("1800 seconds");
    expect(flat(needs)).toContain("**two roles**");
    expect(needs).toContain("`DATABASE_URL_MIGRATE`");
    expect(needs).toContain("**A GitHub App for the hosted instance.**");
    expect(needs).toContain("`app/`");
    expect(needs).toContain("`dispatcher/`");
    // The former environments and the list of hosts are retired, and the guide says so.
    for (const name of [
      "`hosted-snapshot`",
      "`hosted-canary`",
      "`DISPATCHER_CANARY_HOSTS`",
    ])
      expect(flat(needs), name).toMatch(
        new RegExp(`${name}[^.]*\\*\\*retired\\*\\*|[Rr]etired:[^\\n]*${name}`),
      );
  });
});

describe("the hosted deployment guide as a document", () => {
  const documents = [
    ["docs/deployment-vercel.md", guide],
    ["docs/dispatcher.md", dispatcherDoc],
  ] as const;

  function anchorsOf(text: string): Set<string> {
    return new Set(
      [...text.matchAll(/^#{1,6} (.+)$/gm)].map((match) =>
        (match[1] as string)
          .toLowerCase()
          .replace(/`/g, "")
          .replace(/[^a-z0-9 _-]/g, "")
          .replace(/ /g, "-"),
      ),
    );
  }

  // #333-T01
  it("links only to files that exist and to headings that exist", () => {
    const broken: string[] = [];
    for (const [file, text] of documents) {
      const own = anchorsOf(text);
      for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const link = match[1] as string;
        if (/^https?:/.test(link)) continue;
        const [target, anchor] = link.split("#") as [
          string,
          string | undefined,
        ];
        if (target === "") {
          if (anchor && !own.has(anchor)) broken.push(`${file}: ${link}`);
          continue;
        }
        const path = resolve(repoRoot, "docs", target);
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

  // #333-T01
  it("is linked from the README and from the golden snapshot runbook", () => {
    expect(readme).toContain("](docs/deployment-vercel.md)");
    expect(readme).toContain("](docs/dispatcher.md)");
    expect(read("docs/golden-snapshot.md")).toContain(
      "](deployment-vercel.md)",
    );
    expect(read("dispatcher/README.md")).toContain(
      "](../docs/deployment-vercel.md)",
    );
  });

  /** Everything this change added that is public, with the README reduced to its section of the guide. */
  function publicTexts(): Array<readonly [string, string]> {
    const readmeSection = readme.slice(
      readme.indexOf("## Deploy on Vercel (hosted)"),
      readme.indexOf("## Lint, typecheck, test"),
    );
    return [
      ...documents,
      ["dispatcher/.env.example", read("dispatcher/.env.example")],
      ["README.md (Deploy on Vercel)", readmeSection],
    ];
  }

  // #333-T03
  it("holds no account id, snapshot id, image digest, secret shape or em dash", () => {
    for (const [file, text] of publicTexts()) {
      expect(text, file).not.toMatch(/\bsnap_[A-Za-z0-9]{6,}/);
      expect(text, file).not.toMatch(/\b(?:team|prj|usr)_[A-Za-z0-9]{6,}/);
      expect(text, file).not.toMatch(/sha256:[0-9a-f]{64}/);
      expect(text, file).not.toMatch(/\bgh[pousr]_[A-Za-z0-9]{30,}/);
      expect(text, file).not.toMatch(/\bvc[a-z]_[A-Za-z0-9]{20,}/);
      expect(text, file).not.toMatch(/\bcrj_[A-Za-z0-9]{10,}/);
      expect(text, file).not.toContain("—");
    }
  });

  // #333-T03
  it("names no price, no company or customer and no personal address", () => {
    for (const [file, text] of publicTexts()) {
      expect(text, file).not.toMatch(/[$€£]\s?\d/);
      expect(text, file).not.toMatch(
        /\b\d[\d.,]*\s?(?:USD|EUR|GBP|dollars?|euros?|cents?)\b/i,
      );
      expect(text, file).not.toMatch(/\b(?:per month|\/month|monthly fee)\b/i);
      expect(text, file).not.toMatch(
        /\b(?:GmbH|Inc\.|Ltd\.?|LLC|Corp\.|S\.A\.|B\.V\.)(?=\W|$)/,
      );
      expect(text, file).not.toMatch(/\bcustomers?\b/i);
      expect(text, file).not.toMatch(
        /[\w.+-]+@(?!example\.com\b|users\.noreply\.github\.com\b)[\w-]+\.\w{2,}/,
      );
    }
  });

  // #333-T03
  it("uses only placeholder host names and the names of the platforms", () => {
    const allowed = new Set([
      "github.com",
      "vercel.com",
      "localhost",
      "127.0.0.1",
    ]);
    for (const [file, text] of publicTexts()) {
      const hosts = [...text.matchAll(/https?:\/\/([a-z0-9.<>_-]+)/gi)].map(
        (match) => (match[1] as string).toLowerCase(),
      );
      for (const host of hosts)
        expect(
          host.startsWith("<") ||
            host === "example.com" ||
            host.endsWith(".example.com") ||
            allowed.has(host),
          `${file}: ${host}`,
        ).toBe(true);
    }
  });
});

describe("the deployment pipeline in the guide", () => {
  const setup = section("### 2.1 Setup of the deployment pipeline (once)");
  const workflowFiles = [
    ".github/workflows/deploy-production.yml",
    ".github/workflows/vercel-stage.yml",
    ".github/workflows/dispatcher-canary.yml",
    ".github/workflows/golden-snapshot.yml",
    ".github/workflows/rollback-production.yml",
  ].map((path) => read(path));
  const everything = [
    ...workflowFiles,
    read(".github/actions/infisical-ci-secrets/action.yml"),
  ].join("\n");

  // #403-T11
  it("lists the GitHub side: the environment production, its branch rule and its four secrets, as secrets", () => {
    expect(setup).toContain("**`production`**");
    expect(flat(setup)).toContain("only the branch `main`");
    for (const name of [
      "INFISICAL_CLIENT_ID",
      "INFISICAL_CLIENT_SECRET",
      "INFISICAL_DOMAIN",
      "INFISICAL_PROJECT_SLUG",
    ]) {
      expect(setup, name).toContain(`| \`${name}\``);
      expect(everything, name).toContain(`secrets.${name}`);
      expect(everything, name).not.toContain(`vars.${name}`);
    }
    expect(flat(setup)).toContain("**not** variables");
  });

  // #403-T11
  it("lists every key of /ci that a workflow loads, and no other", () => {
    const loaded = new Set<string>();
    for (const text of workflowFiles)
      for (const match of text.matchAll(/secret-names: (.+)/g))
        for (const name of (match[1] as string).split(" "))
          if (/^[A-Z][A-Z0-9_]+$/.test(name)) loaded.add(name);
    loaded.delete("VERCEL_ORG_ID");
    const ci = (setup.split("The keys of **`/ci`**")[1] ?? "").split(
      "**Infisical Secret Sync**",
    )[0] as string;
    const documented = [...ci.matchAll(/^\s*\| `([A-Z][A-Z0-9_]+)` \|/gm)].map(
      (match) => match[1] as string,
    );
    // The project id of the stage job is a parameter of the caller.
    for (const name of [
      "VERCEL_APP_PROJECT_ID",
      "VERCEL_DISPATCHER_PROJECT_ID",
    ])
      loaded.add(name);
    expect(documented.sort()).toEqual([...loaded].sort());
    // Eight for the hosted pair, four more for the dormant second App (#732, section 5.8).
    expect(documented).toHaveLength(12);
  });

  // #403-T11
  it("lists the three Infisical folders, the two Secret Syncs, the shared values and the read-only machine identity", () => {
    expect(setup).toContain("`/ci`");
    expect(setup).toContain("`/app`");
    expect(setup).toContain("`/dispatcher`");
    expect(setup).toContain("`prod`");
    expect(flat(setup)).toContain(
      "source `prod` `/app` to the **App** project, environment **Production**",
    );
    expect(flat(setup)).toContain(
      "source `prod` `/dispatcher` to the **Dispatcher** project, environment **Production**",
    );
    expect(setup).toContain("Infisical secret references");
    for (const name of [
      "RUNNER_TOKEN",
      "RUNNER_WEBHOOK_SECRET",
      "DISPATCHER_SIGNING_SECRET",
      "RUNNER_DISPATCH_MAX_RUNNING",
      "DISPATCHER_MAX_RUNNING",
      "BETTER_AUTH_URL",
      "RUNNER_API_URL",
    ])
      expect(setup, name).toContain(`\`${name}\``);
    expect(setup).toContain("**Universal Auth**");
  });

  // #403-T19
  it("describes the one identity's role exactly: read /ci, create and edit three keys of /dispatcher, nothing else", () => {
    const text = flat(setup);
    expect(text).toContain("**one** identity");
    expect(setup).toContain(
      "| Secrets: describe and read value | `prod` | `/ci` | any |",
    );
    expect(setup).toContain(
      "| Secrets: describe, create and edit | `prod` | `/dispatcher` | `SANDBOX_SNAPSHOT_ID`, `SANDBOX_IMAGE_DIGEST`, `SANDBOX_SNAPSHOT_COMMIT` |",
    );
    expect(text).toContain("**No** read of `/app` or `/dispatcher`");
    expect(text).toContain("recommended hardening");
    expect(text).toContain("The pipeline does not depend on it");
    expect(guide).not.toMatch(
      /INFISICAL_\w*SNAPSHOT\w*|second (machine )?identity/,
    );
    expect(text).toContain(
      "`persist` job of `deploy-production.yml` and the `rollback` job of `rollback-production.yml`",
    );
  });

  // #403-T19
  it("explains the failure behaviour: before the promotion nothing changes, after a failed persist the next run repairs", () => {
    const snapshot = flat(
      section(
        "### 5.1 The golden snapshot: built, wired in and cleaned up by the pipeline",
      ),
    );
    expect(snapshot).toContain("**If the run fails before the promotion**");
    expect(snapshot).toContain("`discard` job removes");
    // The outcome of a promotion that failed or timed out is unknown, and the snapshot is left alone.
    expect(snapshot).toContain("the outcome is unknown");
    expect(snapshot).toContain(
      "`discard` runs only when the promotion never started",
    );
    expect(snapshot).toContain(
      "**If the promotion succeeded and `persist` failed:**",
    );
    expect(snapshot).toContain("**prefers it over the variables**");
    expect(snapshot).toContain("**only after the Dispatcher is live**");
    expect(snapshot).toContain("**after every promotion of the Dispatcher**");
    expect(snapshot).toContain("the previous one");
    expect(snapshot).toContain("`IMAGE_INPUT_PATHS`");
    expect(snapshot).toContain(
      "A release that changes the Worker image needs nothing from you",
    );
  });

  // #403-T11
  it("writes every Infisical reference as ${<env>.<folder>.<KEY>} with the environment slug first", () => {
    const references = [
      ...guide.matchAll(/\$\{([A-Za-z0-9_]+\.[A-Za-z0-9_.]+)\}/g),
    ].map((match) => match[1] as string);
    expect(references.length).toBeGreaterThanOrEqual(6);
    for (const reference of references)
      expect(reference, reference).toMatch(
        /^prod\.(ci|app|dispatcher)\.[A-Z][A-Z0-9_]+$/,
      );
    expect(guide).not.toMatch(/\$\{(ci|app|dispatcher)\./);
    expect(flat(setup)).toContain("environment slug first");
  });

  // #403-T11
  it("says where the GitHub App credentials and the model keys come from, since no folder holds them", () => {
    const text = flat(setup);
    expect(text).toContain("no GitHub App credential and no model API key");
    expect(text).toContain("encrypted with `APP_SECRET`");
    expect(text).toContain("/admin/llm");
  });

  // #403-T11
  it("lists the Vercel dashboard steps: the root directories, Git auto-deploy off and the bypass", () => {
    expect(setup).toContain("**Root Directory**");
    expect(setup).toContain("`app`");
    expect(setup).toContain("`dispatcher`");
    expect(setup).toContain("**Git auto-deploy off.**");
    expect(setup).toContain('"git": { "deploymentEnabled": false }');
    expect(setup).toContain("**Protection Bypass for Automation**");
  });

  // #403-T11
  it("marks the retired environments and the list of hosts as retired, and no workflow uses them", () => {
    for (const name of [
      "hosted-snapshot",
      "hosted-canary",
      "DISPATCHER_CANARY_HOSTS",
    ]) {
      expect(setup, name).toContain(name);
      expect(everything, name).not.toContain(name);
    }
    expect(setup).toMatch(/Retired: the environments/);
  });

  // #434-X7
  it("tells the operator what the release that removes the managed model tiers asks for", () => {
    const update = flat(section("### 5.6 Updating the App or the Dispatcher"));
    const start = update.indexOf(
      "Release that removes the managed model tiers",
    );
    expect(start).toBeGreaterThanOrEqual(0);
    const note = update.slice(start, start + 6_000);

    // The entries must be listed in the lists set by hand, or managed reviews stop.
    expect(note).toContain(
      "add the migrated entries to every `modelAccess` list you set on a workspace or on the instance default by hand",
    );
    expect(note).toContain("managed reviews stop");
    expect(note).toContain("`managed_model_unavailable`");
    // The behaviour that differs from the tiers, said once and plainly.
    expect(note).toContain("a tier that had no model for a review kind");
    expect(note).toContain(
      "created after the release get the instance default",
    );
    // The removed route: 401 without a valid token, 404 with one.
    expect(note).toContain("`401` without a valid token and `404` with one");
    // A rollback is not safe, and the three changes go back together.
    expect(note).toContain("A rollback is not safe");
    expect(note).toContain("#432, #433 and #434 together");
    expect(note).toContain("reload");
  });

  // #403-T11
  it("names the pipeline's jobs in their order and the rollback workflow", () => {
    const update = section("### 5.6 Updating the App or the Dispatcher");
    const order = [
      "fresh",
      "migrate",
      "snapshot-decide",
      "snapshot-build",
      "stage-app",
      "stage-dispatcher",
      "health-app",
      "canary",
      "promote-app",
      "persist",
      "cleanup",
      "discard",
      "record",
    ].map((job) => update.indexOf(`| \`${job}\``));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(update).toContain("`promote-app`, `promote-dispatcher`");
    expect(update).toContain("SCHEMA_BEHIND");
    expect(update).toContain("deploy-production");
    expect(flat(update)).toContain("Merging it is the whole release");
    expect(section("## 7. Rolling back")).toContain("*Rollback production*");
  });
});

describe("the snapshot keys, the rollback and the build in the guide", () => {
  const setup = flat(
    section("### 2.1 Setup of the deployment pipeline (once)"),
  );
  const snapshot = flat(
    section(
      "### 5.1 The golden snapshot: built, wired in and cleaned up by the pipeline",
    ),
  );

  // #403-T25
  it("tells the operator not to create the three snapshot keys and not to give them a placeholder, and says why", () => {
    expect(setup).toContain(
      "**Do not create them, and do not give them a placeholder.**",
    );
    expect(setup).toContain("Absent is the supported state");
    expect(setup).toContain("`ConfigError`");
    // Nothing in the guide suggests a placeholder value, and the first step leaves the keys out.
    expect(guide).not.toMatch(/with the value `unset`|value `unset`/);
    expect(guide).not.toMatch(/Create them once/);
    expect(
      flat(
        section(
          "### Step 2. Put the variables into Infisical (still in poll mode)",
        ),
      ),
    ).toContain("**Leave the three `SANDBOX_SNAPSHOT_*` keys unset**");
    expect(setup).toContain(
      "a 403 on that first write means the role lacks it",
    );
  });

  // #403-T21
  it("says that a pair whose snapshot is gone is rebuilt, and that a rollback to a deployment whose snapshot is gone is refused", () => {
    expect(snapshot).toContain("`snapshot_missing`");
    expect(snapshot).toContain("`snapshot_lookup_failed`");
    expect(snapshot).toContain("`live_pair_unavailable`");
    const rollback = flat(section("## 7. Rolling back"));
    expect(rollback).toContain("**refuses with `rollback_snapshot_missing`**");
    expect(rollback).toContain("before it touches either project");
  });

  // #403-T14
  it("describes the image inputs as exactly what the build consumes, and what is not an input", () => {
    expect(snapshot).toContain("`IMAGE_INPUT_PATHS`");
    expect(snapshot).toContain("`scripts.ts`");
    expect(snapshot).toContain(
      "The tests of `runner/`, its README and the logic of the deployment steps are not inputs",
    );
  });

  // #403-T26
  it("states what the build sees: the production runtime variables, not the token", () => {
    const text = flat(section("### 3.4 The GitHub side"));
    expect(text).toContain("**What the build sees.**");
    expect(text).toContain("`.vercel/.env.production.local`");
    expect(text).toContain("without the Vercel token");
  });

  // #403-T26
  it("lists what is accepted or not verified: the deployment records, the mixed trio, targets.production after a rollback", () => {
    const followUps = flat(section("## 9. Follow-ups"));
    expect(followUps).toContain(
      "**Accepted:** every job that runs in the environment `production`",
    );
    expect(followUps).toContain("written one after the other");
    expect(guide).toContain(
      "`targets.production` of the project follows a `vercel rollback`",
    );
  });

  // #403-T21
  it("says that this guide is for a new installation and what a hand-made pair does", () => {
    expect(flat(guide)).toContain("This guide is for a **new installation**");
    expect(flat(guide)).toContain("keeps the old one as the previous snapshot");
  });
});

describe("the second App in the guide (#732)", () => {
  const second = section("### 5.8 A second App (the factory lane)");
  const bringUp = read("docs/factory-bring-up.md");
  const deploy = read(".github/workflows/deploy-production.yml");
  const bootstrap = read("tools/factory-bootstrap/factory-bootstrap.sh");

  // #732-T09
  it("exists, says it is dormant and what switches it on and off", () => {
    expect(flat(second)).toContain("merged dormant");
    expect(second).toContain("`FACTORY_ENABLED`");
    expect(flat(second)).toContain("Switching it off");
    expect(flat(second)).toContain("never blocks the release of the first");
    // Where the switch lives: a repository variable, which the job `factory-flag` reads once.
    expect(flat(second)).toContain(
      "**repository variable** (Settings, Secrets and variables, Actions, *Variables*, repository), not a variable of the environment `production`",
    );
    expect(flat(second)).toContain("`factory-flag` reads it once per run");
    expect(
      section("### 2.1 Setup of the deployment pipeline (once)"),
    ).toContain("`FACTORY_ENABLED`");
  });

  // #747-T08
  it("documents the implementer capability: where it is allowed, that it is off by default, what it needs, and the health expectation", () => {
    const row = section("### 3.1 The App project")
      .split("\n")
      .find((line) => line.startsWith("| `PRODUCT_CAPABILITIES` |"));
    expect(row).toBeDefined();
    const variable = flat(row as string);
    expect(variable).toContain("`implementer` (needs `dynamic-review`;");
    expect(variable).toContain("`factory` only");
    expect(variable).toContain("stops the start");
    expect(variable).toContain("`factory`: `review,dynamic-review`");

    const capabilities = flat(second);
    expect(capabilities).toContain("**The capability set of the factory.**");
    expect(capabilities).toContain("`implementer`");
    expect(capabilities).toContain("never turns it on");
    expect(capabilities).toContain("`dynamic-review,implementer,review`");
    expect(capabilities).toContain("`health-factory` compares the set exactly");
    expect(capabilities).toContain("code-review.com refuses");

    const checklist = flat(bringUp);
    expect(checklist).toContain("`implementer` is allowed on this product");
    expect(checklist).toContain(
      "off until the rollout of the Implementer sets it",
    );
    expect(checklist).not.toContain("—");
  });

  // #732-T09
  it("names every job of the lane, in the order the workflow has them", () => {
    const jobs = [
      ...deploy.matchAll(
        /^ {2}((?:[a-z-]*factory(?:-flag)?|apps-check))\s*:/gm,
      ),
    ].map((match) => match[1] as string);
    expect(jobs.sort()).toEqual(
      [
        "apps-check",
        "factory-flag",
        "health-factory",
        "migrate-factory",
        "promote-factory",
        "stage-factory",
      ].sort(),
    );
    const lane = parse(deploy) as {
      jobs: Record<string, { "timeout-minutes"?: number }>;
    };
    const stage = parse(read(".github/workflows/vercel-stage.yml")) as {
      jobs: Record<string, { "timeout-minutes"?: number }>;
    };
    const limits = Object.values(stage.jobs).map(
      (found) => found["timeout-minutes"],
    );
    for (const name of jobs) {
      expect(second, name).toContain(`\`${name}\``);
      // The row of the job names its time limit: the one of the job, or of the workflow it calls.
      const row = second
        .split("\n")
        .find((line) => line.startsWith(`| \`${name}\` |`));
      expect(row, name).toBeDefined();
      const limit =
        lane.jobs[name]?.["timeout-minutes"] ??
        Math.max(...(limits as number[]));
      expect(row, name).toContain(`| ${limit} min |`);
    }
    // The factory migration is a job of its own and `migrate` is not mentioned as carrying steps of it.
    expect(second).not.toContain("`migrate` (two more steps)");
  });

  // #732-T09
  it("names every variable, key and folder the lane adds, as the workflows and the bootstrap tool have them", () => {
    const workflows = [
      deploy,
      read(".github/workflows/rollback-production.yml"),
      read(".github/workflows/dispatcher-canary.yml"),
    ].join("\n");
    const keys = new Set<string>(["FACTORY_ENABLED", "DISPATCHER_APPS"]);
    for (const match of workflows.matchAll(
      /\b([A-Z][A-Z0-9_]*FACTORY[A-Z0-9_]*)\b/g,
    ))
      keys.add(match[1] as string);
    for (const match of bootstrap.matchAll(
      /^\s+"\/[a-z-]+\|([A-Z][A-Z0-9_]+)\|/gm,
    ))
      keys.add(match[1] as string);
    // Names that are results or inputs of a step, not settings of the lane.
    keys.delete("FACTORY_RESULT");
    keys.delete("FACTORY_DEPLOYMENT");
    keys.delete("FACTORY_DEPLOYMENT_ID");
    keys.delete("FACTORY_URL");
    const documented = `${second}\n${section("### 2.1 Setup of the deployment pipeline (once)")}`;
    for (const key of keys) {
      // Keys the hosted pair already documents elsewhere in the guide (section 3) need no second description.
      if (
        [
          "APP_SECRET",
          "CRON_SECRET",
          "DATABASE_URL",
          "BETTER_AUTH_URL",
          "RUNNER_TOKEN",
          "RUNNER_WEBHOOK_SECRET",
        ].includes(key)
      )
        continue;
      expect(documented, key).toContain(`\`${key}\``);
    }
    expect(second).toContain("`/app-factory`");
    expect(second).toContain("factory_deployment");
    expect(section("## 7. Rolling back")).toContain("`factory_deployment`");
  });

  // #732-T09
  it("lists exactly what a failure of the lane can still affect, says the migration is no gate, and gives the order of the promotions", () => {
    const text = flat(second);
    expect(text).toContain(
      "No job of the first App's path needs a job of the lane, the second App's migration included",
    );
    expect(text).not.toContain("the only gate that reaches the first App");
    expect(text).toContain(
      "What a failure of the lane can still affect, all of it:",
    );
    for (const item of [
      "1. **The run is red**",
      "2. **Delay.**",
      "3. **Shared configuration, not jobs.**",
    ])
      expect(text, item).toContain(item);
    expect(text).toContain("the App, the second App, the Dispatcher");
    // The hung-job delay is documented where the limits are, and the first promotion's manual step is too.
    expect(text).toContain("`promote-dispatcher` waits for `promote-factory`");
    expect(text).toContain("**The first promotion needs one manual step.**");
    expect(text).toContain("vercel promote");
    expect(text).toContain("`app_unreachable: factory`");
  });

  // #732-T09
  it("documents the canary's credential as independent of the switch, in the guide and in the workflow", () => {
    const text = flat(second);
    expect(text).toContain("does not depend on the switch");
    expect(text).toContain(
      "`DISPATCHER_OPERATOR_TOKEN` when `/ci` has that key",
    );
    expect(text).toContain("`RUNNER_TOKEN` when it has not");
    expect(text).toContain("`/ci` and in `/dispatcher` **together**");
    const off = text.split("**Switching it off.**")[1] as string;
    expect(off).toContain("The canary does not change");
    expect(off).not.toContain("operator_token");
    expect(deploy).not.toContain("operator_token");
  });

  // #748-T06
  it("documents the variable that sets the expected capability set, the order of the rollout and what a lone change does", () => {
    const text = flat(second);
    const name = "FACTORY_EXPECTED_CAPABILITIES";
    expect(text).toContain(`\`${name}\``);
    expect(text).toContain("`dynamic-review,review` while it is unset");
    expect(text).toContain("**sorted alphabetically**");
    expect(text).toContain("`dynamic-review,implementer,review`");
    // The order: the code first, then the setting and the variable together.
    expect(text).toContain(
      "Release the code that allows the capability to `main`",
    );
    expect(text).toContain("Only then, together:");
    expect(text).toContain(
      "`PRODUCT_CAPABILITIES` in Infisical `prod` `/app-factory`",
    );
    // The failure mode of a change of one of the two.
    expect(text).toContain("**If only one of the two is changed**");
    expect(text).toContain("`PRODUCT_MISMATCH`");
    expect(text).toContain("nothing live changes");
    expect(text).toContain("is not promoted");
    expect(text).toContain(
      "A variable with a malformed value fails the same job earlier",
    );
    // The variable is listed where the repository variables are, and in the owner's checklist.
    expect(
      section("### 2.1 Setup of the deployment pipeline (once)"),
    ).toContain(name);
    expect(flat(bringUp)).toContain(name);
    expect(flat(bringUp)).toContain("`PRODUCT_MISMATCH`");
    expect(flat(bringUp)).toContain("**together**");
    // The workflow reads the very name the guide documents.
    expect(deploy).toContain(`vars.${name}`);
  });

  // #732-T09
  it("keeps the owner's checklist to four mandatory steps and lists the rest as optional or deferred", () => {
    const mandatory = bringUp
      .split("## Mandatory")[1]
      ?.split("## Optional or deferred")[0] as string;
    const steps = [...mandatory.matchAll(/^(\d+)\. \*\*([^*]+)\*\*/gm)].map(
      (match) => match[2] as string,
    );
    expect(steps).toEqual([
      "Create the database.",
      "Create the Vercel project.",
      "Run the bootstrap, then fill Infisical.",
      "Set the repository variable `FACTORY_ENABLED` to `true`",
    ]);
    const optional = bringUp.split("## Optional or deferred")[1] as string;
    for (const item of [
      "GitHub App",
      "model key",
      "Own domain",
      "Mail",
      "Stripe",
      "Final product name",
      "PostHog",
    ])
      expect(optional, item).toContain(item);
    expect(bringUp).toContain("factory-bootstrap.sh");
    // The entries of the clone that are not secrets are in the checklist too.
    for (const key of [
      "PRODUCT_ID",
      "PRODUCT_CAPABILITIES",
      "RUNNER_DISPATCH",
      "RUNNER_WEBHOOK_URL",
      "RUNNER_WEBHOOK_KEY_ID",
      "RUNNER_DISPATCH_MAX_RUNNING",
      "RUNNER_WEBHOOK_BYPASS_TOKEN",
      "DISPATCHER_APPS",
    ])
      expect(bringUp, key).toContain(`\`${key}\``);
    expect(flat(bringUp)).toContain(
      "repository variable, not a variable of the environment `production`",
    );
    expect(bringUp).toContain("The first run stops at `apps-check`");
    expect(bringUp).not.toContain("—");
    expect(bringUp).not.toMatch(/\bcustomers?\b|GmbH/i);
  });

  // #732-T09
  it("is the same list of entries as the bootstrap tool prints, for the keys of /dispatcher", () => {
    for (const key of [
      "DISPATCHER_APP_FACTORY_TOKEN",
      "DISPATCHER_APP_FACTORY_SIGNING_SECRET",
      "DISPATCHER_OPERATOR_TOKEN",
      "DISPATCHER_APPS",
    ]) {
      expect(bootstrap, key).toContain(key);
      expect(second, key).toContain(`\`${key}\``);
    }
    expect(bootstrap).toContain("${prod.app-factory.RUNNER_TOKEN}");
    expect(second).toContain("`${prod.app-factory.RUNNER_TOKEN}`");
  });
});
