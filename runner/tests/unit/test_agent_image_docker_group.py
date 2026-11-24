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


# #1138-T02
def test_the_docker_group_s_number_is_none_of_the_ids_the_image_files_make() -> None:
    # The Dockerfile's comment says the number is not the engine's (10101), the layer's user's
    # (10201) or the runner's (10001): every other numeric id the file makes is checked, not only
    # the one that is `> 10000`.
    gid = int(re.search(r"groupadd --system --gid (\d+) docker\b", agent_stage()).group(1))  # pyright: ignore[reportOptionalMemberAccess]
    others = {int(n) for n in re.findall(r"(?:--gid|--uid)[ =](\d+)", DOCKERFILE)} - {gid}
    assert {10001, 10101} <= others
    assert gid not in others | {10001, 10101, 10201}, "the group is nobody else's primary group"


# #1138-T02
def test_no_stage_but_the_agent_s_has_the_docker_group_and_the_engine_user_is_not_in_it() -> None:
    # The engine (uid 10101) and the Worker (10001) are in `sandbox` / `runtime-base`, which are
    # not built from the agent stage: the group, and the socket it opens, are not in their image.
    agent = agent_stage()
    rest = DOCKERFILE.replace(agent, "")
    assert not re.search(r"\bdocker\b[^\n]*\bgroupadd|groupadd[^\n]*\bdocker\b", rest)
    assert not re.search(r"usermod|--groups|-G\s", rest), "no user of those stages gets a group"
    assert not re.search(r"(?m)^FROM\s+\S*\s+AS\s+(runtime-base|sandbox)\b.*agent", DOCKERFILE)
    assert "FROM runtime-base AS sandbox" in DOCKERFILE and "COPY --from=agent" not in rest
    for line in re.findall(r"useradd[^\n]*(?:\\\n[^\n]*)*", rest):
        assert "docker" not in line


# #1138-T01
def test_the_init_starts_the_daemon_with_that_group_and_changes_nothing_of_the_vm_s_docker() -> (
    None
):
    script = (RUNNER / "docker" / "agent-init.sh").read_text(encoding="utf-8")

    assert "--group docker" in script
    assert "chmod 666" not in script and "chmod 0666" not in script and "chmod a+" not in script
    assert "tcp://" not in script, "no listener besides the unix socket"
