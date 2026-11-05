# SPDX-License-Identifier: LicenseRef-Proprietary

"""The git side of an Implementer turn: free git inside the workspace, one push at the end.

What the system does, and what the agent can and cannot:

* The runner (Control, root) clones the base branch, `--depth 1`, into a bare **mirror** only it can
  enter (`/work/reserve/mirror.git`, on the **reserve disk**: a pre-allocated file system of its
  own below the work volume, which the agent's container does not mount and the agent cannot
  fill, so the final push has room however full the VM's disk is). The provider token is in the
  environment of that one git process and nowhere else: not in argv, a config file, a URL, the
  mirror or anything the agent can reach.
* **A follow-up turn** (#838, `resume` of the job) starts from the branches the earlier turn left on
  the provider and not from the base alone: the provider is asked which of them it still has, and
  the base and all of those are fetched in one `--depth=50` fetch (git counts the depth from every
  tip, so none has less than 50 commits of history where it has that many), the agent's repository
  gets a local branch for each and the one the agent was on is checked out. A branch that moved on
  the provider since is taken at the provider's tip and the change is recorded (`resume_moved`). The
  start tip is kept **per branch** (`start_tips`): a branch the agent did not touch is not pushed
  again, and what a setup script did is undone branch by branch.
* The agent works in `/work/repo` of **its own container** (`agent_container.py`): the Subpath
  `repo` of the work volume, a local clone of the mirror with no remote and no credential. It may do
  anything with git there: commit, amend, rebase, reset, create and switch branches, tag. Nothing is
  installed in its repository and nothing watches it. It sees nothing of the mirror.
* **The one push.** When the turn ends, Control lists the local branches of the agent's repository,
  fetches each into a scratch ref of the mirror (`refs/runner/in/<n>`) and pushes it from the mirror
  to `refs/heads/<name>` with the token, **without force**, one refspec and one command per branch
  (`push_all`). No check of who committed, what descends from what, or which branch
  (`push_policy.select_branches` is the one place a rule would go). A branch the provider refuses is
  reported as rejected with a reason; the others are not held back. Nothing is ever deleted on the
  provider and no tag or note is pushed. There is no push during the turn: the agent may rewrite
  history, so a VM that dies mid-turn loses the work.
* **How Control stays safe from the agent's repository.** Control never runs git with that
  repository as working directory or git directory, and never opens a path in it: everything that
  looks inside runs in the **reader** (`reader.py`), a container under the Sysbox runtime with the
  repository and no network, no token and no other mount, and whatever the repository's config
  makes git run, it runs there, where it cannot reach the VM. The repository is read-only for
  every look; only the steps that change it (the set-up before the agent exists, the rescue of a
  detached HEAD and the leftover commit after the agent's container is gone) run in the second
  reader that has it read-write. The list of branches is made by `git for-each-ref` in the reader,
  read as a stream and
  capped (`LIST_MAX_BYTES`); the mirror reads the branches through `git upload-pack` in the reader,
  piped to Control's `git fetch` (`exec_pipe.py`). What comes back is an object stream that the
  mirror's git checks (`fsckObjects`) and stores; the mirror is bare (nothing is checked out, no
  filter or hook runs) and its config is the runner's. The names of the branches are the only thing
  taken from the listing, and each is validated (`push_policy`) before it is put in a refspec; the
  tip of a branch is read from the mirror, never from what the listing printed. **Room first:**
  before any branch is taken over the mirror's file system is asked for its free bytes and inodes
  (`MIN_FREE_BYTES`, `MIN_FREE_INODES`); too little and no fetch is started, every branch is
  reported rejected as `out_of_space`, and a fetch that fails with the disk gone says the same
  instead of `unreadable`. **When each runs:**
  the look at the status of the tree (`dirty`) runs **while the agent's container is still alive**,
  because its answer decides whether the agent gets one more message; it is a read in the read-only
  reader, and an agent that changes the tree under it only changes that answer. The rescue of a
  detached HEAD and the leftover commit run in the reader that writes, **after** the agent's
  container is killed and confirmed gone (nothing is committed or rescued otherwise), and the
  listing and the fetch of the final push follow. The one thing Control does in the repository's
  directory is making it (`git clone` of its own mirror, before the agent exists).
"""

import os
import re
import shutil
import stat
import time
import uuid
from collections.abc import Callable, Collection, Iterable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol
from urllib.parse import urlsplit

from ..job import ImplementerResume, JobError
from ..result import ErrorCode
from .git_process import (
    DEFAULT_TIMEOUT,
    TRUSTED_PATH,
    GitProcess,
    Outcome,
    fail,
    token_environment,
)
from .history import (
    READ_COMMITS,
    CappedBytes,
    CappedLines,
    CommitInfo,
    FileChange,
    StopReading,
    parse_commits,
    parse_name_status,
)
from .push_guard import SecretScanner
from .push_policy import branch_name_problem, select_branches
from .ref_drop import RefDeletions, RefListingFailed

LEFTOVER_MESSAGE = "Implementer: uncommitted changes of the turn"
# The final push asks the lease again every this often, for up to `confirm_seconds` (#765).
CONFIRM_PAUSE_SECONDS = 2.0
CONFIRM_SECONDS = 30.0
# How long one command of the end of the turn may take at most; the budget of the whole push
# (`push_all(seconds=...)`) shortens each of them further.
LIST_TIMEOUT = 20.0
# The look at the status of the tree before the leftover commit, and each read of the commits or
# the files of the form's branch from the mirror for the report.
DIRTY_TIMEOUT = 10.0
REPORT_READ_TIMEOUT = 5.0
# Each of the three git commands of the rescue of a detached HEAD (`rescue_detached_head`).
RESCUE_STEP_TIMEOUT = 3.0
# The most bytes of the agent's list of local branches the runner reads. A repository can hold any
# number of refs; this holds about 40,000 branches and the rest is not read.
LIST_MAX_BYTES = 4 * 1024 * 1024
FETCH_TIMEOUT = 60.0
# The most time the `ls-remote` and the one fetch of a follow-up's branches may take together (the
# `ls-remote` gets `FETCH_TIMEOUT` of it at most); a turn that is not set up by then ends
# `clone_failed`, free.
RESUME_FETCH_SECONDS = 300.0
# How much history every branch of a follow-up turn gets at least (the base branch, the session
# branch and the other branches, fetched in one command so that git counts the depth from every
# tip): the agent has no remote to deepen from, and with less the base branch that moved since the
# earlier turn cannot be merged, rebased or diffed against (`merge-base` finds nothing). A merge
# base further back than this many commits is not found. A first turn takes the base branch one
# deep: its branch starts at the tip.
RESUME_DEPTH = 50
PUSH_TIMEOUT = 120.0
# The push guard (#856) reads the objects a branch adds, twice (the list, then the content): each
# read gets this long at most, the list is kept up to 64 MiB (about 700,000 objects with their
# paths) and the content is read up to 4 GiB. A branch beyond any of them is not pushed
# (`unchecked`): the guard does not let through what it could not read.
GUARD_SECONDS = 300.0
# Of the seconds the final push has, this share is kept for the guard (#856): the fetch of a branch,
# the question to the lease and the push stop before it, so a stop (which gives the push 25 s) or a
# slow fetch cannot leave the guard one second and turn committed work into `unchecked`. What the
# guard does not use goes back to the push of the last branch.
GUARD_SHARE = 0.4
GUARD_LISTING_MAX_BYTES = 64 * 1024 * 1024
GUARD_READ_MAX_BYTES = 4 * 1024**3
# The wait before the one new try of a push the provider could not take.
TRANSIENT_PAUSE_SECONDS = 3.0
# The room the mirror's file system must have left before the final push takes a branch over: the
# objects of the agent's commits (a few megabytes for a normal turn, the size of what it committed
# for a large one) and the pack git writes while it checks them.
MIN_FREE_BYTES = 256 * 1024 * 1024
MIN_FREE_INODES = 10_000
# The mirror's directory below the work directory. In production it is a mount of its own, a
# pre-allocated file system the agent cannot fill (`reserve disk`, `container.ts`).
RESERVE_DIRECTORY = "reserve"
# The scratch refs of the mirror: the agent's branches are fetched here, numbered, so that no name
# the agent chose ever becomes a local ref of the runner.
SCRATCH_PREFIX = "refs/runner/in/"
# The mirror is the runner's alone: no git in it may start a `gc --auto` or `maintenance run
# --auto` that outlives it (they detach into the background, and survive the group kill of a
# timeout).
# `core.bigFileThreshold` as in the reader: big blobs are stored whole, so packing them for the push
# stays within Control's memory. The objects and their names are the same either way.
_MIRROR_OPTIONS = (
    "-c",
    "gc.auto=0",
    "-c",
    "maintenance.auto=false",
    "-c",
    "core.bigFileThreshold=1m",
)
_PLAIN_FETCH = ("--no-tags", "--no-write-fetch-head")
_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f-\x9f]")
# Only the leftover commit of the system: the agent's hooks do not run for it.
_LEFTOVER_OPTIONS = ("core.hooksPath=/dev/null", "commit.gpgsign=false")

