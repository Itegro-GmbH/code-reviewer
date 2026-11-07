// SPDX-License-Identifier: LicenseRef-Proprietary

// The words of the ticket source card of the Setup tab beyond the card itself (#937): the board picker, the Resync button with its
// progress and the hint that the tickets may be out of date. The routes answer with stable codes; `describeSetupFailure` turns one into a
// sentence (an unknown code gets the generic one of the project pages).
import {
  CROSS_SITE_REQUEST_RELOAD_PAGE,
  REQUEST_NOT_UNDERSTOOD,
} from "../../copy/messages.ts";
import type { ProductIdentity } from "../../product-identity/identity.ts";
import { describeFailure } from "./messages.ts";

export const BOARD_COPY = {
  label: "Board (optional)",
  none: "None",
  noStatus: "no Status field",
  loading: "Reading the boards of the repository…",
  unreadable:
    "GitHub did not let the App read the boards of this repository (the App needs the Projects permission, which the owner of the installation grants).",
  failed:
    "GitHub could not be asked for the boards right now. Reload the page to try again.",
  noBoards: "This repository has no board. A project works without one.",
  picked: "Tickets move on this board; its Status field gives the columns.",
  noneSet: "No board: tickets keep no status from a board.",
  currentUnread:
    "The board set on this project (its boards cannot be read now)",
  saving: "Saving the board",
  saved: "Board saved. Resync reads the statuses of the new board.",
  cleared: "Board removed.",
  readOnly:
    "Only an Admin or an Owner changes the board of a project; a Member sees it.",
  readOnlySet: "A board is set on this project.",
} as const;

export const RESYNC_COPY = {
  button: "Resync",
  running: (call: number) => `Reading from GitHub… (call ${String(call)})`,
  done: (written: number, removed: number) =>
    `Done: ${String(written)} ${written === 1 ? "ticket" : "tickets"} read${removed > 0 ? `, ${String(removed)} removed` : ""}.`,
  skipped: (count: number) =>
    `${String(count)} ${count === 1 ? "ticket" : "tickets"} could not be read, so none was removed. Resync again later.`,
  noBoard:
    "GitHub did not let the App read the boards, so board statuses stay empty.",
  gaveUp:
    "Still reading after many calls. What was read is kept: press Resync to go on.",
  hint: "Reads every ticket of the repository again, in steps of about twenty seconds, and shows how far it is. It cannot lose what is read.",
  staleDays: (days: number) =>
    `The tickets were last read in full ${String(days)} days ago and nothing has been delivered since. GitHub may have missed a change: press Resync.`,
  never:
    "The tickets have not been read in full yet. Press Resync to read them.",
} as const;

const SETUP_FAILURE: Record<string, string> = {
  TRACKER_REPOSITORY_NOT_FOUND:
    "This repository does not exist any more. Reload the page.",
  TRACKER_PROJECT_NOT_FOUND:
    "This project does not exist any more. Reload the page.",
  TRACKER_PROJECT_NOT_ACTIVE:
    "The project is switched off, so its tickets are not read. Switch it on first.",
  TRACKER_INTEGRATION_UNAVAILABLE:
    "The GitHub App installation of this repository is suspended or removed, so GitHub cannot be asked.",
  TRACKER_SYNC_FAILED:
    "GitHub could not be read just now. What was read is kept: press Resync to go on.",
  TRACKER_CROSS_SITE_REQUEST: CROSS_SITE_REQUEST_RELOAD_PAGE,
  TRACKER_REQUEST_INVALID: REQUEST_NOT_UNDERSTOOD,
};

export function describeSetupFailure(
  product: ProductIdentity,
  code: string,
): string {
  return Object.hasOwn(SETUP_FAILURE, code)
    ? SETUP_FAILURE[code]!
    : describeFailure(product, code);
}
