# SPDX-License-Identifier: LicenseRef-Proprietary
"""The network setup of the Dynamic runner container, done once at start, and the end of NET_ADMIN.

The engine's nft rules (`netguard.py`) depend on three values only: the engine user and two
loopback ports (an Implementer container adds a third, the egress proxy's, #763). With one Dynamic
slot those values are fixed for the life of the container, so the
rules are installed once, when the container starts, and the capabilities that installing needed
are then dropped for good (#244, ADR 0003):

* `NET_ADMIN` installs the nftables rules and could change or remove them;
* `SETPCAP` is what allows a process to drop a capability from its bounding set.

`secure_startup` installs the rules, drops both from the bounding set and from the loop's own
permitted, effective and inheritable sets, and reads `/proc/self/status` to confirm it. Everything
the loop starts afterwards (job processes, the engine) inherits the smaller bounding set, so no
process of this container can touch the rules again, root or not. Each Dynamic job re-checks its
own sets (`require_startup_capabilities_gone`) and runs the probe as the engine user, which is the
proof that the static rules are in effect: without `NET_ADMIN` not even the supervisor can list
them.

The one process that keeps the capabilities is PID 1 (`tini`, which runs nothing of the job and is
not reachable by the engine user).

Which rules are installed depends on the kernel (#345): the full `inet` + `reject` ruleset where the
kernel supports it, otherwise an `ip` + `drop` one, with IPv6 switched off by the same startup step
(it needs `NET_ADMIN` too). The choice is the kernel's answer; `secure_startup`'s `detect` seam is
how a test forces the other mode, and nothing in the environment or in a job reaches it.
"""

import ctypes
import logging
import platform
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Concatenate

from code_reviewer_runner.result import ErrorCode

from .ipv6_off import disable_ipv6 as switch_ipv6_off
from .ipv6_off import ipv6_problem as find_ipv6_problem
from .netguard import EgressMode, IsolationError, NetworkConfinement, select_egress_mode

PROXY_PORT_VARIABLE = "RUNNER_DYNAMIC_PROXY_PORT"
ENGINE_PORT_VARIABLE = "RUNNER_DYNAMIC_ENGINE_PORT"
# The Implementer container's variables (#746; `job.py` keeps the same names and a test compares).
EGRESS_PORT_VARIABLE = "RUNNER_IMPLEMENTER_EGRESS_PORT"
NETWORK_VARIABLE = "RUNNER_IMPLEMENTER_NETWORK"
# Below the kernel's default ephemeral range (32768 and up). The range can be lowered, so startup
# reads the real one (`require_ports_outside_ephemeral_range`) before it installs anything.
DEFAULT_PROXY_PORT = 10180
DEFAULT_ENGINE_PORT = 10181
DEFAULT_EGRESS_PORT = 10182
_LOWEST_PORT = 1024
_HIGHEST_PORT = 32767
EPHEMERAL_RANGE_FILE = Path("/proc/sys/net/ipv4/ip_local_port_range")
THREAD_DIRECTORY = Path("/proc/self/task")

CAP_SETPCAP = 8
CAP_NET_ADMIN = 12
STARTUP_ONLY_CAPABILITIES = (CAP_NET_ADMIN, CAP_SETPCAP)
_STARTUP_MASK = sum(1 << number for number in STARTUP_ONLY_CAPABILITIES)

_PR_CAPBSET_DROP = 24
_LINUX_CAPABILITY_VERSION_3 = 0x20080522
# The numbers of the `capget` and `capset` system calls; the image is linux-x64 (arm64 listed).
_CAPGET = {"x86_64": 125, "aarch64": 90}
_CAPSET = {"x86_64": 126, "aarch64": 91}
_SETS = ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb")

_log = logging.getLogger("code_reviewer_runner.loop")


@dataclass(frozen=True)
class SlotPorts:
    """The loopback ports of the single slot: this job's model proxy and the engine, and in an
    Implementer container the egress proxy (`egress`, #763; None when there is none)."""

    proxy: int
    engine: int
    egress: int | None = None

    @property
    def extra(self) -> tuple[int, ...]:
        """The ports beyond the model proxy and the engine that the rules allow."""
        return () if self.egress is None else (self.egress,)


class ImplementerNetwork(StrEnum):
    """What the agent of an Implementer container may reach besides the model proxy (#746)."""

    REGISTRIES = "registries"
    NONE = "none"


def _port(environment: Mapping[str, str], name: str, default: int) -> int:
    raw = environment.get(name, "").strip()
    if not raw:
        return default
    if not raw.isascii() or not raw.isdigit() or not _LOWEST_PORT <= int(raw) <= _HIGHEST_PORT:
        raise IsolationError(f"{name} must be a port between {_LOWEST_PORT} and {_HIGHEST_PORT}")
    return int(raw)


