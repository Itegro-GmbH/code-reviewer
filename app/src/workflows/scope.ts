// SPDX-License-Identifier: LicenseRef-Proprietary

// What a reference can reach at a given place (#833), and how a reference is resolved against it. The scope follows the structure of
// the document, not a graph:
//  - a step is in scope for every step that comes after it in the same list, and for everything nested inside those;
//  - inside a loop body, the steps of the body that came before; after the loop, the body's own steps with the values of the LAST
//    round (a body runs at least once, a round always runs to its end: the loop checks its budget between rounds, not inside one);
//  - inside an `if` branch, what came before the `if` and the branch's own earlier steps; after the `if`, only the `if` itself
//    (`{{id.taken}}`): ids are unique in the document, so no step is produced by both branches and nothing a branch made is
//    certain to exist, and its values stay inside the branch;
//  - `previous.<step>.<field>` is the value a direct step of the innermost loop body had in the round before: it exists from round two.
import {
  clip,
  comparePaths,
  issue,
  listNames,
  shown,
  type Issue,
} from "./issues.ts";
import { NAMES_LISTED_MAX } from "./limits.ts";
import {
  describeType,
  valueFits,
  UNKNOWN,
  type FieldType,
  type ObjectType,
  type ValueType,
} from "./value-type.ts";
import type { Reference } from "./template.ts";

export type StepKind =
  "trigger" | "agent" | "action" | "if" | "loop" | "reserved";

export type Binding = {
  id: string;
  kind: StepKind;
  type: ObjectType | { kind: "unknown" };
  /** Fields the platform does not provide for this step, with the reason (a profile that may not push has no branch). */
  unavailable: Readonly<Record<string, string>>;
  /** The result schema of the step failed its own check, which is reported where it is written: any other name is unknown, not an error. */
  open?: boolean;
  /** Of an agent step: the profile name and the environment (lower case) it is written with, for the steps that continue its session. */
  agent?: { profile?: string; environment?: string };
};

export type LoopFrame = {
  id: string;
  /** Pointer of the body of the loop. */
  bodyPath: string;
  /** The direct steps of the body that yield values: what `previous.` can name. */
  previous: ReadonlyMap<string, Binding>;
};

export type Env = {
  scope: Map<string, Binding>;
  /** Innermost last. */
  loops: LoopFrame[];
};

/** Where a step sits in the document: for the reason a reference to it fails. */
export type StepInfo = {
  id: string;
  path: string;
  kind: string;
  /** The `if` branches around it, outermost first. */
  branches: { ifId: string; branch: "then" | "else" }[];
};

export type Use = {
  /** Pointer of the text that holds the reference. */
  path: string;
  env: Env;
  /** `previous.` is fine without a default here (the `next` instruction of a loop). */
  previousOk: boolean;
  /** Where the node that holds the text sits, to tell a step that comes later from one in another branch. */
  nodePath: string;
  /** The branches around the node, outermost first. */
  branches: StepInfo["branches"];
};

export type Resolution = { type: ValueType };

export type ScopeContext = {
  index: ReadonlyMap<string, StepInfo>;
  report: (found: Issue) => void;
  /** The check has all the problems an answer can hold: nothing more needs to be looked at. */
  halted: () => boolean;
};

function isPrefix(shorter: string, longer: string): boolean {
  return longer === shorter || longer.startsWith(`${shorter}/`);
}

/** The first `limit` of the values of an iterator, without walking the rest. */
export function firstOf<T>(values: Iterable<T>, limit = NAMES_LISTED_MAX): T[] {
  const taken: T[] = [];
  if (limit <= 0) return taken;
  for (const value of values) {
    taken.push(value);
    if (taken.length >= limit) break;
  }
  return taken;
}

/** A few of the names in reach (and how many there are): a scope may hold thousands of steps, and a list is made for each problem. */
function namesInReach(
  env: Env,
  previous: boolean,
): { names: string[]; total: number } {
  const withPrevious = previous && env.loops.length > 0;
  const total = env.scope.size + (withPrevious ? 1 : 0);
  const names = firstOf(env.scope.keys());
  return {
    names:
      withPrevious && names.length < NAMES_LISTED_MAX
        ? [...names, "previous"]
        : names,
    total,
  };
}

function fail(
  context: ScopeContext,
  use: Use,
  code: Issue["code"],
  message: string,
  available?: readonly string[],
): Resolution {
  context.report(issue(use.path, code, message, available));
  return { type: UNKNOWN };
}

/** Why a step that exists cannot be used here. */
function whyNotReachable(
  info: StepInfo,
  use: Use,
): { code: Issue["code"]; message: string } {
  if (isPrefix(info.path, use.nodePath))
    return {
      code: "reference_to_later_step",
      message: `${shown(info.id)} is still running here: it contains this step, and its values exist only when it has ended. Use a step that ends before.`,
    };
  const later =
    comparePaths(info.path, use.nodePath) > 0 &&
    !isPrefix(use.nodePath, info.path);
  const ours = new Set(use.branches.map((b) => `${b.ifId}/${b.branch}`));
  const foreign = info.branches.find((b) => !ours.has(`${b.ifId}/${b.branch}`));
  const otherBranchOfOurIf =
    foreign !== undefined && use.branches.some((b) => b.ifId === foreign.ifId);
  if (foreign !== undefined && (!later || otherBranchOfOurIf))
    return {
      code: "reference_not_in_scope",
      message: `${shown(info.id)} is in the '${foreign.branch}' branch of the if ${shown(foreign.ifId)}. A step in a branch is certain to have run only inside that branch; after the if only '${clip(foreign.ifId)}.taken' is available.`,
    };
  return {
    code: "reference_to_later_step",
    message: `${shown(info.id)} (${info.path}) comes later than this text, or is this step itself. Steps run in order and can only use what ran before them.`,
  };
}

