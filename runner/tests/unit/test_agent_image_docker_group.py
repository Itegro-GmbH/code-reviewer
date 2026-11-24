# SPDX-License-Identifier: LicenseRef-Proprietary

"""The agent image's `docker` group (#1138): the agent's own `dockerd` gives its socket to it, and
the Claude Code layer's user (not root) is a member, so `docker ps` works in the agent's tools as it
does for the hosted agent, which is root. Read from the files; the daemon itself runs in CI's image
build and the DevBox probe."""

import re
from pathlib import Path

from code_reviewer_runner.implementer.claude_code.command import AGENT_UID

RUNNER = Path(__file__).resolve().parents[2]
DOCKERFILE = (RUNNER / "Dockerfile").read_text(encoding="utf-8")


def agent_stage() -> str:
    start = DOCKERFILE.index("AS agent\n")
    return DOCKERFILE[start : DOCKERFILE.index("\nFROM ", start)]


# #1138-T01
def test_the_agent_image_has_the_docker_group_with_a_number_that_is_nobody_s_primary_group() -> (
    None
):
    found = re.search(r"groupadd --system --gid (\d+) docker\b", agent_stage())

    assert found is not None
    gid = int(found.group(1))
    assert gid not in (0, AGENT_UID) and gid > 10000, "not a number another user or group has"
    assert not re.search(r"usermod|useradd[^\n]*docker", agent_stage()), (
        "the image puts no user into the group: root needs none, the layer's user is added there"
    )


# #1138-T01
def test_the_init_starts_the_daemon_with_that_group_and_changes_nothing_of_the_vm_s_docker() -> (
    None
):
    script = (RUNNER / "docker" / "agent-init.sh").read_text(encoding="utf-8")

    assert "--group docker" in script
    assert "chmod 666" not in script and "chmod 0666" not in script and "chmod a+" not in script
    assert "tcp://" not in script, "no listener besides the unix socket"
