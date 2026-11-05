# SPDX-License-Identifier: LicenseRef-Proprietary

"""The labels of the containers and networks of Control (#854, R1b): the role always, the runner's
id when a customer's runner names one, so that it removes only its own."""

from typing import Any

import pytest

from code_reviewer_runner.implementer import (
    agent_container,
    door_launcher,
    host_rules,
    netdoor_launcher,
    reader,
    setup_container,
)
from code_reviewer_runner.implementer.role_labels import (
    ROLE_LABEL,
    RUNNER_ID_VARIABLE,
    RUNNER_LABEL,
    role_labels,
)

pytestmark = pytest.mark.unit

IMAGE = "sha256:" + "a" * 64


def everything_control_creates() -> list[dict[str, Any]]:
    return [
        door_launcher.network_document(),
        door_launcher.door_document(IMAGE),
        door_launcher.rules_document(IMAGE, "door"),
        netdoor_launcher.door_document(IMAGE),
        netdoor_launcher.rules_document(IMAGE, "door"),
        agent_container.agent_document(IMAGE, "volume", 1024),
        setup_container.network_document(),
        setup_container.setup_document(IMAGE, "volume", 1024),
        reader.reader_document(IMAGE, "volume"),
        reader.reader_document(IMAGE, "volume", writable=True),
        host_rules.helper_document(IMAGE, ["/bin/true"], [], "host-rules"),
    ]


# #854-R1
def test_every_container_and_network_carries_the_id_of_the_runner_that_made_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(RUNNER_ID_VARIABLE, "runner-1")

    documents = everything_control_creates()

    assert len(documents) == 11
    for document in documents:
        assert document["Labels"][RUNNER_LABEL] == "runner-1"
        assert document["Labels"][ROLE_LABEL]


# #854-R1
def test_the_hosted_control_sets_no_id_and_its_labels_are_the_role_alone(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv(RUNNER_ID_VARIABLE, raising=False)

    for document in everything_control_creates():
        assert list(document["Labels"]) == [ROLE_LABEL]


def test_an_environment_given_is_used_instead_of_the_process_s() -> None:
    assert role_labels("agent", {RUNNER_ID_VARIABLE: " r1 "}) == {
        ROLE_LABEL: "agent",
        RUNNER_LABEL: "r1",
    }
    assert role_labels("agent", {RUNNER_ID_VARIABLE: "  "}) == {ROLE_LABEL: "agent"}
