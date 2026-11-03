# SPDX-License-Identifier: LicenseRef-Proprietary

"""The Setup container (#818, step 5 of `plans/implementer-sandbox.md`): the environment's script
runs here, once, before the model is called, and what it leaves behind becomes the agent's image.

Control starts a throwaway container from the agent's own image, under `sysbox-runc`, as root, with
its own `dockerd` and the repository (the same Subpath of the work volume the agent will get). The
script from the environment runs in it as an exec: `bash -e` (or the interpreter of its `#!` line),
working directory the repository, root, all of the image's tools. When it ends with status 0 the
container's own Docker is stopped, the container is stopped, and its file system, with whatever the
script installed and whatever images its inner Docker pulled, is committed (`docker commit`) as the
image the Agent container starts from. Then the Setup container is removed.

**What it has: nothing of ours.** No git token, no model key, no job token, no environment variable
of its own, no mount but the repository, no socket, no device. Its definition is made of constants
and of identifiers the daemon gave (as the agent's is), and Control reads the container back from
the daemon before it runs the script, as it does for the agent. The script is free inside it: it has
root, the internet and Docker. The script's text is data written by a member of the workspace, and
the only place it is ever put is a file in this container.

**How it reaches the internet and nothing of ours.** The container is alone on a network of its own
(`SETUP_NETWORK_NAME`, a bridge named `SETUP_BRIDGE`, not internal, so Docker masquerades its
traffic to the internet). Its way to Control, the model door, the VM's services (the control port
`23456` among them), the platform's own addresses and every private range is closed **in the VM's
own network namespace**, by a table of `nft` rules that a one-shot container with `NET_ADMIN` in
the host's namespace installs before the Setup container exists (`EGRESS_RULES`). The rules are on
the VM's side of the bridge, not in the container: the container is root of a user namespace of its
own and owns its network namespace, so anything installed inside it, the script could remove; the
host's rules, it cannot reach. Packets from its bridge to the VM itself (input) are dropped; packets
that would be routed anywhere private, or into another bridge (the default bridge Control is on,
the model network), or over IPv6, are dropped; the rest of the internet is open on every port,
which includes the inner containers of its own Docker (their traffic is routed through the
container's address). DNS goes to public resolvers named in the container's definition, because the
VM's own resolver is on a private address. A Setup whose rules did not go in is never started.

**The result.** The end of the script's output (stdout and stderr together, bounded to the last
`OUTPUT_KEEP_BYTES`), its exit status, whether it ran out of time and the image id. A script that
exits non-zero, runs past its time limit, or leaves a disk that cannot hold the commit, ends the
turn before the model is used (`environment_setup.py`).
"""

import contextlib
import logging
import socket
import threading
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any, Final

from code_reviewer_runner.job_loop.jsonvalues import as_object

from .agent_container import (
    AGENT_ENTRYPOINT,
    AGENT_IMAGE_REFERENCE,
    AGENT_PIDS_LIMIT,
    AGENT_REPO,
    AGENT_RUNTIME,
    READY_FILE,
    WRITE_FILE_SCRIPT,
)
from .docker_api import DockerApi, DockerError
from .door_launcher import PRIVATE_RANGES, RULES_ENTRYPOINT
from .exec_run import exec_document, run_exec
from .reader import REPO_SUBPATH, work_volume_of

_log = logging.getLogger(__name__)

SETUP_CONTAINER_NAME: Final = "code-reviewer-setup"
SETUP_RULES_CONTAINER_NAME: Final = "code-reviewer-setup-rules"
SETUP_ROLE_LABEL: Final = "code-reviewer.role"
SETUP_NETWORK_NAME: Final = "code-reviewer-setup"
# The bridge's own name, so that the rules can name it before it exists (a name is matched when a
# packet comes in).
SETUP_BRIDGE: Final = "crsetup0"
SETUP_NETWORK_SUBNET: Final = "10.213.78.0/29"
SETUP_NETWORK_GATEWAY: Final = "10.213.78.1"
SETUP_ADDRESS: Final = "10.213.78.2"
# Public resolvers: the VM's resolver is on a private address the rules close.
SETUP_DNS: Final = ("1.1.1.1", "8.8.8.8")
# The image the committed result gets: the agent's repository name and a tag of its own.
SETUP_IMAGE_REPOSITORY: Final = "code-reviewer-agent"
SETUP_IMAGE_TAG: Final = "environment"
SETUP_HOSTNAME: Final = "setup"

