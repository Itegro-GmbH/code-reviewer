// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// A review that is asked for (#925), in the panel next to the list: the pull request (title as text, a link to it on GitHub), who is asked,
// an optional note, and "Approve" or "Request changes", which post through `POST /api/w/:workspace/todos/reviews`: the GitHub App
// submits the review in the name of the person (docs/todos.md). The answer says which of the three things happened (a review, the same
// review as before, or a comment, because GitHub does not let an App review a pull request it opened itself). One decision at a time.
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../../components/button.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { useProductIdentity } from "../../product-identity/context.tsx";
import type { ReviewDecision, ReviewOutcome } from "../review.ts";
import type { ReviewTodo } from "../service.ts";
import type { TodosApi } from "./api.ts";
import {
  describeTodosFailure,
  PANEL_COPY,
  REVIEW_COPY,
  REVIEW_NOTE_MAX,
} from "./messages.ts";
import { ExternalLink, Time } from "./panel-parts.tsx";

type Done = { decision: ReviewDecision; outcome: ReviewOutcome };

export function ReviewForm({
  todo,
  open,
  api,
  onChanged,
}: {
  todo: ReviewTodo;
  /** The review is still on the list the page reads. */
  open: boolean;
  api: TodosApi;
  /** Something changed on the server: the page reads the list again. */
  onChanged: () => void;
}) {
  const product = useProductIdentity();
  const noteId = useId();
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<ReviewDecision | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const posting = useRef(false);
  const resultRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (done !== null) resultRef.current?.focus();
  }, [done]);

  async function decide(decision: ReviewDecision) {
    if (posting.current) return;
    posting.current = true;
    setPending(decision);
    setProblem(null);
    const result = await api.review({
      repositoryId: todo.repositoryId,
      number: todo.number,
      decision,
      ...(note.trim() === "" ? {} : { comment: note }),
    });
    posting.current = false;
    setPending(null);
    if (result.ok) {
      setDone({ decision, outcome: result.data });
      onChanged();
      return;
    }
    setProblem(describeTodosFailure(product, result));
    // The request is not there any more: the list says so.
    if (result.code === "TODOS_REVIEW_NOT_REQUESTED") onChanged();
  }

  const canDecide = open && done === null;
  const outcome = done?.outcome;

  return (
    <div className="flex flex-col gap-5">
      <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">{REVIEW_COPY.repository}</dt>
        <dd className="font-semibold break-words">{todo.repo ?? "Unknown"}</dd>
        <dt className="text-muted-foreground">{REVIEW_COPY.pullRequest}</dt>
        <dd className="font-semibold break-words">
          <ExternalLink href={todo.url}>#{todo.number}</ExternalLink>
          {` ${todo.title}`}
        </dd>
        <dt className="text-muted-foreground">{PANEL_COPY.lane}</dt>
        <dd className="font-semibold break-words">
          {todo.lane ?? "Archived lane"}
        </dd>
        <dt className="text-muted-foreground">{REVIEW_COPY.checks}</dt>
        <dd className="font-semibold break-words">
          {todo.checksState ?? REVIEW_COPY.checksUnknown}
        </dd>
        <dt className="text-muted-foreground">Last change</dt>
        <dd className="font-semibold">
          <Time iso={todo.since} />
        </dd>
      </dl>
      <p className="text-sm text-muted-foreground">
        {todo.audience === "you"
          ? REVIEW_COPY.askedOfYou
          : REVIEW_COPY.askedOfMembers}
      </p>
      {todo.url === null ? null : (
        <p className="text-sm">
          <ExternalLink href={todo.url}>
            {REVIEW_COPY.openPullRequest}
          </ExternalLink>
        </p>
      )}

      {canDecide ? (
        <form
          className="flex flex-col gap-3 border-t border-border pt-4"
          onSubmit={(event) => event.preventDefault()}
        >
          <label htmlFor={noteId} className="text-sm font-semibold">
            {REVIEW_COPY.noteLabel}
          </label>
          <Textarea
            id={noteId}
            rows={3}
            value={note}
            maxLength={REVIEW_NOTE_MAX}
            placeholder={REVIEW_COPY.notePlaceholder}
            disabled={pending !== null}
            onChange={(event) => setNote(event.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              loading={pending === "approve"}
              loadingLabel={REVIEW_COPY.sending}
              disabled={pending !== null}
              onClick={() => void decide("approve")}
            >
              {REVIEW_COPY.approve}
            </Button>
            <Button
              variant="secondary"
              loading={pending === "request_changes"}
              loadingLabel={REVIEW_COPY.sending}
              disabled={pending !== null}
              onClick={() => void decide("request_changes")}
            >
              {REVIEW_COPY.requestChanges}
            </Button>
          </div>
          {problem === null ? null : (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {REVIEW_COPY.footnote}
          </p>
        </form>
      ) : (
        <div
          data-slot="review-result"
          className="flex flex-col gap-2 border-t border-border pt-4 text-sm"
        >
          {done === null ? (
            <p role="status">{REVIEW_COPY.gone}</p>
          ) : (
            <p
              ref={resultRef}
              tabIndex={-1}
              role="status"
              className="font-semibold outline-none"
            >
              {outcome?.outcome === "already_there"
                ? REVIEW_COPY.alreadyThere
                : outcome?.outcome === "commented"
                  ? REVIEW_COPY.commented
                  : REVIEW_COPY.submitted(done.decision)}
            </p>
          )}
          {outcome?.outcome === "commented" ? (
            <p>
              <ExternalLink href={outcome.url}>
                {REVIEW_COPY.openComment}
              </ExternalLink>
            </p>
          ) : null}
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
