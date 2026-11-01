// SPDX-License-Identifier: LicenseRef-Proprietary

// The Dispatcher's own check of the shared contracts (contracts/README.md, "Who checks what"): the
// examples are valid under the schemas, and what the Dispatcher accepts and refuses agrees with them.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { DispatchStopSchema } from "./triggers/stop-schema.ts";
import { DispatchWebhookSchema } from "./triggers/webhook-schema.ts";
import {
  APP_FAILURES,
  createAppClient,
  parseSplitClaim,
} from "./core/app-client.ts";
import { readContract } from "./test-support/harness.ts";
import {
  CONTRACT_REVIEW_KINDS,
  ENGINE_BY_KIND,
  KNOWN_KINDS,
  REVIEWER_KINDS,
} from "./core/types.ts";

const CONTRACTS = join(import.meta.dirname, "..", "..", "contracts");

// A schema is found under its own `$id`, which the files state; no test spells the address out.
const ids = new Map<string, string>();
function ajvWithContracts(): Ajv2020 {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  for (const file of ["runner-api", "dispatch-webhook", "dispatcher-ops"]) {
    const schema = readContract<{ $id: string }>(`${file}.v1.json`);
    ids.set(file, schema.$id);
    ajv.addSchema(schema);
  }
  return ajv;
}
const ajv = ajvWithContracts();

function validator(file: string, definition: string) {
  const check = ajv.getSchema(`${ids.get(file)}#/$defs/${definition}`);
  if (check === undefined) throw new Error(`no definition ${definition}`);
  return check;
}

