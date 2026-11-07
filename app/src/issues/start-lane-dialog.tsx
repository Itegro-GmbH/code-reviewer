// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The start dialog (#925, prototype board "12 Start a lane on a task"): it asks one question, "Which lane?", among the lanes of the project
// that a person can start from an issue by hand, says what the lane does and what limits it runs under, and starts it through the start
// route of the lane with the issue as its ticket. Nothing about a machine, a profile or a model is asked: the profile of a step carries the
// harness, the model, the key and the runner. The same ticket is the same request (one `clientRequestId` for the life of the dialog's
// open state), so a retry after a lost answer starts one run.
import { useRouter } from "next/navigation";
import { useId, useMemo, useRef, useState } from "react";
import { Button } from "../components/button.tsx";
import { StatusRegion } from "../components/status-region.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.tsx";
import { Label } from "../components/ui/label.tsx";
import { RadioGroup, RadioGroupItem } from "../components/ui/radio-group.tsx";
import { useProductIdentity } from "../product-identity/context.tsx";
import { workspacePath } from "../workspaces/paths.ts";
import { formatTicketRef } from "../workflows/ticket-ref.ts";
import {
  browserWorkflowRunsApi,
  type WorkflowRunsApi,
} from "../workflow-pages/api.ts";
import { describeStartFailure } from "../workflow-pages/messages.ts";
import { START_LANE_COPY } from "./messages.ts";
import type { StartLane } from "./start-lanes.ts";

function newClientRequestId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function StartLaneDialog({
  workspaceSlug,
  repo,
  issueNumber,
  lanes,
  onOpenChange,
  api: apiProp,
}: {
  workspaceSlug: string;
  /** `owner/name` of the project's repository. */
  repo: string;
  /** The issue to start on; the dialog is open while it is set. */
  issueNumber: number | null;
  lanes: readonly StartLane[];
  onOpenChange: (open: boolean) => void;
  /** Only tests pass this. */
  api?: WorkflowRunsApi;
}) {
  const product = useProductIdentity();
  const router = useRouter();
  const defaultApi = useMemo(
    () => browserWorkflowRunsApi(workspaceSlug),
    [workspaceSlug],
  );
  const api = apiProp ?? defaultApi;
  const groupId = useId();
  const [picked, setPicked] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const sending = useRef(false);
  /** One id per lane and issue: the same start is the same request. */
  const requestIds = useRef(new Map<string, string>());

  const lane =
    lanes.find((entry) => entry.workflowId === picked) ?? lanes[0] ?? undefined;

  async function start() {
    if (lane === undefined || issueNumber === null || sending.current) return;
    sending.current = true;
    setPending(true);
    setProblem(null);
    const ticket = formatTicketRef({
      provider: "github",
      repo,
      number: issueNumber,
    });
    const key = `${lane.workflowId}:${ticket}`;
    const clientRequestId = requestIds.current.get(key) ?? newClientRequestId();
    requestIds.current.set(key, clientRequestId);
    const result = await api.start(lane.workflowId, {
      ...(lane.trigger === undefined ? {} : { trigger: lane.trigger }),
      input: { [lane.ticketField]: ticket },
      clientRequestId,
    });
    sending.current = false;
    setPending(false);
    if (!result.ok) {
      setProblem(describeStartFailure(product, result));
      return;
    }
    requestIds.current.clear();
    onOpenChange(false);
    router.push(
      workspacePath(
        workspaceSlug,
        `/workflows/${encodeURIComponent(lane.workflowId)}/runs/${encodeURIComponent(result.data.run.id)}`,
      ),
    );
  }

  return (
    <Dialog
      open={issueNumber !== null}
      onOpenChange={(open) => {
        if (pending) return;
        if (!open) setProblem(null);
        onOpenChange(open);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{START_LANE_COPY.title(issueNumber ?? 0)}</DialogTitle>
          <DialogDescription>{START_LANE_COPY.description}</DialogDescription>
        </DialogHeader>
        {lanes.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {START_LANE_COPY.none}
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
              <legend className="mb-1 text-sm font-semibold">
                {START_LANE_COPY.lane}
              </legend>
              <RadioGroup
                value={lane?.workflowId ?? ""}
                onValueChange={setPicked}
                aria-label={START_LANE_COPY.lane}
              >
                {lanes.map((entry, index) => (
                  <div
                    key={entry.workflowId}
                    className="flex items-center gap-2"
                  >
                    <RadioGroupItem
                      id={`${groupId}-${String(index)}`}
                      value={entry.workflowId}
                    />
                    <Label htmlFor={`${groupId}-${String(index)}`}>
                      {entry.name}
                    </Label>
                  </div>
                ))}
              </RadioGroup>
            </fieldset>
            {lane === undefined ? null : <LaneFacts lane={lane} />}
          </div>
        )}
        <StatusRegion label="Starting" className="text-destructive">
          {problem ?? ""}
        </StatusRegion>
        <DialogFooter>
          <Button
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {START_LANE_COPY.cancel}
          </Button>
          <Button
            onClick={() => void start()}
            disabled={lane === undefined}
            loading={pending}
            loadingLabel={START_LANE_COPY.starting}
          >
            {START_LANE_COPY.start}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What the chosen lane does and the limits it runs under. All of it is the lane's own text, shown as text. */
function LaneFacts({ lane }: { lane: StartLane }) {
  return (
    <dl className="m-0 flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 text-sm">
      {lane.description === "" ? null : (
        <div className="flex flex-col gap-1">
          <dt className="text-xs font-semibold text-muted-foreground">
            {START_LANE_COPY.does}
          </dt>
          <dd className="m-0 break-words">{lane.description}</dd>
        </div>
      )}
      {lane.firstSteps.length === 0 ? null : (
        <div className="flex flex-col gap-1">
          <dt className="text-xs font-semibold text-muted-foreground">
            {START_LANE_COPY.firstSteps}
          </dt>
          <dd className="m-0">
            <ol className="m-0 flex list-decimal flex-col gap-0.5 pl-5">
              {lane.firstSteps.map((step, index) => (
                <li key={`${String(index)}-${step}`} className="break-words">
                  {step}
                </li>
              ))}
            </ol>
          </dd>
        </div>
      )}
      <div className="flex flex-col gap-1">
        <dt className="text-xs font-semibold text-muted-foreground">
          {START_LANE_COPY.limits}
        </dt>
        <dd className="m-0">
          {START_LANE_COPY.budget(lane.budgetUsd)} ·{" "}
          {START_LANE_COPY.turn(lane.turnTimeLimitMinutes)}
        </dd>
      </div>
    </dl>
  );
}
