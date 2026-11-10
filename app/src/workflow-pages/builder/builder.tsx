// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The lane builder (#926): the flow on the left, the inspector and the lane card on the right, the state of the validator and the
// buttons on top. The document is the one state: every edit makes a new document, and every new document is sent to the validate route
// (after a short pause) so the red counts and the header follow the edit. "Save as vN" is on only for a document the validator has
// accepted *as it stands* and that differs from the saved one; the save route validates again. Nothing is stored before that.
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "../../components/button.tsx";
import { Alert } from "../../components/ui/alert.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../components/ui/dialog.tsx";
import { useProductIdentity } from "../../product-identity/context.tsx";
import { canonicalJson } from "../../workflows/json.ts";
import { BUDGET_DEFAULT_USD } from "../../workflows/limits.ts";
import {
  browserBuilderApi,
  VALIDATE_DEBOUNCE_MS,
  type BuilderApi,
  type ReachLookup,
  type ValidateAnswer,
} from "./api.ts";
import { BUILDER_COPY, describeSaveFailure } from "./copy.ts";
import {
  forSave,
  insertNode,
  moveNode,
  newNode,
  nodeAt,
  normalise,
  removeNode,
  type Doc,
  type Pointer,
} from "./document.ts";
import { Flow, type AddableKind } from "./flow.tsx";
import { Inspector, type ProfileOption } from "./inspector.tsx";
import { LaneCard, type VersionEntry } from "./lane-card.tsx";
import { ProblemList } from "./problem-list.tsx";
import { sortProblems } from "./problems.ts";

type Checked = {
  doc: Doc;
  /** `undefined`: the validator could not be asked. */
  answer: ValidateAnswer | undefined;
};

/** `raw` is the document as the server holds it (a lane written with the single `trigger` is saved in that shape until its trigger is edited). */
type Saved = {
  doc: Doc;
  raw: unknown;
  version: number;
  versions: VersionEntry[];
};

/** Where focus goes after the next render: the inspector's heading, or a card. */
type FocusTarget = { to: "inspector" } | { to: "card"; pointer: Pointer };

function firstPointer(doc: Doc): Pointer {
  return nodeAt(doc, "/steps/0") === undefined ? "/triggers/0" : "/steps/0";
}

function money(usd: number): string {
  return `$${Number.isInteger(usd) ? String(usd) : usd.toFixed(2)}`;
}

