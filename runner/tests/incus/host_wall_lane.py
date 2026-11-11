# SPDX-License-Identifier: LicenseRef-Proprietary

"""What the lane of the host's nft table (#1008) needs besides the launcher's own objects: commands
on the host, the decoy servers that stand for the host's services and the proxy, a lab network
namespace that stands for the LAN, the metadata address and the internet (a forwarded target needs
somewhere to be forwarded to), and the probes run from inside an instance.

A probe has four possible answers, and only two of them say a packet reached the host or beyond:
`open` (a connection was made) and `refused` (something answered with a reset); `timeout` (nothing
answered: the packet was dropped) and `unreachable` (no route: nothing was sent, which proves
nothing and is an error of the lane, never a pass)."""

import re
import socketserver
import subprocess
import threading
from collections.abc import Sequence
from dataclasses import dataclass, field

from code_reviewer_runner.factory_runner.incus.client import IncusClient, run_exec

REACHED = ("open", "refused")
LAB_NAMESPACE = "crlane-lan"
LAB_HOST_VETH = "crlane-v0"
LAB_PEER_VETH = "crlane-v1"
LAB_HOST_ADDRESS = "10.77.0.1"
LAB_ADDRESS = "10.77.0.2"
METADATA_ADDRESS = "169.254.169.254"
INTERNET_ADDRESS = "203.0.113.9"
FORWARD_TAG = "crlane-forward"


def sh(*command: str, check: bool = True) -> str:
    """A command on the host (the lane runs as root); its standard output."""
    done = subprocess.run(
        command, capture_output=True, text=True, check=False, stdin=subprocess.DEVNULL
    )
    if check and done.returncode != 0:
        raise AssertionError(f"{' '.join(command)}: {done.returncode}: {done.stderr.strip()}")
    return done.stdout


# -- decoys: what the host would answer with ---


class _TcpHandler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        server = self.server
        assert isinstance(server, DecoyTcp)
        server.hits.append(str(self.client_address[0]))
        self.request.sendall(b"decoy\n")


class _UdpHandler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        server = self.server
        assert isinstance(server, DecoyUdp)
        server.hits.append(str(self.client_address[0]))


class DecoyTcp(socketserver.ThreadingTCPServer):
    """A TCP service of the host that records who connected."""

    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, host: str, port: int) -> None:
        self.hits: list[str] = []
        super().__init__((host, port), _TcpHandler)


class DecoyUdp(socketserver.ThreadingUDPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, host: str, port: int) -> None:
        self.hits: list[str] = []
        super().__init__((host, port), _UdpHandler)


@dataclass
class Decoys:
    """The servers a lane runs on the host; `close` stops them all."""

    servers: list[DecoyTcp | DecoyUdp] = field(default_factory=list[DecoyTcp | DecoyUdp])

    def tcp(self, host: str, port: int) -> DecoyTcp:
        server = DecoyTcp(host, port)
        self._serve(server)
        return server

    def udp(self, host: str, port: int) -> DecoyUdp:
        server = DecoyUdp(host, port)
        self._serve(server)
        return server

    def _serve(self, server: DecoyTcp | DecoyUdp) -> None:
        self.servers.append(server)
        threading.Thread(target=server.serve_forever, daemon=True).start()

    def close(self) -> None:
        for server in self.servers:
            server.shutdown()
            server.server_close()
        self.servers.clear()


# -- the lab network: where a forwarded packet goes ---


