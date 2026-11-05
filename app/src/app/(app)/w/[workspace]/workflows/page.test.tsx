// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment node
// The three pages of the workflows (#873): outside the capability `implementer` each is the platform's 404 before the session or the
// workspace is looked at (the second wall behind the access proxy), in the factory each asks for the workspace of the address, and a
// workflow or run the workspace does not have is the not-found page. The data is read through the services of the workspace in the
// address, so another workspace's is never reached.
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const access = vi.hoisted(() => ({
  requireWorkspace: vi.fn(async () => ({
    workspace: { id: "workspace-1", slug: "acme" },
    role: "member",
    user: { isInstanceAdmin: false },
  })),
}));
vi.mock("@/workspaces/access-runtime", () => ({
  requireWorkspace: access.requireWorkspace,
}));
const permission = vi.hoisted(() => ({ allowed: true }));
vi.mock("@/workspaces/permissions", () => ({
  can: vi.fn(() => permission.allowed),
}));

const services = vi.hoisted(() => ({
  workflowServiceFor: vi.fn(),
  workflowRunServiceFor: vi.fn(),
}));
vi.mock("@/workflows/shared", () => ({
  workflowServiceFor: services.workflowServiceFor,
}));
vi.mock("@/workflow-runs/shared", () => ({
  workflowRunServiceFor: services.workflowRunServiceFor,
}));

import { WorkflowError } from "@/workflows/errors";
import { WorkflowRunError } from "@/workflow-runs/errors";
import WorkflowsPage from "./page.tsx";
import WorkflowPage from "./[workflowId]/page.tsx";
import WorkflowRunPage from "./[workflowId]/runs/[runId]/page.tsx";

afterEach(() => {
  permission.allowed = true;
  vi.unstubAllEnvs();
  access.requireWorkspace.mockClear();
  services.workflowServiceFor.mockReset();
  services.workflowRunServiceFor.mockReset();
});

const FACTORY = {
  PRODUCT_ID: "factory",
  PRODUCT_CAPABILITIES: "review,dynamic-review,implementer",
};
const searchParams = Promise.resolve({});
const listProps = () => ({
  params: Promise.resolve({ workspace: "acme" }),
  searchParams,
});
const workflowProps = (workflowId: string) => ({
  params: Promise.resolve({ workspace: "acme", workflowId }),
  searchParams,
});
const runProps = (workflowId: string, runId: string) => ({
  params: Promise.resolve({ workspace: "acme", workflowId, runId }),
  searchParams,
});

function stub(env: Record<string, string>) {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
}

/** The elements below a node, depth first. */
function elementsOf(node: ReactNode): ReactElement[] {
  if (!isValidElement(node))
    return Array.isArray(node) ? node.flatMap(elementsOf) : [];
  const props = node.props as { children?: ReactNode };
  return [node, ...elementsOf(props.children)];
}

/** Renders the async content component the page returned, the way the server does. */
async function contentOf(page: ReactNode, name: string) {
  const content = elementsOf(page).find(
    (element) =>
      typeof element.type === "function" && element.type.name === name,
  );
  if (content === undefined) throw new Error(`no ${name} in the page`);
  return (content.type as (props: unknown) => Promise<ReactNode>)(
    content.props,
  );
}

const PAGES = [
  ["the list", () => WorkflowsPage(listProps()), {}],
  ["a workflow", () => WorkflowPage(workflowProps("wf-1")), {}],
  ["a run", () => WorkflowRunPage(runProps("wf-1", "run-1")), {}],
] as const;

describe("the workflow pages", () => {
  // #873-T80
  it.each(PAGES)(
    "%s is the platform's 404 outside the factory, before the workspace is looked at",
    async (_name, render) => {
      stub({ PRODUCT_ID: "code-review-com" });

      await expect(render()).rejects.toMatchObject({
        digest: "NEXT_HTTP_ERROR_FALLBACK;404",
      });
      expect(access.requireWorkspace).not.toHaveBeenCalled();
    },
  );

  // #873-T80
  it.each(PAGES)(
    "%s is the 404 in the factory without the capability",
    async (_name, render) => {
      stub({
        PRODUCT_ID: "factory",
        PRODUCT_CAPABILITIES: "review,dynamic-review",
      });

      await expect(render()).rejects.toMatchObject({
        digest: "NEXT_HTTP_ERROR_FALLBACK;404",
      });
    },
  );

  // #873-T81
  it("shows the not-found page for a workflow the workspace does not have", async () => {
    stub(FACTORY);
    services.workflowServiceFor.mockReturnValue({
      get: async () => {
        throw new WorkflowError(
          "WORKFLOW_NOT_FOUND",
          "There is no such workflow.",
        );
      },
    });
    services.workflowRunServiceFor.mockReturnValue({
      list: async () => ({ runs: [] }),
    });

    const page = await WorkflowPage(workflowProps("wf-of-another"));

    await expect(contentOf(page, "WorkflowContent")).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
    expect(services.workflowServiceFor).toHaveBeenCalledWith("workspace-1");
    expect(access.requireWorkspace).toHaveBeenCalledWith("acme");
  });

  // #873-T81
  it("shows the not-found page for a run the workspace does not have", async () => {
    stub(FACTORY);
    services.workflowServiceFor.mockReturnValue({
      get: async () => ({ id: "wf-1", name: "Flow" }),
    });
    services.workflowRunServiceFor.mockReturnValue({
      get: async () => {
        throw new WorkflowRunError(
          "WORKFLOW_RUN_NOT_FOUND",
          "There is no such run of this workflow.",
        );
      },
    });

    const page = await WorkflowRunPage(runProps("wf-1", "run-of-another"));

    await expect(contentOf(page, "RunContent")).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
    expect(services.workflowRunServiceFor).toHaveBeenCalledWith("workspace-1");
  });

  // #873-T81
  it("does not hide another failure behind the not-found page", async () => {
    stub(FACTORY);
    services.workflowServiceFor.mockReturnValue({
      get: async () => {
        throw new Error("the database is down");
      },
    });
    services.workflowRunServiceFor.mockReturnValue({
      list: async () => ({ runs: [] }),
    });

    const page = await WorkflowPage(workflowProps("wf-1"));

    await expect(contentOf(page, "WorkflowContent")).rejects.toThrow(
      "the database is down",
    );
  });

  // #873-T82
  it("hands the list the workflows of the workspace in the address, and shows a role that may not start a sentence instead", async () => {
    stub(FACTORY);
    services.workflowServiceFor.mockReturnValue({
      list: async () => ({ workflows: [], maximum: 100 }),
    });

    const allowed = await WorkflowsPage(listProps());
    const content = await contentOf(allowed, "WorkflowsContent");
    expect(isValidElement(content)).toBe(true);
    expect(services.workflowServiceFor).toHaveBeenCalledWith("workspace-1");

    permission.allowed = false;
    const refused = await WorkflowsPage(listProps());
    expect(JSON.stringify(refused)).toContain("does not allow");
    expect(
      elementsOf(refused).some(
        (element) =>
          typeof element.type === "function" &&
          element.type.name === "WorkflowsContent",
      ),
    ).toBe(false);
  });
});
