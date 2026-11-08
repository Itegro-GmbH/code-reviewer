# 0005: LLM providers, the model catalog and billing with Paddle

- **Status:** Proposed. **Superseded in part by [0006](0006-prepaid-billing-via-stripe-managed-payments.md):** the
  billing part (Paddle subscriptions, plans, plan versions, the Free plan, M3 to M10, M12 to M14, M17 to M19, C9, sections
  2.10 to 2.15 and 2.18, and the billing rows of 2.16 and sections 3 to 5) is replaced by prepaid pay-as-you-go billing
  via Stripe Managed Payments (epic #489). The providers and model-catalog part (M1, M2, C1 to C8, sections 2.4 to 2.9
  without the `source` marker) stays valid.
- **Date:** 2026-10-17
- **Deciders:** the maintainer (Luca). Points marked **decision** are binding. Points marked **default,
  confirm with Luca** are the lead's defaults and may still change before the affected issue starts.
- **Implemented by:** epic #420 (providers, workspace keys and model catalog) and epic #421 (billing
  with Paddle); tracking issue of this record: #419
- **Amends:** [0001](0001-editions-setup-and-accounts.md), section 2.8 addendum (one operator key
  and model tiers) and section 6 (billing is now in scope); epic #268, principles 2 and 4 and its
  "out of scope" list (section 2.1 below). The rest of 0001 and of #268 stands.

## 1. Context

