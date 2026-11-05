# SPDX-License-Identifier: LicenseRef-Proprietary

"""How a customer's runner differs from the hosted Control in the containers it starts (#854,
R1b): the runtime, the entry point under it, the CPU limit; a hosted Control is unchanged."""

import pytest
from loop_support import Harness, outcome, run, settle
from test_implementer_job_host import (
    ALL_THREE,
    PROFILE,
    USERS,
    implementer_claim,
    line,
)

from code_reviewer_runner.implementer.agent_container import (
    AGENT_ENTRYPOINT,
    AGENT_RUNTIME,
    AgentSeams,
    agent_document,
)
from code_reviewer_runner.implementer.reader import READER_RUNTIME, ReaderSeams
from code_reviewer_runner.implementer.runner_profile import (
    AGENT_CPUS_VARIABLE,
    AGENT_RUNTIME_VARIABLE,
    READY_ONLY_ENTRYPOINT,
    agent_seams,
    nano_cpus_of,
    reader_seams,
    setup_seams,
)
from code_reviewer_runner.implementer.setup_container import SetupSeams

pytestmark = pytest.mark.unit


def test_without_the_variables_everything_is_as_hosted() -> None:
    assert agent_seams({}) == AgentSeams()
    assert setup_seams({}) == SetupSeams()
    assert reader_seams({}) == ReaderSeams()
    assert agent_seams({}).runtime == AGENT_RUNTIME and agent_seams({}).entrypoint is None
    assert reader_seams({}).runtime == READER_RUNTIME


def test_under_runc_the_init_that_starts_the_inner_docker_is_replaced_by_a_ready_marker() -> None:
    environment = {AGENT_RUNTIME_VARIABLE: "runc"}

    for seams in (agent_seams(environment), setup_seams(environment)):
        assert seams.runtime == "runc"
        assert tuple(seams.entrypoint or ()) == READY_ONLY_ENTRYPOINT
    assert reader_seams(environment).runtime == "runc"
    assert tuple(AGENT_ENTRYPOINT) != READY_ONLY_ENTRYPOINT


def test_under_sysbox_the_image_keeps_its_own_init() -> None:
    assert agent_seams({AGENT_RUNTIME_VARIABLE: "sysbox-runc"}).entrypoint is None


def test_the_cpu_limit_is_a_whole_number_or_none() -> None:
    assert nano_cpus_of({AGENT_CPUS_VARIABLE: "2"}) == 2_000_000_000
    for bad in ("", "0.5", "-1", "x"):
        assert nano_cpus_of({AGENT_CPUS_VARIABLE: bad}) == 0
    assert agent_seams({AGENT_CPUS_VARIABLE: "4"}).nano_cpus == 4_000_000_000


def test_the_agents_container_carries_the_cpu_limit_beside_the_memory_limit() -> None:
    limited = agent_document("img", "vol", 2**30, nano_cpus=2_000_000_000)["HostConfig"]
    plain = agent_document("img", "vol", 2**30)["HostConfig"]

    assert limited["NanoCpus"] == 2_000_000_000 and limited["Memory"] == 2**30
    assert "NanoCpus" not in plain  # hosted: no CPU limit, as before


def test_the_runner_never_gives_the_agent_more_than_the_hosted_one_has() -> None:
    document = agent_document("img", "vol", 2**30, runtime="runc", entrypoint=READY_ONLY_ENTRYPOINT)
    host = document["HostConfig"]

    assert host["Privileged"] is False
    assert host["Runtime"] == "runc"
    assert {mount["Target"] for mount in host["Mounts"]} == {"/work/repo"}
    assert "Binds" not in host and "Devices" not in host


def test_the_host_hands_the_job_process_the_runners_choices_and_nothing_else_of_its_own() -> None:
    async def scenario() -> None:
        harness = Harness(
            **USERS,
            engines=ALL_THREE,
            environment={
                **PROFILE,
                AGENT_RUNTIME_VARIABLE: "runc",
                AGENT_CPUS_VARIABLE: "2",
                "FACTORY_RUNNER_CREDENTIAL": "must-not-pass",
            },
        )
        harness.api.claims = [implementer_claim()]
        await harness.start()
        spec = harness.launcher.processes[0].spec
        harness.launcher.processes[0].finish(outcome(stdout=line()))
        await settle()

        assert spec.env[AGENT_RUNTIME_VARIABLE] == "runc"
        assert spec.env[AGENT_CPUS_VARIABLE] == "2"
        assert "FACTORY_RUNNER_CREDENTIAL" not in spec.env

    run(scenario)
