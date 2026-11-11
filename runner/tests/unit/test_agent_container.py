# SPDX-License-Identifier: LicenseRef-Proprietary

"""The agent's container, the reader and the pipe between them (#745, step 4), against the fake
Docker Engine of `fakes/docker_engine`.

The questions are the ones the plan asks: what the daemon is asked for (a Sysbox container on the
model network with the repository and nothing else, no secret in any body), that Control drives it
only outward (an exec per connection, no address of Control's anywhere), that a dead container is
named and honest, that the reader has no network and no token, and that what a hostile repository
makes git run runs there."""

import json
import os
import socket
import sys
import tempfile
import threading
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any, BinaryIO

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from fakes.docker_engine.server import (
    AGENT_IMAGE_ID,
    HOSTNAME,
    IMAGE_ID,
    WORK_VOLUME,
    FakeDockerEngine,
    FakeExec,
)

from code_reviewer_runner.dynamic_review.model_door_route import (
    MODEL_AGENT_ADDRESS,
    MODEL_NETWORK_NAME,
)
from code_reviewer_runner.implementer import agent_container as ac
from code_reviewer_runner.implementer import exec_pipe, host_rules
from code_reviewer_runner.implementer import reader as ac_reader
from code_reviewer_runner.implementer.agent_container import (
    AGENT_CONTAINER_NAME,
    Adopted,
    AgentContainer,
    AgentSeams,
    agent_document,
    docker_environment_file,
    proxy_environment,
)
from code_reviewer_runner.implementer.claude_code.agent import ClaudePlace
from code_reviewer_runner.implementer.docker_api import DockerApi
from code_reviewer_runner.implementer.door_launcher import network_document
from code_reviewer_runner.implementer.network_rule import MODE_LIST, OFF, NetworkRule
from code_reviewer_runner.implementer.reader import (
    READER_CONTAINER_NAME,
    READER_WRITER_CONTAINER_NAME,
    ReaderAccess,
    ReaderSeams,
    reader_document,
)
from code_reviewer_runner.job import JobError
from code_reviewer_runner.result import ErrorCode

KEY = "sk-real-key-0123456789abcdef"
CAPABILITY = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo"


class Rig:
    def __init__(self, directory: Path) -> None:
        self.directory = directory
        self.socket = directory / "docker.sock"
        self.engine = FakeDockerEngine(self.socket).start()
        self.ready_after = 0
        # A container without an inner Docker (the test lane under `runc`).
        self.no_inner_docker = False
        self.execs: list[tuple[list[str], dict[str, str], str | None]] = []
        # What was written to the files of the engine's configuration: path -> bytes.
        self.written: dict[str, bytes] = {}
        self.engine.exec_behaviour = self.behave
        self.relay_port: int | None = None
        self._tries = 0
        # The VM's memory as `MemoryGuard` reads it: plenty, until a test says otherwise.
        self.meminfo = directory / "meminfo"
        self.set_available(6_000_000)
        # The model network the door's start made before the agent's container exists.
        DockerApi(str(self.socket), timeout=5.0).create_network(network_document())

    def set_available(self, kib: int) -> None:
        self.meminfo.write_text(
            f"MemTotal: 8000000 kB\nMemFree: {kib} kB\nMemAvailable: 7000000 kB\n"
            "Active(file): 1 kB\nInactive(file): 1 kB\n"
        )

    def api(self) -> DockerApi:
        return DockerApi(str(self.socket), timeout=5.0)

    def seams(self, **options: Any) -> AgentSeams:
        base: dict[str, Any] = {
            "api": self.api,
            "hostname": lambda: HOSTNAME,
            "ready_seconds": 5.0,
            "meminfo": str(self.meminfo),
        }
        base.update(options)
        return AgentSeams(**base)

    def behave(self, made: FakeExec, stdin: BinaryIO, stdout: Any) -> int:
        argv: list[str] = made.document["Cmd"]
        env = dict(item.split("=", 1) for item in made.document.get("Env", []))
        self.execs.append((argv, env, made.document.get("WorkingDir")))
        if argv[:3] == ["/bin/sh", "-c", ac.WRITE_FILE_SCRIPT]:
            self.written[argv[4]] = stdin.read()
            return 0
        if argv[:3] == ["/bin/sh", "-c", ac.RESTART_DOCKER_SCRIPT]:
            self.written[argv[4]] = stdin.read()
            stdout.write(ac.NO_DOCKER + "\n" if self.no_inner_docker else "restarting\n")
            return 0
        if argv[:2] == ["/usr/bin/test", "-e"]:
            self._tries += 1
            return 0 if self._tries > self.ready_after else 1
        if argv[:3] == [ac.PYTHON, "-I", "-c"] and self.relay_port is not None:
            # The relay of the tunnel: bytes in go to the "engine", bytes out come back.
            with socket.create_connection(("127.0.0.1", self.relay_port), timeout=5) as engine:

                def up() -> None:
                    while data := stdin.read(65536):
                        engine.sendall(data)
                    engine.shutdown(socket.SHUT_WR)

                threading.Thread(target=up, daemon=True).start()
                while data := engine.recv(65536):
                    stdout.write(data.decode("latin-1"))
            return 0
        return 0

    def stop(self) -> None:
        self.engine.stop()


@pytest.fixture
def rig() -> Iterator[Rig]:
    with tempfile.TemporaryDirectory(dir="/tmp", prefix="agent-") as directory:
        made = Rig(Path(directory))
        yield made
        made.stop()


def container(made: Rig, memory_mb: int = 2560) -> AgentContainer:
    return AgentContainer(memory_mb, made.seams())


def everything_sent(engine: FakeDockerEngine) -> str:
    return json.dumps([[method, target, body] for method, target, body in engine.calls])


# -- the definition -----------------------------------------------------------------------------


# #745-T20
def test_the_agent_container_is_a_sysbox_container_on_the_model_network_with_the_repository_only(
    rig: Rig,
) -> None:
    place = container(rig)
    place.create()

    made = rig.engine.container(AGENT_CONTAINER_NAME)
    assert made.document == agent_document(AGENT_IMAGE_ID, WORK_VOLUME, 2560 * 1024 * 1024)
    host = made.document["HostConfig"]
    assert host["Runtime"] == "sysbox-runc" and host["Privileged"] is False
    assert host["NetworkMode"] == MODEL_NETWORK_NAME
    endpoint = made.document["NetworkingConfig"]["EndpointsConfig"][MODEL_NETWORK_NAME]
    assert endpoint["IPAMConfig"]["IPv4Address"] == MODEL_AGENT_ADDRESS
    assert host["Mounts"] == [
        {
            "Type": "volume",
            "Source": WORK_VOLUME,
            "Target": "/work/repo",
            "ReadOnly": False,
            "VolumeOptions": {"Subpath": "repo", "NoCopy": True},
        }
    ], "the repository (the Subpath of the work volume), so the mirror is out of its reach"
    assert host["Memory"] == host["MemorySwap"] == 2560 * 1024 * 1024
    # The VM's OOM killer takes the agent's processes before anything of Control's (#745, step 6).
    assert host["OomScoreAdj"] == 1000
    assert not host.get("Binds") and not host.get("Devices") and not host.get("CapAdd")
    assert made.document["User"] == "0:0" and made.document["Env"] == []
    place.stop()


