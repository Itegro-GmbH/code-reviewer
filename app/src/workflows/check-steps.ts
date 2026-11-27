// SPDX-License-Identifier: LicenseRef-Proprietary

// The steps of a workflow in the order they run (#833): the shape of each node, and everything that depends on what ran before it.
// `check-values.ts` checks the texts and values, `scope.ts` what a reference can reach.
import {
  CLAUDE_CODE_HARNESS,
  CLAUDE_CODE_PROVIDER,
  OPENCODE_HARNESS,
  harnessNeedsRunner,
  harnessOfProfile,
} from "../runner-identity/harness.ts";
import type { ModelChoice } from "../db/implementer-model-choice.ts";
import {
  NETWORK_HOSTS_MAX,
  NETWORK_HOST_MAX_LENGTH,
  NETWORK_MODES,
  isNetworkMode,
  normalizeHostEntry,
} from "../network-rule/network.ts";
import {
  INLINE_SETTING_KEYS,
  MODEL_HINT,
  checkHarness,
  checkInstructions,
  checkModelFitsHarness,
  isInlineStep,
  readModel,
} from "./agent-settings.ts";
import {
  checkCondition,
  checkInput,
  checkLiteral,
  checkText,
  type TargetCheck,
} from "./check-values.ts";
import {
  COST_FACT,
  FACT_NAMES,
  FACT_TYPES,
  PUSH_FACTS,
  REPOS_FACT,
  REPOS_FACT_TYPE,
} from "./facts.ts";
import {
  FAILURE_ID,
  ON_FAILURE_CONNECTORS,
  ON_FAILURE_KINDS,
} from "./failure.ts";
import { isRecord, jsonTypeName, textLength } from "./json.ts";
import { jiraLabel } from "./label-match.ts";
import {
  DESCRIPTION_MAX_LENGTH,
  ID_MAX_LENGTH,
  LOOP_NESTING_MAX,
  LOOP_ROUNDS_MAX,
  NAMES_LISTED_MAX,
  NESTING_DEPTH_MAX,
  SETUP_SCRIPT_MAX_BYTES,
} from "./limits.ts";
import { demandOfProfile } from "../runner-identity/access.ts";
import {
  announcedBy,
  announcedByRunner,
  describeDemand,
} from "../runner-identity/announced.ts";
import { issue, listNames, pointer, shown, warning } from "./issues.ts";
import { checkStepMcp } from "./mcp-check.ts";
import {
  parseProfileRef,
  type EnvironmentInfo,
  type ProfileInfo,
  type ProfileVersionFacts,
  type RunnerInfo,
  type WorkflowResolver,
} from "./resolver.ts";
import {
  objectTypeOf,
  validateResultSchema,
  type ResultSchema,
} from "./result-schema.ts";
import {
  GITHUB_ISSUE_LABELS,
  PROJECT_MEMBERS,
  PULL_REQUEST_COMMENT,
  PULL_REQUEST_OPENING_CONNECTORS,
  PUSH_BRANCH_ROOTS,
  REPOS_BASE_ROOTS,
  REPOS_BRANCH_ROOTS,
  REPOS_REPO_ROOTS,
  START_BRANCH_ROOTS,
  TICKET_LABELS,
  TICKET_REQUEST_REVIEW,
  TICKET_SET_STATUS,
  type ConnectorSpec,
} from "./connectors.ts";
import { literalText, parseTemplate } from "./template.ts";
import { isPushBranchName } from "../implementer/branch-name.ts";
import {
  SESSION_REPOS_MAX,
  deriveMountNames,
  firstRepeat,
  isRepositoryFullName,
} from "../db/session-repos.ts";
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
  /** The MCP servers the lane names (`mcp` of the document, #1052): what a step's own `mcp` may narrow to. Left out: the lane names none. */
  laneMcp?: ReadonlySet<string>;
  /**
   * The labels (trimmed, lower case) a step here may not add, because they start the workflow: those of its label triggers that are
   * well formed. The pre-steps of a trigger that is not a label trigger have none: the bot's own writes start no run (#916).
   */
  retriggerLabels?: readonly string[];
  /**
   * The statuses (trimmed, lower case) a step here should not move a ticket into, because they start the workflow (#1036): those of its
   * status triggers that are well formed. A warning, not an error. The pre-steps of a trigger that is no status trigger have none.
   */
  retriggerStatuses?: readonly string[];
  /**
   * Called with where a node sits and what it can reach, before the node is checked (and for the `until` of a loop, with the scope of
   * the body). The scope lookup of the lane builder (`reach.ts`) reads the reach here, so it is the validator's own and not a copy.
   */
  probe?: (path: string, env: Env, state: StepState) => void;
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

/** The model of a step with settings of its own, when it is one of the two shapes. */
function inlineModelOf(node: Record<string, unknown>): ModelChoice | undefined {
  return readModel(node.model);
}

/**
 * What the validator knows about a step's settings, from the profile version it runs or, for a step with settings of its own, from the
 * step. Silent: the checks report. A profile nobody knows has no facts (reported where it is written). An inline step whose `canPush`
 * is not a boolean is taken as one that may push, as a profile without facts is, so one mistake is not reported at every use.
 */
function factsOf(
  node: Record<string, unknown>,
  resolver: WorkflowResolver,
): ProfileVersionFacts | undefined {
  if (!isInlineStep(node)) return findProfile(node.profile, resolver)?.facts;
  const model = inlineModelOf(node);
  const harness =
    node.harness === CLAUDE_CODE_HARNESS
      ? CLAUDE_CODE_HARNESS
      : OPENCODE_HARNESS;
  return {
    canPush: node.canPush !== false,
    harness,
    ...(model === undefined ? {} : { managedModel: "entryId" in model }),
    ...(model !== undefined &&
    harness === CLAUDE_CODE_HARNESS &&
    "provider" in model &&
    model.provider === CLAUDE_CODE_PROVIDER
      ? { model: model.model }
      : {}),
  };
}

/** How a message names what holds the settings: the profile, or the step itself. */
function subjectOf(node: Record<string, unknown>): string {
  return isInlineStep(node)
    ? `the step ${shown(String(node.id))}`
    : `the profile ${shown(parseProfileRef(String(node.profile))?.name ?? "")}`;
}

/**
 * The environment an agent step runs in (#919): the one of its profile version, else the one the step names (a version saved before
 * profiles had one). `fromProfile` says which; `info` is undefined when the environment is not one of the workspace (reported where it
 * is written) and `name` is then what the step wrote, if it wrote a literal.
 */
