# SPDX-License-Identifier: LicenseRef-Proprietary

"""Which local branches of the agent's repository the final push takes (the git model of the
Implementer: git is free inside the workspace, the runner pushes all local branches at the end).
The names come from the agent's repository, so they are checked here before any of them is used in
a refspec."""

import shutil
import subprocess

import pytest

from code_reviewer_runner.implementer import push_policy
from code_reviewer_runner.implementer.push_policy import (
    MAX_PUSHED_BRANCHES,
    PUSH_EXCLUDED_BRANCHES,
    REASON_EXCLUDED,
    branch_name_problem,
    select_branches,
)

pytestmark = pytest.mark.unit

FORM = "implementer/a1b2c3"

GOOD = [
    "main",
    "feature/x",
    "implementer/a1b2c3",
    "fix-1.2",
    "a" * 200,
    "release_2026/11/02",
    "umlaut-äöü",
    "with#hash",
    "plus+sign",
    "at@sign",
    "comma,equals=percent%",
    "x.y",
]

# Each of these could change what a refspec, a ref update or a log line means.
HOSTILE = [
    "",
    "-delete",
    "--force",
    "+refs/heads/x",
    "a:b",
    "a b",
    "a\tb",
    "a\nb",
    "a\r\nb",
    "a\x00b",
    "a\x1bb",
    "a\x7fb",
    "a\x85b",
    "a\u2028b",
    "a\u00a0b",
    "a~b",
    "a^b",
    "a?b",
    "a*b",
    "a[b",
    "a\\b",
    "a..b",
    "a//b",
    "/a",
    "a/",
    "a.",
    ".a",
    "a/.b",
    "a.lock",
    "a/b.lock",
    "a/b.lock/c",
    "a@{b",
    "@",
    "HEAD",
    "heads/../../tags/x",
    "x" * 300,
    "a\udcffb",  # not UTF-8 once encoded: a surrogate escape from git's bytes
]


@pytest.mark.parametrize("name", GOOD)
def test_a_normal_branch_name_is_accepted(name: str) -> None:
    assert branch_name_problem(name) is None


@pytest.mark.parametrize("name", HOSTILE)
def test_a_name_that_could_change_a_refspec_or_a_line_is_refused(name: str) -> None:
    assert branch_name_problem(name) is not None


def test_every_name_this_accepts_is_one_git_accepts() -> None:
    git = shutil.which("git")
    assert git is not None
    for name in GOOD:
        done = subprocess.run(
            [git, "check-ref-format", f"refs/heads/{name}"], capture_output=True, check=False
        )
        assert done.returncode == 0, name


def test_the_form_branch_comes_first_then_the_others_by_name() -> None:
    chosen = select_branches(["zeta", FORM, "alpha", "main"], form_branch=FORM)

    assert chosen.names == [FORM, "alpha", "main", "zeta"]


def test_a_branch_the_agent_did_not_create_is_not_treated_differently() -> None:
    # The owner's decision: no check of which branch. This pins that nothing but the exclusion
    # list (empty for now) and the name rules decide.
    chosen = select_branches(["main", "release/1", FORM], form_branch=FORM)

    assert set(chosen.names) == {"main", "release/1", FORM}
    assert chosen.excluded == []


def test_the_exclusion_list_is_empty_for_now() -> None:
    assert frozenset() == PUSH_EXCLUDED_BRANCHES


def test_an_excluded_branch_is_reported_with_its_reason_and_not_chosen(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(push_policy, "PUSH_EXCLUDED_BRANCHES", frozenset({"main"}))

    chosen = select_branches(["main", FORM], form_branch=FORM)

    assert chosen.names == [FORM]
    assert chosen.excluded == [("main", REASON_EXCLUDED)]


def test_hostile_names_are_counted_and_never_chosen_or_named() -> None:
    chosen = select_branches(["ok", "a\nb", "-x", "a b"], form_branch=FORM)

    assert chosen.names == ["ok"]
    assert chosen.invalid == 3


def test_the_same_name_twice_is_one_branch() -> None:
    assert select_branches(["a", "a", "b"], form_branch=FORM).names == ["a", "b"]


def test_more_branches_than_the_limit_are_cut_and_counted() -> None:
    names = [f"b{number:04d}" for number in range(MAX_PUSHED_BRANCHES + 7)]

    chosen = select_branches(names, form_branch=FORM)

    assert len(chosen.names) == MAX_PUSHED_BRANCHES
    assert chosen.overflow == 7


def test_the_form_branch_survives_the_limit() -> None:
    names = [f"a{number:04d}" for number in range(MAX_PUSHED_BRANCHES + 3)] + [FORM]

    chosen = select_branches(names, form_branch=FORM)

    assert chosen.names[0] == FORM
    assert chosen.overflow == 4


def test_excluded_branches_count_toward_the_limit_so_the_report_never_has_more_than_the_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    names = [f"b{number:04d}" for number in range(MAX_PUSHED_BRANCHES + 10)]
    monkeypatch.setattr(push_policy, "PUSH_EXCLUDED_BRANCHES", frozenset(names[:20]))

    chosen = select_branches(names, form_branch=FORM)

    assert len(chosen.names) + len(chosen.excluded) == MAX_PUSHED_BRANCHES
    assert chosen.overflow == 10
    assert [name for name, _ in chosen.excluded] == names[:20]


def test_what_is_dropped_is_the_end_of_the_order_task_branch_then_alphabetical() -> None:
    names = [f"b{number:04d}" for number in range(MAX_PUSHED_BRANCHES + 2)] + [FORM, "a-first"]

    chosen = select_branches(names, form_branch=FORM)

    assert chosen.names[:2] == [FORM, "a-first"]
    assert chosen.overflow == 4 and "b0051" not in chosen.names and "b0000" in chosen.names
