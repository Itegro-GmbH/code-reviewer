# SPDX-License-Identifier: LicenseRef-Proprietary

"""The git side of an Implementer turn (#762): the safety core of the slice.

What the system does, and what the agent can and cannot:

* The runner (root) clones the base branch, `--depth 1`, into a bare **mirror** only it can enter
  (`/work/mirror.git`). The provider token is in the environment of that one git process and nowhere
  else: not in argv, a config file, a URL, the mirror or anything the agent's user can read.
* The agent works in `/work/repo`, a local clone of the mirror owned by the agent's user. It has no
  remote, no credential, the system identity and a new branch at the base tip.
* A `reference-transaction` hook (installed by the image, #761) keeps the agent on its branch and
  appends every tip update to a spool. It is an accident guard: `git -c core.hooksPath=/dev/null` or
  a hand-written ref gets around it.
* **The guarantee is the push.** From the mirror, as root: fetch the agent's branch into a scratch
  ref, check that the tip is a commit that contains the start commit, descends from what was
  verified before and was committed by the system identity, move the mirror's branch to it only then
  (compare-and-swap) and push without force. A rewrite below what was already pushed ends the turn
  `branch_violation` and the provider keeps the last good tip. Every decision is made from the exit
  status of git and from the objects in the mirror, never from what git printed: the agent decides
  what its side of a fetch prints.
* Root never runs git with the agent's repository as working directory or git directory (it would
  run the `core.fsmonitor`, hooks and aliases the agent can write). `git status` and the leftover
  commit run as the agent's user (through the hook directory of the image, whatever the agent set
  as `core.hooksPath`). The mirror reads the agent's branch through `git upload-pack` that is
  itself run as the agent's user, so the config of the agent's repository is read by the agent's own
  rights and by nothing else.
* A turn whose repository cannot be committed or verified after the agent ran ends with
  `RepositoryUnusable` (wire code `branch_violation`, which the billing table classes as charged):
  the model was used, and what is left is the agent's doing or unknowable.
"""

import os
import re
import shlex
import shutil
import stat
import subprocess
import threading
import time
from collections.abc import Callable, Collection
from dataclasses import dataclass
from enum import Enum, auto
from pathlib import Path
from typing import NoReturn
from urllib.parse import urlsplit

