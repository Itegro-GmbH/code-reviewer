// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { githubBranchLink, githubLinkInRepository } from "./github-link.ts";

const REPO = "acme/widgets";

describe("the links a workflow page makes to GitHub", () => {
  // #873-T10
  it("links an address of the run's repository on github.com, normalised", () => {
    expect(
      githubLinkInRepository("https://github.com/acme/widgets/pull/12", REPO),
    ).toBe("https://github.com/acme/widgets/pull/12");
    expect(
      githubLinkInRepository("https://github.com/acme/widgets", REPO),
    ).toBe("https://github.com/acme/widgets");
    // GitHub ignores the case of a repository name.
    expect(
      githubLinkInRepository("https://github.com/ACME/Widgets/issues/3", REPO),
    ).toBe("https://github.com/ACME/Widgets/issues/3");
  });

  // #873-T11
  it.each([
    ["a script address", "javascript:alert(1)"],
    ["a data address", "data:text/html,<script>alert(1)</script>"],
    ["plain http", "http://github.com/acme/widgets/pull/1"],
    ["another host", "https://evil.example/acme/widgets/pull/1"],
    [
      "a host that only starts like it",
      "https://github.com.evil.example/acme/widgets/pull/1",
    ],
    ["a subdomain", "https://gist.github.com/acme/widgets/pull/1"],
    ["a user in the address", "https://acme@github.com/acme/widgets/pull/1"],
    ["a port", "https://github.com:8443/acme/widgets/pull/1"],
    ["another repository", "https://github.com/acme/other/pull/1"],
    ["another owner", "https://github.com/evil/widgets/pull/1"],
    [
      "a repository that only starts like it",
      "https://github.com/acme/widgets-evil/pull/1",
    ],
    ["the owner alone", "https://github.com/acme"],
    [
      "a dot segment that leaves the repository",
      "https://github.com/acme/widgets/../other/pull/1",
    ],
    [
      "an encoded dot segment",
      "https://github.com/acme/widgets/%2e%2e/other/pull/1",
    ],
    ["text that is no address", "see the pull request"],
    ["an empty text", ""],
  ])("does not link %s", (_name, value) => {
    expect(githubLinkInRepository(value, REPO)).toBeUndefined();
  });

  // #873-T11
  it("does not link a value that is no text, or when the run's repository is not known", () => {
    expect(githubLinkInRepository(42, REPO)).toBeUndefined();
    expect(githubLinkInRepository(null, REPO)).toBeUndefined();
    expect(
      githubLinkInRepository(
        "https://github.com/acme/widgets/pull/1",
        undefined,
      ),
    ).toBeUndefined();
    expect(
      githubLinkInRepository(
        "https://github.com/acme/widgets/pull/1",
        "not a repo",
      ),
    ).toBeUndefined();
  });

  it("makes the link of a branch from the repository and the name, encoded", () => {
    expect(githubBranchLink(REPO, "workflow/run-1/plan")).toBe(
      "https://github.com/acme/widgets/tree/workflow/run-1/plan",
    );
    expect(githubBranchLink(REPO, "fix#1 ?x")).toBe(
      "https://github.com/acme/widgets/tree/fix%231%20%3Fx",
    );
    expect(githubBranchLink(REPO, "../other")).toBeUndefined();
    expect(githubBranchLink(REPO, "a//b")).toBeUndefined();
    expect(githubBranchLink(REPO, "a/./b")).toBeUndefined();
    expect(githubBranchLink(REPO, "/leading")).toBeUndefined();
    expect(githubBranchLink(REPO, "")).toBeUndefined();
    expect(githubBranchLink(REPO, 7)).toBeUndefined();
    expect(githubBranchLink(undefined, "main")).toBeUndefined();
  });
});
