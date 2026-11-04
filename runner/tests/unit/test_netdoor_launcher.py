# SPDX-License-Identifier: LicenseRef-Proprietary

"""Control starts the network door through the VM's Docker (#745, step 7), against the fake daemon.

What these tests hold: the daemon is asked for a door that is hardened by construction, that holds
no secret and no environment variable, and for nothing that comes from a job (the rule travels on
the door's stdin); the door's egress rules go in before it is told anything, with ports 80 and 443
and DNS open and the VM and every private range closed; the door is the real code behind the
daemon's pipes; a door that cannot start ends the turn with a name and the free class; and the log
Control reads is the door's."""

import io
import json
import socket
import tempfile
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any, BinaryIO

import pytest
from door_support import free_port
from fakes.docker_engine.server import HOSTNAME, IMAGE_ID, OWN_ID, FakeDockerEngine
from netdoor_support import PUBLIC, Lookups, Origin

from code_reviewer_runner.dynamic_review.model_door_route import (
    MODEL_DOOR_ADDRESS,
    MODEL_NETWORK_NAME,
    MODEL_NETWORK_SUBNET,
    NETWORK_DOOR_ADDRESS,
    NETWORK_DOOR_PORT,
)
from code_reviewer_runner.implementer.docker_api import DockerApi
from code_reviewer_runner.implementer.door_launcher import PRIVATE_RANGES, network_document
from code_reviewer_runner.implementer.netdoor.addresses import TEST_PUBLIC_VARIABLE
from code_reviewer_runner.implementer.netdoor.service import run_netdoor
from code_reviewer_runner.implementer.netdoor_launcher import (
    NETDOOR_CONTAINER_NAME,
    NETDOOR_MEMORY_BYTES,
    RULES_CONTAINER_NAME,
    CiNetwork,
    NetDoorSeams,
    RunningNetDoor,
    door_document,
    egress_rules,
    rules_document,
    start_document,
    start_network_door,
)
from code_reviewer_runner.implementer.network_rule import MODE_LIST, MODE_OFF, NetworkRule
from code_reviewer_runner.job import JobError
from code_reviewer_runner.result import ErrorCode

pytestmark = pytest.mark.integration

RULE = NetworkRule(MODE_LIST, ("registry.npmjs.org", "*.pythonhosted.org"))


class Rig:
    """The fake daemon with the real network door behind it, and the seams that point Control at
    it. The door's lookup and connector are the test's (`netdoor_support`)."""

    def __init__(self, directory: Path, origin: Origin) -> None:
        self.port = free_port()
        self.lookups = Lookups(
            table={"registry.npmjs.org": [PUBLIC], "example.com": [PUBLIC]},
            servers={PUBLIC: origin.port},
        )
        self.engine = FakeDockerEngine(directory / "docker.sock", self.behave).start()
        self.api = DockerApi(str(directory / "docker.sock"), timeout=5.0)
        self.api.create_network(network_document())
        self.seams = NetDoorSeams(
            api=lambda: DockerApi(str(directory / "docker.sock"), timeout=5.0),
            hostname=lambda: HOSTNAME,
            ready_seconds=5.0,
            stop_seconds=3.0,
        )

    def behave(self, stdin: BinaryIO, stdout: Any, stderr: Any) -> int:
        text = io.TextIOWrapper(stdin, encoding="utf-8")
        return run_netdoor(
            text,
            stdout,
            bind=("127.0.0.1", self.port),
            resolver=self.lookups.resolve,
            connector=self.lookups.connect,
            poll_seconds=0.02,
        )

    def start(self, rule: NetworkRule = RULE, **options: Any) -> RunningNetDoor:
        arguments: dict[str, Any] = {"deadline_seconds": 600.0, "seams": self.seams}
        arguments.update(options)
        return start_network_door(rule, **arguments)

    def stop(self) -> None:
        self.engine.stop()


@pytest.fixture
def origin() -> Iterator[Origin]:
    server = Origin()
    yield server
    server.close()


@pytest.fixture
def rig(origin: Origin) -> Iterator[Rig]:
    with tempfile.TemporaryDirectory(dir="/tmp", prefix="netdoor-") as directory:
        made = Rig(Path(directory), origin)
        yield made
        made.stop()


def call_bodies(engine: FakeDockerEngine) -> str:
    return json.dumps([[method, target, body] for method, target, body in engine.calls])


def tunnel(port: int, target: str) -> bytes:
    client = socket.create_connection(("127.0.0.1", port), timeout=10)
    try:
        client.sendall(f"CONNECT {target} HTTP/1.1\r\n\r\n".encode())
        client.shutdown(socket.SHUT_WR)
        data = b""
        while chunk := client.recv(4096):
            data += chunk
        return data
    finally:
        client.close()


# -- the container the daemon is asked for ---


