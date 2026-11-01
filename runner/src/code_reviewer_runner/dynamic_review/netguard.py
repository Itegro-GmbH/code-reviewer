# SPDX-License-Identifier: LicenseRef-Proprietary
"""The engine user's network boundary: it may reach its job's model proxy and nothing else (#197).

The engine runs as a dedicated unprivileged user in the runner container. Tool denial is not a
network boundary, so the operating system enforces one: an nftables output filter keyed on the
socket owner (`meta skuid`) that lets that one user open new connections only to the loopback
address of this job's model proxy (and to the engine's own server port). Everything else it tries
(another job's loopback service, any other address, IPv6, UDP, raw sends) is rejected at once.
Only the answers of the engine's own server pass as replies (never "any tracked flow").

An Implementer container (#763) allows one more loopback port: the egress allowlist proxy that
the supervisor runs for the agent's package managers (`implementer/egress_proxy.py`). Nothing else
changes, and the engine user still never resolves a name or reaches any address itself.

Two rulesets exist (#345). The full one (`table inet`, `reject`) is what every host with a complete
nf_tables gets. Some VM kernels support only the `ip` family and have no `reject`; there the
fallback (`table ip`, `drop`) enforces the same policy, silently instead of at once, and IPv6 (which
an `ip` table does not see) must be switched off and proven so (`ipv6_off.py`). Startup asks the
kernel and picks (`select_egress_mode`); nothing in the environment or in a job can choose.

The rules are static: with one Dynamic slot the engine user and its two loopback ports are fixed,
so the runner installs them once when the container starts and then drops `NET_ADMIN` for good
(`static_isolation.py`, #244). Nothing in the container, root included, can change them after that.

A per-job network namespace would need `SYS_ADMIN`, a user namespace is excluded by the lead
decisions and a container-level rule cannot tell the supervisor (GitHub, the model upstream) from
the engine in the same container. The rules are therefore proven in effect before the engine
starts: a probe running as the engine user must reach the proxy and must be refused everywhere
else; any other result is `dynamic_isolation_self_check_failed` and no engine is started. Without
`NET_ADMIN` the supervisor cannot list the ruleset, so this probe is the verification of it.
"""

import contextlib
import json
import shutil
import socket
import subprocess
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.result import ErrorCode

PROXY_HOST = "127.0.0.1"
# A second loopback address: not the proxy's, so it stands in for "any other host" in the probe.
_OTHER_HOST = "127.0.0.2"
_TRUSTED_PATH = "/usr/local/bin:/usr/bin:/bin"
# `nft` lives in /usr/sbin on Debian and Ubuntu.
_NFT_PATH = f"/usr/sbin:/sbin:{_TRUSTED_PATH}"
_NFT_TIMEOUT_SECONDS = 10.0
_PROBE_TIMEOUT_SECONDS = 15.0
_CONNECT_TIMEOUT_SECONDS = 2.0
_UDP_WAIT_SECONDS = 0.5

# Runs as the engine user: one connection to the allowed port, one to each forbidden stand-in, and
# one datagram. Prints which connections got through. Fixed text, no repository input.
_PROBE = r"""
import json, socket, sys
host, allowed, tcp_ports, other_host, other_port, udp_port = sys.argv[1:7]
extra_ports = sys.argv[8].split(",") if len(sys.argv) > 8 else []
def connect(address, port):
    try:
        with socket.create_connection((address, int(port)), timeout=float(sys.argv[7])):
            return True
    except OSError:
        return False
reached = {
    "allowed": connect(host, allowed),
    "other_port": connect(host, tcp_ports),
    "other_host": connect(other_host, other_port),
}
if extra_ports:
    reached["extra"] = all([connect(host, port) for port in extra_ports])
try:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as datagram:
        datagram.sendto(b"x", (host, int(udp_port)))
except OSError:
    pass  # a refused send is the expected outcome; the supervisor looks at what arrived
print(json.dumps(reached))
"""


class IsolationError(Exception):
    """The network boundary is not in effect. `detail` names the property, never a value."""

    def __init__(self, detail: str) -> None:
        super().__init__(f"{ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED.value}: {detail}")
        self.code = ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED
        self.detail = detail


class NftUnavailable(IsolationError):
    """`nft` is not installed or could not be run: no ruleset of either mode can be installed."""


class NftRefused(IsolationError):
    """`nft` ran and the kernel refused the script (an unsupported family or expression)."""


class EgressMode(StrEnum):
    """Which ruleset confines the engine user. Stable: logged, and handed to the job processes."""

    FULL = "full"
    FALLBACK = "fallback"


