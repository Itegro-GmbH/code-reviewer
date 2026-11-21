# SPDX-License-Identifier: LicenseRef-Proprietary

"""#1126: the order in which a subscription turn with a setup script meets its login, read from the
calls the real `SetupContainer`, `AgentContainer` and `ClaudeCodeAgent` make to the fake Docker
Engine (`fakes/docker_engine`), not from doubles of them: the script ran, what it left was ended,
the container left the setup network and joined the model network (the door of the turn is up
before the container is taken over, as `Session.run` does it), and only then does the first exec
that carries the login exist. Nothing the daemon was asked before that point (create, exec,
environment, mount, label, command line) contains the login.

The check is `login_before_first_use`; the last test proves that it fails when a login is put in
the setup container's definition, so that it is not a statement that cannot be false."""

import contextlib
import json
import sys
import tempfile
from collections.abc import Iterator
from pathlib import Path
from typing import Any, cast

import pytest
from test_setup_container import Rig, run  # pyright: ignore[reportUnknownVariableType]

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from fakes.docker_engine.server import HOSTNAME

from code_reviewer_runner.implementer import setup_container as sc
from code_reviewer_runner.implementer.agent_container import (
    AgentContainer,
    AgentSeams,
)
from code_reviewer_runner.implementer.claude_code.agent import ClaudeCodeAgent
from code_reviewer_runner.implementer.claude_code.login import ClaudeLogin
from code_reviewer_runner.implementer.claude_code.readiness import ReadyHarness
from code_reviewer_runner.implementer.docker_api import DockerApi
from code_reviewer_runner.implementer.door_launcher import network_document
from code_reviewer_runner.implementer.job_run import harness_setup_seams
from code_reviewer_runner.implementer.network_rule import MODE_LIST, NetworkRule
from code_reviewer_runner.implementer.setup_leftovers import LEFTOVERS_SCRIPT

pytestmark = pytest.mark.unit

LOGIN = "sk-" + "ant-" + "oat01-OrderTest9Zq3-ordertestordertestordertest"
IMAGE = "code-reviewer-agent:golden"
RULE = NetworkRule(MODE_LIST, ("api.anthropic.com", "registry.npmjs.org"), ports=(443,))
DOOR = "door up"

Call = tuple[str, str, Any]


class Played:
    def __init__(self, calls: list[Call], door_at: int, first_login: int | None) -> None:
        self.calls = calls
        self.door_at = door_at
        self.first_login = first_login


def exec_of(call: Call) -> list[str] | None:
    method, target, body = call
    if method == "POST" and target.endswith("/exec") and isinstance(body, dict):
        return [str(part) for part in cast("dict[str, list[Any]]", body).get("Cmd", [])]
    return None


def exec_running(calls: list[Call], script: str) -> list[int]:
    """The positions of the execs that run `script` (`sh -c <script>`)."""
    return [i for i, call in enumerate(calls) if (cmd := exec_of(call)) and cmd[2:3] == [script]]


def post(calls: list[Call], suffix: str) -> int:
    for position, (method, target, _) in enumerate(calls):
        if method == "POST" and target.split("?")[0].endswith(suffix):
            return position
    raise AssertionError(f"no POST ...{suffix}")


def login_before_first_use(calls: list[Call], login: str) -> tuple[int | None, list[int]]:
    """The first call that carries the login (the agent's exec), and the calls before it that
    carry it too: create, exec, environment, mount, label or command line (there must be none)."""
    first: int | None = None
    for position, (method, target, body) in enumerate(calls):
        if login in json.dumps([method, target, body]):
            first = position
            break
    return first, [] if first is None else [
        position
        for position, (method, target, body) in enumerate(calls[:first])
        if login in json.dumps([method, target, body])
    ]


def play(rig: Rig, *, leftovers: list[list[str]] | None = None) -> Played:
    rig.leftover_passes = leftovers if leftovers is not None else [["postgres"]]
    harness = ReadyHarness(ClaudeLogin.oauth_token(LOGIN), IMAGE)
    taken = harness_setup_seams(rig.seams(), harness)
    done = run(
        rig,
        "npm ci\n",
        image=taken.image,
        no_new_privileges=taken.no_new_privileges,
        kill_leftovers=taken.kill_leftovers,
    )
    assert done.outcome == sc.OUTCOME_OK, done.detail
    assert done.adopted is not None
    # The door of the turn and the narrowing of the outer wall: `Session.run` does them after the
    # setup and before the agent's container takes the setup's over (`place.create()`); the model
    # network the door makes is what the container joins.
    DockerApi(str(rig.socket), timeout=5.0).create_network(network_document())
    door_at = len(rig.engine.calls)
    place = AgentContainer(
        2560,
        AgentSeams(
            api=rig.api,
            hostname=lambda: HOSTNAME,
            ready_seconds=5.0,
            meminfo=str(rig.meminfo),
            image=IMAGE,
            no_new_privileges=True,
        ),
        RULE,
        adopted=done.adopted,
    )
    place.create()
    agent = ClaudeCodeAgent(
        place=place,
        login=harness.login,
        model="claude-sonnet-5-5",
        session_id="d847dcf5-e741-4252-98b0-d73cbc39f2c0",
        secrets=(),
        remaining_seconds=lambda: 60.0,
        check_deadline=lambda: None,
    )
    agent.start()
    with contextlib.suppress(Exception):  # the fake program prints nothing: the turn ends badly
        agent.turn("Build it.")
    place.stop()
    calls = list(rig.engine.calls)
    return Played(calls, door_at, login_before_first_use(calls, LOGIN)[0])


