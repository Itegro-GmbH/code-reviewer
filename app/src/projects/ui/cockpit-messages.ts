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
    "A project is exactly one ticket source: the GitHub issues of one repository, with a GitHub Project as its board if you like. Issues are shown in GitHub's own words; the factory writes back only through lane actions.",
  ticketSource: "Ticket source (one)",
  chooseRepository: "Choose a repository",
  githubIssuesOf: (repository: string) => `GitHub issues of ${repository}`,
  jira: "Jira project (later)",
  board: "Board (optional)",
  boardHint: "Choose a repository first: its boards are read from GitHub.",
  boardsLoading: "Reading the boards of the repository…",
  boardsNone: "This repository has no board. A project works without one.",
  boardsUnreadable:
    "GitHub did not let the App read the boards of this repository (the App needs the Projects permission, which the owner of the installation grants). A project works without a board.",
  boardsFailed:
    "GitHub could not be asked for the boards right now. Create the project without a board, or try again.",
  boardPicked:
    "Tickets move on this board; its Status field gives the columns.",
  boardNoStatus: "no Status field",
  noRepository: "None",
  lanes: "Lanes to start with",
  lanesHint:
    "Copies of the built-in lanes; the project owns them and you change them without changing the built-in.",
  laneNames: {
    "issue-to-pr": "Issue to PR",
    "review-a-pull-request": "Review a pull request",
  } as Record<string, string>,
  laneProblem: (names: string) =>
    `The project was created, but these lanes could not be copied (they need the profiles implementer and reviewer, and an environment): ${names}.`,
  none: "Every repository of the GitHub App already is a project.",
  cancel: "Cancel",
  create: "Create and read from GitHub",
  creating: "Creating the project",
  openProject: "Open the project",
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
  hint: "The flows that run on this project. A lane belongs to the project and works on its tickets, in its repository.",
  emptyTitle: "No lanes yet",
  emptyDescription:
    "A new project copies the built-in lanes it is asked to; others are written through the API with the project's id (docs/workflows.md).",
  note: "A lane starts from a label on a ticket of this project's repository, or by hand with a ticket of it.",
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
