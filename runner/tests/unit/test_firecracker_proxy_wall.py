# SPDX-License-Identifier: LicenseRef-Proprietary

"""The outer wall's proxy (#979) on real loopback sockets: which address it listens on, what a VM
may reach before and after `narrow`, what it refuses whatever the rule says, and when it lets go.

A slot's TAP addresses are loopback addresses here (127.0.1.1 is the host's side of slot 0,
127.0.1.2 the guest's), so a "guest" is a client that binds the guest's address and a "host's other
address" is 127.0.0.1. Names resolve through a table and connections go to loopback servers
(`netdoor_support`), so the questions are the proxy's own. The real wall (the nft table, a real VM)
is the KVM lane's."""

import asyncio
import contextlib
import logging
import socket
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from typing import Any

import pytest
from firecracker_support import CREDENTIAL, short_directory, start_for
from firecracker_support import Rig as MachineRig
from netdoor_support import PUBLIC, Lookups, Origin, status_of

from code_reviewer_runner.factory_runner.firecracker.launcher import FirecrackerSandbox
from code_reviewer_runner.factory_runner.firecracker.outer_wall import VmIdentity
from code_reviewer_runner.factory_runner.firecracker.proxy_wall import (
    OuterWallUnavailable,
    ProxyOuterWall,
    SlotAddresses,
)
from code_reviewer_runner.factory_runner.firecracker.slots import Slot
from code_reviewer_runner.factory_runner.firecracker.wire import NarrowMessage, Refusal
from code_reviewer_runner.factory_runner.sandbox import WorkerStart
from code_reviewer_runner.implementer.network_rule import (
    MODE_LIST,
    MODE_OFF,
    MODE_OPEN,
    NetworkRule,
)

# Loopback addresses besides 127.0.0.1 are not in the default allow-list of the socket guard.
pytestmark = [
    pytest.mark.integration,
    pytest.mark.allow_hosts(["127.0.0.1", "127.0.1.1", "127.0.1.2", "127.0.1.5", "127.0.1.6"]),
]

SETUP_ONLY = "setup-only.example.com"
MODEL = "api.anthropic.com"
APP = "app.example.test"
FIRST, SECOND = Slot(0), Slot(1)


def tap_addresses(slot: Slot) -> SlotAddresses:
    return SlotAddresses(f"127.0.1.{slot.index * 4 + 1}", f"127.0.1.{slot.index * 4 + 2}")


def vm(slot: Slot = FIRST, name: str = "a", app_host: str | None = APP) -> VmIdentity:
    return VmIdentity(f"vm-{slot.index}-{name}", slot, app_host)


def narrow_message(
    mode: str = MODE_OFF, hosts: tuple[str, ...] = (), model: str = MODEL
) -> NarrowMessage:
    return NarrowMessage(NetworkRule(mode, hosts), model)


def run(coroutine: Any) -> Any:
    return asyncio.run(coroutine)


@dataclass
class Rig:
    wall: ProxyOuterWall
    lookups: Lookups
    origin: Origin

    def ask(
        self,
        request: bytes,
        slot: Slot = FIRST,
        *,
        source: str | None = None,
        more: Callable[[socket.socket], None] | None = None,
    ) -> bytes:
        """What the proxy of `slot` answers to `request` from the slot's guest (or from
        `source`)."""
        client = self.client(slot, source)
        try:
            client.sendall(request)
            if more is not None:
                more(client)
            with contextlib.suppress(OSError):
                client.shutdown(socket.SHUT_WR)
            chunks: list[bytes] = []
            while True:
                try:
                    chunk = client.recv(65536)
                except OSError:
                    break
                if not chunk:
                    break
                chunks.append(chunk)
            return b"".join(chunks)
        finally:
            client.close()

    def client(self, slot: Slot = FIRST, source: str | None = None) -> socket.socket:
        client = socket.socket()
        client.settimeout(10)
        client.bind((source or tap_addresses(slot).guest, 0))
        client.connect((tap_addresses(slot).host, self.wall.port_of(slot)))
        return client


