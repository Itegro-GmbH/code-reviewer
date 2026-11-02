# Cost policy of a native job

What the claim decides about the cost of a **native** Dynamic job, one that runs through the passthrough proxy of the runner
(`runner/.../dynamic_review/passthrough/`, design #544, epic #420). The ticket is #553; the billing rules are those of epic
#489: a run is free only when the failure is clearly ours, an unknown AI cost is charged as minutes only, and the managed key is
never used with an unknown price.

| File             | Role                                                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `catalog-ref.ts` | The minimal map from a selection (registry slug, model id) to the models.dev ids, and the one rule that says which selection is native                                         |
| `policy.ts`      | Pure: the managed policy from the answer of `availability()` (with the cache-read rule), the own policy from a book and a cap. `CostPolicyJson` is `dynamic.cost` of the claim |
| `token-cap.ts`   | The token cap of an own key: bounds (100,000 to 100,000,000), the default 4,000,000, and the reading of a stored value                                                         |
| `service.ts`     | `createNativeCostService`: `refOf` and `policyFor`, over the price service and the instance settings                                                                           |
| `shared.ts`      | The wiring of the running server (the claim imports this, never the price module: `model-prices/visibility.test.ts`)                                                           |

## Who is native

A job is native when its selection names a catalog model: `catalogRefOf` maps the slug of the provider to the provider id of
models.dev (the underscore of a slug is the hyphen of the id; an id with an underscore, or one that starts with a digit, has no
slug) and the provider must be in `contracts/opencode-providers.v1.json` and **not** in the legacy registry (`openrouter`,
`anthropic`). Those two stay on their wires until #556, so nothing about their claim changes. Only a Dynamic job is native (a Diff
job runs PR-Agent). **The registry does not accept a native slug in a selection yet**, so on the running server no job is native
and the claim is the claim of today, unless the switch below turns the two registry providers native; #555 lifts the rest.

**The Implementer is the exception (#755).** Its agent is OpenCode and has no legacy wire, so for a turn of the Implementer no
provider is legacy: `implementerRefOf` (`implementerCatalogRefOf`) names `anthropic` and `openrouter` as catalog models, whatever
the switch says, and the claim asks it for a turn and `refOf` for a review. Everything after the ref is the native claim below
(the entry at the registry's pinned address, the own-key policy with the catalog's price, the cap). A Diff or Dynamic review
never calls it.

## The switch (#578)

`NATIVE_OPENCODE_PROVIDERS` in the environment of the app (`1`, `true` or `on`; anything else is off, `switch.ts`). **Default off.**
Off, `legacyProvidersFor` returns the registry's providers, `catalogRefOf` names none of them and every claim is exactly the claim
of today (no `dynamic.cost`, no `dynamic.modelEntry`, no price check, the legacy capability metadata is read as before). On, the
legacy list is empty: a **Dynamic** job on `openrouter` or `anthropic` is native, their ids being models.dev provider ids that the
supported-provider file lists. The variable is read at every claim (`getNativeCost()` is built per request), so it can be turned
off again with the next deployment without a migration. A native slug of another provider still needs #555.

A native claim sends, next to the policy below, the **entry of the chosen model** (`dynamic.modelEntry`, `entryFor` of the service,
the last known catalog row through `buildJobModelEntry`, so a model models.dev no longer lists is still served). The price is judged
first, so a managed model without a confirmed price keeps its refusal; then an entry that cannot be built ends the job before any
credential exists: `managed_model_unavailable` on the managed key (free), `dynamic_model_features_unsupported` on an own key, with
`reason=entry_<code>` in the log (`model_not_in_catalog`, `provider_url_blocked`, `provider_unsupported`, `entry_invalid`). A failed read
of the catalog gives the job back like a failed price check. A native job does not read the legacy capability metadata of the
provider: the entry states the window, the output bound and the flags.

## The managed key (we pay)

At claim time, before any key, token or VM exists, `availability()` of #549 is asked. Only a model that is **enabled and has a
confirmed price** passes. Otherwise the job ends `managed_model_unavailable` (the code that already has a member-safe notice; no
provider, model or price is named). The log carries the opaque entry id, the kind and the stable refusal code with the internal
reason (`reason=catalog_price_unconfirmed:price_unconfirmed`); the code is `catalog_price_unconfirmed` for a price that is not
confirmed, stale, not priced or incomplete (below), and `catalog_model_unavailable` for everything else. The usage record of the
refused job is `void`, and the job's billing class is `free` (every code of the claim has one). A managed job that is accepted logs
which confirmation priced it (`confirmation=<id> hash=<version>` on its selection line). A price check that itself fails
(`check_failed`: the database could not be read) is not the model's fault: the job is given back (503 with `Retry-After`, an attempt
counted, reason `price_check_failed`, class `free`) and tried again, on the Worker's fetch as on the claim.

