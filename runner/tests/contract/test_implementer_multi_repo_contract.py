# SPDX-License-Identifier: LicenseRef-Proprietary

"""The multi-repository implementer job of contracts/runner-api.v1.json (#1091, ADR 0006).

Only the contract is checked: the examples are valid, the job form is `repos` or `repo`, never both
and never neither, the tokens, the resume and the result follow the job, and the feature is named
in the file. The parser of the runner does not read `repos` yet (#1093), so nothing here parses a
job of this form.
"""

import copy
import json
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[3]
CONTRACTS = ROOT / "contracts"
SCHEMA_PATH = CONTRACTS / "runner-api.v1.json"
SINGLE = CONTRACTS / "examples" / "implementer"
MULTI = CONTRACTS / "examples" / "implementer-multi-repo"

Document = dict[str, Any]


def _load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _accepts(definition: str, document: Any) -> bool:
    schema: Document = _load(SCHEMA_PATH)
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
        "tokenId": "t1",
    }


def test_the_examples_of_a_multi_repository_turn_are_valid() -> None:
    assert _accepts("RunnerJobInput", _job())
    assert _accepts("RunnerResult", _load(MULTI / "RunnerResult.json"))
    assert _accepts("ImplementerResume", _load(MULTI / "ImplementerResume.json"))
    for name in ("ImplementerJobRepo", "ImplementerRepoResult", "ImplementerResumeRepo"):
        assert _accepts(name, _load(SINGLE / f"{name}.json")), name


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


@pytest.mark.parametrize("key", ["name", "fullName", "cloneUrl", "base", "branch", "tokenId"])
def test_every_field_of_a_repository_is_needed(key: str) -> None:
    job = _job()
    del job["implementer"]["repos"][0][key]
    assert not _accepts("RunnerJobInput", job)


@pytest.mark.parametrize("name", ["", ".", "..", "a/b", "a b", "x" * 203])
def test_a_mount_name_that_is_not_safe_is_refused(name: str) -> None:
    job = _job()
    job["implementer"]["repos"][0]["name"] = name
    assert not _accepts("RunnerJobInput", job)


@pytest.mark.parametrize("name", [".github", "app", "Itegro-GmbH__app", "a.b_c-d", "x" * 202])
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
