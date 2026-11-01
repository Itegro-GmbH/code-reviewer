# SPDX-License-Identifier: LicenseRef-Proprietary

"""The guard's configuration files read by the programs that read them in the Worker (#762): the
hook sources `guard.conf` with bash, git reads the system config."""

import subprocess
from pathlib import Path

import pytest

from code_reviewer_runner.implementer.guard_files import guard_conf_text, system_gitconfig_text

SHA = "a" * 40


def _shell_value(text: str, name: str) -> str:
    """What `. conf` makes of `NAME=...`: the hook sources the file with bash."""
    done = subprocess.run(
        ["bash", "-c", f'{text}\nprintf %s "${name}"'], capture_output=True, text=True, check=True
    )
    return done.stdout


# #762-T02
@pytest.mark.parametrize(
    "branch",
    [
        "implementer/a1b2c3",
        "fix/$(id)",
        "x`id`y",
        "a'b",
        'a"b',
        "a;b",
        "a&b|c",
        "a\\b",
        "a$HOME",
        "é",
    ],
)
def test_the_guard_configuration_survives_the_shell_with_any_branch_name(branch: str) -> None:
    text = guard_conf_text(branch=branch, start=SHA, spool="/run/spool file", repo="/work/re po")

    assert _shell_value(text, "BRANCH") == branch
    assert _shell_value(text, "START") == SHA
    assert _shell_value(text, "SPOOL") == "/run/spool file"
    assert _shell_value(text, "REPO") == "/work/re po"
    assert not text.startswith("#!")


# #762-T02
def test_a_path_with_a_quote_or_backslash_is_escaped_in_the_git_config(tmp_path: Path) -> None:
    hooks = tmp_path / 'we"ird\\dir'
    hooks.mkdir()
    config = tmp_path / "system.gitconfig"
    config.write_text(system_gitconfig_text(hooks, [hooks]))

    done = subprocess.run(
        ["git", "config", "--file", str(config), "core.hooksPath"],
        capture_output=True,
        text=True,
        check=True,
    )

    assert done.stdout.strip() == str(hooks)
