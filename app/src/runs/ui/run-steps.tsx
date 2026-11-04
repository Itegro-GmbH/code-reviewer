// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// "What the agent did" on the detail page of a run of the Implementer (#745, live view): the work of the agent as a timeline, one
// model call after the other, as in a terminal session. For each call: what it thought (collapsed), what it said (open), each
// tool call as one line (the tool, what the engine called it, how it went, how long it took; its input in a collapsed block), and
// at the head the tokens, the time and, on the workspace's own key, the cost. The OUTPUT of a tool is never shown: the runner does
// not even send it.
//
// Everything in it is text from the agent or the repository, and is rendered as text: no markdown, no HTML, no link. A long turn
// keeps the page fast by rendering only the newest model calls (`newestGroups`); "Show earlier steps" adds more.
//
// A run that is going on opens the section and follows the poll of the run (`use-run-steps.ts`); a settled run shows a button, and
// the steps are fetched when it is pressed.
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Switch } from "../../components/ui/switch.tsx";
import { formatDuration } from "../run-duration.ts";
import type { StepView } from "../steps-view.ts";
import type { RunsApi } from "./api.ts";
import {
  groupDurationMs,
  groupSteps,
  isShortened,
  newestGroups,
  RENDER_PARTS,
  splitCut,
  type StepGroup,
} from "./steps-merge.ts";
import {
  cutText,
  earlierText,
  stepNumberText,
  STEPS_COPY,
  toolStatusText,
} from "./steps-messages.ts";
import { costText } from "./usage-facts.tsx";
import { useRunSteps } from "./use-run-steps.ts";

const COUNT = new Intl.NumberFormat("en-US");

/** How far from the end the person may scroll before "Follow" lets go. */
const FOLLOW_SLACK_PX = 80;

function CutMark({ bytes }: { bytes: number | null }) {
  if (bytes === null) return null;
  return (
    <span
      data-slot="run-step-cut"
      className="block text-xs text-muted-foreground"
    >
      {cutText(bytes)}
    </span>
  );
}

/** A text from the agent, with the runner's mark for a cut shown as a mark of its own. */
function PlainText({ text, className }: { text: string; className?: string }) {
  const { body, cutBytes } = splitCut(text);
  return (
    <div className={className}>
      <p className="break-words whitespace-pre-wrap">{body}</p>
      <CutMark bytes={cutBytes} />
    </div>
  );
}

function toolTime(ms: number): string {
  return ms < 1000 ? STEPS_COPY.underSecond : formatDuration(ms);
}

function ToolLine({ step }: { step: StepView }) {
  const status = step.status ?? "";
  const failed = status === "error";
  const title = splitCut(step.title ?? "");
  const input = step.input === undefined ? null : splitCut(step.input);
  const took =
    step.startedAt !== undefined && step.endedAt !== undefined
      ? toolTime(Math.max(0, step.endedAt - step.startedAt))
      : null;
  return (
    <li
      data-slot="run-step-tool"
      data-status={status}
      className="flex flex-col gap-1 text-sm"
    >
      <p className="flex flex-wrap items-baseline gap-x-2 break-words">
        <span className="min-w-0 font-mono font-semibold break-all">
          {step.tool}
        </span>
        {title.body === "" ? null : (
          <span className="min-w-0 break-all">{title.body}</span>
        )}
        <span
          data-slot="run-step-status"
          className={failed ? "text-danger" : "text-muted-foreground"}
        >
          {toolStatusText(status)}
        </span>
        {took === null ? null : (
          <span className="text-muted-foreground">{took}</span>
        )}
      </p>
      <CutMark bytes={title.cutBytes} />
      {failed && step.error !== undefined && step.error !== "" ? (
        <PlainText text={step.error} className="text-sm text-danger" />
      ) : null}
      {input === null || input.body === "" ? null : (
        <details data-slot="run-step-input" className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            {STEPS_COPY.input}
          </summary>
          <pre className="mt-1 max-h-60 overflow-auto rounded-lg border border-border bg-background p-2 font-mono break-words whitespace-pre-wrap">
            {input.body}
          </pre>
          <CutMark bytes={input.cutBytes} />
        </details>
      )}
    </li>
  );
}

function Item({ step }: { step: StepView }) {
  if (step.kind === "reasoning")
    return (
      <li data-slot="run-step-thinking">
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            {STEPS_COPY.thinking}
          </summary>
          <PlainText
            text={step.text ?? ""}
            className="mt-1 border-l-2 border-border pl-3 text-muted-foreground"
          />
        </details>
      </li>
    );
  if (step.kind === "text")
    return (
      <li data-slot="run-step-text">
        <PlainText text={step.text ?? ""} className="text-sm" />
      </li>
    );
  return <ToolLine step={step} />;
}

