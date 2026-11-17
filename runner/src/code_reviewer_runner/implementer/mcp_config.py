# SPDX-License-Identifier: LicenseRef-Proprietary

"""The MCP servers of a step in the two harnesses' configuration (#1067, epic #1049). Pure: it makes
data, runs nothing.

The agent talks to **one local endpoint per server** at the MCP door (`mcpdoor/`):
`http://<door>:<port>/mcp/<server id>`. The key a server has in the configuration is its name, which
is the prefix of its tools (OpenCode `<name>_<tool>`, Claude Code `mcp__<name>__<tool>`). Nothing
else
of the server is in either file: no header, no token, no address of the real server, no job
credential. A test greps both files for them.

A name is made a plain key (`[A-Za-z0-9_-]`, at most 64 characters) because both harnesses build a
tool's name from it and replace anything else themselves; two names that come out the same are told
apart by a number, and the name `finish` (the finish tool's server) is not given out.
"""

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final

from code_reviewer_runner.job import ImplementerSpec, McpServerRef

from .placement import placement_of

RESERVED_KEYS: Final = frozenset({"finish"})
# What the harness waits for the server to start (the `initialize` and `tools/list` the door relays
# to the app and the app to the server) and for the list of its tools.
OPENCODE_MCP_TIMEOUT_MS: Final = 30_000
_NOT_KEY: Final = re.compile(r"[^A-Za-z0-9_-]")


def mcp_door_wanted(spec: ImplementerSpec, environment: Mapping[str, str]) -> bool:
    """Whether the turn has an MCP door: its step names servers and this runner's placement has one.
    False for every turn of a lane without `mcp` (nothing is added to it)."""
    mcp = spec.mcp
    return mcp is not None and bool(mcp.servers) and placement_of(environment).mcp_supported


@dataclass(frozen=True)
class McpEndpoint:
    """One server as the agent sees it."""

    key: str
    url: str
    server_id: str


def endpoint_keys(servers: Sequence[McpServerRef]) -> list[str]:
    """The key of each server, in order: its name as a plain token, unique and not reserved."""
    taken: set[str] = set(RESERVED_KEYS)
    keys: list[str] = []
    for server in servers:
        base = _NOT_KEY.sub("_", server.name)[:60].strip("_-") or "mcp"
        key = base
        number = 2
        while key.lower() in taken:
            key = f"{base}_{number}"
            number += 1
        taken.add(key.lower())
        keys.append(key)
    return keys


def endpoints_of(servers: Sequence[McpServerRef], door_url: str) -> tuple[McpEndpoint, ...]:
    """The endpoints of a turn's servers at the door: `<door_url>/mcp/<server id>`."""
    base = door_url.rstrip("/")
    return tuple(
        McpEndpoint(key, f"{base}/mcp/{server.id}", server.id)
        for key, server in zip(endpoint_keys(servers), servers, strict=True)
    )


def opencode_block(endpoints: Sequence[McpEndpoint]) -> dict[str, Any]:
    """The `mcp` entries of the engine's config: `remote` servers at the local endpoints. `oauth` is
    off: a server that wants a sign-in is the app's to handle (it adds the token), and the engine
    must never start a sign-in of its own from a 401 that the door does not pass on anyway."""
    return {
        endpoint.key: {
            "type": "remote",
            "url": endpoint.url,
            "enabled": True,
            "oauth": False,
            "timeout": OPENCODE_MCP_TIMEOUT_MS,
        }
        for endpoint in endpoints
    }


def opencode_permissions(endpoints: Sequence[McpEndpoint]) -> dict[str, str]:
    """The permission that lets the agent use the tools of these servers (the engine names a tool
    `<key>_<tool>`; the config is default-deny, so each server's tools are allowed by prefix). Only
    the servers of the step: no other tool is let in by it."""
    return {f"{endpoint.key}_*": "allow" for endpoint in endpoints}


def claude_servers(endpoints: Sequence[McpEndpoint]) -> dict[str, Any]:
    """The `mcpServers` entries of Claude Code's `--mcp-config`: Streamable HTTP servers at the
    local
    endpoints. The agent runs with `bypassPermissions`, so no allow-list is needed."""
    return {endpoint.key: {"type": "http", "url": endpoint.url} for endpoint in endpoints}
