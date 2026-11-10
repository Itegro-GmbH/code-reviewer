// SPDX-License-Identifier: LicenseRef-Proprietary

// The validator of workflow format v1 (#833): a pure function from a JSON document (untrusted, as parsed) to the full list of
// problems. It checks the form (the same form `contracts/workflow.v1.json` states), the ids, every reference against what ran before
// it on every path, the types of the values that flow, the limits, and the profile, environment and connector names against a
// resolver. It never throws on a document and never stops at the first problem; the list is sorted by path.
import {
  checkSteps,
  ID_PATTERN,
  type Checker,
  type StepState,
} from "./check-steps.ts";
import { FAILURE_ID, FAILURE_TYPE } from "./failure.ts";
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
  TRIGGERS_MAX,
  TURN_TIME_LIMIT_MINUTES_DEFAULT,
  TURN_TIME_LIMIT_MINUTES_MAX,
  TURN_TIME_LIMIT_MINUTES_MIN,
} from "./limits.ts";
import {
  IssueSink,
  isWarning,
  issue,
  listNames,
  pointer,
  shown,
  sortIssues,
  type Issue,
} from "./issues.ts";
import type { WorkflowResolver } from "./resolver.ts";
import { validateResultSchema, type ResultSchema } from "./result-schema.ts";
import { Scope, type Binding, type Env, type StepInfo } from "./scope.ts";
import {
  TICKET_INPUT,
  TRIGGER_FIELDS,
  TRIGGER_KINDS,
  canonicalTriggerKind,
  commonTriggerType,
  declaresTicket,
  legacyTriggerId,
  triggerOutput,
  type TriggerKind,
} from "./triggers.ts";

type Report = (found: Issue) => void;

export type ValidateOptions = {
  /** The most a workflow may be given to spend, in USD: the operator's limit. */
  maxBudgetUsd?: number;
  /**
   * For the scope lookup (`reach.ts`): called with where every node sits and what it can reach (see `Checker.probe`). `done` ends the
   * check as soon as it is true, so a lookup does not read the rest of the document.
   */
  probe?: Checker["probe"];
  done?: () => boolean;
};

export type ValidationResult = {
  valid: boolean;
  /** The problems, sorted by path, `ERRORS_MAX` at most. Empty when `valid`. */
  errors: Issue[];
  /** There are more problems than `errors` lists (the check stops once it has a few more than that): fix these and validate again. */
  truncated: boolean;
  /** What is said and does not stop a save (`severity: "warning"`, #973), in the shape of an error. Left out when there is none. */
  warnings?: Issue[];
  /** The budget the workflow runs with: its own, or the default when it names none. Set when `valid`. */
  budgetUsd?: number;
  /** The time one agent turn may run, in minutes: its own, or the default when the document names none (#918). Set when `valid`. */
  turnTimeLimitMinutes?: number;
  /** How many steps the document has, counted through branches and loop bodies. */
  steps: number;
};

const DOCUMENT_KEYS = [
  "version",
  "name",
  "description",
  "trigger",
  "triggers",
  "budgetUsd",
  "turnTimeLimitMinutes",
  "steps",
  "onFailure",
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
  preStepOf?: StepInfo["preStepOf"],
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
      else
        index.set(id, {
          id,
          path: at,
          kind: String(node.kind),
          branches,
          ...(preStepOf === undefined ? {} : { preStepOf }),
        });
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
        preStepOf,
      );
      count += indexSteps(
        node.else,
        pointer(at, "else"),
        [...branches, { ifId: String(id), branch: "else" }],
        index,
        report,
        depth + 1,
        preStepOf,
      );
    } else if (node.kind === "loop") {
      count += indexSteps(
        node.body,
        pointer(at, "body"),
        branches,
        index,
        report,
        depth + 1,
        preStepOf,
      );
    }
  });
  return count;
}

const TRIGGER_ID_RESERVED = ["trigger", "previous"] as const;
const CRON = /^[^\s]+( [^\s]+){4}$/;
const CRON_MAX_LENGTH = 100;

