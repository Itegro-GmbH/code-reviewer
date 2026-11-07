// SPDX-License-Identifier: LicenseRef-Proprietary

// The ToDos of one workspace (#924, epic #915): what waits for a person, read from the ticket mirror and the runs at the moment of the
// question. Nothing about a ToDo is stored: a question is a run that `waits` with an open ask, a review is an open pull request a lane
// opened and a review is asked for, and the done list is read from the answers the asks keep and from the pull requests that are over.
//
//  - A question needs the run, not the label: the label `agent waiting` is a hint of the App that a repository may refuse, and a question
//    that nobody sees because a label failed would never be answered. The ticket (title, address, whether it carries the label) is
//    added from the mirror when the mirror has it.
//  - A review is for the person the provider says is asked (the GitHub login of the viewer) and for nobody else: a request that names
//    logins can only be acted on by those logins. The one exception is the fan-out of the lane, `reviewers: "project members"` (#917),
//    which asks the members and which any member may answer. A pull request of nobody's lane is not a ToDo, whoever is asked. A person who
//    acted on a review while GitHub still held their request (the App's review does not satisfy it, and taking it away can fail) does not
//    see it again (`reviewActedBy` of the mirror row).
//  - The done list is bounded (`DONE_MAX`): the asks that were answered last and the pull requests of a lane that ended while a review was
//    still asked from the viewer (or from the members by a fan-out).
//  - Every list is read newest first and bounded (`LOOK_AT_MAX` per kind of row); a list narrowed to a project is narrowed inside the
//    queries, by the repositories of the project, so the rows of another project cannot use up the bound.
import type {
  StoredStepRun,
  StoredWorkflowRun,
  WorkflowRunsRepository,
} from "../db/repositories/workflow-runs-repository.ts";
import type { TrackerRepository } from "../db/repositories/tracker-repository.ts";
import type { WorkflowsRepository } from "../db/repositories/workflows-repository.ts";
import type { ProjectService } from "../projects/service.ts";
import {
  parseStepAsk,
  type AskAnswer,
  type StepAsk,
} from "../workflow-runs/ask.ts";
import { LABEL_WAITING } from "../workflow-runs/ask-comment.ts";
import { PROJECT_MEMBERS } from "../workflows/connectors.ts";
import {
  placeOf,
  pullRequestNumberOf,
  type Place,
} from "../workflow-runs/ask-place.ts";
import { TodosError } from "./errors.ts";

/** How many entries the done list holds. */
export const DONE_MAX = 20;
/**
 * How many waiting runs, answered asks and pull requests of lanes are looked at, the newest first: more than a person can answer. The
 * bound is per kind of row and, for a list of one project, per project: the queries are narrowed to the project's repositories first.
 */
const LOOK_AT_MAX = 200;
const MICRO = 1_000_000;

/** The ticket a ToDo is about, as far as the mirror knows it. */
export type TodoTicket = {
  number: number;
  kind: "issue" | "pull_request";
  /** Null when the mirror does not hold the ticket (yet). */
  title: string | null;
  /** The address on the provider; null when the repository is not known. */
  url: string | null;
  /** Whether the ticket carries the label `agent waiting`. */
  labelled: boolean;
};

type Where = {
  /** The project of the lane, else of the repository; null for a lane without one. */
  projectId: string | null;
  repositoryId: string;
  /** "owner/name"; null when the repository is not in the list of projects. */
  repo: string | null;
};

type LaneOf = {
  runId: string;
  workflowId: string;
  /** The name of the lane; null for one that is archived. */
  lane: string | null;
};

/** A question an agent asked and waits for the answer to. */
export type QuestionTodo = Where &
  LaneOf & {
    kind: "question";
    /** `question:<run>:<step run>:<n>`. */
    id: string;
    stepRunId: string;
    stepId: string;
    /** Which question of the step this is: what `POST .../runs/<run>/answer` names as `question`. */
    n: number;
    question: string;
    context: string | null;
    options: string[];
    /** When the step began to wait (the question's own time, else the run's last change). */
    since: string;
    spentUsd: number;
    budgetUsd: number;
    ticket: TodoTicket | null;
  };

