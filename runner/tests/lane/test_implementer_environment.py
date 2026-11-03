# SPDX-License-Identifier: LicenseRef-Proprietary

"""The environment's setup script on a real Docker daemon (#818, step 5 of the sandbox plan): the
Setup container, its network, the image it commits and the agent that starts from it.

Under `runc` (CI) the Setup container has no inner Docker, so what is proven here is the flow, the
files, the failures, the secrets and the network rules of the host's side; under `sysbox-runc` (a
VM, `LANE_RUNTIME=sysbox-runc`) the same tests also prove that the images the script put in the
container's own Docker are in the agent's. What only a VM with the platform's network proves (the
internet is reachable, the VM's control port is not) is in `docs/implementer.md`, "Measured on a
real VM"."""

import socket
import threading
from collections.abc import Iterator
from pathlib import Path
from unittest import mock

import pytest
from fakes.wire.formats import Turn
from lane_support import (
    bash,
    bridge_gateway,
    commit,
    docker,
    lane_config,
    lane_environment,
    lane_turn,
    says,
    write_file,
)
from opencode_native import REAL_KEY

from code_reviewer_runner.implementer import environment_setup as es
from code_reviewer_runner.implementer.agent_container import AGENT_CONTAINER_NAME
from code_reviewer_runner.implementer.session import ShutdownRequested
from code_reviewer_runner.implementer.setup_container import (
    SETUP_ADDRESS,
    SETUP_CONTAINER_NAME,
    SETUP_IMAGE_REPOSITORY,
    SETUP_IMAGE_TAG,
    SETUP_NETWORK_GATEWAY,
    SETUP_NETWORK_NAME,
)
from code_reviewer_runner.result import ErrorCode
from git_support import TOKEN, raw

IMAGE = f"{SETUP_IMAGE_REPOSITORY}:{SETUP_IMAGE_TAG}"

SETUP = """
echo made-by-setup > /opt/setup-marker
echo untracked > /work/repo/setup-made.txt
echo '# changed by the setup' >> /work/repo/README.md
echo 'setup is done'
"""


@pytest.fixture(autouse=True)
def no_committed_image_between_tests() -> Iterator[None]:
    """A test starts without the image an earlier one committed, and leaves none."""
    docker("image", "rm", IMAGE, check=False)
    yield
    docker("image", "rm", IMAGE, check=False)


def nothing_of_the_setup_is_left() -> None:
    """The Setup container and its network are gone, and so is the model side of a turn that
    never began."""
    names = docker("ps", "-a", "--format", "{{.Names}}").stdout.split()
    assert SETUP_CONTAINER_NAME not in names and AGENT_CONTAINER_NAME not in names
    assert docker("network", "inspect", SETUP_NETWORK_NAME, check=False).returncode != 0


# #818-L01
def test_the_agent_starts_from_what_the_script_left_and_the_tracked_files_are_back(
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
                "cp /opt/setup-marker marker-copy.txt; git status --short > status.txt; "
                + inner
                + "git add marker-copy.txt status.txt images.txt && git commit -qm 'Use the setup'"
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
        assert prepared is not None and prepared.image is not None and prepared.error is None
        assert prepared.block is not None and prepared.block["ok"] is True
        assert "setup is done" in prepared.block["output"]
        # The agent started from the committed image: the file the script left in the container's
        # file system, and not in the repository, is there.
        tip = result.head_commit or ""
        shown = raw("show", f"{tip}:marker-copy.txt", cwd=turned.origin.path, git=turned.origin.git)
        assert shown.strip() == "made-by-setup"
        # What the script added to the repository is in the agent's tree (untracked); the tracked
        # file it changed was put back, so it is no change of the agent's.
        status = raw("show", f"{tip}:status.txt", cwd=turned.origin.path, git=turned.origin.git)
        assert "?? setup-made.txt" in status and "README.md" not in status
        assert any(
            "1 tracked file(s) the script changed were put back" in n for n in prepared.notes
        )
        assert [f.path for f in result.files_changed if f.path == "README.md"] == []
        if under_sysbox:
            images = raw("show", f"{tip}:images.txt", cwd=turned.origin.path, git=turned.origin.git)
            assert "tiny:setup" in images
        # The image is the one that was committed, by repository and tag, and the Setup container
        # and its network are gone.
        assert (
            docker("image", "inspect", IMAGE, "--format", "{{.Id}}").stdout.strip()
            == prepared.image
        )
    nothing_of_the_setup_is_left()


# #818-L02
def test_a_script_that_fails_ends_before_the_model_and_leaves_its_output(tmp_path: Path) -> None:
    with lane_environment(tmp_path, "echo about to fail\necho oops >&2\nexit 3\n") as (lane, step):
        assert step.error is not None and step.error.code is ErrorCode.ENVIRONMENT_SETUP_FAILED
        assert step.image is None
        block = step.block
        assert block is not None and block["ok"] is False and block["exitCode"] == 3
        assert block["timedOut"] is False
        assert "about to fail" in block["output"] and "oops" in block["output"]
        # No door, no model network and no agent: the model was never within reach.
        assert docker("network", "inspect", "code-reviewer-model", check=False).returncode != 0
        assert docker("image", "inspect", IMAGE, check=False).returncode != 0
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
def test_the_setup_container_has_no_secret_of_any_kind(tmp_path: Path) -> None:
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
        # The image it makes carries none either.
        config = docker("image", "inspect", IMAGE, "--format", "{{json .Config.Env}}").stdout
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
def test_the_setup_container_cannot_reach_the_vms_services_over_ipv4_or_ipv6(
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
sysctl -qw net.ipv6.conf.all.disable_ipv6=0 net.ipv6.conf.eth0.disable_ipv6=0 || true
sleep 3; ping -6 -c1 -W1 ff02::1%eth0 >/dev/null 2>&1
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
    finally:
        server.close()
    nothing_of_the_setup_is_left()


# #818-L08
def test_a_turn_without_an_environment_makes_no_setup_container_and_no_image(
    tmp_path: Path,
) -> None:
    def script(repo: Path) -> list[Turn]:
        return [write_file(repo, "hello.txt"), commit("Add hello"), says("Done.")]

    with lane_turn(tmp_path, script) as turned:
        assert turned.result.ok, (turned.result.error_code, turned.result.notes)
        assert turned.setup is None
        assert docker("image", "inspect", IMAGE, check=False).returncode != 0
        assert docker("network", "inspect", SETUP_NETWORK_NAME, check=False).returncode != 0
        calls = [
            n for n in docker("ps", "-a", "--format", "{{.Names}}").stdout.split()
            if n == SETUP_CONTAINER_NAME
        ]  # fmt: skip
        assert calls == []
