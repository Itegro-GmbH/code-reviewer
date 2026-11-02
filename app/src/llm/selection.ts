// SPDX-License-Identifier: LicenseRef-Proprietary

// Which provider, model and catalog entry a job runs on, and whose key it will need (ADR 0005, 2.8, steps 1 to 4). It runs before any key is loaded: the key follows the
// selection, not the other way round. Pure: no database, no clock, no environment, no network. Everything it needs is
// passed in, and nothing it is passed is changed.
//
// The input is a union on the key mode, like `ResolveLlmInput` (resolve.ts), so a branch has no place for the other
// branch's data:
//
//   - `own`: the provider and model of the job's kind, from the layers of the settings (workspace default, project) over
//     the built-in model. There is no catalog, no entry and no `modelAccess` here; an own job reads none of them.
//   - `managed`: the entry the project selected, else the instance default entry of the kind, else nothing. The entry must
//     exist, be released, serve the kind, be allowed by the plan and have a provider the app and the runner can use.
//     There is no fallback to another entry, another provider or the instance's model (decision C5): the first thing that
//     is wrong ends the job. The settings of the own mode are not an input.
//   - `unreadable`: the entitlements cannot be read, so it is not known whose key applies. Fails closed.
//
// The job's kind is an input, never the project's current kind: a job claimed for a Diff review stays a Diff review
// when the project switches to Dynamic meanwhile.
//
// A failure is a stable code and a reason, never a model. A managed failure names the entry's opaque id at most; the
// provider and the model of an entry are operator data that a member must not read.
//
// The caller (the claim, #432) maps a failure to the job's error and loads the key the selection names. This function
// does not decide that a workspace holds no key for the provider (`llm_not_configured`, reason `no_key`, decision C7): it
// has not looked.
import type { CatalogEntry } from "../model-catalog/entries.ts";
import {
  implementerProviderIdOf,
  isCatalogModelId,
  nativeProviderIdOf,
} from "../native-cost/catalog-ref.ts";
import type { ProjectReviewKind } from "../job-kind/job-kind.ts";
import {
  ENTITLEMENTS_INVALID_CODE,
  entryAllowed,
  type ResolvedEntitlements,
} from "../workspaces/entitlements.ts";
import { LLM_NOT_CONFIGURED_ERROR } from "./access.ts";
import { llmProviderDescriptors } from "./providers/index.ts";
import type { LlmProviderDescriptor } from "./providers/types.ts";

/** The job error code of a job whose catalog entry cannot be used (the catalog replaced the tiers, #434). */
export const MANAGED_MODEL_UNAVAILABLE = "managed_model_unavailable" as const;
/** The job error code of an own job whose provider the app does not know or the runner did not advertise. */
export const LLM_PROVIDER_UNSUPPORTED = "llm_provider_unsupported" as const;
/** The existing job error code of options that cannot be used; an own job whose provider and model do not fit says why. */
export const JOB_LLM_OPTIONS_INVALID = "job_llm_options_invalid" as const;

/** Why a managed job has no usable entry. Checked in this order; the first one that applies is the reason. */
export const MANAGED_UNAVAILABLE_REASONS = [
  /** Neither the project nor the instance names an entry. */
  "no_selection",
  /** The id names no entry. */
  "missing",
  /** The entry is a draft or retired. */
  "not_released",
  /** The entry does not serve the job's kind. */
  "kind_mismatch",
  /** The plan's `modelAccess` does not list the entry. */
  "not_allowed",
  /** The entry's provider is not one the app knows, or the runner did not advertise it. */
  "provider_unsupported",
] as const;
export type ManagedUnavailableReason =
  (typeof MANAGED_UNAVAILABLE_REASONS)[number];

/** Why an own job has no usable provider and model. */
export const OWN_SELECTION_REASONS = [
  /** The provider is not one the app knows, or the runner did not advertise it. */
  "provider_unsupported",
  /** The model is not a model id of the provider that applies. */
  "model_invalid",
  /** The model was set for another provider than the one that applies (for example a workspace model and a project provider). */
  "model_provider_mismatch",
] as const;
export type OwnSelectionReason = (typeof OWN_SELECTION_REASONS)[number];

/** Where a managed job's entry came from: the project's choice or the instance default of the kind. */
export const ENTRY_ORIGINS = ["project", "instance_default"] as const;
export type EntryOrigin = (typeof ENTRY_ORIGINS)[number];

