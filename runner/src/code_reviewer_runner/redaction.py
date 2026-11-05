# SPDX-License-Identifier: LicenseRef-Proprietary

"""Secret redaction for everything the runner lets out: logs, stdout, stderr and the result.

Two layers. First the exact secrets of the job (and their URL-quoted and base64 forms) are replaced,
which catches anything that was in the job. Then well known token shapes are replaced, which catches
secrets the runner does not know about (a token PR-Agent fetched itself, for example).
"""

import base64
import re
from collections.abc import Iterable
from typing import TextIO
from urllib.parse import quote, quote_plus

REDACTED = "[REDACTED]"
_MIN_GUARD_CHARS = 256

_PATTERNS = tuple(
    re.compile(pattern)
    for pattern in (
        r"gh[pousr]_[A-Za-z0-9]{20,}",
        r"github_pat_[A-Za-z0-9_]{20,}",
        r"sk-or-v1-[A-Za-z0-9]{20,}",
        r"sk-[A-Za-z0-9_-]{20,}",
        r"(?i)(?:authorization|bearer)[:= ]+(?:bearer |token |basic )?[^\s\"']+",
        r"(?<=://)[^/\s:@]+:[^@\s/]+(?=@)",
    )
)


def secret_forms(secret: str) -> set[str]:
    """The spellings a secret travels in: as it is, URL-quoted and base64 (both alphabets). The
    redactor replaces them and the push guard (`implementer/push_guard.py`) looks for them."""
    return {
        secret,
        quote(secret, safe=""),
        quote(secret),
        quote_plus(secret),
        base64.b64encode(secret.encode()).decode(),
        base64.urlsafe_b64encode(secret.encode()).decode(),
    }


class Redactor:
    def __init__(self, secrets: Iterable[str]) -> None:
        values: set[str] = set()
        for secret in secrets:
            if secret.strip():
                values |= secret_forms(secret)
        # Longest first, so a secret that contains another one is replaced as a whole.
        self._values = sorted(values, key=len, reverse=True)
        self.longest = len(self._values[0]) if self._values else 0

    def redact(self, text: str) -> str:
        for value in self._values:
            text = text.replace(value, REDACTED)
        for pattern in _PATTERNS:
            text = pattern.sub(REDACTED, text)
        return text


class RedactingStream:
    """A text stream that redacts line by line before passing text on.

    Text is held back until a line is complete, because a secret may arrive in several writes.
    A line longer than `max_line_chars` is released in redacted chunks, always holding back a tail
    at least as long as the longest known secret, so memory stays bounded and a secret that
    straddles a chunk boundary is still seen whole.
    """

    def __init__(self, target: TextIO, redactor: Redactor, *, max_line_chars: int = 65536) -> None:
        self._target = target
        self._redactor = redactor
        self._max_line_chars = max_line_chars
        self._pending = ""
        self.encoding = "utf-8"
        self.errors = "replace"

    def write(self, text: str) -> int:
        self._pending += text
        *lines, self._pending = self._pending.split("\n")
        for line in lines:
            self._target.write(self._redactor.redact(line) + "\n")
        if len(self._pending) > self._max_line_chars:
            guard = max(self._redactor.longest, _MIN_GUARD_CHARS)
            redacted = self._redactor.redact(self._pending)
            self._target.write(redacted[:-guard])
            self._pending = redacted[-guard:]
        return len(text)

    def flush(self) -> None:
        self._target.flush()

    def close(self) -> None:
        if self._pending:
            self._target.write(self._redactor.redact(self._pending))
            self._pending = ""
        self._target.flush()

    def isatty(self) -> bool:
        return False

    def writable(self) -> bool:
        return True

    def fileno(self) -> int:
        raise OSError("RedactingStream has no file descriptor")