function descend(
  binding: Binding,
  rest: readonly string[],
  ref: Reference,
  context: ScopeContext,
  use: Use,
): Resolution {
  let current: ValueType = binding.type;
  const trail: string[] = [binding.id];
  for (const [position, name] of rest.entries()) {
    if (current.kind === "unknown") return { type: UNKNOWN };
    if (current.kind !== "object")
      return fail(
        context,
        use,
        "reference_unknown_field",
        `${shown(trail.join("."))} is ${describeType(current)} and has no field ${shown(name)}.`,
        [],
      );
    const field: FieldType | undefined = Object.hasOwn(current.fields, name)
      ? current.fields[name]
      : undefined;
    if (field === undefined) {
      const reason =
        position === 0 && Object.hasOwn(binding.unavailable, name)
          ? binding.unavailable[name]
          : undefined;
      if (reason !== undefined)
        return fail(
          context,
          use,
          "reference_fact_unavailable",
          reason,
          Object.keys(current.fields),
        );
      if (position === 0 && binding.open === true) return { type: UNKNOWN };
      const known = Object.keys(current.fields);
      return fail(
        context,
        use,
        "reference_unknown_field",
        `${shown(trail.join("."))} has no field ${shown(name)}. Its fields: ${listNames(known)}.`,
        known,
      );
    }
    if (!field.required && ref.default === undefined)
      return fail(
        context,
        use,
        "reference_optional_field",
        `${shown([...trail, name].join("."))} is not a required field of the result, so it may be missing. Make it required in the result schema, or give a default: {{${clip(ref.raw)} | default "…"}}.`,
      );
    trail.push(name);
    current = field.type;
  }
  if (ref.default !== undefined && !valueFits(ref.default.value, current))
    context.report(
      issue(
        use.path,
        "default_type_mismatch",
        `The default of ${shown(ref.path.join("."))} does not fit its value, which is ${describeType(current)}.`,
      ),
    );
  return { type: current };
}

/** Why `previous.<stepId>` names nothing: it belongs to an outer loop, sits inside an `if` of the body, or is no step of the body. */
function notPreviousMessage(
  stepId: string,
  frame: LoopFrame,
  use: Use,
  context: ScopeContext,
): string {
  const outer = use.env.loops.find(
    (other) => other !== frame && other.previous.has(stepId),
  );
  if (outer !== undefined)
    return `${shown(stepId)} is a step of the outer loop '${outer.id}'. 'previous.' names the steps of the innermost loop only, '${frame.id}'; use ${shown(stepId)} without 'previous.' if it ran before this loop.`;
  const info = context.index.get(stepId);
  if (info !== undefined && isPrefix(frame.bodyPath, info.path))
    return `${shown(stepId)} sits inside an if (or a loop) of the body of '${frame.id}' and may not have run in the round before. 'previous.' names the steps that always run: the direct steps of the body.`;
  return `${shown(stepId)} is no step of the body of the loop '${frame.id}'. 'previous.' names its direct steps.`;
}

/** The type of what `ref` points at, or an issue reported and `unknown` returned (so a mistake is reported once). */
export function resolveReference(
  ref: Reference,
  context: ScopeContext,
  use: Use,
): Resolution {
  const [root, ...rest] = ref.path as [string, ...string[]];
  if (root === "previous") {
    const frame = use.env.loops[use.env.loops.length - 1];
    if (frame === undefined)
      return fail(
        context,
        use,
        "previous_outside_loop",
        "'previous' is the value a step of a loop had in the round before. It exists only inside a loop body.",
        namesInReach(use.env, false).names,
      );
    if (ref.default === undefined && !use.previousOk)
      return fail(
        context,
        use,
        "previous_without_default",
        `In round one there is no previous round, so ${shown(ref.raw)} has no value. Use it in the 'next' instruction of the step, or give a default: {{${clip(ref.raw)} | default "…"}}.`,
      );
    const [stepId, ...fieldPath] = rest;
    if (stepId === undefined)
      return fail(
        context,
        use,
        "previous_unknown_step",
        "Name a step of the loop body after 'previous.', like previous.review.findings.",
        firstOf(frame.previous.keys()),
      );
    const binding = frame.previous.get(stepId);
    if (binding === undefined)
      return fail(
        context,
        use,
        "previous_unknown_step",
        notPreviousMessage(stepId, frame, use, context),
        firstOf(frame.previous.keys()),
      );
    return descend(binding, fieldPath, ref, context, use);
  }
  const binding = use.env.scope.get(root);
  if (binding !== undefined) return descend(binding, rest, ref, context, use);
  const info = context.index.get(root);
  if (info !== undefined) {
    const why = whyNotReachable(info, use);
    return fail(
      context,
      use,
      why.code,
      why.message,
      namesInReach(use.env, true).names,
    );
  }
  const reach = namesInReach(use.env, true);
  return fail(
    context,
    use,
    "reference_unknown_step",
    `${shown(root)} is not a step of this workflow. In reach here: ${listNames(reach.names, reach.total)}.`,
    reach.names,
  );
}
