# SPDX-License-Identifier: LicenseRef-Proprietary

"""Pins down the runner API format of contracts/runner-api.v1.json from the runner's side.

The app checks its real answers against the same file (app/integration-tests/compatibility), so a
change to the format has to change both sides. Here the file itself is checked: the examples in
contracts/examples are valid, and the rules the runner relies on (a closed job input, the error
code rules of a result, tolerance for fields it does not know) hold.
"""

import copy
import json
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any, cast

import pytest
from jsonschema import Draft202012Validator

from code_reviewer_runner import job as runner_job
from code_reviewer_runner.llm_providers import PROVIDER_ID_PATTERN, registered_provider_ids

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"
SCHEMA_PATH = CONTRACTS / "runner-api.v1.json"
EXAMPLES = CONTRACTS / "examples"

# The definitions that describe a whole request or response body. Each has one example file.
BODIES = (
    "ClaimRequest",
    "ClaimResponse",
    "HeartbeatRequest",
    "HeartbeatResponse",
    "CompleteRequest",
    "CompleteResponse",
    "ErrorResponse",
    # #318: the Dispatcher API additions (the claim by a Dispatcher, release, version).
    "SplitClaimResponse",
    "ReleaseRequest",
    "ReleaseResponse",
    "VersionResponse",
    # #364: the job state a Dispatcher reads to find the VMs of jobs that ended.
    "JobStateResponse",
    # #493: the Dispatcher reports the VM it created (billable minutes).
    "VmStartRequest",
    "VmStartResponse",
    # #745: the steps of a running turn of the Implementer (the live view).
    "StepsRequest",
    "StepsResponse",
)

Document = dict[str, Any]


def _load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _validator(definition: str) -> Draft202012Validator:
    schema: Document = _load(SCHEMA_PATH)
    return Draft202012Validator(
        {"$schema": schema["$schema"], "$ref": f"#/$defs/{definition}", "$defs": schema["$defs"]}
    )


def _accepts(definition: str, document: Document) -> bool:
    # The overloads of is_valid are only partly typed in jsonschema.
    return bool(_validator(definition).is_valid(document))  # pyright: ignore[reportUnknownMemberType]


def _example(definition: str) -> Document:
    return _load(EXAMPLES / f"{definition}.json")


# A review job a previous release's app could have sent: the legacy `args` and the option families
# of the removed tools. Frozen in fakes/fixtures, proven against a recorded shape.
PREVIOUS_RELEASE_JOB = (
    Path(__file__).resolve().parents[3] / "fakes" / "fixtures" / "previous-release-review-job.json"
)


def _previous_release_review_claim() -> Document:
    job_input: Document = _load(PREVIOUS_RELEASE_JOB)
    job_input["args"] = ["a legacy question"]
    return {
        "version": 1,
        "job": {
            "id": "00000000-0000-4000-8000-0000000000aa",
            "leaseToken": "previous-release-lease-token",
            "leaseExpiresAt": "2026-10-10T13:00:00.000Z",
            "heartbeatIntervalSeconds": 30,
            "tokenExpiresAt": None,
            "input": job_input,
        },
    }


def test_the_contract_file_is_a_valid_schema_of_version_one() -> None:
    schema: Document = _load(SCHEMA_PATH)

    Draft202012Validator.check_schema(schema)
    assert schema["version"] == 1
    assert schema["$defs"]["ClaimResponse"]["properties"]["version"] == {"const": 1}


# CR-28-T01
@pytest.mark.parametrize("definition", BODIES)
def test_the_example_of_every_body_is_valid(definition: str) -> None:
    assert _accepts(definition, _example(definition))


def test_there_is_exactly_one_example_per_body() -> None:
    assert sorted(path.stem for path in EXAMPLES.glob("*.json")) == sorted(BODIES)


# CR-28-T02
def test_a_claim_response_with_fields_the_runner_does_not_know_is_still_valid() -> None:
    claim = _example("ClaimResponse")
    claim["somethingNew"] = {"nested": True}
    claim["job"]["priority"] = 5

    assert _accepts("ClaimResponse", claim)


def test_the_job_input_is_closed_because_the_runner_refuses_unknown_fields() -> None:
    claim = _example("ClaimResponse")
    claim["job"]["input"]["git"]["expiresAt"] = "2026-10-10T13:00:00.000Z"

    assert not _accepts("ClaimResponse", claim)


def _without_git_token(claim: Document) -> None:
    del claim["job"]["input"]["git"]["token"]


def _without_llm_key(claim: Document) -> None:
    del claim["job"]["input"]["llm"]["apiKey"]


def _without_lease_token(claim: Document) -> None:
    del claim["job"]["leaseToken"]


def _without_version(claim: Document) -> None:
    del claim["version"]


def _another_version(claim: Document) -> None:
    claim["version"] = 2


def _unsupported_platform(claim: Document) -> None:
    claim["job"]["input"]["git"]["provider"] = "gitlab"


def _command_not_allowed(claim: Document) -> None:
    claim["job"]["input"]["command"] = "deploy"


def _foreign_environment_variable(claim: Document) -> None:
    claim["job"]["input"]["env"]["GITHUB__USER_TOKEN"] = "x"


def _lease_expiry_not_a_timestamp(claim: Document) -> None:
    claim["job"]["leaseExpiresAt"] = "tomorrow"


@pytest.mark.parametrize(
    "mutate",
    [
        pytest.param(_without_git_token, id="no git token"),
        pytest.param(_without_llm_key, id="no llm key"),
        pytest.param(_without_lease_token, id="no lease token"),
        pytest.param(_without_version, id="no version"),
        pytest.param(_another_version, id="another version"),
        pytest.param(_unsupported_platform, id="unsupported platform"),
        pytest.param(_command_not_allowed, id="command not allowed"),
        pytest.param(_foreign_environment_variable, id="variable outside the PR-Agent tools"),
        pytest.param(_lease_expiry_not_a_timestamp, id="lease expiry not a timestamp"),
    ],
)
def test_a_claim_response_that_breaks_a_rule_is_refused(mutate: Callable[[Document], None]) -> None:
    claim = copy.deepcopy(_example("ClaimResponse"))
    mutate(claim)

    assert not _accepts("ClaimResponse", claim)


# #203-T13: only /review is a command, and a previous release's review payload still validates (v1
# compatibility): the legacy `args` and the removed tools' env families are accepted.
def test_only_review_is_a_command_and_legacy_review_fields_are_accepted() -> None:
    claim = copy.deepcopy(_example("ClaimResponse"))
    claim["job"]["input"]["command"] = "ask"
    assert not _accepts("ClaimResponse", claim)

    legacy = _previous_release_review_claim()
    assert _accepts("ClaimResponse", legacy)
    assert legacy["job"]["input"]["args"] == ["a legacy question"]
    assert "PR_QUESTIONS__EXTRA_INSTRUCTIONS" in legacy["job"]["input"]["env"]


# CR-28-T03
def test_a_failed_result_needs_an_error_code_and_a_good_one_must_not_have_it() -> None:
    complete = _example("CompleteRequest")
    complete["result"]["errorCode"] = "timeout"
    assert not _accepts("CompleteRequest", complete)

    complete["result"]["ok"] = False
    assert _accepts("CompleteRequest", complete)

    complete["result"]["errorCode"] = None
    assert not _accepts("CompleteRequest", complete)