# #745-T20
def test_the_door_container_is_hardened_by_what_it_is_made_of_and_has_no_environment(
    rig: Rig,
) -> None:
    door = rig.start()
    document = rig.engine.container(NETDOOR_CONTAINER_NAME).document
    host = document["HostConfig"]

    assert document["Image"] == IMAGE_ID, "the Worker image: one image in the snapshot"
    assert document["User"] not in ("", "0", "0:0", "root"), "not root"
    assert host["ReadonlyRootfs"] is True
    assert host["CapDrop"] == ["ALL"] and "CapAdd" not in host
    assert host["SecurityOpt"] == ["no-new-privileges:true"]
    assert host["Privileged"] is False
    assert host["Memory"] == host["MemorySwap"] == NETDOOR_MEMORY_BYTES
    assert 0 < host["PidsLimit"] <= 512
    assert host["OomScoreAdj"] < 0, "the VM's OOM killer takes the agent before it takes a door"
    assert host["Tmpfs"]["/tmp"].startswith("rw,noexec,nosuid,nodev")
    assert host["NetworkMode"] == "bridge", "its way out is the VM's default bridge"
    for forbidden in (
        "Binds",
        "Mounts",
        "Devices",
        "PortBindings",
        "PidMode",
        "IpcMode",
        "UsernsMode",
        "UTSMode",
        "CgroupnsMode",
        "VolumesFrom",
        "ExtraHosts",
    ):
        assert forbidden not in host, f"the door has no {forbidden}"
    assert "Volumes" not in document and "ExposedPorts" not in document
    assert document["Env"] == [], "no secret, no variable of any kind"
    assert host["Sysctls"] == {
        "net.ipv6.conf.all.disable_ipv6": "1",
        "net.ipv6.conf.default.disable_ipv6": "1",
    }
    assert document == door_document(IMAGE_ID), "constants and an image id, nothing else"
    door.stop()


# #745-T20
def test_the_door_sits_on_the_model_network_at_its_own_address_and_control_is_not_on_it(
    rig: Rig,
) -> None:
    door = rig.start()
    ((_, network),) = rig.engine.networks.items()
    door_id = rig.engine.container(NETDOOR_CONTAINER_NAME).identifier

    assert OWN_ID not in network["members"]
    assert network["members"][door_id]["IPAMConfig"]["IPv4Address"] == NETWORK_DOOR_ADDRESS
    assert NETWORK_DOOR_ADDRESS != MODEL_DOOR_ADDRESS
    assert door.url == f"http://{NETWORK_DOOR_ADDRESS}:{NETWORK_DOOR_PORT}"
    assert rig.engine.container(NETDOOR_CONTAINER_NAME).networks.keys() == {MODEL_NETWORK_NAME}
    door.stop()


# #745-T20
def test_nothing_of_the_rule_is_in_a_request_to_the_daemon_it_goes_to_the_door_on_stdin(
    rig: Rig,
) -> None:
    door = rig.start()
    door.stop()

    sent = call_bodies(rig.engine)
    assert "pythonhosted" not in sent and "registry.npmjs.org" not in sent
    stdin = bytes(rig.engine.container(NETDOOR_CONTAINER_NAME).stdin_received)
    first = json.loads(stdin.split(b"\n")[0])
    assert first == {
        "version": 1,
        "rule": RULE.to_json(),
        "listenPort": NETWORK_DOOR_PORT,
        "deadlineSeconds": 600.0,
    }
    assert json.loads(start_document(RULE, 600.0)) == first


# -- the door's own egress rules ---


# #745-T20
def test_the_rules_are_installed_by_a_one_shot_container_before_the_door_is_told_the_rule(
    rig: Rig,
) -> None:
    door = rig.start()

    helper = rig.engine.container(RULES_CONTAINER_NAME)
    door_id = rig.engine.container(NETDOOR_CONTAINER_NAME).identifier
    assert helper.document == rules_document(IMAGE_ID, door_id)
    assert helper.removed
    paths = [target.split("?")[0] for _, target, _ in rig.engine.calls]
    started_helper = paths.index(f"/containers/{helper.identifier}/start")
    waited = paths.index(f"/containers/{helper.identifier}/wait")
    started_door = paths.index(f"/containers/{door_id}/start")
    assert started_door < started_helper < waited
    assert rig.engine.container(NETDOOR_CONTAINER_NAME).stdin_received
    door.stop()


# #745-T20
def test_the_rules_container_holds_net_admin_and_nothing_else_and_runs_a_constant(rig: Rig) -> None:
    door = rig.start()
    document = rig.engine.container(RULES_CONTAINER_NAME).document
    host = document["HostConfig"]

    assert host["NetworkMode"].startswith("container:")
    assert host["CapDrop"] == ["ALL"] and host["CapAdd"] == ["NET_ADMIN"]
    assert host["ReadonlyRootfs"] is True and host["Privileged"] is False
    for forbidden in ("Binds", "Mounts", "Devices", "PortBindings", "PidMode", "IpcMode"):
        assert forbidden not in host
    assert document["Entrypoint"] == ["/usr/sbin/nft"]
    assert document["Cmd"] == [egress_rules()] and document["Env"] == []
    door.stop()


