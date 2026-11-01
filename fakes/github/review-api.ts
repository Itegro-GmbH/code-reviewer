// SPDX-License-Identifier: LicenseRef-Proprietary

// The part of the fake GitHub that a reviewer reads and writes: the files and the diff of a pull
// request, its commits, the contents of files, and the comments below it. These are the calls the
// GitHub provider of PR-Agent makes (through PyGithub) when the runner reviews a pull request, so
// the real PR-Agent can run against the fake. It sits inside the GitHub App part (`app-api.ts`),
// which authenticates the installation token, finds the repository and hands the rest of the path
// over; the answers are shaped like GitHub's.
//
// A comment is stored with the pull request it belongs to. Its author is the bot of the app
// (`<slug>[bot]`), which is what makes PR-Agent edit its earlier review instead of posting another.
// Faults are injected with `fail()` of the whole fake (any path), not here. Dummy data only.
//
// Routes that name a pull request (`/pulls/7`, `/issues/7/comments`) serve that one. The routes
// that name a commit or a ref (`/commits/<sha>`, `/compare/...`, `/contents/...?ref=`) serve the
// pull request that has this head. A ref that is no head (the default branch, the base commit) is
// answered only when it is unambiguous: with one pull request in the repository it is that one's,
// with several a file is served when all of them that have it agree on its text, and everything
// else is a 404. A fake that guessed would let a test pass on the wrong pull request.
//
// Not modelled on purpose, as in the engine suite's own fake (runner/tests/engine/fake_github.py):
// inline review comments, labels and paging (every list comes whole). Check runs and pull request reviews are
// served by `checks-api.ts`.

/** GitHub refuses a comment longer than this with a 422. */
export const MAX_COMMENT_CHARS = 65536;

/** A file of a pull request: its diff and the text on both sides. */
export type FakeChangedFile = {
  filename: string;
  baseContent: string;
  headContent: string;
  patch: string;
  status?: "added" | "modified" | "removed";
};

export type FakeComment = {
  id: number;
  /** The pull request the comment is below. */
  pullRequestNumber: number;
  body: string;
  /** The login of the author, for example `code-reviewer-e2e[bot]`. */
  login: string;
  htmlUrl: string;
  /** 1 when written, plus one for every edit: tells an edit in place from a second comment. */
  revision: number;
};

/** The pull request as the review calls need it (a `FakePullRequest` of `app-api.ts` fits). */
export type ReviewedPullRequest = {
  number: number;
  title: string;
  body?: string;
  state: "open" | "closed";
  merged?: boolean;
  draft?: boolean;
  headSha: string;
  headRef: string;
  baseRef: string;
  author: { login: string; id: number };
  files?: FakeChangedFile[];
};

export type ReviewedRepository = {
  id: number;
  fullName: string;
  defaultBranch?: string;
  private?: boolean;
};

const NOW = "2026-10-10T12:00:00Z";
const EDITED = "2026-10-10T12:05:00Z";
/** The commit every pull request is based on. */
export const BASE_SHA = "b".repeat(40);

/** A small Python change, enough for PR-Agent to build a prompt from (same as the engine suite). */
export function defaultFiles(): FakeChangedFile[] {
  return [
    {
      filename: "greeting.py",
      baseContent: 'def greet(name):\n    return "Hello"\n',
      headContent:
        'def greet(name):\n    return f"Hello, {name}!"\n\n\n' +
        'def farewell(name):\n    return f"Bye, {name}"\n',
      patch:
        "@@ -1,2 +1,6 @@\n" +
        " def greet(name):\n" +
        '-    return "Hello"\n' +
        '+    return f"Hello, {name}!"\n' +
        "+\n" +
        "+\n" +
        "+def farewell(name):\n" +
        '+    return f"Bye, {name}"\n',
    },
  ];
}

function additions(file: FakeChangedFile): number {
  return file.patch.split("\n").filter((line) => line.startsWith("+")).length;
}
function deletions(file: FakeChangedFile): number {
  return file.patch.split("\n").filter((line) => line.startsWith("-")).length;
}

