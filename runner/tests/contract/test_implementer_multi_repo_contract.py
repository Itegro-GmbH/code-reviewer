# SPDX-License-Identifier: LicenseRef-Proprietary

"""The multi-repository implementer job of contracts/runner-api.v1.json (#1091, ADR 0006).

Only the contract is checked: the examples (and their variants: a continued branch, direct work,
`canPush` false, a follow-up) are valid, the job form is `repos` or `repo`, never both and never
neither, the tokens, the resume and the result follow the job, the feature is named in the file,
and **the shared negative corpus** (contracts/examples/implementer-multi-repo/invalid/, the same
files the app's test reads) is rejected: by the schema where it can state the rule, by the
reference rules of `multi_repo_rules.py` where it cannot. The runner's parser
(`job.parse_implementer_input`, #1093) reads `repos` and is held to the corpus here: every job case
of it is refused with `invalid_job`, and every valid example and variant of a job is accepted. The
lane cases (`AgentStep`) are the app's: only the reference rules read them.
"""

import copy
import json
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator
from multi_repo_rules import (
    apply_patch,
    break_of_job_rule,
    break_of_lane_rule,
    derive_mount_names,
)

from code_reviewer_runner.job import JobError, parse_implementer_input
from code_reviewer_runner.result import ErrorCode

ROOT = Path(__file__).resolve().parents[3]
CONTRACTS = ROOT / "contracts"
SCHEMA_PATH = CONTRACTS / "runner-api.v1.json"
SINGLE = CONTRACTS / "examples" / "implementer"
EXAMPLES = CONTRACTS / "examples"
MULTI = EXAMPLES / "implementer-multi-repo"
VARIANTS = MULTI / "variants"
INVALID = MULTI / "invalid"
WORKFLOW_PATH = CONTRACTS / "workflow.v1.json"

Document = dict[str, Any]


def _load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _accepts(definition: str, document: Any, schema_path: Path = SCHEMA_PATH) -> bool:
    schema: Document = _load(schema_path)
    validator = Draft202012Validator(
        {"$schema": schema["$schema"], "$ref": f"#/$defs/{definition}", "$defs": schema["$defs"]}
    )
    return bool(validator.is_valid(document))  # pyright: ignore[reportUnknownMemberType]


def _job() -> Document:
    return _load(MULTI / "RunnerJobInput.json")


def _entry(index: int) -> Document:
    return {
        "name": f"r{index}",
        "fullName": f"acme/r{index}",
        "cloneUrl": f"https://github.com/acme/r{index}.git",
        "base": "main",
        "branch": "main",
        "branchExists": False,
        "tokenId": "t1",
    }


def test_the_examples_of_a_multi_repository_turn_are_valid() -> None:
    assert _accepts("RunnerJobInput", _job())
    assert _accepts("RunnerResult", _load(MULTI / "RunnerResult.json"))
    assert _accepts("ImplementerResume", _load(MULTI / "ImplementerResume.json"))
    for name in ("ImplementerJobRepo", "ImplementerRepoResult", "ImplementerResumeRepo"):
        assert _accepts(name, _load(SINGLE / f"{name}.json")), name


def _variants() -> list[Path]:
    return sorted(VARIANTS.glob("*.json"))


@pytest.mark.parametrize("path", _variants(), ids=lambda path: path.stem)
def test_every_variant_is_a_valid_document_of_its_definition(path: Path) -> None:
    # `Definition.case.json`: the part before the first dot names the definition.
    assert _accepts(path.name.split(".", 1)[0], _load(path)), path.name


def test_a_continued_branch_starts_at_its_own_tip_and_made_nothing() -> None:
    entry: Document = _load(VARIANTS / "ImplementerRepoResult.continued-branch.json")
    assert entry["created"] is False
    assert entry["baseCommit"] == entry["headCommit"]
    assert entry["commits"] == [] and entry["filesChanged"] == []
    assert entry["pushed"] is True


def test_a_continued_branch_that_got_commits_counts_from_its_start_tip() -> None:
    entry: Document = _load(VARIANTS / "ImplementerRepoResult.continued-branch-with-commits.json")
    assert entry["created"] is False
    assert [commit["sha"] for commit in entry["commits"]] == [entry["headCommit"]]
    assert entry["baseCommit"] != entry["headCommit"]


