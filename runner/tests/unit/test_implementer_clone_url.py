# SPDX-License-Identifier: LicenseRef-Proprietary

"""The clone address of an implementer job (#762, the review finding on #774).

The job carries a token that may write one repository, and the runner sends it to whatever address
`cloneUrl` names. So the parser pins the address: the host of the git provider's web address, a path
that is exactly the job's repository, and a new branch that is not the base branch. Anything else is
refused before a process starts, with a message that names the field and never echoes the value.
"""

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from code_reviewer_runner import job as runner_job
from code_reviewer_runner.result import ErrorCode

EXAMPLE = (
    Path(__file__).resolve().parents[3]
    / "contracts"
    / "examples"
    / "implementer"
    / "RunnerJobInput.json"
)

Document = dict[str, Any]


def _job() -> Document:
    return json.loads(EXAMPLE.read_text(encoding="utf-8"))


def _with(clone_url: str, base_url: str = "https://api.github.com", **spec: Any) -> Document:
    job = _job()
    job["git"]["baseUrl"] = base_url
    job["implementer"]["repo"]["cloneUrl"] = clone_url
    job["implementer"].update(spec)
    return job


def _refusal(job: Document) -> runner_job.JobError:
    with pytest.raises(runner_job.JobError) as refused:
        runner_job.parse_implementer_input(json.dumps(job))
    return refused.value


# #762-T15
@pytest.mark.parametrize(
    "clone_url",
    [
        "https://github.com/acme/widgets.git",
        "https://github.com/acme/widgets",
    ],
)
def test_the_address_of_the_repository_on_the_provider_host_is_accepted(clone_url: str) -> None:
    parsed = runner_job.parse_implementer_input(json.dumps(_with(clone_url)))

    assert parsed.implementer.repo.clone_url == clone_url


# #762-T15
def test_a_provider_with_its_own_web_host_is_matched_on_that_host() -> None:
    job = _with("https://ghe.example/acme/widgets.git", base_url="https://ghe.example/api/v3")

    # The API address has a path; the web host is its host. Compared by host (and port) only.
    runner_job.parse_implementer_input(json.dumps(job))


REFUSED_ADDRESSES: dict[str, Callable[[], Document]] = {
    "another host": lambda: _with("https://evil.example/acme/widgets.git"),
    "the review's example attack: another repository on another host": lambda: _with(
        "https://evil.example/acme/other.git"
    ),
    "a loopback address": lambda: _with("https://127.0.0.1:1/x"),
    "a loopback address with the repository path": lambda: _with(
        "https://127.0.0.1/acme/widgets.git"
    ),
    "the right name as a prefix of another host": lambda: _with(
        "https://github.com.evil.example/acme/widgets.git"
    ),
    "the provider host as a subdomain": lambda: _with("https://evil.github.com/acme/widgets.git"),
    "the provider host with another port": lambda: _with(
        "https://github.com:8443/acme/widgets.git"
    ),
    "another repository of the owner": lambda: _with("https://github.com/acme/other.git"),
    "another owner": lambda: _with("https://github.com/evil/widgets.git"),
    "a different case of the repository": lambda: _with("https://github.com/Acme/Widgets.git"),
    "a longer path": lambda: _with("https://github.com/acme/widgets.git/extra"),
    "a path before the repository": lambda: _with("https://github.com/x/acme/widgets.git"),
    "no path": lambda: _with("https://github.com"),
    "only the owner": lambda: _with("https://github.com/acme"),
    "a trailing slash": lambda: _with("https://github.com/acme/widgets/"),
    "a dot segment": lambda: _with("https://github.com/acme/../evil/widgets.git"),
    "an encoded repository name": lambda: _with("https://github.com/acme/widget%73.git"),
    "a double suffix": lambda: _with("https://github.com/acme/widgets.git.git"),
    "a credential in the address": lambda: _with("https://user:pw@github.com/acme/widgets.git"),
    "a query": lambda: _with("https://github.com/acme/widgets.git?x=1"),
    "a fragment": lambda: _with("https://github.com/acme/widgets.git#x"),
    "plain http": lambda: _with("http://github.com/acme/widgets.git"),
    "plain http on loopback while the provider is loopback too": lambda: _with(
        "http://127.0.0.1:9/acme/widgets.git", base_url="http://127.0.0.1:8"
    ),
    "a backslash": lambda: _with("https://github.com\\@evil.example/acme/widgets.git"),
}


# #762-T15
@pytest.mark.parametrize("name", sorted(REFUSED_ADDRESSES))
def test_an_address_that_is_not_the_job_repository_on_the_provider_is_refused(name: str) -> None:
    refused = _refusal(REFUSED_ADDRESSES[name]())

    assert refused.code is ErrorCode.INVALID_JOB
    assert "cloneUrl" in refused.detail
    assert "evil" not in str(refused)
    assert "127.0.0.1" not in str(refused)


# #762-T15
def test_the_token_is_not_part_of_the_refusal() -> None:
    refused = _refusal(_with("https://evil.example/acme/widgets.git"))

    assert _job()["git"]["token"] not in str(refused)


# #762-T16
def test_a_new_branch_equal_to_the_base_branch_is_refused() -> None:
    refused = _refusal(_with("https://github.com/acme/widgets.git", branch="main"))

    assert refused.code is ErrorCode.INVALID_JOB
    assert "branch" in refused.detail
    assert "baseBranch" in refused.detail


# #762-T16
def test_a_branch_that_only_looks_like_the_base_branch_is_accepted() -> None:
    parsed = runner_job.parse_implementer_input(
        json.dumps(_with("https://github.com/acme/widgets.git", branch="main2"))
    )

    assert parsed.implementer.branch == "main2"
