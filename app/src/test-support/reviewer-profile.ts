// SPDX-License-Identifier: LicenseRef-Proprietary

// The reviewer profile of the workflow "Issue to PR" (#846): a profile that may not push and answers with a list of findings. Profiles are
// data that people create (nothing is seeded into a workspace), so this is the example of `docs/profiles.md` as a fixture: the engine
// tests save it, and a test holds it to the document. The model is the one of the test.

/** What a review step yields: the findings of the review. An empty list is a review that found nothing. */
export const FINDINGS_RESULT = {
  type: "object",
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        required: ["type", "name", "description"],
        properties: {
          type: { type: "string", enum: ["bug", "risk", "nit"] },
          name: { type: "string", maxLength: 120 },
          description: { type: "string" },
        },
      },
    },
  },
} as const;

export const REVIEWER_PROFILE = {
  description:
    "Reads a branch and reports what is wrong. Changes nothing that leaves the container.",
  instructions:
    "You review code. Read the task and the work, run the tests if there are any, and report each problem as a finding. Do not change any file.",
  canPush: false,
  defaultResult: FINDINGS_RESULT,
} as const;
