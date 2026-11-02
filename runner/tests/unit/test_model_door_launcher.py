# SPDX-License-Identifier: LicenseRef-Proprietary

"""Control starts the model door through the VM's Docker (#745, step 3), against the fake daemon.

What these tests hold: the daemon is asked for a door that is hardened by construction and for
nothing that comes from a job; the key reaches the door on its stdin and is in no request, no
container definition and no environment; the door is the real code behind the daemon's pipes; a
door that cannot start, that refuses, that never answers or that is killed ends the turn with a
name and a decision of who pays; and the ledger Control reads is the door's."""

import io
import json
import sys
import tempfile
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any, BinaryIO, cast

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from door_support import (
    CAPABILITY,
    free_port,
    implementer_job_text,
    model_access,
    post,
    scripted_provider,
)
from fakes.docker_engine.server import HOSTNAME, IMAGE_ID, OWN_ID, FakeDockerEngine
from native_job_support import API_KEY

from code_reviewer_runner.dynamic_review.job_model_entry import (
    native_model_reference,
    native_provider_config,
)
from code_reviewer_runner.dynamic_review.model_door_route import (
    MODEL_CONTROL_ADDRESS,
    MODEL_DOOR_ADDRESS,
    MODEL_DOOR_MODE,
    MODEL_DOOR_VARIABLE,
    MODEL_NETWORK_NAME,
    MODEL_NETWORK_SUBNET,
)
from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily, spec_of
from code_reviewer_runner.implementer.config import build_engine_config
from code_reviewer_runner.implementer.docker_api import DockerApi, DockerError
from code_reviewer_runner.implementer.door.service import run_door
from code_reviewer_runner.implementer.door_launcher import (
    DOOR_CONTAINER_NAME,
    EGRESS_RULES,
    PRIVATE_RANGES,
    RULES_CONTAINER_NAME,
    DoorSeams,
    RunningDoor,
    door_document,
    network_document,
    rules_document,
    start_door,
)
from code_reviewer_runner.implementer.egress_config import EgressSettings
from code_reviewer_runner.implementer.session import ImplementerSession, SessionSeams, classify
from code_reviewer_runner.job import JobError, parse_implementer_input
from code_reviewer_runner.result import ErrorCode

from code_reviewer_runner.dynamic_review.static_isolation import ImplementerNetwork  # isort: skip


class Rig:
    """The fake daemon with the real door behind it, and the seams that point Control at it."""

    def __init__(self, directory: Path) -> None:
        self.port = free_port()
        self.upstream = scripted_provider()
        self.engine = FakeDockerEngine(directory / "docker.sock", self.behave).start()
        self.seams = DoorSeams(
            api=lambda: DockerApi(str(directory / "docker.sock"), timeout=5.0),
            hostname=lambda: HOSTNAME,
            ready_seconds=5.0,
            stop_seconds=3.0,
        )
        self.door_url = f"http://127.0.0.1:{self.port}"

    def behave(self, stdin: BinaryIO, stdout: Any, stderr: Any) -> int:
        text = io.TextIOWrapper(stdin, encoding="utf-8")
        return run_door(
            text,
            stdout,
            bind=("127.0.0.1", self.port),
            upstream_for=lambda _destination: self.upstream,
            poll_seconds=0.02,
        )

    def start(self, **options: Any) -> RunningDoor:
        arguments: dict[str, Any] = {
            "model_access": model_access(),
            "capability": CAPABILITY,
            "deadline_seconds": 600.0,
            "port": 10180,
            "environment": {},
            "seams": self.seams,
        }
        arguments.update(options)
        return start_door(**arguments)

    def stop(self) -> None:
        self.engine.stop()


@pytest.fixture
def rig() -> Iterator[Rig]:
    with tempfile.TemporaryDirectory(dir="/tmp", prefix="door-") as directory:
        made = Rig(Path(directory))
        yield made
        made.stop()


def call_bodies(engine: FakeDockerEngine) -> str:
    """Everything the daemon was ever sent, as one text."""
    return json.dumps([[method, target, body] for method, target, body in engine.calls])


