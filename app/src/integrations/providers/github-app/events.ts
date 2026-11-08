// SPDX-License-Identifier: LicenseRef-Proprietary

// Translates a verified GitHub delivery into what it means for the app (an IntegrationEvent). Reads
// only the fields listed in `webhook-fields.ts`. A genuine delivery of no interest is `ignored` with a
// reason for the logs; a payload that lacks fields the app reads is `invalid_payload`; a closed pull
// request is its own event (`pull_request_closed`).
import {
  parseAnswerCommand,
  parseCommentCommand,
  type ParsedAnswer,
} from "../../comment-command.ts";
import type {
  InstallationAction,
  IntegrationEvent,
  ReviewTrigger,
} from "../../types.ts";
import {
  field,
  hasField,
  isReadWebhookEvent,
  payloadProblems,
  rawField,
} from "./webhook-fields.ts";

/** GitHub's `installation` actions that matter, and what they mean for the app. */
const INSTALLATION_ACTION_MAP: Record<string, InstallationAction> = {
  created: "created",
  deleted: "deleted",
  suspend: "suspended",
  unsuspend: "unsuspended",
};

/** Pull request actions that start a review, and which kind of trigger they are. */
const PULL_REQUEST_TRIGGER_MAP = {
  opened: "opened",
  reopened: "opened",
  ready_for_review: "opened",
  synchronize: "updated",
} as const;

/** Only these can have write access to a repository; every other commenter is ignored at once. */
const WRITE_CAPABLE_ASSOCIATIONS: ReadonlySet<unknown> = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);

/**
 * Whether a commenter with this `author_association` can have write access at all. A cheap first
 * filter that costs no API call: only OWNER, MEMBER and COLLABORATOR pass, anything else (including
 * a value GitHub adds later, or none) does not. Whether the commenter really has write access is
 * then asked from GitHub (the collaborator permission API).
 */
export function mayHaveWriteAccess(association: unknown): boolean {
  return WRITE_CAPABLE_ASSOCIATIONS.has(association);
}

export type ParseContext = {
  integrationId: string;
  /** The event name from the `X-GitHub-Event` header. */
  eventName: string;
  payload: unknown;
  /** Does this user have write access to the repository? Asked before anything else is read. */
  hasWriteAccess(repoFullName: string, login: string): Promise<boolean>;
  /** The current head commit of a pull request; a comment delivery does not carry it. */
  headShaOf(repoFullName: string, prNumber: number): Promise<string>;
};

function ignored(reason: string): IntegrationEvent {
  return { kind: "ignored", reason };
}

function repoOf(context: ParseContext) {
  const { payload } = context;
  return {
    integrationId: context.integrationId,
    externalId: String(field<number>(payload, "repository.id")),
    fullName: field<string>(payload, "repository.full_name"),
    url: field<string>(payload, "repository.html_url"),
  };
}

function actorOf(payload: unknown) {
  return {
    login: field<string>(payload, "sender.login"),
    externalId: String(field<number>(payload, "sender.id")),
  };
}

/** The names of the labels an issue has; an entry that is not an object with a name is left out. */
function labelNames(payload: unknown): string[] {
  const labels = rawField(payload, "issue.labels");
  if (!Array.isArray(labels)) return [];
  return labels.flatMap((entry: unknown) => {
    const name =
      typeof entry === "object" && entry !== null
        ? (entry as { name?: unknown }).name
        : undefined;
    return typeof name === "string" && name !== "" ? [name] : [];
  });
}

/** The logins of the people an issue is assigned to; an entry that is not an object with a login is left out. */
function assigneeLogins(payload: unknown): string[] {
  const assignees = rawField(payload, "issue.assignees");
  if (!Array.isArray(assignees)) return [];
  return assignees.flatMap((entry: unknown) => {
    const login =
      typeof entry === "object" && entry !== null
        ? (entry as { login?: unknown }).login
        : undefined;
    return typeof login === "string" && login !== "" ? [login] : [];
  });
}

/**
 * `issues` (#845): only a label put on an open issue starts anything. A pull request is an issue to GitHub and arrives here too
 * (`issue.pull_request`); it is not one for the workflows. Only a sender of the type "User" starts one: a bot, our own App included,
 * does not (the connectors label issues with the App's token, and a label that starts a workflow would otherwise start the next one by
 * itself), nor does an "Organization" or a "Mannequin". A machine account that uses a personal access token is a "User" to GitHub.
 * Who may label is GitHub's rule, there is no check of our own.
 */
