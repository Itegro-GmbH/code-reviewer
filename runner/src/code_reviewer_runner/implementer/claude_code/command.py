# SPDX-License-Identifier: LicenseRef-Proprietary

"""How Claude Code is started headless in the agent's container (#856, R3). Pure: it makes the
command line and the environment, runs nothing.

The decisions in it (plan `customer-runner.md`, owner 2026-11-05):

* **The agent is free inside the sandbox.** `--permission-mode bypassPermissions`, no
  `--allowedTools` (a closed list of tools), nothing the runner decides about the approach. The
  guards are outside: money (the budget), the key (it never enters the container, except the
  customer's own subscription token on the customer's device), the exits (the network).
* **Not as root.** `bypassPermissions` refuses to run as root unless `IS_SANDBOX=1`, which
  Anthropic does not document, so it is not relied on: the exec runs as the unprivileged user of
  the install layer (`layer.py`); root stays for the set-up.
* **What the repository holds is data.** `--setting-sources user` (no project or local settings:
  hooks and permissions of a repository are not read) and `--strict-mcp-config` (no `.mcp.json`
  of the repository): the one MCP server is the finish tool.
* **The prompt travels on standard input**, not in the argument list.
* **The login is in the environment** (`login.py`), never in the argument list.
"""

import json
import re
from collections.abc import Sequence
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Final

from code_reviewer_runner.implementer import finish_tool

from .login import ClaudeLogin

# The user of the install layer, as `uid:gid` for the exec. Not 0, not 1000 (a mapped user of the
# host's), a fixed number the layer creates (`layer.py`).
AGENT_UID: Final = 10201
AGENT_USER: Final = f"{AGENT_UID}:{AGENT_UID}"
AGENT_HOME: Final = "/home/agent"
AGENT_TMP: Final = "/tmp"
# Claude Code's configuration, its credentials file and its sessions live in one directory.
CONFIG_DIRECTORY: Final = f"{AGENT_HOME}/.claude"
# The one MCP server, the finish tool: Claude Code names its tool `mcp__finish__submit_result`.
FINISH_SERVER: Final = "finish"
FINISH_TOOL: Final = f"mcp__{FINISH_SERVER}__{finish_tool.TOOL_NAME}"
AGENT_PATH: Final = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
EXECUTABLE: Final = "claude"

_SESSION_ID: Final = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
_AMOUNT: Final = re.compile(r"[0-9]{1,6}(\.[0-9]{1,6})?")


@dataclass(frozen=True)
class SessionChoice:
    """A new session under an id the runner chose (`--session-id`), or the stored one of an earlier
    turn (`--resume`). The id is a UUID and nothing else, so it can never be read as an option."""

    session_id: str
    resumes: bool

    @staticmethod
    def new(session_id: str) -> "SessionChoice":
        return SessionChoice(_checked(session_id), False)

    @staticmethod
    def resume(session_id: str) -> "SessionChoice":
        return SessionChoice(_checked(session_id), True)


def _checked(session_id: str) -> str:
    if not _SESSION_ID.fullmatch(session_id):
        raise ValueError("a Claude Code session id is a UUID")
    return session_id


@dataclass(frozen=True)
class ClaudeCommand:
    model: str | None
    session: SessionChoice
    # The stdio server of the finish tool (`result_channel.finish_server_command()`); None: the turn
    # has no result schema and no MCP server.
    finish_command: Sequence[str] | None = None
    # `--max-budget-usd`: stops the turn after the call that crosses it. The only brake of a
    # subscription turn besides the job's clock (no model door, so no ledger).
    max_budget_usd: str | None = None
    # The runner's addition to Claude Code's own system prompt (`prompts.instructions_text`).
    instructions: str | None = None

    def argv(self) -> list[str]:
        argv = [
            EXECUTABLE,
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--permission-mode",
            "bypassPermissions",
            "--setting-sources",
            "user",
            "--strict-mcp-config",
        ]
        if self.model:
            argv += ["--model", self.model]
        argv += ["--resume" if self.session.resumes else "--session-id", self.session.session_id]
        if self.max_budget_usd is not None:
            argv += ["--max-budget-usd", _amount(self.max_budget_usd)]
        if self.instructions:
            argv += ["--append-system-prompt", self.instructions]
        if self.finish_command:
            command, *args = self.finish_command
            server = {"type": "stdio", "command": command, "args": args}
            argv += [
                "--mcp-config",
                json.dumps({"mcpServers": {FINISH_SERVER: server}}, separators=(",", ":")),
            ]
        return argv


def _amount(value: str) -> str:
    try:
        positive = _AMOUNT.fullmatch(value) is not None and Decimal(value) > 0
    except InvalidOperation:
        positive = False
    if not positive:
        raise ValueError("a budget is a positive amount in dollars")
    return value


def claude_environment(login: ClaudeLogin, *, base_url: str | None = None) -> dict[str, str]:
    """The environment of the exec, built from names and never by inheriting. Telemetry, updates
    and error reports are off; the tool schema is in the first request (`ENABLE_TOOL_SEARCH`:
    otherwise a model must find the finish tool through a search tool first).

    **Not set: `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`.** It exists in 2.1.311 and would keep the login
    out of the environment of the agent's tools, but it makes Claude Code run its tools under
    bubblewrap (and refuse to start without it) and **forces the permission mode to `default`**
    ("Declare allowedTools explicitly"): every tool then waits for an approval that never comes in
    a headless run. That is the opposite of "the agent is free inside the sandbox", and a closed
    list of tools is a decision the owner has not made (`docs/runner.md`, "What is left", 7). An
    engine test pins the behaviour, so that nobody sets it by accident."""
    environment = {
        "HOME": AGENT_HOME,
        "CLAUDE_CONFIG_DIR": CONFIG_DIRECTORY,
        "XDG_CONFIG_HOME": f"{AGENT_HOME}/.config",
        "XDG_DATA_HOME": f"{AGENT_HOME}/.local/share",
        "XDG_CACHE_HOME": f"{AGENT_HOME}/.cache",
        "XDG_STATE_HOME": f"{AGENT_HOME}/.local/state",
        "TMPDIR": AGENT_TMP,
        "CI": "1",
        "NO_COLOR": "1",
        "GIT_TERMINAL_PROMPT": "0",
        "PATH": f"/etc/code-reviewer:{AGENT_PATH}",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        "DISABLE_AUTOUPDATER": "1",
        "ENABLE_TOOL_SEARCH": "false",
    }
    environment.update(login.environment())
    if base_url is not None:
        environment["ANTHROPIC_BASE_URL"] = base_url
    return environment
