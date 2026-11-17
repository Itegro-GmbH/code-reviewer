// SPDX-License-Identifier: LicenseRef-Proprietary

// What the Jira project reader (#1038) asks a site and how it reads the answers: the projects page by page, the workflow statuses of a
// project by issue type without a name twice, and what each failure of the call is called. The calls go through a stub of the token
// handling here (the real handling against the fake Atlassian is in `projects.integration.test.ts`).
import { describe, expect, it } from "vitest";
import type { JiraRequestResult, JiraTokens } from "./tokens.ts";
import { createJiraProjectReader } from "./projects.ts";

function answer(status: number, body: unknown): JiraRequestResult {
  return {
    ok: true,
    response: new Response(
      typeof body === "string" ? body : JSON.stringify(body),
      { status },
    ),
  };
}

function readerOver(
  respond: (path: string) => JiraRequestResult | Promise<JiraRequestResult>,
) {
  const paths: string[] = [];
  const tokens: Pick<JiraTokens, "request"> = {
    request: async (_connection, path) => {
      paths.push(path);
      return respond(path);
    },
  };
  return { reader: createJiraProjectReader({ tokens }), paths };
}

const page = (
  values: { id: string; key: string; name: string }[],
  isLast: boolean,
) => answer(200, { startAt: 0, isLast, total: 3, values });

describe("reading the projects of a site", () => {
  // #1038
  it("follows the pages until Jira says the last one, and keeps the order of the site", async () => {
    const { reader, paths } = readerOver((path) =>
      path.includes("startAt=0")
        ? page(
            [
              { id: "1", key: "ALPHA", name: "Alpha" },
              { id: "2", key: "BETA", name: "Beta" },
            ],
            false,
          )
        : page([{ id: "3", key: "GAMMA", name: "Gamma" }], true),
    );

    const result = await reader.listProjects("conn-1");

    expect(result).toEqual({
      ok: true,
      complete: true,
      projects: [
        { id: "1", key: "ALPHA", name: "Alpha" },
        { id: "2", key: "BETA", name: "Beta" },
        { id: "3", key: "GAMMA", name: "Gamma" },
      ],
    });
    expect(paths).toEqual([
      "/rest/api/3/project/search?startAt=0&maxResults=50&orderBy=name",
      "/rest/api/3/project/search?startAt=2&maxResults=50&orderBy=name",
    ]);
  });

  // #1038
  it("stops on an empty page even when Jira never says last, and says the list is not complete when it gave up", async () => {
    const endless = readerOver(() =>
      answer(200, {
        isLast: false,
        values: [{ id: "1", key: "ALPHA", name: "Alpha" }],
      }),
    );
    const result = await endless.reader.listProjects("conn-1");
    expect(result).toMatchObject({ ok: true, complete: false });
    expect(endless.paths.length).toBeLessThanOrEqual(100);

    const empty = readerOver(() => page([], false));
    expect(await empty.reader.listProjects("conn-1")).toEqual({
      ok: true,
      complete: true,
      projects: [],
    });
  });

  // #1038
  it("skips an entry that is no project and names every failure with a stable code", async () => {
    const odd = readerOver(() =>
      answer(200, {
        isLast: true,
        values: [
          { id: "1", key: "ALPHA", name: "Alpha" },
          { id: 2 },
          null,
          "x",
        ],
      }),
    );
    expect(await odd.reader.listProjects("conn-1")).toMatchObject({
      ok: true,
      projects: [{ id: "1", key: "ALPHA", name: "Alpha" }],
    });

    const codes = async (
      respond: Parameters<typeof readerOver>[0],
    ): Promise<unknown> =>
      (await readerOver(respond).reader.listProjects("conn-1")) as unknown;
    expect(await codes(() => answer(401, {}))).toEqual({
      ok: false,
      error: "jira_forbidden",
    });
    expect(await codes(() => answer(403, {}))).toEqual({
      ok: false,
      error: "jira_forbidden",
    });
    expect(await codes(() => answer(429, {}))).toEqual({
      ok: false,
      error: "jira_unavailable",
    });
    expect(await codes(() => answer(500, {}))).toEqual({
      ok: false,
      error: "jira_unavailable",
    });
    expect(await codes(() => answer(200, "not json"))).toEqual({
      ok: false,
      error: "jira_unavailable",
    });
    expect(
      await codes(() => ({ ok: false, error: "jira_connection_broken" })),
    ).toEqual({ ok: false, error: "jira_connection_broken" });
    expect(
      await codes(() => {
        throw new Error("network");
      }),
    ).toEqual({ ok: false, error: "jira_unavailable" });
  });
});

