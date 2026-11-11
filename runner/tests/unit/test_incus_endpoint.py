# SPDX-License-Identifier: LicenseRef-Proprietary

"""The host's end of a job's environment control on the Unix socket (#1007, `ControlListener`) over
real sockets, with a session that records what reaches it: a frame outside the contract (too large,
slow, a byte after it) is closed and nothing about it reaches the session, and the listener serves
at most `MAX_CONNECTIONS` connections at a time."""

import asyncio
import contextlib
import struct
from collections.abc import Callable, Coroutine
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from incus_support import short_directory

from code_reviewer_runner.factory_runner.firecracker.endpoint import MAX_CONNECTIONS
from code_reviewer_runner.factory_runner.firecracker.wire import (
    MAX_CONTROL_FRAME_BYTES,
    encode_frame,
    read_frame,
)
from code_reviewer_runner.factory_runner.incus.endpoint import ControlListener

pytestmark = pytest.mark.unit

REQUEST = {"version": 1, "type": "end", "token": "t" * 43, "status": 0}
REPLY = {"version": 1, "type": "ack", "for": "end"}


def go(scenario: Callable[[], Coroutine[Any, Any, Any]]) -> Any:
    return asyncio.run(scenario())


class RecordingSession:
    """What the listener is given as a session: it records every document and answers REPLY (or
    nothing)."""

    def __init__(self, reply: dict[str, Any] | None = REPLY) -> None:
        self.vm = SimpleNamespace(vm_id="0-test")
        self.reply = reply
        self.documents: list[dict[str, Any]] = []

    async def control(self, document: dict[str, Any]) -> dict[str, Any] | None:
        self.documents.append(document)
        return self.reply


class Listening:
    def __init__(self, root: Path, session: RecordingSession, frame_seconds: float) -> None:
        self.session = session
        self.path = root / "ctl.sock"
        self.listener = ControlListener(
            self.path,
            session,  # pyright: ignore[reportArgumentType]
            frame_seconds=frame_seconds,
        )

    async def __aenter__(self) -> "Listening":
        await self.listener.start()
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.listener.close()

    async def connect(self) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
        return await asyncio.open_unix_connection(str(self.path))


async def reply_of(reader: asyncio.StreamReader, seconds: float = 2.0) -> bytes:
    """What the listener sent before it closed the connection (b"" for nothing)."""
    return await asyncio.wait_for(reader.read(), seconds)


# #1007-T02
def test_a_whole_frame_is_answered_once_and_the_connection_is_closed() -> None:
    with short_directory() as root:
        session = RecordingSession()

        async def scenario() -> Any:
            async with Listening(root, session, 2.0) as listening:
                reader, writer = await listening.connect()
                writer.write(encode_frame(REQUEST))
                await writer.drain()
                answer = await read_frame(reader, max_bytes=65536)
                rest = await reply_of(reader)
                writer.close()
                return answer, rest, listening.path.stat().st_mode & 0o777

        answer, rest, mode = go(scenario)

        assert answer == REPLY and rest == b"" and session.documents == [REQUEST]
        assert mode == 0o600


# #1007-T02
def test_a_frame_longer_than_the_contract_allows_is_closed_and_never_reaches_the_session() -> None:
    with short_directory() as root:
        session = RecordingSession()

        async def scenario() -> Any:
            async with Listening(root, session, 2.0) as listening:
                reader, writer = await listening.connect()
                # The header alone names a length one past the limit; no body is needed to refuse.
                writer.write(struct.pack(">I", MAX_CONTROL_FRAME_BYTES + 1))
                await writer.drain()
                answer = await reply_of(reader)
                writer.close()
                # Zero is as outside as too large.
                reader, writer = await listening.connect()
                writer.write(struct.pack(">I", 0))
                await writer.drain()
                zero = await reply_of(reader)
                writer.close()
                return answer, zero, listening.listener

        answer, zero, listener = go(scenario)

        assert answer == b"" and zero == b"" and session.documents == []
        assert listener._open == 0  # pyright: ignore[reportPrivateUsage]


