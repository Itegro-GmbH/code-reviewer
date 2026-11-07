// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The lane builder (#926): the flow on the left, the inspector and the lane card on the right, the state of the validator and the
// buttons on top. The document is the one state: every edit makes a new document, and every new document is sent to the validate route
// (after a short pause) so the red counts and the header follow the edit. "Save as vN" is on only for a document the validator has
// accepted *as it stands* and that differs from the saved one; the save route validates again. Nothing is stored before that.
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
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
  type ValidateAnswer,
} from "./api.ts";
import { BUILDER_COPY, describeSaveFailure } from "./copy.ts";
import {
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
import { sortProblems } from "./problems.ts";

type Checked = {
  doc: Doc;
  /** `undefined`: the validator could not be asked. */
  answer: ValidateAnswer | undefined;
};

type Saved = { doc: Doc; version: number; versions: VersionEntry[] };

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
      : { doc: initial, version, versions: [...versions] },
  );
  const [selected, setSelected] = useState<Pointer>(
    initial === undefined ? "" : firstPointer(initial),
  );
  const [showJson, setShowJson] = useState(false);
  const [checked, setChecked] = useState<Checked | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    if (doc === undefined) return;
    let stale = false;
    const timer = setTimeout(() => {
      void calls.validate(doc).then((result) => {
        if (stale) return;
        setChecked({ doc, answer: result.ok ? result.data : undefined });
      });
    }, validateDelayMs);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [calls, doc, validateDelayMs]);

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
  const effective =
    nodeAt(doc, selected) === undefined ? firstPointer(doc) : selected;
  const budget =
    answer?.budgetUsd ??
    (typeof doc.budgetUsd === "number" ? doc.budgetUsd : BUDGET_DEFAULT_USD);

  const edit = (next: Doc): void => {
    setDoc(next);
    setJustSaved(false);
    setSaveError(undefined);
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
    setSelected(inserted.pointer);
  };

  const remove = (): void => {
    const removed = removeNode(doc, effective);
    edit(removed.doc);
    setSelected(removed.selection);
  };

  const move = (direction: -1 | 1): void => {
    const moved = moveNode(doc, effective, direction);
    edit(moved.doc);
    setSelected(moved.pointer);
  };

  const save = async (): Promise<void> => {
    if (!valid || !dirty || saving) return;
    const body = doc;
    setSaving(true);
    setSaveError(undefined);
    const result = await calls.save(workflowId, body, saved.version);
    setSaving(false);
    if (!result.ok) {
      setSaveError(describeSaveFailure(product, result));
      return;
    }
    const { workflow } = result.data;
    setSaved({
      doc: body,
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
        <div role="status" aria-live="polite" data-slot="validity">
          {status}
        </div>
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
      {showJson ? (
        <pre
          aria-label={BUILDER_COPY.jsonLabel}
          className="max-h-80 overflow-auto rounded-xl bg-raised p-4 font-mono text-xs"
        >
          {JSON.stringify(doc, null, 2)}
        </pre>
      ) : null}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <Flow
          doc={doc}
          selected={effective}
          problems={sorted}
          onSelect={setSelected}
          onAdd={add}
        />
        <aside className="flex min-w-0 flex-col gap-4">
          <Inspector
            doc={doc}
            pointer={effective}
            problems={sorted.byNode.get(effective) ?? []}
            documentProblems={sorted.document}
            profiles={profiles}
            onChange={edit}
            onRemove={remove}
            onMove={move}
          />
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
