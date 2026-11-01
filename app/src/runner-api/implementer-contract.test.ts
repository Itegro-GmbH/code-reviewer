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
  IMPLEMENTER_NETWORK_MODES,
  RUNNER_ERROR_CODES,
  RUNNER_REVIEW_KINDS,
} from "./contract.ts";
import { checkJob } from "./claim.ts";
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
  "push_rejected",
  "branch_violation",
  "cost_limit_reached",
  "time_limit_reached",
  "git_write_not_granted",
  "implementer_engine_unavailable",
  "implementer_config_invalid",
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
      "RUNNER_IMPLEMENTER_EGRESS_PORT",
      "RUNNER_IMPLEMENTER_NETWORK",
    ]);
    expect([...IMPLEMENTER_ENVIRONMENT_NAMES].sort()).toStrictEqual(
      [...(defs.KnownImplementerEnvironmentName?.enum ?? [])].sort(),
    );
    expect([...IMPLEMENTER_NETWORK_MODES].sort()).toStrictEqual(
      [...(defs.ImplementerNetworkMode?.enum ?? [])].sort(),
    );
    expect([...IMPLEMENTER_NETWORK_MODES].sort()).toStrictEqual([
      "none",
      "registries",
    ]);
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
