// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// One run of a workflow for a member (#873): the status (a failure told in words, never as its code), the budget and what was spent
// with where the cost figures come from, and the steps with their status, failure, duration and result. An agent step links to its
// Implementer run, where the live view shows what the agent does. While the run runs the browser asks for newer data; once it has
// ended it stops. Everything that came from outside (the values an agent returned, what an action got from GitHub) is rendered as
// text, and a link is made only to an address of the run's own repository on github.com (`github-link.ts`).
import Link from "next/link";
import { useId, useMemo, type ReactNode } from "react";
import { DescriptionList } from "../components/description-list.tsx";
import { InfoHint } from "../components/info-hint.tsx";
import { StatusRegion } from "../components/status-region.tsx";
import { Alert } from "../components/ui/alert.tsx";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../components/ui/card.tsx";
import { Progress } from "../components/ui/progress.tsx";
import { useProductIdentity } from "../product-identity/context.tsx";
import { formatDuration } from "../runs/run-duration.ts";
import { formatUtc } from "../ui/format-time.ts";
import { useLiveSnapshot } from "../ui/use-live-snapshot.ts";
import { workspacePath } from "../workspaces/paths.ts";
import type { RunView, StepView } from "../workflow-runs/service.ts";
import {
  browserWorkflowRunsApi,
  WORKFLOW_RUN_POLL_MS,
  type WorkflowRunsApi,
} from "./api.ts";
import {
  COST_BASIS_COPY,
  COST_COPY,
  CONTROL_COPY,
  COST_NOT_RUN_COPY,
  describeRunFailure,
  describeRunPollFailure,
  describeStepFailure,
  PAGE_COPY,
  STEP_KIND_COPY,
  TRIGGER_COPY,
} from "./messages.ts";
import { StepStatusBadge, WorkflowRunStatusBadge } from "./status-badge.tsx";
import {
  actionResultOf,
  agentResultOf,
  controlResultOf,
  costBasesOf,
  formatUsd,
  neverRan,
  readableMessageOf,
  repositoryOfRun,
  spentShare,
  stepDurationMs,
} from "./view.ts";

export type RunSnapshot = { run: RunView };

/** A titled card: the heading is the name of the region. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <Card role="region" aria-labelledby={id}>
      <CardHeader>
        <CardTitle>
          <h2
            id={id}
            className="text-lg leading-7 font-semibold tracking-normal"
          >
            {title}
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">{children}</CardContent>
    </Card>
  );
}

function Time({ iso }: { iso: string | null }) {
  if (iso === null)
    return (
      <span className="text-muted-foreground">{PAGE_COPY.stepNotStarted}</span>
    );
  return <time dateTime={iso}>{formatUtc(iso)}</time>;
}

/** A link to GitHub that the view checked, or the text alone. The text is from outside and stays text. */
function GithubLink({
  href,
  children,
}: {
  href: string | undefined;
  children: ReactNode;
}) {
  return href === undefined ? (
    <span className="break-all">{children}</span>
  ) : (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="break-all"
    >
      {children}
    </a>
  );
}

function CostBasisText({
  basis,
}: {
  basis: NonNullable<StepView["costBasis"]>;
}) {
  const copy = COST_BASIS_COPY[basis];
  return (
    <span className="inline-flex items-center gap-1">
      <span data-slot="cost-basis" data-basis={basis}>
        {copy.label}
      </span>
      <InfoHint label={`About the cost basis ${copy.label}`}>
        {copy.explanation}
      </InfoHint>
    </span>
  );
}

/** The cost of a step that no runner took: it never ran, so the basis of a figure does not apply. */
function NotRunText() {
  return (
    <span className="inline-flex items-center gap-1">
      <span data-slot="cost-basis" data-basis="not_run">
        {COST_NOT_RUN_COPY.label}
      </span>
      <InfoHint
        label={`About the cost of a step that ${COST_NOT_RUN_COPY.label}`}
      >
        {COST_NOT_RUN_COPY.explanation}
      </InfoHint>
    </span>
  );
}

