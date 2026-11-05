// SPDX-License-Identifier: LicenseRef-Proprietary

// #746: the contract of the implementer job kind (contracts/runner-api.v1.json). The schema and the
// examples are checked against each other here (Ajv, no database); the lists the app keeps in
// TypeScript are compared with the file; a job of the new kind that reaches the claim fails closed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RUNNER_ENGINES,
  reviewKindsForEngines,
} from "../jobs/runner-capabilities.ts";
import {
  CONTRACTS_DIRECTORY,
  createContractValidator,
  readContract,
  readExamples,
} from "../test-support/runner-contract.ts";
import {
  IMPLEMENTER_ENVIRONMENT_NAMES,
  IMPLEMENTER_RESUME_MODES,
  IMPLEMENTER_RESUME_REASONS,
  RUNNER_ERROR_CODES,
  RUNNER_REVIEW_KINDS,
} from "./contract.ts";
import { checkJob } from "./claim.ts";
import { parseCompleteRequest, parseWorkerResultRequest } from "./requests.ts";
import type { CheckOptions } from "./claim.ts";
import { refusalForKind } from "./kind-guard.ts";
import type { ClaimDeps } from "./claim.ts";
import type { Job } from "../jobs/job-types.ts";

const contract = createContractValidator();
const webhooks = createContractValidator("dispatch-webhook.v1.json");

const NEW_ERROR_CODES = [
  "branch_exists",
  "base_branch_not_found",
  "clone_failed",
  "setup_failed",
  "agent_gave_up",
  "no_result",
  "push_rejected",
  "branch_violation",
  "cost_limit_reached",
  "time_limit_reached",
  "git_write_not_granted",
  "implementer_engine_unavailable",
  "implementer_config_invalid",
  "sandbox_unproven",
  "sandbox_size_unsupported",
] as const;

type Document = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- a JSON document edited by key in a test

function example(name: string): Document {
  const found = readExamples("examples/implementer").find(
    (entry) => entry.definition === name,
  );
  if (found === undefined) throw new Error(`no example ${name}`);
  return structuredClone(found.document) as Document;
}

function accepts(definition: string, document: unknown): boolean {
  return contract.check(definition, document).valid;
}

