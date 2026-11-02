# The Implementer: live smoke test

What the lead runs once, on the platform, after the Implementer is released and switched on
([`factory-bring-up.md`](factory-bring-up.md), "Switching on the Implementer", steps 1 to 7). No automated test can
prove these: they need the real VM image, the real network rules, the real GitHub and the real models. Each row says how to
look and what a pass is: on GitHub, in Runs, in the cost, in the Vercel Sandbox list and in the logs. This is T03 of issue #768:
the result goes into that issue as a copy of the table with the numbers and the verdict of each row, and nothing in it names a
secret. What the Implementer does is in [`implementer.md`](implementer.md).

## Before you start

- The release with the Implementer is live and the steps of the rollout are done: Dispatcher kind, capability set, the
  GitHub App created after that deploy and installed, cost maximum, a model.
- The canary of rollout step 2 passed. If it was blocked with `reasons=implementer_probe_failed missing=implementer`, stop: no
  task can run until that is fixed, and the rest of the release waited with it.
- A **throwaway repository** the factory's GitHub App is installed on (selected repositories), with a `main` branch, a
  `package.json` with no dependencies and a few lines of code. A private one is better: it makes S12 a real handshake with
  an authenticated clone. A second repository, of the first App, with an open pull request for S13.
- **A baseline taken before rollout step 2**, on the first App: one Diff review and one Dynamic review of that pull request.
  Write down, for each job, the `ms` of its `launched` line in the Dispatcher log (claim to hand-over) and the time to the
  posted review. S04 and S13 compare with these.
- The values to write down: the release commit, the time you started, the snapshot id of the live Dispatcher deployment (its
  meta, or `SANDBOX_SNAPSHOT_ID`; an id is written in the issue only if the issue is private).
- **The image has no `curl`, no `wget`, no `sudo`.** It has `python3`, `git`, `node`, `npm`, `grep`, `env`, `id` on the
  agent's `PATH` (`/usr/local/bin:/usr/bin:/bin`). Task B uses only these; a missing tool must never be read as a closed
  network.

## Tasks to send

Five tasks from `/w/<slug>/implementer`, each with a **new** branch name (the name stays taken). Send A first and read S04
while it runs; B, C, D and E can follow one after the other. Git is free in the agent's workspace and the runner pushes every
local branch when the turn ends ([`implementer.md`](implementer.md), "The git rules"), so the throwaway repository must be one
where a pushed branch does no harm; protect `main` on it if you want to see the owner's accepted risk stay contained.

- **A, the plain one**, no cost limit: `Add a file smoke/hello.txt with the single line "hello from the implementer". Commit it.`
- **B, the facts**, no cost limit. The agent reports what it sees on the VM, in a file on the branch:

  ```text
  Create the file smoke/checks.txt. For each numbered line run the command and write the command and the last line of its
  output (or "no output") into the file. Do not change a command. Commit the file.
  1. id
  2. git --version
  3. grep ' /work ' /proc/self/mountinfo
  4. env -u HTTPS_PROXY -u https_proxy python3 -c "import urllib.request as u; print(u.urlopen('https://example.com', timeout=15).status)"
  5. env -u HTTPS_PROXY -u https_proxy python3 -c "import socket; socket.create_connection(('1.1.1.1', 443), timeout=10); print('connected')"
  6. python3 -c "import urllib.request as u; print(u.urlopen('https://registry.npmjs.org/-/ping', timeout=15).status)"
  7. npm ping --registry https://registry.npmjs.org/
  8. python3 -c "import urllib.request as u; print(u.urlopen('https://github.com', timeout=15).status)"
  9. git ls-remote https://github.com/git/git.git
  10. git remote -v
  11. git branch smoke-other; git branch --list; git remote -v; git push origin HEAD
  12. grep -E '^(Uid|CapEff):' /proc/self/status
  13. env | grep -i -E 'token|key|secret' | cut -d= -f1
  ```

- **C, the limit**, a cost limit of 0.20 (dollars in the form), a cheap model: `Write a Python command line tool with a
  full test suite for a bank account ledger, with documentation, and run the tests after every change.`
- **D, workflows**, no cost limit: `Add .github/workflows/smoke.yml with a workflow that prints hello on push. Commit it.`
- **E, git is free**, no cost limit: `Add smoke/e1.txt with one line and commit it. Then amend that commit with a new message, create a branch smoke-extra from the base commit, add smoke/e2.txt there and commit it, and switch back to your first branch.`

## The checks

