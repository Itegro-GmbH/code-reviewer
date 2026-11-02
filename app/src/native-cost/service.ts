// SPDX-License-Identifier: LicenseRef-Proprietary

// What the claim asks about the cost of a native job (#553): which catalog model a selection names, and the cost policy
// of its key (policy.ts). It reads the price service (`availability` for the managed key, `catalogPrice` for the own key)
// and the token cap of the instance; it decides nothing the pure modules do not. Server side only: it names providers,
// models and prices, none of which reaches a member.
import "server-only";
import type { InstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import type { ModelsDevRepository } from "../db/repositories/models-dev-repository.ts";
import {
  buildJobModelEntry,
  type JobEntryRefusalCode,
  type JobModelEntry,
} from "../models-dev/job-entry.ts";
import type { ModelPriceService } from "../model-prices/service.ts";
import { isCanonicalCatalogAddress } from "./catalog-address.ts";
import {
  catalogRefOf,
  implementerCatalogRefOf,
  type CatalogRef,
} from "./catalog-ref.ts";
import {
  managedPolicy,
  ownPolicy,
  type CostPolicyJson,
  type ManagedPolicyOutcome,
} from "./policy.ts";
import { sameAddress, UPSTREAM_NOT_REGISTRY } from "./registry-addresses.ts";
import { ownKeyTokenCapOf } from "./token-cap.ts";

export type PolicyOutcome =
  | {
      ok: true;
      policy: CostPolicyJson;
      /** The confirmation that priced a managed run; null for an own key. */
      confirmation: { id: number; hashVersion: number } | null;
    }
  | Extract<ManagedPolicyOutcome, { ok: false }>;

/** The refusal of an entry for a provider outside the registry whose trusted address is not a plain public https address in its canonical spelling. */
export const UPSTREAM_INVALID = "upstream_invalid";

/**
 * The refusal of an entry for a catalog provider whose trusted address is not the one the workspace's selection pinned (#588): the
 * catalog's address moved since the workspace selected the provider. The key is not sent anywhere until an Owner or Admin
 * confirms the new address in the settings of the project.
 */
export const PROVIDER_ADDRESS_CHANGED = "provider_address_changed";

/**
 * The entry of the chosen model for the claim (#578), or why there is none. `model_not_in_catalog`: the catalog has no such
 * provider or model; `upstream_not_registry`: the provider is one of the app's registry and the catalog's trusted address is not
 * the registry's (the key goes only to the registry's address); `upstream_invalid` (#555): any other provider, whose stored trusted
 * address is not a plain public https address in the one spelling the runner accepts (`catalog-address.ts`); `check_failed`: the
 * database could not be read (the job is given back, as for a failed price check). `unlisted`: models.dev no longer lists the
 * model and the last known row serves (#548). `provider_address_changed` (#588): the selection pinned another address than the
 * catalog trusts now. `unpinned`: the selection has no pin (made before pins existed) and the entry names the trusted address;
 * the claim adopts it as the pin before it goes on.
 */
export type EntryOutcome =
  | { ok: true; entry: JobModelEntry; unlisted?: boolean; unpinned?: true }
  | {
      ok: false;
      code:
        | JobEntryRefusalCode
        | "model_not_in_catalog"
        | typeof UPSTREAM_NOT_REGISTRY
        | typeof UPSTREAM_INVALID
        | typeof PROVIDER_ADDRESS_CHANGED
        | "check_failed";
    };

export type NativeCostService = {
  /** The catalog model a selection names, or null when the job does not take the native path (catalog-ref.ts). */
  refOf(selection: { provider: string; model: string }): CatalogRef | null;
  /**
   * The same for a turn of the Implementer, whose agent is OpenCode and has no legacy wire: the registry's two providers are
   * catalog models here too (catalog-ref.ts, `implementerCatalogRefOf`). A review never asks this.
   */
  implementerRefOf(selection: {
    provider: string;
    model: string;
  }): CatalogRef | null;
  /**
   * The cost policy of a job on this key. `managed`: only a model that is enabled and has a confirmed price passes; the
   * refusal carries a stable code (`catalog_price_unconfirmed`, `catalog_model_unavailable`) and an internal reason, both
   * for the log. `own`: always a policy, with the catalog's price when it states one and the instance's token cap. Never
   * throws: the price service answers a failed read as a refusal (managed) or as no price (own).
   */
  policyFor(
    keyMode: "managed" | "own",
    ref: CatalogRef,
  ): Promise<PolicyOutcome>;
  /**
   * The entry the claim tells the runner about the model (`dynamic.modelEntry`, #578): the last known row of the catalog, so a
   * model models.dev no longer lists is still served. No key, no price. Never throws. `pinned` (#588) is the address the
   * workspace's selection of a catalog provider pinned: the entry names exactly that address or there is none
   * (`provider_address_changed`); a registry provider has the registry's address and ignores it.
   */
  entryFor(ref: CatalogRef, pinned?: string): Promise<EntryOutcome>;
};

export function createNativeCostService(deps: {
  prices: Pick<ModelPriceService, "availability" | "catalogPrice">;
  settings: Pick<InstanceSettingsRepository, "get">;
  /** The stored providers and models the entry is made from. */
  catalog: Pick<ModelsDevRepository, "getProvider" | "getModel">;
  /** The providers of the app's registry, which keep the legacy path until #556. */
  legacyProviders: readonly string[];
  /** The API addresses of those providers by catalog provider id; the entry of such a provider names no other (#578). */
  registryAddresses: Readonly<Record<string, string>>;
}): NativeCostService {
  return {
    refOf: (selection) => catalogRefOf(selection, deps.legacyProviders),
    implementerRefOf: implementerCatalogRefOf,

    async policyFor(keyMode, ref) {
      if (keyMode === "managed")
        return managedPolicy(
          await deps.prices.availability(ref.providerId, ref.modelId),
        );
      const [book, stored] = await Promise.all([
        deps.prices.catalogPrice(ref.providerId, ref.modelId),
        deps.settings.get("own_key_max_total_tokens"),
      ]);
      return {
        ok: true,
        policy: ownPolicy(book, ownKeyTokenCapOf(stored)),
        confirmation: null,
      };
    },

    async entryFor(ref, pinned) {
      try {
        const [provider, model] = await Promise.all([
          deps.catalog.getProvider(ref.providerId),
          deps.catalog.getModel(ref.providerId, ref.modelId),
        ]);
        if (provider === undefined || model === undefined)
          return { ok: false, code: "model_not_in_catalog" };
        const built = buildJobModelEntry(provider, model);
        if (!built.ok) return built;
        const registryAddress = deps.registryAddresses[ref.providerId];
        // The key of a registry provider goes to the registry's address; the key of any other provider to the address the catalog
        // trusts for it, in the one spelling the runner accepts (#555). Nothing a workspace typed is ever an address.
        if (registryAddress !== undefined) {
          if (!sameAddress(built.entry.upstreamBaseUrl, registryAddress))
            return { ok: false, code: UPSTREAM_NOT_REGISTRY };
          return {
            ok: true,
            entry: built.entry,
            unlisted: model.unlistedAt !== null,
          };
        }
        if (!isCanonicalCatalogAddress(built.entry.upstreamBaseUrl))
          return { ok: false, code: UPSTREAM_INVALID };
        // #588: the address the catalog trusts is the one the workspace saw when it selected the provider, or the key does not go.
        if (pinned !== undefined && pinned !== built.entry.upstreamBaseUrl)
          return { ok: false, code: PROVIDER_ADDRESS_CHANGED };
        return {
          ok: true,
          entry: built.entry,
          unlisted: model.unlistedAt !== null,
          ...(pinned === undefined ? { unpinned: true as const } : {}),
        };
      } catch {
        // No error text: it could carry whatever the failing layer held.
        return { ok: false, code: "check_failed" };
      }
    },
  };
}
