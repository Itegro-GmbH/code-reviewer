# SPDX-License-Identifier: LicenseRef-Proprietary

"""The reader: where Control looks at the agent's repository (#745, step 4).

The agent's repository is the agent's: it can hold hooks, a hostile `config`, symlinks, alternates
and anything else git will act on. Control (root, with the token) never opens it. Every git command
that has to look inside it runs in the **reader**, a container of its own that has the repository
and nothing else: no network (`none`), no token, no secret, no socket, no other mount, a read-only
root file system and a small memory limit. Whatever a repository's config makes git run, it runs
there, and it must not matter.

**What makes it not matter: the runtime, and a bounding set of one.** The reader runs under
`sysbox-runc`, the runtime the agent runs under: its root is an unprivileged user of the VM (a
mapped uid), and what it holds as capabilities exists inside its own user namespace only. An
earlier reader ran on plain runc as the VM's root with `DAC_READ_SEARCH` and `DAC_OVERRIDE`, and the
default seccomp profile allows `open_by_handle_at`: a planted `core.fsmonitor` could reach any file
of the VM's root file system and write into Control's own image layer. Under Sysbox the same call
has no right to the VM's files (proven on a real VM, `docs/implementer.md`).

Sysbox also ignores the container's `CapDrop` (measured on a VM: with `CapDrop: ["ALL"]` the init
and every exec still hold all 41 capabilities of the user namespace, `CAP_SYS_ADMIN` included). So
the document says `CapDrop ALL` and `CapAdd DAC_OVERRIDE` (what a plain-runc lane gets, and what the
document means), and **every command starts through `setpriv`** (`READER_DROP_CAPABILITIES`), which
cuts the bounding set to `DAC_OVERRIDE` before git starts: whatever a repository makes git run holds
that one capability at most. `DAC_OVERRIDE` is the minimum (measured: `add -A`, `commit` and
`switch -c` work with it alone over files of mode 600, directories of mode 700 and a git directory
of another uid; with none, `status` cannot open a directory and `add` fails on the index). Even with
all capabilities the read-only reader cannot remount its volume writable (the mount's flags are
locked by the user namespace that made them); that is asserted on a VM (`test_reader_hostile.py`).
The git options below are the cheap extra (nothing the agent planted runs if an option can stop it);
the container is the wall, not the options.

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
import tarfile
import tempfile
import time
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Any, Final, cast

from code_reviewer_runner.job import JobError
from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.result import ErrorCode

from .docker_api import DockerApi, DockerError
from .exec_run import run_exec
from .git_process import Outcome
from .placement import B_WORK_VOLUME, HOSTED, Placement
from .result_channel import (
    ASK_FILE,
    READ_RESULT_SCRIPT,
    READER_RESULT_DIRECTORY,
    RESULT_FILE,
    result_mount,
)
from .role_labels import role_labels

_log = logging.getLogger(__name__)

READER_CONTAINER_NAME: Final = "code-reviewer-reader"
# The second reader, with the repository read-write.
READER_WRITER_CONTAINER_NAME: Final = "code-reviewer-reader-rw"
READER_RUNTIME: Final = "sysbox-runc"
# Where the repository is in the reader, and in Control (the work volume at `/work`).
READER_REPO: Final = "/repo"
CONTROL_REPO: Final = "/work/repo"
WORK_VOLUME_TARGET: Final = "/work"
REPO_SUBPATH: Final = "repo"
GIT: Final = "/usr/local/bin/git"
SETPRIV: Final = "/usr/bin/setpriv"
# The one capability a command in a reader keeps: DAC_OVERRIDE, to read and write what the agent's
# other users made (files of mode 600, directories of mode 700, a git directory of another uid).
# Not DAC_READ_SEARCH (`open_by_handle_at`), not FOWNER or anything else (measured: add, commit
# and switch work with this one alone).
READER_CAPABILITY: Final = "DAC_OVERRIDE"
# Under Sysbox the container's `CapDrop` changes nothing: root and every exec of it hold all 41
# capabilities of its user namespace (measured on a VM). So each command drops them itself, before
# git starts: the bounding set is what a process the repository makes git run could ever hold.
READER_DROP_CAPABILITIES: Final = (
    SETPRIV,
    f"--bounding-set=-all,+{READER_CAPABILITY.lower()}",
    "--inh-caps=-all",
    "--no-new-privs",
)
# Small, and counted in full in the VM's memory (`READER_MEMORY_MB` of
# dispatcher/src/launchers/sandbox.ts).
READER_MEMORY_BYTES: Final = 256 * 1024 * 1024
READER_PIDS_LIMIT: Final = 256
READER_TMPFS: Final = "rw,noexec,nosuid,nodev,size=64m,mode=1777"
# The most a read of the result file takes (#843).
RESULT_READ_SECONDS: Final = 2.5
# The most a reset of the readers takes, all of them together (`ReaderAccess.reset`).
RESET_SECONDS: Final = 10.0
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
    # Every blob over 1 MB is streamed and not delta-compressed. Without it `pack-objects` of the
    # final fetch reads each blob under git's 512 MB default whole into memory, twice (measured on a
    # VM: a repository of 3.7 GB in files of 100 MB was OOM-killed at 128, 256 and 512 MB; with this
    # option the same fetch ran at 128 MB). The cost is a bigger pack for large binaries.
    "-c",
    "core.bigFileThreshold=1m",
)


# What `append_exclude` runs: the directory and the file are git's own, the text comes on stdin.
APPEND_EXCLUDE_SCRIPT: Final = "umask 022 && mkdir -p .git/info && cat >> .git/info/exclude"


def reader_argv(args: Sequence[str]) -> list[str]:
    """The command of every look into the repository: git with its options, under the one
    capability a reader keeps."""
    return [*READER_DROP_CAPABILITIES, GIT, *READER_GIT_OPTIONS, *args]


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
    image: str,
    work_volume: str,
    *,
    writable: bool = False,
    runtime: str = READER_RUNTIME,
    result: bool = False,
) -> dict[str, Any]:
    """The reader's container: constants, the image id and the volume name the daemon gave. The
    repository is read-only unless `writable`. The runtime is `sysbox-runc`; only a test lane
    without Sysbox names another. A turn with a result schema (#843) has the result directory in
    it too, read-only at `/result`."""
    mounts: list[dict[str, Any]] = [
        {
            "Type": "volume",
            "Source": work_volume,
            "Target": READER_REPO,
            "ReadOnly": not writable,
            "VolumeOptions": {"Subpath": REPO_SUBPATH, "NoCopy": True},
        }
    ]
    if result:
        mounts.append(result_mount(work_volume, READER_RESULT_DIRECTORY, read_only=True))
    return {
        "Image": image,
        "Entrypoint": READER_ENTRYPOINT,
        "Cmd": [],
        "User": "0:0",
        "Env": [f"PATH={READER_PATH}", "HOME=/tmp"],
        "Hostname": "reader",
        "Labels": role_labels("reader-rw" if writable else "reader"),
        "NetworkDisabled": True,
        "HostConfig": {
            "Runtime": runtime,
            "NetworkMode": "none",
            "Privileged": False,
            "CapDrop": ["ALL"],
            "CapAdd": [READER_CAPABILITY],
            "ReadonlyRootfs": True,
            "SecurityOpt": ["no-new-privileges:true"],
            "Memory": READER_MEMORY_BYTES,
            "MemorySwap": READER_MEMORY_BYTES,
            "PidsLimit": READER_PIDS_LIMIT,
            "Tmpfs": {"/tmp": READER_TMPFS},
            "RestartPolicy": {"Name": "no"},
            "PublishAllPorts": False,
            "Mounts": mounts,
        },
    }


SEED_NAME: Final = "code-reviewer-seed"
SEED_TARGET: Final = "/seed"
SEED_SECONDS: Final = 600.0
DOCKER_SOCKET_OPTION: Final = "--docker-socket="


def seed_document(image: str, volume: str, runtime: str) -> dict[str, Any]:
    """The container that only carries B's volume while the archive is put into it: made, never
    started, no network."""
    return {
        "Image": image,
        "Entrypoint": ["/bin/true"],
        "Cmd": [],
        "User": "0:0",
        "Env": [],
        "Labels": role_labels("seed"),
        "NetworkDisabled": True,
        "HostConfig": {
            "Runtime": runtime,
            "NetworkMode": "none",
            "Privileged": False,
            "RestartPolicy": {"Name": "no"},
            "Mounts": [
                {
                    "Type": "volume",
                    "Source": volume,
                    "Target": SEED_TARGET,
                    "ReadOnly": False,
                    "VolumeOptions": {"NoCopy": True},
                }
            ],
        },
    }


def _plain(info: tarfile.TarInfo) -> tarfile.TarInfo:
    """A tar entry without the owner of A's files: B's root owns what it receives."""
    info.uid = info.gid = 0
    info.uname = info.gname = ""
    return info


def repository_archive(repo: Path, scratch: Path) -> IO[bytes]:
    """The tar of Control's checkout (as `repo/`) and an empty `result/`, in a file that is deleted
    when it is closed. Links are stored as links and never followed."""
    archive = tempfile.TemporaryFile(dir=scratch)  # noqa: SIM115 - the caller closes it
    try:
        with tarfile.open(fileobj=archive, mode="w", format=tarfile.PAX_FORMAT) as tar:
            directory = tarfile.TarInfo("result")
            directory.type = tarfile.DIRTYPE
            directory.mode = 0o755
            tar.addfile(directory)
            tar.add(repo, arcname="repo", filter=_plain)
        archive.seek(0)
    except BaseException:
        archive.close()
        raise
    return archive


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
    # Which Docker the readers are made in (#1017). On the Incus backend it is B's: the readers run
    # there, from `image` (the agent's golden image, which has git; the Worker image is in A), on
    # B's own volume, which `_seed` fills once.
    placement: Placement = HOSTED
    image: str = ""
    # Where Control's checkout of the agent's repository is (what `_seed` copies to B) and where it
    # may keep the archive meanwhile.
    repo_directory: str = CONTROL_REPO
    scratch_directory: str = WORK_VOLUME_TARGET


class ReaderAccess:
    """Git commands in the agent's repository, run in a reader. A reader is made on the first
    command that needs it and all are removed by `close()`. The same surface as a local repository
    gives the workspace (`run`, `stream`, `upload_pack`): a read goes to the reader with the
    repository read-only, `run(..., write=True)` to the one with it read-write."""

    def __init__(
        self,
        environment: Mapping[str, str] | None = None,
        seams: ReaderSeams = ReaderSeams(),  # noqa: B008
        *,
        result: bool = False,
    ) -> None:
        self._api = seams.api()
        # #843: the readers see the result directory (read-only) when the turn has a result schema.
        self._result = result
        self._seams = seams
        self._environment = reader_environment(environment)
        self._containers: dict[bool, str] = {}
        # B's volume has the repository once the first reader is made (`_seed`).
        self._seeded = False

    @property
    def repo_source(self) -> str:
        """What Control's `git fetch` names as the source repository: the path the reader's
        upload-pack is told about is the reader's own (`exec_pipe` ignores this one)."""
        return CONTROL_REPO

    @property
    def protocol_version(self) -> int:
        """0 on B's Docker, whose connection cannot be half-closed: the upload-pack of protocol 2
        waits for the end of its input, the one of protocol 0 ends after the pack."""
        return 0 if self._seams.placement.split else 2

    def upload_pack(self) -> str:
        command = f"{self._seams.python} -I -m {UPLOAD_PACK_MODULE}"
        if self._seams.placement.split:
            command += f" {DOCKER_SOCKET_OPTION}{self._seams.placement.docker_socket}"
        return command

    def warm(self) -> bool:
        """Make both readers now, before the agent runs: the final push must not need a container
        to be created on a disk the agent may have filled."""
        return self._ensure(False) is not None and self._ensure(True) is not None

    def run(self, args: Sequence[str], *, timeout: float, write: bool = False) -> Outcome:
        container = self._ensure(write)
        if container is None:
            return Outcome(255, "", "the reader cannot run", unanswered=True)
        return run_exec(
            self._api,
            container,
            reader_argv(args),
            env=self._environment,
            workdir=READER_REPO,
            timeout=timeout,
            name=f"git {args[0] if args else ''}",
        )

    def read_result(self, max_bytes: int, *, timeout: float = RESULT_READ_SECONDS) -> bytes | None:
        """The first `max_bytes` bytes of the agent's result file (#843), read in the reader that
        cannot write: a plain file, not a link, else None. The bytes are the agent's and are
        judged by `finish_tool.parse_result`; nothing here looks at them."""
        return self._read_agent_file(RESULT_FILE, max_bytes, timeout, "read the result")

    def read_ask(self, max_bytes: int, *, timeout: float = RESULT_READ_SECONDS) -> bytes | None:
        """#920: the same for the question file the finish tool writes; judged by
        `finish_tool.parse_ask`."""
        return self._read_agent_file(ASK_FILE, max_bytes, timeout, "read the question")

    def _read_agent_file(
        self, file: str, max_bytes: int, timeout: float, name: str
    ) -> bytes | None:
        container = self._ensure(False)
        if container is None:
            return None
        kept = bytearray()

        def keep(chunk: bytes) -> None:
            kept.extend(chunk[: max_bytes - len(kept)])

        done = run_exec(
            self._api,
            container,
            [
                *READER_DROP_CAPABILITIES,
                "/bin/sh",
                "-c",
                READ_RESULT_SCRIPT,
                "read",
                f"{READER_RESULT_DIRECTORY}/{file}",
                str(max_bytes),
            ],
            timeout=timeout,
            consume=keep,
            name=name,
        )
        return bytes(kept) if done.returncode == 0 and not done.unanswered else None

    def append_exclude(self, data: bytes, *, timeout: float) -> Outcome:
        """Append lines to the repository's `info/exclude` (git's local ignore file, never
        committed), in the reader that writes. For the step after an environment's script (#818):
        what it left untracked is the base of the turn, not a change of the agent. The text is the
        standard input of a constant script, under the same one capability as every command of a
        reader."""
        container = self._ensure(True)
        if container is None:
            return Outcome(255, "", "the reader cannot run", unanswered=True)
        return run_exec(
            self._api,
            container,
            [*READER_DROP_CAPABILITIES, "/bin/sh", "-c", APPEND_EXCLUDE_SCRIPT, "append"],
            stdin=data,
            workdir=READER_REPO,
            timeout=timeout,
            name="append to the exclude file",
        )

    def update_refs(
        self, options: Sequence[str], commands: Iterable[bytes], *, timeout: float
    ) -> Outcome:
        """`git update-ref --stdin -z` in the reader that writes, the commands streamed to its
        standard input (#818: the refs a setup script made are removed this way)."""
        container = self._ensure(True)
        if container is None:
            return Outcome(255, "", "the reader cannot run", unanswered=True)
        return run_exec(
            self._api,
            container,
            reader_argv([*options, "update-ref", "--stdin", "-z"]),
            env=self._environment,
            stdin=commands,
            workdir=READER_REPO,
            timeout=timeout,
            name="git update-ref",
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
            reader_argv(args),
            env=self._environment,
            workdir=READER_REPO,
            timeout=timeout,
            consume=consume,
            name=f"git {args[0] if args else ''}",
        )

    def reset(self, *, seconds: float = RESET_SECONDS) -> bool:
        """Make every reader that exists quiet: SIGKILL to its init takes every process in it (a
        filter that left a daemon behind with `setsid` included), then it is started again. The
        agent's container is gone when this runs, and a process left in a reader could change the
        repository under the commit or the push. A reader that cannot be restarted is removed
        (forced: that kills it too) and made again; if that fails too it is forgotten, so that no
        command runs in a reader that is not known to be quiet. False when any of them could not
        be had back. Within `seconds` in all."""
        deadline = time.monotonic() + seconds
        quiet = True
        for writable in (False, True):
            container = self._containers.get(writable)
            if container is None:
                continue
            if self._restart(container, deadline):
                continue
            self._drop(writable, timeout=max(1.0, deadline - time.monotonic()))
            # Making a reader again is four calls to the daemon; past the deadline it is forgotten,
            # so that a hanging daemon cannot eat the time of the push.
            if time.monotonic() >= deadline:
                quiet = False
                continue
            quiet = self._ensure(writable) is not None and quiet
        return quiet

    def _restart(self, container: str, deadline: float) -> bool:
        def left() -> float:
            return max(1.0, deadline - time.monotonic())

        try:
            self._api.kill_container(container, timeout=left())
            self._api.wait_container(container, timeout=left())
            self._api.start_container(container, timeout=left())
        except DockerError as error:
            _log.warning("a reader could not be restarted (%s)", error.status)
            return False
        return True

    def _ensure(self, writable: bool) -> str | None:
        existing = self._containers.get(writable)
        if existing is not None:
            return existing
        try:
            if self._seams.placement.split:
                image = str(self._api.inspect_image(self._seams.image).get("Id", ""))
                volume = B_WORK_VOLUME
                if not image:
                    raise DockerError(0, "the daemon does not know the reader's image")
                if not self._seeded:
                    self._seed(image, volume)
            else:
                own = self._api.inspect_container(self._seams.hostname())
                image = str(own.get("Image", ""))
                if not image:
                    raise DockerError(0, "the daemon does not know this container")
                volume = work_volume_of(own)
            name = READER_WRITER_CONTAINER_NAME if writable else READER_CONTAINER_NAME
            container = self._api.create_container(
                reader_document(
                    image,
                    volume,
                    writable=writable,
                    runtime=self._seams.runtime,
                    result=self._result,
                ),
                name,
            )
            self._containers[writable] = container
            self._api.start_container(container)
        except (DockerError, JobError, OSError) as error:
            # What the daemon said is about containers and paths of this VM, never about the job.
            reason = (
                f"{error.status}: {error.message[:160]}"
                if isinstance(error, DockerError)
                else error.detail[:160]
                if isinstance(error, JobError)
                else type(error).__name__
            )
            _log.warning("the reader could not be started (%s)", reason)
            self._drop(writable)
            return None
        return self._containers.get(writable)

    def _seed(self, image: str, volume: str) -> None:
        """The one way the agent's repository gets from A to B (#1017): the checkout Control made
        from its own mirror is packed into a tar and unpacked into B's volume (`repo/`, and the
        empty `result/` the hosted layout has), through a container that is made and never
        started. Nothing is shared: no mount, no socket, B holds a copy. Nothing comes back this
        way; the end of the turn fetches the agent's branches through `git upload-pack` in a
        reader and Control's git checks every object. Raises `DockerError` or `OSError`."""
        api = self._api
        seeder = api.create_container(seed_document(image, volume, self._seams.runtime), SEED_NAME)
        try:
            with repository_archive(
                Path(self._seams.repo_directory), Path(self._seams.scratch_directory)
            ) as archive:
                api.put_archive(seeder, SEED_TARGET, archive, timeout=SEED_SECONDS)
        finally:
            try:
                api.remove_container(seeder)
            except DockerError as error:
                _log.warning("the seed container could not be removed (%s)", error.status)
        self._seeded = True

    def _drop(self, writable: bool, *, timeout: float | None = None) -> None:
        container = self._containers.pop(writable, None)
        if container is None:
            return
        try:
            self._api.remove_container(container, timeout=timeout)
        except DockerError as error:
            _log.warning("the reader could not be removed (%s)", error.status)

    def close(self) -> None:
        for writable in (True, False):
            self._drop(writable)
