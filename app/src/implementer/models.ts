// SPDX-License-Identifier: LicenseRef-Proprietary

// The models a person can send an Implementer task to (#755). One rule serves the picker (`options`) and the submit (`check`), and
// it is the claim's (#753): the model must run on the native path (the passthrough proxy, an entry from the catalog and a cost
// policy), because the agent is OpenCode. So:
//  - on the workspace's own key a model is a provider and a model of the models.dev catalog (`src/native-providers/`), and the
//    workspace has saved a key for the provider. The registry's two providers (their wires are not native) are not offered;
//  - on the operator's key a model is a released catalog entry that serves Dynamic Review, that the plan allows, and whose model
//    has a confirmed price and an entry in the catalog (`entryUsable`). The tenant never sees the provider or the model id of an
//    entry (principle 2 of epic #420): the options carry the fields of `MemberCatalogEntry` only.
// Which of the two applies is the workspace's key mode, read for each request.
import type { ModelChoice } from "../db/implementer-model-choice.ts";
import type { NativeCatalogReader } from "../native-providers/catalog.ts";
import type { NativeModelView } from "../native-providers/catalog.ts";
import { isNativeProvider } from "../review-settings/native-choice.ts";
import {
  refusalOfChoice,
  type CatalogEntryRefusal,
  type CatalogSelectionSource,
} from "../review-settings/catalog-selection.ts";
import type { ModelRefusalReason } from "./errors.ts";

export type OwnProviderOption = {
  /** The slug the key and the choice are stored under. */
  id: string;
  label: string;
  models: NativeModelView[];
};

export type ManagedEntryOption = {
  id: string;
  name: string;
  description: string | null;
  providerLabel: string;
};

export type ModelOptions =
  | { keyMode: "own"; providers: OwnProviderOption[] }
  | { keyMode: "managed"; entries: ManagedEntryOption[] }
  /** The entitlements cannot be read: nothing is offered. */
  | { keyMode: "unreadable" };

export type ImplementerModels = {
  options(): Promise<ModelOptions>;
  /** Null when the claim would run the choice, else why not. */
  check(choice: ModelChoice): Promise<ModelRefusalReason | null>;
};

export type ImplementerModelsDependencies = {
  keyMode(): Promise<"own" | "managed" | "unreadable">;
  /** The slugs of the catalog providers the workspace holds a readable key for. */
  configuredProviders(): Promise<ReadonlySet<string>>;
  nativeCatalog: Pick<
    NativeCatalogReader,
    "providers" | "models" | "checkSelection"
  >;
  catalog: CatalogSelectionSource;
  /** Whether the catalog entry has a model the native path can price and describe (the claim's `policyFor` and `entryFor`). */
  entryUsable(entryId: string): Promise<boolean>;
};

const CATALOG_REASON: Record<CatalogEntryRefusal, ModelRefusalReason> = {
  CATALOG_ENTRY_UNKNOWN: "entry_unknown",
  CATALOG_ENTRY_NOT_RELEASED: "entry_not_released",
  CATALOG_ENTRY_KIND_MISMATCH: "entry_kind_mismatch",
  CATALOG_ENTRY_NOT_ALLOWED: "entry_not_allowed",
};

export function createImplementerModels(
  deps: ImplementerModelsDependencies,
): ImplementerModels {
  async function checkEntry(
    entryId: string,
  ): Promise<ModelRefusalReason | null> {
    const refusal = await refusalOfChoice(deps.catalog, "dynamic", entryId);
    if (refusal !== null) return CATALOG_REASON[refusal];
    return (await deps.entryUsable(entryId)) ? null : "entry_unavailable";
  }

  return {
    async options() {
      const keyMode = await deps.keyMode();
      if (keyMode === "unreadable") return { keyMode };
      if (keyMode === "own") {
        const configured = await deps.configuredProviders();
        const providers: OwnProviderOption[] = [];
        for (const provider of await deps.nativeCatalog.providers()) {
          if (!configured.has(provider.id)) continue;
          const models = await deps.nativeCatalog.models(provider.id);
          if (models === undefined || models.length === 0) continue;
          providers.push({ id: provider.id, label: provider.label, models });
        }
        return { keyMode, providers };
      }
      const entries: ManagedEntryOption[] = [];
      for (const candidate of await deps.catalog.entries()) {
        // The same checks, in the same order, as `check` makes for a choice; copies fields one by one.
        if ((await checkEntry(candidate.id)) !== null) continue;
        entries.push({
          id: candidate.id,
          name: candidate.name,
          description: candidate.description,
          providerLabel: candidate.providerLabel,
        });
      }
      return { keyMode, entries };
    },

    async check(choice) {
      const keyMode = await deps.keyMode();
      if (keyMode === "unreadable") return "key_mode_unreadable";
      if (keyMode === "managed")
        return "entryId" in choice
          ? checkEntry(choice.entryId)
          : "wrong_key_mode";
      if ("entryId" in choice) return "wrong_key_mode";
      if (!isNativeProvider(choice.provider)) return "provider_unsupported";
      if (!(await deps.configuredProviders()).has(choice.provider))
        return "no_key";
      const checked = await deps.nativeCatalog.checkSelection(
        choice.provider,
        choice.model,
      );
      return checked.ok ? null : "model_not_in_catalog";
    },
  };
}