# #293-T08: what the runner prints as the usage of a stopped-early review is a valid result.
def test_the_usage_of_a_stopped_early_review_is_valid_and_a_complete_one_has_no_such_field() -> (
    None
):
    from code_reviewer_runner.dynamic_review.budget import (
        STOPPED_EARLY_COST,
        STOPPED_EARLY_TIME,
    )
    from code_reviewer_runner.result import Usage

    def usage(stopped_early: str | None) -> dict[str, Any]:
        return Usage(
            model="vendor/model",
            prompt_tokens=1,
            completion_tokens=1,
            total_tokens=2,
            ai_calls=1,
            fallback_used=False,
            cost_usd=0.01,
            stopped_early=stopped_early,
        ).to_json()

    complete = _example("CompleteRequest")
    for reason in (STOPPED_EARLY_COST, STOPPED_EARLY_TIME):
        complete["result"]["usage"] = usage(reason)
        assert _accepts("CompleteRequest", complete), reason
    complete["result"]["usage"] = usage(None)
    assert "stoppedEarly" not in complete["result"]["usage"]
    assert _accepts("CompleteRequest", complete)
    complete["result"]["usage"] = {**usage(None), "stoppedEarly": "budget"}
    assert not _accepts("CompleteRequest", complete)


# #540-N4: by how much a run passed its cost limit is an optional number of dollars.
def test_the_excess_over_the_cost_limit_is_an_optional_non_negative_number() -> None:
    from code_reviewer_runner.result import Usage

    complete = _example("CompleteRequest")
    usage = Usage("vendor/model", 1, 1, 2, 1, False, 1.01, limit_exceeded_by=0.01).to_json()
    assert usage["limitExceededBy"] == 0.01
    complete["result"]["usage"] = usage
    assert _accepts("CompleteRequest", complete)
    for bad in (-0.01, "0.01", True, None):
        complete["result"]["usage"] = {**usage, "limitExceededBy": bad}
        assert not _accepts("CompleteRequest", complete), bad


def test_every_error_of_the_api_has_a_stable_code_and_a_message() -> None:
    error = _example("ErrorResponse")
    assert _accepts("ErrorResponse", error)

    error["error"]["code"] = "something went wrong"
    assert not _accepts("ErrorResponse", error)

    del error["error"]["code"]
    assert not _accepts("ErrorResponse", error)


def test_the_error_codes_the_runner_reports_are_listed_once() -> None:
    schema: Document = _load(SCHEMA_PATH)
    codes: list[str] = schema["$defs"]["KnownRunnerErrorCode"]["enum"]

    assert len(codes) == len(set(codes))
    assert {"timeout", "llm_auth", "git_rate_limit", "runner_shutdown", "unknown"} <= set(codes)


def test_every_error_code_of_the_runner_is_in_the_contract() -> None:
    from code_reviewer_runner.result import ErrorCode

    schema: Document = _load(SCHEMA_PATH)
    listed: list[str] = schema["$defs"]["KnownRunnerErrorCode"]["enum"]

    assert {code.value for code in ErrorCode} <= set(listed)


def test_a_failed_result_may_carry_the_link_of_a_review_that_was_posted_but_shortened() -> None:
    result = _example("CompleteRequest")["result"]
    result.update(
        ok=False,
        errorCode="review_state_truncated",
        commentUrl="https://github.com/octo/repo/pull/7#issuecomment-1",
    )

    assert _accepts("RunnerResult", result)


# #273-T07
def test_the_examples_of_a_failed_result_with_usage_are_valid() -> None:
    schema: Document = _load(SCHEMA_PATH)
    examples: list[Document] = schema["$defs"]["RunnerResult"]["examples"]

    assert len(examples) >= 2
    for example in examples:
        assert example["ok"] is False
        assert example["usage"]["aiCalls"] > 0
        assert _accepts("RunnerResult", example)
        assert _accepts("CompleteRequest", {**_example("CompleteRequest"), "result": example})
    # One of them shows the unknown cost next to the counters.
    assert {example["usage"]["costUsd"] is None for example in examples} == {True, False}


# #273-T07: what the runner prints for a failed run that used the model is what the file says.
@pytest.mark.parametrize("cost", [0.0042, None])
def test_the_failed_result_the_runner_prints_after_a_model_call_is_valid(
    cost: float | None,
) -> None:
    from code_reviewer_runner.result import ErrorCode, JobResult, Usage

    result = JobResult(
        ok=False,
        duration_ms=1200,
        comment_url=None,
        error_code=ErrorCode.DYNAMIC_BUDGET_EXCEEDED,
        log_tail="dynamic_budget_exceeded: the cost limit is used up",
        usage=Usage(
            model="vendor/model-name",
            prompt_tokens=300,
            completion_tokens=30,
            total_tokens=330,
            ai_calls=3,
            fallback_used=False,
            cost_usd=cost,
        ),
    )

    assert _accepts("RunnerResult", result.to_json())


# #274-T07: what the runner prints for a Diff run with its exact cost is what the file says.
@pytest.mark.parametrize("cost", [0.6, 0.00037035, 0.0, None])
def test_the_result_of_a_diff_run_with_its_exact_cost_is_valid(cost: float | None) -> None:
    from decimal import Decimal

    from code_reviewer_runner.result import JobResult, Usage

    result = JobResult(
        ok=True,
        duration_ms=41200,
        comment_url="https://github.com/octo/repo/pull/7#issuecomment-1",
        error_code=None,
        log_tail="",
        usage=Usage(
            model="openrouter/vendor/model-name",
            prompt_tokens=3000,
            completion_tokens=450,
            total_tokens=3450,
            ai_calls=3,
            fallback_used=False,
            cost_usd=None if cost is None else float(Decimal(repr(cost))),
        ),
    )

    assert _accepts("RunnerResult", result.to_json())
    assert result.to_json()["usage"]["costUsd"] == cost


# #405-T30: what the runner prints for the findings a review left open is what the file says.
@pytest.mark.parametrize(
    "findings",
    [
        None,
        (3, {"P0": 1, "P1": 0, "P2": 2, "P3": 0}),
        (2, None),
        (0, {"P0": 0, "P1": 0, "P2": 0, "P3": 0}),
        (0, None, True),
        (1, {"P0": 0, "P1": 1, "P2": 0, "P3": 0}, True),
    ],
)
def test_the_findings_a_review_left_open_are_valid_or_absent(
    findings: tuple[int, dict[str, int] | None] | tuple[int, dict[str, int] | None, bool] | None,
) -> None:
    from code_reviewer_runner.result import JobResult, ReviewFindings

    result = JobResult(
        ok=True,
        duration_ms=41200,
        comment_url="https://github.com/octo/repo/pull/7#issuecomment-1",
        error_code=None,
        log_tail="",
        findings=None
        if findings is None
        else ReviewFindings(
            open=findings[0],
            by_severity=findings[1],
            incomplete=len(findings) == 3 and findings[2] is True,
        ),
    )

    assert _accepts("RunnerResult", result.to_json())
    assert ("findings" in result.to_json()) is (findings is not None)
    # #405 (review round 2): the field for a review that did not cover everything is in the schema.
    if findings is not None and len(findings) == 3:
        assert result.to_json()["findings"]["incomplete"] is True


