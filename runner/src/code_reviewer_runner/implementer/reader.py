# SPDX-License-Identifier: LicenseRef-Proprietary

"""The reader: where Control looks at the agent's repository (#745, step 4).

The agent's repository is the agent's: it can hold hooks, a hostile `config`, symlinks, alternates
and anything else git will act on. Control (root, with the token) never opens it. Every git command
that has to look inside it runs in the **reader**, a container of its own that has the repository
and nothing else: no network (`none`), no token, no secret, no socket, no other mount, a read-only
root file system and a small memory limit. Whatever a repository's config makes git run, it runs
there, and it must not matter.

**What makes it not matter: the runtime.** The reader runs under `sysbox-runc`, the runtime the
agent runs under, with no capability added: its root is an unprivileged user of the VM (a mapped
uid), and what it holds as capabilities exists inside its own user namespace only. An earlier
reader ran on plain runc as the VM's root with `DAC_READ_SEARCH` and `DAC_OVERRIDE`, and the default
seccomp profile allows `open_by_handle_at`: a planted `core.fsmonitor` could reach any file of the
VM's root file system and write into Control's own image layer. Under Sysbox the same call has no
right to the VM's files (proven on a real VM, `docs/implementer.md`). The git options below are
the cheap extra (nothing the agent planted runs if an option can stop it); the container is the
wall, not the options.

**The volume is read-only for it wherever git allows it.** There are two readers, made when they
are first needed: the one every look uses (the list of branches, the status, the upload-pack of the
fetch) has the repository read-only; the one that writes (the leftover commit, the rescue of a
detached HEAD and the set-up of the repository, `write=True`) has it read-write and runs only
when the agent's container is gone or before it exists.

Control only starts commands in them through the Engine API (`exec_run.py`) and reads what they
print. The fetch of the final push reads the agent's branches through `git upload-pack` in the
read-only reader, its streams piped to Control's `git fetch` by `exec_pipe.py`; what comes back is
an object stream that Control's git checks (`fsckObjects`) and stores in its mirror, which the
agent cannot reach.

The repository lives on the work volume (`/work/repo`, the Subpath `repo` of it, which is also what
the agent container mounts: neither sees the mirror). The agent's root and the reader's root are
both mapped to the VM's root on the mount (an ID-mapped mount: the proof of the golden snapshot
checks it, `docs/golden-snapshot.md`), so the reader reads and writes what the agent made without a
capability of the VM's. Git is told that the directory is safe (`safe.directory`): the reader is
the place where that decision costs nothing.
"""

import logging
import socket
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final, cast

from code_reviewer_runner.job import JobError
from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.result import ErrorCode

from .docker_api import DockerApi, DockerError
from .exec_run import run_exec
from .git_process import Outcome

_log = logging.getLogger(__name__)

READER_CONTAINER_NAME: Final = "code-reviewer-reader"
# The second reader, with the repository read-write.
READER_WRITER_CONTAINER_NAME: Final = "code-reviewer-reader-rw"
READER_ROLE_LABEL: Final = "code-reviewer.role"
READER_RUNTIME: Final = "sysbox-runc"
# Where the repository is in the reader, and in Control (the work volume at `/work`).
READER_REPO: Final = "/repo"
CONTROL_REPO: Final = "/work/repo"
WORK_VOLUME_TARGET: Final = "/work"
REPO_SUBPATH: Final = "repo"
GIT: Final = "/usr/local/bin/git"
# Small, and counted in full in the VM's memory (`READER_MEMORY_MB` of
# dispatcher/src/launchers/sandbox.ts).
READER_MEMORY_BYTES: Final = 256 * 1024 * 1024
READER_PIDS_LIMIT: Final = 256
READER_TMPFS: Final = "rw,noexec,nosuid,nodev,size=64m,mode=1777"
READER_ENTRYPOINT: Final = ["/usr/bin/tini", "--", "/usr/bin/sleep", "infinity"]
READER_PATH: Final = "/usr/local/bin:/usr/bin:/bin"
# The upload-pack that Control's `git fetch` is told to run for the agent's repository: the module
# below pipes it into the reader. A fixed command; the path git appends is checked by the module.
UPLOAD_PACK_PYTHON: Final = "/opt/venv/bin/python"
UPLOAD_PACK_MODULE: Final = "code_reviewer_runner.implementer.exec_pipe"
UPLOAD_PACK_COMMAND: Final = f"{UPLOAD_PACK_PYTHON} -I -m {UPLOAD_PACK_MODULE}"
UPLOAD_PACK_PROTOCOL_VARIABLE: Final = "GIT_PROTOCOL"
# Every git command in a reader starts with these. The repository's own config would otherwise name
# programs git runs for it (an fsmonitor, hooks) or work that outlives the command (gc,
# maintenance).
# Not a wall: a filter driver or an attribute of the tree cannot be switched off by name.
READER_GIT_OPTIONS: Final = (
    "-c",
    f"safe.directory={READER_REPO}",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.untrackedCache=false",
    "-c",
    "gc.auto=0",
    "-c",
    "maintenance.auto=false",
    "-c",
    "protocol.ext.allow=never",
)


def reader_environment(identity: Mapping[str, str] | None = None) -> dict[str, str]:
    """The environment of every command in the reader: git's own config files out of play, no
    prompt, and the identity of the system's commits."""
    environment = {
        "PATH": READER_PATH,
        "HOME": "/tmp",
        "LC_ALL": "C",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_TERMINAL_PROMPT": "0",
    }
    environment.update(identity or {})
    return environment


