// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The details of the step selected in the flow (#1079): its state, times, cost and where the cost comes from, the profile, why it failed
// in words, the question it asked with the way to answer while it waits, what it returned (what the agent said first, then the fields),
// every round of it, and for an agent step a link to its run in the Implementer with the MCP calls of that job. A node the run did not
// reach has no rows: the panel says what the state means and what the lane says about the node. Everything from outside (the agent's
// text, a connector's answer, names from the lane document) is rendered as text.
import Link from "next/link";
import { DescriptionList } from "../components/description-list.tsx";
import { SheetTitle } from "../components/ui/sheet.tsx";
import { formatDuration } from "../runs/run-duration.ts";
import { RunMcpCalls } from "../runs/ui/run-mcp-calls.tsx";
import type { RunsApi } from "../runs/ui/api.ts";
import { workspacePath } from "../workspaces/paths.ts";
import type { RunView, StepView } from "../workflow-runs/service.ts";
import type { WorkflowRunsApi } from "./api.ts";
import { AskBlock } from "./ask-block.tsx";
import { describeNode } from "./flow/describe.ts";
import type { Doc, NodeKind } from "./flow/document.ts";
import { CONTROL_COPY, describeStepFailure, FLOW_COPY } from "./messages.ts";
import { nodeNameOf, StateMark } from "./run-flow.tsx";
import type { NodeRun } from "./run-node-states.ts";
import { StepStatusBadge } from "./status-badge.tsx";
import { StepCostText, StepOutcome, Time } from "./step-parts.tsx";
import { readableMessageOf, stepDurationMs } from "./view.ts";

/** Why a step failed in words, and the engine's own message under it when it carries no code. */
function Failure({ step }: { step: StepView }) {
  const failure = describeStepFailure(step.errorCode, step.errorMessage);
  const message = readableMessageOf(step.errorMessage);
  return (
    <>
      {failure === null ? null : (
        <p data-slot="step-failure" className="text-sm text-destructive">
          {failure}
        </p>
      )}
      {message === null ? null : (
        <p
          data-slot="step-error-message"
          className="text-xs break-words whitespace-pre-wrap text-muted-foreground"
        >
          {message}
        </p>
      )}
    </>
  );
}

function Duration({ step }: { step: StepView }) {
  const duration = stepDurationMs(step);
  return duration === null ? (
    <Time iso={step.startedAt} />
  ) : (
    <span data-slot="step-duration">{formatDuration(duration)}</span>
  );
}

