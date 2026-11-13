# SPDX-License-Identifier: LicenseRef-Proprietary

"""The environment's setup script on a real Docker daemon (#818, step 5 of the sandbox plan; #1009):
the container it runs in (the agent's own), its network and the agent that runs in that same
container afterwards.

Under `runc` (CI) the container has no inner Docker, so what is proven here is the flow, the files,
the processes the script leaves running, the failures, the secrets and the network rules of the
host's side; under `sysbox-runc` (a VM, `LANE_RUNTIME=sysbox-runc`) the same tests also prove that
the images the script put in the container's own Docker are the agent's. What only a VM with the
platform's network proves (the internet is reachable, the VM's control port is not) is in
`docs/implementer.md`, "Measured on a real VM"."""

import socket
import threading
import time
from pathlib import Path
from typing import Any
from unittest import mock

import pytest
from fakes.wire.formats import Turn
from lane_support import (
    bash,
    bridge_gateway,
    commit,
    docker,
    environment_step,
    host_nft,
    inet_family_supported,
    lane_config,
    lane_environment,
    lane_turn,
    lane_workspace,
    says,
    wait_for,
    write_file,
)
from opencode_native import REAL_KEY

from code_reviewer_runner.implementer import environment_setup as es
from code_reviewer_runner.implementer.agent_container import AGENT_CONTAINER_NAME
from code_reviewer_runner.implementer.git_workspace import GitWorkspace
from code_reviewer_runner.implementer.session import ShutdownRequested
from code_reviewer_runner.implementer.setup_container import (
    SETUP_ADDRESS,
    SETUP_BRIDGE,
    SETUP_NETWORK_GATEWAY,
    SETUP_NETWORK_NAME,
)
from code_reviewer_runner.result import ErrorCode
from git_support import TOKEN, raw

SETUP = """
echo made-by-setup > /opt/setup-marker
echo untracked > /work/repo/setup-made.txt
echo '# changed by the setup' >> /work/repo/README.md
echo 'setup is done'
"""


def nothing_of_the_setup_is_left() -> None:
    """The container the script ran in and its network are gone, and so is the model side of a turn
    that never began."""
    names = docker("ps", "-a", "--format", "{{.Names}}").stdout.split()
    assert AGENT_CONTAINER_NAME not in names
    assert docker("network", "inspect", SETUP_NETWORK_NAME, check=False).returncode != 0


