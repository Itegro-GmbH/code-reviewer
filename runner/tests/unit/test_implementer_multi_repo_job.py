# SPDX-License-Identifier: LicenseRef-Proprietary

"""The parser of a multi-repository implementer job (#1093, epic #1090, ADR 0006), beside the shared
negative corpus of `tests/contract/test_implementer_multi_repo_contract.py`: what a parsed job
holds, the tokens of each repository, the per-repository resume, the names and the single form
that must stay as it was."""

import json
from pathlib import Path
from typing import Any

import pytest

from code_reviewer_runner.implementer.repo_names import derive_mount_names, is_mount_name
from code_reviewer_runner.job import JobError, parse_implementer_input
from code_reviewer_runner.result import ErrorCode

pytestmark = pytest.mark.unit

EXAMPLES = Path(__file__).resolve().parents[3] / "contracts" / "examples"
MULTI = EXAMPLES / "implementer-multi-repo"


def _job(name: str = "RunnerJobInput.json") -> dict[str, Any]:
    path = MULTI / name if "/" not in name else EXAMPLES / name
    return json.loads(path.read_text(encoding="utf-8"))


def _parse(document: dict[str, Any]) -> Any:
    return parse_implementer_input(json.dumps(document))


# #1093-T20
def test_a_job_with_repos_parses_into_one_entry_per_repository() -> None:
    parsed = _parse(_job())

    repos = parsed.implementer.repos
    assert [repo.name for repo in repos] == ["acme__app", "shared-lib", "other-org__app"]
    assert [repo.direct for repo in repos] == [False, True, False]
    assert [repo.branch_exists for repo in repos] == [False, False, True]
    # The old single fields are those of the first repository.
    assert parsed.implementer.repo.full_name == "acme/app"
    assert parsed.implementer.branch == "feature/ACME-12"
    assert parsed.implementer.start_branch is None


# #1177-T73
def test_push_only_marks_the_entry_whose_branch_is_the_only_one_pushed() -> None:
    document = _job()
    document["implementer"]["repos"][0]["pushOnly"] = True

    repos = _parse(document).implementer.repos

    assert [repo.push_only for repo in repos] == [True, False, False]


# #1177-T74
def test_push_only_must_be_true_or_false() -> None:
    document = _job()
    document["implementer"]["repos"][0]["pushOnly"] = "yes"

    with pytest.raises(JobError) as caught:
        _parse(document)

    assert caught.value.code == ErrorCode.INVALID_JOB


# #1093-T21
def test_every_repository_has_the_token_its_tokenid_names() -> None:
    parsed = _parse(_job())

    assert [parsed.git.token_of(repo.token_id) for repo in parsed.implementer.repos] == [
        "example-git-write-token-1",
        "example-git-write-token-1",
        "example-git-write-token-2",
    ]
    assert parsed.git.token == "example-git-write-token-1"


# #1093-T22
def test_every_token_of_the_job_is_a_secret_of_the_turn() -> None:
    secrets = _parse(_job()).secrets

    assert "example-git-write-token-1" in secrets and "example-git-write-token-2" in secrets


# #1093-T23
def test_the_job_of_today_has_no_repos_and_is_parsed_as_it_was() -> None:
    parsed = _parse(_job("implementer/RunnerJobInput.json"))

    assert parsed.implementer.repos is None and parsed.git.tokens == ()


# #1093-T24
def test_tokens_without_repos_and_repos_without_tokens_are_refused() -> None:
    single = _job("implementer/RunnerJobInput.json")
    single["git"]["tokens"] = [{"id": "t1", "token": single["git"]["token"]}]
    multi = _job()
    del multi["git"]["tokens"]

    for document in (single, multi):
        with pytest.raises(JobError) as refused:
            _parse(document)
        assert refused.value.code is ErrorCode.INVALID_JOB


# #1093-T25
def test_a_follow_up_gives_each_repository_its_own_branches_and_checkout() -> None:
    parsed = _parse(_job("implementer-multi-repo/variants/RunnerJobInput.follow-up.json"))

    resume = parsed.implementer.resume
    assert resume is not None and resume.repos is not None
    assert resume.branches == () and resume.checkout is None
    for repo in parsed.implementer.repos:
        single = resume.for_repo(repo.name)
        assert single.repos is None and single.turn == resume.turn
        assert single.branches == next(r for r in resume.repos if r.name == repo.name).branches


# #1093-T26
def test_a_resume_checkout_must_be_one_of_the_repository_s_branches_or_its_working_branch() -> None:
    document = _job("implementer-multi-repo/variants/RunnerJobInput.follow-up.json")
    document["implementer"]["resume"]["repos"][0]["checkout"] = "some/other-branch"

    with pytest.raises(JobError) as refused:
        _parse(document)

    assert refused.value.code is ErrorCode.INVALID_JOB


# #1093-T27
def test_a_job_with_eleven_repositories_is_refused() -> None:
    document = _job()
    entry = document["implementer"]["repos"][1]
    document["implementer"]["repos"] = [
        {
            **entry,
            "name": f"r{i}",
            "fullName": f"acme/r{i}",
            "cloneUrl": f"https://github.com/acme/r{i}",
        }
        for i in range(11)
    ]

    with pytest.raises(JobError):
        _parse(document)


# #1093-T28
def test_the_clone_address_of_the_second_repository_is_checked_before_a_token_goes_there() -> None:
    document = _job()
    document["implementer"]["repos"][1]["cloneUrl"] = "https://evil.example/acme/shared-lib.git"

    with pytest.raises(JobError) as refused:
        _parse(document)

    assert "cloneUrl" in refused.value.detail


# #1093-T29
@pytest.mark.parametrize(
    ("full_names", "expected"),
    [
        (["acme/app", "acme/shared-lib", "other/app"], ["acme__app", "shared-lib", "other__app"]),
        (["other/app", "acme/shared-lib", "acme/app"], ["other__app", "shared-lib", "acme__app"]),
        (["acme/App", "other/app"], ["acme__App", "other__app"]),
        (
            ["acme/result", "acme/Reserve", "acme/.git", "acme/x"],
            ["acme__result", "acme__Reserve", "acme__.git", "x"],
        ),
    ],
)
def test_mount_names_are_derived_without_regard_to_case_and_order(
    full_names: list[str], expected: list[str]
) -> None:
    assert derive_mount_names(full_names) == expected


# #1093-T30
@pytest.mark.parametrize("name", ["", ".", "..", "-x", "a/b", "result", "RESERVE", ".git", ".Git"])
def test_a_name_that_cannot_be_a_mount_is_none(name: str) -> None:
    assert not is_mount_name(name)


def test_a_dot_directory_name_that_is_plain_is_a_mount() -> None:
    assert is_mount_name(".github") and is_mount_name("a.b-c_d")


# #1093-T31
def test_the_job_host_masks_every_git_token_of_a_multi_repository_job() -> None:
    from code_reviewer_runner.job_loop.host import _secrets_in  # pyright: ignore[reportPrivateUsage]

    secrets = _secrets_in(_job())

    assert "example-git-write-token-1" in secrets
    assert "example-git-write-token-2" in secrets
    assert "example-llm-key" in secrets
