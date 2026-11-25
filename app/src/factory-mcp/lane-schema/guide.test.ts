// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateWorkflow } from "../../workflows/validate.ts";
import { createResolver } from "../../workflows/resolver.ts";
import { FAKE_RESOLVER } from "../../workflows/test-fixtures.ts";
import { laneSchemaSection } from "./build.ts";
import {
  GENERATED_FILE,
  generateGuideData,
  renderGuideData,
} from "./generate.ts";
import { chapterMarkdown, slugOf, splitGuide } from "./guide.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");

describe("splitGuide", () => {
  const text = [
    "# Title",
    "",
    "Intro text.",
    "",
    "## One",
    "",
    "Lead of one.",
    "",
    "### Part A",
    "",
    "A text.",
    "",
    "```",
    "## not a heading",
    "```",
    "",
    "### Part A",
    "",
    "A again.",
    "",
    "## Two",
    "",
    "Only lead.",
  ].join("\n");

  // #1144-T150
  it("cuts at ## and ###, keeps the intro, and ignores headings inside a code fence", () => {
    const guide = splitGuide(text);
    expect(guide.intro).toBe("# Title\n\nIntro text.");
    expect(guide.sections.map((s) => s.id)).toEqual(["one", "two"]);
    expect(guide.sections[0]?.children.map((c) => c.id)).toEqual([
      "part-a",
      "part-a-2",
    ]);
    expect(guide.sections[0]?.children[0]?.markdown).toContain(
      "## not a heading",
    );
  });

  // #1144-T151
  it("loses nothing: the chapters put together are the document", () => {
    const guide = splitGuide(text);
    const rebuilt = [guide.intro, ...guide.sections.map(chapterMarkdown)].join(
      "\n\n",
    );
    expect(rebuilt.replace(/\n{2,}/g, "\n").trim()).toBe(
      text.replace(/\n{2,}/g, "\n").trim(),
    );
  });

  // #1144-T152
  it("makes slugs of headings", () => {
    expect(slugOf('The agent step (`"kind": "agent"`)')).toBe(
      "the-agent-step-kind-agent",
    );
    expect(slugOf("Results & facts")).toBe("results-facts");
  });
});

describe("the committed guide", () => {
  // #1144-T153
  it("is what the generator makes of docs/workflows.md and the contracts now (run pnpm lane-guide:generate)", () => {
    const committed = readFileSync(
      join(import.meta.dirname, GENERATED_FILE),
      "utf8",
    );
    expect(committed).toBe(renderGuideData(generateGuideData(ROOT)));
  });

  // #1144-T154
  it("holds every chapter of the document, once", () => {
    const docs = readFileSync(join(ROOT, "docs", "workflows.md"), "utf8");
    const headings = [...docs.matchAll(/^## (.+)$/gm)].map((match) =>
      slugOf(match[1] as string),
    );
    const guide = splitGuide(docs);
    expect(guide.sections.map((s) => s.id)).toEqual(headings);
    expect(new Set(headings).size).toBe(headings.length);
  });

  // #1144-T155
  it("hands out an example that the validator accepts", () => {
    const example = laneSchemaSection("example");
    if (example === undefined || example.format !== "json")
      throw new Error("no example");
    const resolver = createResolver({
      environments: [{ name: "node" }],
      profiles: FAKE_RESOLVER.profiles(),
      runners: [
        {
          id: "runner-vercel-4-vcpu",
          name: "Vercel Sandbox 4 vCPU",
          kind: "hosted",
        },
      ],
    });
    expect(validateWorkflow(example.content, resolver).errors).toEqual([]);
  });
});