describe("the contracts the Dispatcher speaks", () => {
  // #327 (additional)
  it("has valid examples for the dispatch webhook, the split claim, the release and the version", () => {
    for (const [file, definition, example] of [
      [
        "dispatch-webhook",
        "DispatchWebhook",
        "examples/dispatch-webhook/DispatchWebhook.json",
      ],
      [
        "dispatch-webhook",
        "DispatchAccepted",
        "examples/dispatch-webhook/DispatchAccepted.json",
      ],
      [
        "dispatch-webhook",
        "DispatchIgnored",
        "examples/dispatch-webhook/DispatchIgnored.json",
      ],
      ["runner-api", "ClaimRequest", "examples/ClaimRequest.json"],
      ["runner-api", "SplitClaimResponse", "examples/SplitClaimResponse.json"],
      ["runner-api", "ReleaseRequest", "examples/ReleaseRequest.json"],
      ["runner-api", "ReleaseResponse", "examples/ReleaseResponse.json"],
      ["runner-api", "VersionResponse", "examples/VersionResponse.json"],
      ["runner-api", "JobStateResponse", "examples/JobStateResponse.json"],
      ["runner-api", "VmStartRequest", "examples/VmStartRequest.json"],
      ["runner-api", "VmStartResponse", "examples/VmStartResponse.json"],
    ] as const) {
      const check = validator(file, definition);
      expect(
        check(readContract(example)),
        `${definition}: ${JSON.stringify(check.errors)}`,
      ).toBe(true);
    }
    expect(
      readdirSync(join(CONTRACTS, "examples", "dispatch-webhook")).sort(),
    ).toStrictEqual([
      "DispatchAccepted.json",
      "DispatchIgnored.json",
      "DispatchStop.json",
      "DispatchStopAccepted.json",
      "DispatchStopIgnored.json",
      "DispatchWebhook.json",
    ]);
  });

  // #493-T02
  it("sends a VM start report that is a valid VmStartRequest", async () => {
    let sent: unknown;
    const client = createAppClient({
      appUrl: "https://app.example.test",
      token: "example-dispatcher-token",
      poolId: "pool",
      fetch: (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return Promise.resolve(new Response("{}", { status: 200 }));
      },
    });

    const result = await client.reportVm(
      "0b9f6f4e-3c1a-4d9e-8f43-2a7d5e1c9b10",
      "crj_EXAMPLEexampleEXAMPLEexampleEXAMPLE-0123456",
      {
        name: "cr-diff-0b9f6f4e-3c1a-4d9e-8f43-2a7d5e1c9b10-ab12cd34",
        startedAt: new Date("2026-10-19T10:00:00.250Z"),
        timeoutSeconds: 2100,
      },
    );

    const check = validator("runner-api", "VmStartRequest");
    expect(result).toBe("recorded");
    expect(check(sent), JSON.stringify(check.errors)).toBe(true);
    expect(sent).toStrictEqual(readContract("examples/VmStartRequest.json"));
  });

  // #487-T10
  it("has valid examples for the stop call and its two answers", () => {
    for (const [definition, example] of [
      ["DispatchStop", "examples/dispatch-webhook/DispatchStop.json"],
      [
        "DispatchStopAccepted",
        "examples/dispatch-webhook/DispatchStopAccepted.json",
      ],
      [
        "DispatchStopIgnored",
        "examples/dispatch-webhook/DispatchStopIgnored.json",
      ],
    ] as const) {
      const check = validator("dispatch-webhook", definition);
      expect(
        check(readContract(example)),
        `${definition}: ${JSON.stringify(check.errors)}`,
      ).toBe(true);
    }
  });

  // #487-T02, #487-T10
  it("accepts and refuses the same stop bodies as the schema file", () => {
    const good = readContract<Record<string, unknown>>(
      "examples/dispatch-webhook/DispatchStop.json",
    );
    const bodies: Array<[string, unknown]> = [
      ["the example", good],
      ["an unknown field", { ...good, extra: 1 }],
      ["a credential field", { ...good, credential: "crj_x" }],
      ["a kind field", { ...good, reviewKind: "diff" }],
      ["a missing stop id", { ...good, stopId: undefined }],
      ["a missing job id", { ...good, jobId: undefined }],
      ["a wrong version", { ...good, version: 2 }],
      ["the type of the wake-up call", { ...good, type: "job.ready" }],
      ["a bad job id", { ...good, jobId: "not-a-uuid" }],
      [
        "a job id with a path in it",
        { ...good, jobId: `${String(good.jobId)}/..` },
      ],
      ["a bad stop id", { ...good, stopId: "x" }],
      ["a bad timestamp", { ...good, sentAt: "yesterday" }],
      ["an array", []],
      ["null", null],
    ];
    const check = validator("dispatch-webhook", "DispatchStop");

    for (const [name, body] of bodies)
      expect(DispatchStopSchema.safeParse(body).success, name).toBe(
        check(body),
      );
  });

  // #327-T02
  it("accepts and refuses the same webhook bodies as the schema file", () => {
    const good = readContract<Record<string, unknown>>(
      "examples/dispatch-webhook/DispatchWebhook.json",
    );
    const bodies: Array<[string, unknown]> = [
      ["the example", good],
      ["a second attempt", { ...good, attempt: 2 }],
      ["a dynamic job", { ...good, reviewKind: "dynamic" }],
      // #746-T05
      ["an implementer job", { ...good, reviewKind: "implementer" }],
      ["an unknown field", { ...good, extra: 1 }],
      ["a credential field", { ...good, credential: "crj_x" }],
      ["a missing field", { ...good, sentAt: undefined }],
      ["a wrong version", { ...good, version: 2 }],
      ["attempt zero", { ...good, attempt: 0 }],
      ["attempt 101", { ...good, attempt: 101 }],
      ["a fractional attempt", { ...good, attempt: 1.5 }],
      ["a bad job id", { ...good, jobId: "not-a-uuid" }],
      ["a bad timestamp", { ...good, sentAt: "yesterday" }],
      ["an unknown kind", { ...good, reviewKind: "other" }],
      ["an array", []],
      ["null", null],
    ];
    const check = validator("dispatch-webhook", "DispatchWebhook");

    for (const [name, body] of bodies)
      expect(DispatchWebhookSchema.safeParse(body).success, name).toBe(
        check(body),
      );
  });

  // #327 (additional)
  it("reads the split claim answer, and refuses the legacy one and a malformed credential", () => {
    const split = readContract<{ job: Record<string, unknown> }>(
      "examples/SplitClaimResponse.json",
    );
    const legacy = readContract("examples/ClaimResponse.json");

    expect(parseSplitClaim(split)).toMatchObject({ id: split.job.id });
    expect(parseSplitClaim(legacy)).toBeNull();
    expect(
      parseSplitClaim({ ...split, job: { ...split.job, credential: "short" } }),
    ).toBeNull();
    expect(parseSplitClaim({ ...split, version: 2 })).toBeNull();
    // The raw example file is read from disk too, so a change of the schema file shows here.
    expect(
      JSON.parse(
        readFileSync(
          join(CONTRACTS, "examples", "SplitClaimResponse.json"),
          "utf8",
        ),
      ),
    ).toBeTruthy();
  });
});

