// SPDX-License-Identifier: LicenseRef-Proprietary

// The "Review defaults" sub-page of the workspace settings (#178): the form for the global defaults
// every project inherits (reusing the settings form of #174 in its global mode, where there is no
// project reset; the destructive reset of every default sits at the end of this page, #658). It has the sections of a
// project's form: the review kind and verdict, the Diff and Dynamic provider and model, the trigger and the limits (#676). `loadGlobalSettingsPage` gathers the
// data from the service (passed in), `GlobalSettingsPageContent` renders it.
import type { ReviewSettingsService } from "../service.ts";
import type { SettingsApi } from "./api.ts";
import { SettingsScreen } from "../../workspaces/ui/settings-shell.tsx";
import { modelFromGlobalView, type SettingsFormModel } from "./form-model.ts";
import { ResetReviewDefaults } from "./reset-defaults.tsx";
import { SettingsForm } from "./settings-form.tsx";
import type { ProductIdentity } from "../../product-identity/identity.ts";

export type GlobalSettingsPageData = {
  model: SettingsFormModel;
  /** Whether the instance has turned Dynamic Review on (#195): the Review kind card says so when it is off. */
  dynamicReviewEnabled: boolean;
};

export async function loadGlobalSettingsPage(deps: {
  settings: Pick<ReviewSettingsService, "getGlobalSettings">;
  dynamicReviewEnabled?: () => boolean | Promise<boolean>;
}): Promise<GlobalSettingsPageData> {
  return {
    model: modelFromGlobalView(await deps.settings.getGlobalSettings()),
    dynamicReviewEnabled: (await deps.dynamicReviewEnabled?.()) ?? false,
  };
}

export function GlobalSettingsPageContent({
  product,
  workspaceSlug,
  canEdit = true,
  readOnlyNote,
  showPlan = false,
  showBilling = false,
  billingOn = true,
  keyedProviders,
  data,
  api,
  resetApi,
}: {
  /** The product whose name the sentences of the page use. */
  product: ProductIdentity;
  /** The workspace of the page. */
  workspaceSlug: string;
  /** Whether the person may change the defaults (an Admin or an Owner). */
  canEdit?: boolean;
  /** What the form says while it is read only (the default tells it is the role). */
  readOnlyNote?: string;
  /** The workspace has entitlements (#282): the settings navigation lists the Plan page. */
  showPlan?: boolean;
  /** Billing is on (#505): the settings navigation lists the Billing page instead of the Plan page. */
  showBilling?: boolean;
  /** Billing is on: the managed model choice says the reviews are billed via code-review.com (#675). */
  billingOn?: boolean;
  /** The providers that have a stored key in the workspace (#433): the form warns about a chosen one that has none. */
  keyedProviders?: readonly string[];
  data: GlobalSettingsPageData;
  api?: SettingsApi;
  /** Only tests pass this. */
  resetApi?: Pick<SettingsApi, "save">;
}) {
  // The reset puts the kind back to the built-in one: when that is another kind, the projects that follow the default switch.
  const dynamic = data.model.dynamic;
  const kindChange =
    dynamic !== undefined &&
    dynamic.effective.reviewKind !== dynamic.defaults.reviewKind
      ? {
          to: dynamic.defaults.reviewKind,
          ...(data.model.followingProjects === undefined
            ? {}
            : { following: data.model.followingProjects }),
        }
      : undefined;
  return (
    <SettingsScreen
      workspaceSlug={workspaceSlug}
      current="review-defaults"
      showPlan={showPlan}
      showBilling={showBilling}
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Every project uses these unless it sets a value of its own on its
          settings page.
        </p>
        {/* Keyed on the server data, see project-settings-page.tsx. */}
        <SettingsForm
          key={JSON.stringify([data.model, data.dynamicReviewEnabled])}
          product={product}
          workspaceSlug={workspaceSlug}
          readOnly={!canEdit}
          {...(readOnlyNote === undefined ? {} : { readOnlyNote })}
          dynamicReviewEnabled={data.dynamicReviewEnabled}
          billingOn={billingOn}
          initial={data.model}
          {...(keyedProviders === undefined ? {} : { keyedProviders })}
          {...(api === undefined ? {} : { api })}
        />
        {canEdit ? (
          <ResetReviewDefaults
            workspaceSlug={workspaceSlug}
            {...(kindChange === undefined ? {} : { kindChange })}
            {...(resetApi === undefined ? {} : { api: resetApi })}
          />
        ) : null}
      </div>
    </SettingsScreen>
  );
}