# Why a branch was not pushed (the `reason` of a branch in the report; a closed set of ours, never
# the provider's text).
REASON_NOT_FAST_FORWARD = "non_fast_forward"
REASON_REMOTE_REJECTED = "remote_rejected"
REASON_WORKFLOWS = "workflows_not_allowed"
REASON_PROVIDER_REFUSED = "provider_refused"
REASON_PROVIDER_UNAVAILABLE = "provider_unavailable"
REASON_UNREADABLE = "unreadable"
REASON_NOT_A_COMMIT = "not_a_commit"
REASON_OUT_OF_TIME = "out_of_time"
# The mirror's disk has too little room left to take a branch over (or ran out while it was).
REASON_OUT_OF_SPACE = "out_of_space"
# A git command of ours was killed at its time limit: nothing is known of what it did.
REASON_TIMED_OUT = "timed_out"
# GitHub answered the push with an error that is neither a refusal of the access nor a hiccup.
REASON_PROVIDER_ERROR = "provider_error"
# The branch holds the login of the device (#856, `push_guard.py`), or the guard could not read it
# to its end: in both the branch is not pushed.
REASON_LOGIN_SECRET = "login_secret"
REASON_UNCHECKED = "unchecked"
# Why the list of branches could not be had (`PushReport.list_problem`).
LIST_UNREADABLE = "unreadable"
LIST_TOO_LARGE = "too_large"

# An answer of the provider that is a no and not a hiccup: a client error other than "request
# timeout" and "too many requests" (credentials, permission, a missing repository, a validation).
_HTTP_ERROR = re.compile(r"returned error: (\d{3})")
_RETRYABLE_CLIENT_ERRORS = frozenset({408, 425, 429})
# git asks for credentials after a 401 and, with prompts off, reports that instead of the status.
# Only the words of git about the remote's answer: a local "Permission denied" (a lock, the
# mirror's own files) is not the provider refusing anything, and is not matched.
_CREDENTIALS_REFUSED = re.compile(r"could not read (?:Username|Password)|Authentication failed")
# A `! ... [remote rejected] (reason)` line of the porcelain whose reason says the provider itself
# failed (GitHub's "internal error" and "failed to update ref"): a hiccup, not a no.
_HICCUP = re.compile(r"\[remote rejected\]\s*\((?:internal error|failed to update ref)\)", re.I)
# The words GitHub gives for a change of a workflow file by an App without the `workflows`
# permission. Matched only as the reason in the parentheses of the status line, or at the start of a
# `remote:` line: a branch name is never in either place, so a name that holds "workflow" is no
# reason.
_WORKFLOW_REASON = "refusing to allow a GitHub App to create or update workflow "
_REMOTE_REJECTED = re.compile(r"\[remote rejected\]\s*\((?P<reason>.*)\)\s*$")
# A client error of the provider that means "no access" (the token, the permission, the repository).
_ACCESS_STATUSES = frozenset({401, 403, 404})
_SHA = re.compile(r"[0-9a-f]{40}")


@dataclass(frozen=True)
class DiskSpace:
    """What is left on a file system for the runner: bytes and inodes (a full inode table stops
    git as a full disk does)."""

    free_bytes: int
    free_inodes: int


def disk_space(path: Path) -> DiskSpace:
    status = os.statvfs(path)
    return DiskSpace(status.f_bavail * status.f_frsize, status.f_favail)


class RepoAccess(Protocol):
    """How git looks into the agent's repository: in the reader, a container with the repository
    and nothing else (`reader.ReaderAccess`). A test brings a local one."""

    @property
    def repo_source(self) -> str:
        """What Control's `git fetch` names as the source repository."""
        ...

    def upload_pack(self) -> str:
        """The command Control's `git fetch --upload-pack=` runs to read the agent's branches."""
        ...

    def warm(self) -> bool:
        """Make everything a look needs before the agent runs, so that nothing has to be created
        later, when the VM's disk may be full (a container needs room to be made). False when it
        cannot be had."""
        ...

    def reset(self, *, seconds: float) -> bool:
        """Kill every process that exists in the places git runs and start them again, so that
        nothing a repository's filter or hook left behind is alive. False when that could not be
        done for all of them."""
        ...

    def append_exclude(self, data: bytes, *, timeout: float) -> Outcome:
        """Append lines to the repository's local ignore file (`.git/info/exclude`)."""
        ...

    def run(self, args: Sequence[str], *, timeout: float, write: bool = False) -> Outcome:
        """One git command in the repository; never raises on a failed command. A command that
        changes the repository says `write`: it runs where the repository is read-write, and only
        those do."""
        ...

    def stream(
        self, args: Sequence[str], consume: Callable[[bytes], None], *, timeout: float
    ) -> Outcome:
        """`run` for output that is read as a stream and not kept."""
        ...

    def update_refs(
        self, options: Sequence[str], commands: Iterable[bytes], *, timeout: float
    ) -> Outcome:
        """`git <options> update-ref --stdin -z` in the repository (where it is read-write) with
        `commands` as its standard input, written as they are produced."""
        ...


@dataclass(frozen=True)
class GitIdentity:
    """Who the agent's commits are by unless it says otherwise: `<product> Implementer`."""

    name: str
    email: str


@dataclass(frozen=True)
class WorkspaceSpec:
    """What a job names: the repository, the token that may write it and the two branches."""

    clone_url: str
    token: str
    base_branch: str
    branch: str
    # #838: the branches of the session on a follow-up turn; None on the first turn.
    resume: ImplementerResume | None = None


@dataclass(frozen=True)
class BranchMoved:
    """A branch of the session that is not where the earlier turn left it: `was` is the tip that
    turn pushed, `now` the tip the provider has (the one the new turn starts from)."""

    name: str
    was: str
    now: str


@dataclass(frozen=True)
class WorkspaceLayout:
    """Where things are. `work_dir` is the work volume (Control's view of it), `run_dir` is under
    /run (the runner's own files)."""

    work_dir: Path = Path("/work")
    run_dir: Path = Path("/run/code-reviewer")


class LeaseNotConfirmed(JobError):
    """The job host could not say whether the job is still ours (the app did not answer, #765). Not
    a no: the push asks again within its window before it gives up (`lease_lost`). Nothing is
    pushed while the answer is missing."""

    def __init__(self) -> None:
        super().__init__(
            ErrorCode.RUNNER_ERROR, "the lease could not be confirmed, so nothing is pushed"
        )


@dataclass(frozen=True)
class BranchPush:
    """What became of one local branch: pushed, or rejected with a reason. `head` is the tip the
    runner took over (None when it could not be read)."""

    name: str
    head: str | None
    pushed: bool
    reason: str | None


@dataclass(frozen=True)
class PushReport:
    """The result of the final push so far. `form_head` is the tip of the form's branch when it has
    work on top of the start commit (pushed or not). `listed` is False when the agent's repository
    could not be read at all. `invalid` counts local branches whose name is not a branch name and
    `overflow` the valid ones beyond the limit: neither is named."""

    branches: tuple[BranchPush, ...] = ()
    form_head: str | None = None
    listed: bool = True
    list_problem: str | None = None
    invalid: int = 0
    overflow: int = 0
    # Whether the task's branch is among the local branches. A branch that is gone is not a branch
    # that is verifiably empty.
    form_listed: bool = True

    @property
    def pushed_any(self) -> bool:
        return any(branch.pushed for branch in self.branches)


def _http_status(detail: str) -> int | None:
    found = _HTTP_ERROR.search(detail)
    return None if found is None else int(found.group(1))


def _is_access_refusal(detail: str) -> bool:
    """Whether git's report names a refusal of the access: credentials asked for again, or a 401,
    403 or 404. The text is the provider's side of the push on the runner's own mirror."""
    return bool(_CREDENTIALS_REFUSED.search(detail)) or _http_status(detail) in _ACCESS_STATUSES


def _is_client_error(detail: str) -> bool:
    """A client error of the provider that is no hiccup and not worth retrying (a 413, a 422, ...;
    408, 425 and 429 are hiccups)."""
    status = _http_status(detail)
    return status is not None and 400 <= status < 500 and status not in _RETRYABLE_CLIENT_ERRORS


