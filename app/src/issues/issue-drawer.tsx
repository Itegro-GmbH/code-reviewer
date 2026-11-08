// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The issue drawer (#925, prototype board "3 Project: issues + issue drawer"): a side sheet with everything the factory knows of one issue.
// It is the Radix dialog of the sheet, so it traps the focus, closes on Escape and returns the focus to the row that opened it. State, type,
// labels, board status, assignees, the pull request and its checks are GitHub's own words; the lane and its step, the effort (what the runs
// cost; for the run that is going on also how long it has been going, the rounds and the questions asked) and the history of its steps are
// the factory's. A field the data does not have is left out, not made up: there are no tokens or lines of code yet. Everything from GitHub
// and from the agent is rendered as text.
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "../components/button.tsx";
import { Badge } from "../components/ui/badge.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../components/ui/sheet.tsx";
import { formatUtc } from "../ui/format-time.ts";
import { workspacePath } from "../workspaces/paths.ts";
import type { TicketList, TicketListItem } from "../tracker/service.ts";
import type { RunView } from "../workflow-runs/service.ts";
import { WorkflowRunStatusBadge } from "../workflow-pages/status-badge.tsx";
import { browserIssuesApi, type IssuesApi } from "./api.ts";
import { DRAWER_COPY } from "./messages.ts";
import {
  formatSince,
  formatUsd,
  pullRequestOf,
  pullRequestState,
  pullRequestUrl,
  subIssuesOf,
  ticketUrl,
} from "./view.ts";
import { formatTicketRef } from "../workflows/ticket-ref.ts";

type RunState =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ready"; run: RunView };

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs font-semibold text-muted-foreground">{label}</dt>
      <dd className="m-0 text-sm break-words">{children}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="m-0 text-sm leading-5 font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function ExternalLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

