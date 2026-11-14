// SPDX-License-Identifier: LicenseRef-Proprietary

// What a project's ticket source (#1038) asks of a Jira site: the projects the connection's account can browse (the new-project dialog), one
// project by its key (the check of a creation) and the workflow statuses of one project (the status picker of `ticket.statusChanged`, the setup tab). Both are plain reads through
// `JiraTokens.request`, so the token is refreshed, renewed on a 401 and never seen here. Answers are values, never exceptions, and a
// failure holds nothing of what Jira said. The names are Jira's own: the factory has no status model of its own (epic #1034).
import type { JiraReadErrorCode } from "./errors.ts";
import type { JiraTokens } from "./tokens.ts";

export type JiraProject = { id: string; key: string; name: string };

/** `new`, `indeterminate` or `done`: the category Jira files a status under (a status with none counts as `indeterminate`). */
export type JiraStatusCategory = "new" | "indeterminate" | "done";

export type JiraStatus = {
  id: string;
  name: string;
  category: JiraStatusCategory;
};

export type JiraReadFailure = { ok: false; error: JiraReadErrorCode };

export type JiraProjectReader = {
  /**
   * The projects of the connection's site in the order Jira lists them (by name). `complete` is false when the list was cut at
   * `MAX_PROJECT_PAGES` pages.
   */
  listProjects(
    connectionId: string,
  ): Promise<
    { ok: true; projects: JiraProject[]; complete: boolean } | JiraReadFailure
  >;
  /**
   * One project of the site by its key, in one call: how a key a person typed is checked, whatever the number of projects the site
   * has. `jira_project_not_found` is what Jira answers for a key it has not, and also for a project the account may not browse.
   */
  getProject(
    connectionId: string,
    projectKey: string,
  ): Promise<{ ok: true; project: JiraProject } | JiraReadFailure>;
  /** The statuses of the project's workflows, all issue types together, each name once, in the order Jira lists them. */
  listStatuses(
    connectionId: string,
    projectKey: string,
  ): Promise<{ ok: true; statuses: JiraStatus[] } | JiraReadFailure>;
};

/** Jira pages the project search by 50 at most; a site with more than this many pages is cut (and says so). */
export const MAX_PROJECT_PAGES = 100;
const PAGE_SIZE = 50;

/** What can be a Jira project key (upper case letters, digits and underscore; the site's own rule is narrower, never wider). */
export const JIRA_PROJECT_KEY = /^[A-Z][A-Z0-9_]{1,99}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The JSON of an answer, or undefined when it is none. The body of a failed answer is never read. */
async function jsonOf(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/** The failure an answer that is no success stands for. */
function failureOf(status: number): JiraReadFailure {
  if (status === 401 || status === 403)
    return { ok: false, error: "jira_forbidden" };
  if (status === 404) return { ok: false, error: "jira_project_not_found" };
  return { ok: false, error: "jira_unavailable" };
}

function categoryOf(value: unknown): JiraStatusCategory {
  const key =
    isRecord(value) && isRecord(value.statusCategory)
      ? value.statusCategory.key
      : undefined;
  return key === "new" || key === "done" ? key : "indeterminate";
}

export function createJiraProjectReader({
  tokens,
}: {
  tokens: Pick<JiraTokens, "request">;
}): JiraProjectReader {
  /** One GET through the token handling: the parsed body of a 200, or the failure. */
  async function read(
    connectionId: string,
    path: string,
  ): Promise<{ ok: true; body: unknown } | JiraReadFailure> {
    let result;
    try {
      result = await tokens.request(connectionId, path);
    } catch {
      return { ok: false, error: "jira_unavailable" };
    }
    if (!result.ok) return { ok: false, error: result.error };
    if (result.response.status !== 200) {
      await result.response.body?.cancel().catch(() => undefined);
      return failureOf(result.response.status);
    }
    const body = await jsonOf(result.response);
    return body === undefined
      ? { ok: false, error: "jira_unavailable" }
      : { ok: true, body };
  }

  return {
    async listProjects(connectionId) {
      const projects: JiraProject[] = [];
      let startAt = 0;
      for (let pages = 0; pages < MAX_PROJECT_PAGES; pages += 1) {
        const read1 = await read(
          connectionId,
          `/rest/api/3/project/search?startAt=${String(startAt)}&maxResults=${String(PAGE_SIZE)}&orderBy=name`,
        );
        if (!read1.ok) return read1;
        const { body } = read1;
        if (!isRecord(body) || !Array.isArray(body.values))
          return { ok: false, error: "jira_unavailable" };
        const values: unknown[] = body.values;
        for (const value of values)
          if (
            isRecord(value) &&
            typeof value.id === "string" &&
            typeof value.key === "string" &&
            typeof value.name === "string"
          )
            projects.push({ id: value.id, key: value.key, name: value.name });
        startAt += values.length;
        if (
          body.isLast === true ||
          values.length === 0 ||
          (typeof body.total === "number" && startAt >= body.total)
        )
          return { ok: true, projects, complete: true };
      }
      return { ok: true, projects, complete: false };
    },

    async getProject(connectionId, projectKey) {
      // The key is part of the path: only what can be a key goes in.
      if (!JIRA_PROJECT_KEY.test(projectKey))
        return { ok: false, error: "jira_project_not_found" };
      const result = await read(
        connectionId,
        `/rest/api/3/project/${projectKey}`,
      );
      if (!result.ok) return result;
      const { body } = result;
      // The answer must be the project that was asked for (Jira also takes a project id where a key is).
      if (
        !isRecord(body) ||
        typeof body.id !== "string" ||
        typeof body.name !== "string" ||
        body.key !== projectKey
      )
        return { ok: false, error: "jira_unavailable" };
      return {
        ok: true,
        project: { id: body.id, key: projectKey, name: body.name },
      };
    },

    async listStatuses(connectionId, projectKey) {
      // The key is part of the path: only what can be a key goes in.
      if (!JIRA_PROJECT_KEY.test(projectKey))
        return { ok: false, error: "jira_project_not_found" };
      const result = await read(
        connectionId,
        `/rest/api/3/project/${projectKey}/statuses`,
      );
      if (!result.ok) return result;
      if (!Array.isArray(result.body))
        return { ok: false, error: "jira_unavailable" };
      const seen = new Set<string>();
      const statuses: JiraStatus[] = [];
      for (const issueType of result.body as unknown[]) {
        if (!isRecord(issueType) || !Array.isArray(issueType.statuses))
          continue;
        for (const status of issueType.statuses as unknown[]) {
          if (
            !isRecord(status) ||
            typeof status.id !== "string" ||
            typeof status.name !== "string" ||
            seen.has(status.name)
          )
            continue;
          seen.add(status.name);
          statuses.push({
            id: status.id,
            name: status.name,
            category: categoryOf(status),
          });
        }
      }
      return { ok: true, statuses };
    },
  };
}
