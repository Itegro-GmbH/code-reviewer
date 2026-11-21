// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The review settings form, for the global defaults and for one project (#174, #656). One form, one save, four
// sections as tabs: Review (the kind, the verdict and the review options), LLM (a provider and a model dropdown), Trigger
// (when the reviewer starts) and Limits (what one review may cost). The values in force are shown, every field says where
// its value comes from and can be taken back to the layer below with "Reset to default". A save replaces the whole set of the
// layer and is the only action in the footer; resetting the whole project to the defaults is a separate action in its own
// card at the bottom. Problems are checked before sending (the same validation the server runs, which checks again), shown as
// sentences at their field, and the first marked field gets the focus (its section is opened first); the estimated cost
// updates while the person types and warns above the limit without blocking anything.
import { WarningCircleIcon } from "@phosphor-icons/react/dist/ssr";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Alert } from "../../components/ui/alert.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog.tsx";
import { Button } from "../../components/button.tsx";
import { DangerZone } from "../../components/danger-zone.tsx";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../../components/ui/tabs.tsx";
import { MODEL_CHOICE_DEFAULT_OPTION } from "../../copy/model-choice.ts";
import { formatUtc } from "../../ui/format-time.ts";
import {
  CATALOG_FIELD_OF_KIND,
  PROJECT_DYNAMIC_SETTING_FIELDS,
  REVIEW_SETTING_FIELDS,
  type ReviewSettingField,
} from "../settings.ts";
import type { ProjectReviewKind } from "../../job-kind/job-kind.ts";
import type { ReviewCostGuard } from "../cost.ts";
import { estimateReviewCost } from "../cost.ts";
import { llmProviderDescriptors } from "../../llm/providers/index.ts";
import {
  suggestedModelsFor,
  type SuggestingProvider,
} from "../../llm/providers/suggested-models.ts";
import type { LlmProviderDescriptor } from "../../llm/providers/types.ts";
import {
  browserGlobalSettingsApi,
  browserProjectSettingsApi,
  type SettingsApi,
} from "./api.ts";
import {
  editSkill,
  resetSkill,
  setCatalogEntry,
  setDynamicModel,
  setConfirmProviderAddress,
  setDynamicProvider,
  setReviewKind,
  setReviewVerdict,
  setSkillText,
} from "./dynamic-form-state.ts";
import {
  modelFromAnswer,
  warningsFromAnswer,
  type SettingsFormModel,
} from "./form-model.ts";
import {
  initialFormState,
  previewSettings,
  resetField,
  resetModelTo,
  setBoolean,
  setCommand,
  setProvider,
  setText,
  type BooleanField,
  type FormState,
  type TextField,
} from "./form-state.ts";
import { planGlobalSave } from "./global-save.ts";
import { adoptCards, planProjectSave, type SaveStep } from "./project-save.ts";
import { ProviderAddressNote } from "./provider-address-note.tsx";
import type { ProductIdentity } from "../../product-identity/identity.ts";
import { LlmFieldset, type OwnLlmChoice } from "./llm-fieldset.tsx";
import { LimitsFieldset } from "./limits-fieldset.tsx";
import type { NativeFormData } from "../../native-providers/form-data.ts";
import type { CatalogModelsApi } from "../../native-providers/ui/api.ts";
import { providerOptions } from "./provider-select.tsx";
import { KIND_NAMES } from "../kind-names.ts";
import { followersText } from "./followers-text.ts";
import {
  gateOffWarning,
  gateOffWarningDefaults,
  ReviewKindFieldset,
  type ReviewKindHandlers,
} from "./review-kind-fieldset.tsx";
import { ReviewFieldset } from "./review-fieldset.tsx";
import { ReviewVerdictFieldset } from "./review-verdict-fieldset.tsx";
import { WhenFieldset } from "./when-fieldset.tsx";
import {
  RESET_LABEL,
  settingsOrigin,
  type SettingsFieldHandlers,
  type SettingsOrigin,
} from "./settings-fields.tsx";
import {
  describeIssue,
  describeSaveFailure,
  describeWarning,
  FALLBACK_REMOVED_NOTICE,
  projectsNote,
  TAB_PROBLEM_NOTE,
} from "./messages.ts";
import type { RequestIssue } from "../../ui/json-request.ts";

type Errors = Partial<Record<string, string>>;

