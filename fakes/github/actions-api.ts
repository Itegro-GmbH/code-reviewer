// SPDX-License-Identifier: LicenseRef-Proprietary

// The part of the fake GitHub behind the workflow actions (#844): opening a pull request, issues (a number, a title, labels, and the
// comments below them, written and listed), and the labels of an issue or pull request. It sits inside the GitHub App part (`app-api.ts`), which
// authenticates the installation token and finds the repository; the answers are shaped like GitHub's.
//
// Issues and pull requests share the numbers of a repository. A label that is added and is not known is created. Not modelled on
// purpose: label colors and descriptions, issue states other than open.

export type FakeIssue = {
  number: number;
  title: string;
  labels?: string[];
  body?: string;
  /** The logins the issue is assigned to (#916). */
  assignees?: string[];
  /** GitHub's issue type (`Bug`), left out for an issue without one (#916). */
  type?: string;
};

type Stored = {
  number: number;
  title: string;
  labels: string[];
  body?: string;
  assignees?: string[];
  type?: string;
};

type FakeIssueComment = {
  id: number;
  number: number;
  body: string;
  login: string;
};

export type ActionsRequest = {
  method: string;
  /** The path after `/repos/<owner>/<name>`. */
  rest: string;
  query: URLSearchParams;
  repository: { fullName: string };
  /** The numbers pull requests of the repository have. */
  pullRequestNumbers: number[];
  /** Pull requests that are open, by head and base branch. */
  openPullRequest(head: string, base: string): number | undefined;
  /** The branches of the repository with their commits. */
  branches: () => { name: string; sha: string }[];
  defaultBranch: string;
  body: () => Promise<string>;
  mayDo: (names: string[], level: "read" | "write") => boolean;
  /** Writes the pull request and answers its GitHub JSON. */
  createPullRequest(fields: {
    title: string;
    body: string;
    draft: boolean;
    headRef: string;
    baseRef: string;
    headSha: string;
    number: number;
  }): unknown;
};

export type ActionsAnswer = { status: number; body: unknown } | undefined;

export type ActionsApiOptions = {
  webBase: () => string;
  apiBase: () => string;
  botLogin: string;
};

export type ActionsApi = {
  handle(request: ActionsRequest): Promise<ActionsAnswer>;
  addIssue(repoFullName: string, issue: FakeIssue): void;
  labels(repoFullName: string, number: number): string[];
  issueComments(repoFullName: string, number: number): FakeIssueComment[];
  reset(): void;
};

const MAX_PER_PAGE = 100;

