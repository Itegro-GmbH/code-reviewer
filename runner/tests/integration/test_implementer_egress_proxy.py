# SPDX-License-Identifier: LicenseRef-Proprietary

"""The Implementer agent's egress proxy on real loopback sockets (#763).

No name is resolved and no address outside loopback is touched: the resolver is a table and the
connector maps the (public looking) address the proxy judged to a local server, so what is proven
is the proxy's decision and its relay, not the network. The TLS server stands in for a registry.
"""

import contextlib
import datetime
import errno
import logging
import socket
import ssl
import threading
import time
from collections.abc import Callable, Generator
from contextlib import contextmanager
from pathlib import Path

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from code_reviewer_runner.implementer.egress_policy import DEFAULT_ALLOWLIST, EgressAllowlist
from code_reviewer_runner.implementer.egress_proxy import EgressLimits, EgressProxy

_THREAD = threading.Thread

PUBLIC = "151.101.0.1"
REGISTRY = "registry.npmjs.org"
RESOLVED = {
    REGISTRY: [PUBLIC],
    "files.pythonhosted.org": [PUBLIC],
    "pypi.org": [PUBLIC],
    "rebinding.pkg.test": ["10.0.0.7"],
}


class Resolver:
    """A name table that records what was asked."""

    def __init__(self, table: dict[str, list[str]] | None = None) -> None:
        self.table = dict(RESOLVED if table is None else table)
        self.asked: list[str] = []

    def __call__(self, host: str) -> list[str]:
        self.asked.append(host)
        if host not in self.table:
            raise OSError("no such name")
        return list(self.table[host])


class Backend:
    """Where every tunnel ends: the connector maps the judged public address to this server."""

    def __init__(self, handler: Callable[[socket.socket], None]) -> None:
        self.listener = socket.socket()
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(16)
        self.port = int(self.listener.getsockname()[1])
        self.dialled: list[tuple[str, int]] = []
        self._handler = handler
        self._threads: list[threading.Thread] = []
        self._thread = threading.Thread(target=self._accept, daemon=True)
        self._thread.start()

    def _accept(self) -> None:
        while True:
            try:
                client, _ = self.listener.accept()
            except OSError:
                return
            thread = threading.Thread(target=self._serve, args=(client,), daemon=True)
            thread.start()
            self._threads.append(thread)

    def _serve(self, client: socket.socket) -> None:
        with client, contextlib.suppress(OSError):
            self._handler(client)

    def connect(self, address: tuple[str, int], timeout: float) -> socket.socket:
        self.dialled.append(address)
        return socket.create_connection(("127.0.0.1", self.port), timeout=timeout)

    def close(self) -> None:
        self.listener.close()


def echo(client: socket.socket) -> None:
    while data := client.recv(65536):
        client.sendall(data)


def silent(client: socket.socket) -> None:
    client.settimeout(30)
    with contextlib.suppress(OSError):
        client.recv(1)


@contextmanager
def backend(handler: Callable[[socket.socket], None] = echo) -> Generator[Backend]:
    server = Backend(handler)
    try:
        yield server
    finally:
        server.close()


@contextmanager
def running(
    server: Backend,
    resolver: Resolver | None = None,
    *,
    limits: EgressLimits | None = None,
    allowlist: EgressAllowlist = DEFAULT_ALLOWLIST,
) -> Generator[EgressProxy]:
    proxy = EgressProxy(
        allowlist=allowlist,
        resolve=resolver or Resolver(),
        connect=server.connect,
        limits=limits or EgressLimits(),
    )
    proxy.start()
    try:
        yield proxy
    finally:
        proxy.stop()


def read_head(client: socket.socket) -> tuple[int, bytes]:
    """The status code of the answer and whatever followed the head."""
    data = b""
    while b"\r\n\r\n" not in data:
        try:
            chunk = client.recv(4096)
        except ConnectionError:  # the proxy closed with our request still unread
            break
        if not chunk:
            break
        data += chunk
    head, _, rest = data.partition(b"\r\n\r\n")
    parts = head.split(b" ", 2)
    return (int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0), rest