/** What a catalog entry has to tell the resolver: the operator's view of it (never handed to a member). */
export type SelectableEntry = Pick<
  CatalogEntry,
  "id" | "name" | "provider" | "modelId" | "kinds" | "status"
>;

/** The model fields of one settings layer for one kind: `provider` and `model` of Diff, or `dynamicProvider` and `dynamicModel`. */
export type ModelLayer = {
  provider?: string;
  model?: string;
  /** The address the layer pinned for its catalog provider when the provider was selected (#588); a Dynamic project layer only. */
  address?: string;
};

type Common = {
  /** The job's kind, pinned when the job was queued. */
  kind: ProjectReviewKind;
  /**
   * The providers of the caller that will run the job (the runner's advertisement). The app sends a provider only to a
   * caller that listed it. The caller applies the rule for an absent list (the contract names the default provider).
   */
  runnerProviders: readonly string[];
};

export type SelectionInput =
  | (Common & {
      keyMode: "own";
      /**
       * The caller that will run the job can run a catalog model (#555): a Dynamic job whose provider is a catalog provider
       * (`contracts/opencode-providers.v1.json`) takes this path only then. Left out, or false, such a job fails closed with
       * `llm_provider_unsupported`, the answer for a provider the caller did not list. A Diff job never takes it (#558).
       */
      nativeModels?: boolean;
      /**
       * The job is a task of the Implementer: its agent is OpenCode, which has no legacy wire, so a provider of the registry
       * is a catalog provider for it too, with the same workspace key. A review never sets this.
       */
      implementer?: true;
      /** The model of the kind for the default provider when no layer sets one (`LLM_MODEL`, or the Dynamic default). */
      builtInModel: string;
      /**
       * The layers that set provider and model for the kind, weakest first in the order workspace, project. A field a
       * layer leaves out is not set there. The workspace default of the Dynamic provider and model is a layer since #676.
       */
      layers: { workspace?: ModelLayer; project?: ModelLayer };
    })
  | (Common & {
      keyMode: "managed";
      /** Limited entitlements: the other two kinds of entitlements are the other branches. Carries `modelAccess`. */
      entitlements: Extract<ResolvedEntitlements, { kind: "limited" }>;
      /** The entry the project selected for the kind (`catalogEntryDiff`, `catalogEntryDynamic`), or null. */
      projectEntryId: string | null;
      /** The instance default entry of the kind (`catalog_defaults[kind]`), or null. */
      defaultEntryId: string | null;
      /** The entries the two ids may name. An id that is not among them names no entry. */
      entries: readonly SelectableEntry[];
    })
  | { keyMode: "unreadable" };

/** Which key a selection needs: the workspace's own key of `provider`, or the operator's key of the entry's provider. */
export const KEY_SOURCES = ["workspace", "operator"] as const;
export type SelectionKeySource = (typeof KEY_SOURCES)[number];

export type Selection =
  | {
      keyMode: "own";
      kind: ProjectReviewKind;
      provider: string;
      model: string;
      /** The key to load: the workspace's own key of `provider`. */
      keySource: "workspace";
      /**
       * The model is one of the models.dev catalog, named by the slug of its provider (#555): the claim serves it from the stored
       * row and builds its entry before any key is loaded. Absent for a provider of the registry.
       */
      catalog?: true;
      /**
       * The address the project pinned for the catalog provider when it selected it (#588). The claim sends the key to exactly this
       * address, or refuses the job when the catalog trusts another one; absent for a selection made before pins existed.
       */
      pinnedAddress?: string;
      /** An own selection has no entry. */
      entry?: never;
    }
  | {
      keyMode: "managed";
      kind: ProjectReviewKind;
      /** The provider of the entry. Operator data. */
      provider: string;
      /** The real model id of the entry. Operator data. */
      model: string;
      /** The key to load: the operator's key of `provider`. */
      keySource: "operator";
      /** The entry, with its name as it is now (the claim records the snapshot, so a rename does not rewrite history). */
      entry: { id: string; name: string; origin: EntryOrigin };
    };

export type SelectionFailure =
  | {
      errorCode: typeof LLM_NOT_CONFIGURED_ERROR;
      reason: typeof ENTITLEMENTS_INVALID_CODE;
    }
  | {
      errorCode: typeof MANAGED_MODEL_UNAVAILABLE;
      reason: ManagedUnavailableReason;
      /** The opaque id of the entry that failed, when there was one. Never a provider or a model. */
      entryId?: string;
    }
  | {
      errorCode: typeof LLM_PROVIDER_UNSUPPORTED;
      reason: "provider_unsupported";
      /** The provider the project chose, as it wrote it: a tenant's own choice, logged with the failure. */
      provider: string;
    }
  | {
      errorCode: typeof JOB_LLM_OPTIONS_INVALID;
      reason: Exclude<OwnSelectionReason, "provider_unsupported">;
    };