def implementer_network(environment: Mapping[str, str]) -> ImplementerNetwork:
    """The network of an Implementer container from trusted runner configuration.

    Unset on both variables is no Implementer container and reaches nothing (`none`); a port alone
    means `registries`. Anything but the two known values is an isolation failure.
    """
    raw = environment.get(NETWORK_VARIABLE, "").strip()
    if not raw:
        return (
            ImplementerNetwork.REGISTRIES
            if environment.get(EGRESS_PORT_VARIABLE, "").strip()
            else ImplementerNetwork.NONE
        )
    try:
        return ImplementerNetwork(raw)
    except ValueError:
        raise IsolationError(
            f"{NETWORK_VARIABLE} must be one of "
            + ", ".join(mode.value for mode in ImplementerNetwork)
        ) from None


def egress_port(environment: Mapping[str, str]) -> int | None:
    """The egress proxy's loopback port, or None when the container's network is `none`."""
    if implementer_network(environment) is ImplementerNetwork.NONE:
        return None
    return _port(environment, EGRESS_PORT_VARIABLE, DEFAULT_EGRESS_PORT)


def slot_ports(environment: Mapping[str, str]) -> SlotPorts:
    """The ports of the slot from trusted runner configuration. Raises `IsolationError`."""
    ports = SlotPorts(
        _port(environment, PROXY_PORT_VARIABLE, DEFAULT_PROXY_PORT),
        _port(environment, ENGINE_PORT_VARIABLE, DEFAULT_ENGINE_PORT),
        egress_port(environment),
    )
    if ports.proxy == ports.engine:
        raise IsolationError(f"{PROXY_PORT_VARIABLE} and {ENGINE_PORT_VARIABLE} must differ")
    if ports.egress in (ports.proxy, ports.engine):
        raise IsolationError(
            f"{EGRESS_PORT_VARIABLE} must differ from {PROXY_PORT_VARIABLE} "
            f"and {ENGINE_PORT_VARIABLE}"
        )
    return ports


def require_ports_outside_ephemeral_range(
    ports: SlotPorts, source: Path = EPHEMERAL_RANGE_FILE
) -> None:
    """Raise `IsolationError` unless both ports lie outside the kernel's ephemeral port range.

    An outgoing connection of any process may be given a port of that range; a fixed port inside
    it could then be taken by a stranger before the supervisor or the engine binds it. An
    unreadable or unparsable range counts as unsafe.
    """
    try:
        low, high = (int(part) for part in source.read_text(encoding="ascii").split())
    except (OSError, ValueError):
        raise IsolationError("the kernel's ephemeral port range cannot be read") from None
    if low > high:
        raise IsolationError("the kernel's ephemeral port range cannot be read")
    if any(low <= port <= high for port in (ports.proxy, ports.engine, *ports.extra)):
        raise IsolationError("a fixed slot port lies inside the kernel's ephemeral port range")


# -- what the process holds ---------------------------------------------------


def capability_sets(status: str) -> dict[str, int]:
    """The capability sets of a `/proc/<pid>/status` text, as numbers."""
    found: dict[str, int] = {}
    for line in status.splitlines():
        name, _, value = line.partition(":")
        if name not in _SETS:
            continue
        try:
            found[name] = int(value.strip(), 16)
        except ValueError:
            continue
    return found


def sets_holding_startup_capabilities(status: str) -> list[str]:
    """The sets of the process that still hold `NET_ADMIN` or `SETPCAP` (or cannot be read)."""
    sets = capability_sets(status)
    return [name for name in _SETS if name not in sets or sets[name] & _STARTUP_MASK]


def require_startup_capabilities_gone(status: str | None = None) -> None:
    """Raise `IsolationError` unless this process holds neither `NET_ADMIN` nor `SETPCAP`.

    The bounding set is what matters for everything it starts; the other sets are the process's
    own. Reads the process's own status unless a text is given (tests).
    """
    if status is None:
        try:
            status = Path("/proc/self/status").read_text(encoding="ascii", errors="replace")
        except OSError:
            raise IsolationError("the capabilities of the supervisor cannot be read") from None
    if sets_holding_startup_capabilities(status):
        raise IsolationError("the supervisor still holds a capability only startup may hold")


# -- dropping them ------------------------------------------------------------


class _Header(ctypes.Structure):
    _fields_ = [("version", ctypes.c_uint32), ("pid", ctypes.c_int)]


class _Data(ctypes.Structure):
    _fields_ = [
        ("effective", ctypes.c_uint32),
        ("permitted", ctypes.c_uint32),
        ("inheritable", ctypes.c_uint32),
    ]