@pytest.fixture
def rig() -> Iterator[Rig]:
    origin = Origin()
    lookups = Lookups()
    lookups.servers[PUBLIC] = origin.port
    for name in (SETUP_ONLY, "github.com", "api.github.com", MODEL, APP, "registry.npmjs.org"):
        lookups.table[name] = [PUBLIC]
    wall = ProxyOuterWall(
        slots=2,
        port=0,
        addresses=tap_addresses,
        resolver=lookups.resolve,
        connector=lookups.connect,
    )
    run(wall.start())
    try:
        yield Rig(wall, lookups, origin)
    finally:
        run(wall.close())
        origin.close()


def connect(target: str) -> bytes:
    return f"CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n".encode()


def reason_of(answer: bytes) -> str:
    for line in answer.split(b"\r\n"):
        if line.lower().startswith(b"x-network-door:"):
            return line.split(b":", 1)[1].strip().decode()
    return ""


def admitted(rig: Rig, slot: Slot = FIRST, name: str = "a") -> VmIdentity:
    identity = vm(slot, name)
    run(rig.wall.admit(identity))
    return identity


# -- where it listens ---


# #979 (spike #970: the guest could reach a proxy on the host's other addresses)
def test_the_proxy_listens_on_the_tap_address_of_each_slot_and_on_nothing_else(rig: Rig) -> None:
    admitted(rig)

    assert rig.wall.listening() == [
        (tap_addresses(FIRST).host, rig.wall.port_of(FIRST)),
        (tap_addresses(SECOND).host, rig.wall.port_of(SECOND)),
    ]
    # The host's other address (here 127.0.0.1, in a real machine eth0) has no proxy on that port.
    with pytest.raises(ConnectionRefusedError):
        socket.create_connection(("127.0.0.1", rig.wall.port_of(FIRST)), timeout=2)
    assert rig.wall.port_of(FIRST) != rig.wall.port_of(SECOND)


def test_the_default_addresses_are_the_slots_tap_network_and_the_default_port() -> None:
    wall = ProxyOuterWall(slots=3)

    assert wall.addresses_of(Slot(2)) == SlotAddresses("172.31.0.9", "172.31.0.10")
    assert wall.configured_port == 3128


def test_a_proxy_that_cannot_listen_says_which_tap_and_leaves_nothing_open(
    caplog: pytest.LogCaptureFixture,
) -> None:
    def addresses(slot: Slot) -> SlotAddresses:
        # Slot 0 is bindable, slot 1 is an address no interface has.
        return tap_addresses(slot) if slot.index == 0 else SlotAddresses("192.0.2.1", "192.0.2.2")

    wall = ProxyOuterWall(slots=2, port=0, addresses=addresses)

    with caplog.at_level(logging.ERROR), pytest.raises(OuterWallUnavailable):
        run(wall.start())

    assert "fctap1" in caplog.text and "192.0.2.1" in caplog.text
    assert wall.listening() == []


def test_close_stops_the_listeners_and_can_be_repeated() -> None:
    wall = ProxyOuterWall(slots=1, port=0, addresses=tap_addresses)
    run(wall.start())
    port = wall.port_of(FIRST)

    run(wall.close())
    run(wall.close())

    with pytest.raises(ConnectionRefusedError):
        socket.create_connection((tap_addresses(FIRST).host, port), timeout=2)


# -- before and after narrow ---


# #979-T02
def test_before_narrow_a_setup_only_host_is_reachable_through_the_proxy(rig: Rig) -> None:
    admitted(rig)

    answer = rig.ask(connect(f"{SETUP_ONLY}:443"))

    assert answer.startswith(b"HTTP/1.1 200 Connection Established\r\n\r\n")
    assert rig.lookups.connected == [(PUBLIC, 443)]


# #979-T02
def test_after_narrow_the_setup_only_host_is_refused_and_the_jobs_hosts_are_not(
    rig: Rig,
) -> None:
    identity = admitted(rig)

    assert run(rig.wall.narrow(identity, narrow_message())) is None

    refused = rig.ask(connect(f"{SETUP_ONLY}:443"))
    assert status_of(refused) == 403 and reason_of(refused) == "not_listed"
    assert rig.lookups.looked_up == [], "a name the rule does not list is never sent to a resolver"
    for host in ("github.com", "api.github.com", MODEL, APP):
        answer = rig.ask(connect(f"{host}:443"))
        assert status_of(answer) == 200, host


