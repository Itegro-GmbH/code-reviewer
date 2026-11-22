# SPDX-License-Identifier: LicenseRef-Proprietary

"""The self-test of the agent's own Docker on the Incus backend (#1136): `agent-docker` is announced
only after a probe instance ran the Worker's own agent container and unpacked an image of three
layers in its Docker. The fake Incus answers the commands in the instance; the agent's container is
made by the real `AgentContainer` against a fake Docker Engine that stands for B's."""

import asyncio
import sys
import tempfile
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from incus_support import IMAGE_ID, FakeIncus, short_directory
from test_incus_parts import environment, runner_config

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from fakes.docker_engine.server import FakeDockerEngine

from code_reviewer_runner.factory_runner.incus import probe
from code_reviewer_runner.factory_runner.incus.client import ExecResult, IncusError
from code_reviewer_runner.factory_runner.incus.harnesses import PROPERTY_WORKER_FEATURES
from code_reviewer_runner.factory_runner.incus.instances import instance_spec
from code_reviewer_runner.factory_runner.incus.prepare import prepare_incus
from code_reviewer_runner.factory_runner.incus.settings import IncusSettings
from code_reviewer_runner.factory_runner.selftest import CHECK_AGENT_DOCKER, Check
from code_reviewer_runner.implementer.agent_container import INNER_DOCKER_DIRECTORY
from code_reviewer_runner.implementer.docker_api import DockerApi
from code_reviewer_runner.job_loop.worker_api import FEATURE_INNER_DOCKER_VOLUME, WORKER_FEATURES

pytestmark = pytest.mark.unit

OVERLAY_ERROR = (
    "failed to extract layer sha256:5bc1f3ef: failed to mount /tmp/containerd-mount1: mount "
    'source: "overlay", fstype: overlay, err: invalid argument'
)


class Rig:
    def __init__(self, root: Path, engine: FakeDockerEngine) -> None:
        self.settings = IncusSettings(
            pool="crpool", image_id=IMAGE_ID, state_dir=root, ready_seconds=1.0
        ).validated()
        self.incus = FakeIncus(self.settings)
        self.engine = engine
        self.sockets: list[str] = []
        self.scripts: list[str] = []
        self.answers: dict[str, ExecResult] = {}
        self.incus.responder = self.respond
        self.seams = probe.ProbeSeams(api=self.api)

    def api(self, path: str) -> DockerApi:
        self.sockets.append(path)
        return DockerApi(str(self.engine.socket_path), timeout=5.0, half_close=False)

    def respond(self, name: str, argv: tuple[str, ...]) -> ExecResult | None:
        if argv[:2] != ("sh", "-c"):
            return self.answers.get("docker-version")
        script = argv[2]
        self.scripts.append(script)
        if probe.PROBE_IMAGE in script and "docker save" in script:
            return self.answers.get("load", ExecResult(0, "tini version 0.19.0\n"))
        return self.answers.get("build", ExecResult(0))

    def run(self) -> Check:
        return asyncio.run(probe.probe_agent_docker(self.settings, self.incus, self.seams))


@pytest.fixture
def rig() -> Iterator[Rig]:
    with short_directory() as root, tempfile.TemporaryDirectory(dir="/tmp", prefix="probe-") as d:
        engine = FakeDockerEngine(Path(d) / "b.sock").start()
        engine.exec_behaviour = lambda made, stdin, stdout: 0  # pyright: ignore[reportUnknownLambdaType]
        yield Rig(root, engine)
        engine.stop()


def instances_left(rig: Rig) -> list[str]:
    return list(rig.incus.instances)


# #1136-T04
def test_the_probe_passes_only_after_the_three_layer_image_ran_in_the_agents_own_docker(
    rig: Rig,
) -> None:
    check = rig.run()

    assert check == Check(CHECK_AGENT_DOCKER, True, "")
    build, load = rig.scripts
    assert "COPY one /one" in build and "COPY two /two" in build and "docker build" in build
    # Loaded into the agent container's Docker (unpacks every layer there) and run there.
    assert "docker save cr-probe-layers | docker exec -i code-reviewer-agent docker load" in load
    assert "docker exec code-reviewer-agent docker run --rm --network none cr-probe-layers" in load
    assert instances_left(rig) == [], "the probe's instance is deleted"
    assert not list(rig.settings.jobs_dir.glob("job-*")), "and so is its directory"


# #1136-T05
def test_the_probe_runs_the_agents_container_as_a_job_does_with_its_data_root_on_a_volume(
    rig: Rig,
) -> None:
    rig.run()

    (container,) = rig.engine.containers.values()
    host = container.document["HostConfig"]
    assert host["Runtime"] == "runc" and host["Privileged"] is True
    data_roots = [m for m in host["Mounts"] if m["Target"] == INNER_DOCKER_DIRECTORY]
    assert [m["Type"] for m in data_roots] == ["volume"] and "Source" not in data_roots[0]
    assert not host.get("Binds")


# #1136-T06
def test_the_probe_instance_is_made_as_instance_b_of_a_job_with_the_hosts_socket_for_the_probe(
    rig: Rig,
) -> None:
    seen: list[Any] = []
    original = rig.incus.create

    async def create(spec: Any) -> None:
        seen.append(spec)
        await original(spec)

    rig.incus.create = create  # type: ignore[method-assign]
    devices: list[dict[str, str]] = []
    add = rig.incus.add_device

    async def add_device(name: str, device: str, config: Any) -> None:
        devices.append(dict(config))
        await add(name, device, config)

    rig.incus.add_device = add_device  # type: ignore[method-assign]

    rig.run()

    (spec,) = seen
    job = instance_spec(rig.settings, name=spec.name, role="b", job="x", slot=None)
    assert spec.name.startswith(f"{rig.settings.name_prefix}-b-selftest-")
    assert dict(spec.config) == {**job.config, "user.cr.job": probe.PROBE_MARK}
    assert (spec.image, spec.pool, spec.disk_gib) == (job.image, job.pool, job.disk_gib)
    (device,) = devices
    assert device["type"] == "proxy" and device["bind"] == "host" and device["mode"] == "0600"
    assert device["connect"] == "unix:/var/run/docker.sock"
    assert device["listen"] == f"unix:{rig.sockets[0]}"


