# SPDX-License-Identifier: LicenseRef-Proprietary

"""The implementer job kind of contracts/runner-api.v1.json from the runner's side (#746).

The schema and the examples are checked against each other with jsonschema; the strict parser of the
runner agrees with the schema on the same documents; the lists the runner keeps in Python are the
lists of the file; and a job of the new kind that reaches the Diff or Dynamic path is refused with
its stable code (the kind has no engine in this release).
"""

import copy
import io
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator

from code_reviewer_runner import job as runner_job
from code_reviewer_runner import runner
from code_reviewer_runner.capabilities import ALL_ENGINES, ENGINE_IMPLEMENTER, KNOWN_ENGINES
from code_reviewer_runner.result import ErrorCode

ROOT = Path(__file__).resolve().parents[3]
CONTRACTS = ROOT / "contracts"
SCHEMA_PATH = CONTRACTS / "runner-api.v1.json"
EXAMPLES = CONTRACTS / "examples" / "implementer"
FIXTURES = ROOT / "fakes" / "fixtures"

Document = dict[str, Any]

NEW_ERROR_CODES = (
    "branch_exists",
    "base_branch_not_found",
    "clone_failed",
    "setup_failed",
    "agent_gave_up",
    "no_result",
    "push_rejected",
    "branch_violation",
    "cost_limit_reached",
    "time_limit_reached",
    "git_write_not_granted",
    "implementer_engine_unavailable",
    "implementer_config_invalid",
    "sandbox_unproven",
    "sandbox_size_unsupported",
)


def _load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _schema() -> Document:
    return _load(SCHEMA_PATH)


def _accepts(definition: str, document: Any) -> bool:
    schema = _schema()
    validator = Draft202012Validator(
        {"$schema": schema["$schema"], "$ref": f"#/$defs/{definition}", "$defs": schema["$defs"]}
    )
    return bool(validator.is_valid(document))  # pyright: ignore[reportUnknownMemberType]


def _job() -> Document:
    return _load(EXAMPLES / "RunnerJobInput.json")


def _result() -> Document:
    return _load(EXAMPLES / "RunnerResult.json")


def _fixture(name: str) -> Document:
    return _load(FIXTURES / name)


def _set(path: tuple[str, ...], value: Any) -> Callable[[Document], None]:
    """An edit that sets the value at a path of the job example."""

    def edit(document: Document) -> None:
        target = document
        for key in path[:-1]:
            target = target[key]
        target[path[-1]] = value

    return edit


def _drop(path: tuple[str, ...]) -> Callable[[Document], None]:
    def edit(document: Document) -> None:
        target = document
        for key in path[:-1]:
            target = target[key]
        del target[path[-1]]

    return edit