def ask(proxy: EgressProxy, request: bytes, timeout: float = 5.0) -> int:
    """Send raw bytes to the proxy and return the status code it answers with (0: just closed)."""
    with socket.create_connection(("127.0.0.1", proxy.port), timeout=timeout) as client:
        try:
            client.sendall(request)
        except ConnectionError:
            return 0
        status, _ = read_head(client)
    return status


def connect_request(authority: str, *extra: str) -> bytes:
    lines = [f"CONNECT {authority} HTTP/1.1", f"Host: {authority}", *extra, "", ""]
    return "\r\n".join(lines).encode("ascii")


def open_tunnel(proxy: EgressProxy, authority: str = f"{REGISTRY}:443") -> socket.socket:
    client = socket.create_connection(("127.0.0.1", proxy.port), timeout=5)
    client.sendall(connect_request(authority))
    status, _ = read_head(client)
    assert status == 200
    return client


def closed_within(client: socket.socket, seconds: float) -> bool:
    client.settimeout(seconds)
    try:
        return client.recv(1) == b""
    except TimeoutError:
        return False
    except OSError:
        return True


def certificate(directory: Path, name: str) -> tuple[Path, str]:
    key = ec.generate_private_key(ec.SECP256R1())
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, name)])
    now = datetime.datetime.now(datetime.UTC)
    built = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(name)]), critical=False)
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        .sign(key, hashes.SHA256())
    )
    pem = built.public_bytes(serialization.Encoding.PEM)
    path = directory / "server.pem"
    path.write_bytes(
        pem
        + key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    return path, pem.decode("ascii")


# #763-T01
def test_a_connect_to_an_allowlisted_host_tunnels_a_real_tls_session_end_to_end(
    tmp_path: Path,
) -> None:
    pem_path, certificate_pem = certificate(tmp_path, REGISTRY)
    server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server_context.load_cert_chain(pem_path)

    def serve(client: socket.socket) -> None:
        with server_context.wrap_socket(client, server_side=True) as secure:
            secure.sendall(b"pong:" + secure.recv(16))

    client_context = ssl.create_default_context(cadata=certificate_pem)
    with backend(serve) as server, running(server) as proxy:
        tunnel = open_tunnel(proxy)
        with tunnel, client_context.wrap_socket(tunnel, server_hostname=REGISTRY) as secure:
            secure.sendall(b"ping")
            assert secure.recv(64) == b"pong:ping"
            assert secure.getpeercert() is not None
        assert server.dialled == [(PUBLIC, 443)]  # the judged address, port 443, never the name
        assert proxy.tunnel_counts() == {REGISTRY: 1}


# #763-T01
def test_bytes_pass_unchanged_in_both_directions_and_after_a_half_close() -> None:
    payload = bytes(range(256)) * 4096  # 1 MiB
    with backend(echo) as server, running(server) as proxy, open_tunnel(proxy) as tunnel:
        tunnel.settimeout(10)
        received = b""

        def read_all() -> None:
            nonlocal received
            while len(received) < len(payload):
                chunk = tunnel.recv(65536)
                if not chunk:
                    return
                received += chunk

        reader = threading.Thread(target=read_all)
        reader.start()
        tunnel.sendall(payload)
        reader.join(15)
        assert received == payload
        tunnel.shutdown(socket.SHUT_WR)  # the other side must see the end and close in turn
        assert closed_within(tunnel, 5)


# #763-T01
@pytest.mark.parametrize(
    "authority",
    [
        "github.com:443",
        "api.github.com:443",
        "codeload.github.com:443",
        "registry.npmjs.org:80",
        "registry.npmjs.org:8443",
        "registry.npmjs.org:22",
        "registry.npmjs.org:443/path",
        "169.254.169.254:443",
        "127.0.0.1:443",
        "[::1]:443",
        "localhost:443",
        "metadata.google.internal:443",
        "dispatcher.internal:443",
        "user@registry.npmjs.org:443",
        "registry.npmjs.org",
    ],
)
def test_any_other_host_or_port_is_refused_before_a_name_is_looked_up(authority: str) -> None:
    resolver = Resolver()
    with backend() as server, running(server, resolver) as proxy:
        assert ask(proxy, connect_request(authority)) in (400, 403)

        assert resolver.asked == [] and server.dialled == []
        assert proxy.tunnel_counts() == {}


# #763-T01
@pytest.mark.parametrize(
    "request_line",
    [
        "GET http://registry.npmjs.org/left-pad HTTP/1.1",
        "GET / HTTP/1.1",
        "POST http://registry.npmjs.org/ HTTP/1.1",
        "HEAD http://registry.npmjs.org/ HTTP/1.1",
        "OPTIONS * HTTP/1.1",
        "connect registry.npmjs.org:443 HTTP/1.1",
        "CONNECT http://registry.npmjs.org:443/ HTTP/1.1",
    ],
)
def test_plain_http_and_every_method_other_than_connect_are_refused(request_line: str) -> None:
    resolver = Resolver()
    with backend() as server, running(server, resolver) as proxy:
        status = ask(proxy, f"{request_line}\r\nHost: registry.npmjs.org\r\n\r\n".encode("ascii"))

        assert status in (400, 405)
        assert resolver.asked == [] and server.dialled == []


# #763-T01
@pytest.mark.parametrize(
    "request_bytes",
    [
        b"\r\n\r\n",
        b"CONNECT\r\n\r\n",
        b"CONNECT registry.npmjs.org:443\r\n\r\n",
        b"CONNECT registry.npmjs.org:443 HTTP/2\r\n\r\n",
        b"CONNECT registry.npmjs.org:443 HTTP/1.1 extra\r\n\r\n",
        b"CONNECT  registry.npmjs.org:443 HTTP/1.1\r\n\r\n",
        b"CONNECT registry.npmjs.org:443 HTTP/1.1\r\nBroken header\r\n\r\n",
        b"\x16\x03\x01\x02\x00\x01\x00\x01\xfc\x03\x03" + b"\x00" * 64 + b"\r\n\r\n",
        b"CONNECT registry.npmjs.org:\xff\xfe HTTP/1.1\r\n\r\n",
    ],
)
def test_a_malformed_request_is_refused_and_opens_nothing(request_bytes: bytes) -> None:
    resolver = Resolver()
    with backend() as server, running(server, resolver) as proxy:
        assert ask(proxy, request_bytes) in (0, 400, 405)

        assert resolver.asked == [] and server.dialled == []


# #763-T01
def test_a_host_header_that_names_another_host_or_comes_twice_is_refused() -> None:
    resolver = Resolver()
    with backend() as server, running(server, resolver) as proxy:
        other = b"CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n"
        twice = (
            b"CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n"
            b"Host: github.com:443\r\n\r\n"
        )
        fronted = b"CONNECT github.com:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n"

        assert ask(proxy, other) in (400, 403)
        assert ask(proxy, twice) in (400, 403)
        assert ask(proxy, fronted) in (400, 403)
        assert resolver.asked == [] and server.dialled == []
        # No Host header, or the same one in any case, is what clients send.
        assert ask(proxy, b"CONNECT registry.npmjs.org:443 HTTP/1.1\r\n\r\n") == 200
        assert ask(proxy, connect_request("REGISTRY.NPMJS.ORG:443")) == 200


# #763-T01
def test_a_redirect_is_a_new_request_that_is_judged_like_any_other() -> None:
    # The proxy never reads the tunnel, so a 302 inside it is the client's business; the client's
    # next request goes through the proxy again and meets the same rules.
    resolver = Resolver({**RESOLVED, "github.com": [PUBLIC]})
    with backend() as server, running(server, resolver) as proxy:
        with open_tunnel(proxy):
            pass
        for target in (
            "github.com:443",
            "151.101.0.1:443",
            "[2606:4700::1111]:443",
            "x.pkg.test:443",
        ):
            assert ask(proxy, connect_request(target)) in (400, 403)
        assert ask(proxy, connect_request("files.pythonhosted.org:443")) == 200
        assert "github.com" not in resolver.asked


# #763-T03
@pytest.mark.parametrize(
    "answer",
    [
        ["127.0.0.1"],
        ["10.0.0.7"],
        ["169.254.169.254"],
        ["::1"],
        ["fc00::1"],
        ["fd00:ec2::254"],
        ["::ffff:169.254.169.254"],
        [PUBLIC, "192.168.0.10"],
        ["192.168.0.10", PUBLIC],
    ],
)
def test_an_allowlisted_name_that_resolves_to_a_forbidden_address_is_refused_and_not_dialled(
    answer: list[str],
) -> None:
    resolver = Resolver({REGISTRY: answer})
    with backend() as server, running(server, resolver) as proxy:
        assert ask(proxy, connect_request(f"{REGISTRY}:443")) == 403

        assert resolver.asked == [REGISTRY]
        assert server.dialled == []
        assert proxy.tunnel_counts() == {}


# #763-T03
def test_a_name_that_changes_its_answer_cannot_redirect_a_tunnel() -> None:
    # A rebinding name: public for the proxy's lookup, private for the next one. The proxy looks up
    # once and connects to the address it judged, so the second answer is never used.
    answers = iter([[PUBLIC], ["169.254.169.254"], ["169.254.169.254"]])
    asked: list[str] = []

    def rebinding(host: str) -> list[str]:
        asked.append(host)
        return next(answers)

    with backend() as server:
        proxy = EgressProxy(resolve=rebinding, connect=server.connect)
        proxy.start()
        try:
            with open_tunnel(proxy):
                pass
            assert server.dialled == [(PUBLIC, 443)]
            assert asked == [REGISTRY]
            assert ask(proxy, connect_request(f"{REGISTRY}:443")) == 403
            assert server.dialled == [(PUBLIC, 443)]
        finally:
            proxy.stop()


# #763-T03
def test_an_unknown_name_or_a_failing_lookup_is_a_gateway_error_not_a_tunnel() -> None:
    def failing(host: str) -> list[str]:
        raise OSError("no resolver")

    with backend() as server:
        proxy = EgressProxy(resolve=failing, connect=server.connect)
        proxy.start()
        try:
            assert ask(proxy, connect_request(f"{REGISTRY}:443")) == 502
            assert server.dialled == []
        finally:
            proxy.stop()


# #763-T03
def test_a_target_that_cannot_be_reached_is_a_gateway_error() -> None:
    def refuses(address: tuple[str, int], timeout: float) -> socket.socket:
        raise ConnectionRefusedError

    proxy = EgressProxy(resolve=Resolver(), connect=refuses)
    proxy.start()
    try:
        assert ask(proxy, connect_request(f"{REGISTRY}:443")) == 502
        assert proxy.tunnel_counts() == {}
    finally:
        proxy.stop()


# #763-T04
def test_tunnels_beyond_the_limit_are_refused_and_a_closed_one_frees_its_place() -> None:
    with (
        backend(silent) as server,
        running(server, limits=EgressLimits(max_tunnels=2)) as proxy,
    ):
        first = open_tunnel(proxy)
        second = open_tunnel(proxy)
        assert ask(proxy, connect_request(f"{REGISTRY}:443")) == 503

        first.close()
        deadline = time.monotonic() + 5
        status = 503
        while status == 503 and time.monotonic() < deadline:
            time.sleep(0.05)
            status = ask(proxy, connect_request(f"{REGISTRY}:443"))
        assert status == 200
        second.close()


# #763-T04
def test_clients_that_only_hold_a_connection_cannot_exhaust_the_proxy() -> None:
    with (
        backend() as server,
        running(server, limits=EgressLimits(max_connections=2, head_timeout=30)) as proxy,
    ):
        holders = [socket.create_connection(("127.0.0.1", proxy.port), timeout=5) for _ in range(2)]
        try:
            assert ask(proxy, connect_request(f"{REGISTRY}:443")) == 503
        finally:
            for holder in holders:
                holder.close()


# #763-T04
def test_a_client_that_never_finishes_its_request_is_dropped() -> None:
    with backend() as server, running(server, limits=EgressLimits(head_timeout=0.3)) as proxy:
        with socket.create_connection(("127.0.0.1", proxy.port), timeout=5) as client:
            client.sendall(b"CONNECT registry.npmjs.org:443 HTT")
            assert closed_within(client, 3) or read_head(client)[0] in (0, 408)
        assert server.dialled == []


# #763-T04
def test_an_oversized_request_head_is_refused() -> None:
    with backend() as server, running(server) as proxy:
        request = connect_request(f"{REGISTRY}:443", "X-Padding: " + "a" * 20_000)

        assert ask(proxy, request) in (0, 400, 431)
        assert server.dialled == []


# #763-T04
def test_an_idle_tunnel_is_closed_and_one_with_traffic_is_not() -> None:
    with backend(echo) as server, running(server, limits=EgressLimits(idle_timeout=0.6)) as proxy:
        busy = open_tunnel(proxy)
        idle = open_tunnel(proxy)
        busy.settimeout(2)
        for _ in range(5):  # 1.0 s of traffic, longer than the idle limit
            busy.sendall(b"x")
            assert busy.recv(1) == b"x"
            time.sleep(0.2)
        assert closed_within(idle, 3)
        busy.sendall(b"y")
        assert busy.recv(1) == b"y"
        busy.close()


# #763-T04
def test_the_job_log_counts_tunnels_per_host_and_holds_no_path_or_content(
    caplog: pytest.LogCaptureFixture,
) -> None:
    resolver = Resolver()
    with backend(echo) as server:
        proxy = EgressProxy(resolve=resolver, connect=server.connect)
        proxy.start()
        try:
            for authority, secret in (
                (f"{REGISTRY}:443", b"GET /secret-package/-/secret-1.0.0.tgz"),
                (f"{REGISTRY}:443", b"Authorization: Bearer SECRET-TOKEN"),
                ("pypi.org:443", b"POST /simple/secret-project/"),
            ):
                with open_tunnel(proxy, authority) as tunnel:
                    tunnel.sendall(secret)
                    assert tunnel.recv(1024) == secret
            ask(proxy, connect_request("github.com:443"))
            ask(proxy, connect_request("INJECTED\x1b[31m.example:443"))
            with caplog.at_level(logging.INFO):
                proxy.stop()
        finally:
            proxy.stop()

    text = "\n".join(record.getMessage() for record in caplog.records)
    assert proxy.tunnel_counts() == {REGISTRY: 2, "pypi.org": 1}
    assert f"{REGISTRY}=2" in text and "pypi.org=1" in text
    assert "github.com" in text  # a refused host is a host
    for forbidden in ("secret", "SECRET", "Bearer", "/simple", ".tgz", "INJECTED", "\x1b"):
        assert forbidden not in text
    assert all("\n" not in record.getMessage() for record in caplog.records)
    assert "bytes" not in text.lower()


# #763-T04
def test_stopping_the_proxy_ends_open_tunnels_and_a_second_stop_is_harmless() -> None:
    with backend(silent) as server:
        proxy = EgressProxy(resolve=Resolver(), connect=server.connect)
        proxy.start()
        tunnel = open_tunnel(proxy)
        proxy.stop()
        assert closed_within(tunnel, 3)
        proxy.stop()
        tunnel.close()


# #763-T01
def test_the_proxy_listens_on_loopback_only() -> None:
    with backend() as server, running(server) as proxy:
        assert proxy.address == ("127.0.0.1", proxy.port)
        assert proxy.port > 0


def padded_connect(head_bytes: int) -> bytes:
    """A CONNECT request whose head (without the blank line) is exactly `head_bytes` long."""
    base = f"CONNECT {REGISTRY}:443 HTTP/1.1\r\nHost: {REGISTRY}:443\r\nX-Pad: "
    return (base + "a" * (head_bytes - len(base)) + "\r\n\r\n").encode("ascii")


# #763-T04
def test_a_head_of_exactly_the_limit_is_served_and_one_byte_more_is_refused() -> None:
    limits = EgressLimits(max_head_bytes=200)
    with backend() as server, running(server, limits=limits) as proxy:
        assert ask(proxy, padded_connect(200)) == 200
        assert ask(proxy, padded_connect(201)) == 431


# #763-T04
def test_a_head_that_is_not_complete_yet_at_the_limit_is_waited_for() -> None:
    limits = EgressLimits(max_head_bytes=200)
    with backend() as server, running(server, limits=limits) as proxy:
        request = padded_connect(197)  # 197 + 4 bytes; everything but the last one is 200 bytes
        with socket.create_connection(("127.0.0.1", proxy.port), timeout=5) as client:
            client.sendall(request[:-1])
            time.sleep(0.3)  # the proxy has read exactly the limit and must go on reading
            client.sendall(request[-1:])
            status, _ = read_head(client)

        assert status == 200


# #763-T04
def test_a_head_that_never_ends_is_refused_once_it_is_too_long_not_when_the_time_is_up() -> None:
    with backend() as server, running(server, limits=EgressLimits(head_timeout=30)) as proxy:
        started = time.monotonic()
        # 9 000 bytes, more than the limit of 8 192, and no blank line anywhere.
        status = ask(proxy, b"CONNECT " + b"a" * 9_000, timeout=5)

        assert status in (0, 431)
        assert time.monotonic() - started < 5
        assert server.dialled == []
        assert proxy.refused_counts() == {"malformed": 1}


# #763-T04
def test_a_client_that_drips_its_request_cannot_hold_a_slot_past_the_head_deadline() -> None:
    with backend() as server, running(server, limits=EgressLimits(head_timeout=0.6)) as proxy:
        request = connect_request(f"{REGISTRY}:443")
        started = time.monotonic()
        sent = 0
        ended = False
        with socket.create_connection(("127.0.0.1", proxy.port), timeout=5) as client:
            # One byte every 0.4 s: each read returns well inside the 0.6 s, the whole head would
            # take half a minute. Only a deadline for the head as a whole ends this.
            while not ended and time.monotonic() - started < 4:
                client.sendall(request[sent : sent + 1])
                sent += 1
                client.settimeout(0.4)
                try:
                    client.recv(1024)  # the 408, or just the end of the connection
                    ended = True
                except TimeoutError:
                    pass
                except OSError:
                    ended = True

        assert ended
        assert time.monotonic() - started < 2
        assert sent < len(request)
        assert server.dialled == []


# #763-T01
def test_bytes_sent_right_behind_the_request_head_reach_the_target() -> None:
    seen: list[bytes] = []

    def record_then_answer(client: socket.socket) -> None:
        seen.append(client.recv(64))
        client.sendall(b"server-hello")

    with backend(record_then_answer) as server, running(server) as proxy:
        with socket.create_connection(("127.0.0.1", proxy.port), timeout=5) as client:
            # The client does not wait for the 200: its first TLS bytes ride in the same segment.
            client.sendall(connect_request(f"{REGISTRY}:443") + b"client-hello")
            status, rest = read_head(client)
            while len(rest) < len(b"server-hello"):
                rest += client.recv(64)

        assert status == 200
        assert rest == b"server-hello"
        assert seen == [b"client-hello"]


class AcceptFaults:
    """Makes `accept` of the proxy's own listener (no other socket) raise the queued errors."""

    def __init__(
        self,
        monkeypatch: pytest.MonkeyPatch,
        address: tuple[str, int],
        *errors: OSError,
        after: int,
    ) -> None:
        self.errors = list(errors)
        self.after = after
        self.raised = 0
        self.accepted = 0
        original = socket.socket.accept

        def accept(listener: socket.socket) -> tuple[socket.socket, object]:
            try:
                ours = listener.getsockname() == address
            except OSError:
                ours = False
            if ours and self.accepted >= self.after and self.errors:
                self.raised += 1
                raise self.errors.pop(0)
            accepted = original(listener)
            if ours:
                self.accepted += 1
            return accepted

        monkeypatch.setattr(socket.socket, "accept", accept)


# #763-T04
def test_an_accept_that_fails_for_one_client_does_not_end_the_acceptor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with backend() as server, running(server) as proxy:
        faults = AcceptFaults(
            monkeypatch, proxy.address, OSError(errno.ECONNABORTED, "aborted"), after=2
        )
        for _ in range(4):
            with open_tunnel(proxy) as tunnel:
                tunnel.settimeout(5)
                tunnel.sendall(b"x")
                assert tunnel.recv(1) == b"x"

        assert faults.raised == 1


# #763-T04
def test_an_accept_that_keeps_failing_is_retried_slowly_and_recovers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    out_of_files = OSError(errno.EMFILE, "too many open files")
    with backend() as server, running(server) as proxy:
        faults = AcceptFaults(monkeypatch, proxy.address, *[out_of_files] * 100_000, after=0)
        time.sleep(0.5)

        assert 1 <= faults.raised <= 20  # a loop without a pause would raise it thousands of times
        faults.errors.clear()
        with open_tunnel(proxy) as tunnel:
            tunnel.settimeout(5)
            tunnel.sendall(b"x")
            assert tunnel.recv(1) == b"x"


class ThreadsThatCannotStart:
    """The proxy's handler threads (and only those) fail to start, like at the pids limit."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch, *, times: int) -> None:
        self.remaining = times
        outer = self

        class Thread(_THREAD):
            def start(self) -> None:
                serving = getattr(self._target, "__name__", "") == "_serve"  # type: ignore[attr-defined]
                if serving and outer.remaining > 0:
                    outer.remaining -= 1
                    raise RuntimeError("can't start new thread")
                super().start()

        monkeypatch.setattr(threading, "Thread", Thread)


# #763-T04
def test_a_handler_that_cannot_start_costs_that_client_only_and_stop_still_logs(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    with backend() as server:
        proxy = EgressProxy(
            resolve=Resolver(), connect=server.connect, limits=EgressLimits(max_connections=1)
        )
        proxy.start()
        failing = ThreadsThatCannotStart(monkeypatch, times=1)
        try:
            assert ask(proxy, connect_request(f"{REGISTRY}:443")) == 503
            assert failing.remaining == 0
            # The place of that client is free again (the limit is one connection), and the
            # acceptor is alive.
            with open_tunnel(proxy) as tunnel:
                tunnel.settimeout(5)
                tunnel.sendall(b"x")
                assert tunnel.recv(1) == b"x"
        finally:
            with caplog.at_level(logging.INFO):
                proxy.stop()

    assert proxy.refused_counts() == {"limit": 1}
    assert not proxy._handlers  # pyright: ignore[reportPrivateUsage]  # a failed start is not kept
    assert f"{REGISTRY}=1" in "\n".join(record.getMessage() for record in caplog.records)


# #763-T04
def test_stop_does_not_raise_on_a_thread_that_never_started_and_still_logs(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with backend() as server:
        proxy = EgressProxy(resolve=Resolver(), connect=server.connect)
        proxy.start()
        # A handler that is registered but never started.
        with proxy._lock:  # pyright: ignore[reportPrivateUsage]
            proxy._handlers.add(threading.Thread(target=lambda: None))  # pyright: ignore[reportPrivateUsage]
        with caplog.at_level(logging.INFO):
            proxy.stop()

    assert any("egress proxy: tunnels per host" in r.getMessage() for r in caplog.records)
