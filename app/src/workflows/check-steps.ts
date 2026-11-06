// SPDX-License-Identifier: LicenseRef-Proprietary

// The steps of a workflow in the order they run (#833): the shape of each node, and everything that depends on what ran before it.
// `check-values.ts` checks the texts and values, `scope.ts` what a reference can reach.
import {
  harnessNeedsRunner,
  harnessOfProfile,
} from "../runner-identity/harness.ts";
import {
  checkCondition,
  checkInput,
  checkLiteral,
  checkText,
  type TargetCheck,
} from "./check-values.ts";
import { COST_FACT, FACT_NAMES, FACT_TYPES, PUSH_FACTS } from "./facts.ts";
import {
  FAILURE_ID,
  ON_FAILURE_CONNECTORS,
  ON_FAILURE_KINDS,
} from "./failure.ts";
import { isRecord, jsonTypeName, textLength } from "./json.ts";
import {
  DESCRIPTION_MAX_LENGTH,
  ID_MAX_LENGTH,
  LOOP_NESTING_MAX,
  LOOP_ROUNDS_MAX,
  NAMES_LISTED_MAX,
  NESTING_DEPTH_MAX,
} from "./limits.ts";
import { issue, listNames, pointer, shown } from "./issues.ts";
import {
  parseProfileRef,
  type ProfileInfo,
  type ProfileVersionFacts,
  type WorkflowResolver,
} from "./resolver.ts";
import {
  objectTypeOf,
  validateResultSchema,
  type ResultSchema,
} from "./result-schema.ts";
import { GITHUB_ISSUE_LABELS, type ConnectorSpec } from "./connectors.ts";
import { literalText, parseTemplate } from "./template.ts";
import {
  firstOf,
  type Binding,
  type Env,
  type LoopFrame,
  type ScopeContext,
  type StepInfo,
  type Use,
} from "./scope.ts";
import {
  enumOf,
  NUMBER,
  objectOf,
  STRING,
  type FieldType,
} from "./value-type.ts";

export const SUPPORTED_KINDS = ["agent", "action", "if", "loop"] as const;
/** Named in the format so a document can use them later; version 1 refuses them. */
export const RESERVED_KINDS = ["forEach", "approval", "workflow"] as const;
export const ID_PATTERN = new RegExp(
  `^[A-Za-z][A-Za-z0-9_-]{0,${ID_MAX_LENGTH - 1}}$`,
);
const RESERVED_IDS = ["trigger", "previous"] as const;

/** `failure` is taken in `onFailure` only: a step of the workflow called so keeps working, nothing there reads the failure. */
function isStepId(id: string, onFailure: boolean): boolean {
  return (
    ID_PATTERN.test(id) &&
    !(RESERVED_IDS as readonly string[]).includes(id) &&
    !(onFailure && id === FAILURE_ID)
  );
}
const COMMON_KEYS = ["id", "kind", "description"] as const;

export type Checker = ScopeContext & {
  resolver: WorkflowResolver;
  /** The label that starts the workflow, when the trigger has one and it is well formed. */
  triggerLabel?: string;
};

export type StepState = {
  depth: number;
  loopDepth: number;
  branches: StepInfo["branches"];
  /** The list being checked is the body of a loop, not a branch of an `if` inside one. */
  inLoopBody: boolean;
  /** The list is `onFailure` or inside it (#902): actions and `if` only, and no step of the workflow in reach. */
  onFailure: boolean;
};

function keysOf(
  node: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  c: Checker,
): void {
  for (const key of Object.keys(node))
    if (!allowed.includes(key))
      c.report(
        issue(
          pointer(path, key),
          "unknown_field",
          `${shown(key)} is not a field of this node. Fields: ${listNames(allowed)}.`,
          allowed,
        ),
      );
}

function missing(path: string, key: string, hint: string, c: Checker): void {
  c.report(
    issue(pointer(path, key), "missing_field", `'${key}' is required: ${hint}`),
  );
}

/** Reads a string field; reports a wrong type or a missing key. */
function stringField(
  node: Record<string, unknown>,
  key: string,
  path: string,
  hint: string,
  c: Checker,
  required = true,
): string | undefined {
  const value = node[key];
  if (value === undefined) {
    if (required) missing(path, key, hint, c);
    return undefined;
  }
  if (typeof value !== "string") {
    c.report(
      issue(
        pointer(path, key),
        "wrong_type",
        `${shown(key)} must be a text, not ${jsonTypeName(value)}. ${hint}`,
      ),
    );
    return undefined;
  }
  return value;
}