/**
 * A run works on one repository. A label trigger brings it (the ticket's); a manual or api one gets it from its input: a required
 * `ticket` (the run works in the repository of the ticket) or, as before #916, a required text `repo` (owner/name).
 */
function checkRepositoryInput(
  schema: ResultSchema,
  where: string,
  report: Report,
): void {
  if (declaresTicket(schema)) {
    if (!(schema.required ?? []).includes(TICKET_INPUT))
      report(
        issue(
          where,
          "repo_required",
          `The input '${TICKET_INPUT}' is the ticket the run is about and the repository it works in: it must be in required.`,
        ),
      );
    return;
  }
  const repo = Object.hasOwn(schema.properties, "repo")
    ? schema.properties.repo
    : undefined;
  if (repo === undefined)
    report(
      issue(
        where,
        "repo_required",
        "A run works on one repository. Declare the input 'ticket' (type ticket, in required): the run works in the repository of the ticket. Or declare the input 'repo' (a text, owner/name) in properties and in required: the caller names the repository.",
      ),
    );
  else if (repo.type !== "string")
    report(
      issue(
        pointer(where, "properties", "repo"),
        "repo_required",
        "The input 'repo' is the repository the run works on, owner/name: its type is string.",
      ),
    );
  else if (!(schema.required ?? []).includes("repo"))
    report(
      issue(
        where,
        "repo_required",
        "The input 'repo' is the repository the run works on and must be in required.",
      ),
    );
}

/** A trigger as the validator holds it once its form is checked; what failed its own check is left out. */
type CheckedTrigger = {
  /** Pointer of the trigger node. */
  path: string;
  id: string;
  kind?: TriggerKind;
  input?: ResultSchema;
  inputInvalid?: boolean;
  label?: string;
  /** The pre-steps as written (not checked yet) and where they are. */
  steps: unknown;
  stepsPath: string;
};

/**
 * One trigger node. `legacy` is the single `trigger` of a document written before #916: it has no `id` and no `steps`, and its pointers
 * are the ones they always were.
 */
