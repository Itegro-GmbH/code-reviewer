# SPDX-License-Identifier: LicenseRef-Proprietary
"""Launching the engine as the dedicated unprivileged user, and ending all that user runs (#197).

The job process is the root supervisor: it prepared the read-only export (#196, `export_isolation`),
runs the model proxy and holds every credential. The engine is a different user in the same
container. This module is the supervisor's side of that boundary:

* the `Popen` options that start a process as that user, with no supplementary groups (a
  `setuid()` in the child, no `sudo`, no setuid helper: `no-new-privileges` stays on);
* the engine's config file, readable by that user and nobody else;
* the proof that the engine's server port is held by the engine and not by a stranger;
* the network rules of that user (`netguard.py`): installed once at container start, with
  `NET_ADMIN` dropped afterwards (`static_isolation.py`); each job checks that the supervisor holds
  neither and proves the rules with a probe before the engine starts;
* the end of the job: everything that user still runs is killed, also what left the process group.

A process group alone is not enough: a helper may `setsid()` and leave it. The dedicated user is
the boundary, so the final step is a `kill(-1, SIGKILL)` run **as that user** (the kernel then
signals exactly the processes that user owns; nobody else can be reached and no pid is looked up and
reused). No capability beyond `SETUID`/`SETGID` is involved for that, and `KILL` lets the supervisor
signal the engine's group.
"""

import json
import os
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .ipv6_off import verify_ipv6_off
from .netguard import EgressMode, IsolationError, verify_confinement
from .static_isolation import (
    DEFAULT_ENGINE_PORT,
    DEFAULT_PROXY_PORT,
    require_startup_capabilities_gone,
)

_TRUSTED_PATH = "/usr/local/bin:/usr/bin:/bin"
_SWEEP_SECONDS = 10.0
_LISTEN = "0A"
_PROC_TABLES = ("/proc/net/tcp", "/proc/net/tcp6")

_SWEEP = "import os, signal; os.kill(-1, signal.SIGKILL)"
# A process that was forking while it was signalled can leave a child behind; look again.
_SWEEP_ROUNDS = 5


def user_pids(uid: int) -> list[int]:
    """The live (not zombie) processes whose real user is `uid`, read from /proc."""
    found: list[int] = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            status = (entry / "status").read_text(encoding="ascii", errors="replace")
        except OSError:
            continue  # it ended while we looked
        state = ""
        real = -1
        for line in status.splitlines():
            if line.startswith("State:"):
                state = line.split()[1] if len(line.split()) > 1 else ""
            elif line.startswith("Uid:"):
                try:
                    real = int(line.split()[1])
                except (IndexError, ValueError):
                    real = -1
        if real == uid and state != "Z":
            found.append(int(entry.name))
    return found


class SweepUnavailable(Exception):
    """The sweep could not be made at all (no `python3`, the subprocess cannot start or hangs).

    Not the same as a process that survived: that is a `False` of the sweep, this is no sweep.
    """


def try_sweep_user(uid: int, gid: int) -> bool:
    """Kill every process of user `uid`, wherever it went. True when none is left.

    Raises `SweepUnavailable` when the sweep could not be made. Needs the privilege to become that
    user (the supervisor and the job loop both are root).
    """
    python = shutil.which("python3", path=_TRUSTED_PATH)
    if python is None:
        raise SweepUnavailable("python3 is not installed")
    for _ in range(_SWEEP_ROUNDS):
        if not user_pids(uid):
            return True
        try:
            subprocess.run(
                [python, "-I", "-c", _SWEEP],
                user=uid,
                group=gid,
                extra_groups=(),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=_SWEEP_SECONDS,
                check=False,
                env={"PATH": _TRUSTED_PATH},
            )
        except (OSError, subprocess.TimeoutExpired):
            raise SweepUnavailable("the sweep process could not run") from None
        time.sleep(0.02)
    return not user_pids(uid)


def sweep_user(uid: int, gid: int) -> bool:
    """`try_sweep_user` for callers that treat a sweep that could not be made as "not ended"."""
    try:
        return try_sweep_user(uid, gid)
    except SweepUnavailable:
        return False


def listener_uids(port: int, tables: dict[str, str]) -> set[int]:
    """The owners of every listening socket on `port`, read from /proc/net/tcp{,6} texts."""
    owners: set[int] = set()
    wanted = f"{port:04X}"
    for text in tables.values():
        for line in text.splitlines()[1:]:
            fields = line.split()
            if len(fields) < 8 or fields[3] != _LISTEN:
                continue
            if fields[1].rsplit(":", 1)[-1].upper() != wanted:
                continue
            try:
                owners.add(int(fields[7]))
            except ValueError:
                owners.add(-1)  # unreadable owner: never equal to the engine user
    return owners


