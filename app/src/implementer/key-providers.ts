// SPDX-License-Identifier: LicenseRef-Proprietary

// The providers a workspace holds a readable key for, as the Implementer's picker and check need them: the registry's two providers
// keep their key in a slot of their own, the catalog providers in a slot per slug (`native-providers/lookup.ts`).
// The task is native for all of them (its agent is OpenCode), so the claim loads the key of the same provider by the same slot.
import type { WorkspaceLlmKeyService } from "../llm/workspace-key.ts";

export async function configuredKeyProviders(
  keys: Pick<WorkspaceLlmKeyService, "statusAll" | "nativeStatuses">,
): Promise<ReadonlySet<string>> {
  const [registry, catalog] = await Promise.all([
    keys.statusAll(),
    keys.nativeStatuses(),
  ]);
  return new Set(
    [...registry, ...catalog]
      .filter(({ status }) => status.state === "configured")
      .map(({ provider }) => provider),
  );
}
