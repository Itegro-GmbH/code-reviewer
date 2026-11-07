// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// "Resync" on the Setup tab (#937): the full sync of the ticket mirror of the project's repository. One call reads for about twenty seconds
// and answers 202 while more is left, so the button asks again until the answer is 200 and shows how far it is; what was read stays
// whatever happens, so an error or the limit of calls ends with "press Resync to go on". The hint above it tells when the tickets may be
// out of date (`sync-staleness.ts`). The page refreshes afterwards so the hint follows the new state.
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/ssr";
import { Button } from "../../components/button.tsx";
import { Alert } from "../../components/ui/alert.tsx";
import { StatusRegion } from "../../components/status-region.tsx";
import { useProductIdentity } from "../../product-identity/context.tsx";
import { browserSetupApi, type SetupApi } from "./setup-api.ts";
import { describeSetupFailure, RESYNC_COPY } from "./setup-messages.ts";
import type { SyncStaleness } from "./sync-staleness.ts";

/** The most calls one press of the button makes (about ten minutes); then it stops and says to press again. */
export const RESYNC_MAX_CALLS = 30;

type Outcome =
  | { kind: "running"; call: number }
  | { kind: "done"; text: string[] }
  | { kind: "stopped"; text: string; written: number };

export function ResyncTickets({
  workspaceSlug,
  repositoryId,
  staleness,
  api: apiProp,
}: {
  workspaceSlug: string;
  repositoryId: string;
  /** The hint the page worked out from the sync state of the tickets, or null for none. */
  staleness: SyncStaleness | null;
  /** Only tests pass this. */
  api?: SetupApi;
}) {
  const product = useProductIdentity();
  const router = useRouter();
  const defaultApi = useMemo(
    () => browserSetupApi(workspaceSlug),
    [workspaceSlug],
  );
  const api = apiProp ?? defaultApi;
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const running = outcome?.kind === "running";

  async function run() {
    let written = 0;
    for (let call = 1; call <= RESYNC_MAX_CALLS; call += 1) {
      setOutcome({ kind: "running", call });
      const result = await api.resync(repositoryId);
      if (!result.ok) {
        setOutcome({
          kind: "stopped",
          text: describeSetupFailure(product, result.code),
          written,
        });
        router.refresh();
        return;
      }
      written += result.data.written;
      if (result.data.status === "done") {
        setOutcome({
          kind: "done",
          text: [
            RESYNC_COPY.done(written, result.data.removed),
            ...(result.data.skipped > 0
              ? [RESYNC_COPY.skipped(result.data.skipped)]
              : []),
            ...(result.data.boardAvailable ? [] : [RESYNC_COPY.noBoard]),
          ],
        });
        router.refresh();
        return;
      }
    }
    setOutcome({ kind: "stopped", text: RESYNC_COPY.gaveUp, written });
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-2">
      {staleness !== null ? (
        <Alert variant="warning" role="note">
          {staleness.kind === "never"
            ? RESYNC_COPY.never
            : RESYNC_COPY.staleDays(staleness.days)}
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          disabled={running}
          onClick={() => void run()}
        >
          <ArrowClockwiseIcon aria-hidden="true" />
          {running ? RESYNC_COPY.running(outcome.call) : RESYNC_COPY.button}
        </Button>
        <StatusRegion className="min-w-0">
          {outcome?.kind === "done" ? (
            outcome.text.map((line) => <span key={line}>{line}</span>)
          ) : outcome?.kind === "stopped" ? (
            <span className="text-destructive">{outcome.text}</span>
          ) : null}
        </StatusRegion>
      </div>
      <p className="text-xs text-muted-foreground">{RESYNC_COPY.hint}</p>
    </div>
  );
}
