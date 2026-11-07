// SPDX-License-Identifier: LicenseRef-Proprietary

// A review given from the ToDo list (#924): approve or request changes on a pull request a lane opened and a review is asked for, as a
// review of the GitHub App in the name of the person ("Review by @login"), with a token limited to that one repository and the pull
// request permission (`submitReviewVerdict`, #405). Only a pull request that is a ToDo of the person can be reviewed from here: the
// service looks it up first, so the route is no way to review any pull request of a repository.
//
//  - The review is idempotent: its marker names the pull request, the commit and the person, so a repeat finds the review that is there
//    and posts nothing twice (`already_there`). A new commit is a new review.
//  - GitHub does not let an App approve or ask for changes on a pull request it opened itself, and a lane opens its pull requests as the
//    App. That refusal is not an error here: the decision is written as a comment of the App with the same attribution and the same
//    marker (`commented`), so the record is on the pull request either way.
//  - Asking for changes does not start a turn of the implementer session: the session of the run has ended by the time a pull request
//    is reviewed, and continuing it on a fresh sandbox is the resumable session of the cockpit (#915), not part of this action.
import { IntegrationError } from "../integrations/errors.ts";
import type { GithubActionTarget } from "../workflow-runs/github-connectors.ts";
import { safeText } from "../workflow-runs/ask-comment.ts";
import { TodosError, type TodosRequestIssue } from "./errors.ts";
import type { TodosService, TodoViewer } from "./service.ts";

export const REVIEW_DECISIONS = ["approve", "request_changes"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export const REVIEW_COMMENT_MAX_CHARS = 4000;
const MAX_ID_LENGTH = 128;

export type ReviewInput = {
  repositoryId: string;
  number: number;
  decision: ReviewDecision;
  /** A note that goes with the decision; empty when there is none. */
  comment: string;
};

export type ReviewOutcome =
  /** The App's review was submitted. */
  | { outcome: "submitted"; reviewId: string }
  /** The same review was submitted before. */
  | { outcome: "already_there"; reviewId: string }
  /** GitHub refused a review of the App's own pull request; the decision stands as a comment. */
  | { outcome: "commented"; url: string };

/** The body of a review request as the action takes it, or every problem of it (`path`, `code`, `message`, `available`). */
export function readReviewInput(
  body: unknown,
):
  | { ok: true; value: ReviewInput }
  | { ok: false; issues: TodosRequestIssue[] } {
  const issues: TodosRequestIssue[] = [];
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return {
      ok: false,
      issues: [
        {
          path: "",
          code: "invalid",
          message: "The body must be a JSON object.",
        },
      ],
    };
  const given = body as Record<string, unknown>;
  const known = ["repositoryId", "number", "decision", "comment"];
  for (const key of Object.keys(given))
    if (!known.includes(key))
      issues.push({
        path: key,
        code: "invalid",
        message: `"${key.slice(0, 40)}" is not a field of a review.`,
        available: known,
      });

  const { repositoryId, number, decision, comment } = given;
  if (repositoryId === undefined)
    issues.push({
      path: "repositoryId",
      code: "required",
      message: "repositoryId is required.",
    });
  else if (
    typeof repositoryId !== "string" ||
    repositoryId.trim() === "" ||
    repositoryId.length > MAX_ID_LENGTH
  )
    issues.push({
      path: "repositoryId",
      code: "invalid",
      message: "repositoryId must be the id of a repository.",
    });
  if (number === undefined)
    issues.push({
      path: "number",
      code: "required",
      message: "number is required.",
    });
  else if (!Number.isSafeInteger(number) || (number as number) < 1)
    issues.push({
      path: "number",
      code: "invalid",
      message:
        "number must be the number of a pull request (a whole number from 1).",
    });
  if (decision === undefined)
    issues.push({
      path: "decision",
      code: "required",
      message: "decision is required.",
      available: REVIEW_DECISIONS,
    });
  else if (!(REVIEW_DECISIONS as readonly unknown[]).includes(decision))
    issues.push({
      path: "decision",
      code: "invalid",
      message: `decision must be one of ${REVIEW_DECISIONS.join(", ")}.`,
      available: REVIEW_DECISIONS,
    });
  if (comment !== undefined) {
    if (typeof comment !== "string")
      issues.push({
        path: "comment",
        code: "invalid",
        message: "comment must be a text.",
      });
    else if (comment.length > REVIEW_COMMENT_MAX_CHARS)
      issues.push({
        path: "comment",
        code: "too_long",
        message: `comment must be at most ${String(REVIEW_COMMENT_MAX_CHARS)} characters.`,
      });
  }
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      repositoryId: repositoryId as string,
      number: number as number,
      decision: decision as ReviewDecision,
      comment: typeof comment === "string" ? comment : "",
    },
  };
}

