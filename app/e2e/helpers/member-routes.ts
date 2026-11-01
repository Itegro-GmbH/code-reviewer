// SPDX-License-Identifier: LicenseRef-Proprietary

// The routes a member of a workspace can read, taken from the app router itself (#435): every page below `(app)` that is
// not the instance portal, and every route of the workspace API (and the account and workspace-list routes) that
// exports a GET. A route added to the app is read by the privacy search of the catalog journey without a line here; one
// with a parameter this file does not know fails the journey loudly, so nobody forgets to say what to put there.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type MemberRoute = {
  kind: "page" | "api";
  /** `/w/:workspace/runs/:id` */
  pattern: string;
  /** The title the page declares, when it declares a literal one. */
  title: string | undefined;
  params: string[];
};

const APP = join(process.cwd(), "src", "app");
// What a member of a workspace reaches in the API, by the directory below `src/app`.
const API_ROOTS = ["api/w/[workspace]", "api/workspaces", "api/account"];
const GET_EXPORT = /export\s+(?:async\s+)?(?:function\s+GET\b|const\s+GET\b)/;

function filesBelow(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? filesBelow(join(dir, entry.name))
      : [join(dir, entry.name)],
  );
}

function patternOf(relative: string): { pattern: string; params: string[] } {
  const params: string[] = [];
  const segments = relative
    .split("/")
    .slice(0, -1)
    // Route groups, such as `(app)`, are not part of the address.
    .filter((segment) => !/^\(.*\)$/.test(segment))
    .map((segment) => {
      const optional = /^\[\[\.\.\.(\w+)\]\]$/.exec(segment);
      if (optional !== null) {
        params.push(`${optional[1] ?? ""}?`);
        return null;
      }
      const dynamic = /^\[(\w+)\]$/.exec(segment);
      if (dynamic === null) return segment;
      params.push(dynamic[1] ?? "");
      return `:${dynamic[1] ?? ""}`;
    })
    .filter((segment): segment is string => segment !== null);
  return { pattern: `/${segments.join("/")}`, params };
}

export function memberRoutes(): MemberRoute[] {
  const routes: MemberRoute[] = [];
  for (const file of filesBelow(APP)) {
    const relative = file.slice(APP.length + 1).replaceAll("\\", "/");
    const source = readFileSync(file, "utf8");
    if (relative.endsWith("/route.ts")) {
      if (!API_ROOTS.some((root) => relative.startsWith(`${root}/`))) continue;
      if (!GET_EXPORT.test(source)) continue;
      routes.push({ kind: "api", ...patternOf(relative), title: undefined });
      continue;
    }
    if (!relative.endsWith("/page.tsx")) continue;
    if (!relative.startsWith("(app)/")) continue;
    if (relative.startsWith("(app)/instance-portal/")) continue;
    routes.push({
      kind: "page",
      ...patternOf(relative),
      title: /title:\s*"([^"]+)"/.exec(source)?.[1],
    });
  }
  return routes.sort((a, b) => a.pattern.localeCompare(b.pattern));
}

/** What the journey knows about the workspace it reads. */
export type RouteValues = {
  slug: string;
  repositoryId: string;
  runIds: string[];
};

/** The addresses a route stands for here. `refused` ones are made up: what they answer is a 4xx, scanned like the rest. */
export function addressesOf(
  route: MemberRoute,
  values: RouteValues,
): Array<{ path: string; refused: boolean }> {
  // The billing routes of a workspace are for an Owner or an Admin (`manage_billing`, #499), and a missing path while billing is
  // off: whoever reads here is a Member of a workspace on the operator's key, so every address answers a 4xx, scanned like any other.
  // The billing page of a workspace (#505) is the same: it exists only while billing is on, and this workspace's app has it off. So
  // is the key mode a workspace chooses (#496). The routes behind the Implementer form (#755) exist only in a deployment with the
  // capability `implementer`, and so does its page (#756); the app of this journey has not, so they answer the 404 of a path that does
  // not exist.
  let results: Array<{ path: string; refused: boolean }> = [
    {
      path: route.pattern,
      refused:
        route.pattern.startsWith("/api/w/:workspace/billing/") ||
        route.pattern === "/api/w/:workspace/llm-key-mode" ||
        route.pattern.startsWith("/api/w/:workspace/implementer/") ||
        route.pattern === "/w/:workspace/implementer" ||
        route.pattern === "/w/:workspace/settings/billing",
    },
  ];
  for (const param of route.params) {
    const name = param.replace("?", "");
    const choices: Array<{ value: string; refused: boolean }> = (() => {
      if (param.endsWith("?")) return [{ value: "", refused: false }];
      switch (name) {
        case "workspace":
          return [{ value: values.slug, refused: false }];
        case "repositoryId":
          return [{ value: values.repositoryId, refused: false }];
        case "id":
          // The only `:id` a member reads is a run (`/runs/:id`).
          if (!route.pattern.includes("/runs/"))
            throw new Error(
              `${route.pattern}: say in e2e/helpers/member-routes.ts what :id is.`,
            );
          return values.runIds.map((value) => ({ value, refused: false }));
        case "provider":
          // The models of a catalog provider (#555) exist only for a workspace on its own key; the workspace read here is on
          // the operator's key, so every address of the route answers a 4xx, and the answer is scanned like any other.
          if (route.pattern.includes("/llm-catalog/"))
            return [
              { value: "openrouter", refused: true },
              { value: "no-such-provider", refused: true },
            ];
          return [
            { value: "openrouter", refused: false },
            { value: "no-such-provider", refused: true },
          ];
        case "integrationId":
        case "invitationId":
        case "userId":
          return [{ value: "no-such-record", refused: true }];
        default:
          throw new Error(
            `${route.pattern}: say in e2e/helpers/member-routes.ts what :${name} is.`,
          );
      }
    })();
    results = results.flatMap((result) =>
      choices.map((choice) => ({
        path: result.path.replace(`:${name}`, choice.value),
        refused: result.refused || choice.refused,
      })),
    );
  }
  return results.map((result) => ({
    ...result,
    path: result.path.length > 1 ? result.path.replace(/\/+$/, "") : "/",
  }));
}
