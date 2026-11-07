// SPDX-License-Identifier: LicenseRef-Proprietary

// The words of the projects page and of the project cockpit (#925), taken from the prototype of the factory. Where a number comes
// from a part that does not exist yet (the ticket source, #923; the lanes, #922; the answers, #924) the function takes `null` and says
// "–", so the card keeps its shape and the number appears when the part lands.
const count = (value: number | null) => (value === null ? "–" : String(value));

export const PROJECT_COPY = {
  allProjects: (projects: number) => `All projects · ${String(projects)}`,
  allProjectsHint: "Open tasks, running lanes and what waits for you.",
  footnote:
    "A project is one or more GitHub repositories and their issues, plus the lanes that run on them. The factory stores only runs, ToDos, lanes and profiles.",
  ticketSource: (repository: string) => `Issues of ${repository}`,
  lanesRunning: (value: number | null) =>
    value === null ? "Lanes running –" : `${count(value)} lanes running`,
  openIssues: (value: number | null) => `Open issues ${count(value)}`,
  waiting: (value: number | null) =>
    value === null ? "Waits for you –" : `${count(value)} wait for you`,
  newProject: "New project",
  noneTitle: "No project yet",
  noneDescription:
    "The repositories of the GitHub App are listed under New project. Pick one as the ticket source to turn it into a project.",
} as const;

export const NEW_PROJECT_COPY = {
  title: "New project",
  description:
    "Issues are shown in GitHub's own words. The factory writes back only through lane actions. Which repositories a lane works in is defined by the lane.",
  ticketSource: "Ticket source (one)",
  chooseRepository: "Choose a repository",
  githubIssuesOf: (repository: string) => `GitHub issues of ${repository}`,
  jira: "Jira project (later)",
  board: "Board (optional)",
  boardHint: "Boards come with the ticket source.",
  noRepository: "None",
  none: "Every repository of the GitHub App already is a project.",
  cancel: "Cancel",
  create: "Create and read from GitHub",
  creating: "Creating the project",
} as const;

export const COCKPIT_TABS = [
  { segment: "", label: "Issues" },
  { segment: "todos", label: "ToDos" },
  { segment: "runs", label: "Runs" },
  { segment: "lanes", label: "Lanes" },
  { segment: "setup", label: "Setup" },
] as const;
export type CockpitTab = (typeof COCKPIT_TABS)[number]["segment"];

export const ISSUES_COPY = {
  title: "Issues",
  hint: "Exactly what GitHub says, plus whether a lane is on an issue. Click a row for details.",
  emptyTitle: "No issues yet",
  emptyDescription:
    "The issues of this repository appear here as soon as the ticket source is read: state, type, labels and board status in GitHub's own words, and which lane is on an issue and at which step.",
  footnote:
    "Nothing is translated: state, type, labels and board status are GitHub's own words. The factory only adds which lane is on an issue and at which step.",
} as const;

export const PROJECT_TODOS_COPY = {
  title: "ToDos",
  hint: "Questions, reviews and red checks of this project. Answer here or in the ticket.",
  emptyTitle: "Nothing waits for you in this project",
  emptyDescription:
    "When an agent asks a question, asks for a review or stops on red checks, it shows up here and in your ToDos.",
} as const;

export const LANES_COPY = {
  title: "Lanes",
  hint: "The flows that run on this project. A lane belongs to the project; which repositories it works in is defined in the lane.",
  emptyTitle: "No lanes yet",
  emptyDescription:
    "A lane is written through the API for now (docs/workflows.md). The lanes of the workspace are listed here.",
  note: "Lanes are shared by the whole workspace until they belong to a project (#922).",
  allLink: "All lanes of the workspace",
  taskNote:
    "Until a lane can be started from an issue, a task goes to the agent by hand:",
  taskLink: "send a task",
  name: "Lane",
  version: "Version",
  updated: "Updated",
} as const;

export const SETUP_COPY = {
  title: "Ticket source",
  hint: "Exactly one per project. Shown in its own words, never mapped.",
  kind: "GitHub issues",
  stateOk: "Connected",
  stateOff: "Not read",
  stateGone: "Unavailable",
  note: (installation: string) =>
    `Repository of the GitHub App installation ${installation}.`,
  footnote:
    "The factory writes into the source only through lane actions: comments, labels, the board status, review requests. Lanes belong to the project; which repositories they work in is defined in each lane.",
  review: "Review settings",
  reviewHint:
    "How pull requests of this repository are reviewed: the model, the focus and the limits.",
  reviewLink: "Open the review settings",
  switchTitle: "Reviews and runs",
} as const;
