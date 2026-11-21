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
from code_reviewer_runner.implementer.netdoor.registries import (
    intercepted_domains,
    interceptor_for,
    rule_has_registries,
)
from code_reviewer_runner.implementer.network_rule import (
    MODE_LIST,
    NetworkRule,
    RuleError,
    parse_door_rule,
)
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


# #1126-T01
def test_the_hosts_a_step_lists_are_read_only_and_on_443_beside_the_api_host() -> None:
    rule = subscription_rule(
        NetworkRule(MODE_LIST, ("fonts.googleapis.com", "*.gstatic.com", "lateinorum.de"))
    )

    assert rule.mode == MODE_LIST and rule.ports == (443,)
    assert rule.hosts == (
        "api.anthropic.com",
        "fonts.googleapis.com",
        "*.gstatic.com",
        "lateinorum.de",
    )
    # The API host stays a tunnel (Claude Code posts to it); everything else is only read.
    assert rule.read_only == ("fonts.googleapis.com", "*.gstatic.com", "lateinorum.de")
    assert ANTHROPIC_HOST not in rule.read_only


# #1126-T02
@pytest.mark.parametrize(
    "hosts",
    [
        ("api.anthropic.com", "registry.npmjs.org"),
        ("*.github.com", "api.anthropic.com"),
        ("example.org",),
    ],
)
def test_a_list_with_other_hosts_is_no_longer_refused(hosts: tuple[str, ...]) -> None:
    rule = subscription_rule(NetworkRule(MODE_LIST, hosts))

    assert rule.hosts[0] == ANTHROPIC_HOST
    assert set(rule.read_only) == set(hosts) - {ANTHROPIC_HOST}


# #1126-T07
@pytest.mark.parametrize("entry", ["*.anthropic.com"])
def test_a_wildcard_over_the_model_host_refuses_the_turn(entry: str) -> None:
    with pytest.raises(JobError) as refused:
        subscription_rule(NetworkRule(MODE_LIST, (entry, "example.org")))

    assert refused.value.code is ErrorCode.IMPLEMENTER_CONFIG_INVALID
    assert refused.value.detail.startswith(NETWORK_HOSTS_REASON)
    # A wildcard that does not cover it is only another read-only host.
    assert subscription_rule(NetworkRule(MODE_LIST, ("*.example.org",))).read_only == (
        "*.example.org",
    )


# #1126-T03
def test_the_read_only_hosts_travel_in_the_door_document_and_come_back() -> None:
    rule = subscription_rule(NetworkRule(MODE_LIST, ("example.org",)))

    assert rule.to_json() == {
        "mode": "list",
        "hosts": ["api.anthropic.com", "example.org"],
        "ports": [443],
        "readOnly": ["example.org"],
    }
    assert parse_door_rule(rule.to_json()) == rule


# #1126-T04
def test_a_rule_without_extra_hosts_has_nothing_read_only() -> None:
    assert subscription_rule(OFF).read_only == ()
    assert "readOnly" not in subscription_rule(OFF).to_json()


# #1126-T05
@pytest.mark.parametrize(
    "document",
    [
        {"mode": "list", "hosts": ["a.example.org"], "readOnly": ["b.example.org"]},
        {"mode": "list", "hosts": ["a.example.org"], "readOnly": []},
        {"mode": "list", "hosts": ["a.example.org"], "readOnly": "a.example.org"},
        {"mode": "open", "hosts": [], "readOnly": ["a.example.org"]},
    ],
)
def test_the_door_refuses_a_read_only_set_that_is_not_part_of_the_list(
    document: dict[str, object],
) -> None:
    with pytest.raises(RuleError):
        parse_door_rule(document)


# #1126-T06
def test_the_door_reads_the_registries_and_the_read_only_hosts_and_tunnels_the_rest() -> None:
    rule = subscription_rule(NetworkRule(MODE_LIST, ("fonts.googleapis.com", "*.gstatic.com")))
    intercepts = interceptor_for(rule)

    assert rule_has_registries(rule)
    assert intercepts("fonts.googleapis.com") and intercepts("fonts.gstatic.com")
    assert not intercepts("gstatic.com"), "a suffix entry is the names below it"
    assert not intercepts(ANTHROPIC_HOST), "the API host is a tunnel: Claude Code posts to it"
    assert intercepts("registry.npmjs.org"), "registries are read-only as before"
    # The door's certificate is limited to what it is for: the listed names, not their parents.
    domains = intercepted_domains(rule)
    assert "fonts.googleapis.com" in domains and "gstatic.com" in domains
    assert "googleapis.com" not in domains and ANTHROPIC_HOST not in domains
    assert not rule_has_registries(subscription_rule(OFF))


# #856-P01
def test_the_agent_container_can_be_made_without_new_privileges() -> None:
    plain = agent_document("img", "vol", 2**30)["HostConfig"]
    sealed = agent_document("img", "vol", 2**30, no_new_privileges=True)["HostConfig"]

    assert "SecurityOpt" not in plain  # the hosted OpenCode agent is root and free, as before
    assert sealed["SecurityOpt"] == ["no-new-privileges"]
    assert sealed["Privileged"] is False
