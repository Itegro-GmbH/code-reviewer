// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The "New project" dialog (#925, prototype; #922): exactly one ticket source and an optional board. The ticket source is the choice of a
// repository that is not a project yet; the board is one of the GitHub Projects of that repository, read from GitHub once the repository
// is chosen (a repository without boards, or whose boards the App may not read, creates a project without one); the lanes to start with are
// copies of the built-in ones. "Create" posts all three to `POST /projects` and opens the cockpit. The ticket source can also be a Jira project
// (#1038): then the person picks the Jira site (a connection of the workspace), one of the projects the site has (read when the site is chosen)
// and the repository the code lives in; the board does not apply, and only the lanes that need no ticket write-back are offered. A lane that could not be copied (it needs
// the profiles and an environment) does not undo the project: the dialog says so and offers the way to the project. Only an Admin or an Owner
// may create a project (`manage_projects`); the page leaves the button out for a Member. Where the GitHub App is not configured nothing can
// be switched on: the button is disabled and the reason stands next to it (`blockedReason`, the text of the project switch).
import { useRouter } from "next/navigation";
import { useId, useMemo, useRef, useState } from "react";
import { Button } from "../../components/button.tsx";
import { NativeSelect } from "../../components/native-select.tsx";
import { StatusRegion } from "../../components/status-region.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../components/ui/dialog.tsx";
import { Checkbox } from "../../components/ui/checkbox.tsx";
import { Label } from "../../components/ui/label.tsx";
import { useProductIdentity } from "../../product-identity/context.tsx";
import {
  browserNewProjectApi,
  type BoardChoice,
  type NewProjectApi,
} from "./api.ts";
import { NEW_PROJECT_COPY, PROJECT_COPY } from "./cockpit-messages.ts";
import { projectPath } from "./project-cards.tsx";
import { describeFailure } from "./messages.ts";
import { LANES_FOR_JIRA } from "../new-project-request.ts";

export type NewProjectChoice = { repositoryId: string; fullName: string };

/** A Jira connection of the workspace as the dialog offers it (#1038); a broken one is listed but cannot be chosen. */
export type JiraConnectionChoice = {
  id: string;
  siteName: string;
  siteUrl: string;
  broken: boolean;
};

/** The value of the ticket source choice that stands for "a Jira project" (a repository id is a UUID, never this). */
const JIRA_SOURCE = "jira";

/** The built-in lanes a new project can copy, by the key the route takes. */
const LANE_KEYS = [
  "issue-to-pr",
  "issue-to-pr-status",
  "review-a-pull-request",
] as const;

/** The lanes ticked at the start: the status variant needs the board to have its statuses (#1036), so it is the project's choice. */
const LANES_BY_DEFAULT: readonly string[] = [
  "issue-to-pr",
  "review-a-pull-request",
];

type ProjectsState =
  | { kind: "none_chosen" }
  | { kind: "loading" }
  | {
      kind: "ready";
      projects: { key: string; name: string }[];
      complete: boolean;
    }
  | { kind: "broken" }
  | { kind: "failed" };

type BoardsState =
  | { kind: "none_chosen" }
  | { kind: "loading" }
  | { kind: "ready"; boards: BoardChoice[] }
  | { kind: "unreadable" }
  | { kind: "failed" };

