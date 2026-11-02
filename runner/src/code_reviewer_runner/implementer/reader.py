# SPDX-License-Identifier: LicenseRef-Proprietary

"""The reader: where Control looks at the agent's repository (#745, step 4).

The agent's repository is the agent's: it can hold hooks, a hostile `config`, symlinks, alternates
and anything else git will act on. Control (root, with the token) never opens it. Every git command
that has to look inside it runs in the **reader**, a container of its own that has the repository
and nothing else: no network (`none`), no token, no secret, no socket, no other mount, a read-only
root file system, no capability but the three that read and write files of any owner. Whatever a
repository's config makes git run, it runs there, with nothing to reach and no way out.

Control only starts commands in it through the Engine API (`exec_run.py`) and reads what they print.
The fetch of the final push reads the agent's branches through `git upload-pack` in the reader, its
streams piped to Control's `git fetch` by `exec_pipe.py`; what comes back is an object stream that
Control's git checks (`fsckObjects`) and stores in its mirror, which the agent cannot reach.

The repository lives on the work volume (`/work/repo`, the Subpath `repo` of it, which is also what
the agent container mounts: neither sees the mirror). Files the agent's root writes there belong to
the VM's root (Sysbox maps the mount, measured), so the reader needs to read and write files of any
owner (DAC_OVERRIDE, FOWNER, DAC_READ_SEARCH), and git is told that the directory is safe
(`safe.directory`): the reader is the place where that decision costs nothing.
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
READER_ROLE_LABEL: Final = "code-reviewer.role"
# Where the repository is in the reader, and in Control (the work volume at `/work`).
READER_REPO: Final = "/repo"
CONTROL_REPO: Final = "/work/repo"
WORK_VOLUME_TARGET: Final = "/work"
REPO_SUBPATH: Final = "repo"
GIT: Final = "/usr/local/bin/git"
READER_MEMORY_BYTES: Final = 768 * 1024 * 1024
READER_PIDS_LIMIT: Final = 256
READER_TMPFS: Final = "rw,noexec,nosuid,nodev,size=64m,mode=1777"
READER_ENTRYPOINT: Final = ["/usr/bin/tini", "--", "/usr/bin/sleep", "infinity"]
READER_CAPABILITIES: Final = ["DAC_OVERRIDE", "FOWNER", "DAC_READ_SEARCH"]
READER_PATH: Final = "/usr/local/bin:/usr/bin:/bin"
# The upload-pack that Control's `git fetch` is told to run for the agent's repository: the module
# below pipes it into the reader. A fixed command; the path git appends is checked by the module.
UPLOAD_PACK_COMMAND: Final = "/opt/venv/bin/python -I -m code_reviewer_runner.implementer.exec_pipe"
UPLOAD_PACK_PROTOCOL_VARIABLE: Final = "GIT_PROTOCOL"


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


def reader_document(image: str, work_volume: str) -> dict[str, Any]:
    """The reader's container: constants, the image id and the volume name the daemon gave."""
    return {
        "Image": image,
        "Entrypoint": READER_ENTRYPOINT,
        "Cmd": [],
        "User": "0:0",
        "Env": [f"PATH={READER_PATH}", "HOME=/tmp"],
        "Hostname": "reader",
        "Labels": {READER_ROLE_LABEL: "reader"},
        "NetworkDisabled": True,
        "HostConfig": {
            "NetworkMode": "none",
            "Privileged": False,
            "ReadonlyRootfs": True,
            "CapDrop": ["ALL"],
            "CapAdd": READER_CAPABILITIES,
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
                    "ReadOnly": False,
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


class ReaderAccess:
    """Git commands in the agent's repository, run in the reader. The container is made on the
    first command and removed by `close()`. The same surface as a local repository gives the
    workspace (`run`, `stream`, `upload_pack`)."""

    def __init__(
        self,
        environment: Mapping[str, str] | None = None,
        seams: ReaderSeams = ReaderSeams(),  # noqa: B008
    ) -> None:
        self._api = seams.api()
        self._seams = seams
        self._environment = reader_environment(environment)
        self._container: str | None = None

    @property
    def repo_source(self) -> str:
        """What Control's `git fetch` names as the source: the path the reader's upload-pack is
        told about is the reader's own (`exec_pipe` ignores this one)."""
        return CONTROL_REPO

    def upload_pack(self) -> str:
        return UPLOAD_PACK_COMMAND

    def run(self, args: Sequence[str], *, timeout: float) -> Outcome:
        container = self._ensure()
        if container is None:
            return Outcome(255, "", "the reader cannot run", unanswered=True)
        return run_exec(
            self._api,
            container,
            [GIT, "-c", f"safe.directory={READER_REPO}", *args],
            env=self._environment,
            workdir=READER_REPO,
            timeout=timeout,
            name=f"git {args[0] if args else ''}",
        )

    def stream(
        self, args: Sequence[str], consume: Callable[[bytes], None], *, timeout: float
    ) -> Outcome:
        container = self._ensure()
        if container is None:
            return Outcome(255, "", "the reader cannot run", unanswered=True)
        return run_exec(
            self._api,
            container,
            [GIT, "-c", f"safe.directory={READER_REPO}", *args],
            env=self._environment,
            workdir=READER_REPO,
            timeout=timeout,
            consume=consume,
            name=f"git {args[0] if args else ''}",
        )

    def _ensure(self) -> str | None:
        if self._container is not None:
            return self._container
        try:
            own = self._api.inspect_container(self._seams.hostname())
            image = str(own.get("Image", ""))
            if not image:
                raise DockerError(0, "the daemon does not know this container")
            volume = work_volume_of(own)
            container = self._api.create_container(
                reader_document(image, volume), READER_CONTAINER_NAME
            )
            self._container = container
            self._api.start_container(container)
        except (DockerError, JobError):
            _log.warning("the reader could not be started")
            self.close()
            return None
        return self._container

    def close(self) -> None:
        container, self._container = self._container, None
        if container is None:
            return
        try:
            self._api.remove_container(container)
        except DockerError as error:
            _log.warning("the reader could not be removed (%s)", error.status)
