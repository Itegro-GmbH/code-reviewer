// SPDX-License-Identifier: LicenseRef-Proprietary

// The validator of workflow format v1 (#833): a pure function from a JSON document (untrusted, as parsed) to the full list of
// problems. It checks the form (the same form `contracts/workflow.v1.json` states), the ids, every reference against what ran before
// it on every path, the types of the values that flow, the limits, and the profile, environment and connector names against a
// resolver. It never throws on a document and never stops at the first problem; the list is sorted by path.
import { checkSteps, type Checker, type StepState } from "./check-steps.ts";
import { isRecord, jsonTypeName, textLength } from "./json.ts";
import {
  BUDGET_DEFAULT_USD,
  BUDGET_OPERATOR_MAX_USD,
  DESCRIPTION_MAX_LENGTH,
  ERRORS_MAX,
  LABEL_MAX_LENGTH,
  NAME_MAX_LENGTH,
  NESTING_DEPTH_MAX,
  STEPS_MAX,
} from "./limits.ts";
import {
  issue,
  listNames,
  pointer,
  shown,
  sortIssues,
  type Issue,
} from "./issues.ts";
import type { WorkflowResolver } from "./resolver.ts";
import { validateResultSchema, type ResultSchema } from "./result-schema.ts";
import type { Binding, Env, StepInfo } from "./scope.ts";
import {
  TRIGGER_FIELDS,
  TRIGGER_KINDS,
  triggerOutput,
  type TriggerKind,
} from "./triggers.ts";

export type ValidateOptions = {
  /** The most a workflow may be given to spend, in USD: the operator's limit. */
  maxBudgetUsd?: number;
};

export type ValidationResult = {
  valid: boolean;
  /** The problems, sorted by path, `ERRORS_MAX` at most. Empty when `valid`. */
  errors: Issue[];
  /** There are more problems than `errors` lists: the first ones by path are there, fix them and validate again. */
  truncated: boolean;
  /** The budget the workflow runs with: its own, or the default when it names none. Set when `valid`. */
  budgetUsd?: number;
  /** How many steps the document has, counted through branches and loop bodies. */
  steps: number;
};

const DOCUMENT_KEYS = [
  "version",
  "name",
  "description",
  "trigger",
  "budgetUsd",
  "steps",
];

/**
 * Every step of the document by id, in document order, with where it sits; duplicate ids are reported. It goes no deeper than
 * `if` and `loop` may nest: what lies below is never checked, `checkSteps` reports `nesting_too_deep` at the node that goes over,
 * and a walk without that bound would run out of stack on a document that is nothing but nesting.
 */
function indexSteps(
  steps: unknown,
  path: string,
  branches: StepInfo["branches"],
  index: Map<string, StepInfo>,
  report: (found: Issue) => void,
  depth = 0,
): number {
  if (!Array.isArray(steps)) return 0;
  let count = 0;
  steps.forEach((node: unknown, position) => {
    if (!isRecord(node)) return;
    count += 1;
    const at = pointer(path, position);
    const id = node.id;
    if (typeof id === "string") {
      const first = index.get(id);
      if (first !== undefined)
        report(
          issue(
            pointer(at, "id"),
            "duplicate_id",
            `The id ${shown(id)} is already used by the step at ${first.path}. Every step needs its own id, also inside branches and loops.`,
          ),
        );
      else index.set(id, { id, path: at, kind: String(node.kind), branches });
    }
    if (depth + 1 > NESTING_DEPTH_MAX) return;
    if (node.kind === "if") {
      count += indexSteps(
        node.then,
        pointer(at, "then"),
        [...branches, { ifId: String(id), branch: "then" }],
        index,
        report,
        depth + 1,
      );
      count += indexSteps(
        node.else,
        pointer(at, "else"),
        [...branches, { ifId: String(id), branch: "else" }],
        index,
        report,
        depth + 1,
      );
    } else if (node.kind === "loop") {
      count += indexSteps(
        node.body,
        pointer(at, "body"),
        branches,
        index,
        report,
        depth + 1,
      );
    }
  });
  return count;
}

/**
 * A run works on one repository. An issue trigger brings it (`trigger.repo`); a manual one must declare it as the input `repo`, a
 * required text, which the caller hands in.
 */