# #745-T20
def test_nothing_of_a_job_the_key_or_the_agents_output_is_in_any_request(rig: Rig) -> None:
    place = container(rig)
    place.create()
    place.write_files({"opencode.json": (b'{"apiKey": "bearer-only"}', 0o600)})
    assert rig.written["/etc/code-reviewer/opencode.json"] == b'{"apiKey": "bearer-only"}'
    place.start_engine(["opencode", "serve"], {"HOME": "/root"})
    place.stop()

    sent = everything_sent(rig.engine)
    assert KEY not in sent and CAPABILITY not in sent
    assert "docker.sock" not in sent, "no socket is mounted anywhere"


# #745-T20
def test_the_container_is_read_back_and_a_definition_that_is_not_what_was_asked_ends_the_turn(
    rig: Rig,
) -> None:
    def privileged(answer: dict[str, Any]) -> dict[str, Any]:
        answer["HostConfig"] = {**answer["HostConfig"], "Privileged": True}
        return answer

    rig.engine.inspect_override[AGENT_CONTAINER_NAME] = privileged
    place = container(rig)

    with pytest.raises(JobError) as refused:
        place.create()

    assert refused.value.code is ErrorCode.SETUP_FAILED
    assert "agent_container_unavailable" in refused.value.detail
    assert rig.engine.container(AGENT_CONTAINER_NAME).removed, "and it is taken away"


# #745-T20
@pytest.mark.parametrize(
    "changes",
    [
        {"Binds": ["/var/run/docker.sock:/var/run/docker.sock"]},
        {"Devices": [{"PathOnHost": "/dev/kvm"}]},
        {"PidMode": "host"},
        {"Runtime": "runc"},
    ],
)
def test_each_way_to_the_vm_in_the_definition_is_refused(rig: Rig, changes: dict[str, Any]) -> None:
    rig.engine.inspect_override[AGENT_CONTAINER_NAME] = lambda answer: {
        **answer,
        "HostConfig": {**answer["HostConfig"], **changes},
    }

    with pytest.raises(JobError):
        container(rig).create()


# #745-T20
def test_another_network_or_another_mount_is_refused(rig: Rig) -> None:
    rig.engine.inspect_override[AGENT_CONTAINER_NAME] = lambda answer: {
        **answer,
        "NetworkSettings": {"Networks": {MODEL_NETWORK_NAME: {}, "bridge": {}}},
    }
    with pytest.raises(JobError):
        container(rig).create()


# #745-T20
def test_a_daemon_without_the_sysbox_runtime_or_the_agent_image_is_the_free_setup_failure(
    rig: Rig,
) -> None:
    rig.engine.runtimes = {"runc": {}}
    with pytest.raises(JobError) as no_runtime:
        container(rig).create()
    rig.engine.runtimes = {"runc": {}, "sysbox-runc": {}}
    rig.engine.images = {}
    with pytest.raises(JobError) as no_image:
        container(rig).create()

    for refused in (no_runtime, no_image):
        assert refused.value.code is ErrorCode.SETUP_FAILED
        assert refused.value.detail.startswith("agent_container_unavailable:")
    assert not any(c.name == AGENT_CONTAINER_NAME for c in rig.engine.containers.values())


# #745-T20
def test_the_inner_docker_has_to_say_ready_and_a_container_that_never_does_is_given_up_on(
    rig: Rig,
) -> None:
    rig.ready_after = 2
    container(rig).create()
    assert sum(1 for argv, _, _ in rig.execs if argv[:2] == ["/usr/bin/test", "-e"]) == 3

    slow = Rig(rig.directory / "slow") if (rig.directory / "slow").mkdir() is None else rig
    slow.ready_after = 10_000
    with pytest.raises(JobError) as late:
        AgentContainer(2560, slow.seams(ready_seconds=0.5)).create()
    assert "did not become ready" in late.value.detail
    slow.stop()


# #827-T03: a start that failed leaves no guard behind (it would read /proc/meminfo for ever)
@pytest.mark.parametrize("how", ["not ready", "sealed wrong"])
def test_a_failed_start_closes_the_memory_guard(rig: Rig, how: str) -> None:
    if how == "not ready":
        rig.ready_after = 10_000
    else:
        rig.engine.inspect_override[AGENT_CONTAINER_NAME] = lambda a: {
            **a,
            "HostConfig": {**a["HostConfig"], "Privileged": True},
        }
    place = AgentContainer(2560, rig.seams(ready_seconds=0.3))
    with pytest.raises(JobError):
        place.create()
    guard = place._guard  # pyright: ignore[reportPrivateUsage]
    assert guard is not None
    # A closed guard ends its thread: waited for, not guessed at by the time a look takes (the
    # look that was running when it was closed may still write what it read).
    guard._thread.join(timeout=5.0)  # pyright: ignore[reportPrivateUsage]
    assert not guard._thread.is_alive(), "the guard is still looking"  # pyright: ignore[reportPrivateUsage]
    looked = place.lowest_left
    rig.set_available(300_000)  # below the floor: a guard still running would see it
    time.sleep(0.5)  # five looks of a guard
    assert place.lowest_left == looked


# #745-T20: the lane without Sysbox starts the real image under runc with an entrypoint of its own
def test_the_runtime_and_the_entrypoint_are_seams_and_production_leaves_them_alone(
    rig: Rig,
) -> None:
    default = agent_document(AGENT_IMAGE_ID, WORK_VOLUME, 1024)
    assert default["HostConfig"]["Runtime"] == "sysbox-runc"
    assert default["Entrypoint"] == ["/usr/bin/tini", "--", "/usr/local/bin/agent-init"]
    assert AgentSeams().runtime == "sysbox-runc" and AgentSeams().entrypoint is None

    lane = agent_document(
        AGENT_IMAGE_ID, WORK_VOLUME, 1024, runtime="runc", entrypoint=["/bin/sh", "-c", "sleep 1"]
    )
    assert lane["HostConfig"]["Runtime"] == "runc"
    assert lane["Entrypoint"] == ["/bin/sh", "-c", "sleep 1"]

    rig.engine.runtimes.pop("sysbox-runc")
    AgentContainer(
        1024, rig.seams(runtime="runc", entrypoint=["/usr/bin/tini", "--", "/bin/sh"])
    ).create()
    made = rig.engine.container(AGENT_CONTAINER_NAME)
    assert made.document["HostConfig"]["Runtime"] == "runc"
    assert made.document["Entrypoint"] == ["/usr/bin/tini", "--", "/bin/sh"]


# #856-P01: only the Claude Code agent's container is made with no-new-privileges
def test_the_hosted_agent_container_is_not_sealed_against_new_privileges(rig: Rig) -> None:
    AgentContainer(1024, rig.seams()).create()

    assert "SecurityOpt" not in rig.engine.container(AGENT_CONTAINER_NAME).document["HostConfig"]


# #856-P01
def test_the_seam_makes_the_agent_container_without_new_privileges(rig: Rig) -> None:
    AgentContainer(1024, rig.seams(no_new_privileges=True)).create()

    host = rig.engine.container(AGENT_CONTAINER_NAME).document["HostConfig"]
    assert host["SecurityOpt"] == ["no-new-privileges"] and host["Privileged"] is False


# -- driving it only outward --------------------------------------------------------------------