# #1136-T07
def test_a_docker_that_cannot_unpack_a_second_layer_is_not_agent_docker_and_says_why(
    rig: Rig,
) -> None:
    """The failure of the live run: the pull works, the second layer's overlay mount does not."""
    rig.answers["load"] = ExecResult(125, "", OVERLAY_ERROR)

    check = rig.run()

    assert check.name == CHECK_AGENT_DOCKER and not check.ok
    assert "three layers" in check.detail and "err: invalid argument" in check.detail
    assert instances_left(rig) == []
    assert not list(rig.settings.jobs_dir.glob("job-*"))


# #1136-T08
def test_an_image_that_ran_but_printed_nothing_it_should_have_is_not_enough(rig: Rig) -> None:
    rig.answers["load"] = ExecResult(0, "")

    check = rig.run()

    assert not check.ok and "printed nothing" in check.detail
    assert instances_left(rig) == []


# #1136-T09
def test_a_probe_image_that_cannot_be_built_is_not_agent_docker(rig: Rig) -> None:
    rig.answers["build"] = ExecResult(1, "", "docker: command not found")

    check = rig.run()

    assert not check.ok and "the build failed" in check.detail
    assert instances_left(rig) == []
    assert rig.engine.containers == {}, "no agent container before there is an image"


# #1136-T10
def test_a_docker_that_never_answers_in_the_instance_is_not_agent_docker(rig: Rig) -> None:
    rig.answers["docker-version"] = ExecResult(1, "", "Cannot connect to the Docker daemon")

    check = rig.run()

    assert not check.ok and "Docker did not answer" in check.detail
    assert instances_left(rig) == []


# #1136-T11
def test_an_agent_container_that_cannot_be_made_is_not_agent_docker(rig: Rig) -> None:
    rig.engine.images.pop("code-reviewer-agent:golden")

    check = rig.run()

    assert not check.ok and "the agent's container could not be made" in check.detail
    assert instances_left(rig) == []


# #1136-T12
@pytest.mark.parametrize("operation", ["create", "start", "add_device"])
def test_incus_that_refuses_a_step_is_a_failed_check_never_an_exception(
    rig: Rig, operation: str
) -> None:
    rig.incus.fail[operation] = IncusError(operation, "storage pool is full")

    check = rig.run()

    assert not check.ok and "storage pool is full" in check.detail
    assert instances_left(rig) == []


# -- prepare_incus ---


def prepare(
    root: Path, incus: FakeIncus, probe_result: Check | None, *, features: str | None = None
) -> Any:
    asked: list[str] = []
    named = FEATURE_INNER_DOCKER_VOLUME if features is None else features
    incus.image_properties_of["code-reviewer-golden"] = {PROPERTY_WORKER_FEATURES: named}

    def agent_docker(settings: IncusSettings, client: Any) -> Check:
        asked.append(settings.image)
        assert probe_result is not None
        return probe_result

    prepared = prepare_incus(
        runner_config(),
        environment(FACTORY_RUNNER_VM_STATE_DIR=str(root)),
        client=incus.provision,
        agent_docker=agent_docker,
    )
    return prepared, asked


# #1136-T13
def test_the_runner_announces_agent_docker_only_when_the_probe_passed() -> None:
    with short_directory() as root:
        incus = FakeIncus(pool="crpool")

        ok, asked = prepare(root, incus, Check(CHECK_AGENT_DOCKER, True))
        failed, _ = prepare(root, incus, Check(CHECK_AGENT_DOCKER, False, "overlay"))

        assert asked == ["code-reviewer-golden"]
        assert "agent-docker" in ok.selftest.capabilities
        assert "agent-docker" not in failed.selftest.capabilities
        # A capability, not the base: the machine still takes jobs without it.
        assert failed.selftest.base_ok


# #1136-T14
def test_a_machine_that_is_not_ready_is_not_probed_and_has_no_agent_docker() -> None:
    with short_directory() as root:
        incus = FakeIncus(pool="crpool")
        incus.images.clear()

        prepared, asked = prepare(root, incus, None)

        assert asked == []
        assert "agent-docker" not in prepared.selftest.capabilities
        assert not prepared.selftest.base_ok


# #1136-T15
def test_an_image_whose_worker_lacks_the_volume_feature_is_not_probed_and_says_rebuild() -> None:
    """The probe runs this service's code, the jobs run the image's: a service on new code with an
    image that was not rebuilt must not announce what the jobs cannot do."""
    with short_directory() as root:
        incus = FakeIncus(pool="crpool")

        old, asked = prepare(
            root, incus, Check(CHECK_AGENT_DOCKER, True), features="implementer_multi_repo"
        )

        assert asked == []
        assert "agent-docker" not in old.selftest.capabilities and old.selftest.base_ok
        docker = next(c for c in old.selftest.checks if c.name == CHECK_AGENT_DOCKER)
        assert not docker.ok and "rebuild the golden image" in docker.detail


# #1136-T16
def test_the_worker_names_the_feature_the_golden_build_records_for_the_image() -> None:
    assert FEATURE_INNER_DOCKER_VOLUME in WORKER_FEATURES
