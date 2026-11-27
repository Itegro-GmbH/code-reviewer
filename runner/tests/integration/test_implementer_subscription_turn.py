# SPDX-License-Identifier: LicenseRef-Proprietary

"""A whole turn on the harness `claude-code` through the runner's entry point, in process (#856):
the job glue, the session, the real Claude Code agent (its command line, its stream-json reading,
its redaction) over a double of the container, and the gates around it. What is doubled and proven
elsewhere: the container and the program in it (`tests/engine/test_engine_claude_code.py`, the
lane), the doors (`tests/unit`), and the push (`test_implementer_push_guard.py`). The shapes follow
`test_implementer_job.py`."""

import io
import json
import os
from collections.abc import Callable, Iterator, Mapping
from functools import partial
from pathlib import Path
from typing import Any

import pytest
from test_implementer_job import (
    EXAMPLE,
    TIP,
    TOKEN,
    FakeGit,
    FakePlace,
    LeaseChannel,
    held,
    valid_result,
)

from code_reviewer_runner import runner
from code_reviewer_runner.capabilities import ENGINE_IMPLEMENTER, ENGINES_VARIABLE
from code_reviewer_runner.implementer import session as session_module
from code_reviewer_runner.implementer.agent import CommandOutcome
from code_reviewer_runner.implementer.agent_container import Adopted
from code_reviewer_runner.implementer.claude_code.login import ClaudeLogin
from code_reviewer_runner.implementer.claude_code.readiness import HarnessNotReady, ReadyHarness
from code_reviewer_runner.implementer.door.subscription import SUBSCRIPTION_PLACEHOLDER
from code_reviewer_runner.implementer.environment_setup import EnvironmentSetup
from code_reviewer_runner.implementer.git_workspace import REASON_LOGIN_SECRET
from code_reviewer_runner.implementer.job_run import (
    EnvironmentHost,
    JobSeams,
    TurnSetup,
    run_implementer_job,
)
from code_reviewer_runner.implementer.network_rule import MODE_LIST, MODE_OPEN, NetworkRule
from code_reviewer_runner.implementer.placement import Placement
from code_reviewer_runner.implementer.session import SessionSeams
from code_reviewer_runner.job import JobError
from code_reviewer_runner.lease_check import LEASE_CHECK_FD_VARIABLE
from code_reviewer_runner.result import ErrorCode

LOGIN = "sk-" + "ant-" + "oat01-Zq9Lm3XvTn8Rk5Wc2-integrationtestintegrationtest"
SESSION = "d847dcf5-e741-4252-98b0-d73cbc39f2c0"
IMAGE = "code-reviewer-agent-claude-code:2.1.311-sha512-abcdef012345-0123456789ab"
PROFILE = {"name": "claude", "version": 1, "canPush": True, "harness": "claude-code"}


def subscription_job(environment: dict[str, Any] | None = None) -> str:
    document: dict[str, Any] = json.loads(EXAMPLE.read_text(encoding="utf-8"))
    spec = document["implementer"]
    del spec["cost"], spec["modelEntry"], document["llm"]
    spec["profile"] = dict(PROFILE)
    spec["subscription"] = {"model": "claude-sonnet-5-5", "maxBudgetUsd": "2.50"}
    if environment is not None:
        spec["environment"] = environment
    document["git"]["token"] = TOKEN
    return json.dumps(document)


def result_line(text: str, cost: float | None = 0.0123) -> bytes:
    document: dict[str, Any] = {
        "type": "result",
        "subtype": "success",
        "is_error": False,
        "result": text,
        "session_id": SESSION,
        "modelUsage": {"claude-sonnet-5-5": {"costBasis": "list"}},
    }
    if cost is not None:
        document["total_cost_usd"] = cost
    return json.dumps(document).encode() + b"\n"


class ClaudePlace(FakePlace):
    """The container with a program in it that prints what the test scripted and, meanwhile, does
    what the test says (commits)."""

    def __init__(self, events: list[str], removals: list[tuple[str, ...]], script: Any) -> None:
        super().__init__(events, removals)
        self.script = script
        self.runs: list[dict[str, Any]] = []

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
        self.runs.append({"argv": argv, "environment": dict(environment), "stdin": stdin})
        self.events.append("claude")
        consume(self.script(self))
        return CommandOutcome(0, "")


class FakeSubscriptionDoor:
    """The model door in its subscription mode (#1176): records the token it was handed and says
    where the agent reaches it."""

    url = "http://10.213.77.2:10180"
    end = None

    def __init__(self, token: str, events: list[str]) -> None:
        self.token = token
        self.stopped = 0
        self.events = events
        self.state = type("State", (), {"lost": None})()

    def stop(self) -> None:
        self.stopped += 1


