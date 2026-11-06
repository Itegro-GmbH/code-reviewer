# Admin portal

The instance admin's area at `/admin`: the settings of the whole instance, and the one safe place for its
credentials. The decision is in `docs/decisions/0001-editions-setup-and-accounts.md`, sections 2.3 and 2.7;
the first-run setup that creates the admin is `src/setup/`.

| File                                | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `paths.ts`                          | `isAdminPath`: which request paths belong to the portal (any spelling Next.js would route there)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `access.ts`, `session.ts`           | Who may enter: `adminAccessOf` (admin, anonymous, not an admin), `lookupAdmin` and `requireAdmin` for the code that runs inside a request                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `service.ts`                        | The typed settings service: `readSettings` (every setting with who and when, the secret statuses, the facts of the overview) and the changes (tenancy, sign-up rule, ways to sign in, limits, the Dynamic Review gate, the mail server, the operator's own LLM keys) and the test mail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `tenancy.ts`                        | The change of the tenancy, one transaction (the rules below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `sign-in-methods.ts`                | The rules for the ways to sign in, and what is actually on (`effectiveSignInMethods`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `sign-up-rule-state.ts`             | Whether an email or domain rule is fail-closed right now (no mail server, and sign-in is not GitHub only), and whether the instance can verify addresses at all; the sign-up reads the same functions (`src/signup/availability.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `http.ts`, `errors.ts`, `shared.ts` | The handlers of `GET\|PUT /api/admin/settings`, `POST /api/admin/mail/test` and `POST /api/admin/integrations/sync`, their stable error codes, and the wiring of the running server                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `ui/`                               | The pages' building blocks: navigation, overview, the forms (instance — tenancy, limits and the Dynamic Review gate (#202) —, sign-up rule, ways to sign in, mail server with the test mail button, the LLM key of the instance (#276)), the copy for the error codes. Pages: `src/app/(app)/instance-portal/`. The setup is split into `setup/instance`, `setup/sign-up` and `setup/sign-in` (#181); `/admin/setup` and `/admin/limits` redirect to the instance section. The Integrations group nests the GitHub App page (`/admin/integrations/github`) under its index (#182/#185).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Model catalog                       | The section of the LLM page (`/admin/llm`, #429) where the operator manages the models that workspaces on the key of the instance choose from: name, description, provider, model id, kinds, status, order and the default of each kind. It is `src/model-catalog/` (`admin-service.ts`, `admin-http.ts`, its README has the routes), its data routes are below `/api/admin/model-catalog`, and the overview shows only counts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| models.dev catalog                  | `/admin/catalog` (#554): the daily fetch with "Fetch now", the providers whose address changed, and the models of the models.dev catalog with their state (new, enabled, disabled), price status and actions. The screens are `src/admin/catalog-models/`, the data routes are below `/api/admin/catalog-models` (`src/model-prices/`, #549), `/api/admin/catalog-providers/url/confirm` and `/api/admin/catalog-fetch` (the list of providers is read on the server, there is no route for it) (`src/models-dev/admin-*.ts`); the section below says how they work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Billing                             | `/admin/billing` (#504): the switch of billing with the statement of what it does, the payment adapter (`manual` or `stripe`) with the write-only Stripe API key and webhook secret, the connection check, the webhook endpoint, the rates and numbers (A, B per kind, the Diff AI reserve, the start credit, the low-balance threshold, the hourly brake), the links to the operator's terms and privacy statement (#626; the terms link is required for Stripe) and the result of the daily journal check ("Journal check: ok / inconsistent (date)") and the manual credit and correction of any workspace; below it **Payment reviews** (`/admin/billing/reviews`, #603): the billing events that moved money and changed nothing in the ledger, to close with a note, repair with a manual credit or check at Stripe, with their count on the menu and the overview. The screens are `src/admin/ui/billing-*`, the data routes are below `/api/admin/billing` (`src/billing/admin-http.ts`), and the logic and its rules are in `src/billing/README.md` ("The billing page") |
| GitHub                              | The Integrations page (the GitHub App, the one-click and the manual way, the sign in with GitHub, the admin's own GitHub account) is `src/github-config/`; its data routes are below `/api/admin/github`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

A lost admin password is reset by mail (below).

## Who gets in

- Not signed in: a page redirects to the sign-in, a data route answers `401`, exactly as for any other
  path that does not exist.
- Signed in, not an instance admin: **the answer of a path that does not exist**, in every detail. This is
  by construction, not by imitation: `/admin/**` and `/api/admin/**` are not routes of the app. The files
  of the portal live below `/instance-portal` and `/api/instance-portal`, and only the proxy
  (`src/auth/access-proxy.ts`) sends the instance admin's request there (`paths.ts`,
  `portalRewriteTarget`): it lets the request go on with `PORTAL_REWRITE_HEADER` and `next.config.ts` rewrites
  `/admin/**` and `/api/admin/**` to the files when the header is present. The proxy builds no address for
  the rewrite, so what a client sends as `X-Forwarded-Proto` or `Host` cannot change where it leads (a rewrite
  to an address whose origin is not the one Next.js made of the request is a request to another server, and
  failed with 500 when the server was started with a `HOSTNAME` other than `0.0.0.0`/`localhost` and the
  client, or a reverse proxy, said `https`). For everybody else the request goes on untouched and Next.js answers it itself:
  same status, same headers (including the `Cache-Control` that keeps it out of shared caches), same
  behavior for an RSC request, a prefetch, a write and a posted Server Function, and no rewrite header.
  A 404 built by hand, or a rewrite to a not-found route made by the proxy, would show
  (`x-middleware-rewrite`, a year of shared caching of the prerendered not-found); the e2e journey compares
  the full header set (names as written) and body against a missing path.
- The header is the proxy's alone: it takes it off every request it sees that arrives with it from outside
  (the one exception is a request that carries the mark, below), so nobody else is served the portal's files.
  Next.js does not run the proxy a second time on the path a rewrite of `next.config.ts` leads to (it did for
  a rewrite made by the proxy). The header's value is a secret of the running proxy (`PORTAL_REWRITE_HEADER`,
  compared with `timingSafeEqual`), so, should the proxy see the rewritten path, the
  files by their own address (`/instance-portal`, `/api/instance-portal`) are a missing path for everybody,
  the admin included. The proxy does not answer such a request itself (its answer would carry
  `x-middleware-rewrite` and lower-case header names, and `Cache-Control` would not be the one of Next.js's
  own 404): it lets it go on marked with `PORTAL_DENIED_HEADER`, which it takes off every request it
  sees that arrives with it, and `next.config.ts` rewrites a marked request to a path that is no route. Next.js adds
  `x-nextjs-rewritten-path` to the RSC answer of any rewrite, so the same rewrite also catches every other
  path that is no route (`fallback`, Next.js's own files left out); then the marked request and a missing
  path are answered by the same code, and the e2e journey compares every header, with its name as written.
- The instance admin's own portal answer is `Cache-Control: private, no-store` (`access-proxy.ts`): a
  prefetch of a portal address is answered from Next.js's prerender cache with a year of shared caching
  (`s-maxage=31536000`), and an admin-only answer must not sit in a shared cache (`#156`; the e2e journey
  compares the cache headers of an admin's RSC prefetch).
- The admin keeps access with an unverified email address, so that a mail problem can always be fixed. While a mail server is configured and the admin's address is not verified, the admin reaches `/admin` and nothing else of the app (`src/auth/access-gates.ts`, the proxy, `requireAdmin`); a person who is not an admin gets the same answer for a portal path as for any other path that does not exist: the 404 if they may use the app, and, while they are still waiting to verify their address or for a workspace, the redirect or 403 that every other path gets from them. Nothing says that the portal is there.
- Taking the admin flag away takes effect on the next request (the session lookup reads it every time).

The proxy is not the only guard. Every page and the layout call `requireAdmin()` (a person who is not an
admin gets `notFound()`, `session.test.ts` runs every page as such a person), every data route hands
`lookupAdmin` to `createAdminRouteHandlers` (or `createGithubRouteHandlers`, `src/github-config/http.ts`), which checks it before anything is read (401 for nobody, the
Next.js `notFound()` for somebody who is not an admin). `portal-guards.test.ts` fails for a page or route
that forgot it, and for a file of Server Functions inside the portal's folders (the portal has none: its
forms call the data route, which is also where the cross-site check lives).

## The settings

Stored in `instance_settings` (JSON values; `updated_by` and `updated_at` on every row, shown under each
setting). Nothing saved reads as the default.

| Setting                    | Values                                            | Rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenancy`                  | `single`, `multi`                                 | single to multi always; multi to single only while at most one workspace exists (none: the default workspace is created and the acting admin is its Owner), otherwise `too_many_workspaces` with the count. The count and the write are one transaction.                                                                                                                                                                                                                                                                                                                                        |
| `sign_up_rule`             | `everyone`, a list of emails, allowed domains     | Always changeable; same validation as the wizard. Affects new accounts and invitations only. A rule that names emails or domains shows a notice while it is fail-closed.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `sign_in_methods`          | `{ emailPassword, github }`                       | At least one stays on (`at_least_one_method`); GitHub only while configured (`github_not_configured`); GitHub only needs a linked GitHub identity of the acting admin (`admin_needs_github_identity`). Enforced at the sign-in (`src/auth/http.ts`, the login page and actions).                                                                                                                                                                                                                                                                                                                |
| `max_workspaces_per_user`  | integer 1 to 1000, default 10                     | Stored here, enforced by the workspaces issue.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `own_key_max_total_tokens` | integer 100,000 to 100,000,000, default 4,000,000 | The most tokens a Dynamic run on a workspace's own key may use when the price of its model is not known (#553; `src/native-cost/README.md`). Read at every claim. A stored value outside the bounds reads as the default, never as no cap.                                                                                                                                                                                                                                                                                                                                                      |
| `review_max_cost_cents`    | integer 1 to 10,000 (US cents), default 100       | #689: the most one review may cost, for Diff and Dynamic Review alike ("Maximum cost per review (USD)", General, Limits; typed in dollars with at most two decimals). It is the customers' maximum: a cost limit of a workspace or a project can not be saved above it, and the limit of a job is the smaller of the two (`src/runner-api/job-cost-limit.ts`). Read at every claim and at every settings save; a stored value outside the bounds reads as the default (1.00 USD), never as no limit. `RUNNER_DYNAMIC_MAX_COST_USD` is only the fallback of a runner whose app does not send it. |
| `plan_management_url`      | an absolute `https:` address, or none             | The operator-configured page "Manage plan" hands workspace Owners and Admins over to (#284; `src/plan-handoff/README.md`). No credentials, no fragment, at most 2048 characters; refused with `url_invalid`, `url_not_https`, `url_has_credentials`, `url_has_fragment` or `url_too_long`. Empty (`null`) removes it, and with it the button and the route. The operator API sets the same value. Upgrade every app instance before you set it.                                                                                                                                                 |
| `smtp`                     | host, port, security, user, sender, self-signed   | The mail server; the password is the secret `smtp_password`. Rules, the security modes and the test mail are in `src/mail/README.md`. Removing it (`{ "smtp": null }`) is allowed at any time; the sign-up rules that depend on it become fail-closed again (`sign-up-rule-state.ts`) and the portal shows the notice.                                                                                                                                                                                                                                                                          |

Two admins saving the same setting at once end with one complete write (one statement per setting): the
value and the admin belong together.

### Tenancy and workspaces

`src/workspaces/create-workspace.ts` (`createWorkspaceUnderTenancy`) is the one place that creates a
workspace for a user: it reads the tenancy in the same transaction that inserts the workspace, and refuses
on a single-tenant instance. The switch to single-tenant counts the workspaces in its transaction. The two cannot interleave and an instance never
ends up single-tenant with two workspaces (`tenancy-race.integration.test.ts` races two real processes).
A Postgres port needs a row lock on the tenancy setting in both places.

### The ways to sign in

`effectiveSignInMethods` is what is actually on. Nothing saved: email with password, and GitHub where it is
configured. GitHub that is switched on but not configured offers nothing. If that would leave no way in
(a saved GitHub only whose configuration is gone), email with password stays on, so nobody is locked out.
"GitHub is configured" means the GitHub App's user authorization (client id and a secret that can be read) is saved in the
database (`isGithubSignInConfigured` in `src/github-config/shared.ts`, read on every call). "GitHub only" asks for a GitHub
identity linked to the acting admin (`github-identity.ts`: a row in `accounts`), which the admin links under Integrations
(`src/github-signin/README.md`).

## The secret store

`src/secrets/`: table `secrets` (name, ciphertext, nonce, key version, optional last four characters,
`updated_by`, `updated_at`) on top of `src/crypto/`.

- Encryption as in the decision record: a key per purpose from `APP_SECRET` (HKDF-SHA256), AES-256-GCM, a
  random 96-bit nonce per save, the table, the name (the row id) and the field as additional authenticated
  data, so a ciphertext copied to another name does not decrypt. The names are a closed list
  (`src/secret-names/names.ts`, joined with the LLM key names in `admin/secret-names.ts`); a feature that stores a credential adds its name.
- `save`, `status` / `statuses` ("is configured") and `use` (inside the server). **Nothing returns a value
  through an API or a page.** `use` hands out a `SecretValue` that prints as `[secret]` in a string, JSON or
  `console.log`; `reveal()` is the one way to the value. A status can carry the last four characters, only
  when the caller asked at save time and the value has at least 16 characters.
- A secret that cannot be decrypted (a changed row, another `APP_SECRET`, an unknown key version) is the
  state `undecryptable` with the code `secret_undecryptable` or `secret_key_version_unknown`. Nothing throws
  and nothing logs; the overview tells the admin to enter it again.
- The operator's own LLM keys, one for each provider (`operator_llm_key` for the first provider, `operator_llm_key.<provider>` for the others; #276, #427), are saved on **LLM keys** (`/admin/llm`, one card for each provider) through `PUT /api/admin/settings` (`{ "operatorLlmKeys": { "<provider>": { "apiKey": "..." } | null } }`, one provider each; `null` removes that provider's key and leaves the others; the old `{ "operatorLlmKey": ... }` is accepted for the default provider for one more release, removal tracked in #460). They are write-only like the others: the settings read back carry a status and the last four characters of a long key for each provider (`operatorLlmKeys`, and `secrets`; `operatorLlmKey` is the default provider's), the field is emptied after a save, a refusal is `invalid_input` with the field `apiKey` (`api_key_required`, `api_key_invalid`; the Test button with an empty field also has `api_key_unreadable` for a saved key that cannot be read) or `provider` (`provider_invalid`). `POST /api/admin/llm-keys/:provider/test` asks the provider whether the typed (or the stored) key is accepted, with counters of its own. Only an instance admin gets here (the operator API has no call for it, `src/llm/README.md`, "The operator's own keys"). The overview lists them as optional, one status for each provider, and warns only when a saved key cannot be read.
- The managed model tiers (#280) are gone (#434): which model backs a workspace's reviews is a catalog entry (`src/model-catalog/README.md`), and `readSettings` has no `modelTiers` any more, the overview no "Managed model tiers" row; its row is "Model catalog" (#429: `modelCatalog`, released entries per kind and whether the kind has a default, counts only), which links to `/admin/llm`. A request that carries `modelTiers` is refused as an unknown field. The old operator setting `managed_model_tiers` stays in the database, unread, until a later migration removes it; the portal does not read it.
- The mail form saves the SMTP password through `PUT /api/admin/settings` (`{ "smtp": { ..., "password": "..." } }`); an empty or missing password keeps the stored one only while host, port, user and security are unchanged (otherwise `password_required_for_new_server`), `clearPassword` removes it, and the answer, the settings read back and every log line say only that one is set (`configured`), cannot be read (`unreadable`) or is missing (`none`). The GitHub App (private key, webhook secret, client secret) uses the store the same way: `src/github-config/README.md`.

## Billing (#504)

`/admin/billing` is in the group of the LLM keys and is the instance admin's alone, like every page of the portal:
`requireAdmin()` on the page and `lookupAdmin` handed to `createBillingRouteHandlers` in every data route
(`portal-guards.test.ts` finds one that forgot it; `protection.integration.test.ts` and `guard.integration.test.ts` list the
routes). Opening the page changes nothing and calls nobody; an admin who never opens it sees no change. Nothing here is
served to a workspace. The Stripe API key and the webhook secret are secrets of the store above (`stripe_api_key`,
`stripe_webhook_secret`): write-only, the answers say whether each is stored and the last four characters. The wording of every
code is in `src/admin/ui/billing-messages.ts`; the page names no payment vendor but Stripe and no plan.

`/admin/billing/reviews` (#603) is a child of Billing in the menu and the instance admin's alone like the rest: `requireAdmin()` on the page, `lookupAdmin` handed to `createBillingRouteHandlers` in `/api/admin/billing/reviews`, `/reviews/resolve` and `/reviews/check` (`portal-guards.test.ts`, `guard.integration.test.ts` and `protection.integration.test.ts` list them). The menu (the layout) and the overview read the number of open rows with `countOpenBillingReviews`; it shows as a badge on Billing and Payment reviews and as a "Needs attention" line, and nothing while none is open. A row holds ids and a reason, never a payload or a buyer; the rules are in `src/billing/README.md`, "Payment reviews".

## The run view (#541)

`/admin/runs` lists the newest runs of every workspace (workspace, project and pull request, review kind, status, time,
duration, error code) and `/admin/runs/<id>` shows one: its facts, what it consumed (model, tokens, cost in full, why it
stopped early) and the two tables of the call trace (`app/src/runs/ui/call-trace.tsx`, `contracts/README.md`). The operator
pays for the runs, so the cost is shown; the view names the fields it shows (`AdminRunDetailView`), so the log, the
question of an `/ask`, the trigger and actor, the pull request and comment addresses, the commit and the failure reason
and problem never reach it, and a field added to the workspace view does not appear here by itself. It reads
through `db/repositories/job-directory-repository.ts`, an instance level repository that only reads (`src/db/README.md`,
"Workspace scoping"); the pages ask `requireAdmin()` first like every page of the portal.

## The models.dev catalog (#554)

`/admin/catalog` is where the admin decides which models of the daily models.dev catalog (`src/models-dev/`) the managed key,
which we pay, may use, and what each costs. Instance admin only, like every page of the portal: `requireAdmin()` on the page,
`lookupAdmin` handed to the handlers of every data route (`portal-guards.test.ts` finds one that forgot it). Nothing here is
served to a workspace (`src/model-prices/visibility.test.ts` fails when anything outside the portal imports it).

- **The list** is filtered and paged on the server and the filters live in the address (`?provider=&q=&price=&state=&page=`,
  `catalog-models/query.ts`): there are about two hundred providers and thousands of models, so the page lists 50 at a time,
  newest first (what "new" is read by). The states are _new_ (no decision, first seen after the first fetch), _enabled_,
  _disabled_ (that is "dismissed") and _not decided_ (a model of the first fetch). **Reset to new** takes a decision back.
- **The price** of a model (a dialog) shows the price today with the source of every amount (models.dev, the override file or
  the admin's correction), the status (`confirmed`, `stale`, `unconfirmed`, `unpriced`) and, for a stale price, both prices.
  _Confirm price as shown_ echoes the hash of the price the admin saw (`price_changed` reloads the page with a notice);
  _Correct price_ takes dollars per million tokens as decimals and sends whole micro-USD digit strings, never through a float
  (`catalog-models/price-form.ts`, `src/model-prices/money.ts`), with a required reason. `fetch_in_progress` offers another try.
- **The fetch**: the state of the last attempt (success, or failure with its stable code as a sentence) and _Fetch now_
  (`POST /api/admin/catalog-fetch`): `refresh({ deadlineMs: 45 s })` (the route runs 60 s on the hosted deployment,
  `vercel.json`, pinned by a test), at most 6 times in 10 minutes for the whole instance (`rate_limits`, key
  `models-dev-fetch-now`). A fetch the guard stopped (`models_dev_guard_*`) is **not** applied silently: the answer (409)
  carries `reasons` (the code of every reason that tripped) and `details` (the figures the guard measured), the page lists them
  and asks, and the second request carries `acceptReasons`, the codes the admin accepted. A reason that is new in that fetch, or
  one that was not named, refuses it again.
- **A provider whose address changed** (`url_changed`, or a new one that was refused) is shown with the trusted and the new
  address next to each other as text, and with the reason in words. _Confirm the new address_ asks first and is a guarded update
  of the one provider row in a transaction of its own (`POST /api/admin/catalog-providers/url/confirm`,
  `{ providerId, pendingUrl }`): only the address the admin saw, only while `url_problem` is null, never a refused one. It reads
  the row `FOR UPDATE` first with a `lock_timeout` of 5 seconds on Postgres, so it waits for a fetch that is writing
  (`fetch_in_progress`, nothing written) and is applied after it; it does not take `MODELS_DEV_LOCK`. There is no "reject": the
  provider stays blocked until the address is confirmed or models.dev states the trusted one again, so doing nothing is the
  rejection.
- **Untrusted text.** Every name, id and address comes from models.dev. React escapes it, nothing is set as HTML, long strings are
  cut where they are shown (the whole text stays in the title), and an address is a link only when it is plain https
  (`catalog-models/format.ts`, `safeHttpsHref`); a pending address is never a link.
- **Codes.** A stable code from a route becomes a sentence in `catalog-models/messages.ts`; every table there is typed over the
  codes it translates.

## A lost admin password

A password is reset with a single-use link valid for 30 minutes: a random 256-bit token, stored only as a SHA-256 hash in `password_reset_tokens` (`src/auth/link-token.ts`). A
new link replaces the unused ones of the account. The link opens `/reset-password`, which posts to
`POST /api/password-reset` (`src/auth/password-reset*.ts`): the new password must pass the password rule,
the token is used up by one statement, and every session of the account ends in the same transaction. An
unknown, used, expired or changed token gets one answer, `invalid_token`. The route is public (the token is
the credential). It is rate limited per link, not for the instance: attempts against a token that exists
are counted in `rate_limits` (key `password-reset:<hash>`, 10 in the 30 minutes a link lives); a token that
does not exist gets the same generic answer and touches no counter, so junk requests cannot lock the
operator out of the recovery path. With a mail server the reset mail (`POST /api/password-reset/request`, `src/auth/password-reset-request.ts`) ends in the same function.

The link is asked for on the login page and arrives by mail, so it needs a mail server (admin portal, Mail). There is no
command line that makes a link any more (#700).

## Tests

- `guard.integration.test.ts`, `guard-visitor-routes.integration.test.ts`, `guard-member-*.integration.test.ts`: the
  proxy and the data route with real requests, a real database and Better Auth: anonymous, not an admin (every
  route, every method, odd spellings, a Server Function, the route without the proxy), the admin, an unverified
  admin. The cases on every route and method are their own files (#905: one test file runs in one worker, and one
  file of 484 tests made its CI shard the slowest); the routes and the harness are in
  `src/test-support/admin-guard-cases.ts`. `portal-guards.test.ts` finds a file without a guard.
- `http.integration.test.ts`, `service.integration.test.ts`, `tenancy.integration.test.ts`,
  `tenancy-race.integration.test.ts`: the settings, their rules, the concurrency and what is never in an
  answer or a log line. `src/secrets/store.integration.test.ts` and `secret-value.test.ts`: the store.
- `src/auth/password-reset.integration.test.ts`: the lost password.
  `src/auth/password-reset-expiry.integration.test.ts`: the exact 30:00 end of a link, held by the look before
  the reset and by the statement that uses the link up, each on its own (the clock answers a different instant
  to each).
- `ui/*.test.tsx`: the forms, the overview and the navigation. Journey: `e2e/admin/admin-portal.e2e.ts`; it
  compares the answer of a missing path with the answer for `/admin/**`, `/api/admin/**` and the files by
  their own address, for a page, an RSC request and prefetch, JSON, HEAD, OPTIONS, writes and a posted Server
  Function, as a member and as the admin.
- `src/auth/access-proxy.test.ts`: the rewrite mark (random per proxy, constant-time comparison, any length
  refused) and the marking of the files by their own address. `portal-rewrites.test.ts`: the rewrites of
  `next.config.ts` (the portal's, in front of the one for a missing path).