describe("the implementer job input", () => {
  // #746-T01
  it("has a valid example", () => {
    expect(
      contract.check("RunnerJobInput", example("RunnerJobInput")),
    ).toStrictEqual({ valid: true, errors: "" });
  });

  // #746-T01
  it("is closed: an unknown field is refused at every level", () => {
    for (const edit of [
      (input: Document) => (input.somethingNew = true),
      (input: Document) => (input.implementer.somethingNew = true),
      (input: Document) => (input.implementer.repo.somethingNew = true),
      (input: Document) => (input.implementer.limits.somethingNew = true),
      (input: Document) => (input.git.somethingNew = true),
    ]) {
      const input = example("RunnerJobInput");
      edit(input);
      expect(accepts("RunnerJobInput", input)).toBe(false);
    }
  });

  // #746-T01
  it("forbids prUrl, command, base, dynamic and args", () => {
    const forbidden: Array<[string, unknown]> = [
      ["prUrl", "https://github.com/acme/widgets/pull/7"],
      ["command", "review"],
      ["args", ["a legacy question"]],
      ["dynamic", { model: "m", skill: "s", limits: { maxFindings: 1 } }],
      ["base", {}],
    ];
    for (const [key, value] of forbidden) {
      const input = example("RunnerJobInput");
      input[key] = value;
      expect(accepts("RunnerJobInput", input), key).toBe(false);
    }
  });

  // #746-T01
  it("requires the implementer block and each of its fields", () => {
    const withoutBlock = example("RunnerJobInput");
    delete withoutBlock.implementer;
    expect(accepts("RunnerJobInput", withoutBlock)).toBe(false);

    for (const key of [
      "repo",
      "baseBranch",
      "branch",
      "instruction",
      "limits",
      "cost",
      "modelEntry",
    ]) {
      const input = example("RunnerJobInput");
      delete input.implementer[key];
      expect(accepts("RunnerJobInput", input), key).toBe(false);
    }
  });

  // #746-T01
  it("bounds the instruction at 20 000 characters and the time limit", () => {
    const longest = example("RunnerJobInput");
    longest.implementer.instruction = "x".repeat(20_000);
    expect(accepts("RunnerJobInput", longest)).toBe(true);

    for (const edit of [
      (input: Document) => (input.implementer.instruction = "x".repeat(20_001)),
      (input: Document) => (input.implementer.instruction = ""),
      (input: Document) => (input.implementer.limits.timeLimitSeconds = 0),
      (input: Document) => (input.implementer.limits.timeLimitSeconds = 1.5),
      (input: Document) => (input.implementer.branch = "-force"),
      (input: Document) => (input.implementer.branch = "has space"),
      (input: Document) => (input.implementer.repo.fullName = "no-owner"),
      (input: Document) =>
        (input.implementer.repo.cloneUrl = "file:///etc/passwd"),
    ]) {
      const input = example("RunnerJobInput");
      edit(input);
      expect(accepts("RunnerJobInput", input)).toBe(false);
    }
  });

  // #746-T01
  it("uses the cost policy and the model entry of the native Dynamic job", () => {
    const input = example("RunnerJobInput");
    input.implementer.cost = { keyMode: "managed", priceBook: null };
    expect(accepts("RunnerJobInput", input)).toBe(false);
  });

  // #746-T01
  it("still requires prUrl and command for a Diff job and for a Dynamic job", () => {
    const diff = {
      prUrl: "https://github.com/acme/widgets/pull/7",
      command: "review",
      git: { provider: "github", baseUrl: "u", token: "t", botLogin: "b" },
      llm: { provider: "openrouter", model: "m", apiKey: "k" },
      env: {},
    };
    expect(accepts("RunnerJobInput", diff)).toBe(true);
    for (const key of ["prUrl", "command"]) {
      const broken: Document = { ...diff };
      delete broken[key];
      expect(accepts("RunnerJobInput", broken), `diff without ${key}`).toBe(
        false,
      );
      expect(
        accepts("RunnerJobInput", { ...broken, reviewKind: "diff" }),
        `tagged diff without ${key}`,
      ).toBe(false);
    }
    const dynamic = JSON.parse(
      readFileSync(
        join(
          CONTRACTS_DIRECTORY,
          "..",
          "fakes",
          "fixtures",
          "dynamic-review-job.json",
        ),
        "utf8",
      ),
    ) as Document;
    expect(accepts("RunnerJobInput", dynamic)).toBe(true);
    for (const key of ["prUrl", "command"]) {
      const broken: Document = { ...dynamic };
      delete broken[key];
      expect(accepts("RunnerJobInput", broken), `dynamic without ${key}`).toBe(
        false,
      );
    }
  });

  // #746-T01
  it("forbids the implementer block on a Diff job and on a Dynamic job", () => {
    const block = example("RunnerJobInput").implementer;
    const diff = JSON.parse(
      readFileSync(
        join(
          CONTRACTS_DIRECTORY,
          "..",
          "fakes",
          "fixtures",
          "previous-release-review-job.json",
        ),
        "utf8",
      ),
    ) as Document;
    const dynamic = JSON.parse(
      readFileSync(
        join(
          CONTRACTS_DIRECTORY,
          "..",
          "fakes",
          "fixtures",
          "dynamic-review-job.json",
        ),
        "utf8",
      ),
    ) as Document;
    expect(accepts("RunnerJobInput", { ...diff, implementer: block })).toBe(
      false,
    );
    expect(accepts("RunnerJobInput", { ...dynamic, implementer: block })).toBe(
      false,
    );
  });

  // #746-T06
  it("leaves the recorded Diff and Dynamic jobs valid", () => {
    for (const name of [
      "previous-release-review-job.json",
      "dynamic-review-job.json",
      "dynamic-review-job-capabilities.json",
      "dynamic-review-job-cost-managed.json",
      "dynamic-review-job-cost-own.json",
      "dynamic-review-job-native-managed.json",
      "dynamic-review-job-native-own.json",
    ]) {
      const job = JSON.parse(
        readFileSync(
          join(CONTRACTS_DIRECTORY, "..", "fakes", "fixtures", name),
          "utf8",
        ),
      ) as unknown;
      expect(contract.check("RunnerJobInput", job), name).toStrictEqual({
        valid: true,
        errors: "",
      });
    }
    for (const entry of readExamples()) {
      if (entry.definition !== "ClaimResponse") continue;
      expect(accepts("ClaimResponse", entry.document)).toBe(true);
    }
  });
});