# #405-T30
def test_the_example_of_a_completion_carries_findings_the_runner_can_produce() -> None:
    example = _example("CompleteRequest")

    assert _accepts("ReviewFindings", example["result"]["findings"])


# #296-T10
def test_every_checkout_reason_of_the_runner_is_in_the_contract_once() -> None:
    from code_reviewer_runner.dynamic_review.limits import CheckoutReason

    schema: Document = _load(SCHEMA_PATH)
    listed: list[str] = schema["$defs"]["KnownCheckoutReason"]["enum"]

    assert len(listed) == len(set(listed))
    assert {reason.value for reason in CheckoutReason} == set(listed)


# #296-T10
def test_a_failed_result_may_carry_the_stable_reason_of_the_failure() -> None:
    result = _example("CompleteRequest")["result"]
    result.update(ok=False, errorCode="checkout_incomplete", errorReason="budget_preparation")
    result["commentUrl"] = None

    assert _accepts("RunnerResult", result)
    for bad in ("Budget Prep", "", "x" * 65, 5):
        result["errorReason"] = bad
        assert not _accepts("RunnerResult", result)


def test_a_complete_response_may_say_the_job_was_given_back_after_a_shutdown() -> None:
    response = _example("CompleteResponse")
    response["job"]["status"] = "queued"
    assert _accepts("CompleteResponse", response)

    response["job"]["status"] = "cancelled"
    assert not _accepts("CompleteResponse", response)


# CR-29 alignment: the contract and the runner state the same rules twice, so both are read from
# their sources and compared.
def test_the_job_env_key_pattern_of_the_runner_equals_the_one_of_the_contract() -> None:
    schema: Document = _load(SCHEMA_PATH)
    contract_pattern: str = schema["$defs"]["JobEnv"]["propertyNames"]["pattern"]

    # The contract anchors the pattern, the runner uses fullmatch: the same rule written twice.
    assert contract_pattern == f"^{runner_job._ENV_KEY.pattern}$"  # pyright: ignore[reportPrivateUsage]


@pytest.mark.parametrize(
    "key",
    [
        "PR_REVIEWER__EXTRA_INSTRUCTIONS",
        "PR_DESCRIPTION__ADD_ORIGINAL_USER_DESCRIPTION",
        "PR_CODE_SUGGESTIONS__NUM_CODE_SUGGESTIONS",
        "PR_QUESTIONS__ENABLE_HELP_TEXT",
        "PR_REVIEWER__NUM_MAX_FINDINGS",
        "GITHUB__USER_TOKEN",
        "CONFIG__MODEL",
        "PR_REVIEWER__",
        "PR_REVIEWER__EXTRA__NESTED",
        "PR_REVIEWER__EXTRA_",
        "pr_reviewer__extra_instructions",
        "PR_OTHER__EXTRA_INSTRUCTIONS",
    ],
)
def test_the_runner_and_the_contract_give_the_same_verdict_on_a_job_env_key(key: str) -> None:
    claim = _example("ClaimResponse")
    claim["job"]["input"]["env"] = {key: "x"}
    contract_accepts = _accepts("ClaimResponse", claim)

    try:
        runner_job.parse_job(json.dumps(claim["job"]["input"]))
        runner_accepts = True
    except runner_job.JobError:
        runner_accepts = False

    assert runner_accepts == contract_accepts


def test_the_runner_accepts_the_fallback_models_the_way_the_contract_defines_them() -> None:
    schema: Document = _load(SCHEMA_PATH)
    definition = schema["$defs"]["RunnerJobInput"]["properties"]["llm"]["properties"]
    max_items: int = definition["fallbackModels"]["maxItems"]
    models = [f"vendor/fallback-{number}" for number in range(max_items)]
    claim = _example("ClaimResponse")
    claim["job"]["input"]["llm"]["fallbackModels"] = models
    assert _accepts("ClaimResponse", claim)

    parsed = runner_job.parse_job(json.dumps(claim["job"]["input"]))

    assert parsed.llm.fallback_models == tuple(models)
    assert max_items == runner_job.MAX_FALLBACK_MODELS


def test_the_runner_and_the_contract_both_refuse_more_fallback_models_than_allowed() -> None:
    schema: Document = _load(SCHEMA_PATH)
    max_items: int = schema["$defs"]["RunnerJobInput"]["properties"]["llm"]["properties"][
        "fallbackModels"
    ]["maxItems"]
    claim = _example("ClaimResponse")
    claim["job"]["input"]["llm"]["fallbackModels"] = [
        f"vendor/fallback-{number}" for number in range(max_items + 1)
    ]

    assert not _accepts("ClaimResponse", claim)
    with pytest.raises(runner_job.JobError):
        runner_job.parse_job(json.dumps(claim["job"]["input"]))


# #195-T06: the claim request and the tagged Dynamic job input are one shape both sides agree on.
def test_the_claim_request_example_lists_the_engines_and_the_contract_refuses_unknown_ones() -> (
    None
):
    request = _example("ClaimRequest")
    assert _accepts("ClaimRequest", request)
    assert set(request["engines"]) <= {"pr-agent", "opencode"}

    # An empty legacy claim and an absent body are both accepted (pr-agent only).
    assert _accepts("ClaimRequest", {})
    assert _accepts("ClaimRequest", {"engines": ["opencode"]})

    request["engines"] = ["pr-agent", "pr-agent"]
    assert not _accepts("ClaimRequest", request)
    request["engines"] = ["gitlab"]
    assert not _accepts("ClaimRequest", request)
    request["engines"] = []
    assert not _accepts("ClaimRequest", request)


DYNAMIC_JOB = Path(__file__).resolve().parents[3] / "fakes" / "fixtures" / "dynamic-review-job.json"


def _tagged_claim() -> Document:
    return {
        "version": 1,
        "job": {
            "id": "00000000-0000-4000-8000-0000000000bb",
            "leaseToken": "dynamic-lease-token",
            "leaseExpiresAt": "2026-10-10T13:00:00.000Z",
            "heartbeatIntervalSeconds": 30,
            "tokenExpiresAt": None,
            "input": _load(DYNAMIC_JOB),
        },
    }


# #195-T06, #195-T10, #262-T02
def test_the_tagged_dynamic_job_input_is_accepted_and_keeps_exact_shas_and_bounds() -> None:
    job = _load(DYNAMIC_JOB)
    claim = _tagged_claim()
    assert _accepts("ClaimResponse", claim)

    parsed = runner_job.parse_job(json.dumps(job))
    assert parsed.review_kind is runner_job.ReviewKind.DYNAMIC
    assert parsed.dynamic is not None
    assert parsed.dynamic.model == "deepseek/deepseek-v4.1-flash"
    assert parsed.dynamic.limits.max_findings == 5
    assert parsed.base is not None
    assert parsed.base.head_sha == "1f3a5c7e9b2d4f60a8c1e3b5d7f90a2c4e6b8d01"
    assert parsed.base.comparison == "full"
    assert parsed.base.previous_reviewed_sha is None
    # #255: the shared golden job carries the attempted heads.
    assert parsed.base.attempted_shas == ("2" * 40, "3" * 40)
    # #257: and the truncation flag, which the app only sends when it is true.
    assert parsed.base.attempted_shas_truncated is True


