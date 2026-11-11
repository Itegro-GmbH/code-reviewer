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
import errno
import logging
import socket
import threading
import time
from collections.abc import Callable, Generator, Iterator
from dataclasses import dataclass
from typing import Any

import pytest
from firecracker_support import CREDENTIAL, short_directory, start_for
from firecracker_support import Rig as MachineRig
from netdoor_support import PUBLIC, Lookups, Origin, status_of

from code_reviewer_runner.factory_runner.firecracker.host_addresses import (
    HostAddresses,
    local_addresses,
)
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


class Hooks:
    """Where a test stops the proxy's own steps: `on_lookup` runs in the thread that resolves a
    name, `on_connect` in the one that connects (both before the real double answers)."""

    def __init__(self) -> None:
        self.on_lookup: Callable[[str], None] = lambda name: None
        self.on_connect: Callable[[str], None] = lambda address: None


@dataclass
class Rig:
    wall: ProxyOuterWall
    lookups: Lookups
    origin: Origin
    hooks: Hooks

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


@contextlib.contextmanager
def running(**options: Any) -> Generator[Rig]:
    """A started wall of two slots over loopback; `options` are those of `ProxyOuterWall`."""
    origin = Origin()
    lookups = Lookups()
    hooks = Hooks()
    lookups.servers[PUBLIC] = origin.port
    for name in (SETUP_ONLY, "github.com", "api.github.com", MODEL, APP, "registry.npmjs.org"):
        lookups.table[name] = [PUBLIC]

    def resolve(name: str, port: int) -> list[str]:
        hooks.on_lookup(name)
        return lookups.resolve(name, port)

    def reach(address: str, port: int, timeout: float) -> socket.socket:
        hooks.on_connect(address)
        return lookups.connect(address, port, timeout)

    settings: dict[str, Any] = {
        "slots": 2,
        "port": 0,
        "addresses": tap_addresses,
        "resolver": resolve,
        "connector": reach,
        # What the host has is the host's: a test names the addresses it needs.
        "host_addresses": HostAddresses(lambda: frozenset({"192.0.2.77"})),
    }
    wall = ProxyOuterWall(**{**settings, **options})
    run(wall.start())
    try:
        yield Rig(wall, lookups, origin, hooks)
    finally:
        run(wall.close())
        origin.close()


@pytest.fixture
def rig() -> Iterator[Rig]:
    with running() as made:
        yield made


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


# -- a tunnel ends as a whole ---


# #979 (review: the origin's half stayed open, the handler waited for it and kept its permit)
def test_narrow_ends_the_whole_tunnel_and_gives_the_slots_permits_back() -> None:
    with running(slot_connections=2) as rig:
        identity = admitted(rig)
        held = [hold_a_tunnel(rig, f"held{n}.example.com", f"151.101.1.{n + 1}") for n in range(2)]
        try:
            assert wait_for(lambda: all(each.accepted.is_set() for each in held))
            full = rig.ask(connect(f"{SETUP_ONLY}:443"))
            assert status_of(full) == 503 and reason_of(full) == "too_many_connections"

            run(rig.wall.narrow(identity, narrow_message()))

            # The origins are silent and never close: only the proxy can end the tunnels.
            assert wait_for(lambda: rig.wall.open_connections(FIRST) == 0, 3.0), (
                "the handlers of the setup's tunnels did not return"
            )
            assert all(each.origin_saw_the_end() for each in held)
            for host in ("github.com", MODEL):
                assert status_of(rig.ask(connect(f"{host}:443"))) == 200, host
        finally:
            for each in held:
                each.stop()


# #979
def test_forget_ends_the_whole_tunnel_too() -> None:
    with running(slot_connections=1) as rig:
        identity = admitted(rig)
        held = hold_a_tunnel(rig)
        try:
            assert wait_for(lambda: held.accepted.is_set())

            run(rig.wall.forget(identity))

            assert wait_for(lambda: rig.wall.open_connections(FIRST) == 0, 3.0)
            assert held.origin_saw_the_end()
        finally:
            held.stop()


# -- a decision belongs to the rule it was made under ---


def was_dropped_for_the_rule(rig: Rig, answer: bytes) -> bool:
    """The request met no connection and no 200: `narrow` already ended the guest's connection
    (nothing to read) or the refusal reached it, and the log says `rule_changed` either way."""

    def logged() -> bool:
        return any(
            each["reason"] == "rule_changed" and each["outcome"] == "refused"
            for each in rig.wall.log_of(FIRST)["connections"]
        )

    ended = answer == b"" or (status_of(answer) == 403 and reason_of(answer) == "rule_changed")
    # The handler may still be in the step the test stopped when the guest's end is seen.
    return ended and wait_for(logged, 5.0)


