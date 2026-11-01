// SPDX-License-Identifier: LicenseRef-Proprietary

// Every stable code of the Implementer routes has a sentence of its own, and the sentences are fixed (#756): what a response
// carried (a message, a field, a name) is never put into one.
import { describe, expect, it } from "vitest";
import { identityFor } from "../../product-identity/identities.ts";
import { TRANSPORT_ERROR_CODES } from "../../ui/json-request.ts";
import { BRANCH_NAME_ISSUES } from "../branch-name.ts";
import {
  IMPLEMENTER_ERROR_CODES,
  MODEL_REFUSAL_REASONS,
  UNWRITABLE_REASONS,
} from "../errors.ts";
import {
  describeBranchIssue,
  describeFieldIssue,
  describeImplementerFailure,
  describeModelRefusal,
  describeUnwritable,
  describeUnwritableNote,
  MODEL_REFUSAL_COPY_REASONS,
} from "./messages.ts";

const factory = identityFor("factory");

describe("the sentences of the Implementer page", () => {
  // #756-T08
  it("has a sentence for every error code of the routes, for every transport code, and none is empty or the code itself", () => {
    for (const code of [...IMPLEMENTER_ERROR_CODES, ...TRANSPORT_ERROR_CODES]) {
      const sentence = describeImplementerFailure(factory, { code });
      expect(sentence, code).toMatch(/\w+ \w+ /);
      expect(sentence, code).not.toContain(code);
      expect(sentence.endsWith("."), code).toBe(true);
    }
  });

  // #756-T08
  it("has a sentence for every rule of the branch name, for every reason a model is refused, and says which rule or reason", () => {
    const rules = new Set<string>();
    for (const rule of BRANCH_NAME_ISSUES) {
      const sentence = describeBranchIssue(rule);
      expect(sentence, rule).toMatch(/\w+ \w+ /);
      rules.add(sentence);
    }
    // A sentence per rule, not one for all.
    expect(rules.size).toBe(BRANCH_NAME_ISSUES.length);
    expect(MODEL_REFUSAL_COPY_REASONS).toEqual([...MODEL_REFUSAL_REASONS]);
    const reasons = new Set<string>();
    for (const reason of MODEL_REFUSAL_REASONS) {
      const sentence = describeModelRefusal(reason);
      expect(sentence, reason).toMatch(/\w+ \w+ /);
      reasons.add(sentence);
    }
    expect(reasons.size).toBe(MODEL_REFUSAL_REASONS.length);
  });

  // #756-T08
  it("says on every field issue what to do, for the codes a field can get", () => {
    for (const field of [
      "repositoryId",
      "baseBranch",
      "branch",
      "instruction",
      "model",
      "costLimitCents",
      "clientRequestId",
    ] as const)
      for (const code of ["required", "invalid", "too_long"] as const)
        expect(describeFieldIssue(field, code), `${field} ${code}`).toMatch(
          /\w+ \w+ /,
        );
    for (const rule of BRANCH_NAME_ISSUES)
      expect(describeFieldIssue("branch", rule)).toBe(
        describeBranchIssue(rule),
      );
  });

  // #756-T08
  it("never shows text of the response: an unknown code gets the generic sentence, and the extra fields of an answer stay out", () => {
    const generic = describeImplementerFailure(factory, {
      code: "SOMETHING_NEW",
    });
    expect(generic).toMatch(/^Something went wrong/);
    const sentence = describeImplementerFailure(factory, {
      code: "IMPLEMENTER_GITHUB_UNAVAILABLE",
      message: "Bad credentials ghs_SECRET",
      detail: "<script>alert(1)</script>",
    } as never);
    expect(sentence).not.toMatch(/ghs_SECRET|script/);
    // The one number an answer carries is formatted by us.
    expect(
      describeImplementerFailure(factory, {
        code: "EXCEEDS_OPERATOR_MAXIMUM",
        maximumCents: 250,
      }),
    ).toContain("$2.50");
  });

  // #756-T08
  it("says a new branch name is needed when the name is taken or clashes", () => {
    for (const code of [
      "IMPLEMENTER_BRANCH_EXISTS",
      "IMPLEMENTER_BRANCH_CONFLICT",
    ])
      expect(describeImplementerFailure(factory, { code }), code).toMatch(
        /new branch name/i,
      );
  });

  // #756-T08
  it("says plainly what to do when the installation has no write permission, and names the product where it means the product", () => {
    const sentence = describeImplementerFailure(factory, {
      code: "IMPLEMENTER_WRITE_NOT_GRANTED",
    });
    expect(sentence).toMatch(/permission/i);
    expect(sentence).toMatch(/approve/i);
    expect(sentence).toMatch(/GitHub/);
    expect(
      describeImplementerFailure(factory, {
        code: "ACCESS_DENIED",
      }),
    ).toContain(factory.name);
  });

  // #756-T08
  it("explains a refused model by its reason, and a refusal without a known reason with the general sentence", () => {
    const withReason = describeImplementerFailure(factory, {
      code: "IMPLEMENTER_MODEL_NOT_ALLOWED",
      reason: "no_key",
    });
    expect(withReason).toBe(describeModelRefusal("no_key"));
    expect(
      describeImplementerFailure(factory, {
        code: "IMPLEMENTER_MODEL_NOT_ALLOWED",
        reason: "not-a-reason",
      }),
    ).toMatch(/model/i);
  });
});

describe("the reasons a repository cannot be sent a task (review of #793)", () => {
  // #756-T08
  it("has a sentence and a note of its own for every reason, and each says what is true", () => {
    const sentences = new Set<string>();
    const notes = new Set<string>();
    for (const reason of UNWRITABLE_REASONS) {
      const sentence = describeUnwritable(factory, reason);
      expect(sentence, reason).toMatch(/\w+ \w+ /);
      expect(sentence.endsWith("."), reason).toBe(true);
      sentences.add(sentence);
      notes.add(describeUnwritableNote(reason));
    }
    expect(sentences.size).toBe(UNWRITABLE_REASONS.length);
    expect(notes.size).toBe(UNWRITABLE_REASONS.length);
  });

  // #756-T08
  it("asks for the new permission only where the permission is what is missing", () => {
    expect(describeUnwritableNote("write_not_granted")).toBe(
      "approve the new GitHub permission",
    );
    for (const reason of UNWRITABLE_REASONS) {
      if (reason === "write_not_granted") continue;
      expect(describeUnwritableNote(reason), reason).not.toMatch(/approve/i);
      expect(describeUnwritable(factory, reason), reason).not.toMatch(
        /approve the new/i,
      );
    }
    expect(describeUnwritable(factory, "write_not_granted")).toBe(
      describeImplementerFailure(factory, {
        code: "IMPLEMENTER_WRITE_NOT_GRANTED",
      }),
    );
    expect(describeUnwritable(factory, "connection_gone")).toMatch(/removed/i);
    expect(describeUnwritable(factory, "connection_suspended")).toMatch(
      /suspended/i,
    );
  });

  // #756-T08
  it("says a task with this form was already started when the request id was used for another task", () => {
    expect(
      describeImplementerFailure(factory, {
        code: "IMPLEMENTER_REQUEST_REUSED",
      }),
    ).toMatch(/already started/i);
  });
});
