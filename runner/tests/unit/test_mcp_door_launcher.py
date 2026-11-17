# SPDX-License-Identifier: LicenseRef-Proprietary

"""Control starts the MCP door through the VM's Docker (#1067), against the fake daemon.

What these tests hold: the daemon is asked for a door that is hardened by construction and holds no
environment variable; **the job's credential goes to the door's stdin and is in no request to the
daemon**; the door's egress rules go in before it is told anything; the door is the real code behind
the daemon's pipes and ends the MCP sessions when it is stopped; and a door that cannot start is a
`JobError` the session turns into a note."""

import http.client
import io
import json
import tempfile
from collections.abc import Iterator
from pathlib import Path
from typing import Any, BinaryIO

import pytest
from door_support import free_port, implementer_job_text
from fakes.docker_engine.server import HOSTNAME, IMAGE_ID, OWN_ID, FakeDockerEngine
from mcp_door_support import (
    JOB_CREDENTIAL,
    JOB_ID,
    SERVER_A,
    SERVER_B,
    FakeApp,
    jsonrpc,
)

from code_reviewer_runner.dynamic_review.model_door_route import (
    MCP_DOOR_ADDRESS,
    MCP_DOOR_PORT,
    MODEL_NETWORK_NAME,
)
from code_reviewer_runner.implementer.docker_api import DockerApi
from code_reviewer_runner.implementer.door_launcher import PRIVATE_RANGES
from code_reviewer_runner.implementer.mcpdoor.service import run_mcp_door
from code_reviewer_runner.implementer.mcpdoor_launcher import (
    MCPDOOR_CONTAINER_NAME,
    MCPDOOR_MEMORY_BYTES,
    RULES_CONTAINER_NAME,
    McpDoorSeams,
    RunningMcpDoor,
    door_document,
    rules_document,
    start_document,
    start_mcp_door,
)
from code_reviewer_runner.implementer.placement import Placement
from code_reviewer_runner.implementer.session import ImplementerSession, SessionSeams
from code_reviewer_runner.job import JobError, McpAccess, parse_implementer_input
from code_reviewer_runner.outer_proxy import OuterProxy

pytestmark = pytest.mark.integration


