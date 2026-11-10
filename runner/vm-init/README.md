# vm-init

The program in a Firecracker VM's root file system that does, on a customer's own Linux machine, what the Vercel Sandbox API does for the
hosted Dispatcher (Runner v2, #977, epic #969, [ADR 0005](../../docs/decisions/0005-runner-v2-one-dispatcher-contract.md)). The local
Dispatcher (#978) starts the VM; vm-init takes the job's start over vsock, prepares the VM as the hosted launcher does, runs the Control
container with the hosted container's flags, and reports how it ended.

- Code: [`runner/src/code_reviewer_runner/vm_init/`](../src/code_reviewer_runner/vm_init/) (Python, standard library only).
- Wire: [`contracts/vm-init.v1.json`](../../contracts/vm-init.v1.json) (the start and the exit report, ports, times, examples in
  `contracts/examples/vm-init/`). The environment control of the Worker (`narrow`, `end`) is
  [`contracts/environment-control.v1.json`](../../contracts/environment-control.v1.json) (#975) and is unchanged.
- Install hook: [`install.sh`](install.sh), the one thing the root file system build (#976) runs.
- The seccomp profile of the Control container: [`control-seccomp.json`](control-seccomp.json).
- Dispatcher side: `dispatcher/src/launchers/local-control.ts` (the local Control spec, the rendering of its `docker run` arguments, the
  start request), goldens `docker-run.local-control.golden.json` and `vm-steps.golden.json` in `dispatcher/src/launchers/testdata/`.

## What it does

```
host (local Dispatcher, #978)                               guest (vm-init, root)
                                                            oom_score_adj -1000, listen on vsock port 5000
                                                            [start the daemon, as the hosted launcher does]
connect to <vsock uds>, "CONNECT 5000"  ──────────────────▶ accept
frame: StartRequest (with the VM's token) ───────────────▶ read, validate
                       ◀──────────────────────────────── frame: ack (or refused, and the VM ends)
                                                            image id check, Sysbox, work volume
                                                            docker run <control.args>  (job document and token on stdin)
   Control ──(AF_VSOCK, CID 2, port 5100, #975)──▶ host: narrow, end, each with the token   (Control talks to the host itself)
                                                            docker run ends
listener on <vsock uds>_5101  ◀──── connect, frame: ExitReport (with the token)
                       ack ──────────────────────────────▶ power off
```

1. **Listens first, prepares meanwhile.** vm-init listens on vsock port 5000 before anything else, so a host that connects the moment the VM is up
   finds it; the connection waits in the listen queue while the VM is prepared (about 2 s of the measured 2.6 s until Control can start, spike
   #970), and the host's answer therefore comes after the preparation, not after the connect. The host must wait for the `ack` at least as long as
   the daemon's start may take (the limits of the steps before the answer add up to 72 s) and no longer than `StartWaitSeconds` (300 s) after the boot.
2. **Starts the daemon as the hosted launcher does** (`sandbox.ts`, `sandbox-host.ts`): the Docker runtime directories on memory, IPv6 off for new
   interfaces, `vm-prepare.sh` with `TMPDIR` there (cgroup root, `dockerd`; 60 s, as the hosted `prepare()` bounds it, pinned in the golden). The steps are
   data (`steps.py`), held equal to what the Dispatcher's code renders by a golden file both suites read. A daemon that already answers (the guest's init
   started one) makes it skip these steps, because the runtime directories of a running daemon cannot be moved under it.
3. **Reads the start** (one frame, at most 256 KiB, within 10 s), answers `ack` or `refused` with the stable reason `invalid_start`, and from then on
   accepts nothing else. A start the contract refuses, one whose arguments hold the credential, a byte after the frame, a frame that does not come in
   time and a length outside the contract all end the VM with the exit report `start_invalid` and no job.
4. **Goes on in the order of the hosted launcher** (`prepare()`, then the Implementer's steps): it **checks the image** against the manifest's id right after the
   daemon (`docker image inspect --format {{.Id}} <reference>`; `image_missing`, `image_mismatch`), then runs `sysbox-prepare.sh` (idempotent), then
   **makes the work volume** with the hosted steps (`workVolumeCommands`: a mount of its own below the VM's disk, a reserve disk the agent cannot fill, a Docker
   named volume), reading the mount options back from the kernel before it goes on. The image check needs the start's `image`, so Sysbox and the volume come after
   the start was read; the hosted order is kept otherwise (`test_the_steps_run_in_the_order_of_the_hosted_launcher`). Only the size of the reserve is the host's
   (`reserveGib`: hosted 8, an eighth of the 64 GB disk; local, an eighth of the job disk's quota).
5. **Binds the image that runs to the image that was checked.** The image operand of `control.args` (the first argument after the options) must be the start's
   `image.id` or `image.reference`; a reference is replaced by the id before `docker run`, so what runs is what the check printed the id of, and any other image
   is refused (`start_invalid`).
6. **Runs Control**: `docker` with the start's `control.args` (rendered by the Dispatcher's `renderDockerRunArguments` from the local spec), the job
   document `{appUrl, jobId, credential, controlToken}` (plus `localCredential` when there is one) as one JSON line on stdin, then the pipe is closed. Nothing
   else carries a credential or the token.
7. **Reports and powers off.** The exit report (`ExitReport`: the container's status and a stable reason) goes to the host's port 5101, tried again every
   0.5 s for at most 10 s in all, then the VM is ended whatever came back (the power off is in a `finally`: a failure of the report, of a close or a bug of ours
   cannot leave the VM running). The report carries the token once a start was read. The host takes **the first report of a VM** and answers a repeated one
   with the same `ack`: vm-init sends the report again when the `ack` did not come, so the report is idempotent for the host. It is the authority on how the job ended
   (Control may be killed and never send `end`); the host may kill the VMM after it, and must, as the backstop. Statuses 125 to 127 of `docker run` are `docker_failed`, every other
   status is `worker_exited`; a VM that ended before Control ran has status 2 (the Worker's "setup error") and its own reason.

## Trust, the token and the wall clock

**The trust boundary.** The host (the local Dispatcher, #978) owns the VMM, the root file system and the kernel of the VM: it is **trusted**. What vm-init accepts
from it is checked (the contract, the image binding, the credential not in an argument), but the deny-list on `control.args` (`--privileged`, `seccomp=unconfined`,
`apparmor=unconfined`, `--pid`, `--net`, `--network`, `--ipc`, `--userns`, `--uts` with `host`, `--device`, `--cap-add ALL`, `--volume`, and every `--mount` but the
job's work volume and the Docker socket) only catches a **bug of the Dispatcher** that renders such an option; it is no defence against a host that is hostile, which
could as well send a different VM. What is **not** trusted is everything inside the VM that runs the job: the agent, its container, its tools.

**The token.** Something in the VM must not be able to talk to the host as Control or as vm-init. The agent's container has Docker's default seccomp profile, which
refuses `socket(AF_VSOCK)`, and the kernel of the root file system is built without the 32-bit system-call interfaces (IA32 and X32 emulation, #976) through which a
call that profile does not cover could be made; but that denial is a **defence in depth, an assumption, and not what the host trusts**. The host trusts a per-VM token:

- the host makes a random `controlToken` for each VM (`generateControlToken`, `dispatcher/src/launchers/control-token.ts`) and sends it in the start;
- vm-init puts it in **every exit report** it sends after it read a start; Control gets it on its **stdin** with the credential (the Worker reads it from the start
  document, hands it to its job process on that process's stdin, and the environment control puts it in every `narrow` and `end`). It is never in an argument,
  the environment, a file or a log (tests look for it everywhere the guest writes);
- the host checks it with the same file's helpers (`verifyControlMessage`, `verifyExitReport`, constant time) and refuses a message without it or with another one.
  A VM that never took a start (`start_timeout`, `start_invalid`, a daemon that did not start) cannot know it: the host accepts a report without a token only while it has
  no `ack` for the start of that VM, when no job and no agent exists.

**The wall clock is the host's.** vm-init has no timer for the job: Control's own job timeout (`RUNNER_JOB_TIMEOUT_SECONDS`) ends a job that runs too long, and a VM that
is still there when the host's limit passes is killed by the host, which holds the VMM's process (#978). vm-init's only timers are the contract's start and report times.
vm-init sets its own `oom_score_adj` to -1000, so that the guest's OOM killer picks anything but the process that tells the host how the VM ended.

## Decisions

### Language: Python, standard library only

vm-init is about a thousand lines (a third of them comments) of sockets, subprocesses and JSON. The alternatives were Go (a static binary: no interpreter in the root file system) and
TypeScript (the Dispatcher's language: the same renderer would run in the guest, but with Node in a rootfs that otherwise has none).

- **Python** is the language of the runner and of the Worker's own vsock client (`environment_control.py`, same framing), so the whole job-side path
  is one language, and the tests run in the lane that already exists: pytest with `--disable-socket --allow-unix-socket` (a fake vsock built on socket pairs,
  real framing), pyright strict, ruff. The spike's vsock agent was Python and measured 0.6 ms per request. The cost is an interpreter in the root file
  system (`python3` with its standard library) and its start: measured on this loaded server (not in a guest), `vm-init --version` from the installed zipapp takes
  a median of 90 ms (76 to 113 ms, ten runs) and 16 MB of resident memory; the time in a real guest is #978's to measure.
- **Go** would save that interpreter and nothing else: it adds a toolchain, a module license check and a language to CI that no other part has, cannot be tested
  on this server's toolchain, and the code is I/O glue where Go's strength (concurrency, a single binary) does not matter.
- **Node** would make the rendering of `docker run` run in the guest. It is not needed: the Dispatcher renders and the guest executes (below), and a
  Node runtime is the heaviest of the three for a rootfs.

The package imports the standard library and itself, nothing else (a test checks it), so the install hook can pack it as a zipapp.

### The `docker run` arguments come from the Dispatcher, rendered once

The hosted flags come from one definition (`container-spec.ts`, rendered by `renderDockerRunArguments`). vm-init does not render them again in Python;
the Dispatcher renders them for the local spec and sends them in the start (`control.args`), vm-init runs them. So "the same arguments as hosted" is
the same code, and the guarantee is a golden test, not a second implementation kept in step by hand:

- `dispatcher/src/launchers/local-control.test.ts` pins `docker-run.local-control.golden.json` and that the local rendering is the hosted Implementer
  rendering with exactly two more things.
- the runner's `test_vm_init_agent.py` feeds that golden file to the guest unchanged and checks that `docker` gets exactly it.
- The steps vm-init makes itself (they are Python, they have no `docker run` form) are held to `vm-steps.golden.json`, which the Dispatcher's test writes
  from its own constants (`RUN_DIRECTORY_COMMANDS`, `IPV6_OFF_COMMANDS`, `workVolumeCommands`) and the runner's test reads.

**The local spec** (`LOCAL_IMPLEMENTER_CONTAINER_SPEC`) is the hosted Implementer spec with one more name in its allow-list, `RUNNER_ENVIRONMENT_CONTROL`
(deliberately not in the hosted list; the hosted specs and `docker-run.sandbox.golden.json` are untouched, and the tests say the hosted renderer
refuses the name), the hosted environment (`environmentOf`, exported for it), the Sandbox variant's IPv6 switches, and a seccomp profile for Control alone.

### Why there is no relay: Control talks to the host itself

The issue asked whether vm-init should relay Control's `narrow` and `end` to the host (a guest-side listener that Control connects to, forwarded to CID 2,
port 5100) or whether Control should connect itself. **Control connects itself**, and the contract of #975 stays as it is, because:

- the Worker's contract is fixed to the host: it connects AF_VSOCK to `ControlHostCid` 2 on `ControlPort` 5100 and the constants are held by a contract
  test. A relay would need the Worker to connect somewhere else (another CID or a port of its own), which changes #975;
- a relay is a second hop with its own failure modes (a listener that is not up yet when Control starts, a hop that dies, two timeouts instead of
  one) in front of a call whose failure ends the job (`environment_control_failed`) and whose answer must be an `ack` only after the outer wall holds the
  rule: the host's answer should reach the Worker directly;
- what a relay would buy is a Control container without AF_VSOCK. Only Control gets the seccomp profile that allows it: the agent's container, the model door, the
  network door and the readers keep Docker's default profile, which refuses AF_VSOCK. That is **defence in depth**: the claim that the agent cannot open a vsock socket
  is an assumption (Docker's default profile allows `socketcall`, and with 32-bit emulation in the kernel a 32-bit call could open one; the kernel of #976 has none).
  What the host trusts is the per-VM token (above), which every message from the VM carries; the host treats every vsock connection from the VM as coming from the guest as
  a whole, which includes Control, and refuses one without the token.

vm-init's part in the environment control is therefore the enabling: `RUNNER_ENVIRONMENT_CONTROL=vsock` in Control's environment and the seccomp
profile. The exit report is vm-init's own, on its own port (5101): it is sent when `docker run` ends, whether or not Control said `end`.

### The seccomp profile

Docker's default profile allows `socket` for every family except AF_VSOCK (a condition on the first argument, `SCMP_CMP_NE 40`). The Control container's
Worker needs AF_VSOCK. `control-seccomp.json` is Docker's default profile of the pinned version (29.1.3, moby `vendor/github.com/moby/profiles/seccomp/default.json`,
Apache-2.0, kept as `dispatcher/src/launchers/testdata/docker-default-seccomp-29.1.3.json`) with that one condition taken out; `allowSocketFamilies` in
`dispatcher/src/launchers/seccomp.ts` derives it, and a test holds the file equal to the derivation (so the file is never edited by hand and a Docker bump
is: copy the new default, run the derivation, replace the file, and the test says when they differ). It is passed as `--security-opt seccomp=/etc/code-reviewer/control-seccomp.json`
(the Docker CLI reads the file where it runs: in the guest). The local spec allows only this profile, never `unconfined`.

## What the root file system must provide (for #976)

- Run `runner/vm-init/install.sh <root>`: it writes `/usr/local/sbin/vm-init` (a zipapp; the shebang is `/usr/bin/python3`, `VM_INIT_PYTHON` changes it) and
  `/etc/code-reviewer/control-seccomp.json`. The output is byte for byte the same on every run from the same sources.
- **`python3` 3.12 or newer** (the code uses `enum.StrEnum`, `dataclasses`, `socket.AF_VSOCK`; no third-party package).
- **Start it from the guest's init, after the file systems and before anything that needs Docker**, as root and not as PID 1:
  `/usr/local/sbin/vm-init` (no arguments; `--version` prints the contract's constants). It runs until the VM ends; if it returns, the VM did not end
  (the power off was refused) and the init must end it. Exit status 1: the power off was refused; 64: unknown arguments.
- **The init does not run `vm-prepare.sh` or `sysbox-prepare.sh`**, or the three runtime-directory and IPv6 steps before the daemon: vm-init does, in the
  hosted order, and skips the steps before the daemon when one already answers. What the init does keep (what the hosted platform does before the
  Launcher's first command): `/proc`, `/sys`, `/dev` (devtmpfs, with `/dev/loop-control` for the reserve disk), the cgroup v2 mount with `cpuset cpu io memory pids`
  enabled in the root's `subtree_control`, a writable job disk mounted where Docker's data root, `/var/lib/sysbox` and `/var/lib/code-reviewer-work` live
  (the work volume's directory must be on the job disk: its reserve image is a file in it), a tmpfs at `/var/lib/sysboxfs`, networking, and the kernel
  command line with `reboot=k` (a restart ends a Firecracker VM, the power off does not: `power.py`).
- Installed at the paths the hosted scripts have: `/usr/local/sbin/vm-prepare.sh` and `/usr/local/sbin/sysbox-prepare.sh` from `docker/sandbox/`, unchanged.
- Programs the steps call: `docker` (CLI and daemon), `mount`, `mkdir`, `fallocate`, `mkfs.ext4` (e2fsprogs), `cat`, `env`, `sh`.
- The Worker image loaded into Docker under the tag `code-reviewer-worker:golden` (the manifest's image id is what the host sends; the id must match).
- A kernel with `CONFIG_VSOCKETS`, `CONFIG_VIRTIO_VSOCKETS` and `CONFIG_BLK_DEV_LOOP` (all in the spike's fragment).

## What the local Dispatcher must do (for #978)

- Listen on `<vsock uds path>_5100` (environment control) and `<vsock uds path>_5101` (exit report) **before** the VM starts; connect to
  `<vsock uds path>` with `CONNECT 5000` once the VM is up and send the `StartRequest`; read the `ack`.
- Make a token for the VM (`generateControlToken`) and build the start with `buildStartRequest` (`local-control.ts`): the arguments, the job document, the token,
  the image id from the verified manifest (the image operand of the arguments is that id), the work volume.
- Check the token of every message with `verifyControlMessage` (`narrow`, `end`) and `verifyExitReport` (`startAcked`: whether the host has an `ack` for the start),
  and refuse (or close) what fails. Take the **first** exit report that passes; answer a repeated one with the same `ack`.
- Treat the exit report as the end of the job and the VMM as to be killed after it (and after `ReportSeconds` without one). A VM that ends with no report
  ended with an unknown outcome. **The wall clock is the host's**: kill the VMM when the job's limit passes; vm-init does not keep time for the job.

## Tests, and what they do not prove

Unit tests (`runner/tests/unit/test_vm_init_*.py`) drive the whole sequence over a fake vsock made of socket pairs; contract tests hold the constants and
documents to `contracts/vm-init.v1.json`; the integration tests start real processes (a `docker` script of the test, the install hook, the zipapp run
without the runner). **No test opens an AF_VSOCK socket, boots a VM or runs the real Docker and Sysbox: that is the Firecracker lane of #978** (KVM in
GitHub Actions, #970), which also measures the time to "Control could start" with vm-init in the path. Not measured here: the interpreter's start and memory in the
real guest (above: only on this server).

The secrets: the credential, the local credential and the token live in the memory of the process and in the pipe to Control's stdin (the token also in the report, which is
where the host reads it). A test starts a job with all three
and looks for them in every command, argument, log record, standard output and error, reply, report and file the guest wrote; another starts one that
is refused and one that fails unexpectedly.
