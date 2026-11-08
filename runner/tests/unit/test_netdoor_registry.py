# SPDX-License-Identifier: LicenseRef-Proprietary

"""Package registries through the network door, read-only (#784), on real loopback sockets with
real TLS on both sides: the door ends the agent's TLS connection with its own certificate for the
registry name, lets GET and HEAD through to a registry stand-in it verifies by name, and refuses
everything else before anything reaches the registry.

The registry is a TLS server on loopback with a certificate of a test authority; the door's
connector dials it for the "public" address the name resolves to (`netdoor_support`)."""

import os
import socket
import ssl
import tempfile
import threading
import time
from collections.abc import Callable, Iterator
from datetime import UTC, datetime

import pytest
from cryptography import x509
from netdoor_support import PUBLIC, Lookups, Running, start_proxy, status_of, talk

from code_reviewer_runner.implementer.netdoor.authority import Authority
from code_reviewer_runner.implementer.netdoor.connections import ConnectionLog
from code_reviewer_runner.implementer.netdoor.intercept import RegistryGate
from code_reviewer_runner.implementer.network_rule import MODE_LIST, MODE_OPEN, NetworkRule

pytestmark = pytest.mark.integration

NPM = "registry.npmjs.org"
PYPI = "pypi.org"
LIST = NetworkRule(MODE_LIST, (NPM, "*.pythonhosted.org", PYPI, "example.com"))
TARBALL = b"\x1f\x8b" + bytes(range(256)) * 40


@pytest.fixture(scope="module")
def door_authority() -> Authority:
    return Authority(lifetime_seconds=3600)


@pytest.fixture(scope="module")
def registry_authority() -> Authority:
    """The registries' own authority, which only the door's upstream side trusts."""
    return Authority(lifetime_seconds=3600)


class Registry:
    """A registry stand-in: TLS on loopback, one request per connection, what it received kept."""

    def __init__(self, authority: Authority, *, certificate_for: str) -> None:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        handle, path = tempfile.mkstemp(suffix=".pem")
        try:
            with os.fdopen(handle, "wb") as written:
                written.write(authority.issue(certificate_for))
            context.load_cert_chain(path)
        finally:
            os.unlink(path)
        self._context = context
        self.received: list[bytes] = []
        self._listener = socket.socket()
        self._listener.bind(("127.0.0.1", 0))
        self._listener.listen(8)
        self.port = self._listener.getsockname()[1]
        threading.Thread(target=self._accept, daemon=True).start()

    def _accept(self) -> None:
        while True:
            try:
                connection, _ = self._listener.accept()
            except OSError:
                return
            threading.Thread(target=self._serve, args=(connection,), daemon=True).start()

    def _serve(self, connection: socket.socket) -> None:
        try:
            tls = self._context.wrap_socket(connection, server_side=True)
            data = b""
            while b"\r\n\r\n" not in data:
                chunk = tls.recv(4096)
                if not chunk:
                    break
                data += chunk
            self.received.append(data)
            body = TARBALL if data.startswith(b"GET") else b""
            tls.sendall(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n"
                b"Connection: keep-alive\r\nKeep-Alive: timeout=5\r\n"
                b"Content-Length: " + str(len(TARBALL)).encode() + b"\r\n\r\n" + body
            )
            tls.close()
        except OSError:
            connection.close()

    def close(self) -> None:
        self._listener.close()


class Door:
    def __init__(self, running: Running, lookups: Lookups, registry: Registry) -> None:
        self.running = running
        self.lookups = lookups
        self.registry = registry

    @property
    def port(self) -> int:
        return self.running.port

    @property
    def refusals(self) -> list[tuple[str, str | None]]:
        return [
            (c["host"], c["reason"])
            for c in self.running.log.snapshot()["connections"]
            if c["outcome"] == "refused"
        ]


