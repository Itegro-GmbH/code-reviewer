# SPDX-License-Identifier: LicenseRef-Proprietary

"""The verdict of the startup self-check: which engines a container may advertise, and why not.

It is the one shape that the `probe` entry mode prints and that the engines file holds (#324). It
carries engines (`pr-agent`, `opencode` and, in an Implementer container whose own check passed too,
`implementer`, #765) and stable reasons (`SelfCheckReason` values) and nothing else: no path, no
environment, no value of the container. A launcher parses it; a version number lets the shape grow.
"""

import json
from dataclasses import dataclass

VERDICT_VERSION = 1


@dataclass(frozen=True)
class Verdict:
    engines: tuple[str, ...]
    # Why `opencode` is missing from `engines`; empty when it is advertised.
    reasons: tuple[str, ...] = ()

    def document(self) -> dict[str, object]:
        return {
            "version": VERDICT_VERSION,
            "engines": list(self.engines),
            "reasons": list(self.reasons),
        }

    def to_json(self) -> str:
        """One compact line, so that a launcher reads it with one `readline`."""
        return json.dumps(self.document(), separators=(",", ":"))
