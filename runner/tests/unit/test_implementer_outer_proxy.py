# SPDX-License-Identifier: LicenseRef-Proprietary

"""The job process of an Implementer on a customer's machine (#994): the host's outer-wall proxy
reaches every client it starts, from the environment Control gave it and from nowhere else. The
clients themselves are held in their own test files (git, the model door, the network door, the
Setup container); here is the glue that hands the proxy to each of them, and that a process which is
told to use a proxy and cannot read it does not start anything."""

import json
from typing import Any
from unittest.mock import MagicMock

import pytest
from door_support import implementer_job_text

from code_reviewer_runner.implementer import job_run, session
from code_reviewer_runner.implementer.door_launcher import DoorSeams
from code_reviewer_runner.implementer.netdoor_launcher import NetDoorSeams
from code_reviewer_runner.implementer.runner_profile import (
    door_seams,
    netdoor_seams,
    outer_proxy_for_job,
    setup_seams,
)
from code_reviewer_runner.implementer.setup_container import SetupSeams
from code_reviewer_runner.job import JobError, parse_implementer_input
from code_reviewer_runner.outer_proxy import OUTER_PROXY_VARIABLE, OuterProxy
from code_reviewer_runner.result import ErrorCode

PROXY = OuterProxy("172.31.0.21", 3128)
WITH = {OUTER_PROXY_VARIABLE: PROXY.address}


# #994-T03
def test_a_job_process_with_no_variable_has_no_proxy_and_every_seam_is_untouched() -> None:
    doors, nets, setup = DoorSeams(), NetDoorSeams(), SetupSeams()

    assert outer_proxy_for_job({}) is None
    assert door_seams({}, doors) is doors
    assert netdoor_seams({}, nets) is nets
    assert setup_seams({}, setup) == setup and setup_seams({}).outer_proxy is None


# #994-T01
def test_a_job_process_with_the_variable_hands_the_proxy_to_each_seam() -> None:
    assert outer_proxy_for_job(WITH) == PROXY
    assert door_seams(WITH, DoorSeams()).outer_proxy == PROXY
    assert netdoor_seams(WITH, NetDoorSeams()).outer_proxy == PROXY
    assert setup_seams(WITH).outer_proxy == PROXY


# #994-T04
@pytest.mark.parametrize("value", ["", "8.8.8.8:3128", "172.31.0.1", "172.31.0.1:0", "proxy:3128"])
def test_a_variable_that_is_set_and_wrong_ends_the_turn_before_anything_is_started(
    value: str,
) -> None:
    bad = {OUTER_PROXY_VARIABLE: value}

    for call in (
        lambda: outer_proxy_for_job(bad),
        lambda: door_seams(bad, DoorSeams()),
        lambda: netdoor_seams(bad, NetDoorSeams()),
        lambda: setup_seams(bad),
    ):
        with pytest.raises(JobError) as refused:
            call()
        assert refused.value.code is ErrorCode.SETUP_FAILED
        assert "outer_proxy_invalid" in refused.value.detail


# #994-T01
def test_the_production_setup_hands_the_proxy_to_the_git_workspace(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: dict[str, Any] = {}

    class Quiet:
        def __init__(self, *args: Any, **options: Any) -> None:
            seen.setdefault("workspace", []).append(options.get("proxy", "unset"))

        def close(self) -> None:
            return None

    monkeypatch.setattr(job_run, "ReaderAccess", MagicMock())
    monkeypatch.setattr(job_run, "GitWorkspace", Quiet)
    job = parse_implementer_input(implementer_job_text())

    for environment in ({}, WITH):
        job_run.production_setup(job, environment, lambda: None)

    assert seen["workspace"] == [None, PROXY]


# #994-T01
def test_the_session_hands_the_proxy_to_the_model_door_and_the_network_door(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    doors: list[DoorSeams] = []
    nets: list[NetDoorSeams] = []

    def start_door(**options: Any) -> Any:
        doors.append(options["seams"])
        return MagicMock()

    def start_network_door(rule: Any, **options: Any) -> Any:
        nets.append(options["seams"])
        return MagicMock()

    monkeypatch.setattr(session, "start_door", start_door)
    monkeypatch.setattr(session, "start_network_door", start_network_door)
    document = json.loads(implementer_job_text(max_cost=2.5))
    document["implementer"]["environment"] = {
        "name": "E",
        "network": {"mode": "list", "hosts": ["example.com"]},
    }
    job = parse_implementer_input(json.dumps(document))

    for environment in ({"RUNNER_IMPLEMENTER_MODEL_DOOR": "docker"}, WITH):
        made = session.ImplementerSession(
            job,
            workspace=MagicMock(),
            command=["opencode"],
            place=lambda: MagicMock(),
            environment=environment,
            seams=session.SessionSeams(),
        )
        model = made._start_model()  # pyright: ignore[reportPrivateUsage]
        made._start_network(model)  # pyright: ignore[reportPrivateUsage]

    assert [seams.outer_proxy for seams in doors] == [None, PROXY]
    assert [seams.outer_proxy for seams in nets] == [None, PROXY]
