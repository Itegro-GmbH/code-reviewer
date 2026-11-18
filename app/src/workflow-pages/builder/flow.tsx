// SPDX-License-Identifier: LicenseRef-Proprietary

// The flow of the builder (#926): the layout of `flow-layout.tsx` (triggers, shared steps, loops, `if` branches, `onFailure`) with "+" between
// cards to insert a step. A card is one button; the red count on it is what the validator found at that node.
import { useState } from "react";
import { Button } from "../../components/button.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { BUILDER_COPY } from "./copy.ts";
import { describeNode } from "./describe.ts";
import {
  afterNode,
  stepCountOf,
  STEPS_MAX,
  type Doc,
  type NodeKind,
  type Pointer,
} from "./document.ts";
import { FlowLayout, type FlowGap } from "./flow-layout.tsx";
import { countOf, type SortedProblems } from "./problems.ts";

export type AddableKind = Exclude<NodeKind, "trigger">;
const ALL_KINDS: readonly AddableKind[] = ["agent", "action", "loop", "if"];
/** After a failure nothing starts an agent or opens a pull request: comments, labels and `if` over them. */
const ON_FAILURE_KINDS: readonly AddableKind[] = ["action", "if"];
const KIND_NAME: Record<AddableKind, string> = {
  agent: "Agent step",
  action: "Action",
  loop: "Loop",
  if: "If",
};

type FlowProps = {
  doc: Doc;
  selected: Pointer;
  problems: SortedProblems;
  onSelect: (pointer: Pointer) => void;
  onAdd: (list: Pointer, index: number, kind: AddableKind) => void;
};

function AddStep({
  label,
  kinds,
  onPick,
  disabled,
}: {
  label: string;
  kinds: readonly AddableKind[];
  onPick: (kind: AddableKind) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col items-center gap-1" data-slot="add-step">
      <span aria-hidden="true" className="h-3 w-px bg-line-strong" />
      <Button
        variant="secondary"
        size="sm"
        aria-label={label}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        +
      </Button>
      {open ? (
        <div
          role="group"
          aria-label={`${label}: which kind`}
          className="flex flex-wrap justify-center gap-1"
        >
          {kinds.map((kind) => (
            <Button
              key={kind}
              variant="ghost"
              size="sm"
              onClick={() => {
                setOpen(false);
                onPick(kind);
              }}
            >
              {KIND_NAME[kind]}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Card({
  pointer,
  kind,
  node,
  selected,
  problems,
  onSelect,
}: Pick<FlowProps, "selected" | "problems" | "onSelect"> & {
  pointer: Pointer;
  kind: NodeKind;
  node: Doc;
}) {
  const described = describeNode(node, kind);
  const errors = countOf(problems, pointer);
  const on = selected === pointer;
  return (
    <button
      type="button"
      data-node={pointer}
      data-kind={kind}
      aria-pressed={on}
      onClick={() => onSelect(pointer)}
      className={`flex w-full flex-col gap-1 rounded-xl border p-3 text-left transition-all ${
        on
          ? "border-2 border-foreground bg-raised"
          : errors > 0
            ? "border-danger bg-background"
            : "border-line-strong bg-background hover:bg-surface"
      }`}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-muted-foreground uppercase">
          {described.kindLabel}
        </span>
        <span className="flex items-center gap-2">
          {errors > 0 ? (
            <Badge
              variant="danger"
              aria-label={`${String(errors)} ${errors === 1 ? "error" : "errors"}`}
            >
              {errors}
            </Badge>
          ) : null}
          <code className="text-xs text-muted-foreground">
            {String(node.id ?? "")}
          </code>
        </span>
      </span>
      <span className="text-sm font-semibold break-words">
        {described.title}
      </span>
      <span className="text-xs break-words text-muted-foreground">
        {described.summary}
      </span>
    </button>
  );
}

export function Flow(props: FlowProps) {
  const { doc, selected, problems, onSelect, onAdd } = props;
  const full = stepCountOf(doc) >= STEPS_MAX;
  return (
    <FlowLayout
      doc={doc}
      label={BUILDER_COPY.flowLabel}
      sharedHeading={`${BUILDER_COPY.sharedSteps} · ${String(stepCountOf(doc))} of ${String(STEPS_MAX)}`}
      showEmptyFailure
      renderCard={(pointer, kind, node) => (
        <Card
          pointer={pointer}
          kind={kind}
          node={node}
          selected={selected}
          problems={problems}
          onSelect={onSelect}
        />
      )}
      renderGap={(gap: FlowGap) => (
        <AddStep
          label={
            gap.after === undefined
              ? BUILDER_COPY.addStepTo(gap.where)
              : BUILDER_COPY.addStepAfter(String(gap.after.node.id ?? ""))
          }
          kinds={gap.listKind === "onFailure" ? ON_FAILURE_KINDS : ALL_KINDS}
          disabled={full}
          onPick={(kind) =>
            onAdd(
              gap.list,
              gap.after === undefined
                ? 0
                : (afterNode(gap.after.pointer)?.index ?? 0),
              kind,
            )
          }
        />
      )}
    />
  );
}