# #1007-T02
def test_a_frame_that_is_not_whole_in_time_is_closed_and_the_listener_serves_the_next() -> None:
    with short_directory() as root:
        session = RecordingSession()

        async def scenario() -> Any:
            async with Listening(root, session, 0.2) as listening:
                reader, writer = await listening.connect()
                # Two bytes of a header, then nothing: a slow sender holds a connection for the
                # frame's time and no longer.
                writer.write(b"\x00\x00")
                await writer.drain()
                slow = await reply_of(reader)
                writer.close()
                reader, writer = await listening.connect()
                writer.write(encode_frame(REQUEST))
                await writer.drain()
                good = await read_frame(reader, max_bytes=65536)
                writer.close()
                return slow, good, listening.listener

        slow, good, listener = go(scenario)

        assert slow == b"" and good == REPLY and session.documents == [REQUEST]
        assert listener._open == 0  # pyright: ignore[reportPrivateUsage]


# #1007-T02
def test_a_byte_after_the_frame_closes_the_connection_with_no_reply_and_no_effect() -> None:
    with short_directory() as root:
        session = RecordingSession()

        async def scenario() -> Any:
            async with Listening(root, session, 2.0) as listening:
                reader, writer = await listening.connect()
                writer.write(encode_frame(REQUEST) + b"\x00")
                await writer.drain()
                answer = await reply_of(reader)
                writer.close()
                return answer

        answer = go(scenario)

        assert answer == b"" and session.documents == []


# #1007-T02
def test_a_request_the_session_does_not_answer_is_closed_without_a_reply() -> None:
    with short_directory() as root:
        session = RecordingSession(reply=None)

        async def scenario() -> bytes:
            async with Listening(root, session, 2.0) as listening:
                reader, writer = await listening.connect()
                writer.write(encode_frame(REQUEST))
                await writer.drain()
                answer = await reply_of(reader)
                writer.close()
                return answer

        assert go(scenario) == b"" and session.documents == [REQUEST]


# #1007-T02
def test_at_most_max_connections_are_served_at_once_and_the_rest_are_closed_at_once() -> None:
    with short_directory() as root:
        session = RecordingSession()

        async def scenario() -> Any:
            async with Listening(root, session, 5.0) as listening:
                held = [await listening.connect() for _ in range(MAX_CONNECTIONS)]
                # Let the listener take them all (each waits for its frame).
                for _ in range(100):
                    if listening.listener._open == MAX_CONNECTIONS:  # pyright: ignore[reportPrivateUsage]
                        break
                    await asyncio.sleep(0.01)
                over: list[bytes] = []
                for _ in range(3):
                    reader, writer = await listening.connect()
                    over.append(await reply_of(reader, 1.0))
                    writer.close()
                # A held connection is still waiting for its frame (served, not dropped) ...
                still = await asyncio.gather(
                    *(asyncio.wait_for(reader.read(1), 0.1) for reader, _ in held),
                    return_exceptions=True,
                )
                # ... and once one is released, a new connection is served again.
                _, first_writer = held[0]
                first_writer.close()
                for _ in range(100):
                    if listening.listener._open < MAX_CONNECTIONS:  # pyright: ignore[reportPrivateUsage]
                        break
                    await asyncio.sleep(0.01)
                reader, writer = await listening.connect()
                writer.write(encode_frame(REQUEST))
                await writer.drain()
                served = await read_frame(reader, max_bytes=65536)
                writer.close()
                for _, each in held[1:]:
                    each.close()
                return over, still, served

        over, still, served = go(scenario)

        assert over == [b""] * 3
        assert all(isinstance(each, TimeoutError) for each in still)
        assert served == REPLY and session.documents == [REQUEST]


def test_closing_the_listener_removes_its_socket_and_a_second_close_is_fine() -> None:
    with short_directory() as root:

        async def scenario() -> bool:
            listening = Listening(root, RecordingSession(), 1.0)
            await listening.listener.start()
            made = listening.path.exists()
            await listening.listener.close()
            with contextlib.suppress(Exception):
                await listening.listener.close()
            return made and not listening.path.exists()

        assert go(scenario) is True
