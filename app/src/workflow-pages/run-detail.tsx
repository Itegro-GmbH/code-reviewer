// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// One run of a workflow for a member (#873, #1079): the header (the ticket, the lane and its version, the status, who started it and how,
// when, how long, what was spent of the budget with where the cost figures come from), the lane as a flow with every node coloured by where
// the run stands, and the details of the step that is selected (`?step=<id>` in the address; by default the current step, else the failed
// one, else the last). A lane that cannot be drawn falls back to the plain list of steps. While the run runs or waits for an answer the
// browser asks for newer data; once it has ended it stops. Everything that came from outside (the values an agent returned, what an
// action got from GitHub, the ticket's title) is rendered as text, and a link is made only through `github-link.ts`.
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  useId,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Button } from "../components/button.tsx";
import { DescriptionList } from "../components/description-list.tsx";
import { StatusRegion } from "../components/status-region.tsx";
import { Alert } from "../components/ui/alert.tsx";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../components/ui/card.tsx";
import { Progress } from "../components/ui/progress.tsx";
import { Sheet, SheetContent } from "../components/ui/sheet.tsx";
import { useProductIdentity } from "../product-identity/context.tsx";
import { formatDuration } from "../runs/run-duration.ts";
import { browserRunsApi, type RunsApi } from "../runs/ui/api.ts";
import { useLiveSnapshot } from "../ui/use-live-snapshot.ts";
import { workspacePath } from "../workspaces/paths.ts";
import type { RunView, StepView } from "../workflow-runs/service.ts";
import {
  browserWorkflowRunsApi,
  WORKFLOW_RUN_POLL_MS,
  type WorkflowRunsApi,
} from "./api.ts";
import { normalise, type Doc } from "./builder/document.ts";
import {
  costBasisCopy,
  COST_COPY,
  CONTROL_COPY,
  describeRunFailure,
  describeRunPollFailure,
  describeStartFailure,
  describeStepFailure,
  FLOW_COPY,
  PAGE_COPY,
  STEP_KIND_COPY,
  TRIGGER_COPY,
} from "./messages.ts";
import { AskBlock } from "./ask-block.tsx";
import { RunFlow } from "./run-flow.tsx";
import { nodeStatesOf, selectionOf } from "./run-node-states.ts";
import { StepPanel } from "./step-panel.tsx";
import { StepStatusBadge, WorkflowRunStatusBadge } from "./status-badge.tsx";
import { GithubLink, StepCost, StepOutcome, Time } from "./step-parts.tsx";
import {
  costBasesOf,
  formatUsd,
  readableMessageOf,
  repositoryOfRun,
  runDurationMs,
  spentShare,
  stepDurationMs,
  ticketOfRun,
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

/** What was spent of the budget, and where the cost figures come from: the lower part of the header. */
function Budget({ run }: { run: RunView }) {
  const bases = costBasesOf(run.steps);
  return (
    <div data-slot="run-budget" className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{COST_COPY.budget}</h3>
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
                  {costBasisCopy(basis).label}
                </span>
                : {costBasisCopy(basis).explanation}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** The ticket the run is about: its ref, its title (text) and, for an address of the run's own repository, a link. */
function Ticket({
  run,
  repository,
}: {
  run: RunView;
  repository: string | undefined;
}) {
  const ticket = ticketOfRun(run, repository);
  if (ticket === undefined) return null;
  return (
    <p
      data-slot="run-ticket"
      className="flex flex-wrap items-baseline gap-x-2 text-base"
    >
      <GithubLink href={ticket.url}>
        <span className="font-semibold">{ticket.ref}</span>
      </GithubLink>
      {ticket.title === undefined ? null : (
        <span className="min-w-0 break-words">{ticket.title}</span>
      )}
    </p>
  );
}

function Step({
  step,
  repeated,
  workspaceSlug,
  repository,
  workflowId,
  runId,
  api,
}: {
  step: StepView;
  /** The step ran more than once in this run (the rounds of a loop): its round is told. */
  repeated: boolean;
  workspaceSlug: string;
  repository: string | undefined;
  workflowId: string;
  runId: string;
  api: WorkflowRunsApi;
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
          <StepCost step={step} costUsd={step.costUsd} />
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
      {/* #920: the question the step asked, and the way to answer while it waits. */}
      {/* A step may ask again after an answer: each question is its own block, so what the last one sent does not stay on the next. */}
      <AskBlock
        key={`${step.id}-${String(step.ask?.n ?? 0)}`}
        step={step}
        workflowId={workflowId}
        runId={runId}
        api={api}
      />
      <StepOutcome step={step} repository={repository} />
    </li>
  );
}

/**
 * What a member can do with a run (#921). Discard works on any run that is not discarded yet, running, waiting or over: the run is
 * `discarded` at once and the page shows it from the answer (a run that is over is not polled any more). A run that is active can also be
 * paused after its current step and resumed. A run of before #921 that was asked to stop (`cancelRequestedAt`) says so.
 */
function RunControls({
  run,
  workflowId,
  api,
  onChanged,
}: {
  run: RunView;
  workflowId: string;
  api: WorkflowRunsApi;
  /** The run as the route answered it: shown until the page's own polling has something newer. */
  onChanged: (run: RunView) => void;
}) {
  const product = useProductIdentity();
  const [pending, setPending] = useState<"discard" | "pause" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  if (run.status === "discarded")
    return (
      <p
        data-slot="run-discarded"
        className="text-sm text-muted-foreground"
        role="status"
      >
        {PAGE_COPY.discardedNote}
      </p>
    );
  const active = run.status === "running" || run.status === "waiting";
  const paused = run.pauseRequestedAt !== null;
  async function act(
    kind: "discard" | "pause",
    call: () => ReturnType<WorkflowRunsApi["discard"]>,
  ) {
    setPending(kind);
    setProblem(null);
    const result = await call();
    setPending(null);
    if (result.ok) onChanged(result.data.run);
    else setProblem(describeStartFailure(product, result));
  }
  return (
    <div className="flex flex-col gap-2">
      {active && run.cancelRequestedAt !== null ? (
        <p
          data-slot="run-cancel-requested"
          className="text-sm text-muted-foreground"
          role="status"
        >
          {PAGE_COPY.cancelRequested}
        </p>
      ) : null}
      {active && paused ? (
        <p
          data-slot="run-paused"
          className="text-sm text-muted-foreground"
          role="status"
        >
          {PAGE_COPY.pausedNote}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {active ? (
          <Button
            type="button"
            variant="secondary"
            loading={pending === "pause"}
            loadingLabel={paused ? PAGE_COPY.resuming : PAGE_COPY.pausing}
            disabled={pending !== null}
            onClick={() =>
              void act("pause", () =>
                paused
                  ? api.resume(workflowId, run.id)
                  : api.pause(workflowId, run.id),
              )
            }
          >
            {paused ? PAGE_COPY.resumeRun : PAGE_COPY.pauseRun}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="secondary"
          loading={pending === "discard"}
          loadingLabel={PAGE_COPY.discarding}
          disabled={pending !== null}
          onClick={() =>
            void act("discard", () => api.discard(workflowId, run.id))
          }
        >
          {PAGE_COPY.discardRun}
        </Button>
        <span className="text-sm text-muted-foreground">
          {PAGE_COPY.discardHint}
        </span>
      </div>
      {problem === null ? null : (
        <p
          data-slot="run-cancel-failure"
          role="alert"
          className="text-sm text-destructive"
        >
          {problem}
        </p>
      )}
    </div>
  );
}

/** The viewport is too narrow for the panel beside the flow: it opens as a sheet then. */
const NARROW_QUERY = "(max-width: 1023px)";

function useIsNarrow(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const list = window.matchMedia(NARROW_QUERY);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () =>
      typeof window.matchMedia === "function" &&
      window.matchMedia(NARROW_QUERY).matches,
    () => false,
  );
}

/** Puts the selected step in the address (`?step=`) without a new entry in the history and without a request. */
function writeStepToAddress(stepId: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("step", stepId);
  window.history.replaceState(
    null,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}

/** The lane as a flow with the panel of the selected step beside it (a sheet on a narrow screen). */
function RunFlowView({
  doc,
  run,
  states,
  workspaceSlug,
  workflowId,
  repository,
  api,
  runsApi,
}: {
  doc: Doc;
  run: RunView;
  states: NonNullable<ReturnType<typeof nodeStatesOf>>;
  workspaceSlug: string;
  workflowId: string;
  repository: string | undefined;
  api: WorkflowRunsApi;
  runsApi: RunsApi;
}) {
  const headingId = useId();
  const narrow = useIsNarrow();
  // What the address names is only looked up in the lane (`selectionOf`), never used as it is. A person's own choice stays; until there is
  // one the selection follows the run (the current step moves on while it runs).
  const fromAddress = useSearchParams()?.get("step") ?? null;
  const known = (stepId: string | null): stepId is string =>
    stepId !== null && states.byStepId.has(stepId);
  const [chosen, setChosen] = useState<string | null>(fromAddress);
  // The step the sheet is open for (a narrow screen only): a link to a step of the lane opens it, as a click does.
  const [sheetFor, setSheetFor] = useState<string | null>(
    known(fromAddress) ? fromAddress : null,
  );
  // The address can change under the page (a link inside the app to another step of the same run): the selection follows it. A click
  // writes its own step to the address, which is no change.
  const [seen, setSeen] = useState(fromAddress);
  if (seen !== fromAddress) {
    setSeen(fromAddress);
    if (fromAddress !== null) {
      setChosen(fromAddress);
      if (known(fromAddress)) setSheetFor(fromAddress);
    }
  }
  const selected = selectionOf(states, chosen);
  const found =
    selected === undefined ? undefined : states.byStepId.get(selected);
  function select(stepId: string): void {
    setChosen(stepId);
    setSheetFor(stepId);
    writeStepToAddress(stepId);
  }
  // A closed sheet has no trigger that Radix could hand the focus back to: the node that opened it gets it, so that a keyboard or screen
  // reader user goes on where they were in the flow.
  function focusNodeOf(event: Event): void {
    event.preventDefault();
    if (selected === undefined) return;
    const node = [
      ...document.querySelectorAll<HTMLElement>("[data-node-step]"),
    ].find((each) => each.getAttribute("data-node-step") === selected);
    node?.focus();
  }
  // A step run the lane has no node for (the lane of this version does not name it) has no place in the flow: it is listed under it, so
  // that nothing a run did, and no question it asks, is out of reach.
  const apart = run.steps.filter((step) => !states.byStepId.has(step.id));
  // The panel is named by its heading; a lane without a node has no heading, and the region is named by a label instead.
  const labelOf =
    found === undefined
      ? { "aria-label": FLOW_COPY.panelLabel }
      : { "aria-labelledby": headingId };
  const panel =
    found === undefined ? (
      <p className="text-sm text-muted-foreground">{FLOW_COPY.panelHint}</p>
    ) : (
      <StepPanel
        key={found.stepId}
        stepId={found.stepId}
        kind={found.kind}
        node={found.node}
        found={found}
        run={run}
        workspaceSlug={workspaceSlug}
        workflowId={workflowId}
        repository={repository}
        api={api}
        runsApi={runsApi}
        headingId={headingId}
        inSheet={narrow}
      />
    );
  return (
    <>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_26rem]">
        <Section title={FLOW_COPY.flowHeading}>
          <RunFlow
            doc={doc}
            states={states}
            selected={selected}
            onSelect={select}
          />
        </Section>
        {narrow ? (
          <Sheet
            open={sheetFor !== null}
            onOpenChange={(open) => {
              if (!open) setSheetFor(null);
            }}
          >
            <SheetContent
              side="right"
              className="w-full overflow-y-auto p-4 sm:max-w-md"
              {...labelOf}
              aria-describedby={undefined}
              onCloseAutoFocus={focusNodeOf}
            >
              {panel}
            </SheetContent>
          </Sheet>
        ) : (
          <aside
            {...labelOf}
            data-slot="step-panel-region"
            className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto"
          >
            {panel}
          </aside>
        )}
      </div>
      {apart.length === 0 ? null : (
        <FlatSteps
          run={run}
          steps={apart}
          title={FLOW_COPY.otherSteps}
          workspaceSlug={workspaceSlug}
          workflowId={workflowId}
          repository={repository}
          api={api}
        />
      )}
    </>
  );
}

/** The plain list of the steps of a run: for a lane that cannot be drawn. */
function FlatSteps({
  run,
  steps,
  title,
  workspaceSlug,
  workflowId,
  repository,
  api,
}: {
  run: RunView;
  /** The steps to list: all of them, or those the lane has no node for. */
  steps: readonly StepView[];
  title: string;
  workspaceSlug: string;
  workflowId: string;
  repository: string | undefined;
  api: WorkflowRunsApi;
}) {
  return (
    <Section title={title}>
      {steps.length === 0 ? (
        <p className="text-sm text-muted-foreground">{PAGE_COPY.stepsNone}</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {steps.map((step) => (
            <Step
              key={step.position}
              step={step}
              repeated={run.steps.some(
                (other) => other.id === step.id && other.round !== step.round,
              )}
              workspaceSlug={workspaceSlug}
              repository={repository}
              workflowId={workflowId}
              runId={run.id}
              api={api}
            />
          ))}
        </ol>
      )}
    </Section>
  );
}

export function WorkflowRunDetail({
  workspaceSlug,
  workflowId,
  initial,
  laneName,
  document,
  api: apiProp,
  runsApi: runsApiProp,
}: {
  /** The workspace of the page: the polling and every link stay in it. */
  workspaceSlug: string;
  workflowId: string;
  initial: RunSnapshot;
  /** The name of the lane, for the header. */
  laneName?: string;
  /** The lane document of the version the run uses: what the flow draws. Left out or unusable, the steps are listed. */
  document?: unknown;
  /** Only tests pass this: a server component cannot hand functions to the client component. */
  api?: WorkflowRunsApi;
  /** Only tests pass this, for the same reason: the MCP calls of an agent step's job. */
  runsApi?: RunsApi;
}) {
  const product = useProductIdentity();
  // One client for the life of the component: a new one every render would restart what depends on it.
  const defaultApi = useMemo(
    () => browserWorkflowRunsApi(workspaceSlug),
    [workspaceSlug],
  );
  const api = apiProp ?? defaultApi;
  const defaultRunsApi = useMemo(
    () => browserRunsApi(workspaceSlug),
    [workspaceSlug],
  );
  const runsApi = runsApiProp ?? defaultRunsApi;
  const { data, failed, failureCode, stopped } = useLiveSnapshot({
    initial,
    fetchLatest: () => api.run(workflowId, initial.run.id),
    // A run that waits for an answer (#920) changes when somebody answers, on this page or on the ticket: it is polled like a running one.
    isSettled: (snapshot) =>
      snapshot.run.status !== "running" && snapshot.run.status !== "waiting",
    activeIntervalMs: WORKFLOW_RUN_POLL_MS,
    // A run that has ended does not change any more: no more requests.
    idleIntervalMs: null,
  });
  // What a discard, a pause or a resume answered shows at once; the page's own polling takes over when it has something newer. A run that
  // was discarded is over and not polled any more, so the answer is what the page shows from then on.
  const [changed, setChanged] = useState<RunView | null>(null);
  const run =
    changed !== null &&
    changed.id === data.run.id &&
    changed.updatedAt > data.run.updatedAt
      ? changed
      : data.run;
  const repository = repositoryOfRun(run);
  const failure = describeRunFailure(run.errorCode);
  const doc = useMemo(() => normalise(document), [document]);
  const states = useMemo(
    () => (doc === undefined ? undefined : nodeStatesOf(doc, run)),
    [doc, run],
  );
  const duration = runDurationMs(run);
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
        <Ticket run={run} repository={repository} />
        <DescriptionList
          items={[
            {
              term: "Status",
              description: <WorkflowRunStatusBadge status={run.status} hint />,
            },
            ...(laneName === undefined
              ? []
              : [{ term: FLOW_COPY.lane, description: laneName }]),
            {
              term: PAGE_COPY.runWorkflowVersion,
              description: run.workflowVersion,
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
            ...(duration === null
              ? []
              : [
                  {
                    term: FLOW_COPY.duration_run,
                    description: (
                      <span data-slot="run-duration">
                        {formatDuration(duration)}
                      </span>
                    ),
                  },
                ]),
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
        <Budget run={run} />
        <RunControls
          run={run}
          workflowId={workflowId}
          api={api}
          onChanged={setChanged}
        />
      </Section>
      {doc === undefined || states === undefined ? (
        <FlatSteps
          run={run}
          steps={run.steps}
          title={PAGE_COPY.stepsHeading}
          workspaceSlug={workspaceSlug}
          workflowId={workflowId}
          repository={repository}
          api={api}
        />
      ) : (
        <RunFlowView
          doc={doc}
          run={run}
          states={states}
          workspaceSlug={workspaceSlug}
          workflowId={workflowId}
          repository={repository}
          api={api}
          runsApi={runsApi}
        />
      )}
    </div>
  );
}