function parseIssueEvent(
  context: ParseContext,
  action: string,
): IntegrationEvent {
  const { payload } = context;
  if (action !== "labeled")
    return ignored(`the issue action "${action}" does not start a workflow`);
  if (hasField(payload, "issue.pull_request"))
    return ignored("the label is on a pull request, not on an issue");
  if (field<string>(payload, "issue.state") !== "open")
    return ignored("the issue is not open");
  // Only a "User" starts a workflow: a "Bot" (the App itself included), an "Organization" or a "Mannequin" do not. A machine account
  // that labels with a personal access token is a "User" to GitHub, and starts workflows like any person.
  if (field<string>(payload, "sender.type") !== "User")
    return ignored("the label was not put on by a user account");
  const label = rawField(payload, "label.name");
  if (typeof label !== "string" || label === "")
    return {
      kind: "invalid_payload",
      reason: 'the "issues" payload lacks the expected fields: label.name',
    };
  const body = rawField(payload, "issue.body");
  const assignees = assigneeLogins(payload);
  const issueType = rawField(payload, "issue.type.name");
  return {
    kind: "issue_labeled",
    labeled: {
      repo: repoOf(context),
      defaultBranch: field<string>(payload, "repository.default_branch"),
      issue: {
        number: field<number>(payload, "issue.number"),
        title: field<string>(payload, "issue.title"),
        body: typeof body === "string" ? body : "",
        url: field<string>(payload, "issue.html_url"),
        labels: labelNames(payload),
        ...(assignees.length === 0 ? {} : { assignees }),
        ...(typeof issueType === "string" && issueType !== ""
          ? { type: issueType }
          : {}),
      },
      label,
      actor: actorOf(payload),
    },
  };
}

/**
 * `/answer` (#920): the commenter has been checked for the association that can have write access (no call); this reads the command
 * and then asks GitHub whether the commenter really has write access, the check `/review` makes. The comment is on an issue or on a pull
 * request, open, closed or merged: a run that waits for an answer is the app's to find (a pull request that was closed while the run
 * waits is still what the person answers on), and a comment on anything else changes nothing.
 */
async function ticketAnswerEvent(
  context: ParseContext,
  answer: ParsedAnswer,
): Promise<IntegrationEvent> {
  const { payload } = context;
  const repo = repoOf(context);
  const actor = actorOf(payload);
  if (!(await context.hasWriteAccess(repo.fullName, actor.login)))
    return ignored("the commenter has no write access");
  const createdAt = hasField(payload, "comment.created_at")
    ? field<string>(payload, "comment.created_at")
    : undefined;
  return {
    kind: "ticket_answer",
    answer: {
      repo,
      number: field<number>(payload, "issue.number"),
      commentId: String(field<number>(payload, "comment.id")),
      ...(createdAt === undefined || createdAt === "" ? {} : { createdAt }),
      actor,
      ...(answer.choice === undefined ? {} : { choice: answer.choice }),
      ...(answer.text === undefined ? {} : { text: answer.text }),
      raw: answer.raw,
    },
  };
}