export type ReviewApiOptions = {
  /** The address the links of the fake point to (`html_url`), no trailing slash. */
  webBase: () => string;
  /** The address of the REST API (`url`), no trailing slash. */
  apiBase: () => string;
  /**
   * The address the `html_url` of comments points to; `webBase` when omitted. A real GitHub answers with
   * github.com whatever API address is used, and the Runs page shows a comment link only for github.com.
   */
  commentWebBase?: () => string;
  /** The login the app's comments are written as. */
  botLogin: string;
};

/** What the part needs to know about a request, from the App part that routed it. */
export type ReviewRequest = {
  method: string;
  /** The path after `/repos/<owner>/<name>`. */
  rest: string;
  query: URLSearchParams;
  repository: ReviewedRepository;
  /** Every pull request of the repository, oldest first. */
  pullRequests: ReviewedPullRequest[];
  /** The branches of the repository, by name, each at its commit. */
  branches: () => { name: string; sha: string }[];
  body: () => Promise<string>;
  /** Does the token hold at least this level of one of these permissions? */
  mayDo: (permissions: string[], level: "read" | "write") => boolean;
  /** Replaces fields of a stored pull request (a `PATCH` of its title or body). */
  changePullRequest: (
    number: number,
    changes: { title?: string; body?: string },
  ) => ReviewedPullRequest;
};

export type ReviewApiAnswer = { status: number; body: unknown } | undefined;

export type ReviewApi = {
  /** Undefined when the path is not one of this part's. */
  handle(request: ReviewRequest): Promise<ReviewApiAnswer>;
  /** The pull request as GitHub's pull request endpoints show it. */
  pullRequestJson(
    repository: ReviewedRepository,
    pullRequest: ReviewedPullRequest,
  ): unknown;
  comments(repoFullName: string, number: number): FakeComment[];
  addComment(
    repoFullName: string,
    number: number,
    body: string,
    login?: string,
  ): FakeComment;
  reset(): void;
};

