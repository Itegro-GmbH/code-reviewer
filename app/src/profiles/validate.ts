// SPDX-License-Identifier: LicenseRef-Proprietary

// Checks the body that creates or changes a profile (#843): pure, never throws, reports every problem with a JSON pointer, a stable
// code and a sentence an AI can act on (the `Issue` of the workflow validator, whose codes it shares). What needs the world is not
// here but in the service: whether the model is one the claim would run, whether the cost limit is within the operator's maximum,
// whether the name is free. The default result schema is checked by the validator of the workflow format (`validateResultSchema`).
import {
  CLAUDE_CODE_HARNESS,
  CLAUDE_CODE_MODEL_PATTERN,
  CLAUDE_CODE_PROVIDER,
  OPENCODE_HARNESS,
  PROFILE_HARNESSES,
  isProfileHarness,
  type ProfileHarness,
} from "../runner-identity/harness.ts";
import type { ModelChoice } from "../db/implementer-model-choice.ts";
import {
  issue,
  pointer,
  shown,
  sortIssues,
  type Issue,
} from "../workflows/issues.ts";
import { FACT_NAMES } from "../workflows/facts.ts";
import { ERRORS_MAX } from "../workflows/limits.ts";
import { isRecord, jsonTypeName, textLength } from "../workflows/json.ts";
import {
  validateResultSchema,
  type ResultSchema,
} from "../workflows/result-schema.ts";
import {
  DESCRIPTION_MAX_LENGTH,
  INSTRUCTIONS_MAX_LENGTH,
  MODEL_FIELD_MAX_LENGTH,
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
  /** The most one turn may cost in whole US cents; null: the operator's maximum alone. */
  costLimitCents: number | null;
  /** Whether a turn of this profile may push branches. */
  canPush: boolean;
  /** The result schema a step takes when it declares none; null for none. */
  defaultResult: ResultSchema | null;
  /** #856: the harness the agent runs with; a profile that names none runs OpenCode. */
  harness: ProfileHarness;
};

export type ProfileCheck = {
  valid: boolean;
  errors: Issue[];
  /** Whether more problems were found than `errors` lists. */
  truncated: boolean;
  /** The profile, when valid. */
  profile?: ProfileDocument;
};

// Control characters other than tab, line feed and carriage return; a lone surrogate half is not text at all.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
/** Every control character: an id or a model name is one line. */
const CONTROL_OR_NEWLINE = /[\u0000-\u001f\u007f]/;

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

const MODEL_HINT =
  'A model is {"entryId": "<id>"} (a released catalog entry, for a workspace on the operator\'s key) or {"provider": "<slug>", "model": "<id>"} (a model of the workspace\'s own key). Both come from GET .../implementer/models.';

function readModel(value: unknown): ModelChoice | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value).sort().join(",");
  const fits = (...fields: unknown[]) =>
    fields.every(
      (field) =>
        isText(field) &&
        field.length <= MODEL_FIELD_MAX_LENGTH &&
        !CONTROL_OR_NEWLINE.test(field),
    );
  if (keys === "entryId" && fits(value.entryId))
    return { entryId: value.entryId as string };
  if (keys === "model,provider" && fits(value.provider, value.model))
    return { provider: value.provider as string, model: value.model as string };
  return undefined;
}

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
    if (textLength(value) > max) {
      report(
        issue(
          pointer("", key),
          "limit_exceeded",
          `The field "${key}" may have ${max} characters at most.`,
        ),
      );
      return undefined;
    }
    if (CONTROL.test(value) || LONE_SURROGATE.test(value)) {
      report(
        issue(
          pointer("", key),
          "invalid_value",
          `The field "${key}" holds a control character or a broken character. Tabs and line breaks are fine.`,
        ),
      );
      return undefined;
    }
    if (key === "instructions" && value !== "" && value.trim() === "") {
      report(
        issue(
          pointer("", key),
          "invalid_value",
          `The field "instructions" holds only white space. Write the instructions, or leave the field out.`,
        ),
      );
      return undefined;
    }
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
  const harness = given("harness");
  let harnessName: ProfileHarness = OPENCODE_HARNESS;
  if (harness !== undefined) {
    if (typeof harness === "string" && isProfileHarness(harness))
      harnessName = harness;
    else
      report(
        issue(
          "/harness",
          typeof harness === "string" ? "invalid_value" : "wrong_type",
          `The harness is ${PROFILE_HARNESSES.map((name) => shown(name)).join(" or ")}; ${typeof harness === "string" ? shown(harness) : `a ${jsonTypeName(harness)}`} is not a harness a profile can name.`,
          PROFILE_HARNESSES,
        ),
      );
  }

  // The provider `claude-code` is the harness's own: a model of it is a name Claude Code reads, and no other model is run by it.
  if (model !== undefined) {
    const claude =
      "provider" in model && model.provider === CLAUDE_CODE_PROVIDER
        ? model
        : null;
    if (harnessName === CLAUDE_CODE_HARNESS) {
      if (claude === null || !CLAUDE_CODE_MODEL_PATTERN.test(claude.model))
        report(
          issue(
            "/model",
            "invalid_value",
            `A profile on the harness ${shown(CLAUDE_CODE_HARNESS)} takes {"provider": "${CLAUDE_CODE_PROVIDER}", "model": "<name>"} with the name Claude Code reads (for example "sonnet" or "claude-sonnet-5-5"); its login is the runner's, so no catalog entry and no key of the workspace is used.`,
          ),
        );
    } else if (claude !== null)
      report(
        issue(
          "/model",
          "invalid_value",
          `The provider ${shown(CLAUDE_CODE_PROVIDER)} belongs to the harness ${shown(CLAUDE_CODE_HARNESS)}. Name that harness in the field "harness", or choose a model from GET .../implementer/models.`,
        ),
      );
  }

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