export async function parseGithubEvent(
  context: ParseContext,
): Promise<IntegrationEvent> {
  const { eventName, payload } = context;
  if (!isReadWebhookEvent(eventName))
    return ignored(`the event "${eventName}" is not used`);

  const problems = payloadProblems(eventName, payload);
  // Names the fields only, never their values: the payload is untrusted text.
  if (problems.length > 0)
    return {
      kind: "invalid_payload",
      reason: `the "${eventName}" payload lacks the expected fields: ${problems.join(", ")}`,
    };

  const action = field<string>(payload, "action");

  if (eventName === "installation") {
    const mapped = INSTALLATION_ACTION_MAP[action];
    if (mapped === undefined)
      return ignored(`the installation action "${action}" is not used`);
    return {
      kind: "installation_changed",
      externalId: String(field<number>(payload, "installation.id")),
      action: mapped,
    };
  }

  if (eventName === "installation_repositories") {
    if (action !== "added" && action !== "removed")
      return ignored(`the repositories action "${action}" is not used`);
    return {
      kind: "installation_changed",
      externalId: String(field<number>(payload, "installation.id")),
      action: "repositories_changed",
    };
  }

  if (eventName === "pull_request") {
    // A closed pull request starts no review; the app drops its waiting jobs (merged or not).
    if (action === "closed")
      return {
        kind: "pull_request_closed",
        repo: repoOf(context),
        prNumber: field<number>(payload, "number"),
        merged: field<boolean>(payload, "pull_request.merged"),
      };
    // A draft is not reviewed automatically; what already waits for it is dropped.
    if (action === "converted_to_draft")
      return {
        kind: "pull_request_drafted",
        repo: repoOf(context),
        prNumber: field<number>(payload, "number"),
      };
    if (!Object.hasOwn(PULL_REQUEST_TRIGGER_MAP, action))
      return ignored(
        `the pull request action "${action}" does not start a review`,
      );
    const kind =
      PULL_REQUEST_TRIGGER_MAP[action as keyof typeof PULL_REQUEST_TRIGGER_MAP];
    const trigger: ReviewTrigger = {
      kind,
      repo: repoOf(context),
      prNumber: field<number>(payload, "number"),
      prUrl: field<string>(payload, "pull_request.html_url"),
      headSha: field<string>(payload, "pull_request.head.sha"),
      command: null,
      args: null,
      actor: actorOf(payload),
      draft: field<boolean>(payload, "pull_request.draft"),
      state:
        field<string>(payload, "pull_request.state") === "open"
          ? "open"
          : "closed",
    };
    return { kind: "review_trigger", trigger };
  }

  if (eventName === "issues") return parseIssueEvent(context, action);

  // issue_comment
  if (action !== "created")
    return ignored(`the comment action "${action}" is not used`);
  if (!hasField(payload, "issue.pull_request")) {
    // #920: a comment on an issue is an answer or nothing. A bot never answers (our own comments are the App's), and only a commenter
    // that can have write access is read at all.
    if (
      field<string>(payload, "sender.type") === "Bot" ||
      !mayHaveWriteAccess(field<string>(payload, "comment.author_association"))
    )
      return ignored("the comment is on an issue, not on a pull request");
    const answer = parseAnswerCommand(field<string>(payload, "comment.body"));
    return answer === null
      ? ignored("the comment is on an issue, not on a pull request")
      : ticketAnswerEvent(context, answer);
  }
  if (field<string>(payload, "issue.state") !== "open") {
    // #920: a closed or merged pull request starts no review, but a run may still wait for an answer on it.
    const notOpen = "the pull request is not open";
    if (
      field<string>(payload, "sender.type") === "Bot" ||
      !mayHaveWriteAccess(field<string>(payload, "comment.author_association"))
    )
      return ignored(notOpen);
    const closedAnswer = parseAnswerCommand(
      field<string>(payload, "comment.body"),
    );
    return closedAnswer === null
      ? ignored(notOpen)
      : ticketAnswerEvent(context, closedAnswer);
  }
  if (field<string>(payload, "sender.type") === "Bot")
    return ignored("the comment was written by a bot");

  // Cheapest checks first, so a commenter without write access costs as few GitHub calls as
  // possible: the association from the payload (no call), then the permission (one call), and only
  // then the head commit of the pull request. The text of the comment is read after the first of
  // them: the association is known without reading anything, and the text of a commenter who cannot
  // use commands is none of our business.
  if (!mayHaveWriteAccess(field<string>(payload, "comment.author_association")))
    return ignored("the commenter cannot have write access");

  // #920: `/answer` on a pull request is read before `/review`; the two words never meet.
  const answer = parseAnswerCommand(field<string>(payload, "comment.body"));
  if (answer !== null) return ticketAnswerEvent(context, answer);

  const parsed = parseCommentCommand(field<string>(payload, "comment.body"));
  if (parsed === null) return ignored("the comment is not a command");

  const repo = repoOf(context);
  const actor = actorOf(payload);
  if (!(await context.hasWriteAccess(repo.fullName, actor.login)))
    return ignored("the commenter has no write access");

  const prNumber = field<number>(payload, "issue.number");
  return {
    kind: "review_trigger",
    trigger: {
      kind: "command",
      repo,
      prNumber,
      prUrl: `${repo.url}/pull/${prNumber}`,
      headSha: await context.headShaOf(repo.fullName, prNumber),
      command: parsed.command,
      args: parsed.args,
      commentId: String(field<number>(payload, "comment.id")),
      actor,
    },
  };
}