export function LaneBuilder({
  workspaceSlug,
  workflowId,
  version,
  versions,
  document,
  profiles,
  startPanel,
  api,
  validateDelayMs = VALIDATE_DEBOUNCE_MS,
}: {
  workspaceSlug: string;
  workflowId: string;
  /** The current version of the lane: the one `document` is. */
  version: number;
  versions: readonly VersionEntry[];
  document: unknown;
  /** The profiles of the workspace a step may run. */
  profiles: readonly ProfileOption[];
  /** The start form(s) of the lane: what "Run now" opens. */
  startPanel: ReactNode;
  /** Only tests pass this. */
  api?: BuilderApi;
  validateDelayMs?: number;
}) {
  const product = useProductIdentity();
  const router = useRouter();
  const calls = useMemo(
    () => api ?? browserBuilderApi(workspaceSlug),
    [api, workspaceSlug],
  );
  const initial = useMemo(() => normalise(document), [document]);
  const [doc, setDoc] = useState<Doc | undefined>(initial);
  const [saved, setSaved] = useState<Saved | undefined>(
    initial === undefined
      ? undefined
      : { doc: initial, raw: document, version, versions: [...versions] },
  );
  const [selected, setSelected] = useState<Pointer>(
    initial === undefined ? "" : firstPointer(initial),
  );
  const [showJson, setShowJson] = useState(false);
  const [checked, setChecked] = useState<Checked | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [justSaved, setJustSaved] = useState(false);
  const saveInFlight = useRef(false);
  const flowBox = useRef<HTMLDivElement>(null);
  const inspectorHeading = useRef<HTMLHeadingElement>(null);
  const focusTarget = useRef<FocusTarget | undefined>(undefined);
  const [focusTick, setFocusTick] = useState(0);
  /** What the screen reader is told about the check: the result of the latest one, never "Checking…" between two pauses. */
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    if (doc === undefined) return;
    let stale = false;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void calls.validate(doc, controller.signal).then((result) => {
        if (stale) return;
        setChecked({ doc, answer: result.ok ? result.data : undefined });
      });
    }, validateDelayMs);
    return () => {
      stale = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [calls, doc, validateDelayMs]);

  const answered =
    checked !== undefined && checked.doc === doc ? checked.answer : undefined;
  const result =
    answered === undefined
      ? undefined
      : BUILDER_COPY.checkResult(
          answered.valid,
          answered.valid ? answered.steps : answered.errors.length,
          answered.truncated,
        );
  if (result !== undefined && result !== announcement) setAnnouncement(result);

  useEffect(() => {
    const target = focusTarget.current;
    focusTarget.current = undefined;
    if (target === undefined) return;
    if (target.to === "card") {
      const card = Array.from(
        flowBox.current?.querySelectorAll<HTMLElement>("button[data-node]") ??
          [],
      ).find((each) => each.dataset.node === target.pointer);
      if (card !== undefined) {
        card.focus();
        return;
      }
    }
    inspectorHeading.current?.focus();
  }, [focusTick]);

  if (doc === undefined || saved === undefined)
    return (
      <Alert variant="info" role="status">
        {BUILDER_COPY.unreadable}
      </Alert>
    );

  const current = checked?.doc === doc;
  const answer = checked?.answer;
  const valid = current && answer?.valid === true;
  const dirty = canonicalJson(doc) !== canonicalJson(saved.doc);
  const sorted = sortProblems(answer?.errors ?? []);
  const warned = sortProblems(answer?.warnings ?? []);
  const warningCount = answer?.warnings?.length ?? 0;
  const effective =
    nodeAt(doc, selected) === undefined ? firstPointer(doc) : selected;
  const budget =
    answer?.budgetUsd ??
    (typeof doc.budgetUsd === "number" ? doc.budgetUsd : BUDGET_DEFAULT_USD);

  /** What a field of the inspector can reach: asked of the document as it stands (unsaved), with the samples of this lane's latest run. */
  const lookup: ReachLookup = (request, signal) =>
    calls.scope(doc, request, workflowId, signal);

  const edit = (next: Doc): void => {
    setDoc(next);
    setJustSaved(false);
    setSaveError(undefined);
  };

  const focusAfterRender = (target: FocusTarget): void => {
    focusTarget.current = target;
    setFocusTick((tick) => tick + 1);
  };

  const select = (pointer: Pointer): void => {
    setSelected(pointer);
    focusAfterRender({ to: "inspector" });
  };

  const add = (list: Pointer, index: number, kind: AddableKind): void => {
    const inserted = insertNode(
      doc,
      list,
      index,
      newNode(
        doc,
        kind,
        profiles[0] === undefined ? {} : { profile: profiles[0].name },
      ),
    );
    edit(inserted.doc);
    select(inserted.pointer);
  };

  // Selection and focus agree: both go to the node that is shown in the inspector once the step is gone.
  const remove = (): void => {
    const removed = removeNode(doc, effective);
    edit(removed.doc);
    setSelected(removed.selection);
    focusAfterRender({ to: "card", pointer: removed.selection });
  };

  const move = (direction: -1 | 1): void => {
    const moved = moveNode(doc, effective, direction);
    edit(moved.doc);
    setSelected(moved.pointer);
  };

  const save = async (): Promise<void> => {
    if (!valid || !dirty || saveInFlight.current) return;
    saveInFlight.current = true;
    const body = forSave(doc, saved.raw);
    setSaving(true);
    setSaveError(undefined);
    const result = await calls
      .save(workflowId, body, saved.version)
      .finally(() => {
        saveInFlight.current = false;
      });
    setSaving(false);
    if (!result.ok) {
      setSaveError(describeSaveFailure(product, result));
      return;
    }
    const { workflow } = result.data;
    setSaved({
      doc,
      raw: body,
      version: workflow.version,
      versions: workflow.versions,
    });
    setJustSaved(true);
    router.refresh();
  };

  const status = !current ? (
    <Badge variant="neutral">{BUILDER_COPY.checking}</Badge>
  ) : answer === undefined ? (
    <Badge variant="warning">{BUILDER_COPY.couldNotCheck}</Badge>
  ) : answer.valid ? (
    <Badge variant="success">
      Valid · {answer.steps} {answer.steps === 1 ? "step" : "steps"} ·{" "}
      {money(budget)}
      {warningCount === 0 ? "" : ` · ${BUILDER_COPY.warnings(warningCount)}`}
    </Badge>
  ) : (
    <Badge variant="danger">
      {answer.errors.length}
      {answer.truncated ? "+" : ""}{" "}
      {answer.errors.length === 1 && !answer.truncated ? "error" : "errors"},
      not saved
    </Badge>
  );

  return (
    <div className="flex flex-col gap-4" data-slot="lane-builder">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div data-slot="validity">{status}</div>
        <span role="status" aria-live="polite" className="sr-only">
          {announcement}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            aria-pressed={showJson}
            onClick={() => setShowJson(!showJson)}
          >
            {showJson ? BUILDER_COPY.jsonHide : BUILDER_COPY.jsonShow}
          </Button>
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="secondary">{BUILDER_COPY.runNow}</Button>
            </DialogTrigger>
            <DialogContent className="max-h-[85vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>{BUILDER_COPY.runNowTitle}</DialogTitle>
                <DialogDescription>
                  {dirty
                    ? BUILDER_COPY.runNowUnsaved
                    : BUILDER_COPY.runNowSaved}
                </DialogDescription>
              </DialogHeader>
              {startPanel}
            </DialogContent>
          </Dialog>
          <Button
            variant="primary"
            disabled={!valid || !dirty}
            loading={saving}
            loadingLabel="Saving"
            onClick={() => void save()}
          >
            Save as v{saved.version + 1}
          </Button>
        </div>
      </div>
      {saveError === undefined ? null : (
        <Alert variant="destructive">{saveError}</Alert>
      )}
      {justSaved ? (
        <Alert variant="success" role="status">
          {BUILDER_COPY.saved}
        </Alert>
      ) : null}
      {current && answer === undefined ? (
        <Alert variant="warning" role="status">
          {BUILDER_COPY.couldNotCheck}
        </Alert>
      ) : null}
      {sorted.document.length === 0 ? null : (
        <ProblemList
          doc={doc}
          problems={sorted.document}
          onChange={edit}
          heading={BUILDER_COPY.documentErrors}
        />
      )}
      {warned.document.length === 0 ? null : (
        <ProblemList
          doc={doc}
          problems={warned.document}
          onChange={edit}
          heading={BUILDER_COPY.documentWarnings}
          severity="warning"
        />
      )}
      {showJson ? (
        <pre
          aria-label={BUILDER_COPY.jsonLabel}
          className="max-h-80 overflow-auto rounded-xl bg-raised p-4 font-mono text-xs"
        >
          {JSON.stringify(doc, null, 2)}
        </pre>
      ) : null}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div ref={flowBox} className="min-w-0">
          <Flow
            doc={doc}
            selected={effective}
            problems={sorted}
            onSelect={select}
            onAdd={add}
          />
        </div>
        <aside className="flex min-w-0 flex-col gap-4">
          <Inspector
            doc={doc}
            pointer={effective}
            problems={sorted.byNode.get(effective) ?? []}
            profiles={profiles}
            lookup={lookup}
            headingRef={inspectorHeading}
            onChange={edit}
            onRemove={remove}
            onMove={move}
          />
          {(warned.byNode.get(effective) ?? []).length === 0 ? null : (
            <ProblemList
              doc={doc}
              problems={warned.byNode.get(effective) ?? []}
              onChange={edit}
              heading={BUILDER_COPY.warningsHeading}
              severity="warning"
            />
          )}
          <LaneCard
            doc={doc}
            version={saved.version}
            versions={saved.versions}
            onChange={edit}
          />
        </aside>
      </div>
    </div>
  );
}
