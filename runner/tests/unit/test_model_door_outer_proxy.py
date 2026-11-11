# SPDX-License-Identifier: LicenseRef-Proprietary

"""The model door through the outer wall's proxy (#994): on a customer's machine its one way to the
provider is the host's proxy. What these tests hold: the upstream asks the proxy for the name and
resolves nothing itself, a refusal or a missing proxy is a call that never left, the door's own
firewall lets it dial that proxy and nothing else, and the door learns the proxy from Control's
start document (and refuses a wrong one)."""

import json
import re
import socket
import threading
from collections.abc import Iterator
from dataclasses import replace
from typing import Any

import pytest
from test_model_door_launcher import Rig, rig  # noqa: F401  # pyright: ignore[reportUnusedImport]

from code_reviewer_runner.dynamic_review.model_door_route import MODEL_NETWORK_SUBNET
from code_reviewer_runner.dynamic_review.passthrough.upstream import (
    HttpsUpstream,
    UpstreamError,
    UpstreamFailure,
    UpstreamRequest,
)
from code_reviewer_runner.implementer.door.protocol import REFUSED_START_INVALID, DoorRefused
from code_reviewer_runner.implementer.door.service import parse_start
from code_reviewer_runner.implementer.door_launcher import (
    DOOR_CONTAINER_NAME,
    EGRESS_RULES,
    RULES_CONTAINER_NAME,
    egress_rules,
    rules_document,
    start_document,
)
from code_reviewer_runner.outer_proxy import OuterProxy

PROXY = OuterProxy("172.31.0.5", 3128)
ANSWER = b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\nok"


class ProxyWire:
    """A socket pair standing in for the connection to the host's proxy: the far end reads the
    `CONNECT`, answers it, and (when it said 200) serves one request as the provider would."""

    def __init__(self, connect_answer: bytes) -> None:
        self.connect_answer = connect_answer
        self.dialled: list[tuple[str, int]] = []
        self.resolved: list[str] = []
        self.connect_heads: list[bytes] = []
        self.requests: list[bytes] = []
        self.hostnames: list[str] = []

    def resolve(self, host: str) -> list[str]:
        self.resolved.append(host)
        return ["93.184.216.34"]

    def connect(self, address: tuple[str, int], timeout: float) -> Any:
        self.dialled.append(address)
        client, server = socket.socketpair()
        threading.Thread(target=self._serve, args=(server,), daemon=True).start()
        return client

    def tls(self, raw: Any, hostname: str) -> Any:
        self.hostnames.append(hostname)
        return raw

    def _serve(self, server: socket.socket) -> None:
        with server:
            received = b""
            while b"\r\n\r\n" not in received:
                chunk = server.recv(65536)
                if not chunk:
                    return
                received += chunk
            self.connect_heads.append(received)
            server.sendall(self.connect_answer)
            if not self.connect_answer.startswith(b"HTTP/1.1 200"):
                return
            request = b""
            while b"\r\n\r\n" not in request:
                chunk = server.recv(65536)
                if not chunk:
                    return
                request += chunk
            head, _, rest = request.partition(b"\r\n\r\n")
            found = re.search(rb"(?i)content-length: *(\d+)", head)
            while found and len(rest) < int(found.group(1)):
                rest += server.recv(65536)
            self.requests.append(request)
            server.sendall(ANSWER)


def upstream(wire: ProxyWire, proxy: OuterProxy | None = PROXY) -> HttpsUpstream:
    return HttpsUpstream(
        "https://api.example.com/v1",
        resolve=wire.resolve,
        connect=wire.connect,
        tls=wire.tls,
        proxy=proxy,
    )


def send(wire: ProxyWire) -> bytes:
    response = upstream(wire).send(UpstreamRequest("/chat/completions", {"x-a": "b"}, b"{}"), 5)
    try:
        return response.read(100)
    finally:
        response.close()