describe("the resume of a follow-up turn (#838)", () => {
  const SHA = "1".repeat(40);

  function withResume(resume: unknown): Document {
    const input = example("RunnerJobInput");
    input.implementer.resume = resume;
    return input;
  }

  // #838-T70
  it("has a valid example, alone and inside the job input", () => {
    const resume = example("ImplementerResume");

    expect(contract.check("ImplementerResume", resume)).toStrictEqual({
      valid: true,
      errors: "",
    });
    expect(accepts("RunnerJobInput", withResume(resume))).toBe(true);
  });

  // #838-T71
  it("is optional: a first turn carries none", () => {
    expect(example("RunnerJobInput").implementer.resume).toBeUndefined();
    expect(accepts("RunnerJobInput", example("RunnerJobInput"))).toBe(true);
  });

  // #838-T72
  it("is closed and needs its three fields", () => {
    for (const key of ["turn", "branches", "checkout"]) {
      const resume = example("ImplementerResume");
      delete resume[key];
      expect(accepts("ImplementerResume", resume), key).toBe(false);
    }
    for (const edit of [
      (resume: Document) => (resume.somethingNew = true),
      (resume: Document) => (resume.branches[0].somethingNew = true),
    ]) {
      const resume = example("ImplementerResume");
      edit(resume);
      expect(accepts("ImplementerResume", resume)).toBe(false);
    }
  });

  // #838-T73
  it("bounds the turn, the branches, their names and their tips", () => {
    const refused: Array<(resume: Document) => void> = [
      (resume) => (resume.turn = 1),
      (resume) => (resume.turn = 2.5),
      (resume) => (resume.turn = 100_001),
      (resume) => (resume.branches = { name: "x", head: SHA }),
      (resume) =>
        (resume.branches = Array.from({ length: 21 }, (_, index) => ({
          name: `feature/${index}`,
          head: SHA,
        }))),
      (resume) => (resume.branches[0].name = "-delete"),
      (resume) => (resume.branches[0].name = "has space"),
      (resume) => delete resume.branches[0].head,
      (resume) => (resume.branches[0].head = "main"),
      (resume) => (resume.branches[0].head = "A".repeat(40)),
      (resume) => (resume.branches[0].head = "abc1234"),
      (resume) => (resume.checkout = "-delete"),
      (resume) => (resume.checkout = 3),
    ];
    for (const edit of refused) {
      const resume = example("ImplementerResume");
      edit(resume);
      expect(accepts("ImplementerResume", resume), String(edit)).toBe(false);
    }
    const largest = example("ImplementerResume");
    largest.branches = Array.from({ length: 20 }, (_, index) => ({
      name: `feature/${index}`,
      head: SHA,
    }));
    largest.checkout = null;
    expect(accepts("ImplementerResume", largest)).toBe(true);
    expect(
      accepts("ImplementerResume", {
        ...largest,
        branches: [],
        checkout: null,
      }),
    ).toBe(true);
  });

  // #838-T74
  it("is part of the implementer block only", () => {
    const diff = {
      prUrl: "https://github.com/acme/widgets/pull/7",
      command: "review",
      git: { provider: "github", baseUrl: "u", token: "t", botLogin: "b" },
      llm: { provider: "openrouter", model: "m", apiKey: "k" },
      env: {},
      resume: example("ImplementerResume"),
    };
    expect(accepts("RunnerJobInput", diff)).toBe(false);
  });
});

