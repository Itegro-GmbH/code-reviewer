# SPDX-License-Identifier: LicenseRef-Proprietary

"""The import of a stored conversation by the agent (#840, part of #745): written and imported
before the engine starts, with the engine's environment, then checked; and every reason the import
can fail for, each ending in a fresh session and a reason word. None of them fails the turn."""

import json
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

import pytest

from code_reviewer_runner.dynamic_review.adapter import PINNED_ENGINE_VERSION
from code_reviewer_runner.dynamic_review.budget import BudgetLedger, UnitCosts
from code_reviewer_runner.implementer.agent import (
    CONFIG_DIRECTORY,
    CommandOutcome,
    ImplementerAgent,
    ResumeOutcome,
)
from code_reviewer_runner.implementer.limits import agent_limits
from code_reviewer_runner.implementer.preface import ResumeMode
from code_reviewer_runner.implementer.resume_session import ResumeInput, ResumeSnapshot
from code_reviewer_runner.resume_wire import ResumeReason

IMPORTED_ID = "ses_imported0001"
FRESH_ID = "ses_fresh0002"


@dataclass
class Place:
    """The agent's container of the test: records what was written and run, in order."""

    events: list[str] = field(default_factory=lambda: [])
    written: dict[str, tuple[bytes, int]] = field(default_factory=lambda: {})
    commands: list[tuple[list[str], dict[str, str], float]] = field(default_factory=lambda: [])
    outcome: CommandOutcome | Exception = field(default_factory=lambda: CommandOutcome(0, "ok"))

    def write_files(self, files: Mapping[str, tuple[bytes, int]]) -> None:
        self.events.append("write:" + ",".join(files))
        self.written.update(files)

    def run_command(
        self, argv: list[str], environment: Mapping[str, str], timeout: float
    ) -> CommandOutcome:
        self.events.append("run")
        self.commands.append((argv, dict(environment), timeout))
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return self.outcome

    def start_engine(self, argv: list[str], environment: Mapping[str, str]) -> str:
        self.events.append("start_engine")
        return "http://127.0.0.1:4096"

    def engine_running(self) -> bool:
        return True

    def settle(self, seconds: float) -> None:
        return None

    def engine_end_note(self) -> str | None:
        return None

    def stop(self) -> bool:
        return True


class Engine:
    """The engine's HTTP API as far as `start` uses it."""

    def __init__(self, place: Place, *, knows_imported: bool = True) -> None:
        self.place = place
        self.knows_imported = knows_imported
        self.calls: list[tuple[str, str]] = []

    def __call__(
        self, method: str, url: str, payload: bytes | None, headers: Mapping[str, str], t: float
    ) -> tuple[int, bytes]:
        path = url.removeprefix("http://127.0.0.1:4096")
        self.calls.append((method, path))
        if path == "/global/health":
            return 200, json.dumps({"healthy": True, "version": PINNED_ENGINE_VERSION}).encode()
        if method == "POST" and path == "/session":
            self.place.events.append("create_session")
            return 200, json.dumps({"id": FRESH_ID}).encode()
        if method == "GET" and path == f"/session/{IMPORTED_ID}":
            if self.knows_imported:
                return 200, json.dumps({"id": IMPORTED_ID}).encode()
            return 404, b"{}"
        return 404, b"{}"


def snapshot(version: str = PINNED_ENGINE_VERSION) -> ResumeSnapshot:
    return ResumeSnapshot(
        data=b'{"info":{"id":"x"},"messages":[]}', session_id=IMPORTED_ID, version=version
    )


