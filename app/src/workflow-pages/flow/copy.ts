// SPDX-License-Identifier: LicenseRef-Proprietary

// The copy of the lane flow of a run (#1079): the headings the flow draws between its nodes. The lane itself has no editor (#1107,
// ADR 0007); the flow is a picture of what ran.
export const FLOW_LAYOUT_COPY = {
  sharedSteps: "Shared steps · in order",
  onFailure: "On a technical failure · comments and labels only",
  triggerPre: "Steps only for this trigger, before the shared steps",
  nothingGoesOn: "nothing, goes on",
  elseLabel: "else",
  thenLabel: "then",
  loopFooter: (rounds: unknown): string =>
    `Ends when until holds, after ${typeof rounds === "number" ? String(rounds) : "?"} rounds, or when the budget runs out between two rounds · yields exit and rounds`,
} as const;
