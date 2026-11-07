// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The question an agent step asked (#920), on the page of the run: the question as the text it is (the agent wrote it), the numbered options and
// the context, and, while the step waits, the way to answer: a button for each option (a note typed below goes with it), or a text of one's own.
// Once it is answered the page says who answered, what, and where from. The answer goes to the route of the run; the page's own polling shows
// that the run goes on (a waiting run is polled like a running one). A question that was answered on the ticket shows up the same way, from the
// next poll on.
import { useId, useState } from "react";
import { Button } from "../components/button.tsx";
import { Textarea } from "../components/ui/textarea.tsx";
import { useProductIdentity } from "../product-identity/context.tsx";
import type { StepView } from "../workflow-runs/service.ts";
import type { WorkflowRunsApi } from "./api.ts";
import { describeStartFailure, PAGE_COPY } from "./messages.ts";

export function AskBlock({
  step,
  workflowId,
  runId,
  api,
}: {
  step: StepView;
  workflowId: string;
  runId: string;
  api: WorkflowRunsApi;
}) {
  const product = useProductIdentity();
  const noteId = useId();
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { ask } = step;
  if (ask === null) return null;
  const open = step.status === "waiting" && ask.state === "open" && !sent;

  async function send(choice: number | undefined) {
    setPending(true);
    setProblem(null);
    const result = await api.answer(workflowId, runId, {
      ...(choice === undefined ? {} : { choice }),
      ...(note.trim() === "" ? {} : { text: note }),
    });
    setPending(false);
    if (result.ok) setSent(true);
    else setProblem(describeStartFailure(product, result));
  }

  return (
    <div
      data-slot="step-ask"
      data-state={sent ? "answered" : ask.state}
      className="flex flex-col gap-3 rounded-lg border border-border bg-raised p-3 text-sm"
    >
      <h4 className="font-semibold">{PAGE_COPY.askHeading}</h4>
      {/* The question, the options and the context are the agent's text: rendered as text and nothing else. */}
      <p
        data-slot="step-ask-question"
        className="break-words whitespace-pre-wrap"
      >
        {ask.question}
      </p>
      {ask.context === undefined ? null : (
        <p className="break-words whitespace-pre-wrap text-muted-foreground">
          {ask.context}
        </p>
      )}
      {ask.options === undefined ? null : (
        <ol className="flex list-decimal flex-col gap-2 pl-5">
          {ask.options.map((option, index) => (
            <li key={option} data-slot="step-ask-option">
              <span className="break-words">{option}</span>
              {open ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="ml-2"
                  disabled={pending}
                  onClick={() => void send(index + 1)}
                >
                  {PAGE_COPY.askChoose} {index + 1}
                </Button>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {open ? (
        <div className="flex flex-col gap-2">
          <label htmlFor={noteId} className="text-muted-foreground">
            {ask.options === undefined
              ? PAGE_COPY.askAnswerLabel
              : PAGE_COPY.askNoteLabel}
          </label>
          <Textarea
            id={noteId}
            value={note}
            maxLength={4000}
            onChange={(event) => setNote(event.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              loading={pending}
              loadingLabel={PAGE_COPY.askSending}
              disabled={note.trim() === ""}
              onClick={() => void send(undefined)}
            >
              {PAGE_COPY.askSend}
            </Button>
            <span className="text-muted-foreground">
              {PAGE_COPY.askWaitingHint}
            </span>
          </div>
          {problem === null ? null : (
            <p
              data-slot="step-ask-failure"
              role="alert"
              className="text-destructive"
            >
              {problem}
            </p>
          )}
        </div>
      ) : sent ? (
        <p data-slot="step-ask-sent" role="status">
          {PAGE_COPY.askSent}
        </p>
      ) : ask.answer === undefined ? null : (
        <p
          data-slot="step-ask-answer"
          className="break-words whitespace-pre-wrap"
        >
          {ask.answer.by === null
            ? PAGE_COPY.askAnswered
            : `${PAGE_COPY.askAnsweredBy} ${ask.answer.by}`}
          {" ("}
          {ask.answer.via === "ui"
            ? PAGE_COPY.askViaPage
            : PAGE_COPY.askViaComment}
          {"): "}
          {ask.answer.text}
        </p>
      )}
    </div>
  );
}