function environmentOf(
  node: Record<string, unknown>,
  resolver: WorkflowResolver,
):
  | { fromProfile: boolean; info: EnvironmentInfo | undefined; name?: string }
  | undefined {
  const id = findProfile(node.profile, resolver)?.facts?.environmentId;
  if (typeof id === "string")
    return {
      fromProfile: true,
      info: resolver.environments().find((e) => e.id === id),
    };
  const name =
    typeof node.environment === "string"
      ? literalText(parseTemplate(node.environment))
      : undefined;
  if (name === undefined) return undefined;
  return {
    fromProfile: false,
    name,
    info: resolver
      .environments()
      .find((e) => e.name.toLowerCase() === name.toLowerCase()),
  };
}

/**
 * The runner a step with settings of its own names (#1105, ADR 0007): the id it wrote (a literal; anything else is reported where it is
 * written) and the runner of the workspace with that id. `info` is undefined for an id of no runner of the workspace; a resolver that does
 * not know the workspace's runners knows none.
 */
function runnerOfStep(
  node: Record<string, unknown>,
  resolver: WorkflowResolver,
): { id: string; info: RunnerInfo | undefined } | undefined {
  if (typeof node.runner !== "string") return undefined;
  const id = literalText(parseTemplate(node.runner));
  if (id === undefined) return undefined;
  return { id, info: resolver.runners?.().find((runner) => runner.id === id) };
}

/** The ids of the runners a step may name (a revoked one is not offered). */
function runnerIds(resolver: WorkflowResolver): string[] {
  return (resolver.runners?.() ?? [])
    .filter((runner) => runner.revoked !== true && runner.unavailable !== true)
    .map((runner) => runner.id);
}

/** "id (name)" for every runner a step may name, for a message: the `available` of the issue holds the ids alone, so they can be copied. */
function runnersListed(resolver: WorkflowResolver): string {
  const pairs = (resolver.runners?.() ?? [])
    .filter((runner) => runner.revoked !== true && runner.unavailable !== true)
    .map((runner) => `${runner.id} (${runner.name})`);
  return listNames(pairs);
}

/** The profile name and the environment (lower case) an agent step runs with: what makes two steps share a session. */
function setupOf(
  node: Record<string, unknown>,
  resolver: WorkflowResolver,
): NonNullable<Binding["agent"]> {
  const found = environmentOf(node, resolver);
  const environment = (found?.info?.name ?? found?.name)?.toLowerCase();
  const profile =
    typeof node.profile === "string"
      ? parseProfileRef(node.profile)?.name
      : undefined;
  const model = isInlineStep(node) ? inlineModelOf(node) : undefined;
  const runner = runnerOfStep(node, resolver)?.id;
  return {
    ...(profile === undefined ? {} : { profile }),
    ...(environment === undefined ? {} : { environment }),
    ...(runner === undefined ? {} : { runner }),
    ...(isInlineStep(node)
      ? {
          settings: {
            harness:
              node.harness === CLAUDE_CODE_HARNESS
                ? CLAUDE_CODE_HARNESS
                : OPENCODE_HARNESS,
            model:
              model === undefined
                ? ""
                : "entryId" in model
                  ? `entry ${model.entryId}`
                  : `${model.provider}/${model.model}`,
            canPush: String(node.canPush !== false),
            instructions:
              typeof node.instructions === "string" ? node.instructions : "",
          },
        }
      : {}),
  };
}