JOB_REFUSALS: dict[str, Callable[[Document], None]] = {
    "unknown top-level field": _set(("somethingNew",), True),
    "unknown implementer field": _set(("implementer", "somethingNew"), True),
    "unknown repo field": _set(("implementer", "repo", "somethingNew"), True),
    "unknown limits field": _set(("implementer", "limits", "somethingNew"), True),
    "prUrl": _set(("prUrl",), "https://github.com/acme/widgets/pull/7"),
    "command": _set(("command",), "review"),
    "args": _set(("args",), ["a question"]),
    "base": _set(("base",), {}),
    "dynamic": _set(("dynamic",), {"model": "m", "skill": "s", "limits": {"maxFindings": 1}}),
    "no implementer block": _drop(("implementer",)),
    "no repo": _drop(("implementer", "repo")),
    "no baseBranch": _drop(("implementer", "baseBranch")),
    "no branch": _drop(("implementer", "branch")),
    "no instruction": _drop(("implementer", "instruction")),
    "no limits": _drop(("implementer", "limits")),
    "no cost": _drop(("implementer", "cost")),
    "no modelEntry": _drop(("implementer", "modelEntry")),
    "instruction too long": _set(("implementer", "instruction"), "x" * 20_001),
    "empty instruction": _set(("implementer", "instruction"), ""),
    "time limit zero": _set(("implementer", "limits", "timeLimitSeconds"), 0),
    "time limit fraction": _set(("implementer", "limits", "timeLimitSeconds"), 1.5),
    "branch starts with a dash": _set(("implementer", "branch"), "-force"),
    "branch with a space": _set(("implementer", "branch"), "has space"),
    "base branch with a space": _set(("implementer", "baseBranch"), "has space"),
    # #909-T07: the start branch is bounded as the base branch is
    "start branch with a space": _set(("implementer", "startBranch"), "has space"),
    "start branch starts with a dash": _set(("implementer", "startBranch"), "-force"),
    "empty start branch": _set(("implementer", "startBranch"), ""),
    "start branch that is not a string": _set(("implementer", "startBranch"), 7),
    "start branch that is null": _set(("implementer", "startBranch"), None),
    "full name without owner": _set(("implementer", "repo", "fullName"), "no-owner"),
    "clone url that is not https": _set(("implementer", "repo", "cloneUrl"), "file:///etc/passwd"),
    # #843: the profile version a turn started with
    "profile that is a string": _set(("implementer", "profile"), "reviewer"),
    "unknown profile field": _set(
        ("implementer", "profile"), {"name": "r", "version": 1, "canPush": True, "model": "m"}
    ),
    "profile without a push right": _set(("implementer", "profile"), {"name": "r", "version": 1}),
    "profile without a name": _set(("implementer", "profile"), {"version": 1, "canPush": True}),
    "profile without a version": _set(("implementer", "profile"), {"name": "r", "canPush": True}),
    "push right that is not a boolean": _set(
        ("implementer", "profile"), {"name": "r", "version": 1, "canPush": "yes"}
    ),
    "profile version zero": _set(
        ("implementer", "profile"), {"name": "r", "version": 0, "canPush": True}
    ),
    "profile version fraction": _set(
        ("implementer", "profile"), {"name": "r", "version": 1.5, "canPush": True}
    ),
    "profile name in capitals": _set(
        ("implementer", "profile"), {"name": "Reviewer", "version": 1, "canPush": True}
    ),
    "empty profile instructions": _set(
        ("implementer", "profile"),
        {"name": "r", "version": 1, "canPush": True, "instructions": ""},
    ),
    "profile instructions too long": _set(
        ("implementer", "profile"),
        {"name": "r", "version": 1, "canPush": True, "instructions": "x" * 20_001},
    ),
}


def test_the_example_of_the_job_is_valid_and_the_runner_reads_it() -> None:
    assert _accepts("RunnerJobInput", _job())

    parsed = runner_job.parse_implementer_input(json.dumps(_job()))

    assert parsed.implementer.repo.full_name == "acme/widgets"
    assert parsed.implementer.repo.clone_url == "https://github.com/acme/widgets.git"
    assert parsed.implementer.base_branch == "main"
    assert parsed.implementer.branch == "implementer/a1b2c3"
    assert parsed.implementer.limits.time_limit_seconds == 3600
    assert parsed.implementer.cost is not None and parsed.implementer.model_entry is not None
    assert parsed.implementer.cost.key_mode == "managed"
    assert parsed.implementer.model_entry.model_id == "deepseek/deepseek-v4.1-flash"
    assert parsed.git.token == "example-git-write-token"


# #909-T07
def test_a_job_may_name_a_start_branch_and_a_job_without_one_is_still_valid() -> None:
    assert "startBranch" not in _job()["implementer"]
    assert _accepts("RunnerJobInput", _job())
    assert runner_job.parse_implementer_input(json.dumps(_job())).implementer.start_branch is None
    job = _job()
    job["implementer"]["startBranch"] = "feature/x"

    assert _accepts("RunnerJobInput", job)
    parsed = runner_job.parse_implementer_input(json.dumps(job)).implementer
    assert (parsed.base_branch, parsed.start_branch) == ("main", "feature/x")


# #909-T07
def test_the_runner_refuses_a_start_branch_that_is_the_new_branch() -> None:
    job = _job()
    job["implementer"]["startBranch"] = job["implementer"]["branch"]

    with pytest.raises(runner_job.JobError) as refused:
        runner_job.parse_implementer_input(json.dumps(job))

    assert refused.value.code is ErrorCode.INVALID_JOB
    assert "implementer.startBranch" in refused.value.detail


