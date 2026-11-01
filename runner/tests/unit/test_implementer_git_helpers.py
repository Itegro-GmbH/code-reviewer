# SPDX-License-Identifier: LicenseRef-Proprietary

"""The pure parts of the Implementer's git workspace (#762): how the guard's configuration is
written, how the spool is read, how a git version is judged and what a workspace refuses to be
built with."""

import re
import shlex
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import pytest

from code_reviewer_runner.implementer.git_process import (
    MIN_GIT_VERSION,
    GitProcess,
    Outcome,
    parse_git_version,
)
from code_reviewer_runner.implementer.git_workspace import (
    AgentUser,
    GitIdentity,
    GitWorkspace,
    WorkspaceLayout,
    WorkspaceSpec,
)
from code_reviewer_runner.implementer.guard_files import (
    parse_spool,
    system_gitconfig_text,
)
from code_reviewer_runner.job import JobError
from code_reviewer_runner.result import ErrorCode

SHA = "a" * 40


# #762-T02
def test_the_system_git_config_points_at_the_hooks_and_trusts_the_repository() -> None:
    text = system_gitconfig_text(Path("/opt/code-reviewer/guard"), [Path("/work/repo")])

    assert 'hooksPath = "/opt/code-reviewer/guard"' in text
    assert 'directory = "/work/repo"' in text


# #762-T12
def test_the_spool_lines_that_look_like_a_tip_update_are_read_and_the_rest_ignored() -> None:
    text = (
        f"1700000000.123 {SHA}\nnot a line\n\n17.5 {'b' * 40} extra\n9 {'c' * 39}\n12 {'d' * 40}\n"
    )

    assert parse_spool(text) == [(1700000000.123, SHA), (12.0, "d" * 40)]


# #762-T12
def test_a_spool_of_binary_garbage_gives_no_entries() -> None:
    assert parse_spool("\x00\x01\xff" * 1000) == []


# #762-T11
@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("git version 2.53.0", (2, 53, 0)),
        ("git version 2.43.0\n", (2, 43, 0)),
        ("git version 2.39.5 (Apple Git-154)", (2, 39, 5)),
        ("git version 3.0", (3, 0)),
        ("nonsense", None),
        ("", None),
    ],
)
def test_the_git_version_is_read_from_its_banner(
    text: str, expected: tuple[int, ...] | None
) -> None:
    assert parse_git_version(text) == expected


# #762-T11
def test_the_minimum_git_is_2_53() -> None:
    assert MIN_GIT_VERSION == (2, 53)
    below: tuple[int, ...] = (2, 52, 9)
    above: tuple[int, ...] = (2, 53, 0)
    assert below < MIN_GIT_VERSION <= above
    assert re.fullmatch(r"\d+\.\d+", ".".join(map(str, MIN_GIT_VERSION)))


def _workspace(tmp_path: Path, **overrides: object) -> GitWorkspace:
    layout = WorkspaceLayout(
        work_dir=tmp_path / "work",
        run_dir=tmp_path / "run",
        guard_dir=tmp_path / "guard",
        agent_home=tmp_path / "home",
    )
    spec = WorkspaceSpec(
        clone_url=str(overrides.pop("clone_url", "https://github.com/acme/widgets.git")),
        token="ghs_token",
        base_branch="main",
        branch="implementer/a1",
    )
    agent = overrides.pop("agent", AgentUser(uid=10101, gid=10101))
    assert isinstance(agent, AgentUser)
    return GitWorkspace(
        spec,
        layout,
        agent,
        GitIdentity("Implementer", "i@example.invalid"),
        **overrides,  # type: ignore[arg-type]
    )


# #762-T10
def test_the_agent_is_never_root(tmp_path: Path) -> None:
    for uid, gid in ((0, 10101), (10101, 0)):
        with pytest.raises(JobError) as refused:
            _workspace(tmp_path, agent=AgentUser(uid=uid, gid=gid))
        assert refused.value.code is ErrorCode.IMPLEMENTER_CONFIG_INVALID


# #762-T10
@pytest.mark.parametrize(
    "url",
    [
        "http://github.com/acme/widgets.git",
        "git://github.com/acme/widgets.git",
        "ssh://git@github.com/acme/widgets.git",
        "ext::sh -c id",
        "file:///etc",
        "/etc",
        "https://user:pw@github.com/acme/widgets.git",
        "https://github.com/acme/widgets.git?x=1",
        "https://",
        "",
    ],
)
def test_only_an_https_address_without_credentials_is_accepted_by_default(
    tmp_path: Path, url: str
) -> None:
    with pytest.raises(JobError) as refused:
        _workspace(tmp_path, clone_url=url)

    assert refused.value.code is ErrorCode.IMPLEMENTER_CONFIG_INVALID
    assert "user:pw" not in str(refused.value)


# #762-T10
def test_an_https_address_is_accepted(tmp_path: Path) -> None:
    workspace = _workspace(tmp_path)

    assert workspace.mirror == tmp_path / "work" / "mirror.git"
    assert workspace.repo == tmp_path / "work" / "repo"