# -- the daemon is asked for a hardened door and for nothing that comes from a job ---------------


# #745-T05
def test_the_door_is_made_in_the_order_that_keeps_the_key_out_of_every_request(rig: Rig) -> None:
    door = rig.start()

    steps = [(method, target.split("?")[0]) for method, target, _ in rig.engine.calls]
    assert steps[0] == ("GET", f"/containers/{HOSTNAME}/json"), (
        "its own image comes from the daemon"
    )
    assert ("POST", "/networks/create") in steps
    created = steps.index(("POST", "/containers/create"))
    attached = next(i for i, (_, path) in enumerate(steps) if path.endswith("/attach"))
    started = next(i for i, (_, path) in enumerate(steps) if path.endswith("/start"))
    assert created < attached < started, "stdin is attached before the door runs"
    assert door.url == f"http://{MODEL_DOOR_ADDRESS}:10180"
    door.stop()


# #745-T05
def test_the_key_and_the_capability_are_in_no_request_to_the_daemon(rig: Rig) -> None:
    door = rig.start()
    post(rig.door_url)
    door.stop()

    sent = call_bodies(rig.engine)
    assert API_KEY not in sent and CAPABILITY not in sent
    assert "apiKey" not in sent and "modelAccess" not in sent
    container = rig.engine.container(DOOR_CONTAINER_NAME)
    assert API_KEY not in json.dumps(container.document), "not in the definition of the container"
    assert container.document["Env"] == [], "and no environment variable of any kind"
    assert API_KEY not in "".join(container.stderr_text)


# #745-T05
def test_the_door_container_is_hardened_by_what_it_is_made_of(rig: Rig) -> None:
    door = rig.start()
    document = rig.engine.container(DOOR_CONTAINER_NAME).document
    host = document["HostConfig"]

    assert document["Image"] == IMAGE_ID, "the Worker image: one image in the snapshot"
    assert document["User"] not in ("", "0", "0:0", "root"), "not root"
    assert host["ReadonlyRootfs"] is True
    assert host["CapDrop"] == ["ALL"] and "CapAdd" not in host
    assert host["SecurityOpt"] == ["no-new-privileges:true"]
    assert host["Privileged"] is False
    assert host["Memory"] == host["MemorySwap"] > 0, "a memory limit and no swap"
    assert 0 < host["PidsLimit"] <= 256
    assert host["Tmpfs"]["/tmp"].startswith("rw,noexec,nosuid,nodev")
    assert host["NetworkMode"] == "bridge", "the provider is reached over the VM's default bridge"
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
    assert document["Env"] == []
    assert document == door_document(IMAGE_ID), "constants and an image id, nothing else"
    door.stop()


# #745-T05
def test_the_model_network_has_no_exit_and_a_fixed_range_and_the_agent_side_joins_it(
    rig: Rig,
) -> None:
    door = rig.start()
    ((_, network),) = rig.engine.networks.items()
    document = network["document"]

    assert document == network_document()
    assert document["Internal"] is True
    assert document["Options"]["com.docker.network.bridge.gateway_mode_ipv4"] == "isolated"
    assert document["IPAM"]["Config"][0]["Subnet"] == MODEL_NETWORK_SUBNET
    assert document["Name"] == MODEL_NETWORK_NAME
    members = network["members"]
    assert members[OWN_ID]["IPAMConfig"]["IPv4Address"] == MODEL_CONTROL_ADDRESS
    door_id = rig.engine.container(DOOR_CONTAINER_NAME).identifier
    assert members[door_id]["IPAMConfig"]["IPv4Address"] == MODEL_DOOR_ADDRESS
    door.stop()


# -- the door's own network rules ----------------------------------------------------------------