# #909-T07
def test_a_lone_surrogate_in_the_start_branch_is_refused_by_the_runner() -> None:
    job = _job()
    job["implementer"]["startBranch"] = "a\ud800b"

    with pytest.raises(runner_job.JobError) as refused:
        runner_job.parse_implementer_input(json.dumps(job))

    assert refused.value.code is ErrorCode.INVALID_JOB
    assert "implementer.startBranch" in refused.value.detail


@pytest.mark.parametrize("name", sorted(JOB_REFUSALS))
def test_the_schema_and_the_runner_both_refuse(name: str) -> None:
    job = _job()
    JOB_REFUSALS[name](job)

    assert not _accepts("RunnerJobInput", job)
    with pytest.raises(runner_job.JobError) as refused:
        runner_job.parse_implementer_input(json.dumps(job))
    assert refused.value.code is ErrorCode.INVALID_JOB


def test_the_example_of_the_profile_is_valid_and_the_runner_reads_it_in_a_job() -> None:
    profile = _load(EXAMPLES / "ImplementerProfile.json")
    assert _accepts("ImplementerProfile", profile)
    job = _job()
    job["implementer"]["profile"] = profile
    assert _accepts("RunnerJobInput", job)

    parsed = runner_job.parse_implementer_input(json.dumps(job)).implementer.profile

    assert parsed is not None
    assert (parsed.name, parsed.version, parsed.can_push) == ("reviewer", 3, False)
    assert parsed.instructions == profile["instructions"]


def test_a_job_without_a_profile_is_the_job_of_before_profiles() -> None:
    job = _job()
    assert "profile" not in job["implementer"]

    assert runner_job.parse_implementer_input(json.dumps(job)).implementer.profile is None


@pytest.mark.parametrize(
    "profile",
    [
        {"name": "r", "version": 1, "canPush": True},
        {"name": "r", "version": 1, "canPush": False},
        {"name": "x" * 64, "version": 999999, "canPush": True, "instructions": "x" * 20_000},
        {"name": "a_b-9", "version": 2, "canPush": False, "instructions": "ä😀\n\ttext"},
    ],
)
def test_the_smallest_and_the_largest_profile_are_accepted_by_both(profile: Document) -> None:
    job = _job()
    job["implementer"]["profile"] = profile

    assert _accepts("RunnerJobInput", job)
    parsed = runner_job.parse_implementer_input(json.dumps(job)).implementer.profile
    assert parsed is not None and parsed.can_push is profile["canPush"]
    assert parsed.instructions == profile.get("instructions", "")


def test_the_feature_that_reads_the_profile_is_in_the_contract_and_named_by_the_worker() -> None:
    from code_reviewer_runner.job_loop.worker_api import WORKER_FEATURES

    features = _schema()["$defs"]["KnownClaimFeature"]["enum"]

    assert "implementer_profile" in features
    assert "implementer_profile" in WORKER_FEATURES
    assert set(WORKER_FEATURES) <= set(features)


def _with_resume(resume: Any) -> Document:
    job = _job()
    job["implementer"]["resume"] = resume
    return job


def _resume_example() -> Document:
    return _load(EXAMPLES / "ImplementerResume.json")


# #838-T70
def test_the_example_of_the_resume_is_valid_alone_and_in_the_job_and_the_runner_reads_it() -> None:
    assert _accepts("ImplementerResume", _resume_example())
    assert _accepts("RunnerJobInput", _with_resume(_resume_example()))

    parsed = runner_job.parse_implementer_input(json.dumps(_with_resume(_resume_example())))

    resume = parsed.implementer.resume
    assert resume is not None
    assert [(branch.name, branch.head) for branch in resume.branches] == [
        ("implementer/a1b2c3", "1" * 40),
        ("feature/retry-docs", "2" * 40),
    ]
    assert (resume.turn, resume.checkout) == (2, "feature/retry-docs")


