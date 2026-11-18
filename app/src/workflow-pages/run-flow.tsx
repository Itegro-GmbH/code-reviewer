// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The lane of a run, drawn read-only (#1079): the layout of the builder's flow (`builder/flow-layout.tsx`: triggers with their pre-steps,
// the shared steps top down, loops as containers, `if` with then and else side by side, `onFailure` at the bottom) with every node
// coloured by where the run stands on it. A node is one button: its kind, its name, its state (a symbol and a word as well as a hue), the
// round of a loop, and how long it took and what it cost where that is known. The step that runs now is marked and scrolled into view when
// the page opens; its pulse stops for a person who asked for less motion. Names come from the lane document: text, never markup.
import {
  CheckCircleIcon,
  ChatCircleDotsIcon,
  CircleDashedIcon,
  GitForkIcon,
  LightningIcon,
  MinusCircleIcon,
  PlayCircleIcon,
  RepeatIcon,
  RobotIcon,
  XCircleIcon,
} from "@phosphor-icons/react/dist/ssr";
import type { Icon } from "@phosphor-icons/react";
import { useEffect, useRef } from "react";
import { formatDuration } from "../runs/run-duration.ts";
import { FlowLayout } from "./builder/flow-layout.tsx";
import { BUILDER_COPY } from "./builder/copy.ts";
import { brief, describeNode } from "./builder/describe.ts";
import type { Doc, NodeKind } from "./builder/document.ts";
import { FLOW_COPY } from "./messages.ts";
import type { NodeRun, NodeState, NodeStates } from "./run-node-states.ts";
import { formatUsd, stepDurationMs } from "./view.ts";

const STATE_ICON: Record<NodeState, Icon> = {
  done: CheckCircleIcon,
  running: PlayCircleIcon,
  waiting: ChatCircleDotsIcon,
  failed: XCircleIcon,
  skipped: MinusCircleIcon,
  notReached: CircleDashedIcon,
};

const KIND_ICON: Record<NodeKind, Icon> = {
  trigger: PlayCircleIcon,
  agent: RobotIcon,
  action: LightningIcon,
  loop: RepeatIcon,
  if: GitForkIcon,
};

/** The ground, the line and the text of a node by its state: the tokens of `theme.css` (`flow-*`), calm in light and in dark. */
export const STATE_NODE_CLASS: Record<NodeState, string> = {
  done: "border-flow-done/50 bg-flow-done-soft",
  running: "border-flow-running bg-flow-running-soft",
  waiting: "border-flow-waiting bg-flow-waiting-soft",
  failed: "border-flow-failed bg-flow-failed-soft",
  skipped: "border-dashed border-line-strong bg-background",
  notReached: "border-line bg-background",
};
export const STATE_TEXT_CLASS: Record<NodeState, string> = {
  done: "text-flow-done",
  running: "text-flow-running",
  waiting: "text-flow-waiting",
  failed: "text-flow-failed",
  skipped: "text-muted-foreground",
  notReached: "text-muted-foreground",
};

/** What a state is called on this node: a trigger is "started this run" or "not used", the rest as the copy says. */
export function stateLabelOf(kind: NodeKind, state: NodeState): string {
  if (kind === "trigger")
    return state === "done"
      ? FLOW_COPY.triggerUsed
      : state === "skipped"
        ? FLOW_COPY.triggerUnused
        : FLOW_COPY.kindName.trigger;
  return FLOW_COPY.state[state];
}

/** The state as a symbol and a word. The running symbol pulses unless the person asked for less motion. */
export function StateMark({
  kind,
  state,
  className,
}: {
  kind: NodeKind;
  state: NodeState;
  className?: string;
}) {
  const StateIcon = STATE_ICON[state];
  return (
    <span
      data-slot="node-state"
      data-state={state}
      className={`inline-flex items-center gap-1 text-xs font-semibold ${STATE_TEXT_CLASS[state]} ${className ?? ""}`}
    >
      <StateIcon
        aria-hidden="true"
        weight={state === "running" ? "fill" : "bold"}
        className={`size-4 ${state === "running" ? "motion-safe:animate-pulse" : ""}`}
      />
      {stateLabelOf(kind, state)}
    </span>
  );
}

