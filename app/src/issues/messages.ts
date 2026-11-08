// SPDX-License-Identifier: LicenseRef-Proprietary

// The words of the Issues tab, the issue drawer and the start dialog (#925). What GitHub says (state, type, labels, board status, checks) is
// shown as GitHub says it and never translated; only the words around it are ours.
export const BOARD_COPY = {
  title: "Issues",
  hint: "Exactly what GitHub says, plus whether a lane is on an issue. Click a row for details.",
  tableLabel: "Issues",
  columns: {
    issue: "Issue",
    github: "In GitHub",
    lane: "Lane",
    waits: "Waits for",
  },
  emptyTitle: "No issues yet",
  emptyDescription:
    "The issues of this repository appear here as soon as the ticket source is read: state, type, labels and board status in GitHub's own words, and which lane is on an issue and at which step.",
  noneOpenTitle: "No open issues",
  noneOpenDescription:
    "Every issue of this repository is closed. Show all issues to see them.",
  footnote:
    "Nothing is translated: state, type, labels and board status are GitHub's own words. The factory only adds which lane is on an issue and at which step.",
  filterLabel: "Show",
  filterOpen: "Open issues",
  filterAll: "All issues",
  noLane: "No lane",
  step: (step: string) => `at ${step}`,
  noBoardStatus: "not on a board",
  updateFailed:
    "Updating failed. The list shows the last data it got; it keeps trying.",
  updating: "Updating the list",
  limited: (listed: number) =>
    `Showing the ${String(listed)} issues that changed last.`,
  lastSync: (when: string) => `Read from GitHub ${when}.`,
  neverSynced: "Not read from GitHub yet.",
  syncing: "The first read from GitHub is still going on.",
} as const;

export const TILES_COPY = {
  open: { name: "Open issues", note: "in GitHub, newest changes first" },
  working: { name: "Lanes working", note: "issues with a lane on them" },
  waiting: {
    name: "Wait for you",
    note: "a question, or a pull request to review",
  },
  spent: {
    name: "Spent on these issues",
    note: "all runs of the issues listed",
  },
  scopeAll: (issues: number) =>
    `Counted over all ${String(issues)} issues of the repository.`,
  scopeLimited: (tickets: number) =>
    `Counted over the ${String(tickets)} tickets that changed last; older ones are not included.`,
} as const;

export const WAITS_COPY = {
  start: "Start",
  answer: "Answer",
  review: "Review",
  none: "–",
  startLabel: (number: number) => `Start a lane on issue #${String(number)}`,
  answerLabel: (number: number) =>
    `Answer the question on issue #${String(number)}`,
  reviewLabel: (number: number) =>
    `Review the pull request of issue #${String(number)} on GitHub`,
  notAllowed: "Only a member who may start tasks can start a lane.",
  noLanes: "This project has no lane that starts from an issue by hand.",
} as const;

export const DRAWER_COPY = {
  description: "Details of this issue, in GitHub's own words.",
  openOnGitHub: "Open on GitHub",
  state: "State",
  type: "Type",
  noType: "none",
  labels: "Labels",
  noLabels: "none",
  boardStatus: "Board status",
  assignees: "Assignees",
  nobody: "nobody",
  pullRequest: "Pull request",
  noPullRequest: "none yet",
  checks: "Checks",
  noChecks: "none reported",
  lane: "Lane",
  laneNone: "No lane is on this issue.",
  laneRunning: "running",
  laneWaiting: "waits for an answer",
  openRun: "Open the run",
  effort: "Effort",
  spent: "Spent",
  runtime: "Running for",
  questions: "Questions",
  rounds: "Rounds",
  runLoading: "Reading the run…",
  runFailed: "The run could not be read right now.",
  steps: "History",
  stepsNone: "No step has run yet.",
  subIssues: "Sub-issues",
  noSubIssues: "none",
  technical: "Technical",
  ticketRef: "Ticket",
  repository: "Repository",
  project: "Project",
  run: "Run",
  lanePage: "Lane",
  updatedAt: "Changed in GitHub",
  syncedAt: "Read from GitHub",
  stateReason: (reason: string) => `(${reason})`,
} as const;

export const START_LANE_COPY = {
  title: (number: number) => `Start a lane on issue #${String(number)}`,
  description: "Which lane should work on this issue?",
  lane: "Which lane?",
  none: "This project has no lane that can start from an issue by hand. A lane needs a manual trigger that takes a ticket.",
  does: "What it does",
  firstSteps: "First steps",
  limits: "Limits",
  budget: (usd: number) => `Budget ${formatUsdLimit(usd)}`,
  turn: (minutes: number) => `${String(minutes)} min per agent turn`,
  start: "Start",
  starting: "Starting the lane",
  cancel: "Cancel",
} as const;

function formatUsdLimit(usd: number): string {
  return Number.isInteger(usd) ? `$${String(usd)}` : `$${usd.toFixed(2)}`;
}
