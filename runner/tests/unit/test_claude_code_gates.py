# SPDX-License-Identifier: LicenseRef-Proprietary

"""The gates of a turn that runs on the device's login (#856): the network of the agent's
container, no new privileges, and the check that the device can run the harness at all."""

import pytest

from code_reviewer_runner.implementer.agent_container import agent_document
from code_reviewer_runner.implementer.claude_code.gates import (
    ANTHROPIC_HOST,
    NETWORK_HOSTS_REASON,
    NETWORK_OPEN_REASON,
    subscription_rule,
)
from code_reviewer_runner.implementer.network_rule import MODE_LIST, NetworkRule
from code_reviewer_runner.job import JobError
from code_reviewer_runner.result import ErrorCode

pytestmark = pytest.mark.unit

OFF = NetworkRule()
OPEN = NetworkRule("open")


# #856-N01
def test_a_subscription_turn_reaches_the_anthropic_api_and_nothing_else() -> None:
    rule = subscription_rule(OFF)

    assert rule == NetworkRule(MODE_LIST, ("api.anthropic.com",), ports=(443,))
    assert ANTHROPIC_HOST == "api.anthropic.com" and not ANTHROPIC_HOST.startswith("*")


# #856-P04
def test_the_door_entry_of_a_subscription_turn_allows_443_only() -> None:
    """Claude Code speaks TLS: port 80 of the API host is not needed and not opened."""
    assert subscription_rule(OFF).ports == (443,)
    assert subscription_rule(NetworkRule(MODE_LIST, ("api.anthropic.com",))).ports == (443,)
    assert subscription_rule(OFF).to_json()["ports"] == [443]


# #856-N01
def test_an_environment_that_lists_exactly_that_host_is_what_the_turn_gets_anyway() -> None:
    assert subscription_rule(NetworkRule(MODE_LIST, ("api.anthropic.com",))) == subscription_rule(
        OFF
    )


# #856-N02
def test_an_open_environment_refuses_the_turn_with_a_clear_reason() -> None:
    with pytest.raises(JobError) as refused:
        subscription_rule(OPEN)

    assert refused.value.code is ErrorCode.IMPLEMENTER_CONFIG_INVALID
    assert refused.value.detail.startswith(NETWORK_OPEN_REASON)


# #856-N02
@pytest.mark.parametrize(
    "hosts",
    [
        ("api.anthropic.com", "registry.npmjs.org"),
        ("*.anthropic.com",),
        ("*.github.com", "api.anthropic.com"),
        ("example.org",),
    ],
)
def test_an_environment_that_lists_other_hosts_refuses_the_turn(hosts: tuple[str, ...]) -> None:
    with pytest.raises(JobError) as refused:
        subscription_rule(NetworkRule(MODE_LIST, hosts))

    assert refused.value.code is ErrorCode.IMPLEMENTER_CONFIG_INVALID
    assert refused.value.detail.startswith(NETWORK_HOSTS_REASON)


# #856-N02
def test_the_refusal_does_not_name_the_hosts_of_the_environment() -> None:
    with pytest.raises(JobError) as refused:
        subscription_rule(NetworkRule(MODE_LIST, ("secret-internal.example.org",)))

    assert "secret-internal" not in refused.value.detail


# #856-P01
def test_the_agent_container_can_be_made_without_new_privileges() -> None:
    plain = agent_document("img", "vol", 2**30)["HostConfig"]
    sealed = agent_document("img", "vol", 2**30, no_new_privileges=True)["HostConfig"]

    assert "SecurityOpt" not in plain  # the hosted OpenCode agent is root and free, as before
    assert sealed["SecurityOpt"] == ["no-new-privileges"]
    assert sealed["Privileged"] is False