function Budget({ run }: { run: RunView }) {
  const bases = costBasesOf(run.steps);
  return (
    <Section title={COST_COPY.budget}>
      <p data-slot="run-spent" className="text-sm">
        <span className="font-semibold">{formatUsd(run.spentUsd)}</span>{" "}
        {COST_COPY.of}{" "}
        <span className="font-semibold">{formatUsd(run.budgetUsd)}</span>{" "}
        {COST_COPY.spentOfBudget}
      </p>
      <Progress
        value={Math.round(spentShare(run) * 100)}
        aria-label={COST_COPY.spentOfBudget}
      />
      {bases.length === 0 ? null : (
        <div className="flex flex-col gap-2" data-slot="run-cost-bases">
          <h3 className="text-sm font-semibold">{COST_COPY.basisHeading}</h3>
          <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
            {bases.map((basis) => (
              <li key={basis}>
                <span className="text-foreground">
                  {COST_BASIS_COPY[basis].label}
                </span>
                : {COST_BASIS_COPY[basis].explanation}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

/** What an action step returned: the link, the number, whether it existed before. */
function ActionOutcome({
  step,
  repository,
}: {
  step: StepView;
  repository: string | undefined;
}) {
  const result = actionResultOf(step, repository);
  if (result === undefined) return null;
  return (
    <div data-slot="step-action-result" className="flex flex-col gap-1 text-sm">
      {result.url === undefined && result.urlText === undefined ? null : (
        <p>
          <GithubLink href={result.url}>
            {result.url === undefined
              ? (result.urlText ?? "")
              : PAGE_COPY.stepLink}
          </GithubLink>
        </p>
      )}
      {result.number === undefined ? null : (
        <p>
          {PAGE_COPY.stepNumber}: <span>{result.number}</span>
        </p>
      )}
      {result.existing === undefined ? null : (
        <p className="text-muted-foreground">
          {result.existing ? PAGE_COPY.stepExisting : PAGE_COPY.stepCreated}
        </p>
      )}
    </div>
  );
}

/** What an agent step returned: the branch, and the rest of its output as JSON text in a collapsed block. */
function AgentOutcome({
  step,
  repository,
}: {
  step: StepView;
  repository: string | undefined;
}) {
  const result = agentResultOf(step, repository);
  if (result === undefined) return null;
  return (
    <div data-slot="step-agent-result" className="flex flex-col gap-2 text-sm">
      {result.branch === undefined ? null : (
        <p>
          {PAGE_COPY.stepBranch}:{" "}
          <GithubLink href={result.branchUrl}>{result.branch}</GithubLink>
        </p>
      )}
      {result.fields === undefined ? null : (
        <details>
          <summary className="cursor-pointer text-muted-foreground">
            {PAGE_COPY.stepResultJson}
          </summary>
          <pre className="mt-2 max-h-96 overflow-auto font-mono text-xs break-words whitespace-pre-wrap">
            {JSON.stringify(result.fields, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

/** What a condition or a loop decided, in a sentence, and for a loop how many rounds it ran. */
function ControlOutcome({ step }: { step: StepView }) {
  const result = controlResultOf(step);
  if (result === undefined) return null;
  return (
    <div
      data-slot="step-control-result"
      className="flex flex-col gap-1 text-sm"
    >
      {result.taken === undefined ? null : (
        <p>{CONTROL_COPY.taken[result.taken]}</p>
      )}
      {result.exit === undefined ? null : (
        <p>{CONTROL_COPY.exit[result.exit]}</p>
      )}
      {result.rounds === undefined ? null : (
        <p className="text-muted-foreground">
          {CONTROL_COPY.rounds}: {result.rounds}
        </p>
      )}
    </div>
  );
}

function Step({
  step,
  repeated,
  workspaceSlug,
  repository,
}: {
  step: StepView;
  /** The step ran more than once in this run (the rounds of a loop): its round is told. */
  repeated: boolean;
  workspaceSlug: string;
  repository: string | undefined;
}) {
  const duration = stepDurationMs(step);
  const failure = describeStepFailure(step.errorCode, step.errorMessage);
  const message = readableMessageOf(step.errorMessage);
  return (
    <li
      data-slot="run-step"
      data-step-id={step.id}
      data-status={step.status}
      className="flex flex-col gap-2 rounded-lg border border-border p-4"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {/* The id of a step is a name from the workflow document: text. */}
        <h3 className="min-w-0 text-base font-semibold break-words">
          {step.id}
        </h3>
        <StepStatusBadge status={step.status} />
        <span className="text-xs text-muted-foreground">
          {STEP_KIND_COPY[step.kind]}
          {repeated
            ? `, ${CONTROL_COPY.round.toLowerCase()} ${String(step.round)}`
            : ""}
          {step.profile === null
            ? ""
            : `, ${PAGE_COPY.profile.toLowerCase()} ${step.profile.name} version ${String(step.profile.version)}`}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {duration === null ? (
          <Time iso={step.startedAt} />
        ) : (
          <>
            {PAGE_COPY.stepFinished}{" "}
            <span data-slot="step-duration">{formatDuration(duration)}</span>
          </>
        )}
        {step.costUsd === null ? null : (
          <>
            {" · "}
            {COST_COPY.stepCost}{" "}
            <span data-slot="step-cost">{formatUsd(step.costUsd)}</span>
            {step.costBasis === null ? null : (
              <>
                {" ("}
                {neverRan(step) ? (
                  <NotRunText />
                ) : (
                  <CostBasisText basis={step.costBasis} />
                )}
                {")"}
              </>
            )}
          </>
        )}
      </p>
      {failure === null ? null : (
        <p data-slot="step-failure" className="text-sm text-destructive">
          {failure}
        </p>
      )}
      {/* The message of a failed step is the engine's own text or a connector's: kept as text, under the sentence, and left out when it
          carries a code (the sentence of the code says it then). */}
      {message === null ? null : (
        <p
          data-slot="step-error-message"
          className="text-xs break-words whitespace-pre-wrap text-muted-foreground"
        >
          {message}
        </p>
      )}
      {step.kind === "agent" && step.jobId !== null ? (
        <p className="text-sm">
          <Link
            href={workspacePath(
              workspaceSlug,
              `/runs/${encodeURIComponent(step.jobId)}`,
            )}
          >
            {PAGE_COPY.stepAgentRun}
          </Link>
        </p>
      ) : null}
      {step.kind === "agent" ? (
        <AgentOutcome step={step} repository={repository} />
      ) : step.kind === "action" ? (
        <ActionOutcome step={step} repository={repository} />
      ) : (
        <ControlOutcome step={step} />
      )}
    </li>
  );
}

export function WorkflowRunDetail({
  workspaceSlug,
  workflowId,
  initial,
  api: apiProp,
}: {
  /** The workspace of the page: the polling and every link stay in it. */
  workspaceSlug: string;
  workflowId: string;
  initial: RunSnapshot;
  /** Only tests pass this: a server component cannot hand functions to the client component. */
  api?: WorkflowRunsApi;
}) {
  const product = useProductIdentity();
  // One client for the life of the component: a new one every render would restart what depends on it.
  const defaultApi = useMemo(
    () => browserWorkflowRunsApi(workspaceSlug),
    [workspaceSlug],
  );
  const api = apiProp ?? defaultApi;
  const { data, failed, failureCode, stopped } = useLiveSnapshot({
    initial,
    fetchLatest: () => api.run(workflowId, initial.run.id),
    isSettled: (snapshot) => snapshot.run.status !== "running",
    activeIntervalMs: WORKFLOW_RUN_POLL_MS,
    // A run that has ended does not change any more: no more requests.
    idleIntervalMs: null,
  });
  const { run } = data;
  const repository = repositoryOfRun(run);
  const failure = describeRunFailure(run.errorCode);
  return (
    <div className="flex flex-col gap-6">
      <StatusRegion label="Updating the run">
        {failed ? describeRunPollFailure(product, failureCode, stopped) : null}
      </StatusRegion>
      {failure === null ? null : (
        <Alert variant="destructive" role="status" data-slot="run-failure">
          <span className="font-semibold">{PAGE_COPY.runWhy}: </span>
          {failure}
        </Alert>
      )}
      <Section title={PAGE_COPY.runTitle}>
        <DescriptionList
          items={[
            {
              term: "Status",
              description: <WorkflowRunStatusBadge status={run.status} hint />,
            },
            {
              term: PAGE_COPY.runTrigger,
              description: TRIGGER_COPY[run.trigger],
            },
            // A run a label started has no person who started it: who put the label on is shown, as the text it is (a login).
            ...(run.trigger === "manual"
              ? []
              : [{ term: PAGE_COPY.runActor, description: run.actorLogin }]),
            {
              term: PAGE_COPY.runStartedAt,
              description: <Time iso={run.createdAt} />,
            },
            ...(run.finishedAt === null
              ? []
              : [
                  {
                    term: PAGE_COPY.runFinishedAt,
                    description: <Time iso={run.finishedAt} />,
                  },
                ]),
            {
              term: PAGE_COPY.runWorkflowVersion,
              description: run.workflowVersion,
            },
            ...(repository === undefined
              ? []
              : [
                  {
                    term: PAGE_COPY.runRepository,
                    // The name comes from the input of the run: text.
                    description: repository,
                  },
                ]),
            { term: PAGE_COPY.runBaseBranch, description: run.baseBranch },
          ]}
        />
      </Section>
      <Budget run={run} />
      <Section title={PAGE_COPY.stepsHeading}>
        {run.steps.length === 0 ? (
          <p className="text-sm text-muted-foreground">{PAGE_COPY.stepsNone}</p>
        ) : (
          <ol className="flex flex-col gap-3">
            {run.steps.map((step) => (
              <Step
                key={step.position}
                step={step}
                repeated={run.steps.some(
                  (other) => other.id === step.id && other.round !== step.round,
                )}
                workspaceSlug={workspaceSlug}
                repository={repository}
              />
            ))}
          </ol>
        )}
      </Section>
    </div>
  );
}
