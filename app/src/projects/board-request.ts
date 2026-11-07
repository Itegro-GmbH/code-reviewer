// SPDX-License-Identifier: LicenseRef-Proprietary

// The body of `PUT /api/w/:workspace/projects/:projectId` (#937), checked strictly and without any I/O. It carries the board and nothing
// else; every problem is one issue with the `path` of the value, a stable `code`, a `message` and, for a name that is not known, what
// would have been accepted (`available`). Which board the id is, is the handler's business: it reads the boards of the repository.
//
//   { "board": { "projectV2Id": "PVT_…" } | null }     // required: `null` clears the board of the project
import type { NewProjectIssue } from "./errors.ts";

const FIELDS = ["board"] as const;
const BOARD_FIELDS = ["projectV2Id"] as const;
/** A node id of a GitHub Project (`PVT_…`); anything else cannot name a board. */
const BOARD_ID = /^PVT_[A-Za-z0-9_-]{1,200}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The text of a user value for a message: short, one line. */
const shown = (value: string): string =>
  value.replace(/[^\x20-\x7e]/g, "?").slice(0, 40);

export function readBoardRequest(
  body: unknown,
):
  | { ok: true; board: { projectV2Id: string } | null }
  | { ok: false; issues: NewProjectIssue[] } {
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
  const issues: NewProjectIssue[] = [];
  for (const key of Object.keys(body))
    if (!(FIELDS as readonly string[]).includes(key))
      issues.push({
        path: shown(key),
        code: "unknown_field",
        message: `The body has no field ${shown(key)}.`,
        available: [...FIELDS],
      });
  const { board } = body;
  if (board === undefined)
    issues.push({
      path: "board",
      code: "missing_field",
      message:
        "board is required: an object with projectV2Id, or null for no board.",
    });
  else if (board === null)
    return issues.length > 0
      ? { ok: false, issues }
      : { ok: true, board: null };
  else if (!isRecord(board))
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
    else if (issues.length === 0)
      return { ok: true, board: { projectV2Id: id } };
  }
  return { ok: false, issues };
}
