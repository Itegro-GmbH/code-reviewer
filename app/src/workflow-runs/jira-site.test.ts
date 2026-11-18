// SPDX-License-Identifier: LicenseRef-Proprietary

// The wiring of the Jira site of a run's ticket (#1086) with a fake store: the real repositories are in jira-site.integration.test.ts.
import { describe, expect, it } from "vitest";
import type { StoredProject } from "../db/repositories/projects-repository.ts";
import { jiraSiteLookup } from "./jira-site.ts";

function lookupOf(
  source: StoredProject["ticketSource"] | undefined,
  connections: Record<string, { siteUrl: string }>,
) {
  return jiraSiteLookup({
    projects: {
      async get() {
        return source === undefined
          ? undefined
          : ({ ticketSource: source } as StoredProject);
      },
    },
    jiraConnections: {
      async get(id: string) {
        return connections[id] as never;
      },
    },
  });
}

describe("jiraSiteLookup", () => {
  // #1086-T11
  it("gives the site and the project key of the Jira source's connection", async () => {
    const lookup = lookupOf(
      {
        provider: "jira",
        repositoryId: "repo-1",
        board: null,
        connectionId: "conn-a",
        projectKey: "LAT",
      },
      { "conn-a": { siteUrl: "https://acme.atlassian.net" } },
    );

    expect(await lookup("repo-1")).toEqual({
      siteUrl: "https://acme.atlassian.net",
      projectKey: "LAT",
    });
  });

  // #1086-T12
  it("gives nothing for a GitHub source, a repository without a project, and a connection that is not found", async () => {
    const github = { provider: "github", repositoryId: "repo-1", board: null };
    const jira = {
      provider: "jira",
      repositoryId: "repo-1",
      board: null,
      connectionId: "gone",
      projectKey: "LAT",
    };
    const connections = { "conn-a": { siteUrl: "https://acme.atlassian.net" } };

    expect(await lookupOf(github, connections)("repo-1")).toBeUndefined();
    expect(await lookupOf(undefined, connections)("repo-1")).toBeUndefined();
    expect(await lookupOf(jira, connections)("repo-1")).toBeUndefined();
  });
});