# #745-T19
def test_the_rules_are_installed_by_a_one_shot_container_in_the_doors_namespace_before_the_key(
    rig: Rig,
) -> None:
    door = rig.start()

    helper = rig.engine.container(RULES_CONTAINER_NAME)
    door_id = rig.engine.container(DOOR_CONTAINER_NAME).identifier
    assert helper.document == rules_document(IMAGE_ID, door_id)
    assert helper.removed, "it is a one-shot: gone when it has done"
    paths = [target.split("?")[0] for _, target, _ in rig.engine.calls]
    start_of_helper = paths.index(f"/containers/{helper.identifier}/start")
    waited = paths.index(f"/containers/{helper.identifier}/wait")
    started_door = paths.index(f"/containers/{door_id}/start")
    assert started_door < start_of_helper < waited, (
        "the door runs, its rules go in, then it is told"
    )
    assert rig.engine.container(DOOR_CONTAINER_NAME).stdin_received, "and then it was told"
    door.stop()


# #745-T19
def test_the_rules_container_holds_net_admin_and_nothing_else_and_shares_nothing_but_the_namespace(
    rig: Rig,
) -> None:
    door = rig.start()
    document = rig.engine.container(RULES_CONTAINER_NAME).document
    host = document["HostConfig"]

    assert host["NetworkMode"].startswith("container:")
    assert host["CapDrop"] == ["ALL"] and host["CapAdd"] == ["NET_ADMIN"]
    assert host["ReadonlyRootfs"] is True and host["Privileged"] is False
    assert host["SecurityOpt"] == ["no-new-privileges:true"]
    for forbidden in ("Binds", "Mounts", "Devices", "PortBindings", "PidMode", "IpcMode"):
        assert forbidden not in host
    assert document["Entrypoint"] == ["/usr/sbin/nft"]
    assert document["Cmd"] == [EGRESS_RULES], "the one command is a constant"
    assert document["Env"] == []
    door.stop()


# #745-T19
def test_the_rules_let_the_agent_side_dns_and_https_through_and_drop_the_vm_and_everything_else() -> (
    None
):
    rules = EGRESS_RULES.split("; ")

    assert rules[-1].endswith("output drop"), "the last word is no"
    accept_model = next(i for i, r in enumerate(rules) if MODEL_NETWORK_SUBNET in r)
    drop_private = next(i for i, r in enumerate(rules) if r.endswith("} drop"))
    accept_https = next(i for i, r in enumerate(rules) if "dport 443 accept" in r)
    assert accept_model < drop_private < accept_https, "the model network is inside 10.0.0.0/8"
    assert any("th dport 53 accept" in r for r in rules), (
        "the resolver of the VM is a private address"
    )
    assert any('oifname "lo" accept' in r for r in rules)
    for private in (
        "10.0.0.0/8",
        "169.254.0.0/16",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "100.64.0.0/10",
    ):
        assert private in PRIVATE_RANGES and private in rules[drop_private]
    assert not any("dport 80" in r or "dport 22" in r for r in rules)
    assert "ip6" not in EGRESS_RULES, "an ip table: the door has no IPv6 (the sysctls say so)"


# #745-T19
def test_the_door_has_no_ipv6_because_its_rules_are_an_ip_table(rig: Rig) -> None:
    door = rig.start()

    host = rig.engine.container(DOOR_CONTAINER_NAME).document["HostConfig"]

    assert host["Sysctls"] == {
        "net.ipv6.conf.all.disable_ipv6": "1",
        "net.ipv6.conf.default.disable_ipv6": "1",
    }
    door.stop()


# #745-T19
def test_a_door_whose_rules_did_not_go_in_never_gets_the_key_and_is_taken_away(
    rig: Rig,
) -> None:
    rig.engine.rules_exit = 1

    with pytest.raises(JobError) as error:
        rig.start()

    assert error.value.code is ErrorCode.SETUP_FAILED
    assert "network rules" in error.value.detail and "model_door_unavailable" in error.value.detail
    door = rig.engine.container(DOOR_CONTAINER_NAME)
    assert bytes(door.stdin_received) == b"", "the start document, with the key, was never written"
    assert door.removed and rig.engine.networks == {}
    assert API_KEY not in call_bodies(rig.engine)


# #745-T19
def test_a_daemon_that_refuses_the_rules_container_is_the_same_free_end(rig: Rig) -> None:
    rig.engine.refuse[f"name={RULES_CONTAINER_NAME}"] = 500

    with pytest.raises(JobError) as error:
        rig.start()

    assert error.value.code is ErrorCode.SETUP_FAILED
    assert bytes(rig.engine.container(DOOR_CONTAINER_NAME).stdin_received) == b""


