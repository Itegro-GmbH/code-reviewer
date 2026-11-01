// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The frame around every signed in page: the skip link, a header (the drawer trigger, the brand, the
// workspace switcher and the user menu) and the main landmark with the page. The workspace
// navigation is the shadcn Sidebar to the left; on a narrow screen it becomes the Sheet drawer the
// trigger opens. The user menu and the workspace switcher arrive as slots: they need the session, so
// the layout renders them on the server and the frame itself stays static. The look is the design
// board's workspace frame (#633): a floating glass nav pill, then the 200px side column and the page in
// one centred column of at most 1152px.
import Link from "next/link";
import { Suspense, useId, type CSSProperties, type ReactNode } from "react";
import { Brand } from "@/components/brand";
import type { ProductIdentity } from "@/product-identity/identity";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import {
  CurrentWorkspaceSidebar,
  WorkspaceSidebarTrigger,
} from "./nav-links.tsx";

export function AppShell({
  product,
  userMenu,
  workspaceSwitcher,
  children,
}: {
  /** The product whose brand the header shows. */
  product: ProductIdentity;
  userMenu: ReactNode;
  /** The workspaces of the signed in person; it needs the session, so it arrives as a slot too. */
  workspaceSwitcher?: ReactNode;
  children: ReactNode;
}) {
  const mainId = useId();

  return (
    // The primitive already gives the wrapper `min-h-svh`; `flex-col` is the only thing the frame
    // adds, so there is a single min-height with no winner to guess (#168 review). The sidebar is
    // 200px wide, as the side column of the design board.
    <SidebarProvider
      className="flex-col"
      style={{ "--sidebar-width": "12.5rem" } as CSSProperties}
    >
      <a
        href={`#${mainId}`}
        className="sr-only no-underline focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground"
      >
        Skip to content
      </a>
      {/* The floating glass nav of the design board (#633): a pill centred at the top, with the
          brand, the workspace switcher and the user menu. */}
      <header className="pointer-events-none sticky top-0 z-20 flex justify-center px-4 pt-6">
        <div className="pointer-events-auto flex max-w-full min-w-0 items-center gap-1 rounded-full border border-border bg-background/70 p-1 shadow-nav sm:p-2 backdrop-blur-xl">
          {/* Only where a sidebar exists: a page outside a workspace has none, and the admin portal
              brings its own trigger next to the admin sidebar. */}
          <Suspense fallback={null}>
            <WorkspaceSidebarTrigger product={product} />
          </Suspense>
          <Link
            href="/"
            className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full px-2 no-underline sm:pr-3"
          >
            <Brand product={product} compact />
          </Link>
          {workspaceSwitcher || userMenu ? (
            <span aria-hidden="true" className="h-6 w-px shrink-0 bg-border" />
          ) : null}
          <div className="flex min-w-0 items-center gap-1">
            {workspaceSwitcher}
            {userMenu}
          </div>
        </div>
      </header>
      <div className="mx-auto flex min-h-0 w-full max-w-page flex-1 gap-8 px-4 pt-12 pb-24 md:px-8">
        <Suspense fallback={null}>
          <CurrentWorkspaceSidebar product={product} />
        </Suspense>
        <SidebarInset
          id={mainId}
          tabIndex={-1}
          className="min-w-0 flex-1 gap-6 bg-transparent outline-none"
        >
          {children}
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
