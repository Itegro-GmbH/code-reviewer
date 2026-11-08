// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The panel next to the ToDo list (#925, prototype "1 ToDos with answer panel"): a labelled region with the kind and the title of the ToDo, a
// close button, and the answer form of a question or the review form of a review. Focus goes to its heading when it opens, so a
// keyboard or screen reader user lands in it; closing it is the page's, which gives the focus back to the row.
import { useEffect, useId, useRef } from "react";
import { XIcon } from "@phosphor-icons/react/dist/ssr";
import { Button } from "../../components/button.tsx";
import type { QuestionTodo, ReviewTodo } from "../service.ts";
import type { TodoActor } from "./actor.ts";
import type { TodosApi } from "./api.ts";
import { AnswerForm } from "./answer-panel.tsx";
import { PANEL_COPY, TODO_COPY } from "./messages.ts";
import { ReviewForm } from "./review-panel.tsx";

export function TodoPanel({
  todo,
  open,
  actor,
  api,
  onChanged,
  onClose,
}: {
  todo: QuestionTodo | ReviewTodo;
  /** The ToDo is still on the list. */
  open: boolean;
  actor: TodoActor;
  api: TodosApi;
  onChanged: () => void;
  onClose: () => void;
}) {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const isQuestion = todo.kind === "question";
  return (
    <aside
      aria-labelledby={headingId}
      data-slot="todo-panel"
      className="flex min-w-0 flex-col gap-5 rounded-xl border border-border p-5 lg:sticky lg:top-4 lg:self-start"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-xs font-semibold text-warning">
            {isQuestion ? TODO_COPY.kindQuestion : TODO_COPY.kindReview}
            {todo.repo === null ? null : (
              <span className="font-normal text-muted-foreground">
                {` · ${todo.repo}`}
              </span>
            )}
          </span>
          <h2
            id={headingId}
            ref={headingRef}
            tabIndex={-1}
            className="text-lg leading-7 font-semibold break-words outline-none"
          >
            {isQuestion
              ? (todo.ticket?.title ?? PANEL_COPY.questionHeading)
              : todo.title}
          </h2>
        </div>
        <Button
          variant="secondary"
          size="icon"
          aria-label={PANEL_COPY.close}
          onClick={onClose}
        >
          <XIcon aria-hidden="true" />
        </Button>
      </div>
      {todo.kind === "question" ? (
        <AnswerForm
          todo={todo}
          open={open}
          actor={actor}
          api={api}
          onChanged={onChanged}
        />
      ) : (
        <ReviewForm
          todo={todo}
          open={open}
          actor={actor}
          api={api}
          onChanged={onChanged}
        />
      )}
    </aside>
  );
}
