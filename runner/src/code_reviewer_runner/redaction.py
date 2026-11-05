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


# Base64 turns three bytes into four characters, so a secret that sits inside a larger value starts
# at the first, second or third byte of a group (the alignment, 0, 1 or 2). The leading characters
# that the bytes before the secret take part in, and the last character the bytes after it take
# part in, say nothing about the secret and are cut off: what is left is the same wherever the
# secret sits.
_LEADING_CHARS_BY_ALIGNMENT = (0, 2, 3)
# A cut form shorter than this would match everywhere (the whole encoding of a short secret is
# kept).
_MIN_CUT_FORM_CHARS = 8


def _base64_forms(secret: str) -> set[str]:
    """The base64 spellings of a secret in both alphabets, with and without padding, wherever it
    starts in a group of three bytes."""
    raw = secret.encode()
    forms: set[str] = set()
    for encode in (base64.b64encode, base64.urlsafe_b64encode):
        forms.add(encode(raw).decode())
        for alignment, leading in enumerate(_LEADING_CHARS_BY_ALIGNMENT):
            padded = encode(bytes(alignment) + raw).decode()
            unpadded = padded.rstrip("=")
            # The last character of a group that is not full takes bits of the next byte.
            trailing = 1 if (alignment + len(raw)) % 3 else 0
            for form in (padded[leading:], unpadded[leading : len(unpadded) - trailing]):
                if alignment == 0 or len(form) >= _MIN_CUT_FORM_CHARS:
                    forms.add(form)
    return forms


def secret_forms(secret: str) -> set[str]:
    """The spellings a secret travels in: as it is, URL-quoted and base64 (both alphabets, with and
    without padding, at every alignment inside a larger value). The redactor replaces them and the
    push guard (`implementer/push_guard.py`) looks for them."""
    return {
        secret,
        quote(secret, safe=""),
        quote(secret),
        quote_plus(secret),
        *_base64_forms(secret),
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

    def redact_known(self, text: str) -> str:
        """Only the exact secrets and their spellings, not the token shapes: for facts that are
        data (a commit subject, a branch name, a path), where "authorization: ..." in a subject is
        no secret."""
        for value in self._values:
            text = text.replace(value, REDACTED)
        return text

    def redact(self, text: str) -> str:
        text = self.redact_known(text)
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
