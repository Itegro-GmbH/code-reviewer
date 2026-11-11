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
  hosted second wall's list of names) and drops the connections the setup left open, both halves of
  each tunnel; it returns, and so the host answers `ack`, only when the rule is held. A decision
  carries the generation of the rule it was made under and is dropped, before the connection and
  again before the first byte is sent, when `narrow` or `forget` came in between. `forget` takes the
  VM's rule away. A slot with no VM serves nobody. Changing a rule never touches nft.
* **DNS is the proxy's.** A guest asks for `CONNECT name:443` (or an absolute-form HTTP request) and
  the proxy looks the name up; the guest has no name server it can reach. The decision is the
  network door's (`implementer/netdoor/proxy.py`, which this reuses on purpose: an address is never
  a name, only 80 and 443, the rule lists the name before any lookup, every address must be public,
  and the connection goes to an address that was checked, never to the name again).

The proxy has no way to be told a test network: the door's `NETDOOR_TEST_PUBLIC_CIDR` seam is not
used here, so no setting can open a private range for a VM. Besides the private ranges the proxy
refuses every address the host itself has (`host_addresses.py`): a name that resolves to the
machine it runs on is not "the internet".

**Limits of the process.** Each slot has its own cap of connections, and all slots share one budget
(`TOTAL_CONNECTIONS`): a connection holds two descriptors (the guest's and the origin's), so busy
slots cannot use up the descriptors of the dispatcher whatever the number of slots. A listener that
meets `EMFILE` backs off instead of spinning on its readable socket. The service's unit sets
`LimitNOFILE` to cover the budget (the installer, #982)."""

import asyncio
import contextlib
import errno
import itertools
import logging
import socket
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, replace
from typing import Any, Final, override

from code_reviewer_runner.implementer.netdoor.addresses import Resolver, system_resolver
from code_reviewer_runner.implementer.netdoor.connections import (
    OUTCOME_REFUSED,
    REASON_TOO_MANY,
    ConnectionLog,
)
from code_reviewer_runner.implementer.netdoor.proxy import (
    MAX_CONNECTIONS,
    Connector,
    Decider,
    Decision,
    ProxyServer,
    tcp_connector,
)
from code_reviewer_runner.implementer.netdoor.wire import respond
from code_reviewer_runner.implementer.network_rule import NetworkRule

from .host_addresses import HostAddresses
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
# Connections over all slots (two descriptors each, with the pump threads' sockets shared): under
# the 8192 descriptors the unit asks for, with room for the launcher's own files.
TOTAL_CONNECTIONS: Final = 256
# What `accept` meets when the process or the machine is out of descriptors or memory.
_OUT_OF_RESOURCES: Final = (errno.EMFILE, errno.ENFILE, errno.ENOBUFS, errno.ENOMEM)
ACCEPT_BACKOFF_SECONDS: Final = 0.2
ACCEPT_WARN_SECONDS: Final = 10.0


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

    def __init__(self, resolver: Resolver, excluded: Callable[[str], bool] | None = None) -> None:
        super().__init__(WIDE, ConnectionLog(), resolver=resolver, excluded=excluded)
        self._resolver = resolver
        self._excluded = excluded
        self._lock = threading.Lock()
        self._holder: str | None = None
        self._decider: Decider | None = None
        self._generation = 0

    def hold(self, vm_id: str, rule: NetworkRule) -> None:
        decider = Decider(rule, self.log, resolver=self._resolver, excluded=self._excluded)
        with self._lock:
            self._holder, self._decider = vm_id, decider
            self._generation += 1

    def release(self, vm_id: str) -> bool:
        """Drop the rule of `vm_id`. False (and nothing dropped) when another VM holds the slot."""
        with self._lock:
            if self._holder != vm_id:
                return False
            self._holder, self._decider = None, None
            self._generation += 1
            return True

    @property
    def holder(self) -> str | None:
        with self._lock:
            return self._holder

    @property
    def generation(self) -> int:
        """The version of the slot's rule: every `hold` and `release` makes a new one."""
        with self._lock:
            return self._generation

    @override
    def decide(self, host: str, port: int) -> Decision:
        # The generation is read with the rule, so a decision carries the one it was made under.
        with self._lock:
            decider, generation = self._decider, self._generation
        if decider is None:
            return Decision(reason=REASON_NO_JOB, generation=generation)
        return replace(decider.decide(host, port), generation=generation)


class SlotProxyServer(ProxyServer):
    """The door's proxy bound to one TAP address, serving only the slot's own guest, able to end
    every tunnel it holds (the setup's, at `narrow`; both halves, the guest's and the origin's), and
    drawing on a budget of connections shared with the other slots."""

    def __init__(
        self,
        bind: tuple[str, int],
        decider: SlotDecider,
        guest: str,
        *,
        connector: Connector,
        max_connections: int = MAX_CONNECTIONS,
        budget: threading.BoundedSemaphore | None = None,
    ) -> None:
        self._guest = guest
        self._slot_decider = decider
        self._budget = budget
        self._dial = connector
        self._open: set[socket.socket] = set()
        # The origin sockets of each handler thread, by thread: its tunnel's other half.
        self._upstream: dict[int, list[socket.socket]] = {}
        self._open_lock = threading.Lock()
        self._stopping = threading.Event()
        self._warned_at: float | None = None
        super().__init__(
            bind,
            decider,
            connector=self._track,
            max_connections=max_connections,
            voice=VOICE,
        )

    def verify_request(self, request: Any, client_address: Any) -> bool:
        if client_address[0] == self._guest:
            return True
        self.log.add("", 0, OUTCOME_REFUSED, REASON_WRONG_SOURCE)
        return False

    @override
    def is_current(self, decision: Decision) -> bool:
        return decision.generation == self._slot_decider.generation

    def _track(self, address: str, port: int, timeout: float) -> socket.socket:
        """The connector of the handlers: the origin socket is noted for the thread that made it,
        so that ending the guest's connection ends the origin's too."""
        upstream = self._dial(address, port, timeout)
        with self._open_lock:
            self._upstream.setdefault(threading.get_ident(), []).append(upstream)
        return upstream

    def process_request(self, request: Any, client_address: Any) -> None:
        if self._budget is not None and not self._budget.acquire(blocking=False):
            # Over the budget of all slots: refused here, with no thread and no permit taken.
            self.log.add("", 0, OUTCOME_REFUSED, REASON_TOO_MANY)
            with contextlib.suppress(OSError):
                request.settimeout(2.0)
                respond(request, 503, REASON_TOO_MANY, VOICE)
            self.shutdown_request(request)
            return
        with self._open_lock:
            self._open.add(request)
        super().process_request(request, client_address)

    def shutdown_request(self, request: Any) -> None:
        # Called by the handler's thread when it is done (and by the accepting thread for a request
        # it refused): only a request that was counted gives its share of the budget back.
        with self._open_lock:
            counted = request in self._open
            self._open.discard(request)
            self._upstream.pop(threading.get_ident(), None)
        if counted and self._budget is not None:
            self._budget.release()
        super().shutdown_request(request)

    def open_count(self) -> int:
        """The guests' connections that are open (a handler that has not returned yet)."""
        with self._open_lock:
            return len(self._open)

    def end_connections(self) -> None:
        """Shut every tunnel that is open, the guest's half and the origin's: the pump of each ends
        at once, the handler returns, and its permit is given back. An origin that says nothing and
        never closes cannot hold a slot of the proxy."""
        with self._open_lock:
            sockets = [*self._open, *itertools.chain.from_iterable(self._upstream.values())]
        for each in sockets:
            with contextlib.suppress(OSError):
                each.shutdown(socket.SHUT_RDWR)

    @override
    def get_request(self) -> tuple[socket.socket, Any]:
        try:
            return super().get_request()
        except OSError as error:
            if error.errno in _OUT_OF_RESOURCES:
                self._back_off(error)
            raise

    def _back_off(self, error: OSError) -> None:
        """`accept` failed for want of descriptors: the listener is still readable, so returning at
        once would spin. Say so (rarely) and wait."""
        now = time.monotonic()
        if self._warned_at is None or now - self._warned_at >= ACCEPT_WARN_SECONDS:
            self._warned_at = now
            _log.warning(
                "the outer wall's proxy is out of file descriptors (%s) and backs off: the "
                "service's LimitNOFILE is too small for its connections",
                error.strerror or type(error).__name__,
            )
        self._stopping.wait(ACCEPT_BACKOFF_SECONDS)

    @override
    def stop(self) -> None:
        self._stopping.set()
        super().stop()


@dataclass
class _Held:
    vm_id: str
    app_host: str | None
    app_port: int | None
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
        slot_connections: int = MAX_CONNECTIONS,
        total_connections: int = TOTAL_CONNECTIONS,
        host_addresses: HostAddresses | None = None,
    ) -> None:
        self._count = slots
        self._port = port
        self._addresses = addresses
        self._resolver = resolver
        self._connector = connector
        self._slot_connections = slot_connections
        self._budget = threading.BoundedSemaphore(total_connections)
        self._host_addresses = HostAddresses() if host_addresses is None else host_addresses
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

    def open_connections(self, slot: Slot) -> int:
        """The guest connections of the slot's proxy that are open."""
        return self._servers[slot.index].open_count()

    def log_of(self, slot: Slot) -> dict[str, Any]:
        """What the slot's proxy has decided (host, port, outcome, reason, bytes; never a path or a
        header), over every VM that held the slot since the service started."""
        return self._deciders[slot.index].log.snapshot()

    # -- lifecycle ---

    async def start(self) -> None:
        if self._servers:
            return
        _log.warning(
            "the outer wall's proxy is on (FACTORY_RUNNER_OUTER_WALL=proxy): this dispatcher "
            "cannot verify that the nft table `code_reviewer_wall` is loaded (a normal user cannot "
            "read nft state), so without it a VM has no outer wall; the installer must verify the "
            "table before it sets the proxy"
        )
        await asyncio.to_thread(self._start_all)

    def _start_all(self) -> None:
        try:
            self._host_addresses.refresh()
        except OSError as error:
            _log.error(
                "the addresses of this host cannot be read (%s): the outer wall cannot refuse a "
                "name that resolves to the host itself",
                error.strerror or error,
            )
            raise OuterWallUnavailable("host addresses") from None
        try:
            for index in range(self._count):
                slot = Slot(index)
                ends = self._addresses(slot)
                decider = SlotDecider(self._resolver, self._host_addresses.contains)
                try:
                    server = SlotProxyServer(
                        (ends.host, self._port),
                        decider,
                        ends.guest,
                        connector=self._connector,
                        max_connections=self._slot_connections,
                        budget=self._budget,
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
            vm.vm_id, vm.app_host, vm.app_port, int(snapshot["allowed"]), int(snapshot["refused"])
        )
        decider.hold(vm.vm_id, WIDE)

    async def narrow(self, vm: VmIdentity, message: NarrowMessage) -> Refusal | None:
        index = vm.slot.index
        decider, held = self._deciders.get(index), self._held.get(index)
        if decider is None or held is None or held.vm_id != vm.vm_id:
            _log.error("%s: narrow refused: the outer wall does not know this VM", vm.vm_id)
            return Refusal.UNAVAILABLE
        try:
            rule = narrowed_rule(message.rule, message.model_host, held.app_host, held.app_port)
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