def _resume_set(path: tuple[str | int, ...], value: Any) -> Callable[[Document], None]:
    def edit(resume: Document) -> None:
        target: Any = resume
        for key in path[:-1]:
            target = target[key]
        target[path[-1]] = value

    return edit


RESUME_REFUSALS: dict[str, Callable[[Document], None]] = {
    "unknown field": _resume_set(("somethingNew",), 1),
    "no turn": lambda resume: resume.pop("turn"),
    "no branches": lambda resume: resume.pop("branches"),
    "no checkout": lambda resume: resume.pop("checkout"),
    "turn one": _resume_set(("turn",), 1),
    "turn that is a fraction": _resume_set(("turn",), 2.5),
    "turn above the bound": _resume_set(("turn",), 100_001),
    "unknown branch field": _resume_set(("branches", 0, "somethingNew"), 1),
    "branch without a head": lambda resume: resume["branches"][0].pop("head"),
    "head that is a name": _resume_set(("branches", 0, "head"), "main"),
    "head in upper case": _resume_set(("branches", 0, "head"), "A" * 40),
    "short head": _resume_set(("branches", 0, "head"), "abc1234"),
    "name with a space": _resume_set(("branches", 0, "name"), "has space"),
    "name that starts with a dash": _resume_set(("branches", 0, "name"), "-delete"),
    "checkout with a space": _resume_set(("checkout",), "has space"),
    "checkout that is not text": _resume_set(("checkout",), 3),
    "21 branches": _resume_set(
        ("branches",), [{"name": f"feature/{number}", "head": "1" * 40} for number in range(21)]
    ),
}


# #838-T71
@pytest.mark.parametrize("name", sorted(RESUME_REFUSALS))
def test_the_schema_and_the_runner_both_refuse_a_resume_that_is_not_the_contracts(
    name: str,
) -> None:
    resume = _resume_example()
    RESUME_REFUSALS[name](resume)

    assert not _accepts("RunnerJobInput", _with_resume(resume))
    with pytest.raises(runner_job.JobError) as refused:
        runner_job.parse_implementer_input(json.dumps(_with_resume(resume)))
    assert refused.value.code is ErrorCode.INVALID_JOB


# #838-T72
def test_the_resume_of_a_first_turn_is_absent_in_the_example_and_in_the_parsed_job() -> None:
    assert "resume" not in _job()["implementer"]
    assert runner_job.parse_implementer_input(json.dumps(_job())).implementer.resume is None


# #838-T73
def test_the_worker_names_the_claim_feature_of_a_follow_up_and_the_contract_knows_it() -> None:
    from code_reviewer_runner.job_loop.worker_api import WORKER_FEATURES

    assert "implementer_resume" in WORKER_FEATURES
    for feature in WORKER_FEATURES:
        assert feature in _schema()["$defs"]["KnownClaimFeature"]["enum"], feature


def test_the_longest_instruction_is_accepted_by_both() -> None:
    job = _job()
    job["implementer"]["instruction"] = "x" * 20_000

    assert _accepts("RunnerJobInput", job)
    runner_job.parse_implementer_input(json.dumps(job))


@pytest.mark.parametrize("key", ["prUrl", "command"])
def test_a_diff_job_and_a_dynamic_job_still_need_prurl_and_command(key: str) -> None:
    diff = _fixture("previous-release-review-job.json")
    dynamic = _fixture("dynamic-review-job.json")
    assert _accepts("RunnerJobInput", diff)
    assert _accepts("RunnerJobInput", dynamic)

    for job in (diff, dynamic, {**diff, "reviewKind": "diff"}):
        broken = copy.deepcopy(job)
        del broken[key]
        assert not _accepts("RunnerJobInput", broken)


def test_the_implementer_block_is_forbidden_on_a_diff_job_and_a_dynamic_job() -> None:
    block = _job()["implementer"]

    for job in (_fixture("previous-release-review-job.json"), _fixture("dynamic-review-job.json")):
        assert not _accepts("RunnerJobInput", {**job, "implementer": block})


