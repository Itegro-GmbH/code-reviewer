// SPDX-License-Identifier: LicenseRef-Proprietary

// The minimal map from what a job selected to the models.dev catalog (#553; the mapping #549 left to the claim and #555).
//
// A selection names a provider by a **slug** of the app's registry (`^[a-z][a-z0-9_]{1,31}$`: the name of the secret that
// holds the key per provider) and a model by its id. The catalog names the same model by the **provider id** of models.dev
// (`^[a-z0-9][a-z0-9_-]{0,63}$`, with hyphens) and the model id. The map is the one rule that makes the two spellings one:
// the underscore of a slug is the hyphen of the id. It is one-to-one only for ids without an underscore, so an id that has
// one has no slug (and a model of such a provider cannot be selected), as does an id that starts with a digit.
//
// Which selection takes the native path (the passthrough proxy, the price check, the cost policy of #553) is decided here
// and nowhere else: a supported provider of `contracts/opencode-providers.v1.json` that is **not** a provider of the legacy
// registry. The two providers of the registry are in both lists; their wires stay the production path until #556 removes
// them, so a selection that names either is never native and nothing about its claim changes. The registry itself does not accept
// a native slug in a selection yet: that, and the key per native provider, belong to the wiring and #555 (README.md).
//
// One kind has no legacy wire: a task of the Implementer (the agent is OpenCode). For it `implementerProviderIdOf` and
// `implementerCatalogRefOf` below treat no provider as legacy, so the key of Anthropic or OpenRouter reaches the agent through the
// passthrough proxy like any catalog provider's. The reviews never call them.
import { supportedProvider } from "../models-dev/opencode-providers.ts";

/** A model of the catalog by the ids of models.dev. */
export type CatalogRef = { providerId: string; modelId: string };

const SLUG = /^[a-z][a-z0-9_]{1,31}$/;
// The charset of the job entry's model id, without `..` (it would walk out of a path the id is put into).
const MODEL_ID = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,199}$/;

/** Whether `id` has the shape of a model id a job entry can carry (the one rule for a catalog model's id; its existence is the catalog's). */
export function isCatalogModelId(id: string): boolean {
  return MODEL_ID.test(id);
}

/** The models.dev provider id a registry slug stands for, or null when the text is no slug. */
export function catalogProviderIdOf(slug: string): string | null {
  return SLUG.test(slug) ? slug.replaceAll("_", "-") : null;
}

/** The registry slug of a models.dev provider id, or null when no slug can spell it (a digit first, an underscore, too long). */
export function providerSlugOf(providerId: string): string | null {
  if (providerId.includes("_")) return null;
  const slug = providerId.replaceAll("-", "_");
  return SLUG.test(slug) ? slug : null;
}

/**
 * The models.dev provider id of a registry slug that takes the native path, or null: the provider is one of the legacy
 * registry (`legacyProviders`), no slug, or not a provider the pinned engine can drive.
 */
export function nativeProviderIdOf(
  slug: string,
  legacyProviders: readonly string[],
): string | null {
  if (legacyProviders.includes(slug)) return null;
  const providerId = catalogProviderIdOf(slug);
  if (providerId === null || supportedProvider(providerId) === undefined)
    return null;
  return providerId;
}

/**
 * The catalog model a selection names, or null when the job does not take the native path: its provider is not a native
 * one (`nativeProviderIdOf`) or the model id is not one a job entry can carry.
 */
export function catalogRefOf(
  selection: { provider: string; model: string },
  legacyProviders: readonly string[],
): CatalogRef | null {
  const providerId = nativeProviderIdOf(selection.provider, legacyProviders);
  if (providerId === null || !isCatalogModelId(selection.model)) return null;
  return { providerId, modelId: selection.model };
}

/**
 * The models.dev provider id of a registry slug for a **task of the Implementer**, or null. Its agent is OpenCode, which has no
 * legacy wire, so the registry's two providers are catalog providers here. Only the Implementer's own code asks this (the
 * picker, the check at submit, the claim of a turn); `nativeProviderIdOf` is the rule of the reviews and does not change.
 */
export function implementerProviderIdOf(slug: string): string | null {
  return nativeProviderIdOf(slug, []);
}

/** The catalog model a turn of the Implementer names (`implementerProviderIdOf`), or null when the catalog cannot serve it. */
export function implementerCatalogRefOf(selection: {
  provider: string;
  model: string;
}): CatalogRef | null {
  return catalogRefOf(selection, []);
}