/** The Diff fields an agent review does not show: an error on one of them is hidden while Dynamic is chosen. */
const DIFF_ONLY_FIELDS: readonly string[] = [
  "provider",
  "catalogEntryDiff",
  "model",
  "fallbackModel",
  "maxTokens",
  "largePrChunking",
  "inlineKeyIssues",
  "extraInstructions",
];
const DYNAMIC_ONLY_FIELDS: readonly string[] = [
  "dynamicProvider",
  "dynamicModel",
  "catalogEntryDynamic",
  "reviewSkill",
];

/** The four sections of the form, in the order of the tabs. */
const SECTIONS = ["review", "llm", "trigger", "limits"] as const;
type Section = (typeof SECTIONS)[number];

const SECTION_NAMES: Record<Section, string> = {
  review: "Review",
  llm: "LLM",
  trigger: "Trigger",
  limits: "Limits",
};

function isSection(value: string): value is Section {
  return SECTIONS.some((section) => section === value);
}

/** The section that shows a field, so a problem on it opens that section. */
const SECTION_OF_FIELD: Record<string, Section> = {
  reviewKind: "review",
  reviewVerdict: "review",
  reviewSkill: "review",
  extraInstructions: "review",
  maxFindings: "review",
  largePrChunking: "review",
  inlineKeyIssues: "review",
  provider: "llm",
  model: "llm",
  fallbackModel: "llm",
  dynamicProvider: "llm",
  dynamicModel: "llm",
  catalogEntryDiff: "llm",
  catalogEntryDynamic: "llm",
  autoReviewOnOpen: "trigger",
  autoReviewOnPush: "trigger",
  allowedCommands: "trigger",
  maxCostCents: "limits",
  maxTokens: "limits",
};

/**
 * The first section (in tab order) with a problem, or null. A field the selected kind does not show has its note in the
 * Review section, so that one opens for it.
 */
function firstSectionWithProblem(
  errors: Errors,
  hiddenFields: readonly string[],
): Section | null {
  const found = sectionsWithProblems(errors, hiddenFields);
  return SECTIONS.find((section) => found.has(section)) ?? null;
}

/** Every section that holds a field with a problem, for the marker on its tab. */
function sectionsWithProblems(
  errors: Errors,
  hiddenFields: readonly string[],
): ReadonlySet<Section> {
  return new Set(
    Object.keys(errors).flatMap((field) =>
      hiddenFields.includes(field) ? "review" : (SECTION_OF_FIELD[field] ?? []),
    ),
  );
}

/** The origin of a provider and its model as one choice: it counts as set when either of the two was set here. */
function pairOrigin(
  origin: SettingsOrigin,
  set: boolean,
  setText: string,
): SettingsOrigin {
  return set
    ? { ...origin, source: setText, resetLabel: RESET_LABEL }
    : { ...origin, resetLabel: null };
}

/** The kind that has a problem the selected kind does not show, or null. */
function hiddenProblemOf(
  errors: Errors,
  selected: ProjectReviewKind,
): ProjectReviewKind | null {
  const other = selected === "diff" ? "dynamic" : "diff";
  const hidden = selected === "diff" ? DYNAMIC_ONLY_FIELDS : DIFF_ONLY_FIELDS;
  return Object.keys(errors).some((field) => hidden.includes(field))
    ? other
    : null;
}

const UNCHANGED_TEXT = "No changes to save.";

function confirmText(
  product: ProductIdentity,
  kind: ProjectReviewKind,
  dynamicReviewEnabled: boolean,
  mode: SettingsFormModel["mode"],
  following?: number,
): string {
  const base =
    mode === "global"
      ? followersText(kind, following)
      : "Reviews of this project that are still waiting are cancelled, and a review that is already running finishes. The next review posts a new summary comment on the pull request; the findings of the current comment are not carried over.";
  const gateOff =
    mode === "global"
      ? gateOffWarningDefaults(product)
      : gateOffWarning(product);
  return kind === "dynamic" && !dynamicReviewEnabled
    ? `${base} ${gateOff}`
    : base;
}

const SAVED_TEXT =
  "Saved. Reviews that start from now on use these values; a review that is already running keeps the values it started with.";

/**
 * Splits the problems of a save into those that belong to a field of the form and those that do not
 * (a problem with the settings as a whole, a field this version does not know): the second kind is
 * shown with the message at the foot of the form, never dropped.
 */