def test_the_contract_and_the_runner_refuse_a_dynamic_job_with_an_unknown_authority_field() -> None:
    claim = _tagged_claim()
    # A malicious skill/metadata cannot smuggle an executable command, a fixed core override or an
    # endpoint into the Dynamic options: the object is closed on both sides.
    claim["job"]["input"]["dynamic"]["command"] = "sh -c evil"
    assert not _accepts("ClaimResponse", claim)

    claim = _tagged_claim()
    claim["job"]["input"]["dynamic"]["core"] = "override"
    assert not _accepts("ClaimResponse", claim)

    claim = _tagged_claim()
    claim["job"]["input"]["base"]["endpoint"] = "https://attacker.test"
    assert not _accepts("ClaimResponse", claim)

    # The runner refuses the same shape locally, before it launches anything.
    job = _load(DYNAMIC_JOB)
    job["dynamic"]["command"] = "sh -c evil"
    with pytest.raises(runner_job.JobError):
        runner_job.parse_job(json.dumps(job))


def test_the_runner_and_the_contract_both_require_the_tagged_dynamic_fields() -> None:
    claim = _tagged_claim()
    del claim["job"]["input"]["dynamic"]
    assert not _accepts("ClaimResponse", claim)

    job = _load(DYNAMIC_JOB)
    del job["dynamic"]
    with pytest.raises(runner_job.JobError):
        runner_job.parse_job(json.dumps(job))


def _claim_for(job: Document) -> Document:
    claim = _example("ClaimResponse")
    claim["job"]["input"] = job
    return claim


# #195 finding 7: the tagged union is bidirectional. A Diff job (no reviewKind, or "diff") must not
# carry `dynamic`/`base`; a Dynamic job must carry both; every required field is required on both
# sides; the model validation is the same.
def test_the_tagged_union_is_bidirectional_and_both_sides_give_the_same_verdict() -> None:
    dynamic: Document = _load(DYNAMIC_JOB)
    base: Document = cast("dict[str, Any]", dynamic["base"])
    options: Document = cast("dict[str, Any]", dynamic["dynamic"])

    def without_key(key: str) -> Document:
        return {name: value for name, value in dynamic.items() if name != key}

    diff_shape: Document = {
        "prUrl": dynamic["prUrl"],
        "command": "review",
        "git": dynamic["git"],
        "llm": dynamic["llm"],
        "env": {},
    }
    positives: list[Document] = [
        dynamic,
        {
            **dynamic,
            "base": {
                **base,
                "comparison": "incremental",
                "previousReviewedSha": "a" * 40,
            },
        },
        # #255: optional, absent means none.
        {**dynamic, "base": {**base, "attemptedShas": ["b" * 40, "c" * 40]}},
        {**dynamic, "base": {**base, "attemptedShas": []}},
        # #257: optional, true only when the list was cut; absent means false.
        {**dynamic, "base": {**base, "attemptedShasTruncated": True}},
        {**dynamic, "base": {**base, "attemptedShasTruncated": False}},
        {**dynamic, "base": {k: v for k, v in base.items() if k != "attemptedShasTruncated"}},
        # An app that has nothing to name leaves the key out (an older runner rejects it).
        {**dynamic, "base": {k: v for k, v in base.items() if k != "attemptedShas"}},
    ]
    negatives: list[Document] = [
        without_key("dynamic"),
        without_key("base"),
        {
            **dynamic,
            "base": {name: value for name, value in base.items() if name != "previousReviewedSha"},
        },
        {**dynamic, "base": {**base, "attemptedShas": ["B" * 40]}},
        {**dynamic, "base": {**base, "attemptedShas": ["b" * 40, "b" * 40]}},
        {**dynamic, "base": {**base, "attemptedShas": [f"{n:040x}" for n in range(21)]}},
        {**dynamic, "base": {**base, "attemptedShas": "b" * 40}},
        {**dynamic, "base": {**base, "attemptedShasTruncated": "true"}},
        {**dynamic, "base": {**base, "attemptedShasTruncated": 1}},
        {**dynamic, "base": {**base, "attemptedShasTruncated": None}},
        {**dynamic, "dynamic": {**options, "model": "bad model name"}},
        {**diff_shape, "dynamic": options},
        {**diff_shape, "base": base},
        {**diff_shape, "reviewKind": "diff", "dynamic": options},
    ]

    for job in positives:
        assert _accepts("ClaimResponse", _claim_for(job)) is True
        runner_job.parse_job(json.dumps(job))

    for job in negatives:
        assert _accepts("ClaimResponse", _claim_for(job)) is False
        with pytest.raises(runner_job.JobError):
            runner_job.parse_job(json.dumps(job))


DYNAMIC_REVIEW = CONTRACTS / "dynamic-review"


def _findings_schema() -> Document:
    return _load(DYNAMIC_REVIEW / "schema.v1.json")


def _findings_validator() -> Draft202012Validator:
    schema = _findings_schema()
    return Draft202012Validator(
        {
            "$schema": schema["$schema"],
            "$ref": "#/$defs/DynamicFindings",
            "$defs": schema["$defs"],
        }
    )


def _findings_document(findings: list[Document], **envelope: Any) -> Document:
    example = _load(DYNAMIC_REVIEW / "example.v1.json")
    return {**example, "findings": findings, **envelope}


def _accepts_findings(document: Document) -> bool:
    return bool(_findings_validator().is_valid(document))  # pyright: ignore[reportUnknownMemberType]


# #195-T10: the frozen neutral findings schema, with no provider-routing field, is the same on both
# sides and lists the stable model-feature failure.
def test_the_dynamic_review_schema_is_version_one_and_has_no_provider_routing_fields() -> None:
    schema = _findings_schema()
    Draft202012Validator.check_schema(schema)
    assert schema["version"] == 1

    findings: Document = schema["$defs"]["DynamicFindings"]
    assert findings["properties"]["schemaVersion"] == {"type": "integer", "const": 1}

    # No property anywhere in the schema may name a permission, routing or command field. The
    # descriptions may *mention* them (to say they are absent); the property names must not.
    def property_names(node: Any) -> set[str]:
        if isinstance(node, list):
            result: set[str] = set()
            for entry in cast("list[Any]", node):
                result |= property_names(entry)
            return result
        if not isinstance(node, dict):
            return set()
        record = cast("dict[str, Any]", node)
        properties = cast("dict[str, Any]", record.get("properties") or {})
        names = set(properties)
        for key, value in record.items():
            if key != "properties":
                names |= property_names(value)
        return names

    names = property_names(schema)
    forbidden = ("provider", "hostingProvider", "fallback", "endpoint", "command", "permission")
    for name in forbidden:
        assert name not in names, name

    fields = set(_load(DYNAMIC_REVIEW / "example.v1.json")["findings"][0])
    assert {
        "id",
        "priority",
        "confidence",
        "title",
        "body",
        "path",
        "lineStart",
        "lineEnd",
        "evidence",
        "reviewedSha",
    } <= fields
    # #195 finding 5: resolutions live on the envelope, not on a current finding.
    assert "resolvedIds" not in fields
    assert "resolvedIds" in _load(DYNAMIC_REVIEW / "example.v1.json")

    assert _accepts_findings(_load(DYNAMIC_REVIEW / "example.v1.json"))
    resolved_only = _load(DYNAMIC_REVIEW / "example-resolved.v1.json")
    assert resolved_only["findings"] == []
    assert resolved_only["resolvedIds"] == ["f-1a2b3c"]
    assert _accepts_findings(resolved_only)

    bad = _load(DYNAMIC_REVIEW / "example.v1.json")
    bad["findings"][0]["provider"] = "deepinfra"
    assert not _accepts_findings(bad)