describe("the implementer result", () => {
  // #746-T02
  it("has a valid example", () => {
    expect(
      contract.check("RunnerResult", example("RunnerResult")),
    ).toStrictEqual({
      valid: true,
      errors: "",
    });
    expect(
      accepts("CompleteRequest", {
        leaseToken: "lease-token-example",
        result: example("RunnerResult"),
      }),
    ).toBe(true);
  });

  // #746-T02
  it("is optional and closed", () => {
    const without = example("RunnerResult");
    delete without.implementer;
    expect(accepts("RunnerResult", without)).toBe(true);

    for (const edit of [
      (result: Document) => (result.implementer.somethingNew = 1),
      (result: Document) => (result.implementer.commits[0].somethingNew = 1),
      (result: Document) =>
        (result.implementer.filesChanged[0].somethingNew = 1),
      (result: Document) => (result.implementer.opencode.somethingNew = 1),
    ]) {
      const result = example("RunnerResult");
      edit(result);
      expect(accepts("RunnerResult", result)).toBe(false);
    }
  });

  // #746-T02
  it("enforces the limits of commits, files and summary", () => {
    const commit = { sha: "a".repeat(40), subject: "A change" };
    const file = { path: "src/a.ts", status: "added" };
    const accepted = example("RunnerResult");
    accepted.implementer.commits = Array.from({ length: 200 }, () => commit);
    accepted.implementer.filesChanged = Array.from({ length: 500 }, () => file);
    accepted.implementer.summary = "x".repeat(8192);
    expect(accepts("RunnerResult", accepted)).toBe(true);

    for (const edit of [
      (result: Document) =>
        (result.implementer.commits = Array.from(
          { length: 201 },
          () => commit,
        )),
      (result: Document) =>
        (result.implementer.filesChanged = Array.from(
          { length: 501 },
          () => file,
        )),
      (result: Document) => (result.implementer.summary = "x".repeat(8193)),
      (result: Document) =>
        (result.implementer.commits[0].sha = "A".repeat(40)),
      (result: Document) => (result.implementer.commits[0].sha = "abc"),
      (result: Document) => (result.implementer.baseCommit = "main"),
      (result: Document) =>
        (result.implementer.filesChanged[0].status = "moved"),
      (result: Document) => (result.implementer.pushed = "yes"),
    ]) {
      const result = example("RunnerResult");
      edit(result);
      expect(accepts("RunnerResult", result)).toBe(false);
    }
  });

  // The git model: the runner reports every branch it pushed at the end of the turn.
  it("takes the branches of the turn: optional, closed, at most 50, a reason word for a rejection", () => {
    const branch = {
      name: "experiment/two",
      head: "c".repeat(40),
      result: "rejected",
      reason: "non_fast_forward",
    };
    const accepted = example("RunnerResult");
    accepted.implementer.branches = [
      ...accepted.implementer.branches,
      branch,
      { name: "unread", head: null, result: "rejected", reason: "unreadable" },
    ];
    expect(accepts("RunnerResult", accepted)).toBe(true);
    const older = example("RunnerResult");
    delete older.implementer.branches;
    expect(accepts("RunnerResult", older)).toBe(true);
    const full = example("RunnerResult");
    full.implementer.branches = Array.from({ length: 50 }, (_, number) => ({
      ...branch,
      name: `b${String(number)}`,
    }));
    expect(accepts("RunnerResult", full)).toBe(true);

    for (const edit of [
      (result: Document) =>
        (result.implementer.branches = Array.from(
          { length: 51 },
          () => branch,
        )),
      (result: Document) => (result.implementer.branches[0].extra = 1),
      (result: Document) => (result.implementer.branches[0].name = ""),
      (result: Document) =>
        (result.implementer.branches[0].name = "n".repeat(256)),
      (result: Document) => (result.implementer.branches[0].head = "abc"),
      (result: Document) => (result.implementer.branches[0].result = "maybe"),
      (result: Document) =>
        (result.implementer.branches[0].reason = "Not Fast"),
      (result: Document) => delete result.implementer.branches[0].reason,
    ]) {
      const result = example("RunnerResult");
      edit(result);
      expect(accepts("RunnerResult", result)).toBe(false);
    }
  });

  it("takes the counts of the branches that were left out: optional, closed, two whole numbers from 0", () => {
    const counted = example("RunnerResult");
    counted.implementer.branchesDropped = { invalid: 3, overflow: 7 };
    expect(accepts("RunnerResult", counted)).toBe(true);

    for (const dropped of [
      { invalid: 0 },
      { invalid: 0, overflow: 0, extra: 1 },
      { invalid: -1, overflow: 0 },
      { invalid: 0, overflow: 1.5 },
      { invalid: "1", overflow: 0 },
      null,
    ]) {
      const result = example("RunnerResult");
      result.implementer.branchesDropped = dropped;
      expect(accepts("RunnerResult", result)).toBe(false);
    }
  });

  // #837
  it("takes the branch that was checked out: optional, a name from 1 to 255 characters or null", () => {
    const result = example("RunnerResult");
    expect(result.implementer.checkedOut).toBe("implementer/a1b2c3");
    expect(accepts("RunnerResult", result)).toBe(true);
    result.implementer.checkedOut = null;
    expect(accepts("RunnerResult", result)).toBe(true);
    delete result.implementer.checkedOut;
    expect(accepts("RunnerResult", result)).toBe(true);

    for (const bad of ["", "x".repeat(256), 3, ["a"]]) {
      const refused = example("RunnerResult");
      refused.implementer.checkedOut = bad;
      expect(accepts("RunnerResult", refused)).toBe(false);
    }
  });

  // #840
  it("takes how a follow-up turn got its conversation: optional, `imported`, or `summary_only` with one of the runner's reasons", () => {
    const result = example("RunnerResult");
    expect(result.implementer.resume).toStrictEqual({
      mode: "summary_only",
      reason: "version_changed",
    });
    expect(accepts("RunnerResult", result)).toBe(true);
    result.implementer.resume = { mode: "imported" };
    expect(accepts("RunnerResult", result)).toBe(true);
    delete result.implementer.resume;
    expect(accepts("RunnerResult", result)).toBe(true);

    for (const bad of [
      {},
      { mode: "copied" },
      { mode: "summary_only" },
      { mode: "summary_only", reason: "unknown" },
      { mode: "imported", reason: "import_failed" },
      { mode: "imported", note: "x" },
      "imported",
      null,
    ]) {
      const refused = example("RunnerResult");
      refused.implementer.resume = bad;
      expect(accepts("RunnerResult", refused)).toBe(false);
    }
  });

  // #840
  it("holds the words the app keeps for the resume result equal to the contract's", () => {
    const properties = readContract().$defs.ImplementerResumeResult
      ?.properties as Record<string, { enum?: string[] }> | undefined;

    expect(properties?.mode?.enum).toStrictEqual([...IMPLEMENTER_RESUME_MODES]);
    expect(properties?.reason?.enum).toStrictEqual([
      ...IMPLEMENTER_RESUME_REASONS,
    ]);
  });

  // #840
  it("takes the stored-conversation fields of a follow-up job: `snapshot`, `previousSummary` and `digest`", () => {
    const resume = example("ImplementerResume");
    expect(resume.snapshot).toBe(true);
    expect(accepts("ImplementerResume", resume)).toBe(true);
    for (const name of ["snapshot", "previousSummary", "digest"]) {
      const without = example("ImplementerResume");
      delete without[name];
      expect(accepts("ImplementerResume", without)).toBe(true);
    }
    for (const edit of [
      (r: Document) => (r.snapshot = "yes"),
      (r: Document) => (r.previousSummary = "x".repeat(8193)),
      (r: Document) => (r.digest = "x".repeat(16385)),
      (r: Document) => (r.digest = 3),
    ]) {
      const refused = example("ImplementerResume");
      edit(refused);
      expect(accepts("ImplementerResume", refused)).toBe(false);
    }
  });

  // #746-T02
  it("allows a failed turn with no head commit, a null session and nothing pushed", () => {
    const failed = example("RunnerResult");
    Object.assign(failed, { ok: false, errorCode: "agent_gave_up" });
    Object.assign(failed.implementer, {
      headCommit: null,
      pushed: false,
      commits: [],
      filesChanged: [],
      opencode: null,
    });
    expect(accepts("RunnerResult", failed)).toBe(true);
  });

  // #746-T02
  it("never says pushed without a head commit", () => {
    const result = example("RunnerResult");
    Object.assign(result.implementer, { headCommit: null, pushed: true });
    expect(accepts("RunnerResult", result)).toBe(false);
  });
});

