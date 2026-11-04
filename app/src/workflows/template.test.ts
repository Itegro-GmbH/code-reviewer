// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import {
  isWholeReference,
  parseTemplate,
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
