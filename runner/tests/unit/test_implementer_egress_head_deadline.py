# SPDX-License-Identifier: LicenseRef-Proprietary

"""The deadline for a request head of the Implementer egress proxy, on a clock that is ours (#763).

A read that returns after the head's time is up must end the request with a 408, not hand a zero
or negative timeout to the next read.
"""

from types import SimpleNamespace

import pytest

from code_reviewer_runner.implementer import egress_proxy
from code_reviewer_runner.implementer.egress_proxy import EgressLimits, EgressProxy


class LateClient:
    """Every read takes 11 s of the (fake) clock and brings one byte."""

    def __init__(self, clock: SimpleNamespace) -> None:
        self.clock = clock
        self.timeouts: list[float] = []
        self.sent: list[bytes] = []

    def settimeout(self, value: float) -> None:
        self.timeouts.append(value)

    def recv(self, size: int) -> bytes:
        self.clock.now += 11
        return b"C"

    def sendall(self, data: bytes) -> None:
        self.sent.append(data)


# #763-T04
def test_a_byte_that_arrives_after_the_head_deadline_is_answered_with_408(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = SimpleNamespace(now=1000.0)
    monkeypatch.setattr(egress_proxy, "time", SimpleNamespace(monotonic=lambda: clock.now))
    client = LateClient(clock)
    proxy = EgressProxy(limits=EgressLimits(head_timeout=10))

    with pytest.raises(egress_proxy._Done):  # pyright: ignore[reportPrivateUsage]
        proxy._read_head(client)  # pyright: ignore[reportPrivateUsage, reportArgumentType]

    assert client.sent and client.sent[0].startswith(b"HTTP/1.1 408 ")
    assert all(timeout > 0 for timeout in client.timeouts)
