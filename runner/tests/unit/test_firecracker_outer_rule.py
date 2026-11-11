# SPDX-License-Identifier: LicenseRef-Proprietary

"""The rule language of the outer wall (#979): the local proxy reads the same rules as the hosted
Dispatcher's rule code (`dispatcher/src/network/rule.ts`). Both suites read
`contracts/network-rule-examples.json` and must give its answers; the TypeScript one is
`dispatcher/src/network/network-examples.test.ts`."""

import json
from pathlib import Path
from typing import Any

import pytest

from code_reviewer_runner.factory_runner.firecracker.outer_rule import (
    WIDE,
    OuterRuleError,
    allow_list,
    narrowed_rule,
)
from code_reviewer_runner.implementer.netdoor.connections import ConnectionLog
from code_reviewer_runner.implementer.netdoor.proxy import Decider
from code_reviewer_runner.implementer.network_rule import (
    MODE_LIST,
    MODE_OPEN,
    NetworkRule,
    RuleError,
    parse_rule,
)

EXAMPLES: dict[str, Any] = json.loads(
    (Path(__file__).resolve().parents[3] / "contracts" / "network-rule-examples.json").read_text()
)
PUBLIC = "93.184.216.34"


def _cases(key: str) -> list[Any]:
    return [pytest.param(case, id=case.get("name", case.get("host"))) for case in EXAMPLES[key]]


def _rule(document: dict[str, Any]) -> NetworkRule:
    return parse_rule(document)


# #979-T03
@pytest.mark.unit
@pytest.mark.parametrize("case", _cases("rules"))
def test_a_rule_document_is_a_rule_as_the_hosted_code_says(case: dict[str, Any]) -> None:
    if case["valid"]:
        assert parse_rule(case["rule"]).mode == case["rule"]["mode"]
        return
    with pytest.raises(RuleError):
        parse_rule(case["rule"])


# #979-T03
@pytest.mark.unit
@pytest.mark.parametrize("case", _cases("allowLists"))
def test_the_narrowed_list_is_the_one_the_hosted_code_makes(case: dict[str, Any]) -> None:
    found = allow_list(_rule(case["rule"]), case["modelHost"], case["appHost"])

    if case["allow"] is None:
        assert found is None
        return
    assert found is not None
    assert set(found) == set(case["allow"])
    assert len(found) == len(set(found))


# #979-T03
@pytest.mark.unit
@pytest.mark.parametrize("case", _cases("verdicts"))
def test_a_name_has_the_verdict_of_the_hosted_rule_code(case: dict[str, Any]) -> None:
    entry = next(each for each in EXAMPLES["allowLists"] if each["name"] == case["list"])
    rule = narrowed_rule(_rule(entry["rule"]), entry["modelHost"], entry["appHost"])
    # The real decision of the proxy with the lookup answered by a public address: the verdict is
    # the rule's (the address check has tests of its own).
    decider = Decider(rule, ConnectionLog(), resolver=lambda _name, _port: [PUBLIC])

    assert decider.decide(case["host"], case["port"]).allowed is case["allowed"]


@pytest.mark.unit
def test_open_is_not_narrowed_and_the_setup_runs_under_the_wide_rule() -> None:
    assert WIDE == NetworkRule(MODE_OPEN)
    assert narrowed_rule(NetworkRule(MODE_OPEN), "api.anthropic.com", "app.example.test") == WIDE


@pytest.mark.unit
def test_the_narrowed_rule_is_a_list_of_the_names_and_nothing_else() -> None:
    rule = narrowed_rule(
        NetworkRule(MODE_LIST, ("registry.npmjs.org",)), "api.anthropic.com", "app.example.test"
    )

    assert rule.mode == MODE_LIST
    assert rule.ports == ()
    assert set(rule.hosts) == {
        "github.com",
        "api.github.com",
        "api.anthropic.com",
        "app.example.test",
        "registry.npmjs.org",
    }


@pytest.mark.unit
@pytest.mark.parametrize("app_host", [None, "", "10.0.0.5", "localhost", "App.Example.Test"])
def test_an_app_that_cannot_be_named_in_a_rule_is_an_error_not_a_hole(app_host: str | None) -> None:
    # The proxy refuses an address and cannot name a host of one label, so the Worker could not
    # reach its app after the narrowing: the wall says so instead of holding a rule that cannot work.
    with pytest.raises(OuterRuleError):
        narrowed_rule(NetworkRule(), "api.anthropic.com", app_host)


@pytest.mark.unit
def test_a_model_host_that_is_no_name_is_an_error() -> None:
    with pytest.raises(OuterRuleError):
        narrowed_rule(NetworkRule(), "10.0.0.5", "app.example.test")
