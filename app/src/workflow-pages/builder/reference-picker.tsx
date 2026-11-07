// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The picker under a field (#927): search, the categories on the left, the values on the right with their name, type and a sample of the
// last run. It lists what the server says the step can reach (`POST .../workflows/scope`), nothing it works out itself. Keyboard: the
// search box has focus; arrow keys move through the values, Enter picks, Escape closes; Tab reaches the categories.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  REACH_CATEGORIES,
  REACH_CATEGORY_LABEL,
  type ReachCategory,
} from "../../workflows/reach-categories.ts";
import type { ReachEntry, ScopeAnswer } from "../../workflows/reach.ts";
import type { ReachLookup } from "./api.ts";
import { PICKER_COPY, describeTargetRule } from "./copy.ts";

type Choice = ReachCategory | "all";

type Loaded =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "ready"; answer: ScopeAnswer };

function matches(entry: ReachEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return [entry.reference, entry.name, entry.type, entry.sample ?? ""].some(
    (text) => text.toLowerCase().includes(needle),
  );
}

export function ReferencePicker({
  label,
  at,
  target,
  lookup,
  onPick,
  onClose,
}: {
  /** The name of the field, for the names a screen reader hears. */
  label: string;
  /** Pointer of the text the value goes into. */
  at: string;
  /** The roots a target field takes; left out for a field of free text. */
  target?: readonly string[];
  lookup: ReachLookup;
  onPick: (entry: ReachEntry) => void;
  /** `restoreFocus`: the person is done with the picker (Escape), so the field gets focus back. */
  onClose: (restoreFocus: boolean) => void;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [query, setQuery] = useState("");
  const [choice, setChoice] = useState<Choice | undefined>(undefined);
  const [active, setActive] = useState(0);
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  // What was asked when the picker opened: the list is a snapshot of that moment, however the document changes while it is open.
  const [asked] = useState({ lookup, at, target });

  useEffect(() => {
    const controller = new AbortController();
    const { lookup: ask, at: where, target: roots } = asked;
    void ask(
      { at: where, ...(roots === undefined ? {} : { targetRoots: roots }) },
      controller.signal,
    ).then((result) => {
      if (controller.signal.aborted) return;
      setLoaded(
        result.ok
          ? { state: "ready", answer: result.data }
          : { state: "failed" },
      );
    });
    return () => controller.abort();
  }, [asked]);

  useEffect(() => {
    search.current?.focus();
  }, []);

  const entries = useMemo(
    () => (loaded.state === "ready" ? loaded.answer.entries : []),
    [loaded],
  );
  const found = useMemo(
    () => entries.filter((entry) => matches(entry, query)),
    [entries, query],
  );
  const counts = useMemo(() => {
    const byCategory = new Map<ReachCategory, number>();
    for (const entry of found)
      byCategory.set(entry.category, (byCategory.get(entry.category) ?? 0) + 1);
    return byCategory;
  }, [found]);
  const categories = REACH_CATEGORIES.filter((each) => counts.has(each));
  // The first category that has values, until the person picks one; a choice that has nothing in it (after a search) shows everything.
  const selected: Choice =
    choice !== undefined && (choice === "all" || counts.has(choice))
      ? choice
      : (categories[0] ?? "all");
  const visible = found.filter(
    (entry) => selected === "all" || entry.category === selected,
  );
  const current = Math.min(active, Math.max(visible.length - 1, 0));
  const optionId = (at: number): string => `${listId}-option-${String(at)}`;

  useEffect(() => {
    document
      .getElementById(`${listId}-option-${String(current)}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [current, listId, visible.length]);

  const move = (to: number): void =>
    setActive(Math.max(0, Math.min(to, visible.length - 1)));

  const moveAmongCategories = (event: React.KeyboardEvent): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = Array.from(
      root.current?.querySelectorAll<HTMLButtonElement>(
        "[data-slot='category']",
      ) ?? [],
    );
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    event.preventDefault();
    buttons[
      Math.max(
        0,
        Math.min(at + (event.key === "ArrowDown" ? 1 : -1), buttons.length - 1),
      )
    ]?.focus();
  };

  const body =
    loaded.state === "loading" ? (
      <p role="status" className="p-3 text-sm text-muted-foreground">
        {PICKER_COPY.loading}
      </p>
    ) : loaded.state === "failed" ? (
      <p role="alert" className="p-3 text-sm text-destructive">
        {PICKER_COPY.failed}
      </p>
    ) : null;

  const categoryButton = (key: Choice, text: string, count: number) => (
    <button
      key={key}
      type="button"
      data-slot="category"
      aria-pressed={selected === key}
      onClick={() => {
        setChoice(key);
        setActive(0);
        search.current?.focus();
      }}
      className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm aria-pressed:bg-raised aria-pressed:font-semibold hover:bg-raised"
    >
      <span className="min-w-0 truncate">{text}</span>
      <span className="text-xs text-muted-foreground">{count}</span>
    </button>
  );

  return (
    <div
      ref={root}
      role="dialog"
      aria-label={PICKER_COPY.dialog(label)}
      data-slot="reference-picker"
      className="absolute top-full right-0 left-0 z-20 mt-1 flex flex-col rounded-xl border border-line-strong bg-surface shadow-lg"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose(true);
        }
        moveAmongCategories(event);
      }}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && !event.currentTarget.contains(next))
          onClose(false);
      }}
    >
      <div className="border-b border-line p-2">
        <input
          ref={search}
          type="search"
          role="combobox"
          aria-label={PICKER_COPY.search}
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          {...(visible.length > 0
            ? { "aria-activedescendant": optionId(current) }
            : {})}
          value={query}
          placeholder={PICKER_COPY.search}
          className="h-9 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-sm"
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            if (event.target.value.trim() !== "") setChoice("all");
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              move(current + 1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              move(current - 1);
            } else if (event.key === "Enter") {
              event.preventDefault();
              const entry = visible[current];
              if (entry !== undefined) onPick(entry);
            }
          }}
        />
      </div>
      {body}
      {loaded.state === "ready" ? (
        <div className="grid min-h-0 grid-cols-[minmax(0,8.5rem)_minmax(0,1fr)]">
          <div
            role="group"
            aria-label={PICKER_COPY.categories}
            className="flex flex-col gap-1 border-r border-line p-2"
          >
            {categoryButton("all", PICKER_COPY.all, found.length)}
            {categories.map((each) =>
              categoryButton(
                each,
                REACH_CATEGORY_LABEL[each],
                counts.get(each) ?? 0,
              ),
            )}
          </div>
          <ul
            id={listId}
            role="listbox"
            aria-label={PICKER_COPY.values}
            className="flex max-h-64 flex-col gap-1 overflow-y-auto p-2"
          >
            {visible.map((entry, at) => (
              <li
                key={entry.reference}
                id={optionId(at)}
                role="option"
                aria-selected={at === current}
                data-reference={entry.reference}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => setActive(at)}
                onClick={() => onPick(entry)}
                className="flex cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 text-sm aria-selected:bg-raised"
              >
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-semibold break-all">
                    {selected === "all" && entry.category !== "steps"
                      ? `${REACH_CATEGORY_LABEL[entry.category]} · ${entry.name}`
                      : entry.name}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {entry.type}
                  </span>
                </span>
                {entry.sample === undefined ? null : (
                  <span className="text-xs break-words text-muted-foreground">
                    {PICKER_COPY.sample}: {entry.sample}
                  </span>
                )}
              </li>
            ))}
            {visible.length === 0 ? (
              <li
                role="presentation"
                className="px-2 py-1.5 text-sm text-muted-foreground"
              >
                {query.trim() === ""
                  ? PICKER_COPY.empty
                  : PICKER_COPY.noMatch(query.trim())}
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
      <div
        data-slot="picker-footer"
        className="flex flex-col gap-1 border-t border-line p-2 text-xs text-muted-foreground"
      >
        {target === undefined ? null : <p>{describeTargetRule(target)}</p>}
        {loaded.state === "ready" ? (
          <p>
            {loaded.answer.sampled
              ? PICKER_COPY.sampled
              : PICKER_COPY.notSampled}
            {loaded.answer.truncated ? ` ${PICKER_COPY.truncated}` : ""}
          </p>
        ) : null}
      </div>
    </div>
  );
}
