// SPDX-License-Identifier: LicenseRef-Proprietary

// The model a turn was started with, as the column `implementer_turns.model_choice` holds it (#751): JSON text of exactly one
// of two shapes. `{entryId}` is a released catalog entry (a workspace that runs on the operator's key); `{provider, model}` is a
// model of the workspace's own key. Nothing else is stored, and nothing else is read back: a different shape is a typed error.
import { encodeJson, tryDecodeJson } from "./codecs.ts";
import { ImplementerStoreError } from "./implementer-errors.ts";

export type ModelChoice =
  { entryId: string } | { provider: string; model: string };

function isText(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/** The choice if `value` is exactly one of the two shapes, else undefined. */
function readChoice(value: unknown): ModelChoice | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const keys = Object.keys(value).sort().join(",");
  const record = value as Record<string, unknown>;
  if (keys === "entryId" && isText(record.entryId))
    return { entryId: record.entryId };
  if (
    keys === "model,provider" &&
    isText(record.provider) &&
    isText(record.model)
  )
    return { provider: record.provider, model: record.model };
  return undefined;
}

/** The text to store. Only the known keys are written, in a fixed order. */
export function encodeModelChoice(choice: ModelChoice): string {
  const record = choice as Record<string, unknown>;
  const shape = readChoice(
    "entryId" in record
      ? { entryId: record.entryId }
      : { provider: record.provider, model: record.model },
  );
  if (shape === undefined)
    throw new ImplementerStoreError(
      "IMPLEMENTER_MODEL_CHOICE_INVALID",
      "A model choice is an entry id, or a provider and a model, as non-empty text.",
    );
  return encodeJson(shape);
}

/** The choice stored in `text`; a typed error, never a guess, when it is not one of the two shapes. */
export function decodeModelChoice(text: string): ModelChoice {
  const parsed = tryDecodeJson(text);
  const choice = parsed.ok ? readChoice(parsed.value) : undefined;
  if (choice === undefined)
    throw new ImplementerStoreError(
      "IMPLEMENTER_MODEL_CHOICE_UNREADABLE",
      "The stored model choice of a turn is not an entry id, or a provider and a model.",
    );
  return choice;
}
