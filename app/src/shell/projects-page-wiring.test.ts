// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down that the Projects page hands the play button's permission to the list (#655): the page
// asks `can(role, "start_review")` and passes the answer on as `canStartReview`. Every real role may
// start a review today, so the permission is stood in for with one that refuses it; the page itself
// runs for real, with the data behind it replaced and the page content recording what it is given.
// The page names itself as its product names the area (#757): Projects for code-review.com, QA for the factory.
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const stub = vi.hoisted(() => ({
  allowStartReview: true,
  contentProps: null as Record<string, unknown> | null,
}));

vi.mock("@/workspaces/access-runtime", () => ({
  requireWorkspace: () =>
    Promise.resolve({
      workspace: { id: "ws-1", slug: "acme" },
      role: "member",
      user: { isInstanceAdmin: false },
    }),
}));
vi.mock("@/workspaces/permissions", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../workspaces/permissions.ts")>();
  return {
    ...real,
    can: (
      role: Parameters<typeof real.can>[0],
      action: Parameters<typeof real.can>[1],
    ) =>
      action === "start_review"
        ? stub.allowStartReview
        : real.can(role, action),
  };
});
vi.mock("@/projects/shared", () => ({ projectServiceFor: () => ({}) }));
vi.mock("@/runs/shared", () => ({ lastRunSourceFor: () => ({}) }));
vi.mock("@/config-status/shared", () => ({ getConfigStatusFor: () => ({}) }));
vi.mock("@/llm/shared", () => ({
  getWorkspaceLlm: () => ({ summaryFor: () => Promise.resolve(null) }),
}));
vi.mock("@/llm/ui/llm-access-notice", () => ({
  llmAccessAttention: () => null,
}));
vi.mock("@/projects/ui/sync-button", () => ({ SyncButton: () => null }));
vi.mock("@/components/page-header", () => ({ PageHeader: () => null }));
vi.mock("@/projects/ui/projects-page", () => ({
  loadProjectsPage: () => Promise.resolve({}),
  ProjectsPageContent: (props: Record<string, unknown>) => {
    stub.contentProps = props;
    return null;
  },
}));

import { PageHeader } from "@/components/page-header";
import ProjectsPage, {
  generateMetadata,
} from "../app/(app)/w/[workspace]/projects/page.tsx";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The elements of a returned tree, depth first. */
function elementsOf(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elementsOf);
  if (!isValidElement(node)) return [];
  const { children } = node.props as { children?: ReactNode };
  return [node, ...elementsOf(children)];
}

/** Runs the page and its async content component, and returns what the list received. */
async function propsOfTheContent(): Promise<Record<string, unknown>> {
  stub.contentProps = null;
  const tree = await ProjectsPage({
    params: Promise.resolve({ workspace: "acme" }),
  } as Parameters<typeof ProjectsPage>[0]);
  const content = elementsOf(tree).find(
    (element) =>
      typeof element.type === "function" &&
      element.type.name === "ProjectsContent",
  );
  if (content === undefined)
    throw new Error("the page renders no ProjectsContent");
  const render = content.type as (props: unknown) => Promise<ReactElement>;
  const output = await render(content.props);
  (output.type as (props: unknown) => unknown)(output.props);
  if (stub.contentProps === null)
    throw new Error("the page content was not rendered");
  return stub.contentProps;
}

describe("the Projects page", () => {
  // #655-T02
  it("shows the play button to a role that may start a review", async () => {
    stub.allowStartReview = true;
    expect((await propsOfTheContent()).canStartReview).toBe(true);
  });

  // #655-T02
  it("hides the play button from a role without the start_review permission", async () => {
    stub.allowStartReview = false;
    expect((await propsOfTheContent()).canStartReview).toBe(false);
  });
});

describe("the name of the Projects page", () => {
  async function headerTitle(): Promise<unknown> {
    const tree = await ProjectsPage({
      params: Promise.resolve({ workspace: "acme" }),
    } as Parameters<typeof ProjectsPage>[0]);
    const header = elementsOf(tree).find(
      (element) => element.type === PageHeader,
    );
    if (header === undefined) throw new Error("the page renders no PageHeader");
    return (header.props as { title: unknown }).title;
  }

  // #757-T01
  it("is Projects for code-review.com, in the browser title and the heading", async () => {
    vi.stubEnv("PRODUCT_ID", "code-review-com");

    expect(generateMetadata()).toStrictEqual({ title: "Projects" });
    expect(await headerTitle()).toBe("Projects");
  });

  // #757-T01
  it("is Projects while PRODUCT_ID is not set", async () => {
    vi.stubEnv("PRODUCT_ID", "");

    expect(generateMetadata()).toStrictEqual({ title: "Projects" });
    expect(await headerTitle()).toBe("Projects");
  });

  // #757-T02
  it("is QA for the factory, in the browser title and the heading", async () => {
    vi.stubEnv("PRODUCT_ID", "factory");

    expect(generateMetadata()).toStrictEqual({ title: "QA" });
    expect(await headerTitle()).toBe("QA");
  });
});
