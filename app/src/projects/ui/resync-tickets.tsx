// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// "Resync" on the Setup tab (#937): the full sync of the ticket mirror of the project's repository. One call reads for about twenty seconds
// and answers 202 while more is left, so the button asks again until the answer is 200 and shows how far it is; what was read stays
// whatever happens, so an error or the limit of calls ends with "press Resync to go on". The hint above it tells when the tickets may be
// out of date (`sync-staleness.ts`), or, right after the board was changed, that the tickets still show the old board's statuses: the page
// counts the changes of the board (`boardChanges`) and a Resync answers the changes that were made before it began, so a second change after
// a finished Resync brings the prompt back.
// The page refreshes afterwards so the hint follows the new state. Leaving the page aborts the call under way and ends the loop; a second
// click while the loop runs does nothing (a ref, not the rendered state, which a double click can beat).
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
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
  boardChanges = 0,
  api: apiProp,
}: {
  workspaceSlug: string;
  repositoryId: string;
  /** The hint the page worked out from the sync state of the tickets, or null for none. */
  staleness: SyncStaleness | null;
  /**
   * How many times the board was changed since the page opened: the tickets still carry the old board's statuses until a Resync that began
   * after the last change has finished. Takes the place of the staleness hint.
   */
  boardChanges?: number;
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
  // The changes of the board a finished Resync has answered, and what the last render said (the loop reads it when it begins).
  const [answered, setAnswered] = useState(0);
  const changes = useRef(boardChanges);
  useEffect(() => {
    changes.current = boardChanges;
  }, [boardChanges]);
  const prompted = boardChanges > answered;
  // The outcome of a Resync says nothing about a board that was changed after it.
  const [seenChanges, setSeenChanges] = useState(boardChanges);
  if (seenChanges !== boardChanges) {
    setSeenChanges(boardChanges);
    if (!running) setOutcome(null);
  }
  const busy = useRef(false);
  const controller = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );

  async function run() {
    if (busy.current) return;
    busy.current = true;
    const abort = new AbortController();
    controller.current = abort;
    try {
      await loop(abort.signal);
    } finally {
      busy.current = false;
      if (controller.current === abort) controller.current = null;
    }
  }

  async function loop(signal: AbortSignal) {
    let written = 0;
    const began = changes.current;
    for (let call = 1; call <= RESYNC_MAX_CALLS; call += 1) {
      if (signal.aborted) return;
      setOutcome({ kind: "running", call });
      const result = await api.resync(repositoryId, signal);
      // The page was left: nothing to show, nothing to refresh.
      if (signal.aborted) return;
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
        setAnswered(began);
        router.refresh();
        return;
      }
    }
    setOutcome({ kind: "stopped", text: RESYNC_COPY.gaveUp, written });
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-2">
      {prompted ? (
        <Alert variant="warning" role="note">
          {RESYNC_COPY.boardChanged}
        </Alert>
      ) : staleness !== null ? (
        <Alert variant="warning" role="note">
          {staleness.kind === "never"
            ? RESYNC_COPY.never
            : RESYNC_COPY.staleDays(staleness.days)}
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant={prompted ? "primary" : "secondary"}
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
            <>
              <span className="text-destructive">{outcome.text}</span>
              {outcome.written > 0 ? (
                <span>{RESYNC_COPY.kept(outcome.written)}</span>
              ) : null}
            </>
          ) : null}
        </StatusRegion>
      </div>
      <p className="text-xs text-muted-foreground">{RESYNC_COPY.hint}</p>
    </div>
  );
}
