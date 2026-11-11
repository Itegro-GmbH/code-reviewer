# SPDX-License-Identifier: LicenseRef-Proprietary

"""The network door chained to the outer wall's proxy (#994): agent, network door, outer-wall proxy.

The door is the real code on a real loopback socket; the outer-wall proxy is a stand-in that
records what it was asked for and relays to loopback origins (the real proxy is
`test_firecracker_proxy_wall.py`). What these tests hold: the door decides on the rule and the port
and then asks the proxy for the name, looks nothing up and dials nothing but the proxy, a refusal
or a missing proxy is the `502` the agent gets for a host that does not answer, and the door's
firewall and start document name the proxy."""

import io
import json
import socket
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

import pytest
from netdoor_support import Lookups, Origin
from test_netdoor_launcher import rig  # noqa: F401  (the fixture)

from code_reviewer_runner.implementer.netdoor import service
from code_reviewer_runner.implementer.netdoor.connections import ConnectionLog
from code_reviewer_runner.implementer.netdoor.proxy import (
    Decider,
    ProxyServer,
    chained_connector,
)
from code_reviewer_runner.implementer.netdoor.service import StartRefused, parse_start, run_netdoor
from code_reviewer_runner.implementer.netdoor_launcher import (
    egress_rules,
    rules_document,
    start_document,
)
from code_reviewer_runner.implementer.network_rule import MODE_LIST, MODE_OPEN, NetworkRule
from code_reviewer_runner.outer_proxy import OuterProxy

PROXY = OuterProxy("172.31.0.9", 3128)
RULE = NetworkRule(MODE_LIST, ("api.example.com", "example.com", "refused.example.com"))
ECHO = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"