class _LoginFound(Exception):
    """The push guard found the login in what a branch adds (ends the read of it)."""


class _GuardOverrun(Exception):
    """What a branch adds is larger than the push guard reads (ends the read of it)."""


class _ListingTooLarge(Exception):
    """The agent's list of branches is longer than `LIST_MAX_BYTES`."""


def _invalid(detail: str) -> JobError:
    return fail(ErrorCode.IMPLEMENTER_CONFIG_INVALID, detail)


def _checked_url(url: str, schemes: Collection[str]) -> None:
    parts = urlsplit(url)
    if parts.scheme not in schemes:
        raise _invalid("the clone address must be an https address")
    if parts.scheme == "file":
        if not parts.path.startswith("/"):
            raise _invalid("the clone address is not a valid file address")
        return
    if not parts.hostname or parts.username or parts.password or parts.query or parts.fragment:
        raise _invalid("the clone address must not have credentials, a query or a fragment")


@dataclass
class _Progress:
    """What the final push has done so far; read by `push_report` also after it raised."""

    branches: list[BranchPush] = field(default_factory=lambda: [])
    form_head: str | None = None
    listed: bool = True
    list_problem: str | None = None
    invalid: int = 0
    overflow: int = 0
    form_listed: bool = True
    # The scratch ref the form's branch was taken over into (None: it was not).
    form_ref: str | None = None
    # The seconds still kept for the push guard (`GUARD_SHARE`): nothing for a turn without a login.
    guard_tank: float = 0.0