function descriptionField(
  node: Record<string, unknown>,
  path: string,
  c: Checker,
): void {
  const text = stringField(
    node,
    "description",
    path,
    "A short note.",
    c,
    false,
  );
  if (text !== undefined && textLength(text) > DESCRIPTION_MAX_LENGTH)
    c.report(
      issue(
        pointer(path, "description"),
        "limit_exceeded",
        `description may have ${DESCRIPTION_MAX_LENGTH} characters at most.`,
      ),
    );
}

// ---- what a step yields -------------------------------------------------------------------------------------------------

function findProfile(
  ref: unknown,
  resolver: WorkflowResolver,
): { info: ProfileInfo; facts: ProfileVersionFacts | undefined } | undefined {
  if (typeof ref !== "string") return undefined;
  const parsed = parseProfileRef(ref);
  if (parsed === undefined) return undefined;
  const info = resolver.profiles().find((p) => p.name === parsed.name);
  if (info === undefined) return undefined;
  // The version the step runs: the one it names, else the newest. A version that does not exist is reported where it is written; its
  // facts are the newest's, so one mistake is not reported at every use. A version that exists and has no facts is not known.
  const newest = info.versions[info.versions.length - 1];
  const version =
    parsed.version !== undefined && info.versions.includes(parsed.version)
      ? parsed.version
      : newest;
  return {
    info,
    facts: version === undefined ? undefined : info.facts[version],
  };
}

/** The profile name and the environment (lower case, a literal only) an agent step is written with: what makes two steps share a session. */
function setupOf(node: Record<string, unknown>): NonNullable<Binding["agent"]> {
  const environment =
    typeof node.environment === "string"
      ? literalText(parseTemplate(node.environment))?.toLowerCase()
      : undefined;
  const profile =
    typeof node.profile === "string"
      ? parseProfileRef(node.profile)?.name
      : undefined;
  return {
    ...(profile === undefined ? {} : { profile }),
    ...(environment === undefined ? {} : { environment }),
  };
}

/** What an agent step yields: its declared result, and the facts. Silent: the checks report. */
export function agentBinding(
  node: Record<string, unknown>,
  resolver: WorkflowResolver,
): Binding {
  const id = node.id as string;
  const found = findProfile(node.profile, resolver);
  // A profile nobody knows is reported where it is written; its facts stay, so one mistake is not reported at every use.
  const canPush = found?.facts?.canPush ?? true;
  const declared =
    node.result === undefined
      ? undefined
      : validateResultSchema(node.result).schema;
  const schema: ResultSchema | undefined =
    declared ??
    (node.result === undefined ? found?.facts?.defaultResult : undefined);

  const entries: [string, FieldType][] =
    schema === undefined
      ? []
      : Object.entries(objectTypeOf(schema).fields).filter(
          ([name]) => !FACT_NAMES.includes(name),
        );
  const facts = canPush ? [COST_FACT, ...PUSH_FACTS] : [COST_FACT];
  for (const name of facts)
    entries.push([
      name,
      { type: FACT_TYPES[name] as FieldType["type"], required: true },
    ]);
  const fields: Record<string, FieldType> = Object.fromEntries(entries);
  const reason = `The profile ${shown(String(node.profile))} may not push, so ${shown(id)} yields no branch, no commits, no head commit and no push state. Use a profile that may push, or reference the result of the step.`;
  return {
    id,
    kind: "agent",
    type: { kind: "object", fields },
    unavailable: canPush
      ? {}
      : Object.fromEntries(PUSH_FACTS.map((name) => [name, reason])),
    // A result that failed its check is reported where it is written; its fields are unknown, not missing.
    ...(node.result !== undefined && declared === undefined
      ? { open: true }
      : {}),
    agent: setupOf(node),
  };
}

function connectorOf(
  node: Record<string, unknown>,
  resolver: WorkflowResolver,
): ConnectorSpec | undefined {
  return typeof node.connector === "string"
    ? resolver.connectors().find((spec) => spec.name === node.connector)
    : undefined;
}

export function actionBinding(
  node: Record<string, unknown>,
  resolver: WorkflowResolver,
): Binding {
  const spec = connectorOf(node, resolver);
  return {
    id: node.id as string,
    kind: "action",
    type: spec?.output ?? { kind: "unknown" },
    unavailable: {},
  };
}

