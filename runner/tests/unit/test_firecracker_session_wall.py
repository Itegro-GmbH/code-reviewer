# SPDX-License-Identifier: LicenseRef-Proprietary

"""What the host answers to `narrow` when the outer wall misbehaves (#979, from the review of
#991): a wall that raises or hangs is answered `refused` `unavailable` within a timeout, never by
dropping the connection, so the Worker's job ends with a reason and the host's log says why."""

import asyncio
import logging
from typing import Any

import pytest

from code_reviewer_runner.factory_runner.firecracker.outer_wall import VmIdentity
from code_reviewer_runner.factory_runner.firecracker.session import VmSession
from code_reviewer_runner.factory_runner.firecracker.slots import Slot
from code_reviewer_runner.factory_runner.firecracker.tokens import generate_control_token
from code_reviewer_runner.factory_runner.firecracker.wire import NarrowMessage, Refusal

TOKEN = generate_control_token()
VM = VmIdentity("vm-0-abcd1234", Slot(0), "app.example.test")


def narrow_request(host: str = "api.example.com") -> dict[str, Any]:
    return {
        "version": 1,
        "type": "narrow",
        "network": {"mode": "off", "hosts": []},
        "modelHost": host,
        "token": TOKEN,
    }


class Wall:
    def __init__(self) -> None:
        self.narrowed = 0

    async def admit(self, vm: VmIdentity) -> None:
        _ = vm

    async def narrow(self, vm: VmIdentity, message: NarrowMessage) -> Refusal | None:
        _ = vm, message
        self.narrowed += 1
        return None

    async def forget(self, vm: VmIdentity) -> None:
        _ = vm


class RaisingWall(Wall):
    async def narrow(self, vm: VmIdentity, message: NarrowMessage) -> Refusal | None:
        _ = vm, message
        self.narrowed += 1
        raise RuntimeError("the wall broke: this text must not reach the Worker")


class HangingWall(Wall):
    def __init__(self) -> None:
        super().__init__()
        self.cancelled = False

    async def narrow(self, vm: VmIdentity, message: NarrowMessage) -> Refusal | None:
        _ = vm, message
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            self.cancelled = True
            raise
        return None


def session_for(wall: Wall, wall_seconds: float = 5.0) -> VmSession:
    return VmSession(VM, wall, TOKEN, start_acked=True, wall_seconds=wall_seconds)


def unavailable() -> dict[str, Any]:
    return {"version": 1, "type": "refused", "for": "narrow", "reason": "unavailable"}


# #979 (review of #991)
@pytest.mark.unit
def test_a_wall_that_raises_is_answered_unavailable_and_the_log_says_why(
    caplog: pytest.LogCaptureFixture,
) -> None:
    wall = RaisingWall()
    session = session_for(wall)

    with caplog.at_level(logging.ERROR):
        reply = asyncio.run(session.control(narrow_request()))

    assert reply == unavailable()
    assert session.narrowed is False
    assert "vm-0-abcd1234" in caplog.text and "RuntimeError" in caplog.text
    # The error's own text is for neither the Worker nor the log: it may name a value of the job.
    assert "must not reach" not in caplog.text


# #979 (review of #991)
@pytest.mark.unit
def test_a_wall_that_hangs_is_answered_unavailable_within_the_timeout(
    caplog: pytest.LogCaptureFixture,
) -> None:
    wall = HangingWall()
    session = session_for(wall, wall_seconds=0.2)

    async def scenario() -> tuple[dict[str, Any] | None, float]:
        started = asyncio.get_running_loop().time()
        reply = await session.control(narrow_request())
        return reply, asyncio.get_running_loop().time() - started

    with caplog.at_level(logging.ERROR):
        reply, took = asyncio.run(scenario())

    assert reply == unavailable()
    assert took < 2.0
    assert wall.cancelled, "the call to the wall was left running"
    assert "did not answer within" in caplog.text


# #979 (review of #991)
@pytest.mark.unit
def test_the_refusal_of_a_broken_wall_is_the_answer_to_the_same_request_again() -> None:
    wall = RaisingWall()
    session = session_for(wall)

    async def scenario() -> tuple[Any, Any]:
        return await session.control(narrow_request()), await session.control(narrow_request())

    first, second = asyncio.run(scenario())

    assert first == second == unavailable()
    assert wall.narrowed == 1


@pytest.mark.unit
def test_a_wall_that_holds_the_rule_is_acked_once() -> None:
    wall = Wall()
    session = session_for(wall)

    reply = asyncio.run(session.control(narrow_request()))

    assert reply == {"version": 1, "type": "ack", "for": "narrow"}
    assert session.narrowed is True and wall.narrowed == 1
