# SPDX-License-Identifier: LicenseRef-Proprietary

"""The environment's setup script as one step of a turn (#818): the budget it gets, the Setup
container that runs it (`setup_container.py`), what becomes of the repository afterwards, and the
words of its result.

**Where it sits.** After the workspace is prepared (the clone is in the work volume) and before the
model door exists: a script that fails ends the turn here, free, and the model key was never
handed to anything. The agent's container starts from the image this step made.

**The time.** The script has `SETUP_SCRIPT_SECONDS` (15 minutes,
`contracts/environment-sizes.v1.json`) at most, and the whole step (start, script, saving the
image) is part of the turn's time limit: the agent's own deadline is counted from the start of the
job, so the minutes of the step are gone from it (`session.deadline_seconds`). The script is also
held to what the limit leaves: the grace for the end of the turn, the parts of the step around the
script (`SETUP_OVERHEAD_SECONDS`) and at least `MIN_AGENT_SECONDS` for the agent; a limit that
leaves less than `MIN_SCRIPT_SECONDS` for the script ends the turn here, free, saying so.

**The repository afterwards.** The script ran in the repository's folder and may have changed
anything in it, `.git` included. What it did is the base of the turn, not a change of the agent
(`GitWorkspace.settle_after_setup`), and the turn ends by pushing every local branch, so:

* its **history is undone**: a `git commit`, `git checkout -b`, `git tag` or `git reset` of the
  script does not count as the agent's work and is not pushed. HEAD goes back to the task's branch
  at the base commit the turn started from, the base branch goes back to it, every other branch
  and every tag is deleted. The log says how many commits and branches or tags that was;
* a change to a **tracked** file is undone (also one the script committed: the commit is gone, the
  file is restored), because a lockfile an install rewrote would arrive on the branch as the
  agent's work;
* a file or folder the script **added** (also one it committed) stays in the tree and goes on the
  repository's local ignore list (`.git/info/exclude`), **a folder as a whole**, so that it is
  neither "dirty" nor committed. A file the agent later adds inside such a folder is not committed
  either unless it adds it by name (`git add -f`); the agent's instructions say so. The log says
  how many were kept out and names the first few.

This is the one rule about what the script did; it is a rule about where the agent starts, not
about what the script may do. If Control cannot read the repository afterwards, the turn ends
`setup_failed` (ours, free), not `environment_setup_failed`.

**What the page gets.** The `setup` block of the result (`ImplementerSetupResult`): ok, the exit
status (None when the script did not end by itself), whether it ran out of time, the seconds, and
the end of its output (stdout and stderr together) with the job's secrets removed, control
characters taken out, at most 8,192 characters.
"""

import math
import re
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any, Final

from code_reviewer_runner.job import ImplementerEnvironment, JobError
from code_reviewer_runner.redaction import Redactor
from code_reviewer_runner.result import ErrorCode

from .git_workspace import GitWorkspace
from .session import ShutdownRequested, deadline_seconds
from .setup_container import (
    OUTCOME_NO_ROOM,
    OUTCOME_NOT_SAVED,
    OUTCOME_SCRIPT_FAILED,
    OUTCOME_STOPPED,
    OUTCOME_TIMED_OUT,
    SETUP_OVERHEAD_SECONDS,
    SetupContainer,
    SetupRun,
    SetupSeams,
)

# The script's own time limit (`contracts/environment-sizes.v1.json`, `setupScript.timeoutSeconds`).
SETUP_SCRIPT_SECONDS: Final = 900.0
# A script that gets less than this is not worth starting a container for.
MIN_SCRIPT_SECONDS: Final = 60.0
# What the agent must still have after the whole step at its ceilings.
MIN_AGENT_SECONDS: Final = 600.0
OUTPUT_CHARS: Final = 8192
# What of the output goes into the log line of a failed turn (the page has all of the 8,192).
LOG_OUTPUT_CHARS: Final = 1200
LOW_DISK_BYTES: Final = 1024 * 1024 * 1024

_ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")
# Everything but tab and line feed (a carriage return becomes a line end first).
_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")


def script_seconds(time_limit: float, elapsed: float) -> float:
    """The seconds the script may take: its own limit, or what the turn's limit leaves after the
    grace, the parts of the step around the script and the agent's minimum. May be below
    `MIN_SCRIPT_SECONDS`: then the caller ends the turn."""
    left = deadline_seconds(time_limit, elapsed) - SETUP_OVERHEAD_SECONDS - MIN_AGENT_SECONDS
    return min(SETUP_SCRIPT_SECONDS, left)


