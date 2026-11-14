// SPDX-License-Identifier: LicenseRef-Proprietary

// #1036: the trigger `ticket.statusChanged` in the format: its fields, what the steps read of it, and the warning for a step that puts the
// ticket into the status that starts the workflow. The engine side (which run starts for which board change) is in
// `workflow-runs/status-trigger.test.ts`.
import { describe, expect, it } from "vitest";
import { FAKE_RESOLVER } from "./test-fixtures.ts";
import { TRIGGER_KINDS, triggerOutput } from "./triggers.ts";
import { validateWorkflow } from "./validate.ts";

type Json = Record<string, unknown>;

const STATUS = {
  id: "ready",
  kind: "ticket.statusChanged",
  to: "Ready for agent",
};
const MANUAL = {
  id: "manual",
  kind: "manual",
  input: {
    type: "object",
    required: ["ticket"],
    properties: { ticket: { type: "ticket" } },
  },
};

const comment = (id: string, body = "Hello"): Json => ({
  id,
  kind: "action",
  connector: "ticket.comment",
  ticket: "{{trigger.ticket}}",
  body,
});
const setStatus = (id: string, status: string): Json => ({
  id,
  kind: "action",
  connector: "ticket.setStatus",
  ticket: "{{trigger.ticket}}",
  status,
});

function workflow(triggers: Json[], steps: Json[] = [comment("say")]): Json {
  return { version: 1, name: "w", triggers, steps };
}

const check = (document: Json) => validateWorkflow(document, FAKE_RESOLVER);
const codes = (document: Json) =>
  check(document).errors.map((e) => [e.path, e.code]);
const warned = (document: Json) =>
  (check(document).warnings ?? []).map((w) => [w.path, w.code]);

describe("the trigger ticket.statusChanged", () => {
  it("is one of the kinds of the format", () => {
    expect(TRIGGER_KINDS).toContain("ticket.statusChanged");
  });

  it("accepts `to` alone and `to` with `from`, and the steps read the ticket and the statuses", () => {
    const steps = [
      comment(
        "say",
        "{{trigger.ticket.title}} {{trigger.status.from}} -> {{trigger.status.to}} {{trigger.id}} {{trigger.kind}}",
      ),
    ];

    expect(check(workflow([STATUS], steps)).errors).toEqual([]);
    expect(
      check(workflow([{ ...STATUS, from: "Backlog" }], steps)).errors,
    ).toEqual([]);
  });

  it("yields the ticket and the statuses as texts, and nothing of the old issue fields", () => {
    const output = triggerOutput({ id: "ready", kind: "ticket.statusChanged" });

    expect(Object.keys(output.fields).sort()).toEqual([
      "id",
      "kind",
      "status",
      "ticket",
    ]);
    expect(output.fields.status?.type).toEqual({
      kind: "object",
      fields: {
        from: { type: { kind: "string" }, required: true },
        to: { type: { kind: "string" }, required: true },
      },
    });
  });

  it("lets shared steps read the ticket next to a label trigger, and the statuses only when every trigger has them", () => {
    const labeled = { id: "labeled", kind: "ticket.labeled", label: "go" };

    expect(check(workflow([STATUS, labeled])).errors).toEqual([]);
    expect(
      codes(
        workflow([STATUS, labeled], [comment("say", "{{trigger.status.to}}")]),
      ),
    ).toEqual([["/steps/0/body", "reference_not_in_scope"]]);
  });

  // #1036-T03
  it("refuses a status trigger without `to`", () => {
    expect(
      codes(workflow([{ id: "ready", kind: "ticket.statusChanged" }])),
    ).toEqual([["/triggers/0/to", "missing_field"]]);
  });

  it("refuses a blank or too long `to` or `from`, a `to` that is no text and the fields of another trigger", () => {
    expect(codes(workflow([{ ...STATUS, to: "   " }]))).toEqual([
      ["/triggers/0/to", "invalid_value"],
    ]);
    expect(codes(workflow([{ ...STATUS, to: "x".repeat(101) }]))).toEqual([
      ["/triggers/0/to", "invalid_value"],
    ]);
    expect(codes(workflow([{ ...STATUS, to: 4 }]))).toEqual([
      ["/triggers/0/to", "wrong_type"],
    ]);
    expect(codes(workflow([{ ...STATUS, from: " " }]))).toEqual([
      ["/triggers/0/from", "invalid_value"],
    ]);
    expect(codes(workflow([{ ...STATUS, label: "go" }]))).toEqual([
      ["/triggers/0/label", "unknown_field"],
    ]);
  });

  it("is read from the single `trigger` of the older form too", () => {
    expect(
      check({
        version: 1,
        name: "w",
        trigger: { kind: "ticket.statusChanged", to: "Ready" },
        steps: [comment("say", "{{trigger.status.to}}")],
      }).errors,
    ).toEqual([]);
  });

  it("warns, and does not refuse, a step that puts the ticket into the status that starts the workflow", () => {
    const result = check(
      workflow([STATUS], [setStatus("again", " ready FOR agent ")]),
    );

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        path: "/steps/0/status",
        code: "status_retriggers_workflow",
        severity: "warning",
      }),
    ]);
  });

  it("warns for the pre-steps of the status trigger itself and not for a pre-step of another trigger, nor for another status", () => {
    expect(
      warned(
        workflow([
          { ...STATUS, steps: [setStatus("mark", "Ready for agent")] },
        ]),
      ),
    ).toEqual([["/triggers/0/steps/0/status", "status_retriggers_workflow"]]);
    expect(
      warned(
        workflow([
          STATUS,
          { ...MANUAL, steps: [setStatus("mark", "Ready for agent")] },
        ]),
      ),
    ).toEqual([]);
    expect(
      warned(workflow([STATUS], [setStatus("start", "In progress")])),
    ).toEqual([]);
  });
});