CONNECTED = b"HTTP/1.1 200 Connection Established\r\n\r\n"


# #994-T01
def test_the_door_asks_the_proxy_for_the_name_and_resolves_and_dials_nothing_itself() -> None:
    wire = ProxyWire(CONNECTED)

    assert send(wire) == b"ok"

    assert wire.dialled == [("172.31.0.5", 3128)]
    assert wire.connect_heads == [
        b"CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n"
    ]
    assert wire.resolved == [], "a guest has no name server it can reach: the proxy looks up"
    # TLS is spoken to the name through the tunnel, certificate and name verified as ever.
    assert wire.hostnames == ["api.example.com"]
    assert wire.requests and wire.requests[0].startswith(b"POST /v1/chat/completions HTTP/1.1")


# #994-T04
@pytest.mark.parametrize(
    ("answer", "kind"),
    [
        (b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n", UpstreamFailure.ADDRESS_REFUSED),
        (b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n", UpstreamFailure.UNREACHABLE),
        (b"HTTP/1.1 503 Busy\r\nContent-Length: 0\r\n\r\n", UpstreamFailure.UNREACHABLE),
        (b"garbage\r\n\r\n", UpstreamFailure.UNREACHABLE),
    ],
)
def test_a_proxy_that_refuses_is_a_call_that_never_left_and_nothing_is_dialled_directly(
    answer: bytes, kind: UpstreamFailure
) -> None:
    wire = ProxyWire(answer)

    with pytest.raises(UpstreamError) as failed:
        send(wire)

    assert failed.value.kind is kind and failed.value.sent is False
    assert wire.dialled == [("172.31.0.5", 3128)], "no second try at the provider's own address"
    assert wire.requests == [], "the request, which holds the key, was never sent"
    assert wire.hostnames == [], "and no TLS was spoken"


# #994-T04
def test_a_proxy_that_cannot_be_reached_is_a_call_that_never_left() -> None:
    dialled: list[tuple[str, int]] = []

    def connect(address: tuple[str, int], timeout: float) -> Any:
        dialled.append(address)
        raise ConnectionRefusedError

    with pytest.raises(UpstreamError) as failed:
        HttpsUpstream(
            "https://api.example.com/v1",
            resolve=lambda _host: ["93.184.216.34"],
            connect=connect,
            proxy=PROXY,
        ).send(UpstreamRequest("/x", {}, b"{}"), 2)

    assert failed.value.kind is UpstreamFailure.UNREACHABLE and failed.value.sent is False
    assert dialled == [("172.31.0.5", 3128)]


# #994-T03
def test_without_a_proxy_the_upstream_resolves_and_dials_the_address_it_checked_as_before() -> None:
    wire = ProxyWire(ANSWER)
    seen: list[tuple[str, int]] = []

    def connect(address: tuple[str, int], timeout: float) -> Any:
        seen.append(address)
        return wire.connect(address, timeout)

    response = HttpsUpstream(
        "https://api.example.com/v1",
        resolve=wire.resolve,
        connect=connect,
        tls=wire.tls,
    ).send(UpstreamRequest("/x", {}, b"{}"), 5)
    response.close()

    assert wire.resolved == ["api.example.com"]
    assert seen == [("93.184.216.34", 443)]


# -- the door's own firewall ---


# #994-T03
def test_without_a_proxy_the_rules_are_the_hosted_ones_to_the_byte() -> None:
    assert egress_rules(None) == EGRESS_RULES
    assert rules_document("sha256:x", "door")["Cmd"] == [EGRESS_RULES]


# #994-T04
def test_with_a_proxy_the_door_may_dial_that_address_and_port_and_nothing_else() -> None:
    rules = egress_rules(PROXY).split("; ")

    accepts = [rule for rule in rules if rule.endswith("accept")]
    assert accepts == [
        'add rule ip door_egress output oifname "lo" accept',
        "add rule ip door_egress output ct state established,related accept",
        "add rule ip door_egress output ip daddr 172.31.0.5 tcp dport 3128 accept",
    ]
    assert rules[-1] == "add rule ip door_egress output drop"
    # No DNS, no port 443 of the internet: the proxy resolves and dials.
    assert not any("dport 53" in rule or "dport 443" in rule for rule in rules)
    # The model network stays shut, and the proxy's address is let through before the last drop.
    shut = next(i for i, r in enumerate(rules) if MODEL_NETWORK_SUBNET in r and r.endswith("drop"))
    proxy = next(i for i, r in enumerate(rules) if "172.31.0.5" in r)
    assert shut < proxy < len(rules) - 1
    assert "ip6" not in "; ".join(rules)


def test_the_rules_container_installs_the_rules_of_the_proxy_it_was_given() -> None:
    assert rules_document("sha256:x", "door", PROXY)["Cmd"] == [egress_rules(PROXY)]


# -- the start document ---


def document(**changes: Any) -> str:
    base: dict[str, Any] = json.loads(
        start_document(
            model_access={"llm": {}},
            capability="c" * 40,
            deadline_seconds=60.0,
            port=10180,
            environment={},
        )
    )
    base.update(changes)
    return json.dumps(base)


# #994-T03
def test_a_start_without_a_proxy_has_no_key_for_one_and_is_read_as_before() -> None:
    plain = start_document(
        model_access={}, capability="c" * 40, deadline_seconds=60.0, port=10180, environment={}
    )

    assert b"outerProxy" not in plain
    assert parse_start(plain.decode()).outer_proxy is None


# #994-T01
def test_the_start_document_carries_the_proxy_and_the_door_reads_it() -> None:
    text = start_document(
        model_access={},
        capability="c" * 40,
        deadline_seconds=60.0,
        port=10180,
        environment={},
        outer_proxy=PROXY,
    )

    assert json.loads(text)["outerProxy"] == {"host": "172.31.0.5", "port": 3128}
    assert parse_start(text.decode()).outer_proxy == PROXY


# #994-T04
@pytest.mark.parametrize(
    "bad",
    [None, "172.31.0.5:3128", {"host": "10.0.0.1", "port": 3128}, {"host": "172.31.0.5"}, {}],
)
def test_a_proxy_that_is_not_one_refuses_the_start(bad: Any) -> None:
    with pytest.raises(DoorRefused) as refused:
        parse_start(document(outerProxy=bad))

    assert refused.value.reason == REFUSED_START_INVALID


# #994-T04
def test_an_unknown_key_still_refuses_the_start() -> None:
    with pytest.raises(DoorRefused):
        parse_start(document(somethingElse=1))


# -- Control starts the door with the proxy ---


@pytest.fixture
def proxied(rig: Rig) -> Iterator[Rig]:  # noqa: F811
    rig.seams = replace(rig.seams, outer_proxy=PROXY)
    yield rig


# #994-T01
def test_control_gives_the_rules_container_the_proxys_rules_and_the_door_the_proxy(
    proxied: Rig,
) -> None:
    door = proxied.start()

    helper = proxied.engine.container(RULES_CONTAINER_NAME)
    assert helper.document["Cmd"] == [egress_rules(PROXY)]
    told = bytes(proxied.engine.container(DOOR_CONTAINER_NAME).stdin_received)
    assert json.loads(told.splitlines()[0])["outerProxy"] == PROXY.to_json()
    door.stop()


# #994-T03
def test_control_without_a_proxy_starts_the_door_as_hosted(rig: Rig) -> None:  # noqa: F811
    door = rig.start()

    assert rig.engine.container(RULES_CONTAINER_NAME).document["Cmd"] == [EGRESS_RULES]
    told = bytes(rig.engine.container(DOOR_CONTAINER_NAME).stdin_received)
    assert "outerProxy" not in json.loads(told.splitlines()[0])
    door.stop()