@pytest.mark.parametrize(
    "name",
    [
        "previous-release-review-job.json",
        "dynamic-review-job.json",
        "dynamic-review-job-capabilities.json",
        "dynamic-review-job-cost-managed.json",
        "dynamic-review-job-cost-own.json",
        "dynamic-review-job-native-managed.json",
        "dynamic-review-job-native-own.json",
    ],
)
def test_every_recorded_job_of_the_earlier_kinds_is_still_valid_and_parses(name: str) -> None:
    job = _fixture(name)

    assert _accepts("RunnerJobInput", job)
    parsed = runner_job.parse_job(json.dumps(job))
    assert parsed.review_kind is not runner_job.ReviewKind.IMPLEMENTER


# #843-T50
def test_the_example_of_the_result_schema_is_valid_and_the_runner_reads_it_in_a_job() -> None:
    schema = _load(EXAMPLES / "ImplementerResultSchema.json")
    assert _accepts("ImplementerResultSchema", schema)
    job = _job()
    job["implementer"]["resultSchema"] = schema
    assert _accepts("RunnerJobInput", job)

    parsed = runner_job.parse_implementer_input(json.dumps(job)).implementer.result_schema

    assert parsed == schema


# #843-T50
def test_a_job_without_a_result_schema_has_none() -> None:
    assert "resultSchema" not in _job()["implementer"]

    assert runner_job.parse_implementer_input(json.dumps(_job())).implementer.result_schema is None


# #843-T50
@pytest.mark.parametrize(
    "schema",
    [
        [],
        {"type": "string"},
        {"type": "object", "properties": {}},
        {"type": "object", "properties": {"a": {"type": "date"}}},
        {"type": "object", "properties": {"a": {"type": "string"}}, "required": ["b"]},
    ],
)
def test_the_runner_refuses_a_result_schema_it_cannot_make_a_tool_from(schema: Any) -> None:
    job = _job()
    job["implementer"]["resultSchema"] = schema

    with pytest.raises(runner_job.JobError) as refused:
        runner_job.parse_implementer_input(json.dumps(job))

    assert refused.value.code is ErrorCode.INVALID_JOB


# #920-T07
def test_the_example_of_the_agent_ask_is_valid_in_the_result_and_in_the_runners_own_check() -> None:
    from code_reviewer_runner.implementer import finish_tool
    from code_reviewer_runner.implementer.report import agent_ask_ok

    value = _load(EXAMPLES / "ImplementerAgentAsk.json")
    assert _accepts("ImplementerAgentAsk", value)
    assert finish_tool.check_ask(value) == [] and agent_ask_ok(value)
    result = _result()
    result["implementer"]["agentAsk"] = value
    assert _accepts("RunnerResult", result)
    for bad in ([], {"question": ""}, {"question": "q", "answer": "x"}, {"options": ["a"]}):
        result["implementer"]["agentAsk"] = bad
        assert not _accepts("RunnerResult", result), bad


# #843-T50
def test_the_example_of_the_agent_result_is_valid_in_the_result_and_fits_the_example_schema() -> (
    None
):
    from code_reviewer_runner.implementer import finish_tool

    value = _load(EXAMPLES / "ImplementerAgentResult.json")
    assert _accepts("ImplementerAgentResult", value)
    schema = _load(EXAMPLES / "ImplementerResultSchema.json")
    assert finish_tool.check_value(schema, value) == []
    result = _result()
    result["implementer"]["agentResult"] = value
    assert _accepts("RunnerResult", result)
    result["implementer"]["agentResult"] = []
    assert not _accepts("RunnerResult", result)


# #843-T50
def test_the_feature_that_reads_the_result_schema_is_in_the_contract_and_named_by_the_worker() -> (
    None
):
    from code_reviewer_runner.job_loop.worker_api import WORKER_FEATURES

    features = _schema()["$defs"]["KnownClaimFeature"]["enum"]

    assert "implementer_result" in features
    assert "implementer_result" in WORKER_FEATURES


def test_the_example_of_the_result_is_valid() -> None:
    assert _accepts("RunnerResult", _result())
    assert _accepts("CompleteRequest", {"leaseToken": "lease-token-example", "result": _result()})
    without = _result()
    del without["implementer"]
    assert _accepts("RunnerResult", without)


