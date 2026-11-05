# SPDX-License-Identifier: LicenseRef-Proprietary

"""When the job host gives a job process a snapshot channel (#839): only an Implementer turn, and
only when the app lists `implementer_snapshot`; and that the host waits for the upload before the
result is delivered."""

from typing import Any

import pytest
from loop_support import Harness, make_claim, outcome, run, settle
from test_implementer_job_host import advertising_harness, implementer_claim, line

from code_reviewer_runner.job_loop.snapshot_sender import SnapshotApi

pytestmark = pytest.mark.unit


def with_snapshot(harness: Harness, *, supported: bool) -> list[Any]:
    """Give the harness's API the snapshot call; the list collects what is put."""
    put: list[Any] = []

    async def snapshot(job_id: str, part: Any) -> None:
        put.append((job_id, part))

    api: Any = harness.api
    api.supports_snapshot = supported
    api.snapshot = snapshot
    return put


async def spec_of_first_process(harness: Harness) -> Any:
    await harness.start()
    spec = harness.launcher.processes[0].spec
    harness.launcher.processes[0].finish(outcome(stdout=line()))
    await settle()
    return spec


# #839-T13
def test_an_implementer_turn_gets_the_channel_when_the_app_lists_the_feature() -> None:
    async def scenario() -> None:
        harness = advertising_harness()
        with_snapshot(harness, supported=True)
        harness.api.claims = [implementer_claim()]

        spec = await spec_of_first_process(harness)

        assert isinstance(harness.api, SnapshotApi)
        assert spec.snapshot is not None

    run(scenario)


# #839-T13
def test_an_app_that_does_not_list_the_feature_gets_no_channel() -> None:
    async def scenario() -> None:
        harness = advertising_harness()
        with_snapshot(harness, supported=False)
        harness.api.claims = [implementer_claim()]

        spec = await spec_of_first_process(harness)

        assert spec.snapshot is None

    run(scenario)


# #839-T13
def test_an_api_without_the_snapshot_call_gets_no_channel() -> None:
    async def scenario() -> None:
        harness = advertising_harness()
        harness.api.claims = [implementer_claim()]

        spec = await spec_of_first_process(harness)

        assert spec.snapshot is None

    run(scenario)


# #839-T13
def test_a_review_job_never_gets_the_channel_even_when_the_app_has_the_feature() -> None:
    async def scenario() -> None:
        harness = Harness()
        with_snapshot(harness, supported=True)
        harness.api.claims = [make_claim()]

        await harness.start()
        spec = harness.launcher.processes[0].spec
        harness.launcher.processes[0].finish(outcome())
        await settle()

        assert spec.snapshot is None

    run(scenario)
