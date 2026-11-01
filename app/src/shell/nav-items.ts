// SPDX-License-Identifier: LicenseRef-Proprietary

// The places of the signed in app, grouped the way the sidebar shows them. One list feeds the
// navigation, so the labels, the links and the active state cannot drift apart. The places belong to
// a workspace: their addresses are below `/w/<slug>` (src/workspaces/paths.ts), and the navigation
// shows them while the page is in a workspace. The groups are daily work (Projects, Implementer, Runs), then a
// separator, then the workspace administration (Connections, Members, Settings); #168 says Members
// stays a top-level item. The first place is the QA area, which the product names (`qaAreaName`, #757): its address is
// `/projects` in every product.
import {
  createCapabilitySet,
  type Capability,
  type CapabilitySet,
} from "../capabilities/capability.ts";
import { PRODUCTS } from "../capabilities/products.ts";
import type { ProductIdentity } from "../product-identity/identity.ts";
import { workspacePath, workspaceSlugOfPath } from "../workspaces/paths.ts";

// An item with a `capability` is shown only in a deployment that has it (src/capabilities/): no capability, no entry.
// A label is a text or, for a place the product names, a function of its identity.
type NavPlace = {
  path: string;
  label: string | ((product: ProductIdentity) => string);
  capability?: Capability;
};
const NAV_GROUPS: readonly { items: readonly NavPlace[] }[] = [
  {
    items: [
      {
        path: "/projects",
        label: (product) => product.qaAreaName,
        capability: "review",
      },
      { path: "/implementer", label: "Implementer", capability: "implementer" },
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

/** The set a caller that names none gets: the whole product of code-review.com (the tests of the navigation itself). */
const WHOLE_PRODUCT = createCapabilitySet(PRODUCTS["code-review-com"].default);

export type NavItem = { href: string; label: string };
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
  return NAV_GROUPS.map((group) => ({
    items: group.items
      .filter(
        (place) =>
          place.capability === undefined || capabilities.has(place.capability),
      )
      .map((place) => ({
        href: workspacePath(slug, place.path),
        label:
          typeof place.label === "string" ? place.label : place.label(product),
      })),
  })).filter((group) => group.items.length > 0);
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