def test_direct_work_is_pushed_to_the_base_branch() -> None:
    entry: Document = _load(VARIANTS / "ImplementerRepoResult.direct-push.json")
    assert entry["branch"] == entry["base"]
    assert entry["created"] is False and entry["pushed"] is True
    assert entry["branches"][0]["name"] == entry["base"]
    assert entry["branches"][0]["result"] == "pushed"


def test_a_job_that_may_not_push_reports_no_head_commit_and_no_branches() -> None:
    job: Document = _load(VARIANTS / "RunnerJobInput.can-push-false.json")
    assert job["implementer"]["profile"]["canPush"] is False
    entry: Document = _load(VARIANTS / "ImplementerRepoResult.can-push-false.json")
    assert entry["headCommit"] is None and entry["pushed"] is False
    assert entry["commits"] == [] and "branches" not in entry


def test_a_follow_up_has_resume_repos_in_the_order_of_the_job() -> None:
    job: Document = _load(VARIANTS / "RunnerJobInput.follow-up.json")
    names = [repo["name"] for repo in job["implementer"]["repos"]]
    assert [entry["name"] for entry in job["implementer"]["resume"]["repos"]] == names
    assert break_of_job_rule(job) is None


def test_the_job_example_follows_the_rules_the_schema_cannot_state() -> None:
    assert break_of_job_rule(_job()) is None
    for path in _variants():
        if path.name.startswith("RunnerJobInput"):
            assert break_of_job_rule(_load(path)) is None, path.name


def test_the_parser_of_the_runner_accepts_the_job_examples_and_their_variants() -> None:
    paths = [MULTI / "RunnerJobInput.json", *VARIANTS.glob("RunnerJobInput.*.json")]
    assert len(paths) >= 3
    for path in paths:
        parsed = parse_implementer_input(path.read_text(encoding="utf-8"))
        assert parsed.implementer.repos is not None, path.name


def test_mount_names_are_derived_without_regard_to_case_and_to_the_order() -> None:
    assert derive_mount_names(["acme/app", "acme/shared-lib", "other/app"]) == [
        "acme__app",
        "shared-lib",
        "other__app",
    ]
    assert derive_mount_names(["other/app", "acme/shared-lib", "acme/app"]) == [
        "other__app",
        "shared-lib",
        "acme__app",
    ]
    assert derive_mount_names(["acme/App", "other/app"]) == ["acme__App", "other__app"]
    assert derive_mount_names(["acme/result", "acme/Reserve", "acme/.git", "acme/x"]) == [
        "acme__result",
        "acme__Reserve",
        "acme__.git",
        "x",
    ]


def _corpus() -> list[Path]:
    return sorted(INVALID.glob("*.json"))


def test_the_corpus_is_there() -> None:
    assert len(_corpus()) >= 20


@pytest.mark.parametrize("path", _corpus(), ids=lambda path: path.stem)
def test_an_invalid_case_of_the_shared_corpus_is_rejected(path: Path) -> None:
    case: Document = _load(path)
    schema_path = WORKFLOW_PATH if case["definition"] == "AgentStep" else SCHEMA_PATH
    document: Document = (
        copy.deepcopy(case["document"])
        if "document" in case
        else _load(EXAMPLES / f"{case['base']}.json")
    )
    document = apply_patch(document, case["patch"])
    if case["definition"] == "RunnerJobInput":
        # The real parser of the runner, not only the reference rules (#1093): invalid_job.
        with pytest.raises(JobError) as refused:
            parse_implementer_input(json.dumps(document))
        assert refused.value.code is ErrorCode.INVALID_JOB, path.name
    accepted = _accepts(case["definition"], document, schema_path)
    if case["layer"] == "schema":
        assert not accepted, case["why"]
        return
    # A rule the schema cannot state: the document is valid for the schema and a rule breaks it.
    assert accepted, f"{path.name}: the schema refuses it, so the case belongs to layer 'schema'"
    broken = (
        break_of_lane_rule(document)
        if case["definition"] == "AgentStep"
        else break_of_job_rule(document)
    )
    assert broken == case["rule"], case["why"]