# #195 findings 5 and 6: the schema refuses unsafe paths, resolutions only on the envelope, and
# accepts a run that resolves every previous finding with no current one.
def test_the_findings_schema_refuses_unsafe_locations_and_keeps_resolutions_on_the_envelope() -> (
    None
):
    base_finding = _load(DYNAMIC_REVIEW / "example.v1.json")["findings"][0]

    for path in (
        "../../outside.txt",
        "/etc/passwd",
        "C:\\secret",
        "src/../secret",
        "..",
        "a/..",
        "\\\\host\\s",
    ):
        assert not _accepts_findings(_findings_document([{**base_finding, "path": path}])), path

    assert not _accepts_findings(_findings_document([{**base_finding, "resolvedIds": ["old"]}]))
    assert _accepts_findings(_findings_document([], resolvedIds=["old"]))
    without_envelope = {
        key: value
        for key, value in _load(DYNAMIC_REVIEW / "example-resolved.v1.json").items()
        if key != "resolvedIds"
    }
    assert not _accepts_findings(without_envelope)


# #477-T04
def test_the_diff_parameters_failure_code_is_listed_once_and_reachable() -> None:
    schema: Document = _load(SCHEMA_PATH)
    codes: list[str] = schema["$defs"]["KnownRunnerErrorCode"]["enum"]
    assert codes.count("llm_parameters_unsupported") == 1

    from code_reviewer_runner.result import ErrorCode

    assert ErrorCode.LLM_PARAMETERS_UNSUPPORTED.value == "llm_parameters_unsupported"


# #195-T10: the stable feature/isolation/accounting failure codes are in the contract.
def test_the_dynamic_failure_codes_are_listed_once_and_reachable() -> None:
    schema: Document = _load(SCHEMA_PATH)
    codes: list[str] = schema["$defs"]["KnownRunnerErrorCode"]["enum"]
    expected = {
        "dynamic_engine_unavailable",
        "dynamic_isolation_self_check_failed",
        "dynamic_config_invalid",
        "checkout_incomplete",
        "dynamic_policy_violation",
        "dynamic_budget_exceeded",
        "dynamic_accounting_failed",
        "dynamic_model_features_unsupported",
    }
    assert expected <= set(codes)

    from code_reviewer_runner.result import ErrorCode

    assert expected <= {code.value for code in ErrorCode}


DYNAMIC_JOB_WITH_CAPABILITIES = DYNAMIC_JOB.parent / "dynamic-review-job-capabilities.json"
CAPABILITIES_ADVERTISEMENT = "dynamic_capabilities"


# #279-T07
def test_a_dynamic_job_is_valid_with_and_without_the_model_capabilities() -> None:
    plain = _load(DYNAMIC_JOB)
    assert "capabilities" not in plain["dynamic"]
    with_capabilities = _load(DYNAMIC_JOB_WITH_CAPABILITIES)
    assert with_capabilities["dynamic"]["capabilities"]["maxOutputTokens"] == 8192

    for job in (plain, with_capabilities):
        assert _accepts("ClaimResponse", _claim_for(job))
        assert runner_job.parse_job(json.dumps(job)).dynamic is not None

    parsed = runner_job.parse_job(json.dumps(with_capabilities)).dynamic
    assert parsed is not None and parsed.capabilities is not None
    assert parsed.capabilities.max_output_tokens == 8192
    assert parsed.capabilities.context_window_tokens == 1_048_576
    assert str(parsed.capabilities.input_usd_per_mtok) == "0.6"
    assert str(parsed.capabilities.output_usd_per_mtok) == "2.4"


def _capability_mutations() -> list[Callable[[Document], None]]:
    return [
        lambda caps: caps.update(command="x"),
        lambda caps: caps.pop("toolChoiceRequired"),
        lambda caps: caps.pop("contextWindowTokens"),
        lambda caps: caps.update(toolChoiceRequired="yes"),
        lambda caps: caps.update(maxOutputTokens=0),
        lambda caps: caps.update(maxOutputTokens=True),
        lambda caps: caps.update(contextWindowTokens=1.5),
        lambda caps: caps.update(inputUsdPerMtok=0.6),
        lambda caps: caps.update(inputUsdPerMtok="-1"),
        lambda caps: caps.update(inputUsdPerMtok="1e3"),
        lambda caps: caps.update(outputUsdPerMtok="NaN"),
        lambda caps: caps.pop("outputUsdPerMtok"),
        lambda caps: caps.pop("inputUsdPerMtok"),
    ]


# #279-T07: the capability object is closed and typed the same way on both sides.
@pytest.mark.parametrize("mutate", _capability_mutations())
def test_the_runner_and_the_contract_refuse_the_same_bad_model_capabilities(
    mutate: Callable[[Document], None],
) -> None:
    job = _load(DYNAMIC_JOB_WITH_CAPABILITIES)
    mutate(job["dynamic"]["capabilities"])
    assert not _accepts("ClaimResponse", _claim_for(job))
    with pytest.raises(runner_job.JobError):
        runner_job.parse_job(json.dumps(job))


# #279-T07: a runner says it understands the descriptor; an older runner sends nothing, an older app
# ignores the field.
def test_the_claim_request_may_advertise_that_the_runner_reads_model_capabilities() -> None:
    advertised = {"engines": ["opencode"], "features": [CAPABILITIES_ADVERTISEMENT]}
    assert _accepts("ClaimRequest", advertised)
    assert _accepts("ClaimRequest", {"features": []})
    assert _accepts("ClaimRequest", {"features": ["a_future_feature"]})
    assert not _accepts("ClaimRequest", {"features": "dynamic_capabilities"})
    assert not _accepts("ClaimRequest", {"features": [1]})
    assert not _accepts("ClaimRequest", {"features": ["Bad Name"]})
    assert "features" in _example("ClaimRequest")


DYNAMIC_JOB_COST_MANAGED = DYNAMIC_JOB.parent / "dynamic-review-job-cost-managed.json"
DYNAMIC_JOB_COST_OWN = DYNAMIC_JOB.parent / "dynamic-review-job-cost-own.json"
COST_POLICY_ADVERTISEMENT = "dynamic_cost_policy"