describe("the operator routes of the Dispatcher (#730)", () => {
  // #730-T16
  it("has a valid example of the apps check answer, and the codes of the file are the codes of the code", () => {
    const check = validator("dispatcher-ops", "AppsCheckResponse");
    expect(
      check(readContract("examples/dispatcher-ops/AppsCheckResponse.json")),
      JSON.stringify(check.errors),
    ).toBe(true);
    expect(
      readdirSync(join(CONTRACTS, "examples", "dispatcher-ops")),
    ).toStrictEqual(["AppsCheckResponse.json"]);
    const codes = readContract<{
      $defs: { AppCheckCode: { enum: Array<string | null> } };
    }>("dispatcher-ops.v1.json").$defs.AppCheckCode.enum;
    expect(codes.filter((code) => code !== null).sort()).toStrictEqual(
      [...APP_FAILURES].sort(),
    );
    expect(codes).toContain(null);
  });
});

describe("the implementer kind in the contracts the Dispatcher speaks (#746)", () => {
  const runnerApi = readContract<{
    $defs: Record<string, { enum?: string[] }>;
  }>("runner-api.v1.json");

  // #746-T03
  it("lists the review kinds and the engines of the contract file", () => {
    expect([...CONTRACT_REVIEW_KINDS].sort()).toStrictEqual(
      [...(runnerApi.$defs.ReviewKind?.enum ?? [])].sort(),
    );
    expect(Object.keys(ENGINE_BY_KIND).sort()).toStrictEqual(
      [...(runnerApi.$defs.ReviewKind?.enum ?? [])].sort(),
    );
    expect(runnerApi.$defs.Engine?.enum).toContain("implementer");
    expect(new Set(Object.values(ENGINE_BY_KIND))).toStrictEqual(
      new Set(runnerApi.$defs.Engine?.enum),
    );
  });

  // #759-T01
  it("serves every kind of the contract, each with the engine of the contract, and the reviewer's kinds are the two review kinds", () => {
    expect([...KNOWN_KINDS].sort()).toStrictEqual(
      [...(runnerApi.$defs.ReviewKind?.enum ?? [])].sort(),
    );
    expect([...KNOWN_KINDS]).toStrictEqual([...CONTRACT_REVIEW_KINDS]);
    expect(Object.keys(ENGINE_BY_KIND).sort()).toStrictEqual(
      [...KNOWN_KINDS].sort(),
    );
    expect(ENGINE_BY_KIND.implementer).toBe("implementer");
    expect([...REVIEWER_KINDS]).toStrictEqual(["diff", "dynamic"]);
  });

  // #746-T01
  it("reads the split claim answer of an implementer job as the schema does", () => {
    const example = readContract<{ job: Record<string, unknown> }>(
      "examples/implementer/SplitClaimResponse.json",
    );
    const check = validator("runner-api", "SplitClaimResponse");

    expect(check(example), JSON.stringify(check.errors)).toBe(true);
    expect(parseSplitClaim(example)).toMatchObject({
      id: example.job.id,
      reviewKind: "implementer",
    });
    expect(
      parseSplitClaim({
        ...example,
        job: { ...example.job, reviewKind: "review" },
      }),
    ).toBeNull();
  });

  // #746-T01
  it("has valid examples of the job input and the result", () => {
    for (const [definition, example] of [
      ["RunnerJobInput", "examples/implementer/RunnerJobInput.json"],
      ["RunnerResult", "examples/implementer/RunnerResult.json"],
    ] as const) {
      const check = validator("runner-api", definition);
      expect(
        check(readContract(example)),
        `${definition}: ${JSON.stringify(check.errors)}`,
      ).toBe(true);
    }
    expect(
      readdirSync(join(CONTRACTS, "examples", "implementer")).sort(),
    ).toStrictEqual([
      "RunnerJobInput.json",
      "RunnerResult.json",
      "SplitClaimResponse.json",
    ]);
  });
});