Epic #268 gave the operator of an instance the building blocks to run one instance for many
workspaces: entitlements with limits (#271), usage records (#272), a managed key mode with the
operator's own key (#276), enforcement at claim (#277), three fixed quality tiers Low, Medium and
High (#280, #283) and a token-protected operator API (#275). It deliberately left money outside the
repository: the app "knows counts, measured cost and states, nothing more", and an external service
was to decide what a limit means and set it through the operator API.

Four things changed the picture:

- **Provider and model are two half-implicit concepts.** The provider list has one element
  (`LLM_PROVIDERS = ["openrouter"]`, `app/src/llm/config.ts`), the model is a free string without a
  provider next to it, and a workspace has exactly one key slot (`workspace_secrets`, name
  `llm_api_key`). The instance has exactly one operator key (`secrets.operator_llm_key`, provider
  hard-coded). OpenRouter is also wired into the job contract (`llm.provider` is an enum with one
  value), into the runner (prefix, `require_parameters`, cost taken from `usage.cost`) and into the
  capability check. A second provider needs a seam first.
- **Three fixed tiers are too coarse.** The operator wants free, named choices ("Small", "Medium",
  "Big", "Opus"), per review kind, that it can change and that members choose without ever seeing a
  model id. Tiers also cannot express "this plan may use these models and not those".
- **The operator wants to sell plans, not run a side service.** The external-service idea of #268
  means a separate billing service, its own database and a second place for limits. The maintainer
  decided to put billing into the app as an optional module, with **Paddle Billing** (Merchant of
  Record) instead of Stripe, so that VAT and invoicing are not ours.
- **Plans, prices and limits must be editable by the operator without a deploy**, and a customer who
  bought a plan must keep the price and the limits they bought.

This record decides the shape of both features. Research reports (provider and catalog; Paddle) were
written on `26126076` and are the evidence for the code facts below. Production was not accessed.

## 2. Decision

### 2.1 What this supersedes

| Earlier statement | Now |
|---|---|
| #268, principle 2: "No amounts of money, currencies, plan catalog or business rules in this repository." | The repository holds the **mechanism** (a billing module, plan and plan version tables, a Paddle client). It still holds **no amount and no business rule as data or constant**: prices and limits are admin data in the database, tests use made-up numbers. The one constant is the supported currency, USD, a validation rule of the module. |
| #268, principle 1, "no new network surface" | Kept in spirit: billing is **off unless configured** and every billing route is the 404 of a path that does not exist while it is off. Billing adds an outbound Paddle API client and one public webhook route only when it is on. |
| #268, principle 4, "model names of managed tiers are operator configuration" | Now **model catalog entries**: the entry *name* is chosen by the operator and shown to members, the *model id and provider* are never shown. |
| #268, "out of scope: other LLM providers than OpenRouter" | The provider **seam** is in scope. A second provider is a follow-up. |
| 0001, 2.8 addendum: one operator key, "until managed tiers replace this" | One operator key **per provider**; tiers are replaced by catalog entries. |
| 0001, section 6: billing and prices out of scope | In scope, as an optional module of the app (2.10 to 2.17). The operator API of #268 stays and keeps working for manual use (2.9). |
| 0001, 2.7: pricing at instance level, "later" | Plans and prices are instance-level admin data. |
| #276, #277: the key mode is a per-workspace entitlement that the operator sets | Unchanged without billing. While billing is on, the key mode of a billed workspace is the **key mode of its pinned plan version** (M18), and the own key needs an `own` plan (M19, 2.8). |

### 2.2 Decisions of the maintainer (binding)

| # | Decision |
|---|---|
| M1 | **Providers** are a code-level list of supported LLM providers. Today only OpenRouter, built as an adapter registry so that another can be added. API keys are per provider at workspace level. Each project picks provider and model, separately for Diff and for Dynamic. |
| M2 | **Managed workspaces** (instance-managed key mode): the provider keys are set in the admin portal. Projects can only use models the operator released, from a **model catalog** with free names set in the admin portal. Real model ids are never shown to members. This **replaces** the fixed Low/Medium/High tiers (#280, #283). |
| M3 | **Billing is Paddle Billing** (Merchant of Record), not Stripe. There is no separate billing service or database: an optional module inside the app (`app/src/billing/`), off unless Paddle is configured, with its own tables in the app database. The code is public, but no amounts are in code. |
| M4 | **Plans** are editable in the admin dashboard: name, price, key mode, limits, `modelAccess` and the Paddle linkage. A plan grants a key mode, run limits, cost limits and the catalog entries a workspace may use (`modelAccess`, managed plans only), all reusing the entitlements machinery of #271 and #277. |
| M5 | **Hybrid catalog.** The app creates new prices in Paddle through the API and **never edits the amount of an existing price**; the operator can also link price ids created by hand in Paddle. Link-and-validate ships first, then "create a new price version". |
| M6 | **Plan versions.** Every subscription is pinned to a **plan version**: a fixed price together with a fixed key mode and fixed limits (run limits, cost limits, `modelAccess`). A plan configuration in the admin dashboard bundles its price, its key mode and its limits; changing the price, the key mode or the limits creates a new version. Subscribers keep their version, price and limits, until they change plan. The app stores which version each subscription is on and enforces that version's key mode and limits. |
| M7 | **Free plan.** A workspace without a subscription falls onto a configurable **Free plan** (defaults: 10 Diff and 2 Dynamic runs per month). It is a plan like the others, with editable limits and `modelAccess`, but has no Paddle price and no checkout, and its key mode is always `managed` (M18). |
| M8 | `past_due` gets **7 days of grace**, then managed reviews pause. |
| M9 | **Yearly plans** are in v1. A yearly option is offered **when the operator enters a yearly price** for the plan version (an amount, not a discount percentage); without one there is no yearly option. Limits are still per month. |
| M10 | **Plan changes.** An upgrade applies immediately with proration. A downgrade applies at the end of the period, scheduled by the app. |
| M11 | The Paddle **API key and webhook secret are stored encrypted** in the admin dashboard. The app creates the notification destination through the API. |
| M12 | **USD prices, always tax-inclusive** (Paddle `tax_mode: internal`). No country overrides. |
| M13 | **Enterprise** is only a call to action ("Let's talk" and a "Contact us" button) with a configurable contact link or email. There is no provisioning flow in v1. |
| M14 | **No overage** in v1. At a limit the workspace sees an upgrade notice. |
| M15 | Luca creates the Paddle sandbox and live accounts himself. |
| M16 | Tests use a fake Paddle API and a webhook signer in `fakes/`, with duplicates, reordering and lost responses. The sandbox checks are a go-live checklist issue. |
| M17 | An optional trial is **off by default** and configurable per plan. |
| M18 | **A plan has a key mode** (2.11): `managed` (the operator's key and the released catalog entries) or `own` (the workspace's own provider keys). The **Free plan is `managed`**, with defaults of 10 Diff and 2 Dynamic runs per month on the operator's released models; its key mode cannot be changed. A paid plan may be `managed` or `own`. An **own-key plan** (for example an "Own key" plan at a price that covers the operator's server costs) is a paid plan with key mode `own`: its run limits are **unlimited by default** but stay configurable like on any plan; the operator's cost limit does not apply to it (that limit counts runs on the operator's key), the optional own-key cost limit (#361) may still be set. The key mode is pinned with the plan version, together with price, limits and `modelAccess`. `modelAccess` applies to `managed` plans only; an `own` plan chooses provider and model freely (epic #420). |
| M19 | **Reviewing with the workspace's own key needs a paid plan with key mode `own`** while billing is on. Without a subscription (the Free plan) the own key is **not used**: Free reviews run only on the operator's models within the Free limits. A workspace that has stored its own key but has no `own` plan sees a clear notice with a link to Manage plan, and its jobs end with the stable code `own_key_requires_plan`; they never fall back silently, neither to the operator's key nor to the own key. **Billing off (self-hosters): nothing changes**, the own key works unlimited as today. Prices stay admin data (M12: USD, tax-inclusive); no amount goes into the repository. |

### 2.3 Lead defaults (default, confirm with Luca)

These apply unless Luca changes them before the issue that uses them starts. The epics carry the same
list in a comment.

| # | Default | Used by |
|---|---|---|
| C1 | **Tiers are migrated to catalog entries and removed in the same series.** There is no separate "retire" release. The operator route `/api/operator/v1/model-tiers` is removed (a documented breaking change of the operator API). The migration issue starts with a read-only check of the real production counts. All code that reads tiers goes in this series; the physical deletion of the old data (the `managed_model_tiers` setting and the `modelTier` members of the settings JSON) is a separate forward-only migration shipped one release later, because a migration only adds and a removal waits one release (`docs/deployment-vercel.md`, 5.6). Until then nothing reads that data. | migration issue |
| C2 | **No second provider now.** Only the adapter seam. The second provider, and the policy for providers that do not report cost, are a follow-up. | adapter issues |
| C3 | **Catalog entry names are unique** (case-insensitive). One entry may serve Diff, Dynamic or both. There is **one instance default entry per kind**, set by the operator. There is **no workspace-level default**. | catalog, settings |
| C4 | Entries that are not in the workspace's plan are **shown locked**, with a link to Manage plan. | settings UI |
| C5 | A retired or no-longer-allowed entry on a project **fails closed** with a clear notice, with **no silent fallback**. | claim |
| C6 | **Changing the model behind a released entry is allowed** after a re-check, with an audit line and a confirmation that shows how many projects use the entry. | catalog admin |
| C7 | **Own mode may select a provider without a stored key.** The form warns; the job fails with `llm_not_configured`, reason `no_key`. | settings UI, claim |
| C8 | **No operator API for the catalog.** Billing is in-app. `modelAccess` stays in the entitlements. | entitlements |
| C9 | **What triggers `own_key_requires_plan` (M19):** the effective entitlements come from billing (a row with source `billing`, or the Free plan written to `default_entitlements`), their key mode is `managed`, **and the workspace holds a stored own key** (a workspace key of any provider). The way out is to buy an `own` plan or to delete the stored key, after which the workspace reviews on the operator's models within its plan. A workspace without a stored key is unaffected. A `manual` entitlements row is never subject to this rule: the operator decides its key mode. | #442, #444 |

### 2.4 Providers: an adapter registry (decisions M1, C2)

**App.** `app/src/llm/providers/` holds the interface, the registry and the OpenRouter adapter. An
adapter provides: stable `id`, `label`, API base URL (the test override is unchanged), the names of
its workspace and operator secrets, `checkModelId`, `testKey`, `checkModelCapabilities`, suggested
models and prices, default models for Diff and Dynamic, and `costReporting`
(`provider_reported` or `none`). `LLM_PROVIDERS` and the `LlmProvider` type are derived from the
registry. A structure test pins that, with a fake second adapter registered in the test, no file
outside the adapter names `openrouter`.

**Runner.** `runner/.../llm_providers.py` is the same registry keyed by the same slug: LiteLLM
prefix, PR-Agent key and base settings, default API base, the require-parameters mechanism, the
matcher for "no endpoint supports these parameters", the cost extractor. `job.py`,
`pr_agent_config.py`, `require_parameters_patch.py`, `runner.py`, the Dynamic proxy and
`repo_settings_guard.py` read it. The guard derives its protected sections from the registry, so a
new provider cannot become a bypass of the repository-file guard.

**Contract.** `RunnerJobInput.llm.provider` changes from an enum with one value to a pattern string
(`^[a-z][a-z0-9_]{1,31}$`), still checked against the registry on both sides. A runner or Worker of
the previous release only understands `openrouter`, so `ClaimRequest` (and the Worker API's job
details request) gets an optional `llmProviders: string[]`; absent means `["openrouter"]`. The app
sends a provider only to a caller that advertised it, otherwise the job ends with the new stable code
`llm_provider_unsupported` (logged with the provider slug, no retry loop, the same philosophy as
`dynamic_engine_unavailable`). Everything else in the job input is unchanged: `model` is still the
real id, because the runner needs it.

**Cost.** Today all cost enforcement relies on the provider's `usage.cost` (an OpenRouter feature).
A provider with `costReporting: "none"` would give unknown cost on every run, so cost limits would
never trip. This record adds only the seam; the policy (operator-set prices per entry, or refuse to
release such entries while cost limits exist) is decided with the second provider.

### 2.5 Keys per provider (M1)

- **Workspace keys** stay in `workspace_secrets` (primary key `(workspace_id, name)`, AAD binds table,
  workspace id and name). OpenRouter keeps the name `llm_api_key`, so existing rows decrypt unchanged
  (a SQL migration cannot re-encrypt without `APP_SECRET`). Every later provider uses
  `llm_api_key.<provider>`. `WORKSPACE_SECRET_NAMES` is derived from the registry. `binding` must equal
  the provider (existing check). **No schema change, no data migration.**
- **Operator keys** stay in `secrets`: `operator_llm_key` for OpenRouter, `operator_llm_key.<provider>`
  later. They are written only in the admin portal, one card per provider (write-only, last four
  characters, a rate-limited Test), and are **never part of the operator API** (unchanged rule of
  0001, 2.8).
- Routes `/api/w/:ws/llm-keys/:provider` (new) and the old `/llm-key` kept as an alias for the
  default provider. The masking list while a workspace is managed contains the operator keys of
  **all** providers.
- A workspace in `own` mode needs a key for the provider it selected. A managed job needs the
  operator key of the **entry's** provider. A key of provider X is never used for provider Y.

### 2.6 The model catalog (M2, C3, C6)

A new instance-level table `model_catalog_entries` (the table is configuration, not customer data; it
is classified `INSTANCE_LEVEL` in `scoping.test.ts` with a reason):

| Column | Notes |
|---|---|
| `id` | opaque (`mce_` plus random), never reused, the only thing that leaves the server |
| `name` | free text, 1 to 40 printable characters, **unique case-insensitively (C3)**, **shown to members** |
| `description` | optional sentence for members (speed and depth); same copy scan as `copy/model-quality.ts` |
| `provider` | registry slug, validated in code and on read; **operator only** |
| `model_id` | real model id; **operator only** |
| `serves_diff`, `serves_dynamic` | the review kinds it serves; at least one (CHECK) |
| `status` | `draft`, `released`, `retired` |
| `sort_order` | order in the member's picker |
| `created_at`, `updated_at`, `updated_by` | as other tables |

Rules:

- **Release re-runs the adapter's capability check.** A Dynamic entry must be `supported`; an
  `unverifiable` Diff model is accepted; unknown models are refused (existing stable codes
  `DYNAMIC_MODEL_*`, `MODEL_UNKNOWN`).
- A released entry is never hard-deleted (its id stays in the mask list and in old usage records);
  `draft` entries may be deleted.
- **Changing the model or provider behind a released entry** is allowed (C6): the check is repeated,
  an audit line is written, and the portal asks for a confirmation that shows how many projects
  select the entry.
- **The instance default entry per kind** lives in the instance setting `catalog_defaults`
  (`{ diff, dynamic }`, each an entry id or null). There is no workspace-level default (C3).
- **Name guard.** The name is visible to members by design, so the portal refuses a name that
  contains the entry's model id, its slug (the part after `/`) or the provider id
  (`name_reveals_model`) and says that the name is shown to members. "Opus" revealing a vendor family
  is the operator's choice.

### 2.7 How a project selects a model

Additive fields in the existing settings JSON; no table and no migration of the settings:

| Field | Layers | Meaning |
|---|---|---|
| `provider` (new) | workspace default and project | provider of the Diff `model`; absent means the default provider, so every stored project stays valid |
| `model` (exists) | same | Diff model id, own mode |
| `dynamicProvider` (new), `dynamicModel` (exists) | project only (unchanged rule of #194) | Dynamic provider and model, own mode |
| `catalogEntryDiff`, `catalogEntryDynamic` (new) | **project only** (C3) | managed mode: the chosen entry id per kind |

Both families are stored side by side and only the one that matches the key mode takes effect (the
same pattern as "stored models are kept" today). A managed workspace's settings views carry entry ids
and names only, never `model`, `provider` or `dynamicModel`; a write that names a model or provider
is refused with the existing `MODEL_MANAGED_BY_INSTANCE`.

### 2.8 Claim resolution order

A new pure module `resolveModelSelection` runs **before** any key is loaded; the key follows the
selection, not the other way round (today `loadLlm` runs first and knows neither kind nor provider).

0. **Admission, unchanged and first** (`entitlements_invalid`, `workspace_suspended`, run limits,
   cost limits), inside the claim transaction. A refused job has no credential and no usage record.
1. **Key mode** from the effective entitlements: `own`, `managed`, or unreadable (fail closed).
   **Own key needs an own plan (M19, C9).** If the entitlements come from billing (source `billing`,
   or the Free plan in `default_entitlements`), the key mode is `managed` and the workspace holds a
   stored own key, the job ends with `own_key_requires_plan`: no credential, no usage record, no
   fallback to the operator's key or to the own key. The decision uses the entitlements and the
   workspace's key rows only; **it reads no billing table and no billing setting**. A `manual`
   entitlements row and an instance without billing never trigger it.
2. **Effective settings** of the project for the **job's pinned kind** (never the project's current
   kind).
3. **Own:** provider is `settings.provider` or the default; model is the project, workspace or
   built-in value of the kind. The provider must be registered and, for the runner, advertised.
   Key is the workspace key **of that provider**: no key gives `llm_not_configured`, reason `no_key`
   (C7). The fallback model is not sent (as today).
   A non-default provider with no model at any layer gets that adapter's default model for the kind
   (2.4); the cost falls on the workspace's own key.
4. **Managed:** entry id is the project's `catalogEntry<Kind>`, else the instance
   `catalog_defaults[kind]`, else `managed_model_unavailable`, reason `no_selection`. The entry must
   exist, be `released`, serve the kind, be **allowed by `modelAccess`** and have a provider that
   the runner can use. Key is the operator key of the entry's provider. **There is no fallback to
   another entry, another provider or `LLM_MODEL` (C5).** Failure reasons go to the log and the job
   detail, never with a model.
5. Record the key mode, and for managed also the entry id, its name (a snapshot, so a rename does not
   rewrite history) and the provider.
6. Capabilities from the adapter (`dynamic_model_features_unsupported`), token clamp for managed
   jobs (unchanged rule).
7. Job input with `llm.provider`, `llm.model`, `llm.apiKey`.

The Worker's first fetch runs the same function (`checkJob` is shared), so the two delivery paths
cannot disagree. An `own` claim reads no catalog row (a test pins zero catalog queries).
**The claim never reads a billing table**; billing only writes entitlements (2.12).

New stable codes: `managed_model_unavailable` (replaces `managed_tier_unavailable`, which stays in the
Runs copy for old rows), `llm_provider_unsupported`, `PROVIDER_UNKNOWN`, `CATALOG_ENTRY_UNKNOWN`,
`CATALOG_ENTRY_NOT_RELEASED`, `CATALOG_ENTRY_KIND_MISMATCH`, `CATALOG_ENTRY_NOT_ALLOWED`,
`name_reveals_model`, `catalog_entry_invalid`, and (billing, M19) `own_key_requires_plan` (a stable job
error code with member copy that names no model and links to Manage plan).

### 2.9 Entitlements gain `modelAccess` and a source (C8, M4)

- `modelAccess: { catalogEntries: string[] | null }`; `null` or absent means every released entry,
  `[]` means none. It is read **only for `managed` entitlements**: an `own` workspace never reads the
  catalog and never evaluates `modelAccess` (a stored value is kept and ignored, so a switch back to
  `managed` finds it again). Stored as a nullable JSON column `model_access` on `workspace_entitlements` and as
  a field of `default_entitlements`, read leniently (a missing field is `null`, never
  `entitlements_invalid`). Unknown ids are accepted (a plan may be written before the entry) and match
  nothing. One function `entryAllowed(entitlements, entry)` serves the claim and the picker.
- A plan change mid-period: a project whose entry is no longer allowed fails closed at its next claim
  (`managed_model_unavailable`, reason `not_allowed`) and the project page shows a notice.
- **Source marker.** `workspace_entitlements` gets `source` (`manual` or `billing`). Any write through
  the operator API or an admin action stores `manual`; only the billing module writes `billing`.
  The Free plan that billing writes to `default_entitlements` carries the same marker `billing`, which
  is how the claim tells a billed workspace from an operator-provisioned one (2.8, C9) without reading
  a billing table. **Billing never writes or deletes a row whose source is `manual`.** This is the whole protection
  of manually provisioned workspaces (for example a later Enterprise arrangement); there is no
  provisioning flow in v1 (M13).
- The operator API keeps working without billing exactly as today (off by default). While billing is
  on, `default_entitlements` is written by the billing module from the Free plan (2.11); a write
  through the operator API or the admin portal is refused with
  `entitlements_default_managed_by_billing`.

### 2.10 The billing module (M3, M11)

- **Placement.** `app/src/billing/`, server-only, optional. Repositories under
  `app/src/db/repositories/`. Its own tables in the app database, created by Kysely migrations that
  sort after the newest on `origin/development`.
- **Off unless configured.** Billing is on when the instance setting `billing_settings.enabled` is
  true and the credentials are complete. While off, every billing route, page, admin section and
  sweep step is inert (the routes answer the 404 of a path that does not exist), no billing table is
  read, no outbound call is made, and `default_entitlements` stays under the operator's control.
  Enabling requires a passing connection check.
- **Settings and credentials.** `billing_settings` (instance setting, JSON): `environment`
  (`sandbox` or `live`), the Paddle client-side token (public by design), the grace days (default 7),
  `enabled`. The **API key** and the **webhook secret** are encrypted secrets (`paddle_api_key`,
  `paddle_webhook_secret` in `SECRET_NAMES`), write-only in the admin portal. A key that contains
  `_sdbx` must match `environment = sandbox`, otherwise saving is refused. All billing rows carry the
  Paddle environment and are only read for the configured one.
- **Notification destination.** The admin button "Create notification destination" calls
  `POST /notification-settings` with the app's public address (`BETTER_AUTH_URL`) plus
  `/api/billing/webhook`, the events the app handles, and stores the returned `endpoint_secret_key`
  as the webhook secret. It can also be entered by hand. Live and sandbox have separate destinations
  and secrets.
- **Client.** A thin typed `fetch` client (`paddle-client.ts`) with an injectable base URL, our own
  response schemas and only the fields we use, not the Paddle SDK: about ten endpoints, easier to fake,
  no dependency. Money-relevant fields are protected by the client itself (2.11).

### 2.11 Plans, plan versions and prices (M4 to M7, M9, M12, M13, M17)

Tables (instance level unless noted; all in the app database):

```
billing_plans(id, plan_key unique, name, description, sort,
  kind 'free' | 'paid' | 'contact',
  offered bool, popular bool,           -- popular: at most one plan (partial unique index)
  contact_target null,                  -- https link or mailto, kind 'contact' only
  paddle_product_id null, created_at, updated_at)

billing_plan_versions(id, plan_id, number, role 'current' | 'legacy',
  key_mode 'own' | 'managed',           -- pinned with the version; 'managed' for kind 'free'
  limits json,                          -- the entitlement limits of #271/#361
  model_access json null,               -- catalog entry ids; null = all released
  monthly_amount_minor null, yearly_amount_minor null,  -- USD minor units, admin data (2.11, 2.18)
  monthly_price_id null, yearly_price_id null,    -- billing_plan_prices
  created_at, created_by)               -- immutable after creation except role

billing_plan_prices(id, plan_id, paddle_price_id unique, paddle_env,
  interval 'month' | 'year', currency, unit_amount_minor (cache), tax_mode (cache),
  trial_days null (cache), paddle_status (cache), origin 'created' | 'linked',
  intent_id null unique, state 'pending' | 'ready' | 'failed', last_error_code,
  snapshot_at, created_at, archived_at null)
```

- **A plan version is the sold unit.** Saving a plan's price or limits creates a new version with
  the new numbers; the previous current version becomes `legacy`. Metadata that does not change
  what is sold (name, description, `sort`, `offered`, `popular`, contact target) is edited in
  place. Versions may share a Paddle price (a limits-only change needs no new price).
- **Subscribers keep their version** (M6). `billing_subscriptions.plan_version_id` is set when the
  subscription is created (from the checkout row that the server wrote, see 2.12) and changes only
  through a plan change (2.14). The version's limits and `modelAccess` are what the workspace gets.
  Changing limits for existing subscribers is therefore never implicit.
- **Free plan.** A seeded plan of kind `free`, no price, no checkout. Its current version is written to
  `default_entitlements` whenever billing is on and whenever the Free plan gets a new version, so every
  workspace without a billing row falls onto it through the existing "no row means default" rule.
  Changing the Free plan applies to all Free workspaces at once (there is no subscription to
  protect). Defaults: 10 Diff runs and 2 Dynamic runs per month. **Its key mode is `managed` and cannot
  be changed** (M18, M19: no review on the own key without a paid `own` plan; saving `own` on a `free`
  plan is refused); its `modelAccess` is editable and seeded empty until the operator picks entries.
- **Key mode of a plan** (M18). Every plan version has `key_mode` (`managed` or `own`), pinned with the
  version like price and limits. A `managed` version runs on the operator's key and on the released
  catalog entries its `modelAccess` allows, with the usual limits including the operator's cost limit.
  An `own` version is sellable only for a `paid` plan and runs on the workspace's own provider keys,
  with provider and model chosen freely per project (epic #420): `model_access` must be `null`
  (`model_access_requires_managed_plan`) and the operator's cost limit `managedCostLimitMicroUsd` must
  be `null` (the existing `cost_limit_requires_managed_key`). **Run limits of an `own` plan are
  unlimited by default** (`null`) but stay configurable like on any plan, and the optional own-key cost
  limit `ownKeyCostLimitMicroUsd` (#361) may be set. A form default of "unlimited" is not an amount in
  code. Which prices and limits an "Own key" plan has is admin data; the repository holds none.
- **Enterprise** is a plan of kind `contact`: it shows "Let's talk" and a "Contact us"
  button with the configured link or email and has no versions, no price and no checkout (M13).
- **Prices are admin data** (M4, M9, M12). The operator enters per paid version a **monthly price** and an
  **optional yearly price**, USD, tax-inclusive, as dollars and cents (at most two decimals), stored as
  integers in minor units (`monthly_amount_minor`, `yearly_amount_minor`). The yearly price is an amount,
  not a discount; the screen's "save N%" is computed (2.18). A version offers yearly **exactly when it
  has a yearly price**; there is no `yearly_enabled` flag. A price change creates a new version (M6). A
  `free` or `contact` plan has no price. The Paddle price behind an amount (linked or created, below)
  must carry exactly that amount: linking refuses a price whose amount differs, and creating uses the
  entered amount. Limits are per month, see 2.13.
- **Display fields** (2.18): `sort` is the order of the cards, `popular` marks at most one paid plan (the
  flag moves in one transaction and a partial unique index refuses a second), and a `contact` plan is
  offered only with a contact target.
- **Trial** (M17). A trial is a property of the Paddle price (`trial_period`). The admin's "create
  price" form may set trial days (off by default); a linked price shows the trial it has. `trialing`
  is mapped like `active`.
- **USD and tax-inclusive** (M12). The only supported currency is USD. A created price has
  `tax_mode: internal` ("prices are inclusive of tax"); a linked price is accepted only with
  `tax_mode: internal` (an explicit value, not `account_setting`, so it does not depend on the account
  default). No `unit_price_overrides` are created, and a linked price that has overrides is refused.
- **Link and validate first (M5).** Linking reads `GET /prices/{id}`: it must exist, be `active`,
  recurring with the declared interval, USD, `tax_mode: internal`, belong to the plan's product and
  match the configured environment and **carry the amount the operator entered for that interval**. The
  cached amount and status come from Paddle, and a difference is refused (or, later, shown as drift); the
  app never edits the Paddle price to make it match.
- **Create a new price version second (M5).** The server creates the product on first use, then a new
  price with the amount entered for the version and `custom_data { cr_plan_key, cr_intent }`. An **intent row** is written first. Paddle has
  no client idempotency keys, so after a lost response the app lists the product's prices and matches
  the intent before it retries; the `price.created` webhook adopts a price whose intent matches.
- **Money guardrails.** The client wrapper and the fake refuse a `PATCH` of `unit_price`,
  `unit_price_overrides`, `billing_cycle`, `trial_period` or `tax_mode`. Allowed: `name`,
  `description`, `custom_data`, and `status: archived` only when no live subscription uses the price.
  Prices are never deleted; a drift (a price edited or archived by hand in Paddle) is shown as a badge
  and is never "fixed" by overwriting Paddle.

### 2.12 Checkout, customers and webhooks

**Checkout.** An Owner or Admin of the workspace starts it from the plan page. The **server creates the
Paddle transaction** (`POST /transactions` with the version's price for the chosen interval) and
writes a `billing_checkouts` row (`transaction_id`, workspace, plan version, interval, user,
environment) first. The browser opens the Paddle.js overlay with `transactionId`; the default payment
link page (`/billing/pay`) loads Paddle.js and nothing else. **Access is granted only from webhooks,
never from the redirect**: the success page says "activating" and polls the app's own database. The
workspace of a new subscription is resolved from **our own checkout row by transaction id**;
`custom_data.workspace_id` is only a cross-check, so the design does not depend on whether Paddle copies
API-set `custom_data` to the subscription. One live subscription per workspace is enforced by a
partial unique index and by refusing a second checkout.

**Customers.** The app does not create Paddle customers and sends no email to Paddle: Paddle's
checkout collects the customer. The app adopts `customer_id` from `subscription.created` into
`billing_customers(workspace_id, paddle_env, paddle_customer_id)`; later checkouts and the portal use
it. One Paddle customer may serve several workspaces (customer emails are unique per Paddle account),
so the link is stored per workspace.

**Webhook route.** `POST /api/billing/webhook`, Node runtime, public (the signature is the
credential), 404 while billing is off. The handler:

1. reads the **raw body** (`request.text()`, size-limited) and verifies `Paddle-Signature`
   (`ts=<unix>;h1=<hex>`): HMAC-SHA256 over `ts:rawBody` with the destination secret, **our own
   verifier** (all `h1` values, `timingSafeEqual`, tolerance 5 minutes), not the SDK's 5-second,
   non-constant-time check. A bad signature is 401 with an empty body and no logged payload.
2. in **one database transaction**: inserts `billing_webhook_events(event_id, ...)` with
   `ON CONFLICT DO NOTHING`; if nothing was inserted it is a duplicate and the handler answers 200
   and stops (dedupe on `event_id`, never `notification_id`);
3. applies the event to `billing_subscriptions` only if its `occurred_at` is not older than the
   subscription's `last_event_occurred_at` (a stale event is recorded and ignored; equal stamps
   apply);
4. re-derives and writes the workspace entitlements in the same transaction (2.13);
5. commits, then answers 200. Any exception answers 500 and nothing is half-applied; Paddle retries.

The handler makes **no outbound call** (Paddle requires 200 within 5 seconds, and on Vercel a cold
start counts). Event types handled: `subscription.created`, `subscription.updated`,
`subscription.canceled`, `transaction.completed`, `transaction.payment_failed`, `price.created`,
`price.updated`, `product.updated`; others are recorded as `ignored_type`. Outcomes are an `as const`
set (`applied`, `duplicate_ignored`, `stale_ignored`, `price_unmapped`, `workspace_unresolved`,
`workspace_manual`, `ignored_type`, ...). No payload is stored long-term; no card, address or tax id is
ever stored.

### 2.13 From subscription to entitlements

Billing is **upstream of entitlements and never read by the claim**. The pure function
`deriveEntitlements(subscription, planVersion, now, settings)` returns what to write; the writer uses
the same validation as the operator API (`validateEntitlements`).

| Subscription state | Entitlements |
|---|---|
| `active`, `trialing` | the pinned version's key mode, limits and `modelAccess` (`modelAccess` only for `managed`), source `billing`; `planLabel` is the plan name. An `own` version gives `keyMode: own` and its run limits (unlimited unless set) |
| `past_due`, first 7 days (`past_due_since` plus `graceDays`) | unchanged; the plan page shows a banner with the portal link |
| `past_due` after the grace, `paused` | `suspended` with `suspensionCode` `payment_overdue` or `subscription_paused`: reviews pause, on either key mode, with a clear refusal (`workspace_suspended`) |
| `canceled`, or ended | the billing row is **deleted**, so the Free plan (the default, `managed`) applies; an own key the workspace still holds is then not used and its jobs end `own_key_requires_plan` (M19) |
| scheduled change `cancel` | unchanged until `canceled` arrives; the plan page shows the end date |
| price not mapped to any version | unchanged, outcome `price_unmapped`, a log line with ids only; never a suspension |
| workspace row is `manual` | not touched, outcome `workspace_manual` |

`periodStart` is the start of the current **monthly usage period**: for a monthly subscription the
start of the billing period, for a **yearly** subscription the monthly anniversary of the
subscription start that contains `now` (day of month clamped), and it never moves backwards (the
existing `period_start_backwards` rule). Because a grace expiry and a monthly rollover of a yearly
plan are not events, the sweep (2.15) re-derives them. An **upgrade keeps the usage of the period**:
the new limits apply at once against the usage already counted.

### 2.14 Plan changes (M10)

Plan changes go to a **different plan's current version**, in the subscriber's interval and currency
(a subscription's currency is fixed). Changing between monthly and yearly, and moving to the current
version of one's own plan, are follow-ups. Direction is decided by the cached amounts of the two
prices in the same interval.

- **Upgrade, immediately.** `PATCH /subscriptions/{id}` with the full new item list and
  `proration_billing_mode: prorated_immediately`, `on_payment_failure: prevent_change`. A
  `PATCH .../preview` first shows the prorated amount, from Paddle, not computed by us. Entitlements
  follow the **webhook**, never the API response. The pin moves to the new version when
  `subscription.updated` shows the new price.
- **Downgrade, at period end.** Paddle has no scheduled item change (a scheduled change can only be
  cancel, pause or resume), so the app schedules it: a `billing_pending_changes` row (subscription,
  target version, target price, state). The sweep applies it inside a window **between 24 hours and
  1 hour before `next_billed_at`** (Paddle refuses item changes within 30 minutes of the renewal; the
  sweep runs every 2 hours), with `proration_billing_mode: do_not_bill`, so the renewal charges the
  new price. The workspace keeps the old version's entitlements until the period has ended. If the
  window was missed, the change is applied after the renewal with `prorated_immediately` (a credit for
  the unused part) and an alert code is logged.
- **A change can cross key modes** (for example from an `own` plan to a `managed` one). Entitlements
  follow the pin as for any change: the own key keeps working until the pin moves (a downgrade: the
  period end), after which a stored own key is not used and the workspace sees the M19 notice. The
  confirmation step names the key mode of the target plan.
- The plan change starts from the purchase panel of the plan screen (2.18).
- **Blocked states** are shown, not hidden: `past_due`, a pending scheduled change (cancel), a pending
  downgrade, and the 30 minutes before a renewal give stable codes (`plan_change_blocked_*`).
- **Cancel and payment methods** are done in the Paddle customer portal (cancel at period end,
  invoices, payment methods). The app creates a portal session per click
  (`POST /customers/{id}/portal-sessions`), checks the caller is Owner or Admin, redirects with 302,
  and never stores or exposes the link or the customer id.
- **At a limit** the workspace sees an upgrade notice with a link to the plan page. There is no
  overage (M14).

### 2.15 Reconcile and the sweep

Billing adds a step `billing` to the existing sweep (the cron sweep every 2 hours in a serverless
deployment, the hourly timer when self-hosted, `src/dispatch/README.md`). It: re-derives grace expiries
and yearly rollovers, applies due pending downgrades, and **reconciles with Paddle**: for a bounded
batch of known customers it lists subscriptions, compares them with `billing_subscriptions` and
repairs differences through the same apply function (the repair uses the entity's `updated_at` as its
stamp). The admin portal has a "refresh from Paddle" action for one workspace. A failing step does not
stop the other steps of the sweep.

### 2.16 Data model summary

| Table or setting | Level | New in |
|---|---|---|
| `model_catalog_entries`, instance setting `catalog_defaults` | instance | epic #420 |
| `workspace_entitlements.model_access`, `.source`; `default_entitlements.modelAccess`, `.source` | workspace / instance | epic #420 (`model_access`), epic #421 (`source`) |
| `usage_records.catalog_entry_id`, `.catalog_entry_name`, `.llm_provider` | workspace | epic #420 |
| settings JSON: `provider`, `dynamicProvider`, `catalogEntryDiff`, `catalogEntryDynamic` | workspace | epic #420 |
| `billing_plans`, `billing_plan_versions`, `billing_plan_prices`, `billing_webhook_events` | instance | epic #421 |
| `billing_customers`, `billing_subscriptions`, `billing_checkouts`, `billing_pending_changes` | **workspace** (created for one workspace, classified in `scoping.test.ts`, rows in `scoped-isolation.integration.test.ts`) | epic #421 |
| instance setting `billing_settings`; secrets `paddle_api_key`, `paddle_webhook_secret` | instance | epic #421 |

### 2.17 Security and privacy rules for every child issue

- Everything read from a webhook, a Paddle response, a model's metadata or a provider's error text
  is untrusted data. It never changes commands, prompts or permissions, and a webhook is only
  believed after the signature check.
- The Paddle API key, the webhook secret, an operator key and a workspace key never appear in a log,
  an answer, a page, an error or a test output. A secret is masked wherever the app masks keys.
- Customer data is workspace-scoped: a member of workspace A never reads a subscription, checkout or
  portal link of workspace B. Billing actions need Owner or Admin; a Member sees state only.
- Billing stores ids and states only: no card or bank data, no address, no tax or VAT id, no Paddle
  email, no invoice. Logs name ids and codes, never an email or a payload.
- A member never sees a provider or a model id, in any page, answer, run, usage view, log line a
  member can read, pull request comment or error copy. An instance admin sees nothing inside a
  customer workspace beyond what 0001 already allows.
- Stable error codes as `as const` sets; the UI maps codes to copy.

### 2.18 The plan selection screen (M9, M10, M13, M18; Luca's decision)

One screen, Workspace settings → **Plan** (`/w/:ws/settings/plan`), serves buying and changing plans.
Owners and Admins can buy and change; Members see it **read-only** (no select, no panel, no buy or
portal control). The limit notice (`quota_exhausted`) and the `own_key_requires_plan` notice (2.8, M19)
link to it; the latter opens the "Bring your own key" side. UI copy is English.

- **Header:** the current plan and the usage this month, as what is left ("7 of 10 Diff, 1 of 2 Dynamic
  left"; a `null` limit reads "Unlimited").
- **Toggle at the top:** "Plans with our models" lists the `managed` plans (Free, the paid ones and
  Enterprise); "Bring your own key" lists the `own` plans. It opens on the side of the current plan. A
  side with no offered plan is not shown.
- **One card per offered plan**, ordered by the operator's `sort`: the plan name; **"from $X/mo"**
  (X = the **yearly price ÷ 12** when the version has a yearly price, otherwise the monthly price);
  the key limits (Diff and Dynamic runs per month, "Unlimited" for `null`); the allowed models by
  their **catalog names** (`managed`) or "Any model with your keys" (`own`). The current plan is
  marked. The **"Popular" badge** is the `popular` flag of at most one plan, set by the operator. The
  **Enterprise card** reads "Let's talk" with a "Contact us" button to the configured link or email
  and has no checkout; Free reads "Free".
- **Selecting a paid card** opens a panel below the cards: a Monthly/Yearly toggle (Yearly only when the
  version has a yearly price; a subscriber is fixed to the interval of the subscription, the interval
  switch being out of v1, 2.14), the price of the chosen interval **tax included**, for Yearly a
  **"save N%" computed** from the two amounts, the effective date ("now" for a new subscription,
  "now, pro rata" for an upgrade, "on <period end>" for a downgrade, 2.14) and **"Continue to
  payment"**. For a workspace without a subscription it opens the Paddle overlay on the transaction the
  server created (2.12); for a subscriber it starts the plan change of 2.14.
- **Rules for amounts**, pure functions with made-up numbers in their tests, no amount in code. All
  arithmetic is on integer minor units: the "from" price is `round(yearly / 12)`, **rounded half up to
  a whole cent**; the saving is `N = floor(100 × (12 × monthly − yearly) / (12 × monthly))`, a whole
  percent rounded down, **hidden when N ≤ 0**; a price is shown **without cents when whole** ("$10")
  and with two decimals otherwise ("$8.33").
- Catalog names are free names that the operator chose (M2), so showing them to members is allowed;
  the screen still never shows a provider or a model id (2.17).
- Issues: the admin fields are #438, the panel and checkout #443, the screen #444, the plan change #445.

## 3. Failure modes

| Failure | Effect | Handling |
|---|---|---|
| Webhook endpoint or database down | Paddle retries (live 60 times over 3 days, sandbox 3 in 15 minutes) | answer 500 so it retries; the sweep reconciles after an outage; failed notifications can be replayed |
| Duplicate delivery | double apply | `event_id` primary key, applied in the same transaction |
| Out-of-order delivery | an old status overwrites a new one | `occurred_at` guard per subscription |
| Bad or missing signature, a sandbox secret in live | events rejected | 401, no payload logged, a log code on repeated failures; the environment check on save |
| Cold start longer than 5 seconds | Paddle sees a timeout and retries | the handler is idempotent, small and makes no outbound call |
| Webhook lost for good | stale entitlements | the reconcile step and the admin refresh |
| Price created, response lost | duplicate price or orphan | intent row, `custom_data` marker, list-and-match before retry, `price.created` adopts |
| Wrong or foreign price id linked | checkout fails or the wrong plan is sold | link validation (exists, active, recurring, interval, USD, `internal`, product, environment) |
| Price edited or archived by hand in Paddle | stale cache, checkout fails | `price.updated` refreshes the cache and sets a drift badge; an archived current price blocks offering and alerts |
| Subscription on an unmapped price | entitlements cannot be derived | keep the old entitlements, `price_unmapped`, alert; never suspend |
| Two checkouts for one workspace | two subscriptions | partial unique index; checkout refused when a live subscription exists; the second is flagged for the operator |
| Tampered checkout data | wrong workspace | server-created transaction and our checkout row; `custom_data` is never trusted |
| Renewal payment fails | `past_due` | 7 days grace with a banner and the portal link, then `payment_overdue` suspension; Paddle's own dunning keeps running; paying restores at the next event |
| Upgrade payment fails | the change is not applied | `on_payment_failure: prevent_change`; the error is shown |
| Downgrade window missed | the renewal charges the old price | apply after the renewal with a credit, log an alert code |
| Paddle API down or rate-limited | checkout, portal, price creation unavailable | existing access is unaffected (local state); `Retry-After` is honoured; the admin shows retry |
| Sandbox and live mixed up | wrong entities | `paddle_env` on every row, key prefix check on save |
| Billing turned off again | | routes inert; rows stay; `default_entitlements` returns to the operator; existing billing rows keep working until changed |
| Catalog entry retired or not allowed any more | project cannot start a managed review | fails closed with `managed_model_unavailable` and a notice (C5) |
| Provider key missing | job cannot start | `llm_not_configured` with a reason; the key of another provider is never used |
| Billing on, workspace on the Free plan or any `managed` plan, with a stored own key | the job must not run on the operator's key behind the workspace's back, nor on the own key without a plan | `own_key_requires_plan`, no credential, no usage record; the plan page and the LLM access page show a notice with a link to Manage plan; deleting the key or buying an `own` plan ends it (M19, C9) |
| `own` plan, no stored key for the selected provider | job cannot start | `llm_not_configured`, reason `no_key`, as without billing |
| `own` subscription canceled, suspended or downgraded to a `managed` plan | the own key must stop at the right moment | cancel: row deleted, Free plan, `own_key_requires_plan`; suspension: `workspace_suspended`; downgrade: at the period end, the pin moves, `own_key_requires_plan` |
| Billing enabled on an instance whose workspaces use their own key | those workspaces stop reviewing until they buy an `own` plan or delete the key | the enabling step names the count; the notice and the code say what to do; self-hosters who never enable billing are unaffected |

## 4. Alternatives considered

- **Stripe.** Rejected by the maintainer: it is not a Merchant of Record, so VAT, invoices and
  remittance would be ours.
- **A separate billing service and database.** Rejected (M3): a second deployment, a second place for
  limits and a network path for entitlements. The operator API remains for manual use.
- **Plans, prices or limits as code constants.** Rejected: amounts would be public in the repository
  and every change would need a deploy.
- **The app as source of truth for prices, editing amounts in Paddle (`PATCH unit_price`).** Rejected:
  Paddle does not document what a price edit does to a live subscriber's renewal, and a `PATCH` can
  overwrite a hand edit in the dashboard. New price versions plus the plan-version pin give
  grandfathering by construction.
- **Paddle as the only source (admin stores ids only).** Rejected as the end state: two UIs and
  invisible drift. It is the first step (link and validate).
- **Limits attached to the plan (not the version).** Rejected by M6: a limit change would silently
  change what existing customers bought.
- **Compute entitlements lazily at claim from billing tables.** Rejected: it couples the claim to
  Paddle state and to a module that must be off by default, and it breaks "the claim reads
  entitlements only".
- **Webhook acknowledgement before processing.** Rejected: processing is one short transaction, and
  acknowledging after the commit removes the "acknowledged but lost" failure.
- **The Paddle Node SDK.** Not used: about ten endpoints, a fake server and our own verifier make a
  thin client smaller and easier to fake. The SDK's verifier is not constant-time and rejects after
  5 seconds.
- **Credentials in environment variables.** Rejected by M11: the product settings live in the
  database (0001, 2.7) and the notification destination is created by the app.
- **Keep tiers next to the catalog.** Rejected: two ways to choose a model. Tiers are migrated and
  removed (C1).
- **A table `workspace_llm_credentials` instead of reusing `workspace_secrets`.** Rejected for the first
  iteration: it forces a re-encryption step because the ciphertext binds the name.
- **Creating Paddle customers through the API with the member's email.** Rejected: it sends personal
  data we do not need to send, and a duplicate email is an extra failure. The checkout collects it.
- **The own key stays usable on the Free plan** (or on every paid plan). Rejected by M19: the own key
  is what a paid plan sells (it covers the server costs); a key mode is a property of the plan.
- **Falling back to the operator's key when a workspace without an `own` plan holds its own key.**
  Rejected: it spends the operator's money behind the workspace's back and hides the cause. The job
  ends with `own_key_requires_plan` instead.
- **Falling back to the own key when the plan is `managed`.** Rejected: that is the free ride M19 closes.
- **Per-workspace default catalog entry.** Rejected (C3): the project-only rule of the Dynamic model
  already exists, and one instance default per kind is enough.

## 5. Consequences

**Easier**

- The operator edits plans, prices, limits and models in the admin portal without a deploy.
- A customer's price and limits do not change under them.
- A new provider is an adapter, not a rewrite; a self-hoster sees no change.
- Members choose by name; no model id leaves the server.

**Harder or costly**

- The public repository now contains billing code and a Paddle client. Prices are data, but the plan
  structure and the way of selling are visible.
- Two sources must agree: Paddle (what is charged) and the app (what is granted). The pin, the
  reconcile step and the stale-event guard exist for this, and a bug in them changes what a customer
  gets.
- The claim path is refactored (selection before key). It is the critical path of the catalog epic.
- The tier removal is a breaking change of the operator API (`/model-tiers`), accepted because
  production is fresh (C1, to be confirmed by a read-only count).
- Enabling billing on an instance with workspaces on their own key moves them onto the Free plan, whose
  key mode is `managed` (M18). Those workspaces stop reviewing on their own key until they buy an `own`
  plan or delete the key; their jobs end with `own_key_requires_plan` (M19). The enabling step in the
  admin portal says so and shows the count. Without billing nothing changes. The operator has to create
  an `own` plan before it enables billing on such an instance, otherwise these workspaces have nothing
  to buy.
- The claim learns one more case (a billed `managed` workspace with a stored own key), decided from
  entitlements and key rows only; the claim still reads no billing table.
- Docs to update with the issues: `src/llm/README.md`, `src/model-tiers/README.md` (replaced by a
  catalog README), `src/review-settings/README.md`, `src/runner-api/README.md`,
  `src/workspaces/README.md`, `src/operator-api/README.md`, `src/db/README.md`,
  `docs/deployment-coolify.md`, `docs/deployment-vercel.md`, `contracts/README.md`, `.env.example`.
- The operator needs to say in the hosted terms that Paddle is the Merchant of Record and which data it
  holds.

## 6. Open questions

- **Sandbox checks S1 to S8** (go-live checklist issue): effect of a price edit on renewals; renewal on
  an archived price; whether each webhook retry carries a fresh `ts`; `custom_data` of an API-created
  transaction (not relied on); the credit of a downgrade; the real event order during an upgrade and a
  scheduled cancel; the VAT treatment of a domestic German business with **tax-inclusive** prices and
  what the invoice shows; and the response to a duplicate customer email (not relied on). Luca creates
  the sandbox and live accounts (M15).
- **Paddle account and legal:** domain verification and website approval, the default payment link,
  confirmation by Paddle seller support that AI code review is acceptable, and the legal pages (terms,
  privacy, refunds) on the approved site.
- **Interval switch and own-version moves** (monthly to yearly, moving to the current version of the
  own plan) are not in v1.
- **Refund policy** and who approves live refunds (Paddle approval).
- **Cost under a second provider** (2.4) and its adapter (C2).
- **Margin:** the managed model cost is in USD per run; plan prices and limits must keep a margin. That
  is a business decision and outside the code.
- **A manual provisioning flow** for Enterprise customers (M13) and an operator-API view of the
  catalog (C8) are possible later follow-ups.

## 7. Out of scope

- Overage billing, prepaid credits, metered billing.
- Other currencies, country price overrides, tax-exclusive prices.
- A second provider adapter and its cost policy.
- A subscriber migration tool (moving existing subscribers to a newer plan version or price).
- Refund handling in the app, invoices in the app, dunning emails (Paddle's job).
- Sales tax or VAT calculation in the app.
- Mixing key modes inside one workspace (own key for some projects, operator models for others): a plan has one key mode.
- Choosing amounts for the "Own key" plan or any other plan: admin data, a business decision.
