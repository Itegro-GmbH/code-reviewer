# SPDX-License-Identifier: LicenseRef-Proprietary

"""The `resume` of an implementer job (#838, part of #745): what a follow-up turn is told about the
branches the earlier turn left on the provider. The parser is closed and strict; it never echoes a
value, and a job without `resume` is a first turn as before."""

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
SHA_A = "a" * 40
SHA_B = "b" * 40
SESSION_BRANCH = "implementer/a1b2c3"

Document = dict[str, Any]


def _resume(**changes: Any) -> Document:
    return {
        "turn": 2,
        "branches": [
            {"name": SESSION_BRANCH, "head": SHA_A},
            {"name": "feature/y", "head": SHA_B},
        ],
        "checkout": "feature/y",
        **changes,
    }


def _job(resume: Document | None = None) -> Document:
    job = json.loads(EXAMPLE.read_text(encoding="utf-8"))
    if resume is not None:
        job["implementer"]["resume"] = resume
    return job


def _parse(job: Document) -> runner_job.ImplementerInput:
    return runner_job.parse_implementer_input(json.dumps(job))


# #838-T01
def test_the_resume_of_a_follow_up_turn_is_read() -> None:
    parsed = _parse(_job(_resume()))

    resume = parsed.implementer.resume
    assert resume is not None
    assert resume.turn == 2
    assert [(branch.name, branch.head) for branch in resume.branches] == [
        (SESSION_BRANCH, SHA_A),
        ("feature/y", SHA_B),
    ]
    assert resume.checkout == "feature/y"


# #838-T02
def test_a_job_without_resume_is_a_first_turn() -> None:
    assert _parse(_job()).implementer.resume is None


# #838-T03
def test_a_resume_without_branches_is_allowed_and_checks_out_the_session_branch() -> None:
    resume = _parse(_job(_resume(branches=[], checkout=None))).implementer.resume

    assert resume is not None
    assert resume.branches == ()
    assert resume.checkout is None


# #838-T04
def test_the_session_branch_may_be_the_one_to_check_out_though_it_never_arrived() -> None:
    resume = _parse(
        _job(_resume(branches=[{"name": "feature/y", "head": SHA_B}], checkout=SESSION_BRANCH))
    ).implementer.resume

    assert resume is not None and resume.checkout == SESSION_BRANCH


def _set(key: str, value: Any) -> Callable[[Document], None]:
    return lambda resume: resume.__setitem__(key, value)


def _branch(**changes: Any) -> Callable[[Document], None]:
    def edit(resume: Document) -> None:
        resume["branches"][1].update(changes)

    return edit


def _name(value: str) -> Callable[[Document], None]:
    """Only the name is wrong: `checkout` is left out so it is not the reason for the refusal."""

    def edit(resume: Document) -> None:
        resume["branches"][1]["name"] = value
        resume["checkout"] = None

    return edit


RESUME_REFUSALS: dict[str, Callable[[Document], None]] = {
    "unknown field": _set("somethingNew", True),
    "no turn": lambda resume: resume.pop("turn"),
    "no branches": lambda resume: resume.pop("branches"),
    "no checkout": lambda resume: resume.pop("checkout"),
    "turn one": _set("turn", 1),
    "turn that is a fraction": _set("turn", 2.5),
    "turn that is a boolean": _set("turn", True),
    "turn that is a string": _set("turn", "2"),
    "branches that are not a list": _set("branches", {"name": "x", "head": SHA_A}),
    "unknown branch field": _branch(somethingNew=1),
    "branch without a head": lambda resume: resume["branches"][1].pop("head"),
    "branch without a name": lambda resume: resume["branches"][1].pop("name"),
    "name that starts with a dash": _branch(name="-delete"),
    "name with a space": _branch(name="has space"),
    "name that is not text": _branch(name=7),
    "name that could never be pushed (a tilde)": _name("a~b"),
    "name that could never be pushed (two dots)": _name("a..b"),
    "name that could never be pushed (a lock)": _name("feature/x.lock"),
    "name that could never be pushed (a plus)": _name("+plus"),
    "name that could never be pushed (a reflog)": _name("a@{u}b"),
    "name with a control character": _name("a\x01b"),
    "name with a NUL": _name("a\x00b"),
    "name with a lone surrogate": _name("a\ud800b"),
    "head that is a name": _branch(head="main"),
    "head in upper case": _branch(head="A" * 40),
    "short head": _branch(head="abc1234"),
    "head that is not text": _branch(head=None),
    "the same branch twice": _branch(name=SESSION_BRANCH),
    "21 branches": _set(
        "branches", [{"name": f"feature/{number}", "head": SHA_A} for number in range(21)]
    ),
    "checkout that is not a branch of the list": _set("checkout", "feature/z"),
    "checkout that is not text": _set("checkout", 3),
    "checkout of a branch while the list is empty": lambda resume: resume.update(
        branches=[], checkout="feature/y"
    ),
}


