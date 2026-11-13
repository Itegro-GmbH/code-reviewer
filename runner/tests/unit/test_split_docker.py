# SPDX-License-Identifier: LicenseRef-Proprietary

"""The Worker drives setup and agent in B's Docker on the Incus backend (#1017), against two fake
Docker Engines: A's (the doors, Control's own container) and B's (the setup/agent container and the
readers).

The questions: which daemon each thing is made in (the doors in A with the host network and A's
inner address, never a published port; the container of the setup and the agent and the readers in
B, under `runc`, privileged), that nothing of A is handed to B (no mount, no socket, no variable but
the doors' addresses), that the repository gets from A to B by one explicit tar and comes back only
through the reader's `upload-pack`, and that everything is as hosted when the placement is unset."""

import io
import json
import sys
import tarfile
import tempfile
import threading
from collections.abc import Iterator
from pathlib import Path
from typing import Any, BinaryIO

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from fakes.docker_engine.server import AGENT_IMAGE_ID, HOSTNAME, FakeDockerEngine, FakeExec

from code_reviewer_runner.dynamic_review.model_door_route import MODEL_NETWORK_NAME
from code_reviewer_runner.implementer import exec_pipe
from code_reviewer_runner.implementer.agent_container import (
    AGENT_RUNTIME,
    READY_FILE,
    Adopted,
    AgentContainer,
    AgentSeams,
    agent_document,
    proxy_environment,
)
from code_reviewer_runner.implementer.docker_api import DockerApi
from code_reviewer_runner.implementer.door_launcher import DoorSeams, door_document, start_door
from code_reviewer_runner.implementer.netdoor_launcher import (
    NetDoorSeams,
    start_document,
    start_network_door,
)
from code_reviewer_runner.implementer.netdoor_launcher import door_document as netdoor_document
from code_reviewer_runner.implementer.network_rule import MODE_LIST, NetworkRule
from code_reviewer_runner.implementer.placement import (
    B_DOCKER_SOCKET,
    B_WORK_VOLUME,
    DOOR_ADDRESS_VARIABLE,
    HOSTED,
    MODEL_DOOR_PORT,
    NETWORK_DOOR_PORT_SPLIT,
    PLACEMENT_VARIABLE,
    SOCKET_VARIABLE,
    Placement,
    placement_of,
)
from code_reviewer_runner.implementer.reader import (
    ReaderAccess,
    ReaderSeams,
    reader_document,
    repository_archive,
)
from code_reviewer_runner.implementer.runner_profile import (
    agent_seams,
    door_seams,
    netdoor_seams,
    reader_seams,
    setup_seams,
)
from code_reviewer_runner.implementer.setup_container import (
    OUTCOME_OK,
    SETUP_NETWORK_NAME,
    SetupContainer,
    setup_document,
)
from code_reviewer_runner.job import JobError
from code_reviewer_runner.outer_proxy import OuterProxy

pytestmark = pytest.mark.unit

DOOR_ADDRESS = "10.98.0.2"
SPLIT = Placement(split=True, docker_socket="/unused", door_address=DOOR_ADDRESS)
ENVIRONMENT = {
    PLACEMENT_VARIABLE: "split",
    SOCKET_VARIABLE: B_DOCKER_SOCKET,
    DOOR_ADDRESS_VARIABLE: DOOR_ADDRESS,
}
RULE = NetworkRule(MODE_LIST, ("registry.npmjs.org",))


class TwoDaemons:
    """A's Docker (Control's own container, the doors) and B's (the setup/agent container)."""

    def __init__(self, directory: Path) -> None:
        self.a = FakeDockerEngine(directory / "a.sock").start()
        self.b = FakeDockerEngine(directory / "b.sock").start()
        self.b.exec_behaviour = self.behave
        self.script_ran = threading.Event()
        self.placement = Placement(
            split=True, docker_socket=str(directory / "b.sock"), door_address=DOOR_ADDRESS
        )

    def api_a(self) -> DockerApi:
        return DockerApi(str(self.a.socket_path), timeout=5.0)

    def api_b(self) -> DockerApi:
        return DockerApi(str(self.b.socket_path), timeout=5.0)

    def behave(self, made: FakeExec, stdin: BinaryIO, stdout: Any) -> int:
        argv: list[str] = made.document["Cmd"]
        if argv[:2] == ["/usr/bin/test", "-e"]:
            return 0
        stdin.read()
        return 0

    def stop(self) -> None:
        self.a.stop()
        self.b.stop()