| # | Check | How | A pass is | If it fails |
|---|---|---|---|---|
| S01 | The Dispatcher serves the kind | Actions, the *Dispatcher canary* step of the run of rollout step 2, and the Dispatcher log | The canary passed (its report names `implementer` next to `pr-agent` and `opencode`), it took less than 300 s, the log has no `worker_config_invalid`, and `DISPATCHER_PROBE_TIMEOUT_SECONDS` is at or below 190 | `canary: passed engines=pr-agent,opencode reasons=implementer_probe_failed missing=implementer, the release is blocked`: the Dynamic half passed and the Implementer's half did not (the log has `canary_implementer_probe_failed` or `canary_implementer_not_proven`); nothing of that run was promoted. Set `kinds` back (rollout step 2) and read the reason. `probe_unreachable`: the probe took longer than the canary waits |
| S02 | The GitHub App after the click | Right after the App was created in the admin portal (Integrations) and installed: on GitHub, Settings, Developer settings, GitHub Apps, the App, Permissions; and the portal's *Check the permissions*. Also the App's visibility on GitHub | Contents shows **Read and write**; every other permission is as in [`github-app.md`](github-app.md); *Check the permissions* lists nothing missing; the App can be installed by any account (tenancy `multi` makes the manifest public) | Contents Read-only: the App was created before the deploy of rollout step 3; update it by hand ([`github-app.md`](github-app.md), "Update an existing App") and have each installation accept. A permission the manifest does not ask for: stop |
| S03 | The snapshot size after the first rebuild | The release changed the Worker image, so its run rebuilt the golden snapshot (`snapshot-build`, [`golden-snapshot.md`](golden-snapshot.md)). The snapshot record of the platform has a size (`sizeBytes` in the Vercel Sandbox SDK, typed in `dispatcher/src/snapshot/service.ts`) but nothing in this repository prints it after the build; read it for the new snapshot and for the previous one (kept as the rollback target) through the SDK or API, or the dashboard if it lists one (not verified that it does). If no number can be had, read instead the image size the image smoke test prints for the release commit in CI (sum of layers) and say in the issue that the snapshot size could not be read | Both sizes (or the image sizes) are written into the issue and the new one is larger than the old by no more than the budget in [`golden-snapshot.md`](golden-snapshot.md) ("What the Worker image holds, and its size", 600 MB over the image before the toolchain layer) | Over the budget: stop and open a follow-up for a per-kind image. Do not switch the Implementer on for users |
| S04 | VM start time | Send task A. In the Vercel Sandbox list find the VM `cr-implementer-<job id>-<suffix>` (created, running) and read the `ms` of the Dispatcher's `launched` line of that job | The `ms` is written into the issue, no `launch_failed` came, and it is no more than twice the baseline `ms` of the Dynamic job | A slow start on a large snapshot is the S03 problem. A `launch_failed` is read in the Dispatcher log ([`dispatcher/README.md`](../dispatcher/README.md), "The Sandbox-Launcher") |
| S05 | Task A on GitHub | Look at the repository on GitHub | A branch with the chosen name exists; it has at least one commit that adds `smoke/hello.txt` with the single line; `main` is unchanged; no pull request was opened | No branch: read the run's error code in [`implementer.md`](implementer.md), "When a task fails". A change on `main`: stop and treat as a security incident |
| S06 | The commits | Open the commits on GitHub, or `git log --format=raw` of the branch | The commits of task A have the system identity (the product name and "Implementer") as author and committer, because the agent was handed it. This shows the normal path works. It proves nothing about who made a commit: the agent may write any identity ([`implementer.md`](implementer.md), "The git rules") | A commit by an identity nobody expects is not a failure of this slice; note it |
| S07 | The Runs page | Open the run from the form's link | One row with repository, branch, the Implementer badge, status succeeded and no pull request link; the detail shows the instruction, the commits, the changed files, the agent's summary and the usage | A missing field is a bug of #758; a wrong status is a lost result |
| S08 | The cost | The usage on the run detail, for tasks A and B | A model cost is shown and is below the cost maximum; the minutes are shown; no billing entry exists (billing is off) | No cost: the usage was not recorded. A cost above the maximum by more than one call: the brake does not work, stop |
| S09 | The cost limit | Task C | The run ends `cost_limit_reached`; commits pushed before the stop are on the branch; the cost on the run is between 0.20 and 0.30 USD (the limit plus the last call). A cost above 0.30 USD is a pass only if one single call of the run's usage explains it (over 0.10 USD) | The run goes on past the limit: stop. The run succeeded below 0.20 USD: the task was too small, make it larger and repeat |
| S10 | The Vercel Sandbox list and the logs after a task | The Sandbox list a minute after tasks A to D ended; the Dispatcher and Worker logs of the jobs | No VM of a finished job is left (names `cr-implementer-...`); the logs hold no git token (`ghs_`, `x-access-token`), no model key and no capability | A leftover VM is stopped by the reaper after its lifetime; a secret in a log is an incident |
| S11 | Git, the identity and the missing remote on a real VM | Task B: read `smoke/checks.txt` on the branch | (1) a line starting `uid=10101(engine)`; (2) a `git version` line; (10) no output (no remote); (11) the list shows the task branch and `smoke-other`, and the command succeeded (git is free: no `code-reviewer-guard:` message exists any more), and the next two outputs show no remote and a `git push` that fails with `fatal: 'origin' does not appear to be a git repository`; (12) `Uid:` followed by 10101 four times and `CapEff:` followed by sixteen zeros; (13) no output. On GitHub, `smoke-other` does **not** exist (it has nothing new on the base commit) | A remote, a credential or a successful push: stop; the container profile or the image is not what the code says |
| S12 | An https clone through the GnuTLS libcurl | Task A on the private throwaway repository. The runner clones the base branch over https with the git of the image, whose `git-remote-https` uses `libcurl-gnutls` (#786, item 3) | The run did not end `clone_failed`, the branch has the commit, and the Worker log shows the clone step done | `clone_failed` with a TLS error: the GnuTLS handshake with GitHub is the cause; fix the image before any user |
| S13 | Diff and Dynamic through the shared Dispatcher | The same pull request and the two reviews of the baseline, again, while a task of the factory runs | Both reviews succeed and post; the `launched` lines have `app` `reviewer` for the two reviews and `factory` for the task; each review's `ms` is no more than twice its baseline, and each review's total time no more than twice the baseline's; the Dispatcher log has no `fleet_list_failed` | A `kind_not_allowed` or a job of one App launched for the other is an incident of #730. A review that waits behind a task: step 7 of the rollout. `fleet_list_failed`: see "What to look at" below |
| S14 | The billing route is `404` when logged in | Logged in as a member of the factory, open `/w/<slug>/settings/billing`, then `/api/billing/webhook` and `/w/<slug>/no-such-page` | The two billing addresses answer `404` exactly like the address that does not exist; the settings page lists no billing item | A page or a body that differs: the capability wall leaks, see [`app/src/capabilities/README.md`](../app/src/capabilities/README.md) |
| S15 | The nft rules and the proxy on a real VM | Task B, lines 4 to 9 of `smoke/checks.txt` | (4) last line `urllib.error.URLError: <urlopen error [Errno -3] Temporary failure in name resolution>` (rules that refuse at once) or `... timed out>` (the fallback rules drop silently); (5) `OSError: [Errno 113] No route to host` or `TimeoutError: timed out`; (6) `200`; (7) a line with `PONG`; (8) `urllib.error.URLError: <urlopen error Tunnel connection failed: 403 Forbidden>`; (9) `fatal: unable to access 'https://github.com/git/git.git/': CONNECT tunnel failed, response 403` | (4) or (5) shows `200` or `connected`: the rules are not in place, stop. (6) or (7) fails: the egress proxy or the registry list is broken and the agent cannot install anything. (8) or (9) succeeds: the allowlist lets a host through, stop |
| S16 | `nosuid` on `/work` | Task B, line 3 of `smoke/checks.txt`; and the Dispatcher log of task A | The mount line of `/work` has `rw`, `nosuid`, `nodev` and no `noexec`; the launch did not report `work_volume_failed` | The Dispatcher refuses a work volume without `nosuid` and `nodev`; a mount seen here that does not have them contradicts it: stop |
| S17 | A workflow file is not pushed | Task D | The run ends `push_rejected` (GitHub rejects the branch: no `workflows` permission) and the Runs page lists the branch as not pushed with the sentence about `.github/workflows`; `.github/workflows/smoke.yml` is not on GitHub; `main` is unchanged | The file arrives: the App has a permission it must not have, stop |
| S18 | Writing the result down | The issue | A copy of this table, with each row's measured value (sizes, times, costs, the commit shas and run ids, not any token) and a verdict, is a comment on #768 | The issue stays open until every row passes |
| S19 | Every local branch arrives, nothing is forced | Task E | Two branches are on GitHub: the task branch with the amended commit (one commit with the new message, no trace of the first) and `smoke-extra` with `smoke/e2.txt`; the run succeeded and the Runs page lists both as pushed with links; no existing branch of the repository moved; the Dispatcher and Worker logs show no `--force` | A missing branch: read its reason on the Runs page. A moved existing branch: stop, the runner must never force |

## What to look at when a task or a review does not start

- **`fleet_list_failed` in the Dispatcher log.** With two or more Apps the Dispatcher lists the platform's VMs, at most once in five
  seconds, to count what each App occupies. A listing that gives no answer within 4 seconds counts as failed; the last good one is
  used for up to a minute, and after that the Dispatcher counts by its own launches and the claim goes on (the cap is a soft
  limit). So the line is a warning and does not by itself stop a task or a review; it did until the fix that followed the incident of 2026-11-01, and the waiting
  jobs ended `no_capable_runner` after 30 minutes. Read the `fleet_listed` lines next to it: their `ms` is the time of a listing
  and their `count` the VMs it returned, stopped ones included; the reaper deletes an ended VM after one day, 50 per run
  (`reap_done`: `deleted`, `deleteFailed`, `deleteKept`, `deleteNotTried`).
- **`not_capable` or `no_capable_runner`**: the factory's entry in `DISPATCHER_APPS` lacks the kind,
  or the Launcher does not advertise it.
- **`implementer_engine_unavailable`**: the Worker log names the stable reason of its start-up checks.
- The table of codes: [`implementer.md`](implementer.md), "When a task fails".

## After the test

- Delete the throwaway repositories' branches `smoke-*` and the repositories if they are not needed; remove nothing of the
  factory's production data.
- A failed row is not fixed here: open an issue with the row's number, and decide whether the switch-off of step 3 of the
  rollout is needed (S05 to S07, S11, S14 to S17 are reasons to switch it off until fixed). Read what the switch-off does to
  running and queued tasks first ([`factory-bring-up.md`](factory-bring-up.md), step 3).