function splitIssues(
  product: ProductIdentity,
  issues: readonly RequestIssue[],
): {
  fieldErrors: Errors;
  general: string[];
} {
  const fieldErrors: Errors = {};
  const general: string[] = [];
  for (const issue of issues) {
    const text = describeIssue(
      product,
      issue.field,
      issue.code,
      issue.maximumCents,
    );
    if (
      (REVIEW_SETTING_FIELDS as readonly string[]).includes(issue.field) ||
      (PROJECT_DYNAMIC_SETTING_FIELDS as readonly string[]).includes(
        issue.field,
      )
    )
      fieldErrors[issue.field] = text;
    else general.push(text);
  }
  return { fieldErrors, general };
}

/** The "Default" option of a project that chooses no entry while the workspace defaults choose one (#676): it names the provider and the entry it resolves to. */
const workspaceDefaultOption = (entry: {
  providerLabel: string;
  name: string;
}) => `${MODEL_CHOICE_DEFAULT_OPTION} (${entry.providerLabel} · ${entry.name})`;

/** The requests one save makes: a project's travel in two groups, the defaults' in one set. */
function planOf(model: SettingsFormModel, state: FormState) {
  return model.mode === "global"
    ? planGlobalSave(model, state)
    : planProjectSave(model, state);
}