# #979-T02
def test_after_narrow_the_rules_own_hosts_are_reachable_too(rig: Rig) -> None:
    identity = admitted(rig)

    run(rig.wall.narrow(identity, narrow_message(MODE_LIST, ("registry.npmjs.org",))))

    assert status_of(rig.ask(connect("registry.npmjs.org:443"))) == 200
    assert status_of(rig.ask(connect(f"{SETUP_ONLY}:443"))) == 403


# #979-T02
def test_an_open_rule_is_not_narrowed(rig: Rig) -> None:
    identity = admitted(rig)

    assert run(rig.wall.narrow(identity, narrow_message(MODE_OPEN))) is None

    assert status_of(rig.ask(connect(f"{SETUP_ONLY}:443"))) == 200


# #979-T02
def test_narrow_is_acknowledged_only_when_the_rule_is_already_held(rig: Rig) -> None:
    identity = admitted(rig)
    seen: list[int] = []

    async def scenario() -> None:
        assert await rig.wall.narrow(identity, narrow_message()) is None
        # The very next request after the answer meets the job's rule: the answer is the rule.
        seen.append(status_of(await asyncio.to_thread(rig.ask, connect(f"{SETUP_ONLY}:443"))))

    run(scenario())

    assert seen == [403]


def test_connections_of_the_setup_that_are_still_open_end_at_narrow(rig: Rig) -> None:
    identity = admitted(rig)
    held = hold_a_tunnel(rig)
    try:
        assert wait_for(lambda: held.accepted.is_set()), "the tunnel never reached its origin"

        run(rig.wall.narrow(identity, narrow_message()))

        assert wait_for(lambda: held.closed_by_peer()), "the setup's tunnel survived the narrowing"
    finally:
        held.stop()


def test_a_narrow_the_wall_cannot_hold_is_refused_and_says_why(
    rig: Rig, caplog: pytest.LogCaptureFixture
) -> None:
    identity = vm(app_host="10.0.0.5")
    run(rig.wall.admit(identity))

    with caplog.at_level(logging.ERROR):
        refusal = run(rig.wall.narrow(identity, narrow_message()))

    assert refusal is Refusal.UNAVAILABLE
    assert "the app's host" in caplog.text


def test_narrow_for_a_vm_the_wall_does_not_know_is_unavailable(rig: Rig) -> None:
    assert run(rig.wall.narrow(vm(), narrow_message())) is Refusal.UNAVAILABLE
    assert run(rig.wall.narrow(vm(Slot(7)), narrow_message())) is Refusal.UNAVAILABLE


# -- what is refused whatever the rule says ---


@pytest.mark.parametrize("address", ["10.0.0.5", "172.16.1.1", "192.168.1.1", "169.254.169.254"])
def test_a_name_that_resolves_to_a_private_address_is_refused_in_every_phase(
    rig: Rig, address: str
) -> None:
    rig.lookups.table[SETUP_ONLY] = [address]
    rig.lookups.table[APP] = [address]
    identity = admitted(rig)

    wide = rig.ask(connect(f"{SETUP_ONLY}:443"))
    run(rig.wall.narrow(identity, narrow_message()))
    narrowed = rig.ask(connect(f"{APP}:443"))

    assert status_of(wide) == 403 and reason_of(wide) == "private_address"
    assert status_of(narrowed) == 403 and reason_of(narrowed) == "private_address"
    assert rig.lookups.connected == [], "no connection was made to a checked-out address"


def test_a_name_with_one_public_and_one_private_address_is_refused_as_a_whole(rig: Rig) -> None:
    rig.lookups.table[SETUP_ONLY] = [PUBLIC, "10.0.0.5"]
    admitted(rig)

    answer = rig.ask(connect(f"{SETUP_ONLY}:443"))

    assert status_of(answer) == 403 and rig.lookups.connected == []


def test_the_connection_goes_to_the_address_that_was_checked_not_to_the_name_again(
    rig: Rig,
) -> None:
    # A resolver that answers differently the second time (DNS rebinding) changes nothing.
    rig.lookups.second_answer[SETUP_ONLY] = ["10.0.0.5"]
    admitted(rig)

    answer = rig.ask(connect(f"{SETUP_ONLY}:443"))

    assert status_of(answer) == 200
    assert rig.lookups.connected == [(PUBLIC, 443)]
    assert rig.lookups.looked_up.count(SETUP_ONLY) == 1