@pytest.fixture
def daemons() -> Iterator[TwoDaemons]:
    with tempfile.TemporaryDirectory(dir="/tmp", prefix="split-") as directory:
        made = TwoDaemons(Path(directory))
        yield made
        made.stop()


def targets(engine: FakeDockerEngine) -> list[str]:
    return [f"{method} {target.split('?')[0]}" for method, target, _ in engine.calls]


# -- the placement -------------------------------------------------------------------------------


def test_without_the_variables_the_placement_is_hosted_and_every_seam_is_as_it_was() -> None:
    assert placement_of({}) == HOSTED and not HOSTED.split
    assert agent_seams({}) == AgentSeams()
    assert reader_seams({}) == ReaderSeams()
    assert door_seams({}, DoorSeams()) == DoorSeams()
    assert netdoor_seams({}, NetDoorSeams()) == NetDoorSeams()
    assert HOSTED.model_door_port(10180) == 10180 and HOSTED.network_door_port == 3128


def test_the_split_placement_names_the_socket_the_door_address_and_the_wall_s_two_ports() -> None:
    placement = placement_of(ENVIRONMENT)

    assert placement == Placement(True, B_DOCKER_SOCKET, DOOR_ADDRESS)
    assert placement.model_door_port(10180) == MODEL_DOOR_PORT == 8080
    assert placement.network_door_port == NETWORK_DOOR_PORT_SPLIT == 8081
    assert placement.network_door_url == f"http://{DOOR_ADDRESS}:8081"
    assert DOOR_ADDRESS in placement.no_proxy.split(",")


@pytest.mark.parametrize(
    "changes",
    [
        {PLACEMENT_VARIABLE: "yes"},
        {DOOR_ADDRESS_VARIABLE: "not-an-address"},
        {DOOR_ADDRESS_VARIABLE: "10.98.0.999"},
        {DOOR_ADDRESS_VARIABLE: ""},
        {SOCKET_VARIABLE: "relative.sock"},
    ],
)
def test_a_placement_that_is_not_one_ends_the_turn_free_before_anything_starts(
    changes: dict[str, str],
) -> None:
    with pytest.raises(JobError, match="placement_invalid"):
        placement_of({**ENVIRONMENT, **changes})


def test_the_profile_of_a_split_job_is_runc_the_images_own_init_and_no_rules_of_ours() -> None:
    agent = agent_seams(ENVIRONMENT)
    setup = setup_seams(ENVIRONMENT)
    reader = reader_seams(ENVIRONMENT)

    for seams in (agent, setup, reader):
        assert seams.runtime == "runc" and seams.placement.split
    # The image's init starts the inner Docker (a privileged container needs it): not the
    # ready-only one of a runner without any.
    assert agent.entrypoint is None and setup.entrypoint is None
    assert setup.install_rules is False
    assert reader.image == "code-reviewer-agent:golden"
    # The doors stay in A's Docker: their seams keep the default (A's) socket.
    assert door_seams(ENVIRONMENT, DoorSeams()).api is DoorSeams().api
    assert door_seams(ENVIRONMENT, DoorSeams()).placement.split


# -- T02: the doors are A's, with the host network, at A's inner address --------------------


# #1017-T02
def test_a_door_in_a_is_a_host_network_process_bound_to_the_inner_address_only() -> None:
    model = door_document("sha256:image", SPLIT, MODEL_DOOR_PORT)
    network = netdoor_document("sha256:image", None, SPLIT)

    assert model["HostConfig"]["NetworkMode"] == network["HostConfig"]["NetworkMode"] == "host"
    assert model["Cmd"] == ["--bind", f"{DOOR_ADDRESS}:8080"]
    assert network["Cmd"] == ["--bind", f"{DOOR_ADDRESS}:8081"]
    for document in (model, network):
        host = document["HostConfig"]
        # Hardening stays (and a published port would be DNATed and dropped by the inner wall).
        assert host["PublishAllPorts"] is False and "PortBindings" not in host
        assert host["ReadonlyRootfs"] is True and host["CapDrop"] == ["ALL"]
        assert host["Privileged"] is False and "Sysctls" not in host
        assert document["Env"] == []
    hosted = door_document("sha256:image")
    assert hosted["HostConfig"]["NetworkMode"] == "bridge" and "Sysctls" in hosted["HostConfig"]


