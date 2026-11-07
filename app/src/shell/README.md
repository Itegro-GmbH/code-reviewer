# App frame

The frame around every signed in page, and the places of a workspace inside it. Colors, buttons and the
other small building blocks are in `src/components/` (shadcn kit) and `src/app/theme.css`; the color
mode is in `src/theme/`.

| File                     | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nav-items.ts`           | The places of a workspace, in the one group the sidebar shows (#925, the factory's shell: **ToDos** with the count of open ToDos, **Projects**, **Runs**, **Profiles**, **Runners**, **Settings**; ToDos, Profiles and Runners only in a deployment with the capability `implementer`, Projects and Runs with `review`), built for the workspace the address names (`navGroupsFor`/`navItemsFor`; none outside a workspace), and `isCurrentPage` (a place is current on its own path and below it, so Settings is current on every tab). Members, the GitHub App and billing are tabs of Settings, the Implementer form, the environments and the workflows are reached from the Runners page and the Lanes tab of a project; there are no favorites and no lanes outside a project. One list feeds the links and the active state; `SIDEBAR_LINK_CLASS` is the shared link class of both sidebars (colour, underline, coarse-pointer height). |
| `nav-links.tsx`          | `NavLinks` renders the groups on the shadcn `Sidebar` (`SidebarGroup`, `SidebarMenu`, `SidebarMenuButton`, `aria-current="page"`); `CurrentWorkspaceSidebar` reads the path from the router and renders the `Sidebar` itself, or nothing outside a workspace so there is no empty column. A place with a `badge` carries a count the sidebar loads itself: the ToDos link shows `todos/ui/todo-count.tsx` (read from `GET /api/w/<slug>/todos/count` when the page changes; nothing for none or when the read fails; the count is 0 until the ToDos exist, #924). `WorkspaceSidebarTrigger` renders the trigger in the header only where that sidebar renders. The `Sidebar` is the Sheet drawer on a narrow screen; a link, Escape and a page change close it, and Escape returns the focus to the trigger.                                                                                                                                   |
| `app-shell.tsx`          | The skip link, the header (the workspace drawer trigger, the brand, the workspace switcher and the user menu) and the `SidebarInset` main landmark with the page. The header is sticky; the fixed sidebar starts below it (`SIDEBAR_TOP_CLASS`). The user menu and the switcher arrive as slots: they need the session, so the layout renders them on the server and the frame itself stays static.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `workspace-switcher.tsx` | The DropdownMenu with the workspaces of the person, the waiting invitations and "Create a workspace" (multi-tenant only); moved here from `workspaces/ui/` with #168. Only names and slugs of workspaces the person is a member of are ever passed in.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `user-menu.tsx`          | The DropdownMenu with name and login, `Account`, `Admin` (the instance admin only), the color theme (System, Light, Dark) and "Sign out". Radix handles the keyboard, Escape, the click outside and the focus return.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `user-avatar.tsx`        | The GitHub avatar (https only, no referrer) or the initials; never a broken image.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `user-display.ts`        | Display name (the login when the profile has no name), initials, `safeAvatarUrl`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

The pages of the factory's shell (#925), all below `w/[workspace]/`:

| Address                                                                                                                                         | Page                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `todos`                                                                                                                                         | What waits for the person across the projects (empty until #924); `src/todos/`                                                                                                                        |
| `projects`                                                                                                                                      | The projects as cards with the "New project" dialog (factory); the table with the review switches elsewhere; `src/projects/ui/`                                                                       |
| `projects/<id>` and `.../todos`, `.../runs`, `.../lanes`, `.../setup`                                                                           | The cockpit of a project, one page per tab (`projects/ui/project-cockpit.tsx`); `.../review` is the review settings page it had before. Without the factory `projects/<id>` opens the review settings |
| `runs`, `runs/<id>`                                                                                                                             | The review runs                                                                                                                                                                                       |
| `profiles`                                                                                                                                      | The profiles with their drawer (`src/profiles/ui/`)                                                                                                                                                   |
| `runners`                                                                                                                                       | The hosted sandbox and the runners of the customer, "Connect your own runner" (`src/runner-fleet/ui/`)                                                                                                |
| `settings`, `settings/members`, `settings/billing` (or `plan`), `settings/integrations` (with `llm` and `review-defaults`), `settings/advanced` | The four tabs of the settings and their pages (`src/workspaces/ui/settings-*`); `/members` and `/connections` redirect to their tabs                                                                  |

The pages live in `src/app/(app)/` (route group, no effect on the URLs): `layout.tsx` wraps them in
`AppShell`. The pages of a workspace are below `w/[workspace]/`: `projects` (the list and, below
it, `[repositoryId]` for the settings of one project), `runs` (the list and, below it, `[id]` for one
run), `settings` and `members` are real pages, see `src/projects/README.md`, `src/runs/README.md`,
`src/review-settings/README.md` and `src/workspaces/README.md`. `/projects`, `/runs` and `/settings` redirect
to the same page of the first workspace of the person (old bookmarks), `workspaces/new` and `invitations` are
the two places outside a workspace, and `/` redirects to the first workspace (or `/no-access`).

The admin portal (`/admin`, `src/admin/README.md`) renders behind its own layout and its own shadcn
`Sidebar` (`src/admin/ui/admin-nav.tsx`, grouped: Admin / Setup / Integrations, with the GitHub App
page nested under Integrations) with its own
`SidebarProvider` and trigger: on a wide screen the sidebar's container is `absolute` inside the
admin frame (not the primitive's `fixed` one), so it lines up with the centered content, and on a
narrow screen it is the same Sheet drawer as the workspace. The admin check runs before any section
name is rendered. The Ctrl/Cmd+B shortcut is `SidebarShortcut` (`components/ui/sidebar.tsx`), which
each side renders only inside the sidebar it actually shows: on an admin page only the admin sidebar
toggles, and the shell's provider (no workspace sidebar there) registers nothing.

## Rules

- A new signed in page goes below `src/app/(app)/`, calls `requireUser()` itself (the second guard
  behind the proxy, see `src/auth/README.md`) and renders a `PageHeader` with the page's one `h1`. A page
  of a workspace goes below `src/app/(app)/w/[workspace]/` and calls `requireWorkspace(slug)` instead
  (`guard-rule.test.ts` fails without it); its components get the slug as a prop and build every link and
  call with `workspacePath` / `workspaceApiPath`, and a client component keeps one API client per component
  (`useMemo`), not a new one per render. A new place in the navigation is one more entry in `nav-items.ts`.
- With Cache Components the frame is static. The workspace sidebar and its trigger, the user menu and
  the workspace switcher need the request, so each sits behind its own `<Suspense>` boundary (the
  trigger and the sidebar render nothing meanwhile); the page children are behind `<Suspense>` too
  (they read the session). Do not read `cookies()` or `headers()` in the shell components themselves.
- The user menu gets only what it shows (`ShellUser`), never the whole session user. Name and avatar
  come from the GitHub profile and are untrusted: they are rendered as text, and the avatar only when
  it is an https address.
- Every color comes from a token in `src/app/theme.css` (`bg-card`, `text-muted-foreground`, ...), never
  a literal (the colour guard in `src/ci/colors` fails otherwise). Hit areas follow the kit's rule
  (`src/components/README.md`, "Hit areas"); the skip link and `aria-current="page"` stay.
- Without JavaScript the workspace and admin sidebars stay folded (the Sheet needs the trigger's
  click); the header, the page content, the links and sign out keep working through the server. The
  desktop sidebar is plain CSS, so it needs no script.

## Tests

- `app-shell.test.tsx`, `user-menu.test.tsx`, `workspace-switcher.test.tsx`: component tests (jsdom,
  Testing Library) for the sidebar groups, the current place, the narrow-screen drawer (its trigger's
  `aria-expanded`/`aria-controls`, Escape and the focus return, a chosen link, a page change), the
  menus (including a hostile name and a missing avatar) and the switcher.
- `admin/ui/admin-nav.test.tsx`: the grouped admin sections, the current one and the same drawer.
- `app-pages.integration.test.ts`: the proxy and the pages turn away a visitor without a session,
  and the sign out action ends the session on the server.
- `e2e/app/navigation.e2e.ts`: the places and sign out on a desktop window, the drawer on a 375 px
  window (`@smoke`). `e2e/admin/admin-portal.e2e.ts` has the same narrow-window drawer journey
  (`@smoke`).
- Not automated: how it looks (contrast in both modes, nothing cut off, no flash of the wrong mode on
  load). That is a visual check by a team member before a release.
