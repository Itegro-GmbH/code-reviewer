// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createInstanceSettingsRepository } from "@/db/repositories/instance-settings-repository";
import { getDatabase } from "@/db/startup";
import { isBillingOn } from "@/billing/enabled";
import { nativeFormDataFor } from "@/native-providers/form-data";
import { getNativeCatalog } from "@/native-providers/shared";
import { ownKeyTokenCapOf } from "@/native-cost/token-cap";
import { isDynamicReviewEnabled } from "@/jobs/dynamic-review-gate";
import { getConfigStatusFor } from "@/config-status/shared";
import { configAudienceOf } from "@/config-status/status";
import { getWorkspaceLlm } from "@/llm/shared";
import { llmAccessAttention } from "@/llm/ui/llm-access-notice";
import { keyedProvidersFor } from "@/review-settings/ui/keyed-providers";
import { projectServiceFor } from "@/projects/shared";
import {
  loadProjectSettingsPage,
  ProjectSettingsPageContent,
} from "@/projects/ui/project-settings-page";
import { reviewSettingsServiceFor } from "@/review-settings/shared";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { can } from "@/workspaces/permissions";
import { getProductIdentity } from "@/product-identity/current";

export const metadata: Metadata = { title: "Review settings" };

// The review settings of one project (#925: `/projects/<id>/review`; the Setup tab links here, and in a deployment without the factory the
// project's own address opens it). The address names the workspace and the repository by its id in this
// app. An id nobody has in this workspace (also one of another workspace) shows the not-found page; with
// Cache Components the data sits behind the layout's <Suspense>, so the response is already streaming and
// its HTTP status stays 200 (a status of 404 would need the lookup before the first byte, which only data
// outside Suspense allows). A repository that was never activated has its settings page too (the settings
// are saved first and apply once the project is switched on).
export default async function ProjectSettingsPage({
  params,
}: PageProps<"/w/[workspace]/projects/[repositoryId]/review">) {
  const { workspace: slug, repositoryId } = await params;
  const { workspace, role, user } = await requireWorkspace(slug);
  return (
    <ProjectSettingsContent
      workspaceId={workspace.id}
      workspaceSlug={workspace.slug}
      repositoryId={repositoryId}
      canManageLlmKey={can(role, "manage_llm_key")}
      user={user}
    />
  );
}

async function ProjectSettingsContent({
  workspaceId,
  workspaceSlug,
  repositoryId,
  canManageLlmKey,
  user,
}: {
  workspaceId: string;
  workspaceSlug: string;
  repositoryId: string;
  canManageLlmKey: boolean;
  user: { isInstanceAdmin: boolean };
}) {
  const data = await loadProjectSettingsPage(repositoryId, {
    projects: projectServiceFor(workspaceId),
    settings: reviewSettingsServiceFor(workspaceId),
    // Only the instance admin gets the names of the variables that are wrong.
    config: () => getConfigStatusFor(user),
    // Shown on the Review kind card: Dynamic Review runs only while the instance has turned it on.
    dynamicReviewEnabled: () => isDynamicReviewEnabled(getDatabase()),
  });
  if (data.kind === "not_found") notFound();
  // The workspace's LLM hint is a row of the page's one "Needs attention" strip, not its own region.
  const llm = getWorkspaceLlm();
  // The key statuses are read only for a workspace on its own key; a managed one is handed no provider id.
  const [llmSummary, keyedProviders, nativeCatalog, billingOn] =
    await Promise.all([
      llm.summaryFor(workspaceId),
      keyedProvidersFor(data.model, llm.keyServiceFor(workspaceId)),
      // The catalog providers and models of Dynamic Review on the workspace's own key (#555); nothing for a managed one.
      nativeFormDataFor(
        {
          managed: data.model.managed,
          currentProvider: data.model.dynamic?.effective.dynamicProvider,
        },
        {
          catalog: getNativeCatalog(),
          keys: llm.keyServiceFor(workspaceId),
          billingOn: () => isBillingOn(getDatabase()),
          tokenCap: async () =>
            ownKeyTokenCapOf(
              await createInstanceSettingsRepository(getDatabase()).get(
                "own_key_max_total_tokens",
              ),
            ),
        },
      ),
      isBillingOn(getDatabase()),
    ]);
  const llmNotice = llmAccessAttention({
    product: getProductIdentity(),
    workspaceSlug,
    summary: llmSummary,
    canManage: canManageLlmKey,
  });
  return (
    <ProjectSettingsPageContent
      product={getProductIdentity()}
      workspaceSlug={workspaceSlug}
      audience={configAudienceOf(user)}
      llmNotice={llmNotice}
      {...(keyedProviders === undefined ? {} : { keyedProviders })}
      {...(nativeCatalog === undefined ? {} : { nativeCatalog })}
      billingOn={billingOn}
      canConfirmProviderAddress={canManageLlmKey}
      data={data}
    />
  );
}
