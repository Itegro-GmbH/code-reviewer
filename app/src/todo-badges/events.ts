// SPDX-License-Identifier: LicenseRef-Proprietary

// The one browser event of the ToDos (#925), in a file of its own so that the page that sends it and the badges that listen import
// neither each other nor a component.

/** Sent after a ToDo was dealt with or the ToDos page saw the open ToDos change: the badges read their count again, fresh. */
export const TODOS_CHANGED_EVENT = "factory:todos-changed";