export type SelectionResult =
  { ok: true; selection: Selection } | ({ ok: false } & SelectionFailure);

/** The providers the app supports; a test passes its own. */
export type SelectionProviders = {
  readonly defaultProvider: LlmProviderDescriptor;
  find(raw: unknown): LlmProviderDescriptor | undefined;
};

const failClosed = (): SelectionResult => ({
  ok: false,
  errorCode: LLM_NOT_CONFIGURED_ERROR,
  reason: ENTITLEMENTS_INVALID_CODE,
});

const unavailable = (
  reason: ManagedUnavailableReason,
  entryId?: string,
): SelectionResult => ({
  ok: false,
  errorCode: MANAGED_MODEL_UNAVAILABLE,
  reason,
  ...(entryId === undefined ? {} : { entryId }),
});

export function resolveModelSelection(
  input: SelectionInput,
  providers: SelectionProviders = llmProviderDescriptors,
): SelectionResult {
  if (input.keyMode === "unreadable") return failClosed();
  if (input.keyMode === "own") return resolveOwn(input, providers);
  return resolveManaged(input, providers);
}

/** Whether the caller that will run the job can run this provider. */
const advertised = (runnerProviders: readonly string[], id: string): boolean =>
  runnerProviders.includes(id);

/** The outcome of walking the layers of one kind: what is in force, and where the model was set. */
export type ModelWalk = {
  /** The provider in force after the last layer. */
  provider: string;
  /** The provider as the last layer that set one wrote it, or undefined when none did. */
  providerAsWritten: string | undefined;
  /** The model of the last layer that set one, or undefined. */
  model: string | undefined;
  /** The provider in force where `model` was set; a model only counts for that provider. */
  modelProvider: string;
};

/**
 * Walks the layers from the weakest: a field a layer sets replaces the one below. The provider in force when the model was
 * set is kept next to the model, so a model is only used for the provider it was set for. The one rule of the claim (the
 * resolver) and of the save (`modelProviderMismatch`), so the two cannot drift.
 */
export function walkModelLayers(
  layers: readonly (ModelLayer | undefined)[],
  defaultProvider: string,
): ModelWalk {
  let provider = defaultProvider;
  let model: string | undefined;
  let modelProvider = provider;
  let providerAsWritten: string | undefined;
  for (const layer of layers) {
    if (layer === undefined) continue;
    if (layer.provider !== undefined) {
      provider = layer.provider;
      providerAsWritten = layer.provider;
    }
    if (layer.model !== undefined) {
      model = layer.model;
      modelProvider = provider;
    }
  }
  return { provider, providerAsWritten, model, modelProvider };
}

/**
 * Whether the layers pair a model with a provider other than the one it was set for (a workspace model next to a project
 * provider, or the reverse). The claim fails such a job closed (`model_provider_mismatch`); the settings save refuses the
 * same combination so the user does not find out only when a job fails (#432, own key mode only).
 */
export function modelProviderMismatch(
  workspace: ModelLayer | undefined,
  project: ModelLayer | undefined,
  defaultProvider: string,
): boolean {
  const { provider, model, modelProvider } = walkModelLayers(
    [workspace, project],
    defaultProvider,
  );
  return model !== undefined && modelProvider !== provider;
}