The confirmed **book** goes into the claim (`dynamic.cost.priceBook`) and is the runner's only price source: never the engine's own
`cost`, never models.dev. An unknown cost ends the run with `dynamic_accounting_failed`, which billing treats as our fault. There is
no token cap. The result is checked once more when it comes back: the success of a **native** managed Dynamic job that reports a
null cost is stored as `dynamic_accounting_failed` (`runner-api/managed-cost-guard.ts`); it can never settle with a null cost. Whether
a job was native is what its claim stored (`claimedKeys.wasNative`, set when the claim sends `dynamic.modelEntry`), not the switch of the moment the
report arrives, so a native run that finishes after the switch was turned off is still held to its cost, and a job on the legacy wires is unchanged.

**Cache prices (decision).** A cache read without a confirmed read price is not priced as input (the upper bound #569 left open),
because the member would be charged a price nobody confirmed. So "selectable" includes the cache prices, defined once in
`availability()` (`model-prices/availability.ts`): a confirmed book is unpriced (`cache_read_unpriced`) when any level states no
cache read, and a model of the Messages family that states a cache read and no 5-minute write is unpriced too
(`cache_write_unpriced`); the admin states the missing price explicitly in a correction (the input price is its upper bound). The
runner reads the book of a claim with `strict_cache_read` as a second line: a read it has no price for makes the call unpriced and
the run ends `dynamic_accounting_failed`, which is free. **`cache_control.ttl` stays out of the request schema**: the pinned engine
never sends one, so allowing it would buy nothing and widen what the engine may ask.

## The own key (the user pays the provider)

Free choice; a missing price blocks nothing. The book is the confirmed one when there is one, else the price the catalog states
today (`catalogPrice`), else none. **Priced own key = the dollar limit of #540 plus the token cap as a ceiling; unpriced = the
token cap and the clock.** `maxTotalTokens` (prompt, cache and completion tokens in all; default 4,000,000, the instance setting
`own_key_max_total_tokens`, changed in the admin portal under Limits) always applies to an own key, so a free model (a $0 book) or a
cheap one is still bounded. The cap counts every call at the largest of what it states: its counts, the total it states, and
reasoning stated on top of the completion; a call whose usage was not read counts the estimate of its input and the whole output
allowance. The result reports `costUsd: null` when any call is unpriced, and billing charges the minutes only. A call with no usage
at all still fails the run. The cap is read at every claim. The managed key has no cap: the dollar limit binds.

## Contract

`dynamic.cost` (`DynamicCostPolicy` in `contracts/runner-api.v1.json`) is sent only to a caller that named the claim feature
`dynamic_cost_policy`; a job that carries one and meets a caller without it ends `dynamic_engine_unavailable` before any credential
exists. The runner reads it as strictly as the app writes it. A run stopped by the cap reports `stoppedEarly: "token_limit"`.

## A mixed fleet

The feature `dynamic_cost_policy` is named by the caller that runs the job. A runner of the previous release names none and is
never handed a policy; a native job needs the new runner anyway (it needs the passthrough proxy). On the hosted path the
Dispatcher's claim cannot know what its Worker can do: it runs the checks (so a managed model without a confirmed price is refused
before any VM starts), and the Worker's fetch ends a job that carries a policy with `dynamic_engine_unavailable` if the Worker image
is older (a VM was started for nothing, once; nothing ran). The rollout order is therefore: runners and Worker images first, then the
wiring that makes an entry native. A runner of the release of #578 that does not know #555 refuses a job of a provider outside the registry as `invalid_job` (it reads `llm.provider` against its registry), so the same order holds for catalog providers: the runner and the Worker image first.

## Where the key goes (#578, #555; needs a security review)

The key of a native job is held by the supervisor in the VM and sent to one address; the engine never sees the key or the address. The
rule for that address depends on the provider, and the same rule is applied by the app (before the claim carries an entry) and by the
runner (before the key is used):

- **A registry provider** (`anthropic`, `openrouter`): the registry's own API address (`registry-addresses.ts`; the runner pins the
  same, `llm_providers.py`). The catalog's address is not trusted for them; one that differs ends the job
  (`upstream_not_registry`).
