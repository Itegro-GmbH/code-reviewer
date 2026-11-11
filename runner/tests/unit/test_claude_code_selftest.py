# SPDX-License-Identifier: LicenseRef-Proprietary

"""#856: what `factory-runner selftest` says about Claude Code. By default readiness only (login,
layer, version in a throwaway container with no network) and never a model call; with the explicit
flag one tiny turn with the device's login behind the forced network door. The daemon, the door
and the container are doubles, and the "model" is a scripted `stream-json`; nothing here reaches a
real model."""

import json
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest

from code_reviewer_runner.factory_runner import claude_code_selftest as module
from code_reviewer_runner.factory_runner.claude_code_selftest import (
    CHECK_LAYER,
    CHECK_LOGIN,
    CHECK_TURN,
    CHECK_VERSION,
    ClaudeSelfTestSeams,
    claude_code_checks,
)
from code_reviewer_runner.factory_runner.selftest import Check, SelfTestResult
from code_reviewer_runner.implementer.agent import CommandOutcome
from code_reviewer_runner.implementer.agent_container import AgentSeams
from code_reviewer_runner.implementer.claude_code.command import AGENT_USER
from code_reviewer_runner.implementer.claude_code.layer import LayerSpec, layer_labels, layer_tag
from code_reviewer_runner.implementer.docker_api import DockerError
from code_reviewer_runner.implementer.git_process import Outcome
from code_reviewer_runner.implementer.network_rule import MODE_LIST, NetworkRule
from code_reviewer_runner.job import IMPLEMENTER_AGENT_MEMORY_VARIABLE, JobError
from code_reviewer_runner.result import ErrorCode

pytestmark = pytest.mark.unit

TOKEN = "sk-" + "ant-" + "oat01-made-up-token-not-real-0000000000000000"
BASE = "sha256:" + "ab" * 32
SESSION = "d847dcf5-e741-4252-98b0-d73cbc39f2c0"
SPEC = LayerSpec()
JOB_ENVIRONMENT = {IMPLEMENTER_AGENT_MEMORY_VARIABLE: "2048"}


class Daemon:
    """The calls the checks make of the daemon."""

    def __init__(self, *, layer: bool = True, labels: Mapping[str, str] | None = None) -> None:
        self.images: dict[str, dict[str, Any]] = {"code-reviewer-agent:golden": {"Id": BASE}}
        if layer:
            self.images[layer_tag(BASE, SPEC)] = {
                "Config": {"Labels": dict(labels or layer_labels(SPEC))}
            }
        self.created: list[tuple[dict[str, Any], str]] = []
        self.started: list[str] = []
        self.removed: list[str] = []

    def inspect_image(self, reference: str) -> dict[str, Any]:
        if reference not in self.images:
            raise DockerError(404, "no such image")
        return self.images[reference]

    def build_image(self, context: bytes, tag: str, *, timeout: float) -> None:
        raise AssertionError("the self-test never builds a layer")

    def inspect_container(self, _reference: str) -> dict[str, Any]:
        raise DockerError(404, "no such container")

    def create_container(self, document: dict[str, Any], name: str) -> str:
        self.created.append((document, name))
        return "cid"

    def start_container(self, container: str) -> None:
        self.started.append(container)

    def stop_container(self, container: str, *, grace: int, timeout: float) -> None:
        return None

    def remove_container(self, container: str) -> None:
        self.removed.append(container)


class Commands:
    """What the throwaway container's commands answer; every one is recorded."""

    def __init__(self) -> None:
        self.version = "2.1.311 (Claude Code)"
        self.code = 0
        self.log: list[list[str]] = []
        self.users: list[str | None] = []

    def __call__(self, api: Any, container: str, argv: Sequence[str], **kwargs: Any) -> Outcome:
        self.log.append(list(argv))
        self.users.append(kwargs.get("user"))
        if argv[0] == "/usr/bin/test":
            return Outcome(0, "", "")
        return Outcome(self.code, self.version + "\n", "")


def line(document: Mapping[str, Any]) -> bytes:
    return json.dumps(document).encode() + b"\n"


