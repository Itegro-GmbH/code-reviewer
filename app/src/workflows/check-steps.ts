// SPDX-License-Identifier: LicenseRef-Proprietary

// The steps of a workflow in the order they run (#833): the shape of each node, and everything that depends on what ran before it.
// `check-values.ts` checks the texts and values, `scope.ts` what a reference can reach.
import {
  checkCondition,
  checkInput,
  checkText,
  jsonTypeName,
} from "./check-values.ts";
import { FACT_NAMES, FACT_TYPES, PUSH_FACTS } from "./facts.ts";
import {
  ID_MAX_LENGTH,
  LOOP_NESTING_MAX,
  LOOP_ROUNDS_MAX,
  NESTING_DEPTH_MAX,
} from "./limits.ts";
import { issue, listNames, pointer } from "./issues.ts";
import {
  parseProfileRef,
  type ProfileInfo,
  type WorkflowResolver,
} from "./resolver.ts";
import {
  objectTypeOf,
  validateResultSchema,
  type ResultSchema,
} from "./result-schema.ts";
import type { ConnectorSpec } from "./connectors.ts";
import type {
  Binding,
  Env,
  LoopFrame,
  ScopeContext,
  StepInfo,
  Use,
} from "./scope.ts";
import { enumOf, NUMBER, objectOf, type FieldType } from "./value-type.ts";

export const SUPPORTED_KINDS = ["agent", "action", "if", "loop"] as const;
/** Named in the format so a document can use them later; version 1 refuses them. */
export const RESERVED_KINDS = ["forEach", "approval", "workflow"] as const;
export const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const RESERVED_IDS = ["trigger", "previous"] as const;
const COMMON_KEYS = ["id", "kind", "description"] as const;

export type Checker = ScopeContext & {
  resolver: WorkflowResolver;
  /** Whether the trigger names a repository (`trigger.repo`), so an action may leave `repo` out. */
  triggerHasRepo: boolean;
};

export type StepState = {
  depth: number;
  loopDepth: number;
  branches: StepInfo["branches"];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
          `'${key}' is not a field of this node. Fields: ${listNames(allowed)}.`,
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
        `'${key}' must be a text, not ${jsonTypeName(value)}. ${hint}`,
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
  if (text !== undefined && text.length > 1000)
    c.report(
      issue(
        pointer(path, "description"),
        "limit_exceeded",
        "description may have 1000 characters at most.",
      ),
    );
}

// ---- what a step yields -------------------------------------------------------------------------------------------------

function findProfile(
  ref: unknown,
  resolver: WorkflowResolver,
): { info: ProfileInfo; version?: number } | undefined {
  if (typeof ref !== "string") return undefined;
  const parsed = parseProfileRef(ref);
  if (parsed === undefined) return undefined;
  const info = resolver.profiles().find((p) => p.name === parsed.name);
  return info === undefined ? undefined : { info, version: parsed.version };
}