/** An open pull request of a lane that a review is asked for. */
export type ReviewTodo = Where &
  LaneOf & {
    kind: "review";
    /** `review:<repository>:<number>`. */
    id: string;
    number: number;
    title: string;
    url: string | null;
    /** The logins the review is asked from. */
    requestedFrom: string[];
    /** `you`: the viewer is asked; `members`: another member of the workspace is (any member may answer). */
    audience: "you" | "members";
    checksState: string | null;
    since: string;
  };

export type DoneTodo =
  | (Where &
      LaneOf & {
        kind: "question";
        id: string;
        n: number;
        question: string;
        options: string[];
        answer: Pick<AskAnswer, "text" | "choice" | "by" | "via">;
        ticket: TodoTicket | null;
        /** When it was answered. */
        at: string;
      })
  | (Where &
      LaneOf & {
        kind: "review";
        id: string;
        number: number;
        title: string;
        url: string | null;
        /** How the pull request ended: `merged` or `closed`. */
        outcome: "merged" | "closed";
        at: string;
      });

export type TodoList = {
  /** The project the list is for; null for the whole workspace. */
  projectId: string | null;
  questions: QuestionTodo[];
  reviews: ReviewTodo[];
  /** The last answered questions and finished reviews, the newest first, at most `DONE_MAX`. */
  done: DoneTodo[];
};

export type TodoViewer = { githubLogin: string | null };

export type TodosService = {
  /**
   * The ToDos of the workspace, or of one project (`scope`). Throws `TODOS_PROJECT_NOT_FOUND` for a project the workspace does not have.
   * The questions are the same for every member; the reviews depend on the viewer.
   */
  list(viewer: TodoViewer, scope?: { projectId: string }): Promise<TodoList>;
  /** The review ToDo of the viewer for one pull request, or undefined when it is none (what a review action checks first). */
  findReview(
    viewer: TodoViewer,
    repositoryId: string,
    number: number,
  ): Promise<ReviewTodo | undefined>;
};

export type TodosServiceDependencies = {
  projects: Pick<ProjectService, "listProjects">;
  /** `getVersion` is read to tell the fan-out of a lane (`reviewers: "project members"`) from a request that names logins. */
  workflows: Pick<WorkflowsRepository, "list" | "getVersion">;
  runs: Pick<
    WorkflowRunsRepository,
    | "listWaiting"
    | "listStepsOfRuns"
    | "listAnsweredAskSteps"
    | "listPullRequestSteps"
  >;
  tracker: Pick<TrackerRepository, "listItemsByNumbers">;
  /** The GitHub logins of the members of the workspace. */
  memberLogins(): Promise<readonly string[]>;
};

type Known = {
  /** The repository: the address and the name; by the id of the repository. */
  repositories: Map<string, { url: string; fullName: string }>;
  /** The active project of a repository. */
  projectOfRepository: Map<string, string>;
  /** The repositories of each project, active or not. */
  repositoriesOfProject: Map<string, string[]>;
  /** Every project of the workspace, active or not. */
  projectIds: Set<string>;
  /** The lanes by id. */
  lanes: Map<string, { name: string; projectId: string | null }>;
};

const lower = (login: string) => login.toLowerCase();

/** Whether a lane's document has `reviewers: "project members"` anywhere in it (whatever the shape of its steps). */
function mentionsProjectMembers(value: unknown, depth = 0): boolean {
  if (depth > 20 || typeof value !== "object" || value === null) return false;
  if (
    !Array.isArray(value) &&
    (value as { reviewers?: unknown }).reviewers === PROJECT_MEMBERS
  )
    return true;
  return Object.values(value).some((child) =>
    mentionsProjectMembers(child, depth + 1),
  );
}