/** The facts at the head of a model call: its tokens, the time and, where the page shows cost, the cost. */
function groupFacts(group: StepGroup, showCost: boolean): string[] {
  const end = group.end;
  if (end === undefined) return [STEPS_COPY.stepRunning];
  const facts: string[] = [];
  const tokens = end.tokens;
  if (tokens !== undefined) {
    facts.push(`${COUNT.format(tokens.input)} in`);
    facts.push(`${COUNT.format(tokens.output)} out`);
    if (tokens.reasoning > 0)
      facts.push(`${COUNT.format(tokens.reasoning)} reasoning`);
    // The cache counts say which provider answered: shown only where the cost is.
    if (showCost && tokens.cacheRead > 0)
      facts.push(`${COUNT.format(tokens.cacheRead)} cached`);
  }
  const took = groupDurationMs(group);
  if (took !== undefined) facts.push(toolTime(took));
  if (showCost && end.cost !== undefined) facts.push(costText(end.cost));
  return facts;
}

function Group({ group, showCost }: { group: StepGroup; showCost: boolean }) {
  const headingId = useId();
  const facts = groupFacts(group, showCost);
  return (
    <li data-slot="run-step" className="flex flex-col gap-2">
      <h3
        id={headingId}
        className="flex flex-wrap items-baseline gap-x-3 text-sm font-semibold"
      >
        <span>{stepNumberText(group.number)}</span>
        <span
          data-slot="run-step-facts"
          className="text-xs font-normal text-muted-foreground"
        >
          {facts.join(" · ")}
        </span>
      </h3>
      <ul
        aria-labelledby={headingId}
        className="flex flex-col gap-2 border-l-2 border-border pl-3"
      >
        {group.items.map((step) => (
          <Item key={step.partId} step={step} />
        ))}
      </ul>
    </li>
  );
}

export function RunSteps({
  api,
  runId,
  tick,
  settled,
  showCost,
}: {
  api: RunsApi;
  runId: string;
  /** The stamp of the newest snapshot of the run: every new one asks for the steps once. */
  tick: string;
  /** True when the run is over (as the snapshot of the page says). */
  settled: boolean;
  /** Whether the page shows cost for this run: not on the operator's key. */
  showCost: boolean;
}) {
  // A run that is going on is open and followed; a settled one waits for the person to ask, and starts at the top.
  const [opened, setOpened] = useState(!settled);
  const [follow, setFollow] = useState(!settled);
  const [cap, setCap] = useState(RENDER_PARTS);
  const { steps, loaded, failure, retry } = useRunSteps({
    api,
    runId,
    enabled: opened,
    tick,
  });
  const scroller = useRef<HTMLDivElement>(null);
  const followId = useId();

  useEffect(() => {
    const element = scroller.current;
    if (follow && element !== null) element.scrollTop = element.scrollHeight;
  }, [follow, steps, opened, loaded]);

  const { shown, hidden } = newestGroups(groupSteps(steps), cap);

  return (
    <div data-slot="run-steps" className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">{STEPS_COPY.intro}</p>
      {!opened ? (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setOpened(true)}
          >
            {STEPS_COPY.show}
          </Button>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <Switch
              id={followId}
              size="sm"
              checked={follow}
              onCheckedChange={setFollow}
              aria-label={STEPS_COPY.followLabel}
            />
            <label htmlFor={followId} className="text-sm">
              {STEPS_COPY.follow}
            </label>
          </div>
          {failure === null ? null : (
            <div className="flex flex-wrap items-center gap-2">
              <p data-slot="run-steps-failed" className="text-sm text-warning">
                {steps.length === 0
                  ? STEPS_COPY.failedFirst
                  : settled
                    ? STEPS_COPY.failedSettled
                    : STEPS_COPY.failed}
              </p>
              {settled ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={retry}
                >
                  {STEPS_COPY.retry}
                </Button>
              ) : null}
            </div>
          )}
          {!loaded && failure === null ? (
            <p className="text-sm text-muted-foreground">
              {STEPS_COPY.loading}
            </p>
          ) : null}
          {loaded && steps.length === 0 && failure === null ? (
            <p
              data-slot="run-steps-empty"
              className="text-sm text-muted-foreground"
            >
              {settled ? STEPS_COPY.none : STEPS_COPY.waiting}
            </p>
          ) : null}
          {steps.length === 0 ? null : (
            <div
              ref={scroller}
              role="region"
              tabIndex={0}
              aria-label={STEPS_COPY.logLabel}
              onScroll={(event) => {
                const element = event.currentTarget;
                if (
                  element.scrollHeight -
                    element.scrollTop -
                    element.clientHeight >
                  FOLLOW_SLACK_PX
                )
                  setFollow(false);
              }}
              className="flex max-h-[32rem] flex-col gap-3 overflow-y-auto rounded-lg border border-border p-3"
            >
              {isShortened(steps) ? (
                <p
                  data-slot="run-steps-shortened"
                  className="text-xs text-muted-foreground"
                >
                  {STEPS_COPY.shortened}
                </p>
              ) : null}
              {hidden === 0 ? null : (
                <div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => {
                      // The person reads back: the view keeps its place instead of jumping to the end at the next step.
                      setFollow(false);
                      setCap((before) => before + RENDER_PARTS);
                    }}
                  >
                    {earlierText(hidden)}
                  </Button>
                </div>
              )}
              <ol className="flex flex-col gap-3">
                {shown.map((group) => (
                  <Group key={group.number} group={group} showCost={showCost} />
                ))}
              </ol>
            </div>
          )}
        </>
      )}
    </div>
  );
}
