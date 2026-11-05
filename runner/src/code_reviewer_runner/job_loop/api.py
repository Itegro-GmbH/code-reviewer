# SPDX-License-Identifier: LicenseRef-Proprietary

"""The reply types of the runner API (`contracts/runner-api.v1.json`) that the Worker and the job
host share.

The claim and the HTTP client of the runner's own job loop are gone (#700): a Dispatcher claims, and
a Worker only fetches, heartbeats and delivers with its per-job credential (`worker_api.py`). What
stays: `ClaimedJob` (a job as the host runs it), the answers to a heartbeat and a completion, and
their parsing. What a caller has to tell apart is small, so the errors (`http.py`) are too:

- `ApiUnavailable`: the app cannot answer now (no connection, 5xx, 429, a wrong token, an answer
  that is not the contract). The caller waits and tries again.
- `LeaseLost`: the app says the runner no longer holds the job (409, or 404). Nothing more may be
  sent for it.
- `ApiRejected`: the app refused this request for good (another 4xx). Retrying the same request
  cannot help.

No error carries a value of the request or the response: they hold secrets.
"""

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from code_reviewer_runner.job_loop.http import (
    MAX_RETRY_AFTER_SECONDS,
    ApiError,
    ApiRejected,
    ApiUnavailable,
    LeaseLost,
    Reply,
    parse_json,
)
from code_reviewer_runner.job_loop.jsonvalues import as_object

# A heartbeat interval above this would let the 2 minute lease run out between two beats.
MAX_HEARTBEAT_INTERVAL_SECONDS = 60


# The errors and the reply type live in http.py (the Worker API client uses them too); they are
# part of this module's interface as before.
__all__ = [
    "MAX_HEARTBEAT_INTERVAL_SECONDS",
    "MAX_RETRY_AFTER_SECONDS",
    "ApiError",
    "ApiRejected",
    "ApiUnavailable",
    "ClaimedJob",
    "CompleteReply",
    "HeartbeatReply",
    "LeaseLost",
]


@dataclass(frozen=True)
class ClaimedJob:
    id: str
    lease_token: str
    heartbeat_interval: float
    input: dict[str, Any]


@dataclass(frozen=True)
class CompleteReply:
    # "succeeded" or "failed": finished. "queued": given back after runner_shutdown. None: unknown.
    status: str | None
    already_completed: bool


@dataclass(frozen=True)
class HeartbeatReply:
    """What the app said to a heartbeat that it accepted."""

    # #396: a newer push replaced this run; it must stop gracefully. Absent in the answer means
    # False.
    superseded: bool = False
    # When the lease ends, in seconds since the epoch, as the answer names it (None: absent or
    # unreadable). A superseded run drains until shortly before it (`host.py`).
    lease_expires_at: float | None = None
    # #891: a member asked for this run to stop; the host ends the turn and reports `cancelled`.
    # Absent in the answer means False.
    cancel_requested: bool = False


def parse_heartbeat(reply: Reply, job_id: str) -> HeartbeatReply:
    """The accepted heartbeat: a 200 is the app's "yes" only as the contract's answer for this very
    job.

    A gateway or a captive portal that answers 200 to everything is not the app (#260). `superseded`
    and `cancelRequested` count only as the boolean `true`; anything else is "not".
    """
    body = as_object(parse_json(reply))
    job = as_object(body.get("job")) if body and body.get("version") == 1 else None
    if job is None or job.get("id") != job_id:
        raise ApiUnavailable("the heartbeat answer does not match the contract", 200)
    return HeartbeatReply(
        superseded=job.get("superseded") is True,
        lease_expires_at=_epoch(job.get("leaseExpiresAt")),
        cancel_requested=job.get("cancelRequested") is True,
    )


def _epoch(value: object) -> float | None:
    """The time of a contract `Timestamp` as seconds since the epoch, or None for anything else."""
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return None if parsed.tzinfo is None else parsed.timestamp()