/** Every round the step ran, newest first; the earlier ones keep what they returned in a block that opens on request. */
function Rounds({
  rows,
  repository,
}: {
  rows: readonly StepView[];
  repository: string | undefined;
}) {
  const newestFirst = [...rows].reverse();
  return (
    <section
      data-slot="step-rounds"
      aria-label={FLOW_COPY.roundsHeading}
      className="flex flex-col gap-2"
    >
      <h4 className="text-sm font-semibold">{FLOW_COPY.roundsHeading}</h4>
      <ol className="flex flex-col gap-2">
        {newestFirst.map((row, index) => (
          <li
            key={row.position}
            data-slot="step-round"
            data-round={row.round}
            className="flex flex-col gap-1 rounded-lg border border-border p-2 text-sm"
          >
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">
                {CONTROL_COPY.round} {row.round}
              </span>
              <StepStatusBadge status={row.status} />
              <span className="text-xs text-muted-foreground">
                <Duration step={row} />
                {row.costUsd === null ? null : (
                  <>
                    {" · "}
                    <StepCostText step={row} costUsd={row.costUsd} />
                  </>
                )}
              </span>
            </span>
            {index === 0 ? null : (
              <details>
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  {FLOW_COPY.resultHeading}
                </summary>
                <div className="mt-2 flex flex-col gap-2">
                  <Failure step={row} />
                  <StepOutcome step={row} repository={repository} />
                </div>
              </details>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

export function StepPanel({
  stepId,
  kind,
  node,
  found,
  run,
  workspaceSlug,
  workflowId,
  repository,
  api,
  runsApi,
  headingId,
  inSheet,
}: {
  stepId: string;
  kind: NodeKind;
  node: Doc;
  found: NodeRun | undefined;
  run: RunView;
  workspaceSlug: string;
  workflowId: string;
  repository: string | undefined;
  api: WorkflowRunsApi;
  runsApi: RunsApi;
  /** The id of the heading: the panel is named by it. */
  headingId: string;
  /** The panel is the content of a sheet: its heading is the title of the dialog. */
  inSheet: boolean;
}) {
  const state = found?.state ?? "notReached";
  const latest = found?.latest;
  const described = describeNode(node, kind);
  return (
    <div
      data-slot="step-panel"
      data-step={stepId}
      className="flex flex-col gap-4"
    >
      <div className="flex flex-col gap-2">
        {inSheet ? (
          <SheetTitle id={headingId} className="text-lg break-words">
            {nodeNameOf(node, kind)}
          </SheetTitle>
        ) : (
          <h3 id={headingId} className="text-lg font-semibold break-words">
            {nodeNameOf(node, kind)}
          </h3>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <StateMark kind={kind} state={state} />
          <span className="text-xs text-muted-foreground">
            {FLOW_COPY.kindName[kind]}
            {kind === "trigger" ? "" : ` · ${stepId}`}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          {FLOW_COPY.stateNote[state]}
          {latest === undefined && found?.round !== undefined
            ? ` ${FLOW_COPY.round(found.round, found.maxRounds)}.`
            : ""}
        </p>
        {/* What the lane says about the node: text of whoever wrote the lane. */}
        <p
          data-slot="step-definition"
          className="text-xs break-words text-muted-foreground"
        >
          {FLOW_COPY.definition}: {described.summary}
        </p>
      </div>
      {latest === undefined ? null : (
        <>
          <DescriptionList
            items={[
              {
                term: FLOW_COPY.status,
                description: <StepStatusBadge status={latest.status} />,
              },
              {
                term: FLOW_COPY.startedAt,
                description: <Time iso={latest.startedAt} />,
              },
              ...(latest.finishedAt === null
                ? []
                : [
                    {
                      term: FLOW_COPY.finishedAt,
                      description: <Time iso={latest.finishedAt} />,
                    },
                  ]),
              ...(stepDurationMs(latest) === null
                ? []
                : [
                    {
                      term: FLOW_COPY.duration,
                      description: <Duration step={latest} />,
                    },
                  ]),
              ...(latest.costUsd === null
                ? []
                : [
                    {
                      term: FLOW_COPY.cost,
                      description: (
                        <StepCostText step={latest} costUsd={latest.costUsd} />
                      ),
                    },
                  ]),
              ...(latest.profile === null
                ? []
                : [
                    {
                      term: FLOW_COPY.profile,
                      // The name comes from the lane: text.
                      description: `${latest.profile.name} version ${String(latest.profile.version)}`,
                    },
                  ]),
              ...(found?.round === undefined
                ? []
                : [
                    {
                      term: FLOW_COPY.rounds,
                      description: FLOW_COPY.round(
                        found.round,
                        found.maxRounds,
                      ),
                    },
                  ]),
            ]}
          />
          <Failure step={latest} />
          {/* A step may ask again after an answer: each question is its own block, so what the last one sent does not stay on the next. */}
          <AskBlock
            key={`${latest.id}-${String(latest.ask?.n ?? 0)}`}
            step={latest}
            workflowId={workflowId}
            runId={run.id}
            api={api}
          />
          <section
            data-slot="step-result"
            aria-label={FLOW_COPY.resultHeading}
            className="flex flex-col gap-2"
          >
            <h4 className="text-sm font-semibold">{FLOW_COPY.resultHeading}</h4>
            <StepOutcome step={latest} repository={repository} />
            {latest.output === null || latest.output === undefined ? (
              <p className="text-sm text-muted-foreground">
                {FLOW_COPY.nothingYet}
              </p>
            ) : null}
          </section>
          {latest.kind === "agent" && latest.jobId !== null ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm">
                <Link
                  href={workspacePath(
                    workspaceSlug,
                    `/runs/${encodeURIComponent(latest.jobId)}`,
                  )}
                >
                  {FLOW_COPY.agentRun}
                </Link>
              </p>
              <RunMcpCalls
                key={latest.jobId}
                api={runsApi}
                runId={latest.jobId}
                tick={run.updatedAt}
              />
            </div>
          ) : null}
          {(found?.rows.length ?? 0) > 1 && found !== undefined ? (
            <Rounds rows={found.rows} repository={repository} />
          ) : null}
        </>
      )}
    </div>
  );
}
