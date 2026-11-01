# Billing module

The place of billing in the app. **Billing is off unless an instance admin switches it on, and an instance that never
does sees no change.** The design is ADR 0006 (`docs/decisions/0006-prepaid-billing-via-stripe-managed-payments.md`,
epic #489): prepaid pay-as-you-go through Stripe Managed Payments, with a provider-neutral adapter in front of it. The
earlier subscription design (plans, plan versions, prices with a payment provider, an admin page for them) was deleted
before it reached a release (#491); the model catalog, the providers and `modelAccess` of epic #420 are unaffected.

This file is for developers. The people who run an instance have their own guides: `docs/billing.md` (the hosted
operator) and `docs/billing-terms-checklist.md` (the points for the terms).
Every source file here imports `"server-only"` (`server-only.test.ts`).

## Billing end to end

One workspace has one USD balance, kept as the sum of an immutable journal in micro-USD. The sections below describe each
step; this is the whole path in order.

1. **The switch and readiness.** An instance admin sets the rates and the adapter on the billing page of the admin portal
   (`/admin/billing`, #504) and then the switch. Billing is on only when the switch is set **and** the adapter is ready
   (`isBillingOn`, "The switch"). Until then no billing route answers, no billing table is read and nobody is called.
2. **Rates.** The factor **A** (AI cost multiplier, our key only) and one rate **B** per review kind (micro-USD per started
   minute) are admin data with no default. The Diff AI reserve is still required to switch on but nothing reads it (#608).
   The start credit (default 2 USD), the low-balance threshold (default 5 USD) and the hourly brake (default 60) have
   defaults ("The price of a run", "The billing page").
3. **Start credit.** The first time a workspace with a bound GitHub installation meets billing, it gets the start credit,
   once per GitHub account ("The start credit").
4. **Top-up.** An Owner or Admin saves the billing profile, confirms that they buy for a business and starts a top-up of 10
   to 500 USD. The app writes an intent row, creates a Stripe Checkout session (Managed Payments) and sends the browser
   there. The credit is written **only** by the webhook (or by "Check payment", which applies the same event): the net
   amount, once per payment ("The billing profile, the Stripe adapter and the top-up", "Top-up intents", "Stripe webhooks").
5. **Claim.** When a runner claims a job, the checks run in one transaction in this order: the entitlements, the hidden
   hourly brake, the monthly limit, the start credit, and the balance. A review starts whenever the balance is above zero.
   **Nothing is held** (#605). A refusal is free and leaves no usage record ("Start, settle", "Limits at claim").
6. **Run.** Nothing is charged while it runs. The minutes come from the VM records ("Billable minutes").
7. **Settle.** In the transaction that ends the job, `settleEndedJobs` classifies the end, prices it and writes one `usage`
   entry. The balance may go below zero ("Start, settle", "The price of a run").
8. **Negative or empty balance.** At zero or below, every claim is refused (`insufficient_balance`, `balance_negative`) with
   a pull request notice until credit arrives. A refund or chargeback can also take the balance below zero.
9. **Notifications.** Owners and Admins get one mail per crossing into low or empty, and a banner while it lasts ("Balance
   notifications").
10. **Key mode.** While billing is on, each workspace chooses our models (AI plus infrastructure) or its own key
    (infrastructure only). The default is our models ("Key mode").
11. **Payment reviews.** A payment that cannot be credited by itself (an unknown intent, a wrong amount) is recorded as a
    review row that the admin resolves on `/admin/billing/reviews` ("Payment reviews").
12. **Billing off.** Switching off keeps rates, credentials, journal and balances. Claims and usage records are as before
    ("Start, settle" lists what billing off still reads).

What stays true on every path: money is an integer, an entry is written once (idempotent keys), the balance row is locked
before any write, the journal is never updated or deleted, and no secret, billing profile or amount of a payment is logged.

| File                                                                                                                              | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settings.ts`                                                                                                                     | The instance setting `billing_settings`: the switch `enabled`, the `adapter`, the rates, the numbers next to them and the record of the Stripe check (`stripe`). `readBillingSettings` reads a stored value leniently: a field it does not know (a value of the older shape also had an environment, a client token and grace days) is ignored, `enabled` is true only when it is exactly `true`, and a rate that is damaged reads as not set. |
| `rates.ts`                                                                                                                        | The rates and numbers (pure): the bounds, `validateRatesPatch` with the stable codes `factor_invalid`, `rate_invalid`, `reserve_invalid`, `start_credit_invalid`, `low_balance_invalid`, `hourly_limit_invalid`, `billingRatesOf` (the complete rates or null), `billingNumbersOf` (the numbers with their defaults) and `canSwitchBillingOn` (`billing_rates_incomplete`).                                                                    |
| `rates-service.ts`, `settings-store.ts`                                                                                           | The one writer of the rates and numbers: validates, merges into the stored setting under an advisory lock (`db/billing-settings-lock.ts`), keeps the switch, the adapter and the Stripe record as they are. `settings-store.ts` is the read-modify-write both this service and the admin service (#504) go through.                                                                                                                            |
| `outcome.ts`                                                                                                                      | `classifyOutcome`: the end state of a job and its stable codes to `charged`, `minutes_only` or `free`, from an exhaustive table (pure).                                                                                                                                                                                                                                                                                                        |
| `pricing.ts`                                                                                                                      | `priceRun` (pure): the two prices of a run in whole micro-USD. `reserveFor` (the old hold) is read by nothing since #605.                                                                                                                                                                                                                                                                                                                      |
| `journal.ts`                                                                                                                      | The vocabulary of the balance journal (#495): the entry types as an `as const` set, the sign of each, the stable error codes, `validateEntry`. The table checks restate the type and sign rules in SQL; `journal.test.ts` fails when they drift apart.                                                                                                                                                                                         |
| `../db/billing-minutes.ts`                                                                                                        | Billable minutes (pure, #493): `billableMinutes`, `backstopEnd`, `boundedEnd`, the end sources and `STOP_RETRY_WINDOW_SECONDS`.                                                                                                                                                                                                                                                                                                                |
| `wall-clock.ts`                                                                                                                   | `createWallClockRecorder`: the measure of a job without a VM, where billing is on (#493). `shared.ts` hands it to the platform after the response.                                                                                                                                                                                                                                                                                             |
| `hold.ts`                                                                                                                         | What an old hold was made for (#498): the longest a VM lives. The cost limit of a hold is the operator's maximum per review (#689, the admin portal), passed to `reserveFor` by its caller, no constant. Only `reserveFor` reads it, and no claim takes a hold since #605 (dead code, #608).                                                                                                                                                   |
| `claim-billing.ts`                                                                                                                | Billing at the claim (#498, #605): `readClaimBilling` (off, rates incomplete, or on with the rates) and `admitAtClaim`: a balance above zero starts the job, nothing is held.                                                                                                                                                                                                                                                                  |
| `claim-caps.ts`                                                                                                                   | The monthly total limit and the hidden hourly brake at the claim (#499): `checkClaimCaps` (in a savepoint; `reviews_paused`, `monthly_limit_reached`, `billing_limits_unreadable`), `utcMonthStart`, `brakeWindowStart`. See "Limits at claim (#499)".                                                                                                                                                                                         |
| `monthly-limit-service.ts`, `monthly-limit-http.ts`                                                                               | Reading and setting the monthly limit (#499): an Owner and an Admin (`manage_billing`), whole US cents, `null` for none, an audit line for every change; the handlers behind `GET` and `PUT /api/w/:workspace/billing/monthly-limit`.                                                                                                                                                                                                          |
| `claim-key-mode.ts`                                                                                                               | `keyModeAtClaim`: whose key a job runs on, as far as the claim knows (#496): the key mode of the effective entitlements, which is the workspace's own choice while billing is on.                                                                                                                                                                                                                                                              |
| `settle-jobs.ts`                                                                                                                  | `settleEndedJobs`: prices the jobs a transaction ended and writes one `usage` entry for each, unless free (#498, #605); a job that holds an old reservation (legacy) also gets its `release`.                                                                                                                                                                                                                                                  |
| `stranded-holds.ts`                                                                                                               | `releaseStrandedHolds` (#591), legacy since #605: releases the old holds of ended jobs that have none released, never charging; run by the switch-on and the sweep. It finds nothing on an instance that never took a hold.                                                                                                                                                                                                                    |
| `start-credit.ts`                                                                                                                 | `ensureStartCredit` / `ensureStartCreditWhileOn` (#507): the one function that grants the start credit, once per GitHub account ("The start credit" below).                                                                                                                                                                                                                                                                                    |
| `late-minutes.ts`                                                                                                                 | `correctLateMinutes`: one `correction` when the real end of a VM arrives within a day and moves the minutes by more than one (#498).                                                                                                                                                                                                                                                                                                           |
| `dispatcher-features.ts`                                                                                                          | Which Dispatchers the app has seen (with and without `vm_lifecycle`) and `canSwitchBillingOnWithDispatcher` (#498).                                                                                                                                                                                                                                                                                                                            |
| `enabled.ts`, `readiness.ts`                                                                                                      | `isBillingOn(db)`: the one reader of the switch (on = the switch is set and the adapter is ready, `readiness.ts`); `readBillingSwitch(db)`: the same with what is missing. `guardBillingRoute`: the first line of every billing route.                                                                                                                                                                                                         |
| `adapter.ts`                                                                                                                      | The provider-neutral seam (#497): `BillingAdapter`, `BillingCapabilities`, the normalized `BillingEvent`s, `WebhookResult`, the code constants (USD, the top-up range 10 to 500), the registry and `validateBillingEvent`.                                                                                                                                                                                                                     |
| `apply-event.ts`                                                                                                                  | `applyBillingEvent`: the one place where a normalized event becomes money (#497).                                                                                                                                                                                                                                                                                                                                                              |
| `../db/topup-intent.ts`                                                                                                           | The vocabulary of a top-up intent: states, codes and the shape the app sees.                                                                                                                                                                                                                                                                                                                                                                   |
| `manual-adapter.ts`, `manual-credit.ts`                                                                                           | The `manual` adapter and the service an operator's credits and corrections go through (#497).                                                                                                                                                                                                                                                                                                                                                  |
| `webhook-handler.ts`, `active-adapter.ts`, `shared.ts`                                                                            | The generic handler behind `POST /api/billing/webhook`, which adapter is active, and the wiring (#497); `shared.ts` also hands the wall-clock recorder to the platform (#493).                                                                                                                                                                                                                                                                 |
| `public-url.ts`                                                                                                                   | Whether an address can be reached from the internet (https, no credentials, no loopback, private, link-local or local name; pure), and the one spelling addresses are compared in. A Stripe webhook endpoint needs it.                                                                                                                                                                                                                         |
| `stripe-client.ts`, `stripe-schemas.ts`                                                                                           | A thin typed `fetch` client of the Stripe API and our own schemas of the fields we read (#500); no SDK. Used by the Stripe adapter (#501) and the webhook route (#502).                                                                                                                                                                                                                                                                        |
| `stripe-webhook-verify.ts`                                                                                                        | `verifyStripeSignature` (pure): the `Stripe-Signature` header over the raw body bytes (#500).                                                                                                                                                                                                                                                                                                                                                  |
| `stripe-webhook-parse.ts`, `topup-check.ts`, `topup-check-http.ts`                                                                | What a verified Stripe event becomes (#502, pure: `parseStripeWebhookEvent`, `paymentEventOfSession`), and "Check payment": the service and the handler behind `POST /api/w/:workspace/billing/top-ups/:id/check`.                                                                                                                                                                                                                             |
| `stripe-adapter.ts`, `stripe-credentials.ts`                                                                                      | The Stripe adapter (#501): `ensureCustomer` and `createTopUpCheckout` over the client, and the client made from the stored key when a top-up needs it.                                                                                                                                                                                                                                                                                         |
| `profile.ts`, `profile-service.ts`                                                                                                | The billing profile (#501): validation of what a person typed (pure, stable field codes) and the service that lets an Owner and an Admin read and write it.                                                                                                                                                                                                                                                                                    |
| `topup-service.ts`, `topup-http.ts`, `topup-limits.ts`                                                                            | Starting a top-up (#501): the checks in order, the handler behind `POST /api/w/:workspace/billing/top-ups` and its limit.                                                                                                                                                                                                                                                                                                                      |
| `workspace-page.ts`, `workspace-page-load.ts`, `workspace-key-mode.ts`                                                            | The data of the billing page of a workspace (#505): the balance, the journal page by page, the pending payments and, for an Owner and an Admin, the billing details, the monthly limit and this month's charges; what the page file asks for; and the key mode it names. See "The workspace page".                                                                                                                                             |
| `../db/balance-state.ts`, `balance-notifications.ts`, `balance-mail.ts`, `balance-banner.ts`                                      | The notifications of #506: where a balance stands (`low`, `empty`, `negative`; pure), the decision made inside the transaction that moved the balance, the delivery of the mails after the commit, and the data of the banner. See "Balance notifications (#506)".                                                                                                                                                                             |
| `journal-http.ts`, `profile-http.ts`, `run-prices.ts`                                                                             | The handlers behind `GET /api/w/:workspace/billing/journal` and `GET`/`PUT /api/w/:workspace/billing/profile` (#505), and the price of a review for the Runs pages.                                                                                                                                                                                                                                                                            |
| `invoices-service.ts`, `invoices-http.ts`                                                                                         | The invoices of a workspace (#659): an Owner and an Admin (`manage_billing`); the adapter's `listInvoices` for the one provider customer stored on THIS workspace's billing profile (made at the active adapter), nothing else is ever passed to the provider; the handler behind `GET /api/w/:workspace/billing/invoices` (`no-store`, 403 for a Member, 503 on a provider failure). No copy of an invoice is kept.                           |
| `admin-service.ts`, `admin-credit-service.ts`, `admin-http.ts`, `admin-errors.ts`, `enabling-copy.ts`, `stripe-webhook-events.ts` | The billing page of the admin portal (#504): the settings service (adapter, credentials, rates, connection check, webhook endpoint, the switch), the manual credit, the handlers of the data routes with their stable codes, the wording of the enabling statement, and the events Stripe is told to send. The page itself is `src/admin/ui/billing-*` and `src/app/(app)/instance-portal/billing/`.                                           |

## The Stripe client and the webhook verifier

The first real adapter (#501, #502) talks to Stripe through `stripe-client.ts` and trusts a webhook only after
`stripe-webhook-verify.ts` has checked its signature. Neither knows a workspace, a journal or a page (#500).

- **No SDK.** A `fetch` client of the dozen endpoints we use (customers with tax ids, Checkout sessions, payment intents,
  charges, refunds, webhook endpoints, the account), form-encoded as Stripe wants it, with our own zod schemas of only the fields
  we read (`stripe-schemas.ts`): a field we do not list cannot reach the app, a listed one with another type is refused
  (`invalid_response`). Nothing personal is read (no email, address or card).
- **Base URL.** Injected, no default: the client reaches no host it was not given. `STRIPE_API_BASE_URL` is Stripe's one
  address (the same for test and live); a test passes the address of `fakes/stripe`. Plain `http:` is accepted for the loopback
  only (`localhost`, `127.0.0.0/8`, `::1`); any other host must be `https:`, or the client is not configured
  (`invalid_configuration`): the key is a bearer token.
- **API version.** Every request pins `Stripe-Version: 2025-03-31.basil; managed_payments_preview=v1`
  (`managedPayments: false` leaves the preview flag out). Checkout also needs `managed_payments[enabled]=true` in the body and
  an eligible product `tax_code`; `CreateCheckoutSessionInput` has no field for what Managed Payments does not support
  (`tax_id_collection`, `invoice_creation`, `customer_update`, `payment_method_types`, `custom_text`), so none can be sent by accident.
- **The key and its environment.** The environment is read from the prefix (`sk_test_`/`rk_test_` is `test`, `sk_live_`/
  `rk_live_` is `live`, anything else is none). Stripe has one address for both, so the caller states the environment it is
  configured for (`environment`); on a Stripe host a key of another environment, or of an unknown prefix, throws
  `environment_mismatch` when the client is made, and the environment is required. A Stripe host is judged by the parsed host,
  not by the text: `stripe.com` and everything below it, in any case, with trailing dots or percent-escapes
  (`api.stripe.com.`, `API.STRIPE.COM%2e:443`). Only a host that is not Stripe's (the fake on the loopback) accepts any key.
- **Idempotency.** Every POST carries an `Idempotency-Key`: the caller's (`{ idempotencyKey }`; #501 derives it from the top-up
  intent), or a fresh one made for the call and kept for every retry of it. That is why a POST may be repeated after a lost
  answer or a 5xx and still creates one object. For the two calls that move money, `createCheckoutSession` and
  `createRefund`, the key is a required argument (`MoneyWriteOptions`; the type refuses a call without it), because a key made
  per call would not survive a restart of the caller.
- **Retries.** A 429 is retried after `Retry-After` (default 1 s, at most 30 s, else it fails at once); a 5xx, a lost connection
  and a timeout are retried with 0.5 s, 1 s, ... unless Stripe says `Stripe-Should-Retry: false`; any other 4xx is never retried. Two
  retries by default (`maxRetries`). The wait is injectable (`sleep`).
- **Limits.** 10 s for a request, all of it (connect, answer, body); no redirect is followed (`redirect_refused`); a body past
  2,000,000 bytes is refused (`response_too_large`), also while it streams; a list is followed for at most 20 pages.
- **Errors.** `StripeClientError` with a code of `STRIPE_CLIENT_ERROR_CODES` (`invalid_configuration`, `environment_mismatch`,
  `invalid_argument`, `timeout`, `network_error`, `rate_limited`, `bad_request`, `idempotency_conflict`, `unauthorized`,
  `forbidden`, `not_found`, `conflict`, `rejected`, `server_error`, `invalid_response`, `response_too_large`, `redirect_refused`),
  the HTTP status, and Stripe's own `type` and `code` when they are plain identifiers (`stripeCode: "resource_missing"` tells a
  buyer's deleted object from other 404s; the journal tolerates it). Fixed texts; **no response body, no header, no key and no
  cause** in an error, and the client logs nothing. A customer Stripe reports as `deleted: true` is `not_found`.
- **Secrets.** `stripe_api_key` and `stripe_webhook_secret` are names in `STRIPE_SECRET_NAMES` (`src/secret-names/names.ts`) (encrypted, write-only like the others);
  the billing page sets them (#504).
- **The verifier.** `verifyStripeSignature({ header, rawBody, secret, now, toleranceSeconds })` returns `{ ok: true, timestamp }`
  or `{ ok: false, code }` with a code of `STRIPE_SIGNATURE_ERROR_CODES` (`secret_missing`, `signature_missing`,
  `signature_malformed`, `signature_mismatch`, `timestamp_out_of_tolerance`, `tolerance_invalid`). It takes the body as the
  bytes received, accepts several `v1` values (Stripe sends two while a secret is rotated) and ignores `v0` and unknown
  schemes, compares every candidate in constant time, checks the signature **before** the age (a message with a bad signature
  never learns whether it was also old), and refuses a timestamp too far in the future as well as one too old. The tolerance
  is a parameter (default 300 s; `NaN`, infinite and negative are refused); an empty secret is refused. Replay inside the
  tolerance is stopped by the dedupe on the event id (#502).
- **The fake.** `fakes/stripe/` (see `fakes/README.md`); a test starts it with `startTestStripe` and gets a client with
  `clientFor(fake)` (`app/src/test-support/stripe-fake.ts`).

## The price of a run

All money is a whole number of micro-USD (1 USD = 1,000,000). No floating point touches an amount: the arithmetic is
BigInt, the result must fit the safe integer range (a larger one is refused with `pricing_amount_overflow`, never
wrapped), and a price is never negative. The worked numbers below are made up; no rate of an operator is in the repository.

```
aiPrice    = key mode managed, class charged, cost known ? round(cost x A / 10,000) : 0
infraPrice = class free ? 0 : billableMinutes x B[reviewKind]
total      = aiPrice + infraPrice
```

- **A** is stored in parts per 10,000 (1.2 is 12,000; at least 10,000, at most 1,000,000). **B** is micro-USD per started
  minute, one per review kind (0 allowed, at most 10,000,000). A and both B have **no default** and are all required:
  billing cannot be switched on before they are set (`canSwitchBillingOn`, `billing_rates_incomplete`).
- **The Diff AI reserve is dead.** `diffAiReserveMicroUsd` (0 to 50,000,000, real model cost before A) was the AI part of the
  hold of a Diff review. Since #605 nothing reads it, but it is still required to switch billing on (`diff_ai_reserve_missing`),
  so the admin form keeps the field and says that any value in range will do. Removing it (readiness, form, stored setting) is
  the follow-up #608, item 2.
- **Other numbers** (`billingNumbersOf`): the start credit (default 2 USD, 0 switches it off, at most 100 USD), the low-balance
  threshold (default 5 USD, at most 500 USD) and the hourly brake (default 60, 1 to 100,000). They are stored only when the
  admin sets them and can change at any time.
- **Rounding.** The AI price is `cost x A / 10,000` rounded **half up** to a whole micro-USD, once per run, on the whole
  cost. The infrastructure price is whole started minutes times a whole rate, so it is exact and needs no rounding;
  minutes that are not whole are refused. The two are separate amounts, each computed alone, and the total is their sum.
- Example (made up): cost 1,000,000, A 12,000, 3 minutes, B 10,000 gives AI 1,200,000 and infrastructure 30,000.
- **No minimum.** A run that costs nothing and needs no minute charges nothing.
- A run that cannot be priced (a fact that is no whole, non-negative number, rates that are not valid, an amount beyond
  the safe range) throws a `PricingError` with a stable code; the settlement of #498 charges such a run nothing and logs `BILLING_PRICING_FAILED` with the job id and the code (a customer is never charged a number nobody could compute).

### The hold is gone (#605)

Until #605 a claim held an amount for the run (`reserveFor`: the longest the VM lives times `B`, plus the AI budget times `A` on
our key). Holds blocked too much money (with 10 USD only about three Dynamic reviews could run at once), so the maintainer
removed them: a review starts whenever the balance is above zero and its real price is charged when it ends ("Start,
settle"). `reserveFor`, `hold.ts` and the reserve rate stay in the code and are read by nothing at run time (#608). ADR 0006
D6, D8 and 2.8 ("refuse below the hold") are superseded; "Old holds" in "Start, settle" says what still handles a hold that
an earlier release wrote.

### The classes of an outcome

| Class          | AI price                                  | Infrastructure price |
| -------------- | ----------------------------------------- | -------------------- |
| `charged`      | yes, on the managed key with a known cost | yes                  |
| `minutes_only` | no                                        | yes                  |
| `free`         | no                                        | no                   |

The rule is the maintainer's decision of 2026-10-19 (#489, #523): **a run is `free` only when the failure is clearly our
fault; everything else is `charged` in full (AI and minutes).** `minutes_only` is used for one thing only: a run whose AI
cost is unknown (`RunEnd.aiCostKnown === false`), because the AI part cannot be priced. No code, reason or settled reason
maps to it.

`classifyOutcome` maps the end of a job to a class.

- `free`, our fault: the launch failed, the VM or the Worker died, the lease ran out, the runner shut down or failed, our
  infrastructure (the Dispatcher, a runner, the Dynamic engine, the isolation, GitHub's availability and rate limit for our
  App, a checkout that failed on our transport) was unavailable, and **every timeout** (the queue's `timeout`, the runner's
  and, on the managed key, `llm_timeout`). The key, the account, the model, the rate limit, an outage and a timeout of the
  managed key are ours when it fails (`llm_auth`, `llm_quota`, `llm_rate_limit`, `llm_unavailable`, `llm_timeout`, ...) and
  the customer's on their own key. Also free: `no_capable_runner`, `dynamic_review_disabled`, `entitlements_invalid` and
  `dynamic_config_invalid` (missing job options, missing model prices or an invalid operator environment, raised before any
  model call: the operator's side; the job never ran), and the refusals of the claim for billing (`balance_negative`,
  `insufficient_balance`, `billing_rates_incomplete`, and the retired `billing_hold_released` of old rows: nothing ran).
- `charged`, everything else: a delivered result; a run that failed, including the `AI_COST_FAILURE_CODES` group
  (`command_failed`, `dynamic_budget_exceeded`, `cost_limit_reached`, `dynamic_policy_violation`,
  `llm_bad_request`, `llm_context_length_exceeded`, and the Implementer's `agent_gave_up`, `push_rejected`, `branch_violation`
  and `time_limit_reached`: its agent ran, so the model was used; a turn that ended before the agent ran, `branch_exists`,
  `base_branch_not_found`, `clone_failed`, `setup_failed`, `git_write_not_granted`, `implementer_engine_unavailable` and
  `implementer_config_invalid`, is free); a run stopped at a cost or time limit; a run that ended without a result (`no_result`,
  `review_not_published`, `llm_output_invalid`, a process the loop of a runner had to end); a run cancelled or superseded
  by a new commit; `git_auth` and `git_forbidden` (a revoked installation or our own App token: not clearly ours); and a
  code or checkout reason the build does not know. It never throws.
- A job that **never ran** (superseded or cancelled while queued, or refused at claim by `workspace_suspended` or
  `quota_exhausted`) is `charged` and prices to **0**: it has 0 billable minutes and no cost, so nothing is billed whatever
  its class.
- A run with an **unknown AI cost** that would be `charged` is `minutes_only`; one that is `free` stays free.

When several facts apply (the code, a finer reason, the settled reason of the usage record) the cheapest class for the
customer wins, so a run that was our error and also left no result is ours.

The table is exhaustive over today's terminal codes: the job end codes, the release reasons, the error codes and checkout
reasons of the runner contract, the reasons of the loop of a runner and the settled reasons. `outcome.test.ts` fails when
one of those lists gains a code with no class, so adding a code means deciding who pays for it.

## Billable minutes (#493)

The infrastructure price is `billable minutes x B` (ADR 0006, 2.4 and 2.11); this part **only measures**. It sets no price
and writes no journal entry, and #498 reads it when it settles. The table is `job_vm_runs` (workspace-scoped:
`db/repositories/job-vm-runs-repository.ts`): one row per VM the Dispatcher reported, with the raw timestamps for audit
(`started_at`, `reported_at`, `ended_at`), where the end came from (`end_source`), the VM's own timeout, the claim it was
started for and the whole minutes (`billable_minutes`, an integer). `measure(jobId)` is the one answer #498 needs:
`{ state: "not_ended" }` while the job runs, else `{ state: "measured", minutes, run }`, where `run` is the run that counts
(null and 0 minutes when no VM or Worker ever ran for the final claim).

**Started minutes.** `ceil((end - start) / 60 s)`, at least 1 once a VM exists, 0 when none does (`minutes.ts`; a test pins 0 s,
1 s, 59 s, 60 s, 61 s and 3,600 s). The price takes this integer as `billableMinutes` (#494).

**Where the start is recorded.** The Dispatcher creates the VM and is the only party that knows when. It tells the App right
after `Sandbox.create` returned, with `POST /api/runners/v1/jobs/:id/vm` (`vm_lifecycle`; `runner-api/README.md`). The report
is the Dispatcher's dispatcher token plus the job credential it holds during the launch (the VM and the Worker cannot call it),
a closed body, idempotent (the first report of a VM wins) and accepted only while that credential holds the running claim.
`started_at` is the Dispatcher's clock **kept between the claim and the moment the report arrived**: a skewed or wrong clock can
shorten or lengthen a VM by at most the launch, never by hours. A report that does not arrive (the call failed, an old
Dispatcher) leaves no row and the job measures 0 minutes: deploy the Dispatcher before billing is switched on.

**Where the end is recorded.** The reaper does not tell the App, and the VM timeout is only the platform's backstop, so neither
can be the source. The source is **the answer to the App's own stop call (#487)**: the Dispatcher's `202` now names the VMs it
is stopping (`vms`), and the App's clock at that moment is the end (`app_stop_confirmed`). The answer comes before the
platform has finished stopping a VM with a running container (20 seconds or more), so the measure is that much shorter than
the platform's own bill, in the customer's favour; a report of the finished stop is a follow-up. When no answer names the VM
(the stop call failed after its retries, a Dispatcher of the previous release answered `404`, the answer was `no_vm` or a
replay, the App went down) `measure` applies the **backstop**: `min(job end + 60 s, start + the VM's timeout)`
(`timeout_backstop`). Why: a VM that is still up after the job ended and our stop had its window is up because our stop did not
work, and that is our error; billing it up to the VM's timeout (35 minutes for a Diff job) would charge the customer for it.
The VM's timeout is the hard cap, so a missing teardown can never make a bill unbounded. A confirmation that arrives after a
backstop was applied replaces it (it is better evidence), bounded by the same cap; nothing else ever changes an end.

**Several VMs for one job.** Every VM is stored. The one that counts is **the VM of the claim that produced the final outcome**
(`billable`): a job claimed again after a lost attempt (a failed launch, a lapsed lease) gets a new claim, and the VMs of
earlier claims are our fault ("an error on our side is free") and are never billed, even if the final claim never created a VM
(then the job measures 0 minutes). A second VM reported for the same claim is kept but does not count. The claim is identified by
`jobs.claimed_at`, which a job keeps after it ends and which every claim sets anew; the attempt number alone is not reliable
(`complete` and `timeout` do not count a lost attempt, a failed release does).

**No VM.** A job that runs on a runner with no VM (the Worker API's tests, the e2e lanes) has none to measure. Where billing is on (`isBillingOn`), the job's wall clock on a
runner (the claim of the settled attempt to its end) is recorded with `end_source = job_wall_clock` when its claim ends
(`wall-clock.ts`, through the queue's `onClaimsEnded`); with billing off nothing is read or written. A job a Dispatcher
acknowledged is left to its VM. An operator who does not want to charge for it sets B to 0. VM rows themselves are stored
whether or not billing is on: it is one insert per hosted job, it reads no billing table, and it means a billing switch has
history.

**Edge: a superseded run that drains.** Its job is final when the push replaced it, while its Worker finishes a few model
requests; its VM ends with the claim, which the stop call reports, so a confirmed end is right. Only the backstop (no
confirmation) counts from the job's `finished_at`.

## Start, settle (#498, #605)

While billing is on, the money of a job moves in two places, all inside a transaction the queue already runs: the balance check when the job starts, and the charge when it ends. **Nothing is held in between (#605).** With billing off
**no money moves, and nothing reads or writes a billing table** (`claim-billing.integration.test.ts` checks that no statement of a claim and
a completion names one). What billing off does add, exactly:

- **one read of the instance setting `billing_settings`** per claim that reaches a candidate job (`readClaimBilling`, once per claim
  transaction), per `settleEndedJobs` call that has job ids, and per answer to a stop call (`correctLateMinutes`); with a Stripe adapter
  and the switch set it also looks for the two Stripe secrets by name, which is not the case while the switch is off;
- **`RETURNING job_id`** on the statements that end a usage record (`voidEndedJobs`, the sweep and the closing of records), to know which
  jobs ended;
- for a claim that names `worker_credential` (a Dispatcher): **one read of `dispatcher_sightings`**, and a **write of it at most once an hour
  per kind** of Dispatcher (`noteDispatcherClaim`, inside a `try`/`catch`: a failure logs `DISPATCHER_NOT_NOTED` and never delays or fails a
  claim). This runs also while billing is off, because the sighting must exist before an admin switches billing on.

The usage records, the claim and the operator feed are otherwise exactly as before.

**Start (`claim-billing.ts`, `admitAtClaim`, called from `claimNext` after the admission of the entitlements and the limits and before the usage record).**
A review starts whenever the balance of the workspace is **above zero**, even by one cent (maintainer decision of 2026-10-21 on #605, which replaces the hold of
#498 and ADR 0006 D8 and 2.8, "refuse below the hold"). **No amount is held, blocked or written**: the claim reads the cached balance
(`billing_balances`) and writes only the usage record, with `usage_records.billing_state = 'open'` (below). A zero balance is refused `insufficient_balance`, a
balance below zero `balance_negative`. One exception stays from #498: a job that **cannot cost anything** (the workspace's own key and a rate B of zero for its kind,
`canCostAnything`) needs only a balance that is not negative. Refusals fail the job with the stable codes below, count no attempt, leave **no usage record and no entry**,
and are reported to `onRefused` like the refusals of the entitlements:

| Code                        | When                                                                                                            | Notice     |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------- |
| `insufficient_balance`      | the balance is exactly zero                                                                                     | yes        |
| `balance_negative`          | the balance is below zero (a final charge, a refund or a chargeback took it there), also for a job that is free | yes        |
| `billing_rates_incomplete`  | billing is on and a rate is missing, or the switch is set and the adapter is not ready (`isBillingOn` is false) | yes (#632) |
| `reviews_paused`            | the hidden brake: the workspace started too many reviews in the last hour (#499, below)                         | yes        |
| `monthly_limit_reached`     | the workspace's own monthly total limit was reached (#499, below)                                               | yes        |
| `billing_limits_unreadable` | the brake or the monthly limit could not be evaluated (#499): closed for this job                               | no         |

`billing_hold_released` (a job claimed again whose hold was released) is no longer given: it stays in the code lists and the Runs page for the rows that carry it.

**Many reviews may start on a small balance, and that is accepted.** Nothing is held, so a workspace with one cent can start as many reviews as the queue and the hourly brake
(#499) let through, and the sum of their prices may take the balance far below zero when they end; then every claim is refused `balance_negative` until credit arrives. The balance
read at the claim is not locked: two claims at the same moment both see the same positive balance (`claim-billing.integration.test.ts`, #605-T04). A job claimed again after a lost
attempt keeps its one usage record.

**The notice.** `insufficient_balance` and `balance_negative` are in `NOTICE_CODES` (`refusal-notices/`): one comment on the pull request,
"Add credit to continue", naming no amount, rate, formula or model, linking to the billing page of the workspace while billing is on (#505, `refusal-notices/billing-link.ts`; the workspace settings when it is off). It is one per pull request **head** (`head:<sha>` in the `period_start` column, `db/refusal-notice-key.ts`), so a new push after a top-up that
was not enough is told again and the same head is not told twice. The check of the column took two more codes (migration
`20261021090000_widen_refusal_notice_codes`).

**Which jobs are settled: `usage_records.billing_state` (#605, migration `20261022010000_add_usage_record_billing_state`).** The journal used to say which jobs were
claimed with billing on (they had a `reservation`); with no hold it cannot, so the usage record says it. `open`: a claim with billing on handed the job out
(`openBilling`, in the claim transaction, only while billing is on; a job claimed again keeps it). `settled`: its one settlement happened (`closeBilling`). `null`: the job was
claimed with billing off and is **never charged**, whatever the switch is when it ends. Billing off writes nothing to the column (`claim-billing.integration.test.ts` checks that no
statement of a claim and a completion names a billing table). The column is nullable and no row is changed by the migration, so an older instance next to it is not affected.

**Settle (`settle-jobs.ts`, `settleEndedJobs`).** Called with the ids of the jobs whose usage record just reached its end, in the same
transaction, from every place that does it: `complete` (a result, also the report of a superseded run), `closeRecordsOfEndedJobs` (a lease or
runtime that ran out, a release on the last attempt, a cancel of the claim, the drain of a superseded run that never reported, the expiry of a
queued job), `voidEndedJobs` (`cancelWaiting...`, the replacement in `enqueue`) and the switch-off of Dynamic Review. For each job whose record is `open` it reads
the usage record (key mode, real cost, settled reason), classifies the end (`classifyOutcome`, with `aiCostKnown` from `usage_records.cost_micro_usd !== null`: one source
of truth), measures the minutes (below), prices the run (`priceRun`) and writes **one `usage` entry** with its AI and infrastructure parts, unless the run is free or
prices to zero (then nothing is written and the record is just closed). A `free` run is not even measured. **Exactly once:** the record goes `open` to `settled` in an update whose
row lock lets only one of two racing settlements go on, and the entry is keyed by the job besides, so a completion delivered twice, a sweep after it, a requeue and two
settlements at the same moment change nothing (`settle-jobs.integration.test.ts`, #498-T13 and #605-T13). The usage record and the operator feed keep the **real** model cost;
the journal holds the price.

- The price is charged in full whatever the balance is: it may go below zero (a Diff run whose cost passed the balance; a Dynamic run whose result says `usage.limitExceededBy`,
  the documented bound of the cost guard), and then every claim is refused `balance_negative` until credit arrives (#605-T07). The final-call exemption of the cost guard
  (a run never ends without a review) is the runner's; billing only prices what the run reports.
- A job that **never ran** has no minutes and no cost and prices to zero: nothing is written.
- A superseded run whose Worker **reported a result** (or whose drain ended) is charged in full, AI and minutes; one that never reported within window and grace is
  charged its minutes only, up to the push plus a minute (the end of the drain is not counted; accepted). **A superseded run that ends with our error is free** (maintainer
  decision of 2026-10-21 on #489, comment 6310423523: the rule that our error is free wins over the rule that a superseded run is charged). The job of a superseded run keeps
  no error code (it stays `superseded` and only stores the report), so the error code the Worker reported is handed to the settlement of that report
  (`SettleOptions.reportedErrorCodes`) and classes the run like any other end: `runner_error`, `launch_failed`, `git_unavailable`, ..., and on the operator's key the provider
  failures that are ours there (`llm_unavailable`, ...) make it free; a failure that is not ours (`command_failed`, a provider failure on the customer's own key) stays charged
  (#605-T10).
- A job whose billing was **off at the claim** has `billing_state` null and is never settled, even if billing is switched on while it runs. A job claimed with billing on whose
  billing is switched **off before it ends** ends without a settlement (none runs while billing is off) and is **not charged**, also when billing is switched on again (#591,
  confirmed on #489: such a run is not charged; #605-T12). Its record stays `open` and nothing reads it again.

**Old holds (legacy), and the machinery of #591 (`stranded-holds.ts`).** Billing was never enabled in production, so no `reservation` should exist; an instance that switched
billing on with an earlier release may have some, and nothing may break there. So the old code is **kept, not removed**: `settleEndedJobs` settles a job that holds a
`reservation` through it exactly as before (a `release` of the hold, then the `usage`, or the `release` alone when the run is free; #605-T14), the journal keeps `reserve`,
`settle` and `release`, and the entry types, `billing_balances.reserved_micro_usd` and `verify()` (which still flags a stranded hold) stay. Removing them would need a data
migration that turns each open reservation into a release, for a table that has no rows in production; keeping them costs one read (`findByKey("reservation", ...)`) per settled
job and, per sweep, the finder below, which finds nothing on an instance with no hold and reads only the partial index of balances that hold something. The rest of this
paragraph is the behaviour of #591 for those old rows.

A run that ended while billing was off, with a hold, is **released, not charged**: billing off means no charge. `releaseStrandedHolds(db, now)` finds the `reservation` entries of **jobs that
have ended, have no `release` and whose usage record is no longer `reserved`** (`findStrandedHolds`) and gives each hold back with
the journal's `release`: one `release` entry, no `usage`, so the balance is whole again and `reserved` falls by the hold. A job that is
still running, queued again after a lost attempt, or already settled is never touched, and neither is a **superseded run that still drains**:
its job is `superseded` at once, but its usage record stays `reserved` until its Worker reports or the drain window and the grace run out, and
that settlement (a `release` and the `usage` of what the run used) is still to come; releasing it earlier would lose the charge. Every job that
ends closes its record in the transaction that ends it, so "the record is no longer `reserved`" means that nothing is left to settle the
hold. The finder works in two steps so that the work grows with the holds that are open and not with the journal: (1) the workspaces whose
`reserved_micro_usd` is more than the holds that belong to a `reserved` record explain (the partial index of the reserved records, the unique key
of the journal, and the partial index `billing_balances_reserved` of the balances that hold something), which is none in steady state;
(2) only for those workspaces, their open reservations of ended jobs. It runs in two places:

- **When billing is switched on**, in the transaction that writes `enabled` (`admin-service.ts`, under `lockBillingSettings`): a refused switch-on releases nothing (the
  transaction does not commit).
- **In the sweep while billing is on**: the step `billing_holds` of the cron sweep of a hosted deployment, and the hourly timer of a server
  (`maintenance/startup.ts`), through `releaseStrandedHoldsWhileBillingOn`, which reads only the switch while billing is off.

Both are idempotent and safe next to settlement: every release goes through the journal's `release`, which takes the lock of the workspace's balance row first and writes under the
key of the job. At most 500 holds a run (`STRANDED_HOLDS_BATCH`). **Lock order.** The balance row of a workspace is locked at the first write of its job and held until the
transaction ends, so the switch-on (up to 500 holds, in the order workspace, then job) and `settleEndedJobs` (the jobs of one transaction, in the same order: workspace, then job)
lock the workspaces in one global order, and two such transactions cannot each wait for a row the other holds. The log line is `[billing] BILLING_HOLDS_RELEASED count=<n>`.
**`verify()`** counts the stranded holds of the workspace (`strandedHoldCount`, `strandedHoldMicroUsd`) and is not `consistent` while there is one.

**Follow-up (#608).** `reserveFor`, `hold.ts` (and `dispatcher/src/billing-hold-pin.test.ts` that pins it) and the Diff AI reserve rate (`diffAiReserveMicroUsd`, required to switch
billing on) are dead at run time. Dropping them touches the admin form, the stored setting and the end to end test of the billing page, so it is a separate change. Two more notes from
that issue: a job claimed with billing on and ended while billing is off keeps `billing_state = 'open'` for good (it is never charged), and during a rolling deploy a job claimed by new code
and ended by old code stays `open` and is never charged (this matters only if billing is on during the deploy).

**Late minutes (`late-minutes.ts`).** A job settles with the best end of its VM known when it ends (the confirmed stop, else the bounded backstop).
When the answer to the App's stop call arrives later (`dispatch/stop.ts`, after `confirmStopped`), within a day of the settlement, and the started
minutes differ by more than one, **one** `correction` (key `late-minutes:<job id>`) moves the difference at the rate the run was charged at;
otherwise the settlement stands. A stop that answers late is our error (#493), so the correction **never charges beyond the backstop** (the job's
end plus 60 seconds, bounded by the VM's timeout, `lateMinutesTarget`): a measure above it counts as the backstop, and a measure below the settlement
credits the customer (#498-T14, T24). A job that was never charged has nothing to correct.

**Hosted jobs never measure zero minutes silently** (the gate of the review of #524, B-1). `settleEndedJobs` asks `measure`; a charged run with
a claim and no VM row of it falls back to its claim wall clock: `claim_wall_clock` when a Dispatcher acknowledged the job (a VM was started and its
report was lost, or the Dispatcher is of an earlier release), `job_wall_clock` for a runner with no VM. A stop
answer that names a VM of our own naming for the job (`cr-<kind>-<job id>-...`) that has no row creates it (`app_stop_unreported`, from the claim to
the stop, at most the longest a VM lives); a better end (a VM's own) wins over a wall clock in `measure`. A claim keeps at most four VMs (N-1). A late
`/vm` report for a claim that already ended stays refused (customer-friendly). The Dispatcher names `vm_lifecycle` in its claim and the app notes when
it last saw a Dispatcher with and without it (`dispatcher-features.ts`, the instance setting `dispatcher_sightings`, at most once an hour per kind);
`canSwitchBillingOnWithDispatcher` refuses with `dispatcher_lacks_vm_lifecycle` while one without it has claimed within a day; the switch-on of the
admin page asks it inside the same `lockBillingSettings` transaction that writes `enabled`, next to the readiness of the adapter, and names the item in
`missing` (#498-T19).

## Limits at claim (#499)

Three things in ADR 0006, 2.9 are decided where a job is claimed and nowhere else: the customer's optional **monthly total limit**, the operator's hidden
**hourly abuse brake**, and the **absence of the per-period run quotas** while billing is on. The own-key cost limit (`ownKeyCostLimitMicroUsd`, #361) is untouched.
All of it acts **at the claim only**: a run that started is never stopped by a limit, so no review is ever cut short for money, and the cost guard of Dynamic
Review with its final-call exemption is not involved. With billing off none of it runs (`checkClaimCaps` is not even called; `decideAdmission` keeps the
quotas), and nothing about an instance without billing changes.

**Order of the checks at the claim**, inside the claim transaction, the first refusal wins: the entitlements (unreadable, suspended, the own-key and managed
cost limits as today; the run quotas only while billing is off), then **the brake**, then **the monthly limit**, then the start credit and the balance (#498, #507).
A refusal is free like every refusal at the claim: the job fails with a stable code, no attempt is counted, no usage record and no journal entry exists,
and `onRefused` hears of it for the pull request notice.

| Check               | Set by                                                                                          | Default                   | Counts                                                                                                                                                                                                                                                     | Code                    | Notice                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------- |
| Hourly brake        | the instance admin (`billing_settings.hourlyReviewLimit`, #504; 1 to 100,000, 0 is not allowed) | 60                        | the usage records the workspace started after "now minus 60 minutes" (`reserved_at`, every state: a review that was cancelled or replaced did start; the job that asks is left out, so one claimed again after a lost lease is not counted against itself) | `reviews_paused`        | yes: "Reviews are paused for this workspace for a while." |
| Monthly total limit | the customer (Owner, Admin; `billing_workspace_settings.monthly_limit_micro_usd`)               | none (`null`)             | the `usage` entries of the journal (AI plus infrastructure) since the first moment of the **UTC calendar month**, once they have reached the limit (nothing is held at the claim)                                                                          | `monthly_limit_reached` | yes                                                       |
| Plan run quotas     | the operator, in entitlements                                                                   | enforced with billing off | not enforced while billing is on                                                                                                                                                                                                                           | -                       | -                                                         |

- **The brake is hidden.** Nothing a customer can read names its number, its window or that anything is counted. The refused job is stored with the neutral code
  `reviews_paused` (not a name that carries the window) and `describeErrorCode` (`UNSHOWN_ERROR_CODES`) never hands that code out, so the check run says only
  "Reviews are paused for this workspace for a while, so this run did not start ..." with no "(`code`)", and the Runs page shows the sentence with no "Error code" line (also in
  every answer built on the run view). The notice ("Reviews are paused for this workspace for a while. Please try again later.") points to no page, because nobody in
  the workspace can lift it. What the **operator** can see: the server log line every refusal at the claim writes, `[queue] job=<id> workspace=<id> refused at claim: reviews_paused`
  (ids and the neutral code; no number, no window), and the admin runs list, which shows the stored code. The only other line the evaluation writes, `CLAIM_CAPS_FAILED`, holds the workspace
  id and the kind of error. The admin sets the number on the billing page of the admin portal (#504). Two claims of one workspace never both take the last start: the claim runs
  under the gate lock of the queue, and the record of a started review is written in the same transaction.
- **The monthly limit.** `charged >= limit` refuses (maintainer decision on #499, which replaced the first rule `charged + hold > limit` and a later hard cap): the claim
  is refused `monthly_limit_reached` only when this UTC month's **actual charges** have already reached the limit; below it the job starts. `charged` is the sum of `usage`
  entries by the time the run **settled** (`created_at`), from the start of the UTC month (`utcMonthStart`); the sum starts again at 00:00:00.000 UTC of the first day. Nothing is held at the claim (#605),
  so a job whose own cost would take the month above the limit still starts when the charges are below it, and the month can pass the limit by what the reviews in flight and that job end up costing. It acts at the claim only: a review that runs
  is never cut short. The balance check ("Start" above) is a separate matter and unchanged here. A limit of one workspace never counts another's charges. The notice says that the monthly
  spending limit of the workspace was reached and that an Owner or Admin can change it (with a link to the workspace settings when the instance has one); it names no amount.
- **Setting it.** `GET` and `PUT /api/w/:workspace/billing/monthly-limit` (`monthly-limit-http.ts`): billing off is the 404 of a path that does not exist; then the
  same-site check, the session and the role (`manage_billing`: an Owner or an Admin; a Member gets 403 and nothing is stored or logged), a JSON body of at most 1 KiB
  `{ "monthlyLimitCents": 12345 }` (whole US cents between 100 and 100,000,000; `null` clears the limit). Codes: `limit_invalid` (not a whole number or missing),
  `limit_out_of_range`, plus the usual `cross_site_request`, `unsupported_content_type`, `body_too_large`, `invalid_input` and `forbidden`. The workspace is the one of the address. Every change
  leaves an audit line `[billing] MONTHLY_LIMIT_CHANGED workspace=<id> user=<id> action=set limit_cents=<n>` (or `action=cleared`), and the row keeps who and when (`updated_by`,
  `updated_at`). The form is on the workspace billing page (#505).
- **Robustness.** `checkClaimCaps` runs in a savepoint (the pattern of the start credit). Anything that goes wrong in it is rolled back to the savepoint, logged as
  `CLAIM_CAPS_FAILED workspace=<id> error=<kind> retry=<yes|no>`, and never thrown out of the claim. On Postgres the savepoint is what keeps a failed statement from poisoning the claim
  transaction. What happens to the job depends on the kind of error (`isTransientDatabaseError`, `db/errors.ts`, by the SQLSTATE, never by the message):
  - **Deterministic** (a table or column that cannot be read, a stored value that is no positive whole number: asking again gives the same answer): the stable refusal
    `billing_limits_unreadable` for that job: closed, never open, so the queue goes on with the next job.
  - **Transient** (a serialization failure or deadlock, a lock that could not be taken, a statement timeout, too many connections, a failed connection):
    no verdict on the job. The claim gives it back with the queue's own rule for a lost attempt (`loseAttempt`): it is `queued` again with `run_after` at now plus
    `CLAIM_CAPS_RETRY_MS` (15 seconds) and one attempt counted, so it is not due in the next pass (no hot loop; the queue head is not blocked, the next runner poll takes the
    next job) and, after `maxAttempts` (3) such tries, it ends `billing_limits_unreadable` like any lost lease. Until then no refusal, no notice, no usage record and no entry
    exist. The pass ends at once (the claim answers "nothing", the runner asks again): a database in trouble is not asked again inside the transaction that holds the gate lock.
    Trade-off: while the database fails for a workspace, its jobs are tried one per pass and each uses one of its three attempts.
- **Run quotas.** `decideAdmission` takes `{ runQuotas: false }` while billing is on (`billing.state === "on"`; a switch that is set but whose adapter is not ready is not on, and
  keeps the quotas as the claim refuses everything then anyway). The suspension, unreadable entitlements and the cost limits are unchanged. The plan and usage page shows no run rows then
  (`PlanView.runs` is `null`, `src/usage/README.md`). The operator API's limits are not touched (ADR 0006, section 6, no. 3 is open).
- **Indexes.** `usage_records_workspace_reserved_at (workspace_id, reserved_at)` for the brake (the earlier `(workspace_id, review_kind, reserved_at)` cannot serve a range on `reserved_at`
  without the kind) and `billing_journal_entries_type_created (workspace_id, type, created_at)` for the monthly sum (migration `20261021210200_add_limit_query_indexes`; the second one also carries `amount_micro_usd` (`INCLUDE (amount_micro_usd)` on Postgres, a last key column on SQLite, which has no INCLUDE), so the month sum is read from the index alone). The settings table
  is `billing_workspace_settings` (`20261021210100_create_billing_workspace_settings`); the widened check of the notice codes is `20261021210000_widen_refusal_notice_codes_for_limits`.

## Key mode (#496)

Two modes share one balance (ADR 0006, P3, D4). **Our models** (`managed`) use the operator's key and are charged AI plus infrastructure.
**The workspace's own key** (`own`) is charged infrastructure only. The details are in `src/llm/README.md`, "The key mode a workspace chooses
while billing is on"; this is what billing needs from it.

- **While billing is on** the key mode is the workspace's own choice (`llm_key_mode` in its settings; `GET` and `PUT /api/w/:workspace/llm-key-mode`
  for an Owner and an Admin, the page Settings, LLM access). A workspace that has not chosen is on `managed`. The `keyMode` of an entitlements row or of the
  instance default is **not consulted** then; suspension, `modelAccess` and the cost limits still are. With billing off the entitlements decide as before.
- **The claim and the price read the same answer.** `keyModeAtClaim` (`claim-key-mode.ts`) takes the key mode of the effective entitlements, so the claim's
  balance check, the key the job is given and the key mode recorded in the usage record cannot differ. The mode is read at the claim and recorded in the
  usage record; settlement reads the record, so a change never touches a review that runs.
- **What it changes in the price.** `own` has no AI price whatever the cost (`priceRun`), and a job that cannot cost anything (own key and `B` of zero for its
  kind) may start at a balance of exactly zero (`canCostAnything`).
- **Own without a key** still ends `llm_not_configured` (reason `no_key`); it never falls back to our key. The route does not let a workspace choose `own`
  before it has stored a key (`own_key_missing`). There is no plan that gates the own key.
- **When billing is switched on** every existing workspace starts on `managed`, whatever its entitlements said. The enabling statement on the admin page says so and
  counts the workspaces that hold a stored own key (`enabling-copy.ts`).

## The switch

Billing is **on** when the instance setting `billing_settings.enabled` is exactly `true` **and the active adapter is ready**
(`isBillingOn`, `readiness.ts`; #504). Ready means, for every adapter, that A, both B and the Diff AI reserve are set, and for
`stripe` also that the API key and the webhook secret are stored, a connection check passed and the link to the operator's terms is set
(`terms_url_missing`, #626). The passing check is a record in
the setting (`stripe.checkedAt`, with the environment of the key): the switch reader may not call Stripe, so the admin page makes
the check and the setting remembers it. A new API key clears the record; a check that fails never does, so a click during a
Stripe outage cannot turn billing off. The switch reader looks for the two Stripe secrets by name in the secret table and does not
decrypt them: whether they can be read is judged when they are saved, at the connection check and on the page ("cannot be
read"). It calls nobody. **There is exactly one reader of the switch**; a test (`src/ci/billing-cleanup.test.ts`) fails when a
second one appears. Every billing route, page and sweep step asks `isBillingOn` first: while it is false they are inert, a route
answers the 404 of a path that does not exist (`guardBillingRoute`, Next.js's own `notFound()`), no billing table is read and
nobody is called.

**Switch set, adapter not ready (and incomplete rates).** `readBillingSwitch(db)` answers `{ enabled, missing, rates }` from one
read: `isBillingOn` is `enabled && missing.length === 0`. The state "set, but not ready" (a rate or a credential that is gone
since the switch was set, which the admin page does not allow but a damaged database can show) is **off for `isBillingOn`**, so
a route is inert; the claim of a job (#498, `readClaimBilling`) tells it from off and refuses the job with the stable code
`billing_rates_incomplete` (the closest existing code: a new job error code would widen the check of the jobs table and the
refusal notices for a state the operator has to repair; the Runs page says so), so reviews do not run free and no hold is taken
while `isBillingOn` is false (`jobs/claim-billing.integration.test.ts`, #498-T15 and #498-T18). **It is never silent (#632):** the
refusal refuses every review of the instance, so the pull request gets a notice per head (`src/refusal-notices/README.md`, "An
incomplete billing setup"), the check run of the job is completed at once with the reason (`notifyingRunnerQueue.onRefused`), and
every page of the admin portal shows a banner with the missing items (`incompleteBillingItems`, `readIncompleteBilling`,
`admin/ui/billing-incomplete-banner.tsx`). The Billing page shows "the switch is on, but billing is not running" with the list.
A Stripe setup switched on before #626 made the terms link required is in this state after the update: the link is not
filled in for the operator (no legal value is made up); the admin adds it on the Billing page, which is allowed while billing
is on (`enabled.integration.test.ts`, #632-T01). To keep the state from arising, the switch-on in `admin-service.ts` judges `missingItemsOf` (the
rates) and `canSwitchBillingOnWithDispatcher` (a Dispatcher that does not report `vm_lifecycle` and claimed within a day,
`dispatcher_lacks_vm_lifecycle`) inside the same `lockBillingSettings` transaction that writes `enabled`
(`admin-billing.integration.test.ts`, #498-T19). Text in `billing_settings` that is no JSON reads as not set, on the claim
path too (#498-T23).

There is no environment variable: billing is configured in the admin portal and in nothing else, so `.env.example` and
the deployment files stay as they are (`no-environment-variable.test.ts`).

The credentials of Stripe are the encrypted, write-only secrets `stripe_api_key` and `stripe_webhook_secret` of the secret
store (`src/secrets/`, ADR 0006 2.14). A row of a removed secret name that an old database still holds is not read, not listed
and not an error.

## The billing page

`/admin/billing` (data routes below `/api/admin/billing`; `src/admin/README.md` has the guards), instance admin only. Opening it
changes nothing and calls nobody; an admin who never opens it sees no change, no new route that answers and no outbound call.

- **The switch.** `PUT { "enabled": true }` reads everything again, the stored credentials too, in one transaction under
  `lockBillingSettings` (`settings-store.ts`; the service gets the secret store on that transaction, `secretsOn`) and writes the
  switch only if `missingItemsOf` is empty. Saving or removing a credential and replacing the endpoint change the secret in the
  transaction of the settings, so a removal cannot slip in between the check and the write of the switch; otherwise it is refused with `billing_not_ready`
  and `missing`, every missing item by its code (`factor_a_missing`, `minute_rate_diff_missing`, `minute_rate_dynamic_missing`,
  `diff_ai_reserve_missing`, `stripe_api_key_missing`, `stripe_webhook_secret_missing`, `connection_check_missing`,
  `terms_url_missing`, `connection_check_failed`). With Stripe the connection check is made once more just before, so a key that was revoked since the
  last click is found now. Switching off is always allowed and writes nothing else: rates, credentials, journal and balances stay.
- **The enabling statement** (`enabling-copy.ts`) says what switching on does: the reviews of every workspace are charged from a
  prepaid balance, workspaces choose their key mode (our models are the default), a workspace with no balance cannot start a
  review until it has the start credit or credit, the run quotas are not applied and the operator API limits stay, with the
  number of workspaces and of those that hold a stored own key (`db/repositories/own-key-count-repository.ts`).
- **The adapter** is `manual` or `stripe` (`PUT { "adapter" }`); it stays while billing is on (`billing_disable_first`).
- **The Stripe credentials** (`PUT { "stripe": { "apiKey", "webhookSecret" } }`, an empty field keeps the stored one) are
  write-only: the answers carry `configured`, `unreadable` or `not_configured` and the last four characters of a long value. The
  key must start with `sk_test_`, `rk_test_`, `sk_live_` or `rk_live_`; its environment is read from the prefix and shown. A
  credential is not removed while billing is on, and a new key must pass a check before it replaces the one that works. A key of
  the other environment is refused while billing is on (`billing_disable_first`: it would take the webhook secret and the
  endpoint with it and turn billing off without a word); with billing off it takes the stored webhook secret and endpoint id with it.
- **The connection check** (`POST /check`) reads the account (`GET /v1/account`) and answers `{ ok, environment }` or a stable
  code (`stripe_key_rejected`, `stripe_rate_limited`, `stripe_unreachable`, `stripe_unavailable`, `api_key_missing`,
  `api_key_unreadable`). A pass is recorded.
- **The webhook endpoint** (`POST /webhook-endpoint`) registers the public address of this app (`BETTER_AUTH_URL`, never a
  request header) plus `/api/billing/webhook` with the events in `stripe-webhook-events.ts` and stores the returned secret. The
  address must pass `isPublicHttpsUrl` or nothing is called (`webhook_url_not_public`). One creation runs at a time (a lease of
  60 seconds in the setting `billing_destination_lock`: `webhook_endpoint_in_progress`), Stripe is asked first and an endpoint of
  our address that exists is **adopted**, not duplicated, when it is enabled at Stripe, is told about every event of
  `stripe-webhook-events.ts` (or `*`: otherwise `webhook_endpoint_unusable`) and its secret is stored. Stripe shows an endpoint's secret only in the
  answer to the create, so an endpoint of ours without a stored secret answers `webhook_endpoint_secret_unknown` (enter the
  secret, or `{ "recreate": true }` with billing off, which deletes ours and creates a new one). An endpoint whose `livemode` is
  not the key's environment is refused (`webhook_environment_mismatch`) and removed again; a secret that cannot be stored removes
  the endpoint too (`webhook_secret_not_stored`), because the secret cannot be fetched later.
- **Rates and numbers** (`PUT { "rates" }`): A, B for Diff and Dynamic, the Diff AI reserve, the start credit, the low-balance
  threshold and the hourly brake, with the codes of `rates.ts`. The API takes the stored whole numbers (A in parts per 10,000,
  money in micro-USD); the page shows and takes decimals (`src/admin/ui/billing-money.ts`: no float touches an amount). A, both B
  and the reserve have no default; the start credit is 2 USD, the threshold 5 USD and the brake 60 reviews per rolling hour until
  they are set (ADR 0006 D3, D9, D10; `billingNumbersOf`). The numbers are read by the start credit grant (#507), the notifications (#506)
  and the brake (#499). They can be changed at any time, also while billing is on.
- **Terms and privacy links** (`PUT { "legal": { "termsUrl"?, "privacyUrl"? } }`, #626; `legal-urls.ts`). Stored as
  `billing_settings.legal`. A link is an `https` address of a public host (`isPublicHttpsUrl`: no credentials, no loopback, private or
  local name), at most 2,048 characters, with no space or control character inside (`validateLegalUrl`; the URL parser drops tabs
  and line breaks silently, so the text that was checked would not be the text that is stored). A field that is left out stays, an
  empty text or `null` removes the link, and one invalid link refuses the whole change and writes nothing
  (`invalid_input` with `issues: [{ field: "legal.termsUrl", code: "url_invalid" }]`). The stored value is read again with the same
  check (`readLegalUrls`), so a link written by another path reads as not set. The terms link is **required for Stripe**
  (`terms_url_missing`, the switch-on and `isBillingOn`), optional for the manual adapter, and with Stripe on it cannot be removed
  (`billing_disable_first`; it can be changed); the privacy link is always optional. Both can be changed while billing is on. The
  workspace billing page reads them while billing is on (`loadWorkspaceBillingPage`, the page file passes them as `termsHref` and
  `privacyHref`) and the business confirmation of the first top-up links to both, in a new tab (`rel="noopener noreferrer"`).
  Billing off: nothing reads them.
- **Journal check** (`journalCheck` of the answer, #626): the result of the last finished pass of the scheduled check (see "The
  scheduled journal check"), shown as "Journal check: ok / inconsistent (date)". Reading it is one instance setting.
- **Manual credit and correction** (`GET /workspaces?q=`, `GET /workspaces/<id>`, `POST /workspaces/<id>/credit`
  `{ type: "credit" | "correction", amountMicroUsd, note, requestId }`; the request id is required, `request_id_required`, so a retry is one entry): the admin searches a workspace by name, sees its balance
  and its ten newest entries, and writes a `top_up` (credit) or a signed `correction` through `createManualCreditService` with
  their user id as the actor and the required note. It works with either adapter and while billing is off.

## The balance journal

One USD balance per workspace (ADR 0006, 2.7; #495), kept in **micro-USD integers**, never a float, as the sum of an
append-only journal. The repository is `src/db/repositories/billing-journal-repository.ts`, created for one workspace; the
tables and their triggers are described in `src/db/README.md` ("Billing journal and balances"). The job lifecycle writes to it
while billing is on (a charge when a job ends, no hold at claim since #605: "Start, settle" above), and payment events credit and debit it
through `applyBillingEvent` (below).

| Type           | Sign | Meaning                                                                                                                                         |
| -------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `top_up`       | +    | A payment arrived (net amount); the key is the payment intent id.                                                                               |
| `start_credit` | +    | The grant for a new workspace.                                                                                                                  |
| `reservation`  | -    | An old hold taken at claim (before #605); the key is the job id. Only `reserve` writes one.                                                     |
| `usage`        | -    | The charge of a finished run, `ai_micro_usd` + `infra_micro_usd`; the key is the job id. Written by `charge` (and by `settle` for an old hold). |
| `release`      | +    | The whole old hold given back at settlement or when a job is voided.                                                                            |
| `refund`       | -    | A payment was refunded; the key is the refund id.                                                                                               |
| `chargeback`   | -    | A dispute was lost; the key is the dispute id.                                                                                                  |
| `correction`   | +/-  | A manual correction, or the reversal of an entry (`reverses_entry_id`).                                                                         |

- **Repository.** `append(entry)` for every type but the three of a job's hold (`reservation_required` for a reservation,
  `job_entry_required` for a `release` or a `usage`: only `reserve`, `release()`, `settle()` and `charge()` write those); `charge(jobId, charge)` (#605: the price of a finished job as
  one `usage` entry, no hold behind it; takes the balance row's lock, may take the balance below zero, idempotent on the job; a charge of zero is `invalid_entry`, the caller
  writes nothing for a run that costs nothing); and, for the holds of an earlier release, `reserve(hold, jobId)`, `settle(jobId, charge)` (a `release` of the hold and a `usage`
  of the charge, in one transaction; a charge of zero writes only the release; `created` is true when this call wrote the usage, the release when there is none) and
  `release(jobId)` (a job that never ran); `balance()`; `entries({ cursor, limit })` (newest first,
  by `seq`, cursor `{ seq }`; the caller clamps `limit`); `verify()`.
- **Idempotent.** The key is `(workspace, type, ref_key)`: the job id for a job's entries, the provider reference for
  money from outside. The same key with the same amount returns the entry that exists (`created: false`) and changes
  nothing; with another amount it is an `idempotency_conflict`. A `usage` is also its parts, its minutes and its kind: a
  settlement repeated with the same total but other numbers is an `idempotency_conflict` too. A reversal happens once (`already_reversed`), names an
  entry of the workspace with the opposite amount, and is never of a reservation or a release.
- **Atomic and race free on both engines.** An entry and the balance change in one transaction (the caller's, when it
  hands in a transaction). `reserve` is the conditional write of an old hold: it holds at most the balance, so 20 claims of 3
  against 10 grant exactly 3, on Postgres (one pool, two pools). `charge` is unconditional and
  atomic: the same job charged at the same moment writes one entry, and many jobs charged at once leave the exact sum, also below zero (#605-T21).
  `settle` and `release` take the lock of the balance row before they read what a job has, so a release and a settlement
  of one job are decided one after the other: a job whose release committed first, or commits at the same moment, is
  never charged (`job_already_released`). `append` takes the same lock before it writes, so **every writer is "balance row
  first"** and none can wait for another's row (a test holds the lock and appends the same key from both sides).
- **The hold of a job (#498), retired by #605.** No claim takes a hold any more, and `reserveUpTo`, which took `min(hold, balance)`, is gone. For the reservations an
  earlier release wrote, the contract stays: a hold lives from the job's first claim to the job's end, a requeue keeps it, a release happens only when the job ends free
  (`release(jobId)`) and a charged end is `settle`. Keys are per job (`reservation`, `release` and `usage` all use the job id), so a job's hold is taken once, ever, and a
  `reserve` for a job whose hold was released answers **`reservation_released`** (`ok: false`), not the old reservation.
- **A negative balance blocks.** A refund, a chargeback or a final charge may take the balance below zero; every claim is then refused with
  `balance_negative` (and every `reserve`), whatever the amount. A balance that is positive but below an old hold is refused by `reserve` with `insufficient_balance`. All
  come back as the answer (`ok: false`), never as an exception. Credit lifts the block; it never expires.
- **Stable codes** (`BILLING_JOURNAL_ERROR_CODES`): thrown for a caller's bug or a replay with other numbers
  (`invalid_entry`, `idempotency_conflict`, `already_reversed`, `reversed_entry_not_found`, `reservation_required`,
  `job_entry_required`), answered by `reserve`, `settle` and `release` (`insufficient_balance`,
  `balance_negative`, `reservation_released`, `reservation_not_found`, `job_already_released`).
- **`verify()`** returns the cache and the sum of the journal side by side with the difference of each (cache minus sum), the holds of
  jobs that ended with nothing left to settle them and without a release (`strandedHoldCount`, `strandedHoldMicroUsd`, #591; a superseded run
  that still drains is not one) and `consistent` (both differences zero and no stranded hold), read in one statement (one snapshot), so traffic that commits meanwhile never shows as drift. The scheduled
  check that runs it for every workspace is described in "The scheduled journal check (#626)".
- **Order.** Every entry has a `seq`, the order it was written in (a Postgres identity). `entries()`
  lists by it, so a `release` and its `usage`, written in one millisecond, keep their order. On Postgres a transaction
  that commits late can land below a `seq` a reader has passed; a cursor reader sees it on its next fresh read.

## The adapter seam

Money arrives through an **adapter**, never through code that knows a provider (ADR 0006, 2.12; #497). An adapter
performs actions at its provider and returns **normalized events**; it **never touches the journal**. A generic layer
applies the events. The first real adapter is Stripe Managed Payments (#500 to #502); `manual` needs no provider.

```ts
interface BillingAdapter {
  readonly id: string; // lower case letters, digits, _ and -; the key of the registry
  readonly capabilities: BillingCapabilities;
  ensureCustomer(i: {
    workspace;
    profile;
    customer: ProviderRef | null; // the id the app stored from an earlier call
  }): Promise<ProviderRef | null>; // null: the provider has no such object
  createTopUpCheckout(i): Promise<{
    checkout: { kind: "redirect"; url } | { kind: "none" };
    session: ProviderRef | null;
    payment: ProviderRef | null;
  }>;
  verifyAndParseWebhook?(i: {
    headers;
    rawBody: Uint8Array;
    now;
  }): Promise<WebhookResult>; // absent: no webhook
  lookupTopUp?(i: {
    intentId;
    checkout;
    payment;
  }): Promise<TopUpLookupEvent | null>; // absent: cannot be asked
}
```

- **Refunds are an event only.** There is no `refund` method and no auto-recharge capability. The operator refunds in the
  provider's dashboard and the webhook books it.
- **Capabilities** (`merchantOfRecord`, `customAmount`, `partialRefund`, `minTopUp`, `maxTopUp`, `currencies`,
  `providerMayRefund`, `checkout`, `requiresBillingProfile`, `receiptsFrom`) drive the UI, so a page never names a provider. The
  code constants are the currency USD and the top-up range **10 to 500 USD**; an adapter may **narrow** the range and
  never widen it (`assertValidCapabilities` fails the registry at startup; `assertTopUpAmount` checks an amount before a
  checkout is created).
- **Money is `Usd`**: a whole number of micro-USD, a branded type (`toUsd(n)` is the way in), so cents or another
  currency cannot be mixed in by accident. A refund's or dispute's `amount` is NOT `Usd`: it is a `ProviderAmount`, see
  below. `ProviderRef` is an opaque id (`isProviderRef`: letters, digits and
  `_ . : -`, at most 255): no card, address, tax id or email is ever stored or carried.
- **The events.** `payment.succeeded` (`creditable` is the net amount that becomes credit; `gross`; `tax`, where `0` is a
  real tax and `null` is "not said"; `providerAmount`, what the buyer was charged in the provider's unit, which the application
  pins on the intent, with `providerCurrency`, its lower case ISO 4217 code), `payment.failed`, `payment.expired` (the checkout ended unpaid: the only way an
  intent becomes `expired`), `payment.refused` (#502: the adapter read a paid payment that contradicts what we asked for, such as
  another currency or the other environment; nothing is credited, it is recorded `amount_rejected` for review), `refund.updated` (`status` `pending`/`approved`/`rejected`/`reversed`, `initiatedBy`, and the `currency` of its amount),
  `dispute.updated` (`opened`/`lost`/`won`, with the dispute id and the `currency` of its amount) and `ignored` (a verified event of a type the adapter
  does not use). `validateBillingEvent` refuses an event with a non-integer amount, an id that is not an opaque id, a
  time that is not ISO 8601 or an unknown status, so nothing past it trusts a provider's number.
- **Payments are net, refunds and disputes are gross.** A payment carries OUR amounts (`creditable`, net of tax, in
  micro-USD). A refund or dispute carries the PROVIDER's: `amount` of this refund or dispute and `paymentAmount` of the
  whole payment, both gross, in the SAME unit (cents in the buyer's currency, say; the unit never matters), because the
  provider says nothing of the tax split of a refund. The application computes the net share under the intent lock:
  `floor(credited x amount / paymentAmount)` in whole numbers (`net-share.ts`). The whole payment takes exactly what it
  credited (a full refund of 29.75 on a 25.00 credit debits 25.00), and rounding down means the shares of one payment
  never add up to more than its credit.
- **One refund per event.** A delivery carries one event. A provider delivery that lists several refunds (Stripe's
  `charge.refunded`) is not mapped; the adapter maps the per-refund events instead (`refund.created`, `refund.updated`,
  `refund.failed`), each under its own event id and refund id. An adapter must not read a cumulative amount (Stripe's
  `amount_refunded` of a charge) as the amount of one refund; the caps below stop the damage, not the mistake.
- **Disputes** map to three statuses (the Stripe adapter of #502 uses these words): `opened` is `charge.dispute.created`
  or `funds_withdrawn` (the provider takes the money when a dispute opens); `lost` is `charge.dispute.closed` with the
  status `lost`; `won` is `charge.dispute.closed` with `won` or `charge_refunded`, or `funds_reinstated` (the money comes
  back; a refund, if any, is its own event). Early warnings (`warning_*`) and a dispute still under review move no money:
  the event is `ignored`.
- **Asking the provider.** `lookupTopUp` returns what became of a top-up as a `payment.succeeded`, `payment.failed` or
  `payment.expired` event, or `null` (unknown yet, or the object is gone). It is the one outbound call of an adapter,
  made in a user's request (#502's "Check payment"), never in the webhook; its event goes through `applyBillingEvent`,
  so a lost webhook, a late one and a click are idempotent together.
- **`WebhookResult`** is `{ ok: true, event }` or `{ ok: false, code }` with a code of
  `BILLING_WEBHOOK_REJECTION_CODES` (`signature_missing`, `signature_invalid`, `signature_expired`, `body_invalid`) and
  nothing else: no body, no header, no secret. An adapter gets the body as the bytes that were received (`Uint8Array`,
  never decoded text: a byte order mark or a byte that is not UTF-8 would change what a signature covers), checks the
  signature over them before it reads the body, decodes it itself, makes no outbound call and touches no database.

**How to add an adapter.** Implement `BillingAdapter`, add it to `getBillingAdapterRegistry()` in `shared.ts`, and run the
shared kit on it: `describeAdapterContract` (parses its fixtures into the normalized events, refuses bad signatures with a
code, no outbound call, and `lookupTopUp` when it has one) and, when it has a webhook, `describeAdapterApplication` (applies what it parsed on every
engine; the same event twice, the same payment under another event id and the wrong order leave the state of one correct
delivery). Both live in `src/test-support/billing-adapter-kit.ts`; the fake adapter in `fake-billing-adapter.ts` is the
model, and `adapter-kit.test.ts` / `adapter-kit.integration.test.ts` show the call. The active adapter is the `adapter`
field of the instance setting `billing_settings` (`manual` when it is not set or not an adapter id); the admin page sets it
(#504). The Stripe adapter is in the registry (#501) and has its webhook and its lookup since #502 ("Stripe webhooks", below). Errors of an adapter are `BillingAdapterError`s with a stable code (`provider_unavailable` for a timeout,
a 5xx or a rate limit, `provider_rejected`, `provider_not_configured` for a key Stripe does not accept, `vat_id_rejected`,
`customer_missing`) and never carry a word of what the provider said.

## The billing profile, the Stripe adapter and the top-up (#501)

**What is kept.** Managed Payments allows neither `tax_id_collection` nor `customer_update[name|address]`, so the app keeps
the buyer's **billing profile** itself (`billing_profiles`, one row per workspace, repository
`billing-profiles-repository.ts`, workspace-scoped): legal name, address (country, two lines, postal code, city), an optional
VAT ID, the business confirmation (`confirmed_at`, `confirmed_by`, `terms_version`) and the id of the provider's customer made
from it (`customer_adapter`, `customer_ref`, an opaque id). It is customer data: only an Owner and an Admin
(`manage_billing`) read or write it through `profile-service.ts`, a Member gets `forbidden` and nothing, it is never logged,
and it is sent to the payment provider and nowhere else (a test scans every table and the logs for it). `profile.ts`
validates what was typed and answers a **field and a code** (`required`, `too_long`, `invalid_characters`,
`country_unknown`, `vat_id_invalid`, `vat_country_unsupported`), never the value. Control, line and paragraph separators and
format characters (a right-to-left override, a zero-width space, a byte order mark) are `invalid_characters`: the text is
printed on an invoice. The VAT ID check is **light**: the shape
of the country's number (the EU, Great Britain, Norway, Switzerland; Greece is `EL`); it is never a claim that the number is
valid, and a country without a shape takes no VAT ID. The business confirmation text is bumped by `BILLING_TERMS_VERSION`.

**What is sent to Stripe, and why.**

| When                  | What                                                                                                                                                                                                                                                                                                                                                                  | Why                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ensureCustomer`      | A Customer with `name` and `business_name` (the legal name), `address`, `preferred_locales` (`en`: the UI is English), `metadata[workspace]` (an opaque id), and the VAT ID as a **tax id** (`eu_vat`, `gb_vat`, `ch_vat`; `no_vat` without the `NO` prefix, which Stripe refuses)                                                                                    | The invoice of Managed Payments is made from the Customer, and the Checkout cannot ask for it. Created once (the Idempotency-Key is the workspace and the exact content, the id is stored); the next top-up updates the same Customer, replaces a changed VAT ID, removes one that was cleared, and makes a new Customer when Stripe no longer knows the stored one. |
| `createTopUpCheckout` | `mode=payment`, one line **"Review credit"** with `price_data` (USD, the amount in cents, `tax_behavior: exclusive`, `tax_code txcd_10105002`), `managed_payments[enabled]=true`, `customer`, `client_reference_id` and `metadata[intent]` (our intent id), `success_url` and `cancel_url` (the workspace's billing page with `?topup=success` or `?topup=cancelled`) | The intent id maps the payment back to the workspace (#502). The **Idempotency-Key is `topup-checkout:<intent id>`**: the same intent is the same session however often it is asked for (a lost answer, a repeated click, a retry after a crash).                                                                                                                    |

`STRIPE_CHECKOUT_PARAMETERS` is the whole set of top-level parameters a session takes from us; a unit test pins it and
asserts that none of `tax_id_collection`, `invoice_creation`, `customer_update`, `payment_method_types`, `custom_text`,
`automatic_tax` and the address collections is sent. The amount is never the client's word: the route takes **integer cents
from 1000 to 50000** and the adapter checks the range again (Stripe itself would take 50 cents, and the fake one cent, so
the floor is ours: `stripe-adapter.integration.test.ts` shows the fake accepting 1 cent and the adapter not sending it).
Capabilities: `merchantOfRecord`, `customAmount`, `partialRefund` (to be confirmed in #503), 10 to 500 USD, USD,
`providerMayRefund` 60 days, `checkout`, `requiresBillingProfile`, `receiptsFrom: "provider"`.

**The route.** `POST /api/w/:workspace/billing/top-ups` with `{ amountCents, confirmBusiness?, intentId? }` answers
`{ intentId, url }`; the buyer is sent to `url`. It never credits: the balance changes when the webhook arrives (#502), and the
the page it returns to (`/w/<slug>/settings/billing?topup=success`, #505) only says the payment is on its way. The order (`topup-http.ts`, `topup-service.ts`): billing on and an
adapter with a checkout (else the 404 of a path that does not exist, also for the `manual` adapter), same site, session and
role (`manage_billing`), a limit of 10 starts per person and workspace in 10 minutes and of 200 for the whole instance (one API key serves all workspaces; `top_ups_busy`, 503; the counters are shared across app instances and the route **fails closed**: counters that cannot be read are `limits_unavailable`, 503, and Stripe is not asked), a JSON body of at most 4 KiB, then the
amount, the intent id (a UUID the form makes once per attempt, so a repeated click is the same intent), the profile, the
**business confirmation at the first top-up** (stored with the time, the user and the terms version), the **intent row
written first**, the Customer and the session. Refusals are `{ "error": <code> }`: `forbidden`, `amount_invalid`,
`amount_out_of_range`, `intent_id_invalid`, `profile_required`, `business_confirmation_required`, `intent_conflict`,
`checkout_unavailable`, `rate_limited`, `top_ups_busy`, `limits_unavailable`, `request_in_progress` (409: the same start is still running at Stripe, the 409 `idempotency_key_in_use`; try again in a moment, the intent is untouched), `provider_unavailable` (503: a timeout, a 5xx, a rate limit), `provider_rejected`,
`provider_not_configured` (503), `vat_id_rejected`. When the provider fails the intent becomes `failed` (a payment that still
arrives can pay it, as for any failed intent) so none stays pending without a way back, except one that already has a page
(judged on the row under the lock, not on what the request read first) or whose same start is still running: the buyer may be on
that page, or the winning request decides. The person tries again with a new intent id.

**One page per intent.** An intent that has a page (`provider_checkout_ref`) never gets a second one. A repeat of its id asks
the adapter about the page it has (`resumeTopUpCheckout`, a GET, never a create): while the session is `open` the same address
is returned, otherwise (paid, expired, unknown to Stripe, or an adapter that cannot ask) the answer is `intent_conflict` and the
form must use a new intent. Stripe forgets an Idempotency-Key after 24 hours, so without this rule a late repeat would create a
second payable session and then fail on the unique ref, leaving the first payable and the second unreachable. For the same
reason an intent that never got a page is failed after `TOP_UP_PENDING_WITHOUT_PAGE_MS` (30 minutes, swept at the next start of
the workspace and refused on a late repeat): the start that wrote it died before Stripe was asked or before the page was recorded. A start that crashed between the provider and the database leaves a `pending` intent whose session Stripe expires on
its own (#502 turns `checkout.session.expired` into `payment.expired`). The log carries the workspace id and a result code
(`[billing] TOPUP_STARTED workspace=<id> result=ok`), never an amount, a name, an address, a VAT ID, a customer or a page.

**Go-live order.** The route for the billing-profile form (#505) **must not ship before #502** (the webhook and the
crediting). Once a profile can be saved, the top-up route becomes usable (`profile_required` is the only thing keeping a
buyer out today), and a payment made before #502 is taken by Stripe and credited to nobody. The rule is also on #510 (go-live). #502 has merged and the profile route now exists (#505, "The workspace page"); what #510 still requires is a sandbox payment credited end to end before billing is switched on.

**What is not here.** The sandbox plan for invoices and VAT (#503), auto-recharge. The page and the route for the billing-profile form are #505 ("The workspace page" below); the webhook, refunds and chargebacks are #502, above.

**Checked against the Stripe sandbox (test mode, 2026-10-21).** A Customer takes `business_name` at API version
`2025-03-31.basil`; `eu_vat`, `gb_vat`, `ch_vat` (the compact form is stored as `CHE-123.456.789 MWST`) and `no_vat` (without
`NO`) tax ids are taken, a malformed one is `400 Invalid value for <type>` (the adapter says `vat_id_rejected`), a customer
holds at most five tax ids; an address update replaces the whole address. Managed Payments takes both `txcd_10105002` and
`txcd_10103001` (and the rest of `txcd_10...` probed), refuses `txcd_99999999`, `txcd_00000000`, `txcd_20030000` and a text
that is no code ("ineligible for Managed Payments"), and takes any amount, 999 cents included (the floor is ours). A webhook
endpoint takes `api_version` as `2025-03-31.basil` and with the preview flag; the admin page now creates the endpoint with the
version the client's calls use, so the events #502 reads are rendered in a pinned shape (an endpoint that already exists is
adopted as it is).

## Top-up intents

`billing_topup_intents` (workspace-scoped repository `billing-topup-intents-repository.ts`) is the row the application
writes **before any checkout is created**. It holds the adapter, the amount WE asked for, a state (`pending`, `paid`,
`failed`, `expired`) and the provider's opaque ids of the checkout and the payment once known (unique per adapter,
recorded once, never changed). Once paid it also holds what the payment **credited** (net, fixed at that moment) and two
running totals, of what **refunds** and of what **disputes** took back of it; together they never exceed the credit (a
database check as well as the code). It is the only thing that maps a payment to a workspace. To find an intent from an event,
before the workspace is known, `billing-topup-intent-directory-repository.ts` (read only, instance level) looks it up by
payment, checkout or intent id, only for the adapter that made it.

## Applying an event

`applyBillingEvent(db, { provider, event })` runs **one database transaction per event**:

1. **Claim** the event id in `billing_webhook_events` (id, outcome, order; no payload). A repeat is `duplicate_ignored`.
   Only `intent_unresolved` lets the same event id be handled again, if it is delivered again. The route answers 200
   for it, so a provider does NOT redeliver on its own: an event about a payment that is none of ours is recorded for
   review (below), and "Check payment" (#502) or the operator repairs it. A refund or dispute whose payment is NOT
   CREDITED YET is different: see step 2.
2. **Resolve** the intent: by the payment, then the checkout, then our own intent id recorded in the event, and every
   other field must agree. An event that names another intent than the payment belongs to, or another payment than the
   one recorded, resolves to nothing: `intent_unresolved`, no change, answered 200. The intent row is locked (Postgres
   `FOR UPDATE`), so every event about one payment is applied one after the other. **A refund or
   dispute whose payment is not credited yet is not final** (#502): when the payment resolves to an intent that is not
   `paid`, or resolves to none while a top-up of the adapter is still `pending` with no payment recorded and was written in
   the last three days (it may be that one), `applyBillingEvent` throws `BillingEventRetryError("credit_pending")`, the
   transaction rolls back (nothing is claimed) and the route answers **503** with an empty body, so the provider delivers the
   event again after the credit. Without that, a refund that overtakes its `checkout.session.completed` would be answered
   200 and never seen again, and the credit that arrives next would stand beside a payment that was taken back. A payment
   that is none of ours (a foreign object on a shared Stripe account, no top-up waiting) stays `intent_unresolved`, 200 and
   a review row, so a shared account is not retried for days.
3. **Order**: a refund or dispute state older than the last one applied is `stale_ignored`.
4. **Bound**: a credit is **exactly the amount of the intent** (and at least 10 USD): the provider's net must equal what
   we asked for, so a discount or a coupon (a smaller net) is `amount_rejected` and an operator decides, never a silently
   smaller credit. A refund or dispute is turned into its net share (see above); it is `amount_rejected` when its
   **currency is not the one the payment was pinned in** (an amount in another currency is no share of it), when it is
   larger than its payment, and when it would take the
   refunds and disputes of that payment **together** above what the payment credited (two refunds of 20 on a 25 credit
   take 20, then the second is rejected; a refund of 25 and a dispute of 25 take 25). A debit adds to its total, a
   reversal (a rejected or reversed refund, a won dispute) subtracts what it gave back. Nothing is written for a
   rejected amount. This is a deliberate limit: a provider can really lose money twice on one charge (a refund and a lost
   dispute), and that case lands in review (below) instead of silently debiting more than the payment gave.
5. **Write**: `payment.succeeded` is a `top_up` keyed by the **payment** (D14: two events for one payment credit once, and
   the same payment with another amount is `amount_conflict`) and the intent becomes `paid`; `payment.failed` marks a
   pending intent `failed`, `payment.expired` a pending intent `expired` (a late payment still pays either);
   `refund.updated` `pending`/`approved` is a `refund` and a dispute `opened`/`lost` a
   `chargeback`, keyed by the refund or dispute and written **even beyond the unspent balance** (it goes negative and the
   claim refuses the workspace with `balance_negative`); `rejected`/`reversed` and `won` write a `correction` that reverses
   the debit once (`nothing_to_reverse` when there is none yet). A dispute is debited when it opens, because that is when
   the provider takes the money, and when it is lost, whichever is seen first: one `chargeback`.
6. The outcome (`BILLING_EVENT_OUTCOMES`) is recorded with the event id in the same transaction.

**Paid but not credited, and the other outcomes an operator must see.** `intent_unresolved`, `amount_rejected`,
`amount_conflict` (`BILLING_REVIEW_OUTCOMES`) of an event that moves money (a payment, a refund, a dispute), and
`event_invalid`, mean a buyer may have paid and got nothing (an unknown intent, a second payment of an intent that is
paid, an amount above what we asked, a payment that changes the amount of a credit) or been refunded and kept the credit
(a refund before its payment, or beyond the caps). Each is recorded with `review_state = 'open'` and the subject it was
about (`payment:<id>`, `refund:<id>`, `dispute:<id>`) and, when the application could attribute the event to one of its intents, the
**workspace id and the intent id** (`workspace_id`, `intent_id`; null for an event about a payment that is none of ours);
`listReviews` reads them; the admin view of them is "Payment reviews" (#603, below); each is logged
at error level with its code (`billing_webhook_needs_review outcome=...`), and answered 200: the provider's retry would
not change it. The repair is the operator's: a `manual` grant or correction, or "Check payment" (#502) when the provider's
state is the doubt. A signed event that is not a normalized event (an adapter bug, a provider change) is recorded
`event_invalid` under its event id, answered 200 like the rest (a 500 would be retried for days and can disable the
endpoint) and logged `billing_webhook_event_invalid`; if even its id is no id it is answered but cannot be recorded.

Not handled here: a refund that returns to a debit after a reversal (`approved`, `rejected`, `approved` again) stays
reversed, because a refund's journal key is used once; the order of two states of a refund inside one second follows the
provider's clock (`>` on its timestamp); rows of `billing_webhook_events` are never pruned (they are a few bytes each; the journal key is the second idempotency layer, so
a prune after the provider's retry window is safe and left to a follow-up).

## The webhook route

`POST /api/billing/webhook` (`webhook-handler.ts`, wired in `shared.ts`) is public (`src/auth/access.ts`), runs on Node,
and is the same for every provider. Order: guard (billing off, or the active adapter has no webhook, is the 404 of a path
that does not exist, before the body is read and before any billing table is touched), a raw body limited to 256 KiB (413),
`adapter.verifyAndParseWebhook` over the exact bytes (401 for a missing, wrong, altered or old signature and 400 for a signed
body the adapter cannot read, both with an **empty body**), then `applyBillingEvent` (200 and `{ "outcome": "<code>" }`).
The adapter gets the body as bytes (`body.bytes`). Anything that throws is 500 with an empty body and nothing applied; the
provider redelivers. A refund or dispute whose payment is not credited yet is answered **503** with an empty body (log
`billing_webhook_credit_pending`) and nothing applied, so the provider delivers it again after the credit. A signed event that is no event, and a paid-but-not-credited outcome, are not thrown: they are
answered 200 and recorded for review (see above). The log names a code only
(`billing_webhook_rejected code=signature_invalid`): never a body, header, signature, id, amount or error message.
**There is no outbound call in the handler** (`webhook-handler.test.ts` pins it), so the route answers within a few
seconds whatever the provider does.

## Stripe webhooks (#502)

This is the money trust root: **crediting happens only here** (and in "Check payment", which applies the same events). The Stripe
adapter verifies the webhook, reads it into a normalized event (`stripe-webhook-parse.ts`, pure) and `applyBillingEvent` does the
rest; the handler in front of it is the generic one (above).

**Verification.** `Stripe-Signature` over the exact bytes of the body (`Uint8Array`, never decoded text: the generic handler passes the
bytes it read, Next.js's `Request` is not re-encoded), with the secret the admin stored (`stripe_webhook_secret`, read per request),
five minutes of tolerance, constant-time compare, the signature before the age. No stored secret, or no environment that can be told
from the stored API key, refuses every webhook (`signature_invalid`). Only then is the body decoded (strict UTF-8) and read; an event
whose `livemode` is not the environment of the stored API key (a test event at a live instance, or the reverse) is `body_invalid`
(400) and nothing of it is used. The answer for a refusal is a status and an empty body.

**What each event does** (the events the admin page subscribes the endpoint to, `stripe-webhook-events.ts`):

| Stripe event                                                                                                                                                                                                     | Normalized event           | Effect                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checkout.session.completed` (paid), `checkout.session.async_payment_succeeded`                                                                                                                                  | `payment.succeeded`        | A `top_up` of the **net** amount (`amount_total` less `amount_tax`: what the buyer paid after any discount, VAT being on top and never credited; it must equal the amount of the intent), keyed by the payment intent id (D14), on the intent of **our** row. The intent becomes `paid` and pins what the buyer was charged, and in which currency. |
| `checkout.session.completed` (unpaid, a delayed method)                                                                                                                                                          | `ignored`                  | Nothing; the success or failure follows.                                                                                                                                                                                                                                                                                                            |
| a paid session in another currency than USD, of the other environment, with no payment intent, with a total or tax that gives no positive whole net amount of cents, or whose reference contradicts its metadata | `payment.refused`          | Nothing is credited; recorded `amount_rejected`, open for review, logged at error level, answered 200.                                                                                                                                                                                                                                              |
| `checkout.session.async_payment_failed`                                                                                                                                                                          | `payment.failed`           | A pending intent becomes `failed` (a payment that still arrives pays it, once).                                                                                                                                                                                                                                                                     |
| `checkout.session.expired`                                                                                                                                                                                       | `payment.expired`          | A pending intent becomes `expired` (a late payment still pays it).                                                                                                                                                                                                                                                                                  |
| `refund.created`, `refund.updated`, `refund.failed`                                                                                                                                                              | `refund.updated`           | One event per refund with the amount of THAT refund: `pending`/`requires_action`/no status and `succeeded` debit (`refund` entry, the share of the credit), `failed` and `canceled` reverse the debit once (`correction`).                                                                                                                          |
| `charge.dispute.created`, `charge.dispute.funds_withdrawn`                                                                                                                                                       | `dispute.updated` `opened` | A `chargeback` entry (Stripe takes the money when a dispute opens). A `warning_*` status moves no money and is `ignored`.                                                                                                                                                                                                                           |
| `charge.dispute.closed` (`lost`)                                                                                                                                                                                 | `dispute.updated` `lost`   | The debit stays (written once, whichever event was seen first).                                                                                                                                                                                                                                                                                     |
| `charge.dispute.closed` (`won`, `charge_refunded`), `charge.dispute.funds_reinstated`                                                                                                                            | `dispute.updated` `won`    | A `correction` reverses the chargeback once.                                                                                                                                                                                                                                                                                                        |
| anything else, including `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.refunded`                                                                                                          | `ignored`                  | `ignored_type`, 200, no change.                                                                                                                                                                                                                                                                                                                     |

`payment_intent.succeeded` is not read because a payment intent has no net amount and the session event describes the same payment
under the same journal key (the second is a repeat either way). `payment_intent.payment_failed` is not read because a declined card
can be retried on the same page: it is not the end of the intent. `charge.refunded` is cumulative (`amount_refunded` of the whole
charge); reading it as one refund is the mistake the caps exist for, so the per-refund events are mapped instead. A refund or
dispute event with no payment intent, or an amount that is no positive whole number, is `body_invalid` (400).

**The workspace comes from our intent row**, found by the payment, the checkout session or our intent id (`client_reference_id`, with
`metadata[intent]` as a cross-check: when both are there and differ the payment is refused). Metadata alone never maps a payment to a
workspace (ADR 2.13). An event with no intent of ours is `intent_unresolved`, 200, no change, flagged for review.

**The total of a payment is pinned.** A Stripe refund or dispute names only its own amount. When the application credits a payment it
pins on the intent what the buyer was charged, gross, in Stripe's unit (`provider_amount`: `presentment_details.presentment_amount`
when Adaptive Pricing localized the price, else `amount_total`, in cents), and the share of the credit that a refund takes back is
`floor(credited x refund / pinned)` (`net-share.ts`), with no call to Stripe. The first amount told is the one kept. An event that
carries a total which differs from the pin is `amount_conflict`; a refund of a payment that pinned none (paid before the column existed
or by a provider that does not say) is `amount_rejected`: both are open for review, nothing is debited.

**The currency is pinned with it** (`provider_currency`: `presentment_details.presentment_currency` when Adaptive Pricing localized the
price, else the session's own, `usd`). A Stripe refund and dispute name their own `currency`; one that is not the pinned currency (or
that names one for a payment that pinned none) is `amount_rejected` and a review row, so a full refund in euros of a payment pinned in
dollars is never read as "less than all of it" and the credit cannot survive a fully refunded payment.

**A refund or dispute before the credit.** Stripe does not order its events. One whose payment is not credited yet is answered 503 (see
"Applying an event", step 2) and delivered again; when the redelivery comes after the credit it is applied. The window for a payment
we cannot place is the three days of Stripe's retries: a top-up that was started in that time and has no payment recorded could be
the one, so the foreign object is retried only as long as such a top-up is waiting (a day for an abandoned checkout, until its
`checkout.session.expired`). **A refund or dispute that arrives for a payment whose credit never comes** (the checkout event was lost)
is repaired by "Check payment" and then by the redelivery Stripe still has queued.

**On a shared Stripe account** (the account also serves another product) every Stripe event of the account reaches the endpoint:
events of other products of the types the endpoint is subscribed to are verified (a signature check per delivery, before the body is trusted), parsed and, when they are
refunds or disputes, looked up by their payment. Foreign `checkout.session.*` events and refunds are recorded `intent_unresolved`
with a review row, so a busy shared account fills the review list and costs one signature check and a few reads per delivery.
Give the endpoint its own Stripe account when that matters (the subscription is already limited to the types it reads,
`stripe-webhook-events.ts`). **Before verification** a request costs the settings reads of the guard (the billing switch, the active adapter, the stored webhook secret), the read of its
body (at most 256 KiB) and one HMAC over it, and nothing is written: an unsigned flood costs that per request, which the platform's rate limit (the Vercel firewall) should bound: a
rate limit on `POST /api/billing/webhook` of a few dozen requests per minute per IP is recommended (Stripe's own deliveries are
few and come from a small set of addresses).

**While billing is off.** The money events answer 404 while billing is off or the Stripe adapter is not ready (the route is not
there), and Stripe retries a failed delivery for about three days. Do not switch billing off while top-ups are open: the credits
arrive late (after "Check payment" or when the retry comes) and, if billing stays off past the retry window, only "Check payment"
or a manual grant repairs them.

**Ordering.** Refund and dispute states are ordered by the event's `created` (seconds): a state older than the last applied one for that
refund or dispute is `stale_ignored`. Two states in the same second follow the order they arrive in; Stripe's refund and dispute
events are seconds to days apart in practice, and a debit is always reversible by the later event.

**Block on a negative balance.** A refund or chargeback beyond the unspent balance is written anyway; the balance goes negative, the
claim of the workspace refuses `balance_negative` (#498) until a top-up lifts it above zero, and the operator sees the entries in the
journal. The workspace billing page (#505) states why.

**Three things an operator should know** (notes N3, N4, N6 and N7 of the review of #497):

- A refund or dispute that exceeds the caps of its payment is `amount_rejected` and **final**: its event id is not applied again.
  If the earlier debits are reversed later (a refund fails, a dispute is won) the rejected one may have become valid at Stripe; the
  repair is a `manual` correction (#504), not a redelivery.
- An `event_invalid` row is final as well (a redelivery is `duplicate_ignored`), so after an adapter fix "Check payment" or a manual
  grant is the repair. A signed event whose id is not even an id is answered 200 and cannot be recorded: the log line
  `billing_webhook_event_invalid` is the whole record.
- A review row is closed with `resolveReview(provider, eventId, resolution)` of the events repository (N7), from the admin page "Payment reviews" (#603, below).

**Check payment.** `POST /api/w/:workspace/billing/top-ups/:id/check` (an Owner or an Admin; same site; 20 per person and workspace
and 300 for the instance in 10 minutes; the 404 of a missing path while billing is off or for an adapter with no lookup). It finds
the intent in the workspace of the address (any other id, also one of another workspace, is `intent_not_found`), and unless the
intent is paid already or has no page it asks the adapter (`lookupTopUp`: the Checkout Session by the id recorded on the intent;
a delayed payment that Stripe gave up on is read from its payment intent) and applies the resulting event through
`applyBillingEvent` with an event id of its own (`check-<session>-<paid|failed|expired>`). So a lost webhook, a late one and a second
click are one credit. A session or payment intent that is gone at Stripe (`404 resource_missing`) is nothing to report, never an
error; a Stripe that is down is `provider_unavailable` (503) and changes nothing. The answer is `{ intentId, state }`.

**What is not done.** The exact split of a payment refunded in several parts (the last refund taking the remainder, note N1: today
each share is rounded down, so the residue is under one micro-USD per refund) and a reconcile sweep over Stripe's Events API are
follow-ups.

## Payment reviews (#603)

`/admin/billing/reviews` (the child of Billing in the admin menu; data routes below `/api/admin/billing/reviews`; instance admin only,
`Cache-Control: no-store`, the guards of `src/admin/README.md`) is the operator's surface for the rows of `billing_webhook_events` with
`review_state` `open` or `resolved` (`BILLING_REVIEW_OUTCOMES`). Before it, a buyer who paid and was not credited was visible only in the
error log and the database. The logic is `admin-review-service.ts`, the handlers are in `admin-http.ts`, the page is
`src/admin/ui/billing-reviews-page.tsx`.

- **The list** (`GET /reviews?state=open|resolved&page=N`, newest first, 25 to a page; the state and the page are in the address of the
  page). A row shows: the outcome with a plain reading of it (`billing-review-copy.ts`), the provider's object (`payment:<id>`,
  `refund:<id>`, `dispute:<id>` as stored), the workspace (name and slug) and our top-up when the application could attribute the
  event (its state, the amount WE asked for, the checkout session and payment recorded on it), and when the event arrived. A payment that
  is none of ours has no workspace and no top-up. **Nothing else is stored, so nothing else is shown**: no payload, no amount or currency
  the provider sent, no buyer. (The one amount on the page is our own top-up's, which prefills a credit; the amount a buyer actually paid
  is looked up in the Stripe dashboard.) The count of open rows is also in the answer, and shown on the Billing entries of the menu and on
  the "Needs attention" region of the overview (`countOpenBillingReviews`, which counts none when the database cannot answer, so a
  broken table cannot take the portal down). The oldest-first order of `listOpenReviews` is left for callers that want it; the page lists
  newest first (an old unresolved row does not hide a new one).
- **Closing a row** (`POST /reviews/resolve` `{ provider, eventId, note, credit? }`): the note is required (`note_required`,
  `note_too_long`, 500 characters), the admin is the actor. The row keeps `resolved_at`, `resolved_by`, `resolution_note` and
  `resolution_entry_id` (migration `20261022020000`); a second close is `review_already_resolved` (409) and the first resolution stays.
  Closing without `credit` changes no money. The audit line is `billing_review_resolved provider=... event=... actor=<user id>
entry=<id|none>`: never the note, which may name a customer. A row redelivered by the provider (`intent_unresolved` is the only outcome
  that lets the same id be handled again) starts over while its review is open; a review an operator closed stays closed with its
  resolution (who, when, why, the journal entry), whatever the redelivery ends in.
- **Crediting from the row** (`credit: { type?, amountMicroUsd, intentState? }`) is the existing manual credit
  (`admin-credit-service.ts`, the manual adapter, the admin as the actor, the note as the journal note). The workspace is the one **the
  row names**, never one the caller sends (a body with another key is `invalid_input`; a row with no workspace is
  `review_workspace_unknown`). **The row decides the type**: a `credit` (`top_up`) for a payment or an event about none, a `correction`
  for a refund or a dispute; a `type` naming the other one is `review_credit_type_mismatch` (409), so the journal, which keys an entry by
  workspace, type and request id, cannot get a second entry for one row by switching type. The request id is derived from the row
  (`review-` and a hash of provider, event id and that type), so the row credits at most once: a repeat finds the same journal entry, a repeat with another amount is `request_conflict`, and a close that was lost after
  the credit is made by the retry with the same entry. Two admins at the same moment write one entry; the second sees
  `review_already_resolved`. **The state of the top-up the admin saw** travels with the credit (`intentState`, required when the row
  names a top-up of its workspace); if the top-up is in another state by now (a webhook paid it, the admin checked it) the credit is
  `intent_state_changed` (409) and nothing is written. A paid top-up of an `amount_conflict` row can still be credited when the admin
  saw it paid. (The recheck reads the top-up just before the credit; a payment applied in the few milliseconds between is not
  excluded, only a page that went stale is.) The page prefills a credit with the amount of our top-up when the row is a payment of a top-up that is not
  paid yet, and offers a signed correction with no amount for a refund or a dispute (the operator types what to take back).
- **Check payment** (`POST /reviews/check` `{ provider, eventId }`) runs the check of a workspace owner (`topup-check.ts`) for the top-up
  of the row, as an Owner of the row's workspace, and answers the state of the top-up; the row stays open until the admin closes it
  (`review_has_no_intent` for a row with no top-up, `payment_check_not_possible` when billing has no adapter that can look a payment up
  or it is not the provider of the row, `payment_check_unavailable` when the provider could not be asked). Asking is not rate limited:
  only the instance admin gets here.
- Out of scope, as in the issue: pruning `billing_webhook_events`, a reconcile sweep over Stripe's Events API, mail notifications.

## The manual adapter

For prepaid billing with no payment provider (the credit is entered by hand). No checkout (`{ kind: "none" }`: the workspace page
says "ask your operator to add credit") and no webhook. `createManualCreditService(db)` offers `grant` (a `top_up` with the
provider `manual`) and `correct` (a `correction` of either sign, which may take a balance below zero), both with an actor
and a note: the immutable journal entry is the audit trail. A grant is keyed by a random reference, so granting twice is
two grants, unless the caller passes a `requestId` (a form token): then the same request makes one entry. An amount is a
whole micro-USD amount, never zero, at most 10,000 USD at once, a note is required (at most 500 characters) and the
workspace must exist (`MANUAL_CREDIT_ERROR_CODES`). The form is the billing page (#504, above); its routes check that the
caller is an instance admin first and work whether billing is on or off.

## The start credit

The start credit (ADR 0006, 2.16, D11, P7; #507) is what a new workspace gets to try our models before it pays (there is no free tier next to the balance). It is a
`start_credit` journal entry of the amount the admin set on the billing page (`startCreditMicroUsd`, default 2 USD, **0 disables it**).
It is the easiest thing to farm, so it is tied to the **GitHub account**, not to the workspace.

- **When.** Lazily, by one idempotent function, `ensureStartCredit(db, workspaceId)`, the first time a workspace with a bound
  installation meets billing **while billing is on**: the first claim of a job (inside the claim transaction, before the balance check, so the
  first job can use it; `runner-jobs-repository.ts` calls `ensureStartCreditWhileOn` once billing is `on`) and the first visit of the
  workspace's billing page (`loadWorkspaceBillingPage` calls `ensureStartCredit` before it reads the balance, #505). There is no scheduler and no
  hook on binding. Existing workspaces when billing is switched on get theirs through the same path, on their first contact.
- **Who.** The numeric account id of the installation (`config.accountId`, #103) of an integration that is not `disconnected`. A
  workspace without such an installation, or whose installation names no account id, gets nothing, and its claim is refused for
  balance as usual (`insufficient_balance`). A workspace is granted **at most once** whatever the number of its installations
  (the journal key `(workspace, start_credit, "start-credit")`), and an account at most once whatever the number of workspaces.
- **The memory.** `billing_start_credit_grants` (instance level, `billing-start-credit-grants-repository.ts`): the numeric account id
  (primary key), the id of the workspace that got the credit and the time. **No foreign key to a workspace**, so the row outlives
  it: deleting a workspace and creating it again for the same installation account finds the account granted. It holds ids and a
  time only: no login, no name, no address, no amount (the amount is the journal entry, which is what the customer sees). The
  account id is checked to be a plain positive number (a database check on both engines).
- **Race safety.** The grant is one transaction (the claim's, or its own): look for the workspace's entry, read the amount, read the
  accounts of the installations, take the balance row's lock (the journal's rule for every writer: the lock first, then any write,
  the grants table included), take the first bound account nobody was granted (`insert ... on conflict do nothing` on the primary
  key: of two writers exactly one wins, the other waits for the first to commit on Postgres and gets "already granted"), write the
  entry. Nothing is written when any step fails, and every step is keyed, so a retry never grants twice.
- **It never fails the claim.** The grant runs inside a savepoint. An error of any kind (a database error, a row it cannot read)
  rolls back to the savepoint, is logged as `BILLING_START_CREDIT_FAILED workspace=<id>` (never the error text), and the result is
  `failed`: no grant, no entry, the claim goes on and the workspace is judged on its balance as usual; the next contact tries
  again. It reads only the `config` of the rows with `type = 'github_app'` and a status other than `disconnected`, never the
  credentials or the webhook secret, and an unreadable config or account id skips that row. A claim tries a workspace once, not
  once per candidate job.
- **Amount changes.** The amount is read when the grant is made. A grant is never edited (the journal is append-only), so a changed
  amount affects only grants not made yet. Raising it from 0 grants later contacts; accounts that met billing while it was 0 were not
  consumed (no row was written), so they are granted at the new amount on their next contact.
- **Billing off.** `ensureStartCredit` reads the instance setting and nothing else: no billing table and no integration. The claim
  does not call it unless billing is on and ready. Nothing is granted while billing is off.
- **Log.** `BILLING_START_CREDIT_GRANTED workspace=<id> amountMicroUsd=<n>` per grant, written after the transaction committed (a
  claim that rolls back announces nothing); never an account id.

### Abuse protection of version 1, and the surface that is left

What protects the credit: the memory above (one grant per GitHub account, kept past the workspace), the hidden hourly brake (#499, "Limits at claim (#499)"), the refusal
at a balance of zero (a workspace that has used its credit cannot start another review; a run that already started may take the balance below zero), and the sign-up rules of the instance
(allowed organizations, invitation only, verified email as the operator configured them). Not in version 1, by ADR 0006 2.16:
disposable-email lists, a first-top-up cap, a verified email as a condition.

What is observed, so a follow-up can be sized:

- **A new GitHub account is a new credit.** A farmer needs a GitHub account, an installation of the App on it and a workspace that
  binds it. Each costs a few minutes and no money, and yields the start credit (2 USD by default) of real model cost and VM time.
  The limit is the sign-up rule of the instance and GitHub's own abuse handling, not this code.
- **Org accounts.** Any user can create organizations and install the App on each. Every one is a distinct account id.
- **Transfer.** The credit stays with the workspace; it cannot be withdrawn or refunded (credit never expires and is never refunded),
  so the loss of one grant is bounded by the amount.
- **Sizing.** `select count(*), min(granted_at), max(granted_at) from billing_start_credit_grants` and the log line above give grants
  per day; compare `start_credit` totals in `billing_journal_entries` with the `usage` of the same workspaces to see how much of the
  credit is ever spent and by workspaces that never top up.

## The workspace page (#505)

`/w/:ws/settings/billing` shows a workspace its prepaid balance (ADR 0006, 2.5). **It exists only while billing is on**: with billing off the page, `GET /api/w/:ws/billing/journal`, `GET`/`PUT .../billing/profile` and the other billing routes of a workspace are the 404 of a path that does not exist (`loadWorkspaceBillingPage`, `guardBillingRoute`; no billing table is read). While billing is on the settings navigation lists **Billing instead of Plan** (`showBilling` of `SettingsNav`), and `/w/:ws/settings/plan` leads on to it (a redirect; the operator's "Manage plan" page is not part of a prepaid workspace). The page file only wires `workspace-page.ts` in; the UI is `src/workspace-billing/` (client-safe: the files here are server-only, `server-only.test.ts` keeps them out of the browser), so the view types, the money text and the copy are in `workspace-billing/view.ts`, `money.ts` and `messages.ts`.

| Section                | Who          | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Balance                | everyone     | The balance in US dollars; what an old hold still holds (a line only while something is held: no review holds anything since #605); a warning when the balance is zero ("No credit left") or below zero ("The balance is below zero": a review that ended, or a refund, took it there), with the way out for an Owner/Admin and who to ask for a Member. A balance above zero starts reviews, even by one cent.                                                                                                                                    |
| Add credit             | Owner, Admin | Presets 10, 25, 50, 100, 500 and another amount from 10 to 500 US dollars, typed in dollars and sent as whole cents (the server judges the range again); the **business confirmation** (checkbox) at the first top-up only; "Continue to payment" starts `POST .../billing/top-ups` and sends the browser to the page it answers. With the `manual` adapter (no checkout) there is no form for anybody: "Ask your operator to add credit".                                                                                                         |
| Billing details        | Owner, Admin | Legal name, address, an optional VAT ID, saved with `PUT .../billing/profile` (`profile-http.ts` over `profile-service.ts`: the fields are judged by `profile.ts`, a refusal names a field and a code and never echoes the value, nothing is logged). Shown for adapters that keep a profile (`requiresBillingProfile`). The business confirmation links to the operator's terms and privacy statement when the admin has set them on the billing page (#626, "The billing page", "Terms and privacy links"); a link that is not set is not shown. |
| Payments on their way  | Owner, Admin | Pending top-ups with "Check payment" (`POST .../top-ups/:id/check`, #502) where the adapter can look a payment up. After the buyer returns (`?topup=success`) the page says the payment is on its way and asks the server again every 4 seconds, for at most 150 seconds, while a payment is pending, so the credit appears without a reload.                                                                                                                                                                                                      |
| Journal                | everyone     | Credit added, start credit, **charges** (a review, with its AI price and its infrastructure price and a link to the Run), refunds, chargebacks and corrections, newest first, 25 rows a page with a cursor (`GET .../billing/journal?cursor=&limit=`, `entries({ excludeTypes })`). A hold and its release are not rows (they net to nothing; an open hold shows as "held"). The note of a correction, references and provider ids are never sent.                                                                                                 |
| Monthly spending limit | Owner, Admin | The optional limit of #499 (`GET`/`PUT .../billing/monthly-limit`): empty removes it; this UTC month's actual charges so far; "Reviews that are already running always finish".                                                                                                                                                                                                                                                                                                                                                                    |
| Key and invoices       | everyone     | Whose key reviews run on, with a link to the LLM access page where the workspace chooses it (#496: our models by default, or its own provider key; the choice is `GET`/`PUT .../llm-key-mode`, `src/llm/README.md`), and "Invoices and receipts are issued and emailed by Link" with a link to link.com. **No promise of VAT-compliant invoices** until #503 passes.                                                                                                                                                                               |

**Roles.** A Member reads the balance, the journal and the prices (`view`); an Owner and an Admin (`manage_billing`) also top up and change the billing details and the limit. A Member's data never carries the profile, the pending payments, the limit or the month's charges (`workspace-page.integration.test.ts`, #505-T02); another workspace's member gets the 404 of every workspace route.

**The start credit** is granted by the first contact: the service calls `ensureStartCredit` before it reads the balance (the follow-up of #507), so a workspace never sees the page without it.

**What the customer sees: final prices only.** The view and the routes carry a review's AI price and infrastructure price and nothing else: no rate, no factor, no minute count, no real cost of our key, no model or provider id, no mention of the hourly brake (#505-T06 scans the view, the Runs responses and every state of the page). A review on the workspace's own key shows only the infrastructure price (its AI part is `null`, taken from the usage record's key mode). The prices come from the `usage` entry of the journal.

**Display rounding.** Amounts are stored and sent as exact micro-USD integers. The page shows them rounded half away from zero to four decimals with at least two (`$7.98`, `$7.9818`), and a non-zero amount that would round to zero as "Less than $0.0001" (`workspace-billing/money.ts`, integer arithmetic only). A sum of the rounded rows can differ from the shown balance by less than $0.0001 per row.

**The price in Runs.** `RunRowView` and `RunDetailView` carry an optional `price` (`run-prices.ts`, wired in `runs/shared.ts` only while billing is on): `charged` with the two prices, `not_charged` for a review that was settled with nothing charged (free because the error was on our side, or priced to nothing), and **no price** for a review still open, one claimed with billing off, or a job that never ran. The Runs list gets a Price column only when some row has a price; the run detail a "Price" line. Billing off adds nothing: no column, no line, one read of the instance setting per Runs request.

**Invoices (#659).** The card on the page asks `GET /api/w/:ws/billing/invoices` when it appears and when the balance changes. The Stripe adapter lists `GET /v1/invoices?customer=<stored customer>` (first 24, newest first), drops drafts, an amount of zero, a foreign customer and any address that is not https on a Stripe host (`stripe.com` and its subdomains; the fake's loopback address only where `stripeLinkOriginOf` names it, i.e. the test stack), and gives the page the number, date, amount in the invoice's own currency, status and the hosted page and PDF addresses. Top-up Checkout sessions do not ask for `invoice_creation` (unsupported on Managed Payments, `STRIPE_CHECKOUT_PARAMETERS` pins it); the fake issues an invoice for a paid session with a customer, which is the fake's assumption until #503 verifies it. A customer Stripe does not know (`resource_missing`, e.g. stored under a test key before a live key was saved) is an empty list, logged once as `INVOICES_LISTED ... result=customer_missing`; other failures stay errors. The manual adapter has no `listInvoices`: its page has no card.

**Routes added by #505.** `GET /api/w/:workspace/billing/journal` (every member), `GET`/`PUT /api/w/:workspace/billing/profile` (`manage_billing`), the page, and `?topup=` on the return address. All answer `Cache-Control: no-store`; a change is same-site only. They are in the protection, portal-guard and member-scan tables (`auth/protection.integration.test.ts`, `admin/portal-guards.test.ts`, `e2e/helpers/member-routes.ts`).

**Refusal notices.** While billing is on, the notice for a balance or monthly-limit refusal links to the billing page, and so does the link of a quota or suspension notice when the instance has one; with billing off both are as before (`refusal-notices/billing-link.ts`, #505-T12).

**Tests.** `workspace-page.integration.test.ts` (the data), `journal-http.integration.test.ts`, `profile-http.integration.test.ts`, `run-prices.integration.test.ts`, `runs/runs-price.integration.test.ts`, `workspace-billing/ui/*.test.tsx` (the page), `refusal-notices/billing-link.integration.test.ts`, and the journey `e2e/billing/workspace-billing.e2e.ts` against the fake Stripe (top-up, the pending state, "Check payment" after a lost webhook, the limit, billing off).

**The test stack's Stripe address.** The app sends its Stripe API key to Stripe's own address. The e2e stack points it at the fake Stripe with `STRIPE_API_BASE_URL` together with `ALLOW_TEST_STRIPE_ENDPOINTS=true` (`src/stripe-endpoints.ts`, read outside this module, so `no-environment-variable.test.ts` still holds): without the flag the variable is ignored, and even with it only plain `http:` on a loopback address is accepted. It is in no `.env.example` and no deployment file.

## Balance notifications (#506)

An Owner and an Admin hear about a low or empty balance before the pull requests start to carry refusal notices (ADR 0006, D9): **one mail per crossing** and **a banner** while the state lasts. Billing off: nothing is computed, written, sent or shown.

**States.** A balance is `empty` at zero or below (a review starts with any balance above zero, #605, and is refused at exactly zero; below zero is also `empty` for the mail, and `negative` for the banner and the page), `low` below the threshold the admin set (#504, `lowBalanceMicroUsd`, default $5, `db/balance-state.ts`) and `ok` otherwise. `empty` is also `low`.

**Where the decision is made.** The table `billing_notifications` (`20261022030000_create_billing_notifications`; one row per workspace and kind `low` or `empty`, written by the first crossing; `BillingNotificationsRepository`, workspace scoped) holds `state` (`armed`: the next drop into the state is told; `sent`: told since the balance was last out of it), `sent_at` and `delivery` (`none`, `due`, `sending`, `delivered`, `failed`). Every journal write, `applyToBalance` of the journal repository, calls `noteBalanceMoved` right after the balance row changed, so it runs **in the same transaction and under the balance row's lock**: the settlement of a job, a refund, a chargeback, a correction, a top-up, a start credit. A claim that is refused for the balance (`insufficient_balance`, `balance_negative`) calls `noteRefusalForBalance` (the lock first, then the same decision) inside the claim's transaction. Two writers of one workspace therefore decide one after the other, a transaction that rolls back takes its decision with it, and the table is never read without that lock. Billing off, or switched on but not ready: `noteBalanceMoved` reads the switch and returns.

| What happens to the balance                                                                | Written                                                                                                                            |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Drops into a state that was `armed`                                                        | the kind is `sent` and its mail is `due` (when one drop is into both states, only `empty` is mailed, `low` is `sent` with no mail) |
| Stays in a state that is `sent` (ten more settlements, a second refusal)                   | nothing                                                                                                                            |
| Leaves a state (a top-up lifts it out)                                                     | the kind is `armed` again, and a mail that was `due` but not claimed is withdrawn                                                  |
| A credit lands in a state (a start credit under the threshold, a top-up that is still low) | the kind is `sent` with **no** mail: the banner and the page already say it, and the first mail follows the next drop              |

**The mail.** `deliverDueBalanceMails` (`balance-mail.ts`) runs **after the response** (`runAfterResponse`, wired in `shared.ts` as `deliverBalanceMails`): when claims of jobs ended (`onClaimsEnded`, which covers the settlements), when a claim was refused for the balance (`onRefused`) and when a billing webhook was applied (`afterApplied` of the webhook handler: a refund or a chargeback). A call that finds nothing due costs one small read. It claims each due crossing with one guarded statement (`due` to `sending`: of several senders one wins), checks that the balance is still in the state, and sends one message to **every Owner and Admin** (`manage_billing`, at most 20) through `getMailSender()`; a Member gets none. The message (`src/mail/balance-message.ts`) says what happened, the workspace's own balance and a link to its billing page built from the configured public address. No rate, factor, formula, minute count, model, provider or brake is in it (#506-T07 scans it). It is **best effort and cannot fail anything**: it runs after the commit of the claim or the settlement, never throws, tries each recipient once and never retries (a retry could repeat a mail the server did accept). A crossing that reached nobody is `failed` and logs one line `[billing] BALANCE_MAIL_FAILED workspace=<id> kind=<kind> code=<code> recipients=<n>` with the stable codes `mail_failed`, `not_configured` (the instance has no mail server), `no_recipients` and `stale` (the balance was lifted before the mail went out); no address, name or message is ever logged. A server that was down loses that mail but not the banner, which is computed from the balance, not from the table.

**The decision never undoes a money write.** `noteBalanceMovedSafely` / `guardedBalanceNote` (`balance-notifications.ts`) run the decision in a savepoint of the transaction of the journal write, the job's settlement, the webhook and the claim refusal (`noteRefusalForBalance`, `claim-billing.ts`). A failure (a table that cannot be written, a damaged row) is rolled back to the savepoint, logged as `[billing] BALANCE_NOTE_FAILED workspace=<id> code=note_failed` (no address, no text of the database) and skipped: the charge, the credit or the refusal commits and the workspace is not told this time (#506-T11 to T14, a trigger that fails every write to `billing_notifications`). Mails due from a settlement that has no response to send after (a sweep, a superseded job) go out from the step `balance_mails` of the cron sweep and the hourly timer of a server (#506-T16, T17).

**The banner.** `loadBalanceBanner` (`balance-banner.ts`): for an Owner and an Admin only (a Member gets `null` before anything is read), while billing is on and the balance of THEIR workspace is low, zero or below zero. The workspace layout (`src/app/(app)/w/[workspace]/layout.tsx`) shows `BalanceBanner` (`workspace-billing/ui/balance-banner.tsx`) above every page of the workspace: a warning while low, an alert at zero and below, with the balance and "Go to billing". A layout is not rendered again when the person moves between pages of the workspace, so the banner is as fresh as the last full load; the return from a payment loads it again. A database that cannot answer shows no banner and logs `BALANCE_BANNER_UNAVAILABLE`. The pull request notice of #498 stays the signal for members.

**Not here.** Preferences, an opt-out, other channels, a usage forecast and auto-recharge are out of scope of #506. A holds-era reservation (`reserve`, dormant since #605) does not call the decision.

**Tests.** `db/balance-state.test.ts`, `balance-notifications.integration.test.ts` (the state machine on both engines, including a burst of settlements that races), `balance-mail.integration.test.ts` (recipients, content, failures, no repeat), `jobs/claim-balance-notifications.integration.test.ts` (the refusal), `webhook-handler.integration.test.ts` (a refund), `balance-banner.integration.test.ts`, `workspace-billing/ui/balance-banner.test.tsx`, `mail/balance-message.test.ts`, the repository tests and the isolation rows, and the journey `e2e/billing/balance-banner.e2e.ts`.

## The scheduled journal check (#626)

`verify()` of the journal repository (above, "The balance journal") compares one workspace's cached balance and reserved money with
what its journal adds up to and counts the holds of ended jobs nobody released. `journal-check.ts` runs it for every workspace that has
a journal, once a day, while billing is on (#510 item 7).

- **Where it runs.** The step `journal_check` of the cron sweep (after `balance_mails`, before `models_dev`; `src/dispatch/README.md`) and the
  hourly timer of a server (`src/maintenance/startup.ts`, with the cleanup, the release of the holds and the balance mails). Both call
  `runJournalCheckWhileBillingOn`; two runs at once are kept apart by a tried lock (`JOURNAL_CHECK_LOCK`, namespace 626).
- **Bounded cost.** A run reads the workspace ids in order, 100 at a time (`JOURNAL_CHECK_BATCH`; the finder is
  `billing-journal-directory-repository.ts`: the balances and the journal, a page of each at most, so a page never reads a whole
  journal), and takes no further step when its budget is used (`JOURNAL_CHECK_BUDGET_MS`, 20 s). The position (`run.after`) is stored after every
  step, so the next run continues where this one stopped; a pass over a large instance takes several runs and never one long
  transaction.
- **Daily.** A pass starts when the last one finished more than 24 hours ago (`JOURNAL_CHECK_INTERVAL_MS`); in between a run reads the
  stored state and stops (`skipped: "not_due"`). A pass under way for more than three days (billing was off) starts again.
- **The record.** The instance setting `billing_journal_check` holds `last` (when the pass finished, `ok` or `inconsistent`, how many
  workspaces, how many inconsistent) and `run` (the pass under way). It is read leniently (a part of another shape reads as not
  there) and written only by the check. The admin billing page shows `last` (`journalCheck` of `GET /api/admin/billing`); it stays while
  the next pass is under way.
- **The log.** One line per inconsistent workspace (at most 20 a step; the count of the pass has them all):
  `[billing] BILLING_JOURNAL_INCONSISTENT workspace=<id> balance_drift=<0|1> reserved_drift=<0|1> stranded_holds=<count>`, and one line
  per finished pass: `[billing] BILLING_JOURNAL_CHECK_DONE result=<ok|inconsistent> workspaces=<n> inconsistent=<n>`. No amount, no name,
  no address. A workspace that shows a difference is verified a second time before it counts (a write between the two reads of a busy
  workspace is not what the check is for).
- **Billing off.** `runJournalCheckWhileBillingOn` reads the switch and nothing else: no billing table, no write, no log line. The
  pass resumes when billing is on again.
- **It repairs nothing.** A difference is a bug to look at; the stranded holds of ended jobs are released by their own step
  (`billing_holds`), which runs before this one.

Tests: `journal-check.integration.test.ts` (#626-T10 to T14, on Postgres), the sweep (`dispatch/sweep.test.ts`,
`dispatch/sweep.integration.test.ts`, #626-T15), the timer (`maintenance/startup.test.ts`, #626-T16) and the page's data (#626-T17).

## Open points

What is known to be unfinished, so nobody is surprised. Go-live blockers are in the checklist of #510.

- **Refund and dispute currency under Adaptive Pricing (#604, N1).** The webhook pins the currency the buyer paid in and treats a refund or dispute in another
  currency as `amount_rejected`. Whether Stripe reports refunds and disputes of a localized payment in the pinned currency or in USD is not verified in the
  sandbox yet. Fail-closed: the credit stays and a review row opens. Verify before live money.
- **Invoices and VAT ID on Managed Payments (#503).** Not verified. The product promises no VAT-compliant invoice.
- **The Diff AI reserve and the hold code (#608).** Dead, still required to switch on.
- **Journal check alert.** The scheduled check logs a stable code and shows its result on the admin billing page, but sends no mail or
  message: the alert on `BILLING_JOURNAL_INCONSISTENT` is the operator's log tooling (#510, item 7). The admin overview does not show it.
- **Price disclosure (#612).** The AI part and the infrastructure part of each review stay visible on purpose; the infrastructure part matters for future bigger
  machines. Deriving A and B from them is accepted.
- **Pruning.** Rows of `billing_webhook_events` are never pruned.

## Where billing is not allowed to reach

- A browser: `server-only.test.ts` fails when a client component imports this folder, directly or through a file.
- The environment: see above.
- A workspace's data: anything a later issue stores about a workspace is scoped to it (`src/db/README.md`, "Workspace
  scoping").
