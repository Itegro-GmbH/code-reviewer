// SPDX-License-Identifier: LicenseRef-Proprietary

// The stored form of the model a turn was started with (#751): exactly two shapes, and stored text that is not one of
// them is a typed error, never a crash and never a guess.
import { describe, expect, it } from "vitest";
import {
  decodeModelChoice,
  encodeModelChoice,
} from "./implementer-model-choice.ts";
import { ImplementerStoreError } from "./implementer-errors.ts";

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof ImplementerStoreError) return error.code;
    throw error;
  }
  return undefined;
}

describe("the model choice of a turn", () => {
  // #751-T06
  it("round-trips an entry id", () => {
    const text = encodeModelChoice({ entryId: "entry-1" });
    expect(text).toBe('{"entryId":"entry-1"}');
    expect(decodeModelChoice(text)).toEqual({ entryId: "entry-1" });
  });

  // #751-T06
  it("round-trips a provider and a model", () => {
    const text = encodeModelChoice({ provider: "anthropic", model: "sonnet" });
    expect(text).toBe('{"provider":"anthropic","model":"sonnet"}');
    expect(decodeModelChoice(text)).toEqual({
      provider: "anthropic",
      model: "sonnet",
    });
  });

  // #751-T06
  it("writes only the known keys, in a fixed order, whatever the caller handed in", () => {
    const sloppy = { model: "m", provider: "p", extra: 1 } as {
      provider: string;
      model: string;
    };
    expect(encodeModelChoice(sloppy)).toBe('{"provider":"p","model":"m"}');
  });

  // #751-T06
  it.each([
    ["an empty object", "{}"],
    ["an entry id that is not text", '{"entryId":7}'],
    ["an empty entry id", '{"entryId":""}'],
    ["a provider without a model", '{"provider":"p"}'],
    ["a model without a provider", '{"model":"m"}'],
    ["an empty provider", '{"provider":"","model":"m"}'],
    ["both shapes at once", '{"entryId":"e","provider":"p","model":"m"}'],
    ["an unknown key beside an entry id", '{"entryId":"e","note":"x"}'],
    ["an unknown key beside a provider", '{"provider":"p","model":"m","x":1}'],
    ["an array", '["e"]'],
    ["a string", '"e"'],
    ["null", "null"],
    ["text that is not JSON", "{entryId:"],
    ["the empty text", ""],
  ])("refuses stored text that is %s with a typed error", (_label, text) => {
    expect(codeOf(() => decodeModelChoice(text))).toBe(
      "IMPLEMENTER_MODEL_CHOICE_UNREADABLE",
    );
  });

  // #751-T06
  it("refuses to encode a choice that is neither shape", () => {
    expect(codeOf(() => encodeModelChoice({ entryId: "" }))).toBe(
      "IMPLEMENTER_MODEL_CHOICE_INVALID",
    );
    expect(
      codeOf(() =>
        encodeModelChoice({ provider: "p" } as unknown as {
          provider: string;
          model: string;
        }),
      ),
    ).toBe("IMPLEMENTER_MODEL_CHOICE_INVALID");
  });
});
