// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The answer to a question of an agent (#925), in the panel next to the list: the question shown like a comment (the agent's words as text,
// its context), the options as choices, a note, and "Answer", which posts through the route of the run that exists (the same one the
// run page uses: `{ question: { stepRunId, n }, choice?, text? }`), in the name of the signed in person. One answer at a time (a second click
// while one is on its way does nothing), the refusals of the route in words, and a question that is not the open one any more says so and
// reads the list again.
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../../components/button.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { useProductIdentity } from "../../product-identity/context.tsx";
import { formatUsd } from "../../workflow-pages/view.ts";
import type { QuestionTodo } from "../service.ts";
import type { TodosApi } from "./api.ts";
import {
  ANSWER_MAX,
  describeAnswerFailure,
  PANEL_COPY,
  STALE_ANSWER_CODES,
} from "./messages.ts";
import { ExternalLink, Time } from "./panel-parts.tsx";

export function AnswerForm({
  todo,
  open,
  api,
  onChanged,
}: {
  todo: QuestionTodo;
  /** The question is still on the list the page reads. */
  open: boolean;
  api: TodosApi;
  /** Something changed on the server (an answer went, or the question is not the open one): the page reads the list again. */
  onChanged: () => void;
}) {
  const product = useProductIdentity();
  const noteId = useId();
  const hintId = useId();
  const [choice, setChoice] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // A click is counted before the state shows it: two clicks in one frame post once.
  const posting = useRef(false);
  const resultRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (sent) resultRef.current?.focus();
  }, [sent]);

  const hasOptions = todo.options.length > 0;
  const ready = choice !== null || note.trim() !== "";
  const canAnswer = open && !sent;

  async function send() {
    if (posting.current || !ready) return;
    posting.current = true;
    setPending(true);
    setProblem(null);
    const result = await api.answer(todo.workflowId, todo.runId, {
      question: { stepRunId: todo.stepRunId, n: todo.n },
      ...(choice === null ? {} : { choice }),
      ...(note.trim() === "" ? {} : { text: note }),
    });
    posting.current = false;
    setPending(false);
    if (result.ok) {
      setSent(true);
      onChanged();
      return;
    }
    setProblem(describeAnswerFailure(product, result));
    if (STALE_ANSWER_CODES.includes(result.code)) onChanged();
  }

  return (
    <div className="flex flex-col gap-5">
      {/* The question as a comment: who asks, where, and the agent's words. They are the agent's text: rendered as text and nothing else. */}
      <div
        data-slot="todo-question"
        className="flex flex-col gap-2 rounded-xl border border-border bg-raised p-4 text-sm"
      >
        <p className="text-xs text-muted-foreground">
          <b className="text-foreground">{PANEL_COPY.agent}</b>
          {todo.lane === null ? null : ` · ${todo.lane}`}
          {todo.repo === null ? null : ` · ${todo.repo}`}
        </p>
        <p className="break-words whitespace-pre-wrap">{todo.question}</p>
        {todo.context === null ? null : (
          <p className="break-words whitespace-pre-wrap text-muted-foreground">
            {todo.context}
          </p>
        )}
      </div>
      <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">{PANEL_COPY.lane}</dt>
        <dd className="font-semibold break-words">
          {todo.lane ?? "Archived lane"}
        </dd>
        <dt className="text-muted-foreground">{PANEL_COPY.spent}</dt>
        <dd className="font-semibold">
          {formatUsd(todo.spentUsd)} of {formatUsd(todo.budgetUsd)}
        </dd>
        <dt className="text-muted-foreground">Waits since</dt>
        <dd className="font-semibold">
          <Time iso={todo.since} />
        </dd>
        {todo.ticket === null ? null : (
          <>
            <dt className="text-muted-foreground">{PANEL_COPY.ticket}</dt>
            <dd className="font-semibold break-words">
              <ExternalLink href={todo.ticket.url}>
                #{todo.ticket.number}
              </ExternalLink>
              {todo.ticket.title === null ? null : ` ${todo.ticket.title}`}
            </dd>
          </>
        )}
      </dl>

      {canAnswer ? (
        <form
          className="flex flex-col gap-3 border-t border-border pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <fieldset
            className="flex flex-col gap-2"
            disabled={pending}
            aria-describedby={hintId}
          >
            <legend className="pb-2 text-sm font-semibold">
              {PANEL_COPY.optionsLegend}
            </legend>
            {todo.options.map((option, index) => (
              <label
                key={`${String(index)}-${option}`}
                className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 text-sm has-[:checked]:border-foreground has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
              >
                <input
                  type="radio"
                  name={`${noteId}-choice`}
                  value={index + 1}
                  checked={choice === index + 1}
                  onChange={() => setChoice(index + 1)}
                  className="mt-0.5 size-4 shrink-0 accent-primary"
                />
                <span className="break-words">
                  <span className="text-muted-foreground">{index + 1}. </span>
                  {option}
                </span>
              </label>
            ))}
            <label htmlFor={noteId} className="pt-1 text-sm font-semibold">
              {hasOptions ? PANEL_COPY.noteLabel : PANEL_COPY.noteLabelOnly}
            </label>
            <Textarea
              id={noteId}
              rows={3}
              value={note}
              maxLength={ANSWER_MAX}
              placeholder={PANEL_COPY.notePlaceholder}
              onChange={(event) => setNote(event.target.value)}
            />
          </fieldset>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="submit"
              loading={pending}
              loadingLabel={PANEL_COPY.sending}
              disabled={!ready}
            >
              {PANEL_COPY.answer}
            </Button>
            <span id={hintId} className="text-xs text-muted-foreground">
              {ready ? "" : PANEL_COPY.needChoice}
            </span>
          </div>
          {problem === null ? null : (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          )}
          <p className="text-xs text-muted-foreground">{PANEL_COPY.footnote}</p>
        </form>
      ) : (
        <div className="flex flex-col gap-2 border-t border-border pt-4 text-sm">
          {sent ? (
            <p
              ref={resultRef}
              tabIndex={-1}
              role="status"
              className="font-semibold outline-none"
            >
              {PANEL_COPY.sent}
            </p>
          ) : (
            <p role="status">{PANEL_COPY.gone}</p>
          )}
          {problem === null ? null : (
            <p role="alert" className="text-destructive">
              {problem}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