# #745-T21
def test_the_config_goes_in_through_an_exec_and_the_engine_starts_with_an_exec_not_a_port(
    rig: Rig,
) -> None:
    place = container(rig)
    place.create()

    place.write_files({"implementer-instructions.md": (b"rules", 0o644)})
    url = place.start_engine(["/usr/local/bin/opencode", "serve"], {"HOME": "/root"})

    assert rig.written == {"/etc/code-reviewer/implementer-instructions.md": b"rules"}
    (written,) = [e for e in rig.execs if e[0][:3] == ["/bin/sh", "-c", ac.WRITE_FILE_SCRIPT]]
    assert written[0][-2:] == ["/etc/code-reviewer/implementer-instructions.md", "644"]
    assert b"rules" not in json.dumps(written[0]).encode(), "the content is on stdin, not in argv"
    started = [e for e in rig.execs if e[0][-2:] == ["/usr/local/bin/opencode", "serve"]]
    assert started and started[0][1] == {"HOME": "/root"} and started[0][2] == "/work/repo"
    assert url.startswith("http://127.0.0.1:"), (
        "a loopback listener of Control, not an address in the agent"
    )
    place.stop()


# #745-T21
def test_a_file_that_cannot_be_written_ends_the_turn_free(rig: Rig) -> None:
    place = container(rig)
    place.create()
    rig.engine.exec_behaviour = lambda made, stdin, stdout: 1

    with pytest.raises(JobError) as refused:
        place.write_files({"opencode.json": (b"{}", 0o600)})

    assert refused.value.code is ErrorCode.SETUP_FAILED
    place.stop()


# #745-T21
def test_a_connection_to_the_tunnel_is_an_exec_that_relays_to_the_engines_port(rig: Rig) -> None:
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen(4)
    rig.relay_port = server.getsockname()[1]

    def engine() -> None:
        connection, _ = server.accept()
        request = connection.recv(4096)
        connection.sendall(b"echo:" + request)
        connection.shutdown(socket.SHUT_WR)

    threading.Thread(target=engine, daemon=True).start()
    place = container(rig)
    place.create()
    url = place.start_engine(["opencode", "serve"], {})
    host, port = url.removeprefix("http://").split(":")

    with socket.create_connection((host, int(port)), timeout=5) as client:
        client.sendall(b"hello")
        client.shutdown(socket.SHUT_WR)
        got = b""
        while chunk := client.recv(4096):
            got += chunk

    assert got == b"echo:hello"
    relays = [argv for argv, _, _ in rig.execs if argv[:3] == [ac.PYTHON, "-I", "-c"]]
    assert relays and relays[0][-1] == str(ac.ENGINE_PORT), "the port is the only argument"
    place.stop()
    server.close()


# #745-T21
def test_nothing_in_the_definition_lets_the_agent_connect_to_control(rig: Rig) -> None:
    place = container(rig)
    place.create()
    place.start_engine(["opencode"], {})

    document = json.dumps(rig.engine.container(AGENT_CONTAINER_NAME).document)
    assert "10.213.77.3" not in document, "Control has no address on the model network"
    own = rig.engine.networks
    assert not own or all(
        "c0ffee" not in member for network in own.values() for member in network["members"]
    )
    place.stop()


# -- when the container ends --------------------------------------------------------------------


def wait_for(check: Callable[[], bool], seconds: float = 3.0) -> bool:
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if check():
            return True
        time.sleep(0.01)
    return False


# #745-T22
def test_a_container_killed_for_its_memory_is_named_with_its_exit_code(rig: Rig) -> None:
    place = container(rig)
    place.create()
    place.start_engine(["opencode"], {})

    rig.engine.kill(AGENT_CONTAINER_NAME, exit_code=137, oom=True)

    assert wait_for(lambda: place.lost is not None)
    lost = place.lost
    assert lost is not None and lost.out_of_memory and lost.exit_code == 137
    assert "killed for its memory" in lost.sentence() and "(exit code 137)" in lost.sentence()
    assert place.engine_end_note() == lost.sentence()
    assert not place.engine_running()


# #745-S6-07
def test_the_vm_running_out_of_memory_ends_the_agent_and_says_so(rig: Rig) -> None:
    place = container(rig)
    place.create()
    place.start_engine(["opencode"], {})
    assert place.lost is None

    rig.set_available(300_000)  # 293 MiB of 7.6 GiB: below the floor (8%)

    assert wait_for(lambda: place.lost is not None)
    lost = place.lost
    assert lost is not None and lost.vm_memory and lost.unexpected
    assert "because the VM was running out of memory" in lost.sentence()
    assert lost.sentence().startswith("vm_memory: "), "the reason word starts the detail"
    made = rig.engine.container(AGENT_CONTAINER_NAME)
    assert made.exit_code == 137, "the container was killed"
    assert place.engine_end_note() == lost.sentence()


# #745-S6-07
def test_a_vm_with_room_leaves_the_agent_alone_and_a_stop_is_not_a_memory_kill(rig: Rig) -> None:
    place = container(rig)
    place.create()
    place.start_engine(["opencode"], {})

    time.sleep(0.5)  # five looks of the guard
    assert place.lost is None
    assert place.stop() is True
    rig.set_available(1000)  # too late to matter: the turn is over
    time.sleep(0.3)
    assert place.lost is None


# #745-T22
def test_stop_kills_the_container_waits_until_it_is_gone_and_is_not_a_loss(rig: Rig) -> None:
    place = container(rig)
    place.create()
    place.start_engine(["opencode"], {})

    gone = place.stop()

    assert gone is True
    made = rig.engine.container(AGENT_CONTAINER_NAME)
    assert made.exit_code == 137
    assert not made.removed, "the removal is not part of the stop: it comes after the push"
    assert place.lost is None, "an end that Control asked for is not the agent's crash"
    assert place.stop() is True, "twice is safe"

    place.remove()

    assert made.removed
    place.remove()  # twice is safe


# #745-T22
def test_the_engine_process_ending_alone_is_the_engine_not_running_while_the_container_lives(
    rig: Rig,
) -> None:
    place = container(rig)
    place.create()
    place.start_engine(["opencode"], {})
    assert wait_for(lambda: not place.engine_running())  # the fake's exec ends at once
    assert place.lost is None
    place.stop()


# -- the reader ---------------------------------------------------------------------------------


# #745-T23
def test_the_reader_runs_under_sysbox_with_no_added_capability_no_network_no_token_no_socket() -> (
    None
):
    document = reader_document(IMAGE_ID, WORK_VOLUME)

    host = document["HostConfig"]
    # Agent-planted code runs here (a `core.fsmonitor`, a filter): the wall is the runtime, the
    # same one the agent runs under. Every capability is dropped and the one that is needed is
    # added back: DAC_OVERRIDE, to read and write what the agent's other users made. Never
    # DAC_READ_SEARCH (`open_by_handle_at` reaches the VM's files as host root). Sysbox gives root
    # all of them whatever the container says (measured), so every command also drops them itself.
    assert host["Runtime"] == "sysbox-runc"
    assert host["CapDrop"] == ["ALL"] and host["CapAdd"] == ["DAC_OVERRIDE"]
    assert host["NetworkMode"] == "none" and document["NetworkDisabled"] is True
    assert host["Privileged"] is False and host["ReadonlyRootfs"] is True
    assert host["SecurityOpt"] == ["no-new-privileges:true"]
    assert host["Memory"] == host["MemorySwap"] == 256 * 1024 * 1024, "small, and counted in full"
    assert host["Mounts"] == [
        {
            "Type": "volume",
            "Source": WORK_VOLUME,
            "Target": "/repo",
            "ReadOnly": True,
            "VolumeOptions": {"Subpath": "repo", "NoCopy": True},
        }
    ]
    assert "Binds" not in host and "docker.sock" not in json.dumps(document)
    assert document["Env"] == ["PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/tmp"], "no secret"


