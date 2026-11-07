// SPDX-License-Identifier: LicenseRef-Proprietary

// The body of `POST /api/w/:workspace/projects` (#922), checked strictly and without any I/O: every problem is one issue with the `path`
// of the value, a stable `code`, a `message` and, where the value has to be one of a closed set, the names that would have been accepted
// (`available`). The boards of the repository are the handler's business: the body only says which one it means.
//
//   { "repositoryId": "<id of a repository of the workspace>",
//     "board": { "projectV2Id": "PVT_…" } | null,          // optional; the board of the GitHub Project, read from the repository
//     "lanes": ["issue-to-pr", "review-a-pull-request"] }  // optional; built-in lanes copied into the new project
import {
  BUILT_IN_LANE_KEYS,
  isBuiltInLaneKey,
  type BuiltInLaneKey,
} from "../workflows/built-in-lanes.ts";
import type { NewProjectIssue } from "./errors.ts";

const FIELDS = ["repositoryId", "board", "lanes"] as const;
const BOARD_FIELDS = ["projectV2Id"] as const;
const MAX_ID_LENGTH = 128;
/** A node id of a GitHub Project (`PVT_…`); anything else cannot name a board. */
const BOARD_ID = /^PVT_[A-Za-z0-9_-]{1,200}$/;

export type NewProjectRequest = {
  repositoryId: string;
  board: { projectV2Id: string } | null;
  lanes: BuiltInLaneKey[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The text of a user value for a message: short, one line. */
const shown = (value: string): string =>
  value.replace(/[^\x20-\x7e]/g, "?").slice(0, 40);

export function readNewProjectRequest(
  body: unknown,
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

  const { repositoryId, board, lanes } = body;
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

  const lanesRead: BuiltInLaneKey[] = [];
  if (lanes !== undefined) {
    if (!Array.isArray(lanes))
      issues.push({
        path: "lanes",
        code: "wrong_type",
        message: "lanes must be a list of the names of built-in lanes.",
        available: [...BUILT_IN_LANE_KEYS],
      });
    else
      (lanes as unknown[]).forEach((lane, index) => {
        const path = `lanes/${String(index)}`;
        if (!isBuiltInLaneKey(lane))
          issues.push({
            path,
            code: "unknown_lane",
            message: `There is no built-in lane ${typeof lane === "string" ? shown(lane) : "of that kind"}.`,
            available: [...BUILT_IN_LANE_KEYS],
          });
        else if (lanesRead.includes(lane))
          issues.push({
            path,
            code: "duplicate_lane",
            message: `The lane ${lane} is named twice.`,
            available: BUILT_IN_LANE_KEYS.filter(
              (key) => !lanesRead.includes(key),
            ),
          });
        else lanesRead.push(lane);
      });
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    request: {
      repositoryId: repositoryId as string,
      board: boardRead,
      lanes: lanesRead,
    },
  };
}
