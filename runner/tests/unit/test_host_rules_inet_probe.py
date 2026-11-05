# SPDX-License-Identifier: LicenseRef-Proprietary

"""The shell script that installs the `inet` table and tells a kernel with no `inet` family from one
that has it and refused (#827): by the exit status of probes, never by the wording of `nft`. Run
for real with a stand-in `nft` that behaves like the kernels of the two kinds, under any wording."""

import subprocess
from pathlib import Path

import pytest

from code_reviewer_runner.implementer import host_rules

# A stand-in `nft`: one argument is the ruleset, `add table <family> <name>` a probe, `delete table`
# its removal. FAKE_MODE: ok, nofamily (no `inet` family, a ruleset or an `inet` table is refused),
# refused (the family is there, the ruleset is refused), broken (every call fails).
FAKE_NFT = """#!/bin/sh
echo "$@" >> "$FAKE_LOG"
if [ "$#" -eq 1 ]; then
  [ "$FAKE_MODE" = ok ] && exit 0
  echo "$FAKE_MESSAGE" >&2
  exit 1
fi
if [ "$1 $2" = "add table" ]; then
  [ "$FAKE_MODE" = broken ] && { echo "$FAKE_MESSAGE" >&2; exit 1; }
  [ "$FAKE_MODE" = nofamily ] && [ "$3" = inet ] && { echo "$FAKE_MESSAGE" >&2; exit 1; }
  exit 0
fi
exit 0
"""


def status(tmp_path: Path, mode: str, message: str) -> tuple[int, str]:
    nft = tmp_path / "nft"
    nft.write_text(FAKE_NFT)
    nft.chmod(0o755)
    log = tmp_path / "calls"
    log.write_text("")
    script = host_rules.INET_SCRIPT.replace(host_rules.NFT, str(nft))
    done = subprocess.run(
        ["/bin/sh", "-c", script, "inet-rules", "add table inet t"],
        env={
            "FAKE_MODE": mode,
            "FAKE_MESSAGE": message,
            "FAKE_LOG": str(log),
            "PATH": "/usr/bin:/bin",
        },
        capture_output=True,
        timeout=20,
        check=False,
    )
    return done.returncode, log.read_text()


@pytest.mark.parametrize(
    "message",
    ["Error: Could not process rule: Operation not supported", "Protocol not available", ""],
)
def test_a_kernel_without_the_inet_family_is_found_whatever_nft_says(
    tmp_path: Path, message: str
) -> None:
    code, _ = status(tmp_path, "nofamily", message)
    assert code == host_rules.INET_NO_FAMILY_EXIT


@pytest.mark.parametrize(
    "message",
    ["Error: Could not process rule: Operation not supported", "Error: syntax error", ""],
)
def test_a_kernel_with_the_family_that_refused_the_table_is_a_failure_whatever_nft_says(
    tmp_path: Path, message: str
) -> None:
    # A real failure whose message holds the words the old check looked for stays a failure.
    code, log = status(tmp_path, "refused", message)
    assert code == 1
    assert "delete table inet" in log, "the probe table does not stay"


def test_an_nft_that_cannot_make_any_table_is_a_failure_not_a_missing_family(
    tmp_path: Path,
) -> None:
    assert status(tmp_path, "broken", "Operation not permitted")[0] == 1


def test_a_table_that_is_installed_exits_with_zero_and_probes_nothing(tmp_path: Path) -> None:
    code, log = status(tmp_path, "ok", "")
    assert code == 0 and log.count("\n") == 1
