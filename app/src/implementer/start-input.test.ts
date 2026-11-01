// SPDX-License-Identifier: LicenseRef-Proprietary

// The body that starts an Implementer task (#755). It comes from the browser, so nothing is trusted: every field is looked at as
// `unknown`, and a refusal names the field and a value-free code.
import { describe, expect, it } from "vitest";
import {
  INSTRUCTION_MAX_LENGTH,
  validateStartInput,
  type StartInput,
} from "./start-input.ts";

const VALID = {
  repositoryId: "repo-1",
  baseBranch: "main",
  branch: "implementer/abc123",
  instruction: "Add a health endpoint.",
  model: { entryId: "entry-1" },
  clientRequestId: "req-1",
};

const parsed: StartInput = {
  repositoryId: "repo-1",
  baseBranch: "main",
  branch: "implementer/abc123",
  instruction: "Add a health endpoint.",
  model: { entryId: "entry-1" },
  costLimitCents: null,
  clientRequestId: "req-1",
};

function issuesOf(body: unknown) {
  const checked = validateStartInput(body);
  if (checked.ok) throw new Error("expected issues");
  return checked.issues;
}

describe("the body that starts a task", () => {
  it("takes a complete body, with no cost limit as null", () => {
    expect(validateStartInput(VALID)).toEqual({ ok: true, value: parsed });
  });

  it("takes both shapes of the model and a cost limit", () => {
    expect(
      validateStartInput({
        ...VALID,
        model: { provider: "anthropic", model: "claude-sonnet-5-5" },
        costLimitCents: 250,
      }),
    ).toEqual({
      ok: true,
      value: {
        ...parsed,
        model: { provider: "anthropic", model: "claude-sonnet-5-5" },
        costLimitCents: 250,
      },
    });
    expect(validateStartInput({ ...VALID, costLimitCents: null })).toEqual({
      ok: true,
      value: parsed,
    });
  });

  it("keeps the instruction as written, line breaks and tabs included", () => {
    const instruction = "  Fix it.\n\n\tThen test it.\r\n";
    const checked = validateStartInput({ ...VALID, instruction });
    expect(checked).toMatchObject({ ok: true, value: { instruction } });
  });

  it("does not let a field that is not part of the body through", () => {
    const checked = validateStartInput({
      ...VALID,
      workspaceId: "other",
      createdBy: "x",
    });
    expect(checked).toEqual({ ok: true, value: parsed });
  });

  // #755-T06
  it.each([null, undefined, 7, "text", []])(
    "refuses %j as the body, naming the fields that are required",
    (body) => {
      expect(issuesOf(body).map((issue) => issue.field)).toEqual([
        "repositoryId",
        "baseBranch",
        "branch",
        "instruction",
        "model",
        "clientRequestId",
      ]);
    },
  );

  // #755-T06
  it.each([
    ["", "required"],
    ["   ", "required"],
    ["\n\t ", "required"],
    ["x".repeat(INSTRUCTION_MAX_LENGTH + 1), "too_long"],
    ["bell\u0007here", "invalid"],
    ["nul\u0000here", "invalid"],
    ["escape\u001b[31m", "invalid"],
    ["del\u007f", "invalid"],
    ["lone \ud800 surrogate", "invalid"],
    [42, "invalid"],
  ])("refuses the instruction %j: %s", (instruction, code) => {
    expect(issuesOf({ ...VALID, instruction })).toEqual([
      { field: "instruction", code },
    ]);
  });

  // #755-T06
  it("takes an instruction of exactly the longest length", () => {
    const instruction = "x".repeat(INSTRUCTION_MAX_LENGTH);
    expect(validateStartInput({ ...VALID, instruction })).toMatchObject({
      ok: true,
    });
  });

  // #755-T06
  it.each([
    [undefined, "required"],
    [null, "required"],
    [{}, "invalid"],
    ["entry-1", "invalid"],
    [{ entryId: "" }, "invalid"],
    [{ entryId: 7 }, "invalid"],
    [{ provider: "anthropic" }, "invalid"],
    [{ model: "claude" }, "invalid"],
    [{ provider: "", model: "m" }, "invalid"],
    [{ entryId: "e", provider: "p", model: "m" }, "invalid"],
    [{ entryId: "e", extra: 1 }, "invalid"],
    [{ entryId: "x".repeat(201) }, "invalid"],
    [["entry-1"], "invalid"],
    // #791: Postgres refuses a NUL in text, and the model fields reach queries.
    [{ entryId: "a\u0000b" }, "invalid"],
    [{ provider: "p\u0000", model: "m" }, "invalid"],
    [{ provider: "p", model: "\u0000m" }, "invalid"],
    [{ entryId: "tab\there" }, "invalid"],
  ])("refuses the model %j: %s", (model, code) => {
    expect(issuesOf({ ...VALID, model })).toEqual([{ field: "model", code }]);
  });

  // #755-T12
  it.each([0, -1, 1.5, Number.NaN, 10_001, "100", true, Infinity])(
    "refuses the cost limit %j",
    (costLimitCents) => {
      expect(issuesOf({ ...VALID, costLimitCents })).toEqual([
        { field: "costLimitCents", code: "invalid" },
      ]);
    },
  );

  it.each([1, 10_000])("takes the cost limit %j", (costLimitCents) => {
    expect(validateStartInput({ ...VALID, costLimitCents })).toMatchObject({
      ok: true,
      value: { costLimitCents },
    });
  });

  it.each([
    ["", "required"],
    ["has space", "invalid"],
    ["tab\t", "invalid"],
    ["ünï", "invalid"],
    ["x".repeat(201), "too_long"],
    [5, "invalid"],
  ])("refuses the client request id %j: %s", (clientRequestId, code) => {
    expect(issuesOf({ ...VALID, clientRequestId })).toEqual([
      { field: "clientRequestId", code },
    ]);
  });

  it.each([
    ["", "required"],
    ["  ", "required"],
    ["x".repeat(129), "invalid"],
    [7, "invalid"],
  ])("refuses the repository id %j: %s", (repositoryId, code) => {
    expect(issuesOf({ ...VALID, repositoryId })).toEqual([
      { field: "repositoryId", code },
    ]);
  });

  // #755-T04, #755-T05
  it("names the rule a new branch breaks, as the code of the issue", () => {
    expect(issuesOf({ ...VALID, branch: "a..b" })).toEqual([
      { field: "branch", code: "double_dot" },
    ]);
    expect(issuesOf({ ...VALID, branch: "main" })).toEqual([
      { field: "branch", code: "same_as_base" },
    ]);
    expect(issuesOf({ ...VALID, branch: "" })).toEqual([
      { field: "branch", code: "required" },
    ]);
    expect(issuesOf({ ...VALID, branch: 7 })).toEqual([
      { field: "branch", code: "invalid" },
    ]);
  });

  // #755-T04
  it("refuses a base branch that is not usable as a branch name, without the rules of a new one", () => {
    expect(issuesOf({ ...VALID, baseBranch: "" })).toEqual([
      { field: "baseBranch", code: "required" },
    ]);
    expect(issuesOf({ ...VALID, baseBranch: "bad name" })).toEqual([
      { field: "baseBranch", code: "invalid" },
    ]);
    expect(
      validateStartInput({ ...VALID, baseBranch: "release/1.0" }),
    ).toMatchObject({ ok: true });
  });

  it("reports every field that is wrong, in the order of the body", () => {
    expect(
      issuesOf({
        ...VALID,
        repositoryId: "",
        branch: "a b",
        instruction: " ",
        costLimitCents: 0,
      }).map((issue) => issue.field),
    ).toEqual(["repositoryId", "branch", "instruction", "costLimitCents"]);
  });
});