# #818-L01
def test_the_agent_runs_in_the_container_the_script_left_and_the_tracked_files_are_back(
    tmp_path: Path,
) -> None:
    under_sysbox = lane_config().under_sysbox
    inner = (
        "docker image ls --format '{{.Repository}}:{{.Tag}}' > images.txt; "
        if under_sysbox
        else "echo no-inner-docker > images.txt; "
    )

    def script(repo: Path) -> list[Turn]:
        return [
            bash(
                "cp /opt/setup-marker marker-copy.txt; cp setup-made.txt made-copy.txt; "
                "git status --short > status.txt; "
                + inner
                + "git add marker-copy.txt made-copy.txt status.txt images.txt "
                + "&& git commit -qm 'Use the setup'"
            ),
            says("Used what the setup left."),
        ]

    setup = SETUP
    if under_sysbox:
        # An image in the container's own Docker, made without the internet.
        setup += (
            "mkdir -p /tmp/rootfs/bin && cp /usr/local/bin/docker /tmp/rootfs/bin/docker && "
            "tar -C /tmp/rootfs -c . | docker import - tiny:setup\n"
        )
    with lane_turn(tmp_path, script, setup_script=setup) as turned:
        result = turned.result
        assert result.ok, (result.error_code, result.error_detail, result.notes)
        prepared = turned.setup
        assert prepared is not None and prepared.adopted is not None and prepared.error is None
        assert prepared.block is not None and prepared.block["ok"] is True
        assert "setup is done" in prepared.block["output"]
        # The agent ran in the container of the script: the file the script left in the container's
        # file system, and not in the repository, is there.
        tip = result.head_commit or ""
        shown = raw("show", f"{tip}:marker-copy.txt", cwd=turned.origin.path, git=turned.origin.git)
        assert shown.strip() == "made-by-setup"
        # What the script added to the repository is in the agent's tree and the agent used it, but
        # it is no change of the agent's: not in `git status`, not on the branch, and the tree is
        # clean at the end, so the agent got no extra message. The tracked file the script changed
        # was put back.
        status = raw("show", f"{tip}:status.txt", cwd=turned.origin.path, git=turned.origin.git)
        assert "setup-made.txt" not in status and "README.md" not in status
        copy = raw("show", f"{tip}:made-copy.txt", cwd=turned.origin.path, git=turned.origin.git)
        assert copy.strip() == "untracked"
        on_branch = raw(
            "ls-tree", "-r", "--name-only", tip, cwd=turned.origin.path, git=turned.origin.git
        )
        assert "setup-made.txt" not in on_branch.split()
        assert len(turned.messages) == 1, "a clean tree gets no extra message"
        assert any("script added are in the agent's tree" in n for n in prepared.notes)
        assert any(
            "1 tracked file(s) the script changed were put back" in n for n in prepared.notes
        )
        assert [f.path for f in result.files_changed if f.path == "README.md"] == []
        if under_sysbox:
            images = raw("show", f"{tip}:images.txt", cwd=turned.origin.path, git=turned.origin.git)
            assert "tiny:setup" in images
        # It is the very container the script ran in: its id is the one the step handed over, and
        # the turn removed it at the end.
        assert docker("inspect", prepared.adopted.container, check=False).returncode != 0
    nothing_of_the_setup_is_left()


# #818-L02
def test_a_script_that_fails_ends_before_the_model_and_leaves_its_output(tmp_path: Path) -> None:
    with lane_environment(tmp_path, "echo about to fail\necho oops >&2\nexit 3\n") as (lane, step):
        assert step.error is not None and step.error.code is ErrorCode.ENVIRONMENT_SETUP_FAILED
        assert step.adopted is None
        block = step.block
        assert block is not None and block["ok"] is False and block["exitCode"] == 3
        assert block["timedOut"] is False
        assert "about to fail" in block["output"] and "oops" in block["output"]
        # No door, no model network and no agent: the model was never within reach.
        assert docker("network", "inspect", "code-reviewer-model", check=False).returncode != 0
        assert raw("rev-parse", "HEAD", cwd=lane.workspace.repo, git=lane.origin.git)
    nothing_of_the_setup_is_left()


def three_seconds(limit: float, elapsed: float) -> float:
    return 3.0


# #818-L03
def test_a_script_that_runs_out_of_time_is_stopped_and_says_so(tmp_path: Path) -> None:
    with (
        mock.patch.object(es, "script_seconds", three_seconds),
        mock.patch.object(es, "MIN_SCRIPT_SECONDS", 1.0),
        lane_environment(tmp_path, "echo started\nsleep 600\necho never\n") as (_, step),
    ):
        assert step.error is not None and step.error.code is ErrorCode.ENVIRONMENT_SETUP_FAILED
        assert step.block is not None and step.block["timedOut"] is True
        assert step.block["exitCode"] is None and step.block["ok"] is False
        assert "started" in step.block["output"] and "never" not in step.block["output"]
        assert "time limit" in step.error.detail
    nothing_of_the_setup_is_left()


# #818-L04
def test_a_script_that_fills_the_disk_fails_and_the_reserve_is_untouched(tmp_path: Path) -> None:
    with lane_environment(
        tmp_path, "dd if=/dev/zero of=/work/repo/fill.bin bs=1M\n", disk_megabytes=700
    ) as (lane, step):
        assert step.error is not None and step.error.code is ErrorCode.ENVIRONMENT_SETUP_FAILED
        assert step.block is not None and "No space left on device" in step.block["output"]
        # Control's reserve disk was all the time its own: the mirror is whole and has its room.
        assert lane.workspace.reserve_free_bytes() > 256 * 1024**2
        assert raw("rev-parse", "HEAD", cwd=lane.workspace.mirror, git=lane.origin.git)
        assert any("left after the script" in note for note in step.notes)
    nothing_of_the_setup_is_left()


