# SPDX-License-Identifier: LicenseRef-Proprietary

"""#856: the Claude Code agent of one turn: what it asks of the container's exec channel, how the
`stream-json` it reads becomes steps, and how a turn that ends badly is told. The place is a double
that plays scripted output."""

import json
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

import pytest

from code_reviewer_runner.dynamic_review.adapter import EngineError
from code_reviewer_runner.dynamic_review.budget import LimitError
from code_reviewer_runner.implementer.agent import CommandOutcome
from code_reviewer_runner.implementer.claude_code.agent import ClaudeCodeAgent
from code_reviewer_runner.implementer.claude_code.command import AGENT_USER
from code_reviewer_runner.implementer.claude_code.login import ClaudeLogin
from code_reviewer_runner.implementer.preface import ResumeMode
from code_reviewer_runner.result import ErrorCode

TOKEN = "sk-" + "ant-" + "oat01-made-up-token-not-real-0000000000000000"
SESSION = "d847dcf5-e741-4252-98b0-d73cbc39f2c0"
OTHER = "9d3f1c52-7a0e-4d57-8c33-5b6c1f0a2e11"
USAGE: dict[str, Any] = {"input_tokens": 10, "output_tokens": 1}


def line(document: Mapping[str, Any]) -> bytes:
    return json.dumps(document).encode() + b"\n"


def stream(text: str = "All done.", *, api_error: str | None = None, **result: Any) -> list[bytes]:
    """The output of one turn: a message that ends in text, and the result. `api_error` is the
    `error` field Claude Code puts on the assistant message of a failed API call."""
    ended: dict[str, Any] = {
        "type": "result",
        "subtype": "success",
        "is_error": False,
        "result": text,
        "session_id": SESSION,
        "total_cost_usd": 0.0150285,
        "modelUsage": {"claude-sonnet-4-5": {"costBasis": "list"}},
    }
    ended.update(result)
    return [
        line({"type": "system", "subtype": "init", "session_id": SESSION}),
        line(
            {
                "type": "stream_event",
                "session_id": SESSION,
                "event": {"type": "message_start", "message": {"id": "msg_1", "usage": USAGE}},
            }
        ),
        line(
            {
                "type": "assistant",
                "session_id": SESSION,
                "timestamp": "2026-11-04T21:35:56.050Z",
                **({} if api_error is None else {"error": api_error}),
                "message": {
                    "id": "msg_1",
                    "content": [{"type": "text", "text": text}],
                    "usage": USAGE,
                },
            }
        ),
        line(
            {
                "type": "stream_event",
                "session_id": SESSION,
                "event": {
                    "type": "message_delta",
                    "delta": {"stop_reason": "end_turn"},
                    "usage": {"input_tokens": 10, "output_tokens": 24},
                },
            }
        ),
        line(ended),
    ]


@dataclass
class Run:
    argv: list[str]
    environment: dict[str, str]
    user: str
    stdin: bytes
    timeout: float


