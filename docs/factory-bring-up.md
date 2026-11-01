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
| GitHub App for the second App | The first real review. One click in its admin portal (Integrations) creates it from the manifest. With the Implementer, click only after the deploy that puts `implementer` into `PRODUCT_CAPABILITIES` ("Switching on the Implementer", step 5), or the App gets Contents read-only and needs a manual update. With tenancy `multi` the App is public | Login, workspaces and settings work; GitHub is shown as not connected |
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

**Before you start.**

- **Step 2 is the first real proof of the engine, and it can block a release, code-review.com's included (#797).** The
  Sandbox Launcher advertises `implementer` only when `DISPATCHER_APPS` names the kind, and `POST /probe` then requires the
  canary report to name it. The canary VM runs a second probe in the Implementer's container profile (the work volume made as a
  job's is); the two halves do not take each other down. If the second half cannot run, is no verdict, or fails a check
  (`implementer_git_too_old`, `implementer_work_dir_not_exec`, an invalid `DISPATCHER_WORKER_CONFIG` entry and others), the
  Dynamic verdict stands and the report says `implementer_probe_failed` (or the Implementer's own reason). `POST /probe` answers
  `503`, and the canary of the workflow prints
  `canary: passed engines=pr-agent,opencode reasons=implementer_probe_failed missing=implementer, the release is blocked`.
  Then `promote-app`, `promote-factory` and `promote-dispatcher` do not run: **nothing staged in that run is promoted, the
  reviewer's App and Dispatcher included**. The live deployments stay as they were, so nothing breaks, but every change waiting
  for that deploy waits too. There is no switch that waives the proof. The way back is the one in step 2. Do step 2 when no
  other release is waiting.
- **Time.** With the kind the canary adds the work volume and a second container: 110 seconds more, so 260 seconds by default
  (`DISPATCHER_PROBE_TIMEOUT_SECONDS` 150 plus 110). The deploy canary's request gives up at 300 seconds, so with the kind keep
  `DISPATCHER_PROBE_TIMEOUT_SECONDS` **at or below 190**, or the canary reports `probe_unreachable` and blocks the release
  although the Dispatcher would still have answered ([`dispatcher/README.md`](../dispatcher/README.md)).
- Step 1 is an ordinary release. Steps 3 to 7 cannot stop the reviewer's release: the worst case of step 3 is a failed
  `health-factory` when its two settings disagree, which holds back only the factory's promotion.
- Take the baseline of [`implementer-smoke-test.md`](implementer-smoke-test.md) (one Diff and one Dynamic review on the first
  App) before step 2.
- Open points, none of them a blocker for the rollout: the end to end journey of the privileged lane (#767) is not merged, the
  usage of a stopped turn is not recorded (#799), and the registry exfiltration of #784 must be closed before external users.

| # | Step | Who | Check | Rollback |
|---|---|---|---|---|
| 1 | Release the code to `main` (the pull request from `development`). The pipeline migrates the factory database first (two empty tables), stages, runs `health-factory` with the old set (`dynamic-review,review`), the canary (the Worker image changed, so the snapshot is rebuilt and Diff and Dynamic must pass) and promotes the App, the factory and the Dispatcher | lead | *Deploy production* is green; `apps-check` and `health-factory` are green; the factory answers `GET /api/health` with `dynamic-review,review`; the Implementer page is `404` | None needed, the release is dormant. A bad release: *Rollback production* ([`deployment-vercel.md`](deployment-vercel.md), section 7) |
| 2 | Only after step 1 is live: Infisical `prod`, folder `/dispatcher`, key `DISPATCHER_APPS`: in the factory entry set `kinds` to `["diff","dynamic","implementer"]`, everything else as it is. Optional: an `implementer` entry of `DISPATCHER_WORKER_CONFIG` (sizes, `timeoutSeconds`; the defaults need none; a wrong value fails the canary of a deployment that serves the kind). Wait for the Secret Sync, then run *Deploy production* once, which stages and proves the Dispatcher with the kind. Earlier than step 1, the old Dispatcher refuses the unknown kind at start and the reviewer has an outage | lead | The canary of that run is green and its report names `implementer`; `apps-check` passes; no `worker_config_invalid` in the Dispatcher's log. A `503` with `reasons=implementer_probe_failed missing=implementer` is the failure described above (the log of the Dispatcher names the half: `canary_implementer_probe_failed`, `canary_implementer_not_proven`). Also keep an eye on the time: `DISPATCHER_PROBE_TIMEOUT_SECONDS` at or below 190 | Set `kinds` back to `["diff","dynamic"]` (and remove the `DISPATCHER_WORKER_CONFIG` entry if you added one), wait for the Secret Sync and run *Deploy production* again: the Launcher advertises nothing new, the canary passes and the held changes are promoted |
| 3 | Together: Infisical `prod`, folder `/app-factory`, key `PRODUCT_CAPABILITIES` = `review,dynamic-review,implementer`, and the repository variable `FACTORY_EXPECTED_CAPABILITIES` = `dynamic-review,implementer,review` (sorted, no spaces). Then run *Deploy production* once. One of the two alone makes `health-factory` fail with `PRODUCT_MISMATCH`: nothing of the factory is promoted, nothing live changes (safe and loud) | lead | `health-factory` is green; `GET /api/health` of the factory lists `dynamic-review`, `implementer`, `review`; the Implementer item is in the factory's sidebar between QA and Runs | Remove `implementer` from `PRODUCT_CAPABILITIES` and reset (or delete) the repository variable, deploy again. The Dispatcher entry and the GitHub permission may stay. What it does to tasks: the Implementer's routes and page are `404` at once, so nothing new can be started. A turn that is **running** keeps its lease and finishes; the app no longer switches off its write token when it ends (the revoke and the retry steps ask for the capability), so that token lives out its lifetime of up to an hour. A turn that is **queued** is still sent to the Dispatcher; when a Worker fetches it, the app refuses the token (`implementer_engine_unavailable`, not billed). With `kinds` set back as well, queued turns end `no_capable_runner` instead. Wait for running tasks to end before you roll back |
| 4 | Set the maximum cost per review in the factory's admin portal (General, Limits, "Maximum cost per review") to 5.00 USD, the owner's per-turn maximum; the default is 1.00 USD until then. It is the only brake of a turn: there is no step limit. **The setting is the cap of every job the factory claims**, so it also loosens the factory's own Dynamic and Diff reviews (a project's own lower limit still applies) | owner or lead | The task form's cost field names 5.00 USD as its upper bound | Set it back to the earlier value; a running turn keeps the limit it was claimed with |
| 5 | The factory's GitHub App. **Main path: one click in the admin portal, after step 3 is deployed.** Open Integrations in the admin portal and press *Create the App with one click*; the manifest asks for Contents **Read and write** because the capability is on ([`github-app.md`](github-app.md), "One click"). Then install the App on the repositories (*Connect GitHub* on the workspace's Connections page, *Only select repositories*). **Never click before the deploy of step 3:** an App created earlier gets Contents read-only. Fallback only: an App that exists already (created before step 3, or from the earlier manifest) is updated by hand on GitHub, and then the owner of every installation accepts the new permissions ([`github-app.md`](github-app.md), "Update an existing App"); until then the form lists the repository as disabled, with the note "approve the new GitHub permission". **Tenancy:** the factory is `multi` today, and then the manifest creates a **public** App: anybody on GitHub can install it on their own account or organization and chooses the repositories it gets; an installation gives the App access to those repositories only, and no workspace uses an installation until an Owner or Admin who owns the GitHub account (or is an owner of the organization) has linked it. Who may create a workspace is the sign-up rule: keep sign-up closed until #784 is closed | owner | On GitHub, the App's Contents permission shows **Read and write**; the portal's *Check the permissions* lists nothing missing; the repository is selectable in the Implementer form | Delete the App on GitHub (and its configuration in the portal), or set Contents back to Read-only; the Implementer refuses the repository again, nothing else changes |
| 6 | A model: a workspace key in Settings, LLM access (a provider of the models catalog), or released catalog entries that serve Dynamic Review in the admin portal | owner | The model picker of the form lists at least one model | Remove the key or release |
| 7 | Optional: if reviews wait behind tasks, raise `RUNNER_DISPATCH_MAX_RUNNING` (`/app-factory`) and `maxRunning` of the factory entry of `DISPATCHER_APPS` to the same number. For two reviews and two tasks at the same time it must be **at least 4**; the sum over all Apps must fit the team's Sandbox concurrency | lead | Two reviews and two tasks run at the same time | Both back to 2 |
| 8 | The live smoke test, a throwaway repository and a trivial task: [`implementer-smoke-test.md`](implementer-smoke-test.md) | lead | Every row of the test passes and the result is written into issue #768 | Step 3's rollback, then fix and run it again |

Three things to know. The permission is an action of the owner, not a decision: a task can be started only after it. The
cost limit applies to every turn, and a person can ask for a lower one. And the Worker image changes in the release of step
1: the first run rebuilds the golden snapshot (section 5.1 of the deployment guide), which the smoke test measures.