# #1009-T45
def test_a_script_that_fills_the_containers_root_keeps_the_container_whole_for_the_agent(
    tmp_path: Path,
) -> None:
    """A gigabyte in the container's own file system is just there for the agent: nothing is
    committed any more, so there is no step that the VM's disk could fail (before #1009 the
    commit needed twice the layer and a headroom, and a script that left a gigabyte on a small
    disk ended the turn)."""
    big = "dd if=/dev/zero of=/opt/fill.bin bs=1M count=1024\n"
    with lane_environment(tmp_path, big, disk_megabytes=2048) as (_, step):
        assert step.error is None and step.adopted is not None, (step.error, step.notes)
        assert step.block is not None and step.block["ok"] is True
    nothing_of_the_setup_is_left()


# #818-L05
def test_a_stop_of_the_runner_ends_the_script_and_removes_the_container(tmp_path: Path) -> None:
    stop = threading.Event()
    threading.Timer(4.0, stop.set).start()
    with (
        pytest.raises(ShutdownRequested),
        lane_environment(tmp_path, "sleep 600\n", should_stop=stop.is_set),
    ):
        pass
    nothing_of_the_setup_is_left()


# #818-L06
def test_the_container_of_the_script_has_no_secret_of_any_kind(tmp_path: Path) -> None:
    probe = r"""
echo '--- environment'; env | sort
echo '--- pid 1'; tr '\0' '\n' < /proc/1/environ | sort
echo '--- mounts'; cat /proc/self/mountinfo
echo '--- files'; ls -la /run /run/secrets /var/run 2>&1 || true
echo '--- done'
"""
    with lane_environment(tmp_path, probe) as (_, step):
        assert step.error is None and step.block is not None
        shown = step.block["output"]
        assert "--- done" in shown
        # Not the token, not the key, not a variable named like one.
        assert TOKEN not in shown and REAL_KEY not in shown
        variables = dict(
            line.split("=", 1)
            for part in shown.split("--- ")
            if part.startswith(("environment", "pid 1"))
            for line in part.splitlines()[1:]
            if "=" in line
        )
        assert variables, shown
        # Not one variable named like a credential that holds a value. (The Python base image names
        # two public values, `GPG_KEY` and `PYTHON_SHA256`; the agent image empties them.)
        for name, value in variables.items():
            upper = name.upper()
            named = any(
                word in upper for word in ("TOKEN", "KEY", "SECRET", "PASSWORD", "CREDENTIAL")
            )
            assert not (named and value), name
        # No socket of the VM, no device, no mount but the repository.
        mounts = shown.split("--- mounts")[1].split("--- files")[0]
        assert "docker.sock" not in mounts and "/work/repo" in mounts
        # Nor does its definition, which is the agent's: read back from the daemon.
        assert step.adopted is not None
        config = docker(
            "inspect", step.adopted.container, "--format", "{{json .Config.Env}}"
        ).stdout
        assert TOKEN not in config and REAL_KEY not in config
        for word in ("TOKEN", "SECRET", "PASSWORD", "API_KEY"):
            assert word not in config.upper()
    nothing_of_the_setup_is_left()


def listener() -> tuple[socket.socket, int]:
    """A TCP service on all addresses of this machine, as the VM's control port is."""
    server = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
    server.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
    server.bind(("::", 0))
    server.listen(16)
    threading.Thread(target=_accept, args=(server,), daemon=True).start()
    return server, server.getsockname()[1]


def _accept(server: socket.socket) -> None:
    while True:
        try:
            connection, _ = server.accept()
        except OSError:
            return
        connection.close()