# The loop hands the mode it decided to the Dynamic job processes under this name. It is set by the
# loop alone: the container's own environment is never passed on under it (`loop.py`).
EGRESS_MODE_VARIABLE = "RUNNER_EGRESS_MODE"
_PROBE_TABLE = "code_reviewer_capability_probe"

# Runs `nft` with a script on stdin. A test replaces it; the real one is `_run_nft`.
NftRunner = Callable[[str], None]


def table_family(mode: EgressMode) -> str:
    return "inet" if mode is EgressMode.FULL else "ip"


def table_name(uid: int) -> str:
    return f"code_reviewer_engine_{uid}"


def ruleset(
    uid: int,
    proxy_port: int,
    engine_port: int,
    mode: EgressMode = EgressMode.FULL,
    egress_port: int | None = None,
) -> str:
    """The nft script that confines `uid` to loopback TCP to `proxy_port` and `engine_port`.

    An Implementer container passes `egress_port` too (#763): the loopback port of the allowlist
    proxy. It is one more accepted port, before the final refusal; without it the script is
    byte for byte what it always was.

    `add table` + `flush table` makes it idempotent: installing again replaces the rules of this
    uid (a restarted container, a changed port).

    Nothing is accepted by connection state alone: a flow another process opened (the
    supervisor's DNS lookup, say) stays tracked for a while after its socket closed, and the user
    could send on it from the same source port. Replies are accepted only as the answers of the
    engine's own server port.

    The two modes differ in the family of the table and in the last rule only: `inet` + `reject`
    (refused at once) or `ip` + `drop` (silent, for kernels that have neither).
    """
    ports = (proxy_port, engine_port, *(() if egress_port is None else (egress_port,)))
    if uid <= 0 or any(not 0 < port < 65536 for port in ports) or len(set(ports)) != len(ports):
        raise IsolationError("the network rules are given an unusable user or port")
    table = table_name(uid)
    family = table_family(mode)
    loopback = f'oifname "lo" ip daddr {PROXY_HOST}'
    last = "reject with icmpx type admin-prohibited" if mode is EgressMode.FULL else "drop"
    egress = (
        []
        if egress_port is None
        else [
            # The supervisor's allowlist proxy: the only way the agent's tools leave the container.
            f"add rule {family} {table} output meta skuid {uid} {loopback} "
            f"tcp dport {egress_port} accept"
        ]
    )
    return "\n".join(
        [
            f"add table {family} {table}",
            f"flush table {family} {table}",
            f"add chain {family} {table} output {{ type filter hook output priority 0 ; "
            "policy accept ; }",
            # The answers of the engine's own server to whoever connected to it (the supervisor).
            f'add rule {family} {table} output meta skuid {uid} oifname "lo" '
            f"ip saddr {PROXY_HOST} ip daddr {PROXY_HOST} tcp sport {engine_port} "
            "ct state established accept",
            # The only new connections: this job's proxy and the engine's own server.
            f"add rule {family} {table} output meta skuid {uid} {loopback} "
            f"tcp dport {proxy_port} accept",
            f"add rule {family} {table} output meta skuid {uid} {loopback} "
            f"tcp dport {engine_port} accept",
            *egress,
            # Every other packet of that user: refused at once (full) or dropped (fallback).
            f"add rule {family} {table} output meta skuid {uid} {last}",
            "",
        ]
    )


