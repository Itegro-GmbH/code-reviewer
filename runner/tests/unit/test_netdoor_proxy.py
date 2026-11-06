# SPDX-License-Identifier: LicenseRef-Proprietary

"""The network door's proxy (#745, step 7) on a real loopback socket: what each kind of request is
answered, which address the door connects to and when it looks a name up, and what the log says.

The names resolve through a table and the connections go to loopback servers (`netdoor_support`),
so the questions are the door's own: the rule, the refusals that hold in every mode (an address, a
port, a private resolution), the connection to the address that was checked, and no look-up of a
name the rule does not list."""

import socket
import threading
import time
from collections.abc import Iterator

import pytest
from netdoor_support import OTHER_PUBLIC, PUBLIC, Lookups, Origin, start_proxy, status_of, talk

from code_reviewer_runner.implementer.network_rule import MODE_LIST, MODE_OPEN, NetworkRule

pytestmark = pytest.mark.integration

LIST = NetworkRule(MODE_LIST, ("registry.npmjs.org", "*.pythonhosted.org", "xn--bcher-kva.example"))
OPEN = NetworkRule(MODE_OPEN)


@pytest.fixture
def origin() -> Iterator[Origin]:
    server = Origin()
    yield server
    server.close()


def lookups_for(origin: Origin, *names: str, address: str = PUBLIC) -> Lookups:
    lookups = Lookups()
    for name in names:
        lookups.table[name] = [address]
    lookups.servers[address] = origin.port
    return lookups


def connect_request(target: str) -> bytes:
    return f"CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n".encode()


def refusal_reason(answer: bytes) -> str:
    for line in answer.split(b"\r\n"):
        if line.lower().startswith(b"x-network-door:"):
            return line.split(b":", 1)[1].strip().decode()
    return ""


def test_a_listed_host_is_tunnelled_and_the_bytes_are_counted(origin: Origin) -> None:
    lookups = lookups_for(origin, "registry.npmjs.org")
    running = start_proxy(LIST, lookups)
    try:
        answer = talk(
            running.port,
            connect_request("registry.npmjs.org:443"),
            send_more=lambda client: client.sendall(b"GET / HTTP/1.1\r\n\r\n"),
        )
    finally:
        running.stop()
    assert answer.startswith(b"HTTP/1.1 200 Connection Established\r\n\r\n")
    assert answer.endswith(b"ok"), "the origin's answer travelled back through the tunnel"
    assert origin.received == [b"GET / HTTP/1.1\r\n\r\n"]
    assert lookups.connected == [(PUBLIC, 443)], "the door connects to the address it checked"
    snapshot = running.log.snapshot()
    assert snapshot["allowed"] == 1 and snapshot["refused"] == 0
    [entry] = snapshot["connections"]
    assert (entry["host"], entry["port"], entry["outcome"], entry["reason"]) == (
        "registry.npmjs.org",
        443,
        "allowed",
        None,
    )
    assert entry["bytesOut"] == len(b"GET / HTTP/1.1\r\n\r\n")
    assert entry["bytesIn"] == len(origin.reply)


def test_a_host_the_list_does_not_name_is_refused_and_never_looked_up(origin: Origin) -> None:
    lookups = lookups_for(origin, "example.com")
    running = start_proxy(LIST, lookups)
    try:
        answer = talk(running.port, connect_request("example.com:443"))
    finally:
        running.stop()
    assert status_of(answer) == 403 and refusal_reason(answer) == "not_listed"
    assert b"network door:" in answer, "the person reading a failed install is told why"
    assert lookups.looked_up == [] and lookups.connected == [], "no DNS for a name that is refused"
    assert running.log.snapshot()["refused"] == 1


@pytest.mark.parametrize(
    "target",
    [
        "127.0.0.1:443",
        "8.8.8.8:443",
        "[::1]:443",
        "[2001:db8::1]:443",
        "2130706433:443",
        "0x7f.1:80",
        "169.254.169.254:80",
    ],
)
def test_an_ip_address_is_refused_in_every_mode(origin: Origin, target: str) -> None:
    for rule in (LIST, OPEN):
        lookups = lookups_for(origin, "registry.npmjs.org")
        running = start_proxy(rule, lookups)
        try:
            answer = talk(running.port, connect_request(target))
        finally:
            running.stop()
        assert status_of(answer) == 403 and refusal_reason(answer) == "ip_literal"
        assert lookups.looked_up == [] and lookups.connected == []


