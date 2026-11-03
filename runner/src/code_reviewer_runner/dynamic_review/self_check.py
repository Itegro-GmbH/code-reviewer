# SPDX-License-Identifier: LicenseRef-Proprietary
"""The startup self-check that decides whether this runner advertises `opencode` (#202).

It runs once, in the root supervisor, after the one-time network setup (`static_isolation.py`) and
before the job loop claims anything. `opencode` is advertised only when every property holds:

* the process is the root supervisor and an engine user and the slot's ports are configured (only
  the Dynamic runner of the hardened container spec has them; the default runner never passes);
* the engine user exists, with its own group, and is not root;
* the static network rules were installed and `NET_ADMIN`/`SETPCAP` are gone from this process;
* where the kernel gave only the `ip`-family fallback ruleset (#345), IPv6 is off and proven so
  (`ipv6_off.py`): that ruleset does not see IPv6;
* the engine binary and `rg` are the pinned files (size and SHA-256 of `opencode-pin.json` and
  `ripgrep-pin.json`), regular files owned by the trusted owner that nobody else can write, and the
  binary reports the pinned version when run as the engine user, offline. The pin files are held to
  the same standard, and so is every directory above each of the four files, up to `/`: a real
  directory (no link), owned by the trusted owner, not writable by group or others (#249);
* a probe run as the engine user reaches the slot's proxy port and nothing else.

Each failure has a stable reason that the loop logs; none carries a value. A successful `--version`
alone proves nothing about isolation, which is why it is only one item of the list. What cannot be
proven at startup is proven per job: the sealed read-only export, unreadable private state and the
probe again before every engine (`supervisor.py`, `engine_user.py`).
"""

import contextlib
import hashlib
import json
import os
import platform as host
import pwd
import re
import socket
import stat
import subprocess
import sys
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import BinaryIO, Concatenate

from code_reviewer_runner.capabilities import IsolationSelfCheckError
from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.result import ErrorCode

from .ipv6_off import verify_ipv6_off
from .netguard import PROXY_HOST, EgressMode, IsolationError, verify_confinement
from .static_isolation import SlotPorts, require_startup_capabilities_gone

_CHUNK = 1024 * 1024
_SHA256 = re.compile(r"[0-9a-f]{64}")
_TRUSTED_PATH = "/usr/local/bin:/usr/bin:/bin"
_VERSION_TIMEOUT_SECONDS = 60.0


class SelfCheckReason(StrEnum):
    """Why `opencode` is not advertised, or (the `implementer_*` ones) why `implementer` is not on
    top of it. Stable: it is logged, and operators search for it."""

    NOT_A_DYNAMIC_RUNNER = "not_a_dynamic_runner"
    NOT_ROOT_SUPERVISOR = "not_root_supervisor"
    ENGINE_USER_INVALID = "engine_user_invalid"
    NETWORK_RULES_NOT_INSTALLED = "network_rules_not_installed"
    CAPABILITIES_NOT_DROPPED = "capabilities_not_dropped"
    ROOT_FILESYSTEM_WRITABLE = "root_filesystem_writable"
    IPV6_NOT_DISABLED = "ipv6_not_disabled"
    PIN_UNREADABLE = "pin_unreadable"
    PIN_UNTRUSTED = "pin_untrusted"
    ENGINE_BINARY_MISSING = "engine_binary_missing"
    ENGINE_BINARY_UNTRUSTED = "engine_binary_untrusted"
    ENGINE_BINARY_CHECKSUM_MISMATCH = "engine_binary_checksum_mismatch"
    ENGINE_VERSION_MISMATCH = "engine_version_mismatch"
    RIPGREP_MISSING = "ripgrep_missing"
    RIPGREP_UNTRUSTED = "ripgrep_untrusted"
    RIPGREP_CHECKSUM_MISMATCH = "ripgrep_checksum_mismatch"
    NETWORK_PROBE_FAILED = "network_probe_failed"
    # Why `implementer` is not advertised on top of a passing Dynamic check (#765,
    # `implementer/startup.py`). They are in the verdict next to the others.
    IMPLEMENTER_GIT_MISSING = "implementer_git_missing"
    IMPLEMENTER_WORK_DIR_MISSING = "implementer_work_dir_missing"
    # The container starts the model door, the agent's container and the reader through the VM's
    # Docker (#745) and that Docker does not answer ...
    IMPLEMENTER_DOCKER_UNAVAILABLE = "implementer_docker_unavailable"
    # ... has no `sysbox-runc` runtime, or the agent image of the golden snapshot is not in the VM
    # (#745, step 4).
    IMPLEMENTER_SYSBOX_MISSING = "implementer_sysbox_missing"
    IMPLEMENTER_AGENT_IMAGE_MISSING = "implementer_agent_image_missing"
    # ... and the engine user can open the VM's Docker socket, which is root on the VM (#745).
    IMPLEMENTER_DOCKER_SOCKET_OPEN = "implementer_docker_socket_open"


