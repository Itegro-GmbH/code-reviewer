# LLM access

A workspace brings its own LLM key (bring your own key, BYOK; `docs/decisions/0001-editions-setup-and-accounts.md`,
sections 2.7 and 2.8), or, where an operator has set its key mode to `managed`, uses the operator's own key (below). An Admin or an Owner enters it under **Settings → LLM** of the workspace
(`/w/:workspace/settings/llm`), one card and one key for **each registered provider** (#426); removing a key is a danger zone under **Settings → Advanced**, one button for each provider that has a key. The app
hands the key of the job's own workspace to the runner with every job. The former `LLM_PROVIDER` and `LLM_API_KEY`
variables are not read; `LLM_MODEL` and `LLM_MAX_TOKENS` are instance settings.

## Providers

The providers the app supports are a closed list in code, `src/llm/providers/` (ADR 0005, section 2.4; epic #420).
**Adding a provider means adding an adapter** in a folder next to `openrouter/` and listing it in `index.ts` and
`server.ts`; no other file names a provider (the structure test `providers/structure.test.ts` fails on a new mention,
with a short allow-list for the runner contract, which is the next issue).

An adapter (`providers/types.ts`) has two parts, because client components import the first and must not reach the
network:

| Part                                | Members                                                                                                                                                                                             | Listed in   |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| **Descriptor** (data, pure rules)   | `id` (`^[a-z][a-z0-9_]{1,31}$`), `label`, `apiBaseUrl`, `secretNames` (`workspace`, `operator`), `checkModelId`, `suggestedModels`, `priceOf`, `defaultModels` (`diff`, `dynamic`), `costReporting` | `index.ts`  |
| **Operations** (the server's calls) | `testKey` (the "Test key" button), `checkModelCapabilities` (the model metadata)                                                                                                                    | `server.ts` |

`registry.ts` validates a list when the module loads (`ProviderRegistryError`, stable codes `registry_empty`,
`provider_member_missing`, `provider_member_invalid`, `provider_id_duplicate`, `provider_secret_name_taken`) and gives
the lookups: `get`, `find` (a request's or a stored binding's text, trimmed and case-insensitive), `labelOf`, `ids`.
The **first adapter is the default provider** (`DEFAULT_LLM_PROVIDER`): the one a request that names none, the
operator's key and the cost estimate use, until a project can choose (the next issues of the epic).
`LLM_PROVIDERS` and `LlmProvider` (`config.ts`), `OPERATOR_LLM_KEY_NAMES` and `WORKSPACE_LLM_KEY_NAMES` (`secret-names.ts`)
are derived from it.

What moved behind the adapter, with the module that stays and does the part that is the same for every provider:

| Was                                          | Now                                                                                                                                                                                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API address in `endpoint.ts`                 | `apiBaseUrl`; `endpoint.ts` keeps the test-stack override (`ALLOW_TEST_LLM_ENDPOINTS`)                                                                                                                                                                                                |
| The key test in `key-test.ts`                | `testKey`; `key-test.ts` keeps the limits per workspace and for the instance                                                                                                                                                                                                          |
| The metadata read in `model-capabilities.ts` | `checkModelCapabilities`; `model-capabilities.ts` keeps logging and the short memory, **keyed by provider and model**                                                                                                                                                                 |
| `MODEL_NAME_PATTERN`                         | `checkModelId`, used through `isModelId` (`config.ts`)                                                                                                                                                                                                                                |
| `review-settings/model-pricing.ts`           | `priceOf` and `suggestedModels`                                                                                                                                                                                                                                                       |
| `DEFAULT_LLM_MODEL`, `DEFAULT_DYNAMIC_MODEL` | `defaultModels.diff`, `defaultModels.dynamic` (the exports stay)                                                                                                                                                                                                                      |
| `llm_api_key`, `operator_llm_key`            | `secretNames`. **They never change**: the ciphertext is bound to the name, so a stored key would stop decrypting (ADR 0005, 2.5). An operator name must differ from the fixed secret names (`src/secret-names/`; `composeSecretNames` in `src/admin/secret-names.ts` refuses a clash) |
| `OPERATOR_KEY_PROVIDER`, `?? "openrouter"`   | `DEFAULT_LLM_PROVIDER`                                                                                                                                                                                                                                                                |

`costReporting` says how the cost of a call is known (every cost limit and the billing rely on it):
`provider_reported` when the provider states the charge of every answer (OpenRouter), `computed_from_usage` when it
states token counts only and the runner prices them with the adapter's price list (Anthropic, below) and `none`.
Nothing reads the value for a decision: the runner decides per provider (`runner/README.md`, "LLM providers").

The providers today are **OpenRouter** (the default, first in the list) and **Anthropic**. A workspace has **one key per
provider** since #426 (below, "The keys of a workspace").

### Anthropic (Claude API, direct; #511)

`providers/anthropic/` is the adapter for the Claude API, the provider the managed key buys its tokens from.

| File              | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `models.ts`       | **The model list**: fixed and curated, defined in code (the catalog decision of 2026-10-18). Per model: id, display name, context window, max output, the flags `temperature`, `topP`, `tools`, `forcedToolChoice`, `thinkingDisabled`, the review kinds, the prices per MTok (input, output, cache read, cache write 5 minutes and 1 hour, and the higher tier of Haiku 5.5), Anthropic's retirement commitment. The source URLs and the day it was read are in the comment on top |
| `descriptor.ts`   | The descriptor, derived from the list: `checkModelId` is membership of the list (no alias, no prefix, no case folding), `suggestedModels` is the list, `priceOf` the list price for the cost guard                                                                                                                                                                                                                                                                                  |
| `capabilities.ts` | `checkModelCapabilities` is answered from the list, without a request: `supported` for a model a Dynamic Review can use, `unsupported` for one that is listed but cannot, `unknown_model` for any other id                                                                                                                                                                                                                                                                          |
| `key-test.ts`     | `testKey`: `GET /v1/models?limit=1` (free) with `x-api-key` and `anthropic-version`; the same failure classes and cleaning as every adapter                                                                                                                                                                                                                                                                                                                                         |
| `adapter.ts`      | The descriptor and the two operations                                                                                                                                                                                                                                                                                                                                                                                                                                               |

- **The list is closed.** Whoever brings the key, only a listed model can be chosen. `contracts/anthropic-models.v1.json`
  is the single record: the runner keeps its own typed copy to price calls (`anthropic_models.py`) and tests compare the
  three. To update after Anthropic changes its lineup: read the models, pricing and deprecations pages, change
  `models.ts`, the contract file and the runner's copy together, change `ANTHROPIC_MODELS_AS_OF`, run the tests.
- **Defaults.** Diff: `claude-haiku-5-5`. Dynamic: `claude-sonnet-5-5` (the reason is in `models.ts`; it was Sonnet 5 until #533).
- **Review kinds.** Every model of the list serves Diff and Dynamic. A Dynamic Review needs tools and an answer through
  the engine's `StructuredOutput` tool; the engine forces that call and its history cannot carry thinking blocks. Fable 5.1,
  Opus 5.5 and Sonnet 5.5 answer a forced tool choice with a 400 and Fable 5 (like those three) cannot switch thinking
  off, so the runner's wire steers them (#533): `tool_choice: auto`, a strict return tool, an instruction, and the
  thinking blocks given back per tool call (`runner/README.md`, "Anthropic"). Until then they were Diff only and a claim
  of a Dynamic job on one of them failed with `dynamic_model_features_unsupported`. The flags `forcedToolChoice` and
  `thinkingDisabled` are what the runner reads; `checkModelCapabilities` answers `supported` for all of them.
- **Sampling.** `temperature` and `top_p` are a 400 from Opus 4.7 on. The flags of the list decide what a request may
  carry, in the runner too; nothing is guessed from a name.
- **Cost.** Anthropic returns token counts and no charge. The runner computes the cost of every call from the counts and
  the list prices, exactly (`runner/README.md`, "Anthropic"); a model that is not listed, or an answer that cannot be
  priced, is an unknown cost: billing charges the minutes of that run and no AI price.
- **Egress.** The app asks `api.anthropic.com` (HTTPS 443) for the key test only; the runner sends the model calls.
- **Retirement.** `retiresNotBefore` records Anthropic's commitment. `claude-opus-4-5-20251101` (not before 2026-11-24)
  and `claude-haiku-4-5-20251001` (not before 2026-10-15, the day has passed and the model is still listed as active)
  are close to it; a model Anthropic deprecates is removed from the list in the same change that removes it from the
  contract file and the runner.

## Which key a job gets

`resolve.ts` (`resolveWorkspaceLlmAccess`, pure) decides by **the key mode of the workspace's effective entitlements**
(`src/workspaces/README.md`, "Entitlements"; `keyModeForJob`), and by nothing else. **While billing is on, that key mode is
the workspace's own choice** (below, "The key mode a workspace chooses"); the entitlement's key mode is not consulted then.
The three cases are the same:

1. **`own`, or no entitlements at all** (an instance that never configured any): the
   workspace's own key **of the provider the job is for** (the default provider until a project can choose, #426),
   stored encrypted (below), bound to that provider. A key of another provider is never taken. **The operator's key is
   never read** for such a workspace, not even when it has no key of its own: the job then fails with `no_key`.
2. **`managed`**: the operator's own key **of the provider the job is for** (#276, #427, below), source `operator`. The
   workspace's own stored key is ignored (it stays stored, not deleted) and is **never a fallback**: the entitlement
   says which key is used. Without a readable operator key for that provider the job fails with `llm_not_configured`
   and the reason `operator_key_missing` or `operator_key_unreadable`; the operator's key of another provider is never
   used instead.
3. **Entitlements that cannot be read** (`entitlements_invalid`): it is not known whose key applies, so the job fails
   with `llm_not_configured` and the reason `entitlements_invalid`; nothing is chosen. (The claim has refused such a
   job already, #277; this covers the Worker's fetch, which checks again.)

The reasons of `llm_not_configured` (`LLM_NOT_CONFIGURED_REASONS`): `no_key`, `key_unreadable`,
`key_binding_mismatch`, `operator_key_missing`, `operator_key_unreadable`, `entitlements_invalid`. They are logged
with the job and drive the copy of the pages; they never hold a value.

The input of the resolver is a union on purpose (`keyMode: "own"` carries the key of the workspace for the job's
`provider`, `"managed"` carries the operator's key of the job's `provider`, `"unreadable"` carries neither), so a job of a workspace that is not managed has no place to put the
operator's key and a managed one has none for the workspace's. `assemble.ts` reads only what the mode names.

There is no step for a key in the environment: a key in `LLM_API_KEY` would be spent by every workspace that has not
brought its own. The instance that is updated gets its key into the default workspace by the import instead.

Failures **fail closed** instead of falling through to another key: a workspace key that exists but cannot be read
(another `APP_SECRET`, a changed row), one that was entered for another provider than the one it would be sent to, an
operator key that is missing or cannot be read. Using a different key would spend somebody else's money, and sending
the key to another provider would hand a credential to a party it was not entered for.

`assemble.ts` puts it together over a database (`createWorkspaceLlm`: the key service of a workspace, the operator's
key service, `accessFor`, `summaryFor`, `currentKeysFor`); it reads the effective entitlements with
`readEffectiveEntitlements` (`src/workspaces/effective-entitlements.ts`, the same function the claim's admission
uses). `shared.ts` wires it to the running server. The claim of the runner API calls `accessFor(job.workspaceId)`, so a
job never sees another workspace's key (`integration-tests/http/runner-api-llm-key.integration.test.ts`).

### The key mode a workspace chooses while billing is on (#496)

Two modes share one balance (ADR 0006, P3, D4): **our models** (`managed`: the operator's key, charged AI plus infrastructure) and
**the workspace's own provider key** (`own`: infrastructure only). With billing off nothing changes: the entitlements decide, as
described above, and a workspace without any is on its own key. With billing on:

- **One setting.** `llm_key_mode` (`managed` or `own`) in the workspace's `app_settings`, next to its review defaults
  (`key-mode-store.ts`). A workspace that has not chosen is `managed`, with or without entitlements and whatever their key mode
  says (`DEFAULT_LLM_KEY_MODE`). A stored value that is neither reads as not chosen. Nothing migrates: a workspace keeps working as
  before until billing is switched on, and then its choice, default `managed`, applies (the admin text of #504 says so).
- **One pure function.** `effectiveKeyMode({ billingOn, workspaceChoice, entitlements })` (`src/workspaces/effective-key-mode.ts`):
  billing off, the entitlement (none: the own key); billing on, the choice. The `keyMode` of an entitlements row or of
  `default_entitlements` is **not consulted** while billing is on; the suspension, `modelAccess` and the cost limits **are** (the
  cost limit that watches a run is the one of the key mode that applies). Entitlements that cannot be read are still `unreadable`
  and fail closed, billing on or off.
- **One reader.** `readEffectiveEntitlements` applies it (`applyWorkspaceKeyMode`: the entitlements with the key mode that
  applies; a workspace without entitlements stays `unlimited` and carries the mode), so the claim's admission and the balance
  check (`keyModeAtClaim`), this file's `accessFor` and `keyFor`, the model selection and the pages cannot read it differently. The
  claim passes the switch it has read for the whole claim; every other caller reads it.
- **Claim time only.** The mode is read when a job is claimed (the claim route, or the Worker's first fetch) and recorded in the
  job's usage record; settlement and the price page read the record. A change never touches a review that runs. Because the
  workspace can change at any time while billing is on, `currentKeysFor` masks the operator's keys in a result then whatever the
  mode is now.
- **Own without a key.** `own` with no stored key for the selected provider still ends `llm_not_configured`, reason `no_key`, and never
  falls back to our key. The choice route does not let a workspace pick `own` while it has no key for any provider
  (`own_key_missing`). No plan gates the own key.
- **Who.** Everybody in the workspace reads the choice; an Owner and an Admin (`manage_llm_key`, the action of the LLM access
  page) set it, with the audit line `[llm] KEY_MODE_CHANGED workspace=<id> user=<id> key_mode=<mode>`. The route is `GET` and `PUT
/api/w/:workspace/llm-key-mode` (`key-mode-http.ts`, `key-mode-service.ts`; same site, `no-store`); billing off is the 404 of a
  path that does not exist.
- **The page.** While billing is on, **Settings → LLM** starts with the choice (`ui/key-mode-card.tsx`): "Use our models" and
  "Use my own provider key", one sentence each about what is charged (AI and infrastructure, or infrastructure only; no rate, no
  formula), read-only for a Member. The tab is called **LLM** (#656). The settings of the own key (the key forms and the catalog
  providers) follow the selected option (`ui/key-mode-gate.tsx`): they are hidden while "Use our models" is selected and shown as
  soon as "Use my own provider key" is, so the key can still be saved before the choice is; the choice itself can be saved once a
  key is stored. With billing off the page is the one described under "The workspace pages" below.

## Which provider, model and entry a job gets (#431)

`selection.ts` (`resolveModelSelection`, pure, not called by the claim yet; #432 wires it) decides provider, model, catalog
entry and key source for a job **before any key is loaded** (ADR 0005, 2.8). The input is a union on the key mode like
`ResolveLlmInput`, and the job's kind is an input, never the project's current kind:

- **`own`**: the workspace and project layers of provider and model for the kind (a Dynamic job passes the project layer
  only) over the built-in model. Provider and model are paired: a model is used only for the provider that was in force
  where it was set, so a workspace model with a project provider of another provider fails with
  `job_llm_options_invalid` / `model_provider_mismatch` instead of sending the model to the wrong provider. A provider
  chosen without any model takes that provider's own default for the kind. The model must pass the rule of the provider
  that applies (`model_invalid`). A provider the app does not know or the runner did not advertise ends with
  `llm_provider_unsupported`. An own job reads no catalog and no `modelAccess`; whether the workspace holds a key for the
  provider (`no_key`) is for the caller, which loads the key the selection names.
- **`managed`**: the entry of the project, else the instance default of the kind, else `managed_model_unavailable` /
  `no_selection`. The entry must exist (`missing`), be released (`not_released`), serve the kind (`kind_mismatch`), be
  allowed by `modelAccess` (`not_allowed`, `entryAllowed`) and have a provider the app knows and the runner advertised
  (`provider_unsupported`), checked in that order. **No fallback**: a failing project entry never moves the job to the
  default entry, another provider or `LLM_MODEL` (C5). A failure carries the entry's opaque id at most, never a provider or
  a model.
- **`unreadable`**: `llm_not_configured` / `entitlements_invalid`; nothing is selected.

A selection names whose key to load (`keySource`: the workspace's key of `provider`, or the operator's key of the entry's
provider) but holds no key. An own selection has no `entry`; a managed one has no place for the workspace's key (both are
compile-time, `selection.test.ts`).

## The operator's own keys (#276, #427)

The instance admin stores **one key of the operator's own for each provider** for the workspaces whose key mode is
`managed`, in the admin portal (**LLM keys**, `/admin/llm`; `src/admin/ui/operator-llm-key-form.tsx`: one card for each
provider with its status, a write-only field, **Test key** and, while a key is stored, **Remove**). A managed job uses
the key of its own provider (`forJob(provider)`). The decision is ADR 0005, section 2.5; it extends the addendum of
`docs/decisions/0001-editions-setup-and-accounts.md`, section 2.8, which described a single key. A key stored before there
were several providers is the first provider's key and **keeps its name `operator_llm_key`, with no migration**; another
provider's key is stored under `operator_llm_key.<provider>` (its adapter's `secretNames.operator`).

| File                   | Role                                                                                                                                                                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operator-key.ts`      | `createOperatorLlmKeyService`: `status(provider)`, `statusAll`, `save({ provider, apiKey })`, `remove(provider)`, `forJob(provider)`, on the encrypted store of the instance (`src/secrets/`). The provider is named by its id **exactly** (no trimming, no case folding); an id that is not registered has no slot |
| `operator-key-test.ts` | `createOperatorKeyTestService`: the Test button. The same call to the provider as the workspace's button (`checkLlmKey`), with **counters of its own** (`operator-llm-key-test:admin:<id>`: 5 in 10 minutes for each admin; `operator-llm-key-test:all`: 60 for the instance), apart from the workspaces'           |

- **Storage.** Table `secrets`, AES-256-GCM with a key derived from `APP_SECRET`, additional authenticated data the
  table and the name. Like the workspace key, **whoever holds the database and `APP_SECRET` can decrypt it**; the form
  says so.
- **Write-only.** No answer holds the key. The portal's settings carry the status (`configured`, `unreadable`,
  `not_configured`) and the last four characters of a long key (`GET|PUT /api/admin/settings`: `operatorLlmKeys`, a
  status for each provider by its id, and `secrets`; `operatorLlmKey`, the default provider's status, stays one more
  release); an empty field saves nothing (`api_key_required`) and the rules for a key are those of the workspace key
  (`checkLlmApiKey`). The request is `{ "operatorLlmKeys": { "<provider>": { "apiKey" } | null } }`, one provider each,
  and the old `{ "operatorLlmKey": ... }` is still accepted for the default provider (`admin/operator-key-change.ts`).
  `POST /api/admin/llm-keys/:provider/test` (`{ apiKey? }`: the typed key, or the stored one of that provider) is
  rate limited with counters of its own (429, `Retry-After`) and answers a provider that is not registered `404
provider_not_found`.
- **Only the instance admin writes it.** It is **not a setting of the operator API** (`src/operator-api/`): whoever holds
  that token must not hold the key, and the API has no dependency that could reach the store. Entitlements that name a
  key are refused as unknown fields.
- **The key never reaches** a workspace member, the browser, a log line, a Runs page, a stored result or the
  Dispatcher. It leaves the process on two paths only, and on both it is remembered encrypted in `job_claimed_keys`
  before it leaves, so `maskSecretInText` masks it in the result whichever app instance serves it and after a rotation:
  1. **The legacy claim**: the claim response carries it to the runner, like the workspace key (`claim.ts`).
  2. **The Worker API** (#320): the claim of a Dispatcher carries no key; the **first fetch** of the job with the
     per-job credential mints and reveals it (`buildJobInput`, after `checkJob` chose the model and loaded the key again). A key
     that was removed or rotated between the claim and the fetch is the one the fetch uses; one that is gone ends the
     job with `llm_not_configured`.
- **The model is the operator's, per catalog entry.** While a job runs on the operator's key, the operator chooses the
  model, never the tenant (#432, ADR 0005, 2.8): the project selects a **catalog entry** per kind (`catalogEntryDiff`,
  `catalogEntryDynamic`), else the instance default entry of the kind applies, and the entry's provider, model and the
  operator's key of that provider are what the job gets, in the job, in the Dynamic options and in the capabilities
  read, on both delivery paths (`runner-api/claim-selection.ts`, `src/llm/selection.ts`). The review settings' `model`,
  provider, fallback model and Dynamic model stay stored and take effect again if the workspace goes back to its own
  key; the token budget of the job is the claim's (#689) and is cut to the context window of the entry's model when it is known. An
  entry that is missing, retired, not for the kind, not in the plan's `modelAccess` or of a provider the runner cannot
  run fails the job with `managed_model_unavailable`: no move to another entry and not to the instance's `LLM_MODEL`,
  which a managed job does not use at all. The model of an entry never reaches a workspace (not the settings, a page, a
  result, a record or a log). An **own** workspace never reads the catalog or `modelAccess` (#432-T06, T16): its
  provider and model come from its settings layers, and the key is its own key **of that provider** (`keyFor`).
  The old tiers are gone (#434); the migration turned them into catalog entries (`src/model-catalog/README.md`).
- **The Worker's fetch asks for the standing again.** A workspace suspended after the claim, or whose entitlements
  became unreadable, gets no key: the job ends with the code of the claim (`runner-api/README.md`). Quotas are not
  counted again.
- **Upgrade every app instance before setting any workspace to `managed`.** An instance of the previous release does
  not know the key mode: it would run a managed workspace's jobs on the workspace's own key and on the workspace's
  model, record them as `own` (outside the cost limit), and not read the list of remembered keys of a job as keys. Nothing leaks, but the
  operator's rules are not applied until every instance is upgraded.
- **Masking.** `currentKeysFor` returns the workspace's own key of every provider and, **while the workspace is
  managed (or billing is on, #496)**, the operator's current key of **every** provider (not only the one the job runs on: a result must not
  show any of them); the key of the claim comes from `job_claimed_keys`.
- **The usage record says the key that was used.** The claim reserves the record with the key mode it decided from the
  effective entitlements (`managed` for the operator's key; while billing is on, the workspace's choice, #496) and the key
  lookup of the claim and of the Worker's fetch follows that record (`claimedKeyMode`), so the record, the key and the
  settlement of a run cannot disagree, whatever the workspace or the operator changes while it runs. The cost limit of #277
  watches the records whose key mode is `managed` for a workspace whose entitlements say `managed`.
- **The workspace pages.** For a workspace whose key mode is managed (`instanceAccessOf` in `access.ts`), **Settings →
  LLM access** shows no key form to anybody and says that access is provided by this instance (a Member sees the same
  note); when the operator has no usable key it says so and tells the person to contact the administrator of the
  instance. The "LLM not configured" hint of the other pages becomes "LLM is not available" without a link to a
  form. The routes that save, test and remove a workspace key keep working: the key is only not used while managed.

## The keys of a workspace

A workspace has **one key for each registered provider** (#426, ADR 0005, section 2.5). Each is a row of
`workspace_secrets` under the name the provider's adapter gives it (`secretNames.workspace`): **`llm_api_key`** for
OpenRouter, the name it has always had, so a key stored before there were several providers _is_ OpenRouter's key,
unchanged (a SQL migration cannot re-encrypt without `APP_SECRET`: no schema change, no data migration), and
`llm_api_key.<provider>` for every later provider. `WORKSPACE_LLM_KEY_NAMES` is derived from the registry. The binding of
a row must equal the provider of its slot (`key_binding_mismatch` otherwise), and because the name is part of the
additional authenticated data, a ciphertext moved to another provider's name, or to another workspace, does not decrypt.

| File               | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace-key.ts` | `createWorkspaceLlmKeyService`: `status(provider)`, `statusAll()`, `save({provider, apiKey})`, `remove(provider)`, `reveal(provider)`, `keyFor(provider)`, on the encrypted store of the workspace (`src/secrets/workspace-store.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `http.ts`          | The handlers of `GET\|PUT\|DELETE /api/w/:workspace/llm-keys/:provider` and `POST /api/w/:workspace/llm-keys/:provider/test` (route files below `src/app/api/w/[workspace]/llm-keys/[provider]/`). The old `/llm-key` and `/llm-key/test` are an **alias for the default provider** with the same handlers (their body may still name `provider`, which must then be the default one). A body that names another provider than the address is `provider_invalid`; a provider in the address that is not registered is 404 `provider_not_found`, after the workspace and the role were settled (a foreign workspace gets the missing-workspace answer first) |
| `key-test.ts`      | The "Test key" button: the limits per workspace and for the instance around the adapter's `testKey` (one call to the provider; `GET /key` of OpenRouter, which costs nothing), the failure classes                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `endpoint.ts`      | The provider's API address. Not configurable by a person; the test stack points it at the fake LLM with `LLM_API_BASE_URL` together with `ALLOW_TEST_LLM_ENDPOINTS=true`, which anything else ignores                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `ui/`              | The settings section (`LlmAccessSection`, form), the hint "LLM not configured": `llmAccessAttention` builds it as an `AttentionNotice` so a page can merge it into its one "Needs attention" strip, `LlmAccessNotice` renders it on its own; the copy for the codes                                                                                                                                                                                                                                                                                                                                                                                         |

- **Storage.** Table `workspace_secrets`, AES-256-GCM with a key derived from `APP_SECRET`; the additional
  authenticated data is the table, the **workspace id** and the name of the provider's slot (above), so a row copied
  to another workspace, or to another provider's name, does not decrypt. **The operator can decrypt it by design** (the operator holds the database and
  `APP_SECRET`); the settings page says so, and the hosted terms must. This reverses the old guarantee that the
  key is "never stored": a workspace key is persisted, encrypted.
- **Write-only.** No answer holds the key. An Admin or an Owner sees whether it is configured, cannot be read, or
  is missing, and the last four characters of a long key, for each provider; a **Member sees only whether one exists**.
  An empty field keeps the stored key of that provider (`api_key_required` when it has none).
- **Never used for another provider.** The key is bound to its provider (`binding`), and every provider has a slot of
  its own, so saving, replacing or removing one provider's key never touches another's, and an empty field keeps only
  the key of that provider. A stored key is never sent to a provider or an endpoint other than the one it was entered
  for (the lesson of the SMTP password of #100): the binding is compared with the provider again when the key is
  revealed for the test button and when a job takes it (`key_binding_mismatch`).
- **Who.** `manage_llm_key` (Admin and Owner) sets, tests and removes it; every member reads the state.
- **The rules for a key** are the legacy variable's (`checkLlmApiKey`): surrounding whitespace is ignored,
  whitespace or control characters inside and more than 4096 characters are refused (`api_key_invalid`).
- **The Claude Code OAuth token (#1150).** A workspace may store what `claude setup-token` prints as a slot of the same encrypted store
  (`claude-code-token.ts`, name `claude_code_oauth_token`, binding `claude-code`), set on the same page next to the provider keys: set, replace, test, remove, shown by
  its last four characters, write-only, masked in results with the keys, in no log. It is **not a provider** (not in the registry, no models, price or address of ours),
  so no list of providers shows it; routes `GET|PUT|DELETE /api/w/:workspace/llm-keys/claude-code` and `POST .../claude-code/test`
  (`claude-code-token-http.ts`; static siblings of `[provider]`), `manage_llm_key` as for the keys, **no further restriction** (owner decision 2026-11-25).
  **The test checks the shape of the token and sends nothing to Anthropic** (the card says so). Only runs of the harness `claude-code` read it
  (`tokenForJob`); the order of the logins, what the agent can see and the hosted VMs are in [`docs/runner.md`](../../../docs/runner.md#claude-code-on-the-token-of-the-workspace-1150).

- **Test key of a catalog provider and the pin (#588).** The test of a catalog provider is held to the addresses the workspace's
  projects pinned for it (`review-settings/pinned-addresses.ts`): when any pin of a project that uses the provider (switched on, Dynamic) is not the address the
  catalog trusts now, nothing is sent and the answer is `llm_provider_address_changed`, as the claim's is `provider_address_changed`. The
  route asks that first (`LlmKeyTestService.preflight`), before a stored key is decrypted. With no pin the test goes to the trusted
  address, which is the first sight. `pinnedAddresses` of the service is required; the server's wiring is `createWiredLlmKeyTester`
  (`key-tester.ts`), which a test runs over its own database.
- **Test key.** A key typed into the field is checked as it is and forgotten; with an empty field the stored one is
  checked. The address is the provider's own, redirects are not followed, the time is limited, and the provider's
  words only appear as a cleaned first line (the key removed in every spelling, long opaque tokens blanked). Limited
  per workspace, **across providers**: one count for all of its keys (5 per 10 minutes), and for the instance (60), in `rate_limits`; counters that cannot be read refuse
  the click. **The instance budget is shared**: the workspaces of one person (a multi-tenant instance lets anybody
  create several, 10 by default) can use it up, and the button is then refused for everybody for a while. Nothing
  else is affected. The server also logs `LLM_TEST_ENDPOINTS_ENABLED` at start when the test stack's address switch is
  on. Failure classes: `llm_key_rejected`, `llm_unreachable`, `llm_provider_error`.
- **The model** is not set here. It is the `model` review setting (`src/review-settings`), whose built-in value is
  the instance's `LLM_MODEL` (default `anthropic/claude-haiku-5.5`; a wrong name is ignored with a warning and the
  default is used). **That built-in model name is visible to every member** in the model setting of the review
  defaults, as intended: a model name is no secret (decided with #144).

### Catalog providers (#555)

Besides the two providers of the registry, a workspace on its own key can store a key for **any provider of the models.dev
catalog** that the pinned engine can drive with a static key (`contracts/opencode-providers.v1.json`, #548) and run a Dynamic
Review on one of its tool-calling models. These providers are **data, not code**: they are not in the registry (its `ids`, the
cards of the two providers, the operator's keys and the masking by name are unchanged). `src/native-providers/` is the one place
that knows them (its README): `lookup.ts` lets the key service and the claim find a catalog provider by its **slug** (the hyphen
of the models.dev id is an underscore), `catalog.ts` reads what the catalog offers.

- **The slot** is `llm_api_key.<slug>` in the encrypted store of the workspace (`NativeKeySecretName`), bound to the slug. Same
  storage, write-only rule, last four characters, `key_binding_mismatch`, rate limit across providers as for any provider; the store
  accepts any slug, so there is no migration. `nativeStatuses()` lists the catalog providers the workspace holds a slot for.
- **The key routes** are the same (`/llm-keys/:provider`). Reading and removing a key work for any supported slug; saving and
  testing need a provider the catalog **offers** (not blocked by a changed address, not unlisted, with a model): otherwise 404
  `provider_not_found`, nothing stored. The test button uses the generic adapter's model-list read at the **trusted** address
  through the connect guard; "not verified" (`{ok: true, verified: false}`) is an answer, not an error.
- **Own mode only.** A workspace on the operator's key (`managed`) gets none of it: the page shows the note, the models route
  answers the 404 of a path that does not exist, the form is given no catalog data, and `keyFor` for the managed branch uses the
  registry only (a catalog provider has no operator key).
- **Masking.** The keys of the catalog providers are in `currentKeysFor`, so a result that repeats one is masked like any other.
- **Selection.** A Dynamic job on the own key whose provider is a catalog provider is a `catalog` selection (`selection.ts`,
  `nativeModels`); see `src/runner-api/README.md` for the claim.

## The variables

`LLM_PROVIDER` and `LLM_API_KEY` are **retired**: nothing reads them. `LLM_MODEL` and
`LLM_MAX_TOKENS` configure the built-in model and the context window of the instance; the import also copies a
`LLM_MODEL` that differs from the default into the review defaults of the default workspace (unless the team chose a
model), so the model survives the removal of the variable.

| Variable         | Meaning                                                                                                                                                                                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LLM_PROVIDER`   | A provider of the registry: `openrouter` (the default) or `anthropic`. Not case sensitive.                                                                                                                                                                                         |
| `LLM_API_KEY`    | Surrounding whitespace and a trailing line break are ignored; whitespace inside, control characters or over 4096 characters make it invalid.                                                                                                                                       |
| `LLM_MODEL`      | The OpenRouter name of the model reviews use unless the review settings choose another, without an `openrouter/` prefix (the runner adds it). Default `anthropic/claude-haiku-5.5` (`DEFAULT_LLM_MODEL`, the recommendation of the model comparison).                              |
| `LLM_MAX_TOKENS` | The context window of a model PR-Agent does not know (1000 to 10000000); `contextWindowTokens` in the code. Unset lets PR-Agent decide. It is **not** the token budget of a review: the claim decides that (#689) and cuts it to this window for a job on the workspace's own key. |

The limits are the ones the runner enforces on `llm.*` of a job (`runner/README.md`, `job.py`), so a value the
runner would refuse shows up as a configuration error or warning instead of as a failed job. They are copied by
hand; a contract test belongs to the runner API contracts (CR-28).

**A wrong optional variable** (`LLM_MODEL` that is
no model name, `LLM_MAX_TOKENS` that is no number in range) does not stop the reviews: it is ignored, the default is
used, and it is reported as a _warning_ (`LLM_MODEL_INVALID`, `LLM_MAX_TOKENS_INVALID`).

| File         | Role                                                                                                                                                                                                                                                                                         |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.ts`  | `readLlmDefaults(env)`: the built-in model (`LLM_MODEL`) and the context window (`LLM_MAX_TOKENS`), a wrong one ignored with a warning; `configuredLlmModel`; `checkLlmApiKey` (the one rule for a key, shared with the key routes). The former `LLM_PROVIDER` / `LLM_API_KEY` are not read. |
| `access.ts`  | `LlmAccessResult` (with its `source` or its `reason`), `revealLlmAccess` (the one way to get the key out, `LLM_ACCESS_HAS_NO_KEY` without a key), `maskSecretInText` (masks secrets in a text).                                                                                              |
| `status.ts`  | `LlmStatus`: what the UI may know about the instance's LLM defaults (the built-in model and the warnings about an ignored option). The key is a matter of each workspace.                                                                                                                    |
| `startup.ts` | `checkLlmConfigOnStart`: one warning for an optional variable that is ignored (`LLM_MODEL`, `LLM_MAX_TOKENS`) and the notes on the test endpoints. Says nothing about `LLM_PROVIDER` and `LLM_API_KEY`. Never stops the start.                                                               |

## Model capabilities

`model-capabilities.ts` asks the provider's public model metadata whether a model can do what Dynamic Review
needs (#269): `GET /api/v1/models/{author}/{slug}/endpoints` of OpenRouter, no key. `checkModelCapabilities`
answers one of

- `supported`: at least one endpoint lists both `tools` and `tool_choice` in `supported_parameters` and does not
  say it cannot force a tool choice (`supports_tool_choice.required` is not `false`, #279);
- `unsupported`: the model exists, no endpoint qualifies;
- `unknown_model`: 404, or a name that is not `author/slug` (no request is made then); a variant suffix such as
  `:free` is dropped for the lookup;
- `unverifiable`: a network error, a timeout, any status but 200 and 404 (a redirect included), an answer that is
  not JSON, over 256 KiB or not shaped like the documented answer. It never throws.

`supported` and `unsupported` carry the capabilities read: `tools`, `toolChoice`, `toolChoiceRequired`,
`responseFormat`, `structuredOutputs`, `maxCompletionTokens` (the largest limit an endpoint states, or null) and,
for the descriptor of a Dynamic job (#279), `smallestCompletionTokens`, `contextLength` (the smallest window,
null if an endpoint states none) and `inputUsdPerMtok` / `outputUsdPerMtok` (the highest prices of the endpoints a
run could use, as exact decimal text per million tokens, moved from OpenRouter's per-token text without a float;
both null when any is missing or not a plain decimal). They come from the endpoints that qualify when there are
any, otherwise from all of them, and always at the bound a reservation needs.

`dynamic-capabilities.ts` (`dynamicCapabilitiesOf`) turns them into the `dynamic.capabilities` of a job
(`DynamicModelCapabilities` in `contracts/runner-api.v1.json`): structured output is tool calling (the pinned
engine returns its findings through a tool call), the output allowance is the smaller of the model's smallest
stated limit, 8,192 tokens and half the window, prices are left out when unreadable, and a model whose metadata
states no window yields no descriptor. Nothing is invented. The claim of a Dynamic job sends it (see
`src/runner-api/README.md`).

The request goes to the provider's fixed address (`endpoint.ts`; the test stack points it at the fake LLM with
the existing switch), sends no credential, follows no redirect, has a timeout and the size limit, and the fetch is
a parameter. **Outbound call:** the app asks `openrouter.ai` (HTTPS 443, no key) on every save of a Dynamic model and on every claim of a Dynamic job whose model is not in the cache (#279); a host that cannot reach it waits at most 5 seconds and gets the `DYNAMIC_MODEL_UNVERIFIED` warning. The log line holds the model id and the outcome class only (`MODEL_CAPABILITY_CHECK`); the claim of a managed
job (#280) passes `logAs` and the line names its tier (`model=tier=high`) instead of the id.
`createModelCapabilityChecker` remembers a `supported` answer in memory for five minutes (at most 200 models), so
saving the same model repeatedly asks once; for a settings save no other outcome is remembered. **The claim of a
managed job asks with `forClaim`** (#280): it also remembers an answer that is not `supported` for 45 seconds, so a
provider outage costs one wait of the 5 second timeout per model, not one per claim and Worker fetch, and the checker
keeps the last context window it read for a model for a day (`lastKnownContextLength`), which the claim cuts the
token budget to while the provider cannot be asked (`src/model-catalog/README.md`, "The token budget of a job"). The settings save is its first user
(`src/review-settings/README.md`, "Saving a Dynamic model checks it"); the run-time enforcement is the runner
proxy's (`dynamic_model_features_unsupported`).

## Rules

- **A missing key is a state, not a crash.** The app starts, the workspace pages show "LLM not configured" with a link to
  the form, and a job fails when it is claimed (below).
- **The claim fails the job with `llm_not_configured`** and does not hand it to the runner. There is no retry loop:
  nothing a retry does can fix a missing key. The key is looked up once per claim; one entered while the app runs
  is used by the next claim, and removing it does not touch a job that runs (the runner has its key already).
- **The key leaves the process only in the claim response** (and to the provider, in the test button).
  `apiKey` is not enumerable on `LlmConfig` and `LlmAccess`, so JSON, spreads and console output leave it out; only
  `revealLlmAccess` hands it out. Issues, statuses and warnings carry names and codes only, never a value.
- **The keys of a job are remembered, encrypted, in the database** (`job_claimed_keys`, `src/runner-api/
claimed-keys.ts`: one row per job, the sealed text is the list of the keys handed out for it, newest last, at most 3, a
  key already known takes no place; a row of the earlier format, one plain key, is still read) and not in memory, so any app instance can mask a result after the key was rotated (section 2.10). The
  row goes with its job, and the cleanup removes the rows of jobs that finished a week ago.
- **Masking is best effort.** A text that comes back from a runner (`complete`) is run through
  `maskSecretInText(text, ...keys)` before it is stored. It masks the plain, percent-encoded, JSON-escaped and
  base64 form; a secret that was cut or transformed in another way is not found. Mask with the key that was handed
  out with the claim of that job _and_ the current keys of its workspace. A read of those keys that fails **fails
  closed**: `complete` answers `RUNNER_INTERNAL_ERROR` and stores nothing (`runner-api/known-secrets.ts`), it never
  masks with fewer keys.
- **The model per project** is a review setting (`src/review-settings`); it replaces the model of the access when a job is
  built, and the claim decides the token budget from the context window (#689). The provider and the key always come from here.

## Testing

`providers/registry.test.ts` (validation, with a fake second adapter that exists only in tests: `providers/fake-adapter.ts`),
`providers/structure.test.ts` (the provider is named only in its adapter), `providers/openrouter/adapter.test.ts` and
`providers/openrouter/adapter.integration.test.ts` (the adapter against the fake LLM),
`providers/anthropic/models.test.ts` (the model list: the models on offer, the contract file, prices and flags),
`providers/anthropic/adapter.test.ts` and `providers/anthropic/adapter.integration.test.ts` (the adapter, its key test against
the fake LLM), `integration-tests/http/runner-api-anthropic.integration.test.ts` (the claim of a job on this provider, on the
workspace's key and on the operator's);
`resolve.test.ts`, `config.test.ts`, `access.test.ts`, `startup.test.ts`, `endpoint.test.ts`, `model-capabilities.test.ts`, `dynamic-capabilities.test.ts` and
`../instrumentation.test.ts` (unit, no database); `workspace-key.integration.test.ts`, `workspace-keys.integration.test.ts` (one key per provider, with a test-only second provider: the keys apart, the name bound into the ciphertext, an old row), `workspace-keys-access.integration.test.ts` (which provider's key a job takes, the keys to mask), `operator-key.integration.test.ts` (one key per provider, with a test-only second provider),
`operator-key-test.integration.test.ts` (the operator's Test button and its own counters),
`operator-access.integration.test.ts` (whose key a workspace gets, over a real database; a provider without a key is `operator_key_missing`),
`key-mode.integration.test.ts`, `key-mode-http.integration.test.ts` and `ui/key-mode-card.test.tsx` (the key mode a workspace chooses while billing is on, #496; with `../workspaces/effective-key-mode.test.ts`, `../jobs/claim-key-mode.integration.test.ts` and `integration-tests/http/runner-api-key-mode.integration.test.ts`; journey `e2e/billing/key-mode.e2e.ts`),
`key-test.integration.test.ts` (real Postgres, the fake LLM over real HTTP); `ui/*.test.tsx`;
`integration-tests/http/llm-keys-route.integration.test.ts` (the per-provider routes and the alias beside them, the shared limit of the test button, no key in any answer, log or page), `integration-tests/http/llm-key-route.integration.test.ts` (the alias routes, the real route files: roles, isolation, the request,
the test button, no key in any answer or log; and a managed workspace's settings: no form, the same note for every
role, the routes still working), `integration-tests/http/runner-api-llm-key.integration.test.ts` (the claim: each
workspace's own key, no borrowing, no key from the environment, removal, masking across instances),
`integration-tests/http/runner-api-operator-key.integration.test.ts` (the operator's key on the legacy claim and the
Worker API: delivered, remembered, masked, never to a Dispatcher, the usage record's key mode),
`src/admin/operator-llm-key.integration.test.ts` (the portal's save, status, Test route and refusals; who may not), `src/operator-api/no-operator-keys.test.ts` (the operator API imports nothing that reaches a key) and the rows for
the routes in `workspace-isolation.integration.test.ts` (and for the provider-qualified secret name in `src/db/repositories/scoped-isolation.integration.test.ts`). Journey: `e2e/settings/llm-key.e2e.ts`, and the
review with the workspace key in `e2e/jobs/pull-request-to-review.e2e.ts`.
