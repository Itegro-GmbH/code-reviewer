# SPDX-License-Identifier: LicenseRef-Proprietary

"""An agent turn does not run with fewer tools than its step was given (#1142).

Both harnesses start an MCP server in the background and carry on without it when it does not come
up: OpenCode logs the failure and offers no tool of that server, Claude Code marks it `failed`.
The agent then works the whole turn without the tools, says so in its summary, and the run ends
`succeeded`. So before the first prompt the runner asks whether every server of the step is
connected, and ends the turn `mcp_unavailable` (free: the model was never used) when one is not.

* OpenCode (pinned 1.19.0): `GET /mcp` answers `{<key>: {status}}`. A server is `connected` only
  when its `initialize` and its `tools/list` both worked (the engine's `MCP.create` closes the
  client and reports `failed` when the listing fails), so `connected` is "connected and has listed
  its tools". A server that is not gets **one** `POST /mcp/<key>/connect` after a short pause and
  a second look at the status.
* Claude Code: the `mcp_servers` of the `system/init` line, which names the status of each server
  before the first model call. No retry there: the process is already running.

What the error says: the server's configured name, never its address, never a credential, never
the engine's own message (which may carry the address).
"""

import time
from collections.abc import Callable, Mapping, Sequence
from typing import Any, Final

from code_reviewer_runner.dynamic_review.adapter import EngineClient, EngineError
from code_reviewer_runner.dynamic_review.budget import BudgetLedger
from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.result import ErrorCode

from .mcp_config import OPENCODE_MCP_TIMEOUT_MS, McpEndpoint

CONNECTED: Final = "connected"
# The pause before the one reconnect: long enough for a proxy or a server that was busy for a
# moment, short enough that a server that is down costs the turn little.
MCP_RETRY_PAUSE_SECONDS: Final = 2.0
# One call to `/mcp` or `/mcp/<key>/connect` waits for the engine's own connect timeout and the
# listing of the tools (which has the same timeout), plus a margin.
MCP_CALL_SECONDS: Final = OPENCODE_MCP_TIMEOUT_MS / 1000 * 2 + 15.0
# The longest a name is shown.
_NAME_CHARS: Final = 64


def _shown(name: str) -> str:
    """A configured name as plain text: printable, one line, no quote that would end the quoting,
    and not longer than `_NAME_CHARS`."""
    clean = "".join(c if c.isprintable() and c not in "\"'`\\" else " " for c in name)
    clean = " ".join(clean.split())
    if len(clean) > _NAME_CHARS:
        clean = clean[: _NAME_CHARS - 3] + "..."
    return clean or "unnamed"


def unavailable_detail(endpoints: Sequence[McpEndpoint]) -> str:
    """The sentence of the error: the servers by their configured names."""
    names = ", ".join(f'"{_shown(endpoint.label)}"' for endpoint in endpoints)
    if len(endpoints) == 1:
        return (
            f"the MCP server {names} of this step is not available: "
            "it did not connect or list its tools"
        )
    return (
        f"the MCP servers {names} of this step are not available: "
        "they did not connect or list their tools"
    )


CLAUDE_PENDING: Final = "pending"
"""Claude Code's word for a server that is still connecting when `init` is written."""


def not_connected(
    statuses: Mapping[str, str], endpoints: Sequence[McpEndpoint]
) -> list[McpEndpoint]:
    """The endpoints whose server is not `connected` in `statuses` (keyed by the endpoint's key);
    a server the engine does not list at all is not."""
    return [endpoint for endpoint in endpoints if statuses.get(endpoint.key) != CONNECTED]


def ensure_opencode_ready(
    client: EngineClient,
    endpoints: Sequence[McpEndpoint],
    ledger: BudgetLedger,
    *,
    sleep: Callable[[float], None] = time.sleep,
) -> None:
    """Every server of the step is connected, or `EngineError(MCP_UNAVAILABLE)` after one
    reconnect. A step without servers is not asked anything. An engine that cannot answer
    `GET /mcp` raises its own `EngineError` (the engine's failure, not a missing server)."""
    if not endpoints:
        return
    missing = not_connected(_statuses(client, ledger), endpoints)
    if not missing:
        return
    sleep(MCP_RETRY_PAUSE_SECONDS)
    for endpoint in missing:
        # The answer of a reconnect that fails is the status that follows it, not an exception:
        # the engine reports `failed` there and the second look reads it.
        client.mcp_connect(endpoint.key, _seconds(ledger))
    missing = not_connected(_statuses(client, ledger), missing)
    if missing:
        raise EngineError(ErrorCode.MCP_UNAVAILABLE, unavailable_detail(missing))


def _seconds(ledger: BudgetLedger) -> float:
    """The time one call may take: never more than the turn has left."""
    ledger.check_deadline()
    return max(min(MCP_CALL_SECONDS, ledger.remaining_seconds()), 1.0)


def _statuses(client: EngineClient, ledger: BudgetLedger) -> dict[str, str]:
    return client.mcp_status(_seconds(ledger))


def unavailable_in_claude_init(
    init: Mapping[str, Any], endpoints: Sequence[McpEndpoint]
) -> list[McpEndpoint]:
    """The endpoints of the step that the `system/init` line of Claude Code shows as not available:
    a status other than `connected` or `pending`, or no entry at all. `pending` is not a failure:
    Claude Code waits only a short time for a server before it writes `init`, and a slow server
    (door, app proxy, remote server) keeps connecting after it. Servers the step did not name
    (the finish tool, or one a repository tried to add) are not looked at."""
    if not endpoints:
        return []
    statuses: dict[str, str] = {}
    listed = init.get("mcp_servers")
    if isinstance(listed, list):
        items: list[Any] = listed  # pyright: ignore[reportUnknownVariableType]
        for item in items:
            entry = as_object(item)
            if entry is None:
                continue
            name, status = entry.get("name"), entry.get("status")
            if isinstance(name, str) and isinstance(status, str):
                statuses[name] = status
    return [
        endpoint
        for endpoint in not_connected(statuses, endpoints)
        if statuses.get(endpoint.key) != CLAUDE_PENDING
    ]
