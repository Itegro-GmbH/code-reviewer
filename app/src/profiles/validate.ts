// SPDX-License-Identifier: LicenseRef-Proprietary

// Checks the body that creates or changes a profile (#843): pure, never throws, reports every problem with a JSON pointer, a stable
// code and a sentence an AI can act on (the `Issue` of the workflow validator, whose codes it shares). What needs the world is not
// here but in the service: whether the model is one the claim would run, whether the cost limit is within the operator's maximum,
// whether the name is free. The default result schema is checked by the validator of the workflow format (`validateResultSchema`).
import type { ProfileHarness } from "../runner-identity/harness.ts";
import type { ModelChoice } from "../db/implementer-model-choice.ts";
import {
  issue,
  pointer,
  shown,
  sortIssues,
  type Issue,
} from "../workflows/issues.ts";
import {
  CONTROL_OR_NEWLINE,
  MODEL_HINT,
  checkFreeText,
  checkHarness,
  checkModelFitsHarness,
  readModel,
} from "../workflows/agent-settings.ts";
import { ENVIRONMENT_NAME_MAX_LENGTH } from "../implementer/environments/limits.ts";
import { FACT_NAMES } from "../workflows/facts.ts";
import { ERRORS_MAX } from "../workflows/limits.ts";
import { isRecord, jsonTypeName } from "../workflows/json.ts";
import {
  validateResultSchema,
  type ResultSchema,
} from "../workflows/result-schema.ts";
import {
  DESCRIPTION_MAX_LENGTH,
  INSTRUCTIONS_MAX_LENGTH,
  PROFILE_NAME_PATTERN,
} from "./limits.ts";

export const PROFILE_FIELDS = [
  "name",
  "description",
  "model",
  "instructions",
  "costLimitCents",
  "canPush",
  "defaultResult",
  /** #854, #856: the harness the agent runs with: `opencode` (left out) or `claude-code`, which runs on a runner on the login of its device. */
  "harness",
  /** #919: the environment of the workspace the profile runs in, by name: where the agent works. Required in a new version. */
  "environment",
] as const;

/** The cost limit of a turn in whole US cents: what the Implementer form takes (`REVIEW_SETTING_LIMITS.maxCostCents`). */
export const COST_LIMIT_CENTS = { min: 1, max: 10_000 } as const;

/** A profile as it is stored and used: every optional field filled in. */
export type ProfileDocument = {
  name: string;
  description: string;
  model: ModelChoice;
  /** The system-level text the agent is given; empty for none. */
  instructions: string;
  /**
   * The most one turn may cost in whole US cents; null: the operator's maximum alone. Deprecated (#918): the cost of a workflow's turn
   * is what is left of the workflow's budget, so a workflow never reads it, and `documentOf` does not show it. Left out of a body, it is
   * null; a body that still has it is accepted and checked as before.
   */
  costLimitCents?: number | null;
  /** Whether a turn of this profile may push branches. */
  canPush: boolean;
  /** The result schema a step takes when it declares none; null for none. */
  defaultResult: ResultSchema | null;
  /** #856: the harness the agent runs with; a profile that names none runs OpenCode. */
  harness: ProfileHarness;
  /**
   * #919: the name of the environment of the workspace the profile runs in (a hosted VM or a runner). A version saved before it has none
   * (null), and its workflow steps name the environment instead; a body always has one.
   */
  environment: string | null;
};

export type ProfileCheck = {
  valid: boolean;
  errors: Issue[];
  /** Whether more problems were found than `errors` lists. */
  truncated: boolean;
  /** What is said and does not stop a save (`severity: "warning"`, #973), in the shape of an error. Left out when there is none. */
  warnings?: Issue[];
  /** The profile, when valid. */
  profile?: ProfileDocument;
};

