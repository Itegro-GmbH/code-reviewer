# SPDX-License-Identifier: LicenseRef-Proprietary

"""#1142: an agent turn does not run with fewer tools than its step was given. Before the first
prompt the runner asks the engine whether every MCP server of the step is connected (OpenCode:
`GET /mcp`, one `POST /mcp/<key>/connect` and a second look; Claude Code: the `mcp_servers` of the
`system/init` line) and ends the turn `mcp_unavailable`, naming the servers by their configured
names, when one is not. A step without MCP servers is not asked anything."""

import json
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from code_reviewer_runner.dynamic_review.adapter import PINNED_ENGINE_VERSION, EngineError
from code_reviewer_runner.dynamic_review.budget import BudgetLedger, UnitCosts
from code_reviewer_runner.implementer.agent import CommandOutcome, ImplementerAgent
from code_reviewer_runner.implementer.claude_code.agent import ClaudeCodeAgent
from code_reviewer_runner.implementer.claude_code.login import ClaudeLogin
from code_reviewer_runner.implementer.limits import agent_limits
from code_reviewer_runner.implementer.mcp_config import McpEndpoint, endpoints_of
from code_reviewer_runner.implementer.mcp_ready import (
    MCP_RETRY_PAUSE_SECONDS,
    unavailable_detail,
    unavailable_in_claude_init,
)
from code_reviewer_runner.job import McpServerRef
from code_reviewer_runner.result import ErrorCode

# Built in pieces so that the tracked-secrets scan sees no key shape.
TOKEN = "sk-" + "ant-" + "oat01-made-up-token-not-real-0000000000000000"
BASE = "http://127.0.0.1:4096"
SECRET_URL = "https://user:hunter2@mcp.example.com/sse?token=abc123"
ISSUES = McpServerRef("00000001-0000-4000-8000-000000000000", "Issues", "sse")
DOCS = McpServerRef("00000002-0000-4000-8000-000000000000", "Docs", "streamable-http")


def endpoints(*servers: McpServerRef) -> tuple[McpEndpoint, ...]:
    return endpoints_of(list(servers), "http://door.internal:9000")


# -- the engine of the test: OpenCode's `/mcp` as far as the runner uses it ------------------------


@dataclass
class Place:
    events: list[str] = field(default_factory=lambda: [])

    def write_files(self, files: Mapping[str, tuple[bytes, int]]) -> None:
        return None

    def run_command(
        self, argv: list[str], environment: Mapping[str, str], timeout: float
    ) -> CommandOutcome:
        return CommandOutcome(0, "")

    def start_engine(self, argv: list[str], environment: Mapping[str, str]) -> str:
        return BASE

    def engine_running(self) -> bool:
        return True

    def settle(self, seconds: float) -> None:
        return None

    def engine_end_note(self) -> str | None:
        return None

    def stop(self) -> bool:
        return True


class Engine:
    """`status` is what `GET /mcp` answers, step by step (the last one repeats); a `connect` moves
    to the next one, as the real reconnect does."""

    def __init__(self, *rounds: Mapping[str, Any], mcp_status: int = 200) -> None:
        self.rounds = list(rounds)
        self.position = 0
        self.mcp_status = mcp_status
        self.calls: list[tuple[str, str]] = []

    def __call__(
        self, method: str, url: str, payload: bytes | None, headers: Mapping[str, str], t: float
    ) -> tuple[int, bytes]:
        path = url.removeprefix(BASE)
        self.calls.append((method, path))
        if path == "/global/health":
            return 200, json.dumps({"healthy": True, "version": PINNED_ENGINE_VERSION}).encode()
        if method == "POST" and path == "/session":
            return 200, json.dumps({"id": "ses_1"}).encode()
        if method == "GET" and path == "/mcp":
            if self.mcp_status != 200:
                return self.mcp_status, b"{}"
            document = self.rounds[min(self.position, len(self.rounds) - 1)]
            return 200, json.dumps(document).encode()
        if method == "POST" and path.startswith("/mcp/") and path.endswith("/connect"):
            self.position += 1
            return 200, b"true"
        return 404, b"{}"

    @property
    def connects(self) -> list[str]:
        return [path for method, path in self.calls if method == "POST" and "/connect" in path]

    @property
    def reads(self) -> int:
        return len([1 for method, path in self.calls if (method, path) == ("GET", "/mcp")])