const IF_OUTPUT = objectOf({ taken: enumOf("then", "else") });
const LOOP_OUTPUT = objectOf({
  exit: enumOf("until", "maxRounds", "budget"),
  rounds: NUMBER,
});

/** The value of a node without checking it, for `previous.` (which names steps that come later in the body). */
function previewBinding(
  node: unknown,
  resolver: WorkflowResolver,
): Binding | undefined {
  if (!isRecord(node) || typeof node.id !== "string") return undefined;
  switch (node.kind) {
    case "agent":
      return agentBinding(node, resolver);
    case "action":
      return actionBinding(node, resolver);
    case "if":
      return { id: node.id, kind: "if", type: IF_OUTPUT, unavailable: {} };
    case "loop":
      return { id: node.id, kind: "loop", type: LOOP_OUTPUT, unavailable: {} };
    default:
      return undefined;
  }
}

// ---- agent --------------------------------------------------------------------------------------------------------------

const AGENT_KEYS = [
  ...COMMON_KEYS,
  "profile",
  "environment",
  "instruction",
  "session",
  "branch",
  "result",
];

function reachOf(
  env: Env,
  nodePath: string,
  state: StepState,
  previousOk = false,
): Omit<Use, "path"> {
  return { env, previousOk, nodePath, branches: state.branches };
}

function checkProfile(
  node: Record<string, unknown>,
  path: string,
  c: Checker,
): void {
  const ref = stringField(
    node,
    "profile",
    path,
    'the profile to run, like "implementer" or "implementer@1" (a version pins it).',
    c,
  );
  if (ref === undefined) return;
  const where = pointer(path, "profile");
  const parsed = parseProfileRef(ref);
  if (parsed === undefined) {
    c.report(
      issue(
        where,
        "invalid_value",
        `${shown(ref)} is not a profile reference. Write a name, or name@version, like "implementer@1".`,
      ),
    );
    return;
  }
  const info = c.resolver.profiles().find((p) => p.name === parsed.name);
  if (info === undefined) {
    const names = c.resolver.profiles().map((p) => p.name);
    if (c.resolver.archivedProfiles?.().includes(parsed.name) === true) {
      c.report(
        issue(
          where,
          "profile_archived",
          `The profile ${shown(parsed.name)} is archived and cannot be run. Profiles: ${listNames(names)}.`,
          names,
        ),
      );
      return;
    }
    c.report(
      issue(
        where,
        "profile_unknown",
        `There is no profile ${shown(parsed.name)}. Profiles: ${listNames(names)}.`,
        names,
      ),
    );
    return;
  }
  if (parsed.version !== undefined && !info.versions.includes(parsed.version)) {
    const versions = info.versions.map(String);
    c.report(
      issue(
        where,
        "profile_version_unknown",
        `The profile '${info.name}' has no version ${parsed.version}. Versions: ${listNames(versions)}.`,
        versions,
      ),
    );
  }
}

function checkEnvironment(
  node: Record<string, unknown>,
  path: string,
  c: Checker,
  use: Omit<Use, "path">,
): void {
  const name = stringField(
    node,
    "environment",
    path,
    "the name of an environment of the workspace.",
    c,
  );
  if (name === undefined) return;
  const where = pointer(path, "environment");
  const literal = checkLiteral(
    name,
    c,
    { ...use, path: where },
    "'environment' decides where the agent works, so in version 1 it is a literal: the name of an environment of the workspace. A reference to the trigger or to a result is not taken.",
    "target_from_untrusted_value",
  );
  if (literal === undefined) return;
  const names = c.resolver.environments().map((e) => e.name);
  if (!names.some((known) => known.toLowerCase() === literal.toLowerCase()))
    c.report(
      issue(
        where,
        "environment_unknown",
        `There is no environment ${shown(literal)} in this workspace. Environments: ${listNames(names)}.`,
        names,
      ),
    );
}

/**
 * #854: what a profile and an environment can only do together. A runner works with its owner's own key, so a profile with a managed
 * model has no place in a runner environment; and a harness the platform's catalog does not hold (any but OpenCode) exists only on a
 * runner. Both are reported where the environment is written. A name nobody knows is reported by the checks above and not again here.
 */