class SelfCheckFailed(IsolationSelfCheckError):
    """A property of the self-check does not hold. `reason` is stable, `detail` names no value."""

    def __init__(self, reason: SelfCheckReason, detail: str) -> None:
        super().__init__(ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED, detail)
        self.reason = reason


@dataclass(frozen=True)
class SelfCheckResult:
    """What a passing check says: which egress ruleset the engine user is confined by."""

    egress_mode: EgressMode


@dataclass(frozen=True)
class ToolPaths:
    """Where the Dynamic image installs the engine, `rg` and the pins they are checked against."""

    opencode: Path
    ripgrep: Path
    opencode_pin: Path
    ripgrep_pin: Path


DEFAULT_TOOLS = ToolPaths(
    opencode=Path("/usr/local/bin/opencode"),
    ripgrep=Path("/usr/local/bin/rg"),
    opencode_pin=Path("/opt/code-reviewer/pins/opencode-pin.json"),
    ripgrep_pin=Path("/opt/code-reviewer/pins/ripgrep-pin.json"),
)

GroupOf = Callable[[int], int | None]
Probe = Callable[Concatenate[int, int, int, ...], None]
Ipv6Proof = Callable[[int, int], None]
VersionAsUser = Callable[[Path, int, int], str]


def platform_key() -> str:
    """The key of this host in the pin files (`linux-x64`); the same rule as the fetch script."""
    machine = host.machine().lower()
    architecture = {"x86_64": "x64", "amd64": "x64"}.get(machine, machine)
    return f"{sys.platform.removesuffix('2')}-{architecture}"


# -- the real facts -----------------------------------------------------------


def group_of(uid: int) -> int | None:
    """The primary group of `uid`, or None when no such user exists."""
    try:
        return pwd.getpwuid(uid).pw_gid
    except KeyError:
        return None


def root_filesystem_read_only(root: Path = Path("/")) -> bool:
    """True when the root filesystem is mounted read-only (`docker run --read-only`, #249).

    The mount flag is what a process in the container sees; a path that cannot be examined is not
    judged read-only.
    """
    try:
        return bool(os.statvfs(root).f_flag & os.ST_RDONLY)
    except OSError:
        return False


def startup_probe(uid: int, gid: int, proxy_port: int) -> None:
    """Run the network probe as the engine user against a listener of ours on the proxy port.

    No job exists at startup, so the supervisor itself plays the model proxy for the probe's
    "allowed" connection. A port somebody else holds fails the probe: the slot is not clean.
    """
    with contextlib.ExitStack() as stack:
        for port, taken in ((proxy_port, "the model proxy port of the slot is not free"),):
            listener = stack.enter_context(socket.socket())
            # A connection that only waits out its time on the port (the proxy of a job that just
            # ended) does not make the port taken; a live listener of somebody else still fails
            # the bind.
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                listener.bind((PROXY_HOST, port))
                listener.listen(1)
            except OSError:
                raise IsolationError(taken) from None
        verify_confinement(uid, gid, proxy_port)


def version_as_user(executable: Path, uid: int, gid: int) -> str:
    """What `executable --version` prints when the engine user runs it with a closed environment."""
    with tempfile.TemporaryDirectory(prefix="engine-version-") as home:
        os.chown(home, uid, gid)
        try:
            done = subprocess.run(
                [str(executable), "--version"],
                capture_output=True,
                text=True,
                timeout=_VERSION_TIMEOUT_SECONDS,
                check=False,
                stdin=subprocess.DEVNULL,
                cwd=home,
                user=uid,
                group=gid,
                extra_groups=(),
                env={"PATH": _TRUSTED_PATH, "HOME": home, "NO_COLOR": "1", "CI": "1"},
            )
        except (OSError, subprocess.SubprocessError):
            return ""
    return done.stdout.strip()


# -- the pinned files ---------------------------------------------------------


@dataclass(frozen=True)
class _Pinned:
    version: str
    size: int
    sha256: str