def drop_startup_capabilities(task_directory: Path = THREAD_DIRECTORY) -> None:
    """Remove `NET_ADMIN` and `SETPCAP` from this process and from everything it will start.

    Capability sets belong to a thread, and a new thread copies its creator's: this must run
    before any other thread exists. The bounding set goes first (it needs `SETPCAP`, which is
    therefore dropped last); then the process's own sets lose both. The result is read back.

    "Other threads" means OS threads: `threading.active_count()` does not see those of a native
    extension, so the kernel's own list (`/proc/self/task`) has to hold exactly this one thread.
    """
    try:
        os_threads = len(list(task_directory.iterdir()))
    except OSError:
        os_threads = -1
    if threading.active_count() != 1 or os_threads != 1:
        raise IsolationError("the capabilities can only be dropped before other threads exist")
    machine = platform.machine()
    if machine not in _CAPGET:
        raise IsolationError("the capabilities cannot be dropped on this architecture")
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    for number in STARTUP_ONLY_CAPABILITIES:  # NET_ADMIN, then SETPCAP itself
        # prctl takes unsigned long arguments after the option: pass them as such.
        zero = ctypes.c_ulong(0)
        if libc.prctl(_PR_CAPBSET_DROP, ctypes.c_ulong(number), zero, zero, zero) != 0:
            raise IsolationError("a capability could not be dropped from the bounding set")
    header = _Header(_LINUX_CAPABILITY_VERSION_3, 0)
    data = (_Data * 2)()
    if libc.syscall(_CAPGET[machine], ctypes.byref(header), data) != 0:
        raise IsolationError("the capabilities of the supervisor could not be read")
    for entry in data[:1]:  # both capabilities are below 32
        entry.effective &= ~_STARTUP_MASK & 0xFFFFFFFF
        entry.permitted &= ~_STARTUP_MASK & 0xFFFFFFFF
        entry.inheritable &= ~_STARTUP_MASK & 0xFFFFFFFF
    header = _Header(_LINUX_CAPABILITY_VERSION_3, 0)
    if libc.syscall(_CAPSET[machine], ctypes.byref(header), data) != 0:
        raise IsolationError("the capabilities of the supervisor could not be lowered")
    require_startup_capabilities_gone()


# -- the startup step ---------------------------------------------------------

# Takes the model proxy port, the engine port and, in an Implementer container, the egress port.
Install = Callable[Concatenate[int, int, ...], None]
Drop = Callable[[], None]
Detect = Callable[[], EgressMode]


@dataclass(frozen=True)
class EgressSetup:
    """What the startup step did: whether the engine user's rules are installed, in which mode."""

    rules_installed: bool
    mode: EgressMode


def secure_startup(
    uid: int,
    ports: SlotPorts,
    *,
    install: Install | None = None,
    drop: Drop = drop_startup_capabilities,
    ephemeral_range: Path = EPHEMERAL_RANGE_FILE,
    detect: Detect | None = None,
    disable_ipv6: Drop = switch_ipv6_off,
    ipv6_problem: Callable[[], str | None] = find_ipv6_problem,
) -> EgressSetup:
    """Install the engine user's rules once, then drop `NET_ADMIN` for good.

    The kernel decides the ruleset (`select_egress_mode`): the full one wherever it can, the `ip`
    + `drop` fallback only where `inet` or `reject` is missing; the fallback then switches IPv6
    off, since its table does not see IPv6. `detect` is the one way to force a mode and exists
    for tests; no caller in production passes it.

    `rules_installed` is False when the rules could not be installed (no `nft`, no `nf_tables`, a
    fixed port inside the kernel's ephemeral range). The capabilities are dropped all the same: no
    Dynamic job then passes its probe, so each fails closed with
    `dynamic_isolation_self_check_failed`, while Diff jobs are unaffected. If the drop fails,
    `IsolationError` is raised and the runner must not start: a supervisor that can still change
    the rules is not the boundary the design says it is.
    """
    mode = EgressMode.FULL
    installed = True
    try:
        require_ports_outside_ephemeral_range(ports, ephemeral_range)
        mode = (detect or select_egress_mode)()
        (install or NetworkConfinement(uid, mode=mode).apply)(
            ports.proxy, ports.engine, *ports.extra
        )
        # After the rules, not before: no engine runs at startup, and rules that could not be
        # installed must not leave the container, Diff jobs included, without IPv6 (review of #347).
        if mode is EgressMode.FALLBACK:
            disable_ipv6()
    except IsolationError as error:
        installed = False
        _log.error(
            "the engine network rules could not be installed (%s); "
            "Dynamic jobs on this runner will fail with %s",
            error.detail,
            error.code.value,
        )
    if installed:
        _log_mode(mode, ipv6_problem)
    drop()
    return EgressSetup(installed, mode)


def _log_mode(mode: EgressMode, ipv6_problem: Callable[[], str | None]) -> None:
    if mode is EgressMode.FULL:
        _log.info("egress rules: full (inet)")
        return
    problem = ipv6_problem()
    if problem is None:
        _log.info("egress rules: fallback (ip, ipv6 disabled)")
        return
    # Not a crash: the self-check refuses `opencode` for the same reason (`ipv6_not_disabled`).
    _log.error(
        "egress rules: fallback (ip), but %s; Dynamic jobs on this runner will fail with %s. "
        "Set net.ipv6.conf.all.disable_ipv6=1 and net.ipv6.conf.default.disable_ipv6=1 on the "
        "container",
        problem,
        ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED.value,
    )
