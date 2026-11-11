# SPDX-License-Identifier: LicenseRef-Proprietary

"""The outer wall of a customer's machine: a proxy of the local Dispatcher (#979, Runner v2, epic
#969, ADR 0005, decision 7).

A job's VM has no direct internet. A static nft table (`docker/vm/host/outer-wall.nft`, loaded once
at install as root) lets the VM's TAP reach only the proxy port of this process, and drops the rest:
the host's other addresses and ports, the LAN, the metadata address, the other VMs, IPv6. This
module is what answers on that port, as the service's own normal user:

* **One listener per slot, on that slot's TAP address and on nothing else.** The spike (#970) found
  that a guest could also reach a proxy on the host's other addresses; a proxy bound to the host's
  side of each TAP cannot be reached on eth0 or loopback whatever the table says. The listener says
  which VM a connection is from, and a connection whose source is not the slot's own guest address
  is closed unanswered (the table lets a TAP reach any proxy address of the /16, not only its own).
* **A rule per VM.** `admit` (before the VM exists) gives the VM the wide rule of the setup: any
  public name on 80 and 443. `narrow` swaps in the job's rule (`outer_rule.narrowed_rule`, the
  hosted second wall's list of names) and drops the connections the setup left open; it returns, and
  so the host answers `ack`, only when the rule is held. `forget` takes the VM's rule away. A slot
  with no VM serves nobody. Changing a rule never touches nft.
* **DNS is the proxy's.** A guest asks for `CONNECT name:443` (or an absolute-form HTTP request) and
  the proxy looks the name up; the guest has no name server it can reach. The decision is the
  network door's (`implementer/netdoor/proxy.py`, which this reuses on purpose: an address is never
  a name, only 80 and 443, the rule lists the name before any lookup, every address must be public,
  and the connection goes to an address that was checked, never to the name again).

The proxy has no way to be told a test network: the door's `NETDOOR_TEST_PUBLIC_CIDR` seam is not
used here, so no setting can open a private range for a VM."""

import asyncio
import contextlib
import logging
import socket
import threading
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Final, override

from code_reviewer_runner.implementer.netdoor.addresses import Resolver, system_resolver
from code_reviewer_runner.implementer.netdoor.connections import (
    OUTCOME_REFUSED,
    ConnectionLog,
)
from code_reviewer_runner.implementer.netdoor.proxy import (
    Connector,
    Decider,
    Decision,
    ProxyServer,
    tcp_connector,
)
from code_reviewer_runner.implementer.network_rule import NetworkRule

from .outer_rule import WIDE, OuterRuleError, narrowed_rule
from .outer_wall import VmIdentity
from .slots import Slot
from .wire import NarrowMessage, Refusal

_log = logging.getLogger(__name__)

# The port of the proxy on every TAP address. The nft table names it too
# (`docker/vm/host/outer-wall.nft`; a test holds the two equal).
PROXY_PORT: Final = 3128
# The words of a refusal the proxy adds to the door's.
REASON_NO_JOB: Final = "no_job"
REASON_WRONG_SOURCE: Final = "wrong_source"
VOICE: Final = "outer wall"


class OuterWallUnavailable(Exception):
    """The wall cannot be made (a listener cannot be bound). The log names the TAP; this carries
    nothing more."""


@dataclass(frozen=True)
class SlotAddresses:
    """The two ends of a slot's /30: the host's, where the proxy listens, and the guest's."""

    host: str
    guest: str


def tap_addresses(slot: Slot) -> SlotAddresses:
    return SlotAddresses(slot.host_address, slot.guest_address)


class SlotDecider(Decider):
    """The decision of one slot's proxy: the rule of the VM that holds the slot, or a refusal when
    none does. The proxy's threads call `decide`; the wall's loop calls `hold` and `release`. It is
    a `Decider` for the proxy's sake; the rule it decides by is the holder's own."""

    def __init__(self, resolver: Resolver) -> None:
        super().__init__(WIDE, ConnectionLog(), resolver=resolver)
        self._resolver = resolver
        self._lock = threading.Lock()
        self._holder: str | None = None
        self._decider: Decider | None = None

    def hold(self, vm_id: str, rule: NetworkRule) -> None:
        decider = Decider(rule, self.log, resolver=self._resolver)
        with self._lock:
            self._holder, self._decider = vm_id, decider

    def release(self, vm_id: str) -> bool:
        """Drop the rule of `vm_id`. False (and nothing dropped) when another VM holds the slot."""
        with self._lock:
            if self._holder != vm_id:
                return False
            self._holder, self._decider = None, None
            return True

    @property
    def holder(self) -> str | None:
        with self._lock:
            return self._holder

    @override
    def decide(self, host: str, port: int) -> Decision:
        with self._lock:
            decider = self._decider
        if decider is None:
            return Decision(reason=REASON_NO_JOB)
        return decider.decide(host, port)


