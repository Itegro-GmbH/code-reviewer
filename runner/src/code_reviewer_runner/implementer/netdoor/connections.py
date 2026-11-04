# SPDX-License-Identifier: LicenseRef-Proprietary

"""What the network door tells of the connections it saw (#745, step 7): host, port, allowed or
refused, and the bytes, nothing of the content. One entry for each distinct host, port, outcome and
reason, with a count, so that an agent that opens ten thousand connections cannot make the report
long: the door keeps at most `MAX_KEYS` entries, the report lists the first `REPORT_ENTRIES`, and
the totals count every connection.

A host is whatever the request said, cleaned to printable ASCII and cut to 253 characters: it is a
string the agent chose, shown as plain text and never read as anything else.
"""

import threading
from dataclasses import dataclass
from typing import Any, Final

MAX_KEYS: Final = 1000
REPORT_ENTRIES: Final = 100
MAX_HOST_CHARS: Final = 253
OUTCOME_ALLOWED: Final = "allowed"
OUTCOME_REFUSED: Final = "refused"

# The words of a refusal (`ImplementerNetworkReport.connections[].reason`).
REASON_NOT_LISTED: Final = "not_listed"
REASON_IP_LITERAL: Final = "ip_literal"
REASON_PORT: Final = "port_not_allowed"
REASON_BAD_REQUEST: Final = "bad_request"
REASON_TOO_MANY: Final = "too_many_connections"
REASON_UPSTREAM: Final = "upstream_failed"


def clean_host(text: str) -> str:
    """The host as the report shows it: printable ASCII, a `?` for anything else, 253 at most."""
    return "".join(c if 0x21 <= ord(c) < 0x7F else "?" for c in text[:MAX_HOST_CHARS])


@dataclass
class _Entry:
    count: int = 0
    bytes_in: int = 0
    bytes_out: int = 0


class ConnectionLog:
    """The aggregate. Thread safe: every connection of the door adds to it."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._entries: dict[tuple[str, int, str, str | None], _Entry] = {}
        self._allowed = 0
        self._refused = 0
        self._bytes_in = 0
        self._bytes_out = 0
        self._overflow = 0
        self._version = 0

    @property
    def version(self) -> int:
        """Changes whenever something was added (a cheap way to tell whether to say it again)."""
        with self._lock:
            return self._version

    def add(
        self,
        host: str,
        port: int,
        outcome: str,
        reason: str | None,
        *,
        bytes_in: int = 0,
        bytes_out: int = 0,
        count: int = 1,
    ) -> None:
        """One connection (`count` 1 at its end, or at the refusal), or only bytes (`count` 0)."""
        key = (clean_host(host), port, outcome, reason)
        with self._lock:
            self._version += 1
            if outcome == OUTCOME_ALLOWED:
                self._allowed += count
            else:
                self._refused += count
            self._bytes_in += bytes_in
            self._bytes_out += bytes_out
            entry = self._entries.get(key)
            if entry is None:
                if len(self._entries) >= MAX_KEYS:
                    self._overflow += 1
                    return
                entry = self._entries[key] = _Entry()
            entry.count += count
            entry.bytes_in += bytes_in
            entry.bytes_out += bytes_out

    def snapshot(self) -> dict[str, Any]:
        """The totals and the entries, refusals first and then the most bytes, at most
        `REPORT_ENTRIES`; `dropped` counts the entries that were left out."""
        with self._lock:
            ranked = sorted(
                self._entries.items(),
                key=lambda item: (
                    item[0][2] != OUTCOME_REFUSED,
                    -(item[1].bytes_in + item[1].bytes_out),
                    -item[1].count,
                    item[0][0],
                ),
            )
            listed = ranked[:REPORT_ENTRIES]
            return {
                "allowed": self._allowed,
                "refused": self._refused,
                "bytesIn": self._bytes_in,
                "bytesOut": self._bytes_out,
                "dropped": len(ranked) - len(listed) + self._overflow,
                "connections": [
                    {
                        "host": key[0],
                        "port": key[1],
                        "outcome": key[2],
                        "reason": key[3],
                        "count": entry.count,
                        "bytesIn": entry.bytes_in,
                        "bytesOut": entry.bytes_out,
                    }
                    for key, entry in listed
                ],
            }
