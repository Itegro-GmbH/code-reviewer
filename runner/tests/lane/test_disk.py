# SPDX-License-Identifier: LicenseRef-Proprietary

"""An agent that fills its disk (#745, step 4): the work still arrives.

The agent writes where it likes, and the VM's disk is one file system it can fill, so Control's
mirror lives on a reserve disk of its own (a pre-allocated file system below the work volume that
the agent's container does not mount). The lane gives the volume a small file system of its own, the
stand-in for the VM's disk, and the agent fills it to the last block; the mirror, on the reserve, is
untouched, so the fetch and the push of what was committed before the disk was full still work, and
the outcome says that the disk was full. The real disk of a real VM is filled by the run on a spike
VM (`docs/implementer.md`, "The disk")."""

from pathlib import Path

from fakes.wire.formats import Turn
from lane_support import Turned, bash, commit, lane_turn, says, write_file

from code_reviewer_runner.implementer.git_workspace import RESERVE_DIRECTORY

DISK_MEGABYTES = 700


def mounted_on_its_own(path: Path) -> bool:
    return path.is_mount()


# #745-E16
def test_an_agent_that_fills_its_disk_still_gets_what_it_committed_pushed(tmp_path: Path) -> None:
    def script(repo: Path) -> list[Turn]:
        return [
            write_file(repo, "before.txt", "before the disk was full\n"),
            commit("Before the disk was full"),
            bash(
                "dd if=/dev/zero of=/work/repo/fill.bin bs=1M 2>&1 | tail -1; "
                "df -k /work/repo | tail -1; echo '[filled]'"
            ),
            write_file(repo, "after.txt", "after\n"),
            bash("git add -A && git commit -qm After 2>&1 | tail -2; echo '[after]' $?"),
            says("The disk is full."),
        ]

    with lane_turn(tmp_path, script, disk_megabytes=DISK_MEGABYTES) as turned:
        result = turned.result
        work = turned.workspace.layout.work_dir

        assert mounted_on_its_own(work / RESERVE_DIRECTORY), "the mirror is on a disk of its own"
        # The agent really filled it: it saw "No space left on device".
        shown = turned.tool_results()
        assert "[filled]" in shown and "No space left on device" in shown
        # What was committed before arrived, and the push did not need the disk that was full.
        assert result.pushed, (result.error_code, result.error_detail, result.notes)
        assert "Before the disk was full" in [c.subject for c in result.commits]
        assert turned.origin_tip() == result.head_commit
        # The outcome says that the disk was full, and what could not be kept.
        assert any("disk had" in note and "left at the end" in note for note in result.notes)
        free = turned.workspace.volume_free_bytes()
        assert free is not None and free < 64 * 1024**2
        # The reserve had room all the time.
        assert turned.workspace.reserve_free_bytes() > 256 * 1024**2


def test_a_commit_the_full_disk_could_not_take_is_said_not_hidden(tmp_path: Path) -> None:
    def script(repo: Path) -> list[Turn]:
        return [
            write_file(repo, "small.txt", "small\n"),
            commit("Small"),
            bash("dd if=/dev/zero of=/work/repo/fill.bin bs=1M >/dev/null 2>&1; echo '[filled]'"),
            says("Done."),
        ]

    with lane_turn(tmp_path, script, disk_megabytes=DISK_MEGABYTES) as turned:
        result = turned.result

        assert result.pushed and "Small" in [c.subject for c in result.commits]
        _check_notes(turned)


def _check_notes(turned: Turned) -> None:
    notes = " | ".join(turned.result.notes)
    # The leftover (the fill file) cannot be committed with no block free: said, not hidden.
    assert (
        "uncommitted changes could not be committed" in notes or "committed by the system" in notes
    )
    assert "disk had" in notes