// #745, step 7 (the review of #830): the schema and the parser are two hand-written readings of one contract, and the parser once
// refused every result that carried `implementer.network` while the schema and the example were green. Here the example, and the
// edits of it, go through the app's real parser and must get the verdict of the schema, in the body of a Runner and of a Worker.
describe("the implementer result through the app's parser", () => {
  const LEASE = "lease-token-example";

  function verdicts(result: unknown): {
    schema: boolean;
    complete: boolean;
    worker: boolean;
  } {
    return {
      schema: accepts("RunnerResult", result),
      complete: parseCompleteRequest({ leaseToken: LEASE, result }).ok,
      worker: parseWorkerResultRequest({ result }).ok,
    };
  }

  it("takes the example, network block included, and keeps it intact", () => {
    const result = example("RunnerResult");
    expect(result.implementer.network).toBeDefined();
    expect(verdicts(result)).toStrictEqual({
      schema: true,
      complete: true,
      worker: true,
    });
    const complete = parseCompleteRequest({ leaseToken: LEASE, result });
    const worker = parseWorkerResultRequest({ result });
    expect(complete.ok && complete.value.result.implementer?.network).toEqual(
      result.implementer.network,
    );
    expect(worker.ok && worker.value.result.implementer?.network).toEqual(
      result.implementer.network,
    );
  });

  it("takes a block for the rule off with a narrowed policy, and one without a network block", () => {
    const off = example("RunnerResult");
    off.implementer.network = {
      mode: "off",
      door: false,
      vmPolicy: "narrowed",
      allowed: 0,
      refused: 0,
      bytesIn: 0,
      bytesOut: 0,
      dropped: 0,
      connections: [],
    };
    const notConfigured = structuredClone(off);
    notConfigured.implementer.network.vmPolicy = "not_configured";
    const without = example("RunnerResult");
    delete without.implementer.network;
    for (const result of [off, notConfigured, without]) {
      expect(verdicts(result)).toStrictEqual({
        schema: true,
        complete: true,
        worker: true,
      });
    }
    const parsed = parseWorkerResultRequest({ result: off });
    expect(parsed.ok && parsed.value.result.implementer?.network).toEqual(
      off.implementer.network,
    );
    const bare = parseWorkerResultRequest({ result: without });
    expect(bare.ok && "network" in (bare.value.result.implementer ?? {})).toBe(
      false,
    );
  });

  it("agrees with the schema on every edit of the network block", () => {
    const edits: [string, (network: Document) => void][] = [
      ["an unknown key", (n) => (n.somethingNew = 1)],
      ["an unknown key in a connection", (n) => (n.connections[0].extra = 1)],
      ["a missing key", (n) => delete n.dropped],
      ["a missing key in a connection", (n) => delete n.connections[0].reason],
      ["a null block", (n) => Object.keys(n).forEach((k) => delete n[k])],
      ["an unknown mode", (n) => (n.mode = "closed")],
      ["an unknown policy", (n) => (n.vmPolicy = "wide")],
      ["a door that is not a boolean", (n) => (n.door = "yes")],
      ["a negative count", (n) => (n.refused = -1)],
      ["a fractional count", (n) => (n.allowed = 1.5)],
      ["a negative byte count", (n) => (n.connections[0].bytesIn = -1)],
      ["a zero count of a connection", (n) => (n.connections[0].count = 0)],
      ["a port over 65535", (n) => (n.connections[0].port = 65536)],
      [
        "a host of 254 characters",
        (n) => (n.connections[0].host = "a".repeat(254)),
      ],
      [
        "a reason with a capital",
        (n) => (n.connections[1].reason = "Not_listed"),
      ],
      [
        "a reason with a digit",
        (n) => (n.connections[1].reason = "not_listed2"),
      ],
      [
        "a reason of 41 characters",
        (n) => (n.connections[1].reason = "a".repeat(41)),
      ],
      [
        "an outcome that is not known",
        (n) => (n.connections[0].outcome = "maybe"),
      ],
      [
        "101 connections",
        (n) =>
          (n.connections = Array.from({ length: 101 }, () => n.connections[0])),
      ],
      [
        "100 connections",
        (n) =>
          (n.connections = Array.from({ length: 100 }, () => n.connections[0])),
      ],
      [
        "a host of 253 characters",
        (n) => (n.connections[0].host = "a".repeat(253)),
      ],
      [
        "a reason of 40 characters",
        (n) => (n.connections[1].reason = "a".repeat(40)),
      ],
    ];
    for (const [name, edit] of edits) {
      const result = example("RunnerResult");
      edit(result.implementer.network);
      if (name === "a null block") result.implementer.network = null;
      const seen = verdicts(result);
      expect(seen.complete, name).toBe(seen.schema);
      expect(seen.worker, name).toBe(seen.schema);
    }
  });
});