- **Any other provider of the catalog** (BYOK, #555): exactly the address #548 **trusts** for it, which only the catalog's rules can
  set: the first safe address seen (https, port 443, a public host), changed only by an admin's confirmation (`url_changed`
  and `rejected` providers carry no entry: `provider_url_blocked`). A workspace types no address; a project names a provider and a
  model and nothing else. The claim carries the address in `dynamic.modelEntry.upstreamBaseUrl`. Two more checks, the same on both sides
  (`catalog-address.ts`, `runner/.../passthrough/destination.py`, held to the shared `contracts/key-destination-vectors.json`):
  the address is a plain public https address in **exactly one spelling** (lower-case name of at least two labels, no default port, no
  trailing slash, a plain path of letters, digits and `. _ ~ -`, and **never an IP address of any kind**: IPv4 or IPv6, bracketed, with a zone id,
  mapped or in a number spelling, so that neither side has to agree on which literals count as public; an address a row holds in any other spelling ends the job
  `upstream_invalid`, and the runner refuses it as `invalid_job`); and the entry is of the provider the key is for (the id of the entry
  is the slug with hyphens). The runner then connects to that exact string; the connection resolves the name, judges **every**
  address it resolves to, connects to the address it judged, speaks TLS to the name and follows no redirect
  (`passthrough/upstream.py`).
- **What this does not do.** The runner has no address list of its own for such a provider, so it cannot tell a trusted public name
  from another public name; that is the catalog's trust record (the app never builds an entry from an address that is not trusted).
  The residual risk is the one #548 accepted: the first safe address models.dev states for a provider is trusted (except for the providers whose SDK address `contracts/opencode-providers.v1.json` records: that address is the trusted one from the start, and a different address models.dev states waits for an admin, `models-dev/plan.ts`). The picker, the key and the choice offer a provider only if the claim would build its entry (`native-providers/catalog.ts`, the canonical address). A committed
  address per provider (a pin like the registry's) would remove it at the cost of a hand-kept list; it is a follow-up for the
  security review, not part of this rule.
- **The pin of a selection (#588).** What the first-sight trust cannot do is held by the selection: when a project selects a catalog
  provider, the address the catalog trusts at that moment is written once into the project's settings (`dynamicProviderAddress`,
  `review-settings/provider-pin.ts`; the server writes it, a request cannot). The claim carries it as `Selection.pinnedAddress` and
  `entryFor(ref, pinned)` serves the entry only when the catalog still trusts exactly that address; otherwise the job ends
  `provider_address_changed` (free, `entry_provider_address_changed` in the log, no address in it) before any key exists. Nothing
  moves the pin but the person: selecting another provider pins the new provider's address, and the "Confirm the new address" action
  of the settings page (`confirmProviderAddress: true`) pins what the catalog trusts now. Writing or moving a pin that way is for the roles
  that manage the workspace's LLM key (`review-settings/README.md`, "Who may move it"). A selection made before pins existed has
  none; its first claim pins the address it is about to send the key to (`ClaimDeps.providerPins.adopt`, a compare-and-set on the
  project's settings, so two claims cannot pin two addresses) and holds to it from then on. The "Test key" of a catalog provider
  holds to the same pins (`llm_provider_address_changed`, nothing sent). **The registry's two providers get no pin**: their address
  is a constant of the code, which is stronger and cannot go stale when a release changes it.
- **The limit of the pin (#614).** The pin is trust on first use kept per project, not a committed address. Dropping a pin that is
  still the address the catalog trusts needs no right (a Member may switch provider, reset or clear a project), so a Member can
  clear every pin of a provider while the catalog address is the one they were made at, and pin again after the catalog moved it:
  that pin is a first sight, taken at the moved address. What holds: a pin that the catalog no longer trusts cannot be dropped,
  replaced or confirmed without the right to manage the workspace's LLM key, a pin another project of the workspace holds
  differently cannot be written without it, and the "Test key" counts the pins of **every** project of the workspace for the
  provider, also one on Diff Review or switched off (a Member cannot leave its pin out of the test by switching the project over).
  What does not: an address the catalog moved while no project of the workspace held a pin for the provider. A dormant pin per
  provider that outlives the projects, or a committed address, would close it; neither is built, as the registry's two providers
  already have the committed one.

## What #555 added

- **Done in #555.** The selection accepts a catalog slug for a Dynamic job on the own key (`llm/selection.ts`, `nativeModels`; the
  selection carries `catalog: true`); the project settings store a catalog provider and model for Dynamic Review
  (`review-settings/native-choice.ts`, `MODEL_NOT_IN_CATALOG`); the key per catalog provider is stored and revealed
  (`native-providers/lookup.ts`, `keyFor`); the claim's `costOf` builds the entry with `entryFor` and answers a catalog selection
  with `llm_model_unavailable` (a row that is gone) or `llm_provider_unsupported` (a provider that cannot carry a key); the workspace
  UI shows the token cap and the price source (`native-providers/ui/own-key-cost-note.tsx`).
- #554: the catalog view already says why a model is refused (`MANAGED_REASON_COPY`, including the two cache reasons); the
  correction form should suggest the input price as the upper bound for a missing cache read (a hint, nothing is filled in).
