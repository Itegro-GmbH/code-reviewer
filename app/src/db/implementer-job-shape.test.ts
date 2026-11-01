// SPDX-License-Identifier: LicenseRef-Proprietary

// The one place that writes the pull request columns of a turn's job (#752).
import { describe, expect, it } from "vitest";
import { implementerJobShape } from "./implementer-job-shape.ts";

const input = {
  workspaceId: "w-1",
  repositoryUrl: "https://github.test/acme/widgets/",
  branch: "implementer/abc123",
  slot: 3,
  baseSha: "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
  clientRequestId: "req-1",
};

describe("the shape of a turn's job", () => {
  // #752-T01
  it("is a negative number that is never a pull request, a branch url and the documented constants", () => {
    expect(implementerJobShape(input)).toEqual({
      prNumber: -3,
      prUrl: "https://github.test/acme/widgets/tree/implementer/abc123",
      headSha: "abcdef0123456789abcdef0123456789abcdef01",
      command: "review",
      args: "",
      deliveryId: "implementer:w-1:req-1",
    });
  });

  // #755-T05
  it.each([
    ["feature/a#b", "feature/a%23b"],
    ["fix/what?", "fix/what%3F"],
    ["100%/done", "100%25/done"],
    ["a b/c+d", "a%20b/c%2Bd"],
    ["Zürich/ä", "Z%C3%BCrich/%C3%A4"],
  ])(
    "encodes the branch %s in the url, keeping the slashes",
    (branch, encoded) => {
      expect(implementerJobShape({ ...input, branch }).prUrl).toBe(
        `https://github.test/acme/widgets/tree/${encoded}`,
      );
    },
  );

  // #752-T01
  it.each([0, -1, 1.5, Number.NaN])("refuses the slot %s", (slot) => {
    expect(() => implementerJobShape({ ...input, slot })).toThrow();
  });

  // #752-T01
  it("keeps the deliveries of two workspaces apart for one request id", () => {
    expect(
      implementerJobShape({ ...input, workspaceId: "w-2" }).deliveryId,
    ).not.toBe(implementerJobShape(input).deliveryId);
  });
});
