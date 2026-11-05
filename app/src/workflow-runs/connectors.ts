// SPDX-License-Identifier: LicenseRef-Proprietary

// The actions of the engine (#844): the interface a connector implements, the registry the engine asks, and the inputs of an action
// node resolved against the run. The three connectors the format names (`github.pullRequest.open`, `github.issue.comment`,
// `github.issue.labels`) need rights of the GitHub App that the owner grants first; they come with milestone 3b. Until then the
// registry of the running server is empty, and an action whose connector is not there ends its step with `connector_unavailable`.
//
// An action does what the workflow says against the target the workflow names, and nothing else: its inputs are re-checked here after
// the references are resolved (the validator checked the document, an input of a manual trigger is only known now), and a value an
// agent reported can reach a text input (a comment, a title) but never a target; the validator holds the document to it.
import { isRecord } from "../workflows/json.ts";
import {
  BUILT_IN_CONNECTORS,
  type ConnectorSpec,
  type InputSpec,
} from "../workflows/connectors.ts";
import { ISSUE_NUMBER_MAX } from "../workflows/limits.ts";
import type { ValueType } from "../workflows/value-type.ts";
import { renderText, resolveValue, type RunValues } from "./templates.ts";

/** What a connector is told about a call. */
export type ActionCall = {
  workspaceId: string;
  runId: string;
  stepId: string;
  /** The repository of the run. */
  repository: { id: string; fullName: string };
  /** The inputs of the node, references resolved and checked against the connector's spec. */
  inputs: Record<string, unknown>;
  /** The same for a call that is made again, so a connector can recognise a repeat. Stable per step of a run. */
  idempotencyKey: string;
};

export type ActionConnector = {
  name: string;
  /** Does the action; the output has the fields the spec's `output` names. A throw ends the step with `action_failed`. */
  run(call: ActionCall): Promise<Record<string, unknown>>;
};

export type ConnectorRegistry = {
  get(name: string): ActionConnector | undefined;
};

export function createConnectorRegistry(
  connectors: readonly ActionConnector[] = [],
): ConnectorRegistry {
  const byName = new Map(
    connectors.map((connector) => [connector.name, connector]),
  );
  return { get: (name) => byName.get(name) };
}

export class ActionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionInputError";
  }
}

export function specOf(name: string): ConnectorSpec | undefined {
  return BUILT_IN_CONNECTORS.find((spec) => spec.name === name);
}

function issueNumber(value: unknown, input: string): number {
  const number = isRecord(value) ? value.number : value;
  if (
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    number > ISSUE_NUMBER_MAX
  )
    throw new ActionInputError(
      `${input} must be a whole number from 1 to ${ISSUE_NUMBER_MAX}.`,
    );
  return number;
}

/** A value held to the type the spec states for the input; the issue (an object with a number, or a number) is reduced to its number. */
function coerce(
  value: unknown,
  type: ValueType,
  input: string,
  textRequired: boolean,
): unknown {
  switch (type.kind) {
    case "string":
      if (typeof value !== "string" || (textRequired && value === ""))
        throw new ActionInputError(`${input} must be a text.`);
      return value;
    case "boolean":
      if (typeof value !== "boolean")
        throw new ActionInputError(`${input} must be true or false.`);
      return value;
    case "integer":
      return issueNumber(value, input);
    case "oneOf":
      return issueNumber(value, input);
    case "list":
      if (
        !Array.isArray(value) ||
        value.some((entry) => typeof entry !== "string" || entry === "")
      )
        throw new ActionInputError(`${input} must be a list of texts.`);
      return value;
    default:
      return value;
  }
}

/**
 * The inputs of an action node with every reference resolved and the type of each held to the connector's spec. A text input may be a
 * text with references; any other is a literal or exactly one reference, which keeps the type of the value. Throws `ActionInputError`
 * (or a `TemplateError` for a reference that cannot be resolved).
 */
export function resolveActionInputs(
  node: Record<string, unknown>,
  spec: ConnectorSpec,
  values: RunValues,
): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const [name, input] of Object.entries(spec.inputs) as [
    string,
    InputSpec,
  ][]) {
    const raw = node[name];
    if (raw === undefined) {
      if (input.required) throw new ActionInputError(`${name} is missing.`);
      continue;
    }
    const resolved =
      typeof raw === "string" && input.type.kind === "string"
        ? renderText(raw, values)
        : typeof raw === "string"
          ? resolveValue(raw, values)
          : Array.isArray(raw) && input.type.kind === "list"
            ? raw.map((entry: unknown) =>
                typeof entry === "string" ? resolveValue(entry, values) : entry,
              )
            : raw;
    // A list may hold references to lists of texts (`{{trigger.input.labels}}` as an entry is a text, as the whole list a list).
    const flat = Array.isArray(resolved) ? resolved.flat() : resolved;
    inputs[name] = coerce(
      flat,
      input.type,
      name,
      input.required || input.target !== undefined,
    );
  }
  if (
    spec.atLeastOneOf !== undefined &&
    !spec.atLeastOneOf.some(
      (name) => Array.isArray(inputs[name]) && inputs[name].length > 0,
    )
  )
    throw new ActionInputError(
      `At least one entry in ${spec.atLeastOneOf.join(" or ")} is needed.`,
    );
  return inputs;
}
