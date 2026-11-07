// SPDX-License-Identifier: LicenseRef-Proprietary

// docs/profiles.md (#843) must not drift from the code: the example profiles in it pass the validator, every error code of the routes and
// every code of the body has a row, every field is named, and the numbers the code keeps are the numbers the document states.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROFILE_ERROR_CODES, PROFILE_ONLY_ISSUE_CODES } from "./errors.ts";
import {
  ARCHIVED_PROFILES_PER_WORKSPACE_MAX,
  DESCRIPTION_MAX_LENGTH,
  INSTRUCTIONS_MAX_LENGTH,
  PROFILE_BODY_MAX_BYTES,
  PROFILES_PER_WORKSPACE_MAX,
  VERSIONS_PER_PROFILE_MAX,
} from "./limits.ts";
import { REVIEWER_PROFILE } from "../test-support/reviewer-profile.ts";
import {
  COST_LIMIT_CENTS,
  PROFILE_FIELDS,
  validateProfile,
} from "./validate.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const docs = readFileSync(join(ROOT, "docs", "profiles.md"), "utf8");

function jsonBlocks(text: string): unknown[] {
  return [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) =>
    JSON.parse(match[1] as string),
  );
}

describe("docs/profiles.md", () => {
  // #843-T210
  it("holds example profiles that pass the validator", () => {
    const blocks = jsonBlocks(docs);

    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      const result = validateProfile(block);
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    }
  });

  // #846-T90
  it("holds the reviewer of the workflow Issue to PR, as the engine tests save it", () => {
    const [reviewer] = jsonBlocks(docs);

    expect(reviewer).toEqual({
      name: "reviewer",
      model: { entryId: "..." },
      environment: "node",
      ...REVIEWER_PROFILE,
    });
  });

  // #843-T211
  it("names every field of a profile in the table of fields", () => {
    for (const field of PROFILE_FIELDS)
      expect(docs).toContain(`| \`${field}\` |`);
  });

  // #843-T212
  it.each([...PROFILE_ERROR_CODES, ...PROFILE_ONLY_ISSUE_CODES])(
    "has a row for the code %s",
    (code) => {
      expect(docs).toContain(`| \`${code}\` |`);
    },
  );

  // #843-T213
  it("has no row for an error code of the routes that is gone", () => {
    const rows = [...docs.matchAll(/^\| `(PROFILE_[A-Z_]+)` \|/gm)].map(
      (match) => match[1] as string,
    );

    expect(rows.toSorted()).toEqual([...PROFILE_ERROR_CODES].toSorted());
  });

  // #843-T214
  it("states the numbers the code keeps", () => {
    for (const text of [
      `${PROFILES_PER_WORKSPACE_MAX} profiles`,
      `${VERSIONS_PER_PROFILE_MAX.toLocaleString("en-US")} versions`,
      `${ARCHIVED_PROFILES_PER_WORKSPACE_MAX.toLocaleString("en-US")} archived profiles`,
      `${DESCRIPTION_MAX_LENGTH.toLocaleString("en-US")} characters at most`,
      `${INSTRUCTIONS_MAX_LENGTH.toLocaleString("en-US")} characters at most`,
      `(${COST_LIMIT_CENTS.min} to ${COST_LIMIT_CENTS.max.toLocaleString("en-US")})`,
      `A body over ${PROFILE_BODY_MAX_BYTES / 1024} KB`,
    ])
      expect(docs).toContain(text);
  });
});