def make_agent(
    place: Place, engine: Engine, *, seconds: float = 600.0, clock: Any = time.monotonic
) -> ImplementerAgent:
    ledger = BudgetLedger(
        agent_limits(seconds, Decimal("5"), "cost_limit"),
        unit_costs=UnitCosts(input_usd_per_mtok=Decimal(1), output_usd_per_mtok=Decimal(4)),
        clock=clock,
    )
    agent = ImplementerAgent(
        ledger=ledger,
        runtime=place,
        command=["opencode"],
        directory="/work/repo",
        make_config=lambda path: {"instructions": [path]},
        instructions=("implementer-instructions.md", "text"),
        environment={"HOME": "/root", "XDG_DATA_HOME": "/root/.local/share"},
        model="m",
        provider_id="p",
        transport=engine,
    )
    # The audit rides on the engine's event stream, which these tests do not have.
    agent._open_audit = lambda client, session_id: None  # type: ignore[method-assign]  # pyright: ignore[reportPrivateUsage]
    return agent


def start(
    *,
    input: ResumeInput | None,
    outcome: CommandOutcome | Exception | None = None,
    knows_imported: bool = True,
    seconds: float = 600.0,
) -> tuple[ImplementerAgent, Place, Engine]:
    place = Place()
    if outcome is not None:
        place.outcome = outcome
    engine = Engine(place, knows_imported=knows_imported)
    agent = make_agent(place, engine, seconds=seconds)
    agent.start(4096, input)
    return agent, place, engine


# #840-T70
def test_the_conversation_is_imported_before_the_engine_starts_and_the_turn_continues_in_it() -> (
    None
):
    agent, place, engine = start(input=ResumeInput(snapshot(), None))

    assert place.events == [
        "write:implementer-instructions.md,opencode.json",
        "write:resume.json",
        "run",
        "start_engine",
    ]
    assert agent.session_id == IMPORTED_ID
    assert agent.resume == ResumeOutcome(ResumeMode.IMPORTED)
    assert ("POST", "/session") not in engine.calls, "no fresh session on the imported path"
    assert ("GET", f"/session/{IMPORTED_ID}") in engine.calls


# #840-T71
def test_the_file_is_owner_only_and_the_import_runs_with_the_environment_of_the_engine() -> None:
    _, place, _ = start(input=ResumeInput(snapshot(), None))

    data, mode = place.written["resume.json"]
    assert data == snapshot().data
    assert mode == 0o600
    argv, environment, _ = place.commands[0]
    assert argv == ["opencode", "import", f"{CONFIG_DIRECTORY}/resume.json"]
    assert environment["HOME"] == "/root"
    assert environment["XDG_DATA_HOME"] == "/root/.local/share"
    assert environment["OPENCODE_CONFIG"] == f"{CONFIG_DIRECTORY}/opencode.json"


# #840-T72
def test_the_import_is_time_boxed() -> None:
    _, place, _ = start(input=ResumeInput(snapshot(), None))

    assert 5.0 <= place.commands[0][2] <= 60.0


# #840-T73
@pytest.mark.parametrize(
    "reason",
    [
        ResumeReason.NO_SNAPSHOT,
        ResumeReason.DOWNLOAD_FAILED,
        ResumeReason.SNAPSHOT_UNREADABLE,
    ],
)
def test_a_turn_with_no_usable_conversation_starts_a_fresh_session_with_the_reason(
    reason: ResumeReason,
) -> None:
    agent, place, _ = start(input=ResumeInput.without(reason))

    assert agent.session_id == FRESH_ID
    assert agent.resume == ResumeOutcome(ResumeMode.SUMMARY_ONLY, reason)
    assert "run" not in place.events and "write:resume.json" not in place.events


# #840-T74
@pytest.mark.parametrize(
    "outcome",
    [
        CommandOutcome(1, "Error: session is not valid"),
        CommandOutcome(137, ""),
        CommandOutcome(255, "", unanswered=True),
        RuntimeError("the container went away"),
    ],
)
def test_an_import_that_fails_is_a_fresh_session_and_the_reason_import_failed(
    outcome: CommandOutcome | Exception,
) -> None:
    agent, place, _ = start(input=ResumeInput(snapshot(), None), outcome=outcome)

    assert agent.session_id == FRESH_ID
    assert agent.resume == ResumeOutcome(ResumeMode.SUMMARY_ONLY, ResumeReason.IMPORT_FAILED)
    assert place.events.index("start_engine") > place.events.index("run")