class Rig:
    """The fake daemon with the real MCP door behind it, and the seams that point Control at it."""

    def __init__(self, directory: Path, app: FakeApp) -> None:
        self.app = app
        self.port = free_port()
        self.engine = FakeDockerEngine(directory / "docker.sock", self.behave).start()
        self.api = DockerApi(str(directory / "docker.sock"), timeout=5.0)
        self.seams = McpDoorSeams(
            api=lambda: DockerApi(str(directory / "docker.sock"), timeout=5.0),
            hostname=lambda: HOSTNAME,
            ready_seconds=5.0,
            stop_seconds=15.0,
        )
        self.access = McpAccess(app.url, JOB_ID, JOB_CREDENTIAL)

    def behave(self, stdin: BinaryIO, stdout: Any, stderr: Any) -> int:
        text = io.TextIOWrapper(stdin, encoding="utf-8")
        return run_mcp_door(text, stdout, bind=("127.0.0.1", self.port))

    def start(
        self, servers: tuple[str, ...] = (SERVER_A, SERVER_B), **options: Any
    ) -> RunningMcpDoor:
        arguments: dict[str, Any] = {"deadline_seconds": 600.0, "seams": self.seams}
        arguments.update(options)
        return start_mcp_door(self.access, servers, **arguments)

    def call(
        self, server: str, body: bytes, headers: dict[str, str] | None = None
    ) -> tuple[int, Any]:
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            connection.request("POST", f"/mcp/{server}", body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, response
        finally:
            connection.close()

    def stop(self) -> None:
        self.engine.stop()


@pytest.fixture
def rig() -> Iterator[Rig]:
    app = FakeApp()
    with tempfile.TemporaryDirectory(dir="/tmp", prefix="mcpdoor-") as directory:
        made = Rig(Path(directory), app)
        yield made
        made.stop()
    app.stop()


def daemon_text(engine: FakeDockerEngine) -> str:
    """Everything the daemon was asked and every document it holds, as one text."""
    return json.dumps(
        {
            "calls": [[method, target, body] for method, target, body in engine.calls],
            "containers": [container.document for container in engine.containers.values()],
        }
    )


# -- the container the daemon is asked for ---


# #1067-T01
def test_the_door_container_is_hardened_by_what_it_is_made_of_and_has_no_environment(
    rig: Rig,
) -> None:
    door = rig.start()
    document = rig.engine.container(MCPDOOR_CONTAINER_NAME).document
    host = document["HostConfig"]

    assert document["Image"] == IMAGE_ID, "the Worker image: one image in the snapshot"
    assert document["User"] not in ("", "0", "0:0", "root"), "not root"
    assert host["ReadonlyRootfs"] is True and host["Privileged"] is False
    assert host["CapDrop"] == ["ALL"] and "CapAdd" not in host
    assert host["SecurityOpt"] == ["no-new-privileges:true"]
    assert host["Memory"] == host["MemorySwap"] == MCPDOOR_MEMORY_BYTES
    assert 0 < host["PidsLimit"] <= 512
    assert host["OomScoreAdj"] < 0
    assert host["NetworkMode"] == "bridge"
    for forbidden in ("Binds", "Mounts", "Devices", "PortBindings", "PidMode", "VolumesFrom"):
        assert forbidden not in host, f"the door has no {forbidden}"
    assert document["Env"] == [], (
        "no variable of any kind: the credential is not in the environment"
    )
    assert document["Cmd"] == [], "and not in an argument"
    assert document == door_document(IMAGE_ID), "constants and an image id, nothing else"
    door.stop()


# #1067-T03
def test_the_door_sits_on_the_model_network_at_its_own_address_and_control_is_not_on_it(
    rig: Rig,
) -> None:
    door = rig.start()
    ((_, network),) = rig.engine.networks.items()
    door_id = rig.engine.container(MCPDOOR_CONTAINER_NAME).identifier

    assert OWN_ID not in network["members"]
    assert network["members"][door_id]["IPAMConfig"]["IPv4Address"] == MCP_DOOR_ADDRESS
    assert door.url == f"http://{MCP_DOOR_ADDRESS}:{MCP_DOOR_PORT}"
    assert rig.engine.container(MCPDOOR_CONTAINER_NAME).networks.keys() == {MODEL_NETWORK_NAME}
    door.stop()


# #1067-T01
def test_the_job_credential_goes_to_the_doors_stdin_and_to_no_request_of_the_daemon(
    rig: Rig,
) -> None:
    door = rig.start()

    stdin = bytes(rig.engine.container(MCPDOOR_CONTAINER_NAME).stdin_received).decode()
    document = json.loads(stdin.splitlines()[0])
    assert document["credential"] == JOB_CREDENTIAL and document["jobId"] == JOB_ID
    assert document["servers"] == [SERVER_A, SERVER_B]
    assert JOB_CREDENTIAL not in daemon_text(rig.engine), (
        "docker inspect, the container's definition and every call hold none of it"
    )
    assert JOB_CREDENTIAL not in repr(door.__dict__)
    door.stop()


# #1067-T03
def test_the_egress_rules_go_in_before_the_door_is_told_anything_and_name_no_mcp_host(
    rig: Rig,
) -> None:
    door = rig.start()

    rules = rig.engine.container(RULES_CONTAINER_NAME).document
    assert rules == rules_document(
        IMAGE_ID, rig.engine.container(MCPDOOR_CONTAINER_NAME).identifier
    )
    command = " ".join(rules["Cmd"])
    for private in PRIVATE_RANGES:
        assert private in command, "every private range is dropped"
    assert "tcp dport 443 accept" in command and "drop" in command
    methods = [(method, target.rsplit("/", 1)[-1]) for method, target, _ in rig.engine.calls]
    assert methods.index(("POST", "start")) < len(methods), "the order is the daemon's own"
    assert JOB_CREDENTIAL not in command
    door.stop()


# #1067-T03
def test_with_the_hosts_outer_proxy_the_door_has_that_one_way_out(rig: Rig) -> None:
    proxy = OuterProxy("172.31.0.5", 3128)

    document = rules_document(IMAGE_ID, "door", proxy)

    command = " ".join(document["Cmd"])
    assert "172.31.0.5 tcp dport 3128 accept" in command
    assert "dport 443" not in command and "dport 53" not in command


def test_the_start_document_carries_the_outer_proxy_only_when_there_is_one() -> None:
    access = McpAccess("https://app.example", JOB_ID, JOB_CREDENTIAL)

    plain = json.loads(start_document(access, [SERVER_A], port=3129, deadline_seconds=60.0))
    proxied = json.loads(
        start_document(
            access,
            [SERVER_A],
            port=3129,
            deadline_seconds=60.0,
            outer_proxy=OuterProxy("10.1.2.3", 3128),
        )
    )

    assert "outerProxy" not in plain and proxied["outerProxy"] == {"host": "10.1.2.3", "port": 3128}


# -- the door at work ---


# #1067-T01
def test_a_call_through_the_started_door_reaches_the_app_with_the_credential(rig: Rig) -> None:
    door = rig.start()

    status, response = rig.call(SERVER_A, jsonrpc("tools/call", name="issues_list"))

    assert status == 200 and b"called issues_list" in response.read()
    assert rig.app.requests[-1].headers["authorization"] == f"Bearer {JOB_CREDENTIAL}"
    door.stop()


# #1067-T05
def test_stopping_the_door_ends_every_open_session_and_says_so(rig: Rig) -> None:
    door = rig.start()
    for server in (SERVER_A, SERVER_B):
        status, _ = rig.call(server, jsonrpc("initialize"))
        assert status == 200
    assert len(rig.app.sessions) == 2

    status = door.stop()

    assert rig.app.sessions == set(), "no session of a server outlives the step"
    assert status is not None
    assert status["sessionsOpened"] == 2 and status["sessionsClosed"] == 2
    assert status["sessionsLeft"] == 0 and status["calls"] == 2
    deletes = [seen for seen in rig.app.requests if seen.method == "DELETE"]
    assert len(deletes) == 2
    assert all(seen.headers["authorization"] == f"Bearer {JOB_CREDENTIAL}" for seen in deletes)


# #1067-T05
def test_a_door_whose_control_is_gone_ends_its_sessions_too(rig: Rig) -> None:
    door = rig.start()
    rig.call(SERVER_A, jsonrpc("initialize"))
    assert len(rig.app.sessions) == 1

    # The end of the door's stdin is what a dead Control looks like.
    door._streams.close_write()  # pyright: ignore[reportPrivateUsage]
    door._reader.join(timeout=15)  # pyright: ignore[reportPrivateUsage]

    assert rig.app.sessions == set()
    door.stop()


def test_stopping_twice_is_safe_and_removes_the_container(rig: Rig) -> None:
    door = rig.start()

    first = door.stop()
    second = door.stop()

    assert first == second
    assert rig.engine.container(MCPDOOR_CONTAINER_NAME).removed


# -- a door that cannot be had ---


# #1067-T06
def test_a_door_that_refuses_its_start_is_a_job_error_and_nothing_is_left(rig: Rig) -> None:
    with pytest.raises(JobError) as caught:
        rig.start(servers=("not-a-server-id",))

    assert caught.value.detail.startswith("mcp_door_unavailable")
    assert JOB_CREDENTIAL not in str(caught.value)
    assert rig.engine.container(MCPDOOR_CONTAINER_NAME).removed


# #1067-T06
def test_a_placement_without_an_mcp_door_is_refused_before_anything_is_made(rig: Rig) -> None:
    seams = McpDoorSeams(
        api=rig.seams.api,
        hostname=rig.seams.hostname,
        placement=Placement(split=True, door_address="10.9.9.9"),
    )

    with pytest.raises(JobError) as caught:
        start_mcp_door(rig.access, [SERVER_A], deadline_seconds=60.0, seams=seams)

    assert "no MCP door" in caught.value.detail
    assert rig.engine.containers == {}


# #1067-T06
def test_a_daemon_that_refuses_is_a_job_error_without_the_credential(rig: Rig) -> None:
    seams = McpDoorSeams(
        api=lambda: DockerApi("/nonexistent/docker.sock", timeout=1.0),
        hostname=rig.seams.hostname,
    )

    with pytest.raises(JobError) as caught:
        start_mcp_door(rig.access, [SERVER_A], deadline_seconds=60.0, seams=seams)

    assert JOB_CREDENTIAL not in str(caught.value)


# -- the session: notes, endpoints and the end of the step ---


def mcp_session(
    rig: Rig,
    *,
    servers: list[dict[str, str]] | None = None,
    unavailable: int = 0,
    access: bool = True,
    environment: dict[str, str] | None = None,
) -> ImplementerSession:
    document = json.loads(implementer_job_text())
    if servers is not None:
        document["implementer"]["mcp"] = {"servers": servers}
        if unavailable:
            document["implementer"]["mcp"]["unavailable"] = unavailable
    elif unavailable:
        document["implementer"]["mcp"] = {"servers": [], "unavailable": unavailable}
    if access:
        document["mcpAccess"] = {
            "appUrl": rig.app.url,
            "jobId": JOB_ID,
            "credential": JOB_CREDENTIAL,
        }
    return ImplementerSession(
        parse_implementer_input(json.dumps(document)),
        workspace=None,  # type: ignore[arg-type]  # not read by the start and the end of the door
        command=["opencode"],
        place=lambda: None,  # type: ignore[arg-type,return-value]
        environment=environment or {},
        seams=SessionSeams(mcpdoor=rig.seams),
    )


SERVERS = [
    {"id": SERVER_A, "name": "Issues", "transport": "streamable-http"},
    {"id": SERVER_B, "name": "Docs", "transport": "sse"},
]


# #1067-T02
def test_the_session_starts_the_door_and_names_one_endpoint_for_each_server(rig: Rig) -> None:
    session = mcp_session(rig, servers=SERVERS)

    session._start_mcp()  # pyright: ignore[reportPrivateUsage]

    endpoints = session._mcp_endpoints  # pyright: ignore[reportPrivateUsage]
    assert [(e.key, e.url) for e in endpoints] == [
        ("Issues", f"http://{MCP_DOOR_ADDRESS}:{MCP_DOOR_PORT}/mcp/{SERVER_A}"),
        ("Docs", f"http://{MCP_DOOR_ADDRESS}:{MCP_DOOR_PORT}/mcp/{SERVER_B}"),
    ]
    assert session._notes == []  # pyright: ignore[reportPrivateUsage]
    assert JOB_CREDENTIAL in session.secrets(), "scrubbed from every output of the turn"
    session._stop_mcp()  # pyright: ignore[reportPrivateUsage]


# #1067-T05
def test_the_end_of_the_step_ends_the_sessions_through_the_door(rig: Rig) -> None:
    session = mcp_session(rig, servers=SERVERS)
    session._start_mcp()  # pyright: ignore[reportPrivateUsage]
    rig.call(SERVER_A, jsonrpc("initialize"))
    assert len(rig.app.sessions) == 1

    session._stop_mcp()  # pyright: ignore[reportPrivateUsage]
    session._stop_mcp()  # pyright: ignore[reportPrivateUsage]  # safe twice

    assert rig.app.sessions == set()
    assert rig.engine.container(MCPDOOR_CONTAINER_NAME).removed
    assert session._notes == []  # pyright: ignore[reportPrivateUsage]


# #1067-T06
def test_servers_the_lane_no_longer_has_are_a_note_and_the_step_runs_without_them(rig: Rig) -> None:
    session = mcp_session(rig, servers=SERVERS, unavailable=2)

    session._start_mcp()  # pyright: ignore[reportPrivateUsage]

    assert session._notes == [  # pyright: ignore[reportPrivateUsage]
        "2 MCP servers of this lane are no longer available; the step runs without them"
    ]
    assert len(session._mcp_endpoints) == 2  # pyright: ignore[reportPrivateUsage]
    session._stop_mcp()  # pyright: ignore[reportPrivateUsage]


# #1067-T06
def test_when_every_server_is_gone_there_is_a_note_and_no_door(rig: Rig) -> None:
    session = mcp_session(rig, unavailable=1, access=False)

    session._start_mcp()  # pyright: ignore[reportPrivateUsage]

    assert session._notes == [  # pyright: ignore[reportPrivateUsage]
        "1 MCP server of this lane is no longer available; the step runs without it"
    ]
    assert session._mcp_endpoints == () and rig.engine.containers == {}  # pyright: ignore[reportPrivateUsage]


# #1067-T06
def test_a_door_that_cannot_start_is_a_note_not_a_failed_turn(rig: Rig) -> None:
    rig.engine.refuse["containers/create"] = 500
    session = mcp_session(rig, servers=SERVERS)

    session._start_mcp()  # pyright: ignore[reportPrivateUsage]

    assert session._mcp_endpoints == ()  # pyright: ignore[reportPrivateUsage]
    (note,) = session._notes  # pyright: ignore[reportPrivateUsage]
    assert "could not be reached" in note and JOB_CREDENTIAL not in note
    session._stop_mcp()  # pyright: ignore[reportPrivateUsage]


# #1067-T06
def test_a_runner_on_incus_says_it_has_no_mcp_yet_and_starts_nothing(rig: Rig) -> None:
    environment = {
        "RUNNER_ENVIRONMENT_DOCKER": "split",
        "RUNNER_ENVIRONMENT_DOOR_ADDRESS": "10.9.9.9",
    }
    session = mcp_session(rig, servers=SERVERS, environment=environment)

    session._start_mcp()  # pyright: ignore[reportPrivateUsage]

    assert session._notes == [  # pyright: ignore[reportPrivateUsage]
        "the MCP servers of this lane are not available on this runner yet"
    ]
    assert rig.engine.containers == {}


# #1067-T06
def test_a_turn_that_holds_no_access_runs_without_the_servers_and_says_so(rig: Rig) -> None:
    session = mcp_session(rig, servers=SERVERS, access=False)

    session._start_mcp()  # pyright: ignore[reportPrivateUsage]

    assert len(session._notes) == 1 and "holds no access" in session._notes[0]  # pyright: ignore[reportPrivateUsage]
    assert rig.engine.containers == {}


# #1067-T07
def test_a_lane_without_mcp_starts_no_door_and_writes_no_note(rig: Rig) -> None:
    session = mcp_session(rig)

    session._start_mcp()  # pyright: ignore[reportPrivateUsage]
    session._stop_mcp()  # pyright: ignore[reportPrivateUsage]

    assert session._notes == [] and session._mcp_endpoints == ()  # pyright: ignore[reportPrivateUsage]
    assert rig.engine.containers == {} and rig.engine.networks == {}
    assert rig.app.requests == []