def test_the_counts_of_the_branches_that_were_left_out_are_optional_and_accepted() -> None:
    counted = _result()
    counted["implementer"]["branchesDropped"] = {"invalid": 3, "overflow": 7}
    assert _accepts("RunnerResult", counted)
    assert _accepts("RunnerResult", _result())  # the example has none: still valid


# #837
def test_the_branch_that_was_checked_out_is_optional_and_a_name_or_null() -> None:
    named = _result()
    assert named["implementer"]["checkedOut"] == "implementer/a1b2c3"
    assert _accepts("RunnerResult", named)
    named["implementer"]["checkedOut"] = None
    assert _accepts("RunnerResult", named)
    del named["implementer"]["checkedOut"]  # a runner of the release before
    assert _accepts("RunnerResult", named)


def _result_set(path: tuple[str, ...], value: Any) -> Callable[[Document], None]:
    def edit(result: Document) -> None:
        target = result["implementer"]
        for key in path[:-1]:
            target = target[key]
        target[path[-1]] = value

    return edit


def _item_set(list_name: str, key: str, value: Any) -> Callable[[Document], None]:
    """Sets a key of the first item of a list of the implementer block."""

    def edit(result: Document) -> None:
        result["implementer"][list_name][0][key] = value

    return edit


def _pushed_without_head(result: Document) -> None:
    result["implementer"].update(headCommit=None, pushed=True)


COMMIT = {"sha": "a" * 40, "subject": "A change"}
FILE = {"path": "src/a.ts", "status": "added"}

RESULT_REFUSALS: dict[str, Callable[[Document], None]] = {
    "unknown field": _result_set(("somethingNew",), 1),
    "unknown commit field": _item_set("commits", "somethingNew", 1),
    "unknown file field": _item_set("filesChanged", "somethingNew", 1),
    "unknown session field": _result_set(("opencode", "somethingNew"), 1),
    "201 commits": _result_set(("commits",), [COMMIT] * 201),
    "501 files": _result_set(("filesChanged",), [FILE] * 501),
    "summary of 8193 characters": _result_set(("summary",), "x" * 8193),
    "upper-case sha": _item_set("commits", "sha", "A" * 40),
    "short sha": _item_set("commits", "sha", "abc"),
    "base commit that is a name": _result_set(("baseCommit",), "main"),
    "unknown file status": _item_set("filesChanged", "status", "moved"),
    "pushed that is not a boolean": _result_set(("pushed",), "yes"),
    "pushed without a head commit": _pushed_without_head,
    "dropped counts with an unknown field": _result_set(
        ("branchesDropped",), {"invalid": 0, "overflow": 0, "somethingNew": 1}
    ),
    "dropped counts without the overflow": _result_set(("branchesDropped",), {"invalid": 0}),
    "a negative dropped count": _result_set(("branchesDropped",), {"invalid": -1, "overflow": 0}),
    "a dropped count that is not a whole number": _result_set(
        ("branchesDropped",), {"invalid": 0, "overflow": 1.5}
    ),
    "dropped counts that are null": _result_set(("branchesDropped",), None),
    "a checked out branch without a name": _result_set(("checkedOut",), ""),
    "a checked out branch name of 256 characters": _result_set(("checkedOut",), "x" * 256),
    "a checked out branch that is a number": _result_set(("checkedOut",), 3),
}


@pytest.mark.parametrize("name", sorted(RESULT_REFUSALS))
def test_the_schema_refuses_a_malformed_result(name: str) -> None:
    result = _result()
    RESULT_REFUSALS[name](result)

    assert not _accepts("RunnerResult", result)


def test_the_limits_of_the_result_are_inclusive() -> None:
    result = _result()
    result["implementer"]["commits"] = [COMMIT] * 200
    result["implementer"]["filesChanged"] = [FILE] * 500
    result["implementer"]["summary"] = "x" * 8192

    assert _accepts("RunnerResult", result)