def _recording_git(monkeypatch: pytest.MonkeyPatch) -> list[list[str]]:
    """Every git the workspace would run, recorded and failed (no process is started)."""
    calls: list[list[str]] = []

    def run(
        self: GitProcess,
        args: Sequence[str],
        *,
        env: Mapping[str, str],
        cwd: Path | str = "/",
        spawn: Mapping[str, Any] | None = None,
        timeout: float = 0.0,
    ) -> Outcome:
        calls.append(list(args))
        return Outcome(1, "", "")

    monkeypatch.setattr(GitProcess, "run", run)
    return calls


# #762-T09
def test_the_agent_branch_is_read_by_an_upload_pack_that_runs_as_the_agents_user(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = _recording_git(monkeypatch)
    workspace = _workspace(tmp_path)

    workspace.agent_tip()
    with pytest.raises(JobError):
        workspace.push()

    reads = [call for call in calls if "ls-remote" in call or "fetch" in call]
    # The tip is listed, the branch fetched, and the failed fetch is explained by listing it again.
    assert [call[0] if call[0] == "ls-remote" else "fetch" for call in reads] == [
        "ls-remote",
        "fetch",
        "ls-remote",
    ]
    for call in reads:
        (option,) = [argument for argument in call if argument.startswith("--upload-pack=")]
        command = shlex.split(option.removeprefix("--upload-pack="))
        assert command[0].endswith("setpriv")
        assert "--reuid=10101" in command and "--regid=10101" in command
        assert "--clear-groups" in command and "--no-new-privs" in command
        assert command[-1] == "upload-pack" and command[-2].endswith("git")


# #762-T09
def test_the_fetch_of_the_agent_branch_checks_its_objects_and_takes_no_tags(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = _recording_git(monkeypatch)
    workspace = _workspace(tmp_path)

    with pytest.raises(JobError):
        workspace.push()

    (fetch,) = [call for call in calls if "fetch" in call]
    assert "fetch.fsckObjects=true" in fetch
    assert "--no-tags" in fetch


# #762-T09
def test_git_output_on_the_agents_repository_is_dropped_and_a_denial_becomes_a_fixed_text() -> None:
    process = GitProcess("git", "/usr/bin", Path("/"), "ghs_token")
    secret = "fatal: unexpected line in ./packed-refs: SECRET-LINE\n"

    assert process.agent_detail(secret) == ""
    assert (
        process.agent_detail(secret + "code-reviewer-guard: HEAD may only follow implementer/x\n")
        == "HEAD may only follow the agent's branch"
    )


# #762-T09
@pytest.mark.parametrize(
    ("line", "fixed"),
    [
        ("the guard configuration is missing", "the guard configuration is not usable"),
        ("the guard configuration is incomplete", "the guard configuration is not usable"),
        (
            "the guard configuration names a repository that is not one",
            "the guard configuration is not usable",
        ),
        ("deleting implementer/x is not allowed", "deleting a ref is not allowed"),
        ("deleting refs/tags/SECRET is not allowed", "deleting a ref is not allowed"),
        ("implementer/x may only move forward", "the branch may only move forward"),
        ("the tip must contain the start commit", "the tip must contain the start commit"),
        ("HEAD may only point at implementer/x", "HEAD may only follow the agent's branch"),
        ("HEAD may only follow implementer/x", "HEAD may only follow the agent's branch"),
        ("updating refs/heads/SECRET is not allowed", "only the agent's branch may be updated"),
    ],
)
def test_every_denial_of_the_hook_maps_to_a_text_the_agent_cannot_choose(
    line: str, fixed: str
) -> None:
    process = GitProcess("git", "/usr/bin", Path("/"), "ghs_token")

    assert process.agent_detail(f"code-reviewer-guard: {line}\n") == fixed


# #762-T09
def test_a_line_that_claims_to_be_a_denial_but_is_no_known_one_says_nothing_of_its_own() -> None:
    process = GitProcess("git", "/usr/bin", Path("/"), "ghs_token")

    detail = process.agent_detail(
        "code-reviewer-guard: " + "x" * 1000 + "\ncode-reviewer-guard: ghs_token\n"
    )

    assert detail == "the guard refused the change"
    assert "ghs_token" not in detail and "x" * 20 not in detail


# #762-T09
def test_control_characters_and_the_token_are_cleaned_from_the_detail_of_the_runners_git() -> None:
    process = GitProcess("git", "/usr/bin", Path("/"), "ghs_token")

    cleaned = process.detail("fatal: \x1b[31mred\x00 ghs_token\n\n   \nsecond line")

    assert "\x1b" not in cleaned and "\x00" not in cleaned
    assert "ghs_token" not in cleaned
    assert cleaned.endswith("second line")


# #762-T15
def test_every_git_on_the_mirror_switches_auto_gc_and_auto_maintenance_off(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = _recording_git(monkeypatch)
    workspace = _workspace(tmp_path)

    workspace.agent_tip()
    with pytest.raises(JobError):
        workspace.push()

    on_the_mirror = [call for call in calls if "--git-dir" in call]
    assert on_the_mirror, "the push runs git on the mirror"
    for call in on_the_mirror:
        pairs = [(call[i], call[i + 1]) for i in range(len(call) - 1)]
        assert ("-c", "gc.auto=0") in pairs, call
        assert ("-c", "maintenance.auto=false") in pairs, call
