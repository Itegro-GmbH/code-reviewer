// SPDX-License-Identifier: LicenseRef-Proprietary

// #839: the snapshot call of the contract (contracts/worker-api.v1.json, runner-api.v1.json). The schema and the examples are checked
// against each other (Ajv, no database), the hand-written reading of a request gives the same verdict as the schema for a set of
// good and bad queries, and the bounds the app keeps in TypeScript are the file's. The runner's half is
// runner/tests/contract/test_snapshot_contract.py.
import { describe, expect, it } from "vitest";
import {
  createContractValidator,
  readContract,
  readExamples,
} from "../test-support/runner-contract.ts";
import { APP_FEATURES, SNAPSHOT_LIMITS } from "./contract.ts";
import {
  SNAPSHOT_SHA256_PATTERN,
  SNAPSHOT_VERSION_PATTERN,
  parseSnapshotPartRequest,
  snapshotPartBytes,
} from "./snapshot-request.ts";

const workerContract = createContractValidator("worker-api.v1.json");

type Document = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- a JSON document edited by key in a test

function example(name: string): Document {
  const found = readExamples("examples/worker-api").find(
    (entry) => entry.definition === name,
  );
  if (found === undefined) throw new Error(`no example ${name}`);
  return structuredClone(found.document) as Document;
}

/** What the app reads: the query of the example (or a changed one) with a body of the length it announces. */
function parse(query: Document) {
  const size = Number(query.bytes);
  const index = Number(query.part);
  return parseSnapshotPartRequest(
    new URLSearchParams(query as Record<string, string>),
    new Uint8Array(
      Number.isFinite(size) && Number.isFinite(index)
        ? Math.max(0, snapshotPartBytes(size, index))
        : 0,
    ),
  );
}

describe("the examples of the snapshot call", () => {
  // #839-T40
  it.each(["SessionPartQuery", "SessionPartResponse"] as const)(
    "%s is valid",
    (name) => {
      expect(workerContract.check(name, example(name))).toStrictEqual({
        valid: true,
        errors: "",
      });
    },
  );

  // #839-T40
  it("the query example is read by the app", () => {
    expect(parse(example("SessionPartQuery")).ok).toBe(true);
  });
});

describe("the app's reading of a query and the schema", () => {
  // [name, change to the example, the schema's verdict, the app's verdict]. The app also checks what a schema over strings cannot: the
  // cap on the size, that the count is what the size makes, that the part is below the count and the body as long as announced.
  const cases: Array<[string, Document, boolean, boolean]> = [
    ["the example", {}, true, true],
    [
      "a later part of three",
      { part: "2", parts: "3", bytes: "7000000" },
      true,
      true,
    ],
    [
      "the largest snapshot",
      { part: "2", parts: "3", bytes: String(SNAPSHOT_LIMITS.maxBytes) },
      true,
      true,
    ],
    [
      "a size over the cap",
      { bytes: String(SNAPSHOT_LIMITS.maxBytes + 1), parts: "3" },
      true,
      false,
    ],
    ["a count the size does not make", { parts: "2" }, true, false],
    ["a part past the count", { part: "1" }, true, false],
    ["a digest in capitals", { sha256: "A".repeat(64) }, false, false],
    ["a short digest", { sha256: "abc" }, false, false],
    ["a version with a slash", { opencodeVersion: "1/2" }, false, false],
    [
      "a version that is too long",
      { opencodeVersion: "v".repeat(33) },
      false,
      false,
    ],
    ["a size with a sign", { bytes: "-1" }, false, false],
    ["a size of zero", { bytes: "0" }, false, false],
    ["a raw size of zero", { rawBytes: "0" }, false, false],
    ["four parts", { parts: "4" }, false, false],
    ["a part with leading zeros", { part: "01" }, false, false],
    ["a missing digest", { sha256: undefined }, false, false],
  ];

  // #839-T41
  it.each(cases)("%s", (_name, change, bySchema, byApp) => {
    const query = { ...example("SessionPartQuery"), ...change };
    for (const key of Object.keys(query))
      if (query[key] === undefined) delete query[key];

    expect(workerContract.check("SessionPartQuery", query).valid).toBe(
      bySchema,
    );
    expect(parse(query).ok).toBe(byApp);
  });
});

describe("the bounds the app keeps", () => {
  // #839-T42
  it("are the file's: the feature, the digest and version patterns, the number of parts", () => {
    const worker = readContract("worker-api.v1.json");
    const query = worker.$defs["SessionPartQuery"] as Document;
    expect(APP_FEATURES).toContain("implementer_snapshot");
    expect(
      (readContract().$defs["KnownAppFeature"]?.enum as string[]).includes(
        "implementer_snapshot",
      ),
    ).toBe(true);
    expect(query.properties.sha256.pattern).toBe(
      SNAPSHOT_SHA256_PATTERN.source,
    );
    expect(query.properties.opencodeVersion.pattern).toBe(
      SNAPSHOT_VERSION_PATTERN.source,
    );
    expect(query.properties.parts.pattern).toBe(
      `^[1-${SNAPSHOT_LIMITS.maxParts}]$`,
    );
    expect(SNAPSHOT_LIMITS.maxParts).toBe(
      Math.ceil(SNAPSHOT_LIMITS.maxBytes / SNAPSHOT_LIMITS.partBytes),
    );
    const response = worker.$defs["SessionPartResponse"] as Document;
    expect(response.properties.parts.maximum).toBe(SNAPSHOT_LIMITS.maxParts);
  });

  // #839-T42
  it("keep a part below what a function of the platform takes in one request", () => {
    expect(SNAPSHOT_LIMITS.partBytes).toBeLessThan(4_500_000);
    expect(SNAPSHOT_LIMITS.maxBytes).toBe(8 * 1024 * 1024);
  });
});
