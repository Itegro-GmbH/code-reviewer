# SPDX-License-Identifier: LicenseRef-Proprietary

"""The per-VM token of the local Dispatcher (#977, enforced by the host in #978): what lets the host
tell a genuine message from the VM from one forged on the vsock. The host makes one token per VM
(`generate_control_token`), sends it in the start (`controlToken` of
`contracts/vm-init.v1.json`) and refuses every message that does not carry it: the exit report of
vm-init once the start was acknowledged, and every `narrow` and `end` of the environment control.

This is the Python twin of `dispatcher/src/launchers/control-token.ts`; both read
`contracts/control-token-vectors.json` and must give the same verdicts. Pure functions, no socket,
no state. The token is never logged: nothing here formats one."""

import base64
import hashlib
import hmac
import re
import secrets
from collections.abc import Mapping
from enum import StrEnum
from typing import Any, Final

# 256 bits: 43 characters of base64url, the shortest `ControlToken` of the contracts.
CONTROL_TOKEN_BYTES: Final = 32
_CONTROL_TOKEN = re.compile(r"[A-Za-z0-9_-]{43,128}")


class TokenVerdict(StrEnum):
    """What the host does with a message: `ok`, or why it refuses it (a code, never the token). The
    host answers `missing` and `wrong` the same and never says which."""

    OK = "ok"
    MISSING = "missing"
    WRONG = "wrong"


def generate_control_token() -> str:
    """A fresh token for one VM."""
    return base64.urlsafe_b64encode(secrets.token_bytes(CONTROL_TOKEN_BYTES)).rstrip(b"=").decode()


def is_control_token(value: object) -> bool:
    """Whether `value` is a token of the contracts' shape; the host makes only such ones."""
    return isinstance(value, str) and _CONTROL_TOKEN.fullmatch(value) is not None


def _digest(value: str) -> bytes:
    return hashlib.sha256(value.encode("utf-8", errors="surrogatepass")).digest()


def control_token_matches(received: object, expected: str) -> bool:
    """Whether `received` is `expected`. Both go through SHA-256 first, so the buffers have the same
    length whatever the texts' lengths are, and the comparison takes constant time."""
    if not isinstance(received, str):
        return False
    return hmac.compare_digest(_digest(received), _digest(expected))


def verify_control_message(message: Mapping[str, Any], expected: str) -> TokenVerdict:
    """The check of one message of the environment control (`narrow`, `end`): the token of this
    VM, or a refusal."""
    if "token" not in message:
        return TokenVerdict.MISSING
    return (
        TokenVerdict.OK if control_token_matches(message["token"], expected) else TokenVerdict.WRONG
    )


def verify_exit_report(
    report: Mapping[str, Any], *, expected: str, start_acked: bool
) -> TokenVerdict:
    """The check of an exit report of vm-init. A VM that never took a start cannot know the token
    (`start_timeout`, `start_invalid`, a daemon that did not start), so a report without one counts
    only while the host has no `ack` for the start; once it has, the token is required."""
    if "token" not in report and not start_acked:
        return TokenVerdict.OK
    return verify_control_message(report, expected)
