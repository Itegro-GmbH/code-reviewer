# SPDX-License-Identifier: LicenseRef-Proprietary

"""The Setup container on a customer's machine (#994): its internet is the host's outer-wall proxy
and nothing else. What these tests hold: the container gets the proxy variables from the host's
address, the VM's table lets its bridge reach that address and port and drops everything else
(no DNS, no other address, no other port), the seal check knows exactly those variables and no
others, and without a proxy everything is as hosted."""

from dataclasses import replace
from typing import Any

from test_setup_container import Rig, rig, run  # noqa: F401  # pyright: ignore[reportUnusedImport]

from code_reviewer_runner.implementer import host_rules
from code_reviewer_runner.implementer import setup_container as sc
from code_reviewer_runner.implementer.setup_container import (
    OUTCOME_OK,
    OUTCOME_UNAVAILABLE,
    setup_document,
)
from code_reviewer_runner.outer_proxy import OuterProxy

PROXY = OuterProxy("172.31.0.13", 3128)


def setup_container_of(rig: Rig) -> Any:  # noqa: F811
    return next(c for c in rig.engine.containers.values() if c.name == sc.SETUP_CONTAINER_NAME)


# #994-T03
def test_without_a_proxy_the_document_and_the_rules_are_the_hosted_ones() -> None:
    assert setup_document("sha256:aa", "volume-1", 1_000_000)["Env"] == []
    assert sc.egress_rules() == sc.EGRESS_RULES == sc.egress_rules(None)


# #994-T01
def test_with_a_proxy_the_container_gets_the_proxy_variables_and_nothing_else_changes() -> None:
    plain = setup_document("sha256:aa", "volume-1", 1_000_000)
    proxied = setup_document("sha256:aa", "volume-1", 1_000_000, outer_proxy=PROXY)

    assert {**proxied, "Env": []} == plain
    env = dict(entry.split("=", 1) for entry in proxied["Env"])
    assert env["HTTPS_PROXY"] == env["https_proxy"] == "http://172.31.0.13:3128"
    assert env["HTTP_PROXY"] == env["http_proxy"] == "http://172.31.0.13:3128"
    assert env["NO_PROXY"] == env["no_proxy"] == "localhost,127.0.0.1,::1"
    assert set(env) == {
        "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"
    }  # fmt: skip


# #994-T04
def test_with_a_proxy_the_bridge_may_reach_that_address_and_port_and_nothing_else_leaves_it() -> (
    None
):
    rules = sc.egress_rules(PROXY).split("; ")
    rule_lines = [r for r in rules if " rule " in r]

    accepts = [r for r in rule_lines if r.endswith(" accept")]
    assert accepts == [
        f'add rule ip {sc.EGRESS_TABLE} forward iifname "{sc.SETUP_BRIDGE}" '
        "ip daddr 172.31.0.13 tcp dport 3128 accept"
    ]
    forward = [r for r in rule_lines if " forward " in r]
    accept = forward.index(accepts[0])
    drop_all = forward.index(
        f'add rule ip {sc.EGRESS_TABLE} forward iifname "{sc.SETUP_BRIDGE}" drop'
    )
    # The proxy is let through before everything else from the bridge is dropped.
    assert accept < drop_all
    # The VM itself (input) stays closed, and so does the traffic between bridges.
    assert f'input iifname "{sc.SETUP_BRIDGE}" drop' in sc.egress_rules(PROXY)
    assert f'oifname "{sc.SETUP_BRIDGE}" iifname "docker0" drop' in sc.egress_rules(PROXY)
    # No DNS, no other port: the proxy resolves and dials.
    assert "dport 53" not in sc.egress_rules(PROXY) and "dport 443" not in sc.egress_rules(PROXY)
    assert all("priority -10" in r for r in rules if " chain " in r)
    assert "inet" not in sc.egress_rules(PROXY) and "ip6" not in sc.egress_rules(PROXY)


# #994-T01
def test_the_rules_the_vm_gets_are_the_proxys_and_go_in_before_the_container_exists(
    rig: Rig,  # noqa: F811
) -> None:
    done = run(rig, outer_proxy=PROXY)

    assert done.outcome == OUTCOME_OK, done.detail
    rules = next(
        c
        for c in rig.engine.containers.values()
        if c.name == host_rules.HELPER_NAME and c.document["Cmd"] == [sc.egress_rules(PROXY)]
    )
    assert rules.document["Cmd"] != [sc.EGRESS_RULES]
    env = dict(entry.split("=", 1) for entry in setup_container_of(rig).document["Env"])
    assert env["HTTPS_PROXY"] == "http://172.31.0.13:3128"


# #994-T03
def test_without_a_proxy_the_container_has_no_variable_and_the_hosted_rules_go_in(
    rig: Rig,  # noqa: F811
) -> None:
    done = run(rig)

    assert done.outcome == OUTCOME_OK
    assert setup_container_of(rig).document["Env"] == []
    assert any(
        c.name == host_rules.HELPER_NAME and c.document["Cmd"] == [sc.EGRESS_RULES]
        for c in rig.engine.containers.values()
    )


# #994-T04
def test_the_seal_check_accepts_the_proxys_variables_and_refuses_any_other_one(
    rig: Rig,  # noqa: F811
) -> None:
    def other(answer: dict[str, Any]) -> dict[str, Any]:
        entries = [*PROXY.tool_environment(), "GIT_TOKEN=x"]
        return {**answer, "Config": {"Env": entries}}

    rig.engine.inspect_override[sc.SETUP_CONTAINER_NAME] = other
    done = run(rig, outer_proxy=PROXY)

    assert done.outcome == OUTCOME_UNAVAILABLE and "environment" in done.detail
    assert rig.script_text == ""


# #994-T04
def test_a_container_without_the_proxy_it_was_given_is_not_what_was_asked_for(
    rig: Rig,  # noqa: F811
) -> None:
    def without(answer: dict[str, Any]) -> dict[str, Any]:
        return {**answer, "Config": {"Env": []}}

    rig.engine.inspect_override[sc.SETUP_CONTAINER_NAME] = without
    done = run(rig, outer_proxy=PROXY)

    assert done.outcome == OUTCOME_UNAVAILABLE and "environment" in done.detail


# #994-T04
def test_the_proxy_variables_are_refused_in_a_hosted_container(
    rig: Rig,  # noqa: F811
) -> None:
    def with_proxy(answer: dict[str, Any]) -> dict[str, Any]:
        return {**answer, "Config": {"Env": PROXY.tool_environment()}}

    rig.engine.inspect_override[sc.SETUP_CONTAINER_NAME] = with_proxy
    done = run(rig)

    assert done.outcome == OUTCOME_UNAVAILABLE and "environment" in done.detail


def test_the_seam_is_a_plain_field(rig: Rig) -> None:  # noqa: F811
    assert replace(rig.seams(), outer_proxy=PROXY).outer_proxy == PROXY