function checkRunnerRules(
  node: Record<string, unknown>,
  path: string,
  c: Checker,
): void {
  const environment =
    typeof node.environment === "string"
      ? literalText(parseTemplate(node.environment))
      : undefined;
  if (environment === undefined) return;
  const known = c.resolver
    .environments()
    .find((e) => e.name.toLowerCase() === environment.toLowerCase());
  const facts = findProfile(node.profile, c.resolver)?.facts;
  if (known === undefined || facts === undefined) return;
  const where = pointer(path, "environment");
  const onRunner = known.kind === "runner";
  if (onRunner && facts.managedModel === true)
    c.report(
      issue(
        where,
        "runner_needs_own_key",
        `The environment ${shown(known.name)} runs on a runner, which works with the workspace's own key, but the profile ${shown(parseProfileRef(node.profile as string)?.name ?? "")} uses a managed model. Use a profile with a model of your own key, or a platform environment.`,
      ),
    );
  const harness = harnessOfProfile(facts);
  if (!onRunner && harnessNeedsRunner(harness))
    c.report(
      issue(
        where,
        "harness_needs_runner",
        `The profile ${shown(parseProfileRef(node.profile as string)?.name ?? "")} runs with the harness ${shown(harness)}, which exists only on a runner. Use an environment that runs on a runner.`,
      ),
    );
}

function checkInstruction(
  node: Record<string, unknown>,
  path: string,
  c: Checker,
  env: Env,
  state: StepState,
): void {
  const where = pointer(path, "instruction");
  const value = node.instruction;
  if (value === undefined) {
    missing(
      path,
      "instruction",
      'the task for the agent, a text or {"first": …, "next": …}.',
      c,
    );
    return;
  }
  if (typeof value === "string") {
    checkText(value, c, { ...reachOf(env, where, state), path: where });
    return;
  }
  if (!isRecord(value)) {
    c.report(
      issue(
        where,
        "wrong_type",
        `'instruction' is a text or {"first": …, "next": …}, not ${jsonTypeName(value)}.`,
      ),
    );
    return;
  }
  keysOf(value, ["first", "next"], where, c);
  for (const key of ["first", "next"] as const) {
    const text = value[key];
    const at = pointer(where, key);
    if (text === undefined) {
      missing(
        where,
        key,
        key === "first"
          ? "the task for round one."
          : "the task for round two and later.",
        c,
      );
      continue;
    }
    if (typeof text !== "string") {
      c.report(
        issue(
          at,
          "wrong_type",
          `'${key}' must be a text, not ${jsonTypeName(text)}.`,
        ),
      );
      continue;
    }
    if (key === "next" && env.loops.length === 0)
      c.report(
        issue(
          at,
          "instruction_next_outside_loop",
          "'next' is the instruction for the later rounds of a loop; this step is not in a loop, so it would never be used. Use a plain text, or put the step in a loop.",
        ),
      );
    checkText(text, c, {
      ...reachOf(env, at, state, key === "next"),
      path: at,
    });
  }
}

/** The ids of the agent steps in reach, as many as a list in an answer holds (and one more, to tell there are more). */
function agentsInReach(env: Env, own: string | undefined): string[] {
  const agents = firstOf(
    (function* () {
      for (const binding of env.scope.values())
        if (binding.kind === "agent") yield binding.id;
    })(),
    NAMES_LISTED_MAX + 1,
  );
  return own === undefined ? agents : [...agents, own];
}

function reportNoSession(
  at: string,
  cause: string,
  env: Env,
  own: string | undefined,
  c: Checker,
): void {
  const available = agentsInReach(env, own);
  c.report(
    issue(
      at,
      "session_target_invalid",
      `${cause} Sessions of agent steps in reach: ${listNames(available, "more")}.`,
      available,
    ),
  );
}