describe("reading one project of a site", () => {
  // #1038 (finding of the review of #1044)
  it("asks for the one project by its key, in one call, and never for the list", async () => {
    const { reader, paths } = readerOver(() =>
      answer(200, { id: "10000", key: "PROJ", name: "Project", style: "x" }),
    );

    expect(await reader.getProject("conn-1", "PROJ")).toEqual({
      ok: true,
      project: { id: "10000", key: "PROJ", name: "Project" },
    });
    expect(paths).toEqual(["/rest/api/3/project/PROJ"]);
  });

  // #1038 (finding of the review of #1044)
  it("refuses a key that is not one before any call, names an unknown project and an answer that is no project, and names every failure", async () => {
    const { reader, paths } = readerOver(() => answer(404, {}));

    expect(await reader.getProject("conn-1", "../myself")).toEqual({
      ok: false,
      error: "jira_project_not_found",
    });
    expect(await reader.getProject("conn-1", "")).toEqual({
      ok: false,
      error: "jira_project_not_found",
    });
    expect(paths).toEqual([]);
    expect(await reader.getProject("conn-1", "NOPE")).toEqual({
      ok: false,
      error: "jira_project_not_found",
    });
    const result = (respond: Parameters<typeof readerOver>[0]) =>
      readerOver(respond).reader.getProject("conn-1", "PROJ");
    // The answer must be the project that was asked for: Jira also takes an id where a key is, and a site may answer anything.
    expect(await result(() => answer(200, { not: "a project" }))).toEqual({
      ok: false,
      error: "jira_unavailable",
    });
    expect(
      await result(() => answer(200, { id: "1", key: "OTHER", name: "x" })),
    ).toEqual({ ok: false, error: "jira_unavailable" });
    expect(await result(() => answer(403, {}))).toEqual({
      ok: false,
      error: "jira_forbidden",
    });
    expect(await result(() => answer(500, {}))).toEqual({
      ok: false,
      error: "jira_unavailable",
    });
    expect(
      await result(() => ({ ok: false, error: "jira_connection_broken" })),
    ).toEqual({ ok: false, error: "jira_connection_broken" });
  });
});

describe("reading the statuses of a project", () => {
  const statuses = (name: string, ids: [string, string][]) => ({
    id: "t",
    name,
    statuses: ids.map(([id, label]) => ({
      id,
      name: label,
      statusCategory: { key: label === "Done" ? "done" : "indeterminate" },
    })),
  });

  // #1038-T02
  it("lists the workflow statuses of all issue types in Jira's order, each name once, with Jira's own spelling", async () => {
    const { reader, paths } = readerOver(() =>
      answer(200, [
        statuses("Task", [
          ["1", "To Do"],
          ["2", "Ready for agent"],
          ["3", "Done"],
        ]),
        statuses("Bug", [
          ["1", "To Do"],
          ["4", "In Review"],
          ["3", "Done"],
        ]),
      ]),
    );

    const result = await reader.listStatuses("conn-1", "PROJ");

    expect(result).toEqual({
      ok: true,
      statuses: [
        { id: "1", name: "To Do", category: "indeterminate" },
        { id: "2", name: "Ready for agent", category: "indeterminate" },
        { id: "3", name: "Done", category: "done" },
        { id: "4", name: "In Review", category: "indeterminate" },
      ],
    });
    expect(paths).toEqual(["/rest/api/3/project/PROJ/statuses"]);
  });

  // #1038
  it("refuses a project key that is not one before any call, and names an unknown project", async () => {
    const { reader, paths } = readerOver(() => answer(404, {}));

    expect(await reader.listStatuses("conn-1", "../myself")).toEqual({
      ok: false,
      error: "jira_project_not_found",
    });
    expect(await reader.listStatuses("conn-1", "")).toEqual({
      ok: false,
      error: "jira_project_not_found",
    });
    expect(paths).toEqual([]);
    expect(await reader.listStatuses("conn-1", "NOPE")).toEqual({
      ok: false,
      error: "jira_project_not_found",
    });
    expect(
      await readerOver(() =>
        answer(200, { not: "a list" }),
      ).reader.listStatuses("conn-1", "PROJ"),
    ).toEqual({ ok: false, error: "jira_unavailable" });
  });
});