# #818-L07
def test_the_container_of_the_script_cannot_reach_the_vms_services_over_ipv4_or_ipv6(
    tmp_path: Path,
) -> None:
    server, port = listener()
    config = lane_config()
    gateway = bridge_gateway()
    reach = (
        't() { if timeout 4 bash -c "echo > /dev/tcp/$1/$2" 2>/dev/null; '
        'then echo "OPEN $1:$2"; else echo "blocked $1:$2"; fi; }\n'
    )
    # What root in the container can do about IPv6: switch it on and look for the bridge's
    # link-local address, as the measured attack did.
    ipv6 = f"""
echo "ipv6 off in this namespace: eth0=$(cat /proc/sys/net/ipv6/conf/eth0/disable_ipv6)"
sysctl -qw net.ipv6.conf.all.disable_ipv6=0 net.ipv6.conf.eth0.disable_ipv6=0 || true
sleep 3; ping -6 -c1 -W1 ff02::1%eth0 >/dev/null 2>&1 || true
for address in $(ip -6 neigh show dev eth0 | awk '/^fe80/ {{print $1}}'); do
  if timeout 4 bash -c "echo > /dev/tcp/$address%eth0/{port}" 2>/dev/null; then
    echo "OPEN6 $address"; else echo "blocked6 $address"; fi
done
echo "neighbours: $(ip -6 neigh show dev eth0 | grep -c '^fe80')"
"""
    script = (
        reach
        + f"t {SETUP_NETWORK_GATEWAY} {port}\nt {gateway} {port}\n"
        + f'ip route get 1.1.1.1 | head -1\necho "own address: {SETUP_ADDRESS}"\n'
        + ipv6
    )
    try:
        # The control: a plain container on the VM's default bridge reaches the service, so the
        # service is reachable at all and "blocked" below means something.
        control = docker(
            "run", "--rm", "--user", "0:0", "--entrypoint", "/opt/venv/bin/python",
            config.worker_image, "-I", "-c",
            f"import socket; socket.create_connection(('{gateway}', {port}), 5); print('reached')",
        ).stdout  # fmt: skip
        assert "reached" in control
        with lane_environment(tmp_path, script) as (_, step):
            assert step.error is None and step.block is not None, (step.notes, step.block)
            shown = step.block["output"]
            assert f"blocked {SETUP_NETWORK_GATEWAY}:{port}" in shown, shown
            assert f"blocked {gateway}:{port}" in shown, shown
            assert "OPEN" not in shown, shown
            # No link-local neighbour on the bridge, so nothing to connect to over IPv6.
            assert "neighbours: 0" in shown, shown
            # IPv6 was off on the container's interface before its root tried to switch it on:
            # a new interface takes `default` (the VM's `ipv6-off` step writes that one, and only
            # that one), and the bridge Docker made has no IPv6 of its own either.
            assert "eth0=1" in shown, shown
            # The `inet` table beside the `ip` one, for a kernel that has the family: read back,
            # its two drops (IPv6 from the Setup bridge to the VM, and to a private range).
            if inet_family_supported(config):
                table = host_nft(config, "list table inet implementer_ipv6_setup")
                assert table.returncode == 0, table.stderr
                assert f'iifname "{SETUP_BRIDGE}" meta nfproto ipv6 drop' in table.stdout
                assert f'iifname "{SETUP_BRIDGE}" ip6 daddr' in table.stdout
                assert "fe80::/10" in table.stdout and "fc00::/7" in table.stdout
    finally:
        server.close()
    nothing_of_the_setup_is_left()


# #818-L08
def test_a_turn_without_an_environment_makes_no_setup_network(tmp_path: Path) -> None:
    def script(repo: Path) -> list[Turn]:
        return [write_file(repo, "hello.txt"), commit("Add hello"), says("Done.")]

    with lane_turn(tmp_path, script) as turned:
        assert turned.result.ok, (turned.result.error_code, turned.result.notes)
        assert turned.setup is None
        assert docker("network", "inspect", SETUP_NETWORK_NAME, check=False).returncode != 0


