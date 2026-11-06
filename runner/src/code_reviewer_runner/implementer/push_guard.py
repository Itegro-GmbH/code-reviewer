# SPDX-License-Identifier: LicenseRef-Proprietary

"""The push guard of a turn that runs on the device's login (#856).

The login (the token of `claude setup-token`) is in the environment of the agent's tools: Claude
Code needs it there, and a tool of the agent can print it. What the agent can then do with it is to
put it into the repository, and the runner's final push would carry it to the provider. So before a
branch is pushed, the runner reads what the branch adds (the commits, the trees with their names,
the blobs, and the name of the branch itself) for the token and for the spellings the redactor
knows (`redaction.secret_forms`: as it is, URL-quoted, base64 in both alphabets). A branch that
holds one is not pushed (`login_secret`); a branch that could not be read to its end is not pushed
either (`unchecked`): the guard fails closed.

This module is the bytes side: a scanner that finds the forms in a stream whatever the chunks are.
The git side (which objects, from where) is `GitWorkspace`.
"""

from collections.abc import Iterable
from typing import Final

from code_reviewer_runner.redaction import secret_forms

# The shortest secret the guard watches: a shorter value would match everywhere.
MIN_SECRET_CHARS: Final = 8


class SecretScanner:
    """Finds any of the forms of a set of secrets in bytes that arrive in chunks. Holds back the
    last bytes of a chunk (as long as the longest form less one), so a form that straddles two
    chunks is found."""

    def __init__(self, secrets: Iterable[str]) -> None:
        forms: set[bytes] = set()
        for secret in secrets:
            if len(secret.strip()) >= MIN_SECRET_CHARS:
                forms |= {form.encode("utf-8") for form in secret_forms(secret.strip())}
        self._forms = tuple(sorted(forms, key=len, reverse=True))
        self._keep = max((len(form) for form in forms), default=1) - 1
        self._tail = b""
        self.found = False

    @property
    def active(self) -> bool:
        """Whether there is anything to look for."""
        return bool(self._forms)

    def feed(self, chunk: bytes) -> bool:
        """Look at the next bytes; True once a form was found (and for every call after it)."""
        if self.found or not self._forms:
            return self.found
        data = self._tail + chunk
        if any(form in data for form in self._forms):
            self.found = True
            self._tail = b""
            return True
        self._tail = data[-self._keep :] if self._keep else b""
        return False

    def reset(self) -> None:
        """Forget what came before: the next bytes are the start of something new."""
        self._tail = b""

    def holds(self, text: str) -> bool:
        """Whether one short text (a branch name) holds a form."""
        data = text.encode("utf-8", errors="replace")
        return any(form in data for form in self._forms)
