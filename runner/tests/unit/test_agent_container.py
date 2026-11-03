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
from code_reviewer_runner.implementer import exec_pipe
from code_reviewer_runner.implementer import reader as ac_reader
from code_reviewer_runner.implementer.agent_container import (
    AGENT_CONTAINER_NAME,
    AgentContainer,
    AgentSeams,
    agent_document,
)
from code_reviewer_runner.implementer.docker_api import DockerApi
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
        self.execs: list[tuple[list[str], dict[str, str], str | None]] = []
        # What was written to the files of the engine's configuration: path -> bytes.
        self.written: dict[str, bytes] = {}
        self.engine.exec_behaviour = self.behave
        self.relay_port: int | None = None
        self._tries = 0

    def api(self) -> DockerApi:
        return DockerApi(str(self.socket), timeout=5.0)

    def seams(self, **options: Any) -> AgentSeams:
        base: dict[str, Any] = {
            "api": self.api,
            "hostname": lambda: HOSTNAME,
            "ready_seconds": 5.0,
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
    # same one the agent runs under, and not a capability. Nothing is added, and above all not
    # DAC_READ_SEARCH and DAC_OVERRIDE as host root (`open_by_handle_at` reaches the VM's files).
    assert host["Runtime"] == "sysbox-runc"
    assert "CapAdd" not in host and "CapDrop" not in host
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
        assert "CapAdd" not in document["HostConfig"]


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