# #745: a repository of a few GB must not OOM-kill pack-objects in the small reader
def test_the_readers_git_streams_large_blobs_instead_of_holding_them_in_memory() -> None:
    options = list(ac_reader.READER_GIT_OPTIONS)

    assert options[options.index("core.bigFileThreshold=1m") - 1] == "-c"
    assert ac_reader.reader_argv(["status"])[-1] == "status"
    assert "core.bigFileThreshold=1m" in ac_reader.reader_argv(["upload-pack", "/repo"])


# #745-T23
def test_the_volume_is_read_only_for_the_reader_wherever_git_allows_it() -> None:
    reading = reader_document(IMAGE_ID, WORK_VOLUME)
    writing = reader_document(IMAGE_ID, WORK_VOLUME, writable=True)

    assert reading["HostConfig"]["Mounts"][0]["ReadOnly"] is True
    assert writing["HostConfig"]["Mounts"][0]["ReadOnly"] is False
    # The writer differs in that one thing and in the label that tells it apart.
    assert writing["Labels"] != reading["Labels"]
    for document in (reading, writing):
        assert document["HostConfig"]["Runtime"] == "sysbox-runc"
        assert document["HostConfig"]["CapDrop"] == ["ALL"]
        assert document["HostConfig"]["CapAdd"] == ["DAC_OVERRIDE"]


# #745-T23
def test_the_reader_is_made_on_the_first_command_runs_git_in_the_repository_and_is_removed(
    rig: Rig,
) -> None:
    access = ReaderAccess(
        {"GIT_AUTHOR_NAME": "Implementer"}, ReaderSeams(rig.api, lambda: HOSTNAME)
    )
    assert not any(c.name == READER_CONTAINER_NAME for c in rig.engine.containers.values())

    done = access.run(["status", "--porcelain"], timeout=5.0)
    access.run(["rev-parse", "HEAD"], timeout=5.0)

    assert done.returncode == 0
    assert sum(1 for c in rig.engine.containers.values() if c.name == READER_CONTAINER_NAME) == 1
    argv, env, workdir = rig.execs[0]
    # Nothing the agent planted runs if an option can prevent it: the container is the wall, these
    # are the cheap extra (the fsmonitor and the hooks of the repository's config, background work).
    assert argv == [
        "/usr/bin/setpriv",
        "--bounding-set=-all,+dac_override",
        "--inh-caps=-all",
        "--no-new-privs",
        "/usr/local/bin/git",
        *ac_reader.READER_GIT_OPTIONS,
        "status",
        "--porcelain",
    ]
    assert "core.fsmonitor=false" in argv and "core.hooksPath=/dev/null" in argv
    assert "safe.directory=/repo" in argv
    assert workdir == "/repo" and env["GIT_AUTHOR_NAME"] == "Implementer"
    assert env["GIT_CONFIG_GLOBAL"] == "/dev/null" and "TOKEN" not in json.dumps(env).upper()
    access.close()
    assert rig.engine.container(READER_CONTAINER_NAME).removed


# #745-T23
def test_a_read_runs_in_the_read_only_reader_and_a_write_in_a_second_one_made_when_needed(
    rig: Rig,
) -> None:
    access = ReaderAccess(None, ReaderSeams(rig.api, lambda: HOSTNAME))

    access.run(["status"], timeout=5.0)
    access.stream(["for-each-ref"], lambda chunk: None, timeout=5.0)

    names = {c.name for c in rig.engine.containers.values()}
    assert READER_CONTAINER_NAME in names and READER_WRITER_CONTAINER_NAME not in names

    access.run(["add", "-A"], timeout=5.0, write=True)
    access.run(["rev-parse", "HEAD"], timeout=5.0)

    reading = rig.engine.container(READER_CONTAINER_NAME)
    writing = rig.engine.container(READER_WRITER_CONTAINER_NAME)
    assert reading.document["HostConfig"]["Mounts"][0]["ReadOnly"] is True
    assert writing.document["HostConfig"]["Mounts"][0]["ReadOnly"] is False
    went_to = [(made.document["Cmd"][-1], made.container) for made in rig.engine.execs.values()]
    assert went_to == [
        ("status", READER_CONTAINER_NAME),
        ("for-each-ref", READER_CONTAINER_NAME),
        ("-A", READER_WRITER_CONTAINER_NAME),
        ("HEAD", READER_CONTAINER_NAME),
    ]
    access.close()
    assert reading.removed and writing.removed


# #745-T23: nothing has to be created at the end, when the VM's disk may be full
def test_both_readers_are_made_before_the_agent_runs(rig: Rig) -> None:
    access = ReaderAccess(None, ReaderSeams(rig.api, lambda: HOSTNAME))

    assert access.warm() is True

    names = {c.name for c in rig.engine.containers.values()}
    assert {READER_CONTAINER_NAME, READER_WRITER_CONTAINER_NAME} <= names
    count = len(rig.engine.containers)
    access.run(["status"], timeout=5.0)
    access.run(["add", "-A"], timeout=5.0, write=True)
    assert len(rig.engine.containers) == count, "no container is made by a command"
    access.close()


# #745-T23
def test_a_reader_that_cannot_be_made_fails_the_warm_up_so_the_turn_ends_free(rig: Rig) -> None:
    rig.engine.refuse["/containers/create"] = 500
    access = ReaderAccess(None, ReaderSeams(rig.api, lambda: HOSTNAME))

    assert access.warm() is False


# #745-T23: a process a filter left behind (`setsid`) lives in the reader until the reader is killed
def test_the_readers_are_killed_and_started_again_so_that_no_process_of_the_repository_survives(
    rig: Rig,
) -> None:
    access = ReaderAccess(None, ReaderSeams(rig.api, lambda: HOSTNAME))
    assert access.warm()
    before = {c.name: c.identifier for c in rig.engine.containers.values()}
    rig.engine.calls.clear()

    assert access.reset(seconds=5.0) is True

    ours = {made.identifier: made.name for made in rig.engine.containers.values()}
    steps = [
        (method, target.split("/")[2], target.split("/")[3].split("?")[0])
        for method, target, _ in rig.engine.calls
        if target.startswith("/containers/") and not target.endswith("/exec")
    ]
    for name in (READER_CONTAINER_NAME, READER_WRITER_CONTAINER_NAME):
        identifier = before[name]
        mine = [(method, step) for method, container, step in steps if container == identifier]
        # SIGKILL to the init takes the whole process tree of the container; then it is started.
        assert mine[0] == ("POST", "kill"), name
        assert ("POST", "start") in mine and mine.index(("POST", "kill")) < mine.index(
            ("POST", "start")
        ), name
        assert rig.engine.container(name).running and not rig.engine.container(name).removed
    assert set(ours.values()) >= {READER_CONTAINER_NAME, READER_WRITER_CONTAINER_NAME}
    # They still answer.
    assert access.run(["status"], timeout=5.0).returncode == 0
    assert access.run(["add", "-A"], timeout=5.0, write=True).returncode == 0
    access.close()


