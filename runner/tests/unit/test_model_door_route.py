# SPDX-License-Identifier: LicenseRef-Proprietary

"""The route to the model door in the engine user's static rules, the self-check and the parts of
the job and the ledger that the door needs (#745, step 3), without root and without Docker.

What the kernel does with the rules is the privileged suite; what the daemon does is the fake
Docker Engine of `test_model_door_launcher.py`."""

import json
from collections.abc import Callable
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from door_support import implementer_job_text, model_access

from code_reviewer_runner.dynamic_review.budget import LimitError
from code_reviewer_runner.dynamic_review.engine_user import EngineLaunch
from code_reviewer_runner.dynamic_review.model_door_route import (
    MODEL_DOOR_ADDRESS,
    MODEL_DOOR_MODE,
    MODEL_DOOR_VARIABLE,
)
from code_reviewer_runner.dynamic_review.netguard import (
    EgressMode,
    IsolationError,
    NetworkConfinement,
    ruleset,
    table_name,
)
from code_reviewer_runner.dynamic_review.self_check import SelfCheckFailed, SelfCheckReason
from code_reviewer_runner.dynamic_review.static_isolation import (
    ImplementerNetwork,
    SlotPorts,
    slot_ports,
)
from code_reviewer_runner.implementer.door.protocol import DoorFailure, DoorStatus
from code_reviewer_runner.implementer.door_ledger import DoorLedger
from code_reviewer_runner.implementer.door_model import build_door_ledger
from code_reviewer_runner.implementer.door_state import DoorEnd, DoorState
from code_reviewer_runner.implementer.startup import (
    ImplementerSeams,
    check_implementer_runner,
    engine_user_can_open,
)
from code_reviewer_runner.job import (
    IMPLEMENTER_ENVIRONMENT_NAMES,
    IMPLEMENTER_MODEL_DOOR_VARIABLE,
    JobError,
    parse_implementer_input,
    parse_model_access,
)
from code_reviewer_runner.result import ErrorCode

UID = 10101
DOOR = (MODEL_DOOR_ADDRESS, 10180)


# -- the rules ------------------------------------------------------------------------------------


@pytest.mark.parametrize("mode", list(EgressMode))
# #745-T10
def test_the_door_is_one_more_accepted_destination_on_any_interface(mode: EgressMode) -> None:
    without = ruleset(UID, 10180, 10181, mode, egress_port=10182).splitlines()
    with_door = ruleset(UID, 10180, 10181, mode, egress_port=10182, door=DOOR).splitlines()

    family = "inet" if mode is EgressMode.FULL else "ip"
    added = (
        f"add rule {family} {table_name(UID)} output meta skuid {UID} "
        f"ip daddr {MODEL_DOOR_ADDRESS} tcp dport 10180 accept"
    )
    assert [line for line in with_door if line not in without] == [added]
    assert with_door[-2] == added and with_door[-1] == without[-1], "before the final refusal"
    assert "oifname" not in added, "the door is on a network, not on loopback"


# #745-T10
def test_without_a_door_the_rules_are_what_they_always_were() -> None:
    assert ruleset(UID, 10180, 10181, door=None) == ruleset(UID, 10180, 10181)


@pytest.mark.parametrize(
    "door",
    [("10.213.77", 10180), ("10.213.77.256", 10180), ("door.local", 10180), ("1.2.3.4", 0)],
)
# #745-T10
def test_a_door_that_is_not_an_address_and_a_port_is_refused(door: tuple[str, int]) -> None:
    with pytest.raises(IsolationError):
        ruleset(UID, 10180, 10181, door=door)


# #745-T10
def test_the_confinement_installs_the_door_only_when_given_one() -> None:
    scripts: list[str] = []

    NetworkConfinement(UID, run=scripts.append).apply(10180, 10181, 10182, door=DOOR)
    NetworkConfinement(UID, run=scripts.append).apply(10180, 10181, 10182)

    assert scripts == [
        ruleset(UID, 10180, 10181, egress_port=10182, door=DOOR),
        ruleset(UID, 10180, 10181, egress_port=10182),
    ]


# #745-T10
def test_the_slot_has_a_door_only_where_the_dispatcher_says_so() -> None:
    assert slot_ports({}).door is None
    assert slot_ports({MODEL_DOOR_VARIABLE: ""}).door is None
    assert slot_ports({MODEL_DOOR_VARIABLE: MODEL_DOOR_MODE}).door == DOOR
    assert slot_ports(
        {MODEL_DOOR_VARIABLE: MODEL_DOOR_MODE, "RUNNER_DYNAMIC_PROXY_PORT": "20001"}
    ).door == (
        MODEL_DOOR_ADDRESS,
        20001,
    )
    with pytest.raises(IsolationError):
        slot_ports({MODEL_DOOR_VARIABLE: "yes"})


