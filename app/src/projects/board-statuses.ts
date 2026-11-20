// SPDX-License-Identifier: LicenseRef-Proprietary

// The status names a lane's status trigger can use (#1036): the options of the Status field of the board the project chose,
// as the board spells them. A project that chose no board offers none (the names are typed); so does a board the App may not read.
import type { BoardsAnswer } from "./create-http.ts";

/** The names of the statuses of the chosen board, in the board's order; empty when there is nothing to offer. */
export function boardStatusNames(
  answer: BoardsAnswer,
  chosenBoard: string | undefined,
): string[] {
  if (chosenBoard === undefined) return [];
  if (answer.kind !== "boards" || !answer.available) return [];
  const board = answer.boards.find(
    (entry) => entry.projectV2Id === chosenBoard,
  );
  return board === undefined ? [] : [...new Set(board.statuses)];
}
