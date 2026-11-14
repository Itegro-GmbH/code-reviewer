// SPDX-License-Identifier: LicenseRef-Proprietary

// #1036: which status names the lane builder offers for a status trigger.
import { describe, expect, it } from "vitest";
import { boardStatusNames } from "./board-statuses.ts";

const board = (id: string, statuses: string[]) => ({
  projectV2Id: id,
  number: 1,
  title: id,
  statusFieldId: "PVTSSF_1",
  statuses,
});

describe("the status names a status trigger offers", () => {
  it("are the options of the board the project chose, in the board's order", () => {
    expect(
      boardStatusNames(
        {
          kind: "boards",
          available: true,
          boards: [
            board("PVT_1", ["Todo", "In Progress", "Done"]),
            board("PVT_2", ["Other"]),
          ],
        },
        "PVT_1",
      ),
    ).toEqual(["Todo", "In Progress", "Done"]);
  });

  it("are none when the project chose no board, the board is gone or cannot be read, or GitHub could not be asked", () => {
    const boards = [board("PVT_1", ["Todo"])];

    expect(
      boardStatusNames({ kind: "boards", available: true, boards }, undefined),
    ).toEqual([]);
    expect(
      boardStatusNames({ kind: "boards", available: true, boards }, "PVT_9"),
    ).toEqual([]);
    expect(
      boardStatusNames({ kind: "boards", available: false, boards }, "PVT_1"),
    ).toEqual([]);
    expect(boardStatusNames({ kind: "failed" }, "PVT_1")).toEqual([]);
    expect(boardStatusNames({ kind: "repository_not_found" }, "PVT_1")).toEqual(
      [],
    );
  });
});