# -- what the door does behind the daemon ---------------------------------------------------------


# #745-T06
def test_a_started_door_serves_and_control_reads_what_it_counted(rig: Rig) -> None:
    door = rig.start()

    status, _ = post(rig.door_url)
    assert status == 200
    deadline_reached = _wait(lambda: door.state.model_used)

    assert deadline_reached, "the ledger of the door is read back by Control"
    seen = door.state.status
    assert seen is not None and seen.usage["aiCalls"] == 1
    assert door.state.failure() is None
    door.stop()
    final = door.state.status
    assert final is not None and final.final is True and len(final.model_calls) == 1
    assert door.state.end is not None and door.state.end.unexpected is False


# #745-T06
def test_a_stopped_door_leaves_nothing_behind_and_is_not_a_failure(rig: Rig) -> None:
    door = rig.start()

    door.stop()
    door.stop()  # twice is safe

    assert rig.engine.container(DOOR_CONTAINER_NAME).removed
    assert rig.engine.networks == {}, "the network is removed with the door"
    assert door.state.failure() is None, "a door that Control stopped did not fail the turn"


# -- the doors that do not work -------------------------------------------------------------------


# #745-T07
def test_a_daemon_that_refuses_a_step_is_a_free_turn_that_never_started_and_cleans_up(
    rig: Rig,
) -> None:
    rig.engine.refuse["/containers/create"] = 500

    with pytest.raises(JobError) as error:
        rig.start()

    assert error.value.code is ErrorCode.SETUP_FAILED
    assert "model_door_unavailable" in error.value.detail
    assert rig.engine.networks == {}, "what was made before the refusal is taken away again"


# #745-T07
def test_no_daemon_at_all_is_the_same_free_end(rig: Rig) -> None:
    rig.stop()

    with pytest.raises(JobError) as error:
        rig.start()

    assert error.value.code is ErrorCode.SETUP_FAILED
    assert "model_door_unavailable" in error.value.detail


# #745-T07
def test_a_door_that_refuses_the_model_is_the_jobs_settings_not_a_broken_door(rig: Rig) -> None:
    access = model_access()
    access["modelEntry"]["upstreamBaseUrl"] = "https://api.evil.example/v1"

    with pytest.raises(JobError) as error:
        rig.start(model_access=access)

    assert error.value.code is ErrorCode.IMPLEMENTER_CONFIG_INVALID
    assert "evil" not in error.value.detail
    assert rig.engine.container(DOOR_CONTAINER_NAME).removed
    assert rig.upstream.requests == []


# #745-T07
def test_a_door_that_never_says_ready_is_given_up_on_and_removed(rig: Rig) -> None:
    def silent(stdin: BinaryIO, stdout: Any, stderr: Any) -> int:
        stdin.read()  # says nothing until Control is gone
        return 0

    rig.engine.behaviour = silent
    seams = DoorSeams(
        api=rig.seams.api, hostname=rig.seams.hostname, ready_seconds=0.3, stop_seconds=0.3
    )

    with pytest.raises(JobError) as error:
        rig.start(seams=seams)

    assert error.value.code is ErrorCode.SETUP_FAILED
    assert "did not become ready" in error.value.detail
    assert rig.engine.container(DOOR_CONTAINER_NAME).removed


# #745-T07
def test_a_door_that_dies_on_start_names_its_exit_code(rig: Rig) -> None:
    def dies(stdin: BinaryIO, stdout: Any, stderr: Any) -> int:
        return 3

    rig.engine.behaviour = dies

    with pytest.raises(JobError) as error:
        rig.start()

    assert error.value.code is ErrorCode.SETUP_FAILED
    assert "exit code 3" in error.value.detail


# -- the door that is killed during the turn ------------------------------------------------------