DYNAMIC_JOB_NATIVE_MANAGED = DYNAMIC_JOB.parent / "dynamic-review-job-native-managed.json"
DYNAMIC_JOB_NATIVE_OWN = DYNAMIC_JOB.parent / "dynamic-review-job-native-own.json"
ENTRY_SCHEMA_PATH = CONTRACTS / "job-model-entry.v1.json"


def _entry_accepts(entry: Document) -> bool:
    schema: Document = _load(ENTRY_SCHEMA_PATH)
    validator = Draft202012Validator(
        {"$schema": schema["$schema"], "$ref": "#/$defs/JobModelEntry", "$defs": schema["$defs"]}
    )
    return bool(validator.is_valid(entry))  # pyright: ignore[reportUnknownMemberType]


# #578-T07: a native job carries the entry of its model next to the cost policy. The golden jobs
# are valid for the contract, their entry is valid for the entry's own file, and the runner reads
# them as what they say.
@pytest.mark.parametrize("path", [DYNAMIC_JOB_NATIVE_MANAGED, DYNAMIC_JOB_NATIVE_OWN])
def test_a_native_job_carries_a_valid_entry_next_to_its_cost_policy(path: Path) -> None:
    job = _load(path)

    assert _accepts("ClaimResponse", _claim_for(job))
    assert _entry_accepts(job["dynamic"]["modelEntry"])
    parsed = runner_job.parse_job(json.dumps(job)).dynamic
    assert parsed is not None and parsed.model_entry is not None and parsed.cost is not None
    assert parsed.model_entry.model_id == job["dynamic"]["model"]
    assert parsed.model_entry.provider_id == job["llm"]["provider"].replace("_", "-")


# #578-T07: a job without an entry is a job of today, and the contract still accepts it.
@pytest.mark.parametrize(
    "path", [DYNAMIC_JOB, DYNAMIC_JOB_COST_MANAGED, DYNAMIC_JOB_COST_OWN], ids=lambda p: p.name
)
def test_a_dynamic_job_without_an_entry_keeps_working(path: Path) -> None:
    job = _load(path)

    assert _accepts("ClaimResponse", _claim_for(job))
    parsed = runner_job.parse_job(json.dumps(job)).dynamic
    assert parsed is not None and parsed.model_entry is None


# #578-T07: the entry travels with the cost policy, never alone: a runner would run it with no
# price and no cap. The contract and the runner say so the same way.
def test_an_entry_without_a_cost_policy_is_refused_by_the_contract_and_the_runner() -> None:
    job = _load(DYNAMIC_JOB_NATIVE_OWN)
    del job["dynamic"]["cost"]

    assert not _accepts("ClaimResponse", _claim_for(job))
    with pytest.raises(runner_job.JobError):
        runner_job.parse_job(json.dumps(job))


def _entry_mutations() -> list[tuple[str, Callable[[Document], None]]]:
    return [
        ("a key", lambda entry: entry.update(apiKey="sk-live-1")),
        ("an unknown family", lambda entry: entry.update(family="cohere-chat")),
        ("an unbundled SDK", lambda entry: entry.update(npm="left-pad")),
        ("an http address", lambda entry: entry.update(upstreamBaseUrl="http://api.anthropic.com")),
        ("a price", lambda entry: entry["model"].update(cost={"input": 1, "output": 2})),
        ("no tool calling", lambda entry: entry["model"].update(tool_call=False)),
        ("no limit", lambda entry: entry["model"].pop("limit")),
    ]


# #578-T07: what the contract file says about the entry and what the runner reads agree.
@pytest.mark.parametrize(("name", "mutate"), _entry_mutations(), ids=lambda value: str(value))
def test_the_entry_file_and_the_runner_refuse_the_same_bad_entry(
    name: str, mutate: Callable[[Document], None]
) -> None:
    del name
    job = _load(DYNAMIC_JOB_NATIVE_OWN)
    mutate(job["dynamic"]["modelEntry"])

    assert not _entry_accepts(job["dynamic"]["modelEntry"])
    with pytest.raises(runner_job.JobError):
        runner_job.parse_job(json.dumps(job))


# #553-T02: a native job carries its cost policy: the confirmed book of the managed key, the token
# cap of an own key. Both are valid for the contract and read by the runner as what they say.
def test_a_dynamic_job_may_carry_the_cost_policy_of_its_key() -> None:
    managed = _load(DYNAMIC_JOB_COST_MANAGED)
    own = _load(DYNAMIC_JOB_COST_OWN)
    for job in (managed, own):
        assert _accepts("ClaimResponse", _claim_for(job))
    parsed = runner_job.parse_job(json.dumps(managed)).dynamic
    assert parsed is not None and parsed.cost is not None
    assert parsed.cost.key_mode.value == "managed"
    assert parsed.cost.book is not None and parsed.cost.book.base.input == 3_000_000
    assert parsed.cost.max_total_tokens is None
    parsed = runner_job.parse_job(json.dumps(own)).dynamic
    assert parsed is not None and parsed.cost is not None
    assert parsed.cost.key_mode.value == "own"
    assert parsed.cost.book is None and parsed.cost.max_total_tokens == 4_000_000


# #553-T02: a job of today has no cost policy and nothing about it changes.
def test_a_dynamic_job_without_a_cost_policy_is_read_as_before() -> None:
    parsed = runner_job.parse_job(json.dumps(_load(DYNAMIC_JOB))).dynamic
    assert parsed is not None and parsed.cost is None


def _cost_mutations() -> list[tuple[str, Callable[[Document], None]]]:
    return [
        ("unknown key", lambda cost: cost.update(command="x")),
        ("no key mode", lambda cost: cost.pop("keyMode")),
        ("bad key mode", lambda cost: cost.update(keyMode="operator")),
        ("no price book key", lambda cost: cost.pop("priceBook")),
        ("no cap key", lambda cost: cost.pop("maxTotalTokens")),
        ("cap as text", lambda cost: cost.update(maxTotalTokens="4000000")),
        ("cap zero", lambda cost: cost.update(maxTotalTokens=0)),
        ("cap fractional", lambda cost: cost.update(maxTotalTokens=1.5)),
        ("cap boolean", lambda cost: cost.update(maxTotalTokens=True)),
        ("cap too large", lambda cost: cost.update(maxTotalTokens=10**12)),
    ]


# #553-T02: the cost policy is closed and typed the same way on both sides.
@pytest.mark.parametrize(("name", "mutate"), _cost_mutations(), ids=lambda value: str(value))
def test_the_runner_and_the_contract_refuse_the_same_bad_cost_policy(
    name: str, mutate: Callable[[Document], None]
) -> None:
    del name
    job = _load(DYNAMIC_JOB_COST_OWN)
    mutate(job["dynamic"]["cost"])
    assert not _accepts("ClaimResponse", _claim_for(job))
    with pytest.raises(runner_job.JobError):
        runner_job.parse_job(json.dumps(job))


