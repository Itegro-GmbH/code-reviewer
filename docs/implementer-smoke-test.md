# The Implementer: live smoke test

What the lead runs once, on the platform, after the Implementer is released and switched on
([`factory-bring-up.md`](factory-bring-up.md), "Switching on the Implementer", steps 1 to 7). No automated test can
prove these: they need the real VM image, the real network rules, the real GitHub and the real models. Each row says how to
look and what a pass is: on GitHub, in Runs, in the cost, in the Vercel Sandbox list and in the logs. This is T03 of issue #768: the result goes into that issue as a copy of the table with the
numbers and the verdict of each row, and nothing in it names a secret. What the Implementer does is in
[`implementer.md`](implementer.md).

## Before you start

- The release with the Implementer is live and the steps of the rollout are done: capability set, Dispatcher kind, cost
  maximum, GitHub permission accepted, a model.
- The Launcher advertises the engine and the runner job is in the release ("State of the code" in
  [`implementer.md`](implementer.md) is gone). If not, stop: every task would end `implementer_engine_unavailable` or
  never be claimed (`not_capable`).
- A **throwaway repository** the factory's GitHub App is installed on (selected repositories), with a `main` branch, a
  `package.json` with no dependencies and a few lines of code. A private one is better: it makes row S11 a real handshake with
  an authenticated clone. A second one for a pull request of the first App (S12).
- The values to write down: the release commit, the time you started, the snapshot id of the live Dispatcher deployment
  (its meta, or `SANDBOX_SNAPSHOT_ID`; an id is written in the issue only if the issue is private).

## Tasks to send

Four tasks from `/w/<slug>/implementer`, each with a **new** branch name (a name is used once). Send A first and read S03
while it runs; B, C and D can follow one after the other.

- **A, the plain one**, no cost limit: `Add a file smoke/hello.txt with the single line "hello from the implementer". Commit it.`
- **B, the facts**, no cost limit. The agent reports what it sees on the VM, in a file on the branch:

  ```text
  Create the file smoke/checks.txt. For each numbered line run the command and write the command and its output (or its
  error) into the file. Commit it.
  1. id
  2. git --version
  3. grep ' /work ' /proc/self/mountinfo
  4. curl -sS --max-time 15 https://example.com
  5. curl -sS --max-time 15 --noproxy '*' https://registry.npmjs.org/-/ping
  6. curl -sS --max-time 15 https://registry.npmjs.org/-/ping
  7. curl -sS --max-time 15 https://github.com
  8. git remote -v
  9. git branch smoke-other
  10. sudo -n true
  11. env | grep -i -E 'token|key|secret' | cut -d= -f1
  ```

- **C, the limit**, a cost limit of the smallest value the form accepts (1 cent): `Write a Python command line tool with a
  full test suite for a bank account ledger, with documentation, and run the tests after every change.`
- **D, workflows**, no cost limit: `Add .github/workflows/smoke.yml with a workflow that prints hello on push. Commit it.`

## The checks