def test_the_job_of_today_is_still_valid() -> None:
    single: Document = _load(SINGLE / "RunnerJobInput.json")
    assert "repos" not in single["implementer"]
    assert "tokens" not in single["git"]
    assert _accepts("RunnerJobInput", single)


@pytest.mark.parametrize("key", ["repo", "baseBranch", "branch", "startBranch"])
def test_a_job_with_repos_has_none_of_the_single_fields(key: str) -> None:
    job = _job()
    job["implementer"][key] = (
        _load(SINGLE / "RunnerJobInput.json")["implementer"]["repo"] if key == "repo" else "main"
    )
    assert not _accepts("RunnerJobInput", job)


@pytest.mark.parametrize("key", ["repo", "baseBranch", "branch"])
def test_a_job_without_repos_needs_the_single_fields(key: str) -> None:
    job: Document = _load(SINGLE / "RunnerJobInput.json")
    del job["implementer"][key]
    assert not _accepts("RunnerJobInput", job)


def test_a_job_has_one_to_ten_repositories() -> None:
    job = _job()
    job["implementer"]["repos"] = []
    assert not _accepts("RunnerJobInput", job)
    job["implementer"]["repos"] = [_entry(i) for i in range(10)]
    assert _accepts("RunnerJobInput", job)
    job["implementer"]["repos"].append(_entry(10))
    assert not _accepts("RunnerJobInput", job)


@pytest.mark.parametrize(
    "key", ["name", "fullName", "cloneUrl", "base", "branch", "branchExists", "tokenId"]
)
def test_every_field_of_a_repository_is_needed(key: str) -> None:
    job = _job()
    del job["implementer"]["repos"][0][key]
    assert not _accepts("RunnerJobInput", job)


@pytest.mark.parametrize(
    "name",
    [
        "",
        ".",
        "..",
        "a/b",
        "a b",
        "x" * 203,
        "-x",
        "result",
        "Result",
        "RESERVE",
        "reserve",
        ".git",
        ".GIT",
    ],
)
def test_a_mount_name_that_is_not_safe_is_refused(name: str) -> None:
    job = _job()
    job["implementer"]["repos"][0]["name"] = name
    assert not _accepts("RunnerJobInput", job)


@pytest.mark.parametrize(
    "name",
    [
        ".github",
        "app",
        "Itegro-GmbH__app",
        "a.b_c-d",
        "x" * 202,
        "results",
        "reserved",
        "x-",
        "git",
        ".gitignore",
    ],
)
def test_a_mount_name_that_is_safe_is_accepted(name: str) -> None:
    job = _job()
    job["implementer"]["repos"][0]["name"] = name
    assert _accepts("RunnerJobInput", job)


def test_a_repository_is_closed() -> None:
    job = _job()
    job["implementer"]["repos"][0]["remote"] = "origin"
    assert not _accepts("RunnerJobInput", job)


def test_tokens_are_there_exactly_when_the_job_has_repos() -> None:
    job = _job()
    del job["git"]["tokens"]
    assert not _accepts("RunnerJobInput", job)

    single: Document = _load(SINGLE / "RunnerJobInput.json")
    single["git"]["tokens"] = [{"id": "t1", "token": "x"}]
    assert not _accepts("RunnerJobInput", single)


@pytest.mark.parametrize(
    "tokens",
    [
        [],
        [{"id": "t1"}],
        [{"token": "x"}],
        [{"id": "t 1", "token": "x"}],
        [{"id": "t1", "token": ""}],
        [{"id": "t1", "token": "x", "scope": "all"}],
    ],
)
def test_a_token_entry_is_closed_and_needs_an_id_and_a_token(tokens: list[Document]) -> None:
    job = _job()
    job["git"]["tokens"] = tokens
    assert not _accepts("RunnerJobInput", job)


def test_the_first_token_stays_required() -> None:
    job = _job()
    del job["git"]["token"]
    assert not _accepts("RunnerJobInput", job)