SCRIPT_PATH: Final = "/tmp/code-reviewer-setup.sh"
BASH: Final = "/bin/bash"
SH: Final = "/bin/sh"
# The environment of the script: the image's own, and these two (no terminal, no prompt, a home).
SCRIPT_ENVIRONMENT: Final = {"HOME": "/root", "DEBIAN_FRONTEND": "noninteractive"}
# The script runs through this (the script path is the one argument); a script that starts with a
# `#!` line is executed as itself.
RUN_SCRIPT: Final = (
    'if head -c 2 "$1" | grep -q "^#!"; then chmod 700 "$1"; exec "$1" 2>&1; '
    'else exec /bin/bash -e "$1" 2>&1; fi'
)

# What happens after a script that ended well: remove the script's file, then stop the container's
# Docker the way a daemon is stopped (SIGTERM, wait), so that its images are on disk in one piece. The
# container's init ends with the daemon and the container stops by itself. Exit status 1: it did not
# stop in time. A container with no daemon (the test lane under runc) has no pid file: nothing to do.
FINISH_SCRIPT: Final = r"""
rm -f "$1"
pid=$(cat /var/run/docker.pid 2>/dev/null) || exit 0
kill -TERM "$pid" 2>/dev/null || exit 0
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i + 1))
  [ "$i" -gt 1500 ] && exit 1
  sleep 0.2
done
"""

# The VM's firewall for the Setup container's bridge (see the module text). An `inet` table in the
# host's namespace, hooked before Docker's own rules (priority -10), whose only verdicts are drops:
# whatever it does not drop goes on to Docker's rules as before. Rules for a bridge that does not
# exist yet are fine, a name is matched when a packet arrives.
EGRESS_TABLE: Final = "setup_egress"
EGRESS_RULES: Final = "; ".join(
    [
        f"add table inet {EGRESS_TABLE}",
        # To the VM itself (its control port, its services, the bridge's gateway, Docker's DNS): nothing.
        f"add chain inet {EGRESS_TABLE} input "
        "{ type filter hook input priority -10 ; policy accept ; }",
        f'add rule inet {EGRESS_TABLE} input iifname "{SETUP_BRIDGE}" drop',
        # Through the VM: no IPv6, no private range (the platform, the neighbours, the other
        # containers), no other bridge (Control's, the door's, the model network), nowhere but out.
        f"add chain inet {EGRESS_TABLE} forward "
        "{ type filter hook forward priority -10 ; policy accept ; }",
        f'add rule inet {EGRESS_TABLE} forward iifname "{SETUP_BRIDGE}" meta nfproto ipv6 drop',
        f'add rule inet {EGRESS_TABLE} forward iifname "{SETUP_BRIDGE}" '
        f"ip daddr {{ {', '.join(PRIVATE_RANGES)} }} drop",
        f'add rule inet {EGRESS_TABLE} forward iifname "{SETUP_BRIDGE}" oifname "docker0" drop',
        f'add rule inet {EGRESS_TABLE} forward iifname "{SETUP_BRIDGE}" oifname "br-*" drop',
        f'add rule inet {EGRESS_TABLE} forward iifname "{SETUP_BRIDGE}" oifname "veth*" drop',
        f'add rule inet {EGRESS_TABLE} forward oifname "{SETUP_BRIDGE}" iifname "docker0" drop',
        f'add rule inet {EGRESS_TABLE} forward oifname "{SETUP_BRIDGE}" iifname "br-*" drop',
    ]
)
CHECK_RULES: Final = f"list table inet {EGRESS_TABLE}"
RULES_SECONDS: Final = 20.0

