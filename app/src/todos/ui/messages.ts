// SPDX-License-Identifier: LicenseRef-Proprietary

// The words of the ToDos page and of the empty ToDos tab of a project (#925), from the prototype of the factory.
export const TODO_COPY = {
  open: (count: number) => `Open · ${String(count)}`,
  done: (count: number) => `Done · ${String(count)}`,
  hint: "Answer here or in the ticket. Whoever answers first continues the run.",
  emptyTitle: "Nothing waits for you",
  emptyDescription:
    "A question of an agent, a review that is asked of you or red checks show up here as soon as a lane is working on an issue.",
  toProjects: "Open the projects",
  doneEmpty: "Answered ToDos are listed here.",
} as const;