@pytest.fixture
def door(door_authority: Authority, registry_authority: Authority) -> Iterator[Door]:
    registry = Registry(registry_authority, certificate_for=NPM)
    lookups = Lookups(
        table={NPM: [PUBLIC], PYPI: [PUBLIC], "files.pythonhosted.org": [PUBLIC]},
        servers={PUBLIC: registry.port},
    )

    def upstream_tls(sock: socket.socket, name: str) -> socket.socket:
        context = ssl.create_default_context(cadata=registry_authority.ca_pem.decode())
        return context.wrap_socket(sock, server_hostname=name)

    def gate(log: ConnectionLog) -> RegistryGate:
        return RegistryGate(door_authority, log, upstream_tls=upstream_tls)

    running = start_proxy(LIST, lookups, gate=gate)
    yield Door(running, lookups, registry)
    running.stop()
    registry.close()


def eventually(condition: Callable[[], bool], seconds: float = 5.0) -> bool:
    """The door logs a handshake the client already gave up on a moment after the client sees it."""
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if condition():
            return True
        time.sleep(0.02)
    return condition()


def read_all(sock: socket.socket) -> bytes:
    chunks: list[bytes] = []
    while True:
        try:
            chunk = sock.recv(65536)
        except (TimeoutError, OSError):
            break
        if not chunk:
            break
        chunks.append(chunk)
    return b"".join(chunks)


def through_the_door(
    door: Door,
    authority: Authority,
    request: bytes,
    *,
    connect_to: str = f"{NPM}:443",
    server_name: str | None = NPM,
    trusting: bytes | None = None,
) -> bytes:
    """CONNECT, then TLS with `server_name` against the door's certificate, then `request`; what
    comes back until the door closes. Raises `ssl.SSLError` when the handshake fails."""
    client = socket.create_connection(("127.0.0.1", door.port), timeout=10)
    try:
        client.sendall(f"CONNECT {connect_to} HTTP/1.1\r\nHost: {connect_to}\r\n\r\n".encode())
        answer = b""
        while b"\r\n\r\n" not in answer:
            answer += client.recv(4096)
        assert status_of(answer) == 200, answer
        context = ssl.create_default_context(cadata=(trusting or authority.ca_pem).decode())
        if server_name is None:
            context.check_hostname = False
        tls = context.wrap_socket(client, server_hostname=server_name)
        tls.sendall(request)
        return read_all(tls)
    finally:
        client.close()


def get(path: str = "/left-pad/-/left-pad-1.3.0.tgz", host: str = NPM) -> bytes:
    return f"GET {path} HTTP/1.1\r\nHost: {host}\r\nUser-Agent: npm/10\r\n\r\n".encode()


# #784-T01
def test_a_get_of_a_tarball_reaches_the_registry_and_comes_back(
    door: Door, door_authority: Authority
) -> None:
    answer = through_the_door(door, door_authority, get())

    head, _, body = answer.partition(b"\r\n\r\n")
    assert status_of(head) == 200 and body == TARBALL
    assert b"Connection: close" in head and b"keep-alive" not in head.lower()
    assert b"Keep-Alive" not in head, "the door closes after one request"
    [received] = door.registry.received
    assert received.startswith(b"GET /left-pad/-/left-pad-1.3.0.tgz HTTP/1.1\r\n")
    assert f"Host: {NPM}\r\n".encode() in received and b"Connection: close" in received
    assert door.lookups.connected == [(PUBLIC, 443)], "to the address that was checked"
    snapshot = door.running.log.snapshot()
    assert (snapshot["allowed"], snapshot["refused"]) == (1, 0)
    [entry] = snapshot["connections"]
    assert (entry["host"], entry["port"], entry["outcome"]) == (NPM, 443, "allowed")
    assert entry["bytesIn"] >= len(TARBALL) and entry["bytesOut"] > 0


