// SPDX-License-Identifier: LicenseRef-Proprietary

// What a step can reach (#927): the picker's list is the validator's own scope at the node.
import { describe, expect, it } from "vitest";
import { placeOf, reachAt, sampleText, type ReachEntry } from "./reach.ts";
import { FAKE_RESOLVER } from "./test-fixtures.ts";
import { validateWorkflow } from "./validate.ts";

const names = (entries: readonly ReachEntry[]): string[] =>
  entries.map((entry) => entry.reference);

function lane(): Record<string, unknown> {
  return {
    version: 1,
    name: "Reach",
    triggers: [
      {
        id: "labeled",
        kind: "ticket.labeled",
        label: "go",
      },
    ],
    steps: [
      {
        id: "implement",
        kind: "agent",
        profile: "implementer@1",
        environment: "node",
        instruction: "Fix {{trigger.ticket.title}}",
        result: {
          type: "object",
          required: ["summary"],
          properties: {
            summary: { type: "string" },
            note: { type: "string" },
          },
        },
      },
      {
        id: "review",
        kind: "loop",
        maxRounds: 2,
        body: [
          {
            id: "check",
            kind: "agent",
            profile: "reviewer@1",
            environment: "node",
            instruction: {
              first: "Review {{implement.summary}}",
              next: "Again, {{previous.check.verdict}}",
            },
            result: {
              type: "object",
              required: ["verdict"],
              properties: { verdict: { type: "string" } },
            },
          },
          {
            id: "gate",
            kind: "if",
            when: { empty: "{{check.verdict}}" },
            then: [
              {
                id: "say",
                kind: "action",
                connector: "github.issue.comment",
                issue: "{{trigger.ticket}}",
                body: "ok",
              },
            ],
            else: [],
          },
        ],
        until: { equals: ["{{check.verdict}}", "ok"] },
      },
      {
        id: "tell",
        kind: "action",
        connector: "github.issue.comment",
        issue: "{{trigger.ticket}}",
        body: "done",
      },
    ],
    onFailure: [
      {
        id: "sorry",
        kind: "action",
        connector: "github.issue.comment",
        issue: "{{trigger.ticket}}",
        body: "{{failure.message}}",
      },
    ],
  };
}

describe("placeOf", () => {
  // #927-T01
  it("finds the node a pointer is in and the places that read their own scope", () => {
    expect(placeOf("/steps/1")).toEqual({
      wanted: "/steps/1",
      node: "/steps/1",
      previousOk: false,
    });
    expect(placeOf("/steps/1/body/0/instruction/next")).toEqual({
      wanted: "/steps/1/body/0",
      node: "/steps/1/body/0",
      previousOk: true,
    });
    expect(placeOf("/steps/1/until/equals/0")).toEqual({
      wanted: "/steps/1/until",
      node: "/steps/1",
      previousOk: false,
    });
    expect(placeOf("/triggers/0/steps/2/then/0")?.node).toBe(
      "/triggers/0/steps/2/then/0",
    );
    expect(placeOf("/onFailure/0")?.node).toBe("/onFailure/0");
    expect(placeOf("/triggers/0")).toBeUndefined();
    expect(placeOf("steps/0")).toBeUndefined();
    expect(placeOf("")).toBeUndefined();
  });
});