def scripted(text: str = "ok", **result: Any) -> list[bytes]:
    ended: dict[str, Any] = {
        "type": "result",
        "subtype": "success",
        "is_error": False,
        "result": text,
        "session_id": SESSION,
        "total_cost_usd": 0.0150285,
        "modelUsage": {"claude-haiku-4-5": {"costBasis": "list"}},
    }
    ended.update(result)
    return [
        line({"type": "system", "subtype": "init", "session_id": SESSION}),
        line(
            {
                "type": "assistant",
                "session_id": SESSION,
                "message": {
                    "id": "msg_1",
                    "content": [{"type": "text", "text": text}],
                    "usage": {"input_tokens": 10, "output_tokens": 1},
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


@dataclass
class Place:
    output: list[bytes] = field(default_factory=lambda: scripted())
    runs: list[Run] = field(default_factory=lambda: [])
    created: bool = False
    stopped: bool = False
    removed: bool = False

    def create(self) -> tuple[str, ...]:
        self.created = True
        return ()

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
        consume: Callable[[bytes], None],
    ) -> CommandOutcome:
        self.runs.append(Run(argv, dict(environment), user, stdin))
        for chunk in self.output:
            consume(chunk)
        return CommandOutcome(0, "")

    def engine_end_note(self) -> str | None:
        return None

    def stop(self) -> bool:
        self.stopped = True
        return True

    def remove(self) -> None:
        self.removed = True


class Door:
    def __init__(self, rule: NetworkRule, seconds: float) -> None:
        self.rule = rule
        self.seconds = seconds
        self.stopped = False

    def stop(self) -> dict[str, Any] | None:
        self.stopped = True
        return {"allowed": 3, "refused": 0}


class Rig:
    def __init__(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        self.daemon = Daemon()
        self.commands = Commands()
        monkeypatch.setattr(module, "run_exec", self.commands)
        self.doors: list[Door] = []
        self.places: list[Place] = []
        self.place_seams: list[tuple[int, AgentSeams, NetworkRule]] = []
        self.door_error: JobError | None = None
        self.place = Place()
        self.home = tmp_path
        self.source = self.with_token()
        self.seams = ClaudeSelfTestSeams(
            start_door=self._door,
            make_place=self._place,
            clock=lambda: 0.0,
            sleep=lambda _seconds: None,
            new_session=lambda: SESSION,
        )

    def with_token(self, mode: int = 0o600) -> dict[str, str]:
        path = self.home / "claude-code-token"
        path.write_text(TOKEN)
        path.chmod(mode)
        return {"FACTORY_RUNNER_HOME": str(self.home)}

    def _door(self, rule: NetworkRule, seconds: float) -> Door:
        if self.door_error is not None:
            raise self.door_error
        door = Door(rule, seconds)
        self.doors.append(door)
        return door

    def _place(self, memory_mb: int, seams: AgentSeams, rule: NetworkRule) -> Place:
        self.place_seams.append((memory_mb, seams, rule))
        self.places.append(self.place)
        return self.place

    def run(self, *, with_turn: bool = False, runner_id: str = "r1") -> tuple[Check, ...]:
        return claude_code_checks(
            self.daemon,  # type: ignore[arg-type]
            self.source,
            JOB_ENVIRONMENT,
            self.home,
            with_turn=with_turn,
            runner_id=runner_id,
            seams=self.seams,
        )


@pytest.fixture
def rig(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Rig:
    return Rig(tmp_path, monkeypatch)


def outcome(checks: tuple[Check, ...]) -> list[tuple[str, bool]]:
    return [(check.name, check.ok) for check in checks]


def no_token_anywhere(checks: tuple[Check, ...]) -> None:
    assert all(TOKEN not in check.detail for check in checks)


# #856-S01
def test_a_device_with_no_login_says_nothing_by_default_and_touches_nothing(
    rig: Rig, tmp_path: Path
) -> None:
    (tmp_path / "claude-code-token").unlink()

    assert rig.run() == ()
    assert rig.daemon.created == [] and rig.commands.log == [] and rig.doors == []


# #856-S02
def test_a_device_with_no_login_that_is_asked_for_the_turn_says_why_it_fails(
    rig: Rig, tmp_path: Path
) -> None:
    (tmp_path / "claude-code-token").unlink()

    checks = rig.run(with_turn=True)

    assert outcome(checks) == [(CHECK_LOGIN, False)]
    assert rig.doors == [] and rig.daemon.created == []


# #856-S02
def test_a_login_file_others_can_read_fails_the_login_check_in_words_and_stops(rig: Rig) -> None:
    rig.source = rig.with_token(mode=0o644)

    checks = rig.run()

    assert outcome(checks) == [(CHECK_LOGIN, False)]
    no_token_anywhere(checks)
    assert rig.daemon.created == [] and rig.doors == []


# #856-S03
def test_readiness_is_the_login_the_layer_and_the_version_and_calls_no_model(rig: Rig) -> None:
    checks = rig.run()

    assert outcome(checks) == [(CHECK_LOGIN, True), (CHECK_LAYER, True), (CHECK_VERSION, True)]
    assert "pinned digests" in checks[1].detail
    no_token_anywhere(checks)
    # No door, no container of a turn, and no `claude -p`: the only claude command is `--version`.
    assert rig.doors == [] and rig.places == []
    claude = [argv for argv in rig.commands.log if argv[0] == "claude"]
    assert claude == [["claude", "--version"]]
    assert all(TOKEN not in " ".join(argv) for argv in rig.commands.log)


# #856-S03
def test_the_version_is_asked_in_a_throwaway_container_with_no_network_as_the_agent_user(
    rig: Rig,
) -> None:
    rig.run()

    ((document, name),) = rig.daemon.created
    assert document["Image"] == layer_tag(BASE, SPEC)
    assert document["HostConfig"]["NetworkMode"] == "none"
    assert document["HostConfig"]["Mounts"] == []
    assert TOKEN not in json.dumps(document)
    assert "r1" in json.dumps(document["Labels"]), "labelled with the runner, so a sweep finds it"
    assert name == "code-reviewer-selftest-agent"
    assert rig.commands.users[-1] == AGENT_USER
    assert rig.daemon.removed == ["cid"], "the container is removed"


# #856-S03
def test_a_layer_that_is_not_built_is_said_and_nothing_is_started(rig: Rig) -> None:
    rig.daemon = Daemon(layer=False)

    checks = rig.run()

    assert outcome(checks) == [(CHECK_LOGIN, True), (CHECK_LAYER, False)]
    assert "not built" in checks[1].detail
    assert rig.daemon.created == []


# #856-S03
def test_a_layer_with_the_labels_of_another_build_is_not_taken_for_the_pin(rig: Rig) -> None:
    rig.daemon = Daemon(labels={"com.code-reviewer.claude-code": "0.0.1"})

    assert outcome(rig.run()) == [(CHECK_LOGIN, True), (CHECK_LAYER, False)]


# #856-S03
def test_a_program_that_reports_another_version_fails_the_version_check(rig: Rig) -> None:
    rig.commands.version = "2.0.0 (Claude Code)"

    checks = rig.run()

    assert outcome(checks)[-1] == (CHECK_VERSION, False)
    assert "2.0.0" in checks[-1].detail
    assert rig.daemon.removed == ["cid"]


# #856-S03
def test_a_program_that_does_not_run_fails_the_version_check_and_the_container_is_removed(
    rig: Rig,
) -> None:
    rig.commands.code = 127

    assert outcome(rig.run())[-1] == (CHECK_VERSION, False)
    assert rig.daemon.removed == ["cid"]


# #856-S04
def test_the_tiny_turn_runs_only_when_asked_and_with_the_forced_door_and_the_logged_in_agent(
    rig: Rig,
) -> None:
    checks = rig.run(with_turn=True)

    assert outcome(checks) == [
        (CHECK_LOGIN, True),
        (CHECK_LAYER, True),
        (CHECK_VERSION, True),
        (CHECK_TURN, True),
    ]
    [door] = rig.doors
    assert door.rule == NetworkRule(MODE_LIST, ("api.anthropic.com",), ports=(443,))
    ((memory, seams, rule),) = rig.place_seams
    assert (memory, rule) == (2048, door.rule)
    assert seams.image == layer_tag(BASE, SPEC) and seams.no_new_privileges is True
    [run] = rig.place.runs
    assert run.user == AGENT_USER and run.argv[0] == "claude" and "-p" in run.argv
    assert run.argv[run.argv.index("--model") + 1] == "haiku"
    assert float(run.argv[run.argv.index("--max-budget-usd") + 1]) <= 0.5
    assert TOKEN not in " ".join(run.argv) and TOKEN in run.environment.values()
    assert b"ok" in run.stdin.lower()
    assert door.stopped and rig.place.stopped and rig.place.removed


# #856-S04
def test_the_tiny_turn_says_its_estimate_and_the_door_log_and_never_the_login(rig: Rig) -> None:
    checks = rig.run(with_turn=True)

    turn = checks[-1]
    assert turn.ok
    assert "≈ $0.0150" in turn.detail and "subscription" in turn.detail
    assert "let 3" in turn.detail
    no_token_anywhere(checks)


# #856-S04
def test_a_turn_that_does_not_answer_with_the_word_fails(rig: Rig) -> None:
    rig.place.output = scripted("I will not say it.")

    turn = rig.run(with_turn=True)[-1]

    assert (turn.name, turn.ok) == (CHECK_TURN, False)
    assert rig.doors[0].stopped and rig.place.removed


# #856-S04
@pytest.mark.parametrize("text", ["Take a look at the token.", "book", "not okay"])
def test_a_word_that_only_holds_the_letters_is_not_the_answer(rig: Rig, text: str) -> None:
    rig.place.output = scripted(text)

    turn = rig.run(with_turn=True)[-1]

    assert (turn.name, turn.ok) == (CHECK_TURN, False)


# #856-S04
@pytest.mark.parametrize("text", ["ok", "OK.", "Ok!", " ok \n"])
def test_the_answer_ok_passes_whatever_its_case_and_full_stop(rig: Rig, text: str) -> None:
    rig.place.output = scripted(text)

    turn = rig.run(with_turn=True)[-1]

    assert (turn.name, turn.ok) == (CHECK_TURN, True)


# #856-S05
def test_a_login_the_api_refuses_fails_the_turn_with_the_code_and_cleans_up(rig: Rig) -> None:
    rig.place.output = scripted(
        "Invalid API key",
        subtype="success",
        is_error=True,
        errors=["authentication_failed"],
    )
    rig.place.output.insert(
        1,
        line(
            {
                "type": "assistant",
                "session_id": SESSION,
                "error": "authentication_failed",
                "message": {"id": "m", "content": [{"type": "text", "text": "x"}], "usage": {}},
            }
        ),
    )

    checks = rig.run(with_turn=True)

    assert outcome(checks)[-1] == (CHECK_TURN, False)
    assert ErrorCode.SUBSCRIPTION_AUTH.value in checks[-1].detail
    no_token_anywhere(checks)
    assert rig.doors[0].stopped and rig.place.stopped and rig.place.removed


# #856-S05
def test_a_door_that_does_not_start_fails_the_turn_and_no_container_is_made(rig: Rig) -> None:
    rig.door_error = JobError(ErrorCode.SETUP_FAILED, "network_door_unavailable: no")

    turn = rig.run(with_turn=True)[-1]

    assert (turn.name, turn.ok) == (CHECK_TURN, False)
    assert "network_door_unavailable" in turn.detail
    assert rig.places == []


# #856-S05
def test_a_container_that_cannot_be_made_fails_the_turn_and_the_door_is_stopped(rig: Rig) -> None:
    def refused() -> tuple[str, ...]:
        raise JobError(ErrorCode.SETUP_FAILED, "agent_container_unavailable: no runtime")

    rig.place.create = refused  # type: ignore[method-assign]

    turn = rig.run(with_turn=True)[-1]

    assert (turn.name, turn.ok) == (CHECK_TURN, False)
    assert rig.doors[0].stopped


# #856-S04
def test_no_turn_runs_when_the_readiness_failed_even_if_asked(rig: Rig) -> None:
    rig.daemon = Daemon(layer=False)

    checks = rig.run(with_turn=True)

    assert CHECK_TURN not in [check.name for check in checks]
    assert rig.doors == [] and rig.places == []


# #856-S06
def test_a_failing_claude_code_check_never_costs_the_base() -> None:
    base = (Check("docker", True), Check("opencode", True))
    failing = (Check(CHECK_LOGIN, False, "x"), Check(CHECK_TURN, False, "y"))
    result = SelfTestResult((*base, *failing), "runc")

    assert result.base_ok and result.failed() is None
    assert result.claude_code_checks == failing
    assert not SelfTestResult((*base, Check("agent-image", False)), "runc").base_ok
