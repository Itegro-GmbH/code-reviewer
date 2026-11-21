// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Metadata } from "next";
import { getDatabase } from "@/db/startup";
import { isDynamicReviewEnabled } from "@/jobs/dynamic-review-gate";
import { getWorkspaceLlm } from "@/llm/shared";
import { keyedProvidersFor } from "@/review-settings/ui/keyed-providers";
import { reviewSettingsServiceFor } from "@/review-settings/shared";
import { isBillingOn } from "@/billing/enabled";
import { billingPageLinkedFor } from "@/billing/shared";
import { planPageLinkedFor } from "@/usage/shared";
import {
  GlobalSettingsPageContent,
  loadGlobalSettingsPage,
} from "@/review-settings/ui/global-settings-page";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { can } from "@/workspaces/permissions";
import { getProductIdentity } from "@/product-identity/current";
import { getCapabilities } from "@/capabilities/shared";
import { FACTORY_READ_ONLY_NOTE } from "@/review-settings/ui/read-only-note";

export const metadata: Metadata = { title: "Settings · Review defaults" };

// The review defaults of the workspace (#178): the values every project inherits, on one form with one
// explicit save. An Admin or an Owner changes them; a Member reads them.
export default async function ReviewDefaultsSettingsPage({
  params,
}: PageProps<"/w/[workspace]/settings/review-defaults">) {
  const { workspace: slug } = await params;
  const { workspace, role } = await requireWorkspace(slug);
  const workspaceId = workspace.id;
  const factory = getCapabilities().has("implementer");
  const [data, showPlan, showBilling, billingOn] = await Promise.all([
    loadGlobalSettingsPage({
      settings: reviewSettingsServiceFor(workspaceId),
      dynamicReviewEnabled: () => isDynamicReviewEnabled(getDatabase()),
    }),
    planPageLinkedFor(workspaceId),
    billingPageLinkedFor(),
    isBillingOn(getDatabase()),
  ]);
  // Only a workspace on its own key gets the list (and only then are its key statuses read).
  const keyedProviders = await keyedProvidersFor(
    data.model,
    getWorkspaceLlm().keyServiceFor(workspaceId),
  );
  return (
    <GlobalSettingsPageContent
      product={getProductIdentity()}
      workspaceSlug={workspace.slug}
      // In the factory the defaults are read only: an AI sets them through the API (#1108).
      canEdit={can(role, "manage_review_defaults") && !factory}
      {...(factory ? { readOnlyNote: FACTORY_READ_ONLY_NOTE } : {})}
      showPlan={showPlan}
      showBilling={showBilling}
      billingOn={billingOn}
      {...(keyedProviders === undefined ? {} : { keyedProviders })}
      data={data}
    />
  );
}
