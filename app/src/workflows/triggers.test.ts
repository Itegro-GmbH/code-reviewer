// SPDX-License-Identifier: LicenseRef-Proprietary

// #916: several triggers with pre-steps, the `ticket` input and the provider-neutral kinds. What the validator reports for the
// document, with the single `trigger` of before still read, and what the `ticket` type holds.
import { describe, expect, it } from "vitest";
import { checkResultValue, validateResultSchema } from "./result-schema.ts";
import { FAKE_RESOLVER } from "./test-fixtures.ts";
import { parseTicketRef } from "./ticket-ref.ts";
import { validateWorkflow } from "./validate.ts";

type Json = Record<string, unknown>;

const TICKET_INPUT = {
  type: "object",
  required: ["ticket"],
  properties: { ticket: { type: "ticket" } },
};
const REPO_INPUT = {
  type: "object",
  required: ["repo"],
  properties: { repo: { type: "string" }, topic: { type: "string" } },
};

const labels = (id: string, add: string[], ticket = "{{trigger.ticket}}") => ({
  id,
  kind: "action",
  connector: "ticket.labels",
  ticket,
  add,
});
const comment = (
  id: string,
  ticket: string | number = "{{trigger.ticket}}",
  body = "Hello",
) => ({
  id,
  kind: "action",
  connector: "ticket.comment",
  ticket,
  body,
});

const LABELED = { id: "labeled", kind: "ticket.labeled", label: "go" };
const MANUAL = {
  id: "manual",
  kind: "manual",
  input: TICKET_INPUT,
  steps: [labels("mark", ["go"])],
};

function workflow(triggers: Json[], steps: Json[] = [comment("say", 7)]): Json {
  return { version: 1, name: "w", triggers, steps };
}

function check(document: Json) {
  return validateWorkflow(document, FAKE_RESOLVER);
}

const codes = (document: Json) =>
  check(document).errors.map((e) => [e.path, e.code]);

