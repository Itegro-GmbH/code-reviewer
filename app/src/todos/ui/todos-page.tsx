// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The ToDos page (#925, prototype "1 ToDos with answer panel") and the ToDos tab of a project, which is the same list narrowed to the project: the
// open ToDos (questions of agents, reviews that are asked for), the done list, and next to them the panel to answer or review the one
// that is picked. The list is read from `GET /api/w/:workspace/todos` (or the project's) when the page opens and again slowly; what a person
// does here is posted to the routes that exist and the list is read again at once. Text from outside (the agent's question, titles) is
// rendered as text. A person who deals with a ToDo moves it out of the list at once; the sidebar's count is told to read again.
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { NativeSelect } from "../../components/native-select.tsx";
import { StatusRegion } from "../../components/status-region.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../../components/ui/empty.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import { TODOS_CHANGED_EVENT } from "../../shell/todo-count.tsx";
import { useProductIdentity } from "../../product-identity/context.tsx";
import { workspacePath } from "../../workspaces/paths.ts";
import type {
  DoneTodo,
  QuestionTodo,
  ReviewTodo,
  TodoList,
} from "../service.ts";
import { browserTodosApi, type TodosApi } from "./api.ts";
import { describeTodosFailure, TODO_COPY } from "./messages.ts";
import { Time } from "./panel-parts.tsx";
import { TodoPanel } from "./todo-panel.tsx";
import { useTodoList } from "./use-todo-list.ts";

type OpenTodo = QuestionTodo | ReviewTodo;

const PILL =
  "rounded-full border border-warning bg-warning-soft px-3 py-1 text-xs leading-4 font-semibold whitespace-nowrap text-warning";

/** The newest first, the questions and the reviews in one list. */
function openOf(list: TodoList): OpenTodo[] {
  return [...list.questions, ...list.reviews].sort((a, b) =>
    a.since < b.since ? 1 : a.since > b.since ? -1 : 0,
  );
}

function titleOf(todo: OpenTodo): string {
  return todo.kind === "question" ? todo.question : todo.title;
}

function subOf(todo: OpenTodo): string {
  const parts = [todo.repo ?? "Unknown repository"];
  if (todo.kind === "question" && todo.ticket !== null)
    parts.push(
      todo.ticket.title === null
        ? `#${String(todo.ticket.number)}`
        : `#${String(todo.ticket.number)} ${todo.ticket.title}`,
    );
  if (todo.kind === "review") parts.push(`#${String(todo.number)}`);
  parts.push(todo.lane ?? TODO_COPY.unknownLane);
  return parts.join(" · ");
}

function doneTitle(entry: DoneTodo): string {
  if (entry.kind === "question")
    return `${TODO_COPY.doneAnswered}: ${entry.question}`;
  return `${entry.outcome === "merged" ? TODO_COPY.doneMerged : TODO_COPY.doneClosed}: #${String(entry.number)} ${entry.title}`;
}

function doneSub(entry: DoneTodo): string {
  const where = entry.repo ?? "Unknown repository";
  if (entry.kind !== "question") return where;
  const by =
    entry.answer.by === null ? "" : ` ${TODO_COPY.doneBy} ${entry.answer.by}`;
  const via =
    entry.answer.via === "ui" ? TODO_COPY.viaPage : TODO_COPY.viaComment;
  return `${where}${by} (${via})`;
}

/** The repositories the ToDos are about, for the filter: one entry each, in the order they first appear. */
function repositoriesOf(list: TodoList): { id: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const entry of [...list.questions, ...list.reviews, ...list.done])
    if (!seen.has(entry.repositoryId))
      seen.set(entry.repositoryId, entry.repo ?? "Unknown repository");
  return [...seen].map(([id, name]) => ({ id, name }));
}