class GitWorkspace:
    """One turn's repository and mirror. See the module text for the rules."""

    def __init__(
        self,
        spec: WorkspaceSpec,
        layout: WorkspaceLayout,
        identity: GitIdentity,
        access: RepoAccess,
        *,
        git: str = "git",
        path: str = TRUSTED_PATH,
        schemes: Collection[str] = ("https",),
        timeout: float = DEFAULT_TIMEOUT,
        before_push: Callable[[], None] | None = None,
        guard_secrets: Sequence[str] = (),
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        space: Callable[[Path], DiskSpace] = disk_space,
    ) -> None:
        _checked_url(spec.clone_url, schemes)
        executable = shutil.which(git, path=path)
        if executable is None:
            raise fail(ErrorCode.SETUP_FAILED, "git is not installed")
        self.spec = spec
        # Called before the final push lists anything and again right before every `git push`: it
        # raises to refuse. The job asks the lease here, so that nothing is pushed for a job that is
        # not ours (#765).
        self._before_push = before_push
        # #856: the values no branch may carry to the provider (the login of the device); none: no
        # branch is read for them.
        self._guard_secrets = tuple(guard_secrets)
        self.layout = layout
        self.identity = identity
        self._access = access
        self.git = executable
        self._schemes = tuple(sorted(schemes))
        self._timeout = timeout
        self._clock = clock
        self._sleep = sleep
        self._space = space
        self._path = ":".join(dict.fromkeys([str(Path(executable).parent), *path.split(":")]))
        self._process = GitProcess(executable, self._path, layout.run_dir, spec.token)
        self.reserve = layout.work_dir / RESERVE_DIRECTORY
        self.mirror = self.reserve / "mirror.git"
        self.repo = layout.work_dir / "repo"
        # The tip each branch starts the turn at: the base branch, the session branch (the base tip
        # when the earlier turn never pushed it) and every branch of a follow-up that arrived. The
        # one of the form's branch is `_start`.
        self._starts: dict[str, str] = {}
        self._start: str | None = None
        # The branch checked out when the agent starts.
        self._checkout: str | None = None
        self._moved: list[BranchMoved] = []
        self._missing: list[str] = []
        self._names_checked = False
        self._progress = _Progress()
        # How many tracked files `settle_after_setup` found changed, and how many entries it put on
        # the local ignore list (0 before it ran).
        self.restored_count = 0
        self.excluded_count = 0
        # How many commits and how many branches and tags the script made, which
        # `settle_after_setup` took away (0 before it ran).
        self.script_commits = 0
        self.dropped_refs = 0
        # The local branch HEAD is on when the agent's work is read after the turn (#837), set by
        # `rescue_detached_head` and `commit_all`: None while it was not read, and for a HEAD that
        # is detached (and saved on a branch some other way, or not at all).
        self.checked_out: str | None = None

    # -- what the caller needs -------------------------------------------------------------------

    @property
    def start_commit(self) -> str:
        if self._start is None:
            raise fail(ErrorCode.SETUP_FAILED, "the base branch is not cloned yet")
        return self._start

    @property
    def start_tips(self) -> dict[str, str]:
        """The tip every branch of the repository starts the turn at, by name (a copy)."""
        if self._start is None:
            raise fail(ErrorCode.SETUP_FAILED, "the base branch is not cloned yet")
        return dict(self._starts)

    @property
    def start_checkout(self) -> str | None:
        """The branch the agent starts on, once the agent's repository is made (None before)."""
        return self._checkout

    @property
    def resume_moved(self) -> tuple[BranchMoved, ...]:
        """The branches of a follow-up that moved on the provider since the earlier turn."""
        return tuple(self._moved)

    @property
    def resume_missing(self) -> tuple[str, ...]:
        """The branches of a follow-up that the provider no longer has (they are left out)."""
        return tuple(self._missing)

    # -- the steps of a turn's set-up ------------------------------------------------------------

    def prepare(self) -> None:
        """Everything before the agent starts: the mirror and the agent's repository. Raises
        `JobError` with a stable code; nothing is left half done that a retry would trip over (the
        work volume is a new one per turn)."""
        self._check_names()
        self.clone_mirror()
        self.create_agent_repository()
        if not self._access.warm():
            raise fail(ErrorCode.SETUP_FAILED, "reader_unavailable: the reader cannot be made")

    def clone_mirror(self) -> None:
        """Fetch the base branch, depth 1, into the new bare mirror; a follow-up fetches the
        branches of its session as well, `RESUME_DEPTH` deep (`_fetch_follow_up`). The token is in
        the environment of each git process that reaches the provider and nowhere else."""
        self._check_names()
        self._prepare_directories()
        mirror = self.mirror
        mirror.mkdir(mode=0o700)
        os.chmod(mirror, 0o700)
        base = self.spec.base_branch
        init = self._root(
            ["init", "-q", "--bare", "--template=", f"--initial-branch={base}", str(mirror)],
            protocols="file",
        )
        if init.returncode != 0:
            raise fail(
                ErrorCode.SETUP_FAILED, "the mirror cannot be created: " + self._detail(init)
            )
        self._moved, self._missing = [], []
        if self.spec.resume is not None:
            self._starts = self._fetch_follow_up()
        else:
            self._starts = {base: self._fetch_base()}
        # The session branch starts at the base tip unless an earlier turn pushed it.
        self._start = self._starts.setdefault(self.spec.branch, self._starts[base])

    def _fetch_base(self) -> str:
        """A first turn: the base branch, one deep, into the mirror as `refs/heads/<base>`; its
        tip."""
        base = self.spec.base_branch
        fetched = self._mirror(
            [
                "fetch",
                "--depth=1",
                *_PLAIN_FETCH,
                self.spec.clone_url,
                f"refs/heads/{base}:refs/heads/{base}",
            ],
            protocols=":".join(self._schemes),
            token=True,
        )
        if fetched.returncode != 0:
            code = (
                ErrorCode.BASE_BRANCH_NOT_FOUND
                if "couldn't find remote ref" in fetched.stderr
                else ErrorCode.CLONE_FAILED
            )
            raise fail(code, "the base branch cannot be cloned: " + self._detail(fetched))
        return self._tips_in_mirror([base])[base]

    def _fetch_follow_up(self) -> dict[str, str]:
        """A follow-up turn: the base branch and each branch the earlier turn left on the provider,
        into the mirror as `refs/heads/<name>`, by name and tip as the mirror has them.

        The provider is asked first which of the branches it has (`git ls-remote`, with the token
        as every other command that reaches it), then **one** `git fetch --depth=RESUME_DEPTH` takes
        all of them: git counts the depth from every tip and keeps a commit when any tip reaches it
        within that many commits, so no tip is left with less than `RESUME_DEPTH` commits of
        history (where it has that many), whatever the branches lie to each other. Separate fetches
        would not do that: a later `--depth` fetch moves the shallow boundary and can make a branch
        that is an ancestor of the new one, or a base that it is far ahead of, a shallow root.

        A branch the provider no longer has is left out and recorded (`resume_missing`); a tip that
        is not the pushed one is recorded (`resume_moved`). The base branch gone is
        `base_branch_not_found`; the session branch gone is the end of the turn (the app checks it
        before it starts one, so this is a race). Both git commands are bound by `FETCH_TIMEOUT`
        and the `RESUME_FETCH_SECONDS` deadline together."""
        resume = self.spec.resume
        assert resume is not None
        base = self.spec.base_branch
        deadline = self._clock() + RESUME_FETCH_SECONDS
        wanted = [base, *(entry.name for entry in resume.branches if entry.name != base)]
        listed = self._mirror(
            [
                "ls-remote",
                "--heads",
                self.spec.clone_url,
                *(f"refs/heads/{name}" for name in wanted),
            ],
            protocols=":".join(self._schemes),
            token=True,
            timeout=self._left(FETCH_TIMEOUT, deadline),
        )
        if listed.returncode != 0:
            raise fail(
                ErrorCode.CLONE_FAILED,
                "the branches of the session cannot be listed: " + self._detail(listed),
            )
        on_provider = {
            line.partition("\t")[2].removeprefix("refs/heads/")
            for line in listed.stdout.splitlines()
        }
        if base not in on_provider:
            raise fail(ErrorCode.BASE_BRANCH_NOT_FOUND, "the base branch is not on the provider")
        present = [name for name in wanted if name in on_provider]
        fetched = self._mirror(
            [
                "fetch",
                f"--depth={RESUME_DEPTH}",
                *_PLAIN_FETCH,
                self.spec.clone_url,
                *(f"refs/heads/{name}:refs/heads/{name}" for name in present),
            ],
            protocols=":".join(self._schemes),
            token=True,
            timeout=self._left(RESUME_FETCH_SECONDS, deadline),
        )
        if fetched.returncode != 0:
            raise fail(
                ErrorCode.CLONE_FAILED,
                "the branches of the session cannot be fetched: " + self._detail(fetched),
            )
        tips = self._tips_in_mirror(present)
        for entry in resume.branches:
            tip = tips.get(entry.name)
            if tip is None:
                if entry.name == self.spec.branch:
                    raise fail(ErrorCode.CLONE_FAILED, "the session branch is gone on the provider")
                self._missing.append(entry.name)
                continue
            if tip != entry.head:
                self._moved.append(BranchMoved(entry.name, entry.head, tip))
        return tips

    def _tips_in_mirror(self, names: Sequence[str]) -> dict[str, str]:
        """The commit each of the branches fetched into the mirror is at, by name."""
        tips: dict[str, str] = {}
        for name in names:
            done = self._mirror(["rev-parse", "--verify", f"refs/heads/{name}^{{commit}}"])
            if done.returncode != 0 or not _SHA.fullmatch(done.stdout.strip()):
                raise fail(ErrorCode.CLONE_FAILED, "a fetched branch of the session has no commit")
            tips[name] = done.stdout.strip()
        return tips

    def create_agent_repository(self) -> None:
        """The agent's repository: a local clone of the mirror (no hard links, so nothing is shared
        with it), without a remote, with the identity and the new branch at the base tip; on a
        follow-up a local branch for every branch the mirror holds, at the tip the mirror has, and
        the one the agent was on checked out. Made by Control from its own mirror before the agent
        exists; the steps that read or write inside it run in the reader. The same path every
        turn."""
        base = self.spec.base_branch
        starts = self.start_tips  # raises when the base branch is not cloned yet
        target = self._start_branch()
        start = starts[target]
        # Not `--single-branch`: the mirror holds the base branch and, on a follow-up, the branches
        # of the session, and nothing else under `refs/heads/`.
        cloned = self._root(
            [
                "-c",
                "core.hooksPath=/dev/null",
                "clone",
                "-q",
                "--no-tags",
                f"--branch={base}",
                "--template=",
                "--no-checkout",
                f"file://{self.mirror}",
                str(self.repo),
            ],
            protocols="file",
        )
        if cloned.returncode != 0:
            raise fail(
                ErrorCode.SETUP_FAILED,
                "the agent repository cannot be cloned: " + self._detail(cloned),
            )
        if self.spec.resume is not None:
            self._make_local_branches()
        setup = (
            ["remote", "remove", "origin"],
            ["config", "user.name", self.identity.name],
            ["config", "user.email", self.identity.email],
            ["config", "commit.gpgsign", "false"],
            # A new branch at the base tip on the first turn; on a follow-up every branch exists
            # already and the checkout fills the empty tree.
            ["checkout", "-q", "-b", self.spec.branch]
            if self.spec.resume is None
            else ["checkout", "-q", target, "--"],
        )
        for arguments in setup:
            done = self._access.run(arguments, timeout=self._timeout, write=True)
            if done.returncode != 0:
                raise fail(
                    ErrorCode.SETUP_FAILED,
                    f"git {arguments[0]} failed in the agent repository: "
                    + self._agent_detail(done),
                )
        head = self._access.run(["rev-parse", "HEAD"], timeout=self._timeout)
        if head.stdout.strip() != start:
            raise fail(
                ErrorCode.SETUP_FAILED,
                "the agent repository is not at the base tip"
                if self.spec.resume is None
                else "the agent repository is not at the tip of the branch to check out",
            )
        self._checkout = target

    def _start_branch(self) -> str:
        """The branch the agent starts on: the session branch on a first turn; on a follow-up the
        one the earlier turn ended on, when the provider still has it."""
        resume = self.spec.resume
        if resume is not None and resume.checkout in self._starts:
            assert resume.checkout is not None
            return resume.checkout
        return self.spec.branch

    def _make_local_branches(self) -> None:
        """A local branch for every branch of the session at its start tip (the base branch is the
        one the clone made, the session branch is made at the base tip when it never arrived). One
        `update-ref --stdin -z` in the reader, with the tips the mirror gave; the names were
        checked, and are not read by anything that parses them."""
        base = self.spec.base_branch
        commands = (
            b"create refs/heads/" + name.encode() + b"\0" + tip.encode() + b"\0"
            for name, tip in self._starts.items()
            if name != base
        )
        done = self._access.update_refs([], commands, timeout=self._timeout)
        if done.returncode != 0:
            raise fail(
                ErrorCode.SETUP_FAILED,
                "the branches of the session cannot be made in the agent repository: "
                + self._agent_detail(done),
            )

    # -- the leftover (in the reader) -------------------------------------------------------

    def dirty(self) -> bool:
        """Whether the working tree has changes, untracked files included. Runs in the read-only
        reader, while the agent may still be running (it decides on the extra message). Only
        the first byte of what `git status` prints is looked at: the output is the agent's (a tree
        with a million untracked files prints megabytes) and the answer is whether it has any. A
        status that fails says nothing about the tree: False (`commit_all` is not tried)."""
        seen: list[bool] = []

        def first(chunk: bytes) -> None:
            if chunk:
                seen.append(True)
                raise StopReading

        done = self._reader_stream(
            [
                "--no-optional-locks",
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all",
            ],
            first,
            timeout=DIRTY_TIMEOUT,
        )
        return bool(seen) and done.returncode == 0

    def commit_all(self, message: str = LEFTOVER_MESSAGE, *, seconds: float = 60.0) -> str | None:
        """Commit everything with the fixed message, in the reader. The agent's own hooks do
        not run. Returns the new tip, or None when there was nothing to commit. A HEAD that is on no
        branch (the agent checked out a commit) first gets a branch of its own, so that the commit
        is not lost. Raises `JobError` (`setup_failed`) when git fails; the caller notes it and goes
        on to the push."""
        deadline = self._clock() + seconds
        options = [arg for setting in _LEFTOVER_OPTIONS for arg in ("-c", setting)]

        def run(arguments: list[str]) -> Outcome:
            remaining = max(1.0, deadline - self._clock())
            return self._access.run(
                [*options, *arguments], timeout=min(self._timeout, remaining), write=True
            )

        added = run(["add", "-A"])
        if added.returncode != 0:
            raise fail(ErrorCode.SETUP_FAILED, "git add failed: " + self._agent_detail(added))
        staged = run(["diff", "--cached", "--quiet"])
        if staged.returncode == 0:
            return None
        if staged.returncode != 1:
            raise fail(ErrorCode.SETUP_FAILED, "git diff failed: " + self._agent_detail(staged))
        if run(["symbolic-ref", "-q", "HEAD"]).returncode == 1:
            leftover = f"{self.spec.branch}-leftover-{uuid.uuid4().hex[:8]}"
            moved = run(["switch", "-q", "-c", leftover])
            if moved.returncode != 0:
                raise fail(
                    ErrorCode.SETUP_FAILED, "git switch failed: " + self._agent_detail(moved)
                )
            self.checked_out = leftover
        committed = run(["commit", "-q", "--no-verify", "-m", message])
        if committed.returncode != 0:
            raise fail(
                ErrorCode.SETUP_FAILED, "the commit failed: " + self._agent_detail(committed)
            )
        head = run(["rev-parse", "HEAD"])
        if head.returncode != 0 or not head.stdout.strip():
            raise fail(
                ErrorCode.SETUP_FAILED, "the new commit cannot be read: " + self._agent_detail(head)
            )
        return head.stdout.strip()

    # -- after the environment's script (in the reader) ---------------------------------------

    def settle_after_setup(self, *, seconds: float = 120.0) -> list[str]:
        """After a successful setup script (#818): the repository is what the agent starts from, and
        what the script did to it is the **base** of the turn, not a change the agent made.

        * **Its history is undone** (`_return_to_start`): the script may have run `git commit`,
          `git checkout -b`, `git tag` or `git reset`, and the turn ends by pushing every local
          branch, so a commit of the script would arrive on GitHub as the agent's work. HEAD goes
          back to the branch the agent starts on, and every branch of the turn (the base branch,
          the session branch and, on a follow-up, each branch of the session) to its start tip
          (`start_tips`); every other branch and every tag is deleted. The files of a commit the
          script made are not lost with the commit (see the next two points: a changed tracked
          file is put back, an added one stays as the script left it). Reflogs and objects stay in
          the repository.
        * A change to a file git **tracks** is undone, in the working tree and the index
          (`git reset --hard`, after `git status` counted them): the turn ends by committing and
          pushing whatever the tree holds and a lockfile an install rewrote or a configuration a
          script patched would arrive on the branch as the agent's work.
        * A file the script **added** (also one it committed: the commit is gone and the file is
          plain again) and git does not ignore is kept in the working tree and put on the
          repository's local ignore list (`.git/info/exclude`, never committed, never pushed): the
          agent sees and uses it, but it is not "a change of the agent", so the tree is not dirty
          because of it (no extra message), the system's commit of what is left does not take it,
          and the agent's own `git add -A` does not either. **A folder goes on the list whole**
          (`node_modules`, a cache, a virtual environment belong there): a file the agent adds
          inside such a folder later is not committed unless it adds it by name with `git add -f`.
          What the repository itself ignores needs nothing.

        Returns the paths of the tracked files that were restored, at most five (the count is
        `restored_count`), cleaned of control characters. Raises `JobError` (`setup_failed`) when
        the repository cannot be read afterwards, or the lists cannot be kept: a script that broke
        it ends the turn, free."""
        deadline = self._clock() + seconds
        names: list[str] = []
        entries = 0
        carry = bytearray()

        def take(chunk: bytes) -> None:
            nonlocal entries
            carry.extend(chunk)
            while (end := carry.find(b"\0")) >= 0:
                entry = bytes(carry[:end])
                del carry[: end + 1]
                if len(entry) > 3:
                    entries += 1
                    if len(names) < 5:
                        names.append(_plain(entry[3:].decode("utf-8", errors="replace")))
            if len(carry) > 65536:
                raise StopReading

        def left() -> float:
            return min(self._timeout, max(1.0, deadline - self._clock()))

        self._return_to_start(left)
        status = self._reader_stream(
            ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=no"],
            take,
            timeout=left(),
        )
        if status.returncode != 0:
            raise fail(ErrorCode.SETUP_FAILED, "the repository cannot be read after the script")
        if entries:
            options = [arg for setting in _LEFTOVER_OPTIONS for arg in ("-c", setting)]
            restored = self._access.run(
                [*options, "reset", "--hard", "-q"], timeout=left(), write=True
            )
            if restored.returncode != 0:
                raise fail(
                    ErrorCode.SETUP_FAILED,
                    "the tracked files could not be put back: " + self._agent_detail(restored),
                )
        head = self._access.run(["rev-parse", "--verify", "HEAD"], timeout=self._timeout)
        if head.returncode != 0 or not head.stdout.strip():
            raise fail(ErrorCode.SETUP_FAILED, "the repository has no HEAD after the script")
        self.restored_count = entries
        self._exclude_what_the_script_added(left)
        return names

    def _return_to_start(self, left: Callable[[], float]) -> None:
        """The history of the script is undone: HEAD on the branch the agent starts on, every branch
        of the turn at its start tip, every other branch and every tag deleted. The index is reset
        to the start (mixed): the working tree is not touched, so what the script committed is now
        a change of the tree like any other (`settle_after_setup` deals with it)."""
        starts = self._starts
        target = self._checkout
        if target is None or target not in starts:
            raise fail(ErrorCode.SETUP_FAILED, "the agent repository is not made yet")
        options = [arg for setting in _LEFTOVER_OPTIONS for arg in ("-c", setting)]

        def git(args: list[str], what: str) -> Outcome:
            done = self._access.run([*options, *args], timeout=left(), write=True)
            if done.returncode != 0:
                raise fail(ErrorCode.SETUP_FAILED, f"{what}: " + self._agent_detail(done))
            return done

        counted = self._access.run(
            ["rev-list", "--count", "--all", "--not", *sorted(set(starts.values()))],
            timeout=left(),
        )
        if counted.returncode != 0 or not counted.stdout.strip().isdigit():
            raise fail(ErrorCode.SETUP_FAILED, "the repository cannot be read after the script")
        self.script_commits = int(counted.stdout.strip())
        git(
            ["symbolic-ref", "HEAD", f"refs/heads/{target}"],
            "the branch the agent starts on cannot be checked out",
        )
        git(
            ["reset", "-q", "--mixed", starts[target]],
            "the repository cannot be put back to its start",
        )
        for name, tip in starts.items():
            if name != target:
                git(["update-ref", f"refs/heads/{name}", tip], "a branch cannot be put back")
        deletions = RefDeletions(
            lambda consume: self._access.stream(
                ["for-each-ref", "--format=%(refname)%00", "refs/heads/", "refs/tags/"],
                consume,
                timeout=left(),
            ),
            set(starts),
        )
        # `update-ref` takes a branch a linked worktree of the script has checked out, `branch -D`
        # does not; the listing is streamed into it, so no length of one name is limited, but the
        # count of the refs and the bytes of their names are (`MAX_REFS`, `MAX_REF_BYTES`).
        try:
            removed = self._access.update_refs(
                [arg for setting in _LEFTOVER_OPTIONS for arg in ("-c", setting)],
                deletions,
                timeout=left(),
            )
        except RefListingFailed as error:
            raise fail(
                ErrorCode.SETUP_FAILED,
                f"the branches and tags the script made cannot be listed ({error})",
            ) from error
        if removed.returncode != 0:
            raise fail(
                ErrorCode.SETUP_FAILED,
                "the branches and tags the script made could not be removed: "
                + self._agent_detail(removed),
            )
        self.dropped_refs = deletions.count

    def _exclude_what_the_script_added(self, left: Callable[[], float]) -> None:
        """Put what the script added, and git does not ignore, on the local ignore list: the
        top-level entries (a folder with its whole content counts as one), anchored, with git's
        special characters escaped. A name with a line end cannot be written as a pattern and stays
        as it is; a tree with more entries than `EXCLUDE_MAX_ENTRIES` or more text than
        `EXCLUDE_MAX_BYTES` ends the turn rather than half of it being kept."""
        listed = bytearray()
        too_long = False

        def take(chunk: bytes) -> None:
            nonlocal too_long
            listed.extend(chunk)
            if len(listed) > EXCLUDE_MAX_BYTES:
                too_long = True
                raise StopReading

        done = self._reader_stream(
            [
                "--no-optional-locks",
                "ls-files",
                "--others",
                "--exclude-standard",
                "--directory",
                "--no-empty-directory",
                "-z",
            ],
            take,
            timeout=left(),
        )
        if too_long or (done.returncode != 0 and not listed):
            raise fail(
                ErrorCode.SETUP_FAILED,
                "the files the script added cannot be listed ("
                + ("there are too many" if too_long else self._agent_detail(done))
                + ")",
            )
        patterns = exclude_patterns(bytes(listed))
        if len(patterns) > EXCLUDE_MAX_ENTRIES:
            raise fail(
                ErrorCode.SETUP_FAILED,
                f"the script left more than {EXCLUDE_MAX_ENTRIES} untracked folders and files in "
                "the repository's top folders",
            )
        self.excluded_count = len(patterns)
        if not patterns:
            return
        written = self._access.append_exclude(b"\n".join(patterns) + b"\n", timeout=left())
        if written.returncode != 0 or written.unanswered:
            raise fail(
                ErrorCode.SETUP_FAILED,
                "what the script added could not be kept out of the commits: "
                + self._agent_detail(written),
            )

    # -- the final push ---------------------------------------------------------------------------

    def push_all(
        self,
        *,
        seconds: float,
        confirm_seconds: float = CONFIRM_SECONDS,
        confirm_pause: float = CONFIRM_PAUSE_SECONDS,
    ) -> PushReport:
        """Push every local branch of the agent's repository, without force, within `seconds`.

        The lease is asked before anything is listed and again right before each `git push`
        (`before_push`); a lease the host cannot confirm is asked again every `confirm_pause` for up
        to `confirm_seconds`, then the turn ends `lease_lost`, as it does at once for a lost or
        superseded lease. A branch that cannot be taken over or that the provider refuses is
        reported as rejected and the others go on. Raises `JobError` only for a lost lease; what was
        done until then is in `push_report()`."""
        deadline = self._clock() + seconds
        self._progress = _Progress()
        if SecretScanner(self._guard_secrets).active:
            self._progress.guard_tank = seconds * GUARD_SHARE
        self._ask_lease(self._work_deadline(deadline), confirm_seconds, confirm_pause)
        self._clear_stale_locks()
        listed = self._local_branches()
        if listed is None:
            self._progress.listed = False
            return self.push_report()
        self._progress.form_listed = any(name == self.spec.branch for name, _ in listed)
        # A branch still at its start tip has nothing on it: it is neither fetched nor reported.
        names = [name for name, tip in listed if not self._unchanged(name, tip)]
        selection = select_branches(names, form_branch=self.spec.branch)
        self._progress.invalid = selection.invalid
        self._progress.overflow = selection.overflow
        for name, reason in selection.excluded:
            self._progress.branches.append(BranchPush(name, None, False, reason))
        if not self._has_room():
            # Nothing is fetched: a fetch with no room fails half way and leaves the mirror full of
            # what it could not finish. Every branch says why it did not arrive.
            for name in selection.names:
                self._progress.branches.append(BranchPush(name, None, False, REASON_OUT_OF_SPACE))
            return self.push_report()
        for index, name in enumerate(selection.names):
            if self._clock() >= self._work_deadline(deadline):
                self._progress.branches.append(BranchPush(name, None, False, REASON_OUT_OF_TIME))
                continue
            last = index == len(selection.names) - 1
            self._push_one(index, name, deadline, confirm_seconds, confirm_pause, last=last)
        return self.push_report()

    def push_report(self) -> PushReport:
        """What the final push has done so far (also after it raised)."""
        progress = self._progress
        return PushReport(
            branches=tuple(progress.branches),
            form_head=progress.form_head,
            listed=progress.listed,
            list_problem=progress.list_problem,
            invalid=progress.invalid,
            overflow=progress.overflow,
            form_listed=progress.form_listed,
        )

    def commits_since_start(self) -> list[CommitInfo]:
        """The commits of the form's branch after the start commit, oldest first, bounded as the
        result is (`history.parse_commits`). Read from the mirror, where the branch was taken over:
        a stream, so a subject of any size costs no memory. Empty when that branch was not taken
        over."""
        ref = self._progress.form_ref
        if ref is None:
            return []
        reader = CappedLines()
        done = self._mirror_stream(
            [
                "log",
                "--no-show-signature",
                "-n",
                str(READ_COMMITS),
                "--format=%H %s",
                f"{self.start_commit}..{ref}",
            ],
            reader.feed,
        )
        return parse_commits(bytes(reader.data)) if done.returncode == 0 else []

    def changed_files(self) -> list[FileChange]:
        """The files that differ between the start commit and the form's branch
        (`git diff --name-status`, read from the mirror), bounded as the result is."""
        ref = self._progress.form_ref
        if ref is None:
            return []
        reader = CappedBytes()
        done = self._mirror_stream(
            [
                "diff",
                "--name-status",
                "-z",
                "-M",
                "--no-ext-diff",
                "--no-textconv",
                self.start_commit,
                ref,
            ],
            reader.feed,
        )
        return parse_name_status(bytes(reader.data)) if done.returncode == 0 else []

    def volume_free_bytes(self) -> int | None:
        """What the VM's disk (the work volume) has left, for the note at the end of the turn; None
        when it cannot be asked."""
        try:
            return self._space(self.layout.work_dir).free_bytes
        except OSError:
            return None

    def reserve_free_bytes(self) -> int:
        """What the mirror's file system has left (the reserve disk in production)."""
        return self._space(self.mirror).free_bytes

    def check_lease(self) -> None:
        """One question to the job host while the agent works: raises `lease_lost` (or whatever the
        gate raises) when the job is no longer ours, so that the turn ends and the model is not paid
        for nothing. An answer that cannot be had is not a no; the next question comes later."""
        if self._before_push is None:
            return
        try:
            self._before_push()
        except LeaseNotConfirmed:
            return

    def _ask_lease(self, deadline: float, confirm_seconds: float, confirm_pause: float) -> None:
        if self._before_push is None:
            return
        end = min(self._clock() + confirm_seconds, deadline)
        while True:
            try:
                self._before_push()
                return
            except LeaseNotConfirmed:
                # The window is counted on the clock: a question can itself take seconds.
                if self._clock() + confirm_pause > end:
                    raise JobError(
                        ErrorCode.LEASE_LOST,
                        "the lease could not be confirmed, so nothing is pushed",
                    ) from None
                self._sleep(confirm_pause)

    def _local_branches(self) -> list[tuple[str, str]] | None:
        """The local branches of the agent's repository as (name, tip as listed), or None when it
        cannot be read (`list_problem` says why). `git for-each-ref` run **in the reader**, so that
        the repository's config is read there and nowhere else, and **streamed and capped** at
        `LIST_MAX_BYTES`: the runner holds no more than that of a list the agent controls, and the
        read is ended when the cap is passed. The names are judged by
        `push_policy`. The listed tip is only a hint that saves a fetch (a branch still at the
        start commit has nothing to push); what is pushed is read from the mirror."""
        data = bytearray()

        def consume(chunk: bytes) -> None:
            data.extend(chunk)
            if len(data) > LIST_MAX_BYTES:
                raise _ListingTooLarge

        try:
            done = self._reader_stream(
                ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads/"],
                consume,
                timeout=min(self._timeout, LIST_TIMEOUT),
            )
        except _ListingTooLarge:
            self._progress.list_problem = LIST_TOO_LARGE
            return None
        if done.returncode != 0:
            self._progress.list_problem = LIST_UNREADABLE
            return None
        branches: list[tuple[str, str]] = []
        # Split on the line feed only: a name that holds another separator stays one name, which
        # `push_policy` then refuses.
        for line in data.decode("utf-8", errors="surrogateescape").split("\n"):
            tip, _, ref = line.partition(" ")
            if ref.startswith("refs/heads/"):
                branches.append((ref.removeprefix("refs/heads/"), tip))
        return branches

    def quiet_readers(self, *, seconds: float) -> bool:
        """Kill what runs in the readers and start them again. Runs once the agent's container is
        gone and again after the leftover commit: a filter of the agent's repository can leave a
        process behind (`setsid`), and in a reader with the repository read-write it could change
        the repository under the commit or the fetch of the push."""
        return self._access.reset(seconds=seconds)

    def rescue_detached_head(self) -> str | None:
        """Work committed on a detached HEAD is on no branch, so the final push would not see it.
        When HEAD is detached and no local branch contains it, a branch
        `<task branch>-leftover-<id>` is made at HEAD and checked out, and its name is returned;
        otherwise None. Runs in the reader; a failure is raised (`setup_failed`) for the
        caller to note."""
        attached = self._reader(["symbolic-ref", "-q", "HEAD"], timeout=RESCUE_STEP_TIMEOUT)
        if attached.returncode == 0:
            self._remember_checked_out(attached.stdout)
        if attached.returncode != 1:
            return None
        containing = self._reader(
            [
                "for-each-ref",
                "--count=1",
                "--contains",
                "HEAD",
                "--format=%(refname)",
                "refs/heads/",
            ],
            timeout=RESCUE_STEP_TIMEOUT,
        )
        if containing.returncode != 0:
            raise fail(
                ErrorCode.SETUP_FAILED, "git for-each-ref failed: " + self._agent_detail(containing)
            )
        if containing.stdout.strip():
            return None
        name = f"{self.spec.branch}-leftover-{uuid.uuid4().hex[:8]}"
        moved = self._reader(["switch", "-q", "-c", name], timeout=RESCUE_STEP_TIMEOUT, write=True)
        if moved.returncode != 0:
            raise fail(ErrorCode.SETUP_FAILED, "git switch failed: " + self._agent_detail(moved))
        self.checked_out = name
        return name

    def _remember_checked_out(self, ref: str) -> None:
        """The branch a `symbolic-ref HEAD` answered, when it is a name the runner would push (the
        name is the agent's: anything else is left unknown, never shown). Only the line feed of the
        answer is cut: `strip()` would take a no-break space off a name, and a HEAD on a tag is
        no branch."""
        ref = ref.removesuffix("\n")
        if not ref.startswith("refs/heads/"):
            self.checked_out = None
            return
        name = ref.removeprefix("refs/heads/")
        self.checked_out = None if branch_name_problem(name) is not None else name

    def _work_deadline(self, deadline: float) -> float:
        """Where the fetch, the question to the lease and the push stop: before the seconds that are
        still kept for the guard."""
        return deadline - self._progress.guard_tank

    def _push_one(
        self,
        index: int,
        name: str,
        deadline: float,
        confirm_seconds: float,
        confirm_pause: float,
        *,
        last: bool,
    ) -> None:
        scratch = f"{SCRATCH_PREFIX}{index}"
        tip, problem = self._take_over(name, scratch, self._work_deadline(deadline))
        if problem is not None or tip is None:
            self._record(name, tip, problem or REASON_UNREADABLE)
            return
        if self._unchanged(name, tip):
            # Nothing new on it: a branch as the agent found it, or a branch it made and never
            # committed to. Nothing to push.
            return
        if name == self.spec.branch:
            self._progress.form_head = tip
            self._progress.form_ref = scratch
        held = self._login_secret_in(scratch, name, deadline)
        if held is not None:
            self._record(name, tip, held)
            return
        # What the guard left of its slice goes to the push when no branch comes after this one.
        pushing = deadline if last else self._work_deadline(deadline)
        self._ask_lease(pushing, confirm_seconds, confirm_pause)
        reason = self._push(scratch, name, pushing)
        self._record(name, tip, reason)

    def _login_secret_in(self, scratch: str, name: str, deadline: float) -> str | None:
        """The push guard (#856, `push_guard.py`): None when nothing the branch adds holds the
        device's login, `REASON_LOGIN_SECRET` when something does, `REASON_UNCHECKED` when it could
        not be read to its end (a branch is never let through on a guess). What is read is what the
        branch has on top of where the turn started: its commits, trees (the names), blobs, and the
        name of the branch itself. The objects are in the mirror already."""
        scanner = SecretScanner(self._guard_secrets)
        if not scanner.active:
            return None
        if scanner.holds(name):
            return REASON_LOGIN_SECRET
        began = self._clock()
        # The guard reads within its slice; with the slice used up by earlier branches it reads
        # within what the push has left (it never reads past the deadline).
        slice_ = self._progress.guard_tank
        ends = min(deadline, began + slice_) if slice_ > 0 else deadline
        try:
            return self._read_for_login(scanner, scratch, ends)
        finally:
            self._progress.guard_tank = max(slice_ - (self._clock() - began), 0.0)

    def _read_for_login(self, scanner: SecretScanner, scratch: str, deadline: float) -> str | None:
        """The two reads of the guard, each within what is left until `deadline`."""
        starts = sorted(set(self._starts.values()))
        listing = bytearray()

        def list_objects(chunk: bytes) -> None:
            if scanner.feed(chunk):
                raise _LoginFound
            listing.extend(chunk)
            if len(listing) > GUARD_LISTING_MAX_BYTES:
                raise _GuardOverrun

        try:
            listed = self._mirror_stream(
                ["rev-list", "--objects", scratch, "--not", *starts],
                list_objects,
                timeout=self._left(GUARD_SECONDS, deadline),
            )
        except _LoginFound:
            return REASON_LOGIN_SECRET
        except _GuardOverrun:
            return REASON_UNCHECKED
        if listed.returncode != 0 or listed.unanswered:
            return REASON_UNCHECKED
        wanted = b"".join(
            line[:40] + b"\n" for line in bytes(listing).split(b"\n") if len(line) >= 40
        )
        scanner.reset()
        read = 0

        def read_objects(chunk: bytes) -> None:
            nonlocal read
            read += len(chunk)
            if scanner.feed(chunk):
                raise _LoginFound
            if read > GUARD_READ_MAX_BYTES:
                raise _GuardOverrun

        try:
            done = self._mirror_stream(
                ["cat-file", "--batch"],
                read_objects,
                timeout=self._left(GUARD_SECONDS, deadline),
                stdin=wanted,
            )
        except _LoginFound:
            return REASON_LOGIN_SECRET
        except _GuardOverrun:
            return REASON_UNCHECKED
        return REASON_UNCHECKED if done.returncode != 0 or done.unanswered else None

    def _unchanged(self, name: str, tip: str) -> bool:
        """Whether a local branch is where the turn started it. A branch with a start tip of its own
        (the base branch, the session branch, a branch of the session) is judged by that one; a
        branch the agent made is unchanged while it is still at any start tip, that is, while it
        holds no commit of its own."""
        start = self._starts.get(name)
        if start is not None:
            return tip == start
        return tip in self._starts.values()

    def _record(self, name: str, tip: str | None, reason: str | None) -> None:
        self._progress.branches.append(BranchPush(name, tip, reason is None, reason))

    def _take_over(self, name: str, scratch: str, deadline: float) -> tuple[str | None, str | None]:
        """Fetch the agent's branch into the scratch ref and return its tip (a commit that git
        accepted with its objects checked) or the reason it cannot be pushed. The decision is made
        from exit statuses and from the objects in the mirror, never from what git printed."""
        fetched = self._mirror(
            [
                "-c",
                "fetch.fsckObjects=true",
                "-c",
                "transfer.fsckObjects=true",
                # Protocol 2 asks the agent's upload-pack for the one ref only (`ref-prefix`): the
                # advertisement the runner reads does not grow with the refs the agent made.
                "-c",
                "protocol.version=2",
                "fetch",
                *_PLAIN_FETCH,
                f"--upload-pack={self._access.upload_pack()}",
                self._access.repo_source,
                f"+refs/heads/{name}:{scratch}",
            ],
            timeout=self._left(FETCH_TIMEOUT, deadline),
        )
        if fetched.returncode != 0:
            if not self._has_room():
                return None, REASON_OUT_OF_SPACE
            return None, REASON_TIMED_OUT if fetched.unanswered else REASON_UNREADABLE
        raw_id = self._mirror(["rev-parse", "-q", "--verify", scratch])
        commit = self._mirror(["rev-parse", "-q", "--verify", f"{scratch}^{{commit}}"])
        found = raw_id.stdout.strip()
        if raw_id.returncode != 0 or not _SHA.fullmatch(found):
            return None, REASON_UNREADABLE
        if commit.returncode != 0 or commit.stdout.strip() != found:
            return None, REASON_NOT_A_COMMIT
        return found, None

    def _push(self, scratch: str, name: str, deadline: float) -> str | None:
        """One `git push` of one refspec, no force; the reason it failed, or None. A hiccup of the
        provider is tried once more."""
        reason = self._push_once(scratch, name, deadline)
        if (
            reason != REASON_PROVIDER_UNAVAILABLE
            or self._clock() + TRANSIENT_PAUSE_SECONDS >= deadline
        ):
            return reason
        self._sleep(TRANSIENT_PAUSE_SECONDS)
        return self._push_once(scratch, name, deadline)

    def _push_once(self, scratch: str, name: str, deadline: float) -> str | None:
        pushed = self._mirror(
            ["push", "--porcelain", self.spec.clone_url, f"{scratch}:refs/heads/{name}"],
            protocols=":".join(self._schemes),
            token=True,
            timeout=self._left(PUSH_TIMEOUT, deadline),
        )
        if pushed.returncode == 0:
            return None
        if pushed.unanswered:
            return REASON_TIMED_OUT
        refused = [line for line in pushed.stdout.splitlines() if line.startswith("!")]
        detail = self._detail(pushed)
        if refused:
            if all(_HICCUP.search(line) for line in refused):
                return REASON_PROVIDER_UNAVAILABLE
            remote = [_REMOTE_REJECTED.search(line) for line in refused]
            if any(found is not None for found in remote):
                if any(found and found["reason"].startswith(_WORKFLOW_REASON) for found in remote):
                    return REASON_WORKFLOWS
                # A server that shows its reason on `remote:` lines (a hook) says it at the start of
                # the line; a line that only mentions the branch does not count.
                if any(
                    line.startswith("remote: " + _WORKFLOW_REASON)
                    for line in pushed.stderr.splitlines()
                ):
                    return REASON_WORKFLOWS
                return REASON_REMOTE_REJECTED
            # Git's own `[rejected]` (non-fast-forward, fetch first, already exists) says the branch
            # has other history. Anything else says nothing of the kind.
            if any("[rejected]" in line for line in refused):
                return REASON_NOT_FAST_FORWARD
            return REASON_REMOTE_REJECTED
        if _is_access_refusal(detail):
            return REASON_PROVIDER_REFUSED
        if _is_client_error(detail):
            return REASON_PROVIDER_ERROR
        return REASON_PROVIDER_UNAVAILABLE

    def _has_room(self) -> bool:
        """Whether the mirror's file system has the room the final push needs. A file system that
        cannot be asked is not a reason to refuse: the fetch will say if it fails."""
        try:
            space = self._space(self.mirror)
        except OSError:
            return True
        return space.free_bytes >= MIN_FREE_BYTES and space.free_inodes >= MIN_FREE_INODES

    def _left(self, cap: float, deadline: float) -> float:
        return max(1.0, min(cap, self._timeout, deadline - self._clock()))

    # -- internals ------------------------------------------------------------------------

    def _check_names(self) -> None:
        """The branch names are used in refspecs: git itself says whether they are fine."""
        if self._names_checked:
            return
        base, branch = self.spec.base_branch, self.spec.branch
        if branch == base or branch == "HEAD" or branch.startswith("-") or base.startswith("-"):
            raise _invalid("the branch must be a new name that git accepts")
        for name in (base, branch):
            done = self._root(["check-ref-format", f"refs/heads/{name}"], protocols="file")
            if done.returncode != 0:
                raise _invalid("a branch name is not one git accepts")
        for entry in () if self.spec.resume is None else self.spec.resume.branches:
            self._check_session_name(entry.name)
        if self.spec.resume is not None and self.spec.resume.checkout is not None:
            self._check_session_name(self.spec.resume.checkout)
        self._check_no_ref_collision()
        self._names_checked = True

    def _check_no_ref_collision(self) -> None:
        """No branch may be a directory of another (`a` and `a/b` cannot both be refs): the session
        branch is made at the base tip when the provider never had it, and with `a/b` of the session
        beside it that fails in the agent's repository. The turn ends here, before anything is
        fetched, with the stable reason of a branch name git cannot take."""
        names = {self.spec.base_branch, self.spec.branch}
        if self.spec.resume is not None:
            names.update(entry.name for entry in self.spec.resume.branches)
        if any(other.startswith(name + "/") for name in names for other in names):
            raise _invalid("a branch of the session is the directory of another")

    def _check_session_name(self, name: str) -> None:
        """A name of a branch of the session is used in refspecs and ref names as the others are."""
        # A control character (a NUL above all) is refused before a name reaches a command line or
        # the standard input of `update-ref -z`.
        if name == "HEAD" or name.startswith("-") or _CONTROL_CHARS.search(name):
            raise _invalid("a branch name of the session is not one git accepts")
        done = self._root(["check-ref-format", f"refs/heads/{name}"], protocols="file")
        if done.returncode != 0:
            raise _invalid("a branch name of the session is not one git accepts")

    def _prepare_directories(self) -> None:
        for directory in (self.layout.work_dir, self.layout.run_dir, self.reserve):
            _own_directory(directory)
        for existing in (self.mirror, self.repo):
            if existing.exists() or existing.is_symlink():
                raise fail(
                    ErrorCode.SETUP_FAILED, f"{existing.name} exists already in the work directory"
                )

    def _clear_stale_locks(self) -> None:
        """Remove the `.lock` files in the mirror. Only the runner writes the mirror, and no git in
        it starts a background `gc --auto` or maintenance (`_mirror` switches both off), so a lock
        found here belongs to a git that was killed (a timeout) and would refuse every later
        fetch."""
        for directory, _, files in os.walk(self.mirror, followlinks=False):
            for name in files:
                if name.endswith(".lock"):
                    Path(directory, name).unlink(missing_ok=True)

    def _root(
        self,
        args: list[str],
        *,
        protocols: str,
        token: bool = False,
        timeout: float | None = None,
    ) -> Outcome:
        """Git as the runner, never with the agent's repository as its directory."""
        environment = self._process.base_environment(protocols)
        if token:
            environment.update(token_environment(self.spec.token))
        return self._process.run(args, env=environment, timeout=timeout or self._timeout)

    def _mirror(
        self,
        args: list[str],
        *,
        protocols: str = "file",
        token: bool = False,
        timeout: float | None = None,
    ) -> Outcome:
        """Git as the runner on the mirror, with no automatic gc or maintenance."""
        return self._root(
            ["--git-dir", str(self.mirror), *_MIRROR_OPTIONS, *args],
            protocols=protocols,
            token=token,
            timeout=timeout,
        )

    def _mirror_stream(
        self,
        args: list[str],
        consume: Callable[[bytes], None],
        *,
        timeout: float | None = None,
        stdin: bytes | None = None,
    ) -> Outcome:
        """`_mirror` for output that is read as a stream and not kept (see `GitProcess.stream`)."""
        return self._process.stream(
            ["--git-dir", str(self.mirror), *_MIRROR_OPTIONS, *args],
            env=self._process.base_environment("file"),
            consume=consume,
            timeout=min(self._timeout, timeout or REPORT_READ_TIMEOUT),
            stdin=stdin,
        )

    def _reader(
        self, args: Sequence[str], *, timeout: float | None = None, write: bool = False
    ) -> Outcome:
        """A git command in the agent's repository, run in a reader (never here); `write` for a
        command that changes it."""
        return self._access.run(args, timeout=timeout or self._timeout, write=write)

    def _reader_stream(
        self, args: Sequence[str], consume: Callable[[bytes], None], *, timeout: float | None = None
    ) -> Outcome:
        """`_reader` for output that is read as a stream and only partly kept. A reader that has
        what it keeps (`StopReading`) ends the read, and the command counts as answered."""
        try:
            return self._access.stream(args, consume, timeout=timeout or self._timeout)
        except StopReading:
            return Outcome(0, "", "")

    def _detail(self, outcome: Outcome) -> str:
        """Git's output on the runner's own data (the mirror, the provider)."""
        return self._process.detail(outcome.stderr or outcome.stdout)

    def _agent_detail(self, outcome: Outcome) -> str:
        """The result of a git command on the agent's repository: what the agent can make git print
        does not travel (`fatal: unexpected line in ./packed-refs: <that line>`), only the
        status."""
        return f"status {outcome.returncode}"