# How long each part may take. The script's own limit comes from the caller (it is counted in the
# turn's time budget); these are the parts around it, and `SETUP_OVERHEAD_SECONDS` is their sum: what
# the caller must leave besides the script.
READY_SECONDS: Final = 60.0
FINISH_EXEC_SECONDS: Final = 330.0
STOP_GRACE_SECONDS: Final = 20
STOP_WAIT_SECONDS: Final = 40.0
COMMIT_SECONDS: Final = 300.0
REMOVE_SECONDS: Final = 120.0
SETUP_OVERHEAD_SECONDS: Final = (
    RULES_SECONDS * 2
    + READY_SECONDS
    + FINISH_EXEC_SECONDS
    + STOP_WAIT_SECONDS
    + COMMIT_SECONDS
    + REMOVE_SECONDS
)
# The most of the script's output that is kept: its end.
OUTPUT_KEEP_BYTES: Final = 64 * 1024
WATCH_SECONDS: Final = 0.25
KILL_SECONDS: Final = 15.0

OUTCOME_OK: Final = "ok"
OUTCOME_SCRIPT_FAILED: Final = "script_failed"
OUTCOME_TIMED_OUT: Final = "timed_out"
OUTCOME_STOPPED: Final = "stopped"
OUTCOME_UNAVAILABLE: Final = "unavailable"
OUTCOME_NOT_SAVED: Final = "not_saved"


def network_document() -> dict[str, Any]:
    """The Setup container's network: a bridge of its own that reaches the internet (Docker
    masquerades it) and that the VM's rules close towards everything of ours."""
    return {
        "Name": SETUP_NETWORK_NAME,
        "Driver": "bridge",
        "Internal": False,
        "Attachable": False,
        "EnableIPv6": False,
        "IPAM": {
            "Driver": "default",
            "Config": [{"Subnet": SETUP_NETWORK_SUBNET, "Gateway": SETUP_NETWORK_GATEWAY}],
        },
        "Options": {"com.docker.network.bridge.name": SETUP_BRIDGE},
        "Labels": {SETUP_ROLE_LABEL: "setup-network"},
    }


def rules_document(image: str, command: str) -> dict[str, Any]:
    """The one-shot container that installs (or reads back) the VM's rules for the Setup bridge: the
    host's network namespace, `NET_ADMIN` and no other capability, no mount, one constant command."""
    return {
        "Image": image,
        "Entrypoint": RULES_ENTRYPOINT,
        "Cmd": [command],
        "User": "0:0",
        "Env": [],
        "Labels": {SETUP_ROLE_LABEL: "setup-rules"},
        "HostConfig": {
            "NetworkMode": "host",
            "Privileged": False,
            "ReadonlyRootfs": True,
            "CapDrop": ["ALL"],
            "CapAdd": ["NET_ADMIN"],
            "SecurityOpt": ["no-new-privileges:true"],
            "Memory": 64 * 1024 * 1024,
            "MemorySwap": 64 * 1024 * 1024,
            "PidsLimit": 16,
            "RestartPolicy": {"Name": "no"},
        },
    }