export function validateProfile(body: unknown): ProfileCheck {
  const errors: Issue[] = [];
  const report = (found: Issue) => void errors.push(found);

  if (!isRecord(body)) {
    return finish(
      [
        issue(
          "",
          "wrong_type",
          `A profile is an object like {"name": "...", "model": {...}, "canPush": false}, not ${jsonTypeName(body)}.`,
        ),
      ],
      undefined,
    );
  }

  for (const key of Object.keys(body)) {
    if (!(PROFILE_FIELDS as readonly string[]).includes(key))
      report(
        issue(
          pointer("", key),
          "unknown_field",
          `A profile has no field ${shown(key)}. Fields: ${PROFILE_FIELDS.join(", ")}.`,
          PROFILE_FIELDS,
        ),
      );
  }

  /** An optional field; `null` is left out. */
  const given = (key: (typeof PROFILE_FIELDS)[number]): unknown =>
    body[key] ?? undefined;

  const name = body.name;
  if (name === undefined)
    report(
      issue(
        "",
        "missing_field",
        'The field "name" is required: the name a workflow writes in a step, like "implementer".',
      ),
    );
  else if (typeof name !== "string")
    report(
      issue(
        "/name",
        "wrong_type",
        `The name is a text, not ${jsonTypeName(name)}.`,
      ),
    );
  else if (!PROFILE_NAME_PATTERN.test(name))
    report(
      issue(
        "/name",
        "invalid_value",
        `${shown(name)} is not a profile name. Use lower case letters, digits, "_" and "-", starting with a letter or digit, 64 characters at most, like "implementer" or "code-reviewer".`,
      ),
    );

  const text = (
    key: "description" | "instructions",
    max: number,
  ): string | undefined => {
    const value = given(key);
    if (value === undefined) return "";
    if (typeof value !== "string") {
      report(
        issue(
          pointer("", key),
          "wrong_type",
          `The field "${key}" is a text, not ${jsonTypeName(value)}.`,
        ),
      );
      return undefined;
    }
    if (checkFreeText(value, pointer("", key), key, max, report) === undefined)
      return undefined;
    return value;
  };
  const description = text("description", DESCRIPTION_MAX_LENGTH);
  const instructions = text("instructions", INSTRUCTIONS_MAX_LENGTH);

  let model: ModelChoice | undefined;
  if (body.model === undefined)
    report(
      issue(
        "",
        "missing_field",
        `The field "model" is required. ${MODEL_HINT}`,
      ),
    );
  else if (!isRecord(body.model))
    report(
      issue(
        "/model",
        "wrong_type",
        `The model is an object, not ${jsonTypeName(body.model)}. ${MODEL_HINT}`,
      ),
    );
  else {
    model = readModel(body.model);
    if (model === undefined)
      report(issue("/model", "invalid_value", MODEL_HINT));
  }

  let costLimitCents: number | null | undefined = null;
  const cost = given("costLimitCents");
  if (cost !== undefined) {
    if (typeof cost !== "number") {
      report(
        issue(
          "/costLimitCents",
          "wrong_type",
          `The cost limit is a whole number of US cents, not ${jsonTypeName(cost)}.`,
        ),
      );
      costLimitCents = undefined;
    } else if (
      !Number.isSafeInteger(cost) ||
      cost < COST_LIMIT_CENTS.min ||
      cost > COST_LIMIT_CENTS.max
    ) {
      report(
        issue(
          "/costLimitCents",
          "invalid_value",
          `The cost limit is a whole number of US cents from ${COST_LIMIT_CENTS.min} to ${COST_LIMIT_CENTS.max}. Leave it out for the operator's maximum alone.`,
        ),
      );
      costLimitCents = undefined;
    } else costLimitCents = cost;
  }

  // #854, #856: the harness. Only the two harnesses of a profile are named; a name that is neither is refused. Whether the harness can
  // run is not the profile's to know: `claude-code` runs on a runner environment only, which the workflow check says.
  const harnessName: ProfileHarness = checkHarness(
    given("harness"),
    "/harness",
    report,
    "profile",
  );

  // The provider `claude-code` is the harness's own: a model of it is a name Claude Code reads, and no other model is run by it.
  if (model !== undefined)
    checkModelFitsHarness(model, harnessName, "/model", report, "profile");

  // #919: where the agent works. Whether the environment exists, and whether it fits the model and the harness, needs the workspace:
  // the service says it.
  const environment = body.environment;
  let environmentName: string | undefined;
  if (environment === undefined || environment === null)
    report(
      issue(
        "",
        "missing_field",
        'The field "environment" is required: the name of an environment of the workspace the profile runs in, like "node" (a hosted environment or one that runs on a runner). GET .../implementer/environments lists them.',
      ),
    );
  else if (typeof environment !== "string")
    report(
      issue(
        "/environment",
        "wrong_type",
        `The environment is the name of an environment of the workspace, a text, not ${jsonTypeName(environment)}.`,
      ),
    );
  else if (
    environment.trim() === "" ||
    environment.length > ENVIRONMENT_NAME_MAX_LENGTH ||
    CONTROL_OR_NEWLINE.test(environment)
  )
    report(
      issue(
        "/environment",
        "invalid_value",
        `${shown(environment)} is not the name of an environment. Use the name of an environment of the workspace, one line.`,
      ),
    );
  else environmentName = environment;

  const push = body.canPush;
  if (push === undefined)
    report(
      issue(
        "",
        "missing_field",
        'The field "canPush" is required: true if a turn of this profile may push branches, false if not (a profile that only reads, like a reviewer).',
      ),
    );
  else if (typeof push !== "boolean")
    report(
      issue(
        "/canPush",
        "wrong_type",
        `canPush is true or false, not ${jsonTypeName(push)}.`,
      ),
    );

  let defaultResult: ResultSchema | null = null;
  const schema = given("defaultResult");
  if (schema !== undefined) {
    const checked = validateResultSchema(schema, "/defaultResult");
    for (const found of checked.issues) report(found);
    if (checked.schema !== undefined) defaultResult = checked.schema;
    // The same names a step's own `result` may not use: the platform's facts of an agent step (a profile that may not push has no
    // `branch` fact, and a field of that name would be read as one).
    const properties =
      isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
    for (const field of Object.keys(properties))
      if (FACT_NAMES.includes(field))
        report(
          issue(
            pointer("/defaultResult/properties", field),
            "result_field_reserved",
            `${shown(field)} is filled in by the platform for every agent step. Name the field of the result differently.`,
            FACT_NAMES,
          ),
        );
  }

  const profile =
    errors.length === 0
      ? ({
          name: name as string,
          description: description as string,
          model: model as ModelChoice,
          instructions: instructions as string,
          costLimitCents: costLimitCents as number | null,
          canPush: push as boolean,
          defaultResult,
          harness: harnessName,
          environment: environmentName as string,
        } satisfies ProfileDocument)
      : undefined;
  return finish(errors, profile);
}

function finish(
  errors: Issue[],
  profile: ProfileDocument | undefined,
): ProfileCheck {
  const sorted = sortIssues(errors);
  return {
    valid: profile !== undefined,
    errors: sorted.slice(0, ERRORS_MAX),
    truncated: sorted.length > ERRORS_MAX,
    ...(profile === undefined ? {} : { profile }),
  };
}