function checkRepositoryInput(schema: ResultSchema, issues: Issue[]): void {
  const where = "/trigger/input";
  const repo = Object.hasOwn(schema.properties, "repo")
    ? schema.properties.repo
    : undefined;
  if (repo === undefined)
    issues.push(
      issue(
        where,
        "repo_required",
        "A run works on one repository. Declare the input 'repo' (a text, owner/name) in properties and in required: the caller names the repository.",
      ),
    );
  else if (repo.type !== "string")
    issues.push(
      issue(
        pointer(where, "properties", "repo"),
        "repo_required",
        "The input 'repo' is the repository the run works on, owner/name: its type is string.",
      ),
    );
  else if (!(schema.required ?? []).includes("repo"))
    issues.push(
      issue(
        where,
        "repo_required",
        "The input 'repo' is the repository the run works on and must be in required.",
      ),
    );
}

function checkTrigger(
  value: unknown,
  issues: Issue[],
): {
  kind?: TriggerKind;
  input?: ResultSchema;
  inputInvalid?: boolean;
  label?: string;
} {
  const path = "/trigger";
  if (value === undefined) {
    issues.push(
      issue(
        path,
        "missing_field",
        `'trigger' is required: {"kind": ${listNames([...TRIGGER_KINDS])}}.`,
      ),
    );
    return {};
  }
  if (!isRecord(value)) {
    issues.push(
      issue(
        path,
        "wrong_type",
        `'trigger' is an object like {"kind": "manual"}, not ${jsonTypeName(value)}.`,
      ),
    );
    return {};
  }
  const kind = value.kind;
  if (kind === undefined) {
    issues.push(
      issue(
        pointer(path, "kind"),
        "missing_field",
        `'kind' is required. Triggers: ${listNames([...TRIGGER_KINDS])}.`,
        TRIGGER_KINDS,
      ),
    );
    return {};
  }
  if (
    typeof kind !== "string" ||
    !(TRIGGER_KINDS as readonly string[]).includes(kind)
  ) {
    issues.push(
      issue(
        pointer(path, "kind"),
        "unknown_trigger_kind",
        `${typeof kind === "string" ? `There is no trigger ${shown(kind)}` : "'kind' must be a text"}. Triggers: ${listNames([...TRIGGER_KINDS])}.`,
        TRIGGER_KINDS,
      ),
    );
    return {};
  }
  const trigger = kind as TriggerKind;
  const allowed = ["kind", ...TRIGGER_FIELDS[trigger]];
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      issues.push(
        issue(
          pointer(path, key),
          "unknown_field",
          `${shown(key)} is not a field of the trigger '${trigger}'. Fields: ${listNames(allowed)}.`,
          allowed,
        ),
      );
  if (trigger === "github.issueLabeled") {
    const label = value.label;
    if (label === undefined)
      issues.push(
        issue(
          pointer(path, "label"),
          "missing_field",
          "'label' is required: the label that starts the workflow.",
        ),
      );
    else if (typeof label !== "string")
      issues.push(
        issue(pointer(path, "label"), "wrong_type", "'label' is a text."),
      );
    else if (
      textLength(label) < 1 ||
      textLength(label) > LABEL_MAX_LENGTH ||
      label.trim() === ""
    )
      issues.push(
        issue(
          pointer(path, "label"),
          "invalid_value",
          `'label' has 1 to ${LABEL_MAX_LENGTH} characters and is not only spaces.`,
        ),
      );
    else return { kind: trigger, label };
    return { kind: trigger };
  }
  if (value.input === undefined) {
    issues.push(
      issue(
        path,
        "repo_required",
        "A manual trigger needs 'input', a result schema for what the caller hands in. It must declare 'repo' (a required text, owner/name): the repository the run works on.",
      ),
    );
    return { kind: trigger };
  }
  const checked = validateResultSchema(value.input, pointer(path, "input"));
  issues.push(...checked.issues);
  if (checked.schema !== undefined)
    checkRepositoryInput(checked.schema, issues);
  return {
    kind: trigger,
    input: checked.schema,
    inputInvalid: checked.schema === undefined,
  };
}

function checkBudget(
  value: unknown,
  maximum: number,
  issues: Issue[],
): number | undefined {
  const path = "/budgetUsd";
  if (value === undefined) return BUDGET_DEFAULT_USD;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push(
      issue(path, "wrong_type", "'budgetUsd' is a number of US dollars."),
    );
    return undefined;
  }
  if (value <= 0) {
    issues.push(
      issue(path, "invalid_value", "'budgetUsd' must be more than 0."),
    );
    return undefined;
  }
  if (value > maximum) {
    issues.push(
      issue(
        path,
        "budget_above_maximum",
        `'budgetUsd' is ${value}; the most a workflow may be given here is ${maximum}.`,
      ),
    );
    return undefined;
  }
  return value;
}

