// SPDX-License-Identifier: LicenseRef-Proprietary

// The copy of the lane builder (#926). The validator's own sentence is shown as it comes (it is our text, written to be acted on); every
// other sentence of the builder is here, and a code of the save routes this file does not know gets the generic one, never the raw code.
import {
  GENERIC_FAILURE,
  describeTransportFailure,
} from "../../ui/transport-messages.ts";
import type { ProductIdentity } from "../../product-identity/identity.ts";

export const BUILDER_COPY = {
  flowLabel: "Flow",
  sharedSteps: "Shared steps · in order",
  onFailure: "On a technical failure · comments and labels only",
  triggerPre: "Steps only for this trigger, before the shared steps",
  nothingGoesOn: "nothing, goes on",
  elseLabel: "else",
  thenLabel: "then",
  checking: "Checking…",
  couldNotCheck:
    "Could not check the lane. The last result is shown; change something to try again.",
  jsonShow: "JSON",
  jsonHide: "Hide JSON",
  jsonLabel: "The lane as JSON, read only",
  runNow: "Run now",
  runNowTitle: "Run now",
  runNowSaved: "Starts the saved version.",
  runNowUnsaved:
    "Starts the saved version. Your unsaved changes are not part of it.",
  unreadable:
    "The saved lane cannot be read as a lane, so it cannot be edited here.",
  saved: "Saved.",
  inspectorEmpty: "Pick a step in the flow to edit it.",
  remove: "Remove step",
  moveUp: "Move up",
  moveDown: "Move down",
  idLabel: "Id",
  idHint: "References to the old id are not renamed.",
  noErrors: "No errors on this step.",
  errorsHeading: "Errors",
  documentErrors: "Errors in the lane as a whole",
  target: "target · one value",
  targetLiteral: "target · literal",
  laneCardTitle: "Lane",
  budgetTitle: "Budget",
  budgetHint: "Most it may spend over all steps",
  turnTitle: "Time per turn",
  turnHint: "Longest one agent turn may run",
  versions: "Versions",
  versionCurrent: "current",
  askSentence:
    "A turn ends with done or ask. On ask the sandbox shuts down and the lane waits as long as it takes.",
  addStep: "Add a step",
  addStepAfter: (id: string): string => `Add a step after ${id}`,
  addStepTo: (where: string): string => `Add a step to ${where}`,
  less: "Less",
  more: "More",
  loopFooter: (rounds: unknown): string =>
    `Ends when until holds, after ${typeof rounds === "number" ? String(rounds) : "?"} rounds, or when the budget runs out between two rounds · yields exit and rounds`,
} as const;

export const KIND_HELP = {
  trigger:
    "What starts the lane. Who may set a label is GitHub's business; events caused by the app's own bot never start a lane.",
  agent:
    "The profile says who works and where. A turn ends with done or ask. A profile that may not push yields no branch, only its result fields and costUsd.",
  action:
    "No model: the platform does what the action says. Targets take a literal or exactly one trusted value; free text takes anything, an agent's result included.",
  loop: "The body runs at least once. It ends when until holds, after max rounds, or when the budget is used up between two rounds.",
  if: "Values made inside a branch stay inside it; after the if only its own taken value exists.",
} as const;

const SAVE_FAILURE_TEXT: Record<string, string> = {
  WORKFLOW_INVALID:
    "The server does not accept this version. The errors are shown in the flow.",
  WORKFLOW_VERSION_CONFLICT:
    "The lane was saved by someone else since you opened it. Reload the page to see their version; your changes are not saved.",
  WORKFLOW_NAME_TAKEN: "Another lane of this workspace has that name.",
  WORKFLOW_ARCHIVED: "This lane is archived and takes no new version.",
  WORKFLOW_VERSION_LIMIT_REACHED:
    "This lane holds the most versions it may. Archive it and write it again under its name.",
  WORKFLOW_NOT_FOUND: "This lane does not exist any more.",
  WORKFLOW_BODY_TOO_LARGE: "The lane is too large to save.",
};

export function describeSaveFailure(
  product: ProductIdentity,
  failure: { code: string; status: number | null },
): string {
  if (Object.hasOwn(SAVE_FAILURE_TEXT, failure.code))
    return SAVE_FAILURE_TEXT[failure.code] ?? GENERIC_FAILURE;
  return (
    describeTransportFailure(product, failure.code, failure.status) ??
    GENERIC_FAILURE
  );
}
