// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import {
  isWholeReference,
  literalText,
  parseTemplate,
  REFERENCE_PATTERN,
  renderTemplate,
  renderValue,
} from "./template.ts";

describe("parseTemplate", () => {
  // #833-M1-T20
  it("splits text and references", () => {
    const parsed = parseTemplate(
      "Review {{implement.branch}} for #{{trigger.issue.number}}.",
    );

    expect(parsed.problems).toEqual([]);
    expect(parsed.parts).toEqual([
      { text: "Review " },
      { ref: { path: ["implement", "branch"], raw: "implement.branch" } },
      { text: " for #" },
      {
        ref: {
          path: ["trigger", "issue", "number"],
          raw: "trigger.issue.number",
        },
      },
      { text: "." },
    ]);
  });

  // #833-M1-T21
  it("reads a default as a JSON value after a pipe", () => {
    const parsed = parseTemplate(
      '{{previous.review.findings | default []}} {{a.b|default "none"}} {{a.c | default 3}}',
    );

    expect(parsed.problems).toEqual([]);
    const refs = parsed.parts.flatMap((part) =>
      "ref" in part ? [part.ref] : [],
    );
    expect(refs.map((ref) => ref.default)).toEqual([
      { value: [] },
      { value: "none" },
      { value: 3 },
    ]);
  });

  // #833-M1-T22
  it("tells a text without references from a whole reference", () => {
    expect(isWholeReference(parseTemplate("{{ trigger.issue }}"))).toBe(true);
    expect(isWholeReference(parseTemplate("x {{trigger.issue}}"))).toBe(false);
    expect(isWholeReference(parseTemplate("plain"))).toBe(false);
    expect(parseTemplate("plain").parts).toEqual([{ text: "plain" }]);
  });

  // #833-M1-T23
  it.each([
    ["{{ }}", /empty/i],
    ["{{a..b}}", /name/i],
    ["{{a.b[0]}}", /name/i],
    ["{{a b}}", /name/i],
    ["{{a.b", /never closed/i],
    ["{{a.b | upper}}", /default/i],
    ["{{a.b | default nope}}", /JSON/i],
    ["{{a.b | default}}", /JSON/i],
  ])("reports %s as a syntax problem", (text, message) => {
    const parsed = parseTemplate(text);

    expect(parsed.problems).toHaveLength(1);
    expect(parsed.problems[0]).toMatch(message);
  });

  // #833-M1-T24
  it("writes a literal {{ with a backslash", () => {
    const parsed = parseTemplate("use \\{{name}} here");

    expect(parsed.problems).toEqual([]);
    expect(parsed.parts).toEqual([{ text: "use {{name}} here" }]);
  });
});

describe("a default that holds braces and quotes", () => {
  const defaultOf = (text: string): unknown => {
    const parsed = parseTemplate(text);
    expect(parsed.problems).toEqual([]);
    expect(parsed.parts).toHaveLength(1);
    const part = parsed.parts[0] as { ref: { default?: { value: unknown } } };
    return part.ref.default?.value;
  };

  // #833-M1-T270
  it("reads {} and an object as the default, although they end in }}", () => {
    expect(defaultOf("{{a.o | default {}}}")).toEqual({});
    expect(defaultOf('{{a.o | default {"k": {"j": 1}}}}')).toEqual({
      k: { j: 1 },
    });
    expect(defaultOf('{{a.o | default [{"k": 1}]}}')).toEqual([{ k: 1 }]);
  });

  // #833-M1-T271
  it("reads a default text that holds }} or a brace or an escaped quote", () => {
    expect(defaultOf('{{a.o | default "}}"}}')).toBe("}}");
    expect(defaultOf('{{a.o | default "{{"}}')).toBe("{{");
    expect(defaultOf('{{a.o | default "a\\"}}"}}')).toBe('a"}}');
    expect(defaultOf('{{a.o | default {"k": "}}"}}}')).toEqual({ k: "}}" });
  });

  // #833-M1-T272
  it("finds the text around such a reference", () => {
    const parsed = parseTemplate('x {{a.o | default {}}} y {{b.c}} "}}"');

    expect(parsed.problems).toEqual([]);
    expect(
      parsed.parts.map((part) => ("text" in part ? part.text : "ref")),
    ).toEqual(["x ", "ref", " y ", "ref", ' "}}"']);
  });

  // #833-M1-T273
  it.each([
    ["{{a.o | default {}", /never closed/i],
    ['{{a.o | default "}}', /never closed/i],
    ['{{a.o | default {"k": {"j": {"i": {"h": 1}}}}}}', /nest/i],
  ])("reports %s", (text, message) => {
    const parsed = parseTemplate(text);

    expect(parsed.problems).toHaveLength(1);
    expect(parsed.problems[0]).toMatch(message);
  });
});

describe("the shape of a whole reference", () => {
  const SHAPE = new RegExp(REFERENCE_PATTERN, "u");

  // #833-M1-T274
  it.each([
    ["{{a}}", true],
    ["{{ a.b }}", true],
    ["{{a.b | default {}}}", true],
    ['{{a.b | default "}}"}}', true],
    ['{{a.b | default {"k": {"j": 1}}}}', true],
    ["{{a}} {{b}}", false],
    ["{{a}}{{b}}", false],
    [" {{a}}", false],
    ["{{a}} ", false],
    ["{{a}}\n", false],
    ["x{{a}}", false],
    ["{{a", false],
    ["{{a}}}", false],
    ["\\{{a}}", false],
    ["plain", false],
  ])("%s holds exactly one reference: %s", (text, whole) => {
    expect(SHAPE.test(text)).toBe(whole);
    const parsed = parseTemplate(text);
    if (parsed.problems.length === 0)
      expect(isWholeReference(parsed)).toBe(whole);
  });

  // #833-M1-T275
  it("is not slow on a long text of almost-references", () => {
    const started = Date.now();

    for (const text of [
      `{{${'"'.repeat(15_000)}`,
      `{{a | default ${"{".repeat(5_000)}`,
      `${"{{a}} ".repeat(3_000)}x`,
      `{{${"a}}".repeat(5_000)}`,
    ])
      SHAPE.test(text);

    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("literalText", () => {
  // #833-M1-T276
  it("is the text with the escapes undone when there is no reference, otherwise nothing", () => {
    expect(literalText(parseTemplate("main"))).toBe("main");
    expect(literalText(parseTemplate("use \\{{name}}"))).toBe("use {{name}}");
    expect(literalText(parseTemplate(""))).toBe("");
    expect(literalText(parseTemplate("a {{b.c}}"))).toBeUndefined();
    expect(literalText(parseTemplate("{{a"))).toBeUndefined();
  });
});

describe("renderValue", () => {
  // #833-M1-T25
  it("renders scalars as text and a list one entry per line", () => {
    expect(renderValue("a")).toBe("a");
    expect(renderValue(3)).toBe("3");
    expect(renderValue(true)).toBe("true");
    expect(renderValue(["x", "y"])).toBe("- x\n- y");
    expect(renderValue([])).toBe("");
    expect(renderValue([{ type: "bug", name: "Lease" }])).toBe(
      '- {"type":"bug","name":"Lease"}',
    );
  });
});

describe("renderTemplate", () => {
  // #833-M1-T26
  it("renders a template with the values of its references", () => {
    const parsed = parseTemplate(
      "Fix:\n{{previous.review.findings}}\nbranch {{implement.branch}}",
    );

    expect(
      renderTemplate(parsed, (path) =>
        path[0] === "implement" ? "fix-1" : ["a", "b"],
      ),
    ).toBe("Fix:\n- a\n- b\nbranch fix-1");
  });
});
