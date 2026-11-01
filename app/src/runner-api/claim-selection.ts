// SPDX-License-Identifier: LicenseRef-Proprietary

// The part of the claim that chooses what a job runs on (#432, ADR 0005, 2.8): it builds the input of `resolveModelSelection` from what the claim knows (the effective entitlements,
// the options of the project for the job's pinned kind, the providers of the caller), reads the catalog for a job on the
// operator's key, runs the resolver and turns a failure into the refusal the job ends with. It loads no key: the key
// follows the selection (`ClaimDeps.keyFor`).
//
// The managed input is built from the whole entitlements object, so any further fact about the workspace that decides a
// managed job reaches the resolver through the same input and needs no second read path: it is added here, to one input,
// not read elsewhere.
//
// Nothing here logs a model or a key. A failure names a code, a reason, the kind and (managed) the opaque id of the entry.
import type { Job } from "../jobs/job-types.ts";
import { boundProviderText } from "../llm/provider-text.ts";
import { keyModeForJob } from "../llm/resolve.ts";
import {
  resolveModelSelection,
  type Selection,
  type SelectionFailure,
  type SelectionInput,
  type SelectionProviders,
  type SelectableEntry,
} from "../llm/selection.ts";
import type { CatalogService } from "../model-catalog/service.ts";
import { projectKindOf, type ProjectReviewKind } from "../job-kind/job-kind.ts";
import {
  noLimits,
  type ResolvedEntitlements,
} from "../workspaces/entitlements.ts";
import type { JobOptions } from "./job-options.ts";

/** What the claim asks the catalog: one entry by id, and the instance defaults. Both are read for a managed job only. */
export type ClaimCatalog = Pick<CatalogService, "get" | "defaults">;

export type SelectionDeps = {
  catalog: ClaimCatalog;
  /** The providers of the app; the resolver's own registry unless a test brings a second provider. */
  providers?: SelectionProviders & { readonly ids: readonly string[] };
  /** The model of a kind when no layer of the settings sets one (`LLM_MODEL`, or the Dynamic default). */
  builtInModel: (kind: ProjectReviewKind) => string;
  /**
   * #555: a Dynamic job on the workspace's own key may name a catalog model (`contracts/opencode-providers.v1.json`). Left out,
   * or false, such a selection fails closed as an unsupported provider, which is the answer of a claim that cannot run it.
   */
  nativeModels?: boolean;
};

/** Why the claim does not go on: the code the job ends with and the detail the log gets (names and codes, never a value). */
export type SelectionRefusal = { errorCode: string; detail: string };

export type SelectionOutcome =
  { ok: true; selection: Selection } | ({ ok: false } & SelectionRefusal);

/** The layers of the settings that wrote a provider or a model, or what a source without layers (a test) implies. */
function layersOf(
  options: JobOptions,
  kind: ProjectReviewKind,
): {
  workspace?: { provider?: string; model?: string };
  project?: { provider?: string; model?: string };
} {
  if (options.selection !== undefined) return options.selection.layers;
  // A source that does not know the layers names the model it resolved; that is one project layer for the default
  // provider.
  const model =
    kind === "dynamic"
      ? options.dynamic?.model
      : (options.llm?.model ?? undefined);
  return model === undefined ? {} : { project: { model } };
}

/** The refusal for a failed selection: the job error code and a log detail with no model, no key and a bounded provider. */
export function refusalOf(
  failure: SelectionFailure,
  kind: ProjectReviewKind,
): SelectionRefusal {
  switch (failure.errorCode) {
    case "llm_not_configured":
      return { errorCode: failure.errorCode, detail: failure.reason };
    case "managed_model_unavailable":
      return {
        errorCode: failure.errorCode,
        detail: `${failure.entryId === undefined ? "" : `entry=${failure.entryId} `}kind=${kind} reason=${failure.reason}`,
      };
    case "llm_provider_unsupported":
      // The provider as the tenant wrote it: its own data, but unbounded and free of any rule, so it is cut and made
      // printable before it is logged.
      return {
        errorCode: failure.errorCode,
        detail: `kind=${kind} provider=${boundProviderText(failure.provider)}`,
      };
    case "job_llm_options_invalid":
      return {
        errorCode: failure.errorCode,
        detail: `kind=${kind} reason=${failure.reason}`,
      };
  }
}

/**
 * The entries a managed job may name: the one the project selected, else the instance default of the kind. Only what the
 * resolver can use is read, so a job that names one entry asks for one (and the defaults only when the project names none).
 */
async function managedEntries(
  deps: SelectionDeps,
  kind: ProjectReviewKind,
  projectEntryId: string | null,
): Promise<{ defaultEntryId: string | null; entries: SelectableEntry[] }> {
  const defaultEntryId =
    projectEntryId === null
      ? ((await deps.catalog.defaults())[kind] ?? null)
      : null;
  const id = projectEntryId ?? defaultEntryId;
  if (id === null) return { defaultEntryId, entries: [] };
  const entry = await deps.catalog.get(id);
  return { defaultEntryId, entries: entry === undefined ? [] : [entry] };
}

/**
 * Chooses provider, model and (managed) catalog entry for a job. `runnerProviders` are the providers of the caller that
 * will run it. An own job reads no catalog and does not look at `modelAccess`; a managed job reads the entry it names.
 */
export async function selectModel(
  deps: SelectionDeps,
  job: Job,
  {
    options,
    entitlements,
    runnerProviders,
  }: {
    options: JobOptions;
    entitlements: ResolvedEntitlements;
    runnerProviders: readonly string[];
  },
): Promise<SelectionOutcome> {
  // #752: a turn of the Implementer chooses its model as a Dynamic Review does, but the claim refuses the kind before it gets here
  // (`kind-guard.ts`, until its own input is built).
  const kind = projectKindOf(job.reviewKind);
  const keyMode = keyModeForJob(entitlements);
  let input: SelectionInput;
  if (keyMode === "unreadable") input = { keyMode };
  else if (keyMode === "own")
    input = {
      keyMode,
      kind,
      runnerProviders,
      ...(deps.nativeModels === true ? { nativeModels: true } : {}),
      builtInModel: deps.builtInModel(kind),
      layers: layersOf(options, kind),
    };
  else {
    // `keyModeForJob` answers `managed` for limited entitlements, and for a workspace without entitlements that chose our models
    // while billing is on (#496): it has no list of entries, so it may use every released one.
    const subject =
      entitlements.kind === "unlimited"
        ? noLimits("managed")
        : entitlements.kind === "limited"
          ? entitlements
          : undefined;
    if (subject === undefined) return failedClosed();
    const projectEntryId = options.selection?.entryId ?? null;
    input = {
      keyMode,
      kind,
      runnerProviders,
      entitlements: subject,
      projectEntryId,
      ...(await managedEntries(deps, kind, projectEntryId)),
    };
  }
  const result =
    deps.providers === undefined
      ? resolveModelSelection(input)
      : resolveModelSelection(input, deps.providers);
  if (result.ok) return result;
  return { ok: false, ...refusalOf(result, kind) };
}

function failedClosed(): SelectionOutcome {
  return {
    ok: false,
    errorCode: "llm_not_configured",
    detail: "entitlements_invalid",
  };
}