/** What an agent step yields: its declared result, and the facts. Silent: the checks report. */
export function agentBinding(
  node: Record<string, unknown>,
  resolver: WorkflowResolver,
  /** #1092: the step works on several repositories (its own `repos`, or those of the session it continues). */
  withRepos = Array.isArray(node.repos),
): Binding {
  const id = node.id as string;
  const settings = factsOf(node, resolver);
  // A profile nobody knows is reported where it is written; its facts stay, so one mistake is not reported at every use.
  const canPush = settings?.canPush ?? true;
  const declared =
    node.result === undefined
      ? undefined
      : validateResultSchema(node.result).schema;
  const schema: ResultSchema | undefined =
    declared ??
    (node.result === undefined ? settings?.defaultResult : undefined);

  const entries: [string, FieldType][] =
    schema === undefined
      ? []
      : Object.entries(objectTypeOf(schema).fields).filter(
          ([name]) =>
            !FACT_NAMES.includes(name) && !(withRepos && name === REPOS_FACT),
        );
  const facts = canPush ? [COST_FACT, ...PUSH_FACTS] : [COST_FACT];
  for (const name of facts)
    entries.push([
      name,
      { type: FACT_TYPES[name] as FieldType["type"], required: true },
    ]);
  // #1092: the list of the repositories of a step that has several; like the push facts it exists for a profile that may push only.
  if (withRepos && canPush)
    entries.push([REPOS_FACT, { type: REPOS_FACT_TYPE, required: true }]);
  const fields: Record<string, FieldType> = Object.fromEntries(entries);
  const reason = isInlineStep(node)
    ? `The step ${shown(id)} has canPush false, so it yields no branch, no commits, no head commit and no push state. Set canPush to true, or reference the result of the step.`
    : `The profile ${shown(String(node.profile))} may not push, so ${shown(id)} yields no branch, no commits, no head commit and no push state. Use a profile that may push, or reference the result of the step.`;
  return {
    id,
    kind: "agent",
    type: { kind: "object", fields },
    unavailable: canPush
      ? {}
      : Object.fromEntries(
          [...PUSH_FACTS, ...(withRepos ? [REPOS_FACT] : [])].map((name) => [
            name,
            reason,
          ]),
        ),
    // A result that failed its check is reported where it is written; its fields are unknown, not missing.
    ...(node.result !== undefined && declared === undefined
      ? { open: true }
      : {}),
    agent: setupOf(node, resolver),
    ...(withRepos ? { repos: true as const } : {}),
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

/**
 * What an action yields. A pull request step with `repos` (#1094) yields the single fields of the first pull request that exists, and none when
 * every repository is skipped, so they are optional there (read them with a default); without `repos` they are always there, as before.
 */
function outputOf(
  spec: ConnectorSpec,
  node: Record<string, unknown>,
): ConnectorSpec["output"] {
  if (!PULL_REQUEST_OPENING_CONNECTORS.includes(spec.name)) return spec.output;
  // The single form yields the three fields of its one pull request, as it always did.
  if (node.repos === undefined)
    return {
      kind: "object",
      fields: Object.fromEntries(
        Object.entries(spec.output.fields).filter(
          ([name]) => name !== "pullRequests" && name !== "repository",
        ),
      ),
    };
  return {
    kind: "object",
    fields: Object.fromEntries(
      Object.entries(spec.output.fields).map(([name, field]) => [
        name,
        ["number", "url", "existing", "repository"].includes(name)
          ? { ...field, required: false }
          : field,
      ]),
    ),
  };
}

/** #1094: what the `pullRequest` (and `repository`) input of an action that acts on a pull request tells the scope check about its references. */
function pullRequestUse(
  connector: string,
  input: string,
): { pullRequestInput?: "review" | "comment" } {
  if (connector === TICKET_REQUEST_REVIEW.name)
    return input === "pullRequest" || input === "repository"
      ? { pullRequestInput: "review" }
      : {};
  if (connector === PULL_REQUEST_COMMENT.name && input === "pullRequest")
    return { pullRequestInput: "comment" };
  return {};
}

export function actionBinding(
  node: Record<string, unknown>,
  resolver: WorkflowResolver,
): Binding {
  const spec = connectorOf(node, resolver);
  return {
    id: node.id as string,
    kind: "action",
    type: spec === undefined ? { kind: "unknown" } : outputOf(spec, node),
    unavailable: {},
    ...(spec === undefined ? {} : { connector: spec.name }),
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
  ...INLINE_SETTING_KEYS,
  "environment",
  "instruction",
  "session",
  "branch",
  "pushBranch",
  "repos",
  "result",
  "mcp",
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

/**
 * #1105 (ADR 0007): a step names a profile or carries its settings itself, exactly one of the two. The profile is checked as before; the
 * settings are checked here against what the workspace allows, with the same rules a profile gets when it is saved.
 */
function checkSettingsForm(
  node: Record<string, unknown>,
  path: string,
  c: Checker,
): void {
  const given = INLINE_SETTING_KEYS.filter((key) => node[key] !== undefined);
  if (node.profile !== undefined) {
    checkProfile(node, path, c);
    if (given.length > 0)
      c.report(
        issue(
          pointer(path, "profile"),
          "profile_with_inline_settings",
          `A step names a profile or carries its settings, not both. This one names a profile and also has ${listNames([...given])}. Take the profile out and keep the settings, or take the settings out.`,
          [...INLINE_SETTING_KEYS],
        ),
      );
    return;
  }
  if (given.length === 0) {
    c.report(
      issue(
        path,
        "agent_settings_required",
        `An agent step needs its settings: a "profile" (like "implementer"), or the settings themselves: "model", "canPush" and optionally "harness", "instructions", "setupScript", "network".`,
        [...INLINE_SETTING_KEYS],
      ),
    );
    return;
  }
  checkInlineSettings(node, path, c);
}

function checkInlineSettings(
  node: Record<string, unknown>,
  path: string,
  c: Checker,
): void {
  const harness = checkHarness(
    node.harness,
    pointer(path, "harness"),
    c.report,
    "step",
  );

  const modelAt = pointer(path, "model");
  let model: ModelChoice | undefined;
  if (node.model === undefined)
    c.report(
      issue(
        pointer(path, "model"),
        "missing_field",
        `The field "model" is required in a step with settings of its own. ${MODEL_HINT}`,
      ),
    );
  else if (!isRecord(node.model))
    c.report(
      issue(
        modelAt,
        "wrong_type",
        `The model is an object, not ${jsonTypeName(node.model)}. ${MODEL_HINT}`,
      ),
    );
  else {
    model = readModel(node.model);
    if (model === undefined)
      c.report(issue(modelAt, "invalid_value", MODEL_HINT));
  }
  if (model !== undefined) {
    checkModelFitsHarness(model, harness, modelAt, c.report, "step");
    // Whether the workspace can run it (the rule of the Implementer form, as a profile is held to it when saved) is what the service
    // looked up for the document. A harness on a login has no catalog and no key of the workspace behind it: nothing to ask.
    const reason =
      harness === CLAUDE_CODE_HARNESS ? null : c.resolver.modelCheck?.(model);
    if (typeof reason === "string")
      c.report(
        issue(
          modelAt,
          "model_not_allowed",
          `This workspace cannot run that model (reason: ${shown(reason)}). GET /api/w/<workspace>/implementer/models lists the models it can.`,
        ),
      );
  }

  if (node.canPush === undefined)
    c.report(
      issue(
        pointer(path, "canPush"),
        "missing_field",
        'The field "canPush" is required in a step with settings of its own: true if the step may push branches, false if not (a step that only reads, like a reviewer).',
      ),
    );
  else if (typeof node.canPush !== "boolean")
    c.report(
      issue(
        pointer(path, "canPush"),
        "wrong_type",
        `canPush is true or false, not ${jsonTypeName(node.canPush)}.`,
      ),
    );

  if (node.instructions !== undefined) {
    const at = pointer(path, "instructions");
    if (node.instructions === "")
      c.report(
        issue(
          at,
          "invalid_value",
          'The field "instructions" is the standing text of the agent. Write it, or leave the field out.',
        ),
      );
    else checkInstructions(node.instructions, at, c.report);
  }

  checkHostedSettings(node, path, c);
}

/** The setup script and the network rule of an environment, now settings of the step (ADR 0007, decision 11, amended by #1126: any runner). */
function checkHostedSettings(
  node: Record<string, unknown>,
  path: string,
  c: Checker,
): void {
  const script = node.setupScript;
  if (script !== undefined) {
    const at = pointer(path, "setupScript");
    if (typeof script !== "string")
      c.report(
        issue(
          at,
          "wrong_type",
          `The setup script is a text, not ${jsonTypeName(script)}.`,
        ),
      );
    else if (
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(
        script,
      ) ||
      script.includes("\u0000")
    )
      c.report(
        issue(
          at,
          "invalid_value",
          "The setup script holds a NUL byte or a broken character; it is kept as written and must be text.",
        ),
      );
    else if (new TextEncoder().encode(script).length > SETUP_SCRIPT_MAX_BYTES)
      c.report(
        issue(
          at,
          "limit_exceeded",
          `The setup script may have ${SETUP_SCRIPT_MAX_BYTES} bytes at most.`,
        ),
      );
  }
  if (node.network !== undefined)
    checkNetworkRule(node.network, pointer(path, "network"), c);
  // #1176: no refusal here for `open` or a wide list on the harness `claude-code`: its token is behind the model door, never in the
  // agent's container (a runner that predates that refuses the turn itself, free, when it starts).
}

/**
 * The network rule of a step (ADR 0007, decision 11), as the environment held it. The shape is the schema's (a mode of the three, `hosts`
 * only with `list` and then one to 100); that a host entry is a host name the rule can hold (not an address, not a port) only the
 * validator knows (`network_host_invalid`).
 */
function checkNetworkRule(value: unknown, at: string, c: Checker): void {
  if (!isRecord(value)) {
    c.report(
      issue(
        at,
        "wrong_type",
        `The network rule is {"mode": "off" | "list" | "open", "hosts": [...]}, not ${jsonTypeName(value)}.`,
      ),
    );
    return;
  }
  keysOf(value, ["mode", "hosts"], at, c);
  const mode = value.mode;
  if (mode === undefined) missing(at, "mode", '"off", "list" or "open".', c);
  else if (typeof mode !== "string" || !isNetworkMode(mode))
    c.report(
      issue(
        pointer(at, "mode"),
        typeof mode === "string" ? "invalid_value" : "wrong_type",
        `The mode of a network rule is ${NETWORK_MODES.map((name) => shown(name)).join(", ")}.`,
        NETWORK_MODES,
      ),
    );
  const hosts = value.hosts;
  const hostsAt = pointer(at, "hosts");
  if (hosts === undefined) {
    if (mode === "list")
      missing(
        at,
        "hosts",
        'the host names the agent may reach, because the mode is "list".',
        c,
      );
    return;
  }
  if (!Array.isArray(hosts)) {
    c.report(
      issue(
        hostsAt,
        "wrong_type",
        `'hosts' is a list of host names, not ${jsonTypeName(hosts)}.`,
      ),
    );
    return;
  }
  if (isNetworkMode(mode) && mode !== "list" && hosts.length > 0)
    c.report(
      issue(
        hostsAt,
        "invalid_value",
        `Host names belong to the mode "list"; the mode ${shown(mode)} takes none. Take 'hosts' out, or use "list".`,
      ),
    );
  // The schema's bound is on the entries as written (`maxItems` 100). Past that the entries are not walked.
  if (hosts.length > NETWORK_HOSTS_MAX) {
    c.report(
      issue(
        hostsAt,
        "limit_exceeded",
        `A network rule names ${NETWORK_HOSTS_MAX} hosts at most; this one has ${hosts.length}.`,
      ),
    );
    return;
  }
  // The engine's own reading (`checkNetwork`): an entry of white space between others is nothing, and the entries are normalised and
  // made unique, so a list of them names a host exactly when the engine finds one. (An empty text is still refused: the schema does.)
  const effective = new Set<string>();
  for (const [index, host] of hosts.entries()) {
    const entryAt = pointer(hostsAt, index);
    if (typeof host !== "string") {
      c.report(
        issue(
          entryAt,
          "wrong_type",
          `A host is a text, not ${jsonTypeName(host)}.`,
        ),
      );
      continue;
    }
    if (host === "") {
      c.report(issue(entryAt, "invalid_value", "A host is not empty."));
      continue;
    }
    if (host.trim() === "") continue;
    if (host.length > NETWORK_HOST_MAX_LENGTH) {
      c.report(
        issue(
          entryAt,
          "limit_exceeded",
          `A host may have ${NETWORK_HOST_MAX_LENGTH} characters at most.`,
        ),
      );
      continue;
    }
    const form = normalizeHostEntry(host);
    if (form === null) {
      c.report(
        issue(
          entryAt,
          "network_host_invalid",
          `${shown(host)} is not a host name the rule can hold. Write an exact name ("registry.npmjs.org") or a suffix ("*.pythonhosted.org"), with no scheme, port, path or address.`,
        ),
      );
      continue;
    }
    effective.add(form);
  }
  if (mode !== "list") return;
  if (
    effective.size === 0 &&
    hosts.every(
      (host) => typeof host === "string" && host !== "" && host.trim() === "",
    )
  )
    c.report(
      issue(
        hostsAt,
        "invalid_value",
        'A network rule of mode "list" names at least one host.',
      ),
    );
}

/**
 * #1105 (ADR 0007, decisions 6 and 14): a step with settings of its own says where it runs by the **id of a concrete runner** (a hosted
 * runner of one type, such as "Vercel Sandbox 4 vCPU", or a self-hosted one). `environment` stays accepted in release A for documents written
 * before the runner; a step names one of the two, never both. The id is a literal: where an agent runs is a target (nothing an agent wrote).
 * A rename of the runner changes no id, so no lane; a runner that was revoked and registered again has a new id.
 */
function checkRunner(
  node: Record<string, unknown>,
  path: string,
  c: Checker,
  use: Omit<Use, "path">,
): void {
  if (!isInlineStep(node)) return;
  const at = pointer(path, "runner");
  if (node.runner === undefined) {
    if (node.environment !== undefined) return;
    c.report(
      issue(
        at,
        "runner_required",
        `A step with settings of its own names the runner it runs on: the id of one of these runners (the "runner" field). Runners: ${runnersListed(c.resolver)}.`,
        runnerIds(c.resolver),
      ),
    );
    return;
  }
  if (node.environment !== undefined)
    c.report(
      issue(
        pointer(path, "environment"),
        "runner_with_environment",
        `A step runs in one place: it names a "runner" or an "environment", not both. Take the environment out and keep the runner (an environment is accepted only for steps written before the runner).`,
      ),
    );
  const id = stringField(
    node,
    "runner",
    path,
    "the id of a runner of the workspace.",
    c,
    false,
  );
  if (id === undefined) return;
  const literal = checkLiteral(
    id,
    c,
    { ...use, path: at },
    "'runner' decides where the agent works, so in version 1 it is a literal: the id of a runner of the workspace. A reference to the trigger or to a result is not taken.",
    "target_from_untrusted_value",
  );
  if (literal === undefined) return;
  const found = c.resolver.runners?.().find((runner) => runner.id === literal);
  if (found?.revoked === true) {
    c.report(
      issue(
        at,
        "runner_unknown",
        `The runner ${shown(found.name)} was revoked. A runner that is registered again has a new id: name that runner, or another. Runners: ${runnersListed(c.resolver)}.`,
        runnerIds(c.resolver),
      ),
    );
    return;
  }
  if (found?.unavailable === true) {
    c.report(
      issue(
        at,
        "runner_unavailable",
        `The runner ${shown(found.name)} is switched off on this server (the operator did not enable that size of the placement). Name another runner. Runners: ${runnersListed(c.resolver)}.`,
        runnerIds(c.resolver),
      ),
    );
    return;
  }
  if (found !== undefined) return;
  const byName = (c.resolver.runners?.() ?? []).find(
    (runner) =>
      runner.revoked !== true &&
      runner.unavailable !== true &&
      runner.name.toLowerCase() === literal.toLowerCase(),
  );
  c.report(
    issue(
      at,
      "runner_unknown",
      byName === undefined
        ? `There is no runner ${shown(literal)} in this workspace. The step names a runner by its id. Runners: ${runnersListed(c.resolver)}.`
        : `${shown(literal)} is the name of a runner, and the step names a runner by its id (a rename changes no id): write ${shown(byName.id)}. Runners: ${runnersListed(c.resolver)}.`,
      runnerIds(c.resolver),
    ),
  );
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
    false,
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
 * #919: a profile says where it works, so the environment of a step is optional and must be the profile's when it is written. A version
 * saved before profiles had an environment names none: its step names one, as before.
 */
function checkProfileEnvironment(
  node: Record<string, unknown>,
  path: string,
  c: Checker,
): void {
  if (isInlineStep(node)) return;
  const facts = findProfile(node.profile, c.resolver)?.facts;
  // A profile nobody knows is reported where it is written; a version with no facts is not known, and nothing is refused on a guess.
  if (facts === undefined) return;
  const profile = shown(parseProfileRef(node.profile as string)?.name ?? "");
  const names = c.resolver.environments().map((e) => e.name);
  const id = facts.environmentId;
  if (typeof id !== "string") {
    if (node.environment === undefined)
      c.report(
        issue(
          pointer(path, "environment"),
          "environment_required",
          `The profile ${profile} names no environment (this version was saved before profiles had one), so the step names one. Environments: ${listNames(names)}. Or save a new version of the profile with an "environment".`,
          names,
        ),
      );
    return;
  }
  const own = c.resolver.environments().find((e) => e.id === id);
  if (own === undefined) {
    c.report(
      issue(
        pointer(path, "profile"),
        "environment_unknown",
        `The profile ${profile} runs in an environment that is no longer in this workspace. Save a new version of the profile with one of: ${listNames(names)}.`,
        names,
      ),
    );
    return;
  }
  const written =
    typeof node.environment === "string"
      ? literalText(parseTemplate(node.environment))
      : undefined;
  if (written !== undefined && written.toLowerCase() !== own.name.toLowerCase())
    c.report(
      issue(
        pointer(path, "environment"),
        "environment_mismatch",
        `The profile ${profile} runs in the environment ${shown(own.name)}, not ${shown(written)}. A profile says where it works: leave "environment" out of the step, or write ${shown(own.name)}.`,
        [own.name],
      ),
    );
}

/**
 * #854: what a profile and an environment can only do together. A runner works with its owner's own key, so a profile with a managed
 * model has no place in a runner environment; and a harness the platform's catalog does not hold (any but OpenCode) exists only on a
 * runner. Both are reported where the environment is written, or at the profile when the environment is the profile's (#919). A name
 * nobody knows is reported by the checks above and not again here.
 */
function checkRunnerRules(
  node: Record<string, unknown>,
  path: string,
  c: Checker,
): void {
  const found = environmentOf(node, c.resolver);
  const known = found?.info;
  const facts = factsOf(node, c.resolver);
  if (found === undefined || known === undefined || facts === undefined) return;
  const where = pointer(path, found.fromProfile ? "profile" : "environment");
  const subject = subjectOf(node);
  const inline = isInlineStep(node);
  const onRunner = known.kind === "runner";
  if (onRunner && facts.managedModel === true)
    c.report(
      issue(
        where,
        "runner_needs_own_key",
        `The environment ${shown(known.name)} runs on a runner, which works with the workspace's own key, but ${subject} uses a managed model. ${inline ? "Use a model of your own key" : "Use a profile with a model of your own key"}, or a platform environment.`,
      ),
    );
  const harness = harnessOfProfile(facts);
  // #973: what the runners of the workspace announce. Only a runner with the environment's labels that is online can say, and what it says
  // can change (it may be asleep, or leave an entry out for a while), so this is a warning and never stops a save. A managed model is already
  // refused above, so it is not judged twice.
  const runners = c.resolver.onlineRunners?.();
  if (
    onRunner &&
    facts.managedModel !== true &&
    runners !== undefined &&
    known.labels !== undefined &&
    announcedBy(runners, known.labels, demandOfProfile(facts)) ===
      "not_announced"
  )
    c.report(
      warning(
        where,
        "no_runner_announces",
        `The environment ${shown(known.name)} runs on a runner, and the runners with its labels that are online do not announce what ${subject} asks for (${describeDemand(demandOfProfile(facts))}). The workflow can still be saved; the turn waits until a runner announces it.`,
      ),
    );
  // #1150: with a Claude Code OAuth token in the workspace's LLM keys the harness runs on a hosted environment too (its Sandbox VM runs on the token).
  if (
    !onRunner &&
    harnessNeedsRunner(harness) &&
    c.resolver.claudeCodeToken?.() !== true
  )
    c.report(
      issue(
        where,
        "harness_needs_runner",
        `${inline ? "The step" : `The profile ${shown(parseProfileRef(String(node.profile))?.name ?? "")}`} runs with the harness ${shown(harness)}, which needs a login of its own: the workspace has no Claude Code OAuth token (save one under LLM keys), and the environment ${shown(known.name)} is not on a self-hosted runner. Save the token, or use an environment that runs on a runner.`,
      ),
    );
}

/**
 * #1105 (ADR 0007, "What the validator checks"): the rules a profile and an environment had together, at the runner a step names. A
 * self-hosted runner works with its owner's own key (`runner_needs_own_key`) and says what it can run (`no_runner_announces`, a warning,
 * judged over the runner's own announcement and only when it is online); a harness the platform's catalog does not hold exists only on a
 * self-hosted runner (`harness_needs_runner`). A runner nobody knows is reported by `checkRunner` and not again here.
 */
function checkRunnerRulesAtRunner(
  node: Record<string, unknown>,
  path: string,
  c: Checker,
): void {
  const placed = runnerOfStep(node, c.resolver);
  const known = placed?.info;
  const facts = factsOf(node, c.resolver);
  if (
    placed === undefined ||
    known === undefined ||
    known.revoked === true ||
    facts === undefined
  )
    return;
  const where = pointer(path, "runner");
  const subject = subjectOf(node);
  const selfHosted = known.kind === "self_hosted";
  if (selfHosted && facts.managedModel === true)
    c.report(
      issue(
        where,
        "runner_needs_own_key",
        `The runner ${shown(known.name)} is self-hosted and works with the workspace's own key, but ${subject} uses a managed model. Use a model of your own key, or a hosted runner.`,
      ),
    );
  const harness = harnessOfProfile(facts);
  const online = c.resolver.onlineRunners?.();
  if (
    selfHosted &&
    facts.managedModel !== true &&
    online !== undefined &&
    announcedByRunner(online, known.id, demandOfProfile(facts)) ===
      "not_announced"
  )
    c.report(
      warning(
        where,
        "no_runner_announces",
        `The runner ${shown(known.name)} is online and does not announce what ${subject} asks for (${describeDemand(demandOfProfile(facts))}). The workflow can still be saved; the turn waits until it announces it.`,
      ),
    );
  // #1150: as above, a Claude Code OAuth token of the workspace lets the harness run on a hosted runner.
  if (
    !selfHosted &&
    harnessNeedsRunner(harness) &&
    c.resolver.claudeCodeToken?.() !== true
  )
    c.report(
      issue(
        where,
        "harness_needs_runner",
        `${subject.charAt(0).toUpperCase()}${subject.slice(1)} runs with the harness ${shown(harness)}, which needs a login of its own: the workspace has no Claude Code OAuth token (save one under LLM keys), and the runner ${shown(known.name)} is a hosted one. Save the token, or name a self-hosted runner.`,
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
  const mine = setupOf(node, c.resolver);
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
  // #1105: and on the same runner, when either step names one: the session's files live on that machine.
  if (
    (mine.runner !== undefined || theirs.runner !== undefined) &&
    mine.runner !== theirs.runner
  )
    c.report(
      issue(
        at,
        "session_target_invalid",
        `${shown(target)} and this step must run on the same runner to share a session: ${theirs.runner === undefined ? "the other names an environment" : `the other runs on ${shown(theirs.runner)}`}, this step ${mine.runner === undefined ? "names an environment" : `on ${shown(mine.runner)}`}. Repeat the runner of ${shown(target)} here.`,
      ),
    );
  // #1105: a session also keeps the settings of a step that carries them itself (the turn goes on with those of the session's last turn),
  // so a step that goes on in it repeats them: a `canPush` that differed would be the write token of a step that never asked for it.
  const mineSettings = mine.settings;
  const theirSettings = theirs.settings;
  if ((mineSettings === undefined) !== (theirSettings === undefined)) {
    if (mine.profile !== undefined || theirs.profile !== undefined)
      c.report(
        issue(
          at,
          "session_target_invalid",
          `${shown(target)} and this step must take their settings the same way to share a session: one names a profile, the other carries the settings itself. Repeat the settings of ${shown(target)} here.`,
        ),
      );
  } else if (mineSettings !== undefined && theirSettings !== undefined)
    for (const what of ["harness", "model", "canPush", "instructions"] as const)
      if (mineSettings[what] !== theirSettings[what])
        c.report(
          issue(
            at,
            "session_target_invalid",
            `${shown(target)} and this step differ in the setting ${shown(what)}. A step that goes on in a session repeats the harness, model, canPush and instructions of the step whose session it continues; a session keeps the settings of its last turn.`,
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
    roots: START_BRANCH_ROOTS,
  });
}

/**
 * `pushBranch` (#1177, epic #1175): the branch the session works on and pushes to instead of `workflow/<run id>/<step id>`. It decides where the
 * agent's commits go, so it is a target (a literal, or an input of a manual trigger), never text an agent wrote. A literal is a branch name.
 * It needs a step that may push, a session of its own (a session that goes on keeps its branch) and no `repos` (their entries name their
 * own branches).
 */
function checkPushBranch(
  node: Record<string, unknown>,
  path: string,
  c: Checker,
  env: Env,
  state: StepState,
): void {
  const value = node.pushBranch;
  if (value === undefined) return;
  const where = pointer(path, "pushBranch");
  if (typeof value !== "string") {
    c.report(
      issue(
        where,
        "wrong_type",
        `'pushBranch' must be a text, not ${jsonTypeName(value)}.`,
      ),
    );
    return;
  }
  const parsed = parseTemplate(value);
  const literal = parsed.problems.length > 0 ? undefined : literalText(parsed);
  if (value.trim() === "")
    c.report(
      issue(
        where,
        "invalid_value",
        "'pushBranch' is the name of a branch, not an empty text.",
      ),
    );
  else if (literal !== undefined && !isPushBranchName(literal))
    c.report(
      issue(
        where,
        "invalid_value",
        "'pushBranch' is the name of a branch (no space, no '..', no '~ ^ : ? * [', no leading '-' or '+', not starting with 'refs/' or 'heads/', at most 200 characters).",
      ),
    );
  if (factsOf(node, c.resolver)?.canPush === false)
    c.report(
      issue(
        where,
        "push_branch_without_push",
        isInlineStep(node)
          ? "This step has canPush false, so nothing it does leaves its container: there is no branch to push. Take 'pushBranch' out, or set canPush to true."
          : `The profile ${shown(String(node.profile))} may not push, so there is no branch to push. Take 'pushBranch' out, or use a profile that may push.`,
      ),
    );
  if (isRecord(node.session))
    c.report(
      issue(
        where,
        "session_target_invalid",
        "A step that goes on in a session (session.continue) works on the branch of that session, so it takes no 'pushBranch'. Use 'pushBranch' on a step that starts a session of its own.",
      ),
    );
  if (node.repos !== undefined)
    c.report(
      issue(
        where,
        "push_branch_with_repos",
        "A step with 'repos' names its branches in each entry, so it takes no 'pushBranch'. Take one of the two out.",
      ),
    );
  checkInput(value, STRING, where, c, reachOf(env, where, state), {
    input: "pushBranch",
    roots: PUSH_BRANCH_ROOTS,
    text: true,
  });
}

/** Whether the step goes on in the session of an agent step that has `repos` (#1092): its `{{<step>.repos}}` is the session's list. */
function continuesRepos(node: Record<string, unknown>, env: Env): boolean {
  const session = node.session;
  if (!isRecord(session) || typeof session.continue !== "string") return false;
  return env.scope.get(session.continue)?.repos === true;
}

/**
 * `repos` (#1092, epic #1090, ADR 0006): one to ten entries `{ repo, base?, branch? }`. All three decide what the agent works on and where its
 * commits go, so they are targets. Beside `branch` and `session` it is refused; two literals that name one repository (without regard to
 * case) are `repo_duplicate`; when every entry is a literal, two that mount under one name are `repo_name_clash`. A reference is looked at
 * again when the step runs (the engine), where it gives a repository or does not (`repo_invalid`).
 */
function checkRepos(
  node: Record<string, unknown>,
  path: string,
  c: Checker,
  env: Env,
  state: StepState,
): void {
  const value = node.repos;
  if (value === undefined) return;
  const where = pointer(path, "repos");
  if (!Array.isArray(value)) {
    c.report(
      issue(
        where,
        "wrong_type",
        `'repos' is a list of repositories, not ${jsonTypeName(value)}.`,
      ),
    );
    return;
  }
  if (node.branch !== undefined)
    c.report(
      issue(
        where,
        "repos_with_branch",
        "A step with 'repos' names its branches in each entry, so it takes no 'branch' of its own (the branch a session of its own starts from). Take one of the two out.",
      ),
    );
  if (node.session !== undefined && node.session !== "new")
    c.report(
      issue(
        where,
        "repos_with_session_continue",
        "A step that goes on in a session (session.continue) keeps the repositories of that session, so it takes no 'repos'. Use 'repos' on a step that starts a session of its own.",
      ),
    );
  if (value.length === 0)
    c.report(
      issue(
        where,
        "invalid_value",
        "'repos' names at least one repository, or is left out.",
      ),
    );
  if (value.length > SESSION_REPOS_MAX)
    c.report(
      issue(
        where,
        "limit_exceeded",
        `A step may work on ${SESSION_REPOS_MAX} repositories at most; this one has ${value.length}.`,
      ),
    );
  const literals: { at: string; name: string }[] = [];
  let allLiteral = true;
  for (const [index, entry] of value
    .slice(0, SESSION_REPOS_MAX + 1)
    .entries()) {
    if (c.halted()) break;
    const at = pointer(where, index);
    if (!isRecord(entry)) {
      c.report(
        issue(
          at,
          "wrong_type",
          `An entry of 'repos' is an object with a 'repo', not ${jsonTypeName(entry)}.`,
        ),
      );
      allLiteral = false;
      continue;
    }
    keysOf(entry, ["repo", "base", "branch"], at, c);
    const repoAt = pointer(at, "repo");
    const repo = entry.repo;
    if (repo === undefined) {
      missing(at, "repo", "the repository, like owner/name.", c);
      allLiteral = false;
    } else if (typeof repo !== "string") {
      c.report(
        issue(
          repoAt,
          "wrong_type",
          `'repo' is a text, not ${jsonTypeName(repo)}.`,
        ),
      );
      allLiteral = false;
    } else {
      checkInput(repo, STRING, repoAt, c, reachOf(env, repoAt, state), {
        input: "repo",
        roots: REPOS_REPO_ROOTS,
      });
      const parsed = parseTemplate(repo);
      const literal =
        parsed.problems.length > 0 ? undefined : literalText(parsed);
      if (literal === undefined) allLiteral = false;
      else if (!isRepositoryFullName(literal)) {
        allLiteral = false;
        c.report(
          issue(
            repoAt,
            "invalid_value",
            "'repo' is a repository like owner/name: the owner, a slash and the name.",
          ),
        );
      } else literals.push({ at: repoAt, name: literal });
    }
    for (const [field, roots, text] of [
      ["base", REPOS_BASE_ROOTS, false],
      ["branch", REPOS_BRANCH_ROOTS, true],
    ] as const) {
      const given = entry[field];
      if (given === undefined) continue;
      const givenAt = pointer(at, field);
      if (typeof given !== "string") {
        c.report(
          issue(
            givenAt,
            "wrong_type",
            `'${field}' is a text, not ${jsonTypeName(given)}.`,
          ),
        );
        continue;
      }
      if (given.trim() === "")
        c.report(
          issue(
            givenAt,
            "invalid_value",
            `'${field}' is the name of a branch, not an empty text.`,
          ),
        );
      checkInput(given, STRING, givenAt, c, reachOf(env, givenAt, state), {
        input: field,
        roots,
        ...(text ? { text: true as const } : {}),
      });
    }
  }
  const repeat = firstRepeat(literals.map((entry) => entry.name));
  if (repeat >= 0) {
    c.report(
      issue(
        (literals[repeat] as { at: string }).at,
        "repo_duplicate",
        "Two entries of 'repos' name the same repository (a repository is the same one whatever the case of its name). Name each repository once.",
      ),
    );
    return;
  }
  if (!allLiteral || literals.length !== value.length) return;
  const clash = firstRepeat(deriveMountNames(literals.map((e) => e.name)));
  if (clash >= 0)
    c.report(
      issue(
        (literals[clash] as { at: string }).at,
        "repo_name_clash",
        "Two repositories of 'repos' would be mounted under the same name (the name of the repository, or owner__name when two have the same name). Leave one out.",
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
  checkSettingsForm(node, path, c);
  checkEnvironment(
    node,
    path,
    c,
    reachOf(env, pointer(path, "environment"), state),
  );
  checkProfileEnvironment(node, path, c);
  checkRunner(node, path, c, reachOf(env, pointer(path, "runner"), state));
  checkRunnerRules(node, path, c);
  checkRunnerRulesAtRunner(node, path, c);
  checkInstruction(node, path, c, env, state);
  checkSession(node, path, c, env, state);
  checkStartBranch(node, path, c, env, state);
  checkPushBranch(node, path, c, env, state);
  checkRepos(node, path, c, env, state);
  checkStepMcp(node, path, c.laneMcp ?? new Set(), c.report);
  if (node.result === undefined) return;
  const where = pointer(path, "result");
  const checked = validateResultSchema(node.result, where);
  for (const found of checked.issues) c.report(found);
  const properties =
    isRecord(node.result) && isRecord(node.result.properties)
      ? node.result.properties
      : {};
  for (const name of Object.keys(properties))
    if (
      FACT_NAMES.includes(name) ||
      (name === REPOS_FACT && node.repos !== undefined)
    )
      c.report(
        issue(
          pointer(where, "properties", name),
          "result_field_reserved",
          `${shown(name)} is filled in by the platform for every agent step. Name the field of the result differently.`,
          [...FACT_NAMES, ...(node.repos === undefined ? [] : [REPOS_FACT])],
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
    // #1094: the title and the body of a pull request step with `repos` are written once for every repository: `{{repo.fullName}}`,
    // `{{repo.base}}` and `{{repo.branch}}` stand for the one being opened.
    const perRepo =
      node.repos !== undefined &&
      PULL_REQUEST_OPENING_CONNECTORS.includes(spec.name) &&
      (input === "title" || input === "body");
    checkInput(
      node[input],
      field.type,
      at,
      c,
      {
        ...reachOf(env, at, state),
        ...(perRepo ? { repoScope: true } : {}),
        ...pullRequestUse(spec.name, input),
      },
      target,
    );
  }
  if (
    node.repos !== undefined &&
    PULL_REQUEST_OPENING_CONNECTORS.includes(spec.name)
  )
    for (const input of ["head", "base"])
      if (node[input] !== undefined)
        c.report(
          issue(
            pointer(path, input),
            "invalid_value",
            `A pull request step with 'repos' opens each pull request from the branch of its entry into that entry's base, so it takes no '${input}'. Take '${input}' out, or take 'repos' out.`,
          ),
        );
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
  if (
    spec.name === GITHUB_ISSUE_LABELS.name ||
    spec.name === TICKET_LABELS.name
  )
    checkNoRetrigger(node, path, c);
  if (spec.name === TICKET_SET_STATUS.name) {
    checkBoardInputs(node, path, c);
    checkNoStatusRetrigger(node, path, c);
  }
  if (spec.name === TICKET_REQUEST_REVIEW.name) checkReviewers(node, path, c);
}

/** The number of a GitHub Project (1 to 2147483647) or its node id: what `ticket.setStatus` takes as `board`. */
const BOARD_REFERENCE = /^(?:[1-9]\d{0,9}|PVT_[A-Za-z0-9_-]{1,200})$/;
/** A GitHub login: letters, digits and single hyphens, up to 39 characters. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/**
 * `ticket.setStatus`: `board` and `status` are literals (a target with no reference allowed), so what is checked here is their form:
 * the board is the number of a Project or its node id, the status is not blank. The option name itself is the board's and is looked up
 * when the step runs (`board_status_unknown` lists the options).
 */
function checkBoardInputs(
  node: Record<string, unknown>,
  path: string,
  c: Checker,
): void {
  const { board, status } = node;
  if (
    typeof board === "string" &&
    !board.includes("{{") &&
    !BOARD_REFERENCE.test(board)
  )
    c.report(
      issue(
        pointer(path, "board"),
        "invalid_value",
        '\'board\' is the number of a GitHub Project of the repository\'s owner (for example "7") or its node id ("PVT_…").',
      ),
    );
  if (
    typeof status === "string" &&
    !status.includes("{{") &&
    status.trim() === ""
  )
    c.report(
      issue(
        pointer(path, "status"),
        "invalid_value",
        "'status' is the name of an option of the board's Status field, not blank.",
      ),
    );
}

/** `ticket.requestReview`: `reviewers` is the text "project members" or a list of GitHub logins (a reference to a manual input is fine). */
function checkReviewers(
  node: Record<string, unknown>,
  path: string,
  c: Checker,
): void {
  const { reviewers } = node;
  const refused = (at: string, what: string): void =>
    c.report(
      issue(
        at,
        "invalid_value",
        `${what} 'reviewers' is "${PROJECT_MEMBERS}" or a list of GitHub logins.`,
        [PROJECT_MEMBERS],
      ),
    );
  if (typeof reviewers === "string") {
    if (!reviewers.includes("{{") && reviewers !== PROJECT_MEMBERS)
      refused(
        pointer(path, "reviewers"),
        `${shown(reviewers)} is no group of people.`,
      );
    return;
  }
  if (!Array.isArray(reviewers)) return;
  if (reviewers.length === 0)
    refused(pointer(path, "reviewers"), "The list is empty.");
  reviewers.forEach((entry: unknown, position) => {
    if (typeof entry !== "string" || entry.includes("{{")) return;
    if (!GITHUB_LOGIN.test(entry))
      refused(
        pointer(path, "reviewers", position),
        `${shown(entry)} is not a GitHub login.`,
      );
  });
}

/**
 * Adding the label that starts the workflow would start it again, and again. The same label is meant when only the spelling differs by
 * what Jira does to whitespace (#1129): Jira labels hold none, and the factory writes "ready for agent" as "ready-for-agent", which is the
 * label a lane for "ready for agent" waits for (`label-match.ts`). The identical text (any case) is an error as it always was. The text
 * that is the same label on Jira only is a warning: on GitHub those are two labels, and the validator does not know the provider.
 */
function checkNoRetrigger(
  node: Record<string, unknown>,
  path: string,
  c: Checker,
): void {
  const labels = c.retriggerLabels;
  if (labels === undefined || labels.length === 0 || !Array.isArray(node.add))
    return;
  const jiraSpelled = new Set(labels.map((label) => jiraLabel(label)));
  node.add.forEach((entry: unknown, position) => {
    if (typeof entry !== "string") return;
    const literal = literalText(parseTemplate(entry))?.trim().toLowerCase();
    if (literal === undefined || literal === "") return;
    if (labels.includes(literal)) {
      c.report(
        issue(
          pointer(path, "add", position),
          "label_retriggers_workflow",
          `Adding the label ${shown(literal)} puts the label that starts this workflow on the issue again, and the workflow would start again. Remove it instead, or add another label.`,
        ),
      );
      return;
    }
    if (jiraSpelled.has(jiraLabel(literal)))
      c.report(
        warning(
          pointer(path, "add", position),
          "label_retriggers_workflow",
          `Adding the label ${shown(literal)} puts the label that starts this workflow on a Jira issue again (Jira labels hold no spaces, so "ready for agent" and "ready-for-agent" are one label there), and the workflow would start again. Remove it instead, or add another label.`,
        ),
      );
  });
}

/**
 * Moving a ticket into the status that starts the workflow starts it again once this run is over: no move is left out of the trigger,
 * the factory's own included (owner decision, #1036). A warning (`status_retriggers_workflow`): it does not stop a save.
 */
function checkNoStatusRetrigger(
  node: Record<string, unknown>,
  path: string,
  c: Checker,
): void {
  const statuses = c.retriggerStatuses;
  if (statuses === undefined || statuses.length === 0) return;
  if (typeof node.status !== "string") return;
  const literal = literalText(parseTemplate(node.status))?.trim().toLowerCase();
  if (literal === undefined || !statuses.includes(literal)) return;
  c.report(
    warning(
      pointer(path, "status"),
      "status_retriggers_workflow",
      `Moving the ticket into ${shown(literal)} is the status that starts this workflow: once this run has ended, the move starts it again (no change of status is left out of a trigger, the factory's own included). Use another status.`,
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
  if (bodyEnv !== undefined) c.probe?.(untilAt, bodyEnv, state);
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
    c.probe?.(at, env, state);
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
        if (withId !== undefined)
          bind(
            agentBinding(
              withId,
              c.resolver,
              Array.isArray(node.repos) || continuesRepos(node, env),
            ),
          );
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
