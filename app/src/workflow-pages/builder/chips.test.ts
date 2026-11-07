// SPDX-License-Identifier: LicenseRef-Proprietary

// The chips of a text (#927): what is shown is a view; what is stored is the text as typed.
import { describe, expect, it } from "vitest";
import {
  chipsOf,
  partsOf,
  textOfParts,
  withReference,
  withoutChip,
} from "./chips.ts";

const SAMPLES = [
  "",
  "plain text",
  "{{trigger.ticket}}",
  "Fix {{trigger.ticket.title}}\n\n{{trigger.ticket.body}}",
  '{{ trigger.ticket.title }} and {{implement.summary|default "none"}}',
  '{{a.o | default {}}} then {{b.s | default "}}"}}',
  "escaped \\{{not.a.reference}} stays",
  "broken {{ open",
  "{{not a reference}} and {{ok.x}}",
  "  leading {{a.b}}  trailing  ",
  "{{a.b}}{{c.d}}",
  "emoji 😀 {{a.b}} 😀",
  "{{previous.review.findings | default []}}",
];

describe("parts and chips", () => {
  // #927-T31
  it("give back exactly the text that was typed, for every text", () => {
    for (const text of SAMPLES)
      expect(textOfParts(partsOf(text)), JSON.stringify(text)).toBe(text);
  });

  // #927-T32
  it("make a chip of each well formed reference, with its category and name, and leave the rest as text", () => {
    const chips = chipsOf(
      'Fix {{trigger.ticket.title}} with {{implement.summary}} {{previous.check.verdict | default ""}} {{failure.message}} {{trigger.input.reason}} {{trigger.id}}',
    );
    expect(chips.map((chip) => chip.label)).toEqual([
      "Ticket · title",
      "Steps before · implement.summary",
      "This loop · check.verdict",
      "Failure · message",
      "Trigger input · reason",
      "Lane and run · id",
    ]);
    expect(chips[2]?.hasDefault).toBe(true);
    expect(chips[0]?.hasDefault).toBe(false);
    expect(chipsOf("{{not a reference}} {{ open")).toEqual([]);
    expect(chipsOf("escaped \\{{a.b}}")).toEqual([]);
  });

  // #927-T33
  it("know where a chip sits, also after text with astral characters", () => {
    const text = "😀 {{a.b}} x";
    const [chip] = chipsOf(text);
    expect(text.slice(chip?.start, chip?.end)).toBe("{{a.b}}");
  });

  // #927-T34
  it("remove one chip and nothing else", () => {
    const text = "a {{x.y}} b {{x.z}} c";
    const [first, second] = chipsOf(text);
    expect(withoutChip(text, first!)).toBe("a  b {{x.z}} c");
    expect(withoutChip(text, second!)).toBe("a {{x.y}} b  c");
    expect(withoutChip("{{x.y}}", chipsOf("{{x.y}}")[0]!)).toBe("");
  });

  // #927-T35
  it("insert a reference where the cursor is, replace a selection, and put the cursor after it", () => {
    expect(withReference("ab", { start: 1, end: 1 }, "{{x.y}}")).toEqual({
      text: "a{{x.y}}b",
      caret: 8,
    });
    expect(withReference("abcd", { start: 1, end: 3 }, "{{x.y}}").text).toBe(
      "a{{x.y}}d",
    );
    expect(withReference("ab", { start: 99, end: 99 }, "{{x.y}}").text).toBe(
      "ab{{x.y}}",
    );
    expect(withReference("", { start: 0, end: 0 }, "{{x.y}}").text).toBe(
      "{{x.y}}",
    );
  });

  // #927-T36
  it("make the reference the whole text in a field that takes one value", () => {
    expect(
      withReference("main", { start: 1, end: 2 }, "{{trigger.ticket}}", true),
    ).toEqual({ text: "{{trigger.ticket}}", caret: 18 });
  });
});