| # | Check | How | A pass is | If it fails |
|---|---|---|---|---|
| S01 | The Dispatcher serves the kind | Actions, *Dispatcher canary* of the release, or the log of the last `POST /probe` | The canary passed and its report names `implementer` next to `pr-agent` and `opencode`; the Dispatcher log has no `worker_config_invalid` | Stop. The Launcher does not advertise the engine, or `DISPATCHER_WORKER_CONFIG` has a wrong `implementer` entry |
| S02 | The snapshot size after the first rebuild | The release changed the Worker image, so its run rebuilt the golden snapshot (`snapshot-build`, [`golden-snapshot.md`](golden-snapshot.md)). Read the snapshot size of the new one from the platform: Vercel dashboard, the team's Sandbox page, Snapshots, or the SDK/API listing, and the size of the one before (kept as the rollback target) | Both sizes are written into the issue; the image grew by the budget of [`golden-snapshot.md`](golden-snapshot.md) ("What the Worker image holds, and its size") or less | The growth is larger than the budget: stop and open a follow-up for a per-kind image. Do not switch the Implementer on for users |
| S03 | VM start time | Send task A and read, in the Vercel Sandbox list, the VM `cr-implementer-<job id>-<suffix>` (creation time and the time it is running), and the `ms` of the Dispatcher's `launched` line of the same job (claim to hand-over). Do the same for a Dynamic job of S12 from the same snapshot | Both numbers are written into the issue, no `launch_failed` came, and the `ms` of the Implementer is no more than twice that of the Dynamic job | A slow start on a large snapshot is the S02 problem. A `launch_failed` is read in the Dispatcher log ([`dispatcher/README.md`](../dispatcher/README.md), "The Sandbox-Launcher") |
| S04 | Task A on GitHub | Look at the repository on GitHub | A branch with the chosen name exists; it has at least one commit that adds `smoke/hello.txt` with the single line; `main` is unchanged; no pull request was opened | No branch: read the run's error code in [`implementer.md`](implementer.md), "When a task fails". A change on `main`: stop and treat as a security incident |
| S05 | The committer | Open the commit on GitHub, or `git log --format=raw` of the branch | Every commit of the branch has the system identity (the product name and "Implementer") as committer | A different committer got through the push check: stop |
| S06 | The Runs page | Open the run from the form's link | One row with repository, branch, the Implementer badge, status succeeded and no pull request link; the detail shows the instruction, the commits, the changed files, the agent's summary and the usage | A missing field is a bug of #758; a wrong status is a lost result |
| S07 | The cost | The usage on the run detail, for tasks A, B and C | A model cost is shown and is below the cost maximum (5.00 USD) for each; the minutes are shown; no billing entry exists (billing is off) | No cost: the usage was not recorded. A cost above the maximum by more than one call: the brake does not work, stop |
| S08 | The cost limit | Task C | The run ends `cost_limit_reached`; commits pushed before the stop are on the branch; the usage is at about the limit and no model call is logged after it | The run goes on past the limit: stop. The branch name of C stays taken, as documented |
| S09 | The Vercel Sandbox list and the logs after a task | The Sandbox list a minute after tasks A to D ended; the Dispatcher and Worker logs of the jobs | No VM of a finished job is left (names `cr-implementer-...`, tag `tenant` the factory); the logs hold no git token (`ghs_`, `x-access-token`), no model key and no capability | A leftover VM is stopped by the reaper after its lifetime; a secret in a log is an incident |
| S10 | The guard and the identity on a real VM | Task B: read `smoke/checks.txt` on the branch | (1) the user is not root; (2) git 2.53 or newer; (8) no remote; (9) `git branch smoke-other` is refused with a message that starts `code-reviewer-guard:`; (10) `sudo` is not allowed; (11) no variable name that looks like a credential | Any line the other way: stop; the container profile or the image is not what the code says |
| S11 | An https clone through the GnuTLS libcurl | Task A on the private throwaway repository. The runner clones the base branch over https with the git of the image, whose `git-remote-https` uses `libcurl-gnutls` (#786, item 3) | The run did not end `clone_failed`, the branch has the commit, and the Worker log shows the clone step done | `clone_failed` with a TLS error: the GnuTLS handshake with GitHub is the cause; fix the image before any user |
| S12 | Diff and Dynamic through the shared Dispatcher | A pull request on a test repository of the first App (code-review.com), once with a Diff review and once with a Dynamic review, while a task of the factory runs | Both reviews succeed and post; the Dispatcher log shows a `launched` line for each, with `app` `reviewer` for the reviews and `factory` for the task; the task is not slowed down by them | A `kind_not_allowed` or a job of one App launched for the other is an incident of #730. A review that waits behind a task: step 7 of the rollout |
| S13 | The billing route is `404` when logged in | Logged in as a member of the factory, open `/w/<slug>/settings/billing`, then `/api/billing/webhook` and `/w/<slug>/no-such-page` | The two billing addresses answer `404` exactly like the address that does not exist; the settings page lists no billing item | A page or a body that differs: the capability wall leaks, see [`app/src/capabilities/README.md`](../app/src/capabilities/README.md) |
| S14 | The nft rules on a real VM | Task B, lines (4) to (7) of `smoke/checks.txt` | (4) fails (no route); (5) fails (the proxy cannot be bypassed); (6) answers (the registry through the proxy); (7) is refused (`github.com` is not on the allowlist) | (4) or (5) answers: the rules are not in place, stop. (6) fails: the egress proxy or the registry list is broken, the agent cannot install anything |
| S15 | `nosuid` on `/work` | Task B, line (3) of `smoke/checks.txt`; and the Dispatcher log of task A | The mount line of `/work` has `rw`, `nosuid`, `nodev` and no `noexec`; the launch did not report `work_volume_failed` | The Dispatcher refuses a work volume without `nosuid` and `nodev`; a mount seen here that does not have them contradicts it: stop |
| S16 | A workflow file is not pushed | Task D | The run ends `push_rejected` (GitHub rejects the push: no `workflows` permission); `.github/workflows/smoke.yml` is not on GitHub; `main` is unchanged | The file arrives: the App has a permission it must not have, stop |
| S17 | The App's permission | Integrations, *Check the permissions*; the installation page on GitHub | Contents is Read and write, nothing was added beyond the manifest of the factory, and the repository is not disabled with the note "approve the new GitHub permission" | Follow [`github-app.md`](github-app.md), "Update an existing App" |
| S18 | Writing the result down | The issue | A copy of this table, with each row's measured value (sizes, times, costs, the commit shas and run ids, not any token) and a verdict, is a comment on #768 | The issue stays open until every row passes |

## After the test

- Delete the throwaway repositories' branches `smoke-*` and the repositories if they are not needed; remove nothing of the
  factory's production data.
- A failed row is not fixed here: open an issue with the row's number, and decide whether the switch-off of step 3 of the
  rollout is needed (S04 to S06, S10, S13 to S16 are reasons to switch it off until fixed).
