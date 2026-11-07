// SPDX-License-Identifier: LicenseRef-Proprietary

// What a verified GitHub delivery says about the ticket mirror (#923): the `issues`, `issue_comment`, `pull_request`, `sub_issues`,
// `projects_v2_item` and `check_suite` events as a `TrackerChange`. A pure translation: it reads the fields of `TRACKER_WEBHOOK_FIELDS`
// (and the ticket objects through `toTrackerItem`) and decides nothing about the workspace; the mirror applies the change. A delivery that
// lacks what the mirror needs is `invalid_payload` (named by path, never by value) and does not harm anything else the delivery does.
import type {
  RepoRef,
  TrackerChange,
  TrackerChangeResult,
} from "../../types.ts";
import { toTrackerItem } from "./tracker-map.ts";
import {
  field,
  isTrackerWebhookEvent,
  rawField,
  specProblems,
  TRACKER_WEBHOOK_FIELDS,
} from "./webhook-fields.ts";

export type TrackerParseContext = {
  integrationId: string;
  /** The event name from the `X-GitHub-Event` header. */
  eventName: string;
  payload: unknown;
};

/** The pull request actions that change the commit: what the checks said about the old one no longer holds. */
const COMMIT_ACTIONS: ReadonlySet<string> = new Set([
  "opened",
  "reopened",
  "synchronize",
]);

/** The status field of a board: the mirror shows the one called this (GitHub's default for a new board). */
export const BOARD_STATUS_FIELD = "Status";

function ignored(reason: string): TrackerChangeResult {
  return { kind: "ignored", reason };
}

function change(value: TrackerChange): TrackerChangeResult {
  return { kind: "change", change: value };
}

function repoOf(context: TrackerParseContext): RepoRef {
  const { payload } = context;
  return {
    integrationId: context.integrationId,
    externalId: String(field<number>(payload, "repository.id")),
    fullName: field<string>(payload, "repository.full_name"),
    url: field<string>(payload, "repository.html_url"),
  };
}

function boardStatusChange(
  context: TrackerParseContext,
  action: string,
): TrackerChangeResult {
  const { payload } = context;
  const contentType = field<string>(payload, "projects_v2_item.content_type");
  if (contentType !== "Issue" && contentType !== "PullRequest")
    return ignored(`the board item is a ${contentType}, not an issue`);
  const nodeId = field<string>(payload, "projects_v2_item.content_node_id");
  if (action === "deleted" || action === "archived")
    return change({ kind: "board_status_changed", nodeId, status: null });
  if (action !== "edited")
    return ignored(`the board item action "${action}" carries no status`);
  const fieldChange = rawField(payload, "changes.field_value");
  if (
    typeof fieldChange !== "object" ||
    fieldChange === null ||
    (fieldChange as { field_name?: unknown }).field_name !== BOARD_STATUS_FIELD
  )
    return ignored(
      `the board change is not one of the field ${BOARD_STATUS_FIELD}`,
    );
  const to = (fieldChange as { to?: unknown }).to;
  const name =
    typeof to === "object" && to !== null
      ? (to as { name?: unknown }).name
      : undefined;
  return change({
    kind: "board_status_changed",
    nodeId,
    status: typeof name === "string" && name !== "" ? name : null,
  });
}

function subIssueChange(
  context: TrackerParseContext,
  action: string,
): TrackerChangeResult {
  const { payload } = context;
  if (
    action !== "parent_issue_added" &&
    action !== "parent_issue_removed" &&
    action !== "sub_issue_added" &&
    action !== "sub_issue_removed"
  )
    return ignored(`the sub-issue action "${action}" is not used`);
  const parentRepo = rawField(payload, "parent_issue_repo.full_name");
  const childRepo = rawField(payload, "sub_issue_repo.full_name");
  if (
    typeof parentRepo === "string" &&
    typeof childRepo === "string" &&
    parentRepo.toLowerCase() !== childRepo.toLowerCase()
  )
    return ignored("the sub-issue is in another repository than its parent");
  return change({
    kind: "parent_changed",
    repo: repoOf(context),
    child: field<number>(payload, "sub_issue.number"),
    parent: action.endsWith("_added")
      ? field<number>(payload, "parent_issue.number")
      : null,
  });
}

function checksChange(context: TrackerParseContext): TrackerChangeResult {
  const { payload } = context;
  const repositoryId = field<number>(payload, "repository.id");
  const listed = rawField(payload, "check_suite.pull_requests") as unknown[];
  const pullRequests = listed.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { number, base } = entry as {
      number?: unknown;
      base?: { repo?: { id?: unknown } };
    };
    // A pull request of this repository: its base is here (a fork's suite lists the pull requests that target another repository too).
    if (typeof number !== "number") return [];
    const baseId = base?.repo?.id;
    return baseId === undefined || baseId === repositoryId ? [number] : [];
  });
  if (pullRequests.length === 0)
    return ignored(
      "the check suite belongs to no pull request of the repository",
    );
  return change({
    kind: "checks_changed",
    repo: repoOf(context),
    headSha: field<string>(payload, "check_suite.head_sha"),
    pullRequests,
  });
}

export function parseTrackerChange(
  context: TrackerParseContext,
): TrackerChangeResult {
  const { eventName, payload } = context;
  if (!isTrackerWebhookEvent(eventName))
    return ignored(`the event "${eventName}" is not used by the ticket mirror`);
  const problems = specProblems(TRACKER_WEBHOOK_FIELDS[eventName], payload);
  if (problems.length > 0)
    return {
      kind: "invalid_payload",
      reason: `the "${eventName}" payload lacks the fields the ticket mirror reads: ${problems.join(", ")}`,
    };
  const action = field<string>(payload, "action");

  if (eventName === "projects_v2_item")
    return boardStatusChange(context, action);
  if (eventName === "sub_issues") return subIssueChange(context, action);
  if (eventName === "check_suite") {
    // `requested` and `rerequested` start a suite that is not done; `completed` ends it. Anything else says nothing about the state.
    return action === "completed" ||
      action === "requested" ||
      action === "rerequested"
      ? checksChange(context)
      : ignored(`the check suite action "${action}" is not used`);
  }

  const repo = repoOf(context);
  if (
    eventName === "issues" &&
    (action === "deleted" || action === "transferred")
  )
    return change({
      kind: "item_removed",
      repo,
      number: field<number>(payload, "issue.number"),
    });
  if (eventName === "issue_comment" && action === "deleted") {
    // A deleted comment changes nothing about the ticket but the time of the last change; `edited` and `created` carry it already.
    return ignored("a deleted comment is no news for the ticket");
  }

  const pullRequest = eventName === "pull_request";
  const item = toTrackerItem(
    rawField(payload, pullRequest ? "pull_request" : "issue"),
    repo.fullName,
    { pullRequest },
  );
  if (item === null)
    return {
      kind: "invalid_payload",
      reason: `the "${eventName}" payload has a ticket the ticket mirror cannot read`,
    };
  return change({
    kind: "item_changed",
    repo,
    item,
    resetChecks: pullRequest && COMMIT_ACTIONS.has(action),
  });
}
