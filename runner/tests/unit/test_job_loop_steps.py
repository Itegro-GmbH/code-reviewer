# SPDX-License-Identifier: LicenseRef-Proprietary

"""When the job host gives a job process a steps channel (#745, live view): only an Implementer
turn, and only when the app lists `implementer_steps`. Anything else gets no descriptor and so
records nothing."""

from typing import Any

import pytest
from loop_support import Harness, make_claim, outcome, run, settle
from test_implementer_job_host import advertising_harness, implementer_claim, line

from code_reviewer_runner.job_loop.step_sender import StepsApi

pytestmark = pytest.mark.unit


def with_steps(harness: Harness, *, supported: bool) -> list[tuple[str, bytes]]:
    """Give the harness's API the steps call; the list collects what is posted."""
    posted: list[tuple[str, bytes]] = []

    async def steps(job_id: str, body: bytes) -> None:
        posted.append((job_id, body))

    api: Any = harness.api
    api.supports_steps = supported
    api.steps = steps
    return posted


async def spec_of_first_process(harness: Harness) -> Any:
    await harness.start()
    spec = harness.launcher.processes[0].spec
    harness.launcher.processes[0].finish(outcome(stdout=line()))
    await settle()
    return spec


# #745-L26
def test_an_implementer_turn_gets_the_channel_when_the_app_lists_the_feature() -> None:
    async def scenario() -> None:
        harness = advertising_harness()
        with_steps(harness, supported=True)
        harness.api.claims = [implementer_claim()]

        spec = await spec_of_first_process(harness)

        assert isinstance(harness.api, StepsApi)
        assert spec.steps is not None

    run(scenario)


# #745-L26
def test_an_app_that_does_not_list_the_feature_gets_nothing_sent_and_no_channel() -> None:
    async def scenario() -> None:
        harness = advertising_harness()
        with_steps(harness, supported=False)
        harness.api.claims = [implementer_claim()]

        spec = await spec_of_first_process(harness)

        assert spec.steps is None

    run(scenario)


# #745-L26
def test_an_api_without_the_steps_call_gets_no_channel() -> None:
    async def scenario() -> None:
        harness = advertising_harness()  # the plain FakeApi has no steps call
        harness.api.claims = [implementer_claim()]

        spec = await spec_of_first_process(harness)

        assert spec.steps is None

    run(scenario)


# #745-L26
def test_a_review_job_never_gets_the_channel_even_when_the_app_has_the_feature() -> None:
    async def scenario() -> None:
        harness = Harness()
        with_steps(harness, supported=True)
        harness.api.claims = [make_claim()]

        await harness.start()
        spec = harness.launcher.processes[0].spec
        harness.launcher.processes[0].finish(outcome())
        await settle()

        assert spec.steps is None

    run(scenario)