@pytest.mark.parametrize("port", [22, 25, 8080, 8443, 3306, 5432, 1, 65535, 0])
def test_a_port_other_than_80_and_443_is_refused_in_every_mode(origin: Origin, port: int) -> None:
    for rule in (LIST, OPEN):
        lookups = lookups_for(origin, "registry.npmjs.org")
        running = start_proxy(rule, lookups)
        try:
            answer = talk(running.port, connect_request(f"registry.npmjs.org:{port}"))
        finally:
            running.stop()
        assert status_of(answer) == 403 and refusal_reason(answer) == "port_not_allowed"
        assert lookups.connected == []


def test_a_name_that_resolves_to_a_private_address_is_refused_even_when_listed(
    origin: Origin,
) -> None:
    for private in (
        "10.0.0.5",
        "172.17.0.1",
        "192.168.1.1",
        "127.0.0.1",
        "169.254.169.254",
        "100.64.0.9",
        "10.213.77.4",
    ):
        lookups = lookups_for(origin, "registry.npmjs.org", address=private)
        running = start_proxy(LIST, lookups)
        try:
            answer = talk(running.port, connect_request("registry.npmjs.org:443"))
        finally:
            running.stop()
        assert status_of(answer) == 403 and refusal_reason(answer) == "private_address", private
        assert lookups.connected == [], "nothing was connected to"


def test_a_name_that_resolves_to_a_public_and_a_private_address_is_refused(
    origin: Origin,
) -> None:
    for order in ([PUBLIC, "10.0.0.5"], ["10.0.0.5", PUBLIC], [PUBLIC, "169.254.169.254"]):
        lookups = Lookups(table={"registry.npmjs.org": order}, servers={PUBLIC: origin.port})
        running = start_proxy(LIST, lookups)
        try:
            answer = talk(running.port, connect_request("registry.npmjs.org:443"))
        finally:
            running.stop()
        assert refusal_reason(answer) == "private_address", order
        assert lookups.connected == [], "not even the public one is tried"


def test_a_name_that_changes_its_answer_is_looked_up_once_and_the_checked_address_is_used(
    origin: Origin,
) -> None:
    """DNS rebinding: the second answer is a private address. The door asks once and connects to the
    first, so the second answer is never given a chance."""
    lookups = lookups_for(origin, "registry.npmjs.org")
    lookups.second_answer["registry.npmjs.org"] = ["127.0.0.1"]
    running = start_proxy(LIST, lookups)
    try:
        answer = talk(running.port, connect_request("registry.npmjs.org:443"))
    finally:
        running.stop()
    assert status_of(answer) == 200
    assert lookups.looked_up == ["registry.npmjs.org"]
    assert lookups.connected == [(PUBLIC, 443)]


def test_a_name_that_does_not_resolve_is_refused() -> None:
    running = start_proxy(LIST, Lookups())
    try:
        answer = talk(running.port, connect_request("registry.npmjs.org:443"))
    finally:
        running.stop()
    assert status_of(answer) == 403 and refusal_reason(answer) == "unresolvable"


def test_an_address_that_cannot_be_connected_to_is_a_bad_gateway(origin: Origin) -> None:
    lookups = Lookups(table={"registry.npmjs.org": [PUBLIC, OTHER_PUBLIC]})
    running = start_proxy(LIST, lookups)
    try:
        answer = talk(running.port, connect_request("registry.npmjs.org:443"))
    finally:
        running.stop()
    assert status_of(answer) == 502 and refusal_reason(answer) == "upstream_failed"
    assert lookups.connected == [(PUBLIC, 443), (OTHER_PUBLIC, 443)], "each address, in order"


def test_the_next_address_is_tried_when_the_first_does_not_answer(origin: Origin) -> None:
    lookups = Lookups(
        table={"registry.npmjs.org": [PUBLIC, OTHER_PUBLIC]}, servers={OTHER_PUBLIC: origin.port}
    )
    running = start_proxy(LIST, lookups)
    try:
        answer = talk(running.port, connect_request("registry.npmjs.org:443"))
    finally:
        running.stop()
    assert status_of(answer) == 200
    assert lookups.connected == [(PUBLIC, 443), (OTHER_PUBLIC, 443)]