/** The name of a node: the note the lane's author gave it, else its id (both text from the document). */
export function nodeNameOf(node: Doc, kind: NodeKind): string {
  if (kind === "trigger") return describeNode(node, kind).title;
  const note = typeof node.description === "string" ? node.description : "";
  return note.trim() === "" ? String(node.id ?? "") : brief(note, 80);
}

function cost(found: NodeRun): string | undefined {
  const row = found.latest;
  if (row === undefined || row.costUsd === null) return undefined;
  return row.costBasis === "subscription"
    ? row.costUsd === 0
      ? undefined
      : `≈ ${formatUsd(row.costUsd)}`
    : formatUsd(row.costUsd);
}

function Node({
  node,
  kind,
  found,
  selected,
  current,
  onSelect,
}: {
  node: Doc;
  kind: NodeKind;
  found: NodeRun | undefined;
  selected: boolean;
  current: boolean;
  onSelect: (stepId: string) => void;
}) {
  const stepId = String(node.id ?? "");
  const state = found?.state ?? "notReached";
  const KindIcon = KIND_ICON[kind];
  const duration =
    found?.latest === undefined ? null : stepDurationMs(found.latest);
  const spent = found === undefined ? undefined : cost(found);
  const facts = [
    found?.round === undefined
      ? undefined
      : FLOW_COPY.round(found.round, found.maxRounds),
    duration === null ? undefined : formatDuration(duration),
    spent,
  ].filter((fact): fact is string => fact !== undefined);
  const name = nodeNameOf(node, kind);
  return (
    <button
      type="button"
      data-node-step={stepId}
      data-kind={kind}
      data-state={state}
      aria-pressed={selected}
      aria-current={current ? "step" : undefined}
      onClick={() => onSelect(stepId)}
      className={`relative flex w-full flex-col gap-1 rounded-xl border p-3 text-left transition-all hover:shadow-nav ${STATE_NODE_CLASS[state]} ${
        selected ? "ring-2 ring-ring ring-offset-2 ring-offset-background" : ""
      }`}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 text-xs font-semibold text-muted-foreground uppercase">
          <KindIcon aria-hidden="true" className="size-4" />
          {FLOW_COPY.kindName[kind]}
        </span>
        {current ? (
          <span
            data-slot="current-step"
            className="flex items-center gap-1 text-xs font-semibold text-foreground"
          >
            <span aria-hidden="true" className="relative flex size-2">
              <span className="absolute inline-flex size-full rounded-full bg-flow-running opacity-60 motion-safe:animate-ping" />
              <span className="relative inline-flex size-2 rounded-full bg-flow-running" />
            </span>
            {FLOW_COPY.current}
          </span>
        ) : null}
      </span>
      <span className="text-sm font-semibold break-words">{name}</span>
      {kind !== "trigger" && name !== stepId ? (
        <code className="w-fit text-xs text-muted-foreground">{stepId}</code>
      ) : null}
      <StateMark kind={kind} state={state} />
      {facts.length === 0 ? null : (
        <span data-slot="node-facts" className="text-xs text-muted-foreground">
          {facts.join(" · ")}
        </span>
      )}
    </button>
  );
}

export function RunFlow({
  doc,
  states,
  selected,
  onSelect,
}: {
  doc: Doc;
  states: NodeStates;
  selected: string | undefined;
  onSelect: (stepId: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  // When the page opens, the step that runs now comes into view (once: later updates must not pull the page around).
  useEffect(() => {
    const target = root.current?.querySelector('[aria-current="step"]');
    if (!(target instanceof HTMLElement) || target.scrollIntoView === undefined)
      return;
    const calm =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({
      block: "nearest",
      behavior: calm ? "auto" : "smooth",
    });
  }, []);
  return (
    <div ref={root} data-slot="run-flow">
      <FlowLayout
        doc={doc}
        label={FLOW_COPY.flowLabel}
        sharedHeading={BUILDER_COPY.sharedSteps}
        loopFooter={() => null}
        renderCard={(_pointer, kind, node) => {
          const stepId = String(node.id ?? "");
          return (
            <Node
              node={node}
              kind={kind}
              found={states.byStepId.get(stepId)}
              selected={selected === stepId}
              current={states.current === stepId}
              onSelect={onSelect}
            />
          );
        }}
        renderGap={(gap) =>
          gap.after === undefined || gap.last ? null : (
            <span
              aria-hidden="true"
              className="mx-auto h-3 w-px bg-line-strong"
            />
          )
        }
      />
    </div>
  );
}
