# SPDX-License-Identifier: LicenseRef-Proprietary

"""The network door with no model door beside it, on a real Docker daemon (#856).

A turn on the harness `claude-code` has no model door, which is what makes the model network
otherwise. The network door makes the network itself, sits on it, and takes it away with itself;
the unit tests prove that against the fake daemon, this proves it against the real one: the network
is there while the door runs, it is internal (no exit of its own), the door is a member, and both
are gone after `stop()`. The door's behaviour is proven by `test_network_door.py`."""

import json
import os
from collections.abc import Iterator

import pytest
from lane_support import docker, lane_config

from code_reviewer_runner.dynamic_review.model_door_route import MODEL_NETWORK_NAME
from code_reviewer_runner.implementer.docker_api import DOCKER_SOCKET, DockerApi
from code_reviewer_runner.implementer.netdoor_launcher import (
    NETDOOR_CONTAINER_NAME,
    RULES_CONTAINER_NAME,
    NetDoorSeams,
    start_network_door,
)
from code_reviewer_runner.implementer.network_rule import MODE_LIST, NetworkRule

CONTROL = "code-reviewer-lane-net-alone-control"
LABEL = ["--label", "code-reviewer.lane=1"]
RULE = NetworkRule(MODE_LIST, ("api.anthropic.com",), ports=(443,))


def api() -> DockerApi:
    host = os.environ.get("DOCKER_HOST", "")
    path = host.removeprefix("unix://") if host.startswith("unix://") else DOCKER_SOCKET
    return DockerApi(path, timeout=30.0)


def remove_everything() -> None:
    for name in (NETDOOR_CONTAINER_NAME, RULES_CONTAINER_NAME, CONTROL):
        docker("rm", "-f", name, check=False)
    docker("network", "rm", MODEL_NETWORK_NAME, check=False)


@pytest.fixture
def control() -> Iterator[None]:
    config = lane_config()
    remove_everything()
    # The stand-in of Control: the launcher takes the door's image from the container it runs in.
    docker(
        "run", "-d", "--name", CONTROL, *LABEL, "--entrypoint", "/usr/bin/tini",
        config.worker_image, "--", "sleep", "3600",
    )  # fmt: skip
    try:
        yield
    finally:
        remove_everything()


# #856-P05
def test_the_door_makes_the_model_network_when_no_model_door_did_and_removes_it(
    control: None,
) -> None:
    assert docker("network", "inspect", MODEL_NETWORK_NAME, check=False).returncode != 0
    seams = NetDoorSeams(api=api, hostname=lambda: CONTROL, ready_seconds=60.0)

    door = start_network_door(RULE, deadline_seconds=120.0, seams=seams)
    try:
        network = json.loads(docker("network", "inspect", MODEL_NETWORK_NAME).stdout)[0]
        door_id = docker("inspect", "--format", "{{.Id}}", NETDOOR_CONTAINER_NAME).stdout.strip()
        assert network["Internal"] is True, "no exit of its own"
        assert door_id in network["Containers"], "the door is on the network it made"
    finally:
        door.stop()

    assert docker("network", "inspect", MODEL_NETWORK_NAME, check=False).returncode != 0
    assert docker("inspect", NETDOOR_CONTAINER_NAME, check=False).returncode != 0