/** What an agent step yields: its declared result, and the facts. Silent: the checks report. */
export function agentBinding(
  node: Record<string, unknown>,
  resolver: WorkflowResolver,
): Binding {
  const id = node.id as string;
  const found = findProfile(node.profile, resolver);
  // A profile nobody knows is reported where it is written; its facts stay, so one mistake is not reported at every use.
  const canPush = found?.info.canPush ?? true;
  const declared =
    node.result === undefined
      ? undefined
      : validateResultSchema(node.result).schema;
  const schema: ResultSchema | undefined =
    declared ??
    (node.result === undefined ? found?.info.defaultResult : undefined);
  const fields: Record<string, FieldType> = {};
  if (schema !== undefined)
    for (const [name, field] of Object.entries(objectTypeOf(schema).fields))
      if (!FACT_NAMES.includes(name)) fields[name] = field;
  fields.costUsd = {
    type: FACT_TYPES.costUsd as FieldType["type"],
    required: true,
  };
  if (canPush)
    for (const name of PUSH_FACTS)
      fields[name] = {
        type: FACT_TYPES[name] as FieldType["type"],
        required: true,
      };
  const reason = `The profile '${String(node.profile)}' may not push, so '${id}' yields no branch and no commits. Use a profile that may push, or reference the result of the step.`;
  return {
    id,
    kind: "agent",
    type: { kind: "object", fields },
    unavailable: canPush ? {} : { branch: reason, commits: reason },
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
        `'${ref}' is not a profile reference. Write a name, or name@version, like "implementer@1".`,
      ),
    );
    return;
  }
  const info = c.resolver.profiles().find((p) => p.name === parsed.name);
  if (info === undefined) {
    const names = c.resolver.profiles().map((p) => p.name);
    c.report(
      issue(
        where,
        "profile_unknown",
        `There is no profile '${parsed.name}'. Profiles: ${listNames(names)}.`,
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
  const checked = checkText(name, c, { ...use, path: where });
  if (!checked.ok) return;
  if (checked.whole !== undefined) {
    if (
      checked.whole.kind !== "string" &&
      checked.whole.kind !== "enum" &&
      checked.whole.kind !== "unknown"
    )
      c.report(
        issue(
          where,
          "reference_type_mismatch",
          "The environment must be a text (a name); this reference is not one.",
        ),
      );
    return;
  }
  // A name with a reference in it is only known when the workflow runs.
  if (name.includes("{{")) return;
  const names = c.resolver.environments().map((e) => e.name);
  if (!names.some((known) => known.toLowerCase() === name.toLowerCase()))
    c.report(
      issue(
        where,
        "environment_unknown",
        `There is no environment '${name}' in this workspace. Environments: ${listNames(names)}.`,
        names,
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

function checkSession(
  node: Record<string, unknown>,
  path: string,
  c: Checker,
  env: Env,
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
  const inLoop = env.loops.length > 0;
  const own = node.id;
  const agents = [...env.scope.values()]
    .filter((b) => b.kind === "agent")
    .map((b) => b.id);
  const available =
    inLoop && typeof own === "string" ? [...agents, own] : agents;
  if (target === own) {
    if (!inLoop)
      c.report(
        issue(
          at,
          "session_target_invalid",
          "A step can continue its own session only inside a loop, where the round before had one. Outside a loop there is none.",
          available,
        ),
      );
    return;
  }
  if (env.scope.get(target)?.kind !== "agent")
    c.report(
      issue(
        at,
        "session_target_invalid",
        `'${target}' is not an agent step that ran before this one on every path. Sessions of agent steps in reach: ${listNames(available)}.`,
        available,
      ),
    );
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
  checkInstruction(node, path, c, env, state);
  checkSession(node, path, c, env);
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
          `'${name}' is filled in by the platform for every agent step. Name the field of the result differently.`,
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
        `There is no connector '${name}'. Connectors: ${listNames(names)}.`,
        names,
      ),
    );
    return;
  }
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
    if (
      input === "repo" &&
      typeof node.repo === "string" &&
      !node.repo.includes("{{") &&
      !/^[\w.-]+\/[\w.-]+$/.test(node.repo)
    ) {
      c.report(
        issue(
          at,
          "invalid_value",
          'repo is written owner/name, like "acme/api".',
        ),
      );
      continue;
    }
    checkInput(node[input], field.type, at, c, reachOf(env, at, state));
  }
  if (spec.atLeastOneOf?.every((input) => node[input] === undefined))
    c.report(
      issue(
        path,
        "missing_field",
        `${spec.name} needs at least one of ${listNames(spec.atLeastOneOf)}.`,
        spec.atLeastOneOf,
      ),
    );
  if (spec.needsRepo && node.repo === undefined && !c.triggerHasRepo)
    c.report(
      issue(
        path,
        "repo_required",
        `${spec.name} works on a repository, and the trigger does not provide one (trigger.repo). Name it with "repo": "owner/name".`,
      ),
    );
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
  const branchEnv: Env = { scope: new Map(env.scope), loops: env.loops };
  checkSteps(value, where, c, branchEnv, {
    depth: state.depth + 1,
    loopDepth: state.loopDepth,
    branches: [...state.branches, { ifId: node.id as string, branch: key }],
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
    nestingTooDeep(path, state, c) ||
    (state.loopDepth + 1 > LOOP_NESTING_MAX &&
      (c.report(
        issue(
          path,
          "nesting_too_deep",
          `A loop can be inside ${LOOP_NESTING_MAX - 1} other loop at most.`,
        ),
      ),
      true));
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
    const frame: LoopFrame = { id: node.id as string, previous };
    bodyEnv = { scope: new Map(env.scope), loops: [...env.loops, frame] };
    own = checkSteps(body, bodyAt, c, bodyEnv, {
      depth: state.depth + 1,
      loopDepth: state.loopDepth + 1,
      branches: state.branches,
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
  steps.forEach((node: unknown, index) => {
    const at = pointer(path, index);
    if (!isRecord(node)) {
      c.report(
        issue(
          at,
          "wrong_type",
          `A step is an object, not ${jsonTypeName(node)}.`,
        ),
      );
      return;
    }
    const id = node.id;
    const validId =
      typeof id === "string" &&
      ID_PATTERN.test(id) &&
      !(RESERVED_IDS as readonly string[]).includes(id);
    if (id === undefined)
      missing(at, "id", 'a name for the step, like "implement".', c);
    else if (typeof id !== "string")
      c.report(issue(pointer(at, "id"), "wrong_type", "'id' is a text."));
    else if (!validId)
      c.report(
        issue(
          pointer(at, "id"),
          "invalid_value",
          `'${id.slice(0, ID_MAX_LENGTH)}' is not a usable id: start with a letter, then letters, digits, '_' or '-' (64 at most); 'trigger' and 'previous' are taken.`,
        ),
      );
    const kind = node.kind;
    if (kind === undefined) {
      missing(at, "kind", `one of ${listNames([...SUPPORTED_KINDS])}.`, c);
      return;
    }
    if (
      typeof kind === "string" &&
      (RESERVED_KINDS as readonly string[]).includes(kind)
    ) {
      c.report(
        issue(
          pointer(at, "kind"),
          "kind_not_supported",
          `The kind '${kind}' is reserved for a later version and cannot be used in version 1. Available: ${listNames([...SUPPORTED_KINDS])}.`,
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
      return;
    }
    if (
      typeof kind !== "string" ||
      !(SUPPORTED_KINDS as readonly string[]).includes(kind)
    ) {
      c.report(
        issue(
          pointer(at, "kind"),
          "unknown_kind",
          `${typeof kind === "string" ? `'${kind}' is not a node kind` : "'kind' must be a text"}. Available: ${listNames([...SUPPORTED_KINDS])} (reserved: ${listNames([...RESERVED_KINDS])}).`,
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
      return;
    }
    const nodeId = validId ? id : undefined;
    const withId = nodeId === undefined ? undefined : { ...node, id: nodeId };
    switch (kind) {
      case "agent":
        checkAgent(node, at, c, env, state);
        if (withId !== undefined) bind(agentBinding(withId, c.resolver));
        return;
      case "action":
        checkAction(node, at, c, env, state);
        if (withId !== undefined) bind(actionBinding(withId, c.resolver));
        return;
      case "if":
        checkIf({ ...node, id: nodeId ?? `if@${at}` }, at, c, env, state);
        if (nodeId !== undefined)
          bind({ id: nodeId, kind: "if", type: IF_OUTPUT, unavailable: {} });
        return;
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
  });
  return made;
}