describe("reachAt", () => {
  // #927-T02
  it("offers the trigger facts and the steps that ran before, not the step itself or later ones", () => {
    const reach = reachAt(lane(), FAKE_RESOLVER, "/steps/1");
    const found = names(reach?.entries ?? []);
    expect(found).toContain("trigger.ticket.title");
    expect(found).toContain("trigger.ticket");
    expect(found).toContain("implement.summary");
    expect(found).toContain("implement.costUsd");
    expect(found).not.toContain("review.exit");
    expect(found).not.toContain("tell.number");
    expect(found.some((name) => name.startsWith("failure."))).toBe(false);
    expect(found.some((name) => name.startsWith("previous."))).toBe(false);
    expect(reach?.at).toBe("/steps/1");
  });

  // #927-T03
  it("offers previous.* only inside a loop body, and the body's earlier steps there", () => {
    const outside = reachAt(lane(), FAKE_RESOLVER, "/steps/2");
    expect(
      names(outside?.entries ?? []).some((n) => n.startsWith("previous.")),
    ).toBe(false);
    const inside = reachAt(lane(), FAKE_RESOLVER, "/steps/1/body/1");
    const found = names(inside?.entries ?? []);
    expect(found).toContain("check.verdict");
    expect(found).toContain("previous.check.verdict");
    expect(found).toContain("previous.gate.taken");
    const previous = inside?.entries.find(
      (entry) => entry.reference === "previous.check.verdict",
    );
    expect(previous?.category).toBe("loop");
    expect(previous?.insert).toBe('{{previous.check.verdict | default ""}}');
  });

  // #927-T04
  it("needs no default for previous.* in the next instruction of a step", () => {
    const next = reachAt(
      lane(),
      FAKE_RESOLVER,
      "/steps/1/body/0/instruction/next",
    );
    const entry = next?.entries.find(
      (each) => each.reference === "previous.check.verdict",
    );
    expect(entry?.insert).toBe("{{previous.check.verdict}}");
  });

  // #927-T05
  it("offers failure.* only in onFailure, and none of the workflow's steps there", () => {
    const reach = reachAt(lane(), FAKE_RESOLVER, "/onFailure/0");
    const found = names(reach?.entries ?? []);
    expect(found).toContain("failure.message");
    expect(found).toContain("failure.status");
    expect(found).toContain("trigger.ticket");
    expect(found.some((name) => name.startsWith("implement."))).toBe(false);
  });

  // #927-T06
  it("reaches the steps of the body after the loop, and not a step of an if branch after the if", () => {
    const after = names(
      reachAt(lane(), FAKE_RESOLVER, "/steps/2")?.entries ?? [],
    );
    expect(after).toContain("check.verdict");
    expect(after).toContain("gate.taken");
    expect(after).toContain("review.rounds");
    expect(after.some((name) => name.startsWith("say."))).toBe(false);
  });

  // #927-T07
  it("reads the scope of the body for the until of a loop", () => {
    const until = reachAt(lane(), FAKE_RESOLVER, "/steps/1/until/equals/0");
    const found = names(until?.entries ?? []);
    expect(found).toContain("check.verdict");
    expect(found).toContain("previous.check.verdict");
    expect(until?.at).toBe("/steps/1");
  });

  // #927-T08
  it("gives an optional field a default, because the validator wants one", () => {
    const reach = reachAt(lane(), FAKE_RESOLVER, "/steps/1");
    const note = reach?.entries.find(
      (entry) => entry.reference === "implement.note",
    );
    expect(note?.insert).toBe('{{implement.note | default ""}}');
    const summary = reach?.entries.find(
      (entry) => entry.reference === "implement.summary",
    );
    expect(summary?.insert).toBe("{{implement.summary}}");
  });

  // #927-T09
  it("types each value, and sorts it into the category its path says", () => {
    const reach = reachAt(lane(), FAKE_RESOLVER, "/steps/1");
    const byName = new Map(
      (reach?.entries ?? []).map((entry) => [entry.reference, entry]),
    );
    expect(byName.get("trigger.ticket.number")).toMatchObject({
      category: "ticket",
      name: "number",
      type: "whole number",
    });
    expect(byName.get("trigger.ticket.labels")?.type).toBe("list of text");
    expect(byName.get("trigger.id")?.category).toBe("run");
    expect(byName.get("implement.pushed")).toMatchObject({
      category: "steps",
      type: "true/false",
    });
  });

  // #927-T10
  it("offers the input of a manual trigger under its own category", () => {
    const manual = {
      version: 1,
      name: "Manual",
      triggers: [
        {
          id: "manual",
          kind: "manual",
          input: {
            type: "object",
            required: ["ticket", "reason"],
            properties: {
              ticket: { type: "ticket" },
              reason: { type: "string" },
            },
          },
        },
      ],
      steps: [
        {
          id: "say",
          kind: "action",
          connector: "github.issue.comment",
          issue: "{{trigger.ticket}}",
          body: "x",
        },
      ],
    };
    const reach = reachAt(manual, FAKE_RESOLVER, "/steps/0");
    const reason = reach?.entries.find(
      (entry) => entry.reference === "trigger.input.reason",
    );
    expect(reason).toMatchObject({ category: "input", name: "reason" });
  });

  // #927-T11
  it("is what the validator accepts: every offered insert validates at the node", () => {
    const reach = reachAt(lane(), FAKE_RESOLVER, "/steps/2");
    const scalars = (reach?.entries ?? []).filter(
      (entry) =>
        !["object", "list of text"].includes(entry.type) &&
        !entry.type.startsWith("list"),
    );
    expect(scalars.length).toBeGreaterThan(5);
    for (const entry of scalars) {
      const document = lane();
      (document.steps as { body?: string }[])[2]!.body = entry.insert;
      const result = validateWorkflow(document, FAKE_RESOLVER);
      expect(
        result.errors.filter((error) => error.path === "/steps/2/body"),
        entry.insert,
      ).toEqual([]);
    }
  });

  // #927-T12
  it("holds a target input to the validator's own rule: only the values it takes", () => {
    const issue = reachAt(lane(), FAKE_RESOLVER, "/steps/2", {
      target: { input: "issue", roots: ["issue", "ticket"] },
    });
    expect(names(issue?.entries ?? [])).toEqual([
      "trigger.ticket",
      "trigger.ticket.number",
    ]);
    const branch = reachAt(lane(), FAKE_RESOLVER, "/steps/1", {
      target: { input: "branch", roots: ["input", "defaultBranch", "branch"] },
    });
    expect(names(branch?.entries ?? [])).toEqual([
      "trigger.ticket.repo.defaultBranch",
      "implement.branch",
    ]);
    const literal = reachAt(lane(), FAKE_RESOLVER, "/steps/2", {
      target: { input: "board", roots: [] },
    });
    expect(literal?.entries).toEqual([]);
  });

  // #927-T13
  it("adds a sample of the latest run where the value exists, and none where it does not", () => {
    const reach = reachAt(lane(), FAKE_RESOLVER, "/steps/1/body/0", {
      samples: {
        trigger: { ticket: { title: "Crash on start", labels: ["a", "b"] } },
        steps: { implement: { summary: "Fixed it\nin two files" } },
      },
    });
    const sample = (reference: string): string | undefined =>
      reach?.entries.find((entry) => entry.reference === reference)?.sample;
    expect(sample("trigger.ticket.title")).toBe("Crash on start");
    expect(sample("trigger.ticket.labels")).toBe("a, b");
    expect(sample("implement.summary")).toBe("Fixed it in two files");
    expect(sample("implement.note")).toBeUndefined();
    expect(sample("trigger.ticket.number")).toBeUndefined();
  });

  // #927-T14
  it("answers for a document with problems elsewhere, and for nothing at a pointer that is no step", () => {
    const broken = lane();
    (broken.steps as { instruction?: string }[])[0]!.instruction = "{{nope.x}}";
    expect(
      reachAt(broken, FAKE_RESOLVER, "/steps/1")?.entries.length,
    ).toBeGreaterThan(0);
    expect(reachAt(lane(), FAKE_RESOLVER, "/steps/9")).toBeUndefined();
    expect(reachAt("nonsense", FAKE_RESOLVER, "/steps/0")).toBeUndefined();
    expect(reachAt(lane(), FAKE_RESOLVER, "/triggers/0")).toBeUndefined();
  });

  // #927-T15
  it("is not stopped by a trigger input that fails its own check", () => {
    const document = {
      version: 1,
      name: "Open",
      triggers: [{ id: "manual", kind: "manual", input: { type: "nonsense" } }],
      steps: [
        {
          id: "a",
          kind: "action",
          connector: "github.issue.comment",
          issue: 1,
          body: "x",
        },
      ],
    };
    const reach = reachAt(document, FAKE_RESOLVER, "/steps/0");
    expect(reach).toBeDefined();
  });
});

describe("sampleText", () => {
  // #927-T16
  it("shortens a value to one line and has none for an object or an empty text", () => {
    expect(sampleText("a  b\nc")).toBe("a b c");
    expect(sampleText("x".repeat(100))?.length).toBe(60);
    expect(sampleText(12)).toBe("12");
    expect(sampleText(true)).toBe("true");
    expect(sampleText([])).toBe("none");
    expect(sampleText([1, { a: 1 }])).toBe("1, …");
    expect(sampleText({ a: 1 })).toBeUndefined();
    expect(sampleText("")).toBeUndefined();
    expect(sampleText(undefined)).toBeUndefined();
  });
});