def reader_document(
    image: str, work_volume: str, *, writable: bool = False, runtime: str = READER_RUNTIME
) -> dict[str, Any]:
    """The reader's container: constants, the image id and the volume name the daemon gave. The
    repository is read-only unless `writable`. The runtime is `sysbox-runc`; only a test lane
    without Sysbox names another."""
    return {
        "Image": image,
        "Entrypoint": READER_ENTRYPOINT,
        "Cmd": [],
        "User": "0:0",
        "Env": [f"PATH={READER_PATH}", "HOME=/tmp"],
        "Hostname": "reader",
        "Labels": {READER_ROLE_LABEL: "reader-rw" if writable else "reader"},
        "NetworkDisabled": True,
        "HostConfig": {
            "Runtime": runtime,
            "NetworkMode": "none",
            "Privileged": False,
            "ReadonlyRootfs": True,
            "SecurityOpt": ["no-new-privileges:true"],
            "Memory": READER_MEMORY_BYTES,
            "MemorySwap": READER_MEMORY_BYTES,
            "PidsLimit": READER_PIDS_LIMIT,
            "Tmpfs": {"/tmp": READER_TMPFS},
            "RestartPolicy": {"Name": "no"},
            "PublishAllPorts": False,
            "Mounts": [
                {
                    "Type": "volume",
                    "Source": work_volume,
                    "Target": READER_REPO,
                    "ReadOnly": not writable,
                    "VolumeOptions": {"Subpath": REPO_SUBPATH, "NoCopy": True},
                }
            ],
        },
    }


def work_volume_of(own: Mapping[str, Any]) -> str:
    """The name of the volume mounted at `/work` in Control's own container, as the daemon says."""
    mounts = own.get("Mounts")
    for entry in cast("list[Any]", mounts) if isinstance(mounts, list) else []:
        mount = as_object(entry)
        if (
            mount is not None
            and mount.get("Destination") == WORK_VOLUME_TARGET
            and mount.get("Type") == "volume"
            and isinstance(mount.get("Name"), str)
        ):
            return str(mount["Name"])
    raise JobError(ErrorCode.SETUP_FAILED, "reader_unavailable: no work volume in this container")


@dataclass(frozen=True)
class ReaderSeams:
    """What the tests replace; production leaves the defaults."""

    api: Callable[[], DockerApi] = DockerApi
    hostname: Callable[[], str] = socket.gethostname
    # The runtime of the reader: Sysbox in production. A lane without Sysbox (CI) names `runc`.
    runtime: str = READER_RUNTIME
    # The interpreter of the pipe command Control's `git fetch` runs (the Worker image's venv).
    python: str = UPLOAD_PACK_PYTHON


class ReaderAccess:
    """Git commands in the agent's repository, run in a reader. A reader is made on the first
    command that needs it and all are removed by `close()`. The same surface as a local repository
    gives the workspace (`run`, `stream`, `upload_pack`): a read goes to the reader with the
    repository read-only, `run(..., write=True)` to the one with it read-write."""

    def __init__(
        self,
        environment: Mapping[str, str] | None = None,
        seams: ReaderSeams = ReaderSeams(),  # noqa: B008
    ) -> None:
        self._api = seams.api()
        self._seams = seams
        self._environment = reader_environment(environment)
        self._containers: dict[bool, str] = {}

    @property
    def repo_source(self) -> str:
        """What Control's `git fetch` names as the source repository: the path the reader's
        upload-pack is told about is the reader's own (`exec_pipe` ignores this one)."""
        return CONTROL_REPO

    def upload_pack(self) -> str:
        return f"{self._seams.python} -I -m {UPLOAD_PACK_MODULE}"

    def run(self, args: Sequence[str], *, timeout: float, write: bool = False) -> Outcome:
        container = self._ensure(write)
        if container is None:
            return Outcome(255, "", "the reader cannot run", unanswered=True)
        return run_exec(
            self._api,
            container,
            [GIT, *READER_GIT_OPTIONS, *args],
            env=self._environment,
            workdir=READER_REPO,
            timeout=timeout,
            name=f"git {args[0] if args else ''}",
        )

    def stream(
        self, args: Sequence[str], consume: Callable[[bytes], None], *, timeout: float
    ) -> Outcome:
        container = self._ensure(False)
        if container is None:
            return Outcome(255, "", "the reader cannot run", unanswered=True)
        return run_exec(
            self._api,
            container,
            [GIT, *READER_GIT_OPTIONS, *args],
            env=self._environment,
            workdir=READER_REPO,
            timeout=timeout,
            consume=consume,
            name=f"git {args[0] if args else ''}",
        )

    def _ensure(self, writable: bool) -> str | None:
        existing = self._containers.get(writable)
        if existing is not None:
            return existing
        try:
            own = self._api.inspect_container(self._seams.hostname())
            image = str(own.get("Image", ""))
            if not image:
                raise DockerError(0, "the daemon does not know this container")
            volume = work_volume_of(own)
            name = READER_WRITER_CONTAINER_NAME if writable else READER_CONTAINER_NAME
            container = self._api.create_container(
                reader_document(image, volume, writable=writable, runtime=self._seams.runtime),
                name,
            )
            self._containers[writable] = container
            self._api.start_container(container)
        except (DockerError, JobError):
            _log.warning("the reader could not be started")
            self._drop(writable)
            return None
        return self._containers.get(writable)

    def _drop(self, writable: bool) -> None:
        container = self._containers.pop(writable, None)
        if container is None:
            return
        try:
            self._api.remove_container(container)
        except DockerError as error:
            _log.warning("the reader could not be removed (%s)", error.status)

    def close(self) -> None:
        for writable in (True, False):
            self._drop(writable)
