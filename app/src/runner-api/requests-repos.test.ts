// SPDX-License-Identifier: LicenseRef-Proprietary

// #1092 (epic #1090, ADR 0006): the report of a turn on several repositories (`result.implementer.repos`, `ImplementerRepoResult` in the
// contract): the example of the contract is read whole and unchanged, every entry is a closed object within its bounds, and the secrets are taken out
// of the texts of every repository.
import { describe, expect, it } from "vitest";
import { readExamples } from "../test-support/runner-contract.ts";
import { redactResult } from "./redact.ts";
import { parseCompleteRequest } from "./requests.ts";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- a JSON document edited by key in a test

const TOKEN = "6f1d2c9a-5b3e-4a77-9c0d-8e2f1a4b7c33";

function example(): Json {
  const found = readExamples("examples/implementer-multi-repo").find(
    (entry) => entry.definition === "RunnerResult",
  );
  if (found === undefined) throw new Error("no example");
  return structuredClone(found.document) as Json;
}

function parse(result: Json) {
  return parseCompleteRequest({ leaseToken: TOKEN, result });
}

describe("the report of a turn on several repositories", () => {
  // #1092-T60
  it("reads the example of the contract as it is", () => {
    const parsed = parse(example());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const block = parsed.value.result.implementer;
    expect(block?.repos?.map((repo) => repo.name)).toEqual(
      (example().implementer as Json).repos.map((repo: Json) => repo.name),
    );
    // The old fields are the copy of the first repository's entry.
    expect(block?.commits).toEqual(block?.repos?.[0]?.commits);
    expect(block?.headCommit).toBe(block?.repos?.[0]?.headCommit);
  });

  // #1092-T61
  it("keeps a result without repos as a result of today", () => {
    const result = example();
    delete result.implementer.repos;
    const parsed = parse(result);
    expect(parsed.ok && parsed.value.result.implementer?.repos).toBeFalsy();
  });

  // #1092-T62
  it.each([
    ["an empty list", (r: Json) => (r.implementer.repos = [])],
    [
      "eleven repositories",
      (r: Json) =>
        (r.implementer.repos = Array.from(
          { length: 11 },
          () => r.implementer.repos[0],
        )),
    ],
    ["an entry that is no object", (r: Json) => (r.implementer.repos = ["x"])],
    ["an unknown key", (r: Json) => (r.implementer.repos[0].remote = "origin")],
    ["no name", (r: Json) => delete r.implementer.repos[0].name],
    ["no created flag", (r: Json) => delete r.implementer.repos[0].created],
    [
      "pushed without a head commit",
      (r: Json) => {
        r.implementer.repos[0].headCommit = null;
        r.implementer.repos[0].pushed = true;
      },
    ],
    [
      "101 commits",
      (r: Json) =>
        (r.implementer.repos[0].commits = Array(101).fill({
          sha: "a".repeat(40),
          subject: "c",
        })),
    ],
    [
      "251 files",
      (r: Json) =>
        (r.implementer.repos[0].filesChanged = Array(251).fill({
          path: "a",
          status: "added",
        })),
    ],
    [
      "a negative count of cut commits",
      (r: Json) => (r.implementer.repos[0].commitsTruncated = -1),
    ],
  ])("refuses %s", (_name, change) => {
    const result = example();
    change(result);
    expect(parse(result).ok).toBe(false);
  });

  // #1092-T63
  it("takes the secrets out of the branch names, commit subjects and paths of every repository", () => {
    const parsed = parse(example());
    if (!parsed.ok) throw new Error("expected a valid report");
    const withSecret = structuredClone(parsed.value.result);
    const repo = withSecret.implementer?.repos?.[1];
    if (repo === undefined)
      throw new Error("the example has a second repository");
    repo.branch = "feature/token-s3cr3t-value";
    repo.commits = [{ sha: "a".repeat(40), subject: "use s3cr3t-value here" }];
    repo.filesChanged = [{ path: "s3cr3t-value/file", status: "added" }];
    const cleaned = redactResult(withSecret, ["s3cr3t-value"]);
    const text = JSON.stringify(cleaned.implementer?.repos);
    expect(text).not.toContain("s3cr3t-value");
  });
});