function Loading() {
  return (
    <div className="flex flex-col gap-2" data-slot="todos-loading">
      <StatusRegion label="Loading">{TODO_COPY.loading}</StatusRegion>
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}

function EmptyOpen({
  workspaceSlug,
  project,
}: {
  workspaceSlug: string;
  project: boolean;
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>
          {project ? TODO_COPY.projectEmptyTitle : TODO_COPY.emptyTitle}
        </EmptyTitle>
        <EmptyDescription>
          {project
            ? TODO_COPY.projectEmptyDescription
            : TODO_COPY.emptyDescription}
          {project ? null : (
            <>
              {" "}
              <Link href={workspacePath(workspaceSlug, "/projects")}>
                {TODO_COPY.toProjects}
              </Link>
            </>
          )}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function TodosPageContent({
  workspaceSlug,
  projectId,
  variant = "workspace",
  api,
}: {
  workspaceSlug: string;
  /** The project whose ToDos the list shows (the project's tab); none for the page of the workspace. */
  projectId?: string;
  variant?: "workspace" | "project";
  /** The calls the page makes; the real ones when not given. */
  api?: TodosApi;
}) {
  // A repository that is not a project yet has no ToDos and nothing to read.
  if (variant === "project" && projectId === undefined)
    return (
      <section className="flex flex-col gap-3">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{TODO_COPY.projectEmptyTitle}</EmptyTitle>
            <EmptyDescription>{TODO_COPY.noProject}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </section>
    );
  return (
    <TodosView
      workspaceSlug={workspaceSlug}
      projectId={projectId}
      project={variant === "project"}
      api={api}
    />
  );
}

function TodosView({
  workspaceSlug,
  projectId,
  project,
  api,
}: {
  workspaceSlug: string;
  projectId: string | undefined;
  project: boolean;
  api: TodosApi | undefined;
}) {
  const product = useProductIdentity();
  const calls = useMemo(
    () => api ?? browserTodosApi(workspaceSlug),
    [api, workspaceSlug],
  );
  const { state, refresh } = useTodoList(calls, projectId);
  const [picked, setPicked] = useState<OpenTodo | null>(null);
  const [filter, setFilter] = useState("");
  // The ToDos a person dealt with, hidden from the list they were dealt with in; a list read later is the truth again.
  const [handled, setHandled] = useState<{
    list: TodoList;
    ids: ReadonlySet<string>;
  } | null>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const listHeading = useRef<HTMLHeadingElement>(null);

  const list = state.status === "ready" ? state.list : null;
  const hidden =
    handled !== null && handled.list === list ? handled.ids : undefined;
  const repositories = useMemo(
    () => (list === null ? [] : repositoriesOf(list)),
    [list],
  );
  const activeFilter = repositories.some((entry) => entry.id === filter)
    ? filter
    : "";
  const open = useMemo(
    () =>
      list === null
        ? []
        : openOf(list).filter(
            (todo) =>
              (activeFilter === "" || todo.repositoryId === activeFilter) &&
              !(hidden?.has(todo.id) ?? false),
          ),
    [list, hidden, activeFilter],
  );
  const done =
    list === null
      ? []
      : list.done.filter(
          (entry) => activeFilter === "" || entry.repositoryId === activeFilter,
        );

  const fresh =
    picked === null || list === null
      ? undefined
      : openOf(list).find((todo) => todo.id === picked.id);

  function changed(todo: OpenTodo) {
    if (list !== null)
      setHandled({ list, ids: new Set([...(hidden ?? []), todo.id]) });
    void refresh().then(() => {
      window.dispatchEvent(new Event(TODOS_CHANGED_EVENT));
    });
  }

  function close() {
    const id = picked?.id;
    setPicked(null);
    // The focus goes back to the row that was picked, or to the list's heading when that row is gone.
    queueMicrotask(() => {
      const row = id === undefined ? undefined : rows.current.get(id);
      (row ?? listHeading.current)?.focus();
    });
  }

  return (
    <div className="flex flex-col gap-8">
      <div
        className={
          picked === null
            ? "flex flex-col gap-8"
            : "grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]"
        }
      >
        <div className="flex min-w-0 flex-col gap-8">
          <section aria-labelledby="todos-open" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2
                id="todos-open"
                ref={listHeading}
                tabIndex={-1}
                className="text-lg leading-7 font-semibold outline-none"
              >
                {TODO_COPY.open(open.length)}
              </h2>
              <p className="text-sm text-muted-foreground">
                {project ? TODO_COPY.projectHint : TODO_COPY.hint}
              </p>
            </div>
            {repositories.length > 1 ? (
              <div className="flex max-w-xs flex-col gap-1">
                <label htmlFor="todos-filter" className="text-sm font-semibold">
                  {TODO_COPY.filterLabel}
                </label>
                <NativeSelect
                  id="todos-filter"
                  value={activeFilter}
                  onChange={(event) => setFilter(event.target.value)}
                >
                  <option value="">{TODO_COPY.filterAll}</option>
                  {repositories.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            ) : null}
            {state.status === "loading" ? <Loading /> : null}
            {state.status === "error" ? (
              <Alert variant="destructive">
                <AlertDescription>
                  {TODO_COPY.loadFailed}{" "}
                  {describeTodosFailure(product, {
                    code: state.code,
                    status: state.httpStatus,
                  })}
                  {state.stopped ? "" : ` ${TODO_COPY.loadFailedHint}`}
                </AlertDescription>
              </Alert>
            ) : null}
            {state.status === "ready" && open.length === 0 ? (
              <EmptyOpen workspaceSlug={workspaceSlug} project={project} />
            ) : null}
            {open.length > 0 ? (
              <ul
                aria-label={TODO_COPY.listLabel}
                className="flex flex-col gap-2"
              >
                {open.map((todo) => (
                  <li key={todo.id}>
                    <button
                      type="button"
                      aria-pressed={picked?.id === todo.id}
                      ref={(node) => {
                        if (node === null) rows.current.delete(todo.id);
                        else rows.current.set(todo.id, node);
                      }}
                      onClick={() => setPicked(todo)}
                      data-todo-id={todo.id}
                      className={`flex w-full cursor-pointer flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 text-left transition-colors hover:bg-raised ${picked?.id === todo.id ? "border-warning bg-raised" : "border-border"}`}
                    >
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="flex gap-3 text-xs leading-4 font-semibold">
                          <span className="text-warning">
                            {todo.kind === "question"
                              ? TODO_COPY.kindQuestion
                              : TODO_COPY.kindReview}
                          </span>
                          <span className="font-normal text-muted-foreground">
                            {TODO_COPY.since} <Time iso={todo.since} />
                          </span>
                        </span>
                        <span className="line-clamp-2 font-semibold break-words">
                          {titleOf(todo)}
                        </span>
                        <span className="truncate text-sm text-muted-foreground">
                          {subOf(todo)}
                        </span>
                      </span>
                      <span className={PILL}>
                        {todo.kind === "question"
                          ? TODO_COPY.pillQuestion
                          : TODO_COPY.pillReview}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <StatusRegion label="Updating the ToDos">
              {state.status === "ready" && state.failed
                ? TODO_COPY.refreshFailed
                : ""}
            </StatusRegion>
          </section>

          <section aria-labelledby="todos-done" className="flex flex-col gap-3">
            <h2 id="todos-done" className="text-lg leading-7 font-semibold">
              {TODO_COPY.done(done.length)}
            </h2>
            {done.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {TODO_COPY.doneEmpty}
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {done.map((entry) => (
                  <li
                    key={entry.id + entry.at}
                    className="flex flex-wrap justify-between gap-x-3 gap-y-1 rounded-lg border border-border px-4 py-3 text-sm"
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="line-clamp-2 break-words">
                        {doneTitle(entry)}
                      </span>
                      <span className="truncate text-muted-foreground">
                        {doneSub(entry)}
                      </span>
                    </span>
                    <span className="text-muted-foreground">
                      <Time iso={entry.at} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {picked === null ? null : (
          <TodoPanel
            key={picked.id}
            todo={fresh ?? picked}
            open={fresh !== undefined}
            api={calls}
            onChanged={() => changed(picked)}
            onClose={close}
          />
        )}
      </div>
    </div>
  );
}
