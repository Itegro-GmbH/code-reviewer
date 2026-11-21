// SPDX-License-Identifier: LicenseRef-Proprietary

// The words of the projects page and of the project cockpit (#925), taken from the prototype of the factory. Where a number comes
// from a part that does not exist yet (the ticket source, #923; the lanes, #922; the answers, #924) the function takes `null` and says
// "–", so the card keeps its shape and the number appears when the part lands.
const count = (value: number | null) => (value === null ? "–" : String(value));

export const PROJECT_COPY = {
  allProjects: (projects: number) => `All projects · ${String(projects)}`,
  allProjectsHint: "Open tasks, running lanes and what waits for you.",
  footnote:
    "A project is one or more GitHub repositories and their issues, plus the lanes that run on them. The factory stores only runs, ToDos and lanes.",
  ticketSource: (repository: string) => `Issues of ${repository}`,
  /** The ticket source of a project on a Jira project (#1038): the project's key, and where the code lives. */
  jiraTicketSource: (projectKey: string, repository: string) =>
    `Jira project ${projectKey} · code in ${repository}`,
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
    "A project is exactly one ticket source: the GitHub issues of one repository, with a GitHub Project as its board if you like, or a Jira project (the code stays in a GitHub repository). Tickets are shown in the words of their platform; the factory writes back only through lane actions.",
  ticketSource: "Ticket source (one)",
  chooseRepository: "Choose a repository",
  githubIssuesOf: (repository: string) => `GitHub issues of ${repository}`,
  jira: "Jira project",
  jiraNone: "Jira project (connect a Jira site in the settings first)",
  jiraSite: "Jira site",
  chooseSite: "Choose a site",
  siteOption: (name: string, url: string, broken: boolean) =>
    `${name} (${url})${broken ? " · needs reconnecting" : ""}`,
  jiraProject: "Jira project",
  chooseProject: "Choose a project",
  projectOption: (key: string, name: string) => `${key} · ${name}`,
  projectHint: "Choose a site first: its projects are read from Jira.",
  projectsLoading: "Reading the projects of the site…",
  projectsNone:
    "The connection can read no project of this site. Check the permissions of the Jira account that connected it.",
  projectsBroken:
    "This Jira connection is broken. Connect it again in the settings.",
  projectsFailed:
    "Jira could not be asked for its projects right now. Try again in a moment.",
  projectsPartial:
    "The site has more projects than are listed here; the first ones are shown.",
  projectsPicked:
    "The tickets of this Jira project start the lanes; the statuses are Jira's own.",
  jiraRepository: "Repository for the code",
  jiraRepositoryHint:
    "The tickets come from Jira; the code, the branches and the pull requests stay in this GitHub repository.",
  jiraLanesHint:
    'A ticket starts a lane by moving into a status (the lane "Issue to PR (status)"); a lane that starts from a label is not offered for Jira. The status names are taken from the Jira project\'s workflow where they fit and can be changed in the lane.',
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
    "one-off-task": "One-off task",
    "issue-to-pr": "Issue to PR",
    "issue-to-pr-status": "Issue to PR (status)",
    "review-a-pull-request": "Review a pull request",
  } as Record<string, string>,
  laneProblem: (names: string) =>
    `The project was created, but these lanes could not be copied: ${names}. An Admin can add them through the API (docs/workflows.md, "Built-in lanes").`,
  none: "Every repository of the GitHub App already is a project.",
  cancel: "Cancel",
  create: "Create and read from GitHub",
  createJira: "Create the project",
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

export const LANES_COPY = {
  title: "Lanes",
  hint: "The flows that run on this project, read only: open a lane to start it or to follow its runs. An AI changes a lane through the API.",
  emptyTitle: "No lanes yet",
  emptyDescription:
    "A new project copies the built-in lanes it is asked to; others are written through the API with the project's id (docs/workflows.md).",
  note: "A lane starts from a label on a ticket of this project's repository, or by hand with a ticket of it.",
  noteJira:
    "A lane starts when a ticket of this project's Jira project moves into the status the lane waits for, or by hand with a ticket of it (jira:owner/repo#PROJ-12).",
  name: "Lane",
  version: "Version",
  updated: "Updated",
} as const;

export const SETUP_COPY = {
  title: "Ticket source",
  hint: "Exactly one per project. Shown in its own words, never mapped.",
  kind: "GitHub issues",
  jiraKind: "Jira project",
  jiraSite: (site: string) => `Site ${site}`,
  jiraCode: (repository: string, installation: string) =>
    `The code lives in ${repository}, a repository of the GitHub App installation ${installation}.`,
  jiraStatuses: "Statuses of the project's workflow",
  jiraStatusesHint:
    "Jira's own names; a lane that starts on a status change offers these.",
  jiraStatusesNone:
    "The statuses could not be read just now (the connection may need reconnecting). A lane still takes a status typed by name.",
  jiraNotMirrored:
    "The tickets of a Jira project are not mirrored yet, so this cockpit lists none; they arrive with the Jira webhook.",
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
