// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The links of the main navigation, on the shadcn Sidebar: the groups of the workspace the page is
// in (none outside a workspace). The sidebar itself reads the current path from the router, which
// can wait for the request on routes with dynamic segments, so the shell wraps it in <Suspense>.
// Every link marks the current page with `aria-current="page"` and closes the narrow-screen drawer.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment, useEffect, useRef } from "react";
import { useCapabilities } from "@/capabilities/context";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  SidebarShortcut,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import type { ProductIdentity } from "@/product-identity/identity";
import {
  isCurrentPage,
  navGroupsFor,
  SIDEBAR_LINK_CLASS,
} from "./nav-items.ts";

/**
 * The sidebar sits in the page column (the design board's side column) instead of fixed to the
 * viewport: in the flow, as high as its links, and gone while collapsed (Ctrl/Cmd+B).
 */
export const SIDEBAR_TOP_CLASS =
  "relative z-0 h-auto self-start group-data-[side=left]:border-r-0 group-data-[collapsible=offcanvas]:hidden";

export function NavLinks({
  pathname,
  product,
}: {
  pathname: string | null;
  product: ProductIdentity;
}) {
  const groups = navGroupsFor(pathname, product, useCapabilities());
  if (groups.length === 0) return null;
  return (
    <SidebarContent>
      {groups.map((group, index) => (
        <Fragment key={index}>
          {index > 0 ? <SidebarSeparator /> : null}
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu className="m-0 list-none p-0">
                {group.items.map((item) => (
                  <NavLink key={item.href} item={item} pathname={pathname} />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </Fragment>
      ))}
    </SidebarContent>
  );
}

function NavLink({
  item,
  pathname,
}: {
  item: { href: string; label: string };
  pathname: string | null;
}) {
  const { setOpenMobile } = useSidebar();
  const current = isCurrentPage(pathname, item.href);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={current}>
        <Link
          href={item.href}
          aria-current={current ? "page" : undefined}
          className={SIDEBAR_LINK_CLASS}
          onClick={() => setOpenMobile(false)}
        >
          {item.label}
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * The workspace sidebar of the shell. It reads the current path and renders nothing outside a
 * workspace, so the pages of an account without a workspace (and the admin portal) get no empty
 * column. The `Sidebar` becomes the shadcn Sheet drawer on a narrow screen; a link or a page change
 * closes it.
 */
export function CurrentWorkspaceSidebar({
  product,
}: {
  /** The product whose words the links use. */
  product: ProductIdentity;
}) {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();
  const capabilities = useCapabilities();
  const shownPath = useRef(pathname);

  // The page changed, by whatever means (a link anywhere, back and forward): the drawer has done
  // its job. A click on a nav link closes it sooner through the link's own onClick.
  useEffect(() => {
    if (shownPath.current === pathname) return;
    shownPath.current = pathname;
    setOpenMobile(false);
  }, [pathname, setOpenMobile]);

  if (navGroupsFor(pathname, product, capabilities).length === 0) return null;
  return (
    <>
      <SidebarShortcut />
      <Sidebar className={SIDEBAR_TOP_CLASS}>
        <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col">
          <NavLinks pathname={pathname} product={product} />
        </nav>
      </Sidebar>
    </>
  );
}

/**
 * The trigger of the workspace sidebar, in the header. It renders only where the sidebar renders, so
 * a page outside a workspace has no control that toggles nothing (the admin portal brings its own
 * trigger next to the admin sidebar).
 */
export function WorkspaceSidebarTrigger({
  product,
}: {
  /** The product whose places the sidebar lists. */
  product: ProductIdentity;
}) {
  const pathname = usePathname();
  const capabilities = useCapabilities();
  if (navGroupsFor(pathname, product, capabilities).length === 0) return null;
  // A drawer on a narrow screen; a wide one shows the side column (Ctrl/Cmd+B still folds it away).
  return <SidebarTrigger className="size-11 md:hidden" />;
}
