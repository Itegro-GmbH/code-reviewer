// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the calls the project list makes: which route, which method and which body, for
// activating, deactivating and running the sync. The routes themselves are proven where they live.
import { describe, expect, it } from "vitest";
import type { FetchLike } from "../../ui/json-request.ts";
import {
  createInstanceSyncApi,
  createNewProjectApi,
  createProjectsApi,
} from "./api.ts";

function recorder(body: unknown = {}) {
  const calls: Array<{ url: string; method: string; body: string | null }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
    });
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { calls, api: createProjectsApi(fetchImpl, "acme") };
}

describe("the project list's calls", () => {
  // CR-34-T04
  it("activates a repository with PUT on its project route", async () => {
    const { api, calls } = recorder({ active: true });

    const result = await api.setActive("repo-1", true);

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      {
        url: "/api/w/acme/repositories/repo-1/project",
        method: "PUT",
        body: '{"active":true}',
      },
    ]);
  });

  // CR-34-T04
  it("deactivates a repository with the same route and active false", async () => {
    const { api, calls } = recorder();

    await api.setActive("repo-1", false);

    expect(calls[0]?.body).toBe('{"active":false}');
  });

  it("escapes the repository id in the address", async () => {
    const { api, calls } = recorder();

    await api.setActive("a/b?c", true);

    expect(calls[0]?.url).toBe("/api/w/acme/repositories/a%2Fb%3Fc/project");
  });

  // CR-21-T03
  it("runs the sync of the workspace with POST and no body", async () => {
    const { api, calls } = recorder({ added: 1, errors: [] });

    const result = await api.sync();

    expect(result).toEqual({ ok: true, data: { added: 1, errors: [] } });
    expect(calls).toEqual([
      {
        url: "/api/w/acme/integrations/sync",
        method: "POST",
        body: null,
      },
    ]);
  });
});

describe("the instance's call", () => {
  // #103-IB-13
  it("runs the synchronization of the whole instance on the route of the admin portal", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const api = createInstanceSyncApi(async (url, init) => {
      calls.push({ url, method: init?.method ?? "GET" });
      return new Response(JSON.stringify({ added: 0, errors: [] }), {
        status: 200,
      });
    });

    await api.sync();

    expect(calls).toEqual([
      { url: "/api/admin/integrations/sync", method: "POST" },
    ]);
  });
});

describe("the new project dialog's calls (#922)", () => {
  // #922-T35
  it("reads the boards of a repository with GET on its boards route", async () => {
    const calls: Array<{ url: string; method: string; body: string | null }> =
      [];
    const api = createNewProjectApi(async (url, init) => {
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : null,
      });
      return new Response(JSON.stringify({ available: true, boards: [] }), {
        status: 200,
      });
    }, "acme");

    await api.boards("a/b");

    expect(calls).toEqual([
      {
        url: "/api/w/acme/repositories/a%2Fb/boards",
        method: "GET",
        body: null,
      },
    ]);
  });

  // #922-T35
  it("creates a project with POST on the projects route and the body as given", async () => {
    const calls: Array<{ url: string; method: string; body: string | null }> =
      [];
    const api = createNewProjectApi(async (url, init) => {
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : null,
      });
      return new Response(JSON.stringify({ project: {}, lanes: [] }), {
        status: 201,
      });
    }, "acme");

    await api.createProject({
      repositoryId: "repo-1",
      board: { projectV2Id: "PVT_x" },
      lanes: ["issue-to-pr"],
    });

    expect(calls).toEqual([
      {
        url: "/api/w/acme/projects",
        method: "POST",
        body: '{"repositoryId":"repo-1","board":{"projectV2Id":"PVT_x"},"lanes":["issue-to-pr"]}',
      },
    ]);
  });
});