export function createTodosService(
  deps: TodosServiceDependencies,
): TodosService {
  async function known(): Promise<Known> {
    const repositories = new Map<string, { url: string; fullName: string }>();
    const projectOfRepository = new Map<string, string>();
    const repositoriesOfProject = new Map<string, string[]>();
    const projectIds = new Set<string>();
    for (const entry of await deps.projects.listProjects()) {
      repositories.set(entry.repository.id, {
        url: entry.repository.url,
        fullName: entry.repository.fullName,
      });
      if (entry.project === null) continue;
      projectIds.add(entry.project.id);
      repositoriesOfProject.set(entry.project.id, [
        ...(repositoriesOfProject.get(entry.project.id) ?? []),
        entry.repository.id,
      ]);
      if (entry.project.active)
        projectOfRepository.set(entry.repository.id, entry.project.id);
    }
    const lanes = new Map<string, { name: string; projectId: string | null }>();
    for (const workflow of await deps.workflows.list())
      lanes.set(workflow.id, {
        name: workflow.name,
        projectId: workflow.projectId,
      });
    return {
      repositories,
      projectOfRepository,
      repositoriesOfProject,
      projectIds,
      lanes,
    };
  }

  function whereOf(run: StoredWorkflowRun, facts: Known): Where {
    return {
      projectId:
        facts.lanes.get(run.workflowId)?.projectId ??
        facts.projectOfRepository.get(run.repositoryId) ??
        null,
      repositoryId: run.repositoryId,
      repo: facts.repositories.get(run.repositoryId)?.fullName ?? null,
    };
  }

  const laneOf = (run: StoredWorkflowRun, facts: Known): LaneOf => ({
    runId: run.id,
    workflowId: run.workflowId,
    lane: facts.lanes.get(run.workflowId)?.name ?? null,
  });

  const addressOf = (
    facts: Known,
    repositoryId: string,
    kind: "issue" | "pull_request",
    number: number,
  ): string | null => {
    const repository = facts.repositories.get(repositoryId);
    return repository === undefined
      ? null
      : `${repository.url}/${kind === "pull_request" ? "pull" : "issues"}/${String(number)}`;
  };

  /** The mirror's rows for the places of the runs, by repository and number (one read per repository). */
  async function ticketsOf(
    places: readonly { repositoryId: string; number: number }[],
  ) {
    const byRepository = new Map<string, Set<number>>();
    for (const place of places) {
      const numbers = byRepository.get(place.repositoryId) ?? new Set();
      numbers.add(place.number);
      byRepository.set(place.repositoryId, numbers);
    }
    const found = new Map<
      string,
      Awaited<ReturnType<TrackerRepository["listItemsByNumbers"]>>[number]
    >();
    for (const [repositoryId, numbers] of byRepository)
      for (const item of await deps.tracker.listItemsByNumbers(repositoryId, [
        ...numbers,
      ]))
        found.set(`${repositoryId}#${String(item.number)}`, item);
    return found;
  }

  const ticketOf = (
    facts: Known,
    mirror: Awaited<ReturnType<typeof ticketsOf>>,
    repositoryId: string,
    place: Place | undefined,
  ): TodoTicket | null => {
    if (place === undefined) return null;
    const item = mirror.get(`${repositoryId}#${String(place.number)}`);
    const kind =
      item?.kind ?? (place.kind === "ticket" ? "issue" : "pull_request");
    return {
      number: place.number,
      kind,
      title: item?.title ?? null,
      url: addressOf(facts, repositoryId, kind, place.number),
      labelled:
        item?.labels.some((label) => label.name === LABEL_WAITING) ?? false,
    };
  };

  /** The step of the run that waits and the question it holds open, if the run has one. */
  function openQuestion(
    steps: readonly StoredStepRun[],
  ): { step: StoredStepRun; ask: StepAsk } | undefined {
    for (const step of steps.toReversed()) {
      if (step.status !== "waiting") continue;
      const ask = parseStepAsk(step.ask);
      if (ask?.state === "open") return { step, ask };
    }
    return undefined;
  }

  async function questions(
    facts: Known,
    inScope: (where: Where) => boolean,
    repositoryIds: readonly string[] | undefined,
  ): Promise<QuestionTodo[]> {
    const open: {
      run: StoredWorkflowRun;
      step: StoredStepRun;
      ask: StepAsk;
      place: Place | undefined;
    }[] = [];
    const waitingRuns = (
      await deps.runs.listWaiting(LOOK_AT_MAX, repositoryIds)
    ).filter((run) => inScope(whereOf(run, facts)));
    // The steps of all the runs in one query.
    const stepsOf =
      waitingRuns.length === 0
        ? new Map<string, StoredStepRun[]>()
        : await deps.runs.listStepsOfRuns(waitingRuns.map((run) => run.id));
    for (const run of waitingRuns) {
      const steps = stepsOf.get(run.id) ?? [];
      const waiting = openQuestion(steps);
      if (waiting === undefined) continue;
      open.push({ run, ...waiting, place: placeOf(run, steps) });
    }
    const mirror = await ticketsOf(
      open.flatMap(({ run, place }) =>
        place === undefined
          ? []
          : [{ repositoryId: run.repositoryId, number: place.number }],
      ),
    );
    return open
      .map(({ run, step, ask, place }): QuestionTodo => ({
        kind: "question",
        id: `question:${run.id}:${step.id}:${String(ask.n)}`,
        ...whereOf(run, facts),
        ...laneOf(run, facts),
        stepRunId: step.id,
        stepId: step.stepId,
        n: ask.n,
        question: ask.question,
        context: ask.context ?? null,
        options: ask.options ?? [],
        since: ask.askedAt ?? run.updatedAt,
        spentUsd: run.spentMicroUsd / MICRO,
        budgetUsd: run.budgetMicroUsd / MICRO,
        ticket: ticketOf(facts, mirror, run.repositoryId, place),
      }))
      .sort((a, b) => (a.since < b.since ? 1 : a.since > b.since ? -1 : 0));
  }

  /** The pull requests the lanes opened: each once (the newest run that opened it), with the run. */
  async function lanePullRequests(
    repositoryIds: readonly string[] | undefined,
  ): Promise<{ run: StoredWorkflowRun; number: number }[]> {
    const seen = new Set<string>();
    const found: { run: StoredWorkflowRun; number: number }[] = [];
    for (const { run, step } of await deps.runs.listPullRequestSteps(
      LOOK_AT_MAX,
      repositoryIds,
    )) {
      const number = pullRequestNumberOf([step]);
      if (number === undefined) continue;
      const key = `${run.repositoryId}#${String(number)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ run, number });
    }
    return found;
  }

  /** Whether the document of the lane asks `reviewers: "project members"` anywhere: the fan-out, which any member may answer. */
  const fanOutCache = new Map<string, Promise<boolean>>();
  function asksProjectMembers(run: StoredWorkflowRun): Promise<boolean> {
    const key = `${run.workflowId}@${String(run.workflowVersion)}`;
    let known = fanOutCache.get(key);
    if (known === undefined) {
      known = (async () => {
        const version = await deps.workflows.getVersion(
          run.workflowId,
          run.workflowVersion,
        );
        if (version === undefined) return false;
        try {
          return mentionsProjectMembers(JSON.parse(version.document));
        } catch {
          return false;
        }
      })();
      fanOutCache.set(key, known);
    }
    return known;
  }

  async function reviews(
    facts: Known,
    viewer: TodoViewer,
    inScope: (where: Where) => boolean,
    repositoryIds: readonly string[] | undefined,
  ): Promise<{ open: ReviewTodo[]; finished: DoneTodo[] }> {
    const opened = (await lanePullRequests(repositoryIds)).filter(({ run }) =>
      inScope(whereOf(run, facts)),
    );
    const mirror = await ticketsOf(
      opened.map(({ run, number }) => ({
        repositoryId: run.repositoryId,
        number,
      })),
    );
    const members = new Set((await deps.memberLogins()).map(lower));
    const you =
      viewer.githubLogin === null ? undefined : lower(viewer.githubLogin);
    const open: ReviewTodo[] = [];
    const finished: DoneTodo[] = [];
    for (const { run, number } of opened) {
      const item = mirror.get(`${run.repositoryId}#${String(number)}`);
      if (
        item === undefined ||
        item.kind !== "pull_request" ||
        item.reviewRequestedFrom.length === 0
      )
        continue;
      const asked = item.reviewRequestedFrom.map(lower);
      // The viewer is asked by name, or the lane asked the members and one of them is asked: nobody else can act on the request.
      const byName = you !== undefined && asked.includes(you);
      const audience: ReviewTodo["audience"] | undefined = byName
        ? "you"
        : asked.some((login) => members.has(login)) &&
            (await asksProjectMembers(run))
          ? "members"
          : undefined;
      if (audience === undefined) continue;
      const where = whereOf(run, facts);
      const lane = laneOf(run, facts);
      const url = addressOf(facts, run.repositoryId, "pull_request", number);
      if (item.state === "closed") {
        finished.push({
          kind: "review",
          id: `review:${run.repositoryId}:${String(number)}`,
          ...where,
          ...lane,
          number,
          title: item.title,
          url,
          outcome: item.stateReason === "merged" ? "merged" : "closed",
          at: item.updatedAt,
        });
        continue;
      }
      // Acted on while GitHub still holds the request: not a ToDo of this person any more.
      if (you !== undefined && item.reviewActedBy.map(lower).includes(you))
        continue;
      open.push({
        kind: "review",
        id: `review:${run.repositoryId}:${String(number)}`,
        ...where,
        ...lane,
        number,
        title: item.title,
        url,
        requestedFrom: item.reviewRequestedFrom,
        audience,
        checksState: item.checksState,
        since: item.updatedAt,
      });
    }
    open.sort((a, b) => (a.since < b.since ? 1 : a.since > b.since ? -1 : 0));
    return { open, finished };
  }

  async function answered(
    facts: Known,
    inScope: (where: Where) => boolean,
    repositoryIds: readonly string[] | undefined,
  ): Promise<DoneTodo[]> {
    const candidates: {
      run: StoredWorkflowRun;
      step: StoredStepRun;
      ask: StepAsk & { answer: AskAnswer };
    }[] = [];
    for (const { run, step } of await deps.runs.listAnsweredAskSteps(
      LOOK_AT_MAX,
      repositoryIds,
    )) {
      const ask = parseStepAsk(step.ask);
      if (ask === undefined || ask.answer === undefined) continue;
      if (!inScope(whereOf(run, facts))) continue;
      candidates.push({ run, step, ask: { ...ask, answer: ask.answer } });
    }
    const newest = candidates
      .sort((a, b) =>
        a.ask.answer.at < b.ask.answer.at
          ? 1
          : a.ask.answer.at > b.ask.answer.at
            ? -1
            : 0,
      )
      .slice(0, DONE_MAX);
    // The places of the newest answers, with the steps of all their runs in one query.
    const stepsOf =
      newest.length === 0
        ? new Map<string, StoredStepRun[]>()
        : await deps.runs.listStepsOfRuns([
            ...new Set(newest.map(({ run }) => run.id)),
          ]);
    const places = new Map<string, Place | undefined>();
    for (const { run } of newest)
      if (!places.has(run.id))
        places.set(run.id, placeOf(run, stepsOf.get(run.id) ?? []));
    const mirror = await ticketsOf(
      newest.flatMap(({ run }) => {
        const place = places.get(run.id);
        return place === undefined
          ? []
          : [{ repositoryId: run.repositoryId, number: place.number }];
      }),
    );
    return newest.map(({ run, step, ask }): DoneTodo => ({
      kind: "question",
      id: `question:${run.id}:${step.id}:${String(ask.n)}`,
      ...whereOf(run, facts),
      ...laneOf(run, facts),
      n: ask.n,
      question: ask.question,
      options: ask.options ?? [],
      answer: {
        text: ask.answer.text,
        ...(ask.answer.choice === undefined
          ? {}
          : { choice: ask.answer.choice }),
        by: ask.answer.by,
        via: ask.answer.via,
      },
      ticket: ticketOf(facts, mirror, run.repositoryId, places.get(run.id)),
      at: ask.answer.at,
    }));
  }

  return {
    async list(viewer, scope) {
      const facts = await known();
      if (scope !== undefined && !facts.projectIds.has(scope.projectId))
        throw new TodosError(
          "TODOS_PROJECT_NOT_FOUND",
          "There is no project with this id.",
        );
      const inScope = (where: Where) =>
        scope === undefined || where.projectId === scope.projectId;
      // A project's lists are read for the repositories of the project (inside the queries), then checked for the lane's project.
      const repositoryIds =
        scope === undefined
          ? undefined
          : (facts.repositoriesOfProject.get(scope.projectId) ?? []);
      const [asked, review, answers] = await Promise.all([
        questions(facts, inScope, repositoryIds),
        reviews(facts, viewer, inScope, repositoryIds),
        answered(facts, inScope, repositoryIds),
      ]);
      return {
        projectId: scope?.projectId ?? null,
        questions: asked,
        reviews: review.open,
        done: [...answers, ...review.finished]
          .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
          .slice(0, DONE_MAX),
      };
    },

    async findReview(viewer, repositoryId, number) {
      const facts = await known();
      const { open } = await reviews(facts, viewer, () => true, [repositoryId]);
      return open.find(
        (review) =>
          review.repositoryId === repositoryId && review.number === number,
      );
    },
  };
}