def setup_document(
    image: str,
    work_volume: str,
    memory_bytes: int,
    *,
    runtime: str = AGENT_RUNTIME,
    entrypoint: Sequence[str] | None = None,
) -> dict[str, Any]:
    """The Setup container: the agent's image, the agent's limits, the repository and nothing else.
    Constants, the image id, the volume name the daemon gave and the memory the Dispatcher computed.
    No environment variable, no secret, no job."""
    return {
        "Image": image,
        "Entrypoint": list(AGENT_ENTRYPOINT if entrypoint is None else entrypoint),
        "Cmd": [],
        "User": "0:0",
        "Env": [],
        "Hostname": SETUP_HOSTNAME,
        "WorkingDir": AGENT_REPO,
        "Labels": {SETUP_ROLE_LABEL: "setup"},
        "NetworkingConfig": {
            "EndpointsConfig": {
                SETUP_NETWORK_NAME: {"IPAMConfig": {"IPv4Address": SETUP_ADDRESS}}
            }
        },
        "HostConfig": {
            "Runtime": runtime,
            "NetworkMode": SETUP_NETWORK_NAME,
            "Dns": list(SETUP_DNS),
            "Privileged": False,
            "Memory": memory_bytes,
            "MemorySwap": memory_bytes,
            "PidsLimit": AGENT_PIDS_LIMIT,
            "RestartPolicy": {"Name": "no"},
            "PublishAllPorts": False,
            "Mounts": [
                {
                    "Type": "volume",
                    "Source": work_volume,
                    "Target": AGENT_REPO,
                    "ReadOnly": False,
                    "VolumeOptions": {"Subpath": REPO_SUBPATH, "NoCopy": True},
                }
            ],
        },
    }


class Tail:
    """The last `limit` bytes of a stream and how many came in all. Memory is bounded whatever the
    script prints."""

    def __init__(self, limit: int = OUTPUT_KEEP_BYTES) -> None:
        self._limit = limit
        self._data = bytearray()
        self.total = 0

    def add(self, chunk: bytes) -> None:
        self.total += len(chunk)
        self._data += chunk
        if len(self._data) > 2 * self._limit:
            del self._data[: -self._limit]

    def value(self) -> bytes:
        return bytes(self._data[-self._limit :])


@dataclass(frozen=True)
class SetupRun:
    """How a run of the Setup container went. `outcome` is one of the `OUTCOME_*` words; `detail` is
    a sentence of ours (never a value of the job) for the outcomes that have no script output;
    `image` is the committed image's id after `OUTCOME_OK`."""

    outcome: str
    exit_code: int | None
    output: bytes
    output_bytes: int
    image: str | None
    detail: str
    start_seconds: float
    script_seconds: float
    save_seconds: float
    # The size of the committed image in bytes (None when it was not asked for or not made).
    image_bytes: int | None = None

    @property
    def ok(self) -> bool:
        return self.outcome == OUTCOME_OK


@dataclass(frozen=True)
class SetupSeams:
    """What the tests replace; production leaves the defaults. The image is the agent's; the test
    lane without Sysbox names the runtime and the entry point the agent's lane names."""

    api: Callable[[], DockerApi] = DockerApi
    hostname: Callable[[], str] = socket.gethostname
    clock: Callable[[], float] = time.monotonic
    image: str = AGENT_IMAGE_REFERENCE
    runtime: str = AGENT_RUNTIME
    entrypoint: Sequence[str] | None = None
    ready_seconds: float = READY_SECONDS
    commit_seconds: float = COMMIT_SECONDS
    finish_seconds: float = FINISH_EXEC_SECONDS
    # False only in a test that has no host namespace to put rules in (never in production).
    install_rules: bool = True


class _Unavailable(Exception):
    """A step before the script that could not be done; the word is the reason."""