export function createReviewApi(options: ReviewApiOptions): ReviewApi {
  const store = new Map<string, FakeComment[]>();
  let nextCommentId = 4000;

  const keyOf = (repoFullName: string, number: number) =>
    `${repoFullName}#${String(number)}`;

  function commentsOf(repoFullName: string, number: number): FakeComment[] {
    return store.get(keyOf(repoFullName, number)) ?? [];
  }

  function addComment(
    repoFullName: string,
    number: number,
    body: string,
    login: string = options.botLogin,
  ): FakeComment {
    nextCommentId += 1;
    const comment: FakeComment = {
      id: nextCommentId,
      pullRequestNumber: number,
      body,
      login,
      htmlUrl: `${(options.commentWebBase ?? options.webBase)()}/${repoFullName}/pull/${String(number)}#issuecomment-${String(nextCommentId)}`,
      revision: 1,
    };
    store.set(keyOf(repoFullName, number), [
      ...commentsOf(repoFullName, number),
      comment,
    ]);
    return comment;
  }

  /** Looks a comment up by its id in any pull request of the repository. */
  function findComment(
    repoFullName: string,
    id: number,
  ): FakeComment | undefined {
    for (const [key, list] of store) {
      if (!key.startsWith(`${repoFullName}#`)) continue;
      const comment = list.find((item) => item.id === id);
      if (comment) return comment;
    }
    return undefined;
  }

  const userJson = (login: string, id = 1) => ({
    login,
    id,
    type: login.endsWith("[bot]") ? "Bot" : "User",
  });

  const api = (repo: ReviewedRepository, suffix = "") =>
    `${options.apiBase()}/repos/${repo.fullName}${suffix}`;
  const web = (repo: ReviewedRepository, suffix = "") =>
    `${options.webBase()}/${repo.fullName}${suffix}`;

  function repositoryJson(repo: ReviewedRepository) {
    const [owner = ""] = repo.fullName.split("/");
    return {
      id: repo.id,
      name: repo.fullName.split("/")[1],
      full_name: repo.fullName,
      owner: userJson(owner),
      private: repo.private ?? false,
      default_branch: repo.defaultBranch ?? "main",
      url: api(repo),
      html_url: web(repo),
    };
  }

  function branchRef(repo: ReviewedRepository, name: string, sha: string) {
    const [owner = ""] = repo.fullName.split("/");
    return {
      label: `${owner}:${name}`,
      ref: name,
      sha,
      repo: repositoryJson(repo),
    };
  }

  function branchJson(branch: { name: string; sha: string }) {
    return {
      name: branch.name,
      commit: { sha: branch.sha },
      protected: false,
    };
  }

  const filesOf = (pr: ReviewedPullRequest) => pr.files ?? defaultFiles();

  function fileJson(file: FakeChangedFile) {
    return {
      sha: "3".repeat(40),
      filename: file.filename,
      status: file.status ?? "modified",
      additions: additions(file),
      deletions: deletions(file),
      changes: additions(file) + deletions(file),
      patch: file.patch,
    };
  }

  function commitJson(repo: ReviewedRepository, pr: ReviewedPullRequest) {
    const author = { name: "Alice", email: "alice@example.com", date: NOW };
    return {
      sha: pr.headSha,
      url: api(repo, `/commits/${pr.headSha}`),
      html_url: web(repo, `/commit/${pr.headSha}`),
      commit: { message: "Add a greeting helper", author, committer: author },
      author: userJson(pr.author.login, pr.author.id),
      committer: userJson(pr.author.login, pr.author.id),
      parents: [{ sha: BASE_SHA }],
      files: filesOf(pr).map(fileJson),
    };
  }

  function pullRequestJson(repo: ReviewedRepository, pr: ReviewedPullRequest) {
    const number = String(pr.number);
    return {
      number: pr.number,
      title: pr.title,
      body: pr.body ?? "",
      html_url: web(repo, `/pull/${number}`),
      url: api(repo, `/pulls/${number}`),
      issue_url: api(repo, `/issues/${number}`),
      state: pr.state,
      merged: pr.merged ?? false,
      merged_at: pr.merged ? "2026-10-09T10:00:00Z" : null,
      draft: pr.draft ?? false,
      user: userJson(pr.author.login, pr.author.id),
      head: branchRef(repo, pr.headRef, pr.headSha),
      base: branchRef(repo, pr.baseRef, BASE_SHA),
      changed_files: filesOf(pr).length,
      commits: 1,
      labels: [],
      created_at: NOW,
      updated_at: NOW,
    };
  }

  /**
   * The pull request a commit or ref belongs to: the one with this head, else the only pull request
   * of the repository, else none (ambiguous).
   */
  function pullRequestFor(
    pullRequests: ReviewedPullRequest[],
    hint: string,
  ): ReviewedPullRequest | undefined {
    return (
      pullRequests.find((pr) => pr.headSha === hint || pr.headRef === hint) ??
      (pullRequests.length === 1 ? pullRequests[0] : undefined)
    );
  }

  /** The text of a file at a ref, strictly by ref (the head and the base do not see each other's files). */
  function fileText(
    repo: ReviewedRepository,
    pr: ReviewedPullRequest,
    path: string,
    ref: string,
  ): string | undefined {
    const defaultBranch = repo.defaultBranch ?? "main";
    const file = filesOf(pr).find((item) => item.filename === path);
    if (file === undefined) return undefined;
    if (ref === pr.headSha || ref === pr.headRef) return file.headContent;
    if (ref === "" || ref === defaultBranch || ref === BASE_SHA)
      return file.status === "added" ? undefined : file.baseContent;
    return undefined;
  }

  function commentJson(repo: ReviewedRepository, comment: FakeComment) {
    return {
      id: comment.id,
      body: comment.body,
      user: userJson(comment.login),
      created_at: NOW,
      updated_at: comment.revision > 1 ? EDITED : NOW,
      url: api(repo, `/issues/comments/${String(comment.id)}`),
      html_url: comment.htmlUrl,
      issue_url: api(repo, `/issues/${String(comment.pullRequestNumber)}`),
    };
  }

  const notFound = { status: 404, body: { message: "Not Found" } };
  const forbidden = {
    status: 403,
    body: { message: "Resource not accessible by integration" },
  };

  async function handle(request: ReviewRequest): Promise<ReviewApiAnswer> {
    const { method, rest, query, repository, pullRequests, branches, mayDo } =
      request;

    if (rest === "" && method === "GET") {
      if (!mayDo(["metadata"], "read")) return forbidden;
      return { status: 200, body: repositoryJson(repository) };
    }
    if (rest === "/languages" && method === "GET") {
      if (!mayDo(["metadata"], "read")) return forbidden;
      return { status: 200, body: { Python: 1000 } };
    }
    if (rest === "/branches" && method === "GET") {
      if (!mayDo(["contents"], "read")) return forbidden;
      const perPage = Math.min(
        Math.max(Number(query.get("per_page")) || 30, 1),
        100,
      );
      const page = Math.max(Number(query.get("page")) || 1, 1);
      return {
        status: 200,
        body: branches()
          .slice((page - 1) * perPage, page * perPage)
          .map((branch) => branchJson(branch)),
      };
    }
    // The name may come percent encoded (`feature%2Fx`) or with its slashes.
    const branchMatch = /^\/branches\/(.+)$/.exec(rest);
    if (branchMatch && method === "GET") {
      if (!mayDo(["contents"], "read")) return forbidden;
      let name: string;
      try {
        name = decodeURIComponent(branchMatch[1] ?? "");
      } catch {
        return notFound;
      }
      const branch = branches().find((item) => item.name === name);
      return branch === undefined
        ? { status: 404, body: { message: "Branch not found" } }
        : { status: 200, body: branchJson(branch) };
    }

    // A comment is addressed by its id alone.
    const commentMatch = /^\/issues\/comments\/(\d+)$/.exec(rest);
    if (commentMatch && method === "GET") {
      if (!mayDo(["issues", "pull_requests"], "read")) return forbidden;
      const comment = findComment(repository.fullName, Number(commentMatch[1]));
      if (comment === undefined) return notFound;
      return { status: 200, body: commentJson(repository, comment) };
    }
    if (commentMatch && (method === "PATCH" || method === "DELETE")) {
      if (!mayDo(["issues", "pull_requests"], "write")) return forbidden;
      const comment = findComment(repository.fullName, Number(commentMatch[1]));
      if (comment === undefined) return notFound;
      if (method === "DELETE") {
        store.set(
          keyOf(repository.fullName, comment.pullRequestNumber),
          commentsOf(repository.fullName, comment.pullRequestNumber).filter(
            (item) => item !== comment,
          ),
        );
        return { status: 204, body: undefined };
      }
      const body = commentBodyOf(await request.body());
      if (body.length > MAX_COMMENT_CHARS) return tooLong();
      comment.body = body;
      comment.revision += 1;
      return { status: 200, body: commentJson(repository, comment) };
    }

    // The routes that name a pull request.
    const numbered = /^\/(?:pulls|issues)\/(\d+)(\/.*)?$/.exec(rest);
    if (numbered) {
      const pr = pullRequests.find(
        (item) => item.number === Number(numbered[1]),
      );
      if (pr === undefined) return notFound;
      return handleNumbered(request, pr, numbered[2] ?? "");
    }

    // The routes that name a commit or a ref.
    const commitMatch = /^\/commits\/([0-9a-f]+)$/.exec(rest);
    if (commitMatch && method === "GET") {
      if (!mayDo(["contents"], "read")) return forbidden;
      const pr = pullRequestFor(pullRequests, commitMatch[1] ?? "");
      return pr === undefined
        ? notFound
        : { status: 200, body: commitJson(repository, pr) };
    }
    const compareMatch = /^\/compare\/(.+)$/.exec(rest);
    if (compareMatch && method === "GET") {
      if (!mayDo(["contents"], "read")) return forbidden;
      const head = decodeURIComponent(compareMatch[1] ?? "")
        .split(/\.{2,3}/)
        .at(-1);
      const pr = pullRequestFor(pullRequests, head ?? "");
      if (pr === undefined) return notFound;
      const commit = commitJson(repository, pr);
      return {
        status: 200,
        body: {
          status: "ahead",
          ahead_by: 1,
          behind_by: 0,
          total_commits: 1,
          merge_base_commit: { ...commit, sha: BASE_SHA },
          commits: [commit],
          files: filesOf(pr).map(fileJson),
        },
      };
    }
    const contentsMatch = /^\/contents\/(.+)$/.exec(rest);
    if (contentsMatch && method === "GET") {
      if (!mayDo(["contents"], "read")) return forbidden;
      const path = decodeURIComponent(contentsMatch[1] ?? "");
      const ref = request.query.get("ref") ?? "";
      const named = pullRequestFor(pullRequests, ref);
      // A ref that names no pull request (the default branch): every pull request that has the file
      // must agree on its text.
      const candidates = named === undefined ? pullRequests : [named];
      const found = candidates.flatMap((candidate) => {
        const value = fileText(repository, candidate, path, ref);
        return value === undefined ? [] : [{ pr: candidate, text: value }];
      });
      const [first] = found;
      if (first === undefined || found.some((item) => item.text !== first.text))
        return notFound;
      const { pr, text } = first;
      return {
        status: 200,
        body: {
          type: "file",
          name: path.split("/").at(-1),
          path,
          sha: "4".repeat(40),
          size: text.length,
          encoding: "base64",
          content: Buffer.from(text).toString("base64"),
          url: api(repository, `/contents/${path}`),
          html_url: web(repository, `/blob/${pr.headRef}/${path}`),
        },
      };
    }
    return undefined;
  }

  async function handleNumbered(
    request: ReviewRequest,
    pr: ReviewedPullRequest,
    tail: string,
  ): Promise<ReviewApiAnswer> {
    const { method, repository, mayDo } = request;
    const isPull = request.rest.startsWith("/pulls/");

    if (isPull && tail === "" && method === "GET") {
      if (!mayDo(["pull_requests"], "read")) return forbidden;
      return { status: 200, body: pullRequestJson(repository, pr) };
    }
    if (isPull && tail === "" && method === "PATCH") {
      if (!mayDo(["pull_requests"], "write")) return forbidden;
      const changes = JSON.parse((await request.body()) || "{}") as {
        title?: unknown;
        body?: unknown;
      };
      const changed = request.changePullRequest(pr.number, {
        ...(typeof changes.title === "string" ? { title: changes.title } : {}),
        ...(typeof changes.body === "string" ? { body: changes.body } : {}),
      });
      return { status: 200, body: pullRequestJson(repository, changed) };
    }
    if (isPull && method === "GET") {
      if (!mayDo(["pull_requests"], "read")) return forbidden;
      if (tail === "/comments" || tail === "/reviews")
        return { status: 200, body: [] };
      if (tail === "/commits")
        return { status: 200, body: [commitJson(repository, pr)] };
      if (tail === "/files")
        return { status: 200, body: filesOf(pr).map(fileJson) };
      return undefined;
    }

    if (!isPull && tail === "" && method === "GET") {
      if (!mayDo(["issues", "pull_requests"], "read")) return forbidden;
      const number = String(pr.number);
      return {
        status: 200,
        body: {
          number: pr.number,
          title: pr.title,
          body: pr.body ?? "",
          state: pr.state,
          user: userJson(pr.author.login, pr.author.id),
          url: api(repository, `/issues/${number}`),
          html_url: web(repository, `/pull/${number}`),
          comments_url: api(repository, `/issues/${number}/comments`),
          pull_request: { url: api(repository, `/pulls/${number}`) },
        },
      };
    }
    if (!isPull && tail === "/comments" && method === "GET") {
      if (!mayDo(["issues", "pull_requests"], "read")) return forbidden;
      return {
        status: 200,
        body: commentsOf(repository.fullName, pr.number).map((comment) =>
          commentJson(repository, comment),
        ),
      };
    }
    if (!isPull && tail === "/comments" && method === "POST") {
      if (!mayDo(["issues", "pull_requests"], "write")) return forbidden;
      const body = commentBodyOf(await request.body());
      if (body.length > MAX_COMMENT_CHARS) return tooLong();
      const comment = addComment(repository.fullName, pr.number, body);
      return { status: 201, body: commentJson(repository, comment) };
    }
    return undefined;
  }

  return {
    handle,
    pullRequestJson,
    comments: commentsOf,
    addComment,
    reset() {
      store.clear();
      nextCommentId = 4000;
    },
  };
}

function commentBodyOf(text: string): string {
  const parsed = JSON.parse(text === "" ? "{}" : text) as { body?: unknown };
  return typeof parsed.body === "string" ? parsed.body : "";
}

function tooLong() {
  return {
    status: 422,
    body: {
      message: "Validation Failed",
      errors: [
        {
          resource: "IssueComment",
          code: "unprocessable",
          field: "data",
          message: `Body is too long (maximum is ${String(MAX_COMMENT_CHARS)} characters)`,
        },
      ],
    },
  };
}