class OuterProxyStandIn:
    """What the host's proxy does as far as the door sees it: reads a `CONNECT name:port`, records
    it, answers 403 for a name in `refuse` and otherwise 200 and relays to the origin of that name
    (a loopback server), or 502 when it has none."""

    def __init__(self, origins: dict[tuple[str, int], int], refuse: set[str] | None = None) -> None:
        self.origins = origins
        self.refuse = refuse or set()
        self.asked: list[str] = []
        self._listener = socket.socket()
        self._listener.bind(("127.0.0.1", 0))
        self._listener.listen(16)
        self.port = int(self._listener.getsockname()[1])
        threading.Thread(target=self._accept, daemon=True).start()

    def _accept(self) -> None:
        while True:
            try:
                connection, _ = self._listener.accept()
            except OSError:
                return
            threading.Thread(target=self._serve, args=(connection,), daemon=True).start()

    def _serve(self, connection: socket.socket) -> None:
        with connection:
            data = b""
            while b"\r\n\r\n" not in data:
                chunk = connection.recv(4096)
                if not chunk:
                    return
                data += chunk
            line = data.split(b"\r\n")[0].decode()
            method, target, _ = line.split(" ")
            self.asked.append(f"{method} {target}")
            name, _, port = target.rpartition(":")
            if name in self.refuse:
                connection.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
                return
            origin = self.origins.get((name, int(port)))
            if origin is None:
                connection.sendall(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
                return
            connection.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            with socket.create_connection(("127.0.0.1", origin)) as upstream:
                relay(connection, upstream)

    def close(self) -> None:
        self._listener.close()


def relay(client: socket.socket, upstream: socket.socket) -> None:
    def pump(source: socket.socket, sink: socket.socket) -> None:
        try:
            while chunk := source.recv(4096):
                sink.sendall(chunk)
        except OSError:
            pass
        finally:
            try:
                sink.shutdown(socket.SHUT_WR)
            except OSError:
                pass

    threading.Thread(target=pump, args=(client, upstream), daemon=True).start()
    pump(upstream, client)


class Chained:
    def __init__(self, server: ProxyServer, outer: OuterProxyStandIn, log: ConnectionLog) -> None:
        self.server, self.outer, self.log = server, outer, log
        self.dialled: list[tuple[str, int]] = []

    @property
    def port(self) -> int:
        return self.server.port


@contextmanager
def chained_door(
    rule: NetworkRule = RULE,
    *,
    origins: dict[tuple[str, int], int] | None = None,
    refuse: set[str] | None = None,
    outer_up: bool = True,
) -> Iterator[Chained]:
    outer = OuterProxyStandIn(origins or {}, refuse)
    log = ConnectionLog()
    dialled: list[tuple[str, int]] = []

    def connect(address: tuple[str, int], timeout: float) -> socket.socket:
        dialled.append(address)
        if not outer_up:
            raise ConnectionRefusedError
        return socket.create_connection(("127.0.0.1", outer.port), timeout=timeout)

    def resolver(name: str, port: int) -> list[str]:
        raise AssertionError(f"the door looked {name} up: a chained door resolves nothing")

    server = ProxyServer(
        ("127.0.0.1", 0),
        Decider(rule, log, resolver=resolver, chained=True),
        connector=chained_connector(PROXY, connect),
    ).start()
    door = Chained(server, outer, log)
    door.dialled = dialled
    try:
        yield door
    finally:
        server.stop()
        outer.close()


def agent(door: Chained, request: bytes, then: bytes = b"") -> bytes:
    """What the agent reads from the door after it sends `request` (and `then` once it is told 200)."""
    with socket.create_connection(("127.0.0.1", door.port), timeout=5) as sock:
        sock.sendall(request)
        answer = b""
        while b"\r\n\r\n" not in answer:
            chunk = sock.recv(4096)
            if not chunk:
                return answer
            answer += chunk
        head, _, rest = answer.partition(b"\r\n\r\n")
        if then and head.startswith(b"HTTP/1.1 200"):
            sock.sendall(then)
            sock.shutdown(socket.SHUT_WR)
            while chunk := sock.recv(4096):
                rest += chunk
        return head + b"\r\n\r\n" + rest


def origin_of(reply: bytes = ECHO) -> Iterator[Origin]:
    server = Origin(reply)
    try:
        yield server
    finally:
        server.close()


@pytest.fixture
def origin() -> Iterator[Origin]:
    yield from origin_of()


# #994-T01
def test_a_tunnel_through_the_door_is_a_tunnel_the_proxy_made_for_the_name(origin: Origin) -> None:
    with chained_door(origins={("api.example.com", 443): origin.port}) as door:
        answer = agent(
            door,
            b"CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n",
            b"GET / HTTP/1.1\r\nHost: api.example.com\r\n\r\n",
        )

    assert answer.startswith(b"HTTP/1.1 200 Connection Established")
    assert answer.endswith(b"ok"), "the origin's answer came back through both hops"
    assert door.outer.asked == ["CONNECT api.example.com:443"]
    assert door.dialled == [("172.31.0.9", 3128)], "the door dialled the proxy and nothing else"
    assert [(e["host"], e["port"], e["outcome"]) for e in door.log.snapshot()["connections"]] == [
        ("api.example.com", 443, "allowed")
    ]


# #994-T01
def test_plain_http_through_the_door_is_a_tunnel_to_port_80_and_the_request_in_origin_form(
    origin: Origin,
) -> None:
    with chained_door(origins={("example.com", 80): origin.port}) as door:
        answer = agent(door, b"GET http://example.com/a?b=1 HTTP/1.1\r\nHost: example.com\r\n\r\n")

    assert answer.endswith(b"ok")
    assert door.outer.asked == ["CONNECT example.com:80"]
    assert origin.received and origin.received[0].startswith(
        b"GET /a?b=1 HTTP/1.1\r\nHost: example.com"
    )


# #994-T01
def test_the_door_still_decides_the_rule_before_it_asks_the_proxy_anything() -> None:
    with chained_door() as door:
        answers = [
            agent(door, b"CONNECT elsewhere.example:443 HTTP/1.1\r\n\r\n"),
            agent(door, b"CONNECT api.example.com:8443 HTTP/1.1\r\n\r\n"),
            agent(door, b"CONNECT 93.184.216.34:443 HTTP/1.1\r\n\r\n"),
            agent(door, b"CONNECT [::1]:443 HTTP/1.1\r\n\r\n"),
        ]

    assert [a.split(b"\r\n")[0] for a in answers] == [b"HTTP/1.1 403 Forbidden"] * 4
    assert door.outer.asked == [] and door.dialled == [], "nothing refused here reached the proxy"
    reasons = [e["reason"] for e in door.log.snapshot()["connections"]]
    assert sorted(reasons) == ["ip_literal", "ip_literal", "not_listed", "port_not_allowed"]


# #994-T04
def test_a_name_the_proxy_refuses_is_a_502_for_the_agent_and_never_a_direct_connection() -> None:
    with chained_door(refuse={"refused.example.com"}) as door:
        answer = agent(door, b"CONNECT refused.example.com:443 HTTP/1.1\r\n\r\n")

    assert answer.startswith(b"HTTP/1.1 502"), answer
    assert b"X-Network-Door: upstream_failed" in answer
    assert door.outer.asked == ["CONNECT refused.example.com:443"]
    assert door.dialled == [("172.31.0.9", 3128)]
    assert [e["outcome"] for e in door.log.snapshot()["connections"]] == ["refused"]


# #994-T04
def test_a_proxy_that_is_not_there_is_a_502_and_the_door_dials_nothing_else() -> None:
    with chained_door(outer_up=False) as door:
        answer = agent(door, b"CONNECT api.example.com:443 HTTP/1.1\r\n\r\n")

    assert answer.startswith(b"HTTP/1.1 502")
    assert door.dialled == [("172.31.0.9", 3128)]


# #994-T04
def test_an_open_rule_does_not_make_the_door_resolve_or_dial_itself() -> None:
    with chained_door(NetworkRule(MODE_OPEN), refuse={"anything.example"}) as door:
        answer = agent(door, b"CONNECT anything.example:443 HTTP/1.1\r\n\r\n")

    assert answer.startswith(b"HTTP/1.1 502")
    assert door.dialled == [("172.31.0.9", 3128)]


# #994-T03
def test_a_door_that_is_not_chained_resolves_and_dials_the_address_it_checked(
    origin: Origin,
) -> None:
    looked = Lookups(
        table={"api.example.com": ["93.184.216.34"]}, servers={"93.184.216.34": origin.port}
    )
    server = ProxyServer(
        ("127.0.0.1", 0),
        Decider(RULE, ConnectionLog(), resolver=looked.resolve),
        connector=looked.connect,
    ).start()
    try:
        with socket.create_connection(("127.0.0.1", server.port), timeout=5) as sock:
            sock.sendall(b"CONNECT api.example.com:443 HTTP/1.1\r\n\r\n")
            assert sock.recv(100).startswith(b"HTTP/1.1 200")
    finally:
        server.stop()

    assert looked.looked_up == ["api.example.com"]
    assert looked.connected == [("93.184.216.34", 443)]


# -- the door process and its start document ---


def start_text(**changes: Any) -> str:
    document: dict[str, Any] = json.loads(start_document(RULE, 60.0).decode())
    document.update(changes)
    return json.dumps(document)


# #994-T03
def test_a_start_without_a_proxy_has_no_key_for_one_and_is_read_as_before() -> None:
    assert b"outerProxy" not in start_document(RULE, 60.0)
    assert parse_start(start_text()).outer_proxy is None


# #994-T01
def test_the_start_document_carries_the_proxy_and_the_door_reads_it() -> None:
    text = start_document(RULE, 60.0, PROXY).decode()

    assert json.loads(text)["outerProxy"] == {"host": "172.31.0.9", "port": 3128}
    assert parse_start(text).outer_proxy == PROXY


# #994-T04
@pytest.mark.parametrize(
    "bad", [None, "172.31.0.9:3128", {"host": "10.0.0.1", "port": 3128}, {"host": "172.31.0.9"}, {}]
)
def test_a_proxy_that_is_not_one_refuses_the_start(bad: Any) -> None:
    with pytest.raises(StartRefused):
        parse_start(start_text(outerProxy=bad))


# #994-T01
def test_the_door_process_chains_to_the_proxy_the_start_names(
    monkeypatch: pytest.MonkeyPatch, origin: Origin
) -> None:
    outer = OuterProxyStandIn({("api.example.com", 443): origin.port})
    chained: list[OuterProxy] = []

    def connector(proxy: OuterProxy) -> Callable[[str, int, float], socket.socket]:
        chained.append(proxy)
        return chained_connector(
            proxy, lambda _address, timeout: socket.create_connection(("127.0.0.1", outer.port))
        )

    monkeypatch.setattr(service, "chained_connector", connector)
    out = io.StringIO()
    stop = threading.Event()

    class Stdin(io.StringIO):
        def readline(self, limit: int = -1) -> str:  # the second read is the end of Control's pipe
            if self.tell() == 0:
                return super().readline(limit)
            stop.wait(10)
            return ""

    port = free_port()
    start = json.loads(start_document(RULE, 60.0, PROXY).decode())
    # The start's port is the door's address on the model network; the test binds its own.
    thread = threading.Thread(
        target=run_netdoor,
        args=(Stdin(json.dumps(start) + "\n"), out),
        kwargs={"bind": ("127.0.0.1", port), "poll_seconds": 0.02},
        daemon=True,
    )
    thread.start()
    try:
        for _ in range(100):
            if '"ready"' in out.getvalue():
                break
            threading.Event().wait(0.05)
        with socket.create_connection(("127.0.0.1", port), timeout=5) as sock:
            sock.sendall(b"CONNECT api.example.com:443 HTTP/1.1\r\n\r\n")
            assert sock.recv(100).startswith(b"HTTP/1.1 200")
    finally:
        stop.set()
        thread.join(5)
        outer.close()

    assert chained == [PROXY]
    assert outer.asked == ["CONNECT api.example.com:443"]


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


# -- the door's own firewall ---


# #994-T03
def test_without_a_proxy_the_rules_are_the_ones_they_were() -> None:
    assert egress_rules() == egress_rules(None, None)
    assert "dport { 80, 443 } accept" in egress_rules()
    assert rules_document("sha256:x", "door")["Cmd"] == [egress_rules()]


# #994-T04
def test_with_a_proxy_the_door_may_dial_that_address_and_port_and_nothing_else() -> None:
    rules = egress_rules(None, PROXY).split("; ")

    assert [rule for rule in rules if rule.endswith("accept")] == [
        'add rule ip netdoor_egress output oifname "lo" accept',
        "add rule ip netdoor_egress output ct state established,related accept",
        "add rule ip netdoor_egress output ip daddr 172.31.0.9 tcp dport 3128 accept",
    ]
    assert rules[-1] == "add rule ip netdoor_egress output drop"
    assert not any("dport 53" in r or "dport { 80, 443 }" in r for r in rules)
    assert rules_document("sha256:x", "door", None, PROXY)["Cmd"] == [egress_rules(None, PROXY)]


# #994-T04
def test_the_test_networks_seam_does_not_open_anything_next_to_the_proxy() -> None:
    rules = egress_rules("10.213.99.0/24", PROXY)

    assert "10.213.99.0/24" not in rules


# -- Control starts the door with the proxy ---


# #994-T01
def test_control_gives_the_rules_container_the_proxys_rules_and_the_door_the_proxy(
    rig: Any,  # noqa: F811
) -> None:
    from dataclasses import replace

    from code_reviewer_runner.implementer.netdoor_launcher import (
        NETDOOR_CONTAINER_NAME,
        RULES_CONTAINER_NAME,
    )

    rig.seams = replace(rig.seams, outer_proxy=PROXY)
    door = rig.start()

    assert rig.engine.container(RULES_CONTAINER_NAME).document["Cmd"] == [egress_rules(None, PROXY)]
    told = bytes(rig.engine.container(NETDOOR_CONTAINER_NAME).stdin_received)
    assert json.loads(told.splitlines()[0])["outerProxy"] == PROXY.to_json()
    door.stop()


# #994-T03
def test_control_without_a_proxy_starts_the_door_as_hosted(rig: Any) -> None:  # noqa: F811
    from code_reviewer_runner.implementer.netdoor_launcher import (
        NETDOOR_CONTAINER_NAME,
        RULES_CONTAINER_NAME,
    )

    door = rig.start()

    assert rig.engine.container(RULES_CONTAINER_NAME).document["Cmd"] == [egress_rules()]
    told = bytes(rig.engine.container(NETDOOR_CONTAINER_NAME).stdin_received)
    assert "outerProxy" not in json.loads(told.splitlines()[0])
    door.stop()
