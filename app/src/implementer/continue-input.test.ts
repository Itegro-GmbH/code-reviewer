// SPDX-License-Identifier: LicenseRef-Proprietary

// The body that continues a session (#841): what is left out means "as the last turn", `null` means none.
import { describe, expect, it } from "vitest";
import { validateContinueInput } from "./continue-input.ts";

const base = { instruction: "Do more.", clientRequestId: "req-1" };

function issuesOf(body: unknown) {
  const checked = validateContinueInput(body);
  return checked.ok ? [] : checked.issues;
}

describe("the request id of a follow-up (#920)", () => {
  // #920-T184
  it.each(["wf-", "wf-run-1-0", "wf-run-1-0-q2"])(
    "refuses %j: the prefix is the engine's alone, so a follow-up cannot pass for a workflow step",
    (clientRequestId) => {
      expect(issuesOf({ ...base, clientRequestId })).toEqual([
        { field: "clientRequestId", code: "request_id_reserved" },
      ]);
      expect(
        validateContinueInput(
          { ...base, clientRequestId },
          { workflowStep: true },
        ),
      ).toMatchObject({ ok: true, value: { clientRequestId } });
    },
  );

  it("takes ids that only contain the prefix inside", () => {
    expect(issuesOf({ ...base, clientRequestId: "req-wf-1" })).toEqual([]);
  });
});

describe("the body of a follow-up", () => {
  // #841-V01
  it("accepts an instruction and a request id alone, and leaves every choice undefined", () => {
    const checked = validateContinueInput(base);

    expect(checked).toEqual({
      ok: true,
      value: {
        instruction: "Do more.",
        clientRequestId: "req-1",
        model: undefined,
        costLimitCents: undefined,
        environmentId: undefined,
        profile: undefined,
      },
    });
  });

  // #841-V02
  it("tells none (null) from left out", () => {
    const checked = validateContinueInput({
      ...base,
      costLimitCents: null,
      environmentId: null,
      profile: null,
    });

    expect(checked).toMatchObject({
      ok: true,
      value: { costLimitCents: null, environmentId: null, profile: null },
    });
  });

  // #841-V03
  it("reads the model in both shapes, a profile as name@version, and an environment id", () => {
    expect(
      validateContinueInput({ ...base, model: { entryId: "e1" } }),
    ).toMatchObject({ ok: true, value: { model: { entryId: "e1" } } });
    expect(
      validateContinueInput({
        ...base,
        model: { provider: "anthropic", model: "m" },
      }),
    ).toMatchObject({
      ok: true,
      value: { model: { provider: "anthropic", model: "m" } },
    });
    expect(
      validateContinueInput({
        ...base,
        profile: "reviewer@3",
        environmentId: "env-1",
      }),
    ).toMatchObject({
      ok: true,
      value: {
        profile: { name: "reviewer", version: 3 },
        environmentId: "env-1",
      },
    });
    expect(
      validateContinueInput({ ...base, profile: "reviewer" }),
    ).toMatchObject({
      ok: true,
      value: { profile: { name: "reviewer", version: null } },
    });
  });

  // #841-V04
  it("names the field and a code for each unusable value, never the value", () => {
    expect(issuesOf({ clientRequestId: "r" })).toEqual([
      { field: "instruction", code: "required" },
    ]);
    expect(issuesOf({ ...base, instruction: "  " })).toEqual([
      { field: "instruction", code: "required" },
    ]);
    expect(issuesOf({ ...base, instruction: "x".repeat(20_001) })).toEqual([
      { field: "instruction", code: "too_long" },
    ]);
    expect(issuesOf({ ...base, instruction: "a\u0000b" })).toEqual([
      { field: "instruction", code: "invalid" },
    ]);
    expect(issuesOf({ instruction: "x" })).toEqual([
      { field: "clientRequestId", code: "required" },
    ]);
    expect(issuesOf({ ...base, clientRequestId: "a b" })).toEqual([
      { field: "clientRequestId", code: "invalid" },
    ]);
    expect(issuesOf({ ...base, model: "gpt" })).toEqual([
      { field: "model", code: "invalid" },
    ]);
    expect(issuesOf({ ...base, costLimitCents: 0 })).toEqual([
      { field: "costLimitCents", code: "invalid" },
    ]);
    expect(issuesOf({ ...base, costLimitCents: 1.5 })).toEqual([
      { field: "costLimitCents", code: "invalid" },
    ]);
    expect(issuesOf({ ...base, environmentId: 7 })).toEqual([
      { field: "environmentId", code: "invalid" },
    ]);
    expect(issuesOf({ ...base, environmentId: "" })).toEqual([
      { field: "environmentId", code: "required" },
    ]);
    expect(issuesOf({ ...base, profile: 5 })).toEqual([
      { field: "profile", code: "invalid" },
    ]);
    expect(issuesOf({ ...base, profile: "" })).toEqual([
      { field: "profile", code: "required" },
    ]);
  });

  // #841-V05: the version of a profile brings the model and the cost limit
  it("refuses a model or a cost limit next to a profile", () => {
    expect(
      issuesOf({
        ...base,
        profile: "p@1",
        model: { entryId: "e" },
        costLimitCents: 100,
      }),
    ).toEqual([
      { field: "model", code: "not_with_profile" },
      { field: "costLimitCents", code: "not_with_profile" },
    ]);
  });

  // #841-V06
  it("treats a body that is no object as a body without fields", () => {
    expect(issuesOf(null).map((i) => i.field)).toEqual([
      "instruction",
      "clientRequestId",
    ]);
    expect(issuesOf([base]).map((i) => i.field)).toEqual([
      "instruction",
      "clientRequestId",
    ]);
  });
});