function checkTrigger(
  value: unknown,
  path: string,
  legacy: boolean,
  seenIds: Map<string, string>,
  report: Report,
): CheckedTrigger {
  const checked: CheckedTrigger = {
    path,
    id: "",
    steps: undefined,
    stepsPath: pointer(path, "steps"),
  };
  if (!isRecord(value)) {
    report(
      issue(
        path,
        "wrong_type",
        legacy
          ? `'trigger' is an object like {"kind": "manual"}, not ${jsonTypeName(value)}.`
          : `A trigger is an object like {"id": "manual", "kind": "manual", "input": …, "steps": […]}, not ${jsonTypeName(value)}.`,
      ),
    );
    return checked;
  }
  if (!legacy) checkTriggerId(value.id, path, seenIds, report, checked);
  checked.steps = value.steps;
  const kind = value.kind;
  if (kind === undefined) {
    report(
      issue(
        pointer(path, "kind"),
        "missing_field",
        `'kind' is required. Triggers: ${listNames([...TRIGGER_KINDS])}.`,
        TRIGGER_KINDS,
      ),
    );
    return checked;
  }
  if (
    typeof kind !== "string" ||
    !(TRIGGER_KINDS as readonly string[]).includes(kind)
  ) {
    report(
      issue(
        pointer(path, "kind"),
        "unknown_trigger_kind",
        `${typeof kind === "string" ? `There is no trigger ${shown(kind)}` : "'kind' must be a text"}. Triggers: ${listNames([...TRIGGER_KINDS])}.`,
        TRIGGER_KINDS,
      ),
    );
    return checked;
  }
  const trigger = kind as TriggerKind;
  checked.kind = trigger;
  if (legacy) checked.id = legacyTriggerId(trigger);
  const allowed = legacy
    ? ["kind", ...TRIGGER_FIELDS[trigger]]
    : ["id", "kind", ...TRIGGER_FIELDS[trigger], "steps"];
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      report(
        issue(
          pointer(path, key),
          "unknown_field",
          `${shown(key)} is not a field of the trigger '${trigger}'. Fields: ${listNames(allowed)}.`,
          allowed,
        ),
      );
  if (canonicalTriggerKind(trigger) === "ticket.labeled") {
    const label = value.label;
    if (label === undefined)
      report(
        issue(
          pointer(path, "label"),
          "missing_field",
          "'label' is required: the label that starts the workflow.",
        ),
      );
    else if (typeof label !== "string")
      report(issue(pointer(path, "label"), "wrong_type", "'label' is a text."));
    else if (
      textLength(label) < 1 ||
      textLength(label) > LABEL_MAX_LENGTH ||
      label.trim() === ""
    )
      report(
        issue(
          pointer(path, "label"),
          "invalid_value",
          `'label' has 1 to ${LABEL_MAX_LENGTH} characters and is not only spaces.`,
        ),
      );
    else checked.label = label;
    return checked;
  }
  if (trigger === "schedule") {
    const cron = value.cron;
    if (cron === undefined)
      report(
        issue(
          pointer(path, "cron"),
          "missing_field",
          "'cron' is required: five fields separated by one space, like \"0 6 * * 1\". The schedule is reserved: it is checked, and no run starts from it yet.",
        ),
      );
    else if (typeof cron !== "string")
      report(issue(pointer(path, "cron"), "wrong_type", "'cron' is a text."));
    else if (textLength(cron) > CRON_MAX_LENGTH || !CRON.test(cron))
      report(
        issue(
          pointer(path, "cron"),
          "invalid_value",
          "'cron' has five fields (minute, hour, day of month, month, day of week) separated by one space.",
        ),
      );
    return checked;
  }
  if (trigger === "manual" || trigger === "api") {
    const where = pointer(path, "input");
    if (value.input === undefined) {
      report(
        issue(
          path,
          "repo_required",
          `A ${trigger} trigger needs 'input', a result schema for what the caller hands in. It must declare 'ticket' (type ticket, required: the run works in the repository of the ticket) or 'repo' (a required text, owner/name): the repository the run works on.`,
        ),
      );
      return checked;
    }
    const result = validateResultSchema(value.input, where, {
      allowTicket: true,
    });
    for (const found of result.issues) report(found);
    if (result.schema !== undefined)
      checkRepositoryInput(result.schema, where, report);
    checked.input = result.schema;
    checked.inputInvalid = result.schema === undefined;
  }
  return checked;
}

function checkTriggerId(
  id: unknown,
  path: string,
  seen: Map<string, string>,
  report: Report,
  into: CheckedTrigger,
): void {
  const where = pointer(path, "id");
  if (id === undefined) {
    report(
      issue(
        where,
        "missing_field",
        "'id' is required: a name for the trigger, unique among the triggers (the start API takes it as \"trigger\").",
      ),
    );
    return;
  }
  if (
    typeof id !== "string" ||
    !ID_PATTERN.test(id) ||
    (TRIGGER_ID_RESERVED as readonly string[]).includes(id)
  ) {
    report(
      issue(
        where,
        typeof id === "string" ? "invalid_value" : "wrong_type",
        `'id' is a letter, then letters, digits, '_' or '-' (at most 64); 'trigger' and 'previous' are taken.`,
      ),
    );
    return;
  }
  const first = seen.get(id);
  if (first !== undefined)
    report(
      issue(
        where,
        "duplicate_id",
        `The trigger id ${shown(id)} is already used by the trigger at ${first}. Every trigger needs its own id.`,
      ),
    );
  else seen.set(id, path);
  into.id = id;
}

function canonicalOf(trigger: CheckedTrigger): string | undefined {
  return trigger.kind === undefined
    ? undefined
    : canonicalTriggerKind(trigger.kind);
}

