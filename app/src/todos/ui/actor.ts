// SPDX-License-Identifier: LicenseRef-Proprietary

/** What the panels need to know about the person who looks (#925): the page reads it from the session on the server. */
export type TodoActor = {
  /** The role may answer a question and review (the right `start_implementer_task`, as the run page and the routes ask for it). */
  mayAct: boolean;
  /** The account has a GitHub login: the answer and the review are written "by @login"; without one they say "a member of the workspace". */
  hasLogin: boolean;
};
