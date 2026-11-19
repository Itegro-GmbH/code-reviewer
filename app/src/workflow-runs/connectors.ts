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
  PULL_REQUEST_OPENING_CONNECTORS,
  type ConnectorSpec,
  type InputSpec,
} from "../workflows/connectors.ts";
import { ISSUE_NUMBER_MAX } from "../workflows/limits.ts";
import { STRING, type ValueType } from "../workflows/value-type.ts";
import {
  TemplateError,
  renderText,
  resolveValue,
  type RunValues,
} from "./templates.ts";

/** What a connector is told about a call. */
export type ActionCall = {
  workspaceId: string;
  runId: string;
  stepId: string;
  /** The repository of the run. */
  repository: { id: string; fullName: string };
  /** The branch the run's agent steps started from (the default branch of the repository when the run began): the base of a pull request that names none. */
  baseBranch: string;
  /** The inputs of the node, references resolved and checked against the connector's spec. */
  inputs: Record<string, unknown>;
  /** The same for a call that is made again, so a connector can recognise a repeat. Stable per step of a run. */
  idempotencyKey: string;
  /** When the step was written (ISO 8601): nothing the step did, also in an earlier attempt, is older. Bounds a search for what a repeat finds. */
  stepCreatedAt: string;
  /** Aborted when the call has taken its budget; a connector passes it on to what it calls. */
  signal: AbortSignal;
  /** #1094: the time the engine gives the call (`ActionConnector.budgetMs`, else `ACTION_TIMEOUT_MS`), for a connector that does several things and stops before the signal aborts. Left out by callers that do not time it. */
  budgetMs?: number;
};

/** What a step says when an action that cannot be repeated ended without an answer: the run page does not know whether it took effect. */
export const MAY_HAVE_HAPPENED =
  "The action may have happened; check GitHub before starting again.";