def narrowed_while(rig: Rig, identity: VmIdentity, entered: threading.Event) -> Callable[[], None]:
    """What the test does once the proxy is inside the step it stopped: narrow, which is acked."""

    def narrow_now() -> None:
        assert entered.wait(10), "the proxy never reached the step"
        assert run(rig.wall.narrow(identity, narrow_message())) is None

    return narrow_now


# #979 (review: a decision made under the wide rule was acted on after `narrow` was acked)
def test_a_name_looked_up_under_the_wide_rule_is_not_connected_once_narrow_is_acked(
    rig: Rig,
) -> None:
    identity = admitted(rig)
    entered, release = threading.Event(), threading.Event()

    def slow_resolver(name: str) -> None:
        if name == SETUP_ONLY:
            entered.set()
            assert release.wait(10)

    rig.hooks.on_lookup = slow_resolver
    answers: list[bytes] = []
    asking = threading.Thread(target=lambda: answers.append(rig.ask(connect(f"{SETUP_ONLY}:443"))))
    asking.start()
    narrow_now = narrowed_while(rig, identity, entered)
    narrow_now()
    release.set()
    asking.join(10)

    assert was_dropped_for_the_rule(rig, answers[0])
    assert rig.lookups.connected == [], "a connection was made under a rule that was gone"
    # The same name asked now meets the job's rule.
    assert reason_of(rig.ask(connect(f"{SETUP_ONLY}:443"))) == "not_listed"


# #979
def test_a_connection_made_under_the_wide_rule_sends_nothing_once_narrow_is_acked(
    rig: Rig,
) -> None:
    identity = admitted(rig)
    entered, release = threading.Event(), threading.Event()

    def slow_connector(_address: str) -> None:
        entered.set()
        assert release.wait(10)

    rig.hooks.on_connect = slow_connector
    answers: list[bytes] = []
    request = (
        b"POST http://"
        + SETUP_ONLY.encode()
        + b"/x HTTP/1.1\r\nHost: x\r\nContent-Length: 4\r\n\r\nbody"
    )
    asking = threading.Thread(target=lambda: answers.append(rig.ask(request)))
    asking.start()
    narrowed_while(rig, identity, entered)()
    release.set()
    asking.join(10)

    assert was_dropped_for_the_rule(rig, answers[0])
    assert b"".join(rig.origin.received) == b"", "bytes read under the wide rule were sent"


# #979
def test_a_tunnel_made_under_the_wide_rule_says_nothing_of_a_connection_once_narrow_is_acked(
    rig: Rig,
) -> None:
    identity = admitted(rig)
    entered, release = threading.Event(), threading.Event()

    def slow_connector(_address: str) -> None:
        entered.set()
        assert release.wait(10)

    rig.hooks.on_connect = slow_connector
    answers: list[bytes] = []
    asking = threading.Thread(target=lambda: answers.append(rig.ask(connect(f"{SETUP_ONLY}:443"))))
    asking.start()
    narrowed_while(rig, identity, entered)()
    release.set()
    asking.join(10)

    assert b"Connection Established" not in answers[0]
    assert was_dropped_for_the_rule(rig, answers[0])


# #979
def test_a_decision_made_for_a_forgotten_vm_is_dropped_too() -> None:
    with running() as rig:
        identity = admitted(rig)
        entered, release = threading.Event(), threading.Event()

        def slow_resolver(_name: str) -> None:
            entered.set()
            assert release.wait(10)

        rig.hooks.on_lookup = slow_resolver
        answers: list[bytes] = []
        asking = threading.Thread(
            target=lambda: answers.append(rig.ask(connect(f"{SETUP_ONLY}:443")))
        )
        asking.start()
        assert entered.wait(10)
        run(rig.wall.forget(identity))
        release.set()
        asking.join(10)

        assert was_dropped_for_the_rule(rig, answers[0]) and rig.lookups.connected == []


# -- the process's own limits ---


# #979 (review: busy slots could use up the descriptors of the whole dispatcher)
def test_the_slots_share_one_budget_that_a_busy_slot_cannot_use_up() -> None:
    with running(slot_connections=4, total_connections=2) as rig:
        first = admitted(rig, FIRST)
        admitted(rig, SECOND)
        held = [hold_a_tunnel(rig, f"held{n}.example.com", f"151.101.1.{n + 1}") for n in range(2)]
        try:
            assert wait_for(lambda: all(each.accepted.is_set() for each in held))

            other = rig.ask(connect(f"{SETUP_ONLY}:443"), SECOND)
            assert status_of(other) == 503 and reason_of(other) == "too_many_connections"
            assert rig.wall.log_of(SECOND)["refused"] == 1

            run(rig.wall.forget(first))

            assert wait_for(lambda: rig.wall.open_connections(FIRST) == 0, 3.0)
            assert wait_for(
                lambda: status_of(rig.ask(connect(f"{SETUP_ONLY}:443"), SECOND)) == 200
            ), "the budget was not given back"
        finally:
            for each in held:
                each.stop()


