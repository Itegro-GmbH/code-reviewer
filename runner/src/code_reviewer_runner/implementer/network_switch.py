# SPDX-License-Identifier: LicenseRef-Proprietary

"""The second wall of the network door (#745, step 7): Control asks the Dispatcher to narrow the
VM's network policy once the setup script is done.

**Why the Dispatcher, and why a call.** The platform's network policy is a setting of the VM that is
changed with the platform's API and a credential of the team, which must never be in a VM. The
Dispatcher has the credential, but it holds nothing after the hand-over (#487) and cannot wait for
the end of a setup script that runs for up to fifteen minutes. So the Dispatcher gives Control, in
the environment of its container, everything for one call and a token that is good for that call
only (`RUNNER_IMPLEMENTER_NETWORK_SWITCH`), and Control makes the call at the right moment: after
the setup, before the agent exists.

The token is an HMAC the Dispatcher computes over the VM's name and the rule it read in the claim
(`dispatcher/src/network/switch-token.ts`). Control cannot choose the rule: a call with another
rule is refused. What Control does add, because only the Worker knows it, is the host of the model
provider (`modelHost`); the Dispatcher accepts a plain host name there and nothing else.

**The call may not come back.** Narrowing the policy ends the connections that are open, and the
call that asks for it is one of them. So the answer to a call that was cut is not known, and Control
asks again until it gets a clear `applied` (the Dispatcher's host is always in the narrowed policy,
and the call is idempotent). A call that never gets through ends the turn `setup_failed`, free: the
environment's rule is not in place, and the agent is not started.
"""

import json
import logging
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from typing import Final
from urllib.parse import urlsplit

from code_reviewer_runner.job import JobError
from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.result import ErrorCode

from .network_rule import NetworkRule, RuleError, ascii_name, is_ip_literal, parse_rule

_log = logging.getLogger(__name__)

ATTEMPTS: Final = 8
CALL_SECONDS: Final = 25.0
PAUSE_SECONDS: Final = 2.0
MAX_DOCUMENT_BYTES: Final = 32 * 1024
APPLIED: Final = "applied"

Post = Callable[[str, bytes, float], tuple[int, bytes]]


@dataclass(frozen=True)
class NetworkSwitch:
    """What the Dispatcher handed over: where to call, which VM and app, the rule it read, and the
    token that proves it. Nothing here opens more than this one call for this one VM."""

    url: str
    vm: str
    app_id: str
    rule: NetworkRule
    token: str

    def __repr__(self) -> str:
        return f"NetworkSwitch(vm={self.vm!r}, rule={self.rule.mode})"


def parse_switch(text: str | None) -> NetworkSwitch | None:
    """The switch of the environment variable; None when it is not set. Raises `JobError`
    (`implementer_config_invalid`) for a value that is set and is not one: a deployment that says
    it can switch and cannot is not the same as one that does not say so."""
    if text is None or not text.strip():
        return None
    try:
        if len(text) > MAX_DOCUMENT_BYTES:
            raise ValueError
        given = as_object(json.loads(text))
        if given is None or given.keys() != {"url", "vm", "appId", "network", "token"}:
            raise ValueError
        url, vm, app_id, token = given["url"], given["vm"], given["appId"], given["token"]
        if not all(isinstance(value, str) and value for value in (url, vm, app_id, token)):
            raise ValueError
        parts = urlsplit(str(url))
        if parts.scheme != "https" or not parts.hostname or parts.username or parts.password:
            raise ValueError
        return NetworkSwitch(
            str(url), str(vm), str(app_id), parse_rule(given["network"], "network"), str(token)
        )
    except (ValueError, RuleError, RecursionError):
        raise JobError(
            ErrorCode.IMPLEMENTER_CONFIG_INVALID,
            "the network switch of this container is not one the runner can read",
        ) from None


def model_host_of(upstream_base_url: str) -> str:
    """The host name of the model provider's address, in the form the Dispatcher accepts."""
    host = urlsplit(upstream_base_url).hostname or ""
    name = ascii_name(host)
    if name is None or is_ip_literal(name):
        raise JobError(
            ErrorCode.IMPLEMENTER_CONFIG_INVALID,
            "the model provider's address is not a host name the network policy can name",
        )
    return name


def urllib_post(url: str, body: bytes, timeout: float) -> tuple[int, bytes]:
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read(4096)
    except urllib.error.HTTPError as error:
        return error.code, error.read(4096)


def narrow_policy(
    switch: NetworkSwitch,
    rule: NetworkRule,
    model_host: str,
    *,
    post: Post = urllib_post,
    attempts: int = ATTEMPTS,
    call_seconds: float = CALL_SECONDS,
    pause_seconds: float = PAUSE_SECONDS,
    sleep: Callable[[float], None] = time.sleep,
) -> int:
    """Ask for the narrowed policy until the Dispatcher says `applied`; returns the number of
    calls it took. Raises `JobError` (`setup_failed`, free) when it never does, and
    `implementer_config_invalid` when the rule in the job is not the one the Dispatcher read."""
    if rule != switch.rule:
        raise JobError(
            ErrorCode.IMPLEMENTER_CONFIG_INVALID,
            "the network rule of the job is not the one the Dispatcher read",
        )
    body = json.dumps(
        {
            "vm": switch.vm,
            "appId": switch.app_id,
            "network": switch.rule.to_json(),
            "modelHost": model_host,
            "token": switch.token,
        },
        separators=(",", ":"),
    ).encode()
    for attempt in range(1, attempts + 1):
        try:
            status, answer = post(switch.url, body, call_seconds)
        except (OSError, ValueError):
            # Cut off, which is what the switch does to the call that makes it, or not reachable
            # yet: ask again.
            status, answer = 0, b""
        if status == 200 and _applied(answer):
            return attempt
        if status in (400, 401, 403, 404, 409, 422):
            # The Dispatcher said no, and asking again will not change that.
            raise JobError(
                ErrorCode.SETUP_FAILED,
                f"network_switch_refused: the Dispatcher refused the network policy ({status})",
            )
        if attempt < attempts:
            sleep(pause_seconds)
    raise JobError(
        ErrorCode.SETUP_FAILED,
        "network_switch_unavailable: the VM's network policy could not be narrowed",
    )


def _applied(answer: bytes) -> bool:
    try:
        given = as_object(json.loads(answer))
    except (ValueError, RecursionError):
        return False
    return given is not None and given.get("status") == APPLIED
