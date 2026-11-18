// SPDX-License-Identifier: LicenseRef-Proprietary

// #1091 (epic #1090, ADR 0006): the contract of an Implementer turn on several repositories
// (contracts/runner-api.v1.json and contracts/workflow.v1.json). Only the contract is checked here (Ajv, no database): the examples are
// valid, the job form is `repos` or `repo`, never both and never neither, the tokens, the resume and the result follow the job, and the
// lists the app keeps in TypeScript equal those of the file. The shared negative corpus (contracts/examples/implementer-multi-repo/
// invalid/, the same files the runner's contract test reads) must be rejected: by the schema where it can state the rule, by the
// reference rules of test-support/multi-repo-rules.ts where it cannot. Nothing in the app sends or reads `repos` yet (#1092).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyPatch,
  breakOfJobRule,
  breakOfLaneRule,
  deriveMountNames,
} from "../test-support/multi-repo-rules.ts";
import {
  CONTRACTS_DIRECTORY,
  createContractValidator,
  readContract,
  readExamples,
} from "../test-support/runner-contract.ts";
import { CLAIM_FEATURES } from "./contract.ts";

const runnerApi = createContractValidator();
const workflow = createContractValidator("workflow.v1.json");

type Document = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- a JSON document edited by key in a test

function example(folder: string, name: string): Document {
  const found = readExamples(`examples/${folder}`).find(
    (entry) => entry.definition === name,
  );
  if (found === undefined) throw new Error(`no example ${name}`);
  return structuredClone(found.document) as Document;
}

const multiJob = () => example("implementer-multi-repo", "RunnerJobInput");
const multiResult = () => example("implementer-multi-repo", "RunnerResult");
const multiResume = () =>
  example("implementer-multi-repo", "ImplementerResume");

function jobAccepted(job: Document): boolean {
  return runnerApi.check("RunnerJobInput", job).valid;
}

function repoEntry(index: number): Document {
  return {
    name: `r${String(index)}`,
    fullName: `acme/r${String(index)}`,
    cloneUrl: `https://github.com/acme/r${String(index)}.git`,
    base: "main",
    branch: "main",
    branchExists: false,
    tokenId: "t1",
  };
}

const VARIANTS = join(
  CONTRACTS_DIRECTORY,
  "examples",
  "implementer-multi-repo",
  "variants",
);
const INVALID = join(
  CONTRACTS_DIRECTORY,
  "examples",
  "implementer-multi-repo",
  "invalid",
);

function readJson(path: string): Document {
  return JSON.parse(readFileSync(path, "utf8")) as Document;
}

const variant = (name: string): Document => readJson(join(VARIANTS, name));