function checkSession(
  node: Record<string, unknown>,
  path: string,
  c: Checker,
  env: Env,
  state: StepState,
): void {
  const value = node.session;
  if (value === undefined || value === "new") return;
  const where = pointer(path, "session");
  if (!isRecord(value)) {
    c.report(
      issue(
        where,
        "wrong_type",
        `'session' is "new" or {"continue": "<step id>"}, not ${jsonTypeName(value)}.`,
      ),
    );
    return;
  }
  keysOf(value, ["continue"], where, c);
  const target = value.continue;
  const at = pointer(where, "continue");
  if (target === undefined) {
    missing(
      where,
      "continue",
      "the id of the agent step whose session goes on.",
      c,
    );
    return;
  }
  if (typeof target !== "string") {
    c.report(
      issue(
        at,
        "wrong_type",
        "'continue' is the id of an agent step (a text).",
      ),
    );
    return;
  }
  if (!isStepId(target, false)) {
    c.report(
      issue(
        at,
        "invalid_value",
        `${shown(target)} is not a step id: a letter, then letters, digits, '_' or '-' (${ID_MAX_LENGTH} at most); 'trigger' and 'previous' are taken.`,
      ),
    );
    return;
  }
  const own = node.id;
  // A step continues its own session only as a direct step of a loop body: a step inside an `if` of the body may not have run in
  // the round before, so there may be no session to go on with.
  const ownSession = state.inLoopBody && typeof own === "string";
  if (target === own) {
    if (!ownSession)
      reportNoSession(
        at,
        "A step can continue its own session only as a direct step of a loop body, where the round before ran it. Outside a loop, or inside an if of the body, there may be none.",
        env,
        undefined,
        c,
      );
    return;
  }
  const found = env.scope.get(target);
  if (found?.kind !== "agent") {
    reportNoSession(
      at,
      `${shown(target)} is not an agent step that ran before this one on every path.`,
      env,
      ownSession ? own : undefined,
      c,
    );
    return;
  }
  // A session belongs to one profile in one environment: it holds the files and the conversation of that setup.
  const mine = setupOf(node);
  const theirs = found.agent ?? {};
  for (const [what, a, b] of [
    ["profile", mine.profile, theirs.profile],
    ["environment", mine.environment, theirs.environment],
  ] as const)
    if (a !== undefined && b !== undefined && a !== b)
      c.report(
        issue(
          at,
          "session_target_invalid",
          `${shown(target)} runs with the ${what} ${shown(b)}, this step with ${shown(a)}. A session can only go on with the same profile and the same environment.`,
        ),
      );
}

/**
 * `branch`: the branch a session of its own starts from. It decides what the agent works on, so it is a target (a literal, a trigger
 * value, or the branch an earlier agent step made), never text an agent wrote. A step that goes on in a session keeps the branch of
 * that session, so it names none.
 */
function checkStartBranch(
  node: Record<string, unknown>,
  path: string,
  c: Checker,
  env: Env,
  state: StepState,
): void {
  const value = node.branch;
  if (value === undefined) return;
  const where = pointer(path, "branch");
  if (typeof value !== "string") {
    c.report(
      issue(
        where,
        "wrong_type",
        `'branch' must be a text, not ${jsonTypeName(value)}.`,
      ),
    );
    return;
  }
  if (value.trim() === "")
    c.report(
      issue(
        where,
        "invalid_value",
        "'branch' is the name of a branch, not an empty text.",
      ),
    );
  if (isRecord(node.session))
    c.report(
      issue(
        where,
        "session_target_invalid",
        "A step that goes on in a session (session.continue) works on the branch of that session, so it takes no 'branch'. Use 'branch' on a step that starts a session of its own.",
      ),
    );
  checkInput(value, STRING, where, c, reachOf(env, where, state), {
    input: "branch",
    roots: ["input", "defaultBranch", "branch"],
  });
}

function checkAgent(
  node: Record<string, unknown>,
  path: string,
  c: Checker,
  env: Env,
  state: StepState,
): void {
  keysOf(node, AGENT_KEYS, path, c);
  descriptionField(node, path, c);
  checkProfile(node, path, c);
  checkEnvironment(
    node,
    path,
    c,
    reachOf(env, pointer(path, "environment"), state),
  );
  checkRunnerRules(node, path, c);
  checkInstruction(node, path, c, env, state);
  checkSession(node, path, c, env, state);
  checkStartBranch(node, path, c, env, state);
  if (node.result === undefined) return;
  const where = pointer(path, "result");
  const checked = validateResultSchema(node.result, where);
  for (const found of checked.issues) c.report(found);
  const properties =
    isRecord(node.result) && isRecord(node.result.properties)
      ? node.result.properties
      : {};
  for (const name of Object.keys(properties))
    if (FACT_NAMES.includes(name))
      c.report(
        issue(
          pointer(where, "properties", name),
          "result_field_reserved",
          `${shown(name)} is filled in by the platform for every agent step. Name the field of the result differently.`,
          FACT_NAMES,
        ),
      );
}

