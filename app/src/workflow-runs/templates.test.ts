// SPDX-License-Identifier: LicenseRef-Proprietary

// #844: the references of a workflow at run time. Values are data: one pass, nothing read again, bounded, and a value that is missing
// fails the step with the path.
import { describe, expect, it } from "vitest";
import { cleanBody, cleanTitle } from "./github-connectors.ts";
import { TEMPLATE_VALUE_MAX_CHARS } from "./limits.ts";
import {
  cleanText,
  defuseMentions,
  defuseSegments,
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

  // #844-T310
  it("defuses what an agent step reported where the text goes to an action, and leaves literals and trigger values alone", () => {
    const run: RunValues = {
      trigger: {
        input: { who: "@alice please look", issue: "acme/api#4", n: 9 },
      },
      steps: {
        review: {
          summary:
            "ping @bob and @acme/reviewers, see acme/api#12, #13 and https://github.com/acme/api/issues/14. Closes #15. mail a@b.org",
        },
        open: { number: 3 },
      },
      agentSteps: new Set(["review"]),
    };
    const text =
      "Closes #{{trigger.input.n}} @carol {{trigger.input.who}} {{trigger.input.issue}} #{{open.number}}: {{review.summary}}";

    expect(renderText(text, run, undefined, { defuse: true })).toBe(
      "Closes #9 @carol @alice please look acme/api#4 #3: ping @\u200bbob and @\u200bacme/reviewers, see acme/api#\u200b12, #\u200b13 and https://github.com/acme/api/issues/\u200b14. Closes #\u200b15. mail a@b.org",
    );
    // Not an action: the instruction of an agent is rendered as it is.
    expect(renderText("{{review.summary}}", run)).toContain("@bob");
    expect(renderText("{{review.summary}}", run)).not.toContain("\u200b");
    // The same step id without the mark of an agent step (a value of the trigger, a step that is not an agent's) stays as it is.
    expect(
      renderText("{{open.number}}", run, undefined, { defuse: true }),
    ).toBe("3");
  });

  // #845-T30
  it("defuses the title, the body and the labels of the issue of a label trigger in the text of an action, and leaves the rest of the trigger alone", () => {
    const run: RunValues = {
      trigger: {
        issue: {
          number: 12,
          title: "ping @acme/security, fixes #99",
          body: "cc @bob\nCloses #98 and acme/api#97",
          url: "https://github.com/acme/api/issues/12",
          labels: ["@carol", "bug"],
        },
        repo: {
          fullName: "acme/api",
          owner: "acme",
          name: "api",
          defaultBranch: "main",
        },
      },
      steps: {},
    };
    const text =
      "Closes #{{trigger.issue.number}} in {{trigger.repo.fullName}} ({{trigger.issue.url}}): {{trigger.issue.title}} / {{trigger.issue.body}} / {{trigger.issue.labels}}";

    expect(renderText(text, run, undefined, { defuse: true })).toBe(
      "Closes #12 in acme/api (https://github.com/acme/api/issues/12): ping @\u200bacme/security, fixes #\u200b99 / cc @\u200bbob\nCloses #\u200b98 and acme/api#\u200b97 / - @\u200bcarol\n- bug",
    );
    // The instruction of an agent is the issue as it is: the agent is meant to read it.
    expect(renderText("{{trigger.issue.title}}", run)).toBe(
      "ping @acme/security, fixes #99",
    );
    // A manual input has its own place and is the caller's word: it stays raw, whatever it is called.
    const manual: RunValues = {
      trigger: { input: { title: "@alice", body: "#4" } },
      steps: {},
    };
    expect(
      renderText(
        "{{trigger.input.title}} {{trigger.input.body}}",
        manual,
        undefined,
        {
          defuse: true,
        },
      ),
    ).toBe("@alice #4");
  });

  // #844-T311
  it("defuses a list and a whole reference of an agent step, and text only (the type of a number or a list is not touched)", () => {
    const run: RunValues = {
      trigger: { input: {} },
      steps: { review: { items: ["@bob", "#4"], count: 4 } },
      agentSteps: new Set(["review"]),
    };
    expect(
      renderText("{{review.items}}", run, undefined, { defuse: true }),
    ).toBe("- @\u200bbob\n- #\u200b4");
    expect(resolveValue("{{review.count}}", run, { defuse: true })).toBe(4);
    expect(resolveValue("{{review.items}}", run, { defuse: true })).toEqual([
      "@bob",
      "#4",
    ]);
  });

  // #844-T312
  it("keeps the text readable: a zero-width space only after @ and # of a reference and before the number of an issue address", () => {
    expect(defuseMentions("no mention here, 100% and a # alone, @ alone")).toBe(
      "no mention here, 100% and a # alone, @ alone",
    );
    expect(defuseMentions("@a #1").replaceAll("\u200b", "")).toBe("@a #1");
    expect(defuseMentions("https://github.com/o/r/pull/3")).toBe(
      "https://github.com/o/r/pull/\u200b3",
    );
  });

  // #844-T310b
  it("defuses what two parts form at their boundary, a literal before an agent value included; only literals and trigger values stay raw", () => {
    const run: RunValues = {
      trigger: { input: { n: 12, at: "@" } },
      steps: {
        a: { x: "@", y: "#", z: "GH-", w: "<!-" },
        b: { x: "octocat", y: "12", z: "7", w: "- x" },
        c: { name: "octocat" },
      },
      agentSteps: new Set(["a", "b", "c"]),
    };
    const render = (text: string) =>
      renderText(text, run, undefined, { defuse: true });
    expect(render("{{a.x}}{{b.x}}")).toBe("@\u200boctocat");
    expect(render("{{a.y}}{{b.y}}")).toBe("#\u200b12");
    expect(render("{{a.z}}{{b.z}}")).toBe("GH-\u200b7");
    expect(render("{{a.w}}{{b.w}}")).toBe("<!-\u200b- x");
    // A literal before an agent value.
    expect(render("@{{c.name}}")).toBe("@\u200boctocat");
    expect(render("Closes #{{b.y}}")).toBe("Closes #\u200b12");
    expect(render("see GH-{{b.z}}")).toBe("see GH-\u200b7");
    // A literal after an agent value.
    expect(render("{{a.x}}octocat")).toBe("@\u200boctocat");
    expect(render("{{a.y}}12")).toBe("#\u200b12");
    // A trigger value before an agent value is no excuse; trigger values and literals alone stay as they are.
    expect(render("{{trigger.input.at}}{{c.name}}")).toBe("@\u200boctocat");
    expect(
      render("Closes #{{trigger.input.n}} @carol {{trigger.input.at}}x"),
    ).toBe("Closes #12 @carol @x");
    // No pattern at the boundary, no space.
    expect(render("{{c.name}} {{b.y}}")).toBe("octocat 12");
  });

  // #844-T310c
  it("defuses GH- before a number, in any case, and leaves words that only end in it", () => {
    expect(defuseMentions("fixes GH-12, gh-3 and GH-x, ENGH-5, GH-")).toBe(
      "fixes GH-\u200b12, gh-\u200b3 and GH-x, ENGH-5, GH-",
    );
  });

  // #844-T310d
  it("makes @ and # as HTML entities harmless by writing their & as &amp;", () => {
    for (const entity of [
      "&#64;",
      "&#x40;",
      "&#X40;",
      "&#064;",
      "&commat;",
      "&COMMAT;",
      "&#35;",
      "&#x23;",
      "&num;",
    ])
      expect(defuseMentions(`${entity}bob`)).toBe(`&amp;${entity.slice(1)}bob`);
    // Other entities, and text that only looks alike, are not touched.
    expect(defuseMentions("&amp; &#65; &#123; &numbers; &commatx;")).toBe(
      "&amp; &#65; &#123; &numbers; &commatx;",
    );
    // The & and the rest of the entity may come from two parts.
    const run: RunValues = {
      trigger: { input: {} },
      steps: { a: { x: "&", y: "#64;" } },
      agentSteps: new Set(["a"]),
    };
    expect(
      renderText("{{a.x}}{{a.y}}bob", run, undefined, { defuse: true }),
    ).toBe("&amp;#64;bob");
  });

  // #844-T310e
  it("makes <!-- unable to rebuild the marker of a comment, also inside code", () => {
    expect(defuseMentions("a <!-- wf-r1-1 --> b")).toBe(
      "a <!-\u200b- wf-r1-1 --> b",
    );
    expect(defuseMentions("`<!-- wf-r1-1 -->`")).toBe(
      "`<!-\u200b- wf-r1-1 -->`",
    );
    expect(defuseMentions("<!-<!----")).toBe("<!-<!-\u200b---");
    // A literal of the workflow keeps its comment.
    expect(
      renderText(
        "<!-- note --> {{a.x}}",
        {
          trigger: { input: {} },
          steps: { a: { x: "ok" } },
          agentSteps: new Set(["a"]),
        },
        undefined,
        { defuse: true },
      ),
    ).toBe("<!-- note --> ok");
  });

  // #844-T310f
  it("leaves mails, colours, anchors and entities of legitimate text unchanged", () => {
    for (const text of [
      "john@example.com and a.b+c@d.org",
      // Colours with letters are written in two pieces here: the colour check of the repository reads every literal of one.
      `color: #000; background:${"#"}${"fff"}; border: 1px solid ${"#"}${"1a2b3c"}; #0 #00`,
      "[link](#2-section) and [other](#12)",
      "&#123; &#x1F600; &#9731;",
      "abc#12 and x1#2",
      "https://example.com/page#12 and https://github.com/acme/api#12",
      "a @ b, 100% # alone",
    ])
      expect(defuseMentions(text)).toBe(text);
    // What is a mention or a reference after a non-word character is defused: line start, space, brackets, quotes, punctuation.
    expect(
      defuseMentions('@a\n(@b) [@c] "@d" x,@e -@f #1\n(#2) [#3] "#4" x,#5 =#6'),
    ).toBe(
      '@\u200ba\n(@\u200bb) [@\u200bc] "@\u200bd" x,@\u200be -@\u200bf #\u200b1\n(#\u200b2) [#\u200b3] "#\u200b4" x,#\u200b5 =#\u200b6',
    );
    // An issue reference with a repository, with and without leading zeros; `-` and `.` after it do not hide it.
    expect(defuseMentions("o/r#12 a-b/c.d#7 #007 #12. #12-x")).toBe(
      "o/r#\u200b12 a-b/c.d#\u200b7 #\u200b007 #\u200b12. #\u200b12-x",
    );
    // A name starts with a letter, a digit, _ or -.
    expect(defuseMentions("@-x @_y @9 @ z @.")).toBe(
      "@\u200b-x @\u200b_y @\u200b9 @ z @.",
    );
  });

  // #844-T310g
  it("leaves fenced code and code spans alone, and treats an unclosed one as what GitHub treats it as", () => {
    const code = "```\n@bob #12\n```";
    expect(defuseMentions(`${code}\n@bob`)).toBe(`${code}\n@\u200bbob`);
    expect(defuseMentions("~~~sh\n@bob\n~~~~\n@bob")).toBe(
      "~~~sh\n@bob\n~~~~\n@\u200bbob",
    );
    expect(defuseMentions("run `@bob #12` and `` a ` @bob `` then @bob")).toBe(
      "run `@bob #12` and `` a ` @bob `` then @\u200bbob",
    );
    // A fence closed by a shorter run, or by another character, stays open; a fence that is never closed runs to the end.
    expect(defuseMentions("````\n```\n@bob")).toBe("````\n```\n@bob");
    expect(defuseMentions("```\n@bob\n~~~\n@bob")).toBe("```\n@bob\n~~~\n@bob");
    // Not code: a lone backtick, one escaped with a backslash, a span that a blank line cuts, a run of another length, indentation.
    expect(defuseMentions("a ` @bob")).toBe("a ` @\u200bbob");
    expect(defuseMentions("\\`@bob`")).toBe("\\`@\u200bbob`");
    expect(defuseMentions("`a\n\n@bob`")).toBe("`a\n\n@\u200bbob`");
    expect(defuseMentions("`` @bob `")).toBe("`` @\u200bbob `");
    expect(defuseMentions("    ```\n@bob\n    ```")).toBe(
      "    ```\n@\u200bbob\n    ```",
    );
    // A code span does not run across a list item, a quote, a heading or a table cell (GitHub shows the mention there).
    expect(defuseMentions("- `x\n- @bob `")).toBe("- `x\n- @\u200bbob `");
    expect(defuseMentions("`x\n> @bob `")).toBe("`x\n> @\u200bbob `");
    expect(defuseMentions("| `x | @bob ` |")).toBe("| `x | @\u200bbob ` |");
    expect(defuseMentions("`x\n# @bob `")).toBe("`x\n# @\u200bbob `");
    // An opening fence line may not hold a backtick in its info text: then it is a span, not a fence.
    expect(defuseMentions("```a`b\n@bob")).toBe("```a`b\n@\u200bbob");
    // A text that is no Markdown (a title) hides nothing in code.
    expect(
      defuseSegments([{ text: "`@bob` ```\n@bob", agent: true }], {
        plain: true,
      }),
    ).toBe("`@\u200bbob` ```\n@\u200bbob");
  });

  // #844-T310h
  it("does not let an agent value close the code of a literal to hide a mention, nor open code to hide the text after it", () => {
    const run: RunValues = {
      trigger: { input: {} },
      steps: { a: { x: "x` @bob `y", y: "```\n@bob" } },
      agentSteps: new Set(["a"]),
    };
    expect(renderText("run `{{a.x}}`", run, undefined, { defuse: true })).toBe(
      "run `x` @\u200bbob `y`",
    );
    // The unclosed fence of an agent value hides what follows, as it does on GitHub: the literal text after it is no mention either way.
    expect(
      renderText("{{a.y}}\n@carol", run, undefined, { defuse: true }),
    ).toBe("```\n@bob\n@carol");
  });

  // #844-T310i
  it("uses the title mode of renderText without code left out", () => {
    const run: RunValues = {
      trigger: { input: {} },
      steps: { a: { x: "`@bob`" } },
      agentSteps: new Set(["a"]),
    };
    expect(
      renderText("{{a.x}}", run, undefined, { defuse: true, plain: true }),
    ).toBe("`@\u200bbob`");
    expect(renderText("{{a.x}}", run, undefined, { defuse: true })).toBe(
      "`@bob`",
    );
  });

  // #844-T310j
  it("counts the length of the text after it is defused, and cuts the value before", () => {
    const run: RunValues = {
      trigger: { input: {} },
      steps: { a: { x: "@a".repeat(6) } },
      agentSteps: new Set(["a"]),
    };
    expect(renderText("{{a.x}}", run, 12, { defuse: false })).toHaveLength(12);
    expect(
      failure(() => renderText("{{a.x}}", run, 12, { defuse: true })).code,
    ).toBe("template_too_large");
  });
  // #844-T310k
  it("takes direction marks and control characters out before it defuses, so cleaning the result changes nothing and rebuilds nothing", () => {
    const marks = [
      "\u200e",
      "\u200f",
      "\u061c",
      ..."\u202a\u202b\u202c\u202d\u202e",
      ..."\u2066\u2067\u2068\u2069",
      "\u0001",
      "\u007f",
    ];
    for (const mark of marks) {
      for (const [text, pattern] of [
        [`@${mark}user`, /@(?!\u200b)[A-Za-z]/],
        [`Closes #${mark}1`, /#(?!\u200b)[0-9]/],
        [`GH-${mark}1`, /GH-(?!\u200b)[0-9]/],
        [`<!-${mark}- x -->`, /<!--/],
      ] as const) {
        const defused = defuseMentions(text);
        expect(defused).toBe(cleanText(defused));
        expect(cleanBody(defused, "body")).toBe(defused);
        expect(cleanBody(defused, "body")).not.toMatch(pattern);
        expect(cleanTitle(defused)).not.toMatch(pattern);
      }
    }
    // A literal of the workflow is cleaned as well once an agent part is in the text; a text without an agent part is not touched.
    const run: RunValues = {
      trigger: { input: {} },
      steps: { a: { x: "user" } },
      agentSteps: new Set(["a"]),
    };
    expect(renderText("@\u200e{{a.x}}", run, undefined, { defuse: true })).toBe(
      "@\u200buser",
    );
    expect(defuseSegments([{ text: "@\u200euser", agent: false }])).toBe(
      "@\u200euser",
    );
  });

  // #844-T310l
  it("defuses a mention or a reference that an underscore touches (emphasis around it), and still leaves a mail alone", () => {
    expect(defuseMentions("_@octocat_ __@octocat__ _#1_ _GH-1_")).toBe(
      "_@\u200boctocat_ __@\u200boctocat__ _#\u200b1_ _GH-\u200b1_",
    );
    expect(defuseMentions("snake_case, a_b#1 and octocat@example.com")).toBe(
      "snake_case, a_b#1 and octocat@example.com",
    );
    // A name or a number that goes on with a letter is still none.
    expect(defuseMentions("#1a and x@octocat")).toBe("#1a and x@octocat");
  });

  // #844-T310m
  it("leaves no code out of the defusing where the text holds HTML, and keeps leaving it out where it does not", () => {
    for (const text of [
      '<span title="`">@octocat</span> <span title="`">',
      '<a href="`">x</a> @octocat <a href="`">y</a>',
      "<div>\n```\n@octocat\n```",
      "<!--\n```\n-->\n@octocat",
      "</p> ```\n@octocat\n```",
    ])
      expect(defuseMentions(text)).toContain("@\u200boctocat");
    // The HTML of a part that is no agent's is HTML in the text as well.
    const run: RunValues = {
      trigger: { input: {} },
      steps: { a: { x: "```\n@octocat\n```" } },
      agentSteps: new Set(["a"]),
    };
    expect(renderText("<b>{{a.x}}", run, undefined, { defuse: true })).toBe(
      "<b>```\n@\u200boctocat\n```",
    );
    // No HTML: a `<` before a space, a digit or the end is none, and the code stays left out.
    expect(defuseMentions("a < b, 1<2, x<\n```\n@octocat\n```")).toBe(
      "a < b, 1<2, x<\n```\n@octocat\n```",
    );
  });

  // #844-T310n
  it("defuses a match as soon as its range touches a part an agent wrote, not only where the space goes", () => {
    const run: RunValues = {
      trigger: { input: { n: 12 } },
      steps: {
        a: {
          name: "cat",
          number: "2",
          head: "<!",
          dash: "-",
          repo: "acme/api",
          tail: "4;",
        },
      },
      agentSteps: new Set(["a"]),
    };
    const render = (text: string) =>
      renderText(text, run, undefined, { defuse: true });
    expect(render("cc @octo{{a.name}}")).toBe("cc @\u200boctocat");
    expect(render("Closes #1{{a.number}}")).toBe("Closes #\u200b12");
    expect(render("GH-1{{a.number}}")).toBe("GH-\u200b12");
    expect(render("see /issues/1{{a.number}}")).toBe("see /issues/\u200b12");
    expect(render("{{a.repo}}#1{{a.number}}")).toBe("acme/api#\u200b12");
    expect(render("{{a.head}}--")).toBe("<!-\u200b-");
    expect(render("<!-{{a.dash}}")).toBe("<!-\u200b-");
    expect(render("&#6{{a.tail}}bob")).toBe("&amp;#64;bob");
    // Literals and trigger values that touch no agent part stay raw.
    expect(render("Closes #{{trigger.input.n}}")).toBe("Closes #12");
    expect(render("cc @octocat and Closes #1 {{a.name}}")).toBe(
      "cc @octocat and Closes #1 cat",
    );
  });
});

