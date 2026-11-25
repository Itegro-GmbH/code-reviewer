// SPDX-License-Identifier: LicenseRef-Proprietary

import { getProductIdentity } from "@/product-identity/current";
import type { Metadata } from "next";
import { getCapabilities } from "@/capabilities/shared";
import { instanceAccessOf } from "@/llm/access";
import { getLlmKeyModeService } from "@/llm/key-mode-shared";
import { getWorkspaceLlm } from "@/llm/shared";
import { getNativeCatalog } from "@/native-providers/shared";
import { LlmSettingsPageContent } from "@/llm/ui/llm-settings-page";
import { billingPageLinkedFor } from "@/billing/shared";
import { planPageLinkedFor } from "@/usage/shared";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { can } from "@/workspaces/permissions";

export function generateMetadata(): Metadata {
  return {
    title: getCapabilities().has("implementer")
      ? "Setup · LLM keys"
      : "Settings · LLM",
  };
}

// The LLM access of the workspace (#178): the provider and the write-only key on one form (an Admin or
// an Owner), with "Save key" and "Test key"; a Member only reads whether reviews have a key. Removing
// the key is a destructive action at the end of this page (#658).
export default async function LlmSettingsPage({
  params,
}: PageProps<"/w/[workspace]/settings/llm">) {
  const { workspace: slug } = await params;
  const { workspace, role } = await requireWorkspace(slug);
  return (
    <LlmSettingsContent
      workspaceId={workspace.id}
      workspaceSlug={workspace.slug}
      canManage={can(role, "manage_llm_key")}
    />
  );
}

async function LlmSettingsContent({
  workspaceId,
  workspaceSlug,
  canManage,
}: {
  workspaceId: string;
  workspaceSlug: string;
  canManage: boolean;
}) {
  const llm = getWorkspaceLlm();
  const [keyStatuses, nativeStatuses, summary, showPlan, showBilling] =
    await Promise.all([
      llm.keyServiceFor(workspaceId).statusAll(),
      // The keys of the catalog providers (#555) can be removed too, whatever the catalog offers now.
      llm.keyServiceFor(workspaceId).nativeStatuses(),
      llm.summaryFor(workspaceId),
      planPageLinkedFor(workspaceId),
      billingPageLinkedFor(),
    ]);
  // While billing is on the workspace chooses whose key its reviews use (#496); the key forms stay on the page whichever it chose.
  // `showBilling` is the switch: with billing off there is no choice and the page is what it was.
  const keyChoice = showBilling
    ? await getLlmKeyModeService().choiceOf(workspaceId)
    : undefined;
  // A workspace on the instance's access has no provider to choose: the catalog is not read for it (#555), unless it can choose.
  const catalog =
    instanceAccessOf(summary) === null || keyChoice !== undefined
      ? {
          providers: await getNativeCatalog().providers(),
          keyStatuses: await llm.keyServiceFor(workspaceId).nativeStatuses(),
        }
      : undefined;
  // #1150: the Claude Code OAuth token, where the factory runs the harness `claude-code`.
  const claudeCodeToken = getCapabilities().has("implementer")
    ? await llm.claudeCodeTokenFor(workspaceId).status()
    : undefined;
  const catalogLabels =
    !canManage || nativeStatuses.length === 0
      ? new Map<string, string>()
      : new Map(
          (await getNativeCatalog().providers()).map((provider) => [
            provider.id,
            provider.label,
          ]),
        );
  return (
    <LlmSettingsPageContent
      product={getProductIdentity()}
      workspaceSlug={workspaceSlug}
      canManage={canManage}
      instanceAccess={instanceAccessOf(summary)}
      removableKeys={
        canManage
          ? [
              ...keyStatuses.map(({ provider, status }) => ({
                provider,
                configured: status.state !== "not_configured",
              })),
              ...nativeStatuses.map(({ provider, status }) => {
                const label = catalogLabels.get(provider);
                return {
                  provider,
                  configured: status.state !== "not_configured",
                  ...(label === undefined ? {} : { label }),
                };
              }),
            ]
          : []
      }
      keyStatuses={keyStatuses}
      {...(catalog === undefined ? {} : { catalog })}
      summary={summary}
      {...(keyChoice === undefined ? {} : { keyChoice })}
      {...(claudeCodeToken === undefined ? {} : { claudeCodeToken })}
      showPlan={showPlan}
      showBilling={showBilling}
      // In the factory the LLM keys are a place of Setup, not of the settings (#1108); code-review.com keeps its settings page.
      setup={getCapabilities().has("implementer")}
    />
  );
}
