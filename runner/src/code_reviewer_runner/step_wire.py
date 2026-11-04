# SPDX-License-Identifier: LicenseRef-Proprietary

"""The steps channel between an Implementer job process and the job host (#745, live view).

The process holds the step records of its turn (`implementer/step_feed.py`) but neither the lease
token nor the Worker's credential; the host holds the credential and talks to the app. So the
records go over one more descriptor the host hands the process, a second socket pair beside the
lease question (`lease_check.py`, `RUNNER_STEPS_FD`), and only when the app lists the feature
`implementer_steps` (otherwise there is no channel, and the process records nothing).

Lines, each ending in a newline (the JSON of a body has none inside):

- process to host: `B <n> <body>`, a batch of `n` records, `<body>` being the exact request body of
  the steps call (`{"records":[...]}`, compact JSON with ASCII escapes);
- process to host: `F <seconds>`, the last flush: answer once everything received is sent, or
  after `seconds`, whichever comes first;
- host to process: `U <n>`, the answer to a flush: how many records the host received and could not
  send. The host closes its end when it stopped for good (the app said the lease is lost).

A body is held to `MAX_BODY_BYTES` **as it is sent**: the size is measured on the escaped JSON,
where one control character is six bytes and one emoji twelve. The app reads up to 64 KiB.
"""

import json
from collections.abc import Mapping, Sequence
from typing import Any, Final

STEPS_FD_VARIABLE: Final = "RUNNER_STEPS_FD"
# The feature of `GET /api/runners/v1/version` that says the steps calls exist.
FEATURE_IMPLEMENTER_STEPS: Final = "implementer_steps"

# The contract (`StepsRequest`): at most 50 records in at most 48 KiB.
MAX_BATCH_RECORDS: Final = 50
MAX_BODY_BYTES: Final = 48 * 1024
# A line is a body, `B `, a count of two digits and a space: far below this.
MAX_LINE_BYTES: Final = MAX_BODY_BYTES + 32

_BODY_HEAD: Final = '{"records":['
_BODY_TAIL: Final = "]}"
# What the body holds besides its records: the envelope.
ENVELOPE_BYTES: Final = len(_BODY_HEAD) + len(_BODY_TAIL)

BATCH: Final = b"B"
FLUSH: Final = b"F"
ANSWER: Final = b"U"
# The longest wait for a flush the host honours, whatever the process asks.
MAX_FLUSH_SECONDS: Final = 10.0


def encode_record(document: Mapping[str, Any]) -> str:
    """One record as the compact JSON the body holds, with ASCII escapes (as the body is sent)."""
    return json.dumps(document, separators=(",", ":"))


def body_of(records: Sequence[str]) -> bytes:
    return f"{_BODY_HEAD}{','.join(records)}{_BODY_TAIL}".encode("ascii")


def batch_line(count: int, body: bytes) -> bytes:
    return b"%s %d %s\n" % (BATCH, count, body)


def flush_line(seconds: float) -> bytes:
    return b"%s %.1f\n" % (FLUSH, seconds)


def answer_line(unsent: int) -> bytes:
    return b"%s %d\n" % (ANSWER, unsent)


def parse_batch(line: bytes) -> tuple[int, bytes] | None:
    """`(n, body)` of a batch line, or None when it is not a well formed one."""
    parts = line.rstrip(b"\n").split(b" ", 2)
    if len(parts) != 3 or parts[0] != BATCH or not parts[1].isdigit():
        return None
    count = int(parts[1])
    body = parts[2]
    if not 1 <= count <= MAX_BATCH_RECORDS or not body.startswith(_BODY_HEAD.encode("ascii")):
        return None
    if len(body) > MAX_BODY_BYTES or not body.endswith(_BODY_TAIL.encode("ascii")):
        return None
    return count, body


def parse_flush(line: bytes) -> float | None:
    """The seconds of a flush line, clamped to what the host honours; None for any other line."""
    parts = line.rstrip(b"\n").split(b" ")
    if len(parts) != 2 or parts[0] != FLUSH:
        return None
    try:
        seconds = float(parts[1])
    except ValueError:
        return None
    return min(max(seconds, 0.0), MAX_FLUSH_SECONDS) if seconds == seconds else None


def parse_answer(line: bytes) -> int | None:
    parts = line.rstrip(b"\n").split(b" ")
    if len(parts) != 2 or parts[0] != ANSWER or not parts[1].isdigit():
        return None
    return int(parts[1])
