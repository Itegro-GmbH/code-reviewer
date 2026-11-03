// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment node
// The environments page (#818): outside the capability `implementer` it is the platform's 404 before the session or the workspace
// is looked at (the second wall behind the access proxy), and in the factory it hands the panel the workspace of the address and
// what the role may do, and nothing else.
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
vi.mock("@/db/startup", () => ({ getDatabase: () => ({}) }));

import EnvironmentsPage from "./page.tsx";

afterEach(() => {
  vi.unstubAllEnvs();
  access.requireWorkspace.mockClear();
});

const params = () => ({
  params: Promise.resolve({ workspace: "acme" }),
  searchParams: Promise.resolve({}),
});
const FACTORY_WITH_IMPLEMENTER = {
  PRODUCT_ID: "factory",
  PRODUCT_CAPABILITIES: "review,dynamic-review,implementer",
};

function stub(env: Record<string, string>) {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
}

function elementsOf(node: ReactNode): ReactElement[] {
  if (!isValidElement(node))
    return Array.isArray(node) ? node.flatMap(elementsOf) : [];
  const props = node.props as { children?: ReactNode };
  return [node, ...elementsOf(props.children)];
}

describe("the environments page", () => {
  // #818-T13
  it.each([
    ["code-review.com", { PRODUCT_ID: "code-review-com" }],
    [
      "the factory without the capability",
      { PRODUCT_ID: "factory", PRODUCT_CAPABILITIES: "review,dynamic-review" },
    ],
  ])(
    "is the platform's 404 in %s, before the workspace is looked at",
    async (_name, env) => {
      stub(env);

      await expect(EnvironmentsPage(params())).rejects.toMatchObject({
        digest: "NEXT_HTTP_ERROR_FALLBACK;404",
      });
      expect(access.requireWorkspace).not.toHaveBeenCalled();
    },
  );

  // #818-T13
  it.each([
    ["member", false],
    ["admin", true],
    ["owner", true],
  ] as const)(
    "gives the panel of the workspace in the address and, for a %s, canManage %s",
    async (role, canManage) => {
      stub(FACTORY_WITH_IMPLEMENTER);
      access.requireWorkspace.mockResolvedValueOnce({
        workspace: { id: "workspace-1", slug: "acme" },
        role,
        user: { isInstanceAdmin: false },
      } as never);

      const page = await EnvironmentsPage(params());
      const panel = elementsOf(page).find(
        (element) =>
          typeof element.type === "function" &&
          element.type.name === "EnvironmentsPanel",
      );

      expect(panel?.props).toEqual({ workspaceSlug: "acme", canManage });
      expect(access.requireWorkspace).toHaveBeenCalledWith("acme");
    },
  );
});