function resolveOwn(
  input: Extract<SelectionInput, { keyMode: "own" }>,
  providers: SelectionProviders,
): SelectionResult {
  const { kind, runnerProviders, builtInModel, layers } = input;

  const {
    provider,
    model: setModel,
    modelProvider,
    providerAsWritten,
  } = walkModelLayers(
    [layers.workspace, layers.project],
    providers.defaultProvider.id,
  );
  let model = setModel;

  const descriptor = providers.find(provider);
  if (
    (descriptor === undefined && nativeAllowed(input, provider)) ||
    implementerNative(input, provider)
  )
    return resolveOwnNative(
      kind,
      provider,
      setModel,
      modelProvider,
      layers.project?.address,
    );
  if (descriptor === undefined || !advertised(runnerProviders, descriptor.id))
    return {
      ok: false,
      errorCode: LLM_PROVIDER_UNSUPPORTED,
      reason: "provider_unsupported",
      provider: providerAsWritten ?? provider,
    };

  if (model === undefined) {
    // Nobody set a model: the built-in model of the kind, which is the default provider's. Another provider has its
    // own default for the kind.
    const isDefault = descriptor.id === providers.defaultProvider.id;
    model = isDefault ? builtInModel : descriptor.defaultModels[kind];
  } else if (providers.find(modelProvider)?.id !== descriptor.id) {
    return {
      ok: false,
      errorCode: JOB_LLM_OPTIONS_INVALID,
      reason: "model_provider_mismatch",
    };
  }
  if (!descriptor.checkModelId(model))
    return {
      ok: false,
      errorCode: JOB_LLM_OPTIONS_INVALID,
      reason: "model_invalid",
    };

  return {
    ok: true,
    selection: {
      keyMode: "own",
      kind,
      provider: descriptor.id,
      model,
      keySource: "workspace",
    },
  };
}

/** Whether the provider is a catalog provider for a task of the Implementer, whether or not the registry has it (`implementerProviderIdOf`). */
function implementerNative(
  input: Extract<SelectionInput, { keyMode: "own" }>,
  provider: string,
): boolean {
  return (
    input.implementer === true &&
    input.kind === "dynamic" &&
    input.nativeModels === true &&
    implementerProviderIdOf(provider) !== null
  );
}

/** Whether a provider outside the registry is a catalog provider this job may run (#555): Dynamic, a capable caller, supported. */
function nativeAllowed(
  input: Extract<SelectionInput, { keyMode: "own" }>,
  provider: string,
): boolean {
  return (
    input.kind === "dynamic" &&
    input.nativeModels === true &&
    nativeProviderIdOf(provider, llmProviderDescriptors.ids) !== null
  );
}

/**
 * A catalog provider and its model (#555). The model is the project's: a catalog provider has no built-in one. Whether the
 * catalog still serves it is the claim's question (`resolve` of the catalog reader), asked before any key is loaded.
 */
function resolveOwnNative(
  kind: ProjectReviewKind,
  provider: string,
  model: string | undefined,
  modelProvider: string,
  pinnedAddress: string | undefined,
): SelectionResult {
  if (model === undefined)
    return {
      ok: false,
      errorCode: JOB_LLM_OPTIONS_INVALID,
      reason: "model_invalid",
    };
  if (modelProvider !== provider)
    return {
      ok: false,
      errorCode: JOB_LLM_OPTIONS_INVALID,
      reason: "model_provider_mismatch",
    };
  if (!isCatalogModelId(model))
    return {
      ok: false,
      errorCode: JOB_LLM_OPTIONS_INVALID,
      reason: "model_invalid",
    };
  return {
    ok: true,
    selection: {
      keyMode: "own",
      kind,
      provider,
      model,
      keySource: "workspace",
      catalog: true,
      ...(pinnedAddress === undefined ? {} : { pinnedAddress }),
    },
  };
}

function resolveManaged(
  input: Extract<SelectionInput, { keyMode: "managed" }>,
  providers: SelectionProviders,
): SelectionResult {
  const { kind, runnerProviders, entitlements, entries } = input;
  // A caller that hands over entitlements of another key mode has a bug; the plan's list is not evaluated for them.
  if (entitlements.keyMode !== "managed") return failClosed();

  // One test decides both the id and its origin: no project id (null, or undefined from a mapper) is the default.
  const fromProject = input.projectEntryId != null;
  const origin: EntryOrigin = fromProject ? "project" : "instance_default";
  const id = fromProject ? input.projectEntryId : input.defaultEntryId;
  if (id === null) return unavailable("no_selection");

  const entry = entries.find((candidate) => candidate.id === id);
  if (entry === undefined) return unavailable("missing", id);
  if (entry.status !== "released") return unavailable("not_released", id);
  if (!entry.kinds.includes(kind)) return unavailable("kind_mismatch", id);
  if (!entryAllowed(entitlements, entry)) return unavailable("not_allowed", id);
  const descriptor = providers.find(entry.provider);
  if (descriptor === undefined || !advertised(runnerProviders, descriptor.id))
    return unavailable("provider_unsupported", id);

  return {
    ok: true,
    selection: {
      keyMode: "managed",
      kind,
      provider: descriptor.id,
      model: entry.modelId,
      keySource: "operator",
      entry: { id: entry.id, name: entry.name, origin },
    },
  };
}