@dataclass(frozen=True)
class _Where:
    """Which owner and which top directory the files and their directories are judged against."""

    trusted_owner: int
    chain_root: Path
    lstat: Callable[[Path], os.stat_result]


def _ancestors_trusted(
    path: Path, root: Path, trusted_owner: int, lstat: Callable[[Path], os.stat_result]
) -> bool:
    """Every directory from the parent of `path` up to `root` is the owner's and closed to others.

    Somebody who can write into one of them can swap the whole subtree, however the file itself is
    owned. A link in the chain is refused as well: it would let the judged path lead elsewhere.
    A directory that is not there raises `FileNotFoundError`: that is a missing file, not an
    untrusted one.
    """
    directory = path.parent
    while True:
        try:
            facts = lstat(directory)
        except (FileNotFoundError, NotADirectoryError):
            raise FileNotFoundError from None
        except OSError:
            return False
        if (
            not stat.S_ISDIR(facts.st_mode)
            or facts.st_uid != trusted_owner
            or facts.st_mode & (stat.S_IWGRP | stat.S_IWOTH)
        ):
            return False
        if directory == root:
            return True
        if directory.parent == directory:
            return False  # walked past "/" without meeting the root: the root is not above it
        directory = directory.parent


def _open_trusted(
    path: Path,
    where: _Where,
    unreadable: SelfCheckFailed,
    untrusted: SelfCheckFailed,
) -> BinaryIO:
    """The open file at `path`, if only its owner can change it and every directory above it."""
    try:
        trusted = _ancestors_trusted(path, where.chain_root, where.trusted_owner, where.lstat)
    except FileNotFoundError:
        raise unreadable from None
    if not trusted:
        raise untrusted
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError:
        raise unreadable from None
    stream = os.fdopen(descriptor, "rb")
    facts = os.fstat(stream.fileno())
    if not stat.S_ISREG(facts.st_mode):
        stream.close()
        raise unreadable
    if facts.st_uid != where.trusted_owner or facts.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
        stream.close()
        raise untrusted
    return stream


def _read_pin(path: Path, platform: str, where: _Where) -> _Pinned:
    unreadable = SelfCheckFailed(SelfCheckReason.PIN_UNREADABLE, "a pin file cannot be used")
    untrusted = SelfCheckFailed(
        SelfCheckReason.PIN_UNTRUSTED, "a pin file could be changed by someone else"
    )
    if path.is_symlink():
        raise untrusted
    with _open_trusted(path, where, unreadable, untrusted) as stream:
        try:
            document = as_object(json.loads(stream.read().decode("utf-8")))
        except (OSError, ValueError):
            raise unreadable from None
    if document is None:
        raise unreadable
    platforms = as_object(document.get("platforms")) or {}
    entry = as_object(platforms.get(platform))
    version = document.get("version")
    if entry is None or not isinstance(version, str) or not version:
        raise unreadable
    size, digest = entry.get("executableBytes"), entry.get("executableSha256")
    if not isinstance(size, int) or isinstance(size, bool) or size <= 0:
        raise unreadable
    if not isinstance(digest, str) or not _SHA256.fullmatch(digest):
        raise unreadable
    return _Pinned(version, size, digest)


def _verify_executable(
    path: Path,
    pin_path: Path,
    platform: str,
    where: _Where,
    reasons: tuple[SelfCheckReason, SelfCheckReason, SelfCheckReason],
) -> _Pinned:
    """The file is the pinned one, and only its trusted owner can change it.

    The descriptor is opened without following a link and judged with `fstat`, so the file that is
    hashed is the file that was judged. The file and its directories are judged before its pin is
    read, and the pin the same way.
    """
    missing, untrusted, mismatch = reasons
    with _open_trusted(
        path,
        where,
        SelfCheckFailed(missing, "a required tool is not installed"),
        SelfCheckFailed(untrusted, "a required tool could be changed by someone else"),
    ) as stream:
        if not os.fstat(stream.fileno()).st_mode & stat.S_IXUSR:
            raise SelfCheckFailed(missing, "a required tool is not an executable file")
        pin = _read_pin(pin_path, platform, where)
        if os.fstat(stream.fileno()).st_size != pin.size:
            raise SelfCheckFailed(mismatch, "a required tool is not the pinned file")
        sha = hashlib.sha256()
        while chunk := stream.read(_CHUNK):
            sha.update(chunk)
    if sha.hexdigest() != pin.sha256:
        raise SelfCheckFailed(mismatch, "a required tool is not the pinned file")
    return pin