export function SettingsForm({
  product,
  workspaceSlug,
  initial,
  repositoryId,
  readOnly = false,
  readOnlyNote = "Only Admins and Owners can change these values.",
  dynamicReviewEnabled = false,
  keyedProviders,
  nativeCatalog,
  billingOn = true,
  canConfirmProviderAddress = false,
  providers: providerDescriptors = llmProviderDescriptors.providers,
  api: apiOverride,
  catalogApi,
}: {
  /** The product whose name the sentences of the form use. */
  product: ProductIdentity;
  /** The workspace of the page: the call is made in it. */
  workspaceSlug: string;
  initial: SettingsFormModel;
  /** The repository of the project being edited; required for a project form. */
  repositoryId?: string;
  /**
   * The values are shown and cannot be changed: the person's role does not allow it (the route refuses a
   * save in any case, src/workspaces/permissions.ts).
   */
  readOnly?: boolean;
  /** What the form says in place of the save button while it is read only. */
  readOnlyNote?: string;
  /**
   * Whether the instance has turned Dynamic Review on (the #195 gate). Unknown counts as off: the card
   * never implies that Dynamic Review works when it may not.
   */
  dynamicReviewEnabled?: boolean;
  /**
   * The providers that have a stored key in this workspace (#433). A workspace on its own key is warned about a
   * chosen provider that is not in the list; unknown (not given) warns about nothing.
   */
  keyedProviders?: readonly string[];
  /**
   * The models.dev catalog as far as this project form needs it (#555): the catalog providers the workspace holds a key for, the
   * token cap and whether billing is on. Only a project form of a workspace on its own key gets it; the Dynamic provider select
   * then offers those providers next to the registry's and the model is picked from a list. The Diff provider is not affected.
   */
  nativeCatalog?: NativeFormData;
  /** Billing is on (#675): a workspace on the operator's key is told its reviews are billed via code-review.com. Unknown counts as on. */
  billingOn?: boolean;
  /**
   * The person may manage the workspace's LLM key (`manage_llm_key`, Owner and Admin): only they confirm a new address of the
   * project's catalog provider (#588); the route refuses anyone else. Unknown counts as no.
   */
  canConfirmProviderAddress?: boolean;
  /** Only tests pass this: the providers the selects offer, the registry's by default. */
  providers?: ReadonlyArray<
    Pick<LlmProviderDescriptor, "id" | "label" | "defaultModels"> &
      SuggestingProvider
  >;
  /** Only tests pass this: a server component cannot hand functions to this client component. */
  api?: SettingsApi;
  /** Only tests pass this: the call that lists the models of a catalog provider. */
  catalogApi?: CatalogModelsApi;
}) {
  // One client for the life of the component: a new one every render would restart what depends on it.
  const defaultApi = useMemo(
    () =>
      initial.mode === "project" && repositoryId !== undefined
        ? browserProjectSettingsApi(workspaceSlug, repositoryId)
        : browserGlobalSettingsApi(workspaceSlug),
    [initial.mode, repositoryId, workspaceSlug],
  );
  const api = apiOverride ?? defaultApi;
  const providerChoices = useMemo(
    () => providerOptions(providerDescriptors, keyedProviders),
    [providerDescriptors, keyedProviders],
  );
  // The Dynamic provider select also offers the catalog providers (#555); the Diff select keeps the registry's.
  const dynamicProviderChoices = useMemo(
    () => [...providerChoices, ...(nativeCatalog?.providers ?? [])],
    [providerChoices, nativeCatalog],
  );
  // The models to pick from for a provider and a review kind (none for a provider the form does not know).
  const suggestionsOf = (providerId: string, reviewKind: ProjectReviewKind) => {
    const provider = providerDescriptors.find(
      (entry) => entry.id === providerId,
    );
    return provider === undefined
      ? []
      : suggestedModelsFor(provider, reviewKind);
  };
  // The default model of a provider for a review kind, where the layer below holds the model of another provider:
  // "Reset to default" and the hint of the default must never name that one (#532).
  const providerDefaultModel = (
    providerId: string,
    reviewKind: ProjectReviewKind,
  ) =>
    providerDescriptors.find((entry) => entry.id === providerId)?.defaultModels[
      reviewKind
    ];
  const formRef = useRef<HTMLFormElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  // Set synchronously, so a confirmation that fires twice cannot start two saves (#200 review).
  const savingRef = useRef(false);
  const [model, setModel] = useState(initial);
  const [state, setState] = useState(() => initialFormState(initial));
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  // The message of a request of the Review kind card that failed after another one was saved.
  const [kindError, setKindError] = useState<string | null>(null);
  const [status, setStatus] = useState<"saved" | "unchanged" | null>(null);
  // The notes of the save that was just shown as saved (#269); only shown with that status.
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // A different Diff provider removes the fallback model that was stored for the old one; the LLM section says so.
  const [fallbackRemoved, setFallbackRemoved] = useState(false);
  // A save that waits for the person to confirm the switch of the review kind.
  const [confirming, setConfirming] = useState<{
    steps: SaveStep[];
    to: ProjectReviewKind;
  } | null>(null);
  // Bumped when a save was refused: the first marked field is focused then (rulebook R20).
  const [focusRequest, setFocusRequest] = useState(0);
  // The section that is open (#656); a refused save opens the first one that has a problem.
  const [section, setSection] = useState<Section>("review");

  // The review kind, the Dynamic model and the verdict are set on a project and, since #676, on the workspace defaults.
  const projectView = model.dynamic;
  const kind: ProjectReviewKind = state.dynamic?.reviewKind ?? "diff";
  const preview = useMemo(() => previewSettings(model, state), [model, state]);
  const cost: ReviewCostGuard | null =
    preview === null ? null : estimateReviewCost(preview);
  // Whether anything differs from what was loaded; the person can take it all back.
  const dirty = useMemo(() => {
    if (projectView === undefined) return false;
    const plan = planOf(model, state);
    return !plan.ok || plan.steps.length > 0;
  }, [model, projectView, state]);
  const hiddenProblem =
    projectView === undefined ? null : hiddenProblemOf(errors, kind);

  // After the refusals are in the DOM, the first marked control takes the focus; a problem in a field
  // the selected kind does not show, or a failure that belongs to no field, takes it instead.
  useEffect(() => {
    if (focusRequest === 0) return;
    // A section that was opened by the refusal mounts right after this render: look once it is there.
    queueMicrotask(() => {
      const form = formRef.current;
      const target =
        form?.querySelector<HTMLElement>('[aria-invalid="true"]') ??
        form?.querySelector<HTMLElement>("[data-hidden-problem]") ??
        form?.querySelector<HTMLElement>("[data-kind-error]") ??
        form?.querySelector<HTMLElement>("[data-form-error]");
      target?.focus();
    });
  }, [focusRequest]);

  // A change takes the problem of its field away, and any message of a save that failed: the
  // person is working on the form again, so a "not saved" of an earlier try no longer applies.
  function edit(next: FormState, changed: string) {
    setState(next);
    setStatus(null);
    setKindError(null);
    setFormError(null);
    setErrors((current) => {
      if (current[changed] === undefined) return current;
      const rest = { ...current };
      delete rest[changed];
      return rest;
    });
  }

  function adopt(answer: unknown): boolean {
    const next = modelFromAnswer(model.mode, answer);
    if (next === null) return false;
    setModel(next);
    setState(initialFormState(next));
    setErrors({});
    setFallbackRemoved(false);
    return true;
  }

  function refuse(fieldErrors: Errors, message: string) {
    setErrors(fieldErrors);
    const withProblem = firstSectionWithProblem(
      fieldErrors,
      projectView === undefined
        ? []
        : kind === "diff"
          ? DYNAMIC_ONLY_FIELDS
          : DIFF_ONLY_FIELDS,
    );
    if (withProblem !== null) setSection(withProblem);
    setFormError(message);
    setFocusRequest((count) => count + 1);
  }

  // The requests of one project save, in order. The first failure stops the rest; what an earlier
  // request saved stays saved and is shown as saved, the cards of the failed request keep their edits.
  // The guard is a ref, not `busy`: a second activation of the confirmation can arrive before React
  // has re-rendered with `busy` true, and would send the same save twice (#200 review).
  async function runSteps(steps: SaveStep[]) {
    if (savingRef.current) return;
    savingRef.current = true;
    setBusy(true);
    try {
      let currentModel = model;
      let currentState = state;
      const notes: string[] = [];
      for (const [index, step] of steps.entries()) {
        // The defaults say which version of them this form was built from, so a save over newer ones is refused (#676).
        const result =
          currentModel.mode === "global"
            ? await api.save(step.body, {
                expectedUpdatedAt: currentModel.lastSaved?.at ?? null,
              })
            : await api.save(step.body);
        if (!result.ok) {
          const { fieldErrors, general } = splitIssues(product, result.issues);
          const failure = [
            describeSaveFailure(product, result.code),
            ...general,
            ...projectsNote(result.details),
          ].join(" ");
          const partial = index > 0;
          // After a saved first request, the card of the failed one says what was not saved.
          if (partial && step.cards.length === 1 && step.cards[0] === "kind")
            setKindError(`Not saved. ${failure}`);
          refuse(
            fieldErrors,
            partial
              ? `Some changes were saved, the others were not. ${failure}`
              : failure,
          );
          return;
        }
        const next = modelFromAnswer(model.mode, result.data);
        if (next === null) {
          refuse({}, describeSaveFailure(product, "UNEXPECTED_RESPONSE"));
          return;
        }
        for (const warning of warningsFromAnswer(result.data)) {
          const text = describeWarning(warning.field, warning.code);
          if (text !== null && !notes.includes(text)) notes.push(text);
        }
        currentModel = next;
        currentState = adoptCards(currentState, next, step.cards);
        setModel(currentModel);
        setState(currentState);
      }
      setErrors({});
      setWarnings(notes);
      setStatus("saved");
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setStatus(null);
    setFormError(null);
    setKindError(null);
    // A model without the Dynamic part (an answer of an older server) cannot be planned.
    if (projectView === undefined) {
      refuse({}, describeSaveFailure(product, "UNEXPECTED_RESPONSE"));
      return;
    }
    const plan = planOf(model, state);
    if (!plan.ok) {
      const { fieldErrors, general } = splitIssues(product, plan.issues);
      refuse(
        fieldErrors,
        [
          describeSaveFailure(product, "REVIEW_SETTINGS_INVALID"),
          ...general,
        ].join(" "),
      );
      return;
    }
    setErrors({});
    // An untouched form sends nothing: an empty request would clear the Diff overrides.
    if (plan.steps.length === 0) {
      setStatus("unchanged");
      return;
    }
    if (plan.kindChange !== null) {
      setConfirming({ steps: plan.steps, to: plan.kindChange.to });
      return;
    }
    await runSteps(plan.steps);
  }

  async function resetAll() {
    if (api.reset === undefined || busy) return;
    setStatus(null);
    setFormError(null);
    setKindError(null);
    setBusy(true);
    const result = await api.reset();
    setBusy(false);
    if (!result.ok) {
      setFormError(describeSaveFailure(product, result.code));
      return;
    }
    if (!adopt(result.data))
      setFormError(describeSaveFailure(product, "UNEXPECTED_RESPONSE"));
    else {
      setWarnings([]);
      setStatus("saved");
    }
  }

  // Takes every unsaved change back to what was loaded; nothing is sent.
  function discard() {
    setState(initialFormState(model));
    setErrors({});
    setFallbackRemoved(false);
    setFormError(null);
    setKindError(null);
    setStatus(null);
  }

  const handlers: SettingsFieldHandlers = {
    setText: (name: TextField, value: string) =>
      edit(
        name === "provider"
          ? setProvider(state, value)
          : setText(state, name, value),
        name,
      ),
    setBoolean: (name: BooleanField, value: boolean) =>
      edit(setBoolean(state, name, value), name),
    setCommand: (command, allowed) =>
      edit(setCommand(state, command, allowed), "allowedCommands"),
    reset: (name: ReviewSettingField) => {
      const ownDefault =
        name === "model" && state.values.provider !== model.inherited.provider
          ? providerDefaultModel(state.values.provider, "diff")
          : undefined;
      edit(
        ownDefault === undefined
          ? resetField(state, name, model)
          : resetModelTo(state, ownDefault),
        name,
      );
    },
  };
  const shippedSkill = projectView?.defaults.reviewSkill ?? "";
  const defaultProvider = projectView?.defaults.dynamicProvider ?? "";
  // The default model goes with the provider: the built-in one only while the built-in provider is chosen (#532).
  const chosenDynamicProvider = state.dynamic?.dynamicProvider ?? "";
  // A Dynamic provider outside the registry is a catalog provider: its model is picked from the catalog's list (#555).
  const chosenNative =
    nativeCatalog === undefined || chosenDynamicProvider === ""
      ? undefined
      : nativeCatalog.providers.find(
          (provider) => provider.id === chosenDynamicProvider,
        );
  const kindHandlers: ReviewKindHandlers = {
    setKind: (next) => edit(setReviewKind(state, next), "reviewKind"),
    editSkill: () => edit(editSkill(state, shippedSkill), "reviewSkill"),
    setSkill: (text) => edit(setSkillText(state, text), "reviewSkill"),
    resetSkill: () => edit(resetSkill(state, shippedSkill), "reviewSkill"),
  };
  const disabled = busy || readOnly;
  const saveLabel =
    model.mode === "project" ? "Save review settings" : "Save review defaults";

  // The LLM section (#656): a provider and a model dropdown for the review kind that is selected. A provider chosen takes
  // the default model of that provider with it, so the model dropdown is never left empty (a catalog provider has none).
  const ownChoice = (): OwnLlmChoice => {
    const dynamicChoice = projectView !== undefined && kind === "dynamic";
    if (
      !dynamicChoice ||
      state.dynamic === undefined ||
      projectView === undefined
    ) {
      const provider = state.values.provider;
      return {
        providerName: "provider",
        modelName: "model",
        providers: providerChoices,
        provider,
        // The provider and its model are one choice: one origin, and a reset takes both back.
        providerOrigin: pairOrigin(
          settingsOrigin({
            model,
            state,
            name: "provider",
            label: "provider and model",
            onReset: () => handlers.reset("provider"),
          }),
          state.overridden.provider || state.overridden.model,
          model.mode === "project"
            ? "Set for this project"
            : "Changed from the built-in value",
        ),
        providerError: errors.provider,
        model: state.values.model,
        modelError: errors.model,
        onProvider: (next) => {
          if (
            next !== state.values.provider &&
            state.values.fallbackModel !== ""
          )
            setFallbackRemoved(true);
          const withProvider = setProvider(state, next);
          const fallback = providerDefaultModel(next, "diff");
          edit(
            fallback === undefined || next === state.values.provider
              ? withProvider
              : setText(withProvider, "model", fallback),
            "provider",
          );
        },
        onModel: (next) => handlers.setText("model", next),
        registryModels: suggestionsOf(provider, "diff"),
        keysHint: false,
        ...(fallbackRemoved ? { notice: FALLBACK_REMOVED_NOTICE } : {}),
      };
    }
    const defaultDynamicModel = projectView.defaults.dynamicModel ?? "";
    const dynamicChanged =
      chosenDynamicProvider !== defaultProvider ||
      state.dynamic.dynamicModel !== defaultDynamicModel;
    const sources = [
      projectView.sources.dynamicProvider,
      projectView.sources.dynamicModel,
    ];
    const providerOrigin: SettingsOrigin = {
      source:
        dynamicChanged || sources.includes("project")
          ? model.mode === "project"
            ? "Set for this project"
            : "Changed from the built-in value"
          : sources.includes("global")
            ? "Global default"
            : "Built-in value",
      resetLabel: dynamicChanged ? RESET_LABEL : null,
      resetAriaLabel: "Reset to default for Dynamic Review provider and model",
      onReset: () =>
        edit(
          setDynamicModel(
            setDynamicProvider(state, defaultProvider),
            defaultDynamicModel,
          ),
          "dynamicProvider",
        ),
    };
    return {
      providerName: "dynamicProvider",
      modelName: "dynamicModel",
      providers: dynamicProviderChoices,
      provider: chosenDynamicProvider,
      providerOrigin,
      providerError: errors.dynamicProvider,
      model: state.dynamic.dynamicModel,
      modelError: errors.dynamicModel,
      onProvider: (next) => {
        const withProvider = setDynamicProvider(state, next);
        const fallback = providerDefaultModel(next, "dynamic");
        edit(
          fallback === undefined || next === chosenDynamicProvider
            ? withProvider
            : setDynamicModel(withProvider, fallback),
          "dynamicProvider",
        );
      },
      onModel: (next) => edit(setDynamicModel(state, next), "dynamicModel"),
      registryModels: suggestionsOf(chosenDynamicProvider, "dynamic"),
      ...(nativeCatalog === undefined || chosenNative === undefined
        ? {}
        : {
            catalog: {
              label: chosenNative.label,
              tokenCap: nativeCatalog.tokenCap,
              billingOn: nativeCatalog.billingOn,
            },
          }),
      ...(projectView.providerAddress == null ||
      chosenDynamicProvider !== projectView.effective.dynamicProvider
        ? {}
        : {
            // #588: only for the provider the project has pinned; one chosen instead is pinned by its own selection.
            addressNote: (
              <ProviderAddressNote
                address={projectView.providerAddress}
                confirm={state.dynamic.confirmProviderAddress}
                canConfirm={canConfirmProviderAddress}
                disabled={disabled}
                onConfirmChange={(confirm) =>
                  edit(
                    setConfirmProviderAddress(state, confirm),
                    "dynamicProvider",
                  )
                }
              />
            ),
          }),
      keysHint: nativeCatalog !== undefined,
    };
  };
  const llmSection = () => {
    if (!model.managed)
      return (
        <LlmFieldset
          product={product}
          workspaceSlug={workspaceSlug}
          disabled={disabled}
          own={ownChoice()}
          {...(catalogApi === undefined ? {} : { catalogApi })}
        />
      );
    // The workspace reviews on the operator's key (#283, #433): the entry of the catalog for the kind is the model. The
    // defaults of the workspace choose one per kind as well (#676); a project that chooses none follows them.
    if (state.dynamic === undefined) return null;
    const field = CATALOG_FIELD_OF_KIND[kind];
    const choices = model.catalog?.choices[kind] ?? [];
    const followed = model.catalog?.workspaceSelection?.[kind] ?? null;
    const followedEntry =
      followed === null
        ? undefined
        : choices.find((entry) => entry.id === followed);
    return (
      <LlmFieldset
        product={product}
        workspaceSlug={workspaceSlug}
        disabled={disabled}
        managedFieldName={field}
        billingOn={billingOn}
        managed={{
          choices,
          value: state.dynamic.catalogEntries[kind],
          error: errors[field],
          onChange: (id) => edit(setCatalogEntry(state, kind, id), field),
          ...(followedEntry === undefined
            ? {}
            : { defaultLabel: workspaceDefaultOption(followedEntry) }),
        }}
      />
    );
  };
  const sectionNames = SECTION_NAMES;
  const withProblems = sectionsWithProblems(
    errors,
    projectView === undefined
      ? []
      : kind === "diff"
        ? DYNAMIC_ONLY_FIELDS
        : DIFF_ONLY_FIELDS,
  );

  return (
    <div className="flex flex-col gap-6">
      <form
        ref={formRef}
        onSubmit={(event) => void submit(event)}
        aria-label="Review settings"
        noValidate
        className="flex flex-col gap-6"
      >
        <Tabs
          value={section}
          onValueChange={(next) => {
            if (isSection(next)) setSection(next);
          }}
        >
          <TabsList aria-label="Settings sections">
            {SECTIONS.map((name) => (
              <TabsTrigger
                key={name}
                value={name}
                {...(withProblems.has(name)
                  ? {
                      "aria-label": `${sectionNames[name]} ${TAB_PROBLEM_NOTE}`,
                    }
                  : {})}
              >
                {sectionNames[name]}
                {withProblems.has(name) ? (
                  <WarningCircleIcon
                    aria-hidden="true"
                    weight="fill"
                    className="text-destructive"
                  />
                ) : null}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="review" className="flex flex-col gap-6">
            {projectView !== undefined && state.dynamic !== undefined ? (
              <>
                <ReviewKindFieldset
                  view={projectView}
                  values={state.dynamic}
                  errors={errors}
                  disabled={disabled}
                  dynamicReviewEnabled={dynamicReviewEnabled}
                  hiddenProblem={hiddenProblem}
                  kindError={kindError}
                  handlers={kindHandlers}
                  workspaceDefaults={model.mode === "global"}
                  followsDefault={
                    model.mode === "project" &&
                    projectView.sources.reviewKind === "global" &&
                    kind === projectView.effective.reviewKind
                  }
                />
                <ReviewVerdictFieldset
                  value={state.dynamic.reviewVerdict}
                  kind={kind}
                  defaultMode={projectView.defaults.reviewVerdict}
                  error={errors.reviewVerdict}
                  disabled={disabled}
                  onChange={(mode) =>
                    edit(setReviewVerdict(state, mode), "reviewVerdict")
                  }
                  followsDefault={
                    model.mode === "project" &&
                    projectView.sources.reviewVerdict === "global" &&
                    state.dynamic.reviewVerdict ===
                      projectView.effective.reviewVerdict
                  }
                />
              </>
            ) : null}
            <ReviewFieldset
              model={model}
              state={state}
              errors={errors}
              disabled={disabled}
              handlers={handlers}
              kind={kind}
            />
          </TabsContent>
          <TabsContent value="llm" className="flex flex-col gap-6">
            {llmSection()}
          </TabsContent>
          <TabsContent value="trigger" className="flex flex-col gap-6">
            <WhenFieldset
              model={model}
              state={state}
              errors={errors}
              disabled={disabled}
              handlers={handlers}
            />
          </TabsContent>
          <TabsContent value="limits" className="flex flex-col gap-6">
            <LimitsFieldset
              model={model}
              state={state}
              errors={errors}
              disabled={disabled}
              handlers={handlers}
              cost={cost}
              diff={kind === "diff"}
            />
          </TabsContent>
        </Tabs>

        {formError !== null ? (
          <Alert variant="destructive" tabIndex={-1} data-form-error="">
            {formError}
          </Alert>
        ) : null}
        {status === "saved" ? (
          <Alert variant="success" role="status">
            {SAVED_TEXT}
          </Alert>
        ) : null}
        {status === "saved"
          ? warnings.map((text) => (
              <Alert key={text} variant="warning" role="status">
                {text}
              </Alert>
            ))
          : null}
        {status === "unchanged" ? (
          <Alert variant="info" role="status">
            {UNCHANGED_TEXT}
          </Alert>
        ) : null}

        <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
          {readOnly ? (
            <p className="text-sm text-muted-foreground">{readOnlyNote}</p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                ref={saveRef}
                type="submit"
                loading={busy}
                loadingLabel="Saving"
              >
                {saveLabel}
              </Button>
              {dirty && !busy ? (
                <Button variant="ghost" onClick={discard}>
                  Discard changes
                </Button>
              ) : null}
            </div>
          )}
          {model.lastSaved !== null ? (
            <p className="text-sm text-muted-foreground">
              Last saved{" "}
              <time dateTime={model.lastSaved.at}>
                {formatUtc(model.lastSaved.at)}
              </time>
              {model.lastSaved.by !== null ? ` by ${model.lastSaved.by}` : ""}.
            </p>
          ) : null}
        </div>
      </form>

      {api.reset === undefined ? null : (
        <DangerZone
          title="Reset to defaults"
          description="Removes every value set for this project — the Review kind, the Dynamic Review model, the review skill and the review verdict, together with the Diff settings — and follows the workspace defaults again."
          actionLabel="Reset everything"
          confirmTitle="Reset this project to the defaults?"
          confirmDescription="Every value set for this project is removed, including the Review kind, the Dynamic Review model, the review skill and the review verdict, and the workspace defaults apply again. Reviews started afterwards use the defaults."
          confirmLabel="Reset to defaults"
          onConfirm={resetAll}
        />
      )}

      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            // There is no trigger to return to: the focus goes back to the Save button.
            event.preventDefault();
            saveRef.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              Switch to {KIND_NAMES[confirming?.to ?? kind]}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmText(
                product,
                confirming?.to ?? kind,
                dynamicReviewEnabled,
                model.mode,
                model.followingProjects,
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirming !== null) void runSteps(confirming.steps);
              }}
            >
              Switch to {KIND_NAMES[confirming?.to ?? kind]}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