describe("triggers with pre-steps", () => {
  // #916-T20
  it("accepts two triggers, the second with a pre-step that puts the label of the first on the ticket", () => {
    const result = check(workflow([LABELED, MANUAL]));

    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    // The pre-step counts as a step of the document.
    expect(result.steps).toBe(2);
  });

  // #916-T21
  it("reads the single trigger of before as a list of one: both names of the label trigger work, and the old fields are still there", () => {
    for (const kind of ["github.issueLabeled", "ticket.labeled"]) {
      const result = check({
        version: 1,
        name: "w",
        trigger: { kind, label: "go" },
        steps: [
          comment("say", "{{trigger.issue}}", "{{trigger.issue.title}}"),
          comment(
            "again",
            "{{trigger.ticket.number}}",
            "{{trigger.ticket.title}} {{trigger.repo.fullName}} {{trigger.id}} {{trigger.kind}}",
          ),
        ],
      });
      expect(result.errors).toEqual([]);
    }
    expect(
      codes({
        version: 1,
        name: "w",
        trigger: { kind: "manual", input: REPO_INPUT },
        steps: [comment("say", 7, "{{trigger.input.repo}} {{trigger.id}}")],
      }),
    ).toEqual([]);
  });

  // #916-T22
  it("lets the shared steps read trigger.ticket only when every trigger yields a ticket, and names a trigger that lacks it", () => {
    const withoutTicket = {
      id: "manual",
      kind: "manual",
      input: REPO_INPUT,
    };

    const result = check(workflow([LABELED, withoutTicket], [comment("say")]));

    expect(result.errors).toEqual([
      expect.objectContaining({
        path: "/steps/0/ticket",
        code: "reference_not_in_scope",
        message: expect.stringContaining("'manual'") as string,
        available: expect.arrayContaining(["id", "kind"]) as string[],
      }),
    ]);
    // Every trigger yielding one is enough, however it gets it.
    expect(check(workflow([LABELED, MANUAL])).errors).toEqual([]);
  });

  // #916-T23
  it("names the field that is missing when no trigger yields it, as an unknown field", () => {
    const result = check(
      workflow([LABELED, MANUAL], [comment("say", 7, "{{trigger.nope}}")]),
    );

    expect(result.errors).toEqual([
      expect.objectContaining({
        path: "/steps/0/body",
        code: "reference_unknown_field",
      }),
    ]);
  });

  // #916-T24
  it("gives a pre-step the values of its own trigger only", () => {
    expect(
      codes(
        workflow([
          LABELED,
          {
            id: "manual",
            kind: "manual",
            input: REPO_INPUT,
            steps: [comment("note", 7, "{{trigger.input.repo}}")],
          },
        ]),
      ),
    ).toEqual([]);
    expect(
      codes(
        workflow([
          { ...LABELED, steps: [comment("note", 7, "{{trigger.input.x}}")] },
          MANUAL,
        ]),
      ),
    ).toEqual([["/triggers/0/steps/0/body", "reference_unknown_field"]]);
  });

  // #916-T69
  it("reports a reference to a pre-step of another trigger as not in scope, naming that trigger", () => {
    const phrase =
      "a pre-step of trigger manual, which does not run for this one";
    // A shared step reads the pre-step of a trigger.
    const fromShared = check(
      workflow(
        [LABELED, { ...MANUAL, steps: [labels("mark", ["go"])] }],
        [comment("say", 7, "{{mark.labels}}")],
      ),
    );
    expect(fromShared.errors).toEqual([
      expect.objectContaining({
        path: "/steps/0/body",
        code: "reference_not_in_scope",
        message: expect.stringContaining(phrase) as string,
      }),
    ]);
    // A pre-step reads the pre-step of another trigger.
    const fromOther = check(
      workflow([
        { ...LABELED, steps: [comment("note", 7, "{{mark.labels}}")] },
        { ...MANUAL, steps: [labels("mark", ["go"])] },
      ]),
    );
    expect(fromOther.errors).toEqual([
      expect.objectContaining({
        path: "/triggers/0/steps/0/body",
        code: "reference_not_in_scope",
        message: expect.stringContaining(phrase) as string,
      }),
    ]);
    // A pre-step still reads the step before it in its own trigger, and a step that comes later in it is a later step.
    expect(
      codes(
        workflow([
          LABELED,
          {
            ...MANUAL,
            steps: [
              labels("mark", ["go"]),
              comment("note", 7, "{{mark.labels}}"),
            ],
          },
        ]),
      ),
    ).toEqual([]);
    expect(
      codes(
        workflow([
          LABELED,
          {
            ...MANUAL,
            steps: [
              comment("note", 7, "{{mark.labels}}"),
              labels("mark", ["go"]),
            ],
          },
        ]),
      ),
    ).toEqual([["/triggers/1/steps/0/body", "reference_to_later_step"]]);
  });

  // #916-T70
  it("reports two label triggers that wait for the same label at the second one, without regard to case", () => {
    const result = check(
      workflow([
        LABELED,
        { id: "again", kind: "ticket.labeled", label: " GO " },
        MANUAL,
      ]),
    );

    expect(result.errors).toEqual([
      expect.objectContaining({
        path: "/triggers/1/label",
        code: "duplicate_trigger_label",
        message: expect.stringContaining("'labeled'") as string,
      }),
    ]);
    // The old kind is the same trigger, and another label is fine.
    expect(
      codes(
        workflow([
          LABELED,
          { id: "old", kind: "github.issueLabeled", label: "go" },
        ]),
      ),
    ).toEqual([["/triggers/1/label", "duplicate_trigger_label"]]);
    expect(
      codes(
        workflow([
          LABELED,
          { id: "two", kind: "ticket.labeled", label: "stop" },
        ]),
      ),
    ).toEqual([]);
  });

  // #916-T25
  it("holds a step id once across the pre-steps of every trigger and the shared steps", () => {
    expect(
      codes(
        workflow(
          [LABELED, { ...MANUAL, steps: [labels("same", ["go"])] }],
          [comment("same")],
        ),
      ),
    ).toEqual([["/steps/0/id", "duplicate_id"]]);
    expect(
      codes(
        workflow([
          { ...LABELED, steps: [comment("same")] },
          { ...MANUAL, steps: [labels("same", ["go"])] },
        ]),
      ),
    ).toEqual([["/triggers/1/steps/0/id", "duplicate_id"]]);
  });

  // #916-T26
  it("holds a trigger id once, as a plain name", () => {
    expect(codes(workflow([LABELED, { ...MANUAL, id: "labeled" }]))).toEqual([
      ["/triggers/1/id", "duplicate_id"],
    ]);
    expect(codes(workflow([{ ...LABELED, id: "trigger" }]))).toEqual([
      ["/triggers/0/id", "invalid_value"],
    ]);
    expect(codes(workflow([{ kind: "ticket.labeled", label: "go" }]))).toEqual([
      ["/triggers/0/id", "missing_field"],
    ]);
  });

  // #916-T27
  it("does not raise label_retriggers_workflow for a pre-step of a trigger that is no label trigger, and raises it for the other places", () => {
    // The example: the manual trigger adds the label of the label trigger. The bot's own writes start no run.
    expect(check(workflow([LABELED, MANUAL])).errors).toEqual([]);
    // A shared step runs after the label trigger too.
    expect(
      codes(workflow([LABELED, MANUAL], [labels("again", ["Go"])])),
    ).toEqual([["/steps/0/add/0", "label_retriggers_workflow"]]);
    // The pre-step of the label trigger itself.
    expect(
      codes(
        workflow([{ ...LABELED, steps: [labels("again", ["go"])] }, MANUAL]),
      ),
    ).toEqual([["/triggers/0/steps/0/add/0", "label_retriggers_workflow"]]);
    // The same rule for the single trigger of before, and for the old connector.
    expect(
      codes({
        version: 1,
        name: "w",
        trigger: { kind: "github.issueLabeled", label: "go" },
        steps: [
          {
            id: "x",
            kind: "action",
            connector: "github.issue.labels",
            issue: "{{trigger.issue}}",
            add: ["go"],
          },
        ],
      }),
    ).toEqual([["/steps/0/add/0", "label_retriggers_workflow"]]);
  });

  // #916-T28
  it("lets onFailure read what every trigger yields, like the shared steps", () => {
    const document = {
      ...workflow([LABELED, MANUAL]),
      onFailure: [comment("report", "{{trigger.ticket}}", "{{failure.code}}")],
    };
    expect(check(document).errors).toEqual([]);
    expect(
      codes({
        ...workflow([
          LABELED,
          { id: "manual", kind: "manual", input: REPO_INPUT },
        ]),
        steps: [comment("say", 7)],
        onFailure: [comment("report")],
      }),
    ).toEqual([["/onFailure/0/ticket", "reference_not_in_scope"]]);
  });

  // #916-T29
  it("makes the ticket a target: its number and default branch may name what the workflow acts on, its title may not", () => {
    expect(
      check(
        workflow(
          [LABELED, MANUAL],
          [
            comment("a", "{{trigger.ticket.number}}"),
            {
              id: "pr",
              kind: "action",
              connector: "github.pullRequest.open",
              head: "feature",
              base: "{{trigger.ticket.repo.defaultBranch}}",
              title: "{{trigger.ticket.title}}",
            },
          ],
        ),
      ).errors,
    ).toEqual([]);
    expect(
      codes(
        workflow([LABELED, MANUAL], [comment("a", "{{trigger.ticket.title}}")]),
      ),
    ).toEqual([["/steps/0/ticket", "target_from_untrusted_value"]]);
    expect(
      codes(
        workflow(
          [LABELED, MANUAL],
          [
            {
              id: "x",
              kind: "action",
              connector: "ticket.labels",
              ticket: "{{trigger.ticket}}",
              add: ["{{trigger.ticket.labels}}"],
            },
          ],
        ),
      ),
    ).toEqual([["/steps/0/add/0", "target_from_untrusted_value"]]);
  });

  // #916-T30
  it("reads trigger.id and trigger.kind as facts of every trigger", () => {
    expect(
      check(
        workflow(
          [LABELED, MANUAL, { id: "api", kind: "api", input: REPO_INPUT }],
          [
            {
              id: "x",
              kind: "action",
              connector: "ticket.comment",
              ticket: 7,
              body: "{{trigger.id}} {{trigger.kind}}",
            },
          ],
        ),
      ).errors,
    ).toEqual([]);
  });

  // #916-T31
  it("shares trigger.input.<field> only where every trigger declares it", () => {
    const both = [
      { id: "a", kind: "manual", input: REPO_INPUT },
      { id: "b", kind: "api", input: REPO_INPUT },
    ];
    const use = (field: string) => [
      comment("say", 7, `{{trigger.input.${field}}}`),
    ];
    expect(check(workflow(both, use("repo"))).errors).toEqual([]);
    expect(codes(workflow(both, use("other")))).toEqual([
      ["/steps/0/body", "reference_unknown_field"],
    ]);
    expect(
      codes(
        workflow(
          [
            both[0] as Json,
            {
              id: "b",
              kind: "manual",
              input: {
                ...REPO_INPUT,
                properties: { repo: { type: "string" } },
              },
            },
          ],
          use("topic"),
        ),
      ),
    ).toEqual(
      [["/steps/0/body", "reference_optional_field"]]
        .slice(0, 0)
        .concat([["/steps/0/body", "reference_unknown_field"]]),
    );
  });

  // #916-T32
  it("accepts pre-steps that are left out or empty", () => {
    expect(check(workflow([{ ...LABELED, steps: undefined }])).errors).toEqual(
      [],
    );
    expect(check(workflow([{ ...LABELED, steps: [] }])).errors).toEqual([]);
    expect(codes(workflow([{ ...LABELED, steps: {} }]))).toEqual([
      ["/triggers/0/steps", "wrong_type"],
    ]);
  });

  // #916-T33
  it("holds the form of the list: one to ten triggers, and not together with the single trigger", () => {
    expect(codes(workflow([]))).toEqual([["/triggers", "invalid_value"]]);
    expect(
      codes(
        workflow(
          Array.from({ length: 11 }, (_, n) => ({
            ...LABELED,
            id: `t${n}`,
            label: `go-${n}`,
          })),
        ),
      ),
    ).toEqual([["/triggers", "limit_exceeded"]]);
    expect(
      codes({ ...workflow([LABELED]), trigger: { kind: "manual" } }),
    ).toEqual([["/trigger", "invalid_value"]]);
    expect(codes({ version: 1, name: "w", steps: [comment("x")] })).toEqual([
      ["/trigger", "missing_field"],
    ]);
    expect(codes({ ...workflow([LABELED]), triggers: {} })).toEqual([
      ["/triggers", "wrong_type"],
    ]);
  });

  // #916-T34
  it("names the kinds there are, the old name of the label trigger included, and knows the reserved ones", () => {
    const wrong = check(workflow([{ id: "x", kind: "webhook" }])).errors[0];
    expect(wrong).toMatchObject({
      path: "/triggers/0/kind",
      code: "unknown_trigger_kind",
      available: [
        "manual",
        "api",
        "ticket.labeled",
        "pullRequest.pushed",
        "schedule",
        "github.issueLabeled",
      ],
    });
    expect(
      check(
        workflow(
          [
            LABELED,
            { id: "push", kind: "pullRequest.pushed" },
            { id: "weekly", kind: "schedule", cron: "0 6 * * 1" },
          ],
          [comment("say", 7)],
        ),
      ).errors,
    ).toEqual([]);
    expect(codes(workflow([{ id: "weekly", kind: "schedule" }]))).toEqual([
      ["/triggers/0/cron", "missing_field"],
    ]);
    expect(
      codes(workflow([{ id: "weekly", kind: "schedule", cron: "0 6 *" }])),
    ).toEqual([["/triggers/0/cron", "invalid_value"]]);
    expect(
      codes(workflow([{ id: "push", kind: "pullRequest.pushed", label: "x" }])),
    ).toEqual([["/triggers/0/label", "unknown_field"]]);
  });
});

