// SPDX-License-Identifier: LicenseRef-Proprietary

// #1092 (review finding 7): the usage list names a turn of the Implementer by a real branch, never by the key of a multi-repository session.
import { describe, expect, it } from "vitest";
import { serializeSessionRepos } from "../db/session-repos.ts";
import { implementerBranchLabel } from "./workspace-page.ts";

const repo = (name: string, branch: string) => ({
  repositoryId: `id-${name}`,
  fullName: `acme/${name}`,
  name,
  base: "main",
  branch,
});

describe("the branch a usage row of the Implementer is named by", () => {
  it("is the session's branch for one repository, and a placeholder when the session is not known", () => {
    expect(implementerBranchLabel("implementer/abc", null)).toBe(
      "implementer/abc",
    );
    expect(implementerBranchLabel(null, null)).toBe("(Implementer)");
  });

  it("is the working branch of the first repository, and how many more there are, for several (never the key)", () => {
    const stored = serializeSessionRepos([
      repo("app", "feature/x"),
      repo("lib", "main"),
      repo("docs", "main"),
    ]);

    const label = implementerBranchLabel("workflow/run-1/implement", stored);

    expect(label).toBe("feature/x (+2 more repositories)");
    expect(label).not.toContain("workflow/run-1");
    expect(
      implementerBranchLabel(
        "workflow/run-1/implement",
        serializeSessionRepos([repo("app", "feature/x")]),
      ),
    ).toBe("feature/x");
  });
});