# #745-T23
def test_a_reader_that_cannot_be_restarted_is_made_again_and_a_reset_with_no_reader_is_a_noop(
    rig: Rig,
) -> None:
    access = ReaderAccess(None, ReaderSeams(rig.api, lambda: HOSTNAME))
    assert access.reset(seconds=5.0) is True, "nothing was made, nothing can survive"
    assert not rig.engine.containers
    assert access.warm()
    old = rig.engine.container(READER_CONTAINER_NAME).identifier
    rig.engine.refuse[f"/containers/{old}/kill"] = 500

    assert access.reset(seconds=5.0) is True

    names = [c.name for c in rig.engine.containers.values() if not c.removed]
    assert sorted(names) == [READER_CONTAINER_NAME, READER_WRITER_CONTAINER_NAME]
    assert rig.engine.container(READER_CONTAINER_NAME).identifier != old
    access.close()


# #745-T23: the writer is the one that can change the repository; a failed reset is said
def test_a_reset_that_cannot_make_the_readers_quiet_says_so_and_leaves_none_behind(
    rig: Rig,
) -> None:
    access = ReaderAccess(None, ReaderSeams(rig.api, lambda: HOSTNAME))
    assert access.warm()
    rig.engine.refuse["/kill"] = 500
    rig.engine.refuse["/containers/create"] = 500

    assert access.reset(seconds=5.0) is False

    done = access.run(["status"], timeout=5.0)
    assert done.unanswered, "a reader that is not known to be quiet is not used"
    access.close()


# #745-T23: a reader that cannot be restarted in time is not made again after the deadline
def test_a_reset_past_its_deadline_forgets_the_reader_instead_of_making_it_again(
    rig: Rig,
) -> None:
    access = ReaderAccess(None, ReaderSeams(rig.api, lambda: HOSTNAME))
    assert access.warm()
    rig.engine.refuse["/kill"] = 500
    rig.engine.calls.clear()

    assert access.reset(seconds=0.0) is False

    assert not [call for call in rig.engine.calls if call[1].startswith("/containers/create")]
    # The next command makes a new one, which is quiet: the old one is gone.
    assert access.run(["status"], timeout=5.0).returncode == 0
    access.close()


# #745-T23
def test_the_reader_is_made_under_the_runtime_the_seam_names(rig: Rig) -> None:
    access = ReaderAccess(None, ReaderSeams(rig.api, lambda: HOSTNAME, runtime="runc"))

    access.run(["status"], timeout=5.0)

    assert rig.engine.container(READER_CONTAINER_NAME).document["HostConfig"]["Runtime"] == "runc"
    access.close()


# #745-T23
def test_a_reader_that_cannot_be_made_is_an_unanswered_command_not_a_crash(rig: Rig) -> None:
    rig.engine.refuse["/containers/create"] = 500
    access = ReaderAccess(None, ReaderSeams(rig.api, lambda: HOSTNAME))

    done = access.run(["status"], timeout=5.0)

    assert done.unanswered and done.returncode == 255


# #745-T23
def test_the_streamed_output_of_a_command_goes_to_the_consumer_in_chunks(rig: Rig) -> None:
    def printing(made: FakeExec, stdin: BinaryIO, stdout: Any) -> int:
        stdout.write("refs/heads/a\nrefs/heads/b\n")
        return 0

    rig.engine.exec_behaviour = printing
    access = ReaderAccess(None, ReaderSeams(rig.api, lambda: HOSTNAME))
    seen = bytearray()

    done = access.stream(["for-each-ref"], seen.extend, timeout=5.0)

    assert done.returncode == 0 and bytes(seen) == b"refs/heads/a\nrefs/heads/b\n"
    access.close()


# #745-T23
def test_a_consumer_that_has_enough_ends_the_read(rig: Rig) -> None:
    class Enough(Exception):
        pass

    def printing(made: FakeExec, stdin: BinaryIO, stdout: Any) -> int:
        stdout.write("x" * 100)
        return 0

    rig.engine.exec_behaviour = printing
    access = ReaderAccess(None, ReaderSeams(rig.api, lambda: HOSTNAME))

    def consume(chunk: bytes) -> None:
        raise Enough

    with pytest.raises(Enough):
        access.stream(["status"], consume, timeout=5.0)
    access.close()


# #745-T23
def test_a_command_that_runs_past_its_time_is_unanswered(rig: Rig) -> None:
    release = threading.Event()

    def hanging(made: FakeExec, stdin: BinaryIO, stdout: Any) -> int:
        release.wait(5)
        return 0

    rig.engine.exec_behaviour = hanging
    access = ReaderAccess(None, ReaderSeams(rig.api, lambda: HOSTNAME))

    done = access.run(["fetch"], timeout=0.3)

    release.set()
    assert done.unanswered and done.returncode == 255
    access.close()


# #745-T23
def test_the_upload_pack_the_fetch_runs_is_the_pipe_module_not_a_command_of_the_repository() -> (
    None
):
    access = ReaderAccess(None)

    assert access.upload_pack() == (
        "/opt/venv/bin/python -I -m code_reviewer_runner.implementer.exec_pipe"
    )
    assert access.repo_source == "/work/repo"


# -- the pipe -----------------------------------------------------------------------------------


def pipe_run(
    rig: Rig, argv: list[str], environment: dict[str, str], payload: bytes
) -> tuple[int, bytes]:
    in_read, in_write = os.pipe()
    out_read, out_write = os.pipe()
    os.write(in_write, payload)
    os.close(in_write)
    code = exec_pipe.main(
        argv, environment, api=rig.api(), stdin_descriptor=in_read, stdout_descriptor=out_write
    )
    os.close(out_write)
    data = b""
    while chunk := os.read(out_read, 65536):
        data += chunk
    os.close(in_read)
    os.close(out_read)
    return code, data


@pytest.fixture
def reader_up(rig: Rig) -> Iterator[ReaderAccess]:
    access = ReaderAccess(None, ReaderSeams(rig.api, lambda: HOSTNAME))
    access.run(["status"], timeout=5.0)  # makes the reader
    rig.execs.clear()
    yield access
    access.close()


# #745-T24
def test_the_pipe_runs_upload_pack_in_the_reader_and_carries_the_streams_and_the_status(
    rig: Rig, reader_up: ReaderAccess
) -> None:
    def upload_pack(made: FakeExec, stdin: BinaryIO, stdout: Any) -> int:
        stdout.write("advertisement:" + stdin.read().decode())
        return 7

    rig.engine.exec_behaviour = upload_pack

    code, data = pipe_run(
        rig, ["/work/repo"], {"GIT_PROTOCOL": "version=2"}, b"0014command=ls-refs\n"
    )

    assert code == 7
    assert data == b"advertisement:0014command=ls-refs\n"
    (made,) = list(rig.engine.execs.values())[-1:]
    assert made.document["Cmd"] == [
        *ac_reader.READER_DROP_CAPABILITIES,
        "/usr/local/bin/git",
        *ac_reader.READER_GIT_OPTIONS,
        "upload-pack",
        "/repo",
    ]
    assert made.container == READER_CONTAINER_NAME, "a fetch only reads: the read-only reader"
    assert "GIT_PROTOCOL=version=2" in made.document["Env"]
    assert made.document["WorkingDir"] == "/repo"