/** What `trigger.*` holds; unknown where the trigger itself failed the check, so one mistake is reported once. */
function triggerType(
  trigger: ReturnType<typeof checkTrigger>,
): Binding["type"] {
  if (trigger.kind === undefined) return { kind: "unknown" };
  if (trigger.inputInvalid === true)
    return {
      kind: "object",
      fields: { input: { type: { kind: "unknown" }, required: true } },
    };
  return triggerOutput(trigger.kind, trigger.input);
}

/** Checks a workflow document. See the header for what is checked. */
export function validateWorkflow(
  document: unknown,
  resolver: WorkflowResolver,
  options: ValidateOptions = {},
): ValidationResult {
  if (!isRecord(document))
    return {
      valid: false,
      steps: 0,
      truncated: false,
      errors: [
        issue(
          "",
          "wrong_type",
          `A workflow is an object like {"version": 1, "name": …, "trigger": …, "steps": […]}, not ${jsonTypeName(document)}.`,
        ),
      ],
    };
  const issues: Issue[] = [];
  const report = (found: Issue): void => void issues.push(found);

  for (const key of Object.keys(document))
    if (!DOCUMENT_KEYS.includes(key))
      issues.push(
        issue(
          pointer("", key),
          "unknown_field",
          `${shown(key)} is not a field of a workflow. Fields: ${listNames(DOCUMENT_KEYS)}.`,
          DOCUMENT_KEYS,
        ),
      );

  if (document.version === undefined)
    issues.push(
      issue("/version", "missing_field", "'version' is required: 1."),
    );
  else if (document.version !== 1)
    issues.push(
      issue(
        "/version",
        "invalid_value",
        "This validator knows format version 1.",
        ["1"],
      ),
    );

  const name = document.name;
  if (name === undefined)
    issues.push(
      issue(
        "/name",
        "missing_field",
        "'name' is required: a short name, unique in the workspace.",
      ),
    );
  else if (typeof name !== "string")
    issues.push(issue("/name", "wrong_type", "'name' is a text."));
  else if (name.trim() === "" || textLength(name) > NAME_MAX_LENGTH)
    issues.push(
      issue(
        "/name",
        "invalid_value",
        `'name' has 1 to ${NAME_MAX_LENGTH} characters and is not only spaces.`,
      ),
    );
  if (document.description !== undefined) {
    if (typeof document.description !== "string")
      issues.push(
        issue("/description", "wrong_type", "'description' is a text."),
      );
    else if (textLength(document.description) > DESCRIPTION_MAX_LENGTH)
      issues.push(
        issue(
          "/description",
          "limit_exceeded",
          `'description' may have ${DESCRIPTION_MAX_LENGTH} characters at most.`,
        ),
      );
  }

  const index = new Map<string, StepInfo>();
  const stepCount = indexSteps(document.steps, "/steps", [], index, report);
  if (stepCount > STEPS_MAX)
    issues.push(
      issue(
        "/steps",
        "too_many_steps",
        `The workflow has ${stepCount} steps; at most ${STEPS_MAX}.`,
      ),
    );

  const trigger = checkTrigger(document.trigger, issues);
  const checker: Checker = {
    resolver,
    index,
    report,
    ...(trigger.label === undefined ? {} : { triggerLabel: trigger.label }),
  };
  const budget = checkBudget(
    document.budgetUsd,
    options.maxBudgetUsd ?? BUDGET_OPERATOR_MAX_USD,
    issues,
  );

  if (document.steps === undefined)
    issues.push(
      issue(
        "/steps",
        "missing_field",
        "'steps' is required: the list of steps, run in order.",
      ),
    );
  else {
    const triggerBinding: Binding = {
      id: "trigger",
      kind: "trigger",
      type: triggerType(trigger),
      unavailable: {},
    };
    const env: Env = {
      scope: new Map([["trigger", triggerBinding]]),
      loops: [],
    };
    const state: StepState = {
      depth: 0,
      loopDepth: 0,
      branches: [],
      inLoopBody: false,
    };
    checkSteps(document.steps, "/steps", checker, env, state);
  }

  const found = sortIssues(issues);
  const errors = found.slice(0, ERRORS_MAX);
  return {
    valid: found.length === 0,
    errors,
    truncated: found.length > errors.length,
    steps: stepCount,
    ...(errors.length === 0 && budget !== undefined
      ? { budgetUsd: budget }
      : {}),
  };
}