# The process the script starts, as a small database: it keeps rows in a file, answers on a
# loopback port, and writes its pid. The agent reads the row the script wrote, adds one, stops the
# process, starts it again and reads both (the lane's stand-in for a Postgres: the real one is a
# container of the container's own Docker, which only `sysbox-runc` has).
DATABASE = r"""
import os, socketserver, sys
rows = "/opt/rows.txt"
class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        line = self.rfile.readline().decode().strip()
        if line.startswith("insert "):
            with open(rows, "a") as out:
                out.write(line[7:] + "\n")
            self.wfile.write(b"ok\n")
        else:
            self.wfile.write(open(rows).read().replace("\n", ",").encode() + b"\n")
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", 5433), Handler) as server:
    open("/opt/db.pid", "w").write(str(os.getpid()))
    server.serve_forever()
"""
TALK = (
    "python3 -c \"import socket,sys; s=socket.create_connection(('127.0.0.1',5433),5); "
    "s.sendall((sys.argv[1]+'\\\\n').encode()); print(s.makefile().readline().strip())\""
)


# #1009-T01 (T01 of the issue, in the lane's stand-in, T03: the process runs after the narrowing)
def test_a_process_the_script_started_is_still_running_for_the_agent_and_its_data_persists(
    tmp_path: Path,
) -> None:
    setup = f"""
cat > /opt/db.py <<'PY'
{DATABASE}
PY
echo 7 > /opt/rows.txt
setsid nohup python3 /opt/db.py > /dev/null 2>&1 &
for i in $(seq 1 50); do [ -s /opt/db.pid ] && break; sleep 0.1; done
echo "started $(cat /opt/db.pid)"
"""

    def script(repo: Path) -> list[Turn]:
        return [
            bash(
                f"{TALK} 'select' > rows-before.txt; "
                f"{TALK} 'insert 8' > insert.txt; "
                "kill $(cat /opt/db.pid); sleep 1; "
                "(kill -0 $(cat /opt/db.pid) 2>/dev/null && echo still-alive || echo stopped) "
                "> after-stop.txt; "
                "setsid nohup python3 /opt/db.py > /dev/null 2>&1 & sleep 2; "
                f"{TALK} 'select' > rows-after.txt; "
                "git add rows-before.txt insert.txt after-stop.txt rows-after.txt "
                "&& git commit -qm 'Use the database'"
            ),
            says("Used the process the setup left."),
        ]

    with lane_turn(tmp_path, script, setup_script=setup) as turned:
        result = turned.result
        assert result.ok, (result.error_code, result.error_detail, result.notes)
        prepared = turned.setup
        assert prepared is not None and prepared.block is not None and prepared.block["ok"] is True
        assert "started " in prepared.block["output"]
        tip = result.head_commit or ""

        def shown(name: str) -> str:
            return raw(
                "show", f"{tip}:{name}", cwd=turned.origin.path, git=turned.origin.git
            ).strip()

        # The agent talked to the very process the script started (it had the row the script wrote),
        # stopped it, started it again, and the data was there.
        assert shown("rows-before.txt") == "7,"
        assert shown("insert.txt") == "ok"
        assert shown("after-stop.txt") == "stopped"
        assert shown("rows-after.txt") == "7,8,"
    nothing_of_the_setup_is_left()