# #745-T08
def test_a_door_killed_before_any_call_ends_the_turn_free_and_named(rig: Rig) -> None:
    door = rig.start()

    rig.engine.kill(DOOR_CONTAINER_NAME, exit_code=137)

    assert _wait(lambda: door.state.lost is not None)
    failure = door.state.failure()
    assert failure is not None and failure.code is ErrorCode.RUNNER_ERROR
    assert "model door" in failure.detail and "137" in failure.detail
    assert door.state.model_used is False
    code, detail = classify(failure, used_model=door.state.model_used)
    assert code is ErrorCode.RUNNER_ERROR, "free: the model was never used"
    assert "model door" in detail
    door.stop()


# #745-T08
def test_a_door_killed_after_a_billed_call_ends_the_turn_charged_and_named(rig: Rig) -> None:
    door = rig.start()
    post(rig.door_url)
    assert _wait(lambda: door.state.model_used)

    rig.engine.kill(DOOR_CONTAINER_NAME, exit_code=137, oom=True)

    assert _wait(lambda: door.state.lost is not None)
    failure = door.state.failure()
    assert failure is not None
    assert "memory" in failure.detail, "an out-of-memory kill says so"
    assert door.state.model_used is True
    code, _ = classify(failure, used_model=True)
    assert code is ErrorCode.AGENT_GAVE_UP, (
        "charged: the model was used (outcome.ts: agent_gave_up)"
    )
    assert door.state.upstream_error is None, "the door is the cause, not the provider"
    door.stop()


# -- the session: the same flows as before, through the door --------------------------------------


def door_session(rig: Rig, *, max_cost: float | None = 2.5) -> ImplementerSession:
    job = parse_implementer_input(implementer_job_text(max_cost=max_cost))
    return ImplementerSession(
        job,
        workspace=cast("Any", None),  # not read by the model's start and end
        command=["opencode"],
        egress=EgressSettings(ImplementerNetwork.NONE, None),
        environment={MODEL_DOOR_VARIABLE: MODEL_DOOR_MODE},
        seams=SessionSeams(door=rig.seams),
    )


# #745-T09
def test_the_session_starts_its_model_at_the_door_and_the_agent_gets_the_door_and_a_dummy_key(
    rig: Rig,
) -> None:
    session = door_session(rig)

    model = session._start_model()  # pyright: ignore[reportPrivateUsage]

    assert model.door is not None and model.url.startswith(f"http://{MODEL_DOOR_ADDRESS}:")
    assert model.capability != API_KEY and len(model.capability) >= 32
    assert API_KEY in session.secrets(), "the key is still scrubbed from every output of the turn"
    assert model.capability in session.secrets()
    assert session.ledger is model.ledger
    config = build_engine_config(
        provider=native_provider_config(
            model.entry,
            base_url=spec_of(WireFamily(model.entry.family)).proxy_base_url(model.url),
            api_key=model.capability,
            door_host=MODEL_DOOR_ADDRESS,
        ),
        model_reference=native_model_reference(model.entry),
        family=WireFamily(model.entry.family),
        proxy_url=model.url,
        capability=model.capability,
        instructions_path="/instructions.md",
        door_host=MODEL_DOOR_ADDRESS,
    )
    assert API_KEY not in json.dumps(config), "the agent is handed the door and a bearer, no key"
    model.stop()


# #745-T09
def test_the_cost_limit_at_the_door_ends_the_session_cost_limit_reached(rig: Rig) -> None:
    session = door_session(rig, max_cost=0.000001)
    model = session._start_model()  # pyright: ignore[reportPrivateUsage]
    rig.upstream_calls = len(rig.upstream.requests)  # type: ignore[attr-defined]

    status, _ = post(rig.door_url, capability=model.capability)

    assert status >= 400
    assert _wait(lambda: model.ledger.failure is not None)
    failure = model.ledger.failure
    assert failure is not None
    session._stopped_by(failure)  # pyright: ignore[reportPrivateUsage]
    assert session._error is not None  # pyright: ignore[reportPrivateUsage]
    assert session._error[0] is ErrorCode.COST_LIMIT_REACHED  # pyright: ignore[reportPrivateUsage]
    assert rig.upstream.requests == [], "refused at the door, the provider was not asked"
    model.stop()


