// SPDX-License-Identifier: LicenseRef-Proprietary

// The steps of a run of the Implementer for the Runs page (#745, live view): what the agent thought, said and did, as the runner
// reported it while the turn ran. A thin layer over the steps table of ONE workspace (`implementer-steps-repository.ts`) that
// checks what comes in from the URL and turns the rows into the views the browser may see (`steps-view.ts`).
//
// Only a run of the Implementer has steps. The id of a run of another kind, of another workspace or of nothing is the same
// answer: `undefined`, which the route turns into 404 `RUN_NOT_FOUND`, as for a run nobody has. A run of the Implementer that has
// no steps (yet, or an older one) answers an empty page.
//
// What a member may read of a run on the operator's key is decided HERE, when the rows are read, by the one rule the run detail
// uses (`RunsRepository.implementerRun`): no cost, no cache counts, and no model or provider name in any text, whatever the stored
// row holds (the runner API leaves them out when it stores, and this is the second lock: a row stored before a rule, or by a path
// that forgot it, is still safe).
import "server-only";
import type { ImplementerStepsRepository } from "../db/repositories/implementer-steps-repository.ts";
import type { RunsRepository } from "../db/repositories/runs-repository.ts";
import { maskModelInText } from "../llm/access.ts";
import { maskProvidersInText } from "../llm/provider-mask.ts";
import {
  STEPS_PAGE_LIMIT,
  toStepView,
  type StepView,
  type StepsSnapshot,
} from "./steps-view.ts";

const RUN_ID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const MAX_SEQ = 2_147_483_647;
const COUNT = /^\d{1,10}$/;

/** What a request may ask for. Absent means the default; a value that is not a whole number in range is refused. */
export type StepsQueryInput = {
  after?: string | null | undefined;
  limit?: string | null | undefined;
};

export type ParsedStepsQuery =
  { ok: true; after: number; limit: number } | { ok: false };

/**
 * `after` is the cursor of the last answer (0 for the first request); `limit` is how many parts one answer holds at most, 1 to
 * 200: a larger number is read as 200, a number that is not a whole number is refused.
 */
export function parseStepsQuery(input: StepsQueryInput): ParsedStepsQuery {
  const after = input.after ?? "0";
  const limit = input.limit ?? String(STEPS_PAGE_LIMIT);
  if (!COUNT.test(after) || !COUNT.test(limit)) return { ok: false };
  const afterSeq = Number(after);
  const count = Number(limit);
  if (afterSeq > MAX_SEQ || count < 1) return { ok: false };
  return {
    ok: true,
    after: afterSeq,
    limit: Math.min(count, STEPS_PAGE_LIMIT),
  };
}

export type RunStepsService = {
  /** The parts of the run that changed after `after`; undefined for an id that is not a run of the Implementer of this workspace. */
  list(
    id: string,
    after: number,
    limit: number,
  ): Promise<StepsSnapshot | undefined>;
};

export function createRunStepsService(deps: {
  runs: Pick<RunsRepository, "implementerRun">;
  steps: Pick<ImplementerStepsRepository, "listAfter">;
  /** Takes secrets out of a text before it is shown, once more after the runner API cleaned it. */
  redact?: (text: string) => string;
  /** The model ids of the catalog, read only for a run on the operator's key: they are masked in every text of it. */
  hiddenModels?: () => Promise<readonly string[]>;
}): RunStepsService {
  return {
    async list(id, after, limit) {
      if (!RUN_ID.test(id)) return undefined;
      const run = await deps.runs.implementerRun(id);
      if (run === undefined) return undefined;
      const { onManagedKey } = run;
      const redact = deps.redact ?? ((text: string) => text);
      const models = onManagedKey ? await (deps.hiddenModels?.() ?? []) : [];
      const clean = onManagedKey
        ? (text: string) =>
            maskProvidersInText(maskModelInText(redact(text), ...models))
        : redact;
      // One more than asked for tells whether there is more behind the answer.
      const rows = await deps.steps.listAfter(id, after, limit + 1);
      const page = rows.slice(0, limit);
      const steps: StepView[] = [];
      for (const row of page) {
        const view = toStepView(row, clean, { onManagedKey });
        if (view !== undefined) steps.push(view);
      }
      // The page is taken by `seq` (the cursor), shown by `ordinal`: the order the parts began in.
      steps.sort((a, b) => a.ordinal - b.ordinal || a.seq - b.seq);
      return {
        steps,
        cursor: page.at(-1)?.seq ?? after,
        hasMore: rows.length > limit,
      };
    },
  };
}