/** `trigger` (one, as before #916) or `triggers` (several, each with pre-steps), as a list of triggers; both at once is refused. */
/** Two label triggers that wait for one label would start two runs for one event: the second is reported, naming the first. */
function checkDuplicateLabels(
  triggers: readonly CheckedTrigger[],
  report: Report,
): void {
  const first = new Map<string, string>();
  for (const [position, trigger] of triggers.entries()) {
    if (
      trigger.kind === undefined ||
      canonicalTriggerKind(trigger.kind) !== "ticket.labeled" ||
      trigger.label === undefined
    )
      continue;
    const key = trigger.label.trim().toLowerCase();
    const earlier = first.get(key);
    if (earlier === undefined) {
      first.set(key, trigger.id === "" ? `#${position + 1}` : trigger.id);
      continue;
    }
    report(
      issue(
        pointer(trigger.path, "label"),
        "duplicate_trigger_label",
        `The label ${shown(trigger.label)} already starts the workflow through the trigger ${shown(earlier)}. Two triggers waiting for one label would start two runs for one event: give this one another label.`,
      ),
    );
  }
}

function checkTriggers(
  document: Record<string, unknown>,
  report: Report,
): CheckedTrigger[] {
  const seen = new Map<string, string>();
  if (document.triggers !== undefined) {
    if (document.trigger !== undefined)
      report(
        issue(
          "/trigger",
          "invalid_value",
          "A workflow has 'triggers' (a list) or the single 'trigger' of the older form, not both.",
        ),
      );
    const list = document.triggers;
    if (!Array.isArray(list)) {
      report(
        issue(
          "/triggers",
          "wrong_type",
          `'triggers' is a list of triggers, not ${jsonTypeName(list)}.`,
        ),
      );
      return [];
    }
    if (list.length === 0)
      report(
        issue(
          "/triggers",
          "invalid_value",
          "'triggers' needs at least one trigger.",
        ),
      );
    if (list.length > TRIGGERS_MAX)
      report(
        issue(
          "/triggers",
          "limit_exceeded",
          `A workflow has ${TRIGGERS_MAX} triggers at most; this one has ${list.length}.`,
        ),
      );
    return list
      .slice(0, TRIGGERS_MAX)
      .map((value: unknown, position) =>
        checkTrigger(
          value,
          pointer("/triggers", position),
          false,
          seen,
          report,
        ),
      );
  }
  if (document.trigger === undefined) {
    report(
      issue(
        "/trigger",
        "missing_field",
        `'triggers' is required: a list of triggers, each {"id": …, "kind": ${listNames([...TRIGGER_KINDS])}}. (A single 'trigger' of the older form is read as a list of one.)`,
      ),
    );
    return [];
  }
  return [checkTrigger(document.trigger, "/trigger", true, seen, report)];
}