def test_a_resume_has_repos_or_branches_with_checkout_never_both_never_neither() -> None:
    resume: Document = _load(MULTI / "ImplementerResume.json")
    assert "branches" not in resume
    assert _accepts("ImplementerResume", resume)

    both = copy.deepcopy(resume)
    both["branches"] = []
    both["checkout"] = None
    assert not _accepts("ImplementerResume", both)

    neither = copy.deepcopy(resume)
    del neither["repos"]
    assert not _accepts("ImplementerResume", neither)

    empty = copy.deepcopy(resume)
    empty["repos"] = []
    assert not _accepts("ImplementerResume", empty)

    assert _accepts("ImplementerResume", _load(SINGLE / "ImplementerResume.json"))


def test_a_repository_of_a_resume_has_a_name_and_at_most_twenty_branches() -> None:
    resume: Document = _load(MULTI / "ImplementerResume.json")
    resume["repos"][0]["branches"] = [{"name": f"b{i}", "head": "1" * 40} for i in range(21)]
    assert not _accepts("ImplementerResume", resume)

    nameless: Document = _load(MULTI / "ImplementerResume.json")
    del nameless["repos"][0]["name"]
    assert not _accepts("ImplementerResume", nameless)


def test_the_result_holds_the_first_repository_in_the_old_fields() -> None:
    result: Document = _load(MULTI / "RunnerResult.json")
    turn = result["implementer"]
    first = turn["repos"][0]
    for key in (
        "baseCommit",
        "headCommit",
        "pushed",
        "commits",
        "filesChanged",
        "branches",
        "checkedOut",
    ):
        assert turn[key] == first[key], key

    old = copy.deepcopy(result)
    del old["implementer"]["repos"]
    assert _accepts("RunnerResult", old)


def test_the_lists_of_a_repository_of_a_result_are_bounded() -> None:
    def accepts(key: str, value: Any) -> bool:
        result: Document = _load(MULTI / "RunnerResult.json")
        result["implementer"]["repos"][0][key] = value
        return _accepts("RunnerResult", result)

    assert accepts("commitsTruncated", 3) and accepts("filesTruncated", 0)
    assert not accepts("commitsTruncated", -1) and not accepts("filesTruncated", "1")
    commit = {"sha": "a" * 40, "subject": "c"}
    assert accepts("commits", [commit] * 100)
    assert not accepts("commits", [commit] * 101)
    file = {"path": "a", "status": "added"}
    assert accepts("filesChanged", [file] * 250)
    assert not accepts("filesChanged", [file] * 251)
    branch = {"name": "b", "head": "a" * 40, "result": "pushed", "reason": None}
    assert accepts("branches", [branch] * 25)
    assert not accepts("branches", [branch] * 26)


@pytest.mark.parametrize(
    "key",
    [
        "name",
        "fullName",
        "base",
        "branch",
        "created",
        "baseCommit",
        "headCommit",
        "pushed",
        "commits",
        "filesChanged",
    ],
)
def test_every_field_of_a_repository_of_a_result_is_needed(key: str) -> None:
    result: Document = _load(MULTI / "RunnerResult.json")
    del result["implementer"]["repos"][0][key]
    assert not _accepts("RunnerResult", result)


def test_a_pushed_repository_has_a_head_commit() -> None:
    result: Document = _load(MULTI / "RunnerResult.json")
    entry = result["implementer"]["repos"][0]
    entry["pushed"] = True
    entry["headCommit"] = None
    assert not _accepts("RunnerResult", result)


def test_the_feature_is_in_the_file() -> None:
    schema: Document = _load(SCHEMA_PATH)
    assert "implementer_multi_repo" in schema["$defs"]["KnownClaimFeature"]["enum"]


def test_the_report_validator_of_the_runner_accepts_the_example_result() -> None:
    from code_reviewer_runner.implementer.report import valid_block

    block: Document = _load(MULTI / "RunnerResult.json")["implementer"]
    assert valid_block(block) is not None


def test_the_worker_and_the_factory_runner_name_the_feature() -> None:
    from code_reviewer_runner.factory_runner.app_client import FEATURE_MULTI_REPO
    from code_reviewer_runner.job_loop.worker_api import WORKER_FEATURES

    schema: Document = _load(SCHEMA_PATH)
    known = schema["$defs"]["KnownClaimFeature"]["enum"]
    assert FEATURE_MULTI_REPO in WORKER_FEATURES and FEATURE_MULTI_REPO in known
