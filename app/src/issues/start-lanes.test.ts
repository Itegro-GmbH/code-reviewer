// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { builtInLaneDocument } from "../workflows/built-in-lanes.ts";
import { startLaneOf } from "./start-lanes.ts";

const ticketInput = (
  extra: Record<string, unknown> = {},
  required = ["ticket"],
) => ({
  type: "object",
  required,
  properties: { ticket: { type: "ticket" }, ...extra },
});

const lane = (triggers: unknown[], extra: Record<string, unknown> = {}) => ({
  version: 1,
  name: "Lane",
  triggers,
  steps: [],
  ...extra,
});

describe("the lanes that can start from an issue", () => {
  // #925-T11
  it("reads what the dialog shows from the built-in Issue to PR lane", () => {
    const found = startLaneOf(
      "wf-1",
      "Issue to PR",
      builtInLaneDocument("issue-to-pr", "node"),
    );

    expect(found).toMatchObject({
      workflowId: "wf-1",
      name: "Issue to PR",
      trigger: "manual",
      ticketField: "ticket",
      budgetUsd: 20,
      turnTimeLimitMinutes: 60,
    });
    expect(found?.description).toMatch(/^Implement the ticket/);
    expect(found?.firstSteps.length).toBeGreaterThan(0);
    expect(found?.firstSteps.length).toBeLessThanOrEqual(4);
    expect(found?.firstSteps[0]).toBe("Action: ticket.labels");
  });

  // #925-T12
  it("takes the budget and the turn time limit of the document", () => {
    const found = startLaneOf(
      "wf-2",
      "Small",
      lane([{ id: "m", kind: "manual", input: ticketInput(), steps: [] }], {
        budgetUsd: 5.5,
        turnTimeLimitMinutes: 30,
      }),
    );

    expect(found).toMatchObject({ budgetUsd: 5.5, turnTimeLimitMinutes: 30 });
  });

  // #925-T13
  it("offers no lane whose manual trigger takes no ticket, or asks for more than a ticket", () => {
    const noTicket = lane([
      {
        id: "m",
        kind: "manual",
        input: {
          type: "object",
          required: ["repo"],
          properties: { repo: { type: "string" } },
        },
        steps: [],
      },
    ]);
    const more = lane([
      {
        id: "m",
        kind: "manual",
        input: ticketInput({ topic: { type: "string" } }, ["ticket", "topic"]),
        steps: [],
      },
    ]);

    expect(startLaneOf("a", "A", noTicket)).toBeUndefined();
    expect(startLaneOf("b", "B", more)).toBeUndefined();
  });

  // #925-T14
  it("accepts an optional extra input and picks the trigger that takes the ticket among several", () => {
    const found = startLaneOf(
      "wf-3",
      "Two",
      lane([
        {
          id: "plain",
          kind: "manual",
          input: {
            type: "object",
            properties: { note: { type: "string" } },
          },
          steps: [],
        },
        {
          id: "by-ticket",
          kind: "manual",
          input: ticketInput({ note: { type: "string" } }),
          steps: [],
        },
      ]),
    );

    expect(found?.trigger).toBe("by-ticket");
  });

  // #925-T15
  it("offers no lane started by a label only, and none from a document that is no object", () => {
    expect(
      startLaneOf(
        "wf",
        "Label",
        lane([{ id: "l", kind: "ticket.labeled", label: "go", steps: [] }]),
      ),
    ).toBeUndefined();
    expect(startLaneOf("wf", "Broken", "nope")).toBeUndefined();
  });
});