# #838-T05
@pytest.mark.parametrize("name", sorted(RESUME_REFUSALS))
def test_a_resume_the_contract_does_not_allow_is_refused_without_echoing_it(name: str) -> None:
    resume = _resume()
    RESUME_REFUSALS[name](resume)

    with pytest.raises(runner_job.JobError) as refused:
        _parse(_job(resume))

    assert refused.value.code is ErrorCode.INVALID_JOB
    assert "implementer.resume" in refused.value.detail
    for value in ("feature/z", "has space", "-delete", SHA_B):
        assert value not in refused.value.detail


# #838-T06
def test_twenty_branches_are_the_most() -> None:
    branches = [{"name": f"feature/{number}", "head": SHA_A} for number in range(20)]

    resume = _parse(_job(_resume(branches=branches, checkout=None))).implementer.resume

    assert resume is not None and len(resume.branches) == 20


# #838-T07
def test_a_resume_is_no_reason_for_a_branch_name_the_first_turn_would_refuse() -> None:
    job = _job(_resume())
    job["implementer"]["branch"] = job["implementer"]["baseBranch"]

    with pytest.raises(runner_job.JobError) as refused:
        _parse(job)

    assert refused.value.code is ErrorCode.INVALID_JOB


# #838-T05b
@pytest.mark.parametrize("field", ["baseBranch", "branch"])
def test_a_lone_surrogate_in_the_base_or_the_session_branch_is_refused_by_the_parser(
    field: str,
) -> None:
    job = _job(_resume())
    job["implementer"][field] = "a\ud800b"

    with pytest.raises(runner_job.JobError) as refused:
        _parse(job)

    assert refused.value.code is ErrorCode.INVALID_JOB
    assert f"implementer.{field}" in refused.value.detail


# #838-T07b
@pytest.mark.parametrize(
    "name",
    ["a~b", "a..b", "feature/x.lock", "+plus", "a@{u}b", "a\x01b", "a\x85b", "a" * 256, "ä" * 128],
)
def test_a_session_branch_that_could_never_be_pushed_is_refused_on_every_turn(name: str) -> None:
    for resume in (None, _resume(branches=[], checkout=None)):
        job = _job(resume)
        job["implementer"]["branch"] = name

        with pytest.raises(runner_job.JobError) as refused:
            _parse(job)

        assert refused.value.code is ErrorCode.INVALID_JOB
        assert "implementer.branch" in refused.value.detail


# #838-T07c
@pytest.mark.parametrize(
    "name", ["implementer/a1b2c3", "feature/ä-ö", "a+b", "x" * 255, "ä" * 127, "🙂/emoji"]
)
def test_a_session_branch_the_push_takes_is_accepted(name: str) -> None:
    job = _job(None)
    job["implementer"]["branch"] = name

    assert _parse(job).implementer.branch == name


# #838-T08
def test_the_production_setup_hands_the_resume_to_the_workspace(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from code_reviewer_runner.implementer import job_run

    seen: list[Any] = []

    class Quiet:
        def __init__(self, *args: Any, **options: Any) -> None:
            return None

        def close(self) -> None:
            return None

    class Recording(Quiet):
        def __init__(self, spec: Any, *args: Any, **options: Any) -> None:
            seen.append(spec)

    monkeypatch.setattr(job_run, "ReaderAccess", Quiet)
    monkeypatch.setattr(job_run, "GitWorkspace", Recording)

    for resume in (_resume(), None):
        job_run.production_setup(_parse(_job(resume)), {}, lambda: None)

    followed, first = seen
    assert followed.resume == _parse(_job(_resume())).implementer.resume
    assert first.resume is None