# #840-T75
def test_an_import_that_fails_after_the_pin_moved_names_the_version() -> None:
    agent, _, _ = start(
        input=ResumeInput(snapshot(version="1.18.0"), None),
        outcome=CommandOutcome(1, "cannot read"),
    )

    assert agent.session_id == FRESH_ID
    assert agent.resume == ResumeOutcome(ResumeMode.SUMMARY_ONLY, ResumeReason.VERSION_CHANGED)


# #840-T76
def test_an_import_of_an_older_version_that_works_is_just_imported() -> None:
    agent, _, _ = start(input=ResumeInput(snapshot(version="1.18.0"), None))

    assert agent.resume == ResumeOutcome(ResumeMode.IMPORTED)
    assert agent.session_id == IMPORTED_ID


# #840-T77
def test_an_import_that_printed_success_but_left_no_session_is_a_fresh_session() -> None:
    agent, _, engine = start(input=ResumeInput(snapshot(), None), knows_imported=False)

    assert agent.session_id == FRESH_ID
    assert agent.resume == ResumeOutcome(ResumeMode.SUMMARY_ONLY, ResumeReason.IMPORT_FAILED)
    assert ("POST", "/session") in engine.calls


# #840-T78
def test_a_session_that_the_engine_calls_by_another_id_is_not_taken_for_the_imported_one() -> None:
    place = Place()

    class Other(Engine):
        def __call__(self, method: str, url: str, payload: Any, headers: Any, t: float):  # type: ignore[no-untyped-def]
            if method == "GET" and url.endswith(f"/session/{IMPORTED_ID}"):
                return 200, json.dumps({"id": "ses_somebody_else"}).encode()
            return super().__call__(method, url, payload, headers, t)

    agent = make_agent(place, Other(place))
    agent.start(4096, ResumeInput(snapshot(), None))

    assert agent.session_id == FRESH_ID
    assert agent.resume is not None and agent.resume.mode is ResumeMode.SUMMARY_ONLY


# #840-T79
def test_a_turn_with_too_little_time_left_does_not_try_the_import() -> None:
    agent, place, _ = start(input=ResumeInput(snapshot(), None), seconds=3.0)

    assert "run" not in place.events
    assert agent.resume == ResumeOutcome(ResumeMode.SUMMARY_ONLY, ResumeReason.IMPORT_FAILED)
    assert agent.session_id == FRESH_ID


# #840-T80
def test_a_first_turn_has_no_resume_and_imports_nothing() -> None:
    agent, place, _ = start(input=None)

    assert agent.resume is None
    assert agent.session_id == FRESH_ID
    assert "run" not in place.events


# #840-T81
def test_the_first_message_of_a_turn_can_be_a_list_of_parts() -> None:
    place = Place()
    engine = Engine(place)
    sent: list[dict[str, Any]] = []

    class Capturing(Engine):
        def __call__(self, method: str, url: str, payload: Any, headers: Any, t: float):  # type: ignore[no-untyped-def]
            if method == "POST" and url.endswith("/message"):
                sent.append(json.loads(payload))
                return 200, json.dumps({"info": {"id": "m"}, "parts": []}).encode()
            return super().__call__(method, url, payload, headers, t)

    agent = make_agent(place, Capturing(place))
    agent.start(4096, None)
    parts = [
        {"type": "text", "text": "note", "synthetic": True},
        {"type": "text", "text": "do it"},
    ]

    agent.turn(parts)
    agent.turn("and again")

    assert sent[0]["parts"] == parts
    assert sent[1]["parts"] == [{"type": "text", "text": "and again"}]
    del engine