def _managed_book_mutations() -> list[tuple[str, Callable[[Document], None]]]:
    return [
        ("no book", lambda cost: cost.update(priceBook=None)),
        ("a cap on the managed key", lambda cost: cost.update(maxTotalTokens=4_000_000)),
        ("input as a number", lambda cost: cost["priceBook"].update(input=3)),
        ("a decimal amount", lambda cost: cost["priceBook"].update(input="3.5")),
        ("a negative amount", lambda cost: cost["priceBook"].update(output="-1")),
        ("a leading zero", lambda cost: cost["priceBook"].update(output="015")),
        ("no output price", lambda cost: cost["priceBook"].pop("output")),
        ("an unknown price", lambda cost: cost["priceBook"].update(cacheBlend="1")),
        ("a tier without a size", lambda cost: cost["priceBook"].update(tiers=[{"input": "1"}])),
    ]


# #553-T02: the managed key never runs without a confirmed book, and the book is read exactly.
@pytest.mark.parametrize(
    ("name", "mutate"), _managed_book_mutations(), ids=lambda value: str(value)
)
def test_the_runner_and_the_contract_refuse_the_same_bad_managed_policy(
    name: str, mutate: Callable[[Document], None]
) -> None:
    del name
    job = _load(DYNAMIC_JOB_COST_MANAGED)
    mutate(job["dynamic"]["cost"])
    assert not _accepts("ClaimResponse", _claim_for(job))
    with pytest.raises(runner_job.JobError):
        runner_job.parse_job(json.dumps(job))


# #553-T02: a runner says it enforces the policy; an older runner names no such feature.
def test_the_claim_request_may_advertise_that_the_runner_enforces_the_cost_policy() -> None:
    assert _accepts(
        "ClaimRequest", {"engines": ["opencode"], "features": [COST_POLICY_ADVERTISEMENT]}
    )
    schema: Document = _load(SCHEMA_PATH)
    assert COST_POLICY_ADVERTISEMENT in schema["$defs"]["KnownClaimFeature"]["enum"]
    from code_reviewer_runner.job_loop.worker_api import WORKER_FEATURES

    assert COST_POLICY_ADVERTISEMENT in WORKER_FEATURES


# #553-T05: a run stopped by its token cap says so, and the contract and the runner agree on it.
def test_the_token_limit_is_a_reason_a_run_may_stop_early_for() -> None:
    schema: Document = _load(SCHEMA_PATH)
    reasons = schema["$defs"]["RunnerUsage"]["properties"]["stoppedEarly"]["enum"]
    assert "token_limit" in reasons

    from code_reviewer_runner.job_loop.reporting import STOPPED_EARLY_REASONS

    assert {reason for reason in reasons if reason is not None} == set(STOPPED_EARLY_REASONS)


# #396-T14: the feature a runner names to be superseded gracefully, the field of the heartbeat
# answer and the code.
def test_the_contract_knows_the_supersede_feature_the_heartbeat_field_and_the_result_code() -> None:
    assert _accepts("ClaimRequest", {"engines": ["pr-agent"], "features": ["supersede"]})
    heartbeat = _example("HeartbeatResponse")
    assert _accepts("HeartbeatResponse", heartbeat)
    superseded = {**heartbeat, "job": {**heartbeat["job"], "superseded": True}}
    assert _accepts("HeartbeatResponse", superseded)
    assert not _accepts(
        "HeartbeatResponse", {**heartbeat, "job": {**heartbeat["job"], "superseded": 1}}
    )
    result = {**_example("CompleteRequest")["result"], "ok": False, "errorCode": "superseded"}
    assert _accepts("RunnerResult", result)
    from code_reviewer_runner.result import ErrorCode

    assert ErrorCode.SUPERSEDED.value == "superseded"


# #396-T14: the timing of a superseded run is stated once in the contract; the runner's constants
# and the app's (a test there) are held equal to it.
def test_the_supersede_timing_constants_equal_the_contract() -> None:
    from code_reviewer_runner.job_loop import api
    from code_reviewer_runner.job_loop.host import SUPERSEDED_DRAIN_SECONDS
    from code_reviewer_runner.supersede_timing import (
        CLAIM_SECONDS,
        KILL_MARGIN_SECONDS,
        LONGEST_MODEL_REQUEST_SECONDS,
        MAX_HEARTBEAT_INTERVAL_SECONDS,
        REPORT_GRACE_SECONDS,
    )

    timing = cast(dict[str, Any], _load(SCHEMA_PATH)["$defs"]["SupersedeTiming"]["properties"])
    stated = {name: spec["const"] for name, spec in timing.items()}

    assert stated == {
        "maxHeartbeatIntervalSeconds": MAX_HEARTBEAT_INTERVAL_SECONDS,
        "longestModelRequestSeconds": LONGEST_MODEL_REQUEST_SECONDS,
        "workerDrainSeconds": SUPERSEDED_DRAIN_SECONDS,
        "killMarginSeconds": KILL_MARGIN_SECONDS,
        "claimSeconds": CLAIM_SECONDS,
        "reportGraceSeconds": REPORT_GRACE_SECONDS,
    }
    # What the Worker really does: the heartbeat interval never exceeds the stated maximum, the
    # drain is the longest request, and the claim holds a heartbeat, a drain and the margin.
    assert api.MAX_HEARTBEAT_INTERVAL_SECONDS == MAX_HEARTBEAT_INTERVAL_SECONDS
    assert SUPERSEDED_DRAIN_SECONDS == LONGEST_MODEL_REQUEST_SECONDS
    assert CLAIM_SECONDS >= (
        MAX_HEARTBEAT_INTERVAL_SECONDS + LONGEST_MODEL_REQUEST_SECONDS + KILL_MARGIN_SECONDS
    )


def _job_with_provider(provider: object) -> Document:
    claim = _example("ClaimResponse")
    claim["job"]["input"]["llm"]["provider"] = provider
    return claim


# #424-T01: `llm.provider` is a slug in the contract; the registry decides which slugs run.
@pytest.mark.parametrize(
    ("provider", "accepted"),
    [
        ("openrouter", True),
        ("fakeai", True),
        ("a1", True),
        ("a" + "b" * 31, True),
        ("a" + "b" * 32, False),
        ("a", False),
        ("OpenRouter", False),
        ("1abc", False),
        ("open-router", False),
        ("open router", False),
        ("", False),
        (None, False),
        (7, False),
    ],
)
def test_the_contract_accepts_a_provider_slug_and_refuses_an_uppercase_or_too_long_one(
    provider: object, accepted: bool
) -> None:
    assert _accepts("ClaimResponse", _job_with_provider(provider)) is accepted


# #424-T01, #424-T03: the contract takes the slug, the runner refuses one it has no entry for with
# the existing invalid-job error. The two verdicts on the form always agree for a registered slug.
def test_a_slug_the_contract_accepts_is_still_refused_by_the_runner_without_an_entry() -> None:
    claim = _job_with_provider("fakeai")

    assert _accepts("ClaimResponse", claim)
    with pytest.raises(runner_job.JobError) as refused:
        runner_job.parse_job(json.dumps(claim["job"]["input"]))
    assert refused.value.code.value == "invalid_job"


