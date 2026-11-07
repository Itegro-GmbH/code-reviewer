// SPDX-License-Identifier: LicenseRef-Proprietary

// The places of the signed in app, grouped the way the sidebar shows them. One list feeds the
// navigation, so the labels, the links and the active state cannot drift apart. The places belong to
// a workspace: their addresses are below `/w/<slug>` (src/workspaces/paths.ts), and the navigation
// shows them while the page is in a workspace. A deployment without the `implementer` capability (code-review.com) has the groups
// daily work (Projects, Runs), then a separator, then the workspace administration (Connections, Members, Settings); #168 says
// Members stays a top-level item. The first place is the QA area, which the product names (`qaAreaName`, #757): its address is
// `/projects` in every product. The factory (#925) has the list of its app shell instead: ToDos (with the count of what waits for
// the person), Projects, Runs, Profiles, Runners, Settings. Its workspace administration (members, the GitHub App, billing) is one
// place, Settings, with tabs; there are no favorites and no lanes outside a project.
import {
  createCapabilitySet,
  type Capability,
  type CapabilitySet,
} from "../capabilities/capability.ts";
import { PRODUCTS } from "../capabilities/products.ts";
import type { ProductIdentity } from "../product-identity/identity.ts";
import { workspacePath, workspaceSlugOfPath } from "../workspaces/paths.ts";

// An item with a `capability` is shown only in a deployment that has it (src/capabilities/): no capability, no entry. A label is a
// text or, for a place the product names, a function of its identity. A `badge` is a count the sidebar loads for the place.
type NavPlace = {
  path: string;
  label: string | ((product: ProductIdentity) => string);
  capability?: Capability;
  badge?: NavBadge;
};
const NAV_GROUPS: readonly { items: readonly NavPlace[] }[] = [
  {
    items: [
      {
        path: "/projects",
        label: (product) => product.qaAreaName,
        capability: "review",
      },
      { path: "/runs", label: "Runs", capability: "review" },
    ],
  },
  {
    items: [
      { path: "/connections", label: "Connections" },
      { path: "/members", label: "Members" },
      { path: "/settings", label: "Settings" },
    ],
  },
];

/** The places of the factory (#925); a deployment with the `implementer` capability shows these and no other. */
const FACTORY_NAV_GROUPS: readonly { items: readonly NavPlace[] }[] = [
  {
    items: [
      {
        path: "/todos",
        label: "ToDos",
        capability: "implementer",
        badge: "todos",
      },
      { path: "/projects", label: "Projects", capability: "review" },
      { path: "/runs", label: "Runs", capability: "review" },
      { path: "/profiles", label: "Profiles", capability: "implementer" },
      { path: "/runners", label: "Runners", capability: "implementer" },
      { path: "/settings", label: "Settings" },
    ],
  },
];

/** The set a caller that names none gets: the whole product of code-review.com (the tests of the navigation itself). */
const WHOLE_PRODUCT = createCapabilitySet(PRODUCTS["code-review-com"].default);

/** The counts a sidebar link can carry. */
export type NavBadge = "todos";
export type NavItem = { href: string; label: string; badge?: NavBadge };
/** A group of places; the sidebar draws a separator between two groups, not inside one. */
export type NavGroup = { items: NavItem[] };

/**
 * The class of a sidebar link, shared by the workspace and the admin sidebar: the token colour (muted at
 * rest; the current page, `aria-current`, sits on raised in fg, as on the design board, #633), and a
 * 44px row on a touch screen while the kit's 36px (`h-9`) stays on a fine pointer
 * (`components/README.md`, "Hit areas").
 */
export const SIDEBAR_LINK_CLASS =
  "text-sidebar-foreground no-underline aria-[current=page]:text-foreground pointer-coarse:h-11";

/**
 * The groups of the workspace the page is in, or none for a page outside any workspace. A place whose capability the
 * deployment does not have is left out, and a group without places with it; the labels are the words of `product`.
 */
export function navGroupsFor(
  pathname: string | null,
  product: ProductIdentity,
  capabilities: CapabilitySet = WHOLE_PRODUCT,
): NavGroup[] {
  const slug = pathname === null ? undefined : workspaceSlugOfPath(pathname);
  if (typeof slug !== "string") return [];
  const groups = capabilities.has("implementer")
    ? FACTORY_NAV_GROUPS
    : NAV_GROUPS;
  return groups
    .map((group) => ({
      items: group.items
        .filter(
          (place) =>
            place.capability === undefined ||
            capabilities.has(place.capability),
        )
        .map((place) => ({
          href: workspacePath(slug, place.path),
          label:
            typeof place.label === "string"
              ? place.label
              : place.label(product),
          ...(place.badge === undefined ? {} : { badge: place.badge }),
        })),
    }))
    .filter((group) => group.items.length > 0);
}

/** Every place in one list, in the order the sidebar shows them. */
export function navItemsFor(
  pathname: string | null,
  product: ProductIdentity,
  capabilities: CapabilitySet = WHOLE_PRODUCT,
): NavItem[] {
  return navGroupsFor(pathname, product, capabilities).flatMap(
    (group) => group.items,
  );
}

/**
 * Whether `pathname` is on the page `href` or below it (`/w/acme/runs/42` belongs to `/w/acme/runs`). A path
 * that only starts with the same letters (`/w/acme/runs-archive`) does not.
 */
export function isCurrentPage(pathname: string | null, href: string): boolean {
  if (pathname === null) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}