export function createActionsApi(options: ActionsApiOptions): ActionsApi {
  const issues = new Map<string, Stored[]>();
  const comments = new Map<string, FakeIssueComment[]>();
  let nextCommentId = 6000;

  const issuesOf = (repo: string) => issues.get(repo) ?? [];
  const forbidden = {
    status: 403,
    body: { message: "Resource not accessible by integration" },
  };
  const notFound = { status: 404, body: { message: "Not Found" } };
  const validation = (message: string, field = "data") => ({
    status: 422,
    body: {
      message: "Validation Failed",
      errors: [{ resource: "PullRequest", code: "custom", field, message }],
    },
  });

  /** An issue the fake knows, or a pull request number: labels live on both. */
  function labelledOf(
    request: ActionsRequest,
    number: number,
  ): Stored | undefined {
    const known = issuesOf(request.repository.fullName).find(
      (issue) => issue.number === number,
    );
    if (known !== undefined) return known;
    if (!request.pullRequestNumbers.includes(number)) return undefined;
    const created: Stored = { number, title: "", labels: [] };
    issues.set(request.repository.fullName, [
      ...issuesOf(request.repository.fullName),
      created,
    ]);
    return created;
  }

  const labelJson = (name: string) => ({
    name,
    color: "ededed",
    default: false,
  });

  async function handle(request: ActionsRequest): Promise<ActionsAnswer> {
    const { method, rest, mayDo, repository } = request;

    if (rest === "/pulls" && method === "POST") {
      if (!mayDo(["pull_requests"], "write")) return forbidden;
      const input = JSON.parse((await request.body()) || "{}") as {
        head?: unknown;
        base?: unknown;
        title?: unknown;
        body?: unknown;
        draft?: unknown;
      };
      if (typeof input.title !== "string" || input.title.trim() === "")
        return validation("title is missing", "title");
      if (typeof input.head !== "string" || typeof input.base !== "string")
        return validation("head and base are needed");
      const branches = request.branches();
      const head = branches.find((branch) => branch.name === input.head);
      const base = branches.find((branch) => branch.name === input.base);
      if (head === undefined) return validation("head is invalid", "head");
      if (base === undefined) return validation("base is invalid", "base");
      const owner = repository.fullName.split("/")[0];
      if (request.openPullRequest(head.name, base.name) !== undefined)
        return validation(
          `A pull request already exists for ${owner}:${head.name}.`,
        );
      if (head.sha === base.sha)
        return validation(`No commits between ${base.name} and ${head.name}`);
      const taken = [
        ...request.pullRequestNumbers,
        ...issuesOf(repository.fullName).map((issue) => issue.number),
      ];
      const number = Math.max(0, ...taken) + 1;
      return {
        status: 201,
        body: request.createPullRequest({
          title: input.title,
          body: typeof input.body === "string" ? input.body : "",
          draft: input.draft === true,
          headRef: head.name,
          baseRef: base.name,
          headSha: head.sha,
          number,
        }),
      };
    }

    // One issue, as `GET /repos/{owner}/{repo}/issues/{n}` answers it (#916). A pull request number answers with `pull_request` set, as GitHub does.
    const issueMatch = /^\/issues\/(\d+)$/.exec(rest);
    if (issueMatch !== null && method === "GET") {
      if (!mayDo(["issues", "pull_requests"], "read")) return forbidden;
      const number = Number(issueMatch[1]);
      const known = issuesOf(repository.fullName).find(
        (issue) => issue.number === number,
      );
      const isPullRequest = request.pullRequestNumbers.includes(number);
      if (known === undefined && !isPullRequest) return notFound;
      return {
        status: 200,
        body: {
          number,
          title: known?.title ?? "",
          body: known?.body ?? null,
          state: "open",
          html_url: `${options.webBase()}/${repository.fullName}/${isPullRequest ? "pull" : "issues"}/${String(number)}`,
          labels: (known?.labels ?? []).map(labelJson),
          assignees: (known?.assignees ?? []).map((login) => ({ login })),
          ...(known?.type === undefined ? {} : { type: { name: known.type } }),
          ...(isPullRequest ? { pull_request: {} } : {}),
        },
      };
    }

    const labelsMatch = /^\/issues\/(\d+)\/labels(?:\/(.+))?$/.exec(rest);
    if (labelsMatch !== null) {
      const number = Number(labelsMatch[1]);
      const name = labelsMatch[2];
      const write = method !== "GET";
      if (!mayDo(["issues", "pull_requests"], write ? "write" : "read"))
        return forbidden;
      const issue = labelledOf(request, number);
      if (issue === undefined) return notFound;
      if (method === "GET" && name === undefined) {
        const perPage = Math.min(
          Math.max(Number(request.query.get("per_page")) || 30, 1),
          MAX_PER_PAGE,
        );
        const page = Math.max(Number(request.query.get("page")) || 1, 1);
        return {
          status: 200,
          body: issue.labels
            .slice((page - 1) * perPage, page * perPage)
            .map(labelJson),
        };
      }
      if (method === "POST" && name === undefined) {
        const input = JSON.parse((await request.body()) || "{}") as {
          labels?: unknown;
        };
        if (
          !Array.isArray(input.labels) ||
          input.labels.some(
            (label) => typeof label !== "string" || label === "",
          )
        )
          return validation("labels must be a list of names", "labels");
        for (const label of input.labels as string[])
          if (!issue.labels.includes(label)) issue.labels.push(label);
        return { status: 200, body: issue.labels.map(labelJson) };
      }
      if (method === "DELETE" && name !== undefined) {
        const label = decodeURIComponent(name);
        if (!issue.labels.includes(label))
          return { status: 404, body: { message: "Label does not exist" } };
        issue.labels = issue.labels.filter((existing) => existing !== label);
        return { status: 200, body: issue.labels.map(labelJson) };
      }
      return undefined;
    }

    // Comments below an issue that is no pull request (those of a pull request are `review-api.ts`'s).
    const commentsMatch = /^\/issues\/(\d+)\/comments$/.exec(rest);
    if (commentsMatch !== null && (method === "POST" || method === "GET")) {
      const number = Number(commentsMatch[1]);
      if (request.pullRequestNumbers.includes(number)) return undefined;
      if (!mayDo(["issues"], method === "POST" ? "write" : "read"))
        return forbidden;
      const issue = issuesOf(repository.fullName).find(
        (candidate) => candidate.number === number,
      );
      if (issue === undefined) return notFound;
      const key = `${repository.fullName}#${String(number)}`;
      const commentJson = (comment: FakeIssueComment) => ({
        id: comment.id,
        body: comment.body,
        user: { login: comment.login, id: 1, type: "Bot" },
        html_url: `${options.webBase()}/${repository.fullName}/issues/${String(number)}#issuecomment-${String(comment.id)}`,
        issue_url: `${options.apiBase()}/repos/${repository.fullName}/issues/${String(number)}`,
      });
      if (method === "GET") {
        const perPage = Math.min(
          Math.max(Number(request.query.get("per_page")) || 30, 1),
          MAX_PER_PAGE,
        );
        const page = Math.max(Number(request.query.get("page")) || 1, 1);
        return {
          status: 200,
          body: (comments.get(key) ?? [])
            .slice((page - 1) * perPage, page * perPage)
            .map(commentJson),
        };
      }
      const input = JSON.parse((await request.body()) || "{}") as {
        body?: unknown;
      };
      if (typeof input.body !== "string" || input.body === "")
        return validation("body is missing", "body");
      nextCommentId += 1;
      const comment: FakeIssueComment = {
        id: nextCommentId,
        number,
        body: input.body,
        login: options.botLogin,
      };
      comments.set(key, [...(comments.get(key) ?? []), comment]);
      return { status: 201, body: commentJson(comment) };
    }
    return undefined;
  }

  return {
    handle,
    addIssue(repoFullName, issue) {
      issues.set(repoFullName, [
        ...issuesOf(repoFullName).filter(
          (item) => item.number !== issue.number,
        ),
        {
          number: issue.number,
          title: issue.title,
          labels: [...(issue.labels ?? [])],
          ...(issue.body === undefined ? {} : { body: issue.body }),
          ...(issue.assignees === undefined
            ? {}
            : { assignees: [...issue.assignees] }),
          ...(issue.type === undefined ? {} : { type: issue.type }),
        },
      ]);
    },
    labels: (repoFullName, number) => [
      ...(issuesOf(repoFullName).find((issue) => issue.number === number)
        ?.labels ?? []),
    ],
    issueComments: (repoFullName, number) =>
      comments.get(`${repoFullName}#${String(number)}`) ?? [],
    reset() {
      issues.clear();
      comments.clear();
      nextCommentId = 6000;
    },
  };
}