# #511-T13: the example advertises `anthropic` as well, and the contract file lists it (below).
# #424-T02: a claim without the advertisement is valid and means OpenRouter; the example names it.
def test_the_claim_request_may_leave_the_provider_advertisement_out() -> None:
    assert _accepts("ClaimRequest", {})
    assert _accepts("ClaimRequest", {"engines": ["pr-agent"], "features": ["supersede"]})
    assert _accepts("ClaimRequest", {"llmProviders": ["openrouter"]})
    assert _accepts("ClaimRequest", {"llmProviders": ["openrouter", "fakeai"]})
    assert _example("ClaimRequest")["llmProviders"] == ["openrouter", "anthropic"]
    description = _load(SCHEMA_PATH)["$defs"]["ClaimRequest"]["description"]
    assert "llmProviders" in description and "openrouter" in description


# #424-T01
@pytest.mark.parametrize(
    "advertised",
    [
        [],
        "openrouter",
        ["OpenRouter"],
        ["a" * 33],
        [1],
        ["openrouter", "openrouter"],
        [f"p{index:02d}" for index in range(17)],
    ],
)
def test_the_claim_request_refuses_a_bad_provider_advertisement(advertised: object) -> None:
    assert not _accepts("ClaimRequest", {"llmProviders": advertised})


# #511-T13
# #424-T07: the providers the contract knows are the registry of the runner, in the form of the id.
def test_the_providers_of_the_contract_are_the_providers_of_the_runner_registry() -> None:
    schema = _load(SCHEMA_PATH)
    known: list[str] = schema["$defs"]["KnownLlmProvider"]["enum"]
    pattern: str = schema["$defs"]["LlmProviderId"]["pattern"]

    assert sorted(known) == sorted(registered_provider_ids())
    assert pattern == PROVIDER_ID_PATTERN.pattern
    assert all(re.fullmatch(pattern, name) for name in known)
    assert _example("ClaimRequest")["llmProviders"] == list(registered_provider_ids())


# #424-T04: the job of the previous release still validates and still parses.
def test_the_previous_release_job_is_valid_and_parses_with_the_openrouter_entry() -> None:
    claim = _previous_release_review_claim()

    assert _accepts("ClaimResponse", claim)
    assert runner_job.parse_job(json.dumps(claim["job"]["input"])).llm.provider == "openrouter"


# -- the per-call trace (#541) -------------------------------------------------------------------


def _trace_document() -> Document:
    from decimal import Decimal

    from code_reviewer_runner.dynamic_review.call_trace import CallTrace

    trace = CallTrace()
    trace.tool_called("c1", "read", {"filePath": "src/a.py"})
    trace.tool_resulted("c1", 812)
    trace.tool_called("c2", "bash", {})
    for index in range(3):
        trace.model_call(
            t_ms=1000 * index,
            prompt_tokens=14_600 + 780 * index,
            cache_read=0 if index == 0 else 14_600,
            cache_write=14_600 if index == 0 else 780,
            completion_tokens=400,
            cost=Decimal("0.0342"),
            finish_reason="tool_calls" if index < 2 else "stop",
            final=index == 2,
            tool_names=["read", "bash"] if index < 2 else [],
        )
    document = trace.to_json()
    assert document is not None
    return document


def _complete_with(trace: Any) -> Document:
    complete = _example("CompleteRequest")
    complete["result"]["usage"]["callTrace"] = trace
    return complete


# #541-T06: the contract has the trace as an optional, additive field of the usage.
def test_the_call_trace_the_runner_records_is_valid_and_a_usage_without_one_stays_valid() -> None:
    assert _accepts("CompleteRequest", _complete_with(_trace_document()))
    assert _accepts("CompleteRequest", _example("CompleteRequest"))
    schema: Document = _load(SCHEMA_PATH)
    assert "callTrace" not in schema["$defs"]["RunnerUsage"]["required"]


# #541-T06
def test_the_usage_the_runner_prints_with_a_trace_is_valid() -> None:
    from code_reviewer_runner.result import Usage

    usage = Usage(
        model="vendor/model",
        prompt_tokens=1,
        completion_tokens=1,
        total_tokens=2,
        ai_calls=3,
        fallback_used=False,
        cost_usd=0.01,
        call_trace=_trace_document(),
    ).to_json()
    complete = _example("CompleteRequest")
    complete["result"]["usage"] = usage

    assert _accepts("CompleteRequest", complete)


def _mutations() -> list[tuple[str, Callable[[Document], None]]]:
    return [
        ("an unknown key", lambda t: t.update(extra=1)),
        ("a missing key", lambda t: t.pop("truncated")),
        ("truncated not a boolean", lambda t: t.update(truncated="yes")),
        ("101 model calls", lambda t: t.update(modelCalls=t["modelCalls"][:1] * 101)),
        ("101 tool calls", lambda t: t.update(toolCalls=t["toolCalls"][:1] * 101)),
        ("a call with an extra key", lambda t: t["modelCalls"][0].update(path="src/a.py")),
        ("a call without a key", lambda t: t["modelCalls"][0].pop("tools")),
        ("a negative count", lambda t: t["modelCalls"][0].update(promptTokens=-1)),
        ("a fractional count", lambda t: t["modelCalls"][0].update(cacheRead=1.5)),
        ("a negative cost", lambda t: t["modelCalls"][0].update(costUsd=-0.1)),
        ("an unknown finish reason", lambda t: t["modelCalls"][0].update(finishReason="boom")),
        ("final not a boolean", lambda t: t["modelCalls"][0].update(final=1)),
        ("an unknown tool", lambda t: t["modelCalls"][0]["tools"][0].update(name="bash")),
        ("a tool count of zero", lambda t: t["modelCalls"][0]["tools"][0].update(count=0)),
        ("a tool entry with an extra key", lambda t: t["modelCalls"][0]["tools"][0].update(a=1)),
        ("an unknown tool call name", lambda t: t["toolCalls"][0].update(name="webfetch")),
        ("a tool call with an argument", lambda t: t["toolCalls"][0].update(arguments={})),
        ("isRepeat not a boolean", lambda t: t["toolCalls"][0].update(isRepeat="no")),
        ("a negative result size", lambda t: t["toolCalls"][0].update(resultBytes=-1)),
    ]


# #541-T06: the schema refuses every shape the runner's own check refuses, and the other way round.
@pytest.mark.parametrize(("name", "mutate"), _mutations(), ids=[name for name, _ in _mutations()])
def test_the_contract_and_the_runner_refuse_the_same_bad_call_traces(
    name: str, mutate: Callable[[Document], None]
) -> None:
    from code_reviewer_runner.dynamic_review.call_trace import valid_call_trace

    trace = _trace_document()
    mutate(trace)

    assert not _accepts("CompleteRequest", _complete_with(trace)), name
    assert valid_call_trace(trace) is None, name


# #541-T06
def test_the_contract_and_the_runner_accept_the_same_good_call_traces() -> None:
    from code_reviewer_runner.dynamic_review.call_trace import valid_call_trace

    nulls = _trace_document()
    nulls["modelCalls"][0].update(
        promptTokens=None,
        cacheRead=None,
        cacheWrite=None,
        completionTokens=None,
        costUsd=None,
        finishReason=None,
        tools=[],
    )
    nulls["toolCalls"][0]["resultBytes"] = None
    empty: Document = {"truncated": False, "modelCalls": [], "toolCalls": []}
    for trace in (_trace_document(), nulls, empty):
        assert _accepts("CompleteRequest", _complete_with(trace))
        assert valid_call_trace(trace) == trace