def test_case_a_trailing_dot_and_idn_do_not_get_round_the_list(origin: Origin) -> None:
    lookups = lookups_for(
        origin, "registry.npmjs.org", "xn--bcher-kva.example", "files.pythonhosted.org"
    )
    running = start_proxy(LIST, lookups)
    try:
        for target in (
            "REGISTRY.NPMJS.ORG:443",
            "registry.npmjs.org.:443",
            "XN--BCHER-KVA.Example:443",
            "Files.PythonHosted.Org.:443",
        ):
            assert status_of(talk(running.port, connect_request(target))) == 200, target
        # The apex of a suffix entry is its own name, and a lookalike is not the name.
        for target in (
            "pythonhosted.org:443",
            "registry.npmjs.org.evil.com:443",
            "xregistry.npmjs.org:443",
        ):
            assert refusal_reason(talk(running.port, connect_request(target))) == "not_listed", (
                target
            )
    finally:
        running.stop()


def test_open_lets_any_public_name_through_and_still_refuses_a_private_one(origin: Origin) -> None:
    lookups = lookups_for(origin, "anything.example")
    lookups.table["internal.corp.example"] = ["10.1.2.3"]
    running = start_proxy(OPEN, lookups)
    try:
        assert status_of(talk(running.port, connect_request("anything.example:443"))) == 200
        denied = talk(running.port, connect_request("internal.corp.example:443"))
    finally:
        running.stop()
    assert refusal_reason(denied) == "private_address"


# -- plain HTTP ----------------------------------------------------------------------------------


def get(target: str, *headers: str) -> bytes:
    lines = [f"GET {target} HTTP/1.1", *headers, "", ""]
    return "\r\n".join(lines).encode()


def test_a_plain_http_request_is_forwarded_in_origin_form_with_its_host_set(origin: Origin) -> None:
    lookups = lookups_for(origin, "registry.npmjs.org")
    running = start_proxy(LIST, lookups)
    try:
        answer = talk(
            running.port,
            get(
                "http://Registry.NPMJS.org/pkg/left-pad?x=1",
                "Host: example.com",
                "Proxy-Authorization: Basic c2VjcmV0",
                "Proxy-Connection: keep-alive",
                "Connection: keep-alive",
                "Upgrade: websocket",
                "Accept: application/json",
            ),
        )
    finally:
        running.stop()
    assert status_of(answer) == 200 and answer.endswith(b"ok")
    [received] = origin.received
    lines = received.decode().split("\r\n")
    assert lines[0] == "GET /pkg/left-pad?x=1 HTTP/1.1"
    assert "Host: registry.npmjs.org" in lines, (
        "the host the decision was made on, not the header's"
    )
    assert "Connection: close" in lines and "Accept: application/json" in lines
    lowered = [line.lower() for line in lines]
    assert not any(line.startswith(("proxy-", "upgrade", "example")) for line in lowered)
    assert lookups.connected == [(PUBLIC, 80)]
    [entry] = running.log.snapshot()["connections"]
    assert entry["port"] == 80 and entry["outcome"] == "allowed"


def test_a_plain_http_request_to_an_unlisted_host_a_port_or_an_address_is_refused(
    origin: Origin,
) -> None:
    lookups = lookups_for(origin, "registry.npmjs.org", "example.com")
    running = start_proxy(LIST, lookups)
    try:
        assert refusal_reason(talk(running.port, get("http://example.com/"))) == "not_listed"
        assert (
            refusal_reason(talk(running.port, get("http://registry.npmjs.org:8080/")))
            == "port_not_allowed"
        )
        assert refusal_reason(talk(running.port, get("http://127.0.0.1/"))) == "ip_literal"
        assert refusal_reason(talk(running.port, get("http://[::1]:80/"))) == "ip_literal"
    finally:
        running.stop()
    assert origin.received == [] and lookups.connected == []


# The port a plain request names is the port of the decision: 80 by default, 443 as for a tunnel
# (it reaches a TLS port and gets nothing useful, but it is not a way past the rule), and every
# other port is refused.
def test_a_plain_http_request_names_its_port_and_443_is_decided_like_a_tunnel_to_it(
    origin: Origin,
) -> None:
    lookups = lookups_for(origin, "registry.npmjs.org")
    running = start_proxy(LIST, lookups)
    try:
        answer = talk(running.port, get("http://registry.npmjs.org:443/x"))
    finally:
        running.stop()
    assert status_of(answer) == 200
    assert lookups.connected == [(PUBLIC, 443)]
    [received] = origin.received
    assert "Host: registry.npmjs.org:443" in received.decode().split("\r\n")
    [entry] = running.log.snapshot()["connections"]
    assert entry["port"] == 443 and entry["outcome"] == "allowed"


