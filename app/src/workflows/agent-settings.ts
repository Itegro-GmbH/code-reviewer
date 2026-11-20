// SPDX-License-Identifier: LicenseRef-Proprietary

// The checks of what an agent runs with that a profile (#843) and an agent step with settings of its own (#1105, ADR 0007) share: the
// model, the harness, the text of the instructions and how they fit together. Pure, never throws; each check reports through the
// `report` it is given, with the JSON pointer of the place. The profile validator (`profiles/validate.ts`) calls these for a profile
// body, the step checker (`check-steps.ts`) for a step, so a rule is written once.
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
import { INSTRUCTIONS_MAX_LENGTH, MODEL_FIELD_MAX_LENGTH } from "./limits.ts";
import { issue, shown, type Issue } from "./issues.ts";
import { isRecord, jsonTypeName, textLength } from "./json.ts";

// Control characters other than tab, line feed and carriage return; a lone surrogate half is not text at all.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
/** Every control character: an id or a model name is one line. */
export const CONTROL_OR_NEWLINE = /[\u0000-\u001f\u007f]/;

export type Report = (found: Issue) => void;

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export const MODEL_HINT =
  'A model is {"entryId": "<id>"} (a released catalog entry, for a workspace on the operator\'s key) or {"provider": "<slug>", "model": "<id>"} (a model of the workspace\'s own key). Both come from GET .../implementer/models.';

/** The model choice a value is, or undefined when it is none of the two shapes. */
export function readModel(value: unknown): ModelChoice | undefined {
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

/**
 * A free text of a profile or a step: at most `max` characters, no control character or broken character (tabs and line breaks are
 * fine), and not only white space. Returns the text, or undefined after reporting.
 */
export function checkFreeText(
  value: string,
  at: string,
  key: string,
  max: number,
  report: Report,
): string | undefined {
  if (textLength(value) > max) {
    report(
      issue(
        at,
        "limit_exceeded",
        `The field "${key}" may have ${max} characters at most.`,
      ),
    );
    return undefined;
  }
  if (CONTROL.test(value) || LONE_SURROGATE.test(value)) {
    report(
      issue(
        at,
        "invalid_value",
        `The field "${key}" holds a control character or a broken character. Tabs and line breaks are fine.`,
      ),
    );
    return undefined;
  }
  if (key === "instructions" && value !== "" && value.trim() === "") {
    report(
      issue(
        at,
        "invalid_value",
        `The field "instructions" holds only white space. Write the instructions, or leave the field out.`,
      ),
    );
    return undefined;
  }
  return value;
}

/** The standing instructions (a text of `INSTRUCTIONS_MAX_LENGTH` characters at most), or undefined after reporting. */
export function checkInstructions(
  value: unknown,
  at: string,
  report: Report,
): string | undefined {
  if (typeof value !== "string") {
    report(
      issue(
        at,
        "wrong_type",
        `The field "instructions" is a text, not ${jsonTypeName(value)}.`,
      ),
    );
    return undefined;
  }
  return checkFreeText(
    value,
    at,
    "instructions",
    INSTRUCTIONS_MAX_LENGTH,
    report,
  );
}

/** The harness a value names; left out is OpenCode. Anything else is reported at `at`, and OpenCode is returned so later checks go on. */
export function checkHarness(
  harness: unknown,
  at: string,
  report: Report,
  subject: "profile" | "step",
): ProfileHarness {
  if (harness === undefined) return OPENCODE_HARNESS;
  if (typeof harness === "string" && isProfileHarness(harness)) return harness;
  report(
    issue(
      at,
      typeof harness === "string" ? "invalid_value" : "wrong_type",
      `The harness is ${PROFILE_HARNESSES.map((name) => shown(name)).join(" or ")}; ${typeof harness === "string" ? shown(harness) : `a ${jsonTypeName(harness)}`} is not a harness a ${subject} can name.`,
      PROFILE_HARNESSES,
    ),
  );
  return OPENCODE_HARNESS;
}

/**
 * The provider `claude-code` is the harness's own: a model of it is a name Claude Code reads, and no other model is run by it. Reports
 * at `at` when the model and the harness do not fit.
 */
export function checkModelFitsHarness(
  model: ModelChoice,
  harness: ProfileHarness,
  at: string,
  report: Report,
  subject: "profile" | "step",
): void {
  const claude =
    "provider" in model && model.provider === CLAUDE_CODE_PROVIDER
      ? model
      : null;
  if (harness === CLAUDE_CODE_HARNESS) {
    if (claude === null || !CLAUDE_CODE_MODEL_PATTERN.test(claude.model))
      report(
        issue(
          at,
          "invalid_value",
          `A ${subject} on the harness ${shown(CLAUDE_CODE_HARNESS)} takes {"provider": "${CLAUDE_CODE_PROVIDER}", "model": "<name>"} with the name Claude Code reads (for example "sonnet" or "claude-sonnet-5-5"); its login is the runner's, so no catalog entry and no key of the workspace is used.`,
        ),
      );
    return;
  }
  if (claude !== null)
    report(
      issue(
        at,
        "invalid_value",
        `The provider ${shown(CLAUDE_CODE_PROVIDER)} belongs to the harness ${shown(CLAUDE_CODE_HARNESS)}. Name that harness in the field "harness", or choose a model from GET .../implementer/models.`,
      ),
    );
}

/**
 * The distinct models the agent steps of a document name themselves (#1105), so the service can ask the workspace's rule about each
 * before the validator runs. The document is untrusted: the walk is iterative (no depth to overflow), takes only `model` of an object
 * whose `kind` is `agent` and that names no profile, and stops at `limit` models (the validator then does not know the rest, and so
 * does not refuse them on a guess).
 */
export function inlineModelsIn(
  document: unknown,
  limit: number,
): ModelChoice[] {
  const found = new Map<string, ModelChoice>();
  const pending: unknown[] = [document];
  while (pending.length > 0) {
    const value = pending.pop();
    // Children go on the stack reversed, so the models come in the order the document names them and the bound keeps the first ones.
    if (Array.isArray(value)) {
      pending.push(...(value as unknown[]).toReversed());
      continue;
    }
    if (!isRecord(value)) continue;
    if (value.kind === "agent" && value.profile === undefined) {
      const model = readModel(value.model);
      if (model !== undefined && found.size < limit)
        found.set(JSON.stringify(model), model);
    }
    for (const child of Object.values(value).toReversed())
      if (typeof child === "object" && child !== null) pending.push(child);
  }
  return [...found.values()];
}

/** The keys of an agent step that are its own settings instead of a profile's (#1105, ADR 0007). */
export const INLINE_SETTING_KEYS = [
  "harness",
  "model",
  "canPush",
  "instructions",
  "setupScript",
  "network",
] as const;

/**
 * Whether an agent step carries its settings itself: it names no profile and has at least one of the keys above. A step with both is
 * reported (`profile_with_inline_settings`) and read as a step with a profile, so its facts are the profile's.
 */
export function isInlineStep(node: Record<string, unknown>): boolean {
  return (
    node.profile === undefined &&
    INLINE_SETTING_KEYS.some((key) => node[key] !== undefined)
  );
}
