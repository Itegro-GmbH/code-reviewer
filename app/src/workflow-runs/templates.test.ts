// SPDX-License-Identifier: LicenseRef-Proprietary

// #844: the references of a workflow at run time. Values are data: one pass, nothing read again, bounded, and a value that is missing
// fails the step with the path.
import { describe, expect, it } from "vitest";
import { TEMPLATE_VALUE_MAX_CHARS } from "./limits.ts";
import {
  cleanText,
  renderText,
  resolveValue,
  TemplateError,
  type RunValues,
} from "./templates.ts";

const values: RunValues = {
  trigger: { input: { repo: "acme/api", issueNo: 7, labels: ["a", "b"] } },
  steps: {
    work: {
      summary: "Done.",
      branch: "workflow/r1/work",
      commits: ["a".repeat(40), "b".repeat(40)],
      costUsd: 0.5,
      pushed: true,
      nested: { deep: 1 },
    },
  },
};

function failure(run: () => unknown): TemplateError {
  try {
    run();
  } catch (error) {
    if (error instanceof TemplateError) return error;
    throw error;
  }
  throw new Error("expected a TemplateError");
}

describe("workflow templates at run time", () => {
  // #844-T20
  it("renders trigger inputs and the fields and facts of earlier steps into a text", () => {
    expect(
      renderText(
        "Fix {{trigger.input.repo}} #{{trigger.input.issueNo}}: {{work.summary}} on {{work.branch}} ({{work.costUsd}} USD, pushed {{work.pushed}})",
        values,
      ),
    ).toBe("Fix acme/api #7: Done. on workflow/r1/work (0.5 USD, pushed true)");
  });

  // #844-T21
  it("renders a list one entry per line", () => {
    expect(renderText("{{work.commits}}", values)).toBe(
      `- ${"a".repeat(40)}\n- ${"b".repeat(40)}`,
    );
  });

  // #844-T22
  it("keeps the type of a text that is exactly one reference", () => {
    expect(resolveValue("{{trigger.input.issueNo}}", values)).toBe(7);
    expect(resolveValue("{{trigger.input.labels}}", values)).toEqual([
      "a",
      "b",
    ]);
    expect(resolveValue("{{work.pushed}}", values)).toBe(true);
    expect(resolveValue("#{{trigger.input.issueNo}}", values)).toBe("#7");
  });

  // #844-T23
  it("fails with the missing path when a value is not there and has no default", () => {
    const error = failure(() => renderText("{{work.nothing}}", values));
    expect(error.code).toBe("template_missing_value");
    expect(error.message).toContain("work.nothing");
    expect(failure(() => renderText("{{later.x}}", values)).code).toBe(
      "template_missing_value",
    );
    expect(
      failure(() => renderText("{{trigger.input.repo.x}}", values)).code,
    ).toBe("template_missing_value");
  });

  // #844-T24
  it("takes the default of a missing value as written and never expands a template inside it", () => {
    expect(renderText('{{work.nothing | default "none"}}', values)).toBe(
      "none",
    );
    expect(
      renderText('{{work.nothing | default "{{work.summary}}"}}', values),
    ).toBe("{{work.summary}}");
    expect(resolveValue("{{work.nothing | default []}}", values)).toEqual([]);
    // A default is for a missing value only.
    expect(renderText('{{work.summary | default "none"}}', values)).toBe(
      "Done.",
    );
  });

  // #844-T25
  it("does not read a value again: braces in a result stay text", () => {
    const hostile: RunValues = {
      trigger: { input: {} },
      steps: { work: { summary: "{{trigger.input.secret}} and \\{{x}}" } },
    };
    expect(renderText("S: {{work.summary}}", hostile)).toBe(
      "S: {{trigger.input.secret}} and \\{{x}}",
    );
  });

  // #844-T26
  it("cleans control characters out of an inserted value and keeps tabs and line breaks", () => {
    const dirty: RunValues = {
      trigger: { input: {} },
      steps: { work: { summary: "a\u0000b\u0007c\td\ne\ud800f" } },
    };
    expect(renderText("{{work.summary}}", dirty)).toBe("abc\td\ne�f");
    expect(cleanText("x\u001fy")).toBe("xy");
  });

  // #844-T27
  it("cuts a long value with a note that says so, and fails a text that is too long for its place", () => {
    const big: RunValues = {
      trigger: { input: {} },
      steps: { work: { summary: "x".repeat(TEMPLATE_VALUE_MAX_CHARS + 500) } },
    };
    const text = renderText("{{work.summary}}", big);
    expect(text).toContain("[cut: the value was 10500 characters long]");
    expect(text.startsWith("x".repeat(TEMPLATE_VALUE_MAX_CHARS))).toBe(true);
    const error = failure(() => renderText("{{work.summary}}", big, 100));
    expect(error.code).toBe("template_too_large");
  });

  // #844-T28
  it("refuses an object inside a text, and a text that is not well formed", () => {
    expect(failure(() => renderText("{{work.nested}}", values)).code).toBe(
      "template_invalid",
    );
    expect(failure(() => renderText("{{work.summary", values)).code).toBe(
      "template_invalid",
    );
  });

  // #844-T29
  it("passes a literal with an escaped brace through", () => {
    expect(renderText("a \\{{literal}} b", values)).toBe("a {{literal}} b");
  });
});