# #1009-T46 (T01/T03 of the issue, the way a real setup starts a database: `nohup postgres &`,
# `pg_ctl start`, `./server &` with the output of the script as it is)
def test_a_daemon_that_keeps_the_scripts_output_does_not_end_the_step_and_runs_for_the_agent(
    tmp_path: Path,
) -> None:
    """The daemon is not redirected: it inherits what the script's standard output is, and it prints
    on it every tenth of a second. Before the output went through a file the daemon held the exec's
    stream open, the step waited for its time limit though the script had exited 0, and the daemon
    got SIGPIPE when the stream was closed: it was dead for the agent."""
    setup = """
nohup sh -c 'echo $$ > /opt/beat.pid; while :; do echo beat; date +%s%N >> /opt/beat.log; \
sleep 0.1; done' &
for i in $(seq 1 50); do [ -s /opt/beat.pid ] && break; sleep 0.1; done
echo "started $(cat /opt/beat.pid)"
"""

    def script(repo: Path) -> list[Turn]:
        return [
            bash(
                "a=$(wc -l < /opt/beat.log); sleep 1; b=$(wc -l < /opt/beat.log); "
                'echo "$a $b" > beats.txt; '
                "(kill -0 $(cat /opt/beat.pid) 2>/dev/null && echo alive || echo dead) "
                "> daemon.txt; "
                "git add beats.txt daemon.txt && git commit -qm 'Use the daemon'"
            ),
            says("Used the daemon the setup left."),
        ]

    with lane_turn(tmp_path, script, setup_script=setup) as turned:
        result = turned.result
        assert result.ok, (result.error_code, result.error_detail, result.notes)
        prepared = turned.setup
        assert prepared is not None and prepared.block is not None and prepared.block["ok"] is True
        assert prepared.block["timedOut"] is False
        assert "started " in prepared.block["output"] and "beat" in prepared.block["output"]
        # The step did not wait for anything but the script (its limit is 15 minutes).
        assert prepared.block["durationSeconds"] < 120, prepared.block
        tip = result.head_commit or ""

        def shown(name: str) -> str:
            return raw(
                "show", f"{tip}:{name}", cwd=turned.origin.path, git=turned.origin.git
            ).strip()

        before, after = (int(n) for n in shown("beats.txt").split())
        assert after > before, "the daemon went on running while the agent used the container"
        assert shown("daemon.txt") == "alive"
    nothing_of_the_setup_is_left()


# #1009-T47 (the freeze: a root process of the script must not write the repository while Control
# reads it; the Sysbox variant, a process in an inner container, is `tests/kvm/test_whole_job.py`
# #1009-T48)
def test_the_container_is_frozen_while_control_reads_the_repository_and_runs_after_the_unfreeze(
    tmp_path: Path,
) -> None:
    setup = """
nohup sh -c 'while :; do date +%s%N >> /work/repo/ticks.log; sleep 0.01; done' > /dev/null 2>&1 &
for i in $(seq 1 50); do [ -s /work/repo/ticks.log ] && break; sleep 0.1; done
echo started
"""
    seen: list[tuple[int, int]] = []
    original = GitWorkspace.settle_after_setup

    with lane_workspace(tmp_path) as lane:
        ticks = tmp_path / "work" / "repo" / "ticks.log"

        def watched(self: GitWorkspace, *args: Any, **options: Any) -> list[str]:
            # Control's read, as the step makes it: the file is looked at before, a second goes by,
            # and it is looked at again; a writer that is not frozen has made a hundred more ticks.
            first = ticks.stat().st_size
            time.sleep(1.0)
            seen.append((first, ticks.stat().st_size))
            return original(self, *args, **options)

        with mock.patch.object(GitWorkspace, "settle_after_setup", watched):
            step = environment_step(lane, setup)
        try:
            assert step.error is None and step.adopted is not None, step.notes
            assert step.adopted.paused is True
            assert (
                docker("inspect", "-f", "{{.State.Paused}}", step.adopted.container).stdout.strip()
                == "true"
            )
            [(first, second)] = seen
            assert first > 0, "the writer had not started"
            assert second == first, "the file grew while the container was frozen"
            # Unfrozen, as the agent's container object does it, the same process writes again.
            docker("unpause", step.adopted.container)
            assert wait_for(lambda: ticks.stat().st_size > second, 20.0), "it never ran again"
        finally:
            if step.adopted is not None:
                docker("unpause", step.adopted.container, check=False)
                docker("rm", "-f", step.adopted.container, check=False)
                docker("network", "rm", SETUP_NETWORK_NAME, check=False)
