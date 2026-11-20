// SPDX-License-Identifier: LicenseRef-Proprietary

// Who may save a lane (#1105, ADR 0007 decision 12), at the route files: create, save a new version and archive are for Owners
// and Admins (`manage_workflows`); a Member is refused with 403 `forbidden` before the handler runs, and still reads, validates and
// asks for the scope (`start_implementer_task`). The session and the membership are replaced; the route handlers are fakes that
// only say they ran.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionLookup } from "@/auth/session-user";
import type { WorkspaceRole } from "@/db/workspace-roles";
import { sessionUser } from "@/test-support/session-lookup";

const state = vi.hoisted(() => ({
  lookup: undefined as unknown,
  role: "member" as string,
  ran: [] as string[],
}));

vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("@/implementer/shared", () => ({
  requireImplementerCapability: () => undefined,
}));
vi.mock("@/auth/session", () => ({
  currentLookup: () => Promise.resolve(state.lookup),
}));
vi.mock("@/db/startup", () => ({ getDatabase: () => ({}) }));
vi.mock("@/db/repositories/workspaces-repository", () => ({
  createWorkspacesRepository: () => ({
    findMembership: () =>
      Promise.resolve({
        workspace: { id: "ws-1", slug: "acme" },
        role: state.role,
      }),
  }),
}));
vi.mock("@/workflows/shared", () => ({ workflowServiceFor: () => ({}) }));
vi.mock("@/workflows/http", () => {
  const ran = (name: string) => () => {
    state.ran.push(name);
    return Promise.resolve(Response.json({ ran: name }));
  };
  return {
    createWorkflowRouteHandlers: () => ({
      list: ran("list"),
      create: ran("create"),
      validate: ran("validate"),
      scope: ran("scope"),
      get: ran("get"),
      update: ran("update"),
      archive: ran("archive"),
    }),
  };
});

const collection = await import("./route.ts");
const one = await import("./[workflowId]/route.ts");
const validate = await import("./validate/route.ts");

const request = () => new Request("http://localhost/api/w/acme/workflows");
const collectionContext = { params: Promise.resolve({ workspace: "acme" }) };
const oneContext = {
  params: Promise.resolve({ workspace: "acme", workflowId: "wf-1" }),
};

function actAs(role: WorkspaceRole): void {
  state.role = role;
  state.lookup = {
    kind: "user",
    user: sessionUser("person"),
  } satisfies SessionLookup;
  state.ran = [];
}

/** Each lane write: what it is called and how the route is called. */
const WRITES: [string, () => Promise<Response>, string][] = [
  [
    "create (POST /workflows)",
    () => collection.POST(request(), collectionContext as never),
    "create",
  ],
  [
    "save a new version (PUT /workflows/:id)",
    () => one.PUT(request(), oneContext as never),
    "update",
  ],
  [
    "archive (DELETE /workflows/:id)",
    () => one.DELETE(request(), oneContext as never),
    "archive",
  ],
];

describe("saving a lane needs an Owner or an Admin", () => {
  beforeEach(() => actAs("member"));

  // #1105-T21
  it.each(WRITES)(
    "refuses a Member on %s with 403 forbidden and does not run the handler",
    async (_name, call) => {
      actAs("member");

      const response = await call();

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden" });
      expect(state.ran).toEqual([]);
    },
  );

  // #1105-T22
  it.each(WRITES)("lets an Admin through on %s", async (_name, call, ran) => {
    actAs("admin");

    const response = await call();

    expect(response.status).toBe(200);
    expect(state.ran).toEqual([ran]);
  });

  // #1105-T23
  it.each(WRITES)("lets an Owner through on %s", async (_name, call, ran) => {
    actAs("owner");

    const response = await call();

    expect(response.status).toBe(200);
    expect(state.ran).toEqual([ran]);
  });
});

describe("a Member keeps reading and checking lanes", () => {
  // #1105-T24
  it("lists, reads and validates for a Member", async () => {
    actAs("member");

    const list = await collection.GET(request(), collectionContext as never);
    const read = await one.GET(request(), oneContext as never);
    const check = await validate.POST(request(), collectionContext as never);

    expect([list.status, read.status, check.status]).toEqual([200, 200, 200]);
    expect(state.ran).toEqual(["list", "get", "validate"]);
  });
});
