# SPDX-License-Identifier: LicenseRef-Proprietary

"""A turn on the harness `claude-code` as the runner reads it (#856): the profile names the harness,
the job carries `subscription` instead of a model, and no key of ours; the two kinds of turn are
never mixed. The schema of the contract agrees on the same documents."""

import copy
import json
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator

from code_reviewer_runner import job as runner_job
from code_reviewer_runner.result import ErrorCode

ROOT = Path(__file__).resolve().parents[3]
EXAMPLE = ROOT / "contracts" / "examples" / "implementer" / "RunnerJobInput.json"
SCHEMA = json.loads((ROOT / "contracts" / "runner-api.v1.json").read_text(encoding="utf-8"))

PROFILE = {"name": "claude", "version": 2, "canPush": True, "harness": "claude-code"}
SUBSCRIPTION = {"model": "claude-sonnet-5-5", "maxBudgetUsd": "2.50"}


def subscription_job(**changes: Any) -> dict[str, Any]:
    document: dict[str, Any] = copy.deepcopy(json.loads(EXAMPLE.read_text(encoding="utf-8")))
    spec = document["implementer"]
    del spec["cost"], spec["modelEntry"], document["llm"]
    spec["profile"] = dict(PROFILE)
    spec["subscription"] = dict(SUBSCRIPTION)
    for path, value in changes.items():
        target = document
        *parents, last = path.split(".")
        for part in parents:
            target = target[part]
        if value is _GONE:
            del target[last]
        else:
            target[last] = value
    return document


_GONE = object()


def parse(document: dict[str, Any]) -> runner_job.ImplementerInput:
    return runner_job.parse_implementer_input(json.dumps(document))


def accepted_by_schema(document: dict[str, Any]) -> bool:
    validator = Draft202012Validator(
        {"$schema": SCHEMA["$schema"], "$ref": "#/$defs/RunnerJobInput", "$defs": SCHEMA["$defs"]}
    )
    return bool(validator.is_valid(document))  # pyright: ignore[reportUnknownMemberType]


# #856-J01
def test_a_subscription_turn_is_read_with_its_harness_and_no_model_access() -> None:
    document = subscription_job()
    job = parse(document)
    spec = job.implementer

    assert accepted_by_schema(document)
    assert spec.profile is not None and spec.profile.harness == "claude-code"
    assert spec.subscription is not None
    assert (spec.subscription.model, spec.subscription.max_budget_usd) == (
        "claude-sonnet-5-5",
        "2.50",
    )
    assert spec.cost is None and spec.model_entry is None
    assert job.model_access is None
    assert job.secrets == (job.git.token,)  # no key of ours: only the git token is a secret


# #856-J01
def test_the_model_is_optional_and_the_budget_is_not() -> None:
    without_model = subscription_job(**{"implementer.subscription": {"maxBudgetUsd": "1"}})
    without_budget = subscription_job(**{"implementer.subscription": {"model": "sonnet"}})

    assert parse(without_model).implementer.subscription is not None
    assert accepted_by_schema(without_model)
    assert not accepted_by_schema(without_budget)
    with pytest.raises(runner_job.JobError):
        parse(without_budget)


# #856-J02
def test_a_turn_without_a_harness_is_an_opencode_turn_as_before() -> None:
    document: dict[str, Any] = json.loads(EXAMPLE.read_text(encoding="utf-8"))
    parsed = parse(document)
    assert parsed.implementer.profile is None and parsed.implementer.subscription is None

    document["implementer"]["profile"] = {"name": "writer", "version": 1, "canPush": True}
    profile = parse(document).implementer.profile
    assert profile is not None and profile.harness == "opencode"


# #856-J02
@pytest.mark.parametrize(
    ("path", "value"),
    [
        ("implementer.profile.harness", "codex"),
        ("implementer.profile.harness", 3),
        ("implementer.profile.harness", None),
        ("implementer.subscription.maxBudgetUsd", "0"),
        ("implementer.subscription.maxBudgetUsd", "-1"),
        ("implementer.subscription.maxBudgetUsd", 2.5),
        ("implementer.subscription.maxBudgetUsd", "1e3"),
        ("implementer.subscription.maxBudgetUsd", "1234567"),
        ("implementer.subscription.model", ""),
        ("implementer.subscription.model", "--dangerously-skip-permissions"),
        ("implementer.subscription.model", "a b"),
        ("implementer.subscription.model", "x" * 101),
        ("implementer.subscription.extra", "x"),
    ],
)
def test_the_runner_and_the_schema_both_refuse_what_is_not_the_contracts(
    path: str, value: Any
) -> None:
    document = subscription_job(**{path: value})

    assert not accepted_by_schema(document)
    with pytest.raises(runner_job.JobError) as refused:
        parse(document)
    assert refused.value.code is ErrorCode.INVALID_JOB


# #856-J03
@pytest.mark.parametrize(
    "mixed",
    [
        "implementer.cost",
        "implementer.modelEntry",
        "llm",
    ],
)
def test_a_subscription_turn_with_a_model_or_a_key_is_refused(mixed: str) -> None:
    example: dict[str, Any] = json.loads(EXAMPLE.read_text(encoding="utf-8"))
    document = subscription_job()
    section, _, name = mixed.partition(".")
    document[section] = example[section] if not name else document[section]
    if name:
        document[section][name] = example[section][name]

    with pytest.raises(runner_job.JobError) as refused:
        parse(document)
    assert refused.value.code is ErrorCode.INVALID_JOB


# #856-J03
def test_an_opencode_turn_cannot_carry_a_subscription() -> None:
    document: dict[str, Any] = json.loads(EXAMPLE.read_text(encoding="utf-8"))
    document["implementer"]["subscription"] = dict(SUBSCRIPTION)
    document["implementer"]["profile"] = {"name": "w", "version": 1, "canPush": True}

    with pytest.raises(runner_job.JobError):
        parse(document)


# #856-J03
def test_a_subscription_turn_needs_a_profile_that_names_the_harness() -> None:
    no_profile = subscription_job(**{"implementer.profile": _GONE})
    opencode_profile = subscription_job(**{"implementer.profile.harness": "opencode"})

    for document in (no_profile, opencode_profile):
        with pytest.raises(runner_job.JobError):
            parse(document)


# #856-J03
def test_an_opencode_turn_still_needs_its_cost_its_entry_and_its_key() -> None:
    for gone in ("implementer.cost", "implementer.modelEntry", "llm"):
        document: dict[str, Any] = json.loads(EXAMPLE.read_text(encoding="utf-8"))
        target = document
        *parents, last = gone.split(".")
        for part in parents:
            target = target[part]
        del target[last]

        with pytest.raises(runner_job.JobError):
            parse(document)