export type ActionConnector = {
  name: string;
  /** True for an action that does the same when it is done twice (labels): a timeout of it does not warn that it may have happened. */
  idempotent?: boolean;
  /** Does the action; the output has the fields the spec's `output` names. A `ConnectorError` ends the step with its code, an `ActionInputError` with `action_input_invalid`, any other throw with `action_failed`; an answer later than `ACTION_TIMEOUT_MS` is not waited for (`action_timeout`). */
  run(call: ActionCall): Promise<Record<string, unknown>>;
  /** #1094: the time one call may take, from its resolved inputs, when it does more than one thing (a pull request step with `repos`); `ACTION_TIMEOUT_MS` when left out. */
  budgetMs?(inputs: Record<string, unknown>): number;
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

/** The codes a connector fails with (a subset of the step failure codes, `errors.ts`): the step ends with the connector's own code. */
export const CONNECTOR_FAILURE_CODES = [
  "github_permission_missing",
  "github_not_found",
  "board_status_unknown",
  "github_validation",
  "github_rate_limited",
  "github_unavailable",
  "ticket_provider_unsupported",
  "ticket_not_found",
  "ticket_forbidden",
  "ticket_connection_broken",
  "ticket_unavailable",
  "ticket_rejected",
  "ticket_status_unknown",
  "ticket_status_unreachable",
  /** #1094: a step that does one thing per repository ran out of its budget; `output` says what it had done. */
  "action_timeout",
  /** #1094: an unexpected failure of one repository of such a step; the message names what was done before. */
  "action_failed",
] as const;
export type ConnectorFailureCode = (typeof CONNECTOR_FAILURE_CODES)[number];

/** A connector's failure with a stable code; the message is for the run page (no token, no text of the action). */
export class ConnectorError extends Error {
  readonly code: ConnectorFailureCode;
  /** #1094: what the action had done when it failed (the `pullRequests` of a step that opened some and not others); kept as the output of the failed step. */
  readonly output: Record<string, unknown> | undefined;

  constructor(
    code: ConnectorFailureCode,
    message: string,
    output?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ConnectorError";
    this.code = code;
    this.output = output;
  }
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

/** Whether a list is among the shapes the input takes (a list, or a text or list). */
function holdsList(type: ValueType): boolean {
  return (
    type.kind === "list" ||
    (type.kind === "oneOf" &&
      type.options.some((option) => option.kind === "list"))
  );
}

/** One repository of the `repos` fact of an agent step, as the connector takes it; `title` and `body` are the texts rendered for it (#1094). */
export type RepoInput = {
  fullName: string;
  base: string;
  branch: string;
  pushed: boolean;
  headCommit: string | null;
  /** The push of the working branch was refused (`pushRejected` of the fact). */
  pushRejected: boolean;
  title?: string;
  body?: string;
};

function reposOf(value: unknown, input: string): RepoInput[] {
  // An empty list is what an agent step that reported no repository gives: nothing to open, not a mistake of the lane.
  if (!Array.isArray(value))
    throw new ActionInputError(`${input} must be a list of repositories.`);
  return value.map((entry): RepoInput => {
    if (
      !isRecord(entry) ||
      typeof entry.fullName !== "string" ||
      typeof entry.base !== "string" ||
      typeof entry.branch !== "string" ||
      entry.fullName === "" ||
      entry.base === "" ||
      entry.branch === ""
    )
      throw new ActionInputError(
        `${input} must be the repositories of an agent step: each with fullName, base and branch.`,
      );
    return {
      fullName: entry.fullName,
      base: entry.base,
      branch: entry.branch,
      pushed: entry.pushed === true,
      pushRejected: entry.pushRejected === true,
      headCommit:
        typeof entry.headCommit === "string" ? entry.headCommit : null,
    };
  });
}

function isMissing(raw: string, values: RunValues): boolean {
  try {
    resolveValue(raw, values);
    return false;
  } catch (error) {
    if (
      error instanceof TemplateError &&
      error.code === "template_missing_value"
    )
      return true;
    throw error;
  }
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
    case "oneOf": {
      // An input that is a text or a list of texts (`reviewers`, #917); the other oneOf is the issue: an object with a number, or a number.
      const list = type.options.find((option) => option.kind === "list");
      if (list === undefined) {
        // A ticket (#1040) may be a ticket of a platform that does not number its tickets (Jira): the object has no number then (0), and what
        // the action takes is its text key. Where the ticket has a number (GitHub) the number is handed on, as before.
        const wantsKey = type.options.some(
          (option) => option.kind === "object" && "key" in option.fields,
        );
        if (
          wantsKey &&
          isRecord(value) &&
          typeof value.key === "string" &&
          value.key !== "" &&
          !(typeof value.number === "number" && value.number >= 1)
        )
          return value.key;
        return issueNumber(value, input);
      }
      return coerce(
        value,
        typeof value === "string" ? STRING : list,
        input,
        textRequired,
      );
    }
    case "list":
      // #1094: the `repos` of a pull request step, the facts of an agent step; held to their shape, not to a list of texts.
      if (type.items.kind === "object") return reposOf(value, input);
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
 * text with references (what an agent step reported is defused there, `templates.ts`); any other is a literal or exactly one reference,
 * which keeps the type of the value. Throws `ActionInputError`
 * (or a `TemplateError` for a reference that cannot be resolved).
 */
export function resolveActionInputs(
  node: Record<string, unknown>,
  spec: ConnectorSpec,
  values: RunValues,
): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  const perRepo =
    node.repos !== undefined &&
    PULL_REQUEST_OPENING_CONNECTORS.includes(spec.name);
  for (const [name, input] of Object.entries(spec.inputs) as [
    string,
    InputSpec,
  ][]) {
    const raw = node[name];
    if (raw === undefined) {
      if (input.required) throw new ActionInputError(`${name} is missing.`);
      continue;
    }
    // #1094: a reference to a value that does not exist (the number of a pull request step with `repos` that opened none) leaves the input out;
    // the connector skips then.
    if (
      input.skipsWhenMissing === true &&
      typeof raw === "string" &&
      isMissing(raw, values)
    )
      continue;
    // #1094: with `repos` the title and the body are written once for every repository (below), not once for the step.
    if (perRepo && (name === "title" || name === "body")) continue;
    const resolved =
      typeof raw === "string" && input.type.kind === "string"
        ? renderText(raw, values, undefined, {
            // An input with no root (`target: []`: a board, a status) is a name looked up on the provider by exact equality: it is
            // never a text that is written anywhere, so nothing is put into it.
            defuse: input.target?.length !== 0,
            plain: name === "title",
          })
        : typeof raw === "string"
          ? resolveValue(raw, values)
          : Array.isArray(raw) && holdsList(input.type)
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
  // The pull request step names a branch or the repositories; with neither, the message is the one of the single form (`head` is its input).
  if (
    PULL_REQUEST_OPENING_CONNECTORS.includes(spec.name) &&
    node.head === undefined &&
    node.repos === undefined
  )
    throw new ActionInputError("head is missing.");
  if (perRepo) {
    inputs.repos = (inputs.repos as RepoInput[]).map((entry) => {
      const repoValues: RunValues = {
        ...values,
        repo: {
          fullName: entry.fullName,
          base: entry.base,
          branch: entry.branch,
        },
      };
      const render = (name: "title" | "body"): string | undefined => {
        const raw = node[name];
        if (typeof raw !== "string") return undefined;
        return renderText(raw, repoValues, undefined, {
          defuse: true,
          plain: name === "title",
        });
      };
      const title = render("title");
      const body = render("body");
      return {
        ...entry,
        ...(title === undefined ? {} : { title }),
        ...(body === undefined ? {} : { body }),
      };
    });
    // The texts live in the entries now, one per repository; the connector checks them there like the single form's.
  }
  if (
    spec.atLeastOneOf !== undefined &&
    !spec.atLeastOneOf.some((name) => {
      const given = inputs[name];
      // An empty `repos` is what an agent step that reported no repository gives: a step with nothing to open, not a mistake of the lane.
      if (perRepo && name === "repos") return given !== undefined;
      return Array.isArray(given) ? given.length > 0 : given !== undefined;
    })
  )
    throw new ActionInputError(
      `At least one entry in ${spec.atLeastOneOf.join(" or ")} is needed.`,
    );
  return inputs;
}