class FakeNetDoor:
    end = None
    # The door's certificate authority, which a rule with read-only hosts has the container trust.
    registry_ca = b"-----BEGIN CERTIFICATE-----\nZG9vcg==\n-----END CERTIFICATE-----\n"

    def stop(self) -> None:
        return None


def setup_step(
    played: "Played", outcome: EnvironmentSetup | None = None
) -> Callable[..., EnvironmentSetup]:
    """The script's phase (#1126): what it saw is recorded, and the events say what ran before it.
    The login is handed to the agent's own exec, so the step is not given it; what proves the
    order against the real containers is `tests/unit/test_subscription_login_order.py`."""

    def run(job: Any, elapsed: Any, stop: Any, limit: float) -> EnvironmentSetup:
        played.events.append("setup")
        played.places_at_setup = len(played.places)
        if outcome is not None:
            return outcome
        block = {"ok": True, "exitCode": 0, "timedOut": False, "durationSeconds": 3, "output": "ok"}
        return EnvironmentSetup(Adopted("ab" * 32), block, None, ())

    return run


class Played:
    def __init__(self) -> None:
        self.output = ""
        self.exit_code = 0
        self.git: FakeGit | None = None
        self.places: list[ClaudePlace] = []
        self.rules: list[NetworkRule] = []
        self.doors: list[FakeSubscriptionDoor] = []
        self.setups = 0
        self.events: list[str] = []
        self.places_at_setup = -1

    @property
    def result(self) -> dict[str, Any]:
        lines = [line for line in self.output.splitlines() if line.strip()]
        assert len(lines) == 1, lines
        return json.loads(lines[0])


