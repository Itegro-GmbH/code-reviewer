// SPDX-License-Identifier: LicenseRef-Proprietary

// The flow (#926): the triggers as dashed groups with their pre-steps, then the shared steps top down, a loop as a container with its body
// and a footer, an `if` with then and else side by side, "+" between cards to insert a step, and `onFailure` as a group of its own at the
// bottom. A card is one button; the red count on it is what the validator found at that node.
import { useState } from "react";
import { Button } from "../../components/button.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { BUILDER_COPY } from "./copy.ts";
import { describeNode } from "./describe.ts";
import {
  afterNode,
  kindOf,
  nodeAt,
  nodesOf,
  pointerOf,
  stepCountOf,
  STEPS_MAX,
  type Doc,
  type NodeKind,
  type Pointer,
} from "./document.ts";
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
  doc,
  pointer,
  selected,
  problems,
  onSelect,
}: Pick<FlowProps, "doc" | "selected" | "problems" | "onSelect"> & {
  pointer: Pointer;
}) {
  const kind = kindOf(doc, pointer);
  const node = nodeAt(doc, pointer);
  if (kind === undefined || node === undefined) return null;
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

function Steps({
  list,
  kinds,
  where,
  ...flow
}: FlowProps & {
  list: Pointer;
  kinds: readonly AddableKind[];
  /** What the "+" of an empty list says it adds to. */
  where: string;
}) {
  const entries = nodesOf(flow.doc, list);
  const full = stepCountOf(flow.doc) >= STEPS_MAX;
  return (
    <div className="flex flex-col gap-0" data-list={list}>
      {entries.map(({ pointer, node }) => (
        <div key={pointer} className="flex flex-col">
          <NodeTree {...flow} pointer={pointer} />
          <AddStep
            label={BUILDER_COPY.addStepAfter(String(node.id ?? ""))}
            kinds={kinds}
            disabled={full}
            onPick={(kind) =>
              flow.onAdd(list, afterNode(pointer)?.index ?? 0, kind)
            }
          />
        </div>
      ))}
      {entries.length === 0 ? (
        <AddStep
          label={BUILDER_COPY.addStepTo(where)}
          kinds={kinds}
          disabled={full}
          onPick={(kind) => flow.onAdd(list, 0, kind)}
        />
      ) : null}
    </div>
  );
}

function Branch({
  name,
  list,
  ...flow
}: FlowProps & { name: string; list: Pointer }) {
  const empty = nodesOf(flow.doc, list).length === 0;
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1" data-branch={name}>
      <span className="text-xs font-semibold text-muted-foreground uppercase">
        {name}
      </span>
      {empty && name === BUILDER_COPY.elseLabel ? (
        <span className="text-xs text-muted-foreground">
          {BUILDER_COPY.nothingGoesOn}
        </span>
      ) : null}
      <Steps
        {...flow}
        list={list}
        kinds={ALL_KINDS}
        where={`${name} of the condition`}
      />
    </div>
  );
}

function NodeTree({ pointer, ...flow }: FlowProps & { pointer: Pointer }) {
  const kind = kindOf(flow.doc, pointer);
  const card = <Card {...flow} pointer={pointer} />;
  if (kind === "loop") {
    const node = nodeAt(flow.doc, pointer);
    return (
      <div
        className="flex flex-col gap-2 rounded-xl border border-dashed border-line-strong p-2"
        data-container="loop"
      >
        {card}
        <div className="ml-4 flex flex-col">
          <Steps
            {...flow}
            list={`${pointer}/body`}
            kinds={ALL_KINDS}
            where={`the body of ${String(node?.id ?? "the loop")}`}
          />
        </div>
        <span className="px-1 text-xs text-muted-foreground">
          {BUILDER_COPY.loopFooter(node?.maxRounds)}
        </span>
      </div>
    );
  }
  if (kind === "if")
    return (
      <div
        className="flex flex-col gap-2 rounded-xl border border-dashed border-line-strong p-2"
        data-container="if"
      >
        {card}
        <div className="flex flex-col gap-3 sm:flex-row">
          <Branch
            {...flow}
            name={BUILDER_COPY.thenLabel}
            list={`${pointer}/then`}
          />
          <Branch
            {...flow}
            name={BUILDER_COPY.elseLabel}
            list={`${pointer}/else`}
          />
        </div>
      </div>
    );
  return card;
}

export function Flow(props: FlowProps) {
  const { doc } = props;
  const triggers = nodesOf(doc, "/triggers");
  return (
    <section
      aria-label={BUILDER_COPY.flowLabel}
      className="flex min-w-0 flex-col gap-3"
    >
      {triggers.map(({ pointer }) => (
        <div
          key={pointer}
          data-group="trigger"
          className="flex flex-col gap-0 rounded-xl border border-dashed border-line-strong p-3"
        >
          <NodeTree {...props} pointer={pointer} />
          <span className="mt-2 ml-4 text-xs text-muted-foreground">
            {BUILDER_COPY.triggerPre}
          </span>
          <div className="ml-4 flex flex-col">
            <Steps
              {...props}
              list={`${pointer}/steps`}
              kinds={ALL_KINDS}
              where="this trigger"
            />
          </div>
        </div>
      ))}
      <span className="text-xs font-semibold text-muted-foreground uppercase">
        {BUILDER_COPY.sharedSteps} · {stepCountOf(doc)} of {STEPS_MAX}
      </span>
      <Steps
        {...props}
        list={pointerOf("steps")}
        kinds={ALL_KINDS}
        where="the shared steps"
      />
      <span className="text-xs font-semibold text-muted-foreground uppercase">
        {BUILDER_COPY.onFailure}
      </span>
      <div
        className="rounded-xl border border-dashed border-line-strong p-3"
        data-group="onFailure"
      >
        <Steps
          {...props}
          list={pointerOf("onFailure")}
          kinds={ON_FAILURE_KINDS}
          where="the failure steps"
        />
      </div>
    </section>
  );
}
