// SPDX-License-Identifier: LicenseRef-Proprietary

// The catalog price of the model of a turn (#844, used by the workflow engine), for a step whose cost the runner did not report: the price table of the provider
// adapter (`src/llm/providers/`), reached through the catalog entry of a turn on the operator's key, or through the provider named by
// a turn on the workspace's own key. A model the table does not know has no price; the step is then charged at its cap.
import type { ModelChoice } from "../db/implementer-model-choice.ts";

/** USD per million tokens. */
export type TurnPrice = { inputPerMillion: number; outputPerMillion: number };

export function createTurnPricer(deps: {
  catalog: {
    get(id: string): Promise<{ provider: string; modelId: string } | undefined>;
  };
  providers: {
    find(raw: unknown):
      | {
          priceOf(
            model: string,
          ): { inputPerMillion: number; outputPerMillion: number } | null;
        }
      | undefined;
  };
}): (choice: ModelChoice) => Promise<TurnPrice | undefined> {
  return async (choice) => {
    const model =
      "entryId" in choice
        ? await deps.catalog
            .get(choice.entryId)
            .then((entry) =>
              entry === undefined
                ? undefined
                : { provider: entry.provider, model: entry.modelId },
            )
        : choice;
    if (model === undefined) return undefined;
    const price = deps.providers.find(model.provider)?.priceOf(model.model);
    return price === null || price === undefined
      ? undefined
      : {
          inputPerMillion: price.inputPerMillion,
          outputPerMillion: price.outputPerMillion,
        };
  };
}
