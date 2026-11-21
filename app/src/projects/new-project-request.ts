// SPDX-License-Identifier: LicenseRef-Proprietary

// The body of `POST /api/w/:workspace/projects` (#922), checked strictly and without any I/O: every problem is one issue with the `path`
// of the value, a stable `code`, a `message` and, where the value has to be one of a closed set, the names that would have been accepted
// (`available`). The boards of the repository are the handler's business: the body only says which one it means.
//
//   { "repositoryId": "<id of a repository of the workspace>",
//     "board": { "projectV2Id": "PVT_…" } | null,          // optional; the board of the GitHub Project, read from the repository
//     "lanes": ["issue-to-pr", "review-a-pull-request"],   // optional; built-in lanes copied into the new project
//     "ticketSource": { "provider": "jira", "connectionId": "<id of a Jira connection of the workspace>", "projectKey": "PROJ" } }
//                                                          // optional (#1038); the tickets are those of a Jira project and the code is in
//                                                          // the repository; `{ "provider": "github" }` is the default: its issues
import type { NewProjectIssue } from "./errors.ts";

const FIELDS = ["repositoryId", "board", "lanes", "ticketSource"] as const;
const BOARD_FIELDS = ["projectV2Id"] as const;
const SOURCE_FIELDS = ["provider", "connectionId", "projectKey"] as const;
const SOURCE_PROVIDERS = ["github", "jira"] as const;
/** What can be a Jira project key (the same rule as the stored source: `projects-repository.ts`). */
const JIRA_PROJECT_KEY = /^[A-Z][A-Z0-9_]{1,99}$/;
/**
 * The built-in lanes a project on a Jira project may start with (#1040): the one-off task and the review lane need no ticket, and "Issue to PR (status)" starts
 * by a move of the ticket into a status and writes back to Jira (comments, transitions). "Issue to PR" starts by a LABEL, which a Jira project
 * does not offer: the factory follows the status changes of a Jira project (the owner's decision, epic #1034), not its labels. The dialog
 * offers these only; the route refuses the rest.
 */
export const LANES_FOR_JIRA: readonly string[] = [
  "one-off-task",
  "issue-to-pr-status",
  "review-a-pull-request",
];
const MAX_ID_LENGTH = 128;
/** A node id of a GitHub Project (`PVT_…`); anything else cannot name a board. */
const BOARD_ID = /^PVT_[A-Za-z0-9_-]{1,200}$/;