# #784-T01
def test_a_head_request_and_a_metadata_get_are_reads_too(
    door: Door, door_authority: Authority
) -> None:
    for request in (
        b"HEAD /left-pad HTTP/1.1\r\nHost: registry.npmjs.org\r\n\r\n",
        get("/left-pad", NPM),
        get("/left-pad?write=false", f"{NPM}:443"),
    ):
        assert status_of(through_the_door(door, door_authority, request)) == 200
    assert len(door.registry.received) == 3


@pytest.mark.parametrize(
    ("method", "target"),
    [
        ("PUT", "/my-package"),
        ("POST", "/-/v1/login"),
        ("POST", "/legacy/"),
        ("DELETE", "/my-package/-rev/1-abc"),
        ("PATCH", "/my-package"),
        ("OPTIONS", "/"),
        ("PROPFIND", "/"),
        ("CONNECT", "example.com:443"),
        ("get", "/left-pad"),
    ],
)
# #784-T02
def test_publishing_and_every_other_method_is_refused_before_the_registry_hears_of_it(
    door: Door, door_authority: Authority, method: str, target: str
) -> None:
    request = f"{method} {target} HTTP/1.1\r\nHost: {NPM}\r\nContent-Length: 4\r\n\r\nbody".encode()

    answer = through_the_door(door, door_authority, request)

    assert status_of(answer) == 403 and b"X-Network-Door: method_not_allowed" in answer
    assert b"read-only" in answer, "a failed `npm publish` says why"
    assert door.registry.received == [] and door.lookups.connected == []
    assert door.refusals == [(NPM, "method_not_allowed")]


# #784-T02
def test_a_publish_to_pypis_upload_host_is_refused_too(
    door: Door, door_authority: Authority
) -> None:
    door.lookups.table["upload.pypi.org"] = [PUBLIC]
    # `*.pypi.org` is not in the rule: the upload host is not reachable at all, and with a rule
    # that names it, it is a registry name like the others.
    rule = NetworkRule(MODE_LIST, ("upload.pypi.org",))
    running = start_proxy(
        rule,
        door.lookups,
        gate=lambda log: RegistryGate(door_authority, log),
    )
    try:
        client = socket.create_connection(("127.0.0.1", running.port), timeout=10)
        client.sendall(b"CONNECT upload.pypi.org:443 HTTP/1.1\r\n\r\n")
        assert status_of(client.recv(4096)) == 200
        context = ssl.create_default_context(cadata=door_authority.ca_pem.decode())
        tls = context.wrap_socket(client, server_hostname="upload.pypi.org")
        tls.sendall(b"POST /legacy/ HTTP/1.1\r\nHost: upload.pypi.org\r\nContent-Length: 0\r\n\r\n")
        answer = read_all(tls)
    finally:
        running.stop()
    assert status_of(answer) == 403 and b"method_not_allowed" in answer
    assert door.lookups.connected == []


@pytest.mark.parametrize(
    "host_header",
    [
        "attacker.example",
        "pypi.org",
        "registry.npmjs.org.attacker.example",
        "registry.npmjs.org:8443",
        "",
    ],
)
# #784-T03
def test_a_host_header_that_is_not_the_name_of_the_connection_is_refused(
    door: Door, door_authority: Authority, host_header: str
) -> None:
    request = f"GET /left-pad HTTP/1.1\r\nHost: {host_header}\r\n\r\n".encode()

    answer = through_the_door(door, door_authority, request)

    assert status_of(answer) == 403 and b"X-Network-Door: host_mismatch" in answer
    assert door.registry.received == [] and door.lookups.connected == []


# #784-T03
def test_two_host_headers_or_none_are_refused(door: Door, door_authority: Authority) -> None:
    for request in (
        f"GET / HTTP/1.1\r\nHost: {NPM}\r\nHost: attacker.example\r\n\r\n".encode(),
        b"GET / HTTP/1.1\r\n\r\n",
    ):
        answer = through_the_door(door, door_authority, request)
        assert status_of(answer) == 403 and b"host_mismatch" in answer
    assert door.registry.received == []