# #745-T24
@pytest.mark.parametrize(
    ("argv", "environment"),
    [
        (["/work/repo", "--extra"], {}),
        (["/elsewhere"], {}),
        ([], {}),
        (["/work/repo"], {"GIT_PROTOCOL": "version=2;rm -rf /"}),
        (["/work/repo"], {"GIT_PROTOCOL": "x"}),
    ],
)
def test_the_pipe_takes_no_path_or_option_from_the_caller_and_checks_the_protocol(
    rig: Rig, reader_up: ReaderAccess, argv: list[str], environment: dict[str, str]
) -> None:
    code, _ = pipe_run(rig, argv, environment, b"")

    assert code == exec_pipe.USAGE_ERROR
    assert rig.execs == [], "nothing was started in the reader"


# #745-T24
def test_the_pipe_without_a_reader_is_unavailable_not_a_crash(rig: Rig) -> None:
    code, _ = pipe_run(rig, ["/work/repo"], {}, b"")

    assert code in (exec_pipe.UNAVAILABLE, exec_pipe.USAGE_ERROR)


# #818-T60
def test_the_vms_side_of_the_model_network_has_no_ipv6_address_before_the_agent_exists(
    rig: Rig,
) -> None:
    """Measured on a VM: root in a container on an internal, isolated network switches IPv6 on,
    finds the bridge's link-local address and reaches the VM's control port over it. Control takes
    the address off the bridge before the agent's container is made."""
    from code_reviewer_runner.implementer import host_rules

    container(rig).create()
    helpers = [c for c in rig.engine.containers.values() if c.name == host_rules.HELPER_NAME]
    assert [h.document["Labels"]["code-reviewer.role"] for h in helpers] == [
        "bridge-ipv6",
        "agent-ipv6-rules",
    ]
    helper = helpers[0]
    assert helper.document["Cmd"] == [
        "ip link set dev br-000000000000 addrgenmode none && ip -6 addr flush dev br-000000000000"
    ]
    host = helper.document["HostConfig"]
    assert host["NetworkMode"] == "host" and host["CapAdd"] == ["NET_ADMIN"]
    # The agent image, which has `ip`; never an image an environment's script made.
    assert helper.document["Image"] == "code-reviewer-agent:golden"
    created = [t for m, t, _ in rig.engine.calls if m == "POST" and "containers/create" in t]
    assert created[0].endswith(host_rules.HELPER_NAME)
    assert created[-1].endswith(AGENT_CONTAINER_NAME)


# #818-IPV6-03
def test_the_model_bridge_gets_an_inet_drop_of_its_own_and_a_kernel_without_one_is_no_failure(
    rig: Rig,
) -> None:
    from code_reviewer_runner.implementer import host_rules

    notes = container(rig).create()
    inet = [c for c in rig.engine.containers.values() if c.name == host_rules.HELPER_NAME][-1]
    assert inet.document["Cmd"] == [host_rules.inet_rules("agent", "br-000000000000")]
    assert notes == ()
    # Through a shell that tells a kernel with no `inet` family from one that refused the table.
    assert inet.document["Entrypoint"] == ["/bin/sh", "-c", host_rules.INET_SCRIPT, "inet-rules"]
    assert host_rules.NFT in host_rules.INET_SCRIPT
    # The Worker's image (it has `nft`), the image of the Control container, not the agent's.
    assert inet.document["Image"] != "code-reviewer-agent:golden"


# #818-IPV6-04
def test_a_kernel_without_the_inet_family_does_not_end_the_turn_and_needs_no_note(
    rig: Rig, caplog: pytest.LogCaptureFixture
) -> None:
    from code_reviewer_runner.implementer import host_rules

    rig.engine.inet_exit = host_rules.INET_NO_FAMILY_EXIT
    with caplog.at_level("INFO", logger=host_rules.__name__):
        notes = container(rig).create()
    assert notes == ()
    assert "the kernel has no inet family" in caplog.text
    assert "is not in place" not in caplog.text


# #818-IPV6-05
def test_a_kernel_with_the_inet_family_that_refuses_the_table_is_a_note_not_a_failure(
    rig: Rig, caplog: pytest.LogCaptureFixture
) -> None:
    from code_reviewer_runner.implementer import host_rules

    rig.engine.inet_exit = 1
    with caplog.at_level("WARNING", logger=host_rules.__name__):
        notes = container(rig).create()
    assert notes == (host_rules.inet_failure_note("model"),)
    assert "the inet table of the agent bridge is not in place" in caplog.text


# #818-T61
def test_a_model_network_that_cannot_be_closed_to_ipv6_ends_the_turn_free(rig: Rig) -> None:
    rig.engine.ipv6_exit = 1
    with pytest.raises(JobError) as refused:
        container(rig).create()
    assert refused.value.code is ErrorCode.SETUP_FAILED
    assert "IPv6" in refused.value.detail
    assert not any(c.name == AGENT_CONTAINER_NAME for c in rig.engine.containers.values())


# -- the result directory of a turn with a result schema (#843) ---------------------------------

RESULT_MOUNT = {
    "Type": "volume",
    "Source": WORK_VOLUME,
    "Target": "/work/result",
    "ReadOnly": False,
    "VolumeOptions": {"Subpath": "result", "NoCopy": True},
}


# #843-T60
def test_a_turn_without_a_result_schema_gets_the_container_of_before() -> None:
    document = agent_document(AGENT_IMAGE_ID, WORK_VOLUME, 1024)

    assert [m["Target"] for m in document["HostConfig"]["Mounts"]] == ["/work/repo"]
    assert document == agent_document(AGENT_IMAGE_ID, WORK_VOLUME, 1024, result=False)


# #843-T60
def test_a_turn_with_a_result_schema_gets_the_result_directory_beside_the_repository() -> None:
    document = agent_document(AGENT_IMAGE_ID, WORK_VOLUME, 1024, result=True)

    mounts = document["HostConfig"]["Mounts"]
    assert [m["Target"] for m in mounts] == ["/work/repo", "/work/result"]
    assert mounts[1] == RESULT_MOUNT, "the Subpath `result` of the volume, nothing else of it"
    assert "Binds" not in document["HostConfig"]


# #843-T60
def test_the_container_is_made_with_the_result_directory_and_the_seal_check_allows_it(
    rig: Rig,
) -> None:
    AgentContainer(2560, rig.seams(), result=True).create()

    made = rig.engine.container(AGENT_CONTAINER_NAME)
    assert made.document == agent_document(
        AGENT_IMAGE_ID, WORK_VOLUME, 2560 * 1024 * 1024, result=True
    )


# #843-T60
def test_a_result_mount_nobody_asked_for_is_refused_by_the_seal_check(rig: Rig) -> None:
    rig.engine.inspect_override[AGENT_CONTAINER_NAME] = lambda answer: {
        **answer,
        "Mounts": [*answer["Mounts"], {"Destination": "/work/result", "Type": "volume"}],
    }

    with pytest.raises(JobError):
        container(rig).create()