def make_agent(
    engine: Engine,
    mcp: tuple[McpEndpoint, ...],
    *,
    slept: list[float] | None = None,
    seconds: float = 600.0,
) -> ImplementerAgent:
    ledger = BudgetLedger(
        agent_limits(seconds, Decimal("5"), "cost_limit"),
        unit_costs=UnitCosts(input_usd_per_mtok=Decimal(1), output_usd_per_mtok=Decimal(4)),
        clock=time.monotonic,
    )
    agent = ImplementerAgent(
        ledger=ledger,
        runtime=Place(),
        command=["opencode"],
        directory="/work/repo",
        make_config=lambda path: {"instructions": [path]},
        instructions=("implementer-instructions.md", "text"),
        environment={"HOME": "/root"},
        model="m",
        provider_id="p",
        transport=engine,
        mcp_endpoints=mcp,
        sleep=(slept if slept is not None else []).append,
    )
    # The audit rides on the engine's event stream, which these tests do not have.
    agent._open_audit = lambda client, session_id: None  # type: ignore[method-assign]  # pyright: ignore[reportPrivateUsage]
    return agent


CONNECTED: dict[str, Any] = {"status": "connected"}
FAILED: dict[str, Any] = {"status": "failed", "error": f"could not reach {SECRET_URL}"}


# #1142-T01
def test_opencode_every_server_connected_sends_no_reconnect_and_starts_the_turn() -> None:
    engine = Engine({"Issues": CONNECTED, "Docs": CONNECTED, "finish": CONNECTED})
    slept: list[float] = []

    make_agent(engine, endpoints(ISSUES, DOCS), slept=slept).start(4096)

    assert engine.reads == 1 and engine.connects == []
    assert slept == []


# #1142-T02
def test_opencode_a_server_that_failed_is_reconnected_once_after_a_short_pause_and_recovers() -> (
    None
):
    engine = Engine({"Issues": CONNECTED, "Docs": FAILED}, {"Issues": CONNECTED, "Docs": CONNECTED})
    slept: list[float] = []

    make_agent(engine, endpoints(ISSUES, DOCS), slept=slept).start(4096)

    # Only the server that was not connected is reconnected, by the key it has in the config.
    assert engine.connects == ["/mcp/Docs/connect"]
    assert engine.reads == 2
    assert slept == [MCP_RETRY_PAUSE_SECONDS]


# #1142-T03
def test_opencode_a_server_that_still_fails_after_the_retry_ends_the_turn_by_its_name() -> None:
    engine = Engine({"Issues": FAILED}, {"Issues": FAILED})
    agent = make_agent(engine, endpoints(ISSUES))

    with pytest.raises(EngineError) as raised:
        agent.start(4096)

    assert raised.value.code is ErrorCode.MCP_UNAVAILABLE
    assert "Issues" in raised.value.detail
    # One reconnect, one second look, then the turn ends: never a third.
    assert len(engine.connects) == 1 and engine.reads == 2


# #1142-T04
def test_the_error_names_the_server_and_nothing_of_its_address_or_credentials() -> None:
    engine = Engine({"Issues": FAILED, "Docs": CONNECTED}, {"Issues": FAILED, "Docs": CONNECTED})

    with pytest.raises(EngineError) as raised:
        make_agent(engine, endpoints(ISSUES, DOCS)).start(4096)

    text = str(raised.value)
    assert '"Issues"' in text and "Docs" not in text
    for forbidden in ("hunter2", "abc123", "mcp.example.com", "door.internal", "00000001"):
        assert forbidden not in text


