// SPDX-License-Identifier: LicenseRef-Proprietary

// #918: the cost limit of a profile is deprecated. A profile can be written without one, and the document an API call shows never has
// one, even when the stored version still holds a limit from before.
import { describe, expect, it } from "vitest";
import { documentOf } from "./service.ts";
import { validateProfile } from "./validate.ts";

const version = (costLimitCents: number | null) => ({
  profileId: "p-1",
  version: 1,
  createdBy: "u-1",
  createdAt: "2026-11-07T08:00:00.000Z",
  content: {
    description: "",
    model: { entryId: "entry-1" },
    instructions: "",
    costLimitCents,
    canPush: false,
    defaultResult: null,
  },
});

describe("the document of a profile", () => {
  // #918-T12
  it("accepts a body without costLimitCents", () => {
    const result = validateProfile({
      name: "reviewer",
      model: { entryId: "entry-1" },
      canPush: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  // #918-T13
  it("does not show the cost limit, whatever the stored version holds", () => {
    for (const stored of [null, 300])
      expect(documentOf("reviewer", version(stored))).not.toHaveProperty(
        "costLimitCents",
      );
  });
});
