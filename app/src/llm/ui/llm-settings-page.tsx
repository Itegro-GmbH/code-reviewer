// SPDX-License-Identifier: LicenseRef-Proprietary

// The "LLM access" sub-page content (#178): the settings frame and the key card. The page file only
// wires the real key service; the form itself is `LlmAccessSection` (one form, "Save key" and
// "Test key") for each provider. The removal of a key is a destructive action at the end of the page (#658).
import type { ProductIdentity } from "../../product-identity/identity.ts";
import { SettingsScreen } from "../../workspaces/ui/settings-shell.tsx";
import type { WorkspaceLlmSummary } from "../assemble.ts";
import type { ProviderKeyStatus } from "../workspace-key.ts";
import type { LlmKeyApi } from "./api.ts";
import type { InstanceAccess } from "../access.ts";
import {
  RemoveWorkspaceKeys,
  type RemovableKey,
} from "./remove-workspace-keys.tsx";
import {
  LlmAccessSection,
  type CatalogProvidersData,
  type KeyChoice,
} from "./llm-access-section.tsx";

export function LlmSettingsPageContent({
  product,
  workspaceSlug,
  canManage,
  keyStatuses,
  catalog,
  summary,
  keyChoice,
  removableKeys = [],
  instanceAccess = null,
  showPlan = false,
  showBilling = false,
  setup = false,
  api,
}: {
  product: ProductIdentity;
  workspaceSlug: string;
  /** An Admin or an Owner of the workspace (`manage_llm_key`). */
  canManage: boolean;
  /** The state of the key of every registered provider. */
  keyStatuses: ProviderKeyStatus[];
  /** The providers of the catalog (#555); absent for a workspace on the instance's access. */
  catalog?: CatalogProvidersData;
  summary: WorkspaceLlmSummary;
  /** Billing is on (#496): what the workspace chose, and whether it has a key of its own. Left out, there is no choice to make. */
  keyChoice?: KeyChoice;
  /** Every provider and whether a key of it is saved, for the removal at the end of the page (an Admin or an Owner). */
  removableKeys?: ReadonlyArray<RemovableKey>;
  /** Set for a workspace on the instance's access: no removal names a provider (see `RemoveWorkspaceKeys`). */
  instanceAccess?: InstanceAccess | null;
  /** The workspace has entitlements (#282): the settings navigation lists the Plan page. */
  showPlan?: boolean;
  /** Billing is on (#505): the settings navigation lists the Billing page instead of the Plan page. */
  showBilling?: boolean;
  /** The page is a place of Setup (the factory's "LLM keys", #1108): its own header, without the settings tabs. */
  setup?: boolean;
  /** Only tests pass this. */
  api?: LlmKeyApi;
}) {
  return (
    <SettingsScreen
      workspaceSlug={workspaceSlug}
      current="llm"
      area={setup ? "setup" : "settings"}
      showPlan={showPlan}
      showBilling={showBilling}
    >
      <div>
        <LlmAccessSection
          product={product}
          workspaceSlug={workspaceSlug}
          canManage={canManage}
          keyStatuses={keyStatuses}
          {...(catalog === undefined ? {} : { catalog })}
          summary={summary}
          {...(keyChoice === undefined ? {} : { keyChoice })}
          {...(api === undefined ? {} : { api })}
        />
      </div>
      {canManage ? (
        <div className="flex max-w-[64rem] flex-col gap-6 empty:hidden">
          <RemoveWorkspaceKeys
            workspaceSlug={workspaceSlug}
            keys={removableKeys}
            instanceAccess={instanceAccess}
            {...(api === undefined ? {} : { api })}
          />
        </div>
      ) : null}
    </SettingsScreen>
  );
}
