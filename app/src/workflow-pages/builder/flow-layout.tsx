// SPDX-License-Identifier: LicenseRef-Proprietary

// The layout of a lane as a flow (#926, shared with the run page since #1079): the triggers as dashed groups with their pre-steps, then the
// shared steps top down, a loop as a container with its body and a footer, an `if` with then and else side by side, and `onFailure` as a
// group of its own at the bottom. It draws no card and no "+": the caller hands in how a node looks (`renderCard`) and what sits in the gap
// after a card and in an empty list (`renderGap`), so the builder puts its cards and its "+" there and the run page its read-only nodes and
// connectors. The markup the builder's tests and styles rely on (`data-list`, `data-container`, `data-branch`, `data-group`) is kept here.
import type { ReactNode } from "react";
import { BUILDER_COPY } from "./copy.ts";
import {
  kindOf,
  nodeAt,
  nodesOf,
  pointerOf,
  type Doc,
  type NodeKind,
  type Pointer,
} from "./document.ts";

/** What a list of steps holds: any step, or after a failure only the steps that may run there. */
export type ListKind = "steps" | "onFailure";

/** A place between two cards, or the only place of an empty list. */
export type FlowGap = {
  list: Pointer;
  listKind: ListKind;
  /** The card the gap follows; undefined in an empty list. */
  after: { pointer: Pointer; node: Doc } | undefined;
  /** The card is the last of its list: a read-only flow draws no connector below it. */
  last: boolean;
  /** What an "add" there says it adds to, for a list that is empty. */
  where: string;
};

export type FlowLayoutProps = {
  doc: Doc;
  /** The name of the flow for assistive technology. */
  label: string;
  renderCard: (pointer: Pointer, kind: NodeKind, node: Doc) => ReactNode;
  renderGap: (gap: FlowGap) => ReactNode;
  /** The heading of the shared steps. */
  sharedHeading: string;
  /** Under the body of a loop. */
  loopFooter?: (node: Doc) => ReactNode;
  /** Draw the group of `onFailure` also when the lane has no such step (the builder offers a "+" there). */
  showEmptyFailure?: boolean;
};

type Layout = Omit<FlowLayoutProps, "label" | "sharedHeading">;

function Steps({
  list,
  listKind,
  where,
  ...layout
}: Layout & { list: Pointer; listKind: ListKind; where: string }) {
  const entries = nodesOf(layout.doc, list);
  return (
    <div className="flex flex-col gap-0" data-list={list}>
      {entries.map(({ pointer, node }, index) => (
        <div key={pointer} className="flex flex-col">
          <NodeTree {...layout} pointer={pointer} />
          {layout.renderGap({
            list,
            listKind,
            after: { pointer, node },
            last: index === entries.length - 1,
            where,
          })}
        </div>
      ))}
      {entries.length === 0
        ? layout.renderGap({
            list,
            listKind,
            after: undefined,
            last: true,
            where,
          })
        : null}
    </div>
  );
}

function Branch({
  name,
  list,
  ...layout
}: Layout & { name: string; list: Pointer }) {
  const empty = nodesOf(layout.doc, list).length === 0;
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
        {...layout}
        list={list}
        listKind="steps"
        where={`${name} of the condition`}
      />
    </div>
  );
}

function NodeTree({ pointer, ...layout }: Layout & { pointer: Pointer }) {
  const kind = kindOf(layout.doc, pointer);
  const node = nodeAt(layout.doc, pointer);
  if (kind === undefined || node === undefined) return null;
  const card = layout.renderCard(pointer, kind, node);
  if (kind === "loop") {
    return (
      <div
        className="flex flex-col gap-2 rounded-xl border border-dashed border-line-strong p-2"
        data-container="loop"
      >
        {card}
        <div className="ml-4 flex flex-col">
          <Steps
            {...layout}
            list={`${pointer}/body`}
            listKind="steps"
            where={`the body of ${String(node.id ?? "the loop")}`}
          />
        </div>
        {layout.loopFooter === undefined ? (
          <span className="px-1 text-xs text-muted-foreground">
            {BUILDER_COPY.loopFooter(node.maxRounds)}
          </span>
        ) : (
          layout.loopFooter(node)
        )}
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
            {...layout}
            name={BUILDER_COPY.thenLabel}
            list={`${pointer}/then`}
          />
          <Branch
            {...layout}
            name={BUILDER_COPY.elseLabel}
            list={`${pointer}/else`}
          />
        </div>
      </div>
    );
  return <>{card}</>;
}

export function FlowLayout({
  label,
  sharedHeading,
  ...layout
}: FlowLayoutProps) {
  const { doc } = layout;
  const triggers = nodesOf(doc, "/triggers");
  const failure = nodesOf(doc, pointerOf("onFailure"));
  return (
    <section aria-label={label} className="flex min-w-0 flex-col gap-3">
      {triggers.map(({ pointer }) => (
        <div
          key={pointer}
          data-group="trigger"
          className="flex flex-col gap-0 rounded-xl border border-dashed border-line-strong p-3"
        >
          <NodeTree {...layout} pointer={pointer} />
          <span className="mt-2 ml-4 text-xs text-muted-foreground">
            {BUILDER_COPY.triggerPre}
          </span>
          <div className="ml-4 flex flex-col">
            <Steps
              {...layout}
              list={`${pointer}/steps`}
              listKind="steps"
              where="this trigger"
            />
          </div>
        </div>
      ))}
      <span className="text-xs font-semibold text-muted-foreground uppercase">
        {sharedHeading}
      </span>
      <Steps
        {...layout}
        list={pointerOf("steps")}
        listKind="steps"
        where="the shared steps"
      />
      {failure.length === 0 && layout.showEmptyFailure !== true ? null : (
        <>
          <span className="text-xs font-semibold text-muted-foreground uppercase">
            {BUILDER_COPY.onFailure}
          </span>
          <div
            className="rounded-xl border border-dashed border-line-strong p-3"
            data-group="onFailure"
          >
            <Steps
              {...layout}
              list={pointerOf("onFailure")}
              listKind="onFailure"
              where="the failure steps"
            />
          </div>
        </>
      )}
    </section>
  );
}