@pytest.fixture
def play(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[Callable[..., Played]]:
    for name in list(os.environ):
        if name.startswith("RUNNER_"):
            monkeypatch.delenv(name)
    monkeypatch.setenv(ENGINES_VARIABLE, ENGINE_IMPLEMENTER)
    monkeypatch.setenv("RUNNER_JOB_TIMEOUT_SECONDS", "600")
    monkeypatch.setenv("RUNNER_IMPLEMENTER_SANDBOX_PROOF", "proven")
    monkeypatch.setenv("RUNNER_IMPLEMENTER_AGENT_MEMORY_MB", "2560")
    channels: list[LeaseChannel] = []

    def run(
        script: Callable[[ClaudePlace], bytes],
        *,
        environment: dict[str, Any] | None = None,
        harness: ReadyHarness | HarnessNotReady | None = None,
        commit: str | None = TIP,
        subject: str = "Add it",
        form_rejected: tuple[str, str | None] | None = None,
        dirty: bool = False,
        setup_outcome: EnvironmentSetup | None = None,
        placement: Placement | None = None,
        door: Callable[..., Any] | None = None,
    ) -> Played:
        played = Played()
        if placement is not None:

            def fixed_placement(_environment: Mapping[str, str]) -> Placement:
                return placement

            monkeypatch.setattr(session_module, "placement_of", fixed_placement)
        lease = LeaseChannel(held)
        channels.append(lease)
        monkeypatch.setenv(LEASE_CHECK_FD_VARIABLE, str(lease.fd()))
        removals: list[tuple[str, ...]] = []

        def setup(job: Any, env: Any, gate: Callable[[], None]) -> TurnSetup:
            played.setups += 1
            git = FakeGit(tmp_path, gate)
            git.events = played.events
            git.form_rejected = form_rejected
            git.is_dirty = dirty
            played.git = git
            if commit is not None:
                real_script = script
                sha = commit

                def with_commit(place: ClaudePlace) -> bytes:
                    git.commit(sha, subject)
                    return real_script(place)

                factory = partial(ClaudePlace, played.events, removals, with_commit)
            else:
                factory = partial(ClaudePlace, played.events, removals, script)

            def place() -> ClaudePlace:
                made = factory()
                played.places.append(made)
                return made

            host = None
            if environment is not None and "setupScript" in environment:
                host = EnvironmentHost(setup_step(played, setup_outcome), lambda adopted: place)
            return TurnSetup(git, place, ("claude",), environment=host)

        def netdoor(rule: NetworkRule, **options: Any) -> FakeNetDoor:
            played.rules.append(rule)
            played.events.append("door")
            return FakeNetDoor()

        def no_door(**options: Any) -> None:
            raise AssertionError("a subscription turn has no model-key door")

        def subscription_door(*, token: str, **options: Any) -> FakeSubscriptionDoor:
            played.events.append("model-door")
            made = FakeSubscriptionDoor(token, played.events)
            played.doors.append(made)
            return made

        monkeypatch.setattr(session_module, "start_door", no_door)
        monkeypatch.setattr(
            session_module, "start_subscription_door", subscription_door if door is None else door
        )
        monkeypatch.setattr(session_module, "start_network_door", netdoor)
        ready = harness or ReadyHarness(ClaudeLogin.oauth_token(LOGIN), IMAGE)
        seams = JobSeams(
            setup=setup,
            harness=lambda env: ready,
            session_seams=SessionSeams(
                confirm_seconds=0.3, confirm_pause=0.05, system_roots=lambda: b"roots\n"
            ),
        )
        monkeypatch.setattr(
            runner, "run_implementer_job", partial(run_implementer_job, seams=seams)
        )
        monkeypatch.setattr(runner, "_stop_hard", lambda: None)
        output = io.StringIO()
        played.exit_code = runner.main(
            [], stdin=io.StringIO(subscription_job(environment)), stdout=output
        )
        played.output = output.getvalue()
        return played

    yield run
    for channel in channels:
        channel.close()


def says(text: str, cost: float | None = 0.0123) -> Callable[[ClaudePlace], bytes]:
    return lambda place: result_line(text, cost)


# #856-W01
def test_a_subscription_turn_runs_claude_code_with_no_model_door_and_pushes_the_commit(
    play: Callable[..., Played],
) -> None:
    played = play(says("Added the greeting."))

    result = played.result
    assert played.exit_code == 0 and result["ok"] is True, played.output
    assert valid_result(result)
    [place] = played.places
    [run] = place.runs
    assert run["argv"][run["argv"].index("--max-budget-usd") + 1] == "2.50"
    assert run["argv"][run["argv"].index("--model") + 1] == "claude-sonnet-5-5"
    # #1176: the agent holds the placeholder and the door's address; the token is the door's.
    assert run["environment"]["CLAUDE_CODE_OAUTH_TOKEN"] == SUBSCRIPTION_PLACEHOLDER
    assert run["environment"]["ANTHROPIC_BASE_URL"] == played.doors[0].url
    assert played.doors[0].token == LOGIN
    assert LOGIN not in " ".join(run["argv"])
    assert LOGIN not in json.dumps(run["environment"])
    assert played.git is not None and played.git.pushes == [TIP]
    assert result["implementer"]["summary"] == "Added the greeting."
    assert result["implementer"]["headCommit"] == TIP and result["implementer"]["pushed"] is True


# #856-W01
def test_the_cost_is_an_estimate_with_the_basis_subscription_and_is_not_a_charge(
    play: Callable[..., Played],
) -> None:
    usage = play(says("Done.", cost=0.0123)).result["usage"]

    assert usage["costBasis"] == "subscription" and usage["estimatedCostUsd"] == 0.0123
    assert usage["costUsd"] is None and usage["aiCalls"] == 0


# #856-W01
def test_a_turn_that_claude_code_did_not_price_says_unknown_not_zero(
    play: Callable[..., Played],
) -> None:
    usage = play(says("Done.", cost=None)).result["usage"]

    assert usage["costBasis"] == "subscription" and usage["estimatedCostUsd"] is None


# #856-W02
def test_the_extra_message_for_a_dirty_tree_gets_what_the_first_one_left_of_the_budget(
    play: Callable[..., Played],
) -> None:
    played = play(says("Done.", cost=0.5), dirty=True)

    [place] = played.places
    amounts = [run["argv"][run["argv"].index("--max-budget-usd") + 1] for run in place.runs]
    assert amounts == ["2.50", "2.000000"], played.output


# #856-W02
def test_a_turn_that_spent_its_budget_sends_no_extra_message_for_a_dirty_tree(
    play: Callable[..., Played],
) -> None:
    played = play(says("Done.", cost=2.5), dirty=True)

    [place] = played.places
    assert len(place.runs) == 1, played.output
    assert played.result["ok"] is True


# #856-W01
def test_no_session_is_saved_for_resume_and_the_report_names_no_opencode_session(
    play: Callable[..., Played],
) -> None:
    result = play(says("Done.")).result

    assert result["implementer"]["opencode"] is None


# #1176-T10
def test_a_step_without_a_network_needs_no_network_door_and_the_agent_still_reaches_the_model(
    play: Callable[..., Played],
) -> None:
    played = play(says("Done."))

    assert played.rules == [], "mode off: no network door, the agent reaches the model door only"
    assert [door.url for door in played.doors] == ["http://10.213.77.2:10180"]
    assert played.result["implementer"]["network"]["mode"] == "off"
    assert played.result["ok"] is True


# #1176-T11
def test_an_environment_with_an_open_network_runs_with_the_token_behind_the_door(
    play: Callable[..., Played],
) -> None:
    played = play(
        says("Done."), environment={"name": "wide", "network": {"mode": "open", "hosts": []}}
    )

    result = played.result
    assert result["ok"] is True, played.output
    assert played.rules == [NetworkRule(MODE_OPEN)], "the step's own rule, as it is"
    [place] = played.places
    assert place.runs[0]["environment"]["CLAUDE_CODE_OAUTH_TOKEN"] == SUBSCRIPTION_PLACEHOLDER
    assert LOGIN not in json.dumps(place.runs[0]["environment"])
    assert played.doors[0].token == LOGIN
    assert result["implementer"]["network"]["mode"] == "open"


# #1176-T12
def test_a_list_is_the_steps_own_list_not_narrowed_to_read_only_or_to_port_443(
    play: Callable[..., Played],
) -> None:
    hosts = ["fonts.googleapis.com", "*.github.io", "api.example.org"]
    played = play(
        says("Done."), environment={"name": "b", "network": {"mode": "list", "hosts": hosts}}
    )

    assert played.result["ok"] is True, played.output
    assert played.rules == [NetworkRule(MODE_LIST, tuple(hosts))]
    assert played.rules[0].read_only == () and played.rules[0].ports == ()


# #1176-T13
def test_the_door_of_the_token_comes_up_before_the_network_door_and_ends_with_the_turn(
    play: Callable[..., Played],
) -> None:
    played = play(
        says("Done."),
        environment={"name": "b", "network": {"mode": "list", "hosts": ["lateinorum.de"]}},
    )

    assert [e for e in played.events if e in ("model-door", "door", "claude")] == [
        "model-door",
        "door",
        "claude",
    ]
    assert [door.stopped for door in played.doors] == [1], (
        "the door of the token ends with the turn"
    )


# #1176-T14
def test_a_placement_that_cannot_host_the_door_keeps_the_token_in_the_container_and_says_so(
    play: Callable[..., Played],
) -> None:
    played = play(says("Done."), placement=Placement(subscription_door=False))

    result = played.result
    assert result["ok"] is True, played.output
    assert played.doors == []
    assert played.rules == [NetworkRule(MODE_LIST, ("api.anthropic.com",), ports=(443,))]
    [place] = played.places
    assert place.runs[0]["environment"]["CLAUDE_CODE_OAUTH_TOKEN"] == LOGIN
    assert "ANTHROPIC_BASE_URL" not in place.runs[0]["environment"]
    assert "cannot hold the Claude Code token behind the model door" in result["logTail"]


# #1176-T14
def test_without_the_door_an_open_network_still_refuses_the_turn_free(
    play: Callable[..., Played],
) -> None:
    played = play(
        says("Done."),
        environment={"name": "wide", "network": {"mode": "open", "hosts": []}},
        placement=Placement(subscription_door=False),
    )

    result = played.result
    assert result["ok"] is False and result["errorCode"] == "implementer_config_invalid"
    assert "subscription_network_open" in result["logTail"]
    assert played.rules == [] and result["usage"] is None


# #1176-T16
def test_a_door_that_is_missing_where_the_token_belongs_behind_it_never_gives_the_token_away(
    play: Callable[..., Played],
) -> None:
    def vanished(**options: Any) -> None:
        return None

    played = play(
        says("Done."),
        environment={"name": "wide", "network": {"mode": "open", "hosts": []}},
        door=vanished,
    )

    result = played.result
    assert result["ok"] is False and result["errorCode"] == "setup_failed", played.output
    assert "subscription_door_missing" in result["logTail"]
    assert played.places == [] or all(place.runs == [] for place in played.places)
    assert LOGIN not in json.dumps(result)
    assert played.rules == [], "no wide network is opened for a token that has no door"


# #1126-T20
def test_without_the_door_the_hosts_of_the_step_are_read_only_beside_the_api_host(
    play: Callable[..., Played],
) -> None:
    played = play(
        says("Done."),
        environment={
            "name": "build",
            "network": {"mode": "list", "hosts": ["fonts.googleapis.com", "*.gstatic.com"]},
        },
        placement=Placement(subscription_door=False),
    )

    assert played.result["ok"] is True, played.output
    assert played.rules == [
        NetworkRule(
            MODE_LIST,
            ("api.anthropic.com", "fonts.googleapis.com", "*.gstatic.com"),
            ports=(443,),
            read_only=("fonts.googleapis.com", "*.gstatic.com"),
        )
    ]


# #1126-T21
def test_a_setup_script_runs_before_the_login_is_placed_and_the_agent_keeps_the_container(
    play: Callable[..., Played],
) -> None:
    played = play(
        says("Built it."),
        environment={
            "name": "build",
            "setupScript": "npm ci\n",
            "network": {"mode": "list", "hosts": ["lateinorum.de"]},
        },
    )

    assert played.result["ok"] is True, played.output
    assert [e for e in played.events if e in ("setup", "model-door", "door", "claude")] == [
        "setup",
        "model-door",
        "door",
        "claude",
    ], "the script ends, the doors of the turn come up, then the agent's exec has the placeholder"
    assert played.places_at_setup == 0, "no container of the agent had run anything at the setup"
    [place] = played.places
    [run] = place.runs
    assert run["environment"]["CLAUDE_CODE_OAUTH_TOKEN"] == SUBSCRIPTION_PLACEHOLDER
    assert played.doors[0].token == LOGIN, "the real token is the door's, never the container's"
    assert played.result["implementer"]["setup"]["ok"] is True
    assert played.rules[0].hosts == ("lateinorum.de",) and played.rules[0].read_only == ()


# #1126-T22
def test_a_script_that_fails_ends_a_subscription_turn_before_the_login_is_used(
    play: Callable[..., Played],
) -> None:
    failed = EnvironmentSetup(
        None,
        {"ok": False, "exitCode": 1, "timedOut": False, "durationSeconds": 2, "output": "no"},
        JobError(ErrorCode.ENVIRONMENT_SETUP_FAILED, "exit status 1"),
        (),
    )
    played = play(
        says("Done."),
        environment={"name": "build", "setupScript": "false\n"},
        setup_outcome=failed,
    )

    result = played.result
    assert result["ok"] is False and result["errorCode"] == "environment_setup_failed"
    assert played.places == [] and played.rules == [], "no network, no agent, no login handed out"
    assert result["usage"] is None


# #856-H02
def test_a_device_that_cannot_run_claude_code_refuses_the_job_and_runs_nothing(
    play: Callable[..., Played],
) -> None:
    played = play(says("Done."), harness=HarnessNotReady("the layer is not on this daemon"))

    result = played.result
    assert result["ok"] is False and result["errorCode"] == "implementer_engine_unavailable"
    assert "harness_not_ready" in result["logTail"]
    assert played.setups == 0 and played.places == [], "no workspace, no container, no fallback"


# #1150-N04
def test_the_token_of_the_workspace_is_not_handed_to_an_agent_behind_the_inner_door_alone(
    play: Callable[..., Played],
) -> None:
    """A hosted Dispatcher without a public URL gives the Worker no network switch: the login would
    sit in the container with only the door of the turn around it."""
    played = play(
        says("Done."),
        harness=ReadyHarness(ClaudeLogin.oauth_token(LOGIN), IMAGE, workspace_token=True),
    )

    result = played.result
    assert result["ok"] is False and result["errorCode"] == "implementer_engine_unavailable"
    assert "network_switch_missing" in result["logTail"]
    assert LOGIN not in played.output
    assert played.setups == 0 and played.places == [], "no workspace, no container, no token placed"
    assert result["usage"] is None, "free"


# #856-R02
def test_the_login_is_in_no_text_of_the_result_whatever_the_agent_printed(
    play: Callable[..., Played],
) -> None:
    played = play(says(f"The token is {LOGIN}."), subject=f"Use {LOGIN}", commit="4" * 40)

    assert LOGIN not in played.output
    assert played.result["implementer"]["summary"].startswith("The token is ")


# #856-G08
def test_a_branch_the_push_guard_stopped_ends_the_turn_push_rejected_and_says_why(
    play: Callable[..., Played],
) -> None:
    # The guard's own work is proven on real git (test_implementer_push_guard.py); here the glue:
    # the reason arrives in the report and in the code of the turn.
    played = play(says("Done."), form_rejected=(REASON_LOGIN_SECRET, TIP))

    result = played.result
    assert result["ok"] is False and result["errorCode"] == "push_rejected"
    assert "login_secret" in result["logTail"]
    assert result["implementer"]["branches"][0]["reason"] == "login_secret"
    assert played.git is not None and played.git.pushes == []
