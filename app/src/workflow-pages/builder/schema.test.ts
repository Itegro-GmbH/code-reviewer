// SPDX-License-Identifier: LicenseRef-Proprietary

// The result schema as a table of fields, and conditions as a form (#926): the helpers the inspector's controls write with.
import { describe, expect, it } from "vitest";
import {
  controlOf,
  specOf,
  textOfValue,
  valueOfText,
  withConnector,
} from "./action-fields.ts";
import {
  convertCondition,
  operandFrom,
  operandKind,
  operandOfKind,
  operandText,
} from "./condition.ts";
import {
  addRow,
  removeRow,
  renameRow,
  requireRow,
  retypeRow,
  rowsOf,
} from "./schema.ts";

const SCHEMA = {
  type: "object",
  required: ["summary"],
  properties: {
    summary: { type: "string", description: "What was done." },
    findings: { type: "array", items: { type: "string" } },
  },
};

describe("a result schema as rows", () => {
  // #926-T16
  it("lists the fields with their type and whether they are required, and marks a list or an object as not editable here", () => {
    expect(rowsOf(SCHEMA)).toEqual([
      { name: "summary", type: "string", required: true, nested: false },
      { name: "findings", type: "array", required: false, nested: true },
    ]);
    expect(rowsOf(undefined)).toEqual([]);
  });

  // #926-T17
  it("adds, renames, retypes, requires and removes a field and keeps what else the schema says", () => {
    expect(rowsOf(addRow(SCHEMA)).map((row) => row.name)).toEqual([
      "summary",
      "findings",
      "field",
    ]);
    const renamed = renameRow(SCHEMA, "summary", "text");
    expect(Object.keys(renamed.properties)).toEqual(["text", "findings"]);
    expect(renamed.required).toEqual(["text"]);
    expect(renameRow(SCHEMA, "summary", "findings")).toBe(SCHEMA);
    expect(renameRow(SCHEMA, "summary", "")).toBe(SCHEMA);
    expect(retypeRow(SCHEMA, "summary", "integer").properties.summary).toEqual({
      type: "integer",
      description: "What was done.",
    });
    expect(requireRow(SCHEMA, "findings", true).required).toEqual([
      "summary",
      "findings",
    ]);
    const without = removeRow(SCHEMA, "summary");
    expect(without).not.toHaveProperty("required");
    expect(Object.keys(without.properties)).toEqual(["findings"]);
  });
});

describe("conditions", () => {
  // #926-T18
  it("changes the operator and keeps the operands that fit", () => {
    expect(convertCondition({ notEmpty: "{{a.b}}" }, "empty")).toEqual({
      empty: "{{a.b}}",
    });
    expect(convertCondition({ notEmpty: "{{a.b}}" }, "equals")).toEqual({
      equals: ["{{a.b}}", ""],
    });
    expect(convertCondition({ equals: ["{{a.b}}", "x"] }, "notEquals")).toEqual(
      { notEquals: ["{{a.b}}", "x"] },
    );
    expect(convertCondition({ equals: ["{{a.b}}", "x"] }, "notEmpty")).toEqual({
      notEmpty: "{{a.b}}",
    });
    expect(convertCondition({ notEmpty: "{{a.b}}" }, "all")).toEqual({
      all: [{ notEmpty: "{{a.b}}" }],
    });
    expect(convertCondition({ notEmpty: "{{a.b}}" }, "not")).toEqual({
      not: { notEmpty: "{{a.b}}" },
    });
    expect(convertCondition({ all: [{ empty: "x" }] }, "any")).toEqual({
      any: [{ empty: "x" }],
    });
  });

  // #926-T19
  it("keeps a typed text a text, and reads a number or true/false only for the kind the person chose", () => {
    expect(operandFrom("3", "text")).toBe("3");
    expect(operandFrom("true", "text")).toBe("true");
    expect(operandFrom("3", "number", "")).toBe(3);
    // #927: text that is no number yet leaves the operand as it was; the field keeps the draft.
    expect(operandFrom("", "number", 5)).toBe(5);
    expect(operandFrom("-", "number", 5)).toBe(5);
    expect(operandFrom("x", "number", 5)).toBe(5);
    expect(operandFrom("true", "boolean")).toBe(true);
    expect(operandFrom("false", "boolean")).toBe(false);
    expect(operandKind(3)).toBe("number");
    expect(operandKind("3")).toBe("text");
    expect(operandKind(false)).toBe("boolean");
    expect(operandOfKind("3", "number")).toBe(3);
    expect(operandOfKind("x", "number")).toBe(0);
    expect(operandOfKind(3, "text")).toBe("3");
    expect(operandOfKind(true, "text")).toBe("true");
    expect(operandOfKind("true", "boolean")).toBe(true);
    expect(operandText(3)).toBe("3");
    expect(operandText(undefined)).toBe("");
  });
});

describe("the inputs of an action", () => {
  // #926-T20
  it("is made from the connector's own spec: which inputs, what control", () => {
    const labels = specOf("ticket.labels");
    expect(Object.keys(labels?.inputs ?? {})).toEqual([
      "ticket",
      "add",
      "remove",
    ]);
    expect(controlOf("add", labels?.inputs.add as never)).toBe("list");
    expect(controlOf("ticket", labels?.inputs.ticket as never)).toBe(
      "numberOrText",
    );
    const review = specOf("ticket.requestReview");
    expect(controlOf("reviewers", review?.inputs.reviewers as never)).toBe(
      "listOrText",
    );
    expect(
      controlOf("body", specOf("ticket.comment")?.inputs.body as never),
    ).toBe("longText");
    expect(
      controlOf("draft", specOf("pullRequest.open")?.inputs.draft as never),
    ).toBe("boolean");
  });

  // #926-T21
  it("turns a text into the value the format wants", () => {
    expect(valueOfText("list", "a\n b \n\n", false)).toEqual(["a", "b"]);
    expect(valueOfText("list", "{{trigger.input.labels}}", false)).toBe(
      "{{trigger.input.labels}}",
    );
    expect(valueOfText("list", "", false)).toBeUndefined();
    expect(valueOfText("listOrText", "project members", true)).toBe(
      "project members",
    );
    expect(valueOfText("listOrText", "octocat\nhubot", true)).toEqual([
      "octocat",
      "hubot",
    ]);
    expect(valueOfText("numberOrText", "7", true)).toBe(7);
    expect(valueOfText("numberOrText", "{{trigger.ticket}}", true)).toBe(
      "{{trigger.ticket}}",
    );
    expect(valueOfText("text", "", true)).toBe("");
    expect(valueOfText("text", "", false)).toBeUndefined();
    expect(textOfValue(["a", "b"])).toBe("a\nb");
    expect(textOfValue(7)).toBe("7");
  });

  // #926-T22
  it("keeps what the new connector also has when the connector changes, an issue becoming a ticket", () => {
    const next = withConnector(
      {
        id: "x",
        kind: "action",
        connector: "github.issue.comment",
        issue: "{{trigger.issue}}",
        body: "hi",
      },
      "ticket.comment",
    );
    expect(next).toEqual({
      id: "x",
      kind: "action",
      connector: "ticket.comment",
      ticket: "{{trigger.issue}}",
      body: "hi",
    });
    const labels = withConnector(next, "ticket.labels");
    expect(labels).toEqual({
      id: "x",
      kind: "action",
      connector: "ticket.labels",
      ticket: "{{trigger.issue}}",
    });
    expect(
      withConnector({ id: "x", kind: "action" }, "pullRequest.open"),
    ).toMatchObject({ head: "", title: "" });
  });
});