// ---- action -------------------------------------------------------------------------------------------------------------

function checkAction(
  node: Record<string, unknown>,
  path: string,
  c: Checker,
  env: Env,
  state: StepState,
): void {
  const connectors = c.resolver.connectors();
  const names = connectors.map((spec) => spec.name);
  const name = stringField(
    node,
    "connector",
    path,
    `one of ${listNames(names)}.`,
    c,
  );
  descriptionField(node, path, c);
  if (name === undefined) return;
  const spec = connectors.find((s) => s.name === name);
  if (spec === undefined) {
    c.report(
      issue(
        pointer(path, "connector"),
        "unknown_connector",
        `There is no connector ${shown(name)}. Connectors: ${listNames(names)}.`,
        names,
      ),
    );
    return;
  }
  if (state.onFailure && !ON_FAILURE_CONNECTORS.includes(name))
    c.report(
      issue(
        pointer(path, "connector"),
        "on_failure_step_not_allowed",
        `${shown(name)} cannot run after a failure. A step of onFailure may use ${listNames(ON_FAILURE_CONNECTORS)}.`,
        ON_FAILURE_CONNECTORS,
      ),
    );
  keysOf(
    node,
    [...COMMON_KEYS, "connector", ...Object.keys(spec.inputs)],
    path,
    c,
  );
  for (const [input, field] of Object.entries(spec.inputs)) {
    const at = pointer(path, input);
    if (node[input] === undefined) {
      if (field.required)
        missing(
          path,
          input,
          `${spec.name} needs it (${describeInput(field.type)}).`,
          c,
        );
      continue;
    }
    const target: TargetCheck | undefined =
      field.target === undefined ? undefined : { input, roots: field.target };
    checkInput(node[input], field.type, at, c, reachOf(env, at, state), target);
  }
  // A list of no entries holds nothing: `add: [], remove: []` is as good as neither.
  if (
    spec.atLeastOneOf?.every(
      (input) =>
        node[input] === undefined ||
        (Array.isArray(node[input]) && node[input].length === 0),
    )
  )
    c.report(
      issue(
        path,
        "missing_field",
        `${spec.name} needs at least one of ${listNames(spec.atLeastOneOf)}, with an entry in it.`,
        spec.atLeastOneOf,
      ),
    );
  if (spec.name === GITHUB_ISSUE_LABELS.name) checkNoRetrigger(node, path, c);
}

/** Adding the label that starts the workflow would start it again, and again. */
function checkNoRetrigger(
  node: Record<string, unknown>,
  path: string,
  c: Checker,
): void {
  const label = c.triggerLabel?.trim().toLowerCase();
  if (label === undefined || !Array.isArray(node.add)) return;
  node.add.forEach((entry: unknown, position) => {
    if (typeof entry !== "string") return;
    const literal = literalText(parseTemplate(entry))?.trim().toLowerCase();
    if (literal === label)
      c.report(
        issue(
          pointer(path, "add", position),
          "label_retriggers_workflow",
          `Adding the label ${shown(literal)} puts the label that starts this workflow on the issue again, and the workflow would start again. Remove it instead, or add another label.`,
        ),
      );
  });
}

function describeInput(type: FieldType["type"]): string {
  return type.kind === "oneOf"
    ? "the issue object or its number"
    : type.kind === "list"
      ? "a list"
      : type.kind;
}

// ---- control ------------------------------------------------------------------------------------------------------------

function nestingTooDeep(path: string, state: StepState, c: Checker): boolean {
  if (state.depth + 1 <= NESTING_DEPTH_MAX) return false;
  c.report(
    issue(
      path,
      "nesting_too_deep",
      `if and loop can be nested ${NESTING_DEPTH_MAX} levels deep at most.`,
    ),
  );
  return true;
}

function loopNestingTooDeep(
  path: string,
  state: StepState,
  c: Checker,
): boolean {
  if (state.loopDepth + 1 <= LOOP_NESTING_MAX) return false;
  c.report(
    issue(
      path,
      "nesting_too_deep",
      `A loop can be inside ${LOOP_NESTING_MAX - 1} other loop at most.`,
    ),
  );
  return true;
}