# #745-T09
def test_a_call_that_is_billed_is_in_the_usage_of_the_session(rig: Rig) -> None:
    session = door_session(rig)
    model = session._start_model()  # pyright: ignore[reportPrivateUsage]

    status, _ = post(rig.door_url, capability=model.capability)
    assert status == 200
    assert _wait(lambda: model.ledger.model_used)
    model.stop()

    usage = session._usage()  # pyright: ignore[reportPrivateUsage]
    assert usage.used_the_model and usage.ai_calls == 1
    assert usage.cost_usd is not None and usage.cost_usd > 0
    assert usage.call_trace is not None and len(usage.call_trace["modelCalls"]) == 1


# #745-T08
def test_a_killed_door_after_a_call_ends_the_session_charged_and_the_cost_is_not_made_up(
    rig: Rig,
) -> None:
    session = door_session(rig)
    model = session._start_model()  # pyright: ignore[reportPrivateUsage]
    post(rig.door_url, capability=model.capability)
    assert _wait(lambda: model.ledger.model_used)

    rig.engine.kill(DOOR_CONTAINER_NAME, exit_code=1)

    assert _wait(lambda: model.ledger.failure is not None)
    failure = model.ledger.failure
    assert failure is not None
    session._stopped_by(failure)  # pyright: ignore[reportPrivateUsage]
    assert session._error is not None  # pyright: ignore[reportPrivateUsage]
    assert session._error[0] is ErrorCode.AGENT_GAVE_UP  # pyright: ignore[reportPrivateUsage]
    assert "model door" in session._error[1]  # pyright: ignore[reportPrivateUsage]
    model.stop()


# #745-T08
def test_a_door_that_will_not_start_is_the_free_setup_failure_of_the_session(rig: Rig) -> None:
    rig.engine.refuse["/networks/create"] = 500
    session = door_session(rig)

    with pytest.raises(JobError) as error:
        session._start_model()  # pyright: ignore[reportPrivateUsage]

    session._stopped_by(error.value)  # pyright: ignore[reportPrivateUsage]
    assert session._error is not None  # pyright: ignore[reportPrivateUsage]
    assert session._error[0] is ErrorCode.SETUP_FAILED  # pyright: ignore[reportPrivateUsage]
    assert "model_door_unavailable" in session._error[1]  # pyright: ignore[reportPrivateUsage]


# #745-T09
def test_without_the_variable_the_proxy_stays_in_the_worker_as_before(rig: Rig) -> None:
    job = parse_implementer_input(implementer_job_text())
    session = ImplementerSession(
        job,
        workspace=cast("Any", None),
        command=["opencode"],
        egress=EgressSettings(ImplementerNetwork.NONE, None),
        environment={},
        seams=SessionSeams(upstream_for=lambda _url: cast("Any", object()), door=rig.seams),
    )

    model = session._start_model()  # pyright: ignore[reportPrivateUsage]

    assert model.door is None and model.server is not None
    assert url_of(model).startswith("http://127.0.0.1:")
    assert rig.engine.calls == [], "the daemon was not asked for anything"
    model.stop()


def url_of(model: Any) -> str:
    return cast("str", model.url)


# -- the client of the daemon ---------------------------------------------------------------------


# #745-T05
def test_the_client_reports_a_daemon_that_answers_an_error_with_its_status(rig: Rig) -> None:
    rig.engine.refuse["/networks/create"] = 409
    api = rig.seams.api()

    with pytest.raises(DockerError) as error:
        api.create_network(network_document())

    assert error.value.status == 409


# #745-T05
def test_the_client_pings_and_names_a_daemon_that_does_not_answer(rig: Rig) -> None:
    api = rig.seams.api()
    assert api.ping() is True
    rig.engine.answers_ping = False
    assert api.ping() is False
    rig.stop()
    assert api.ping() is False


def _wait(condition: Any, seconds: float = 5.0) -> bool:
    import time

    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if condition():
            return True
        time.sleep(0.02)
    return bool(condition())


assert SimpleNamespace and WireFamily and spec_of  # names the support module also uses