@dataclass
class Place:
    """The container: scripted output for each `claude` run, and a record of what was asked."""

    outputs: list[list[bytes]] = field(default_factory=lambda: [stream()])
    returncode: int = 0
    runs: list[Run] = field(default_factory=lambda: [])
    commands: list[list[str]] = field(default_factory=lambda: [])
    files: dict[str, tuple[bytes, int]] = field(default_factory=lambda: {})
    stopped: bool = False
    during: Callable[[], None] | None = None

    def write_files(self, files: Mapping[str, tuple[bytes, int]]) -> None:
        self.files.update(files)

    def run_command(
        self, argv: list[str], environment: Mapping[str, str], timeout: float
    ) -> CommandOutcome:
        self.commands.append(argv)
        return CommandOutcome(0, "")

    def run_streaming(
        self,
        argv: list[str],
        environment: Mapping[str, str],
        *,
        user: str,
        stdin: bytes,
        timeout: float,
        consume: Callable[[bytes], None],
    ) -> CommandOutcome:
        self.runs.append(Run(argv, dict(environment), user, stdin, timeout))
        if self.during is not None:
            self.during()
        for chunk in self.outputs[min(len(self.runs), len(self.outputs)) - 1]:
            # The exec channel delivers arbitrary pieces: cut each line in two.
            consume(chunk[: len(chunk) // 2])
            consume(chunk[len(chunk) // 2 :])
        return CommandOutcome(self.returncode, "")

    def engine_end_note(self) -> str | None:
        return None

    def stop(self) -> bool:
        self.stopped = True
        return True


def agent_of(place: Place, **changes: Any) -> ClaudeCodeAgent:
    options: dict[str, Any] = {
        "place": place,
        "login": ClaudeLogin.oauth_token(TOKEN),
        "model": "claude-sonnet-4-5",
        "session_id": SESSION,
        "secrets": (),
        "remaining_seconds": lambda: 600.0,
        "check_deadline": lambda: None,
        "instructions": "Rules of this workplace",
    }
    options.update(changes)
    agent = ClaudeCodeAgent(**options)
    agent.start()
    return agent


# #856-T18
def test_a_turn_runs_claude_as_the_unprivileged_user_with_the_prompt_on_stdin() -> None:
    place = Place()

    agent_of(place).turn("Fix the bug")

    [run] = place.runs
    assert run.user == AGENT_USER
    assert run.stdin == b"Fix the bug"
    assert run.argv[:2] == ["claude", "-p"] and "Fix the bug" not in run.argv
    assert run.argv[run.argv.index("--session-id") + 1] == SESSION
    assert run.environment["CLAUDE_CODE_OAUTH_TOKEN"] == TOKEN
    assert TOKEN not in " ".join(run.argv)
    assert 0 < run.timeout <= 700


# #856-T18
def test_the_set_up_hands_the_repository_and_the_result_directory_to_that_user_as_root() -> None:
    place = Place()

    agent_of(place)

    [command] = place.commands
    assert "chown" in " ".join(command) and AGENT_USER in command


# #856-T18
def test_the_text_parts_of_a_follow_up_message_are_one_prompt() -> None:
    place = Place()

    agent_of(place).turn([{"type": "text", "text": "Earlier."}, {"type": "text", "text": "Now."}])

    assert place.runs[0].stdin == b"Earlier.\n\nNow."


# #856-T19
def test_the_events_of_the_turn_become_step_records_and_the_text_is_the_answer() -> None:
    place = Place()
    agent = agent_of(place, secrets=(TOKEN,))

    ended = agent.turn("Fix the bug")

    assert ended.text == "All done."
    assert agent.steps is not None
    records = agent.steps.drain(100)
    assert [(r.kind, r.part_id) for r in records] == [("text", "msg_1.1"), ("step", "msg_1.step")]
    assert agent.session_id == SESSION and agent.step_notes() == ()


# #856-T19
def test_a_secret_that_is_in_the_output_is_redacted_in_the_records() -> None:
    place = Place(outputs=[stream(f"my token is {TOKEN}")])
    agent = agent_of(place, secrets=(TOKEN,))

    agent.turn("Fix the bug")

    assert agent.steps is not None
    assert all(TOKEN not in json.dumps(r.as_json()) for r in agent.steps.drain(100))


# #856-T20
def test_the_cost_is_an_estimate_added_over_the_turns_of_the_session() -> None:
    place = Place(outputs=[stream(), stream(total_cost_usd=0.01)])
    agent = agent_of(place)

    agent.turn("one")
    agent.turn("two")

    assert agent.estimated_cost_usd == Decimal("0.0250285")
    assert agent.cost_known


# #856-T20
def test_one_turn_without_a_list_price_makes_the_whole_estimate_unknown() -> None:
    unknown = {"made-up": {"costBasis": "unknown"}}
    place = Place(outputs=[stream(), stream(modelUsage=unknown)])
    agent = agent_of(place)

    agent.turn("one")
    agent.turn("two")

    assert agent.estimated_cost_usd is None and not agent.cost_known


# #856-T21
def test_a_second_message_continues_the_session_of_the_first() -> None:
    place = Place(outputs=[stream(), stream("Again.")])
    agent = agent_of(place)

    agent.turn("one")
    again = agent.turn("two")

    first, second = place.runs
    assert "--session-id" in first.argv and "--resume" not in first.argv
    assert second.argv[second.argv.index("--resume") + 1] == SESSION
    assert again.text == "Again."


# #856-T21
def test_a_follow_up_turn_resumes_the_stored_session() -> None:
    place = Place()

    agent = agent_of(place, resume_from=OTHER)
    agent.turn("go on")

    [run] = place.runs
    assert run.argv[run.argv.index("--resume") + 1] == OTHER
    assert agent.session_id == OTHER
    assert agent.resume is not None and agent.resume.mode is ResumeMode.IMPORTED


# #856-T21
def test_an_empty_session_volume_starts_a_fresh_session_under_the_same_id() -> None:
    # As the real program prints it: the sentence is in `errors`, the `result` text is empty.
    missing = stream(
        "",
        errors=["No conversation found with session ID: " + OTHER],
        subtype="error_during_execution",
        is_error=True,
        total_cost_usd=0,
        modelUsage={},
    )
    place = Place(outputs=[missing, stream("Fresh start.")])
    agent = agent_of(place, resume_from=OTHER)

    ended = agent.turn("go on")

    first, second = place.runs
    assert "--resume" in first.argv
    assert (
        second.argv[second.argv.index("--session-id") + 1] == OTHER
        and "--resume" not in second.argv
    )
    assert ended.text == "Fresh start."
    assert agent.resume is not None and agent.resume.mode is ResumeMode.SUMMARY_ONLY


# #856-T22
def test_the_result_schema_of_the_turn_brings_the_finish_tool_into_the_container() -> None:
    place = Place()
    schema = {
        "type": "object",
        "required": ["summary"],
        "properties": {"summary": {"type": "string"}},
    }

    agent_of(place, result_schema=schema).turn("go")

    assert set(place.files) >= {"factory-submit", "result-schema.json"}
    argv = place.runs[0].argv
    servers = json.loads(argv[argv.index("--mcp-config") + 1])["mcpServers"]
    assert list(servers) == ["finish"] and servers["finish"]["args"][-1] == "mcp"


# #856-T22
def test_a_turn_without_a_result_schema_brings_no_file_and_no_server() -> None:
    place = Place()

    agent_of(place).turn("go")

    assert place.files == {} and "--mcp-config" not in place.runs[0].argv


# #856-T23
def test_a_turn_that_ran_out_of_budget_is_the_cost_limit() -> None:
    place = Place(outputs=[stream("", subtype="error_max_budget_usd", is_error=True)], returncode=1)

    with pytest.raises(LimitError) as stopped:
        agent_of(place, max_budget_usd="1.50").turn("go")

    assert stopped.value.code is ErrorCode.COST_LIMIT_REACHED
    assert place.runs[0].argv[place.runs[0].argv.index("--max-budget-usd") + 1] == "1.50"


# #856-T23
def test_a_device_that_is_not_logged_in_is_an_auth_error_that_says_so() -> None:
    place = Place(
        outputs=[
            stream(
                "Not logged in · Please run /login",
                api_error="authentication_failed",
                is_error=True,
                subtype="success",
            )
        ],
        returncode=1,
    )

    with pytest.raises(EngineError) as failed:
        agent_of(place).turn("go")

    assert failed.value.code is ErrorCode.LLM_AUTH
    assert TOKEN not in str(failed.value)


# #856-T23
def test_an_expired_or_revoked_token_is_the_auth_error_not_an_engine_failure() -> None:
    for status in (401, None):
        place = Place(
            outputs=[
                stream(
                    "OAuth token has expired · Please run /login",
                    api_error="authentication_failed",
                    api_error_status=status,
                    is_error=True,
                    terminal_reason="api_error",
                )
            ],
            returncode=1,
        )

        with pytest.raises(EngineError) as failed:
            agent_of(place).turn("go")

        assert failed.value.code is ErrorCode.LLM_AUTH
        assert "run /login" not in str(failed.value), "what Claude Code printed is not passed on"


# #856-T23
def test_a_rejected_status_alone_is_the_auth_error_too() -> None:
    place = Place(
        outputs=[stream("x", api_error_status=401, is_error=True, terminal_reason="api_error")],
        returncode=1,
    )

    with pytest.raises(EngineError) as failed:
        agent_of(place).turn("go")

    assert failed.value.code is ErrorCode.LLM_AUTH


# #856-T23
def test_the_usage_limit_of_a_subscription_is_a_clean_limit_code() -> None:
    for error, status in (("rate_limit", 429), ("rate_limit", None), ("billing_error", 402)):
        place = Place(
            outputs=[
                stream(
                    "You've hit your limit · resets 3pm",
                    api_error=error,
                    api_error_status=status,
                    is_error=True,
                    terminal_reason="api_error",
                )
            ],
            returncode=1,
        )

        with pytest.raises(LimitError) as stopped:
            agent_of(place).turn("go")

        assert stopped.value.code is ErrorCode.LLM_QUOTA
        assert "resets" not in str(stopped.value) and TOKEN not in str(stopped.value)


# #856-T23
def test_what_the_agent_says_in_its_text_is_never_taken_for_a_failure_of_the_login() -> None:
    """A failed turn whose text happens to say the words: it is an engine failure, nothing more."""
    place = Place(
        outputs=[
            stream(
                "I am not logged in to the registry; no conversation found",
                is_error=True,
                subtype="error_during_execution",
                terminal_reason="aborted_streaming",
            )
        ],
        returncode=1,
    )

    with pytest.raises(EngineError) as failed:
        agent_of(place).turn("go")

    assert failed.value.code is ErrorCode.IMPLEMENTER_ENGINE_UNAVAILABLE


# #856-T23
def test_an_api_error_of_an_earlier_turn_does_not_mark_the_next_one() -> None:
    place = Place(
        outputs=[
            stream("x", api_error="rate_limit", is_error=True, terminal_reason="api_error"),
            stream("fine", is_error=True, subtype="error_during_execution"),
        ],
        returncode=1,
    )
    agent = agent_of(place)
    with pytest.raises(LimitError):
        agent.turn("go")

    with pytest.raises(EngineError) as failed:
        agent.turn("again")

    assert failed.value.code is ErrorCode.IMPLEMENTER_ENGINE_UNAVAILABLE


# #856-T23
def test_a_process_that_ends_without_a_result_is_an_engine_failure_with_its_exit_code() -> None:
    place = Place(outputs=[[line({"type": "system", "subtype": "init"})]], returncode=137)

    with pytest.raises(EngineError) as failed:
        agent_of(place).turn("go")

    assert failed.value.code is ErrorCode.IMPLEMENTER_ENGINE_UNAVAILABLE
    assert "137" in str(failed.value)


# #856-T23
def test_the_clock_is_checked_after_a_turn_and_its_limit_is_the_limit_of_the_turn() -> None:
    def expired() -> None:
        raise LimitError(ErrorCode.TIME_LIMIT_REACHED, "the clock ran out")

    place = Place()

    with pytest.raises(LimitError) as stopped:
        agent_of(place, remaining_seconds=lambda: 0.0, check_deadline=expired).turn("go")

    assert stopped.value.code is ErrorCode.TIME_LIMIT_REACHED
    assert place.runs == []


# #856-T24
def test_a_check_that_raises_ends_the_turn_with_its_error() -> None:
    release = threading.Event()

    def hang() -> None:
        release.wait(5)

    place = Place(during=hang)

    def check() -> None:
        release.set()
        raise RuntimeError("the lease is lost")

    with pytest.raises(RuntimeError, match="lease is lost"):
        agent_of(place).turn("go", check=check)


# #856-T24
def test_stopping_the_agent_stops_its_place() -> None:
    place = Place()
    agent = agent_of(place)

    assert agent.stop() is True and place.stopped
