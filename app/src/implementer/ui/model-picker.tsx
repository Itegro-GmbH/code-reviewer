// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The model picker of the form (#756), fed by the models route of #755 and drawn with the select of the settings form
// (`review-settings/ui/model-select.tsx`). Which of the two shapes applies is the workspace's key mode, decided by the server:
//  - own key: a provider (those with a saved key), then one of its models. The choice is `{ provider, model }`;
//  - operator's key: one released entry by the name the operator gave it, with the name of its provider beside it, never a model
//    id of the provider (ADR 0005). The choice is `{ entryId }`.
// Nothing is offered when nothing is configured, and the page says where to configure it.
import Link from "next/link";
import { Alert } from "../../components/ui/alert.tsx";
import type { ModelChoice } from "../../db/implementer-model-choice.ts";
import {
  ModelSelect,
  type ModelOption,
} from "../../review-settings/ui/model-select.tsx";
import { workspacePath } from "../../workspaces/paths.ts";
import type { ModelOptions, OwnProviderOption } from "../models.ts";
import { FORM_COPY, describeModelRefusal } from "./messages.ts";

/** What the person has picked so far; the choice itself follows from it and from the options. */
export type ModelPick = { provider: string; model: string };

/** The provider in force: the picked one if it is still offered, else the first. */
function providerOf(
  providers: readonly OwnProviderOption[],
  picked: string,
): OwnProviderOption | undefined {
  return providers.find((provider) => provider.id === picked) ?? providers[0];
}

/** The choice the picks stand for under these options, or undefined while there is none. */
export function modelChoiceOf(
  options: ModelOptions | undefined,
  pick: ModelPick,
): ModelChoice | undefined {
  if (options === undefined || options.keyMode === "unreadable")
    return undefined;
  if (options.keyMode === "managed")
    return options.entries.some((entry) => entry.id === pick.model)
      ? { entryId: pick.model }
      : undefined;
  const provider = providerOf(options.providers, pick.provider);
  return provider?.models.some((model) => model.id === pick.model)
    ? { provider: provider.id, model: pick.model }
    : undefined;
}

/** Whether the options offer something to choose. */
export function hasModels(options: ModelOptions): boolean {
  if (options.keyMode === "own") return options.providers.length > 0;
  if (options.keyMode === "managed") return options.entries.length > 0;
  return false;
}

export function ModelPicker({
  workspaceSlug,
  options,
  pick,
  error,
  loading,
  onPick,
}: {
  workspaceSlug: string;
  /** Undefined while the options are loading. */
  options: ModelOptions | undefined;
  pick: ModelPick;
  error: string | undefined;
  loading: boolean;
  onPick: (pick: ModelPick) => void;
}) {
  if (options === undefined)
    return (
      <ModelSelect
        name="model"
        label={FORM_COPY.model}
        value=""
        options={[]}
        onChange={() => {}}
        loading={loading}
      />
    );
  if (options.keyMode === "unreadable")
    return (
      <Alert variant="destructive">
        {describeModelRefusal("key_mode_unreadable")}
      </Alert>
    );
  if (!hasModels(options))
    return (
      <Alert variant="info" role="status">
        {FORM_COPY.noModelBefore}{" "}
        <Link
          href={workspacePath(workspaceSlug, "/settings/llm")}
          className="font-semibold underline underline-offset-4"
        >
          {FORM_COPY.noModelLink}
        </Link>{" "}
        {FORM_COPY.noModelAfter}
      </Alert>
    );
  if (options.keyMode === "managed") {
    const entries: ModelOption[] = options.entries.map((entry) => ({
      id: entry.id,
      label: entry.name,
      note: entry.providerLabel,
    }));
    return (
      <ModelSelect
        name="model"
        label={FORM_COPY.model}
        value={pick.model}
        options={entries}
        onChange={(model) => onPick({ provider: "", model })}
        error={error}
        placeholder={FORM_COPY.modelPlaceholder}
      />
    );
  }
  const provider = providerOf(options.providers, pick.provider);
  const models: ModelOption[] = (provider?.models ?? []).map((model) => ({
    id: model.id,
    label: model.name,
    ...(model.deprecated
      ? { note: FORM_COPY.deprecatedNote }
      : model.alpha
        ? { note: FORM_COPY.alphaNote }
        : {}),
  }));
  return (
    <>
      <ModelSelect
        name="provider"
        label={FORM_COPY.provider}
        value={provider?.id ?? ""}
        options={options.providers.map((entry) => ({
          id: entry.id,
          label: entry.label,
        }))}
        onChange={(id) => onPick({ provider: id, model: "" })}
        placeholder={FORM_COPY.providerPlaceholder}
      />
      <ModelSelect
        name="model"
        label={FORM_COPY.model}
        value={pick.model}
        options={models}
        onChange={(model) => onPick({ provider: provider?.id ?? "", model })}
        error={error}
        placeholder={FORM_COPY.modelPlaceholder}
      />
    </>
  );
}