function checkBranch(
  node: Record<string, unknown>,
  key: "then" | "else",
  path: string,
  c: Checker,
  env: Env,
  state: StepState,
): void {
  const value = node[key];
  const where = pointer(path, key);
  if (value === undefined) {
    if (key === "then")
      missing(path, "then", "the steps that run when the condition holds.", c);
    return;
  }
  const branchEnv: Env = { scope: env.scope.child(), loops: env.loops };
  checkSteps(value, where, c, branchEnv, {
    depth: state.depth + 1,
    loopDepth: state.loopDepth,
    branches: [...state.branches, { ifId: node.id as string, branch: key }],
    inLoopBody: false,
    onFailure: state.onFailure,
  });
}

function checkIf(
  node: Record<string, unknown>,
  path: string,
  c: Checker,
  env: Env,
  state: StepState,
): void {
  keysOf(node, [...COMMON_KEYS, "when", "then", "else"], path, c);
  descriptionField(node, path, c);
  const deep = nestingTooDeep(path, state, c);
  if (node.when === undefined) missing(path, "when", "the condition.", c);
  else
    checkCondition(
      node.when,
      pointer(path, "when"),
      c,
      reachOf(env, pointer(path, "when"), state),
    );
  if (deep) return;
  checkBranch(node, "then", path, c, env, state);
  checkBranch(node, "else", path, c, env, state);
}

function checkLoop(
  node: Record<string, unknown>,
  path: string,
  c: Checker,
  env: Env,
  state: StepState,
): Binding[] {
  keysOf(node, [...COMMON_KEYS, "maxRounds", "body", "until"], path, c);
  descriptionField(node, path, c);
  const rounds = node.maxRounds;
  const roundsAt = pointer(path, "maxRounds");
  if (rounds === undefined)
    missing(
      path,
      "maxRounds",
      `how many rounds at most, 1 to ${LOOP_ROUNDS_MAX}.`,
      c,
    );
  else if (typeof rounds !== "number" || !Number.isInteger(rounds))
    c.report(
      issue(
        roundsAt,
        "wrong_type",
        `'maxRounds' is a whole number from 1 to ${LOOP_ROUNDS_MAX}.`,
      ),
    );
  else if (rounds < 1)
    c.report(issue(roundsAt, "invalid_value", "'maxRounds' is at least 1."));
  else if (rounds > LOOP_ROUNDS_MAX)
    c.report(
      issue(
        roundsAt,
        "limit_exceeded",
        `'maxRounds' may be ${LOOP_ROUNDS_MAX} at most.`,
      ),
    );
  const tooDeep =
    nestingTooDeep(path, state, c) || loopNestingTooDeep(path, state, c);
  const body = node.body;
  const bodyAt = pointer(path, "body");
  let own: Binding[] = [];
  let bodyEnv: Env | undefined;
  if (body === undefined)
    missing(path, "body", "the steps that run in every round.", c);
  else if (!tooDeep) {
    const previous = new Map<string, Binding>();
    if (Array.isArray(body))
      for (const child of body) {
        const preview = previewBinding(child, c.resolver);
        if (preview !== undefined) previous.set(preview.id, preview);
      }
    const frame: LoopFrame = {
      id: node.id as string,
      bodyPath: bodyAt,
      previous,
    };
    bodyEnv = { scope: env.scope.child(), loops: [...env.loops, frame] };
    own = checkSteps(body, bodyAt, c, bodyEnv, {
      depth: state.depth + 1,
      loopDepth: state.loopDepth + 1,
      branches: state.branches,
      inLoopBody: true,
      onFailure: state.onFailure,
    });
  }
  const untilAt = pointer(path, "until");
  if (node.until === undefined)
    missing(
      path,
      "until",
      "the condition that ends the loop, checked after every round.",
      c,
    );
  else if (bodyEnv !== undefined && Array.isArray(body) && body.length > 0)
    checkCondition(node.until, untilAt, c, reachOf(bodyEnv, untilAt, state));
  return own;
}

// ---- the list -----------------------------------------------------------------------------------------------------------

/**
 * Checks a list of steps in order; each step that is fine to refer to joins the scope of the steps after it. Returns the bindings
 * this list made (a loop body hands its own to the code after the loop).
 */