describe("the input of a manual or api trigger", () => {
  // #916-T40
  it("needs the ticket, or the repository, so that the run has one", () => {
    expect(
      codes(workflow([{ id: "m", kind: "manual" }], [comment("say", 7)])),
    ).toEqual([["/triggers/0", "repo_required"]]);
    expect(
      codes(
        workflow([
          {
            id: "m",
            kind: "manual",
            input: {
              type: "object",
              properties: { topic: { type: "string" } },
            },
          },
        ]),
      ),
    ).toEqual([["/triggers/0/input", "repo_required"]]);
    // The ticket must be handed in: it names the repository of the run.
    expect(
      codes(
        workflow([
          {
            id: "m",
            kind: "manual",
            input: { ...TICKET_INPUT, required: [] },
          },
        ]),
      ),
    ).toEqual([["/triggers/0/input", "repo_required"]]);
    // `repo` is no longer needed once there is a ticket.
    expect(
      check(workflow([{ id: "m", kind: "api", input: TICKET_INPUT }])).errors,
    ).toEqual([]);
  });

  // #916-T41
  it("takes a ticket only as the field `ticket` of the input itself", () => {
    const input = (properties: Json) => ({
      type: "object",
      required: ["repo"],
      properties: { repo: { type: "string" }, ...properties },
    });
    const at = (properties: Json) =>
      codes(workflow([{ id: "m", kind: "manual", input: input(properties) }]));
    expect(at({ task: { type: "ticket" } })).toEqual([
      ["/triggers/0/input/properties/task/type", "invalid_value"],
    ]);
    expect(at({ many: { type: "array", items: { type: "ticket" } } })).toEqual([
      ["/triggers/0/input/properties/many/items/type", "invalid_value"],
    ]);
    expect(
      at({
        nested: { type: "object", properties: { ticket: { type: "ticket" } } },
      }),
    ).toEqual([
      [
        "/triggers/0/input/properties/nested/properties/ticket/type",
        "invalid_value",
      ],
    ]);
    expect(at({ ticket: { type: "ticket", maxLength: 3 } })).toEqual([
      ["/triggers/0/input/properties/ticket/maxLength", "unknown_field"],
    ]);
  });

  // #916-T42
  it("is refused in the result of an agent step and in a profile's schema, where a ticket is no value an agent hands in", () => {
    const result = {
      type: "object",
      properties: { ticket: { type: "ticket" } },
    };
    expect(validateResultSchema(result).issues).toEqual([
      expect.objectContaining({
        path: "/properties/ticket/type",
        code: "invalid_value",
        message: expect.stringContaining("trigger") as string,
      }),
    ]);
    expect(
      validateResultSchema(result, "", { allowTicket: true }).issues,
    ).toEqual([]);
    expect(
      codes(
        workflow(
          [LABELED],
          [
            {
              id: "work",
              kind: "agent",
              profile: "implementer@1",
              environment: "node",
              instruction: "do it",
              result,
            },
          ],
        ),
      ),
    ).toEqual([["/steps/0/result/properties/ticket/type", "invalid_value"]]);
  });

  // #916-T43
  it("lifts the ticket out of the input: it is trigger.ticket, not trigger.input.ticket", () => {
    expect(
      codes(
        workflow(
          [{ id: "m", kind: "manual", input: TICKET_INPUT }],
          [comment("say", 7, "{{trigger.input.ticket}}")],
        ),
      ),
    ).toEqual([["/steps/0/body", "reference_unknown_field"]]);
  });
});

