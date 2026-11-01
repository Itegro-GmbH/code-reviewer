# Golden snapshot (hosted deployment)

The hosted deployment (#316) runs every review job in a fresh Vercel Sandbox VM that is a clone of one **golden
snapshot**: a VM image with a pinned Docker installed, the cgroup preparation script in place and the Worker image
already built. This document is the runbook for that snapshot: how it is made, what proves it, when it is rebuilt, how
it is rolled back and what happens to old ones. Since #403 **nobody runs any of it by hand**: the deployment pipeline
decides, builds, proves, wires in and cleans up (`deployment-vercel.md`, section 5.1). The code is `dispatcher/src/snapshot/`; the workflow is
`.github/workflows/golden-snapshot.yml`; the Sandbox double the tests use is `fakes/vercel-sandbox/`.

The place of the snapshot in a whole deployment, and the order of the steps around it, is in [`deployment-vercel.md`](deployment-vercel.md).

## What the pipeline does

`pnpm --dir dispatcher snapshot:build --context <tgz> --vm-prepare <sh> --out <json> [options]` (the workflow runs it).
In order:

| #   | Step (label in the logs)                                      | What happens                                                                                                                                                                                                                                                                                                    | Failure code (`SNAPSHOT_ERROR_CODES`)                             |
| --- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1   | `create_builder`, `record_base_manifest`                      | A persistent builder VM in `fra1` (2 vCPU / 4 GB) from the platform's default image, named `code-reviewer-golden-builder-<UTC time>`. Its first command records the **base manifest** (path, size, modification time of every file under the scan roots) before anything is installed (the scan section below). | `builder_create_failed`, `base_manifest_failed`                   |
| 2   | `install_docker`                                              | `apt-get install docker.io=<pinned>* docker-buildx=<pinned>*`; the installed `docker.io` must start with the pinned version.                                                                                                                                                                                    | `docker_install_failed`, `docker_version_mismatch`                |
| 3   | `write_daemon_config`, `install_host_scripts`, `start_daemon` | `/etc/docker/daemon.json` (IPv6 off), `docker/sandbox/vm-prepare.sh` into `/usr/local/sbin/vm-prepare.sh`, and a run of it: the same cgroup fix and `dockerd` start the Sandbox-Launcher (#329) runs on every job VM.                                                                                           | `daemon_config_failed`, `host_prepare_failed`                     |
| 4   | `build_image`                                                 | The commit's tarball (`git archive`, tracked files only) is uploaded and `docker build --target <target>` runs in the VM. About 70 s in the spike. **No registry and no registry credential is involved.**                                                                                                      | `context_upload_failed`, `image_build_failed`                     |
| 5   | `inspect_image`, `clean_builder`                              | The image id (`sha256:<64 hex>`, `docker image inspect --format '{{.Id}}'`) is read and becomes `imageDigest`. Build cache and staged files are removed.                                                                                                                                                        | `image_digest_invalid`                                            |
| 6   | `check_no_containers`, `stop_daemon`                          | `docker ps -aq` must be empty (no container, running or not), then `dockerd` gets SIGTERM and the step waits until it, containerd and the shims are gone. Never SIGKILL.                                                                                                                                        | `containers_present`, `daemon_not_stopped`, `daemon_query_failed` |
| 7   | `snapshot`                                                    | `snapshot({expiration: 0})`: **no expiry**. It must be `created` and available in `fra1`.                                                                                                                                                                                                                       | `snapshot_failed`, `snapshot_region_mismatch`                     |
| 8   | `create_check_vm`                                             | A VM `code-reviewer-golden-check-<UTC time>`, **created from the new snapshot** with `persistent: false`, the way a job VM is.                                                                                                                                                                                  | `check_vm_failed`                                                 |
| 9   | `scan_filesystem`                                             | No secret and no job data in what the pipeline added or changed in the restored snapshot (below).                                                                                                                                                                                                               | `scan_findings`, `scan_unreadable`                                |
| 10  | `start_daemon_check`, `inspect_restored_image`                | `vm-prepare.sh` brings the daemon up; the image id must equal step 5.                                                                                                                                                                                                                                           | `host_prepare_failed`, `image_digest_mismatch`                    |
| 11  | `probe`                                                       | The image runs in `probe` mode (#324) with the flags the shared renderer (#325) makes for the Sandbox variant (the hardened container spec plus the IPv6 sysctls); its verdict must advertise every engine in `requiredEngines` (`pr-agent`, `opencode`).                                                       | `probe_failed`, `probe_unreadable`, `engine_missing`              |
| 12  | record, retention                                             | The record is returned and written; older builders are removed unless `--skip-retention` is given (the deployment removes them itself, below); the check VM is deleted.                                                                                                                                         | `record_invalid`; retention only warns                            |

**Fail closed.** If any step fails after the snapshot exists, the builder is deleted **with** its snapshots, so a bad
snapshot is withdrawn and the run leaves no record. The record file named by `--out` is deleted when the run starts, so
a failed run cannot leave the last good record looking current. If a VM or snapshot cannot be deleted, the error names
it (`cleanupFailures`) and the operator removes it. A snapshot whose Dynamic self-check does not advertise `opencode` is
never recorded.

**What the pipeline never has.** It runs no job code, receives no job credential and no registry credential. The
Vercel token is read from the environment, handed to the platform client and to nothing else (no VM command, file or
environment, no argument, no log line: every log line is masked). The VMs hold no secret.

## What the Worker image holds, and its size

The snapshot carries the whole Worker image, which every kind of job uses: the runner with PR-Agent, the pinned OpenCode and `rg`, `nft`
and, since #761, the toolchain of the Implementer's agent (git built from a pinned source, Node.js, pnpm, uv, `gcc`, `g++`, `make`, `jq`,
`unzip`) and the branch guard files (`docs/dynamic-review.md`, "The Worker image"). The reviewer pays for that layer, so there is a budget:
the image smoke test (`docker/smoke/runner.sh`) prints the size of the image as the sum of its layers and fails when it grew by more than
600 MB over the image before the toolchain layer (999 MB). At the layer's introduction it grew by 490 MB locally and 471 MB in CI (1,489 MB locally), compressed content
264 MB to 436 MB. If a later change breaks the budget, the answer is a per-kind image and snapshot, not a heavier shared image.

What a changed image input does: every file the build reads is in `IMAGE_INPUT_PATHS` (`dispatcher/src/snapshot/pair.ts`, with the
toolchain pins, `fetch_toolchain.py`, the guard files). A release that changes one of them has the deployment build a new golden snapshot
(the image id changes), prove it with the canary and wire it in, as described above; nobody does anything by hand. The first release after
the toolchain layer therefore rebuilds the snapshot once: the build step downloads the three pinned archives and compiles git (118 s with `make -j2` on a loaded
2-vCPU-class host, the builder VM has 2 vCPU and 4 GB) on top of the roughly 70 seconds of the spike. A job VM is created from the snapshot, so a larger snapshot means a larger disk to restore;
the container start of a Diff or Dynamic job does not read the new layers.

## The record

```json
{
  "version": 1,
  "snapshotId": "snap_...",
  "imageDigest": "sha256:<64 hex>",
  "builtAt": "2026-10-15T18:00:00.000Z",
  "region": "fra1",
  "target": "sandbox",
  "commit": "<sha>"
}
```

`snapshotId` and `imageDigest` are what the Sandbox-Launcher (#329) is configured with. The Launcher creates job VMs
from `snapshotId` in `fra1` and refuses to run when `docker image inspect` in the VM reports another id than
`imageDigest`. The workflow keeps the record as the artifact `golden-snapshot-record` (90 days) and shows it in the run
summary and as the outputs `snapshot-id`, `image-digest` and `commit` of the workflow. The build itself changes no
deployment, removes no snapshot of an earlier run and writes nothing to Infisical: _Deploy production_ wires the
snapshot into a staged Dispatcher deployment, proves it with the canary, and only after the promotion writes it to
Infisical (`SANDBOX_SNAPSHOT_ID`, `SANDBOX_IMAGE_DIGEST` and `SANDBOX_SNAPSHOT_COMMIT` of `/dispatcher`) and removes
the snapshots nobody needs.

## Running it

Once: the setup of `docs/deployment-vercel.md`, section 2.1. The build reads its platform credentials from Infisical
`prod` `/ci` (#403): `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_DISPATCHER_PROJECT_ID`, the id of the **Dispatcher's**
Vercel project, with the machine identity whose sign-in is stored as four secrets of the GitHub environment `production`.
The job loads them in one step, just before the build step and after the dependencies were installed, and hands the
project id to the build as `VERCEL_PROJECT_ID`. (The environment `hosted-snapshot` is **retired**.)

The workflow is called by _Deploy production_ when the Worker image has to be rebuilt (a `workflow_call`, with the
same environment, branch and secret rules). Started by hand (_Actions > Golden snapshot > Run workflow_, input
`target`, default `sandbox`) it is a **rehearsal**: it builds and checks a snapshot and leaves it, and wires nothing in
and persists nothing, because a manual build that wrote the pair would let the pair drift away from what production runs
and break the cleanup rule below. The next deployment that cleans up removes it. The repository variable
`GOLDEN_SNAPSHOT_ENABLED` and the input `pinned_snapshot` are **retired**: nothing builds on a push by itself any more,
and the cleanup, not the build, decides what is kept. It never runs for a pull request, and the job runs **only from
`main`**: its own condition guards against accidents, and the boundary is the environment `production`, whose deployment
branches are restricted to `main`. It used to run from `development` too; it cannot any more, because the one environment
that holds the Infisical sign-in is main-only, and a release needs no earlier build: the deployment builds when it merges.
Locally the same command works with the three variables exported (`VERCEL_PROJECT_ID` being the Dispatcher's) and
`--context` made with `git archive --format=tar.gz --output /tmp/context.tgz HEAD` (never run it against a platform
account you do not mean to change).

Options of the command: `--target`, `--dockerfile`, `--image-tag`, `--docker-version`, `--buildx-version`, `--commit`,
`--keep` (default 2) and `--pin-snapshot` (repeatable) for the retention that runs at the end of a build unless
`--skip-retention` is given (the workflow always gives it). Without `VERCEL_TOKEN` the platform client uses the OIDC token of
the environment. Exit status: 0 the record was written, 1 the run failed (the log line `golden_snapshot_failed` has the
code and, for a failed command, its exit status and the last lines of its error output), 2 wrong use, nothing created.

## When it is rebuilt

The deployment rebuilds the snapshot when something that goes into the Worker image changed since the commit the
snapshot in use was built from (exactly the files the image build consumes: what `runner/Dockerfile` copies, its ignore
files, the license files, `docker/sandbox/vm-prepare.sh` and the four files of the build tool that decide what is
installed in the snapshot, `config.ts` with the pinned Docker and buildx versions and the default target among them: see
`IMAGE_INPUT_PATHS` in `dispatcher/src/snapshot/pair.ts`), when that commit or the pair is missing (the first
deployment), when the snapshot of the pair no longer exists, or when _Deploy production_ is started with
`rebuild_snapshot`. That last one is for what the
repository cannot show: the platform's base image changed (the install step then fails with `docker_version_mismatch`
instead of snapshotting something nobody tested: update the pin in `dispatcher/src/snapshot/config.ts`, re-run the
checks of spike #317 on the new base). The decision, the proof by the canary, the promotion, the write to Infisical and
the cleanup are described in `deployment-vercel.md`, section 5.1; the canary (#331) calls `POST /probe`, which runs the
image's `probe` mode in a fresh VM from the snapshot, and fails unless `opencode` is advertised and the answer names the
image of this run (`dispatcher/README.md`, "The canary probe" and "The deploy canary"). The list of hosts of
earlier versions (`DISPATCHER_CANARY_HOSTS`) is **retired**.

## Roll back to the previous snapshot

Roll the Dispatcher back (_Actions > Rollback production_, `deployment-vercel.md`, section 7): the previous Dispatcher
deployment carries its own pair, and the rollback writes that pair back to Infisical. Its snapshot still exists because
the cleanup always keeps the new snapshot **and the previous one**. There is no separate rollback of a snapshot, and an
older one than the previous may already be deleted.

## Expiry and retention

- **Snapshots do not expire** (`expiration: 0`). The platform's default of 30 days applies to automatic snapshots of
  persistent VMs, not to this one; if retention stops running, snapshots stay (and are billed as storage).
- **The cleanup** (`pnpm snapshot:ops cleanup`, the `cleanup` job of _Deploy production_) runs only after the new
  pair is written to Infisical. It keeps the new snapshot, the previous one and the one the live Dispatcher deployment
  runs (read from the platform at that moment; if it cannot be read nothing is removed), and deletes every other
  builder **with** its snapshot (`deleteOrphanSnapshots`). It only touches builders whose name starts with
  `code-reviewer-golden-builder-`, and a keep list that matches none of the builders removes nothing. The `discard` job
  removes just the snapshot of a run that did not get live. The retention at the end of a build (`--keep`,
  `--pin-snapshot`) still exists for a build run by hand from the command line; the workflow turns it off.
- A failed cleanup is a failed job (`cleanup_incomplete` in the log): what is left is removed by the next one.
- A builder whose snapshot the platform did not report is never deleted automatically (warning
  `builder_without_snapshot`). A run that was killed leaves a builder without a snapshot behind: it is a VM that ends at
  its timeout; delete it by hand once it is stopped.
- Snapshots are **region-bound to `fra1`**: no failover. If the region is unavailable, new jobs cannot start; there is
  no snapshot elsewhere to fall back on.

## The final scan (T06)

The scan runs in the VM created from the snapshot (what a job VM will see), as root, and reads files only. It reports
`FINDING <kind> <path>` and never a content; the run fails on any finding, and fails if the scan does not end with its
marker.

**What it reads.** The platform's base image ships files that look like secrets and are not: the docs and bundles of its
global Node packages under `/usr/local/lib/node_modules` hold a `BEGIN PRIVATE KEY` header, `_authToken=` placeholders and
the AWS documentation example key id. So the scan answers "what did the pipeline leave behind", not "what is on the
disk":

- The builder's **first command** (`record_base_manifest`, before `install_docker`) writes a sorted list of every file
  under `/root`, `/home`, `/etc`, `/opt`, `/usr/local`, `/var/tmp` and `/var/log`, one record per file: path, size in
  bytes, modification time and status change time (ctime), both with their fraction. A tool in user space can restore
  the modification time (`touch -r`, `cp -p`, tar) but not the ctime, so a base file rewritten with the old size and
  mtime still differs. The manifest lies in `/var/lib/code-reviewer-golden/base-manifest` (mode 0600, outside every
  scan root), so it travels in the snapshot to the check VM. It holds no content. The step prints the sha256 of the
  finished file; the pipeline keeps that hash **outside the VM** and the scan refuses a manifest that does not match it.
- The scan lists the same roots again and checks every file whose record is **not in the manifest**: a new file (an apt
  package, `daemon.json`, `vm-prepare.sh`, anything the build or a script wrote) or a changed one (another size or time).
  A base file that gained a secret is therefore found; a base file that did not change is not read.
- Docker's `containers` and `volumes` directories are not subject to the manifest: **every** file in them is read.
- No pattern was relaxed for this: a documented example key or a placeholder token in a file the pipeline wrote is still
  a finding.
- **Fail closed.** The scan ends without its marker and with an exit status of its own (`scan_unreadable`) when: the
  manifest is missing or empty (43), it is not the pinned one (48), `find` fails or lists no file under the roots (47,
  45), `grep` fails with anything but a match or no match (47), or `/usr/local/sbin/vm-prepare.sh`, which the pipeline
  wrote after the record, is not among the added files (46: the listing is not the one of the pipeline's VM). No tool
  error is ignored. Two races of the VM's boot are tolerated and nothing else: the listing is asked up to three times
  (`find` ends with 1 when a file it walked past is gone), and a file that is listed and gone when `grep` asks for it
  (the platform renames a temporary `ca-certificates.crt.new` at boot, seen in the first run) is skipped; an error on a
  file that is still there fails the scan. A builder whose roots hold no file at all does not produce a manifest (`base_manifest_failed`).

| Kind          | Finding                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `secret_file` | `.env`, `.env.*` (not `.env.example`), `.netrc`, `.git-credentials`, `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`                           |
| `history`     | shell, Python and Node history files                                                                                                        |
| `docker_auth` | a `.docker/config.json` with a non-empty `auth`, `identitytoken` or `registrytoken`                                                         |
| `private_key` | a `-----BEGIN ... PRIVATE KEY-----` header (the distribution's snake-oil key is allowed)                                                    |
| `token`       | the shapes of GitHub, OpenRouter, Anthropic, AWS and Slack tokens, the per-job credential, `_authToken=`, `RUNNER_TOKEN=`-style assignments |
| `job_data`    | any entry in Docker's `containers` or `volumes` directory, except the two artifacts `dockerd` creates in `volumes` at every start           |

The work volume of the Implementer (#760) is not part of any snapshot: it is made in the job's VM, after the VM started from
the snapshot, by the Sandbox launcher (a directory below `/var/lib/code-reviewer-work`, a mount on it and a Docker volume
bound to it, see `docs/dispatcher.md`). The snapshot, `vm-prepare.sh` and the scan below are unchanged by it, and a builder VM
never has such a volume, so the `volumes` rule keeps finding every entry there as `job_data`. The VM's disk is the platform's
(64 GB); the work volume is the room of a checkout, its dependencies and a build, and goes away with the VM.

The two Docker exemptions are narrow: `volumes/metadata.db` **as a regular file** and `volumes/backingFsBlockDev` **as a
block device**. A file, a directory or a link of that name, or a `metadata.db` in `containers`, is job data.

**Not covered.**

- **Files outside the roots are not read**, among them `/tmp` and the image layers (`/var/lib/docker/overlay2` and
  containerd's data). The layers come from the tracked files of the commit and the pinned downloads of the Dockerfile.
- **A real secret that a future platform base image ships passes the scan**: base files are exempt by design, and the
  earlier scan of all files would have caught it. This is an accepted trade-off. The base image is the platform's, not
  ours; the manual check below is the guard.
- A base file replaced by one with the same size, the same modification time **and** the same ctime is not seen. Setting
  a ctime needs a clock change or a write to the block device; an adversary of the platform image is out of scope: the
  pipeline runs only our own scripts and the pinned apt packages.
- The manifest stays in the golden snapshot (2.6 MB and about 20,000 records on the base image of the first validated
  run: paths, sizes and times, no content).

A **manual** check of the first real snapshot, before the first Dynamic activation, is still the sign-off of #330-T06:
create a VM from it, run `sudo docker images`, `sudo docker ps -a`,
`sudo find / -xdev -newer /usr/local/sbin/vm-prepare.sh -type f` and look at anything that is not an apt, Docker or
build artifact.

## Failure codes

| Code                                                              | Meaning and what to do                                                                                                                                                                                                                   |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `configuration_invalid`                                           | An option was refused; the log names it.                                                                                                                                                                                                 |
| `builder_create_failed`, `check_vm_failed`                        | The platform refused a VM (credentials, quota, region). Check the token, the project and the quota; run again.                                                                                                                           |
| `docker_install_failed`, `docker_version_mismatch`                | apt could not install the pinned versions. The base image has other versions: update the pin deliberately.                                                                                                                               |
| `daemon_config_failed`, `host_prepare_failed`                     | `daemon.json` or `vm-prepare.sh` failed (the cgroup layout of the base image may have changed: see spike #317, finding F1).                                                                                                              |
| `context_upload_failed`, `image_build_failed`                     | The build failed; the log carries the last 20 lines of its error output.                                                                                                                                                                 |
| `image_digest_invalid`, `image_digest_mismatch`                   | The image id is not one `sha256` digest, or the restored snapshot holds another image than the one built. Do not publish.                                                                                                                |
| `containers_present`, `daemon_not_stopped`, `daemon_query_failed` | A container existed, the engine would not stop, or it could not be asked, at snapshot time. Nothing was snapshotted.                                                                                                                     |
| `snapshot_failed`, `snapshot_region_mismatch`                     | The platform did not create the snapshot, or not in `fra1`.                                                                                                                                                                              |
| `base_manifest_failed`                                            | The first command of the builder could not record the base manifest (no file under the scan roots, or the disk is not writable). Nothing was installed or snapshotted.                                                                   |
| `scan_findings`, `scan_unreadable`                                | The scan found something (kind and path are in the log) or did not finish (also: the manifest was missing or not the pinned one, or `find` or `grep` failed). The snapshot was deleted.                                                  |
| `probe_failed`, `probe_unreadable`, `engine_missing`              | The image's own self-check failed or answered nonsense, or did not advertise a required engine (the stable reasons are listed). Dynamic stays unavailable; fix the cause (for example the nf_tables fallback of #345, the IPv6 sysctls). |
| `unexpected_error`                                                | A failure in the pipeline's own code (a bug): no snapshot is kept. Report it with the log.                                                                                                                                               |
| `cancelled`                                                       | The run was interrupted; whatever it created was deleted.                                                                                                                                                                                |

## Not verified yet

The pipeline is tested against `fakes/vercel-sandbox` only; no test calls the platform. The first real run needs the
maintainer's token and has to confirm: the apt versions pinned in `config.ts` on the current base image; that
`snapshot()` of a persistent builder keeps the snapshot after the builder is stopped and reports it as the builder's
`currentSnapshotId` (retention relies on it); that the `sandbox` target (#324) builds and answers `probe` with
`opencode` on the platform kernel (with the egress fallback of #345); that the scan has no false finding on the real
base image (the first run found twelve in files of the base image and in Docker's own device node: #357 scans only what
the pipeline added or changed). See the follow-ups of #330.
