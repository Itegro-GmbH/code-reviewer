# Bringing up the second App (factory): the owner's checklist

The pipeline lane for a second App exists but is dormant (`docs/deployment-vercel.md`, section 5.8). This is what you
do to switch it on. **Four steps are mandatory; everything after them is optional or deferred.** Nothing here changes
code-review.com until the `/dispatcher` entries of step 3: the Dispatcher then reads the registry and the operator
credential, which is why step 3 ends with a run that has the switch still off.

## Mandatory

1. **Create the database.** A Neon project in Frankfurt (or another region near the Vercel projects) with one database.
   Use the **direct** connection host, not the pooler (the App takes session advisory locks). Create the two roles with
   the SQL of `docs/deployment-vercel.md`, section 2 (migrate role and app role). Keep two URLs: the migrate role's and
   the app role's.
2. **Create the Vercel project.** In the existing team, root directory `app`, "Include source files outside of the Root
   Directory" on, Node.js 24.x, framework Next.js, Git auto-deploy off, *Protection Bypass for Automation* on. Note the
   project id and the bypass secret. The production alias `https://<project>.vercel.app` stays unprotected: it is the
   App's address (`BETTER_AUTH_URL`).
3. **Run the bootstrap, then fill Infisical.** `tools/factory-bootstrap/factory-bootstrap.sh` prints every entry and
   setting; `tools/factory-bootstrap/factory-bootstrap.sh --out <new file outside the repository>` also generates the
   five random secrets into that file (mode 0600, never printed). Put each value into its key (the script's table says
   folder and key), add the Secret Sync from `prod` `/app-factory` to the new Vercel project, then **delete the file**.
   Put the database URLs, the project id, the bypass secret and the App's address into their keys too. The App's own keys
   are not only the secrets: `PRODUCT_ID` (`factory`, **mandatory**; without it the project starts as code-review.com; the build copies it into
   `NEXT_PUBLIC_PRODUCT_ID` for the crash page, so that one is not set by hand, and a mismatch is logged at start),
   `PRODUCT_CAPABILITIES` (`review,dynamic-review`, billing off; `implementer` is allowed on this product but stays off until the rollout of the Implementer sets it, and then needs `dynamic-review`; the rollout is the section "Switching on the Implementer" below), `RUNNER_DISPATCH` (`webhook`), `RUNNER_WEBHOOK_URL` (the
   Dispatcher's `/dispatch` address), `RUNNER_WEBHOOK_KEY_ID` (`factory-k1`), `RUNNER_DISPATCH_MAX_RUNNING` (`2`) and, if the
   Dispatcher is protected, `RUNNER_WEBHOOK_BYPASS_TOKEN`. In `/dispatcher` put `DISPATCHER_APPS` (its `keyId` and
   `maxRunning` are the key id and the cap above) and the references to the App's token, its signing secret and the operator
   token. The script's table is the complete list, with the value or reference of each. Then run *Deploy production* once
   with the switch still off: its canary proves that the Dispatcher starts with the new registry.
4. **Set the repository variable `FACTORY_ENABLED` to `true`** (Settings, Secrets and variables, Actions, Variables) and
   run *Deploy production*. Do it only after the Dispatcher with the App registry and the App with the capability set
   are released. The first run stops at `apps-check` (`app_unreachable: factory`), because the second project has nothing
   live yet: promote its staged deployment by hand once (`docs/deployment-vercel.md`, section 5.8, "The first promotion
   needs one manual step"). Nothing of code-review.com depends on it.

## Optional or deferred

| Item | When you need it | Without it |
|---|---|---|
| The brand name of the second App | Before any user sees it. Everything it says (pages, mails, the check run and the GitHub App on GitHub) comes from one value, `app/src/product-identity/factory.ts`: the name is a one-line change there. Until then it is the codename "Factory", with no domain of its own (the address is `BETTER_AUTH_URL`). The browser icons are the shared mark | The App runs as "Factory" |
| GitHub App for the second App | The first real review. One click in its admin portal (Integrations) creates it from the manifest | Login, workspaces and settings work; GitHub is shown as not connected |
| A model key | The first review | Enter a workspace key in Settings, LLM access |
| Own domain and DNS | A brand launch | It runs on the `vercel.app` address; moving later means editing the GitHub App's three URLs and `BETTER_AUTH_URL` |
| Mail (SMTP sending domain) | Invitations, email verification, password reset | No mail: the first administrator comes from the setup wizard, sign-up stays closed |
| Stripe and legal URLs | Billing | The capability `billing` is off: no route, no page |
| Final product name and logo | Before anyone outside sees the App | The codename `factory` is shown |
| PostHog, landing page | Never for the second App | The App has no such code path |
| Making the lane a gate for the release | When the second App has users | A failure of the lane fails the run but never blocks code-review.com. It can delay the Dispatcher's promotion by the time limits of the lane's jobs (section 5.8) |

## Changing the capability set later

The pipeline's `health-factory` compares the staged second App's capabilities with the repository variable
`FACTORY_EXPECTED_CAPABILITIES` (unset: `dynamic-review,review`, the default; sorted alphabetically, comma separated, no
spaces). When a new capability is added to the second App, release the code that allows it first, then change
`PRODUCT_CAPABILITIES` (Infisical `prod` `/app-factory`) and the repository variable **together** and run *Deploy
production* once (`docs/deployment-vercel.md`, section 5.8). If only one of the two is changed, `health-factory` fails with
`PRODUCT_MISMATCH`, the staged App is not promoted and nothing live changes; set the other one and run it again. The Implementer is the first case; its steps, with the order they need, are in "Switching on the Implementer" at the end of this page.

## After step 4

Run `pnpm --dir app setup-code` against the new database (with its migrate URL) and finish the setup wizard in the
browser: single tenant, sign-up closed. To go back: set `FACTORY_ENABLED` to anything but `true`; it is a repository
variable, not a variable of the environment `production`. To restore an earlier deployment of the second App: *Rollback
production* with `factory_deployment`.

## Switching on the Implementer (the rollout)

The Implementer ([`implementer.md`](implementer.md)) is dormant in every release: the code is on `main`, the factory's
capability set does not name it, the Dispatcher does not serve its kind, and no page, route or job exists. Nothing on
code-review.com is touched at any step: no Infisical key, no Vercel setting, no variable. Names and values only below, never
a secret. The order matters; each step has a check and a way back.

**Before you start.** Read "State of the code when this guide was written" in [`implementer.md`](implementer.md). While the
runner job is not merged, or while the Sandbox Launcher advertises `pr-agent` and `opencode` only, steps 1 to 7 are safe but
no task runs: the Dispatcher answers a wake-up call for the kind with `ignored` and `not_capable` and the app stops resending
it. Run the smoke test only after both are in the release.

| # | Step | Who | Check | Rollback |
|---|---|---|---|---|
| 1 | Release the code to `main` (the pull request from `development`). The pipeline migrates the factory database first (two empty tables), stages, runs `health-factory` with the old set (`dynamic-review,review`), the canary (the Worker image changed, so the snapshot is rebuilt and Diff and Dynamic must pass) and promotes the App, the factory and the Dispatcher | lead | *Deploy production* is green; `apps-check` and `health-factory` are green; the factory answers `GET /api/health` with `dynamic-review,review`; the Implementer page is `404` | None needed, the release is dormant. A bad release: *Rollback production* ([`deployment-vercel.md`](deployment-vercel.md), section 7) |
| 2 | Only after step 1 is live: Infisical `prod`, folder `/dispatcher`, key `DISPATCHER_APPS`: in the factory entry set `kinds` to `["diff","dynamic","implementer"]`, everything else as it is. Optional: an `implementer` entry of `DISPATCHER_WORKER_CONFIG` (sizes, `timeoutSeconds`; the defaults need none). Wait for the Secret Sync, then run *Deploy production* once, which redeploys the Dispatcher. Earlier, the old Dispatcher refuses the unknown kind at start and the reviewer has an outage | lead | The Dispatcher starts (the canary of that run is green, `apps-check` passes); no `worker_config_invalid` in its log | Set `kinds` back to `["diff","dynamic"]`, remove the `DISPATCHER_WORKER_CONFIG` entry, deploy again |
| 3 | Together: Infisical `prod`, folder `/app-factory`, key `PRODUCT_CAPABILITIES` = `review,dynamic-review,implementer`, and the repository variable `FACTORY_EXPECTED_CAPABILITIES` = `dynamic-review,implementer,review` (sorted, no spaces). Then run *Deploy production* once. One of the two alone makes `health-factory` fail with `PRODUCT_MISMATCH`: nothing is promoted, nothing live changes (safe and loud) | lead | `health-factory` is green; `GET /api/health` of the factory lists `dynamic-review`, `implementer`, `review`; the Implementer item is in the factory's sidebar between QA and Runs | Remove `implementer` from `PRODUCT_CAPABILITIES` and reset (or delete) the repository variable, deploy again. The Dispatcher entry and the GitHub permission may stay |
| 4 | Raise the maximum cost per review in the factory's admin portal (General, Limits, "Maximum cost per review") from the default of 1.00 USD to 5.00 USD, the owner's per-turn maximum. It is the only brake of a turn: there is no step limit | owner or lead | The task form's cost field names 5.00 USD as its upper bound | Set it back to the earlier value; a running turn keeps the limit it was claimed with |
| 5 | GitHub: the factory's App needs Contents **Read and write**. An **existing App** created from the earlier manifest: change the permission in the App's settings on GitHub, and then the owner of every installation (the person or an owner of the organization) opens the installation and clicks to accept the new permissions. Until then the form lists the repository as disabled, with the note "approve the new GitHub permission". An App created after step 3 (one click in the admin portal) asks for it from the start. [`github-app.md`](github-app.md), "The Implementer" | owner | *Check the permissions* on the Integrations page no longer lists Contents; the repository is selectable in the Implementer form | Set Contents back to Read-only on GitHub; the Implementer refuses the repository again, nothing else changes |
| 6 | A model: a workspace key in Settings, LLM access (a provider of the models catalog), or released catalog entries that serve Dynamic Review in the admin portal | owner | The model picker of the form lists at least one model | Remove the key or release |
| 7 | Optional: if reviews wait behind tasks, raise `RUNNER_DISPATCH_MAX_RUNNING` (`/app-factory`) and `maxRunning` of the factory entry of `DISPATCHER_APPS` to the same number; their sum over all Apps must fit the team's Sandbox concurrency | lead | Two reviews and two tasks run at the same time | Both back to 2 |
| 8 | The live smoke test, a throwaway repository and a trivial task: [`implementer-smoke-test.md`](implementer-smoke-test.md) | lead | Every row of the test passes and the result is written into issue #768 | Step 3's rollback, then fix and run it again |

Three things to know. The permission update is an action of the owner, not a decision: a task can be started only after it.
The cost limit applies to every turn, and a person can ask for a lower one. And the Worker image changes in the release of step
1: the first run rebuilds the golden snapshot (section 5.1 of the deployment guide), which the smoke test measures.
