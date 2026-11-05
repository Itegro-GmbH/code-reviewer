# SPDX-License-Identifier: LicenseRef-Proprietary

"""The container of a turn on the harness `claude-code` on a real Docker daemon (#856).

What only a daemon shows: the agent's container made for the Claude Code agent carries
`no-new-privileges`, and it holds for every process started in it, root's and a user's, while the
container still comes up (its init, the setup of the work directories as root) and keeps no
privilege beyond the hosted agent's. The hosted agent's container is not sealed, as before. The
network door's rule for such a turn (`api.anthropic.com` alone) is the door's ordinary `list` rule,
proven by `test_network_door.py`; the program in the container is proven by the engine suite."""

import json
from pathlib import Path

from lane_support import docker, lane_config, lane_workspace, model_network

from code_reviewer_runner.dynamic_review.static_isolation import slot_ports
from code_reviewer_runner.implementer.agent_container import (
    AGENT_CONTAINER_NAME,
    AgentContainer,
    AgentSeams,
)


def seams(lane_control: str, sealed: bool) -> AgentSeams:
    config = lane_config()
    return AgentSeams(
        hostname=lambda: lane_control,
        image=config.agent_image,
        helper_image=config.agent_image,
        runtime=config.runtime,
        entrypoint=config.entrypoint,
        ready_seconds=180.0,
        no_new_privileges=sealed,
    )


def no_new_privs(user: str) -> str:
    done = docker(
        "exec",
        "--user",
        user,
        AGENT_CONTAINER_NAME,
        "sh",
        "-c",
        "grep '^NoNewPrivs:' /proc/self/status",
    )
    return done.stdout.strip()


# #856-P02
def test_the_claude_code_agents_container_runs_every_process_with_no_new_privileges(
    tmp_path: Path,
) -> None:
    config = lane_config()
    with lane_workspace(tmp_path) as lane, model_network(config, slot_ports({}).proxy):
        agent = AgentContainer(2048, seams(lane.control, True))
        agent.create()
        try:
            host = json.loads(docker("inspect", AGENT_CONTAINER_NAME).stdout)[0]["HostConfig"]
            assert host["SecurityOpt"] == ["no-new-privileges"]
            assert host["Privileged"] is False
            assert no_new_privs("0:0") == "NoNewPrivs:\t1"
            assert no_new_privs("10201:10201") == "NoNewPrivs:\t1"
        finally:
            agent.stop()
            agent.remove()


# #856-P02
def test_the_hosted_agents_container_is_not_sealed_as_before(tmp_path: Path) -> None:
    config = lane_config()
    with lane_workspace(tmp_path) as lane, model_network(config, slot_ports({}).proxy):
        agent = AgentContainer(2048, seams(lane.control, False))
        agent.create()
        try:
            host = json.loads(docker("inspect", AGENT_CONTAINER_NAME).stdout)[0]["HostConfig"]
            assert not host.get("SecurityOpt")
            assert no_new_privs("0:0") == "NoNewPrivs:\t0"
        finally:
            agent.stop()
            agent.remove()
