// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The board of a project on its Setup tab (#937): the GitHub Project whose Status field gives the columns of the tickets, or none. The
// boards are the ones of the project's repository, read from GitHub when the page opens (`GET .../repositories/:id/boards`, which an
// Admin or an Owner may call, so only they get the picker; a Member sees whether a board is set). Choosing one saves it at once
// (`PUT .../projects/:id`): the server checks it against the boards GitHub has and takes the Status field from them. A board without a
// Status field cannot be chosen. A failed save leaves the choice where it was and says why. A saved board changes nothing in the tickets that
// are mirrored already: they keep the statuses of the old board until a full sync, so the message says to press Resync and `onSaved` lets
// the page put that button forward.
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useState } from "react";
import { NativeSelect } from "../../components/native-select.tsx";
import { StatusRegion } from "../../components/status-region.tsx";
import { Label } from "../../components/ui/label.tsx";
import { useProductIdentity } from "../../product-identity/context.tsx";
import type { BoardChoice } from "./api.ts";
import { browserSetupApi, type SetupApi } from "./setup-api.ts";
import { BOARD_COPY, describeSetupFailure } from "./setup-messages.ts";

type BoardsState =
  | { kind: "loading" }
  | { kind: "ready"; boards: BoardChoice[] }
  | { kind: "unreadable" }
  | { kind: "failed" };

export function TicketBoardPicker({
  workspaceSlug,
  projectId,
  repositoryId,
  board,
  canChange,
  onSaved,
  api: apiProp,
}: {
  workspaceSlug: string;
  projectId: string;
  repositoryId: string;
  /** The `projectV2Id` of the board the project has now, or null. */
  board: string | null;
  /** Whether the person may read the boards and change the choice (`manage_projects`). */
  canChange: boolean;
  /** Called after a board was saved or removed: the tickets still carry the old board's statuses. */
  onSaved?: () => void;
  /** Only tests pass this. */
  api?: SetupApi;
}) {
  const product = useProductIdentity();
  const router = useRouter();
  const defaultApi = useMemo(
    () => browserSetupApi(workspaceSlug),
    [workspaceSlug],
  );
  const api = apiProp ?? defaultApi;
  const selectId = useId();
  const hintId = useId();
  const [boards, setBoards] = useState<BoardsState>({ kind: "loading" });
  const [current, setCurrent] = useState(board ?? "");
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<
    { kind: "saved"; text: string } | { kind: "failed"; text: string } | null
  >(null);

  // The page refreshes after a save and hands in the project's board again; the picker stays mounted (its key is the project), so it
  // follows the prop instead of starting over.
  const [seenBoard, setSeenBoard] = useState(board);
  if (seenBoard !== board) {
    setSeenBoard(board);
    setCurrent(board ?? "");
  }

  useEffect(() => {
    if (!canChange) return;
    let dropped = false;
    void api.boards(repositoryId).then((result) => {
      if (dropped) return;
      if (!result.ok) setBoards({ kind: "failed" });
      else if (!result.data.available) setBoards({ kind: "unreadable" });
      else setBoards({ kind: "ready", boards: result.data.boards });
    });
    return () => {
      dropped = true;
    };
  }, [api, repositoryId, canChange]);

  async function choose(next: string) {
    if (pending || next === current) return;
    setPending(true);
    setOutcome(null);
    const result = await api.setBoard(projectId, next === "" ? null : next);
    setPending(false);
    if (!result.ok) {
      setOutcome({
        kind: "failed",
        text: describeSetupFailure(product, result.code, result.issues),
      });
      return;
    }
    setCurrent(next);
    setOutcome({
      kind: "saved",
      text: next === "" ? BOARD_COPY.cleared : BOARD_COPY.saved,
    });
    onSaved?.();
    router.refresh();
  }

  if (!canChange)
    return (
      <p className="text-sm text-muted-foreground">
        {board === null ? BOARD_COPY.noneSet : BOARD_COPY.readOnlySet}{" "}
        {BOARD_COPY.readOnly}
      </p>
    );

  const choices = boards.kind === "ready" ? boards.boards : [];
  const known = choices.some((choice) => choice.projectV2Id === current);
  const hint =
    boards.kind === "loading"
      ? BOARD_COPY.loading
      : boards.kind === "unreadable"
        ? BOARD_COPY.unreadable
        : boards.kind === "failed"
          ? BOARD_COPY.failed
          : choices.length === 0
            ? BOARD_COPY.noBoards
            : BOARD_COPY.picked;
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={selectId}>{BOARD_COPY.label}</Label>
      <NativeSelect
        id={selectId}
        aria-describedby={hintId}
        disabled={pending || boards.kind === "loading"}
        value={current}
        onChange={(event) => void choose(event.target.value)}
      >
        <option value="">{BOARD_COPY.none}</option>
        {current !== "" && !known ? (
          <option value={current}>{BOARD_COPY.currentUnread}</option>
        ) : null}
        {choices.map((choice) => (
          <option
            key={choice.projectV2Id}
            value={choice.projectV2Id}
            disabled={!choice.hasStatusField}
          >
            {`#${String(choice.number)} ${choice.title}${choice.hasStatusField ? "" : ` (${BOARD_COPY.noStatus})`}`}
          </option>
        ))}
      </NativeSelect>
      <p id={hintId} className="text-xs text-muted-foreground">
        {hint}
      </p>
      <StatusRegion>
        {pending ? (
          BOARD_COPY.saving
        ) : outcome?.kind === "failed" ? (
          <span className="text-destructive">{outcome.text}</span>
        ) : (
          (outcome?.text ?? "")
        )}
      </StatusRegion>
    </div>
  );
}