def test_a_failed_turn_may_report_nothing_pushed_and_no_session() -> None:
    result = _result()
    result.update(ok=False, errorCode="agent_gave_up")
    result["implementer"].update(
        headCommit=None, pushed=False, commits=[], filesChanged=[], opencode=None
    )

    assert _accepts("RunnerResult", result)


def test_the_split_claim_example_names_the_kind() -> None:
    claim = _load(EXAMPLES / "SplitClaimResponse.json")

    assert claim["job"]["reviewKind"] == "implementer"
    assert _accepts("SplitClaimResponse", claim)


def test_the_review_kinds_of_the_runner_are_the_review_kinds_of_the_file() -> None:
    listed: list[str] = _schema()["$defs"]["ReviewKind"]["enum"]

    assert sorted(kind.value for kind in runner_job.ReviewKind) == sorted(listed)
    assert "implementer" in listed


def test_the_engines_of_the_runner_are_the_engines_of_the_file() -> None:
    listed: list[str] = _schema()["$defs"]["Engine"]["enum"]

    assert ENGINE_IMPLEMENTER == "implementer"
    assert sorted({*ALL_ENGINES, ENGINE_IMPLEMENTER}) == sorted(listed)
    # The reviewer engines are what the Dynamic self-check gates; `implementer` is advertised on top
    # of them by its own start-up check (#765), so it is not one of them.
    assert ENGINE_IMPLEMENTER not in ALL_ENGINES
    assert (*ALL_ENGINES, ENGINE_IMPLEMENTER) == KNOWN_ENGINES
    assert _accepts("ClaimRequest", {"engines": ["pr-agent", "opencode", "implementer"]})


def test_the_new_error_codes_are_in_the_file_and_in_the_runner_once() -> None:
    listed: list[str] = _schema()["$defs"]["KnownRunnerErrorCode"]["enum"]
    known = [code.value for code in ErrorCode]

    for code in NEW_ERROR_CODES:
        assert listed.count(code) == 1, code
        assert known.count(code) == 1, code
    assert len(listed) == len(set(listed))
    assert {code.value for code in ErrorCode} <= set(listed)


def test_the_names_the_worker_container_gets_are_the_names_of_the_file() -> None:
    defs = _schema()["$defs"]

    assert runner_job.IMPLEMENTER_ENVIRONMENT_NAMES == (
        "RUNNER_IMPLEMENTER_WORK_DIR",
        "RUNNER_IMPLEMENTER_MODEL_DOOR",
        "RUNNER_IMPLEMENTER_SANDBOX_PROOF",
        "RUNNER_IMPLEMENTER_AGENT_MEMORY_MB",
        "RUNNER_IMPLEMENTER_NETWORK_SWITCH",
    )
    assert sorted(runner_job.IMPLEMENTER_ENVIRONMENT_NAMES) == sorted(
        defs["KnownImplementerEnvironmentName"]["enum"]
    )
    assert runner_job.IMPLEMENTER_WORK_DIR == "/work"


# #746-T07
def test_parse_job_refuses_the_new_kind_with_its_code_and_never_returns_another_kind() -> None:
    with pytest.raises(runner_job.JobError) as refused:
        runner_job.parse_job(json.dumps(_job()))

    assert refused.value.code is ErrorCode.IMPLEMENTER_ENGINE_UNAVAILABLE
    assert "example-git-write-token" not in str(refused.value)
    assert "Add a retry" not in str(refused.value)


# #746-T07
def test_an_invalid_implementer_job_is_an_invalid_job_not_an_unavailable_engine() -> None:
    job = _job()
    del job["implementer"]["branch"]

    with pytest.raises(runner_job.JobError) as refused:
        runner_job.parse_job(json.dumps(job))

    assert refused.value.code is ErrorCode.INVALID_JOB


# #746-T07
def test_the_runner_entry_point_reports_the_code_and_runs_nothing_else() -> None:
    out = io.StringIO()

    code = runner.main([], stdin=io.StringIO(json.dumps(_job())), stdout=out)

    result = json.loads(out.getvalue())
    assert code != 0
    assert result["ok"] is False
    assert result["errorCode"] == "implementer_engine_unavailable"
    assert "example-git-write-token" not in out.getvalue()
