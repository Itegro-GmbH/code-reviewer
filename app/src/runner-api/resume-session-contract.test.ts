// SPDX-License-Identifier: LicenseRef-Proprietary

// #840: the resume-session call of the contract (contracts/worker-api.v1.json). The schema and the examples are checked against each
// other (Ajv, no database), the part the app reads from a query gives the same verdict as the schema for a set of good and bad
// queries, and the names of the headers the app writes are the contract's. The runner's half is
// runner/tests/contract/test_resume_contract.py.
import { describe, expect, it } from "vitest";
import {
  createContractValidator,
  readContract,
  readExamples,
} from "../test-support/runner-contract.ts";
import { parseResumePart, RESUME_SESSION_HEADERS } from "./resume-session.ts";
import { SNAPSHOT_LIMITS } from "./contract.ts";

const workerContract = createContractValidator("worker-api.v1.json");

type Document = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- a JSON document edited by key in a test

function example(name: string): Document {
  const found = readExamples("examples/worker-api").find(
    (entry) => entry.definition === name,
  );
  if (found === undefined) throw new Error(`no example ${name}`);
  return structuredClone(found.document) as Document;
}

describe("the examples of the resume-session call", () => {
  // #840-T40
  it.each(["ResumeSessionQuery", "ResumeSessionHeaders"] as const)(
    "%s is valid",
    (name) => {
      expect(workerContract.check(name, example(name))).toStrictEqual({
        valid: true,
        errors: "",
      });
    },
  );

  // #840-T40
  it("the query example is read by the app", () => {
    expect(
      parseResumePart(new URLSearchParams(example("ResumeSessionQuery"))),
    ).toStrictEqual({ ok: true, part: 0 });
  });
});

describe("the app's reading of a query and the schema", () => {
  // [the part as sent, the schema's verdict, the app's verdict]. The app accepts a query with no part (it is part 0); the schema's
  // `part` is optional too.
  const cases: Array<[string, string | undefined, boolean]> = [
    ["no part", undefined, true],
    ["part 0", "0", true],
    ["part 1", "1", true],
    ["part 2, the last of three", "2", true],
    ["part 3, beyond the largest snapshot", "3", false],
    ["a negative part", "-1", false],
    ["a part with a leading zero", "01", false],
    ["a fraction", "1.5", false],
    ["text", "abc", false],
    ["an empty part", "", false],
  ];

  it.each(cases)("%s gets the same verdict from both", (_, part, verdict) => {
    const query: Record<string, string> = part === undefined ? {} : { part };

    expect(workerContract.check("ResumeSessionQuery", query).valid).toBe(
      verdict,
    );
    expect(parseResumePart(new URLSearchParams(query)).ok).toBe(verdict);
  });

  // #840-T41
  it("holds the bound of the part to the largest snapshot", () => {
    expect(SNAPSHOT_LIMITS.maxParts).toBe(3);
  });
});

describe("the headers", () => {
  // #840-T42
  it("are named as the contract names them, and the header example is complete", () => {
    const required = readContract("worker-api.v1.json").$defs
      .ResumeSessionHeaders?.required as string[] | undefined;

    expect([...(required ?? [])].sort()).toStrictEqual(
      Object.values(RESUME_SESSION_HEADERS).sort(),
    );
  });

  // #840-T42
  it("are refused when one is missing or is not what the contract says", () => {
    for (const edit of [
      (headers: Document) => delete headers["x-snapshot-sha256"],
      (headers: Document) => (headers["x-snapshot-parts"] = "4"),
      (headers: Document) => (headers["x-snapshot-bytes"] = "0"),
      (headers: Document) => (headers["x-snapshot-sha256"] = "G".repeat(64)),
      (headers: Document) => (headers["x-snapshot-opencode-version"] = "-1"),
    ]) {
      const headers = example("ResumeSessionHeaders");
      edit(headers);
      expect(workerContract.check("ResumeSessionHeaders", headers).valid).toBe(
        false,
      );
    }
  });
});