@pytest.fixture
def rig() -> Iterator[Rig]:
    with tempfile.TemporaryDirectory(dir="/tmp", prefix="order-") as directory:
        made = Rig(Path(directory))
        yield made
        made.stop()


@pytest.fixture
def played(rig: Rig) -> Played:
    return play(rig)


# #1126-T50
def test_the_login_first_appears_in_the_agents_exec_after_the_hand_over_is_complete(
    played: Played,
) -> None:
    calls = played.calls
    [script] = exec_running(calls, sc.RUN_SCRIPT)
    [cleaned] = exec_running(calls, sc.CLEAN_SCRIPT)
    marked, *sweeps = exec_running(calls, LEFTOVERS_SCRIPT)
    left_setup = post(calls, f"/networks/{sc.SETUP_NETWORK_NAME}/disconnect")
    frozen = post(calls, "/pause")
    thawed = post(calls, "/unpause")
    joined = post(calls, "/networks/code-reviewer-model/connect")
    removed = next(
        i
        for i, (method, target, _) in enumerate(calls)
        if method == "DELETE" and target == f"/networks/{sc.SETUP_NETWORK_NAME}" and i > joined
    )
    assert marked < script, "the process mark is taken before the script exists"
    assert script < cleaned < left_setup, "the script ended; its file is gone; offline"
    assert sweeps and left_setup < min(sweeps) and max(sweeps) < frozen, (
        "leftovers ended, then frozen"
    )
    assert frozen < played.door_at <= thawed, "the door of the turn is up before the thaw"
    assert thawed < joined < removed, "unfrozen, on the model network, the setup network gone"
    assert played.first_login is not None
    assert removed < played.first_login, "the login is used only after all of it"
    first = exec_of(calls[played.first_login])
    assert first is not None and first[0] == "claude", "and it is the agent's program that has it"


# #1126-T51
def test_nothing_the_daemon_is_asked_before_the_first_login_exec_contains_the_login(
    played: Played,
) -> None:
    first, before = login_before_first_use(played.calls, LOGIN)
    assert first is not None, "the agent's exec carries the login"
    assert before == [], "no create, exec, environment, mount or label has it before"
    method, target, body = played.calls[first]
    assert method == "POST" and target.endswith("/exec")
    assert f"CLAUDE_CODE_OAUTH_TOKEN={LOGIN}" in body["Env"]
    assert LOGIN not in json.dumps(body["Cmd"]), "never an argument"
    assert [i for i, (_, _, b) in enumerate(played.calls) if LOGIN in json.dumps(b)] == [first], (
        "and nowhere afterwards either: one exec, the first of the agent"
    )


# #1126-T53
def test_the_check_is_red_when_the_login_is_put_in_the_setup_containers_definition(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A login in the setup container's `Env` is found by the same check before the agent's exec
    (the seal check refuses such a container too, which is the second wall)."""
    real = sc.setup_document

    def leaking(*arguments: Any, **options: Any) -> dict[str, Any]:
        document = real(*arguments, **options)
        document["Env"] = [*document["Env"], f"CLAUDE_CODE_OAUTH_TOKEN={LOGIN}"]
        return document

    monkeypatch.setattr(sc, "setup_document", leaking)
    harness = ReadyHarness(ClaudeLogin.oauth_token(LOGIN), IMAGE)
    taken = harness_setup_seams(rig.seams(), harness)
    done = run(rig, "npm ci\n", image=taken.image, kill_leftovers=True, no_new_privileges=True)
    assert done.outcome == sc.OUTCOME_UNAVAILABLE, "the seal check refuses it"
    first, before = login_before_first_use(list(rig.engine.calls), LOGIN)
    assert first is not None and before == [], "the login is in the very first create"
    assert method_of(rig, first) == "/containers/create"


def method_of(rig: Rig, position: int) -> str:
    return rig.engine.calls[position][1].split("?")[0]