describe("previous.* in a loop", () => {
  const round2: RunValues = {
    ...values,
    steps: {
      ...values.steps,
      review: { findings: ["@octocat closes #5"], note: "second" },
    },
    previous: { review: { findings: ["@acme/team see #12"], note: "first" } },
    agentSteps: new Set(["review"]),
  };

  // #846-T60
  it("reads the value a step of the loop body had in the round before, apart from the latest", () => {
    expect(
      renderText("{{previous.review.note}} then {{review.note}}", round2),
    ).toBe("first then second");
    expect(resolveValue("{{previous.review.findings}}", round2)).toEqual([
      "@acme/team see #12",
    ]);
  });

  // #846-T61
  it("has nothing in round one and outside a loop: a default applies, and without one the step fails with the path", () => {
    expect(
      renderText('{{previous.review.note | default "none"}}', values),
    ).toBe("none");
    const missing = failure(() =>
      renderText("{{previous.review.note}}", values),
    );
    expect(missing.code).toBe("template_missing_value");
    expect(missing.message).toContain("previous.review.note");
    expect(
      failure(() =>
        renderText("{{previous.work.summary}}", { ...round2, previous: {} }),
      ).code,
    ).toBe("template_missing_value");
  });

  // #846-T62
  it("treats what an agent wrote in the round before as an agent's text: defused in the text of an action", () => {
    expect(
      renderText("Open: {{previous.review.findings}}", round2, 1000, {
        defuse: true,
      }),
    ).toBe("Open: - @\u200bacme/team see #\u200b12");
  });

  // #846-T63
  it("does not fall back to the latest value of the step when the round before has none", () => {
    expect(
      renderText('{{previous.work.summary | default "none"}}', {
        ...values,
        previous: {},
      }),
    ).toBe("none");
  });
});
