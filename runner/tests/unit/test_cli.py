# SPDX-License-Identifier: LicenseRef-Proprietary

"""Pins down the command line surface of the runner entry point without starting a process."""

import pytest

from code_reviewer_runner import __version__
from code_reviewer_runner.cli import main


# CR-14-T02
def test_version_flag_prints_the_package_version_and_exits_cleanly(
    capsys: pytest.CaptureFixture[str],
) -> None:
    exit_code = main(["--version"])

    assert exit_code == 0
    assert capsys.readouterr().out.strip() == f"code-reviewer-runner {__version__}"


def test_an_unknown_option_is_rejected_with_a_usage_error(
    capsys: pytest.CaptureFixture[str],
) -> None:
    exit_code = main(["--no-such-option"])

    assert exit_code == 2
    assert "usage:" in capsys.readouterr().err


# The mode is required: without one the entry point says how it is used and starts nothing.
def test_without_a_mode_nothing_starts_and_the_usage_is_named(
    capsys: pytest.CaptureFixture[str],
) -> None:
    exit_code = main([], environment={"RUNNER_TOKEN": "dummy-runner-token-0123456789-abcdef"})

    assert exit_code == 2
    error = capsys.readouterr().err
    assert "invalid arguments (one of: worker-once, probe)" in error
    assert "dummy-runner-token" not in error


# #1093: the golden image build asks the Worker image what its Worker reads of a job.
def test_worker_features_prints_what_the_worker_reads_and_starts_nothing(
    capsys: pytest.CaptureFixture[str],
) -> None:
    from code_reviewer_runner.job_loop.worker_api import WORKER_FEATURES

    exit_code = main(["--worker-features"], environment={})

    assert exit_code == 0
    printed = capsys.readouterr().out.strip().split(",")
    assert tuple(printed) == WORKER_FEATURES
    assert "implementer_multi_repo" in printed