# What `settle_after_setup` keeps of the untracked entries a script left: 10,000 of them and 1 MiB
# of their names.
EXCLUDE_MAX_ENTRIES = 10_000
EXCLUDE_MAX_BYTES = 1024 * 1024
_PATTERN_SPECIALS = re.compile(rb"([\\*?\[\]])")


def exclude_patterns(listing: bytes) -> list[bytes]:
    """`git ls-files --others --directory -z` as lines of an ignore file: each name anchored at the
    top (`/name`), the characters git reads in a pattern escaped, a leading `#` or `!` and a
    trailing space protected. A name with a line end has no such line and is left out."""
    patterns: list[bytes] = []
    for name in listing.split(b"\0"):
        if not name or b"\n" in name:
            continue
        escaped = _PATTERN_SPECIALS.sub(rb"\\\1", name)
        if escaped.endswith(b" "):
            escaped = escaped[:-1] + b"\\ "
        patterns.append(b"/" + escaped)
    return patterns


def _plain(text: str) -> str:
    """A path of the agent's repository as a log may carry it: no control character, at most 200."""
    return _CONTROL_CHARS.sub("?", text)[:200]


def _own_directory(path: Path) -> None:
    """Make sure a directory the runner's files and the agent's tree live in is the runner's. A new
    one is created. An existing one is opened without following a link and judged from that
    descriptor (no gap between the look and the chmod): a plain directory of the runner's user
    that no one else can write. Only then is it made enterable for the agent."""
    path.parent.mkdir(parents=True, exist_ok=True)
    created = True
    try:
        os.mkdir(path, 0o755)
    except FileExistsError:
        created = False
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError:
        raise fail(
            ErrorCode.SETUP_FAILED, f"{path.name} is not a plain directory (a link or a file)"
        ) from None
    try:
        status = os.fstat(descriptor)
        if not created and status.st_uid != os.geteuid():
            raise fail(ErrorCode.SETUP_FAILED, f"{path.name} does not belong to the runner")
        if not created and status.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
            raise fail(ErrorCode.SETUP_FAILED, f"{path.name} can be written by others")
        os.fchmod(descriptor, 0o755)
    finally:
        os.close(descriptor)