def clean_output(raw: bytes, secrets: Iterable[str]) -> str:
    """The end of a script's output as text the app and a person can read: decoded, terminal
    escapes and control characters out, the job's secrets removed, the last `OUTPUT_CHARS`."""
    text = raw.decode("utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
    text = _CONTROL.sub("", _ANSI.sub("", text))
    return Redactor(secrets).redact(text)[-OUTPUT_CHARS:].lstrip("\n")


@dataclass(frozen=True)
class EnvironmentSetup:
    """What the step made. `image` is the agent's image when it succeeded. `block` is the
    `ImplementerSetupResult` of the report (None when the script never ran: the Setup container
    could not be had). `error` is why the turn ends, else None. `notes` are facts for the log."""

    image: str | None
    block: dict[str, Any] | None
    error: JobError | None
    notes: tuple[str, ...]


def setup_block(run: SetupRun, output: str, *, ok: bool, closing: str = "") -> dict[str, Any]:
    """The `ImplementerSetupResult`. `closing` is the runner's own last line of the output (`[setup]
    ...`): a script that ended well but whose result could not be kept has no exit status that says
    so, and the page shows nothing but the exit status and the output."""
    if closing:
        room = max(0, OUTPUT_CHARS - len(closing) - 1)
        output = (output[-room:] + "\n" if room and output else "") + closing
    return {
        "ok": ok,
        "exitCode": run.exit_code,
        "timedOut": run.outcome == OUTCOME_TIMED_OUT,
        "durationSeconds": max(0, math.ceil(run.script_seconds)),
        "output": output,
    }


def _closing_line(text: str, secrets: tuple[str, ...]) -> str:
    return clean_output(f"[setup] {text}".encode(), secrets).strip()


def _megabytes(size: int | None) -> str:
    return "an unknown size" if size is None else f"{size / (1024 * 1024):.0f} MB"


def run_environment_setup(
    environment: ImplementerEnvironment,
    *,
    workspace: GitWorkspace,
    memory_mb: int,
    time_limit: float,
    elapsed: Callable[[], float],
    should_stop: Callable[[], bool],
    secrets: tuple[str, ...],
    seams: SetupSeams = SetupSeams(),  # noqa: B008 - frozen, shared on purpose
) -> EnvironmentSetup:
    """Run the environment's script and make the agent's image of what it left. Never raises for a
    script that failed (the result holds the error); raises `ShutdownRequested` when the runner was
    told to stop meanwhile."""
    seconds = script_seconds(time_limit, elapsed())
    if seconds < MIN_SCRIPT_SECONDS:
        return EnvironmentSetup(
            None,
            None,
            JobError(
                ErrorCode.ENVIRONMENT_SETUP_FAILED,
                "the time limit of the turn leaves no room for the setup script, so the turn "
                "did not start",
            ),
            (),
        )
    run = SetupContainer(memory_mb, seams).run(
        environment.setup_script,
        script_seconds=seconds,
        should_stop=should_stop,
        free_bytes=workspace.volume_free_bytes,
    )
    if run.outcome == OUTCOME_STOPPED:
        raise ShutdownRequested
    output = clean_output(run.output, secrets)
    notes = [
        f"setup: the Setup container started in {run.start_seconds:.0f} s, the script ran "
        f"{run.script_seconds:.0f} s"
        + (f", the image was saved in {run.save_seconds:.0f} s" if run.ok else "")
    ]
    notes.extend(f"setup: {note}" for note in run.notes)
    if run.ok:
        notes[0] += f" ({_megabytes(run.image_bytes)})"
        return _after_success(run, output, workspace, notes)
    closing = ""
    if run.outcome == OUTCOME_SCRIPT_FAILED:
        detail = run.detail or f"the setup script ended with exit status {run.exit_code}"
    elif run.outcome == OUTCOME_TIMED_OUT:
        detail = f"the setup script ran past its time limit of {seconds / 60:.0f} minutes"
    elif run.outcome == OUTCOME_NO_ROOM:
        # The customer's script left more than the VM's disk can keep as an image: theirs, free.
        detail = (
            "the setup script finished, but the disk of the VM is too full to keep its result: "
            + run.detail
        )
        closing = _closing_line(
            f"the VM had no room to save the setup result: {run.detail}", secrets
        )
    elif run.outcome == OUTCOME_NOT_SAVED:
        detail = f"the setup script finished, but its result could not be kept: {run.detail}"
        closing = _closing_line(f"the setup result could not be saved: {run.detail}", secrets)
    else:
        # The Setup container could not be had: the runner's, not the script's.
        return EnvironmentSetup(
            None, None, JobError(ErrorCode.SETUP_FAILED, run.detail), tuple(notes)
        )
    free = workspace.volume_free_bytes()
    if free is not None and free < LOW_DISK_BYTES:
        notes.append(f"the VM's disk had {free // (1024 * 1024)} MB left after the script")
    return EnvironmentSetup(
        None,
        setup_block(run, output, ok=False, closing=closing),
        JobError(ErrorCode.ENVIRONMENT_SETUP_FAILED, detail),
        tuple(notes),
    )


def _after_success(
    run: SetupRun, output: str, workspace: GitWorkspace, notes: list[str]
) -> EnvironmentSetup:
    try:
        restored = workspace.settle_after_setup()
    except JobError as error:
        # The script ended well; Control could not read the repository afterwards (or the lists
        # could not be kept): the failure is ours, with the free code of a turn that did not start.
        return EnvironmentSetup(
            None,
            setup_block(run, output, ok=True),
            JobError(ErrorCode.SETUP_FAILED, error.detail),
            tuple(notes),
        )
    if workspace.restored_count:
        listed = ", ".join(restored)
        more = workspace.restored_count - len(restored)
        notes.append(
            f"setup: {workspace.restored_count} tracked file(s) the script changed were put back "
            f"to the base commit ({listed}{f', and {more} more' if more > 0 else ''})"
        )
    if workspace.script_commits or workspace.dropped_refs:
        notes.append(
            f"setup: the script's history was undone ({workspace.script_commits} commit(s) it made "
            f"are not part of the turn, {workspace.dropped_refs} branch(es) or tag(s) it made were "
            "deleted); its files stay in the tree"
        )
    if workspace.excluded_count:
        notes.append(
            f"setup: {workspace.excluded_count} file(s) or folder(s) the script added are in the "
            "agent's tree and are not part of its changes (not committed unless added by name)"
        )
    return EnvironmentSetup(run.image, setup_block(run, output, ok=True), None, tuple(notes))


def log_output(setup: EnvironmentSetup) -> str:
    """The end of the output for the log line of a failed turn."""
    if setup.block is None:
        return ""
    return str(setup.block["output"])[-LOG_OUTPUT_CHARS:]