# #843-T61
def test_the_reader_sees_the_result_directory_read_only_when_the_turn_has_a_schema() -> None:
    plain = reader_document(IMAGE_ID, WORK_VOLUME)
    with_result = reader_document(IMAGE_ID, WORK_VOLUME, result=True)
    writer = reader_document(IMAGE_ID, WORK_VOLUME, writable=True, result=True)

    assert len(plain["HostConfig"]["Mounts"]) == 1
    for document in (with_result, writer):
        mount = document["HostConfig"]["Mounts"][1]
        assert mount == {**RESULT_MOUNT, "Target": "/result", "ReadOnly": True}
    assert with_result["HostConfig"]["Mounts"][0] == plain["HostConfig"]["Mounts"][0]


# #843-T61
def test_the_result_is_read_in_the_read_only_reader_by_a_constant_script_that_bounds_the_bytes(
    rig: Rig,
) -> None:
    def printing(made: FakeExec, stdin: BinaryIO, stdout: Any) -> int:
        stdout.write('{"findings": []}' + "x" * 100)
        return 0

    rig.engine.exec_behaviour = printing
    access = ReaderAccess(None, ReaderSeams(rig.api, lambda: HOSTNAME), result=True)

    raw = access.read_result(20)

    assert raw == b'{"findings": []}xxxx', "at most the bytes asked for are kept"
    argv = next(iter(rig.engine.execs.values())).document["Cmd"]
    assert argv[-6:] == [
        "/bin/sh",
        "-c",
        'test -f "$1" && test ! -L "$1" && head -c "$2" "$1"',
        "read",
        "/result/result.json",
        "20",
    ]
    assert argv[: len(ac_reader.READER_DROP_CAPABILITIES)] == list(
        ac_reader.READER_DROP_CAPABILITIES
    )
    names = {c.name for c in rig.engine.containers.values()}
    assert names == {READER_CONTAINER_NAME}, "the reader that cannot write"
    assert rig.engine.container(READER_CONTAINER_NAME).document["HostConfig"]["Mounts"][1][
        "ReadOnly"
    ]
    access.close()


# #843-T61
def test_a_missing_file_a_link_and_a_reader_that_cannot_run_are_no_result(rig: Rig) -> None:
    rig.engine.exec_behaviour = lambda made, stdin, stdout: 1
    access = ReaderAccess(None, ReaderSeams(rig.api, lambda: HOSTNAME), result=True)
    assert access.read_result(100) is None
    access.close()

    rig.engine.runtimes.pop("sysbox-runc")
    broken = ReaderAccess(None, ReaderSeams(rig.api, lambda: HOSTNAME), result=True)
    assert broken.read_result(100) is None


# #843-T62
def test_the_result_directory_is_made_by_control_once_and_not_through_a_link(
    tmp_path: Path,
) -> None:
    from code_reviewer_runner.implementer.result_channel import make_result_directory

    make_result_directory(tmp_path)

    assert (tmp_path / "result").is_dir() and (tmp_path / "result").stat().st_mode & 0o777 == 0o755
    with pytest.raises(FileExistsError):
        make_result_directory(tmp_path)


# #843-T62
def test_the_places_of_the_result_agree_across_the_finish_tool_and_the_containers() -> None:
    from code_reviewer_runner.implementer import agent as engine_agent
    from code_reviewer_runner.implementer import finish_tool
    from code_reviewer_runner.implementer import result_channel as rc

    assert f"{rc.AGENT_RESULT_DIRECTORY}/{rc.RESULT_FILE}" == finish_tool.RESULT_PATH
    assert rc.CONFIG_DIRECTORY == ac.AGENT_CONFIG_DIRECTORY == engine_agent.CONFIG_DIRECTORY
    assert rc.INTERPRETER == ac.PYTHON
    assert rc.READER_RESULT_DIRECTORY == "/result"


# #843-T62
def test_the_finish_files_are_the_module_under_an_isolated_shebang_and_the_schema() -> None:
    from code_reviewer_runner.implementer import finish_tool
    from code_reviewer_runner.implementer import result_channel as rc

    schema = {"type": "object", "properties": {"a": {"type": "string"}}}

    files = rc.finish_files(schema)

    program, mode = files["factory-submit"]
    assert mode == 0o755 and program.startswith(b"#!/usr/local/bin/python3 -I\n")
    assert program.split(b"\n", 1)[1] == Path(finish_tool.__file__).read_bytes()
    assert files["result-schema.json"] == (json.dumps(schema).encode(), 0o644)
    assert rc.finish_server_command() == (
        "/usr/local/bin/python3",
        "-I",
        "/etc/code-reviewer/factory-submit",
        "mcp",
    )


# -- a command whose output is read as it comes (#856) -------------------------------------------


# #856-T25
def test_a_streamed_command_runs_as_the_given_user_with_stdin_and_gives_its_output_as_it_comes(
    rig: Rig,
) -> None:
    seen: dict[str, Any] = {}

    def behave(made: FakeExec, stdin: BinaryIO, stdout: Any) -> int:
        if made.document["Cmd"][:1] != ["claude"]:
            return 0
        seen["user"] = made.document.get("User")
        seen["workdir"] = made.document.get("WorkingDir")
        seen["env"] = made.document.get("Env")
        seen["stdin"] = stdin.read()
        stdout.write('{"type": "a"}\n{"type": "b"}\n')
        return 3

    rig.engine.exec_behaviour = behave
    place = container(rig)
    place.create()
    chunks: list[bytes] = []

    done = place.run_streaming(
        ["claude", "-p"],
        {"HOME": "/home/agent"},
        user="10201:10201",
        stdin=b"the prompt",
        timeout=10,
        consume=chunks.append,
    )

    assert (seen["user"], seen["workdir"], seen["env"]) == (
        "10201:10201",
        "/work/repo",
        ["HOME=/home/agent"],
    )
    assert seen["stdin"] == b"the prompt"
    assert b"".join(chunks) == b'{"type": "a"}\n{"type": "b"}\n'
    assert done.returncode == 3 and not done.unanswered
    place.stop()


# #856-T25
def test_a_streamed_command_in_a_container_that_is_not_there_is_unanswered_not_raised() -> None:
    place = AgentContainer(2560, AgentSeams())
    harness_place: ClaudePlace = place  # the container is what the Claude Code agent drives

    done = harness_place.run_streaming(
        ["claude"], {}, user="10201:10201", stdin=b"", timeout=1, consume=lambda _: None
    )

    assert done.unanswered


# -- the container the setup script ran in (#1009) -----------------------------------------------

from code_reviewer_runner.implementer import setup_container as sc  # noqa: E402
from code_reviewer_runner.outer_proxy import OuterProxy  # noqa: E402

LIST_RULE = NetworkRule(MODE_LIST, ("registry.npmjs.org",))


def script_container(
    made: Rig, outer_proxy: OuterProxy | None = None, *, paused: bool = True
) -> Adopted:
    """What the setup step leaves: the agent's container on no network, frozen, started from the
    setup's definition (the proxy's variables, when there is a proxy)."""
    api = made.api()
    api.create_network(sc.network_document())
    identifier = api.create_container(
        sc.setup_document(
            AGENT_IMAGE_ID,
            WORK_VOLUME,
            2560 * 1024 * 1024,
            runtime="sysbox-runc",
            outer_proxy=outer_proxy,
        ),
        AGENT_CONTAINER_NAME,
    )
    api.start_container(identifier)
    api.disconnect_network(sc.SETUP_NETWORK_NAME, identifier)
    if paused:
        api.pause_container(identifier)
    return Adopted(
        identifier,
        setup_environment=() if outer_proxy is None else tuple(outer_proxy.tool_environment()),
        paused=paused,
        setup_network=sc.SETUP_NETWORK_NAME,
    )