class SlotProxyServer(ProxyServer):
    """The door's proxy bound to one TAP address, serving only the slot's own guest, and able to end
    every connection it holds (the setup's, at `narrow`)."""

    def __init__(
        self,
        bind: tuple[str, int],
        decider: SlotDecider,
        guest: str,
        *,
        connector: Connector,
    ) -> None:
        self._guest = guest
        self._slot_decider = decider
        self._open: set[socket.socket] = set()
        self._open_lock = threading.Lock()
        super().__init__(bind, decider, connector=connector, voice=VOICE)

    def verify_request(self, request: Any, client_address: Any) -> bool:
        if client_address[0] == self._guest:
            return True
        self.log.add("", 0, OUTCOME_REFUSED, REASON_WRONG_SOURCE)
        return False

    def process_request(self, request: Any, client_address: Any) -> None:
        with self._open_lock:
            self._open.add(request)
        super().process_request(request, client_address)

    def shutdown_request(self, request: Any) -> None:
        with self._open_lock:
            self._open.discard(request)
        super().shutdown_request(request)

    def end_connections(self) -> None:
        """Shut every client connection that is open: its handler ends and closes the upstream."""
        with self._open_lock:
            sockets = list(self._open)
        for each in sockets:
            with contextlib.suppress(OSError):
                each.shutdown(socket.SHUT_RDWR)


@dataclass
class _Held:
    vm_id: str
    app_host: str | None
    allowed: int
    refused: int


class ProxyOuterWall:
    """`OuterWall` and `WallLifecycle` of the proxy. One per dispatcher."""

    def __init__(
        self,
        slots: int,
        *,
        port: int = PROXY_PORT,
        addresses: Callable[[Slot], SlotAddresses] = tap_addresses,
        resolver: Resolver = system_resolver,
        connector: Connector = tcp_connector,
    ) -> None:
        self._count = slots
        self._port = port
        self._addresses = addresses
        self._resolver = resolver
        self._connector = connector
        self._servers: dict[int, SlotProxyServer] = {}
        self._deciders: dict[int, SlotDecider] = {}
        self._held: dict[int, _Held] = {}

    # -- what is configured and what runs ---

    @property
    def configured_port(self) -> int:
        return self._port

    def addresses_of(self, slot: Slot) -> SlotAddresses:
        return self._addresses(slot)

    def port_of(self, slot: Slot) -> int:
        """The port the slot's proxy listens on (the configured one; the real one when it is 0)."""
        return self._servers[slot.index].port

    def listening(self) -> list[tuple[str, int]]:
        """The (address, port) of every listener that runs, by slot."""
        return [
            (str(server.server_address[0]), server.port)
            for _, server in sorted(self._servers.items())
        ]

    def log_of(self, slot: Slot) -> dict[str, Any]:
        """What the slot's proxy has decided (host, port, outcome, reason, bytes; never a path or a
        header), over every VM that held the slot since the service started."""
        return self._deciders[slot.index].log.snapshot()

    # -- lifecycle ---

    async def start(self) -> None:
        if self._servers:
            return
        await asyncio.to_thread(self._start_all)

    def _start_all(self) -> None:
        try:
            for index in range(self._count):
                slot = Slot(index)
                ends = self._addresses(slot)
                decider = SlotDecider(self._resolver)
                try:
                    server = SlotProxyServer(
                        (ends.host, self._port), decider, ends.guest, connector=self._connector
                    )
                except OSError as error:
                    _log.error(
                        "the outer wall's proxy cannot listen on %s:%d for %s (%s): is the TAP "
                        "device made and its address set?",
                        ends.host,
                        self._port,
                        slot.tap,
                        error.strerror or type(error).__name__,
                    )
                    raise OuterWallUnavailable(slot.tap) from None
                server.start()
                self._servers[index] = server
                self._deciders[index] = decider
        except BaseException:
            self._stop_all()
            raise

    async def close(self) -> None:
        await asyncio.to_thread(self._stop_all)

    def _stop_all(self) -> None:
        servers, self._servers = self._servers, {}
        self._deciders = {}
        self._held = {}
        for server in servers.values():
            with contextlib.suppress(Exception):
                server.end_connections()
                server.stop()

    # -- the OuterWall ---

    async def admit(self, vm: VmIdentity) -> None:
        decider = self._deciders.get(vm.slot.index)
        if decider is None:
            raise OuterWallUnavailable(vm.slot.tap)
        snapshot = decider.log.snapshot()
        self._held[vm.slot.index] = _Held(
            vm.vm_id, vm.app_host, int(snapshot["allowed"]), int(snapshot["refused"])
        )
        decider.hold(vm.vm_id, WIDE)

    async def narrow(self, vm: VmIdentity, message: NarrowMessage) -> Refusal | None:
        index = vm.slot.index
        decider, held = self._deciders.get(index), self._held.get(index)
        if decider is None or held is None or held.vm_id != vm.vm_id:
            _log.error("%s: narrow refused: the outer wall does not know this VM", vm.vm_id)
            return Refusal.UNAVAILABLE
        try:
            rule = narrowed_rule(message.rule, message.model_host, held.app_host)
        except OuterRuleError as error:
            _log.error("%s: narrow refused: %s", vm.vm_id, error)
            return Refusal.UNAVAILABLE
        decider.hold(vm.vm_id, rule)
        # The setup's tunnels were opened under the wide rule and must not outlive it.
        self._servers[index].end_connections()
        return None

    async def forget(self, vm: VmIdentity) -> None:
        index = vm.slot.index
        decider, held = self._deciders.get(index), self._held.get(index)
        if decider is None or held is None or held.vm_id != vm.vm_id:
            return
        decider.release(vm.vm_id)
        self._held.pop(index, None)
        with contextlib.suppress(Exception):
            self._servers[index].end_connections()
            snapshot = decider.log.snapshot()
            _log.info(
                "%s: outer wall: %d connections allowed, %d refused",
                vm.vm_id,
                int(snapshot["allowed"]) - held.allowed,
                int(snapshot["refused"]) - held.refused,
            )
