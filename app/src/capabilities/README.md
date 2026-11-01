# Capabilities (#731)

One codebase is deployed more than once (code-review.com, and a clone with another product). What a deployment
offers is its **capability set**: `review`, `dynamic-review`, `billing`, `implementer`. A feature outside
the set is **absent**, not switched off: no route, no navigation entry, no API endpoint, nothing enqueued or run in
the background.

## Settings

| Variable               | Meaning                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `PRODUCT_ID`           | `code-review-com` (default) or `factory`                                                   |
| `PRODUCT_CAPABILITIES` | comma list; it can only narrow what the product `allowed`; unset = the product's `default` |

Unset, a deployment is exactly today's code-review.com: no new required variable. Every set contains `review`;
`dynamic-review` needs it, `implementer` needs `dynamic-review`, and so does a set of `billing` alone (refused by name). An empty entry in the list (`review,,billing`) is refused as
such.
`implementer` (#747) is allowed by the product `factory` only and is in no product's default, so an unset
`PRODUCT_CAPABILITIES` never turns it on; code-review.com refuses it by name (the code wall). It needs `dynamic-review`
(and so `review`). Its routes are the four behind the task form (`src/implementer/`, #755), classified `implementer` in `routes.ts` and
asked again in each route file; the navigation entry (between the QA area and Runs) and the page `/w/<slug>/implementer` are classified and offered the same way (#756). The job kind `implementer` is already mapped to it (`CAPABILITY_OF_REVIEW_KIND`), so
`allowsReviewKind("implementer")` is true only in a set that has the capability. A wrong setting stops the start
(`DEPLOY_CONFIG_INVALID`, `src/deploy/startup.ts`); it names the variable and never repeats an unknown value.

## Where the set is enforced

| Place                                  | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Proxy (`src/auth/access-proxy.ts`)     | `routes.ts` maps every route to `core` or a capability; a path of an absent capability gets the answer of a path that does not exist (the `MISSING_PATH` rewrite), after the checks any path gets. Pages and APIs, the admin portal's `/admin/...` addresses included                                                                                                                                                                                                                                                            |
| Classification test (`routes.test.ts`) | fails for any page, route handler or metadata file (`icon`, `sitemap`, `robots`, ...; `test-support/routes.ts`) under `src/app` that has no entry of its own in `ROUTE_CLASSES`: a blanket prefix does not count, so a new route is classified on purpose. It also allows a file of Server Functions (`"use server"`) only where `SERVER_FUNCTION_FILES` lists it, because an action id is reachable from any page and the path gate does not cover it                                                                           |
| Navigation                             | `shell/nav-items.ts`, `admin/ui/nav-items.ts`, `workspaces/ui/settings-sections.ts` carry a `capability`; client components read the set with `useCapabilities()` (`context.tsx`, provided by the root layout)                                                                                                                                                                                                                                                                                                                   |
| Jobs                                   | the job repository refuses a review kind without its capability (`JOB_KIND_UNAVAILABLE`); the settings service refuses to save the Dynamic kind without `dynamic-review`                                                                                                                                                                                                                                                                                                                                                         |
| Background                             | the sweep (`dispatch/sweep.ts`) skips the steps of an absent capability; the billing helpers (`billing/shared.ts`) do nothing without `billing`                                                                                                                                                                                                                                                                                                                                                                                  |
| Billing                                | `billing/enabled.ts` (the one reader of the switch) answers "off" without `billing`, so no balance is read, no credit checked, no start credit granted, whatever a stored setting says                                                                                                                                                                                                                                                                                                                                           |
| Health                                 | `GET /api/health` reports `product` and `capabilities`, the latter **sorted alphabetically** (a stable contract: `["dynamic-review","review"]`, with the Implementer `["dynamic-review","implementer","review"]`). The `health-factory` job of `deploy-production.yml` compares the sorted list with the repository variable `FACTORY_EXPECTED_CAPABILITIES` (`dynamic-review,review` while it is unset, `dynamic-review,implementer,review` once the Implementer is switched on; the App's reported list may come in any order) |

A new page or route: add an entry of its own to `ROUTE_CLASSES` or the classification test fails.

## When the set is read

`PRODUCT_ID` and `PRODUCT_CAPABILITIES` are read when the server starts (the check at start, the proxy, the jobs, the sweep,
`/api/health`) and **when the app is built**: the root layout hands the set to the client components (`useCapabilities()`)
and is part of the static shell (`cacheComponents`), so the navigation shows what the set of the _build_ has. Each Vercel
project builds with its own environment, so a project always has the set it runs with. A project whose environment is changed
without a rebuild keeps the old navigation until the next deployment, while the proxy and the jobs already follow the new
set; a link the navigation still shows then leads to a path that does not exist. Change these variables and redeploy.

## Product identity

The identity the application is composed with (`product-identity/`: name, wording, mail, the name of the check run and of the
GitHub App) follows the product: `identities.ts` holds one identity per id of `capabilities/products.ts`, and `current.ts` picks
the one of `PRODUCT_ID` (there is no second selector). This module does not import the identity; the identity imports only the
product ids from `products.ts`.