describe("the lists of the implementer kind", () => {
  // #746-T03
  it("lists the same review kinds as the app's TypeScript list", () => {
    const listed = readContract().$defs.ReviewKind?.enum ?? [];

    expect([...RUNNER_REVIEW_KINDS].sort()).toStrictEqual([...listed].sort());
    expect(listed).toContain("implementer");
  });

  // #746-T03
  it("lists the same engines as the app's TypeScript list", () => {
    const listed = readContract().$defs.Engine?.enum ?? [];

    expect([...RUNNER_ENGINES].sort()).toStrictEqual([...listed].sort());
    expect(listed).toContain("implementer");
  });

  // #746-T03
  it("lists the new error codes once, in the contract and in the app", () => {
    const listed = readContract().$defs.KnownRunnerErrorCode?.enum ?? [];

    for (const code of NEW_ERROR_CODES) {
      expect(
        listed.filter((entry) => entry === code),
        code,
      ).toHaveLength(1);
      expect(RUNNER_ERROR_CODES, code).toContain(code);
    }
    expect(new Set(listed).size).toBe(listed.length);
  });

  // #746-T03
  it("lists the names the Worker container gets for the kind", () => {
    const defs = readContract().$defs;

    expect([...IMPLEMENTER_ENVIRONMENT_NAMES]).toStrictEqual([
      "RUNNER_IMPLEMENTER_WORK_DIR",
      "RUNNER_IMPLEMENTER_MODEL_DOOR",
      "RUNNER_IMPLEMENTER_SANDBOX_PROOF",
      "RUNNER_IMPLEMENTER_AGENT_MEMORY_MB",
      "RUNNER_IMPLEMENTER_NETWORK_SWITCH",
    ]);
    expect([...IMPLEMENTER_ENVIRONMENT_NAMES].sort()).toStrictEqual(
      [...(defs.KnownImplementerEnvironmentName?.enum ?? [])].sort(),
    );
  });
});