export function NewProjectDialog({
  workspaceSlug,
  choices,
  blockedReason = null,
  jiraConnections = [],
  api: apiProp,
}: {
  workspaceSlug: string;
  /** The repositories that are not a project yet and can be read. */
  choices: readonly NewProjectChoice[];
  /** Why no project can be created now (the GitHub App is not configured); the button is disabled and says so. */
  blockedReason?: string | null;
  /** The Jira connections of the workspace (#1038); none, and the Jira option says to connect a site first. */
  jiraConnections?: readonly JiraConnectionChoice[];
  /** Only tests pass this. */
  api?: NewProjectApi;
}) {
  const product = useProductIdentity();
  const router = useRouter();
  const defaultApi = useMemo(
    () => browserNewProjectApi(workspaceSlug),
    [workspaceSlug],
  );
  const api = apiProp ?? defaultApi;
  const sourceId = useId();
  const boardId = useId();
  const boardHintId = useId();
  const blockedId = useId();
  const [open, setOpen] = useState(false);
  const [repositoryId, setRepositoryId] = useState("");
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [boards, setBoards] = useState<BoardsState>({ kind: "none_chosen" });
  const [boardPick, setBoardPick] = useState("");
  const [lanes, setLanes] = useState<readonly string[]>(LANES_BY_DEFAULT);
  // The Jira choices (#1038): the source is a Jira project while `jira` is true; `repositoryId` is then the repository of the code.
  const [jira, setJira] = useState(false);
  const [siteId, setSiteId] = useState("");
  const [projectKey, setProjectKey] = useState("");
  const [projects, setProjects] = useState<ProjectsState>({
    kind: "none_chosen",
  });
  const siteSelectId = useId();
  const projectSelectId = useId();
  const codeId = useId();
  const projectHintId = useId();
  // Set when the project exists but some lanes could not be copied: the dialog stays to say so.
  const [createdAt, setCreatedAt] = useState<string | null>(null);

  // The boards of the repository that was chosen, read when it is chosen; an answer that arrives after another repository was chosen is
  // dropped (`asked` counts the questions).
  const asked = useRef(0);
  const askedProjects = useRef(0);
  function chooseSource(next: string) {
    if (next === JIRA_SOURCE) {
      setJira(true);
      setLanes(LANES_FOR_JIRA);
      choose("");
      return;
    }
    if (jira) {
      setJira(false);
      setLanes(LANES_BY_DEFAULT);
      setSiteId("");
      setProjectKey("");
      setProjects({ kind: "none_chosen" });
    }
    choose(next);
  }
  // The projects of the site that was chosen, read when it is chosen (an answer that arrives after another site was chosen is dropped).
  function chooseSite(next: string) {
    setSiteId(next);
    setProjectKey("");
    askedProjects.current += 1;
    const question = askedProjects.current;
    if (next === "") {
      setProjects({ kind: "none_chosen" });
      return;
    }
    setProjects({ kind: "loading" });
    void api.jiraProjects(next).then((result) => {
      if (question !== askedProjects.current) return;
      if (result.ok)
        setProjects({
          kind: "ready",
          projects: result.data.projects,
          complete: result.data.complete,
        });
      else if (result.code === "PROJECT_JIRA_CONNECTION_BROKEN")
        setProjects({ kind: "broken" });
      else setProjects({ kind: "failed" });
    });
  }
  function choose(next: string) {
    setRepositoryId(next);
    setBoardPick("");
    asked.current += 1;
    const question = asked.current;
    if (next === "") {
      setBoards({ kind: "none_chosen" });
      return;
    }
    setBoards({ kind: "loading" });
    void api.boards(next).then((result) => {
      if (question !== asked.current) return;
      if (!result.ok) setBoards({ kind: "failed" });
      else if (!result.data.available) setBoards({ kind: "unreadable" });
      else setBoards({ kind: "ready", boards: result.data.boards });
    });
  }

  const ready = jira
    ? repositoryId !== "" && siteId !== "" && projectKey !== ""
    : repositoryId !== "";

  async function create() {
    if (!ready || pending) return;
    setPending(true);
    setProblem(null);
    const result = await api.createProject({
      repositoryId,
      board: jira || boardPick === "" ? null : { projectV2Id: boardPick },
      ...(jira
        ? {
            ticketSource: {
              provider: "jira" as const,
              connectionId: siteId,
              projectKey,
            },
          }
        : {}),
      lanes: [...lanes],
    });
    setPending(false);
    if (!result.ok) {
      setProblem(describeFailure(product, result.code));
      return;
    }
    const failed = result.data.lanes.filter((lane) => !lane.ok);
    if (failed.length > 0) {
      setProblem(
        NEW_PROJECT_COPY.laneProblem(
          failed
            .map((lane) => NEW_PROJECT_COPY.laneNames[lane.key] ?? lane.key)
            .join(", "),
        ),
      );
      setCreatedAt(repositoryId);
      return;
    }
    setOpen(false);
    router.push(projectPath(workspaceSlug, repositoryId));
  }

  const boardChoices = boards.kind === "ready" ? boards.boards : [];
  const boardHint =
    boards.kind === "none_chosen"
      ? NEW_PROJECT_COPY.boardHint
      : boards.kind === "loading"
        ? NEW_PROJECT_COPY.boardsLoading
        : boards.kind === "unreadable"
          ? NEW_PROJECT_COPY.boardsUnreadable
          : boards.kind === "failed"
            ? NEW_PROJECT_COPY.boardsFailed
            : boardChoices.length === 0
              ? NEW_PROJECT_COPY.boardsNone
              : NEW_PROJECT_COPY.boardPicked;

  if (blockedReason !== null)
    return (
      <div className="flex flex-col items-end gap-1">
        <Button disabled aria-describedby={blockedId}>
          {PROJECT_COPY.newProject}
        </Button>
        <p id={blockedId} className="text-xs text-muted-foreground">
          {blockedReason}
        </p>
      </div>
    );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>{PROJECT_COPY.newProject}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{NEW_PROJECT_COPY.title}</DialogTitle>
          <DialogDescription>{NEW_PROJECT_COPY.description}</DialogDescription>
        </DialogHeader>
        {choices.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {NEW_PROJECT_COPY.none}
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <Label htmlFor={sourceId}>{NEW_PROJECT_COPY.ticketSource}</Label>
              <NativeSelect
                id={sourceId}
                value={jira ? JIRA_SOURCE : repositoryId}
                disabled={createdAt !== null}
                onChange={(event) => chooseSource(event.target.value)}
              >
                <option value="">{NEW_PROJECT_COPY.chooseRepository}</option>
                {choices.map((choice) => (
                  <option key={choice.repositoryId} value={choice.repositoryId}>
                    {NEW_PROJECT_COPY.githubIssuesOf(choice.fullName)}
                  </option>
                ))}
                <option
                  value={JIRA_SOURCE}
                  disabled={jiraConnections.length === 0}
                >
                  {jiraConnections.length === 0
                    ? NEW_PROJECT_COPY.jiraNone
                    : NEW_PROJECT_COPY.jira}
                </option>
              </NativeSelect>
            </div>
            {jira ? (
              <>
                <div className="flex flex-col gap-1">
                  <Label htmlFor={siteSelectId}>
                    {NEW_PROJECT_COPY.jiraSite}
                  </Label>
                  <NativeSelect
                    id={siteSelectId}
                    value={siteId}
                    disabled={createdAt !== null}
                    onChange={(event) => chooseSite(event.target.value)}
                  >
                    <option value="">{NEW_PROJECT_COPY.chooseSite}</option>
                    {jiraConnections.map((connection) => (
                      <option
                        key={connection.id}
                        value={connection.id}
                        disabled={connection.broken}
                      >
                        {NEW_PROJECT_COPY.siteOption(
                          connection.siteName,
                          connection.siteUrl,
                          connection.broken,
                        )}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor={projectSelectId}>
                    {NEW_PROJECT_COPY.jiraProject}
                  </Label>
                  <NativeSelect
                    id={projectSelectId}
                    disabled={projects.kind !== "ready" || createdAt !== null}
                    aria-describedby={projectHintId}
                    value={projectKey}
                    onChange={(event) => setProjectKey(event.target.value)}
                  >
                    <option value="">{NEW_PROJECT_COPY.chooseProject}</option>
                    {(projects.kind === "ready" ? projects.projects : []).map(
                      (project) => (
                        <option key={project.key} value={project.key}>
                          {NEW_PROJECT_COPY.projectOption(
                            project.key,
                            project.name,
                          )}
                        </option>
                      ),
                    )}
                  </NativeSelect>
                  <p
                    id={projectHintId}
                    className="text-xs text-muted-foreground"
                  >
                    {projects.kind === "none_chosen"
                      ? NEW_PROJECT_COPY.projectHint
                      : projects.kind === "loading"
                        ? NEW_PROJECT_COPY.projectsLoading
                        : projects.kind === "broken"
                          ? NEW_PROJECT_COPY.projectsBroken
                          : projects.kind === "failed"
                            ? NEW_PROJECT_COPY.projectsFailed
                            : projects.projects.length === 0
                              ? NEW_PROJECT_COPY.projectsNone
                              : projects.complete
                                ? NEW_PROJECT_COPY.projectsPicked
                                : NEW_PROJECT_COPY.projectsPartial}
                  </p>
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor={codeId}>
                    {NEW_PROJECT_COPY.jiraRepository}
                  </Label>
                  <NativeSelect
                    id={codeId}
                    value={repositoryId}
                    disabled={createdAt !== null}
                    onChange={(event) => setRepositoryId(event.target.value)}
                  >
                    <option value="">
                      {NEW_PROJECT_COPY.chooseRepository}
                    </option>
                    {choices.map((choice) => (
                      <option
                        key={choice.repositoryId}
                        value={choice.repositoryId}
                      >
                        {choice.fullName}
                      </option>
                    ))}
                  </NativeSelect>
                  <p className="text-xs text-muted-foreground">
                    {NEW_PROJECT_COPY.jiraRepositoryHint}
                  </p>
                </div>
              </>
            ) : null}
            {jira ? null : (
              <div className="flex flex-col gap-1">
                <Label htmlFor={boardId}>{NEW_PROJECT_COPY.board}</Label>
                <NativeSelect
                  id={boardId}
                  disabled={boardChoices.length === 0 || createdAt !== null}
                  aria-describedby={boardHintId}
                  value={boardPick}
                  onChange={(event) => setBoardPick(event.target.value)}
                >
                  <option value="">{NEW_PROJECT_COPY.noRepository}</option>
                  {boardChoices.map((choice) => (
                    <option
                      key={choice.projectV2Id}
                      value={choice.projectV2Id}
                      disabled={!choice.hasStatusField}
                    >
                      {`#${String(choice.number)} ${choice.title}${choice.hasStatusField ? "" : ` (${NEW_PROJECT_COPY.boardNoStatus})`}`}
                    </option>
                  ))}
                </NativeSelect>
                <p id={boardHintId} className="text-xs text-muted-foreground">
                  {boardHint}
                </p>
              </div>
            )}
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium">
                {NEW_PROJECT_COPY.lanes}
              </legend>
              {LANE_KEYS.map((key) => (
                <div key={key} className="flex items-center gap-2">
                  <Checkbox
                    id={`${boardId}-${key}`}
                    checked={lanes.includes(key)}
                    disabled={
                      createdAt !== null ||
                      (jira && !LANES_FOR_JIRA.includes(key))
                    }
                    onCheckedChange={(checked) =>
                      setLanes((current) =>
                        checked === true
                          ? LANE_KEYS.filter(
                              (candidate) =>
                                candidate === key ||
                                current.includes(candidate),
                            )
                          : current.filter((candidate) => candidate !== key),
                      )
                    }
                  />
                  <Label htmlFor={`${boardId}-${key}`}>
                    {NEW_PROJECT_COPY.laneNames[key]}
                  </Label>
                </div>
              ))}
              <p className="text-xs text-muted-foreground">
                {jira
                  ? NEW_PROJECT_COPY.jiraLanesHint
                  : NEW_PROJECT_COPY.lanesHint}
              </p>
            </fieldset>
          </div>
        )}
        {problem !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        ) : null}
        <StatusRegion>{pending ? NEW_PROJECT_COPY.creating : ""}</StatusRegion>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setOpen(false)}>
            {NEW_PROJECT_COPY.cancel}
          </Button>
          {createdAt === null ? (
            <Button
              disabled={!ready || pending}
              loading={pending}
              loadingLabel={NEW_PROJECT_COPY.creating}
              onClick={() => void create()}
            >
              {jira ? NEW_PROJECT_COPY.createJira : NEW_PROJECT_COPY.create}
            </Button>
          ) : (
            <Button
              onClick={() => {
                setOpen(false);
                router.push(projectPath(workspaceSlug, createdAt));
              }}
            >
              {NEW_PROJECT_COPY.openProject}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
