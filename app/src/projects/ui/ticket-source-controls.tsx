// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The board picker and "Resync" of the Setup tab side by side (#937). A board that was just saved changes nothing in the tickets that are
// mirrored: they keep the statuses of the old board until a full sync. So the picker tells this one, and the Resync under it stands out
// (`prompted`) with the same sentence until a Resync has finished. Both stay mounted across the refresh a save causes.
import { useState } from "react";
import { ResyncTickets } from "./resync-tickets.tsx";
import type { SyncStaleness } from "./sync-staleness.ts";
import { TicketBoardPicker } from "./ticket-board-picker.tsx";

export function TicketSourceControls({
  workspaceSlug,
  projectId,
  repositoryId,
  board,
  canChange,
  showResync,
  staleness,
}: {
  workspaceSlug: string;
  projectId: string;
  repositoryId: string;
  /** The `projectV2Id` of the board the project has now, or null. */
  board: string | null;
  /** Whether the person may change the board (`manage_projects`). */
  canChange: boolean;
  /** Whether the person may resync and the project is switched on. */
  showResync: boolean;
  staleness: SyncStaleness | null;
}) {
  const [boardChanged, setBoardChanged] = useState(false);
  return (
    <>
      <TicketBoardPicker
        workspaceSlug={workspaceSlug}
        projectId={projectId}
        repositoryId={repositoryId}
        board={board}
        canChange={canChange}
        onSaved={() => setBoardChanged(true)}
      />
      {showResync ? (
        <ResyncTickets
          workspaceSlug={workspaceSlug}
          repositoryId={repositoryId}
          staleness={staleness}
          prompted={boardChanged}
        />
      ) : null}
    </>
  );
}