def _read_tables() -> dict[str, str]:
    tables: dict[str, str] = {}
    for name in _PROC_TABLES:
        try:
            tables[name] = Path(name).read_text(encoding="ascii", errors="replace")
        except OSError:
            continue
    return tables


@dataclass
class EngineLaunch:
    """What the adapter needs to run one engine as the dedicated user. One per job."""

    uid: int
    gid: int
    # Where the engine's HOME, XDG and temporary directories are (owned by the engine user).
    home: str
    tmpdir: str
    # A root-owned directory the engine user can enter but not list; the config file goes in it.
    config_dir: Path
    # Who owns the engine's config file: root, the supervisor. Never the engine user, which could
    # then change its mode and rewrite it.
    config_owner: int = 0
    # The ports of the single Dynamic slot, which the static network rules allow (#244).
    proxy_port: int = DEFAULT_PROXY_PORT
    engine_port: int = DEFAULT_ENGINE_PORT
    # The loopback port of the Implementer's egress proxy (#763), which the rules also allow; the
    # probe proves it reachable. None for a Dynamic job.
    egress_port: int | None = None
    # Which ruleset startup installed (#345); the fallback one does not see IPv6, so a job in that
    # mode proves IPv6 off again before its engine starts.
    egress_mode: EgressMode = EgressMode.FULL
    _verified: bool = field(default=False, init=False)

    # -- starting -------------------------------------------------------------

    def spawn_options(self) -> dict[str, Any]:
        """The `Popen` keywords that make the child the engine user: no other group, no root."""
        return {"user": self.uid, "group": self.gid, "extra_groups": []}

    def write_config(self, config: dict[str, Any]) -> Path:
        """Write the engine config so that only the engine user (and root) can read it.

        It carries the job's proxy capability. The directory is root's and not listable by the
        engine; the file belongs to the supervisor with the engine's group and mode 0440: the
        engine reads it but cannot rewrite or chmod it, and no other user of the container can
        read it either (#202: config readability).
        """
        return self.write_file("opencode.json", json.dumps(config))

    def write_file(self, name: str, text: str) -> Path:
        """Write another file of the runner's for the engine (the Implementer's instruction file,
        #764) with the same ownership and mode as the config: the engine reads it, nobody else."""
        path = self.config_dir / name
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(text)
            os.fchown(stream.fileno(), self.config_owner, self.gid)
            os.fchmod(stream.fileno(), 0o440)
        return path

    def confine(self, proxy_port: int, engine_port: int) -> None:
        """Prove, once, that the static network rules confine the engine user to these ports.

        The rules were installed when the container started and `NET_ADMIN` was dropped right
        after (`static_isolation.py`); nothing is installed per job. This checks that the ports in
        use are the ones the rules allow, that this process really holds neither `NET_ADMIN` nor
        `SETPCAP` and that the probe, run as the engine user, reaches the proxy and nothing else.
        With the fallback ruleset (#345) it also proves that IPv6, which that ruleset does not
        see, is off. In an Implementer container (`egress_port` set) the egress proxy, which must
        already listen, is probed as reachable too (#763).

        The first call also ends whatever the user still runs: a job process that was killed
        without a chance to clean up (SIGKILL, an OOM kill) leaves its engine behind, and the
        lease on the user is free again the moment that process is gone.
        """
        if (proxy_port, engine_port) != (self.proxy_port, self.engine_port):
            raise IsolationError("the engine ports are not the ones the network rules allow")
        if not self._verified and not self.sweep():
            raise IsolationError("a process of the engine user from an earlier job cannot be ended")
        require_startup_capabilities_gone()
        if not self._verified:
            verify_confinement(
                self.uid,
                self.gid,
                proxy_port,
                *(() if self.egress_port is None else (self.egress_port,)),
            )
            if self.egress_mode is EgressMode.FALLBACK:
                verify_ipv6_off(self.uid, self.gid)
            self._verified = True

    def owns_listener(self, port: int, *, tables: dict[str, str] | None = None) -> bool:
        """True when the engine user, and nobody else, listens on `port`."""
        owners = listener_uids(port, _read_tables() if tables is None else tables)
        return owners == {self.uid}

    # -- ending ---------------------------------------------------------------

    def sweep(self) -> bool:
        """Kill every process of the engine user, wherever it went. True when none is left."""
        return sweep_user(self.uid, self.gid)

    def close(self) -> bool:
        """End the job's use of the user: nothing of it runs. True when that is so.

        The network rules are static and stay (they confine the user for the life of the
        container). If the sweep cannot finish the next job's first sweep fails closed while the
        process lives, and it refuses to start.
        """
        return self.sweep()


__all__ = [
    "EngineLaunch",
    "IsolationError",
    "SweepUnavailable",
    "listener_uids",
    "sweep_user",
    "try_sweep_user",
    "user_pids",
]
