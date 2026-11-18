// SPDX-License-Identifier: LicenseRef-Proprietary

// The pure rules of the repositories of a session (#1092): what is stored and read back, and which repository names can be mounted.
import { describe, expect, it } from "vitest";
import {
  isRepositoryFullName,
  parseSessionRepos,
  serializeSessionRepos,
} from "./session-repos.ts";

const REPO = {
  repositoryId: "r-1",
  fullName: "acme/app",
  name: "app",
  base: "main",
  branch: "feature/x",
};

describe("the stored repositories of a session", () => {
  it("are read back as they were written", () => {
    expect(parseSessionRepos(serializeSessionRepos([REPO]))).toEqual([REPO]);
    expect(parseSessionRepos(null)).toBeNull();
  });

  // #1092 (review finding 3): the caller tells "none" (null column) from "unreadable" (set, and null here); the claim never treats the latter as one repository.
  it.each([
    ["text that is not JSON", "{not json"],
    ["a value that is no list", '{"a":1}'],
    ["an empty list", "[]"],
    ["more than ten entries", JSON.stringify(Array(11).fill(REPO))],
    [
      "a branch with whitespace",
      JSON.stringify([{ ...REPO, branch: "feature/a b" }]),
    ],
    ["an entry that is no object", '["acme/app"]'],
    ["an entry without a name", JSON.stringify([{ ...REPO, name: undefined }])],
  ])("are not readable from %s", (_, text) => {
    expect(parseSessionRepos(text)).toBeNull();
  });
});

describe("the repository names a multi-repository job can mount", () => {
  it.each([
    "acme/app",
    "acme/.github",
    "acme/result",
    "a_b/c.d-e",
    "acme/a.git",
  ])("takes %s", (name) => {
    expect(isRepositoryFullName(name)).toBe(true);
  });

  // #1092 (review finding 6)
  it.each([
    "app",
    "acme/",
    "/app",
    "acme/-app",
    "-acme/app",
    "acme/.",
    "acme/..",
    "acme/.git",
    "acme/.GIT",
    "./app",
    "../app",
    "acme/app/extra",
    "acme/ap p",
  ])("refuses %s", (name) => {
    expect(isRepositoryFullName(name)).toBe(false);
  });
});