@pytest.mark.parametrize(
    "target",
    ["93.184.216.34:443", "10.0.0.1:80", "169.254.169.254:80", "[::1]:443", "2130706433:80"],
)
def test_an_address_is_never_a_name(rig: Rig, target: str) -> None:
    admitted(rig)

    answer = rig.ask(connect(target))

    assert status_of(answer) == 403 and reason_of(answer) == "ip_literal"
    assert rig.lookups.looked_up == [] and rig.lookups.connected == []


@pytest.mark.parametrize("port", [22, 25, 8080, 8443])
def test_only_the_web_ports_go_through(rig: Rig, port: int) -> None:
    admitted(rig)

    answer = rig.ask(connect(f"{SETUP_ONLY}:{port}"))

    assert status_of(answer) == 403 and reason_of(answer) == "port_not_allowed"
    assert rig.lookups.looked_up == []


def test_plain_http_is_forwarded_in_its_origin_form(rig: Rig) -> None:
    admitted(rig)

    answer = rig.ask(
        f"GET http://{SETUP_ONLY}/index.html HTTP/1.1\r\nHost: {SETUP_ONLY}\r\n\r\n".encode()
    )

    assert status_of(answer) == 200
    assert rig.origin.received[0].startswith(b"GET /index.html HTTP/1.1\r\nHost: setup-only")


def test_a_refusal_says_that_the_outer_wall_refused(rig: Rig) -> None:
    identity = admitted(rig)
    run(rig.wall.narrow(identity, narrow_message()))

    answer = rig.ask(connect(f"{SETUP_ONLY}:443"))

    assert b"outer wall: " in answer and b"network door:" not in answer


# -- which VM a connection is from ---


def test_a_connection_that_is_not_from_the_slots_own_guest_is_closed_unanswered(rig: Rig) -> None:
    admitted(rig, FIRST)
    admitted(rig, SECOND, "b")

    # Slot 1's guest connecting to slot 0's proxy (the nft table lets a TAP reach any proxy port of
    # the /16): the source is not slot 0's guest, so the proxy does not serve it.
    answer = rig.ask(connect(f"{SETUP_ONLY}:443"), FIRST, source=tap_addresses(SECOND).guest)

    assert answer == b""
    assert rig.lookups.looked_up == []
    entries = rig.wall.log_of(FIRST)["connections"]
    assert [(each["reason"], each["outcome"]) for each in entries] == [("wrong_source", "refused")]
    # The right guest is served.
    assert status_of(rig.ask(connect(f"{SETUP_ONLY}:443"), FIRST)) == 200


def test_a_slot_with_no_vm_serves_nobody(rig: Rig) -> None:
    answer = rig.ask(connect(f"{SETUP_ONLY}:443"))

    assert status_of(answer) == 403 and reason_of(answer) == "no_job"
    assert rig.lookups.looked_up == []


def test_the_slots_have_rules_of_their_own(rig: Rig) -> None:
    first, second = admitted(rig, FIRST), admitted(rig, SECOND, "b")

    run(rig.wall.narrow(first, narrow_message()))

    assert status_of(rig.ask(connect(f"{SETUP_ONLY}:443"), FIRST)) == 403
    assert status_of(rig.ask(connect(f"{SETUP_ONLY}:443"), SECOND)) == 200
    assert second.slot == SECOND


# -- when the VM is gone ---


def test_a_forgotten_vm_has_no_rule_and_its_open_connections_end(rig: Rig) -> None:
    identity = admitted(rig)
    held = hold_a_tunnel(rig)
    try:
        assert wait_for(lambda: held.accepted.is_set())

        run(rig.wall.forget(identity))

        assert wait_for(lambda: held.closed_by_peer())
        answer = rig.ask(connect(f"{SETUP_ONLY}:443"))
        assert status_of(answer) == 403 and reason_of(answer) == "no_job"
    finally:
        held.stop()


def test_forgetting_the_old_vm_does_not_take_the_rule_of_the_new_one_in_its_slot(rig: Rig) -> None:
    old = admitted(rig, FIRST, "old")
    new = admitted(rig, FIRST, "new")
    run(rig.wall.narrow(new, narrow_message()))

    run(rig.wall.forget(old))

    assert status_of(rig.ask(connect(f"{APP}:443"))) == 200
    assert status_of(rig.ask(connect(f"{SETUP_ONLY}:443"))) == 403


