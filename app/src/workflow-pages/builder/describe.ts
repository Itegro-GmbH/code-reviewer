// SPDX-License-Identifier: LicenseRef-Proprietary

// What a node of the flow says about itself (#926): its kind, a title and one line. Taken from the document as it stands, so a half
// written step still shows what there is of it. All text from the document is data of whoever wrote it, shown as text.
import { isRecord } from "../../workflows/json.ts";
import type { Doc, NodeKind } from "./document.ts";

export const KIND_LABEL: Record<NodeKind, string> = {
  trigger: "Trigger",
  agent: "Agent step",
  action: "Action",
  loop: "Loop",
  if: "If",
};

export type NodeDescription = {
  kindLabel: string;
  title: string;
  summary: string;
};

/** A reference or a text for one line: `{{review.findings}}` becomes `review.findings`, a long text is cut. */
export function brief(value: unknown, max = 48): string {
  const text =
    typeof value === "string"
      ? value.replace(/\{\{\s*([^}]*?)\s*\}\}/g, "$1")
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : "";
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

export const CONDITION_OPERATORS = [
  "empty",
  "notEmpty",
  "equals",
  "notEquals",
  "all",
  "any",
  "not",
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

/** The operator of a condition (an object with one key the format knows), or undefined. */
export function operatorOf(condition: unknown): ConditionOperator | undefined {
  if (!isRecord(condition)) return undefined;
  const [key] = Object.keys(condition);
  return (CONDITION_OPERATORS as readonly string[]).includes(key ?? "")
    ? (key as ConditionOperator)
    : undefined;
}

export function describeCondition(condition: unknown): string {
  const operator = operatorOf(condition);
  if (operator === undefined || !isRecord(condition)) return "no condition";
  const value = condition[operator];
  switch (operator) {
    case "empty":
    case "notEmpty":
      return `${operator} ${brief(value)}`.trim();
    case "equals":
    case "notEquals": {
      const [a, b] = Array.isArray(value) ? (value as unknown[]) : [];
      return `${brief(a, 24)} ${operator === "equals" ? "=" : "≠"} ${brief(b, 24)}`;
    }
    case "all":
    case "any": {
      const parts = Array.isArray(value) ? (value as unknown[]) : [];
      return parts
        .map((part) => describeCondition(part))
        .join(operator === "all" ? " and " : " or ");
    }
    case "not":
      return `not (${describeCondition(value)})`;
  }
}

function describeTrigger(node: Doc): { title: string; summary: string } {
  const kind = typeof node.kind === "string" ? node.kind : "";
  switch (kind) {
    case "ticket.labeled":
    case "github.issueLabeled":
      return {
        title: `Label “${brief(node.label, 40)}” on a ticket`,
        summary: "gives trigger.ticket",
      };
    case "manual":
    case "api": {
      const input = isRecord(node.input) ? node.input : {};
      const names = isRecord(input.properties)
        ? Object.keys(input.properties)
        : [];
      return {
        title: kind === "manual" ? "By hand" : "By API",
        summary:
          names.length > 0 ? `input ${names.join(", ")}` : "no input yet",
      };
    }
    case "schedule":
      return {
        title: `On a schedule`,
        summary: `cron ${brief(node.cron, 40)}`,
      };
    case "pullRequest.pushed":
      return { title: "A push to a pull request", summary: "reserved" };
    default:
      return { title: "Trigger", summary: kind === "" ? "no kind yet" : kind };
  }
}

function describeSession(session: unknown): string {
  if (isRecord(session) && typeof session.continue === "string")
    return `continues ${session.continue}`;
  return "new session";
}

export function describeNode(node: Doc, kind: NodeKind): NodeDescription {
  const note = typeof node.description === "string" ? node.description : "";
  const kindLabel = KIND_LABEL[kind];
  if (kind === "trigger") {
    const described = describeTrigger(node);
    return {
      kindLabel,
      title: note === "" ? described.title : brief(note, 80),
      summary: described.summary,
    };
  }
  if (kind === "agent") {
    const profile = typeof node.profile === "string" ? node.profile : "";
    return {
      kindLabel,
      title: note === "" ? "Agent step" : brief(note, 80),
      summary: `${profile === "" ? "no profile yet" : profile} · ${describeSession(node.session)}`,
    };
  }
  if (kind === "action") {
    const connector = typeof node.connector === "string" ? node.connector : "";
    const labels = (key: "add" | "remove"): string =>
      Array.isArray(node[key])
        ? `${key} ${(node[key] as unknown[]).map((label) => brief(label, 24)).join(", ")}`
        : "";
    const target =
      typeof node.head === "string"
        ? `head ${brief(node.head)}`
        : typeof node.status === "string"
          ? `status ${brief(node.status)}`
          : "";
    return {
      kindLabel,
      title: note === "" ? connector || "Action" : brief(note, 80),
      summary: [
        connector || "no connector yet",
        labels("add"),
        labels("remove"),
        target,
      ]
        .filter((part) => part !== "")
        .join(" · "),
    };
  }
  if (kind === "loop") {
    const rounds = typeof node.maxRounds === "number" ? node.maxRounds : "?";
    return {
      kindLabel,
      title: note === "" ? "Repeat" : brief(note, 80),
      summary: `up to ${String(rounds)} rounds · until ${describeCondition(node.until)}`,
    };
  }
  return {
    kindLabel,
    title: note === "" ? "Condition" : brief(note, 80),
    summary: describeCondition(node.when),
  };
}