describe("a multi-repository implementer job", () => {
  // #1091-T01
  it("has valid examples: the job, the result, the resume and the one-repository pieces", () => {
    expect(runnerApi.check("RunnerJobInput", multiJob())).toStrictEqual({
      valid: true,
      errors: "",
    });
    expect(runnerApi.check("RunnerResult", multiResult())).toStrictEqual({
      valid: true,
      errors: "",
    });
    expect(runnerApi.check("ImplementerResume", multiResume())).toStrictEqual({
      valid: true,
      errors: "",
    });
    for (const name of [
      "ImplementerJobRepo",
      "ImplementerRepoResult",
      "ImplementerResumeRepo",
    ])
      expect(runnerApi.check(name, example("implementer", name))).toStrictEqual(
        { valid: true, errors: "" },
      );
  });

  // #1091-T02
  it("still accepts the job of today: one repository, no tokens", () => {
    const single = example("implementer", "RunnerJobInput");
    expect(jobAccepted(single)).toBe(true);
    expect(single.implementer.repos).toBeUndefined();
    expect(single.git.tokens).toBeUndefined();
  });

  // #1091-T03
  it("has `repos` or `repo` with `baseBranch` and `branch`, never both and never neither", () => {
    for (const edit of [
      (job: Document) =>
        (job.implementer.repo = example(
          "implementer",
          "RunnerJobInput",
        ).implementer.repo),
      (job: Document) => (job.implementer.baseBranch = "main"),
      (job: Document) => (job.implementer.branch = "x"),
      (job: Document) => (job.implementer.startBranch = "main"),
    ]) {
      const job = multiJob();
      edit(job);
      expect(jobAccepted(job)).toBe(false);
    }
    const single = example("implementer", "RunnerJobInput");
    for (const key of ["repo", "baseBranch", "branch"]) {
      const job = structuredClone(single);
      delete job.implementer[key];
      expect(jobAccepted(job)).toBe(false);
    }
  });

  // #1091-T04
  it("takes one to ten repositories", () => {
    const job = multiJob();
    job.implementer.repos = [];
    expect(jobAccepted(job)).toBe(false);

    job.implementer.repos = Array.from({ length: 10 }, (_, i) => repoEntry(i));
    expect(jobAccepted(job)).toBe(true);

    job.implementer.repos.push(repoEntry(10));
    expect(jobAccepted(job)).toBe(false);
  });

  // #1091-T05
  it("holds a repository to its closed form: every field is needed, none is unknown, the names are safe", () => {
    for (const key of [
      "name",
      "fullName",
      "cloneUrl",
      "base",
      "branch",
      "branchExists",
      "tokenId",
    ]) {
      const job = multiJob();
      delete job.implementer.repos[0][key];
      expect(jobAccepted(job), `without ${key}`).toBe(false);
    }
    const unknown = multiJob();
    unknown.implementer.repos[0].remote = "origin";
    expect(jobAccepted(unknown)).toBe(false);

    for (const name of [
      "",
      ".",
      "..",
      "a/b",
      "a b",
      "x".repeat(203),
      "-x",
      "result",
      "Result",
      "RESERVE",
      "reserve",
      ".git",
      ".GIT",
    ]) {
      const job = multiJob();
      job.implementer.repos[0].name = name;
      expect(jobAccepted(job), `name ${name}`).toBe(false);
    }
    for (const name of [
      ".github",
      "app",
      "Itegro-GmbH__app",
      "a.b_c-d",
      "x".repeat(202),
      "results",
      "reserved",
      "x-",
      "git",
      ".gitignore",
    ]) {
      const job = multiJob();
      job.implementer.repos[0].name = name;
      expect(jobAccepted(job), `name ${name}`).toBe(true);
    }
    for (const [key, value] of [
      ["cloneUrl", "http://github.com/acme/r.git"],
      ["cloneUrl", "https://user@github.com/acme/r.git"],
      ["fullName", "acme"],
      ["base", "-x"],
      ["branch", "has space"],
      ["branchExists", "yes"],
      ["tokenId", "a b"],
    ] as const) {
      const job = multiJob();
      job.implementer.repos[0][key] = value;
      expect(jobAccepted(job), `${key} ${value}`).toBe(false);
    }
  });

  // #1091-T06
  it("carries `git.tokens` exactly when it has `repos`, each with an id and a token", () => {
    const without = multiJob();
    delete without.git.tokens;
    expect(jobAccepted(without)).toBe(false);

    const single = example("implementer", "RunnerJobInput");
    single.git.tokens = [{ id: "t1", token: "x" }];
    expect(jobAccepted(single)).toBe(false);

    for (const tokens of [
      [],
      [{ id: "t1" }],
      [{ token: "x" }],
      [{ id: "t 1", token: "x" }],
      [{ id: "t1", token: "" }],
      [{ id: "t1", token: "x", scope: "all" }],
    ]) {
      const job = multiJob();
      job.git.tokens = tokens;
      expect(jobAccepted(job), JSON.stringify(tokens)).toBe(false);
    }
    // `git.token` stays: the token of the first repository.
    const noToken = multiJob();
    delete noToken.git.token;
    expect(jobAccepted(noToken)).toBe(false);
  });

  // #1091-T07
  it("has `resume.repos` or `resume.branches` with `checkout`, never both and never neither", () => {
    const resume = multiResume();
    expect(resume.branches).toBeUndefined();
    expect(resume.checkout).toBeUndefined();

    const both = multiResume();
    both.branches = [];
    both.checkout = null;
    expect(runnerApi.check("ImplementerResume", both).valid).toBe(false);

    const neither = multiResume();
    delete neither.repos;
    expect(runnerApi.check("ImplementerResume", neither).valid).toBe(false);

    const single = example("implementer", "ImplementerResume");
    expect(runnerApi.check("ImplementerResume", single).valid).toBe(true);

    const entry = multiResume();
    entry.repos[0].branches = Array.from({ length: 21 }, (_, i) => ({
      name: `b${String(i)}`,
      head: "1".repeat(40),
    }));
    expect(runnerApi.check("ImplementerResume", entry).valid).toBe(false);

    const unnamed = multiResume();
    delete unnamed.repos[0].name;
    expect(runnerApi.check("ImplementerResume", unnamed).valid).toBe(false);

    const empty = multiResume();
    empty.repos = [];
    expect(runnerApi.check("ImplementerResume", empty).valid).toBe(false);
  });

  // #1091-T08
  it("reports a result with the first repository in the old fields and every repository in `repos`", () => {
    const result = multiResult();
    const turn = result.implementer;
    const first = turn.repos[0];
    for (const key of [
      "baseCommit",
      "headCommit",
      "pushed",
      "commits",
      "filesChanged",
      "branches",
      "checkedOut",
    ])
      expect(turn[key]).toEqual(first[key]);

    // A result without `repos` is a result of today.
    const old = structuredClone(result);
    delete old.implementer.repos;
    expect(runnerApi.check("RunnerResult", old).valid).toBe(true);
  });

  // #1091-T09
  it("holds a repository of a result to its bounds", () => {
    const check = (edit: (entry: Document) => void): boolean => {
      const result = multiResult();
      edit(result.implementer.repos[0]);
      return runnerApi.check("RunnerResult", result).valid;
    };
    const commit = { sha: "a".repeat(40), subject: "c" };
    expect(check((e) => (e.commits = Array(100).fill(commit)))).toBe(true);
    expect(check((e) => (e.commits = Array(101).fill(commit)))).toBe(false);
    const file = { path: "a", status: "added" };
    expect(check((e) => (e.filesChanged = Array(250).fill(file)))).toBe(true);
    expect(check((e) => (e.filesChanged = Array(251).fill(file)))).toBe(false);
    const branch = {
      name: "b",
      head: "a".repeat(40),
      result: "pushed",
      reason: null,
    };
    expect(check((e) => (e.branches = Array(25).fill(branch)))).toBe(true);
    expect(check((e) => (e.branches = Array(26).fill(branch)))).toBe(false);
    for (const key of [
      "name",
      "fullName",
      "base",
      "branch",
      "created",
      "baseCommit",
      "headCommit",
      "pushed",
      "commits",
      "filesChanged",
    ])
      expect(
        check((e) => delete e[key]),
        `without ${key}`,
      ).toBe(false);
    expect(check((e) => (e.pushed = true) && (e.headCommit = null))).toBe(
      false,
    );
    expect(check((e) => (e.extra = 1))).toBe(false);
    expect(check((e) => (e.commitsTruncated = 3))).toBe(true);
    expect(check((e) => (e.filesTruncated = 0))).toBe(true);
    expect(check((e) => (e.commitsTruncated = -1))).toBe(false);
    expect(check((e) => (e.filesTruncated = "1"))).toBe(false);

    const none = multiResult();
    none.implementer.repos = [];
    expect(runnerApi.check("RunnerResult", none).valid).toBe(false);
  });

  // #1091-T14
  it("has valid variants: a continued branch, direct work, a job that may not push, a follow-up", () => {
    const names = readdirSync(VARIANTS)
      .filter((name) => name.endsWith(".json"))
      .sort();
    expect(names.length).toBeGreaterThanOrEqual(9);
    for (const name of names)
      expect(
        runnerApi.check(name.split(".")[0] as string, variant(name)),
        name,
      ).toStrictEqual({ valid: true, errors: "" });
  });

  // #1091-T15
  it("counts a continued branch from its own tip: it made nothing, or only the commits after that tip", () => {
    const untouched = variant("ImplementerRepoResult.continued-branch.json");
    expect(untouched.created).toBe(false);
    expect(untouched.baseCommit).toBe(untouched.headCommit);
    expect(untouched.commits).toEqual([]);
    expect(untouched.filesChanged).toEqual([]);
    expect(untouched.pushed).toBe(true);

    const worked = variant(
      "ImplementerRepoResult.continued-branch-with-commits.json",
    );
    expect(worked.created).toBe(false);
    expect(worked.baseCommit).not.toBe(worked.headCommit);
    expect(worked.commits.map((commit: Document) => commit.sha)).toEqual([
      worked.headCommit,
    ]);
  });

  // #1091-T16
  it("reports direct work as a push to the base branch, and a job that may not push without head commit and branches", () => {
    const direct = variant("ImplementerRepoResult.direct-push.json");
    expect(direct.branch).toBe(direct.base);
    expect(direct.pushed).toBe(true);
    expect(direct.branches[0]).toMatchObject({
      name: direct.base,
      result: "pushed",
    });

    const job = variant("RunnerJobInput.can-push-false.json");
    expect(job.implementer.profile.canPush).toBe(false);
    const reader = variant("ImplementerRepoResult.can-push-false.json");
    expect(reader.headCommit).toBeNull();
    expect(reader.pushed).toBe(false);
    expect(reader.commits).toEqual([]);
    expect(reader.branches).toBeUndefined();
  });

  // #1091-T17
  it("has a follow-up whose `resume.repos` are the job's names in the job's order, and a resume of direct work", () => {
    const job = variant("RunnerJobInput.follow-up.json");
    expect(
      job.implementer.resume.repos.map((entry: Document) => entry.name),
    ).toEqual(job.implementer.repos.map((entry: Document) => entry.name));
    expect(breakOfJobRule(job)).toBeNull();
    const resume = variant("ImplementerResume.direct-pushed.json");
    expect(resume.repos[1].checkout).toBe("main");
    expect(resume.repos[2].checkout).toBeNull();
    expect(resume.repos[2].branches).toHaveLength(1);
  });

  // #1091-T18
  it("derives mount names without regard to case and to the order of the list", () => {
    expect(
      deriveMountNames(["acme/app", "acme/shared-lib", "other/app"]),
    ).toEqual(["acme__app", "shared-lib", "other__app"]);
    expect(
      deriveMountNames(["other/app", "acme/shared-lib", "acme/app"]),
    ).toEqual(["other__app", "shared-lib", "acme__app"]);
    expect(deriveMountNames(["acme/App", "other/app"])).toEqual([
      "acme__App",
      "other__app",
    ]);
    expect(
      deriveMountNames(["acme/result", "acme/Reserve", "acme/.git", "acme/x"]),
    ).toEqual(["acme__result", "acme__Reserve", "acme__.git", "x"]);
    expect(breakOfJobRule(multiJob())).toBeNull();
  });

  // #1091-T10
  it("names the claim feature in the file and in the app's list", () => {
    const features = readContract().$defs.KnownClaimFeature?.enum ?? [];
    expect(features).toContain("implementer_multi_repo");
    expect([...CLAIM_FEATURES].sort()).toEqual([...features].sort());
  });
});

