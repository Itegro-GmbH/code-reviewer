# SPDX-License-Identifier: LicenseRef-Proprietary

"""Pins down the capability probe contract (#331) from the runner's side.

The `probe` entry mode prints a verdict (`ProbeVerdict`); the Dispatcher reads it and keeps only the
stable reasons of the closed list in `contracts/probe-verdict.v1.json`. The runner is the writer,
so what it can write must be valid under the file, and its list of reasons must be that list.
"""

import json
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from code_reviewer_runner.capabilities import ALL_ENGINES, KNOWN_ENGINES
from code_reviewer_runner.dynamic_review.self_check import SelfCheckReason
from code_reviewer_runner.verdict import Verdict

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"
Document = dict[str, Any]


def _load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


_PROBE: Document = _load(CONTRACTS / "probe-verdict.v1.json")
_RUNNER_API: Document = _load(CONTRACTS / "runner-api.v1.json")


def _registry() -> Registry[Any]:
    registry: Registry[Any] = Registry()
    for schema in (_PROBE, _RUNNER_API):
        registry = registry.with_resource(schema["$id"], Resource.from_contents(schema))
    return registry


_REGISTRY = _registry()


def _accepts(definition: str, document: Any) -> bool:
    validator = Draft202012Validator(
        {"$ref": f"{_PROBE['$id']}#/$defs/{definition}"}, registry=_REGISTRY
    )
    return bool(validator.is_valid(document))  # pyright: ignore[reportUnknownMemberType]


@pytest.mark.contract
@pytest.mark.parametrize("definition", ["ProbeVerdict", "ProbeReport"])
def test_every_example_is_valid(definition: str) -> None:
    # #331-T08
    example = _load(CONTRACTS / "examples" / "probe-verdict" / f"{definition}.json")

    assert _accepts(definition, example)


@pytest.mark.contract
def test_the_reasons_of_the_contract_are_the_self_check_reasons() -> None:
    # #331-T08
    listed = set(_PROBE["$defs"]["ProbeReason"]["enum"])

    # The one reason the Dispatcher's canary writes (#765) is the contract's, not the runner's.
    assert listed - {"implementer_probe_failed"} == {reason.value for reason in SelfCheckReason}
    assert "implementer_probe_failed" not in {reason.value for reason in SelfCheckReason}


@pytest.mark.contract
def test_the_implementer_reasons_are_in_the_list_and_only_they() -> None:
    # #765-T08
    implementer = {
        reason.value for reason in SelfCheckReason if reason.value.startswith("implementer_")
    }

    assert len(implementer) == 8
    assert implementer <= set(_PROBE["$defs"]["ProbeReason"]["enum"])
    assert "implementer_work_dir_not_exec" in implementer


@pytest.mark.contract
def test_the_engines_of_the_contract_are_the_engines_a_runner_can_advertise() -> None:
    # #765-T08
    assert _PROBE["$defs"]["ProbeEngine"]["enum"] == list(KNOWN_ENGINES)
    assert KNOWN_ENGINES[:2] == ALL_ENGINES


@pytest.mark.contract
def test_the_implementer_reasons_are_in_the_list_and_only_they() -> None:
    # #765-T08
    implementer = {
        reason.value for reason in SelfCheckReason if reason.value.startswith("implementer_")
    }

    assert len(implementer) == 8
    assert implementer <= set(_PROBE["$defs"]["ProbeReason"]["enum"])
    assert "implementer_work_dir_not_exec" in implementer


@pytest.mark.contract
def test_the_engines_of_the_contract_are_the_engines_a_runner_can_advertise() -> None:
    # #765-T08
    assert _PROBE["$defs"]["ProbeEngine"]["enum"] == list(KNOWN_ENGINES)
    assert KNOWN_ENGINES[:2] == ALL_ENGINES


@pytest.mark.contract
@pytest.mark.parametrize(
    "verdict",
    [
        Verdict(("pr-agent", "opencode")),
        Verdict(("pr-agent", "opencode", "implementer")),
        Verdict(("pr-agent", "opencode"), ("implementer_work_dir_not_exec",)),
        Verdict(("pr-agent",), (SelfCheckReason.ROOT_FILESYSTEM_WRITABLE.value,)),
        Verdict(("pr-agent",), tuple(reason.value for reason in SelfCheckReason)),
        Verdict(("pr-agent", "opencode"), ("implementer_probe_failed",)),
    ],
)
def test_what_the_probe_prints_is_a_valid_verdict(verdict: Verdict) -> None:
    # #331-T08
    assert _accepts("ProbeVerdict", json.loads(verdict.to_json()))


@pytest.mark.contract
def test_the_probe_report_may_name_the_implementer_as_an_engine_and_as_required() -> None:
    # #765-T08
    report = _load(CONTRACTS / "examples" / "probe-verdict" / "ProbeReport.json")
    report.update(
        status="passed",
        ok=True,
        engines=["pr-agent", "opencode", "implementer"],
        reasons=[],
        required=["pr-agent", "opencode", "implementer"],
    )

    assert _accepts("ProbeReport", report)


@pytest.mark.contract
@pytest.mark.parametrize(
    "document",
    [
        {"version": 1, "engines": ["pr-agent", "opencode", "implementer", "more"], "reasons": []},
        {
            "version": 1,
            "engines": ["pr-agent"],
            "reasons": ["ghp_" + "0123456789abcdef0123456789abcdef0123"],
        },
        {"version": 1, "engines": ["pr-agent"], "reasons": [], "path": "/run/secret"},
        {"version": 1, "engines": ["not-an-engine"], "reasons": []},
        {"version": 2, "engines": ["pr-agent"], "reasons": []},
    ],
)
def test_the_verdict_is_closed(document: Document) -> None:
    # #331-T08
    assert not _accepts("ProbeVerdict", document)