from ..job import JobError
from ..result import ErrorCode
from .commit_headers import CommitHeaderReader, HeaderTooLarge
from .git_process import (
    DEFAULT_TIMEOUT,
    MIN_GIT_VERSION,
    TRUSTED_PATH,
    GitProcess,
    Outcome,
    fail,
    parse_git_version,
    spawn_options,
    token_environment,
)
from .guard_files import (
    CONFIG_MODE,
    SPOOL_MODE,
    SpoolWatcher,
    guard_conf_text,
    system_gitconfig_text,
    write_file,
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

LEFTOVER_MESSAGE = "Implementer: uncommitted changes of the turn"
# The files of a repository that the pinned engine loads from its working directory whatever the
# flags say (#764): its v2 configuration service reads `.opencode/` (plugins, tools, commands,
# agents, `opencode.json`) and `opencode.json(c)` at the root of the project unconditionally, and
# `OPENCODE_DISABLE_PROJECT_CONFIG` only guards the older service. Nothing executable or
# configurable may come from the repository (owner rule), so the agent's working tree is a sparse
# checkout without them: they stay in every commit and are never on disk.
ENGINE_INPUTS = (".opencode", "opencode.json", "opencode.jsonc")
# Pathspecs that leave exactly those names out of a command of the leftover handling: git refuses to
# add a path outside the sparse definition (exit 1), and a change of a tracked one is invisible to
# it. They are not the agent's to change in this run, so they never count as a change and never
# block the commit of the rest.
_NOT_THE_AGENTS = tuple(f":(exclude,top){name}" for name in ENGINE_INPUTS)
# The most often a batch of commits is pushed while the agent works (the final push is not held
# back).
PUSH_INTERVAL_SECONDS = 120.0
SELF_TEST_TIMEOUT = 180.0
# Reading the agent's tip happens every tick: a repository the agent made unreadable (a FIFO as
# `.git/HEAD`) must cost seconds, not the 600 s of a push.
TIP_TIMEOUT = 20.0
# A ref only the runner uses: the agent's branch is fetched here first and moves to the branch of
# the mirror only after every check passed.
SCRATCH_REF = "refs/runner/incoming"
ZERO_ID = "0" * 40
# The mirror is the runner's alone and is written under `GitWorkspace._lock`: no git in it may start
# a `gc --auto` or `maintenance run --auto` that outlives it (they detach into the background, and
# survive the group kill of a timeout).
_MIRROR_OPTIONS = ("-c", "gc.auto=0", "-c", "maintenance.auto=false")
_PLAIN_FETCH = ("--no-tags", "--no-write-fetch-head")
# The hook directory is the image's: `-c` beats the `core.hooksPath` of the agent's repository
# (which beats the system config).
_LEFTOVER_COMMIT_OPTIONS = ("commit.gpgsign=false",)
# After a look at the agent's branch failed for a reason that is not the agent's, the loop waits
# this long before the next look, doubling to the ceiling.
RETRY_BACKOFF_SECONDS = 10.0
MAX_BACKOFF_SECONDS = PUSH_INTERVAL_SECONDS
# An answer of the provider that is a no and not a hiccup: a client error other than "request
# timeout" and "too many requests" (credentials, permission, a missing repository, a validation).
_HTTP_ERROR = re.compile(r"returned error: (\d{3})")
_RETRYABLE_CLIENT_ERRORS = frozenset({408, 425, 429})
# git asks for credentials after a 401 and, with prompts off, reports that instead of the status.
# Only the words of git about the remote's answer: a local "Permission denied" (a lock, the
# mirror's own files) is not the provider refusing anything, and is not matched.
_CREDENTIALS_REFUSED = re.compile(r"could not read (?:Username|Password)|Authentication failed")
# A `! [remote rejected] (reason)` line of the porcelain whose reason says the provider itself
# failed (GitHub's "internal error" and "failed to update ref"): a hiccup, not a no.
_HICCUP = re.compile(r"\[remote rejected\]\s*\((?:internal error|failed to update ref)\)", re.I)
_COMMIT_HEADER = re.compile(r"commit [0-9a-f]{40}")
_COMMITTER = re.compile(r"committer (?P<name>[^<>\n]*) <(?P<email>[^<>\n]*)> \d+ [+-]\d{4}")


@dataclass(frozen=True)
class AgentUser:
    """The unprivileged user the agent and its git processes run as (the engine user)."""

    uid: int
    gid: int


@dataclass(frozen=True)
class GitIdentity:
    """Who the agent's commits are by: `<product> Implementer`."""

    name: str
    email: str


@dataclass(frozen=True)
class WorkspaceSpec:
    """What a job names: the repository, the token that may write it and the two branches."""

    clone_url: str
    token: str
    base_branch: str
    branch: str


@dataclass(frozen=True)
class WorkspaceLayout:
    """Where things are. `work_dir` is the work volume, `run_dir` is under /run (the guard's
    configuration and spool), `guard_dir` holds the hook and the matrix (the image), `agent_home` is
    the agent's own home."""

    agent_home: Path
    work_dir: Path = Path("/work")
    run_dir: Path = Path("/run/code-reviewer")
    guard_dir: Path = Path("/opt/code-reviewer/guard")


class PushUnverified(JobError):
    """The agent's branch could not be looked at this time (git timed out, a lock, an unreadable
    repository). Nothing is known against the agent: `PushLoop.tick` looks again after a back-off.
    The final push turns it into `RepositoryUnusable`."""

    def __init__(self, detail: str) -> None:
        super().__init__(ErrorCode.RUNNER_ERROR, detail)


class PushTransient(PushUnverified):
    """The provider did not take the push and said nothing that is a refusal (a 5xx, a reset, a
    timeout, no route). Nothing is known against the agent or the branch: the loop tries again
    after its back-off, and the final push still runs once. Only the final push turns it into
    `push_rejected` (`PushLoop.finish`)."""


class RepositoryUnusable(JobError):
    """The agent ran, and its repository could then not be committed or verified: the leftover
    commit failed, the status cannot be read, or the last look at its branch failed. The model
    budget is spent by then, so this is not a free class: the code is `branch_violation`, which the
    class table of the app (`ERROR_CODE_CLASSES`) has as charged. Callers that build the turn's
    result (#754, #765) branch on this exception and report that code. The detail is built from
    fixed texts only; nothing the agent made git print is in it."""

    def __init__(self, detail: str) -> None:
        super().__init__(
            ErrorCode.BRANCH_VIOLATION,
            "the repository could not be committed or verified after the agent ran: " + detail,
        )


class _AgentRef(Enum):
    PRESENT = auto()
    GONE = auto()
    UNREADABLE = auto()


class PushOutcome(Enum):
    PUSHED = "pushed"
    UP_TO_DATE = "up_to_date"
    NOTHING_TO_PUSH = "nothing_to_push"


@dataclass(frozen=True)
class PushResult:
    outcome: PushOutcome
    # The tip the provider has after this call (None: nothing was ever pushed).
    head: str | None


def _is_http_refusal(detail: str) -> bool:
    """Whether git's report of a failed push to the provider names an HTTP client error that is not
    worth retrying. The text is the provider's side of the push on the runner's own mirror."""
    if _CREDENTIALS_REFUSED.search(detail):
        return True
    found = _HTTP_ERROR.search(detail)
    if found is None:
        return False
    status = int(found.group(1))
    return 400 <= status < 500 and status not in _RETRYABLE_CLIENT_ERRORS


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


class GitWorkspace:
    """One turn's repository, guard and mirror. See the module text for the rules."""

    def __init__(
        self,
        spec: WorkspaceSpec,
        layout: WorkspaceLayout,
        agent: AgentUser,
        identity: GitIdentity,
        *,
        git: str = "git",
        path: str = TRUSTED_PATH,
        schemes: Collection[str] = ("https",),
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        if agent.uid == 0 or agent.gid == 0:
            raise _invalid("the agent must not run as root")
        _checked_url(spec.clone_url, schemes)
        executable = shutil.which(git, path=path)
        if executable is None:
            raise fail(ErrorCode.SETUP_FAILED, "git is not installed")
        self.spec = spec
        self.layout = layout
        self.agent = agent
        self.identity = identity
        self.git = executable
        self._schemes = tuple(sorted(schemes))
        self._timeout = timeout
        self._path = ":".join(dict.fromkeys([str(Path(executable).parent), *path.split(":")]))
        self._process = GitProcess(executable, self._path, layout.run_dir, spec.token)
        self.mirror = layout.work_dir / "mirror.git"
        self.repo = layout.work_dir / "repo"
        self.spool_path = layout.run_dir / "spool"
        self.guard_conf_path = layout.run_dir / "guard.conf"
        self.system_config_path = layout.run_dir / "system.gitconfig"
        self._spool = SpoolWatcher(self.spool_path)
        self._start: str | None = None
        self._pushed: str | None = None
        self._poisoned = False
        self._names_checked = False
        # One look at the agent's branch and one push at a time (the loop's tick races the final
        # push); the mirror is only ever written under it.
        self._lock = threading.RLock()
        # How many times the agent's branch was fetched and checked (a test counts them).
        self.verifications = 0

    # -- what the caller needs -------------------------------------------------------------------

    @property
    def start_commit(self) -> str:
        if self._start is None:
            raise fail(ErrorCode.SETUP_FAILED, "the base branch is not cloned yet")
        return self._start

    @property
    def pushed_tip(self) -> str | None:
        """The tip the provider has (None until the first push)."""
        return self._pushed

    def agent_environment(self) -> dict[str, str]:
        """The environment of every process of the agent: the guard on, the identity set and no
        credential of any kind. The agent's engine and its tools get this one."""
        home = str(self.layout.agent_home)
        return {
            "PATH": self._path,
            "HOME": home,
            "GIT_CONFIG_SYSTEM": str(self.system_config_path),
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_TERMINAL_PROMPT": "0",
            "CODE_REVIEWER_GUARD_CONF": str(self.guard_conf_path),
            "GIT_AUTHOR_NAME": self.identity.name,
            "GIT_AUTHOR_EMAIL": self.identity.email,
            "GIT_COMMITTER_NAME": self.identity.name,
            "GIT_COMMITTER_EMAIL": self.identity.email,
        }

    # -- the steps of a turn's set-up ------------------------------------------------------------

    def prepare(self, *, self_test: bool = True) -> None:
        """Everything before the agent starts: the self-test, the mirror, the agent's repository and
        the guard. Raises `JobError` with a stable code; nothing is left half done that a retry
        would trip over (the work volume is a new one per turn)."""
        self._check_names()
        if self_test:
            self.self_test()
        self.clone_mirror()
        self.create_agent_repository()
        self.install_guard()

    def self_test(self) -> None:
        """Prove the guard before the agent runs: git is new enough and the matrix of about thirty
        actions behaves as the agent's user. Any failure is `setup_failed`; a turn never runs
        unguarded."""
        version = parse_git_version(
            self._process.run(["--version"], env=self._process.base_environment("file")).stdout
        )
        if version is None:
            raise fail(ErrorCode.SETUP_FAILED, "the version of git cannot be read")
        if version < MIN_GIT_VERSION:
            wanted = ".".join(map(str, MIN_GIT_VERSION))
            raise fail(
                ErrorCode.SETUP_FAILED,
                f"git {'.'.join(map(str, version))} is older than {wanted}: the branch guard "
                "cannot see a switch of branch on it",
            )
        for name in ("reference-transaction", "guard_matrix.sh"):
            if not os.access(self.layout.guard_dir / name, os.X_OK):
                raise fail(ErrorCode.SETUP_FAILED, f"the guard file {name} is missing")
        if self._drops_privileges() and self._setpriv() is None:
            raise fail(ErrorCode.SETUP_FAILED, "setpriv is not installed")
        environment = {
            "PATH": self._path,
            "HOME": str(self.layout.agent_home),
            "TMPDIR": str(self.layout.agent_home),
            "GUARD_DIR": str(self.layout.guard_dir),
        }
        try:
            done = subprocess.run(
                [str(self.layout.guard_dir / "guard_matrix.sh")],
                cwd=self.layout.agent_home,
                env=environment,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                errors="replace",
                timeout=SELF_TEST_TIMEOUT,
                check=False,
                **spawn_options(self.agent.uid, self.agent.gid),
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise fail(
                ErrorCode.SETUP_FAILED, f"the guard matrix cannot run: {type(error).__name__}"
            ) from None
        if done.returncode != 0:
            lines = [
                line
                for line in (done.stdout + done.stderr).splitlines()
                if line.startswith(("FAIL", "guard_matrix:"))
            ] or (done.stdout + done.stderr).splitlines()[-5:]
            raise fail(
                ErrorCode.SETUP_FAILED,
                f"the guard matrix failed (status {done.returncode}): "
                + self._process.detail("\n".join(lines)),
            )

    def clone_mirror(self) -> None:
        """Fetch the base branch, depth 1, into the new bare mirror. The token is in this one
        process's environment."""
        self._check_names()
        self._prepare_directories()
        mirror = self.mirror
        mirror.mkdir(mode=0o700)
        os.chmod(mirror, 0o700)
        base = self.spec.base_branch
        init = self._root(
            ["init", "-q", "--bare", f"--initial-branch={base}", str(mirror)], protocols="file"
        )
        if init.returncode != 0:
            raise fail(
                ErrorCode.SETUP_FAILED, "the mirror cannot be created: " + self._detail(init)
            )
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
        tip = self._mirror(["rev-parse", "--verify", f"refs/heads/{base}^{{commit}}"])
        if tip.returncode != 0:
            raise fail(ErrorCode.CLONE_FAILED, "the cloned base branch has no commit")
        self._start = tip.stdout.strip()

    def create_agent_repository(self) -> None:
        """The agent's repository: a local clone of the mirror (no hard links, so nothing is shared
        with it), handed to the agent's user, without a remote, with the identity and the new branch
        at the base tip. The same path every turn."""
        start = self.start_commit
        base = self.spec.base_branch
        cloned = self._root(
            [
                "-c",
                "core.hooksPath=/dev/null",
                "clone",
                "-q",
                "--no-tags",
                "--single-branch",
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
        _hand_over(self.repo, self.agent)
        setup = (
            ["remote", "remove", "origin"],
            ["config", "user.name", self.identity.name],
            ["config", "user.email", self.identity.email],
            ["config", "commit.gpgsign", "false"],
            # What the engine would load from the working tree stays out (see `ENGINE_INPUTS`).
            ["sparse-checkout", "set", "--no-cone", "/*", *(f"!/{name}" for name in ENGINE_INPUTS)],
            ["checkout", "-q", "-b", self.spec.branch],
        )
        environment = {**self.agent_environment(), "GIT_CONFIG_SYSTEM": "/dev/null"}
        for arguments in setup:
            done = self._as_agent(arguments, env=environment)
            if done.returncode != 0:
                raise fail(
                    ErrorCode.SETUP_FAILED,
                    f"git {arguments[0]} failed in the agent repository: "
                    + self._agent_detail(done),
                )
        head = self._as_agent(["rev-parse", "HEAD"], env=environment)
        if head.stdout.strip() != start:
            raise fail(ErrorCode.SETUP_FAILED, "the agent repository is not at the base tip")

    def install_guard(self) -> None:
        """Switch the guard on: the hook's configuration (branch, start commit, spool), the system
        git config of the agent's git and the spool. Written by root, readable by the agent."""
        _own_directory(self.layout.run_dir)
        write_file(
            self.guard_conf_path,
            guard_conf_text(
                branch=self.spec.branch,
                start=self.start_commit,
                spool=str(self.spool_path),
                repo=str(self.repo),
            ),
            CONFIG_MODE,
        )
        write_file(
            self.system_config_path,
            system_gitconfig_text(self.layout.guard_dir, [self.repo]),
            CONFIG_MODE,
        )
        write_file(self.spool_path, "", SPOOL_MODE)

    # -- the leftover API (as the agent's user) ---------------------------------------------------

    def dirty(self) -> bool:
        """Whether the working tree has changes, untracked files included. Runs as the agent. Only
        the first byte of what `git status` prints is looked at: the output is the agent's (a tree
        with a million untracked files prints megabytes) and the answer is whether it has any."""
        seen: list[bool] = []

        def first(chunk: bytes) -> None:
            if chunk:
                seen.append(True)
                raise StopReading

        done = self._agent_stream(
            [
                "--no-optional-locks",
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all",
                "--",
                *_NOT_THE_AGENTS,
            ],
            first,
        )
        if seen:
            return True
        if done.returncode != 0:
            raise RepositoryUnusable("git status failed: " + self._agent_detail(done))
        return False

    def commit_all(self, message: str = LEFTOVER_MESSAGE) -> str | None:
        """Commit everything with the fixed message, as the agent's user, through the guard. Returns
        the new tip, or None when there was nothing to commit.

        The agent's `core.hooksPath` beats the system config that names the guard, so these calls
        name the image's hook directory on the command line (`-c` beats the repository's config):
        the guard runs, the agent's own `pre-commit` and `commit-msg` do not. The calls of the
        runner on the mirror never read the agent's config at all (see the module text), so they
        need no such override. Any failure is `RepositoryUnusable`."""
        options = [
            arg
            for setting in (f"core.hooksPath={self.layout.guard_dir}", *_LEFTOVER_COMMIT_OPTIONS)
            for arg in ("-c", setting)
        ]
        added = self._as_agent([*options, "add", "-A", "--", *_NOT_THE_AGENTS])
        if added.returncode != 0:
            raise RepositoryUnusable("git add failed: " + self._agent_detail(added))
        staged = self._as_agent([*options, "diff", "--cached", "--quiet"])
        if staged.returncode == 0:
            return None
        if staged.returncode != 1:
            raise RepositoryUnusable("git diff failed: " + self._agent_detail(staged))
        committed = self._as_agent([*options, "commit", "-q", "-m", message])
        if committed.returncode != 0:
            raise RepositoryUnusable("the commit failed: " + self._agent_detail(committed))
        head = self._as_agent([*options, "rev-parse", "HEAD"])
        if head.returncode != 0 or not head.stdout.strip():
            raise RepositoryUnusable("the new commit cannot be read: " + self._agent_detail(head))
        return head.stdout.strip()

    def engine_inputs_present(self) -> list[str]:
        """Which of the names the engine loads (`ENGINE_INPUTS`) exist in the agent's working tree:
        the agent created or changed them, and none of it is kept. A look at the names with `lstat`
        (nothing is followed or opened), which is safe in a directory the agent owns."""
        return [name for name in ENGINE_INPUTS if os.path.lexists(self.repo / name)]

    def commits_since_start(self) -> list[CommitInfo]:
        """The commits of the agent's branch after the start commit, oldest first, bounded as the
        result is (`history.parse_commits`). Read as the agent's user from its repository, as a
        stream: a subject of any size costs no memory. Raises `RepositoryUnusable` when git
        fails."""
        reader = CappedLines()
        done = self._agent_stream(
            [
                "log",
                "--no-show-signature",
                "-n",
                str(READ_COMMITS),
                "--format=%H %s",
                f"{self.start_commit}..refs/heads/{self.spec.branch}",
            ],
            reader.feed,
        )
        if done.returncode != 0:
            raise RepositoryUnusable("git log failed: " + self._agent_detail(done))
        return parse_commits(bytes(reader.data))

    def changed_files(self) -> list[FileChange]:
        """The files that differ between the start commit and the agent's branch
        (`git diff --name-status` as the agent's user), bounded as the result is."""
        reader = CappedBytes()
        done = self._agent_stream(
            [
                "diff",
                "--name-status",
                "-z",
                "-M",
                "--no-ext-diff",
                "--no-textconv",
                self.start_commit,
                f"refs/heads/{self.spec.branch}",
            ],
            reader.feed,
        )
        if done.returncode != 0:
            raise RepositoryUnusable("git diff failed: " + self._agent_detail(done))
        return parse_name_status(bytes(reader.data))

    def agent_tip(self) -> str | None:
        """The tip of the agent's branch, read the safe way (`ls-remote` against a `git upload-pack`
        run as the agent's user). None when it cannot be read within `TIP_TIMEOUT`; the push does
        its own check."""
        return self._agent_ref()[1]

    def _agent_ref(self) -> tuple[_AgentRef, str | None]:
        """Whether the agent's repository lists its branch, and at what id. Only the exit status of
        `ls-remote` and the shape of its list are used; a repository that cannot be listed says
        nothing about the branch."""
        ref = f"refs/heads/{self.spec.branch}"
        with self._lock:
            listed = self._root(
                [
                    "ls-remote",
                    f"--upload-pack={self._upload_pack()}",
                    str(self.repo),
                    ref,
                ],
                protocols="file",
                timeout=min(self._timeout, TIP_TIMEOUT),
            )
        if listed.returncode != 0:
            return _AgentRef.UNREADABLE, None
        for line in listed.stdout.splitlines():
            sha, _, name = line.partition("\t")
            if name == ref and re.fullmatch(r"[0-9a-f]{40}", sha):
                return _AgentRef.PRESENT, sha
        return _AgentRef.GONE, None

    def spool_signalled(self) -> bool:
        """Whether the spool has a tip update the runner has not looked at (a hint only)."""
        return self._spool.signalled()

    # -- the push ----------------------------------------------------------------------------------

    def push(self) -> PushResult:
        """Fetch the agent's branch into the mirror, check that it is a commit that still contains
        the start commit, descends from what was verified before and was committed by the system
        identity, and push it from the mirror without force.

        Only a refusal of the branch itself (a rewrite, an object that is no commit, a bad object,
        a commit by another committer, a branch without the start commit, a branch that is gone)
        ends the turn for good; a look that failed for another reason raises `PushUnverified` and
        the next call tries again. Which of the two it is, is decided from exit statuses and the
        objects in the mirror, never from the text git printed."""
        with self._lock:
            return self._push()

    def _push(self) -> PushResult:
        if self._poisoned:
            raise fail(
                ErrorCode.BRANCH_VIOLATION, "the agent's branch was rewritten earlier in this turn"
            )
        self.verifications += 1
        ref = f"refs/heads/{self.spec.branch}"
        self._clear_stale_locks()
        previous = self._mirror_tip(ref)
        tip = self._take_over()
        self._check_tip(tip, previous)
        if tip != previous:
            self._advance(ref, tip, previous)
        if tip == self._pushed:
            return PushResult(PushOutcome.UP_TO_DATE, self._pushed)
        if tip == self.start_commit and self._pushed is None:
            return PushResult(PushOutcome.NOTHING_TO_PUSH, None)
        return self._push_from_mirror(ref, tip)

    def _violation(self, reason: str) -> NoReturn:
        self._poisoned = True
        raise fail(ErrorCode.BRANCH_VIOLATION, reason)

    def _fetch_branch(self, *, check_objects: bool) -> Outcome:
        """The agent's branch into the scratch ref (forced: it is the runner's own, the checks
        below decide what the branch may do)."""
        checked = "true" if check_objects else "false"
        return self._mirror(
            [
                "-c",
                f"fetch.fsckObjects={checked}",
                "-c",
                f"transfer.fsckObjects={checked}",
                "fetch",
                *_PLAIN_FETCH,
                f"--upload-pack={self._upload_pack()}",
                str(self.repo),
                f"+refs/heads/{self.spec.branch}:{SCRATCH_REF}",
            ]
        )

    def _take_over(self) -> str:
        """Fetch the agent's branch and return its tip, a commit that git accepted with its objects
        checked."""
        fetched = self._fetch_branch(check_objects=True)
        if fetched.returncode != 0:
            self._explain_failed_fetch(fetched)
        raw_id = self._mirror(["rev-parse", "-q", "--verify", SCRATCH_REF])
        if raw_id.returncode != 0 or not raw_id.stdout.strip():
            raise PushUnverified("the fetched branch cannot be read in the mirror")
        commit = self._mirror(["rev-parse", "-q", "--verify", f"{SCRATCH_REF}^{{commit}}"])
        if commit.returncode == 1:
            self._violation("the branch does not point at a commit")
        if commit.returncode != 0:
            raise PushUnverified("the fetched branch cannot be read in the mirror")
        if commit.stdout.strip() != raw_id.stdout.strip():
            self._violation("the branch does not point at a commit")
        return commit.stdout.strip()

    def _explain_failed_fetch(self, fetched: Outcome) -> None:
        """A fetch that failed is a refusal of the branch only when the state says so: the agent's
        repository lists no branch (it is gone), or it lists one whose objects git takes with
        `fsckObjects` off and refuses with it on. Anything else (a timeout, a repository that
        cannot be listed, a second try that works, a failure with or without the checks) says
        nothing about the branch. Returns when a second try worked."""
        if fetched.unanswered:
            raise PushUnverified("the agent's branch could not be fetched (git did not finish)")
        state, _ = self._agent_ref()
        if state is _AgentRef.UNREADABLE:
            raise PushUnverified("the agent's repository could not be read")
        if state is _AgentRef.GONE:
            self._violation("the branch is gone")
        again = self._fetch_branch(check_objects=True)
        if again.returncode == 0:
            return
        if not again.unanswered and self._fetch_branch(check_objects=False).returncode == 0:
            self._violation("the branch has objects git refuses")
        raise PushUnverified(
            f"the agent's branch could not be fetched (git fetch, status {again.returncode})"
        )

    def _check_tip(self, tip: str, previous: str | None) -> None:
        """The fetched tip contains the start commit, descends from the tip verified before, and
        every commit since the start was committed by the system identity. Only the committer is
        checked: `git cherry-pick`, `git am` and a merge keep the foreign author of a legitimate
        commit, while the committer is always the agent's environment. A forged author stays
        possible and is visible, because the committer of the same commit shows the system. The
        mirror's branch is not moved until this has passed, so a tip that does not pass is never in
        the mirror's branch."""
        self._must_be_ancestor(
            self.start_commit,
            tip,
            "the agent's branch no longer contains the commit it started from",
        )
        if previous is not None and previous != tip:
            self._must_be_ancestor(
                previous,
                tip,
                "the agent's branch cannot be taken over without force: the branch was "
                "rewritten, it is not a fast-forward of what was pushed",
            )
        self._check_committers(tip)

    def _must_be_ancestor(self, ancestor: str, tip: str, reason: str) -> None:
        done = self._mirror(["merge-base", "--is-ancestor", ancestor, tip])
        if done.returncode == 1:
            self._violation(reason)
        if done.returncode != 0:
            raise PushUnverified(
                "the ancestry of the branch could not be looked at (git merge-base)"
            )

    def _check_committers(self, tip: str) -> None:
        """Every commit in `start..tip` has exactly one `author` and one `committer` header, and
        the committer is the system identity. The headers are read as they are stored
        (`--format=raw` prints the lines of the object): `%cn` and `%ce` read the last `committer`
        line while other parts of git read the first, so a commit with two of them is refused
        outright. Only the header block of each commit is read, as a stream: the message is the
        agent's and can be arbitrarily large (#764)."""
        system = (self.identity.name, self.identity.email)

        def check(headers: list[str]) -> None:
            if not _COMMIT_HEADER.fullmatch(headers[0]):
                self._violation("a commit of the branch cannot be read")
            sha = headers[0].removeprefix("commit ")
            authors = [line for line in headers if line.startswith("author ")]
            committers = [line for line in headers if line.startswith("committer ")]
            if len(authors) != 1 or len(committers) != 1:
                self._violation(
                    f"commit {sha[:12]} does not have exactly one author and one committer"
                )
            found = _COMMITTER.fullmatch(committers[0])
            if found is None or (found["name"], found["email"]) != system:
                self._violation(f"commit {sha[:12]} was not committed by the system identity")

        reader = CommitHeaderReader(check)
        try:
            listed = self._mirror_stream(
                [
                    "log",
                    "-z",
                    "--no-show-signature",
                    "--format=raw",
                    f"{self.start_commit}..{tip}",
                ],
                reader.feed,
            )
            if listed.returncode == 0:
                reader.finish()
        except HeaderTooLarge:
            self._violation("a commit of the branch has an absurdly large header")
        if listed.returncode != 0:
            raise PushUnverified("the commits of the branch could not be listed (git log)")

    def _advance(self, ref: str, tip: str, previous: str | None) -> None:
        """Move the mirror's branch to the verified tip, only if it still is where it was."""
        done = self._mirror(["update-ref", ref, tip, previous or ZERO_ID])
        if done.returncode != 0:
            raise PushUnverified("the mirror's branch could not be moved (git update-ref)")

    def _push_from_mirror(self, ref: str, tip: str) -> PushResult:
        pushed = self._mirror(
            ["push", "--porcelain", self.spec.clone_url, f"{ref}:{ref}"],
            protocols=":".join(self._schemes),
            token=True,
        )
        if pushed.returncode != 0:
            refused = [line for line in pushed.stdout.splitlines() if line.startswith("!")]
            detail = self._detail(pushed)
            hiccups = bool(refused) and all(_HICCUP.search(line) for line in refused)
            if hiccups or (not refused and not _is_http_refusal(detail)):
                raise PushTransient("the provider did not take the push for now: " + detail)
            first = self._pushed is None
            if any("[rejected]" in line for line in refused) and first:
                raise fail(
                    ErrorCode.BRANCH_EXISTS,
                    "the branch exists on the provider with other history: " + detail,
                )
            raise fail(ErrorCode.PUSH_REJECTED, "the provider did not accept the push: " + detail)
        self._pushed = tip
        return PushResult(PushOutcome.PUSHED, tip)

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
        self._names_checked = True

    def _prepare_directories(self) -> None:
        for directory in (self.layout.work_dir, self.layout.run_dir):
            _own_directory(directory)
        for existing in (self.mirror, self.repo):
            if existing.exists() or existing.is_symlink():
                raise fail(
                    ErrorCode.SETUP_FAILED, f"{existing.name} exists already in the work directory"
                )

    def _clear_stale_locks(self) -> None:
        """Remove the `.lock` files in the mirror. Only the runner writes the mirror, and only under
        `self._lock`, and no git in it starts a background `gc --auto` or maintenance (`_mirror`
        switches both off), so a lock found here belongs to a git that was killed (a timeout) and
        would refuse every later fetch."""
        for directory, _, files in os.walk(self.mirror, followlinks=False):
            for name in files:
                if name.endswith(".lock"):
                    Path(directory, name).unlink(missing_ok=True)

    def _drops_privileges(self) -> bool:
        return bool(spawn_options(self.agent.uid, self.agent.gid))

    def _setpriv(self) -> str | None:
        return shutil.which("setpriv", path=TRUSTED_PATH)

    def _upload_pack(self) -> str:
        """The command git runs on the far side of a local fetch. It reads the agent's repository,
        so it runs as the agent's user: that repository's config is read with the agent's rights."""
        command = [self.git, "upload-pack"]
        if self._drops_privileges():
            setpriv = self._setpriv()
            if setpriv is None:
                raise fail(ErrorCode.SETUP_FAILED, "setpriv is not installed")
            command = [
                setpriv,
                f"--reuid={self.agent.uid}",
                f"--regid={self.agent.gid}",
                "--clear-groups",
                "--no-new-privs",
                *command,
            ]
        return " ".join(shlex.quote(part) for part in command)

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

    def _mirror_stream(self, args: list[str], consume: Callable[[bytes], None]) -> Outcome:
        """`_mirror` for output that is read as a stream and not kept (see `GitProcess.stream`)."""
        return self._process.stream(
            ["--git-dir", str(self.mirror), *_MIRROR_OPTIONS, *args],
            env=self._process.base_environment("file"),
            consume=consume,
            timeout=self._timeout,
        )

    def _as_agent(self, args: list[str], *, env: dict[str, str] | None = None) -> Outcome:
        return self._process.run(
            args,
            env=env or self.agent_environment(),
            cwd=self.repo,
            spawn=spawn_options(self.agent.uid, self.agent.gid),
            timeout=self._timeout,
        )

    def _agent_stream(self, args: list[str], consume: Callable[[bytes], None]) -> Outcome:
        """`_as_agent` for output that is read as a stream and only partly kept. A reader that has
        what it keeps (`StopReading`) ends git, and the command counts as answered."""
        try:
            return self._process.stream(
                args,
                env=self.agent_environment(),
                cwd=self.repo,
                spawn=spawn_options(self.agent.uid, self.agent.gid),
                consume=consume,
                timeout=self._timeout,
            )
        except StopReading:
            return Outcome(0, "", "")

    def _mirror_tip(self, ref: str) -> str | None:
        done = self._mirror(["rev-parse", "-q", "--verify", ref])
        return done.stdout.strip() or None if done.returncode == 0 else None

    def _detail(self, outcome: Outcome) -> str:
        """Git's output on the runner's own data (the mirror, the provider)."""
        return self._process.detail(outcome.stderr or outcome.stdout)

    def _agent_detail(self, outcome: Outcome) -> str:
        """The result of a git command on the agent's repository: what the agent can make git print
        does not travel (see `GitProcess.agent_detail`), only the status and a guard denial."""
        denial = self._process.agent_detail(outcome.stderr + outcome.stdout)
        status = f"status {outcome.returncode}"
        return f"{status}: {denial}" if denial else status


def _own_directory(path: Path) -> None:
    """Make sure a directory the guard's files and the agent's tree live in is the runner's. A new
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


def _hand_over(root: Path, agent: AgentUser) -> None:
    """Make the freshly cloned tree the agent's, without following a link."""
    os.lchown(root, agent.uid, agent.gid)
    for directory, names, files in os.walk(root, followlinks=False):
        for name in [*names, *files]:
            os.lchown(os.path.join(directory, name), agent.uid, agent.gid)


class PushLoop:
    """When to push while the agent works. The caller ticks it every couple of seconds.

    A push is due when the spool got a line or the branch moved (the poll finds what the hook's hint
    missed); due pushes are batched to at most one per `interval`, except the final one. A look at
    the branch that failed for a reason that is not the agent's (`PushUnverified`) is tried again
    after a back-off that doubles from `retry_backoff` to `max_backoff` (each look can cost a full
    fetch timeout, and the same failure would repeat at every tick); the final push does not wait,
    and a look that fails then ends the turn with `RepositoryUnusable`."""

    def __init__(
        self,
        workspace: GitWorkspace,
        *,
        interval: float = PUSH_INTERVAL_SECONDS,
        clock: Callable[[], float] = time.monotonic,
        retry_backoff: float = RETRY_BACKOFF_SECONDS,
        max_backoff: float = MAX_BACKOFF_SECONDS,
    ) -> None:
        self._workspace = workspace
        self._interval = interval
        self._clock = clock
        self._seen = workspace.start_commit
        self._pending = False
        self._last: float | None = None
        self._retry_backoff = retry_backoff
        self._max_backoff = max_backoff
        self._failures = 0
        self._retry_at: float | None = None

    def tick(self) -> PushResult | None:
        if self._workspace.spool_signalled():
            self._pending = True
        tip = self._workspace.agent_tip()
        if tip is not None and tip != self._seen:
            self._seen = tip
            self._pending = True
        if not self._pending:
            return None
        now = self._clock()
        if self._last is not None and now - self._last < self._interval:
            return None
        if self._retry_at is not None and now < self._retry_at:
            return None
        try:
            result = self._workspace.push()
        except PushUnverified:
            # Nothing is known against the agent: look again, but not at the next tick. The wait
            # counts from the end of the look: a fetch that hung for 30 s and failed must not be
            # retried at once because the clock was read before it (#764).
            self._failures += 1
            wait = self._retry_backoff * 2 ** (self._failures - 1)
            self._retry_at = self._clock() + min(self._max_backoff, wait)
            return None
        self._failures = 0
        self._retry_at = None
        self._pending = False
        self._last = self._clock()
        return result

    def finish(self) -> PushResult:
        """The last push of the turn, at once and whatever the back-off. A look that fails now ends
        the turn: `RepositoryUnusable`, a charged class."""
        try:
            result = self._workspace.push()
        except PushTransient as transient:
            raise JobError(
                ErrorCode.PUSH_REJECTED,
                "the provider did not take the final push: " + transient.detail,
            ) from None
        except PushUnverified as unverified:
            raise RepositoryUnusable(
                "the agent's branch could not be verified: " + unverified.detail
            ) from None
        self._pending = False
        self._last = self._clock()
        return result
