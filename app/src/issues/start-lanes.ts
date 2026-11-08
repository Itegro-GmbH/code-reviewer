// SPDX-License-Identifier: LicenseRef-Proprietary

// The lanes a person can start from an issue (#925): the lanes of the project with a manual trigger whose only required input is the
// ticket. What the start dialog shows of each one (what it does, its first steps, its limits) is read from the saved document here, on
// the server, and handed to the dialog as plain data. A lane that also asks for something else by hand is not offered: the dialog asks
// the one question "Which lane?" and nothing more.
import { isRecord } from "../workflows/json.ts";
import {
  BUDGET_DEFAULT_USD,
  TURN_TIME_LIMIT_MINUTES_DEFAULT,
} from "../workflows/limits.ts";
import { describeNode } from "../workflow-pages/builder/describe.ts";
import { KIND_LABEL } from "../workflow-pages/builder/describe.ts";
import type { NodeKind } from "../workflow-pages/builder/document.ts";
import {
  startFormOf,
  type StartFormFields,
} from "../workflow-pages/start-form-spec.ts";

const FIRST_STEPS = 4;

/** One lane the dialog offers. */
export type StartLane = {
  workflowId: string;
  name: string;
  description: string;
  /** The id of the manual trigger that takes the ticket; undefined for a document with the single `trigger` of before #916. */
  trigger?: string;
  /** The name of the input that holds the ticket. */
  ticketField: string;
  firstSteps: string[];
  budgetUsd: number;
  turnTimeLimitMinutes: number;
};

function takesOnlyATicket(form: StartFormFields): string | undefined {
  const ticket = form.fields.find((field) => field.kind === "ticket");
  if (ticket === undefined) return undefined;
  return form.fields.every((field) => field === ticket || !field.required)
    ? ticket.name
    : undefined;
}

function stepLine(step: unknown): string | undefined {
  if (!isRecord(step) || typeof step.kind !== "string") return undefined;
  if (!Object.hasOwn(KIND_LABEL, step.kind)) return undefined;
  const described = describeNode(step, step.kind as NodeKind);
  return `${described.kindLabel}: ${described.title}`;
}

/** The lane the document makes, or undefined when it cannot be started from an issue by hand. */
export function startLaneOf(
  workflowId: string,
  name: string,
  document: unknown,
): StartLane | undefined {
  if (!isRecord(document)) return undefined;
  const spec = startFormOf(document);
  const forms =
    spec.kind === "form" ? [spec] : spec.kind === "forms" ? spec.forms : [];
  for (const form of forms) {
    const ticketField = takesOnlyATicket(form);
    if (ticketField === undefined) continue;
    const steps = Array.isArray(document.steps)
      ? (document.steps as unknown[])
      : [];
    return {
      workflowId,
      name,
      description:
        typeof document.description === "string" ? document.description : "",
      ...(form.trigger === undefined ? {} : { trigger: form.trigger }),
      ticketField,
      firstSteps: steps
        .map(stepLine)
        .filter((line): line is string => line !== undefined)
        .slice(0, FIRST_STEPS),
      budgetUsd:
        typeof document.budgetUsd === "number"
          ? document.budgetUsd
          : BUDGET_DEFAULT_USD,
      turnTimeLimitMinutes:
        typeof document.turnTimeLimitMinutes === "number"
          ? document.turnTimeLimitMinutes
          : TURN_TIME_LIMIT_MINUTES_DEFAULT,
    };
  }
  return undefined;
}