# #979
def test_a_connection_refused_for_the_budget_does_not_take_a_permit() -> None:
    with running(slot_connections=4, total_connections=1) as rig:
        admitted(rig)
        held = hold_a_tunnel(rig)
        try:
            assert wait_for(lambda: held.accepted.is_set())
            for _ in range(5):
                assert reason_of(rig.ask(connect(f"{SETUP_ONLY}:443"))) == "too_many_connections"
            assert rig.wall.open_connections(FIRST) == 1
        finally:
            held.stop()
        # The one that was held ends with its client; nothing leaked on the way.
        run(rig.wall.forget(vm()))
        assert wait_for(lambda: rig.wall.open_connections(FIRST) == 0, 3.0)
        admitted(rig, FIRST, "next")
        assert wait_for(lambda: status_of(rig.ask(connect(f"{SETUP_ONLY}:443"))) == 200)


# #979 (review: accept failed with EMFILE and the listener was readable again at once)
def test_a_listener_out_of_descriptors_backs_off_instead_of_spinning(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    with running() as rig:
        admitted(rig)
        target = rig.wall.listening()[0]
        failing = threading.Event()
        failing.set()
        calls: list[int] = []
        original = socket.socket.accept

        def ours(listener: socket.socket) -> bool:
            try:
                return listener.getsockname() == target
            except OSError:
                return False

        def accept(self: socket.socket) -> Any:
            if failing.is_set() and ours(self):
                calls.append(1)
                raise OSError(errno.EMFILE, "Too many open files")
            return original(self)

        monkeypatch.setattr(socket.socket, "accept", accept)
        client = rig.client()
        try:
            with caplog.at_level(logging.WARNING):
                time.sleep(1.0)
                spun = len(calls)
            assert 1 <= spun <= 10, f"{spun} accept calls in a second"
            assert "descriptors" in caplog.text
            failing.clear()
            client.sendall(connect(f"{SETUP_ONLY}:443"))
            client.settimeout(10)
            assert client.recv(4096).startswith(b"HTTP/1.1 200"), "the listener did not recover"
        finally:
            client.close()
            failing.clear()


# -- the host's own addresses ---


# #979 (review: a name that resolves to the host itself passed the public-address check)
def test_a_name_that_resolves_to_an_address_of_the_host_is_refused_in_every_phase() -> None:
    with running(host_addresses=HostAddresses(lambda: frozenset({PUBLIC}))) as rig:
        identity = admitted(rig)

        wide = rig.ask(connect(f"{SETUP_ONLY}:443"))
        run(rig.wall.narrow(identity, narrow_message()))
        narrowed = rig.ask(connect(f"{APP}:443"))

        assert status_of(wide) == 403 and reason_of(wide) == "private_address"
        assert status_of(narrowed) == 403 and reason_of(narrowed) == "private_address"
        assert rig.lookups.connected == []


def test_a_name_with_one_address_of_the_host_among_public_ones_is_refused_as_a_whole() -> None:
    with running(host_addresses=HostAddresses(lambda: frozenset({"151.101.9.9"}))) as rig:
        rig.lookups.table[SETUP_ONLY] = [PUBLIC, "151.101.9.9"]
        admitted(rig)

        assert status_of(rig.ask(connect(f"{SETUP_ONLY}:443"))) == 403
        assert rig.lookups.connected == []


# #979
def test_an_address_the_host_gains_later_is_refused_after_the_next_refresh() -> None:
    now = [100.0]
    have: list[frozenset[str]] = [frozenset({"192.0.2.77"})]
    reads: list[int] = []

    def read() -> frozenset[str]:
        reads.append(1)
        return have[0]

    addresses = HostAddresses(read, clock=lambda: now[0], max_age=30.0)
    with running(host_addresses=addresses) as rig:
        admitted(rig)
        assert status_of(rig.ask(connect(f"{SETUP_ONLY}:443"))) == 200

        have[0] = frozenset({PUBLIC})
        now[0] += 5.0
        assert status_of(rig.ask(connect(f"{SETUP_ONLY}:443"))) == 200, "read again too early"
        now[0] += 30.0
        answer = rig.ask(connect(f"{SETUP_ONLY}:443"))

        assert status_of(answer) == 403 and reason_of(answer) == "private_address"
        assert len(reads) == 2  # the start's, then the one after the age


def test_a_host_that_cannot_list_its_addresses_has_no_wall_and_says_so(
    caplog: pytest.LogCaptureFixture,
) -> None:
    def unreadable() -> frozenset[str]:
        raise OSError("no /proc")

    wall = ProxyOuterWall(
        slots=1, port=0, addresses=tap_addresses, host_addresses=HostAddresses(unreadable)
    )

    with caplog.at_level(logging.ERROR), pytest.raises(OuterWallUnavailable):
        run(wall.start())

    assert "addresses of this host" in caplog.text
    assert wall.listening() == []


def test_a_refresh_that_fails_keeps_the_last_known_addresses(
    caplog: pytest.LogCaptureFixture,
) -> None:
    now = [0.0]
    answers: list[frozenset[str] | None] = [frozenset({PUBLIC}), None]

    def read() -> frozenset[str]:
        answer = answers.pop(0)
        if answer is None:
            raise OSError("gone")
        return answer

    addresses = HostAddresses(read, clock=lambda: now[0], max_age=10.0)
    assert addresses.contains(PUBLIC)

    now[0] = 11.0
    with caplog.at_level(logging.WARNING):
        assert addresses.contains(PUBLIC), "an address was forgotten because a read failed"
    assert "addresses of this host" in caplog.text


# #979
def test_the_real_list_of_the_host_holds_loopback() -> None:
    assert "127.0.0.1" in local_addresses()


# -- the startup warning, the app's port ---


# #979 (review: the dispatcher cannot see the nft table, so it says so)
def test_the_proxy_says_at_startup_that_it_cannot_verify_the_nft_table(
    caplog: pytest.LogCaptureFixture,
) -> None:
    wall = ProxyOuterWall(slots=1, port=0, addresses=tap_addresses)

    with caplog.at_level(logging.WARNING):
        run(wall.start())
    try:
        assert "cannot verify" in caplog.text and "code_reviewer_wall" in caplog.text
    finally:
        run(wall.close())


# #979 (review: the app's port is not 80 or 443, the proxy could not carry it)
def test_a_narrow_for_an_app_on_another_port_is_refused_and_says_why(
    rig: Rig, caplog: pytest.LogCaptureFixture
) -> None:
    identity = VmIdentity("vm-0-port", FIRST, APP, 3000)
    run(rig.wall.admit(identity))

    with caplog.at_level(logging.ERROR):
        refusal = run(rig.wall.narrow(identity, narrow_message()))

    assert refusal is Refusal.UNAVAILABLE
    assert "port 3000" in caplog.text


def test_a_narrow_for_an_app_on_a_web_port_is_held(rig: Rig) -> None:
    for port in (80, 443, None):
        identity = VmIdentity(f"vm-0-{port}", FIRST, APP, port)
        run(rig.wall.admit(identity))

        assert run(rig.wall.narrow(identity, narrow_message())) is None, port
        run(rig.wall.forget(identity))


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

    def origin_saw_the_end(self) -> bool:
        """The proxy shut the origin's side of the tunnel (it reads the end of the stream)."""
        assert self.peer is not None
        self.peer.settimeout(0.2)
        try:
            return self.peer.recv(4096) == b""
        except TimeoutError:
            return False
        except OSError:
            return True

    def stop(self) -> None:
        for each in (self.client, self.peer, self.origin):
            if each is not None:
                with contextlib.suppress(OSError):
                    each.close()


def hold_a_tunnel(
    rig: Rig,
    name: str = "held.example.com",
    address: str = "151.101.1.1",
    slot: Slot = FIRST,
) -> Held:
    """A tunnel to a host of the setup, kept open: the origin accepts and says nothing, and never
    closes it."""
    origin = socket.socket()
    origin.bind(("127.0.0.1", 0))
    origin.listen(1)
    rig.lookups.servers[address] = origin.getsockname()[1]
    rig.lookups.table[name] = [address]
    client = rig.client(slot)
    client.sendall(connect(f"{name}:443"))
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


# #979 (review: a non-web port of the app is refused at narrow, as the proxy could not carry it)
def test_narrow_is_refused_when_the_apps_url_names_a_port_the_proxy_does_not_dial(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with short_directory() as root:
        rig = MachineRig(root)
        wall = ProxyOuterWall(
            1,
            port=0,
            addresses=lambda slot: SlotAddresses(f"127.0.2.{slot.index + 1}", "127.0.2.100"),
        )
        start = WorkerStart("https://app.example.test:8443", start_for().job_id, CREDENTIAL)

        with caplog.at_level(logging.ERROR):
            run_job(lambda: whole_sandbox_job(rig.sandbox(wall=wall), start))

        control = rig.seen()["control"]
        expected = {"version": 1, "type": "refused", "for": "narrow", "reason": "unavailable"}
        assert control["narrow"] == expected
        assert "port 8443" in caplog.text