# #1142-T05
@pytest.mark.parametrize(
    "status", ["failed", "needs_auth", "needs_client_registration", "disabled"]
)
def test_opencode_any_status_but_connected_is_not_available(status: str) -> None:
    engine = Engine({"Issues": {"status": status}}, {"Issues": {"status": status}})

    with pytest.raises(EngineError) as raised:
        make_agent(engine, endpoints(ISSUES)).start(4096)

    assert raised.value.code is ErrorCode.MCP_UNAVAILABLE


# #1142-T06
def test_opencode_a_server_the_engine_does_not_list_at_all_is_not_available() -> None:
    engine = Engine({}, {})

    with pytest.raises(EngineError) as raised:
        make_agent(engine, endpoints(ISSUES)).start(4096)

    assert raised.value.code is ErrorCode.MCP_UNAVAILABLE and '"Issues"' in raised.value.detail


# #1142-T07
def test_a_step_without_servers_asks_the_engine_nothing_about_mcp() -> None:
    engine = Engine({"Issues": FAILED})
    slept: list[float] = []

    make_agent(engine, (), slept=slept).start(4096)

    assert [path for _, path in engine.calls if path.startswith("/mcp")] == []
    assert slept == []


# #1142-T08
def test_an_engine_that_cannot_answer_the_status_is_the_engines_failure_not_a_missing_server() -> (
    None
):
    engine = Engine({"Issues": CONNECTED}, mcp_status=500)

    with pytest.raises(EngineError) as raised:
        make_agent(engine, endpoints(ISSUES)).start(4096)

    assert raised.value.code is ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE


# #1142-T09
def test_a_name_that_is_not_plain_text_is_cleaned_before_it_is_shown() -> None:
    servers = [
        McpServerRef("00000003-0000-4000-8000-000000000000", 'Evil "name"\n' + "x" * 200, "sse")
    ]

    detail = unavailable_detail(endpoints_of(servers, "http://d:1"))

    assert "\n" not in detail and len(detail) < 200 and '""' not in detail


# -- Claude Code ----------------------------------------------------------------------------------


def init(*servers: Mapping[str, str]) -> dict[str, Any]:
    return {"type": "system", "subtype": "init", "session_id": "s", "mcp_servers": list(servers)}


# #1142-T10
def test_claude_init_with_every_server_connected_names_nothing() -> None:
    found = unavailable_in_claude_init(
        init({"name": "Issues", "status": "connected"}, {"name": "finish", "status": "connected"}),
        endpoints(ISSUES),
    )

    assert found == []


# #1142-T11
@pytest.mark.parametrize("status", ["failed", "needs-auth", "disabled"])
def test_claude_init_a_server_that_is_not_connected_is_named(status: str) -> None:
    found = unavailable_in_claude_init(
        init({"name": "Issues", "status": status}, {"name": "Docs", "status": "connected"}),
        endpoints(ISSUES, DOCS),
    )

    assert [endpoint.name for endpoint in found] == ["Issues"]


# #1142-T11b
def test_claude_init_a_pending_server_is_not_a_failure() -> None:
    found = unavailable_in_claude_init(
        init({"name": "Issues", "status": "pending"}, {"name": "Docs", "status": "connected"}),
        endpoints(ISSUES, DOCS),
    )

    assert found == []


# #1142-T12
def test_claude_init_a_server_missing_from_the_list_is_not_available() -> None:
    assert [e.name for e in unavailable_in_claude_init(init(), endpoints(ISSUES))] == ["Issues"]
    no_list = {"type": "system", "subtype": "init"}
    assert [e.name for e in unavailable_in_claude_init(no_list, endpoints(ISSUES))] == ["Issues"]


# #1142-T13
def test_claude_init_without_servers_in_the_step_is_never_a_failure() -> None:
    assert unavailable_in_claude_init(init({"name": "x", "status": "failed"}), ()) == []