describe("a ticket reference", () => {
  const schema = validateResultSchema(TICKET_INPUT, "", {
    allowTicket: true,
  }).schema;
  const problems = (value: unknown) =>
    schema === undefined ? [] : checkResultValue(schema, { ticket: value });

  // #916-T50
  it("is github:owner/repo#number", () => {
    expect(problems("github:itegro/shop#128")).toEqual([]);
    expect(parseTicketRef("github:itegro/shop#128")).toEqual({
      ok: true,
      ref: { provider: "github", repo: "itegro/shop", number: 128 },
    });
  });

  // #916-T51
  it("names what is wrong: the type, the shape, the provider, the number", () => {
    expect(problems(128)).toEqual([
      expect.objectContaining({ path: "/ticket", code: "wrong_type" }),
    ]);
    expect(problems("itegro/shop#128")).toEqual([
      expect.objectContaining({ path: "/ticket", code: "invalid_value" }),
    ]);
    expect(problems("jira:ABC-1")).toEqual([
      expect.objectContaining({
        path: "/ticket",
        code: "invalid_value",
        available: ["github"],
      }),
    ]);
    expect(problems("github:itegro/shop#0")).toEqual([
      expect.objectContaining({ code: "invalid_value" }),
    ]);
    expect(problems("github:itegro/shop#2147483648")).toEqual([
      expect.objectContaining({ code: "invalid_value" }),
    ]);
    expect(problems("github:a/b/c#1")).toEqual([
      expect.objectContaining({ code: "invalid_value" }),
    ]);
    expect(schema === undefined ? [] : checkResultValue(schema, {})).toEqual([
      expect.objectContaining({ path: "/ticket", code: "missing_field" }),
    ]);
  });
});
