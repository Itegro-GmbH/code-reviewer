# SPDX-License-Identifier: LicenseRef-Proprietary

"""The workspaces of a multi-repository turn as one (#1093, epic #1090, ADR 0006).

A multi-repository turn is a list of `GitWorkspace`s, one per entry of `implementer.repos`: its own
mirror under the reserve disk, its own agent repository (the directory `<name>` of the work volume),
its own token, its own start tips and its own push. Every rule of the single repository holds in
each of them, unchanged. This class does the three things that are about the set:

* **the set-up**: every repository is made in the order of the list, and the turn does not start
  until all are (a clone or a checkout that fails ends the turn `clone_failed`, free, naming the
  repository, and nothing is pushed). The time for the fetch (`CLONE_FETCH_SECONDS`) is for all of
  them together, and the room is checked after each clone, on the one reserve disk they share;
* **the push**: repository by repository in the order of the list, every changed local branch, no
  force, with the token of that repository. A rejected branch or a rejected repository does not
  stop the others; a lost lease ends the push at once (nothing is pushed after it). Each repository
  gets an equal share of the time that is left;
* **the facts**: the shape the session and the job read from the first repository (the old single
  facts) and from every one (`members`).

It offers the surface of `GitWorkspace` that the session, the setup and the job use, so that they do
not care which kind they hold; for a value that exists once per repository (`start_commit`, the push
report, ...) it answers with the first repository's, which is what the old single facts mean.
"""

import time
from collections.abc import Callable
from dataclasses import dataclass

from ..result import ErrorCode
from .git_process import fail
from .git_workspace import (
    CLONE_FETCH_SECONDS,
    CONFIRM_PAUSE_SECONDS,
    CONFIRM_SECONDS,
    BranchMoved,
    GitWorkspace,
    PushReport,
)
from .history import CommitInfo, FileChange


@dataclass(frozen=True)
class MemberFacts:
    """What one repository of the turn did, as the session reads it for the report."""

    workspace: GitWorkspace
    # Whether the final push got to this repository (False for one a lost lease cut off).
    reached: bool
    report: PushReport


