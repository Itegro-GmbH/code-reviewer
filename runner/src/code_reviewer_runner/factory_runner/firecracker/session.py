# SPDX-License-Identifier: LicenseRef-Proprietary

"""What the host decides about each message of one VM (#978): the token, the first exit report, the
answer to `narrow`.

One `VmSession` per VM; the connection is the VM's own, so nothing in a message names the VM. Every
message must carry the VM's token (`tokens.py`): something in the VM that is not Control or
vm-init (the agent's container, whatever it opens of AF_VSOCK) must not be able to narrow or end a
job or to report how it ended. The host takes the **first** exit report that passes the check and
answers every later one with the same `ack` (vm-init sends the report again when the `ack` did not
come, so the report is idempotent), and accepts a report without a token only while the start has
no `ack`."""

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any, Final

from .outer_wall import OuterWall, VmIdentity
from .tokens import TokenVerdict, verify_control_message, verify_exit_report
from .wire import (
    EndMessage,
    ExitMessage,
    NarrowMessage,
    ProtocolError,
    Refusal,
    ack,
    parse_control_request,
    parse_exit_report,
    refused,
    request_type,
)

_log = logging.getLogger(__name__)

# How long the host waits for its outer wall to hold a rule. The Worker waits 30 s for its answer
# (`NARROW_SECONDS` of the contract): the host answers before that, with a reason.
WALL_SECONDS: Final = 10.0


@dataclass
class VmSession:
    vm: VmIdentity
    wall: OuterWall
    token: str = field(repr=False)
    # How long `narrow` may take at the wall before the host answers `unavailable`.
    wall_seconds: float = WALL_SECONDS
    # Whether the host has an `ack` of vm-init for the start: from then on a job and an agent may
    # exist, and every message must carry the token.
    start_acked: bool = False
    report: ExitMessage | None = None
    # The status the Worker named in `end` (informational: the exit report is the authority).
    end_status: int | None = None
    narrowed: bool = False
    # What the host answered to the first `narrow`, for the same request again.
    _narrow_request: str | None = field(default=None, init=False)
    _narrow_reply: dict[str, Any] | None = field(default=None, init=False)
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock, init=False, repr=False)
    reported: asyncio.Event = field(default_factory=asyncio.Event, init=False, repr=False)

    # -- port 5100: the environment control ---

    async def control(self, document: dict[str, Any]) -> dict[str, Any] | None:
        """The reply to one request of the environment control, or None to close the connection
        without one."""
        kind = request_type(document)
        try:
            message = parse_control_request(document)
        except ProtocolError as error:
            _log.warning("%s: a request that is not the contract's (%s)", self.vm.vm_id, error)
            return None if kind is None else refused(kind, Refusal.INVALID_REQUEST)
        if (
            not self.start_acked
            or verify_control_message(
                {"token": message.token} if message.token is not None else {}, self.token
            )
            is not TokenVerdict.OK
        ):
            # No word about which: the token is missing or wrong, or no job runs yet.
            _log.warning("%s: a %s without the VM's token is refused", self.vm.vm_id, kind)
            return refused(message_kind(message), Refusal.INVALID_REQUEST)
        if isinstance(message, EndMessage):
            self.end_status = message.exit_code
            return ack("end")
        return await self._narrow(message)

    async def _narrow(self, message: NarrowMessage) -> dict[str, Any]:
        async with self._lock:
            request = message.canonical()
            if self._narrow_request is not None:
                # Both requests are idempotent: the same one is answered the same way; another one
                # after the first is not a request of this job.
                if request == self._narrow_request and self._narrow_reply is not None:
                    return self._narrow_reply
                return refused("narrow", Refusal.INVALID_REQUEST)
            refusal = await self._ask_wall(message)
            reply = ack("narrow") if refusal is None else refused("narrow", refusal)
            self._narrow_request, self._narrow_reply = request, reply
            self.narrowed = refusal is None
            return reply

    async def _ask_wall(self, message: NarrowMessage) -> Refusal | None:
        """The wall's answer to `narrow`. A wall that raises or does not answer in time is
        `unavailable`: a dropped connection would leave the Worker to wait for its own timeout
        with the failure unexplained in the host's log. Only the kind of the error is logged: its
        text may name a value of the job."""
        try:
            async with asyncio.timeout(self.wall_seconds):
                return await self.wall.narrow(self.vm, message)
        except TimeoutError:
            _log.error(
                "%s: the outer wall did not answer within %gs: narrow refused",
                self.vm.vm_id,
                self.wall_seconds,
            )
        except Exception as error:
            _log.error(
                "%s: the outer wall failed (%s): narrow refused",
                self.vm.vm_id,
                type(error).__name__,
            )
        return Refusal.UNAVAILABLE

    # -- port 5101: the exit report ---

    def exit_report(self, document: dict[str, Any]) -> dict[str, Any] | None:
        """The reply to one exit report, or None to close the connection without one."""
        try:
            message = parse_exit_report(document)
        except ProtocolError as error:
            _log.warning("%s: an exit report that is not the contract's (%s)", self.vm.vm_id, error)
            return None
        verdict = verify_exit_report(
            _token_of(message.token), expected=self.token, start_acked=self.start_acked
        )
        if verdict is not TokenVerdict.OK:
            _log.warning("%s: an exit report without the VM's token is refused", self.vm.vm_id)
            return None
        if self.report is None:
            self.report = message
            self.reported.set()
            _log.info(
                "%s: exit report taken: %s (%d)", self.vm.vm_id, message.reason, message.exit_code
            )
        return ack("exit")


def _token_of(token: str | None) -> dict[str, Any]:
    """The part of a message the token's check reads: no `token` field is not an empty one."""
    return {} if token is None else {"token": token}


def message_kind(message: NarrowMessage | EndMessage) -> str:
    return "narrow" if isinstance(message, NarrowMessage) else "end"