# #745-T10
def test_the_probe_of_a_door_container_asks_for_the_door_not_for_loopback(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    asked: list[tuple[Any, ...]] = []

    def verify(*arguments: Any, **options: Any) -> None:
        asked.append((arguments, options))

    from code_reviewer_runner.dynamic_review import engine_user

    monkeypatch.setattr(engine_user, "verify_confinement", verify)
    monkeypatch.setattr(engine_user, "require_startup_capabilities_gone", lambda: None)
    for door, expected in ((DOOR, {"allowed_host": MODEL_DOOR_ADDRESS}), (None, {})):
        asked.clear()
        launch = EngineLaunch(
            uid=UID,
            gid=UID,
            home=str(tmp_path),
            tmpdir=str(tmp_path),
            config_dir=tmp_path,
            egress_port=10182,
            door=door,
        )
        monkeypatch.setattr(launch, "sweep", lambda: True)

        launch.confine(10180, 10181)

        assert asked == [((UID, UID, 10180, 10182), expected)]


# -- the self-check -------------------------------------------------------------------------------


def _check(ports: SlotPorts, *, answers: bool, engine_reaches_docker: bool = False) -> None:
    check_implementer_runner(
        work_dir=Path("/work"),
        user=(UID, UID),
        ports=ports,
        network=ImplementerNetwork.REGISTRIES,
        seams=ImplementerSeams(
            which=lambda name, path: f"/usr/bin/{name}",
            prepare_work_dir=lambda directory, uid, gid: None,
            runs_scripts_as=lambda directory, uid, gid: True,
            is_directory=lambda path: True,
            docker_answers=lambda: answers,
            engine_reaches_docker=lambda uid, gid: engine_reaches_docker,
        ),
    )


# #745-T11
def test_a_container_that_starts_the_door_needs_the_docker_of_the_vm() -> None:
    _check(SlotPorts(10180, 10181, 10182, DOOR), answers=True)

    with pytest.raises(SelfCheckFailed) as failure:
        _check(SlotPorts(10180, 10181, 10182, DOOR), answers=False)

    assert failure.value.reason is SelfCheckReason.IMPLEMENTER_DOCKER_UNAVAILABLE
    assert failure.value.reason.value == "implementer_docker_unavailable"


# #745-T11
def test_a_container_without_a_door_never_asks_the_daemon() -> None:
    _check(SlotPorts(10180, 10181, 10182), answers=False, engine_reaches_docker=True)


# #745-T11
def test_a_container_whose_engine_user_can_open_the_docker_socket_does_not_advertise() -> None:
    # Control is root on the VM through that socket: if the agent's user can open it, nothing else
    # of the door holds. The refusal is checked at every start, not only by the VM check.
    with pytest.raises(SelfCheckFailed) as failure:
        _check(SlotPorts(10180, 10181, 10182, DOOR), answers=True, engine_reaches_docker=True)

    assert failure.value.reason is SelfCheckReason.IMPLEMENTER_DOCKER_SOCKET_OPEN
    assert failure.value.reason.value == "implementer_docker_socket_open"


# #745-T11
def test_a_container_without_a_door_does_not_look_at_the_socket_of_the_engine_user() -> None:
    _check(SlotPorts(10180, 10181, 10182), answers=True, engine_reaches_docker=True)


@pytest.fixture
def listening_socket(tmp_path: Path) -> Any:
    import socket

    path = tmp_path / "docker.sock"
    server = socket.socket(socket.AF_UNIX)
    server.bind(str(path))
    server.listen(4)
    yield path
    server.close()


# #745-T11
def test_the_probe_as_the_engine_user_sees_a_socket_it_can_open(listening_socket: Path) -> None:
    import os

    assert engine_user_can_open(os.getuid(), os.getgid(), listening_socket) is True


# #745-T11
def test_the_probe_as_the_engine_user_sees_a_socket_that_is_not_there(tmp_path: Path) -> None:
    import os

    assert engine_user_can_open(os.getuid(), os.getgid(), tmp_path / "none.sock") is False


# #745-T11
def test_the_probe_as_the_engine_user_sees_a_socket_that_refuses_it(listening_socket: Path) -> None:
    import os

    if os.geteuid() == 0:
        pytest.skip("root opens any socket; the refusal is for the engine user")
    listening_socket.chmod(0o000)

    assert engine_user_can_open(os.getuid(), os.getgid(), listening_socket) is False


# #745-T11
def test_a_probe_that_cannot_run_is_not_a_refusal(tmp_path: Path) -> None:
    # Nothing proves the user cannot open it: the answer is "can", and the check fails closed.
    import os

    if os.geteuid() == 0:
        pytest.skip("root can become any user, so the probe can run")
    assert engine_user_can_open(2**31 - 2, 2**31 - 2, tmp_path / "none.sock") is True


# -- the job --------------------------------------------------------------------------------------


# #745-T12
def test_the_door_is_one_of_the_names_the_dispatcher_gives_the_container() -> None:
    assert IMPLEMENTER_MODEL_DOOR_VARIABLE == MODEL_DOOR_VARIABLE == "RUNNER_IMPLEMENTER_MODEL_DOOR"
    assert IMPLEMENTER_MODEL_DOOR_VARIABLE in IMPLEMENTER_ENVIRONMENT_NAMES


# #745-T12
def test_the_job_keeps_the_parts_the_door_is_built_from_as_they_came() -> None:
    job = parse_implementer_input(implementer_job_text(max_cost=1.5))

    assert job.model_access is not None
    assert set(job.model_access) == {"llm", "modelEntry", "cost"}
    assert job.model_access["llm"]["maxCostUsd"] == 1.5
    assert "model_access" not in repr(job), "the copy of the key this adds is not in the repr"


# #745-T12
def test_the_door_judges_the_model_access_by_the_rules_of_the_job() -> None:
    llm, entry, cost = parse_model_access(model_access(1.5))

    assert llm.max_cost_usd == Decimal("1.5") and entry.provider_id == "anthropic"
    assert cost.priced


Mutation = Callable[[dict[str, Any]], object]
BROKEN_ACCESS: list[Mutation] = [
    lambda a: a.pop("llm"),
    lambda a: a.pop("cost"),
    lambda a: a.update(extra=1),
    lambda a: a["llm"].update(provider="openrouter"),
    lambda a: a["modelEntry"].update(providerId="openrouter"),
    lambda a: a["llm"].update(apiKey=""),
]


@pytest.mark.parametrize("mutate", BROKEN_ACCESS)
# #745-T12
def test_a_model_access_the_job_would_have_refused_is_refused(mutate: Mutation) -> None:
    access = model_access()
    mutate(access)

    with pytest.raises(JobError):
        parse_model_access(access)


# -- the ledger Control keeps ---------------------------------------------------------------------


def status(
    seq: int = 1,
    *,
    used: bool = False,
    opened: int = 0,
    failure: DoorFailure | None = None,
    upstream: str | None = None,
    cost: float | None = 0.0,
    calls: int = 0,
) -> DoorStatus:
    usage: dict[str, Any] = {
        "model": "m",
        "promptTokens": 100 * calls,
        "completionTokens": 10 * calls,
        "totalTokens": 110 * calls,
        "aiCalls": calls,
        "fallbackUsed": False,
        "costUsd": cost,
    }
    return DoorStatus(seq, False, used, opened, failure, upstream, usage)


def ledger() -> tuple[DoorLedger, DoorState]:
    job = parse_implementer_input(implementer_job_text())
    made = build_door_ledger(
        job.implementer.model_entry,
        job.implementer.cost,
        job.llm,
        deadline=600.0,
        environment={},
    )
    state = DoorState()
    made.attach(state)
    return made, state


# #745-T13
def test_the_ledger_of_control_reads_the_door_for_the_cost_and_keeps_its_own_clock() -> None:
    made, state = ledger()
    assert made.model_used is False and made.failure is None
    assert made.remaining_seconds() <= 600.0

    state.update(status(used=True, calls=2, cost=0.0123))

    assert made.model_used is True
    usage = made.usage("m")
    assert usage.ai_calls == 2 and usage.total_tokens == 220 and usage.cost_usd == 0.0123


# #745-T13
def test_a_failure_the_door_recorded_is_the_failure_of_the_turn() -> None:
    made, state = ledger()
    state.update(
        status(failure=DoorFailure("dynamic_budget_exceeded", "the cost limit is used up"))
    )

    failure = made.failure
    assert isinstance(failure, LimitError)
    assert failure.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED
    assert failure.detail == "the cost limit is used up"


# #745-T13
def test_a_door_that_went_away_by_itself_fails_the_turn_by_name() -> None:
    made, state = ledger()
    state.update(status(used=True, calls=1, cost=0.001))

    state.ended(DoorEnd(exit_code=137, out_of_memory=True, unexpected=True))

    failure = made.failure
    assert failure is not None and failure.code is ErrorCode.RUNNER_ERROR
    assert "model door" in failure.detail and "memory" in failure.detail and "137" in failure.detail
    assert made.usage("m").cost_usd == 0.001, "nothing was open: what was counted is the cost"


# #745-T13
def test_a_door_lost_with_a_call_open_leaves_the_cost_unknown_not_made_up() -> None:
    made, state = ledger()
    state.update(status(used=False, opened=1, calls=0, cost=0.0))

    assert made.model_used is True, "a call was open: it may have been billed"
    state.ended(DoorEnd(exit_code=137, out_of_memory=False, unexpected=True))

    assert made.usage("m").cost_usd is None


# #745-T13
def test_a_door_that_control_stopped_is_no_failure_and_its_last_word_stays() -> None:
    made, state = ledger()
    state.update(status(used=True, calls=1, cost=0.002))

    state.ended(DoorEnd(exit_code=0, out_of_memory=False, unexpected=False))

    assert made.failure is None
    assert made.usage("m").cost_usd == 0.002


# #745-T13
def test_a_status_that_is_not_exactly_one_is_ignored_by_the_reader() -> None:
    from code_reviewer_runner.implementer.door.status import parse_status, status_line

    good = status_line(status(used=True, calls=1, cost=0.5))
    assert parse_status(good) is not None
    for broken in (
        {**good, "extra": 1},
        {**good, "seq": -1},
        {**good, "usage": {**good["usage"], "costUsd": "free"}},
        {**good, "failure": {"code": "x"}},
        {**good, "modelCalls": [{"index": 0}]},
        "status",
        None,
    ):
        assert parse_status(json.loads(json.dumps(broken))) is None