# #1017-T02
def test_the_doors_start_in_a_without_a_model_network_a_rules_container_or_a_connect(
    daemons: TwoDaemons,
) -> None:
    seams = DoorSeams(
        api=daemons.api_a,
        hostname=lambda: HOSTNAME,
        ready_seconds=0.5,
        placement=daemons.placement,
    )
    with pytest.raises(JobError):
        start_door(
            model_access={},
            capability="c" * 43,
            deadline_seconds=60.0,
            port=MODEL_DOOR_PORT,
            environment={},
            seams=seams,
        )

    called = targets(daemons.a)
    assert "POST /containers/create" in called
    assert "POST /networks/create" not in called
    assert not [call for call in called if "connect" in call]
    # One container only: no one-shot rules container (A's wall is the inner wall, loaded by the
    # launcher, and A has no way out but the host's proxy).
    assert called.count("POST /containers/create") == 1
    assert daemons.b.calls == []


# #1017-T02
def test_the_network_door_starts_in_a_the_same_way(daemons: TwoDaemons) -> None:
    seams = NetDoorSeams(
        api=daemons.api_a, hostname=lambda: HOSTNAME, ready_seconds=0.5, placement=daemons.placement
    )

    with pytest.raises(JobError):
        start_network_door(RULE, deadline_seconds=60.0, seams=seams)

    called = targets(daemons.a)
    assert called.count("POST /containers/create") == 1
    assert "POST /networks/create" not in called
    assert not [call for call in called if "connect" in call]
    assert json.loads(start_document(RULE, 60.0, None, 8081))["listenPort"] == 8081
    assert daemons.b.calls == []


# -- T01, T02: the container is B's -------------------------------------------------------


# #1017-T02
def test_the_agent_in_b_reaches_the_doors_in_a_and_has_nothing_of_a() -> None:
    document = agent_document(
        "sha256:agent", B_WORK_VOLUME, 1 << 30, runtime="runc", rule=RULE, placement=SPLIT
    )

    environment = dict(entry.split("=", 1) for entry in document["Env"])
    assert environment["HTTP_PROXY"] == f"http://{DOOR_ADDRESS}:8081"
    assert environment["HTTPS_PROXY"] == environment["HTTP_PROXY"]
    assert DOOR_ADDRESS in environment["NO_PROXY"].split(",")
    host = document["HostConfig"]
    assert host["Runtime"] == "runc" and host["Privileged"] is True
    # Nothing of A: only the repository (and the result directory) of B's volume; no bind, no
    # socket, no device, no Docker API address.
    assert {mount["Target"] for mount in host["Mounts"]} == {"/work/repo"}
    assert not host.get("Binds") and not host.get("Devices")
    assert "docker.sock" not in json.dumps(document) and B_DOCKER_SOCKET not in json.dumps(document)
    assert proxy_environment(RULE) != proxy_environment(RULE, SPLIT)


# #1017-T01
def test_the_setup_container_is_made_in_b_on_the_wide_network_with_the_proxy_and_no_helper(
    daemons: TwoDaemons,
) -> None:
    proxy = OuterProxy("10.99.0.1", 3128)
    seams = setup_seams(
        {**ENVIRONMENT, SOCKET_VARIABLE: str(daemons.b.socket_path)},
    )
    from dataclasses import replace

    seams = replace(
        seams,
        api=daemons.api_b,
        hostname=lambda: HOSTNAME,
        ready_seconds=5.0,
        outer_proxy=proxy,
        placement=daemons.placement,
    )

    run = SetupContainer(2048, seams).run("echo hi\n", script_seconds=5.0)

    # The script itself may be anything the fake does; what matters is where things were made.
    made = targets(daemons.b)
    assert "POST /containers/create" in made
    assert made.count("POST /containers/create") == 1
    assert daemons.a.calls == []
    (container,) = [c for c in daemons.b.containers.values()]
    host = container.document["HostConfig"]
    assert host["Runtime"] == "runc" and host["Privileged"] is True
    assert host["NetworkMode"] == SETUP_NETWORK_NAME
    assert {m["Source"] for m in host["Mounts"]} == {B_WORK_VOLUME}
    environment = dict(entry.split("=", 1) for entry in container.document["Env"])
    assert environment["HTTP_PROXY"] == "http://10.99.0.1:3128"
    assert run.outcome == OUTCOME_OK, run.detail
    # The hand-over of #1009 ran in B's daemon: off the setup network, frozen, for the agent.
    assert run.adopted is not None and run.adopted.paused