# #784-T03
def test_a_server_name_that_is_not_the_connect_name_gets_no_handshake(
    door: Door, door_authority: Authority
) -> None:
    # Another registry name the rule lists, and a name outside it: neither is served on this
    # connection, whatever the client asks inside it.
    for name in (PYPI, "attacker.example"):
        with pytest.raises(ssl.SSLError):
            through_the_door(door, door_authority, get(), server_name=name)
    # The client trusts the door's authority but would check the name: the same refusal from the
    # other side, a hello without any server name.
    with pytest.raises(ssl.SSLError):
        through_the_door(door, door_authority, get(), server_name=None)
    assert door.registry.received == [] and door.lookups.connected == []
    assert eventually(lambda: door.running.log.snapshot()["refused"] == 3)
    assert {reason for _, reason in door.refusals} == {"tls_failed"}


# #784-T03
def test_a_client_that_does_not_trust_the_doors_authority_never_sends_a_request(
    door: Door, registry_authority: Authority, door_authority: Authority
) -> None:
    with pytest.raises(ssl.SSLError):
        through_the_door(door, door_authority, get(), trusting=registry_authority.ca_pem)
    assert door.registry.received == []
    assert eventually(lambda: door.refusals == [(NPM, "tls_failed")])


# #784-T03
def test_a_registry_whose_certificate_is_not_for_its_name_is_not_spoken_to(
    door_authority: Authority, registry_authority: Authority
) -> None:
    # Something else at the CDN address: it presents a certificate for another name. The door's
    # own check of the registry's certificate (name and authority) fails before any request.
    other = Registry(registry_authority, certificate_for="mirror.npmjs.org")
    lookups = Lookups(table={NPM: [PUBLIC]}, servers={PUBLIC: other.port})

    def upstream_tls(sock: socket.socket, name: str) -> socket.socket:
        context = ssl.create_default_context(cadata=registry_authority.ca_pem.decode())
        return context.wrap_socket(sock, server_hostname=name)

    running = start_proxy(
        LIST, lookups, gate=lambda log: RegistryGate(door_authority, log, upstream_tls=upstream_tls)
    )
    try:
        wrapper = Door(running, lookups, other)
        answer = through_the_door(wrapper, door_authority, get())
    finally:
        running.stop()
        other.close()
    assert status_of(answer) == 502 and b"upstream_failed" in answer
    assert other.received == []


@pytest.mark.parametrize("target", ["80", "8080"])
# #784-T04
def test_a_registry_is_not_reached_over_plain_http_or_another_port(door: Door, target: str) -> None:
    answer = talk(door.port, f"CONNECT {NPM}:{target} HTTP/1.1\r\n\r\n".encode())
    if target == "80":
        assert status_of(answer) == 403 and b"X-Network-Door: registry_read_only" in answer
    else:
        assert status_of(answer) == 403 and b"port_not_allowed" in answer

    plain = talk(door.port, f"PUT http://{NPM}/pkg HTTP/1.1\r\nHost: {NPM}\r\n\r\n".encode())
    assert status_of(plain) == 403 and b"registry_read_only" in plain
    plain_get = talk(door.port, f"GET http://{NPM}/pkg HTTP/1.1\r\nHost: {NPM}\r\n\r\n".encode())
    assert status_of(plain_get) == 403 and b"registry_read_only" in plain_get
    assert door.registry.received == [] and door.lookups.connected == []


@pytest.mark.parametrize(
    "request_bytes",
    [
        b"GET /x HTTP/1.1\r\nHost: registry.npmjs.org\r\nContent-Length: 5\r\n\r\nhello",
        b"GET /x HTTP/1.1\r\nHost: registry.npmjs.org\r\n"
        b"Transfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
        b"GET http://registry.npmjs.org/x HTTP/1.1\r\nHost: registry.npmjs.org\r\n\r\n",
        b"GET //attacker.example/x HTTP/1.1\r\nHost: registry.npmjs.org\r\n\r\n",
        b"GET /x HTTP/2.0\r\nHost: registry.npmjs.org\r\n\r\n",
        b"GET /x\r\nHost: registry.npmjs.org\r\n\r\n",
    ],
)
# #784-T05
def test_a_read_that_carries_a_body_or_is_not_in_origin_form_is_refused(
    door: Door, door_authority: Authority, request_bytes: bytes
) -> None:
    answer = through_the_door(door, door_authority, request_bytes)

    assert status_of(answer) == 400 and b"bad_request" in answer
    assert door.registry.received == []