def lab_up() -> subprocess.Popen[bytes]:
    """A network namespace behind a veth pair, with the addresses of a LAN host, the cloud metadata
    service and an internet host, each answering on its port; the host forwards to it. Returns the
    process that serves them (stop it with `lab_down`)."""
    lab_down(None)
    sh("ip", "netns", "add", LAB_NAMESPACE)
    sh(
        "ip",
        "link",
        "add",
        LAB_HOST_VETH,
        "type",
        "veth",
        "peer",
        "name",
        LAB_PEER_VETH,
        "netns",
        LAB_NAMESPACE,
    )
    sh("ip", "addr", "add", f"{LAB_HOST_ADDRESS}/24", "dev", LAB_HOST_VETH)
    sh("ip", "link", "set", LAB_HOST_VETH, "up")
    inside = ("ip", "-n", LAB_NAMESPACE)
    sh(*inside, "addr", "add", f"{LAB_ADDRESS}/24", "dev", LAB_PEER_VETH)
    sh(*inside, "link", "set", LAB_PEER_VETH, "up")
    sh(*inside, "link", "set", "lo", "up")
    for address in (METADATA_ADDRESS, INTERNET_ADDRESS):
        sh(*inside, "addr", "add", f"{address}/32", "dev", "lo")
        sh("ip", "route", "replace", f"{address}/32", "via", LAB_ADDRESS)
    # Whatever the lab host answers goes back the way it came, any source address.
    sh(*inside, "route", "add", "default", "via", LAB_HOST_ADDRESS)
    sh("sysctl", "-qw", "net.ipv4.ip_forward=1")
    return subprocess.Popen(
        [
            "ip",
            "netns",
            "exec",
            LAB_NAMESPACE,
            "python3",
            "-c",
            "import http.server, threading\n"
            "def serve(port):\n"
            "    handler = http.server.SimpleHTTPRequestHandler\n"
            "    http.server.ThreadingHTTPServer(('0.0.0.0', port), handler).serve_forever()\n"
            "for port in (80, 8000):\n"
            "    threading.Thread(target=serve, args=(port,), daemon=True).start()\n"
            "threading.Event().wait()\n",
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def lab_down(server: subprocess.Popen[bytes] | None) -> None:
    if server is not None:
        server.terminate()
        server.wait(timeout=10)
    sh("ip", "link", "del", LAB_HOST_VETH, check=False)
    sh("ip", "netns", "del", LAB_NAMESPACE, check=False)
    for address in (METADATA_ADDRESS, INTERNET_ADDRESS):
        sh("ip", "route", "del", f"{address}/32", check=False)


def allow_forwarding_through_dockers_chain(bridge: str) -> None:
    """Docker (on the runner) sets the FORWARD policy to DROP; its sanctioned hook for what is not
    Docker's is DOCKER-USER. The controls of the forwarded probes need the packet to leave the
    bridge, so the lane lets it, tagged, and takes the rules away when the control is over."""
    forget_forwarding(bridge)
    for direction in ("-i", "-o"):
        # A machine whose Docker has no DOCKER-USER chain has no policy to get past either.
        sh(
            "iptables",
            "-I",
            "DOCKER-USER",
            direction,
            bridge,
            "-m",
            "comment",
            "--comment",
            FORWARD_TAG,
            "-j",
            "ACCEPT",
            check=False,
        )


def forget_forwarding(bridge: str) -> None:
    for direction in ("-i", "-o"):
        while (
            subprocess.run(
                [
                    "iptables",
                    "-D",
                    "DOCKER-USER",
                    direction,
                    bridge,
                    "-m",
                    "comment",
                    "--comment",
                    FORWARD_TAG,
                    "-j",
                    "ACCEPT",
                ],
                capture_output=True,
                check=False,
                stdin=subprocess.DEVNULL,
            ).returncode
            == 0
        ):
            pass


# -- nft, read ---


def our_counter(listing: str, comment: str) -> int:
    """The packet counter of the rule of `listing` (as `nft list table` prints it) whose comment
    starts with `comment`."""
    for line in listing.splitlines():
        if f'comment "{comment}' in line:
            found = re.search(r"counter packets (\d+) bytes \d+", line)
            if found:
                return int(found.group(1))
    raise AssertionError(f"no counter for {comment!r} in:\n{listing}")


def other_tables(own_table: str) -> dict[str, str]:
    """Every table of the machine but ours (Docker's, Incus's, whatever else is there), without
    counters: what must be the same before and after anything we do."""
    from code_reviewer_runner.factory_runner.incus.host_wall import normalized

    found: dict[str, str] = {}
    for line in sh("nft", "list", "tables").splitlines():
        parts = line.split()
        if len(parts) != 3 or parts[0] != "table" or parts[2] == own_table:
            continue
        found[f"{parts[1]} {parts[2]}"] = normalized(sh("nft", "list", "table", parts[1], parts[2]))
    return found


# -- probes from inside an instance ---


async def tcp_verdict(
    client: IncusClient, instance: str, host: str, port: int, *, seconds: int = 3
) -> str:
    """`open`, `refused`, `timeout` or `unreachable` for one TCP connection from `instance`."""
    script = f"timeout {seconds} bash -c 'exec 3<>/dev/tcp/{host}/{port}' 2>&1; echo rc=$?"
    result = await run_exec(client, instance, ("sh", "-c", script), timeout=seconds + 20.0)
    text = result.stdout
    code = re.search(r"rc=(\d+)", text)
    if code is None:
        raise AssertionError(f"no verdict from {instance} to {host}:{port}: {text!r}")
    if code.group(1) == "0":
        return "open"
    if code.group(1) == "124":
        return "timeout"
    lowered = text.lower()
    if "refused" in lowered:
        return "refused"
    if "unreachable" in lowered or "no route" in lowered:
        return "unreachable"
    raise AssertionError(f"{instance} to {host}:{port}: {text!r}")


async def ping6_verdict(
    client: IncusClient, instance: str, address: str, host_mac: str, device: str, bridge: str
) -> tuple[str, str]:
    """An ICMPv6 echo from `instance` to the host's link-local `address`. Neighbour discovery is
    taken out of the picture (the instance and the host get a permanent entry for each other), so
    that what is asked is only whether the echo reaches the host. Returns `open` or `timeout` and
    what `ping` and the instance's IPv6 said (for the message of a failed lane): `(verdict, text)`,
    with the instance's link-local address and MAC in the text for the host's own entry."""
    setup = await run_exec(
        client,
        instance,
        (
            "sh",
            "-c",
            f"ip -6 neigh replace {address} lladdr {host_mac} dev {device} nud permanent; "
            f"ip -6 -o addr show dev {device} scope link; cat /sys/class/net/{device}/address",
        ),
        timeout=30.0,
    )
    lines = setup.stdout.split()
    own_address = lines[lines.index("inet6") + 1].split("/")[0]
    own_mac = lines[-1]
    sh("ip", "-6", "neigh", "replace", own_address, "lladdr", own_mac, "dev", bridge,
       "nud", "permanent")  # fmt: skip
    result = await run_exec(
        client,
        instance,
        ("sh", "-c", f"ping -6 -c 1 -W 2 {address}%{device} 2>&1; echo rc=$?"),
        timeout=30.0,
    )
    return ("open" if "rc=0" in result.stdout else "timeout"), result.stdout


async def send_udp(client: IncusClient, instance: str, host: str, port: int) -> None:
    """One datagram from `instance`; it is the decoy that says whether it arrived."""
    await run_exec(
        client,
        instance,
        ("bash", "-c", f"echo x > /dev/udp/{host}/{port}"),
        timeout=20.0,
    )


def reached(verdict: str) -> bool:
    return verdict in REACHED


def table_of(rows: Sequence[tuple[str, str, str, str]]) -> str:
    """A readable grid of (phase, instance, target, verdict) for an assertion message."""
    return "\n".join(
        f"{phase:8} {who:2} {target:22} {verdict}" for phase, who, target, verdict in rows
    )
