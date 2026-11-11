# SPDX-License-Identifier: LicenseRef-Proprietary

"""The outer-wall proxy as the software in a local VM sees it (#994): the address the host gives,
what is refused, and the tunnel a chained client opens. The proxy here is a loopback stand-in (the
real one is `test_firecracker_proxy_wall.py`); the VM's own address is reached through the
`connect` seam."""

import socket
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager

import pytest

from code_reviewer_runner.outer_proxy import (
    OUTER_PROXY_VARIABLE,
    OuterProxy,
    OuterProxyError,
    TunnelRefused,
    open_tunnel,
    outer_proxy_of,
)

PROXY = OuterProxy("172.31.0.1", 3128)


@contextmanager
def stand_in(answer: bytes, seen: list[bytes] | None = None) -> Iterator[tuple[str, int]]:
    """A loopback proxy that reads the request head and sends `answer`, then waits for the client."""
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(4)

    def serve() -> None:
        try:
            connection, _ = listener.accept()
        except OSError:
            return
        with connection:
            data = b""
            while b"\r\n\r\n" not in data:
                chunk = connection.recv(4096)
                if not chunk:
                    return
                data += chunk
            if seen is not None:
                seen.append(data)
            connection.sendall(answer)
            connection.settimeout(2)
            try:
                connection.recv(1)
            except OSError:
                pass

    threading.Thread(target=serve, daemon=True).start()
    try:
        yield listener.getsockname()
    finally:
        listener.close()


def loopback(target: tuple[str, int]) -> Callable[[tuple[str, int], float], socket.socket]:
    def connect(address: tuple[str, int], timeout: float) -> socket.socket:
        assert address == (PROXY.host, PROXY.port)
        return socket.create_connection(target, timeout=timeout)

    return connect


# #994-T04
@pytest.mark.parametrize(
    "host",
    [
        "10.0.0.1",
        "172.30.0.1",
        "172.32.0.1",
        "127.0.0.1",
        "169.254.169.254",
        "example.com",
        "",
        "::1",
    ],
)
def test_a_proxy_outside_the_slots_network_is_not_one(host: str) -> None:
    with pytest.raises(OuterProxyError):
        OuterProxy(host, 3128)


# #994-T04
@pytest.mark.parametrize("port", [0, -1, 65536, True])
def test_a_port_that_is_not_a_port_is_refused(port: int) -> None:
    with pytest.raises(OuterProxyError):
        OuterProxy("172.31.0.1", port)


# #994-T04
@pytest.mark.parametrize(
    "document",
    [
        None,
        "172.31.0.1:3128",
        {"host": "172.31.0.1"},
        {"host": "172.31.0.1", "port": 3128, "extra": 1},
        {"host": 1, "port": 3128},
        {"host": "172.31.0.1", "port": "3128"},
        {"host": "172.31.0.1", "port": True},
        {"host": "172.031.0.1", "port": 3128},
    ],
)
def test_a_document_that_is_not_host_and_port_is_refused(document: object) -> None:
    with pytest.raises(OuterProxyError):
        OuterProxy.from_json(document)


def test_the_proxy_round_trips_through_its_json_and_its_variable() -> None:
    assert OuterProxy.from_json(PROXY.to_json()) == PROXY
    assert outer_proxy_of({OUTER_PROXY_VARIABLE: PROXY.address}) == PROXY
    assert PROXY.url == "http://172.31.0.1:3128"


# #994-T03
def test_a_process_with_no_variable_has_no_proxy_and_dials_as_hosted() -> None:
    assert outer_proxy_of({}) is None
    assert outer_proxy_of({"HTTPS_PROXY": "http://172.31.0.1:3128"}) is None


# #994-T04
@pytest.mark.parametrize(
    "value", ["", "172.31.0.1", "172.31.0.1:", "172.31.0.1:x", "10.0.0.1:3128"]
)
def test_a_variable_that_is_set_and_wrong_is_an_error_not_a_direct_connection(value: str) -> None:
    with pytest.raises(OuterProxyError):
        outer_proxy_of({OUTER_PROXY_VARIABLE: value})


def test_the_tools_of_a_container_get_both_spellings_and_loopback_is_not_proxied() -> None:
    entries = dict(entry.split("=", 1) for entry in PROXY.tool_environment())

    assert {name for name in entries if "proxy" in name.lower() and "no_" not in name.lower()} == {
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "http_proxy",
        "https_proxy",
    }
    assert {value for name, value in entries.items() if name.lower() != "no_proxy"} == {PROXY.url}
    assert entries["NO_PROXY"] == entries["no_proxy"] == "localhost,127.0.0.1,::1"


def test_a_tunnel_asks_the_proxy_for_the_name_and_returns_the_open_socket() -> None:
    seen: list[bytes] = []
    with stand_in(b"HTTP/1.1 200 Connection Established\r\n\r\n", seen) as target:
        tunnel = open_tunnel(PROXY, "api.example.com", 443, 5, connect=loopback(target))
        tunnel.close()

    assert seen == [b"CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n"]


# #994-T04
@pytest.mark.parametrize("status", [400, 403, 502, 503])
def test_a_proxy_that_refuses_gives_no_tunnel_and_the_caller_never_dials_itself(
    status: int,
) -> None:
    with stand_in(f"HTTP/1.1 {status} No\r\nContent-Length: 0\r\n\r\n".encode()) as target:
        with pytest.raises(TunnelRefused) as refused:
            open_tunnel(PROXY, "example.com", 443, 5, connect=loopback(target))

    assert refused.value.status == status


# #994-T04
@pytest.mark.parametrize(
    "answer",
    [
        b"garbage\r\n\r\n",
        b"HTTP/1.1 200 OK\r\n\r\nthe origin spoke first",
        b"HTTP/1.1 2000 OK\r\n\r\n",
        b"",
    ],
)
def test_an_answer_that_is_not_a_clean_200_is_a_refusal(answer: bytes) -> None:
    with stand_in(answer) as target:
        with pytest.raises((TunnelRefused, OSError)):
            open_tunnel(PROXY, "example.com", 443, 5, connect=loopback(target))


# #994-T04
def test_a_proxy_that_does_not_answer_ends_in_a_timeout() -> None:
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    try:
        with pytest.raises(TimeoutError):
            open_tunnel(PROXY, "example.com", 443, 0.3, connect=loopback(listener.getsockname()))
    finally:
        listener.close()


# #994-T04
def test_a_proxy_that_cannot_be_reached_is_an_error_and_not_a_direct_connection() -> None:
    attempts: list[tuple[str, int]] = []

    def connect(address: tuple[str, int], timeout: float) -> socket.socket:
        attempts.append(address)
        raise ConnectionRefusedError

    with pytest.raises(OSError):
        open_tunnel(PROXY, "example.com", 443, 1, connect=connect)

    assert attempts == [(PROXY.host, PROXY.port)]


@pytest.mark.parametrize(
    "host", ["", "Example.com", "a b.com", "a.com\r\nX: 1", "exa mple", "-a.com", "a.com-", "é.com"]
)
def test_a_name_that_could_add_a_header_line_is_refused_before_anything_is_sent(host: str) -> None:
    def connect(address: tuple[str, int], timeout: float) -> socket.socket:
        raise AssertionError("nothing may be dialled")

    with pytest.raises(ValueError):
        open_tunnel(PROXY, host, 443, 1, connect=connect)