describe("the repositories of an agent step", () => {
  const step = (extra: Document): Document => ({
    id: "implement",
    kind: "agent",
    profile: "implementer",
    instruction: "Do it.",
    ...extra,
  });
  const accepted = (document: Document): boolean =>
    workflow.check("AgentStep", document).valid;

  // #1091-T11
  it("takes `repos`: a repository, optionally a base and a branch", () => {
    expect(accepted(step({}))).toBe(true);
    expect(
      accepted(
        step({
          repos: [
            {
              repo: "{{trigger.ticket.repo.fullName}}",
              base: "development",
              branch: "feature/{{trigger.ticket.key}}",
            },
            { repo: "Itegro-GmbH/shared-lib" },
          ],
        }),
      ),
    ).toBe(true);
  });

  // #1091-T12
  it("takes one to ten repositories, each with a `repo` and nothing unknown", () => {
    expect(accepted(step({ repos: [] }))).toBe(false);
    expect(
      accepted(
        step({
          repos: Array.from({ length: 10 }, (_, i) => ({
            repo: `a/r${String(i)}`,
          })),
        }),
      ),
    ).toBe(true);
    expect(
      accepted(
        step({
          repos: Array.from({ length: 11 }, (_, i) => ({
            repo: `a/r${String(i)}`,
          })),
        }),
      ),
    ).toBe(false);
    expect(accepted(step({ repos: [{ base: "main" }] }))).toBe(false);
    expect(accepted(step({ repos: [{ repo: "a/b", remote: "x" }] }))).toBe(
      false,
    );
    expect(accepted(step({ repos: [{ repo: "" }] }))).toBe(false);
  });

  // #1091-T13
  it("does not take `repos` together with `branch` or with `session.continue`", () => {
    expect(accepted(step({ branch: "main", repos: [{ repo: "a/b" }] }))).toBe(
      false,
    );
    expect(
      accepted(
        step({ session: { continue: "implement" }, repos: [{ repo: "a/b" }] }),
      ),
    ).toBe(false);
    expect(accepted(step({ session: "new", repos: [{ repo: "a/b" }] }))).toBe(
      true,
    );
    // A `session` object needs `continue`; `{}` is no session at all.
    expect(accepted(step({ session: {}, repos: [{ repo: "a/b" }] }))).toBe(
      false,
    );
    // Without `repos` both stay as they were.
    expect(accepted(step({ branch: "main" }))).toBe(true);
    expect(accepted(step({ session: { continue: "implement" } }))).toBe(true);
  });
});

describe("the shared negative corpus of multi-repository jobs and lanes", () => {
  const files = readdirSync(INVALID)
    .filter((name) => name.endsWith(".json"))
    .sort();

  // #1091-T19
  it("is there", () => {
    expect(files.length).toBeGreaterThanOrEqual(20);
  });

  // #1091-T20
  it.each(files)("rejects %s", (name) => {
    const entry = readJson(join(INVALID, name));
    const base: Document =
      entry.document ??
      readJson(join(CONTRACTS_DIRECTORY, "examples", `${entry.base}.json`));
    const document = applyPatch(base, entry.patch);
    const lane = entry.definition === "AgentStep";
    const schema = lane ? workflow : runnerApi;
    const accepted = schema.check(entry.definition, document);
    if (entry.layer === "schema") {
      expect(accepted.valid, entry.why).toBe(false);
      return;
    }
    // A rule the schema cannot state: the schema takes the document and a rule breaks it.
    expect(
      accepted.valid,
      `${name}: the schema refuses it (${accepted.errors}), so the case belongs to layer 'schema'`,
    ).toBe(true);
    expect(
      lane ? breakOfLaneRule(document) : breakOfJobRule(document),
      entry.why,
    ).toBe(entry.rule);
  });
});
