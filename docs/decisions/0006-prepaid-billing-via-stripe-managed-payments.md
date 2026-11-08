# 0006: Prepaid pay-as-you-go billing via Stripe Managed Payments

- **Status:** Proposed
- **Date:** 2026-10-19
- **Deciders:** the maintainer (Luca). Points marked **decision** are binding (his decisions of 2026-10-18 and
  2026-10-19). Points marked **default, confirm with Luca** are the lead's defaults and may still change before the
  affected issue starts.
- **Implemented by:** epic #489 (billing: prepaid pay-as-you-go via Stripe Managed Payments); tracking issue of this
  record: #488
- **Supersedes (in part):** [0005](0005-providers-model-catalog-and-paddle-billing.md), its **billing part**
  (section 2.1 below lists what). The providers and model-catalog part of 0005 stays valid. Epic #421 (billing
  with Paddle) is superseded by epic #489.
- **Amends:** epic #268, principle 2 ("no amounts in this repository"): see 2.3, D3.

## 1. Context

ADR 0005 decided to sell subscription plans through Paddle Billing: plans, plan versions, prices, a Free plan, a
subscription state machine, a customer portal and plan changes. Part of it was built on `development`
(#436 Paddle client and fake, #437 settings in the admin portal, #438 plans and the Free plan, #439 price links);
the webhook endpoint (#441, pull request #471) and price creation (#440, pull request #470) were in review. Nothing
billing-related is on `main`: `git ls-tree origin/main app/src/billing` is empty and `main` has no `billing_*`
migration (its newest migration is `20261016140100_widen_usage_record_settled_reason`).

On 2026-10-18 the maintainer replaced that design:

- **Plans are the wrong shape.** A review costs real money twice: the model call and the virtual machine that runs
  the Worker. A flat monthly plan either overcharges small workspaces or loses money on heavy ones, and a
  workspace that brings its own LLM key still costs infrastructure. Usage-based pricing charges what a review costs.
- **Prepaid is simpler and safer than subscriptions.** There is no renewal, no dunning, no grace period, no plan
  change, no proration. The only provider event that matters is "money arrived" (and, rarely, "money left").
- **Stripe Managed Payments (MP) instead of Paddle.** MP is a merchant of record ("Sold through Link, LLC"), is
  generally available to German sellers (since 2026-04-22), has idempotency keys, a sandbox and signed
  webhooks, and its terms do not ban closed-loop prepaid credit the way Paddle's acceptable-use policy does
  (research reports of 2026-10-18).

The code facts this record builds on (`origin/development` at `b8fe39c1`):

- `usage_records` holds one row per job with the **reported real model cost** (`cost_micro_usd`, null when unknown),
  `key_mode`, `review_kind`, a state (`reserved`, `settled`, `void`) and a `settled_reason`
  (`app/src/usage/README.md`). A record is created in the claim transaction and settled in the transaction that ends
  the job. Both are exact for both review kinds.
- The claim (`claimNext`) runs under the instance gate lock, decides admission (`decideAdmission`: unreadable
  entitlements, suspension, run limits, cost limits) and reserves the usage record in one transaction. A refused job
  leaves no record and the pull request gets a refusal notice (`app/src/refusal-notices/`).
- A Dynamic run has an enforced cost budget in USD (the runner's ledger and per-job model proxy; default 1.00, a
  ceiling of 20 in code). A Diff run has a token budget and the job timeout, but no enforced cost cap.
- The key mode (`own` or `managed`) is an entitlement the operator assigns (`src/workspaces/entitlements.ts`). The
  own-key cost limit (`ownKeyCostLimitMicroUsd`, #361) and the managed cost limit exist already.
- The hosted deployment runs each Worker in a fresh Vercel Sandbox VM started by the Dispatcher
  (`dispatcher/README.md`). The App does not know when a VM starts or stops today; issue #487 (in progress) moves
  the VM stop to a signed call from the App.
- The app has a mail sender (`app/src/mail/`), a secret store with encrypted write-only secrets, an admin portal and
  a workspace-scoped repository rule (`app/src/db/README.md`, "Workspace scoping").

## 2. Decision

### 2.1 What this supersedes and what stays

| 0005 | Now |
|---|---|
| M3 Paddle Billing as the provider | **Stripe Managed Payments** behind a provider-neutral adapter (2.12, 2.13). |
| M4 to M7, M9, M10, M12 to M14, M17: plans, plan versions, the Free plan, yearly plans, plan changes, tax-inclusive prices, the Enterprise call to action, no overage, trials | **Gone.** There are no plans. Prices are two rates (2.4). |
| M8 grace period for `past_due` | Gone: there are no subscriptions. |
| M11 credentials encrypted and write-only in the admin dashboard | **Kept** for the Stripe key and webhook secret (2.14). |
| M15 Luca creates the sandbox and live accounts | Kept, for Stripe. |
| M16 fake provider API and webhook signer in `fakes/` | Kept: `fakes/stripe/` replaces `fakes/paddle/`. |
| M18, M19, C9 key mode per plan; the own key needs an `own` plan; `own_key_requires_plan` | **Gone.** The own key is free to use and pays infrastructure only (2.2, P3). |
| 2.9 `modelAccess` and the `source` marker on entitlements | `modelAccess` **stays** (catalog epic #420). The `source` marker and "billing writes `default_entitlements`" are gone. |
| 2.10 to 2.15, 2.18, the billing rows of 2.16 and of sections 3 to 5 | Superseded by this record. |
| 0005 section 7: "overage billing, prepaid credits, metered billing" out of scope | Now **in scope**: prepaid credit is the whole design. |
| M1, M2, C1 to C8 and sections 2.4 to 2.8: providers, keys per provider, the catalog, project selection, the claim resolution order | **Stay valid**, with one change: step 1 of 2.8 no longer refuses a managed-plan workspace that holds an own key. |

Epic #268, principle 2 ("no amounts of money, currencies, plan catalog or business rules in this repository") was
already narrowed by 0005. It is narrowed again: the repository holds the **mechanism** (a journal, a pricing engine,
an adapter) and **no rate as a constant**. The rates A and B are admin data (D3); the code holds two constants:
USD, and the top-up range.

### 2.2 Decisions of the maintainer (binding)

| # | Decision |
|---|---|
| P1 | **Provider.** Stripe Managed Payments (merchant of record "Sold through Link, LLC") behind a provider-neutral billing adapter. Luca accepts, without writing to Stripe first, the risk that Stripe may later object to a stored balance; the adapter keeps a later switch possible. |
| P2 | **Pure prepaid pay-as-you-go.** No plans, no subscriptions, nothing monthly. One USD balance per workspace. |
| P3 | **Two modes share the one balance.** *Bring your own key* pays **infrastructure only**. *Our key* pays **AI plus infrastructure**. |
| P4 | **Price.** AI price = real API cost x factor **A**. Infrastructure price = billable minutes x rate **B**, with one rate per review kind (Diff and Dynamic). Minutes run from VM start to teardown, **per started minute, with no minimum charge**. Rates are global; they are **not overridable per workspace** for now. Luca has no numbers yet: they are estimated from real Vercel costs (issue in the epic). |
| P5 | **What the customer sees:** the final AI price and the final infrastructure price of a review. Never the formula, the real cost, A, B or the minutes. |
| P6 | **Special cases.** A **superseded** run is charged AI plus minutes. An **error on our side** is charged nothing. A run with **unknown cost** is still charged its minutes. |
| P7 | **Balance.** Start credit 2 (proposed as USD 2; the amount is not yet explicitly confirmed). A top-up is at least 10 and at most 500. No auto-recharge in v1. Credit **never expires** and is **never refunded by us**. Stripe may refund within 60 days regardless of our policy, so the balance **may go negative; the workspace is then blocked** until it is positive again. |
| P8 | **Customers.** B2B only: a checkbox at the first top-up confirms that the buyer acts as a business, a clause in the terms, and an optional VAT ID. Currency: **USD**. |
| P9 | **Limits.** One **optional monthly total limit**, set by the customer, off by default. The existing own-key cost limit stays. A **hidden abuse brake** caps reviews per hour per workspace; the admin sets it, with a generous default. No per-review limit in v1. **Plan run quotas are removed.** |
| P10 | **Self-hosters.** Billing is off by default. The instance owner turns it on in a new admin-portal menu "Billing". A **manual adapter** lets an operator grant credit by hand. |
| P11 | **Paddle code is deleted** before the next release: plans, plan versions, plan prices and the Free plan are removed from `development` (never on `main`), together with the Paddle client, fake, price links and the admin plans page. Pull requests #470 and #471 are closed. The webhook skeleton and the event-dedupe **ideas** are kept, as ideas (2.15). |
| P12 | **Invoices.** The VAT ID and business name on MP invoices are undocumented. The app keeps the customer's billing profile itself and pre-creates the Stripe Customer from it. The sandbox test plan runs and the support questions are sent **before** VAT-compliant invoices are promised; the fallback is plain Stripe with our own invoices (2.13, section 6). |
| P13 | **Phases.** 0 cleanup and this record; 1 billing core (minutes, pricing, journal); 2 job integration (reserve and settle); 3 adapters (Stripe MP with a fake, and manual); 4 UI (workspace balance and top-up, admin "Billing", notifications); 5 start credit, abuse protection, go-live. Phases 1 and 3 can run in parallel. |

### 2.3 Lead defaults (default, confirm with Luca)

| # | Default | Used by |
|---|---|---|
| D1 | **Money is an integer in micro-USD** everywhere in the app (1 USD = 1,000,000), as in `usage_records.cost_micro_usd`. Stripe amounts are cents; the adapter converts. No floating point touches an amount. | all |
| D2 | **A** is a decimal factor with at most 4 decimals (stored as an integer in parts per 10,000, so 1.2 is 12,000). **B** is micro-USD per started minute, one value per kind. Each price is computed once per run and **rounded half up to a whole micro-USD**; there is no rounding to cents. AI price and infrastructure price are two separate amounts, each rounded alone. | pricing engine |
| D3 | **No rate in code.** A and both B have no default; billing cannot be switched on until all three are set. The start credit is an admin setting with the default 2. The code constants are the currency (USD) and the top-up range (10 to 500; an adapter may narrow it). | admin, pricing |
| D4 | **Key mode under billing.** While billing is on, the key mode is the **workspace's own choice** (default `managed`, so a new workspace can use the start credit on our models). The `keyMode` of an entitlements row or of `default_entitlements` is not consulted. The rest of the entitlements stays: `suspended`, `modelAccess`, the cost limits. With billing off nothing changes. | key-mode issue, claim |
| D5 | **Run quotas** (`diffRunsPerPeriod`, `dynamicRunsPerPeriod`) are **not enforced while billing is on**, and the plan page does not show them. With billing off a self-hosting operator keeps them (epic #268). | limits issue |
| D6 | **Reserve at claim** (2.8): minutes = the kind's maximum VM lifetime (job timeout plus the VM margin) rounded up; AI = for Dynamic the job's cost limit, for Diff the admin setting "AI reserve per Diff review" (Diff has no enforced cost cap). The reserve is a hold, not a price: settlement charges what the run really cost, even above the hold (the balance may then go below zero). | job integration |
| D7 | **Who caused the error** is decided by a table of the stable job error codes (2.6), pinned by a test that fails on an unclassified code. | pricing, job integration |
| D8 | **Refusals.** `insufficient_balance` when the balance is below the hold; `balance_negative` when the balance is below zero; `monthly_limit_reached`; `hourly_review_limit`. Each is a stable code with a pull request notice. The brake's number is never shown. | job integration |
| D9 | **Low balance** is below an admin-set threshold (default 5); **empty** is below what one review would hold. The mail goes to Owners and Admins once per crossing and re-arms after a top-up. | notifications |
| D10 | **Hourly brake default:** 60 started reviews per workspace per rolling hour. | limits issue |
| D11 | **Start credit** is granted once per GitHub account (the account id of the installation), lazily the first time a workspace with a bound installation meets billing, never twice for a deleted and re-created workspace. | start credit |
| D12 | **Monthly total limit** counts the charged total (AI plus infrastructure) of the calendar month in UTC. A claim is refused when the month's charges plus the new hold would pass the limit. | limits issue |
| D13 | **Top-up amount in Checkout** is a server-side `price_data` amount with the tax code `txcd_10105002` (AI as a service, business use) and `tax_behavior: exclusive`. The ledger credits the **net** amount; VAT is on top and never becomes credit. | Stripe adapter |
| D14 | **Idempotency.** The journal key is `(workspace, type, reference)`; the reference of a top-up is the payment intent id, of a refund the refund id, of a chargeback the dispute id, of a job entry the job id. Provider events are deduplicated on the event id as a second layer. | journal, Stripe |

### 2.4 The price of a review

For one finished run:

```
aiPrice    = key mode managed and cost known ? round(realCost x A) : 0
infraPrice = round(billableMinutes x B[reviewKind])
charge     = aiPrice + infraPrice
```

- `realCost` is `usage_records.cost_micro_usd`, the sum of the charges the model provider reported. `billableMinutes`
  is whole started minutes of the VM's life (2.11), at least 1 for a run that started a VM. There is no minimum
  charge: a run that costs nothing charges nothing.
- A **bring-your-own-key** run has `aiPrice = 0` whatever its cost.
- A, B and the rounding live in one pure module (`app/src/billing/pricing.ts`), tested with made-up numbers.

### 2.5 What the customer sees

- The **balance** in USD and, separately, the amount held for running reviews.
- Per review (in Runs and in the journal): the **AI price** and the **infrastructure price**, nothing else. A
  bring-your-own-key run shows only the infrastructure price (and, as today, the real model cost that is the
  customer's own).
- The **journal** of top-ups, the start credit, charges, releases, refunds and corrections, each with its date.
- Never the factor, the rates, the minutes or the real cost of the operator's key. A member never sees a provider
  or a model id (0005, 2.17, unchanged).

### 2.6 Special cases

| Outcome of the run | AI price | Infrastructure price |
|---|---|---|
| Result delivered, cost known | yes | yes |
| Failed after it used the model, cost known (for example the Dynamic budget ran out) | yes | yes |
| **Superseded** while it ran and its Worker reported | yes (the reported cost) | yes |
| Superseded and no report came within window and grace (cost unknown) | no | yes |
| Result delivered or failed, **cost unknown** (`no_result`, a missing provider cost) | no | yes |
| **Error on our side** (the launch failed, the VM or Worker died, the lease ran out, the runner shut down, the App failed to refuse or settle) | **no** | **no** |
| Void: refused at claim, cancelled before it ran, never began | no | no |

"An error on our side" is a closed table of the stable job error codes (`launch_failed`, `worker_exited`,
`lease_expired`, `lease_lost`, `runner_shutdown`, `dynamic_engine_unavailable`, `dynamic_isolation_self_check_failed`
and so on), decided in the pricing issue and pinned by a test that fails on any code without a class. The initial split (**default, confirm with Luca**) is: infrastructure
failures of the Dispatcher, VM, Worker lease and runner are ours; a run that reached the model and ended on the
customer's side of the line (an unreadable repository, a tool or budget limit, a result that was delivered) is the
customer's. `timeout` (the Worker ran past the hard limit) and `no_result` are ambiguous and listed in section 6.

A run with unknown cost is a free ride for the AI part, by Luca's rule. The hidden abuse brake (2.9) and the existing
unknown-cost alert (#361) are the answer to anyone who tries to provoke it.

### 2.7 The journal and the balance

Two tables, both **workspace-scoped** (created for one workspace, classified in `scoping.test.ts`, rows in
`scoped-isolation.integration.test.ts`):

```
billing_journal_entries(
  id, workspace_id, type, amount_micro_usd (signed integer),
  job_id null, review_kind null, minutes null, ai_micro_usd null, infra_micro_usd null,
  reverses_entry_id null,
  provider null, provider_ref null,            -- 'stripe', the payment intent / refund / dispute id; 'manual'
  actor_user_id null, note null,
  created_at,
  UNIQUE (workspace_id, type, ref_key))        -- ref_key: the job id or the provider ref (D14)

billing_balances(workspace_id primary key, balance_micro_usd, reserved_micro_usd, updated_at)
```

| Type | Sign | Meaning |
|---|---|---|
| `top_up` | + | A payment arrived (net amount). |
| `start_credit` | + | The grant for a new workspace (once per GitHub account). |
| `reservation` | - | The hold taken at claim. |
| `usage` | - | The charge of a finished run, with its AI and infrastructure parts. |
| `release` | + | The hold given back at settlement or when a job is voided. |
| `refund` | - | Stripe refunded a payment. |
| `chargeback` | - | A dispute was lost (or opened, per the adapter). |
| `correction` | either | A manual correction by an operator, or the reversal of a refund or chargeback (`reverses_entry_id`, reversed once). |

- **Immutable.** Entries are never updated or deleted; a trigger on both engines refuses it (the pattern of
  `20261018140000_protect_billing_plan_versions`, which this work deletes, is the model). A mistake is a `correction`.
- **`balance_micro_usd` is the sum of all entries**: it already excludes held money, because a reservation is a
  debit. The page shows `balance` as available and `reserved_micro_usd` as "held by running reviews". The balance
  row is a cache updated in the same transaction as every entry; a test and a check assert that it equals the sum.
- **Concurrency on both engines.** The claim takes a hold with a conditional update
  (`UPDATE ... SET balance = balance - :hold WHERE workspace_id = :w AND balance >= :hold`, one row affected or the
  job is refused), inside the claim transaction that already runs under the instance gate lock. SQLite has one
  writer; on Postgres the row lock serializes two claims of one workspace. Settlements, refunds, chargebacks and
  corrections update unconditionally, so a balance can go below zero only through them.
- A workspace without a balance row has balance 0; the row is created by the first entry.

### 2.8 The money flow: reserve, settle, release

1. **Claim (inside the claim transaction, after the existing admission checks).** In this order: entitlements
   unreadable or suspended (unchanged), the hourly brake, the monthly total limit, then the balance. The hold is
   `infraHold + aiHold` (D6): `infraHold = ceil(maxMinutes) x B[kind]`; `aiHold` is 0 for a bring-your-own-key
   workspace. If the balance is negative the job is refused `balance_negative`; if it is below the hold,
   `insufficient_balance`. A refusal leaves no record and writes the pull request notice (the existing refusal
   notice mechanism). Otherwise the `reservation` entry is written with the usage record.
2. **Run.** Nothing is charged while it runs.
3. **Settlement (the transaction that settles the usage record).** The pricing engine turns the outcome, the real
   cost and the billable minutes into a `charge` (2.4, 2.6). The journal gets a `release` of the hold and a `usage`
   entry for the charge, in one transaction with the usage record. A repeated completion changes nothing (D14).
4. **Void.** A job that ends without a run (refused after the hold, cancelled, never began, an error on our side)
   gets a `release` and no `usage` entry. This runs in the same places that void usage records today
   (`voidEndedJobs`, `closeRecordsOfEndedJobs`).
5. **Minutes arrive late.** The VM's teardown may be known after the job ends (2.11). If the minutes are not known at
   settlement, the entry is settled with the best known value (2.11) and corrected by a `correction` only if the
   real value differs by more than a minute and arrives within a day; otherwise the best known value stands.
6. **Billing off.** None of this runs: no balance is read, no entry written, the claim is unchanged.

A claim that was refused because of the balance is not queued again by the app; the customer tops up and pushes
(or comments `/review`) again. Nothing is parked in v1.

### 2.9 Limits

| Limit | Set by | Default | Counts | Refusal |
|---|---|---|---|---|
| **Monthly total limit** | the customer (Owner, Admin) | off | the charged total (AI plus infrastructure) of the calendar month, UTC, plus the new hold | `monthly_limit_reached` |
| **Own-key cost limit** (`ownKeyCostLimitMicroUsd`, #361) | the operator, in entitlements | unchanged | real model cost of the runs on the workspace's own key | unchanged (`quota_exhausted`, detail cost) |
| **Hourly abuse brake** | the instance admin, in "Billing" | generous (D10) | started reviews of the workspace in a rolling hour | `hourly_review_limit`; the notice says reviews are paused for a while and never names the number |
| Per-review limit | - | none in v1 | - | - |
| Plan run quotas | - | **removed while billing is on** (D5) | - | - |

### 2.10 Key mode while billing is on (D4)

The workspace chooses `managed` (our key and our catalog, AI plus infrastructure) or `own` (its own provider key,
infrastructure only) on its LLM access page. The claim reads the choice in the claim transaction, so the hold is
right (2.8). If the choice is `own` and the workspace holds no key for the selected provider, the job still ends
`llm_not_configured` (reason `no_key`) as today and its hold is released. With billing off the operator's entitlement
decides, as before. The `own_key_requires_plan` code of 0005 is not built.

### 2.11 Billable minutes

Billable minutes run **from VM start to teardown**, per started minute. Today only the Dispatcher knows both moments.

- **Hosted Sandbox.** The Dispatcher reports the VM's creation to the App right after `Sandbox.create` returns (an
  authenticated, idempotent call with the job credential it already holds during the launch; the VM never gets
  access to the Dispatcher or to any new endpoint). The VM's end is the App's own moment: with #487 the App tells
  the Dispatcher to stop the job's VM, and the answer of that call names the VMs it stopped. The stop time is
  taken on the App's clock when the answer arrives. If the stop call fails, the best known end is the earlier of
  "the job's terminal transition + the stop-retry window" and "creation + the VM timeout" (the platform's backstop),
  and the reaper cron's later stop confirms or lowers it.
- **Compose and self-hosted.** There is no VM. Where billing is on, the measured time is the job's wall clock on a
  runner (first claim to terminal transition), recorded with `source: job_wall_clock`. An operator who does not want
  to charge for it sets B to 0 for the kind.
- Stored per job: `vm_started_at`, `vm_ended_at`, `source` (`sandbox_created`, `app_stop_confirmed`,
  `timeout_backstop`, `job_wall_clock`), and the resulting `billable_minutes`. Minutes are whole: `ceil(seconds / 60)`,
  at least 1 once a VM exists, 0 when no VM or Worker ever started (an error before the launch).
- The facts are the App's own records of untrusted-free events (the Dispatcher's signed/authenticated calls); a
  Worker never reports its own minutes.

### 2.12 The provider-neutral adapter

An adapter performs actions and returns normalized events; it never touches the journal. The webhook route is
generic: secret, bounded raw body, `adapter.verifyAndParseWebhook`, then one transaction (deduplicate the provider
event id, apply the event to the journal).

```ts
interface BillingAdapter {
  readonly id: "stripe" | "manual" | string;
  readonly capabilities: BillingCapabilities;
  ensureCustomer(i: { workspace: WorkspaceRef; profile: BillingProfile }): Promise<ProviderRef>;
  createTopUpCheckout(i: { customer: ProviderRef; intentId: string; amount: Usd; returnUrl: string }):
    Promise<{ checkout: { kind: "redirect"; url: string } | { kind: "none" }; payment: ProviderRef | null }>;
  refund?(i: { payment: ProviderRef; amount: Usd | "full"; requestId: string }): Promise<{ refund: ProviderRef }>;
  verifyAndParseWebhook(i: { headers: Headers; rawBody: string; now: Date }): Promise<WebhookResult>;
}
type BillingEvent =                       // normalized, provider-neutral
  | { type: "payment.succeeded"; eventId: string; occurredAt: string; intentId: string | null;
      payment: ProviderRef; creditable: Usd; gross: Usd; tax: Usd | null }
  | { type: "payment.failed"; eventId: string; occurredAt: string; intentId: string | null; payment: ProviderRef }
  | { type: "refund.updated"; eventId: string; occurredAt: string; payment: ProviderRef; refund: ProviderRef;
      amount: Usd; initiatedBy: "seller" | "provider" | "customer"; status: "pending" | "approved" | "rejected" | "reversed" }
  | { type: "dispute.updated"; eventId: string; occurredAt: string; payment: ProviderRef;
      amount: Usd; status: "opened" | "lost" | "won" };
```

- **Capabilities** (`merchantOfRecord`, `customAmount`, `partialRefund`, `minTopUp`, `maxTopUp`, `currencies`,
  `providerMayRefund: { windowDays }`, `requiresBillingProfile`, `receiptsFrom: "provider" | "app"`) drive the UI, so
  the workspace page never names a provider. There is **no auto-recharge capability in v1**.
- `ProviderRef` carries opaque ids only; no card, address, tax id or email is stored (2.18).
- **Stripe MP** (2.13) is the first adapter; **`manual`** has no checkout (`{ kind: "none" }`): an operator grants
  credit from the admin portal (a `top_up` entry with `provider: manual`, an actor and a note) and the workspace page
  says "ask your operator to add credit". It lets a self-hosting operator run a prepaid regime with no payment
  provider at all.
- The interface is the output of the research of 2026-10-18; the issue that builds it may refine a signature, not a
  rule above.

### 2.13 Stripe Managed Payments

- **Top-up.** A Checkout Session `mode=payment` with a server-side `price_data` amount between 10 and 500 USD, the
  tax code `txcd_10105002`, `tax_behavior: exclusive`, `managed_payments[enabled]=true`, `client_reference_id` and
  metadata carrying our top-up intent id, and an `Idempotency-Key` derived from the intent. The intent row is
  written first; the workspace is resolved from **our** intent row, never from metadata. MP does not support
  `tax_id_collection`, `invoice_creation` or `customer_update[name|address]`; none is sent.
- **Crediting.** The credit is written on the first of `checkout.session.completed` or
  `payment_intent.succeeded`; both describe one payment, so the journal key is the **payment intent id** (D14). The
  credit is the net amount; VAT is on top. `checkout.session.async_payment_failed` marks the intent failed. The
  success page never credits.
- **Webhooks.** `Stripe-Signature` (`t=...,v1=...`, HMAC-SHA256 over `t.payload`, constant-time compare, signature
  before age, five-minute tolerance as a parameter), a bounded raw body, 2xx quickly, no outbound call in the handler.
  Delivery is at least once and unordered: dedupe on the event id, order by `created`. A body is data until the
  signature is verified.
- **Refunds and chargebacks.** Stripe may refund within 60 days regardless of our policy and may concede disputes.
  A `charge.refunded` or `charge.dispute.*` event writes a `refund` or `chargeback` entry even if it exceeds what
  is unspent; the balance may go negative and then blocks the workspace (`balance_negative`, P7). A refund that is
  rejected or a dispute that is won writes a `correction` that reverses it once.
- **Billing profile and Customer.** The app keeps, per workspace, the **billing profile** (legal name, address,
  VAT ID optional, the business confirmation with time, user and terms version). Before the first top-up it
  pre-creates the Stripe Customer from the profile (`name`, `business_name`, `address`, `tax_ids`,
  `preferred_locales`) and passes `customer=`. If MP ignores those fields nothing is lost; if it honours them the
  invoice is right (2.17). The profile is customer data of the workspace; it is not logged.
- **Ledger hygiene.** Stripe deletes its Customer, PaymentIntent, Invoice and Charge objects on a buyer's data
  request. The journal keeps opaque ids and our own amounts only and tolerates a `404 resource_missing`; it caches
  no receipt or invoice link (they expire).
- **Currency.** The ledger is USD. Adaptive Pricing is always on under MP: the buyer may pay in a local currency
  and Stripe settles in the account's currency (EUR for a German account unless multi-currency settlement is
  enabled). The exposure is ours (section 6).

### 2.14 Switching billing on, and the admin menu "Billing"

- **Off by default.** `billing_settings.enabled` is false until the instance admin turns it on in the admin portal,
  menu **Billing** (`/admin/billing`, in the group of the LLM keys). Billing is on only when the switch is on **and**
  the active adapter says it is ready (Stripe: key, webhook secret, A, both B, a passing connection check; manual:
  A and B). While off: every billing route answers the 404 of a path that does not exist, no billing table is
  read, no outbound call is made, the claim and the usage records are exactly as before. A self-hoster who never
  opens the page sees no change.
- **The page** holds: the switch (with a statement of what it does), the adapter, the Stripe credentials (the API key
  and the webhook secret are encrypted write-only secrets, last four shown, a connection check, and a button that
  creates the webhook endpoint with the app's public address), A, B per kind, the start credit, the "AI reserve per
  Diff review", the low-balance threshold, the hourly brake, and manual credits and corrections for any workspace
  (each with a note, written as a `top_up` or `correction`).
- Nothing about billing is an environment variable (`.env.example` unchanged).
- Turning billing on for an instance with existing workspaces needs no migration of their data: they begin with
  balance 0 plus the start credit (2.16) and choose their key mode.

### 2.15 The Paddle code: what is deleted, what is kept

All of it is on `development` only. Evidence: `git ls-tree origin/main app/src/billing` is empty, `main` has no
`billing_*` migration, no Paddle fixture and no `entitlements_default_managed_by_billing` in
`contracts/operator-api.v1.json`. So the cleanup is a deletion of files, without a removal migration.

- **Deleted:** plans, plan versions, plan prices and the Free plan with their repositories, services, HTTP handlers,
  rules, the three migrations and their tests; the Paddle client, schemas, verifier and `fakes/paddle/` with its
  fixtures; price links; the admin plans page and its API; the Paddle settings form and service; the operator API
  409 `entitlements_default_managed_by_billing` and the `source: billing` default entitlements, with its writer
  methods; the own-key count and the enabling copy of M19; the billing rows of `github-signin/merge.ts`; the
  billing entries of the tests that list routes, tables and migrations.
- **Kept, because the new design uses it as it is:** `isBillingOn` and `guardBillingRoute` (reduced to the one
  switch reader; the second reader `switch.ts` goes), the `billing_settings` instance setting (reduced to `enabled`
  and later holding the rates), `public-url.ts` (the webhook address must be public https for Stripe too), the
  secret-store machinery (the two Paddle names go, the Stripe names come with the adapter), and the shape of the
  admin route guards and their tests.
- **Kept as ideas, not code:** the webhook route skeleton and the event-dedupe table of pull request #471
  (`billing_webhook_events`: event id, outcome, no payload, plus a provider column), the pre-flight intent row
  (in #471 the checkout row), the destination-creation lease of #437, and the layout of `fakes/paddle/` (store,
  routes, signer, faults) for `fakes/stripe/`. The git history keeps all of it.
- **Risk of the deletion.** Kysely refuses to start when a migration that a database already recorded has no file
  any more. Production never ran the three billing migrations (they are not on `main`), but a local, preview or
  staging database that ran `development` did. The cleanup issue lists that check and the reset step.

### 2.16 Start credit and abuse

The start credit (default 2) replaces the Free plan. It is a `start_credit` journal entry, granted once per GitHub
account (D11) the first time a workspace with a bound installation meets billing. Abuse protection of the first
version: one grant per GitHub account that survives deletion of the workspace, the hourly brake, holds that bound
what a run can cost, and the existing sign-up rules of the instance. A heavier measure (a verified email, disposable
domain lists, a first-top-up cap) is a follow-up if the numbers ask for it.

### 2.17 The invoice and VAT-ID risk, the sandbox plan and the fallback

**The risk.** MP issues the buyer's invoice (the supplier is "Sold through Link, LLC"; we get a monthly self-billed
invoice). No Stripe page says how a EU business gets its company name and VAT number (USt-IdNr.) onto it or whether
reverse charge is applied: `tax_id_collection`, `invoice_creation` and `customer_update[name|address]` are
unsupported, and two undocumented paths remain (`name_collection[business]`, and a pre-created Customer with
`tax_ids`, `business_name` or `tax_exempt`). A German business without its name and VAT number on the invoice may
not be able to deduct input VAT.

**What the product does meanwhile.** Keep the profile ourselves (2.13), pass it to Stripe, and **promise nothing**
about VAT-compliant invoices in the product, the terms or the marketing until the tests below pass. The workspace
page says "Invoices are issued and emailed by Link" and links to link.com.

**Sandbox test plan** (maintainer issue in the epic): one sandbox account with MP enabled. T1 baseline MP Checkout
with `price_data` and the tax code: is there an Invoice and is its PDF the tax invoice. T2 `name_collection[business]`.
T3 `tax_id_collection` (the exact refusal). T4 a pre-created Customer with `eu_vat`, `business_name` and
`tax_exempt=reverse`. T5 a matrix of DE, FR with FR VAT ID, GB, CH and US buyers. T6 invoice and receipt language
(`preferred_locales`). T7 full and partial refund and the credit note. T8 changing the tax ID after the fact. T9 log
every webhook event for T1, T4 and T7. T10 one small **live** purchase, then refund (only live shows link.com).
The eleven support questions of the research report go to Stripe in the same issue.

**Decision rule and fallback.** If T2 to T4 show that a business buyer's name and VAT ID cannot reach the invoice
and support confirms it, the fallback is **plain Stripe with our own invoices** (Checkout without MP, Stripe Tax,
`tax_id_collection`, `invoice_creation`; VAT, OSS and invoicing become ours, which needs a tax advisor). The adapter
exists so that this is a second adapter, not a rewrite. A hybrid (MP for most buyers, plain Stripe for business
buyers who need a VAT invoice) is the least attractive option: it keeps both the 3.5 % fee and the compliance work.

### 2.18 Security and privacy rules for every child issue

- Everything read from a webhook, a Stripe response, a pull request or a tool is untrusted data and never changes
  commands, prompts or permissions. A webhook is believed only after its signature check.
- The Stripe key, the webhook secret and every LLM key never appear in a log, an answer, a page, an error or a test
  output.
- Customer data is workspace-scoped: the journal, the balance, the billing profile and the top-up intents. Only Owner
  and Admin top up or change the limit and the profile; a Member sees the balance and the prices read-only.
- Billing stores opaque provider ids and our own amounts. No card or bank data. The billing profile (name, address,
  VAT ID) is stored because the product needs it; it is never logged, never in a webhook payload store and never
  sent anywhere but Stripe.
- The admin credits and corrections are an operator action and always carry an actor and a note.
- Stable error codes as `as const` sets; the UI maps codes to copy. English copy, no colour literals.

## 3. Failure modes

| Failure | Effect | Handling |
|---|---|---|
| Webhook endpoint or database down | Stripe retries for three days (sandbox: three tries) | answer 5xx so it retries; the credit is idempotent on the payment intent id |
| Duplicate or reordered delivery | double credit, or an old state wins | event-id dedupe plus the journal key on the payment reference; ordering by `created` for refund and dispute states |
| `checkout.session.completed` and `payment_intent.succeeded` both arrive | double credit | one journal key per payment intent id |
| Bad or missing signature | event rejected | 401, empty body, nothing stored but a code |
| Two claims of one workspace at once | the balance is overspent | conditional update inside the claim transaction (2.7) |
| Cost beyond the hold | the balance goes below zero | the charge is real; the next claim is refused `balance_negative` |
| Stripe refunds consumed credit | negative balance | `refund` entry, workspace blocked until a top-up lifts the balance |
| Dispute lost | negative balance | `chargeback` entry, same |
| Dispute won, refund rejected | the debit was wrong | a `correction` that reverses it once |
| VM stop call fails | minutes unknown | best known end (2.11), the reaper confirms |
| Teardown never reported | minutes unknown | creation plus the VM timeout is the upper bound; a note on the entry |
| Settlement fails after the run | the hold stays | a sweep voids or settles records of ended jobs with the existing `closeRecordsOfEndedJobs` and writes the matching `release` |
| Stripe API down | no checkout | existing balances and reviews are unaffected; the page shows a retry |
| Buyer data deleted at Stripe | provider object gone | the journal keeps opaque ids; a `404` is normal |
| MP refuses the product later (stored value, "virtual currency") | no top-ups | the adapter seam: a plain-Stripe adapter or another provider; existing balances stay valid |
| Billing turned off again | | routes inert; the journal stays; reviews are unbilled; turning it on resumes from the same balance |
| Hourly brake trips for a legitimate burst | reviews paused | the admin raises the number; the notice does not name it |

## 4. Alternatives considered

- **Keep Paddle with subscriptions (0005).** Rejected by the maintainer: plans do not price a review fairly and
  a bring-your-own-key workspace would still cost infrastructure.
- **Paddle with prepaid credits.** Rejected: its acceptable-use policy bans "stored value, store credit, gift
  cards, vouchers" and contradicts its own AI page; no idempotency keys; saved payment methods cannot be created
  through the API.
- **Plain Stripe, we own VAT, OSS and invoices.** Cheaper per transaction and the invoice is ours, but VAT
  registration and filing become ours. Kept as the **fallback** (2.17), not the start.
- **Stripe Billing credits and customer balance.** Rejected: credit grants apply only to metered subscription items
  and cannot be applied to one-time invoices. The journal is ours.
- **Auto-recharge in v1.** Rejected: under MP a stored payment method cannot be charged later without our own
  authorization (terms 3.7(b)), so an off-session charge is probably outside MP and the VAT would be ours.
- **Expiring credit.** Rejected: German case law has struck expiry clauses for self-paid prepaid balances. Credit
  never expires.
- **A monthly allowance or a free tier next to the balance.** Rejected: the start credit is the free tier.
- **Per-workspace rate overrides.** Not in v1 (P4).
- **A per-review limit.** Not in v1 (P9).
- **Reading the real cost to the customer.** Rejected: the customer sees prices, not our costs (P5).
- **Parking a job until the customer tops up.** Rejected for v1: the pull request gets a notice and a new push or
  comment starts the review.

## 5. Consequences

**Easier**

- Price follows cost; a small workspace pays little and a heavy one pays what it uses.
- No plan, version, grace or renewal logic. The repository loses about 24,000 lines (95 files, tests and fakes included) of
  unreleased Paddle code before it ever reaches `main`.
- The claim becomes exact about money (a conditional update under the gate lock) instead of the soft cost cap.
- A second provider is an adapter.

**Harder or costly**

- A new critical path: the journal must always equal the sum of what happened. Immutability, idempotency keys and
  the balance check are the answer, and a bug here changes what customers pay.
- The App must learn VM start and teardown, which is new plumbing from the Dispatcher (#487 is its first half).
- The Dispatcher and the App gain a contract (a VM-created report), versioned per `contracts/README.md`.
- Stripe may refund within 60 days, concede disputes and offboard the product. We carry the loss of consumed credit
  and the risk of a provider change.
- The fee: MP charges 3.5 % plus card processing, roughly 8 to 12 % of a 10 USD top-up. The minimum of 10 limits it.
- The product promises no VAT-compliant invoice until the sandbox plan has run.
- USD ledger against EUR settlement is a currency exposure.
- The own-key mode no longer needs a plan; the cost of its infrastructure is now paid per minute.
- Docs to update with the issues: `app/src/billing/README.md`, `app/src/usage/README.md`, `app/src/runner-api/README.md`,
  `app/src/workspaces/README.md`, `app/src/operator-api/README.md`, `app/src/db/README.md`,
  `dispatcher/README.md`, `app/src/dispatch/README.md`, `docs/deployment-vercel.md`, `docs/deployment-coolify.md`,
  `fakes/README.md`, `TESTING.md`, `contracts/README.md`.
- The operator needs terms that say: credit is a prepayment for reviews, no cash value, non-transferable, not
  refunded by us, Stripe is the merchant of record and may refund within 60 days, B2B only, USD, unknown-cost
  runs are charged their minutes, an error on our side is not charged, and the abuse brake exists.

## 6. Open questions

For the maintainer (also listed in the epic):

1. **Is the start credit USD 2?** The amount is "proposed" in the decision and not explicitly confirmed (P7).
2. **"An error on our side" at the edges.** Is a run that timed out (`timeout`) or ended `no_result` ours? As written,
   `no_result` is "unknown cost" (minutes charged) and `timeout` follows the job's own outcome (2.6).
3. **"Plan run quotas are removed."** Removed only while billing is on (D5), or also the operator-API limits that
   self-hosters set (epic #268)?
4. **Key mode choice.** The workspace chooses `managed` or `own` while billing is on (D4); the entitlement's `keyMode`
   is ignored then. Is that the intended meaning of "two modes share one balance"?
5. **AI reserve for Diff.** Diff has no cost cap, so the hold is an admin number (D6). Is a number acceptable, or
   should a Diff cost cap be built first?
6. **Refund policy and the terms.** "Never refunded by us" is Luca's rule, but between businesses German AGB control
   still applies and Stripe refunds within 60 days anyway. A lawyer should read the terms before launch.
7. **Currency exposure.** USD ledger and prices against EUR settlement and Adaptive Pricing. Accept it, or enable
   multi-currency settlement (1 % fee) with a USD bank account?
8. **VAT on prepaid credit** (single- or multi-purpose voucher) and VAT-ID treatment of German business buyers
   (reverse charge, 13b UStG) are for the tax advisor and Stripe (research questions 2, 5, 7).
9. **Does Stripe accept closed-loop credit?** Luca decided not to ask first (P1). The sandbox cannot answer it.
   The risk is recorded in section 3; the live purchase test (T10) is the first real signal.
10. **Rates A and B.** The research issue estimates them from real Vercel Sandbox, function and LLM costs; Luca
    sets them.
11. **Pull requests #470 and #471** are closed by the lead; their branches stay for reference.

## 7. Out of scope

- Auto-recharge, subscriptions, plans, yearly prices, trials, usage-based invoicing of any other kind.
- Other currencies, country price overrides, a second payment provider or the plain-Stripe fallback adapter (a
  follow-up if the sandbox plan fails).
- Refund handling inside the app (the operator refunds in the Stripe dashboard; the webhook books it).
- Invoices and receipts inside the app (Link issues them).
- Per-workspace rates, per-review limits, parking jobs, a spend forecast.
- Sales-tax or VAT calculation in the app.
- The providers and model catalog (epic #420, ADR 0005, unchanged).