function checkBudget(
  value: unknown,
  maximum: number,
  report: Report,
): number | undefined {
  const path = "/budgetUsd";
  if (value === undefined) return BUDGET_DEFAULT_USD;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    report(issue(path, "wrong_type", "'budgetUsd' is a number of US dollars."));
    return undefined;
  }
  if (value <= 0) {
    report(issue(path, "invalid_value", "'budgetUsd' must be more than 0."));
    return undefined;
  }
  if (value > maximum) {
    report(
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

function checkTurnTimeLimit(
  value: unknown,
  report: Report,
): number | undefined {
  const path = "/turnTimeLimitMinutes";
  if (value === undefined) return TURN_TIME_LIMIT_MINUTES_DEFAULT;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    report(
      issue(
        path,
        "wrong_type",
        "'turnTimeLimitMinutes' is a whole number of minutes.",
      ),
    );
    return undefined;
  }
  if (
    !Number.isInteger(value) ||
    value < TURN_TIME_LIMIT_MINUTES_MIN ||
    value > TURN_TIME_LIMIT_MINUTES_MAX
  ) {
    report(
      issue(
        path,
        "invalid_value",
        `'turnTimeLimitMinutes' is a whole number of minutes from ${TURN_TIME_LIMIT_MINUTES_MIN} to ${TURN_TIME_LIMIT_MINUTES_MAX}; it is ${value}.`,
      ),
    );
    return undefined;
  }
  return value;
}

/** What `trigger.*` holds for one trigger; unknown where the trigger itself failed the check, so one mistake is reported once. */
function triggerType(trigger: CheckedTrigger): Binding["type"] {
  if (trigger.kind === undefined) return { kind: "unknown" };
  const full = triggerOutput({
    id: trigger.id,
    kind: trigger.kind,
    ...(trigger.input === undefined ? {} : { input: trigger.input }),
  });
  if (trigger.inputInvalid === true)
    return {
      kind: "object",
      fields: {
        ...full.fields,
        input: { type: { kind: "unknown" }, required: true },
      },
    };
  return full;
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
  const sink = new IssueSink();
  const report = sink.report;

  for (const key of Object.keys(document))
    if (!DOCUMENT_KEYS.includes(key))
      report(
        issue(
          pointer("", key),
          "unknown_field",
          `${shown(key)} is not a field of a workflow. Fields: ${listNames(DOCUMENT_KEYS)}.`,
          DOCUMENT_KEYS,
        ),
      );

  if (document.version === undefined)
    report(issue("/version", "missing_field", "'version' is required: 1."));
  else if (document.version !== 1)
    report(
      issue(
        "/version",
        "invalid_value",
        "This validator knows format version 1.",
        ["1"],
      ),
    );

  const name = document.name;
  if (name === undefined)
    report(
      issue(
        "/name",
        "missing_field",
        "'name' is required: a short name, unique in the workspace.",
      ),
    );
  else if (typeof name !== "string")
    report(issue("/name", "wrong_type", "'name' is a text."));
  else if (name.trim() === "" || textLength(name) > NAME_MAX_LENGTH)
    report(
      issue(
        "/name",
        "invalid_value",
        `'name' has 1 to ${NAME_MAX_LENGTH} characters and is not only spaces.`,
      ),
    );
  if (document.description !== undefined) {
    if (typeof document.description !== "string")
      report(issue("/description", "wrong_type", "'description' is a text."));
    else if (textLength(document.description) > DESCRIPTION_MAX_LENGTH)
      report(
        issue(
          "/description",
          "limit_exceeded",
          `'description' may have ${DESCRIPTION_MAX_LENGTH} characters at most.`,
        ),
      );
  }

  const triggers = checkTriggers(document, report);
  checkDuplicateLabels(triggers, report);
  const budget = checkBudget(
    document.budgetUsd,
    options.maxBudgetUsd ?? BUDGET_OPERATOR_MAX_USD,
    report,
  );
  const turnTimeLimit = checkTurnTimeLimit(
    document.turnTimeLimitMinutes,
    report,
  );

  // One index for the pre-steps of every trigger and the shared steps: an id is used once in the whole document (#916).
  const index = new Map<string, StepInfo>();
  let stepCount = 0;
  for (const [position, trigger] of triggers.entries())
    stepCount += indexSteps(
      trigger.steps,
      trigger.stepsPath,
      [],
      index,
      report,
      0,
      {
        id: trigger.id === "" ? `#${position + 1}` : trigger.id,
        path: trigger.stepsPath,
      },
    );
  stepCount += indexSteps(document.steps, "/steps", [], index, report);
  if (document.onFailure !== undefined)
    stepCount += indexSteps(
      document.onFailure,
      "/onFailure",
      [],
      index,
      report,
    );
  if (stepCount > STEPS_MAX)
    report(
      issue(
        "/steps",
        "too_many_steps",
        `The workflow has ${stepCount} steps; at most ${STEPS_MAX}.`,
      ),
    );

  // The labels that start the workflow: a step may not add one of them, except in the pre-steps of a trigger that is no label trigger.
  const retriggerLabels = triggers.flatMap((trigger) =>
    trigger.label === undefined ? [] : [trigger.label.trim().toLowerCase()],
  );
  const checker: Checker = {
    resolver,
    index,
    report,
    halted:
      options.done === undefined
        ? sink.halted
        : () => sink.halted() || options.done?.() === true,
    retriggerLabels,
    ...(options.probe === undefined ? {} : { probe: options.probe }),
  };
  const state: StepState = {
    depth: 0,
    loopDepth: 0,
    branches: [],
    inLoopBody: false,
    onFailure: false,
  };
  const bindingOf = (trigger: CheckedTrigger): Binding => ({
    id: "trigger",
    kind: "trigger",
    type: triggerType(trigger),
    unavailable: {},
    ...(trigger.inputInvalid === true ? { open: true } : {}),
  });
  // The pre-steps of each trigger see that trigger's own values and run before the shared steps.
  for (const trigger of triggers) {
    if (!Array.isArray(trigger.steps) && trigger.steps === undefined) continue;
    if (Array.isArray(trigger.steps) && trigger.steps.length === 0) continue;
    const scope = new Scope();
    scope.set("trigger", bindingOf(trigger));
    const own: Checker =
      canonicalOf(trigger) === "ticket.labeled"
        ? {
            ...checker,
            retriggerLabels:
              trigger.label === undefined
                ? []
                : [trigger.label.trim().toLowerCase()],
          }
        : { ...checker, retriggerLabels: [] };
    checkSteps(
      trigger.steps,
      trigger.stepsPath,
      own,
      { scope, loops: [] },
      state,
    );
  }
  // What the shared steps may read of the trigger is what all of them yield.
  const types = triggers.map((trigger) => triggerType(trigger));
  const triggerBinding: Binding = {
    id: "trigger",
    kind: "trigger",
    type:
      triggers.length === 0 ? { kind: "unknown" } : commonTriggerType(types),
    unavailable: {},
    ...(triggers.some((trigger) => trigger.inputInvalid === true)
      ? { open: true }
      : {}),
    ...(triggers.length > 1
      ? {
          triggers: triggers.map((trigger, position) => ({
            id: trigger.id === "" ? `#${position + 1}` : trigger.id,
            type: types[position] as Binding["type"],
          })),
        }
      : {}),
  };
  if (document.steps === undefined)
    report(
      issue(
        "/steps",
        "missing_field",
        "'steps' is required: the list of steps, run in order.",
      ),
    );
  else {
    const scope = new Scope();
    scope.set("trigger", triggerBinding);
    const env: Env = { scope, loops: [] };
    checkSteps(document.steps, "/steps", checker, env, state);
    // #902: the steps that run after a failure see the trigger, the facts of the failure and each other, none of the steps above.
    if (document.onFailure !== undefined) {
      const failureScope = new Scope();
      failureScope.set("trigger", triggerBinding);
      failureScope.set(FAILURE_ID, {
        id: FAILURE_ID,
        kind: "failure",
        type: FAILURE_TYPE,
        unavailable: {},
      });
      checkSteps(
        document.onFailure,
        "/onFailure",
        checker,
        { scope: failureScope, loops: [] },
        { ...state, onFailure: true },
      );
    }
  }

  const found = sortIssues(sink.issues.filter((each) => !isWarning(each)));
  const warnings = sortIssues(sink.issues.filter(isWarning)).slice(
    0,
    ERRORS_MAX,
  );
  const errors = found.slice(0, ERRORS_MAX);
  return {
    valid: found.length === 0,
    errors,
    truncated: sink.full || found.length > errors.length,
    ...(warnings.length === 0 ? {} : { warnings }),
    steps: stepCount,
    ...(errors.length === 0 && budget !== undefined
      ? { budgetUsd: budget }
      : {}),
    ...(errors.length === 0 && turnTimeLimit !== undefined
      ? { turnTimeLimitMinutes: turnTimeLimit }
      : {}),
  };
}