export function checkSteps(
  steps: unknown,
  path: string,
  c: Checker,
  env: Env,
  state: StepState,
): Binding[] {
  const made: Binding[] = [];
  if (!Array.isArray(steps)) {
    c.report(
      issue(
        path,
        "wrong_type",
        `This must be a list of steps, not ${jsonTypeName(steps)}.`,
      ),
    );
    return made;
  }
  if (steps.length === 0)
    c.report(
      issue(path, "invalid_value", "A list of steps needs at least one step."),
    );
  const bind = (binding: Binding): void => {
    env.scope.set(binding.id, binding);
    made.push(binding);
  };
  for (const [index, node] of steps.entries()) {
    if (c.halted()) break;
    const at = pointer(path, index);
    if (!isRecord(node)) {
      c.report(
        issue(
          at,
          "wrong_type",
          `A step is an object, not ${jsonTypeName(node)}.`,
        ),
      );
      continue;
    }
    const id = node.id;
    const validId = typeof id === "string" && isStepId(id, state.onFailure);
    if (id === undefined)
      missing(at, "id", 'a name for the step, like "implement".', c);
    else if (typeof id !== "string")
      c.report(issue(pointer(at, "id"), "wrong_type", "'id' is a text."));
    else if (!validId)
      c.report(
        issue(
          pointer(at, "id"),
          "invalid_value",
          `${shown(id)} is not a usable id: start with a letter, then letters, digits, '_' or '-' (${ID_MAX_LENGTH} at most); 'trigger' and 'previous' are taken${state.onFailure ? `, and '${FAILURE_ID}' in onFailure` : ""}.`,
        ),
      );
    const kind = node.kind;
    if (kind === undefined) {
      missing(at, "kind", `one of ${listNames([...SUPPORTED_KINDS])}.`, c);
      continue;
    }
    if (
      typeof kind === "string" &&
      (RESERVED_KINDS as readonly string[]).includes(kind)
    ) {
      c.report(
        issue(
          pointer(at, "kind"),
          "kind_not_supported",
          `The kind ${shown(kind)} is reserved for a later version and cannot be used in version 1. Available: ${listNames([...SUPPORTED_KINDS])}.`,
          SUPPORTED_KINDS,
        ),
      );
      if (validId)
        bind({
          id,
          kind: "reserved",
          type: { kind: "unknown" },
          unavailable: {},
        });
      continue;
    }
    if (
      typeof kind !== "string" ||
      !(SUPPORTED_KINDS as readonly string[]).includes(kind)
    ) {
      c.report(
        issue(
          pointer(at, "kind"),
          "unknown_kind",
          `${typeof kind === "string" ? `${shown(kind)} is not a node kind` : "'kind' must be a text"}. Available: ${listNames([...SUPPORTED_KINDS])} (reserved: ${listNames([...RESERVED_KINDS])}).`,
          SUPPORTED_KINDS,
        ),
      );
      if (validId)
        bind({
          id,
          kind: "reserved",
          type: { kind: "unknown" },
          unavailable: {},
        });
      continue;
    }
    // The node is checked like any other below: the form of a node that is not allowed is still the form the JSON Schema states.
    if (state.onFailure && !ON_FAILURE_KINDS.includes(kind))
      c.report(
        issue(
          pointer(at, "kind"),
          "on_failure_step_not_allowed",
          `A step of onFailure is an action or an if, not ${shown(kind)}: after a failure nothing starts an agent or a loop. Available: ${listNames(ON_FAILURE_KINDS)}.`,
          ON_FAILURE_KINDS,
        ),
      );
    const nodeId = validId ? id : undefined;
    const withId = nodeId === undefined ? undefined : { ...node, id: nodeId };
    switch (kind) {
      case "agent":
        checkAgent(node, at, c, env, state);
        if (withId !== undefined) bind(agentBinding(withId, c.resolver));
        continue;
      case "action":
        checkAction(node, at, c, env, state);
        if (withId !== undefined) bind(actionBinding(withId, c.resolver));
        continue;
      case "if":
        checkIf({ ...node, id: nodeId ?? `if@${at}` }, at, c, env, state);
        if (nodeId !== undefined)
          bind({ id: nodeId, kind: "if", type: IF_OUTPUT, unavailable: {} });
        continue;
      default: {
        const bodyOwn = checkLoop(
          { ...node, id: nodeId ?? `loop@${at}` },
          at,
          c,
          env,
          state,
        );
        // After the loop: the body's own steps with the values of the last round, and the loop itself.
        for (const binding of bodyOwn) bind(binding);
        if (nodeId !== undefined)
          bind({
            id: nodeId,
            kind: "loop",
            type: LOOP_OUTPUT,
            unavailable: {},
          });
      }
    }
  }
  return made;
}