@pytest.mark.parametrize(
    "method",
    ["GE T", "G\x01ET", "GET\x7f", "G(ET)", "GE@T", "G/ET", 'G"ET', "GET,", "G\\ET", "{GET}"],
)
def test_a_method_that_is_not_an_http_token_is_a_bad_request_and_goes_nowhere(
    origin: Origin, method: str
) -> None:
    lookups = lookups_for(origin, "registry.npmjs.org")
    running = start_proxy(LIST, lookups)
    try:
        # A space in the method makes the line four parts; the others are one part, not a token.
        answer = talk(
            running.port, f"{method} http://registry.npmjs.org/ HTTP/1.1\r\n\r\n".encode()
        )
    finally:
        running.stop()
    assert status_of(answer) == 400 and refusal_reason(answer) == "bad_request"
    assert lookups.connected == [] and origin.received == []


@pytest.mark.parametrize("method", ["GET", "POST", "M-SEARCH", "PROPFIND", "X.Y_z~1", "PATCH"])
def test_any_method_that_is_a_token_is_forwarded_as_it_was_sent(
    origin: Origin, method: str
) -> None:
    lookups = lookups_for(origin, "registry.npmjs.org")
    running = start_proxy(LIST, lookups)
    try:
        answer = talk(
            running.port, f"{method} http://registry.npmjs.org/p HTTP/1.1\r\n\r\n".encode()
        )
    finally:
        running.stop()
    assert status_of(answer) == 200
    assert origin.received[0].decode().startswith(f"{method} /p HTTP/1.1\r\n")


@pytest.mark.parametrize(
    "request_bytes",
    [
        get("/just/a/path"),
        get("https://registry.npmjs.org/"),
        get("http://user:pass@registry.npmjs.org/"),
        get("http://registry.npmjs.org@evil.com/"),
        get("http://registry.npmjs.org\\@evil.com/"),
        get("ftp://registry.npmjs.org/"),
        get("http:///path"),
        b"NOT A REQUEST\r\n\r\n",
        b"GET http://registry.npmjs.org/ HTTP/2.0\r\n\r\n",
        b"GET http://registry.npmjs.org/ \r\n\r\n",
        b"CONNECT registry.npmjs.org HTTP/1.1\r\n\r\n",
        b"CONNECT registry.npmjs.org:443/path HTTP/1.1\r\n\r\n",
        b"CONNECT user@registry.npmjs.org:443 HTTP/1.1\r\n\r\n",
        b"CONNECT :443 HTTP/1.1\r\n\r\n",
        b"CONNECT registry.npmjs.org:99999 HTTP/1.1\r\n\r\n",
        b"GET http://registry.npmjs.org/ HTTP/1.1\r\nbad header\r\n\r\n",
    ],
)
def test_a_request_this_proxy_does_not_serve_is_a_bad_request(
    origin: Origin, request_bytes: bytes
) -> None:
    lookups = lookups_for(origin, "registry.npmjs.org")
    running = start_proxy(LIST, lookups)
    try:
        answer = talk(running.port, request_bytes)
    finally:
        running.stop()
    assert status_of(answer) == 400, answer
    assert lookups.connected == [] and origin.received == []


def test_a_head_that_never_ends_is_answered_with_a_bad_request() -> None:
    running = start_proxy(LIST, Lookups())
    try:
        answer = talk(
            running.port, b"GET http://registry.npmjs.org/ HTTP/1.1\r\n" + b"X: y\r\n" * 4000
        )
    finally:
        running.stop()
    assert status_of(answer) == 400


# -- the limits and the log ----------------------------------------------------------------------


def test_connections_over_the_limit_get_a_service_unavailable(origin: Origin) -> None:
    lookups = lookups_for(origin, "registry.npmjs.org")
    running = start_proxy(LIST, lookups, max_connections=1)
    first = socket.create_connection(("127.0.0.1", running.port), timeout=10)
    try:
        first.sendall(b"CONNECT registry.npmjs.org:443 HTTP/1.1\r\n\r\n")
        # The first tunnel is open and idle: it holds the one slot.
        assert first.recv(100).startswith(b"HTTP/1.1 200")
        answer = talk(running.port, connect_request("registry.npmjs.org:443"))
    finally:
        first.close()
        running.stop()
    assert status_of(answer) == 503 and refusal_reason(answer) == "too_many_connections"