# -- the check ----------------------------------------------------------------


def check_dynamic_runner(
    *,
    user: tuple[int, int] | None,
    ports: SlotPorts | None,
    rules_installed: bool,
    tools: ToolPaths = DEFAULT_TOOLS,
    platform: str | None = None,
    trusted_owner: int = 0,
    chain_root: Path = Path("/"),
    lstat: Callable[[Path], os.stat_result] = os.lstat,
    euid: Callable[[], int] = os.geteuid,
    capabilities_gone: Callable[[], None] = require_startup_capabilities_gone,
    user_group: GroupOf = group_of,
    probe: Probe = startup_probe,
    version_as_user: VersionAsUser = version_as_user,
    egress_mode: EgressMode = EgressMode.FULL,
    ipv6_proof: Ipv6Proof = verify_ipv6_off,
    root_read_only: Callable[[], bool] | None = None,
) -> SelfCheckResult:
    """Raise `SelfCheckFailed` unless every property holds. Cheap checks first, the probe last.

    Returns the egress mode the check passed with. `egress_mode` is what startup decided from the
    kernel's answer (`static_isolation.secure_startup`): in fallback mode IPv6 must be proven off.
    `root_read_only` is given by the entry modes of the Worker image (#324): the hardened container
    spec runs the image with a read-only root, so a Worker or probe on a writable root is no such
    container and does not advertise `opencode`. Unset (the legacy loop), the root is not judged.
    """
    if user is None or ports is None:
        raise SelfCheckFailed(
            SelfCheckReason.NOT_A_DYNAMIC_RUNNER, "no engine user is configured for this runner"
        )
    if euid() != 0:
        raise SelfCheckFailed(
            SelfCheckReason.NOT_ROOT_SUPERVISOR, "the runner is not the root supervisor"
        )
    uid, gid = user
    if uid == 0 or gid == 0 or user_group(uid) != gid:
        raise SelfCheckFailed(
            SelfCheckReason.ENGINE_USER_INVALID,
            "the engine user does not exist with its own group",
        )
    if not rules_installed:
        raise SelfCheckFailed(
            SelfCheckReason.NETWORK_RULES_NOT_INSTALLED,
            "the engine network rules are not installed",
        )
    try:
        capabilities_gone()
    except IsolationError:
        raise SelfCheckFailed(
            SelfCheckReason.CAPABILITIES_NOT_DROPPED,
            "a capability only startup may hold was not dropped",
        ) from None
    if root_read_only is not None and not root_read_only():
        raise SelfCheckFailed(
            SelfCheckReason.ROOT_FILESYSTEM_WRITABLE,
            "the root filesystem of the container is writable",
        )
    if egress_mode is EgressMode.FALLBACK:
        try:
            ipv6_proof(uid, gid)
        except IsolationError:
            raise SelfCheckFailed(
                SelfCheckReason.IPV6_NOT_DISABLED,
                "IPv6 is not proven off, and the fallback network rules do not cover it",
            ) from None
    platform = platform or platform_key()
    where = _Where(trusted_owner, chain_root, lstat)
    engine_pin = _verify_executable(
        tools.opencode,
        tools.opencode_pin,
        platform,
        where,
        (
            SelfCheckReason.ENGINE_BINARY_MISSING,
            SelfCheckReason.ENGINE_BINARY_UNTRUSTED,
            SelfCheckReason.ENGINE_BINARY_CHECKSUM_MISMATCH,
        ),
    )
    _verify_executable(
        tools.ripgrep,
        tools.ripgrep_pin,
        platform,
        where,
        (
            SelfCheckReason.RIPGREP_MISSING,
            SelfCheckReason.RIPGREP_UNTRUSTED,
            SelfCheckReason.RIPGREP_CHECKSUM_MISMATCH,
        ),
    )
    if version_as_user(tools.opencode, uid, gid) != engine_pin.version:
        raise SelfCheckFailed(
            SelfCheckReason.ENGINE_VERSION_MISMATCH,
            "the engine does not report the pinned version as the engine user",
        )
    try:
        probe(uid, gid, ports.proxy)
    except IsolationError:
        raise SelfCheckFailed(
            SelfCheckReason.NETWORK_PROBE_FAILED,
            "the engine user's network is not confined to the model proxy",
        ) from None
    return SelfCheckResult(egress_mode=egress_mode)