/** The run that is on the issue, read while the drawer shows the issue; a failure leaves the rest of the drawer as it is. */
function useLaneRun(api: IssuesApi, lane: TicketListItem["lane"]): RunState {
  const [state, setState] = useState<{ key: string; value: RunState } | null>(
    null,
  );
  const key =
    lane === null
      ? ""
      : `${lane.workflowId}:${lane.runId}:${lane.step ?? ""}:${lane.status}`;
  useEffect(() => {
    if (lane === null) return;
    let stale = false;
    void api.run(lane.workflowId, lane.runId).then((result) => {
      if (stale) return;
      setState({
        key,
        value: result.ok
          ? { kind: "ready", run: result.data.run }
          : { kind: "failed" },
      });
    });
    return () => {
      stale = true;
    };
    // `key` stands for the lane: the run is read again when its step or status changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key]);
  if (lane === null) return { kind: "none" };
  return state?.key === key ? state.value : { kind: "loading" };
}

export function IssueDrawer({
  workspaceSlug,
  repositoryId,
  projectId,
  list,
  item,
  onClose,
  onCloseAutoFocus,
  api: apiProp,
}: {
  workspaceSlug: string;
  repositoryId: string;
  projectId: string;
  list: TicketList;
  /** The issue shown; the drawer is open while it is set. */
  item: TicketListItem | undefined;
  onClose: () => void;
  /** Where the focus goes when the drawer has closed (the row's button, see `useReturnFocus`). */
  onCloseAutoFocus?: (event: Event) => void;
  /** Only tests pass this. */
  api?: IssuesApi;
}) {
  const [defaultApi] = useState(() => browserIssuesApi(workspaceSlug));
  const api = apiProp ?? defaultApi;
  // The drawer slides out after the issue is unset: it keeps showing the last issue, and its run, until it is gone.
  const [last, setLast] = useState(item);
  if (item !== undefined && item !== last) setLast(item);
  const shown = item ?? last;
  const run = useLaneRun(api, shown?.lane ?? null);
  return (
    <Sheet
      open={item !== undefined}
      onOpenChange={(open) => !open && onClose()}
    >
      <SheetContent
        className="w-full overflow-y-auto sm:max-w-xl"
        {...(onCloseAutoFocus === undefined ? {} : { onCloseAutoFocus })}
      >
        {shown === undefined ? null : (
          <DrawerBody
            workspaceSlug={workspaceSlug}
            repositoryId={repositoryId}
            projectId={projectId}
            list={list}
            item={shown}
            run={run}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function DrawerBody({
  workspaceSlug,
  repositoryId,
  projectId,
  list,
  item,
  run,
}: {
  workspaceSlug: string;
  repositoryId: string;
  projectId: string;
  list: TicketList;
  item: TicketListItem;
  run: RunState;
}) {
  const address = ticketUrl(list.repo, item);
  const subIssues = subIssuesOf(list, item.number);
  const ticketRef = formatTicketRef({
    provider: "github",
    repo: list.repo,
    number: item.number,
  });
  return (
    <>
      <SheetHeader className="pr-14">
        <SheetTitle className="text-lg leading-7 break-words">
          <span className="font-mono text-muted-foreground">
            #{item.number}
          </span>{" "}
          {item.title}
        </SheetTitle>
        <SheetDescription>{DRAWER_COPY.description}</SheetDescription>
        {address === undefined ? null : (
          <ExternalLink href={address}>{DRAWER_COPY.openOnGitHub}</ExternalLink>
        )}
      </SheetHeader>
      <div className="flex flex-col gap-6 px-4 pb-6">
        <Section title={DRAWER_COPY.state}>
          <dl className="m-0 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={DRAWER_COPY.state}>
              <Badge variant={item.state === "open" ? "success" : "neutral"}>
                {item.state}
              </Badge>
              {item.stateReason === null ? null : (
                <span className="ml-2 text-muted-foreground">
                  {DRAWER_COPY.stateReason(item.stateReason)}
                </span>
              )}
            </Field>
            <Field label={DRAWER_COPY.type}>
              {item.type ?? (
                <span className="text-muted-foreground">
                  {DRAWER_COPY.noType}
                </span>
              )}
            </Field>
            <Field label={DRAWER_COPY.boardStatus}>
              {item.boardStatus ?? (
                <span className="text-muted-foreground">–</span>
              )}
            </Field>
            <Field label={DRAWER_COPY.assignees}>
              {item.assignees.length === 0 ? (
                <span className="text-muted-foreground">
                  {DRAWER_COPY.nobody}
                </span>
              ) : (
                item.assignees.map((person) => person.login).join(", ")
              )}
            </Field>
            <Field label={DRAWER_COPY.labels}>
              {item.labels.length === 0 ? (
                <span className="text-muted-foreground">
                  {DRAWER_COPY.noLabels}
                </span>
              ) : (
                <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
                  {item.labels.map((label) => (
                    <li key={label.name}>
                      <Badge variant="neutral" icon={false}>
                        {label.name}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </Field>
          </dl>
        </Section>

        <Section title={DRAWER_COPY.pullRequest}>
          <PullRequests list={list} item={item} />
        </Section>

        <Section title={DRAWER_COPY.lane}>
          <LaneSection workspaceSlug={workspaceSlug} item={item} run={run} />
        </Section>

        <Section title={DRAWER_COPY.effort}>
          <Effort item={item} run={run} />
        </Section>

        {run.kind === "ready" ? (
          <Section title={DRAWER_COPY.steps}>
            <History run={run.run} />
          </Section>
        ) : null}

        <Section title={DRAWER_COPY.subIssues}>
          {subIssues.length === 0 ? (
            <p className="m-0 text-sm text-muted-foreground">
              {DRAWER_COPY.noSubIssues}
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
              {subIssues.map((sub) => (
                <li key={sub.number} className="flex items-center gap-2">
                  <Badge variant={sub.state === "open" ? "success" : "neutral"}>
                    {sub.state}
                  </Badge>
                  <span className="font-mono text-muted-foreground">
                    #{sub.number}
                  </span>
                  <span className="min-w-0 break-words">{sub.title}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title={DRAWER_COPY.technical}>
          <dl className="m-0 grid grid-cols-1 gap-3 font-mono text-xs">
            <Field label={DRAWER_COPY.ticketRef}>{ticketRef}</Field>
            <Field label={DRAWER_COPY.repository}>
              {list.repo} · {repositoryId}
            </Field>
            <Field label={DRAWER_COPY.project}>{projectId}</Field>
            {item.lane === null ? null : (
              <Field label={DRAWER_COPY.run}>
                {item.lane.runId} ·{" "}
                <Link
                  href={workspacePath(
                    workspaceSlug,
                    `/workflows/${encodeURIComponent(item.lane.workflowId)}`,
                  )}
                >
                  {DRAWER_COPY.lanePage}
                </Link>
              </Field>
            )}
            <Field label={DRAWER_COPY.updatedAt}>
              <time dateTime={item.updatedAt}>{formatUtc(item.updatedAt)}</time>
            </Field>
            <Field label={DRAWER_COPY.syncedAt}>
              <time dateTime={item.syncedAt}>{formatUtc(item.syncedAt)}</time>
            </Field>
          </dl>
        </Section>
      </div>
    </>
  );
}

function PullRequests({
  list,
  item,
}: {
  list: TicketList;
  item: TicketListItem;
}) {
  if (item.pullRequests.length === 0)
    return (
      <p className="m-0 text-sm text-muted-foreground">
        {DRAWER_COPY.noPullRequest}
      </p>
    );
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
      {item.pullRequests.map((number) => {
        const pull = pullRequestOf(list, number);
        const state = pullRequestState(list, item, number);
        const address = pullRequestUrl(list.repo, number);
        return (
          <li key={number} className="flex flex-wrap items-center gap-2">
            {address === undefined ? (
              <span className="font-mono">#{number}</span>
            ) : (
              <ExternalLink href={address}>#{number}</ExternalLink>
            )}
            {state === undefined ? (
              <span className="text-muted-foreground">
                {DRAWER_COPY.pullStateUnknown}
              </span>
            ) : (
              <Badge variant={state === "open" ? "success" : "neutral"}>
                {state}
              </Badge>
            )}
            {pull === undefined ? null : (
              <span className="text-muted-foreground">
                {DRAWER_COPY.checks}: {pull.checksState ?? DRAWER_COPY.noChecks}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function LaneSection({
  workspaceSlug,
  item,
  run,
}: {
  workspaceSlug: string;
  item: TicketListItem;
  run: RunState;
}) {
  const lane = item.lane;
  if (lane === null)
    return (
      <p className="m-0 text-sm text-muted-foreground">
        {DRAWER_COPY.laneNone}
      </p>
    );
  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold break-words">{lane.name}</span>
        <Badge variant={lane.status === "waiting" ? "warning" : "running"}>
          {lane.status === "waiting"
            ? DRAWER_COPY.laneWaiting
            : DRAWER_COPY.laneRunning}
        </Badge>
        {run.kind === "ready" ? (
          <WorkflowRunStatusBadge status={run.run.status} />
        ) : null}
      </div>
      {lane.step === null ? null : (
        <span className="text-muted-foreground">
          at <span className="font-mono">{lane.step}</span>
        </span>
      )}
      <Button asChild variant="secondary" size="sm" className="self-start">
        <Link
          href={workspacePath(
            workspaceSlug,
            `/workflows/${encodeURIComponent(lane.workflowId)}/runs/${encodeURIComponent(lane.runId)}`,
          )}
        >
          {DRAWER_COPY.openRun}
        </Link>
      </Button>
    </div>
  );
}

function Effort({ item, run }: { item: TicketListItem; run: RunState }) {
  const questions =
    run.kind === "ready"
      ? run.run.steps.filter((step) => step.ask !== null).length
      : null;
  const rounds =
    run.kind === "ready"
      ? Math.max(0, ...run.run.steps.map((step) => step.round))
      : null;
  return (
    <>
      <dl className="m-0 grid grid-cols-2 gap-4">
        <Field label={DRAWER_COPY.spent}>
          <span className="font-mono">{formatUsd(item.costUsd)}</span>
        </Field>
        {run.kind === "ready" &&
        run.run.finishedAt === null &&
        run.run.status !== "waiting" ? (
          <Field label={DRAWER_COPY.runtime}>
            {formatSince(run.run.createdAt, new Date())}
          </Field>
        ) : null}
        {questions === null ? null : (
          <Field label={DRAWER_COPY.questions}>
            <span className="font-mono">{questions}</span>
          </Field>
        )}
        {rounds === null || rounds <= 1 ? null : (
          <Field label={DRAWER_COPY.rounds}>
            <span className="font-mono">{rounds}</span>
          </Field>
        )}
      </dl>
      {run.kind === "loading" ? (
        <p className="m-0 text-xs text-muted-foreground">
          {DRAWER_COPY.runLoading}
        </p>
      ) : null}
      {run.kind === "failed" ? (
        <p className="m-0 text-xs text-muted-foreground">
          {DRAWER_COPY.runFailed}
        </p>
      ) : null}
    </>
  );
}

function History({ run }: { run: RunView }) {
  if (run.steps.length === 0)
    return (
      <p className="m-0 text-sm text-muted-foreground">
        {DRAWER_COPY.stepsNone}
      </p>
    );
  return (
    <ol className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
      {run.steps.map((step) => (
        <li
          key={`${String(step.position)}-${step.id}-${String(step.round)}`}
          className="flex flex-wrap items-center gap-2"
        >
          <span className="font-mono">{step.id}</span>
          {step.round > 1 ? (
            <span className="text-xs text-muted-foreground">
              round {step.round}
            </span>
          ) : null}
          <span className="text-xs text-muted-foreground">{step.status}</span>
          {step.startedAt === null ? null : (
            <time
              dateTime={step.startedAt}
              className="text-xs text-muted-foreground"
            >
              {formatUtc(step.startedAt)}
            </time>
          )}
        </li>
      ))}
    </ol>
  );
}