def line(document: Mapping[str, Any]) -> bytes:
    return json.dumps(document).encode() + b"\n"


@dataclass
class ClaudePlace:
    output: list[bytes]
    runs: int = 0

    def write_files(self, files: Mapping[str, tuple[bytes, int]]) -> None:
        return None

    def run_command(
        self, argv: list[str], environment: Mapping[str, str], timeout: float
    ) -> CommandOutcome:
        return CommandOutcome(0, "")

    def run_streaming(
        self,
        argv: list[str],
        environment: Mapping[str, str],
        *,
        user: str,
        stdin: bytes,
        timeout: float,
        consume: Any,
    ) -> CommandOutcome:
        self.runs += 1
        for chunk in self.output:
            consume(chunk)
        return CommandOutcome(0, "")

    def engine_end_note(self) -> str | None:
        return None

    def stop(self) -> bool:
        return True


def claude_agent(place: ClaudePlace, mcp: tuple[McpEndpoint, ...]) -> ClaudeCodeAgent:
    agent = ClaudeCodeAgent(
        place=place,
        login=ClaudeLogin("CLAUDE_CODE_OAUTH_TOKEN", TOKEN),
        model=None,
        session_id="d847dcf5-e741-4252-98b0-d73cbc39f2c0",
        secrets=(),
        remaining_seconds=lambda: 600.0,
        check_deadline=lambda: None,
        mcp_endpoints=mcp,
    )
    agent.start()
    return agent


def result_line() -> bytes:
    return line(
        {
            "type": "result",
            "subtype": "success",
            "is_error": False,
            "result": "done",
            "session_id": "s",
            "total_cost_usd": 0.01,
            "modelUsage": {"m": {"costBasis": "list"}},
        }
    )


# #1142-T14
def test_claude_code_a_turn_whose_server_is_not_connected_ends_mcp_unavailable() -> None:
    place = ClaudePlace(
        [line(init({"name": "Issues", "status": "failed"})), result_line()],
    )

    with pytest.raises(EngineError) as raised:
        claude_agent(place, endpoints(ISSUES)).turn("go")

    assert raised.value.code is ErrorCode.MCP_UNAVAILABLE
    assert '"Issues"' in raised.value.detail


# #1142-T15
def test_claude_code_a_turn_with_every_server_connected_runs_as_before() -> None:
    place = ClaudePlace(
        [line(init({"name": "Issues", "status": "connected"})), result_line()],
    )

    turn = claude_agent(place, endpoints(ISSUES)).turn("go")

    assert turn.text == "done"


# #1142-T16
def test_claude_code_a_turn_without_servers_ignores_what_the_init_line_says() -> None:
    place = ClaudePlace([line(init({"name": "repo", "status": "failed"})), result_line()])

    assert claude_agent(place, ()).turn("go").text == "done"


# #1142-T17
def test_the_session_ends_the_turn_with_the_new_code_and_the_name_and_blames_nothing_else() -> None:
    from code_reviewer_runner.implementer.session import classify

    error = EngineError(ErrorCode.MCP_UNAVAILABLE, unavailable_detail(endpoints(ISSUES)))

    code, detail = classify(error, used_model=False, provider_error=ErrorCode.LLM_UNAVAILABLE)

    assert code is ErrorCode.MCP_UNAVAILABLE and '"Issues"' in detail


# #1142-T18
def test_the_new_code_is_known_to_the_runner_contract_and_is_a_stable_word() -> None:
    contract = json.loads(
        (Path(__file__).parents[3] / "contracts" / "runner-api.v1.json").read_text()
    )
    definitions = contract.get("$defs") or contract["definitions"]

    assert ErrorCode.MCP_UNAVAILABLE.value == "mcp_unavailable"
    assert "mcp_unavailable" in definitions["KnownRunnerErrorCode"]["enum"]