# #745-T20
def test_the_rules_let_dns_and_the_two_web_ports_through_and_drop_the_vm_and_everything_else() -> (
    None
):
    rules = egress_rules().split("; ")

    assert rules[-1].endswith("output drop"), "the last word is no"
    replies = next(i for i, r in enumerate(rules) if "ct state established,related accept" in r)
    shut_model = next(
        i for i, r in enumerate(rules) if MODEL_NETWORK_SUBNET in r and r.endswith("drop")
    )
    accept_dns = next(i for i, r in enumerate(rules) if "th dport 53 accept" in r)
    drop_private = next(i for i, r in enumerate(rules) if r.endswith("} drop"))
    accept_web = next(i for i, r in enumerate(rules) if "tcp dport { 80, 443 } accept" in r)
    assert replies < shut_model < accept_dns < drop_private < accept_web
    assert not any(MODEL_NETWORK_SUBNET in r and "accept" in r for r in rules)
    for private in (
        "10.0.0.0/8",
        "169.254.0.0/16",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "100.64.0.0/10",
    ):
        assert private in PRIVATE_RANGES and private in rules[drop_private]
    assert not any("dport 22" in r or "dport 8080" in r for r in rules)
    assert "ip6" not in " ".join(rules)
    assert "accept" not in " ".join(r for r in rules if "daddr 10." in r), (
        "no private range is open"
    )


# #745-T20
def test_the_test_network_is_in_the_rules_and_the_environment_only_through_the_seam(
    rig: Rig,
) -> None:
    production = door_document(IMAGE_ID)
    assert production["Env"] == [] and "ExtraHosts" not in production["HostConfig"]
    assert "10.213.99" not in egress_rules() and TEST_PUBLIC_VARIABLE not in json.dumps(production)

    ci = CiNetwork("ci-public", "10.213.99.0/29", ("registry.npmjs.org:10.213.99.2",))
    document = door_document(IMAGE_ID, ci)
    assert document["Env"] == [f"{TEST_PUBLIC_VARIABLE}=10.213.99.0/29"]
    assert document["HostConfig"]["ExtraHosts"] == ["registry.npmjs.org:10.213.99.2"]
    rules = egress_rules("10.213.99.0/29").split("; ")
    allowed = next(i for i, r in enumerate(rules) if "10.213.99.0/29" in r)
    dropped = next(i for i, r in enumerate(rules) if r.endswith("} drop"))
    assert allowed < dropped and rules[allowed].endswith("accept")


# -- a door that cannot be had ---


# #745-T20
def test_a_door_whose_rules_did_not_go_in_is_taken_away_and_never_told_the_rule(rig: Rig) -> None:
    rig.engine.rules_exit = 1

    with pytest.raises(JobError) as error:
        rig.start()

    assert error.value.code is ErrorCode.SETUP_FAILED
    assert (
        "network rules" in error.value.detail and "network_door_unavailable" in error.value.detail
    )
    door = rig.engine.container(NETDOOR_CONTAINER_NAME)
    assert bytes(door.stdin_received) == b"" and door.removed


# #745-T20
def test_a_daemon_that_refuses_a_step_is_the_same_free_end(rig: Rig) -> None:
    rig.engine.refuse[f"name={NETDOOR_CONTAINER_NAME}"] = 500

    with pytest.raises(JobError) as error:
        rig.start()

    assert error.value.code is ErrorCode.SETUP_FAILED
    assert "network_door_unavailable" in error.value.detail


# #745-T20
def test_a_door_that_refuses_the_rule_ends_the_turn_free_and_is_removed(rig: Rig) -> None:
    with pytest.raises(JobError) as error:
        rig.start(NetworkRule(MODE_OFF))

    assert error.value.code is ErrorCode.SETUP_FAILED
    assert "refused to start (rule_invalid)" in error.value.detail
    assert rig.engine.container(NETDOOR_CONTAINER_NAME).removed


# -- the door behind the pipes ---


# #745-T20
def test_the_log_control_reads_is_the_doors_and_a_stop_returns_the_last_word(rig: Rig) -> None:
    door = rig.start()
    assert tunnel(rig.port, "registry.npmjs.org:443").startswith(b"HTTP/1.1 200")
    assert b" 403 " in tunnel(rig.port, "example.com:443").split(b"\r\n")[0] + b" "

    log = door.stop()

    assert log is not None and log["final"] is True
    assert (log["allowed"], log["refused"]) == (1, 1)
    hosts = {(c["host"], c["outcome"], c["reason"]) for c in log["connections"]}
    assert hosts == {
        ("registry.npmjs.org", "allowed", None),
        ("example.com", "refused", "not_listed"),
    }
    assert rig.engine.container(NETDOOR_CONTAINER_NAME).removed
    assert door.stop() == log, "twice is the same"


# #745-T20
def test_a_door_that_is_killed_is_seen_as_an_end_that_nobody_asked_for(rig: Rig) -> None:
    door = rig.start()
    rig.engine.kill(NETDOOR_CONTAINER_NAME)

    for _ in range(100):
        if door.end is not None:
            break
        time.sleep(0.05)
    assert door.end is not None and door.end.unexpected
    door.stop()