# #784-T05
def test_a_second_request_behind_the_first_is_never_forwarded(
    door: Door, door_authority: Authority
) -> None:
    both = get() + f"PUT /pkg HTTP/1.1\r\nHost: {NPM}\r\nContent-Length: 0\r\n\r\n".encode()

    answer = through_the_door(door, door_authority, both)

    assert status_of(answer) == 200
    [received] = door.registry.received
    assert received.count(b"HTTP/1.1\r\n") == 1 and b"PUT" not in received


# #784-T06
def test_a_host_that_is_no_registry_is_still_a_plain_tunnel_beside_the_gate(
    door: Door,
) -> None:
    door.lookups.table["example.com"] = [PUBLIC]
    answer = talk(door.port, b"CONNECT example.com:443 HTTP/1.1\r\n\r\n")
    assert status_of(answer) == 200, "no TLS of the door's: the bytes go through unread"


# #784-T06
def test_open_has_no_gate_and_the_registries_stay_tunnels(registry_authority: Authority) -> None:
    lookups = Lookups(table={NPM: [PUBLIC]}, servers={})
    running = start_proxy(NetworkRule(MODE_OPEN), lookups)
    try:
        answer = talk(running.port, f"CONNECT {NPM}:443 HTTP/1.1\r\n\r\n".encode())
    finally:
        running.stop()
    assert status_of(answer) == 502, "a tunnel: the door tried to connect and there was no route"
    assert lookups.connected == [(PUBLIC, 443)]


# -- the authority ---


# #784-T07
def test_the_authority_is_limited_to_the_registry_domains_and_to_the_turn(
    door_authority: Authority,
) -> None:
    ca = x509.load_pem_x509_certificate(door_authority.ca_pem)
    constraints = ca.extensions.get_extension_for_class(x509.NameConstraints)
    assert constraints.critical
    permitted = {
        str(name.value)
        for name in constraints.value.permitted_subtrees or []
        if isinstance(name, x509.DNSName)
    }
    assert {"npmjs.org", "pypi.org", "pythonhosted.org", "crates.io"} <= permitted
    assert "example.com" not in permitted and "github.com" not in permitted
    basic = ca.extensions.get_extension_for_class(x509.BasicConstraints).value
    assert basic.ca and basic.path_length == 0
    assert ca.not_valid_after_utc > datetime.now(UTC)
    assert (ca.not_valid_after_utc - datetime.now(UTC)).total_seconds() < 24 * 3600


# #784-T07
def test_the_authority_makes_no_certificate_for_a_name_outside_its_domains(
    door_authority: Authority,
) -> None:
    for name in ("github.com", "example.com", "evilnpmjs.org", "registry.npmjs.org.evil.test"):
        with pytest.raises(ValueError):
            door_authority.issue(name)


# #784-T07
def test_the_public_certificate_has_no_private_key_in_it(door_authority: Authority) -> None:
    assert b"PRIVATE KEY" not in door_authority.ca_pem
    assert door_authority.ca_pem.startswith(b"-----BEGIN CERTIFICATE-----")


# #784-T07
def test_the_door_sends_no_server_certificate_for_another_names_context(
    door_authority: Authority,
) -> None:
    factory: Callable[[str], ssl.SSLContext] = door_authority.server_context
    assert factory(NPM) is factory(NPM), "one context for a name"
    assert factory(NPM) is not factory(PYPI)