export type NewProjectRequest = {
  repositoryId: string;
  board: { projectV2Id: string } | null;
  /** The names of built-in lanes, each at most once, as `laneKeys` has them. */
  lanes: string[];
  /** The Jira project the tickets come from (#1038); left out for the issues of the repository. */
  jira?: { connectionId: string; projectKey: string };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The text of a user value for a message: short, one line. */
const shown = (value: string): string =>
  value.replace(/[^\x20-\x7e]/g, "?").slice(0, 40);

/**
 * `laneKeys` are the names of the built-in lanes there are (the workflows module owns them; this module does not import it).
 */
export function readNewProjectRequest(
  body: unknown,
  laneKeys: readonly string[],
):
  | { ok: true; request: NewProjectRequest }
  | { ok: false; issues: NewProjectIssue[] } {
  const issues: NewProjectIssue[] = [];
  if (!isRecord(body))
    return {
      ok: false,
      issues: [
        {
          path: "",
          code: "wrong_type",
          message: "The body must be a JSON object.",
          available: [...FIELDS],
        },
      ],
    };
  for (const key of Object.keys(body))
    if (!(FIELDS as readonly string[]).includes(key))
      issues.push({
        path: key,
        code: "unknown_field",
        message: `The body has no field ${shown(key)}.`,
        available: [...FIELDS],
      });

  const { repositoryId, board, lanes, ticketSource } = body;
  if (repositoryId === undefined)
    issues.push({
      path: "repositoryId",
      code: "missing_field",
      message:
        "repositoryId is required: the repository whose issues are the ticket source.",
    });
  else if (
    typeof repositoryId !== "string" ||
    repositoryId.trim() === "" ||
    repositoryId.length > MAX_ID_LENGTH
  )
    issues.push({
      path: "repositoryId",
      code: "invalid_value",
      message: `repositoryId must be the id of a repository, a text of 1 to ${String(MAX_ID_LENGTH)} characters.`,
    });

  let boardRead: NewProjectRequest["board"] = null;
  if (board !== undefined && board !== null) {
    if (!isRecord(board))
      issues.push({
        path: "board",
        code: "wrong_type",
        message:
          "board must be an object with projectV2Id, or null for no board.",
        available: [...BOARD_FIELDS],
      });
    else {
      for (const key of Object.keys(board))
        if (!(BOARD_FIELDS as readonly string[]).includes(key))
          issues.push({
            path: `board.${shown(key)}`,
            code: "unknown_field",
            message: `board has no field ${shown(key)}.`,
            available: [...BOARD_FIELDS],
          });
      const id = board.projectV2Id;
      if (id === undefined)
        issues.push({
          path: "board.projectV2Id",
          code: "missing_field",
          message:
            "board.projectV2Id is required: the id of a board of the repository.",
        });
      else if (typeof id !== "string" || !BOARD_ID.test(id))
        issues.push({
          path: "board.projectV2Id",
          code: "invalid_value",
          message:
            "board.projectV2Id must be the node id of a GitHub Project, like PVT_….",
        });
      else boardRead = { projectV2Id: id };
    }
  }

  let jira: NewProjectRequest["jira"];
  if (ticketSource !== undefined) {
    if (!isRecord(ticketSource))
      issues.push({
        path: "ticketSource",
        code: "wrong_type",
        message:
          "ticketSource must be an object with provider (github or jira), and for jira the connectionId and the projectKey.",
        available: [...SOURCE_FIELDS],
      });
    else {
      for (const key of Object.keys(ticketSource))
        if (!(SOURCE_FIELDS as readonly string[]).includes(key))
          issues.push({
            path: `ticketSource.${shown(key)}`,
            code: "unknown_field",
            message: `ticketSource has no field ${shown(key)}.`,
            available: [...SOURCE_FIELDS],
          });
      const provider = ticketSource.provider;
      if (
        typeof provider !== "string" ||
        !(SOURCE_PROVIDERS as readonly string[]).includes(provider)
      )
        issues.push({
          path: "ticketSource.provider",
          code: provider === undefined ? "missing_field" : "invalid_value",
          message:
            "ticketSource.provider must be github (the issues of the repository) or jira (a Jira project).",
          available: [...SOURCE_PROVIDERS],
        });
      else if (provider === "jira") {
        const { connectionId, projectKey } = ticketSource;
        let connectionOk = false;
        if (connectionId === undefined)
          issues.push({
            path: "ticketSource.connectionId",
            code: "missing_field",
            message:
              "ticketSource.connectionId is required: the Jira connection of the workspace the project is on.",
          });
        else if (
          typeof connectionId !== "string" ||
          connectionId.trim() === "" ||
          connectionId.length > MAX_ID_LENGTH
        )
          issues.push({
            path: "ticketSource.connectionId",
            code: "invalid_value",
            message: `ticketSource.connectionId must be the id of a Jira connection, a text of 1 to ${String(MAX_ID_LENGTH)} characters.`,
          });
        else connectionOk = true;
        let keyOk = false;
        if (projectKey === undefined)
          issues.push({
            path: "ticketSource.projectKey",
            code: "missing_field",
            message:
              "ticketSource.projectKey is required: the key of a project of the site, like PROJ.",
          });
        else if (
          typeof projectKey !== "string" ||
          !JIRA_PROJECT_KEY.test(projectKey)
        )
          issues.push({
            path: "ticketSource.projectKey",
            code: "invalid_value",
            message:
              "ticketSource.projectKey must be the key of a Jira project, upper case letters, digits and underscores, like PROJ.",
          });
        else keyOk = true;
        if (connectionOk && keyOk)
          jira = {
            connectionId: connectionId as string,
            projectKey: projectKey as string,
          };
        // A Jira project has no GitHub Project as its board; naming one would ask for something that cannot be.
        if (board !== undefined && board !== null)
          issues.push({
            path: "board",
            code: "invalid_value",
            message:
              "A Jira project has no GitHub board: leave board out, or choose the issues of the repository as the ticket source.",
          });
      } else {
        for (const key of ["connectionId", "projectKey"] as const)
          if (ticketSource[key] !== undefined)
            issues.push({
              path: `ticketSource.${key}`,
              code: "unknown_field",
              message: `The issues of a repository have no ${key}; it belongs to a Jira project.`,
              available: ["provider"],
            });
      }
    }
  }

  const lanesRead: string[] = [];
  if (lanes !== undefined) {
    if (!Array.isArray(lanes))
      issues.push({
        path: "lanes",
        code: "wrong_type",
        message: "lanes must be a list of the names of built-in lanes.",
        available: [...laneKeys],
      });
    else
      (lanes as unknown[]).forEach((lane, index) => {
        const path = `lanes/${String(index)}`;
        if (typeof lane !== "string" || !laneKeys.includes(lane))
          issues.push({
            path,
            code: "unknown_lane",
            message: `There is no built-in lane ${typeof lane === "string" ? shown(lane) : "of that kind"}.`,
            available: [...laneKeys],
          });
        else if (lanesRead.includes(lane))
          issues.push({
            path,
            code: "duplicate_lane",
            message: `The lane ${lane} is named twice.`,
            available: laneKeys.filter((key) => !lanesRead.includes(key)),
          });
        else lanesRead.push(lane);
      });
  }

  if (jira !== undefined)
    lanesRead.forEach((lane, index) => {
      if (!LANES_FOR_JIRA.includes(lane))
        issues.push({
          path: `lanes/${String(index)}`,
          code: "lane_not_for_jira",
          message: `The lane ${lane} starts when a label is put on a GitHub issue, which a Jira project does not offer: a Jira ticket starts a lane by a move into a status.`,
          available: [...LANES_FOR_JIRA],
        });
    });

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    request: {
      repositoryId: repositoryId as string,
      board: boardRead,
      lanes: lanesRead,
      ...(jira === undefined ? {} : { jira }),
    },
  };
}