export type ReviewActionsDependencies = {
  todos: Pick<TodosService, "findReview">;
  /** The connection and the repository of a repository id; undefined when the repository or its connection is gone. */
  targetOf(repositoryId: string): Promise<GithubActionTarget | undefined>;
  /** Receives the line about a failure of GitHub (its code only). Default: console.error. */
  log?: (line: string) => void;
};

export type ReviewActions = {
  /** Throws a `TodosError`. */
  submit(viewer: TodoViewer, input: ReviewInput): Promise<ReviewOutcome>;
};

const WORDS: Record<ReviewDecision, string> = {
  approve: "Approved",
  request_changes: "Changes requested",
};

export function createReviewActions(
  deps: ReviewActionsDependencies,
): ReviewActions {
  const log = deps.log ?? ((line: string) => console.error(line));
  return {
    async submit(viewer, input) {
      const todo = await deps.todos.findReview(
        viewer,
        input.repositoryId,
        input.number,
      );
      if (todo === undefined)
        throw new TodosError(
          "TODOS_REVIEW_NOT_REQUESTED",
          "No review is asked of you, or of the members, for this pull request of a lane.",
        );
      const target = await deps.targetOf(input.repositoryId);
      const submitReview = target?.provider.submitReviewVerdict?.bind(
        target.provider,
      );
      const writeComment = target?.provider.commentOnIssue?.bind(
        target.provider,
      );
      if (
        target === undefined ||
        submitReview === undefined ||
        writeComment === undefined
      )
        throw new TodosError(
          "TODOS_GITHUB_UNAVAILABLE",
          "The repository has no active GitHub connection that can review.",
        );
      const { provider, integration, repo } = target;
      // The login GitHub knows the person by, or nothing: an email never goes onto a pull request.
      const login = viewer.githubLogin?.replace(/[^A-Za-z0-9-]/g, "") ?? "";
      const by = login === "" ? "a member of the workspace" : `@${login}`;
      try {
        const pullRequest = await provider.getPullRequest(
          integration,
          repo,
          input.number,
        );
        if (pullRequest.state !== "open")
          throw new TodosError(
            "TODOS_REVIEW_NOT_REQUESTED",
            "The pull request is not open any more.",
          );
        const marker = `<!-- factory todo-review pr=${String(input.number)} sha=${pullRequest.headSha} by=${login === "" ? "member" : login} event=${input.decision} -->`;
        const note = safeText(input.comment, REVIEW_COMMENT_MAX_CHARS);
        const body = [
          marker,
          `Review by ${by}: ${WORDS[input.decision]}`,
          ...(note === "" ? [] : ["", note]),
        ].join("\n");
        try {
          const submitted = await submitReview(
            integration,
            repo,
            input.number,
            {
              jobId: `todo:${String(input.number)}`,
              headSha: pullRequest.headSha,
              event: input.decision,
              body,
              marker,
            },
            { lookForEarlier: true },
          );
          return {
            outcome: submitted.outcome,
            reviewId: submitted.reviewId,
          };
        } catch (error) {
          if (
            !(error instanceof IntegrationError) ||
            error.code !== "INTEGRATION_REQUEST_REFUSED"
          )
            throw error;
        }
        const commented = await writeComment(
          integration,
          repo,
          input.number,
          [
            body,
            "",
            "_GitHub does not let the App review a pull request it opened itself, so the decision is written down here._",
          ].join("\n"),
          { marker },
        );
        return { outcome: "commented", url: commented.url };
      } catch (error) {
        if (error instanceof TodosError) throw error;
        log(
          `[todos] review of pull request ${String(input.number)} failed (${error instanceof IntegrationError ? error.code : error instanceof Error ? error.name : "unknown"})`,
        );
        throw new TodosError(
          "TODOS_REVIEW_FAILED",
          "GitHub could not be asked, or refused. Nothing was changed; try again.",
        );
      }
    },
  };
}
