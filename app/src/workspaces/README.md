# Workspaces, roles and invitations

A workspace owns the customer data of an installation: connections (`integrations`), repositories,
projects, jobs and the review defaults. People work in workspaces with a role, are brought in by invitation
and can belong to several. The decision is in `docs/decisions/0001-editions-setup-and-accounts.md`
(sections 2.6 and 2.7); the tables are described in `src/db/README.md`.

| File                                                 | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `../db/workspace-roles.ts`                           | `WORKSPACE_ROLES`, the three roles (the database restricts the column to the same list)                                                                                                                                                                                                                                                                                                                                                                                                        |
| `permissions.ts`                                     | The one permission matrix: what each role may do (`can(role, action)`), who may invite, revoke, change roles and remove whom. Pure; `permissions.test.ts` pins every action against every role                                                                                                                                                                                                                                                                                                 |
| `paths.ts`                                           | The addresses: `/w/<slug>/...` for pages, `/api/w/<slug>/...` for data routes, and how a path names a workspace                                                                                                                                                                                                                                                                                                                                                                                |
| `access.ts`                                          | `resolveWorkspaceAccess`: may this request act in this workspace? A pure decision over the session and the memberships                                                                                                                                                                                                                                                                                                                                                                         |
| `access-runtime.ts`, `access-response.ts`            | The running server's side: `requireWorkspace(slug)` for pages, `withWorkspace(slug, action, handler)` for data routes, `withSignedIn(handler)` for routes that are not about one workspace; the JSON answers of a refusal                                                                                                                                                                                                                                                                      |
| `create-workspace.ts`, `names.ts`, `limits.ts`       | Creating a workspace for a person (multi-tenant only, the limit of workspaces per user, the slug), and the rules for names (length, characters, the slug, line-safe text for mails)                                                                                                                                                                                                                                                                                                            |
| `members.ts`                                         | Changing roles, removing a member or leaving, renaming; the last Owner rule, under a lock                                                                                                                                                                                                                                                                                                                                                                                                      |
| `delete-workspace.ts`                                | Deleting a workspace (Owner, typed name, refusals, one transaction); see "Deleting a workspace"                                                                                                                                                                                                                                                                                                                                                                                                |
| `invitations.ts`                                     | Creating, resending, revoking and accepting invitations; the list of what waits for a verified address                                                                                                                                                                                                                                                                                                                                                                                         |
| `rate-limits.ts`                                     | The limits on creating invitations, accepting them and creating workspaces, in the shared `rate_limits` table                                                                                                                                                                                                                                                                                                                                                                                  |
| `http.ts`, `assemble.ts`, `shared.ts`, `acceptor.ts` | The handlers of the routes, how the services are put together over a database (the same code serves requests and tests), the wiring of the running server, and the account that accepts, as the database has it                                                                                                                                                                                                                                                                                |
| `account-view.ts`, `legacy-redirect.ts`              | What the frame and the page of a person without a workspace need (memberships, pending invitations, whether people can create workspaces); the old addresses of the pages (`/projects`, `/runs/<id>`, `/settings`) as bookmarks: the proxy answers them (and `/`) with a real 307 to the same page of the first workspace of the person (`legacyWorkspaceTarget` in `paths.ts`, `AccessGates.firstWorkspaceSlug`); the pages stay as the fallback for a person who has no workspace to lead to |
| `ui/`                                                | The Members page, the forms (invite, rename, create), the settings sub-nav and screens (General, Advanced; #178), the list of pending invitations, the page of a person without a workspace, the accept button and the workspace switcher                                                                                                                                                                                                                                                      |

## The current workspace is in the address

Every workspace page lives below `/w/<slug>` and every data route below `/api/w/<slug>`. Not a cookie, not a
header: an address is what a link, a bookmark and a second browser tab carry with them, so a deep link opens
the workspace it names for any member, two tabs can work in two workspaces, and nothing the browser remembers
can point a request at a workspace by accident. There is deliberately no "current workspace" that code could
ask for without naming one; the temporary resolver and the lazy default workspace of the data model issue are
gone.

The address is never believed. The slug is looked up among the memberships of the person who is signed in:

1. The proxy (`src/auth/access-proxy.ts`) asks for the role of the person in that slug on every request to
   a workspace address. No role, or a slug that is not shaped like one, and the request goes on marked as one
   for a path that does not exist: the very answer of a workspace that is not there, in every detail (status,
   headers, body). The instance admin is not a member of a workspace by being the admin.
2. The page or route asks again (`requireWorkspace`, `withWorkspace`), close to the data, because the proxy
   alone must not be the only guard. The service for the workspace (`runsServiceFor(workspaceId)`, ...) is
   only made from the answer (`access.workspace.id`), never from the slug or an id of the request;
   `guard-rule.test.ts` fails for a page or route without the guard and for a file that makes a service from
   a value of the address.
3. The services decide on their own who may do what, from the role the person has in the database inside the
   transaction that makes the change, so a caller that forgets a check still cannot hand out a rank.

A person who belongs to no workspace reaches only the pages and routes made for them
(`NO_WORKSPACE_PATHS`, `src/auth/access.ts`): `/no-access`, `/invitations`, `/workspaces/new`,
`POST /api/workspaces` and `POST /api/invitations/accept`. Everything else answers a redirect to `/no-access`
or 403 `no_workspace_access`. That holds for every identity, the GitHub ones too: being on the allow list
admits a person to the app, it gives them no workspace. A member who is removed is turned away at once, also
with the session they hold.

`/` opens the first workspace of the person (the one they joined first), or `/no-access`. The old addresses
(`/projects`, `/runs/<id>`, `/settings`) redirect to the same page in that workspace.

## Roles and the permission matrix

| Role   | Can                                                                                                                                                                                       |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Member | See projects, runs, settings and the members; start reviews; change the settings of a project; leave                                                                                      |
| Admin  | Also switch projects on and off (which repositories are reviewed), change the review defaults, manage connections and the LLM key; invite, revoke and remove Members; see the invitations |
| Owner  | Also invite with any role, revoke any invitation, change roles, remove Admins and Owners, rename the workspace and delete it (#658)                                                       |

`permissions.ts` is the matrix, `permissions.test.ts` pins it. Two judgments are written down here because
the decision record leaves them to this issue: switching a project on or off needs an Admin (it is "which
repositories are managed", and in a hosted instance it decides what is paid for), and the review defaults of a
workspace need an Admin (they decide what every project costs). A Member changes the settings of a project, as
the record says. Admins cannot touch Owners or other Admins, and cannot raise anybody's role.

**The last Owner cannot leave, be removed or be demoted** (`last_owner`). The count and the change are one
transaction that first takes the lock of the workspace (`WorkspaceMembersRepository.lock`, a row lock), so two Owners who leave at the same moment cannot both succeed (`last-owner-race.integration.test.ts`
runs it with two real processes).

## Creating workspaces

Only a multi-tenant instance lets people create workspaces (`multi_tenant_required`); a single-tenant instance
has the one workspace its setup made. `createWorkspaceUnderTenancy` is the one place that creates a workspace
for a person: in one transaction it reads the tenancy and the limit "workspaces per user" (the workspaces the
person is an Owner of; default 10, changed on the Limits page of the admin portal; `workspace_limit_reached`),
makes the slug from the name (a taken one gets `-2`, `-3`) and the person its Owner. A name is 1 to 80
characters without control or formatting characters (they end up in mails and pages). Counted per person
(10 per hour).

## Deleting a workspace (#658)

`DELETE /api/w/:workspace` with `{ "confirmName": "<the name>" }`, for an Owner (`delete_workspace`), from the one card of
Settings → Advanced (the page and its tab exist for an Owner only; for anybody else they are the 404 page). `delete-workspace.ts`
decides inside one transaction, from the database: the person is an Owner now, the typed name is the workspace's, and then
the refusals, each with a stable code and the data untouched: `balance_positive` (unused credit: a deletion would destroy
money paid in, so the person is told to contact support for a payout), `balance_negative` (an open amount is settled first),
`review_running` (a job is running, a superseded run still drains under its lease, or a reservation is open) and `payment_open`
(a top-up checkout started within `PENDING_TOP_UP_WINDOW_MS`, three days, that is neither `paid` nor `failed`, `pending` or
`expired`: a delayed payment method can still succeed after its checkout page expired).

The locks: the Dynamic gate, shared (a claim holds it exclusively from its start to its commit,
so a claim in flight is waited for and none starts meanwhile; the gate is also what keeps a claim from waiting for rows this
deletion holds, because a claim takes its job row before the workspace row and the deletion the other way round); the
workspace row; the repositories and the waiting, running and superseded jobs (`FOR UPDATE`, by id: a writer that sets a job
running without the gate is waited for as well); the balance row last. A top-up and an operator's manual credit read the
workspace row `FOR SHARE` before they write the journal, so a deletion in flight ends before they read it (they then credit
nobody) and one that starts later waits for them (and then refuses on the balance). The delete of the jobs rides on the index
`jobs_superseded_by` (`20261023160000_add_jobs_superseded_by_index`): without it every deleted job scanned the table for a job
that still points at it, 13 s for 20 000 jobs while the gate was held (1.7 s with it; `delete-workspace-scale.integration.test.ts`).
After the waits the deletion reads the state again, so a claim that committed is seen as `review_running`.

Then `WorkspaceErasure` (`db/repositories/workspace-erasure-repository.ts`, scoped to the workspace) removes everything
the customer owns: members, invitations, link requests, connections (every GitHub installation, disconnected or not, is
released: the connection row goes, so another workspace can link it, and it is noted as unclaimed; nothing is sent to GitHub
for that, the App stays installed there until the person removes it), repositories, projects, all jobs with their queue entries,
comments, check runs, dispatches, claimed keys, VM runs, usage records and refusal notices (waiting jobs are cancelled by going:
no runner can claim them), the settings, stored keys, entitlements, hand-over tokens, and the billing limit and notification
state. After the commit the check runs of the waiting reviews are completed on GitHub (`finish-checks.ts`: conclusion
`neutral`, "The workspace was deleted."), best effort: a connection that cannot be reached is one log line
(`CHECK_RUN_NOT_COMPLETED`), never a failed deletion.

What stays, and why: the **`workspaces` row**, anonymised (name "Deleted workspace", slug `deleted-<id>`, `created_by` null; the
old address is free again) and marked with `deleted_at`, because the **billing journal** is append-only (the database refuses an
update and a delete) and holds a foreign key to it; the journal, the cached balance and the top-up intents are what the books
need (amounts, minutes, provider references, no names or addresses); the start credit memory, so a deleted workspace cannot earn
the credit twice; and the payment provider's **customer reference** on a billing profile that is emptied (legal name, address,
VAT ID and confirming user erased; a profile that never reached the provider is removed), which a refund or dispute of an earlier
payment may need. The provider is the merchant of record and keeps the invoices (`docs/billing.md`).

A tombstone is told from a workspace by `deleted_at` (migration `20261023150000_add_workspace_deleted_at`, nullable, additive).
One helper serves every reader: `isDeleted` for a workspace in memory, `NOT_DELETED` for a query
(`db/repositories/workspaces-repository.ts`). `get`, `findDefault`, `count`, `search`, `listPage`, a member's workspaces and
the rename ignore a tombstone, so the instance admin's counts and tenancy change, the operator's search, lookup and credit, and
the operator API (list, entitlements, usage) do not see it; `getIncludingDeleted` is for the readers that explain money which
belongs to one. A payment that arrives for a deleted workspace credits nobody (`workspace_deleted`, a payment review), and no
balance mail is made or sent for it. Sessions belong to users, not workspaces: nobody is signed out; the person's next page is
the start page, which leads to another workspace of theirs or to `/no-access`.

## Invitations

- Owners invite with any role, Admins Members only. The address must be allowed by the current sign-up rule,
  evaluated with the sign-up's own functions (`signUpAvailability`, `evaluateSignUpRule`): `email_not_allowed`
  for an address the rule refuses, `signup_closed` while a rule that names addresses has no way to verify
  them. An instance that has switched email sign-up off (GitHub only) still invites, because the invited
  person signs in with GitHub; the invitation never overrides the rule.
- The link is `<public address>/invitation?token=...`, built from the configured address, never a request
  header. The token is 256 random bits, only its SHA-256 hash is stored, it works once, for 7 days, for the
  address it was made for. With a mail server it is mailed (the names in the mail are made one line each, so
  a name with a line break cannot start a header; the HTML is escaped); without one, or if the mail server
  refuses, the link is in the answer **once** for the person who invited to copy. A new link then needs a
  revoke and a new invitation; with a mail server the same invitation can be sent again (a resend replaces the
  token, which stops the old link).
- The rule is evaluated **again at accept** and at resend (`email_not_allowed`, `signup_closed`): an invitation
  made under "everyone" does not bring in an address that a tightened rule refuses, and it stays open for a
  rule that lets the address in again. The instance admin is exempt, as from the sign-up itself. An existing
  membership is never touched by a change of the rule.
- An invitation belongs to the workspace, not to the person who made it: when that person leaves or is removed
  the invitation stays open and works (`invited_by` is only set to empty when their account is deleted). An
  Owner can revoke it from the list.
- An address that is a member already is `already_member`, one with an open invitation `already_invited`
  (an expired one is ended and replaced). An address that has an account but is no member gets exactly the
  answer of one that has none, so the form tells an Admin nothing they cannot see on the lists.
- Limits (`rate-limits.ts`, in `rate_limits`): per person (30 an hour), per workspace (100 a day), per
  invited address across workspaces (10 a day) and for the instance. A Member who is refused burns no counter.
- **Accepting.** Opening the link accepts nothing: the page (`src/app/invitation`, public) shows what the
  invitation is about and, for a person who is signed in with the invited address, a button; the accept is a
  POST (`/api/invitations/accept`) that needs a session and the same-site check, and the page sends
  `Referrer-Policy: no-referrer` (a header from `next.config.ts` and in the metadata). A person without a
  session is sent to `/login?invitation=...` or `/sign-up?invitation=...`, which carry only a value shaped like
  a token and lead back to the invitation page only (`src/auth/invitation-return.ts`).
- The person must be signed in with the invited address (`email_mismatch`), and that address must be verified
  while the instance can send mail or the rule names addresses (`email_not_verified`); the instance admin needs
  no verification. Only under the rule "everyone" without a mail server there is nothing to verify, and the
  link is the proof of the address (ADR section 2.5/2.6).
- **Without a mail server an invitation is only ever found by its link.** With one, after sign-up or sign-in
  the invitations for the **verified** address are listed (`/no-access`, `/invitations`, the switcher) and
  accepted by id; an unverified address sees nothing listed and the id of an invitation is useless to it.
- One guarded statement uses an invitation up, so of two requests with one link only one succeeds
  (`invitation_used`); revoked and expired ones say `invitation_revoked` and `invitation_expired`; an unknown
  or damaged token is one generic `invitation_not_found`. Accepting while already a member changes nothing
  about the role. Attempts are limited per person (any token) and per invitation (10 a day; a token that does
  not exist touches no invitation counter). The hash is looked up in the database, never compared in
  application code with something an attacker controls.

## Empty states

- **Multi-tenant**, no workspace, no invitation: "Create a workspace" (the person becomes its Owner).
- **Single-tenant**, no workspace: "Ask an admin of this instance for an invitation". No access, no automatic
  join, however the account was made; `POST /api/workspaces` answers `multi_tenant_required`.

## Entitlements

An operator who serves many workspaces can state, per workspace, what it may do (#271; epic #268). The data
model, and the operator API that sets it (#275): no page. The limits and the suspension are enforced when a job is
claimed (#277, `src/usage/README.md`, "Limits and suspension at claim"); the key mode decides whose LLM key a job uses (#276, `src/llm/README.md`). An instance that configures nothing sees no change.

- **Data.** One row per workspace in `workspace_entitlements` (`src/db/repositories/workspace-entitlements-repository.ts`)
  and one instance setting `default_entitlements` for the workspaces without a row. Both hold the same fields:
  `planLabel` (a label for display and audit, at most 64 printable characters; the code never branches on it),
  `keyMode` (`own` or `managed`: whose LLM key the reviews use, the workspace's own or the operator's), `limits` (`diffRunsPerPeriod`, `dynamicRunsPerPeriod`,
  `managedCostLimitMicroUsd`, `ownKeyCostLimitMicroUsd`, each a non-negative integer up to 2^53-1 or `null` for
  unlimited; the two cost limits are micro-USD of measured model cost and each watches the runs on one key mode: the
  operator's key and the workspace's own, #361), `periodStart` (usage
  counts from here), `suspended` and `suspensionCode`.
- **Resolver.** `resolveEntitlements(row, default)` in `entitlements.ts` is the one place that interprets the data. A
  row wins entirely (no field-wise merge with the default); without a row the default applies; with neither the
  answer is `{ kind: "unlimited" }` (own key, no limits, not suspended). A limited answer says whether it came from
  the `workspace` or the `default`. It copies the named fields only: the user id and the time of the last save
  that a stored row carries never reach the answer.
- **Reading them for one workspace.** `readEffectiveEntitlements(db, workspaceId)` in `effective-entitlements.ts`
  reads the workspace's row and, only without one, the default, and resolves them: the claim's admission (#277) and the
  choice of the LLM key (#276) both go through it, so they cannot read the entitlements differently. **While billing is on**
  it also puts the workspace's own choice of the key mode in place of the entitlement's `keyMode` (#496,
  `effective-key-mode.ts`, `applyWorkspaceKeyMode`; the choice is `managed` until the workspace makes it, a workspace without
  entitlements stays `unlimited` and carries the mode); the suspension, the model access and the cost limits are read as
  ever, and entitlements that cannot be read stay unreadable. With billing off it reads exactly what it always read.
- **Unreadable data fails closed.** The columns of a row and the JSON of the default are checked when they are
  read, with the rules of a write (`readEntitlements`). An entry that exists but cannot be read (damaged JSON,
  limits with a missing or bad value, an unknown key mode) is never "unlimited": the resolver answers
  `{ kind: "invalid", code: "entitlements_invalid", source }`, and nothing throws. A row of the workspace that is
  unreadable wins over a good default, like any row. The claim (#277) refuses with
  that code (`entitlements_invalid`; the Runs pages explain it); repairing the entry is a valid `put`. Reading ignores keys it does not know (an
  older app reads what a newer one wrote) and does not ask the clock.
- **The cost limits (#361).** `managedCostLimitMicroUsd` bounds the settled cost of the runs that used the operator's key,
  `ownKeyCostLimitMicroUsd` the runs that used the workspace's own. A job is checked against the limit of the key it runs
  on, and the sums count records by their own key mode, so switching a workspace between the two never moves cost from
  one limit to the other. Both are soft caps and neither bounds a run whose cost is unknown
  (`src/usage/README.md`, "Limits and suspension at claim").
- **The model access (#428; epic #420, ADR 0005, 2.9).** `modelAccess: { catalogEntries: string[] | null }` says which
  entries of the model catalog (`src/model-catalog/`) a workspace may use: `null`, or no field at all, is every
  released entry, `[]` is none, a list is those entries. The ids are the ids of the admin portal (`mce_` and opaque text,
  at most 100, `CATALOG_ENTRY_ID_PATTERN`); an id that no entry has is accepted and matches nothing. It is the same pair of
  stores as every other field: the nullable JSON text column `model_access` of `workspace_entitlements` (NULL for
  `null`) and a field of `default_entitlements`, and a row wins entirely, the model access included.
  `entryAllowed(resolved, entry)` in `entitlements.ts` is the one question the claim (#432) and the picker (#433) ask:
  no entitlements and `null` allow every entry, `[]` none, unreadable entitlements none. It answers about the list only;
  whether the entry is released and serves the kind, and whether the workspace reads the catalog at all, is the caller's.
  **It means something for the key mode `managed` only**: next to `own` it is accepted and kept (so a switch back finds
  it) but the claim and the picker never read it, because a workspace on its own key chooses provider and model freely;
  billing does not refuse it for an `own` key mode. **Off by default**: a row or default without the
  field, and an instance that never sets it, behave as before. Reading is lenient like `LIMITS_ADDED_LATER`: a missing
  field reads as `{ catalogEntries: null }` and never makes the entry `entitlements_invalid`, a key of a newer version
  inside the field is ignored; a field that is there and damaged makes the entry unreadable, so damaged data grants no
  model. A write refuses a field that is not `{ catalogEntries }` with `null` or a list of at most 100 distinct id-shaped
  strings (the same id twice is refused, not deduplicated; reading tolerates a repeat), and a key it does not know, as
  `catalog_entry_invalid` (field `modelAccess` or `modelAccess.catalogEntries`).
  **A write that leaves the field out keeps the stored value** (the `periodStart` rule): the repositories do not touch
  the column or the key in the JSON, so a writer that does not know the field never clears what was granted, and two
  writers cannot race on it; `{ catalogEntries: null }` clears it. The write is intentionally not "replace everything"
  (unlike `ownKeyCostLimitMicroUsd`, which every write states): it needs no cutover, as `periodStart` needs none.
  **Damaged data stays closed on both stores.** A workspace row whose column is damaged stays unreadable under a write
  that leaves the field out (the column is not touched), and the default is refused: `set` over a stored default that
  cannot be read, with no `modelAccess`, throws `catalog_entry_invalid` (field `modelAccess`) and writes nothing, because
  "every released entry" is not a safe guess for data that may have been restrictive. Only a write that states
  `modelAccess` repairs either. **A row wins entirely over the instance default**, so a restrictive default does not
  protect a workspace that has a row of its own. The rollout order is in `src/operator-api/README.md`.
- **A stored `source` on the default is ignored.** An earlier design of billing (deleted before any release, #491) wrote
  `source: "billing"` into the instance default. A default that still carries it reads without error and without the
  field: a read keeps only the fields of `EntitlementsData`, and `validateEntitlements` refuses the key in a write like any
  other key it does not know (`entitlements_invalid`, field `source`). The operator API writes the default like any other
  operator write (`PUT /entitlements/default`).
- **Adding a limit later.** A new limit goes into `LIMIT_NAMES` and, so that existing entries stay readable, into
  `LIMITS_ADDED_LATER` (`entitlements-validation.ts`): when reading, its missing key means `null` (unlimited), which
  is true because no such limit existed when the entry was written. Writes still require every key. (The alternative
  is a migration that backfills the key; choose that if the old entries must not read as unlimited.)
- **Validation.** `entitlements-validation.ts` returns stable codes: `entitlements_invalid` (not an object, or an
  unknown top-level key named in `field`), `plan_label_invalid` (1 to 64 characters, nothing a person cannot see:
  spaces including the no-break space, combining marks, Hangul fillers and the blank braille pattern do not count;
  no control, formatting, private use or line separator characters; unassigned code points are not judged, so the
  answer does not depend on the Unicode version of Node), `key_mode_invalid`, `limits_invalid` (not an object, a
  missing or an unknown key), `limit_invalid` (with the name of the limit), `cost_limit_requires_managed_key` (#277: a
  managed cost limit, even 0, with the key mode `own`, which nothing would read; refused on a write only, a stored entry
  of that shape is still read and its limit ignored. The own-key limit `ownKeyCostLimitMicroUsd` is allowed with either
  key mode, #361), `period_start_invalid`,
  `period_start_in_future` (more than five minutes ahead), `period_start_backwards` (earlier than the stored one;
  the same value again is accepted), `suspended_invalid`, `suspension_code_invalid` (lower case letters, digits,
  `_` and `-`, starting with a letter, at most 64 characters; checked even when not suspended). A valid code is
  kept only while suspended: clearing the suspension clears the code. `catalog_entry_invalid` (#428: the model
  access, see above). The repositories throw `EntitlementsError` with the code.
- **The plan page (#282).** Every member can read `/w/<slug>/settings/plan`: the plan label, the used and allowed runs
  of each review kind, the share of the cost limit as a percentage (never an amount), the start of the period and a
  notice while reviews are paused. The settings navigation lists it only for a workspace with entitlements
  (`src/usage/README.md`, "The plan page").
- **The operator API (#275).** `src/operator-api/README.md` and `contracts/operator-api.v1.json`. It decided the
  three follow-ups of #271: a body without `periodStart` keeps the stored start (a stale start cannot block an unrelated
  update); `DELETE` of a workspace's row is offered and ends the "never backwards" guard for it (documented, not
  prevented), while the default cannot be removed through the API; and a number above 2^53 is refused as
  `limit_invalid`.

## Not here

Transferring data, SSO and teams below the workspace are out of scope. A GitHub App installation
is bound to a workspace by an Owner or Admin (`manage_connections`) through "Connect GitHub" on the Integrations tab of the settings; the
rules are in `src/installation-binding/README.md`, and the synchronization of a workspace reads its own connections only
(`POST /api/w/:workspace/integrations/sync`; the whole instance's stays the instance admin's). The workspace LLM key is
in place (`src/llm/`, `manage_llm_key`: an Admin or an Owner sets it, every member sees whether there is one); the same action
sets the workspace's key mode while billing is on, our models or its own key (`GET` and `PUT /api/w/:workspace/llm-key-mode`,
#496, `src/llm/README.md`), and every member sees the choice. "Manage plan"
(`manage_plan`, an Admin or an Owner) hands the person over to the operator-configured plan page (`src/plan-handoff/`). The billing profile and the top-up of
the prepaid balance (`manage_billing`, an Admin or an Owner) are in `src/billing/`; so is the optional monthly total limit of the workspace
(`GET` and `PUT /api/w/:workspace/billing/monthly-limit`, the same role, #499), which refuses a review at the claim once this UTC month's charges have reached it (a review that runs is never cut short; nothing is held). While billing is on the per-period run quotas of the entitlements (`diffRunsPerPeriod`, `dynamicRunsPerPeriod`) are not enforced and the plan
page shows none (`src/usage/README.md`); with billing off they apply as before. The workspace
pages tell a member only that GitHub is not set up and to ask the instance admin; the names of the variables are the
instance admin's to read (`src/config-status/`). Whether reviews have an LLM key is the workspace's own matter: the hint
"LLM not configured" tells a Member to ask an Admin or an Owner of the workspace (`src/llm/ui/`).

Open (#105): creating a workspace was written when SQLite serialized all writers (`begin immediate`). On Postgres the
creation needs a lock (or the handling of the unique violation of the slug, so a collision never becomes a 500), see the
comment in `create-workspace.ts`.

## Tests

`permissions.test.ts`, `names.test.ts`, `paths.test.ts`, `access.test.ts`, `guard-rule.test.ts`,
`entitlements.test.ts`, `entitlements-validation.test.ts`: the pure
rules and the structure rules. `members.integration.test.ts`, `invitations.integration.test.ts`,
`create-workspace.integration.test.ts`, `last-owner-race.integration.test.ts`, `http.integration.test.ts`,
`fresh-user.integration.test.ts`, `invitation-sign-up.integration.test.ts`: the services and handlers over a
real Postgres database. `integration-tests/http/workspace-isolation.integration.test.ts`: every data route against
a second workspace and against every role. `ui/*.test.tsx`: the components. Journeys:
`e2e/workspaces/invite-and-accept.e2e.ts` (single-tenant, no mail server), `e2e/workspaces/multi-tenant.e2e.ts`.