def test_the_hosted_setup_document_is_unchanged_by_the_placement() -> None:
    assert setup_document("i", "v", 1, runtime=AGENT_RUNTIME)["HostConfig"]["Privileged"] is False


# #1017-T03
def test_the_agent_takes_over_the_setup_container_in_b_and_puts_it_on_b_s_model_network(
    daemons: TwoDaemons,
) -> None:
    api = daemons.api_b()
    created = api.create_container(
        agent_document("sha256:agent", B_WORK_VOLUME, 1 << 30, runtime="runc", placement=SPLIT),
        "code-reviewer-agent",
    )
    api.start_container(created)
    seams = AgentSeams(
        api=daemons.api_b,
        hostname=lambda: "never-asked-in-b",
        ready_seconds=5.0,
        runtime="runc",
        placement=daemons.placement,
    )
    container = AgentContainer(2048, seams, RULE, adopted=Adopted(created, paused=False))

    notes = container.create()

    assert notes == ()
    made = targets(daemons.b)
    # B's model network is made by Control in B (no model door makes it there) and is not
    # `internal`: the agent reaches A's doors through B's NIC.
    network = next(n for n in daemons.b.networks.values() if n["Name"] == MODEL_NETWORK_NAME)
    assert network["document"]["Internal"] is False
    assert "POST /containers/create" in made and made.count("POST /containers/create") == 1
    assert not [call for call in made if "docker.sock" in call]
    assert daemons.a.calls == []
    container.stop()
    container.remove()


# #1017-T02
@pytest.mark.parametrize("privileged", [False])
def test_a_container_in_b_that_is_not_privileged_or_has_a_bind_is_not_what_was_asked(
    daemons: TwoDaemons, privileged: bool
) -> None:
    api = daemons.api_b()
    document = agent_document(
        "sha256:agent", B_WORK_VOLUME, 1 << 30, runtime="runc", placement=SPLIT
    )
    document["HostConfig"]["Privileged"] = privileged
    document["HostConfig"]["Binds"] = ["/var/run/docker.sock:/var/run/docker.sock"]
    created = api.create_container(document, "code-reviewer-agent")
    api.start_container(created)
    seams = AgentSeams(
        api=daemons.api_b,
        hostname=lambda: "x",
        ready_seconds=5.0,
        runtime="runc",
        placement=daemons.placement,
    )

    with pytest.raises(JobError, match="not what was asked"):
        AgentContainer(2048, seams, RULE, adopted=Adopted(created)).create()


# -- the repository: A to B by one tar, the readers in B --------------------------------------


def make_checkout(root: Path) -> Path:
    repo = root / "repo"
    (repo / ".git").mkdir(parents=True)
    (repo / ".git" / "HEAD").write_text("ref: refs/heads/main\n")
    (repo / "README.md").write_text("hello\n")
    # A hostile checkout: a link that points at a secret of A. It is stored as a link, never
    # followed, so the bytes of the target are not in the archive.
    (root / "secret").write_text("TOKEN-OF-A")
    (repo / "link").symlink_to(root / "secret")
    return repo


# #1017-T02
def test_the_archive_holds_the_checkout_as_repo_and_an_empty_result_and_never_follows_a_link() -> (
    None
):
    with tempfile.TemporaryDirectory(dir="/tmp", prefix="seed-") as directory:
        root = Path(directory)
        repo = make_checkout(root)

        with repository_archive(repo, root) as archive:
            data = archive.read()

    with tarfile.open(fileobj=io.BytesIO(data)) as tar:
        names = tar.getnames()
        link = tar.getmember("repo/link")
        assert "result" in names and "repo/README.md" in names and "repo/.git/HEAD" in names
        assert link.issym() and link.linkname == str(root / "secret")
        assert all(member.uid == 0 and member.gid == 0 for member in tar.getmembers())
    assert b"TOKEN-OF-A" not in data


