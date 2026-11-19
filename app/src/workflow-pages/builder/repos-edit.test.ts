// SPDX-License-Identifier: LicenseRef-Proprietary

// #1094 (epic #1090): what the repository list of an agent step writes into the document.
import { describe, expect, it } from "vitest";
import type { Doc } from "./document.ts";
import {
  SESSION_REPOS_MAX,
  addRepoEntry,
  changeRepoEntry,
  removeRepoEntry,
  repoEntries,
} from "./repos-edit.ts";

const lane = (repos?: unknown): Doc => ({
  version: 1,
  name: "L",
  trigger: { kind: "manual" },
  steps: [
    {
      id: "work",
      kind: "agent",
      profile: "implementer",
      instruction: "Do it.",
      ...(repos === undefined ? {} : { repos }),
    },
  ],
});
const node = (doc: Doc): Doc => (doc.steps as Doc[])[0] as Doc;

describe("the repository list of an agent step", () => {
  // #1094-T50
  it("adds an entry, changes its fields and leaves out what is empty", () => {
    let doc = lane();
    expect(repoEntries(node(doc))).toEqual([]);
    doc = addRepoEntry(doc, "/steps/0", repoEntries(node(doc)));
    expect(node(doc).repos).toEqual([{ repo: "" }]);
    doc = changeRepoEntry(doc, "/steps/0", repoEntries(node(doc)), 0, {
      repo: "acme/app",
      base: "main",
      branch: "feature/{{trigger.ticket.key}}",
    });
    expect(node(doc).repos).toEqual([
      {
        repo: "acme/app",
        base: "main",
        branch: "feature/{{trigger.ticket.key}}",
      },
    ]);
    doc = changeRepoEntry(doc, "/steps/0", repoEntries(node(doc)), 0, {
      base: "",
      branch: "",
    });
    expect(node(doc).repos).toEqual([{ repo: "acme/app" }]);
  });

  // #1094-T51
  it("takes repos out of the step when the last entry goes, so it is the step of today again", () => {
    const doc = lane([{ repo: "a/b" }, { repo: "a/c", base: "dev" }]);
    const one = removeRepoEntry(doc, "/steps/0", repoEntries(node(doc)), 0);
    expect(node(one).repos).toEqual([{ repo: "a/c", base: "dev" }]);
    const none = removeRepoEntry(one, "/steps/0", repoEntries(node(one)), 0);
    expect(node(none)).not.toHaveProperty("repos");
  });

  // #1094-T52
  it("adds no eleventh repository", () => {
    const doc = lane(
      Array.from({ length: SESSION_REPOS_MAX }, (_, i) => ({
        repo: `a/r${i}`,
      })),
    );
    expect(addRepoEntry(doc, "/steps/0", repoEntries(node(doc)))).toBe(doc);
  });

  it("shows no entries for a repos that is not a list of objects, and keeps it until an edit", () => {
    expect(repoEntries(node(lane("{{x}}")))).toEqual([]);
    expect(repoEntries(node(lane(["a/b"])))).toEqual([
      { repo: "", base: "", branch: "" },
    ]);
  });
});