def _run_nft(script: str) -> None:
    executable = shutil.which("nft", path=_NFT_PATH)
    if executable is None:
        raise NftUnavailable("the network filter tool is not installed")
    try:
        outcome = subprocess.run(
            [executable, "-f", "-"],
            input=script,
            capture_output=True,
            text=True,
            timeout=_NFT_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise NftUnavailable("the network filter could not be run") from None
    if outcome.returncode != 0:
        raise NftRefused("the network filter was refused by the kernel")


def inet_reject_supported(run: NftRunner = _run_nft) -> bool:
    """True when the kernel accepts what the full ruleset needs: a `table inet` with `reject`.

    Asked by installing a throw-away table whose one rule can match nobody (no process has that
    user id), and taking it away again. A kernel that refuses either the family or the expression
    answers False; a missing or unrunnable `nft` raises `NftUnavailable`, because that is not a
    statement about the kernel.
    """
    script = "\n".join(
        [
            f"add table inet {_PROBE_TABLE}",
            f"flush table inet {_PROBE_TABLE}",
            f"add chain inet {_PROBE_TABLE} output {{ type filter hook output priority 0 ; "
            "policy accept ; }",
            f"add rule inet {_PROBE_TABLE} output meta skuid 4294967294 "
            "reject with icmpx type admin-prohibited",
            "",
        ]
    )
    try:
        run(script)
    except NftRefused:
        return False
    # A table that matches nobody is harmless if it stays; the answer stands either way.
    with contextlib.suppress(NftRefused):
        run(f"delete table inet {_PROBE_TABLE}\n")
    return True


def select_egress_mode(run: NftRunner = _run_nft) -> EgressMode:
    """The full ruleset whenever the kernel supports it, the fallback only when it does not."""
    return EgressMode.FULL if inet_reject_supported(run) else EgressMode.FALLBACK


def egress_mode_from_environment(environment: Mapping[str, str]) -> EgressMode:
    """The mode the loop handed to this job process: missing means full, anything else unknown.

    Only the loop sets it (`loop.py`); an unknown value is an isolation failure, not a default.
    """
    if EGRESS_MODE_VARIABLE not in environment:
        return EgressMode.FULL
    try:
        return EgressMode(environment[EGRESS_MODE_VARIABLE])
    except ValueError:
        raise IsolationError("the egress mode handed to the job process is unknown") from None


@dataclass
class NetworkConfinement:
    """The nft rules of one engine user: `apply` installs them (at container start, #244)."""

    uid: int
    run: NftRunner = _run_nft
    mode: EgressMode = EgressMode.FULL

    def apply(self, proxy_port: int, engine_port: int, egress_port: int | None = None) -> None:
        self.run(ruleset(self.uid, proxy_port, engine_port, self.mode, egress_port))


# Runs the probe as the engine user: argv, the user and group, returns the stdout text.
ProbeRunner = Callable[[list[str], int, int], str]


def run_probe_as_user(argv: list[str], uid: int, gid: int) -> str:
    try:
        outcome = subprocess.run(
            argv,
            user=uid,
            group=gid,
            extra_groups=(),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=_PROBE_TIMEOUT_SECONDS,
            check=False,
            env={"PATH": _TRUSTED_PATH},
        )
    except (OSError, subprocess.TimeoutExpired):
        raise IsolationError("the network probe could not be run as the engine user") from None
    if outcome.returncode != 0:
        raise IsolationError("the network probe failed as the engine user")
    return outcome.stdout


def verify_confinement(
    uid: int,
    gid: int,
    allowed_port: int,
    *extra_ports: int,
    run_probe: ProbeRunner = run_probe_as_user,
) -> None:
    """Prove, as the engine user, that only `allowed_port` is reachable. Raises `IsolationError`.

    `extra_ports` (the egress proxy's, #763) must be reachable as well; a listener of the
    supervisor has to accept on each of them.

    The sentinels are listeners this process owns: another "job's" port on the proxy address, a
    port on another loopback address and a UDP socket. Without the rules every one of them would
    accept, so a refusal is the rules at work, not a missing route. The allowed port must accept.
    """
    python = shutil.which("python3", path=_TRUSTED_PATH)
    if python is None:
        raise IsolationError("no interpreter for the network probe")
    with (
        socket.socket() as other_port,
        socket.socket() as other_host,
        socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as datagram,
    ):
        try:
            other_port.bind((PROXY_HOST, 0))
            other_port.listen(1)
            other_host.bind((_OTHER_HOST, 0))
            other_host.listen(1)
            datagram.bind((PROXY_HOST, 0))
            datagram.settimeout(_UDP_WAIT_SECONDS)
        except OSError:
            raise IsolationError("the network probe could not open its listeners") from None
        argv = [
            python,
            "-I",
            "-c",
            _PROBE,
            PROXY_HOST,
            str(allowed_port),
            str(other_port.getsockname()[1]),
            _OTHER_HOST,
            str(other_host.getsockname()[1]),
            str(datagram.getsockname()[1]),
            str(_CONNECT_TIMEOUT_SECONDS),
            *([",".join(str(port) for port in extra_ports)] if extra_ports else []),
        ]
        output = run_probe(argv, uid, gid)
        try:
            datagram.recvfrom(16)
            datagram_arrived = True
        except OSError:
            datagram_arrived = False
    try:
        document: Any = json.loads(output)
    except ValueError:
        document = None
    reached = as_object(document)
    if reached is None:
        raise IsolationError("the network probe returned no result")
    if reached.get("allowed") is not True:
        raise IsolationError("the engine user cannot reach its model proxy")
    if extra_ports and reached.get("extra") is not True:
        raise IsolationError("the engine user cannot reach its egress proxy")
    if reached.get("other_port") is not False or reached.get("other_host") is not False:
        raise IsolationError("the engine user can reach a service other than its model proxy")
    if datagram_arrived:
        raise IsolationError("the engine user can send datagrams")