describe("the surrounding documents with the implementer kind", () => {
  // #746-T05
  it("lets the dispatch webhook carry reviewKind implementer", () => {
    const wake = readExamples("examples/dispatch-webhook").find(
      (entry) => entry.definition === "DispatchWebhook",
    )?.document as Document;
    wake.reviewKind = "implementer";

    expect(webhooks.check("DispatchWebhook", wake)).toStrictEqual({
      valid: true,
      errors: "",
    });
    wake.reviewKind = "review";
    expect(webhooks.check("DispatchWebhook", wake).valid).toBe(false);
  });

  // #746-T01
  it("has a split claim example for the kind", () => {
    expect(
      contract.check("SplitClaimResponse", example("SplitClaimResponse")),
    ).toStrictEqual({ valid: true, errors: "" });
  });

  // #746-T01
  it("lets a claim name the implementer engine, up to three engines", () => {
    expect(
      accepts("ClaimRequest", {
        engines: ["pr-agent", "opencode", "implementer"],
      }),
    ).toBe(true);
    expect(accepts("ClaimRequest", { engines: ["implementer"] })).toBe(true);
  });
});

describe("a job of the implementer kind in the claim", () => {
  const options: CheckOptions = {
    engines: ["pr-agent", "opencode", "implementer"],
    classifyReadFailures: false,
    runnerProviders: null,
  };

  // #746-T07, #752-T04
  it("serves the kind implementer, and only that, from the engine implementer and leaves the kinds of the others as they were", () => {
    expect(reviewKindsForEngines(["implementer"])).toStrictEqual([
      "implementer",
    ]);
    expect(reviewKindsForEngines(["pr-agent"])).toStrictEqual(["diff"]);
    expect(reviewKindsForEngines(["pr-agent", "opencode"])).toStrictEqual([
      "diff",
      "dynamic",
    ]);
    expect(
      reviewKindsForEngines(["pr-agent", "opencode", "implementer"]),
    ).toStrictEqual(["diff", "dynamic", "implementer"]);
  });

  // #746-T07, #753
  it("has a refusal with a stable code for a caller that did not advertise the engine, and none for the kinds it can run", () => {
    expect(refusalForKind("implementer", ["pr-agent", "opencode"])).toBe(
      "implementer_engine_unavailable",
    );
    expect(refusalForKind("implementer", ["implementer"])).toBeNull();
    // The Worker's fetch: the claim already decided who may have the job.
    expect(refusalForKind("implementer", null)).toBeNull();
    expect(refusalForKind("diff", ["pr-agent"])).toBeNull();
    expect(refusalForKind("dynamic", ["pr-agent"])).toBeNull();
  });

  // #746-T07, #753
  it("is refused by checkJob for a caller without the engine before anything else looks at it, never built as a Diff job", async () => {
    // No dependency is given: the refusal comes first, so none may be touched.
    const untouched = new Proxy(
      {},
      {
        get(_target, name) {
          throw new Error(`the claim touched ${String(name)}`);
        },
      },
    ) as ClaimDeps;
    const job = { id: "job-1", reviewKind: "implementer" } as unknown as Job;

    const checked = await checkJob(untouched, job, {
      ...options,
      engines: ["pr-agent", "opencode"],
    });

    expect(checked).toMatchObject({
      kind: "refused",
      errorCode: "implementer_engine_unavailable",
    });
  });
});