class MultiWorkspace:
    """The workspaces of one turn, in the order of the job."""

    def __init__(
        self,
        members: tuple[GitWorkspace, ...],
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if not members:
            raise ValueError("a multi-repository turn has at least one repository")
        self.members = members
        self._clock = clock
        self._reached: set[int] = set()
        self._prepared = False

    @property
    def first(self) -> GitWorkspace:
        return self.members[0]

    # -- the set-up ------------------------------------------------------------------------------

    def prepare(self) -> None:
        """Every repository's mirror and agent repository, in order; the readers are made once
        they all exist. Raises `JobError` with a stable code that names the repository."""
        for member in self.members:
            member.check_names()
        deadline = self._clock() + CLONE_FETCH_SECONDS
        for member in self.members:
            member.fetch_seconds = max(deadline - self._clock(), 1.0)
            member.prepare_repository()
        # The agent's repositories are second full copies of the mirrors, on the work volume; the
        # mirrors share the reserve disk, and the push needs its room after all of them.
        for member in self.members:
            member.finish_prepare(warm=False)
        if not self.first.warm_readers():
            raise fail(ErrorCode.SETUP_FAILED, "reader_unavailable: the reader cannot be made")
        self._prepared = True

    # -- what the caller needs (the first repository's, the old single facts) --------------------

    @property
    def start_commit(self) -> str:
        if not self._prepared:
            raise fail(ErrorCode.SETUP_FAILED, "the repositories are not cloned yet")
        return self.first.start_commit

    @property
    def earlier_head(self) -> str | None:
        return self.first.earlier_head

    @property
    def start_source(self) -> str:
        return self.first.start_source

    @property
    def start_tips(self) -> dict[str, str]:
        return self.first.start_tips

    @property
    def start_checkout(self) -> str | None:
        return self.first.start_checkout

    @property
    def resume_moved(self) -> tuple[BranchMoved, ...]:
        return self.first.resume_moved

    @property
    def resume_missing(self) -> tuple[str, ...]:
        return self.first.resume_missing

    @property
    def checked_out(self) -> str | None:
        return self.first.checked_out

    # -- the leftover and the rescue, repository by repository ----------------------------------

    def dirty(self) -> bool:
        """Whether any working tree has changes (the look is the single repository's)."""
        return any(member.dirty() for member in self.members)

    def commit_all(self, message: str | None = None, *, seconds: float = 60.0) -> str | None:
        """The leftover commit in every repository whose tree is dirty. A repository that fails does
        not keep the others from being committed; the failure is raised afterwards (the caller notes
        that something could not be committed). Returns the tip of the first commit made."""
        committed: list[str] = []
        failure: Exception | None = None
        for member in self.members:
            try:
                if not member.dirty():
                    continue
                tip = (
                    member.commit_all(seconds=seconds)
                    if message is None
                    else member.commit_all(message, seconds=seconds)
                )
                if tip is not None:
                    committed.append(tip)
            except Exception as error:
                failure = failure or error
        if failure is not None:
            raise failure
        return committed[0] if committed else None

    def rescue_detached_head(self) -> str | None:
        """The rescue in every repository; the name of the first branch made, or None. A repository
        that cannot be rescued does not keep the others from it (raised afterwards)."""
        saved: list[str] = []
        failure: Exception | None = None
        for member in self.members:
            try:
                name = member.rescue_detached_head()
                if name is not None:
                    saved.append(name)
            except Exception as error:
                failure = failure or error
        if failure is not None:
            raise failure
        return saved[0] if saved else None

    def quiet_readers(self, *, seconds: float) -> bool:
        """The readers are the turn's and shared: one reset serves every repository."""
        return self.first.quiet_readers(seconds=seconds)

    def volume_free_bytes(self) -> int | None:
        return self.first.volume_free_bytes()

    def check_lease(self) -> None:
        self.first.check_lease()

    # -- after the environment's script ----------------------------------------------------------

    def settle_after_setup(self, *, seconds: float = 120.0) -> list[str]:
        """The undo of the script's history in every repository (`GitWorkspace.settle_after_setup`):
        the paths of the files restored, at most five of all."""
        names: list[str] = []
        for member in self.members:
            names.extend(member.settle_after_setup(seconds=seconds))
        return names[:5]

    @property
    def restored_count(self) -> int:
        return sum(member.restored_count for member in self.members)

    @property
    def excluded_count(self) -> int:
        return sum(member.excluded_count for member in self.members)

    @property
    def script_commits(self) -> int:
        return sum(member.script_commits for member in self.members)

    @property
    def dropped_refs(self) -> int:
        return sum(member.dropped_refs for member in self.members)

    # -- the push --------------------------------------------------------------------------------

    def push_all(
        self,
        *,
        seconds: float,
        confirm_seconds: float = CONFIRM_SECONDS,
        confirm_pause: float = CONFIRM_PAUSE_SECONDS,
    ) -> PushReport:
        """Push every repository in the order of the list within `seconds` in all. Each gets an
        equal share of what is left when its turn comes (a repository that is quick leaves its time
        to the next). Raises `JobError` only for a lost lease; what was done until then is in
        `push_report()` of each repository."""
        deadline = self._clock() + seconds
        self._reached = set()
        for index, member in enumerate(self.members):
            share = max((deadline - self._clock()) / (len(self.members) - index), 1.0)
            self._reached.add(index)
            member.push_all(
                seconds=share, confirm_seconds=confirm_seconds, confirm_pause=confirm_pause
            )
        return self.first.push_report()

    def push_report(self) -> PushReport:
        """The first repository's report (the old single facts)."""
        return self.first.push_report()

    def facts(self) -> tuple[MemberFacts, ...]:
        """Every repository with its push report and whether the push got to it."""
        return tuple(
            MemberFacts(member, index in self._reached, member.push_report())
            for index, member in enumerate(self.members)
        )

    def commits_since_start(self) -> list[CommitInfo]:
        return self.first.commits_since_start()

    def changed_files(self) -> list[FileChange]:
        return self.first.changed_files()


# What the session, the setup and the job hold: the workspace of one repository or of several.
AnyWorkspace = GitWorkspace | MultiWorkspace
