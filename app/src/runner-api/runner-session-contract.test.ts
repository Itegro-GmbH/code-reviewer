// SPDX-License-Identifier: LicenseRef-Proprietary

// #879: the two snapshot calls of the runner API (contracts/runner-api.v1.json: RunnerLeaseTokenHeader, RunnerSessionPartQuery,
// RunnerSessionPartResponse, RunnerResumeSessionQuery, RunnerResumeSessionHeaders). The schema and the examples are checked against each
// other (Ajv, no database), the hand-written readings of the app give the same verdict as the schema, and the calls are the Worker API's
// with the lease token in a header: what the two files say about the query and the headers must not drift apart. The runner's half is
// runner/tests/contract/test_snapshot_contract.py.
import { describe, expect, it } from "vitest";
import {
  createContractValidator,
  readContract,
  readExamples,
} from "../test-support/runner-contract.ts";
import { APP_FEATURES, SNAPSHOT_LIMITS } from "./contract.ts";
import { LEASE_TOKEN_HEADER, parseLeaseTokenHeader } from "./lease-header.ts";
import { RESUME_SESSION_HEADERS, parseResumePart } from "./resume-session.ts";
import {
  parseSnapshotPartRequest,
  snapshotPartBytes,
} from "./snapshot-request.ts";

const contract = createContractValidator();

type Document = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- a JSON document edited by key in a test

function example(name: string): Document {
  const found = readExamples().find((entry) => entry.definition === name);
  if (found === undefined) throw new Error(`no example ${name}`);
  return structuredClone(found.document) as Document;
}

const DEFINITIONS = [
  "RunnerLeaseTokenHeader",
  "RunnerSessionPartQuery",
  "RunnerSessionPartResponse",
  "RunnerResumeSessionQuery",
  "RunnerResumeSessionHeaders",
] as const;

describe("the examples of the runner's snapshot calls", () => {
  // #879-T50
  it.each(DEFINITIONS)("%s is valid", (name) => {
    expect(contract.check(name, example(name))).toStrictEqual({
      valid: true,
      errors: "",
    });
  });

  // #879-T50
  it("the query example is read by the app, and so is the header example", () => {
    const query = example("RunnerSessionPartQuery");
    const size = Number(query.bytes);
    expect(
      parseSnapshotPartRequest(
        new URLSearchParams(query as Record<string, string>),
        new Uint8Array(snapshotPartBytes(size, Number(query.part))),
      ).ok,
    ).toBe(true);
    expect(
      parseLeaseTokenHeader(
        example("RunnerLeaseTokenHeader")[LEASE_TOKEN_HEADER],
      ).ok,
    ).toBe(true);
    expect(
      parseResumePart(
        new URLSearchParams(
          example("RunnerResumeSessionQuery") as Record<string, string>,
        ),
      ).ok,
    ).toBe(true);
  });
});

describe("the lease token header", () => {
  // [name, value, the schema's verdict, the app's verdict]
  const cases: Array<[string, string | undefined, boolean, boolean]> = [
    ["the example", "6f1d2c9a-5b3e-4a77-9c0d-8e2f1a4b7c33", true, true],
    ["the shortest token", "x".repeat(8), true, true],
    ["the longest token", "x".repeat(256), true, true],
    ["a token that is too short", "x".repeat(7), false, false],
    ["a token that is too long", "x".repeat(257), false, false],
    ["no header", undefined, false, false],
  ];

  // #879-T51
  it.each(cases)("%s", (_name, value, bySchema, byApp) => {
    expect(
      contract.check(
        "RunnerLeaseTokenHeader",
        value === undefined ? {} : { [LEASE_TOKEN_HEADER]: value },
      ).valid,
    ).toBe(bySchema);
    expect(parseLeaseTokenHeader(value ?? null).ok).toBe(byApp);
  });

  // #879-T51
  it("names the header by its fields on a refusal and never by its value", () => {
    const secret = "x".repeat(300);
    expect(JSON.stringify(parseLeaseTokenHeader(secret))).not.toContain(secret);
    expect(parseLeaseTokenHeader(null)).toStrictEqual({
      ok: false,
      fields: [{ field: "x-lease-token", code: "required" }],
    });
  });
});

describe("the runner's calls and the Worker's", () => {
  const worker = readContract("worker-api.v1.json").$defs;
  const runner = readContract().$defs;

  // #879-T52
  it.each([
    ["SessionPartQuery", "RunnerSessionPartQuery"],
    ["SessionPartResponse", "RunnerSessionPartResponse"],
    ["ResumeSessionQuery", "RunnerResumeSessionQuery"],
    ["ResumeSessionHeaders", "RunnerResumeSessionHeaders"],
  ] as const)(
    "%s says the same as %s about the fields (the descriptions differ)",
    (workerName, runnerName) => {
      const fields = (definition: Document) =>
        Object.fromEntries(
          Object.entries(definition).filter(([key]) => key !== "description"),
        );
      const theirs = fields(worker[workerName] as Document);
      const ours = fields(runner[runnerName] as Document);
      expect(ours).toStrictEqual(theirs);
    },
  );

  // #879-T52
  it("serves the headers the Worker API serves, under the names the contract lists", () => {
    expect(Object.values(RESUME_SESSION_HEADERS).sort()).toStrictEqual(
      Object.keys(
        (runner["RunnerResumeSessionHeaders"] as Document).properties,
      ).sort(),
    );
  });

  // #879-T53
  it("lists the feature of the two calls, next to the Worker API's, and the app lists it", () => {
    expect(APP_FEATURES).toContain("runner_session_snapshot");
    expect(APP_FEATURES).toContain("implementer_snapshot");
    expect([...(runner["KnownAppFeature"]?.enum ?? [])].sort()).toStrictEqual(
      [...APP_FEATURES].sort(),
    );
  });

  // #879-T53
  it("holds the file to the same bounds: the count of parts and the part size", () => {
    const query = (runner["RunnerSessionPartQuery"] as Document).properties;
    expect(query.parts.pattern).toBe(`^[1-${SNAPSHOT_LIMITS.maxParts}]$`);
    expect(
      (runner["RunnerSessionPartResponse"] as Document).properties.parts
        .maximum,
    ).toBe(SNAPSHOT_LIMITS.maxParts);
  });
});