# #1017-T03
def test_the_first_reader_in_b_seeds_b_s_volume_once_from_the_agent_image(
    daemons: TwoDaemons,
) -> None:
    with tempfile.TemporaryDirectory(dir="/tmp", prefix="seed-") as directory:
        root = Path(directory)
        repo = make_checkout(root)
        access = ReaderAccess(
            None,
            ReaderSeams(
                api=daemons.api_b,
                runtime="runc",
                placement=daemons.placement,
                image="code-reviewer-agent:golden",
                repo_directory=str(repo),
                scratch_directory=str(root),
            ),
        )

        assert access.warm()

        # The seed container is made, given the tar under `/seed` and removed; never started.
        ((name, path, data),) = daemons.b.archives
        assert name == "code-reviewer-seed" and path == "/seed"
        with tarfile.open(fileobj=io.BytesIO(data)) as sent:
            assert "repo/README.md" in sent.getnames()
        seed = next(c for c in daemons.b.containers.values() if c.name == name)
        assert seed.removed and not seed.running
        assert seed.document["HostConfig"]["Mounts"][0]["Source"] == B_WORK_VOLUME
        assert seed.document["Image"] == AGENT_IMAGE_ID
        # Both readers are in B, on B's volume, from the agent image, under `runc`; none in A.
        readers = [c for c in daemons.b.containers.values() if c.name.startswith("code-reviewer-r")]
        assert len(readers) == 2
        for each in readers:
            assert each.document["HostConfig"]["Runtime"] == "runc"
            assert each.document["HostConfig"]["NetworkMode"] == "none"
            assert each.document["Image"] == AGENT_IMAGE_ID
            assert each.document["HostConfig"]["Mounts"][0]["Source"] == B_WORK_VOLUME
        assert daemons.a.calls == []
        # The hand-over happens once, not for every reader.
        assert len(daemons.b.archives) == 1
        access.close()


# #1017-T02
def test_a_reader_whose_seed_fails_is_unavailable_and_leaves_no_seed_container(
    daemons: TwoDaemons,
) -> None:
    daemons.b.refuse["/archive"] = 500
    with tempfile.TemporaryDirectory(dir="/tmp", prefix="seed-") as directory:
        root = Path(directory)
        access = ReaderAccess(
            None,
            ReaderSeams(
                api=daemons.api_b,
                runtime="runc",
                placement=daemons.placement,
                image="code-reviewer-agent:golden",
                repo_directory=str(make_checkout(root)),
                scratch_directory=str(root),
            ),
        )

        assert not access.warm()

    assert all(c.removed for c in daemons.b.containers.values())
    assert daemons.a.calls == []


def test_the_upload_pack_of_a_split_job_names_b_s_socket_and_the_hosted_one_does_not() -> None:
    split = ReaderAccess(None, ReaderSeams(placement=SPLIT)).upload_pack()
    hosted = ReaderAccess(None, ReaderSeams()).upload_pack()

    assert split.endswith("--docker-socket=/unused") and "--docker-socket" not in hosted
    assert reader_document("i", "v", runtime="runc")["HostConfig"]["Privileged"] is False


def test_the_pipe_takes_one_absolute_socket_path_and_refuses_anything_else() -> None:
    from code_reviewer_runner.implementer.reader import CONTROL_REPO

    for argument in ("--docker-socket=relative", "--docker-socket=/a b", "--docker-socket=/a;b"):
        assert exec_pipe.main([argument, CONTROL_REPO], {}) == exec_pipe.USAGE_ERROR
    assert exec_pipe.main(["--docker-socket=/x", "/elsewhere"], {}) == exec_pipe.USAGE_ERROR
    assert exec_pipe.main(["--other=/x", CONTROL_REPO], {}) == exec_pipe.USAGE_ERROR


def test_ready_file_is_the_one_both_phases_wait_for() -> None:
    assert READY_FILE == "/run/agent-ready"