def adopted_container(made: Rig, adopted: Adopted, rule: Any = OFF) -> AgentContainer:
    return AgentContainer(2560, made.seams(), rule, adopted=adopted)


def calls_of(made: Rig) -> list[str]:
    return [f"{m} {t.split('?')[0]}" for m, t, _ in made.engine.calls]


# #1009-A01
def test_an_adopted_container_is_put_on_the_model_network_and_is_the_same_container(
    rig: Rig,
) -> None:
    adopted = script_container(rig)
    before = set(rig.engine.containers)
    place = adopted_container(rig, adopted)

    notes = place.create()

    assert notes == ()
    agent = rig.engine.container(AGENT_CONTAINER_NAME)
    assert agent.identifier == adopted.container and not agent.removed
    assert not agent.paused, "unfrozen: its processes run again"
    assert set(agent.networks) == {MODEL_NETWORK_NAME}
    assert agent.networks[MODEL_NETWORK_NAME] == {
        "IPAMConfig": {"IPv4Address": MODEL_AGENT_ADDRESS}
    }
    # The setup network goes after the model network is joined, never before (the daemon refuses
    # to connect a container whose network mode is gone).
    names = calls_of(rig)
    connected = names.index(f"POST /networks/{MODEL_NETWORK_NAME}/connect")
    assert names.index(f"DELETE /networks/{sc.SETUP_NETWORK_NAME}") > connected
    assert sc.SETUP_NETWORK_NAME not in {n["Name"] for n in rig.engine.networks.values()}
    # Nothing was made, stopped, killed, committed or removed for it: only the IPv6 helpers.
    made = set(rig.engine.containers) - before
    assert {rig.engine.containers[i].name for i in made} == {host_rules.HELPER_NAME}
    names = calls_of(rig)
    assert not any(n.endswith("/kill") or n.endswith("/stop") for n in names)
    assert not any("create?name=code-reviewer-agent" in n for n in names)


# #1009-A02
def test_a_hosted_container_with_no_door_keeps_its_inner_docker_as_it_is(rig: Rig) -> None:
    place = adopted_container(rig, script_container(rig))
    place.create()
    assert ac.DOCKER_ENV_FILE not in rig.written, "no restart: no proxy changes"
    assert not any(e[0][:3] == ["/bin/sh", "-c", ac.RESTART_DOCKER_SCRIPT] for e in rig.execs)


# #1009-A03
def test_with_a_door_the_inner_docker_is_started_again_with_the_doors_proxy(rig: Rig) -> None:
    place = adopted_container(rig, script_container(rig), LIST_RULE)
    place.create()
    text = rig.written[ac.DOCKER_ENV_FILE].decode()
    assert f"HTTPS_PROXY={ac.NETWORK_DOOR_URL}\n" in text
    assert "NODE_USE_ENV_PROXY=1\n" in text
    # The restart is the last thing: the container was on the model network and sealed first.
    kinds = [e[0][:3] for e in rig.execs]
    assert kinds.count(["/bin/sh", "-c", ac.RESTART_DOCKER_SCRIPT]) == 1
    assert ac.RESTART_DOCKER_SCRIPT.count("kill -TERM") == 1
    # The inner containers keep running across it: the init starts the daemon with `--live-restore`
    # (`runner/docker/agent-init.sh`, pinned by `test_agent_init_script.py`).


# #1009-A04
def test_a_customers_machine_has_the_setups_proxy_in_the_daemon_until_it_is_started_again(
    rig: Rig,
) -> None:
    proxy = OuterProxy("172.31.0.13", 3128)
    place = adopted_container(rig, script_container(rig, proxy))
    place.create()
    # The rule is off: no door variable, but the setup's proxy must not stay in the daemon (it
    # would be a stale one): the file is there and empty, and the init unsets the old variables.
    assert rig.written[ac.DOCKER_ENV_FILE] == b""


# #1009-A05
def test_the_tools_of_an_adopted_container_get_the_doors_variables_and_the_setups_are_emptied(
    rig: Rig,
) -> None:
    proxy = OuterProxy("172.31.0.13", 3128)
    place = adopted_container(rig, script_container(rig, proxy), LIST_RULE)
    place.create()
    place.start_engine(["/usr/local/bin/opencode", "serve"], {"HOME": "/root"})
    env = next(e[1] for e in rig.execs if e[0][-2:] == ["/usr/local/bin/opencode", "serve"])
    door = proxy_environment(LIST_RULE)
    for name, value in door.items():
        assert env[name] == value
    assert env["HOME"] == "/root"
    # A name only the setup had is emptied, never left to the container's own environment.
    stale = {entry.partition("=")[0] for entry in proxy.tool_environment()} - set(door)
    assert all(env[name] == "" for name in stale)
    # The same for a command of the engine.
    place.run_command(["/usr/local/bin/opencode", "import"], {"HOME": "/root"}, 5.0)
    imported = next(e[1] for e in rig.execs if e[0][-1] == "import")
    assert imported["HTTPS_PROXY"] == ac.NETWORK_DOOR_URL


# #1009-A06
def test_a_container_that_is_not_a_container_made_for_the_agent_is_refused_even_when_adopted(
    rig: Rig,
) -> None:
    adopted = script_container(rig)
    rig.engine.inspect_override[AGENT_CONTAINER_NAME] = lambda a: {
        **a,
        "HostConfig": {**a["HostConfig"], "Privileged": True},
    }
    place = adopted_container(rig, adopted)
    with pytest.raises(JobError) as refused:
        place.create()
    assert refused.value.code is ErrorCode.SETUP_FAILED and "privileged" in refused.value.detail


# #1009-A07
def test_a_container_without_an_inner_docker_is_not_waited_for_after_the_restart_request(
    rig: Rig,
) -> None:
    rig.no_inner_docker = True
    place = adopted_container(rig, script_container(rig), LIST_RULE)
    place.create()
    tests = [e for e in rig.execs if e[0][:2] == ["/usr/bin/test", "-e"]]
    assert len(tests) == 1, "the ready check before the seal, and none after the restart request"


# #1009-A08
def test_the_environment_file_is_quoted_assignments_for_the_inits_shell() -> None:
    text = docker_environment_file({"HTTP_PROXY": "http://10.0.0.1:3128", "NO_PROXY": "a,b c"})
    assert text == "HTTP_PROXY=http://10.0.0.1:3128\nNO_PROXY='a,b c'\n"
    assert docker_environment_file({}) == ""


# #1009-A09
def test_the_restart_script_asks_the_daemon_to_end_and_the_init_to_start_it_again() -> None:
    script = ac.RESTART_DOCKER_SCRIPT
    assert ac.NO_DOCKER in script, "a container with no daemon has nothing to restart"
    assert script.index(ac.DOCKER_PID_FILE) < script.index("cat >") < script.index("kill -TERM")
    assert f"touch {ac.DOCKER_RESTART_FILE}" in script and f"rm -f {ac.READY_FILE}" in script
    assert script.index(f"touch {ac.DOCKER_RESTART_FILE}") < script.index("kill -TERM")