def test_a_vm_starts_with_the_wide_rule_again_in_a_slot_that_was_narrowed(rig: Rig) -> None:
    first = admitted(rig, FIRST, "one")
    run(rig.wall.narrow(first, narrow_message()))
    run(rig.wall.forget(first))

    admitted(rig, FIRST, "two")

    assert status_of(rig.ask(connect(f"{SETUP_ONLY}:443"))) == 200


def test_forget_never_raises_for_a_vm_it_does_not_know(rig: Rig) -> None:
    run(rig.wall.forget(vm(Slot(9))))
    run(rig.wall.forget(vm()))


# -- helpers: a tunnel that stays open ---


class Held:
    """An origin that accepts a tunnel and keeps it open, and a client that holds one to it."""

    def __init__(self, rig: Rig, origin: socket.socket, client: socket.socket) -> None:
        self.rig = rig
        self.origin = origin
        self.client = client
        self.accepted = threading.Event()
        self.peer: socket.socket | None = None
        threading.Thread(target=self._accept, daemon=True).start()

    def _accept(self) -> None:
        with contextlib.suppress(OSError):
            self.peer, _ = self.origin.accept()
            self.accepted.set()

    def closed_by_peer(self) -> bool:
        self.client.settimeout(0.2)
        try:
            data = self.client.recv(4096)
        except TimeoutError:
            return False
        except OSError:
            return True
        return data == b""

    def stop(self) -> None:
        for each in (self.client, self.peer, self.origin):
            if each is not None:
                with contextlib.suppress(OSError):
                    each.close()


def hold_a_tunnel(rig: Rig) -> Held:
    """A tunnel to a host of the setup, kept open: the origin accepts and says nothing."""
    origin = socket.socket()
    origin.bind(("127.0.0.1", 0))
    origin.listen(1)
    rig.lookups.servers["151.101.1.1"] = origin.getsockname()[1]
    rig.lookups.table["held.example.com"] = ["151.101.1.1"]
    client = rig.client()
    client.sendall(connect("held.example.com:443"))
    client.settimeout(10)
    assert client.recv(4096).startswith(b"HTTP/1.1 200")
    return Held(rig, origin, client)


def wait_for(condition: Callable[[], bool], seconds: float = 10.0) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if condition():
            return True
        time.sleep(0.05)
    return condition()


# -- the launcher with the real wall ---


async def whole_sandbox_job(sandbox: FirecrackerSandbox, start: WorkerStart | None = None) -> None:
    await sandbox.setup()
    try:
        worker = await sandbox.start(start or start_for())
        await worker.wait()
    finally:
        await sandbox.close()


def run_job(scenario: Callable[[], Any]) -> None:
    asyncio.run(scenario())


# #979
def test_narrow_is_acked_with_the_real_proxy_wall_when_it_holds_the_rule() -> None:
    with short_directory() as root:
        rig = MachineRig(root)
        wall = ProxyOuterWall(
            1,
            port=0,
            addresses=lambda slot: SlotAddresses(f"127.0.2.{slot.index + 1}", "127.0.2.100"),
        )
        start = WorkerStart("https://app.example.test", start_for().job_id, CREDENTIAL)

        run_job(lambda: whole_sandbox_job(rig.sandbox(wall=wall), start))

        assert rig.seen()["control"]["narrow"] == {"version": 1, "type": "ack", "for": "narrow"}


# #979
def test_narrow_is_refused_when_the_app_cannot_be_reached_through_the_proxy(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with short_directory() as root:
        rig = MachineRig(root)
        wall = ProxyOuterWall(
            1,
            port=0,
            addresses=lambda slot: SlotAddresses(f"127.0.2.{slot.index + 1}", "127.0.2.100"),
        )

        # `start_for` names the app by an address (172.31.0.1): the proxy never serves an address.
        with caplog.at_level(logging.ERROR):
            run_job(lambda: whole_sandbox_job(rig.sandbox(wall=wall)))

        control = rig.seen()["control"]
        expected = {"version": 1, "type": "refused", "for": "narrow", "reason": "unavailable"}
        assert control["narrow"] == expected
        assert "the app's host" in caplog.text