describe("the result schema and the result of a turn (#843)", () => {
  function withSchema(schema: unknown): Document {
    const input = example("RunnerJobInput");
    input.implementer.resultSchema = schema;
    return input;
  }

  // #843-T98
  it("has valid examples of the schema and of the agent's result, alone and inside the job input and the result", () => {
    const schema = example("ImplementerResultSchema");
    const result = example("RunnerResult");
    result.implementer.agentResult = example("ImplementerAgentResult");

    expect(contract.check("ImplementerResultSchema", schema)).toStrictEqual({
      valid: true,
      errors: "",
    });
    expect(
      accepts("ImplementerAgentResult", example("ImplementerAgentResult")),
    ).toBe(true);
    expect(accepts("RunnerJobInput", withSchema(schema))).toBe(true);
    expect(accepts("RunnerResult", result)).toBe(true);
  });

  // #843-T98
  it("is optional in both: a turn without a schema carries none, a result without a handed-in result has none", () => {
    expect(example("RunnerJobInput").implementer.resultSchema).toBeUndefined();
    expect(example("RunnerResult").implementer.agentResult).toBeUndefined();
    expect(accepts("RunnerJobInput", example("RunnerJobInput"))).toBe(true);
    expect(accepts("RunnerResult", example("RunnerResult"))).toBe(true);
  });

  // #843-T98
  it("refuses a schema whose root is no object and a result that is not an object", () => {
    for (const bad of ["findings", [], { type: "string" }, { type: "object" }])
      expect(
        accepts("RunnerJobInput", withSchema(bad)),
        JSON.stringify(bad),
      ).toBe(false);
    for (const bad of [[], "text", 3, null]) {
      const result = example("RunnerResult");
      result.implementer.agentResult = bad;
      expect(accepts("RunnerResult", result), JSON.stringify(bad)).toBe(false);
    }
  });

  // #843-T98
  it("names the claim feature that reads the schema and the code of a turn that handed in nothing", () => {
    const features = contract.check("ClaimRequest", {
      engines: ["implementer"],
      features: ["implementer_result"],
    });
    expect(features.valid).toBe(true);
    const failed = example("RunnerResult");
    Object.assign(failed, { ok: false, errorCode: "no_result" });
    expect(accepts("RunnerResult", failed)).toBe(true);
  });
});