class SetupContainer:
    """One run of the Setup container. `run` does everything and always ends with the container and
    the network removed; it does not raise for a script that failed."""

    def __init__(self, memory_mb: int, seams: SetupSeams = SetupSeams()) -> None:  # noqa: B008
        self._api = seams.api()
        self._seams = seams
        self._memory_bytes = memory_mb * 1024 * 1024
        self._container: str | None = None
        self._network: str | None = None
        self._ended = threading.Event()

    # -- the whole run -----------------------------------------------------------------------------

    def run(
        self,
        script: str,
        *,
        script_seconds: float,
        should_stop: Callable[[], bool] = lambda: False,
    ) -> SetupRun:
        clock = self._seams.clock
        begun = clock()
        tail = Tail()
        try:
            container = self._start()
        except _Unavailable as reason:
            self._clean()
            return self._ended_run(OUTCOME_UNAVAILABLE, str(reason), tail, begun, begun, begun)
        except DockerError as error:
            self._clean()
            detail = f"the daemon refused a step ({error.status}: {error.message[:160]})"
            return self._ended_run(OUTCOME_UNAVAILABLE, detail, tail, begun, begun, begun)
        except BaseException:
            self._clean()
            raise
        started = clock()
        try:
            outcome, code, why = self._script(container, script, script_seconds, should_stop, tail)
            finished = clock()
            if outcome != OUTCOME_OK:
                self._clean()
                return self._ended_run(outcome, why, tail, begun, started, finished, code=code)
            try:
                image = self._save(container)
            except _Unavailable as reason:
                self._clean()
                return self._ended_run(
                    OUTCOME_NOT_SAVED, str(reason), tail, begun, started, finished, code=code
                )
            except DockerError as error:
                self._clean()
                detail = f"the image could not be saved ({error.status}: {error.message[:160]})"
                return self._ended_run(
                    OUTCOME_NOT_SAVED, detail, tail, begun, started, finished, code=code
                )
            saved = clock()
            size = self._image_bytes(image)
            self._clean()
            return SetupRun(
                outcome=OUTCOME_OK,
                exit_code=code,
                output=tail.value(),
                output_bytes=tail.total,
                image=image,
                detail="",
                start_seconds=started - begun,
                script_seconds=finished - started,
                save_seconds=saved - finished,
                image_bytes=size,
            )
        except BaseException:
            self._clean()
            raise

    def _ended_run(
        self,
        outcome: str,
        detail: str,
        tail: Tail,
        begun: float,
        started: float,
        finished: float,
        *,
        code: int | None = None,
    ) -> SetupRun:
        return SetupRun(
            outcome=outcome,
            exit_code=code,
            output=tail.value(),
            output_bytes=tail.total,
            image=None,
            detail=detail,
            start_seconds=started - begun,
            script_seconds=finished - started,
            save_seconds=0.0,
        )

    # -- the start ---------------------------------------------------------------------------------

    def _start(self) -> str:
        api = self._api
        own = api.inspect_container(self._seams.hostname())
        worker_image = str(own.get("Image", ""))
        volume = work_volume_of(own)
        image = str(api.inspect_image(self._seams.image).get("Id", ""))
        if not worker_image or not image:
            raise _Unavailable("setup_unavailable: an image of the VM is missing")
        if self._seams.runtime not in api.runtimes():
            raise _Unavailable(f"setup_unavailable: the daemon has no {self._seams.runtime} runtime")
        # A network of an earlier run (a VM runs one turn, but a retry of the step must not trip).
        api.remove_network(SETUP_NETWORK_NAME)
        if self._seams.install_rules:
            self._rules(worker_image, EGRESS_RULES)
            self._rules(worker_image, CHECK_RULES)
        self._network = api.create_network(network_document())
        container = api.create_container(
            setup_document(
                image,
                volume,
                self._memory_bytes,
                runtime=self._seams.runtime,
                entrypoint=self._seams.entrypoint,
            ),
            SETUP_CONTAINER_NAME,
        )
        self._container = container
        api.start_container(container)
        threading.Thread(target=self._watch_end, args=(container,), daemon=True).start()
        self._wait_ready(container)
        self._seal_check(container, image)
        return container

    def _rules(self, image: str, command: str) -> None:
        """Run the rules container once. Raises `_Unavailable` unless it ended with status 0: a
        Setup whose rules are not in place is not started."""
        api = self._api
        helper = api.create_container(rules_document(image, command), SETUP_RULES_CONTAINER_NAME)
        try:
            api.start_container(helper)
            code = api.wait_container(helper, timeout=RULES_SECONDS)
        finally:
            try:
                api.remove_container(helper)
            except DockerError as error:
                _log.warning("the setup rules container could not be removed (%s)", error.status)
        if code != 0:
            raise _Unavailable(
                f"setup_unavailable: the network rules could not be installed (exit code {code})"
            )

    def _wait_ready(self, container: str) -> None:
        end = self._seams.clock() + self._seams.ready_seconds
        while True:
            if self._ended.is_set():
                raise _Unavailable("setup_unavailable: the container ended before its Docker was ready")
            done = run_exec(self._api, container, ["/usr/bin/test", "-e", READY_FILE], timeout=10.0)
            if done.returncode == 0 and not done.unanswered:
                return
            if self._seams.clock() >= end:
                raise _Unavailable("setup_unavailable: the container's Docker did not become ready")
            time.sleep(0.2)

    def _seal_check(self, container: str, image: str) -> None:
        """Read the container back from the daemon: exactly what was asked, nothing of ours in it.
        Anything that would put the VM or a secret within the script's reach stops the run before
        the script is written."""
        document = self._api.inspect_container(container)
        host = as_object(document.get("HostConfig")) or {}
        config = as_object(document.get("Config")) or {}
        settings = as_object(document.get("NetworkSettings")) or {}
        networks = as_object(settings.get("Networks")) or {}
        mounts = document.get("Mounts")
        problems: list[str] = []
        if host.get("Privileged"):
            problems.append("privileged")
        if host.get("Runtime") != self._seams.runtime:
            problems.append("runtime")
        if (
            host.get("Binds")
            or host.get("Devices")
            or host.get("PidMode")
            or host.get("IpcMode") == "host"
        ):
            problems.append("host access")
        if set(networks) != {SETUP_NETWORK_NAME}:
            problems.append("networks")
        destinations: set[object] = set()
        for mount in mounts if isinstance(mounts, list) else []:
            given = as_object(mount)
            destinations.add(None if given is None else given.get("Destination"))
        if destinations - {AGENT_REPO}:
            problems.append("mounts")
        # Not one variable besides the image's own.
        given_env = config.get("Env")
        image_config = as_object(self._api.inspect_image(image).get("Config")) or {}
        image_env = image_config.get("Env")
        if set(given_env if isinstance(given_env, list) else []) != set(
            image_env if isinstance(image_env, list) else []
        ):
            problems.append("environment")
        if problems:
            self._kill()
            raise _Unavailable(
                "setup_unavailable: the container is not what was asked for ("
                + ", ".join(problems)
                + ")"
            )

    def _watch_end(self, container: str) -> None:
        with contextlib.suppress(DockerError):
            self._api.request(
                "POST", f"/containers/{container}/wait", timeout=3 * 3600.0, ok=(200,)
            )
        self._ended.set()

    # -- the script --------------------------------------------------------------------------------

    def _script(
        self,
        container: str,
        script: str,
        seconds: float,
        should_stop: Callable[[], bool],
        tail: Tail,
    ) -> tuple[str, int | None, str]:
        """Write the script to a file in the container and run it. The outcome word, the exit
        status (None when it did not end by itself) and a sentence of ours when there is one to say
        (the container went away under the script)."""
        written = run_exec(
            self._api,
            container,
            [SH, "-c", WRITE_FILE_SCRIPT, "write", SCRIPT_PATH, "700"],
            stdin=script.encode("utf-8"),
            timeout=30.0,
            name="write the script",
        )
        if written.returncode != 0 or written.unanswered:
            return OUTCOME_UNAVAILABLE, None, "setup_unavailable: the script could not be written"
        done: list[Any] = []

        def work() -> None:
            done.append(
                run_exec(
                    self._api,
                    container,
                    [SH, "-c", RUN_SCRIPT, "run", SCRIPT_PATH],
                    env=SCRIPT_ENVIRONMENT,
                    workdir=AGENT_REPO,
                    timeout=seconds + 60.0,
                    consume=tail.add,
                    name="the setup script",
                )
            )

        worker = threading.Thread(target=work, daemon=True)
        worker.start()
        clock = self._seams.clock
        end = clock() + seconds
        why: str | None = None
        while worker.is_alive():
            worker.join(WATCH_SECONDS)
            if not worker.is_alive():
                break
            if self._ended.is_set():
                why = OUTCOME_SCRIPT_FAILED
                break
            if should_stop():
                why = OUTCOME_STOPPED
                break
            if clock() >= end:
                why = OUTCOME_TIMED_OUT
                break
        if why is not None:
            self._kill()
            worker.join(KILL_SECONDS)
            return why, None, self._lost() if why == OUTCOME_SCRIPT_FAILED else ""
        outcome = done[0]
        if outcome.unanswered:
            # The exec ended without a status: the container went away under it, or the daemon
            # stopped answering. The first is the script's doing (its memory), the second is ours.
            lost = self._lost() if self._ended.wait(2.0) else ""
            if lost:
                return OUTCOME_SCRIPT_FAILED, None, lost
            return OUTCOME_UNAVAILABLE, None, "setup_unavailable: the script's status is unknown"
        if outcome.returncode != 0:
            return OUTCOME_SCRIPT_FAILED, outcome.returncode, ""
        return OUTCOME_OK, 0, ""

    def _lost(self) -> str:
        """How the container went away during the script, in words: the kernel's memory kill is the
        usual way, and it is the script's (it ran past the agent's memory)."""
        container = self._container
        if container is None:
            return "the container ended during the script"
        try:
            state = as_object(self._api.inspect_container(container).get("State")) or {}
        except DockerError:
            return "the container ended during the script"
        code = state.get("ExitCode")
        how = (
            "was killed for its memory"
            if state.get("OOMKilled") is True or code == 137
            else "stopped"
        )
        return f"the container ended during the script: it {how}" + (
            f" (exit code {code})" if isinstance(code, int) and not isinstance(code, bool) else ""
        )

    def _image_bytes(self, image: str) -> int | None:
        try:
            size = self._api.inspect_image(image).get("Size")
        except DockerError:
            return None
        return size if isinstance(size, int) and not isinstance(size, bool) else None

    # -- the result --------------------------------------------------------------------------------

    def _save(self, container: str) -> str:
        """Stop the container's Docker and then the container, and commit its file system. Under
        Sysbox the stop is what writes the inner Docker's images into the file system the commit
        reads."""
        api = self._api
        finished = run_exec(
            api,
            container,
            [SH, "-c", FINISH_SCRIPT, "finish", SCRIPT_PATH],
            timeout=self._seams.finish_seconds,
            name="the end of the setup",
        )
        if finished.returncode != 0 or finished.unanswered:
            raise _Unavailable("the container's Docker did not stop in time, so its images are not kept")
        api.stop_container(container, grace=STOP_GRACE_SECONDS, timeout=STOP_WAIT_SECONDS + 30.0)
        if not self._ended.wait(STOP_WAIT_SECONDS):
            raise _Unavailable("the container did not stop, so its file system is not kept")
        return api.commit_container(
            container, SETUP_IMAGE_REPOSITORY, SETUP_IMAGE_TAG, timeout=self._seams.commit_seconds
        )

    # -- the end -----------------------------------------------------------------------------------

    def _kill(self) -> None:
        container = self._container
        if container is not None:
            try:
                self._api.kill_container(container, timeout=KILL_SECONDS)
            except DockerError as error:
                _log.warning("the setup container could not be killed (%s)", error.status)

    def _clean(self) -> None:
        """Take the container, with everything in it, and the network away. Each step on its own:
        a step that fails costs nothing and stops nothing (the VM goes with the turn)."""
        container, self._container = self._container, None
        network, self._network = self._network, None
        if container is not None:
            self._kill()
            try:
                self._api.remove_container(container, timeout=REMOVE_SECONDS)
            except DockerError as error:
                _log.warning("the setup container could not be removed (%s)", error.status)
        if network is not None:
            try:
                self._api.remove_network(network)
            except DockerError as error:
                _log.warning("the setup network could not be removed (%s)", error.status)


__all__ = ["SETUP_OVERHEAD_SECONDS", "SetupContainer", "SetupRun", "SetupSeams"]
