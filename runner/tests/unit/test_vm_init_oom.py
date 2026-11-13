# SPDX-License-Identifier: LicenseRef-Proprietary

"""vm-init keeps the OOM killer away from itself (#977 fix round): `oom_score_adj` -1000."""

import logging
from pathlib import Path

import pytest

from code_reviewer_runner.vm_init import oom


# #977-T08
def test_the_score_is_set_to_never(tmp_path: Path) -> None:
    target = tmp_path / "oom_score_adj"
    target.write_text("0", encoding="ascii")

    assert oom.protect_from_oom(str(target)) is True
    assert target.read_text(encoding="ascii") == "-1000"


# #977-T08
def test_a_file_that_cannot_be_written_is_a_warning_and_not_an_error(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.WARNING)

    assert oom.protect_from_oom(str(tmp_path / "missing" / "oom_score_adj")) is False
    assert "oom_score_adj" in caplog.text


def test_the_path_is_the_processs_own() -> None:
    assert oom.OOM_SCORE_ADJ_PATH == "/proc/self/oom_score_adj"
