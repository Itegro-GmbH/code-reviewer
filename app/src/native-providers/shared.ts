// SPDX-License-Identifier: LicenseRef-Proprietary

// The catalog of providers and models a workspace on its own key chooses from, on the running server's database (#555).
import "server-only";
import { createModelsDevRepository } from "../db/repositories/models-dev-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { llmProviderDescriptors } from "../llm/providers/index.ts";
import {
  createNativeCatalogReader,
  type NativeCatalogReader,
} from "./catalog.ts";

export function getNativeCatalog(): NativeCatalogReader {
  return createNativeCatalogReader({
    models: createModelsDevRepository(getDatabase()),
    // The registry's two providers keep their own path until #556: they are never offered as catalog providers.
    legacyProviders: llmProviderDescriptors.ids,
  });
}

/**
 * The catalog of the Implementer's picker and check: the same catalog, but no provider is legacy, because its agent is OpenCode and
 * has no legacy wire. The registry's two providers are offered with the models.dev models and the address the registry pins for them.
 */
export function getImplementerCatalog(): NativeCatalogReader {
  return createNativeCatalogReader({
    models: createModelsDevRepository(getDatabase()),
    legacyProviders: [],
  });
}