def test_the_log_keeps_the_host_the_agent_wrote_as_printable_text_only(origin: Origin) -> None:
    running = start_proxy(LIST, lookups_for(origin, "registry.npmjs.org"))
    try:
        talk(running.port, b"CONNECT ex\x01ample\x7f.com:443 HTTP/1.1\r\n\r\n")
        talk(running.port, connect_request("a" * 400 + ".example:443"))
    finally:
        running.stop()
    for entry in running.log.snapshot()["connections"]:
        assert len(entry["host"]) <= 253
        assert all(0x20 < ord(c) < 0x7F for c in entry["host"])


def test_many_connections_to_many_hosts_keep_the_report_short(origin: Origin) -> None:
    from code_reviewer_runner.implementer.netdoor.connections import (
        MAX_KEYS,
        REPORT_ENTRIES,
        ConnectionLog,
    )

    log = ConnectionLog()
    for index in range(MAX_KEYS + 500):
        log.add(f"h{index}.example", 443, "refused", "not_listed")
    snapshot = log.snapshot()
    assert snapshot["refused"] == MAX_KEYS + 500
    assert len(snapshot["connections"]) == REPORT_ENTRIES
    assert snapshot["dropped"] == MAX_KEYS + 500 - REPORT_ENTRIES


def test_refusals_come_first_in_the_report_then_the_most_bytes() -> None:
    from code_reviewer_runner.implementer.netdoor.connections import ConnectionLog

    log = ConnectionLog()
    log.add("small.example", 443, "allowed", None, bytes_in=10)
    log.add("big.example", 443, "allowed", None, bytes_in=10_000)
    log.add("bad.example", 443, "refused", "not_listed")
    hosts = [entry["host"] for entry in log.snapshot()["connections"]]
    assert hosts == ["bad.example", "big.example", "small.example"]


def test_a_tunnel_in_use_ends_when_the_proxy_stops(origin: Origin) -> None:
    origin.reply = b""
    running = start_proxy(LIST, lookups_for(origin, "registry.npmjs.org"))
    client = socket.create_connection(("127.0.0.1", running.port), timeout=10)
    try:
        client.sendall(connect_request("registry.npmjs.org:443"))
        assert client.recv(100).startswith(b"HTTP/1.1 200")
        started = threading.Event()
        started.set()
        deadline = time.monotonic() + 5
        client.shutdown(socket.SHUT_WR)
        data = b"x"
        while data and time.monotonic() < deadline:
            data = client.recv(100)
        assert data == b"", "the door closed the tunnel after the origin did"
    finally:
        client.close()
        running.stop()


# #856-P02
def test_a_rule_that_allows_443_only_tunnels_to_443_and_refuses_80_in_both_forms(
    origin: Origin,
) -> None:
    rule = NetworkRule(MODE_LIST, ("registry.npmjs.org",), ports=(443,))
    lookups = lookups_for(origin, "registry.npmjs.org")
    running = start_proxy(rule, lookups)
    try:
        allowed = talk(running.port, connect_request("registry.npmjs.org:443"))
        tunnel = talk(running.port, connect_request("registry.npmjs.org:80"))
        plain = talk(running.port, get("http://registry.npmjs.org/x"))
    finally:
        running.stop()

    assert status_of(allowed) == 200
    assert status_of(tunnel) == 403 and refusal_reason(tunnel) == "port_not_allowed"
    assert status_of(plain) == 403 and refusal_reason(plain) == "port_not_allowed"
    assert lookups.connected == [(PUBLIC, 443)], "port 80 was never dialled"


# #856-P02
def test_a_rule_without_ports_still_allows_80_and_443(origin: Origin) -> None:
    lookups = lookups_for(origin, "registry.npmjs.org")
    running = start_proxy(LIST, lookups)
    try:
        answers = [
            talk(running.port, connect_request(f"registry.npmjs.org:{port}")) for port in (80, 443)
        ]
    finally:
        running.stop()

    assert [status_of(answer) for answer in answers] == [200, 200]
