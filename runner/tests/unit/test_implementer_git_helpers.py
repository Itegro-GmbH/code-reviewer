# SPDX-License-Identifier: LicenseRef-Proprietary

"""The pure parts of the Implementer's git workspace (#762): what a workspace refuses to be built
with, how the runner's git is started for the final push, and what travels in an error."""

import shlex
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

import pytest

from code_reviewer_runner.implementer.git_process import GitProcess, Outcome
from code_reviewer_runner.implementer.git_workspace import (
    AgentUser,
    GitIdentity,
    GitWorkspace,
    WorkspaceLayout,
    WorkspaceSpec,
)
from code_reviewer_runner.job import JobError
from code_reviewer_runner.result import ErrorCode

SHA = "a" * 40


def _workspace(tmp_path: Path, **overrides: object) -> GitWorkspace:
    layout = WorkspaceLayout(
        work_dir=tmp_path / "work",
        run_dir=tmp_path / "run",
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


def _listing_git(
    monkeypatch: pytest.MonkeyPatch, branches: dict[str, str], fetched: dict[str, str] | None = None
) -> list[list[str]]:
    """Every git the final push would run, recorded; the agent's repository lists these branches,
    every fetch works, the mirror knows the tips and pushes succeed (no process is started)."""
    calls: list[list[str]] = []
    scratch: dict[str, str] = {}

    def run(
        self: GitProcess,
        args: Sequence[str],
        *,
        env: Mapping[str, str],
        cwd: Path | str = "/",
        spawn: Mapping[str, Any] | None = None,
        timeout: float = 0.0,
    ) -> Outcome:
        words = list(args)
        calls.append(words)
        if "fetch" in words:
            refspec = words[-1]
            source, _, destination = refspec.removeprefix("+").partition(":")
            name = source.removeprefix("refs/heads/")
            scratch[destination] = (fetched or branches)[name]
            return Outcome(0, "", "")
        if "rev-parse" in words:
            ref = words[-1].removesuffix("^{commit}")
            return Outcome(0, scratch.get(ref, "f" * 40) + "\n", "")
        return Outcome(0, "", "")

    def stream(
        self: GitProcess,
        args: Sequence[str],
        *,
        env: Mapping[str, str],
        consume: Callable[[bytes], None],
        cwd: Path | str = "/",
        spawn: Mapping[str, Any] | None = None,
        timeout: float = 0.0,
    ) -> Outcome:
        words = list(args)
        calls.append(words)
        if "for-each-ref" in words:
            consume(
                "".join(f"{tip} refs/heads/{name}\n" for name, tip in branches.items()).encode()
            )
        return Outcome(0, "", "")

    monkeypatch.setattr(GitProcess, "run", run)
    monkeypatch.setattr(GitProcess, "stream", stream)
    return calls


# a fake mirror: the workspace believes the start commit is this
START = "5" * 40


def _ready(tmp_path: Path) -> GitWorkspace:
    workspace = _workspace(tmp_path)
    workspace._start = START  # pyright: ignore[reportPrivateUsage]
    return workspace


# The agent's branches are listed by git running as the agent's user and fetched through an
# upload-pack that runs as the agent's user, with no new privileges, named on the command line;
# root never has the repository as its directory.
def test_the_agents_branches_are_listed_and_fetched_by_an_upload_pack_that_runs_as_the_agents_user(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = _listing_git(monkeypatch, {"implementer/a1": "a" * 40, "second": "b" * 40})
    workspace = _ready(tmp_path)

    report = workspace.push_all(seconds=60.0)

    assert [call[0] for call in calls if "for-each-ref" in call] == ["for-each-ref"]
    reads = [call for call in calls if "fetch" in call]
    assert len(reads) == 2
    for call in reads:
        (option,) = [argument for argument in call if argument.startswith("--upload-pack=")]
        command = shlex.split(option.removeprefix("--upload-pack="))
        assert command[0].endswith("setpriv")
        assert "--reuid=10101" in command and "--regid=10101" in command
        assert "--clear-groups" in command and "--no-new-privs" in command
        assert command[-1] == "upload-pack" and command[-2].endswith("git")
    assert [entry.name for entry in report.branches] == ["implementer/a1", "second"]


def test_the_fetch_asks_for_protocol_2_so_the_advertisement_is_for_one_ref_only(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = _listing_git(monkeypatch, {"one": "a" * 40})
    workspace = _ready(tmp_path)

    workspace.push_all(seconds=60.0)

    (fetch,) = [call for call in calls if "fetch" in call]
    pairs = [(fetch[i], fetch[i + 1]) for i in range(len(fetch) - 1)]
    assert ("-c", "protocol.version=2") in pairs


def test_the_listing_is_read_as_the_agents_user_in_its_repository_never_by_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: list[tuple[list[str], str]] = []
    real = GitProcess.stream

    def stream(self: GitProcess, args: Sequence[str], **options: Any) -> Outcome:
        seen.append((list(args), str(options.get("cwd"))))
        return real(self, args, **options)

    calls = _listing_git(monkeypatch, {"one": "a" * 40})
    monkeypatch.setattr(GitProcess, "stream", stream)
    workspace = _ready(tmp_path)

    workspace.push_all(seconds=5.0)

    # No fake of the stream ran, so the real git was started in the (missing) repository as the
    # agent's user: the listing is the one call that has the repository as its directory.
    listing = [entry for entry in seen if "for-each-ref" in entry[0]]
    assert listing and listing[0][1] == str(workspace.repo)
    assert not any("ls-remote" in call for call in calls)


def test_the_fetch_of_a_branch_checks_its_objects_takes_no_tags_and_names_a_numbered_scratch_ref(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = _listing_git(monkeypatch, {"one": "a" * 40, "two": "b" * 40})
    workspace = _ready(tmp_path)

    workspace.push_all(seconds=60.0)

    fetches = [call for call in calls if "fetch" in call]
    assert len(fetches) == 2, "one fetch per branch"
    for fetch in fetches:
        assert "fetch.fsckObjects=true" in fetch and "transfer.fsckObjects=true" in fetch
        assert "--no-tags" in fetch
    assert fetches[0][-1] == "+refs/heads/one:refs/runner/in/0"
    assert fetches[1][-1] == "+refs/heads/two:refs/runner/in/1"


def test_a_branch_the_listing_puts_at_the_start_commit_is_neither_fetched_nor_reported(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = _listing_git(monkeypatch, {"main": START, "work": "a" * 40})
    workspace = _ready(tmp_path)

    report = workspace.push_all(seconds=60.0)

    assert [entry.name for entry in report.branches] == ["work"]
    assert sum("fetch" in call for call in calls) == 1


def test_a_branch_that_the_fetch_shows_at_the_start_commit_is_not_pushed_whatever_the_listing_said(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = _listing_git(monkeypatch, {"work": "a" * 40}, fetched={"work": START})
    workspace = _ready(tmp_path)

    report = workspace.push_all(seconds=60.0)

    assert report.branches == () and not any("push" in call for call in calls)


def test_every_git_on_the_mirror_switches_auto_gc_and_auto_maintenance_off(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = _listing_git(monkeypatch, {"work": "a" * 40})
    workspace = _ready(tmp_path)

    workspace.push_all(seconds=60.0)

    on_the_mirror = [call for call in calls if "--git-dir" in call]
    assert on_the_mirror, "the push runs git on the mirror"
    for call in on_the_mirror:
        pairs = [(call[i], call[i + 1]) for i in range(len(call) - 1)]
        assert ("-c", "gc.auto=0") in pairs, call
        assert ("-c", "maintenance.auto=false") in pairs, call


# #762-T09
def test_control_characters_and_the_token_are_cleaned_from_the_detail_of_the_runners_git() -> None:
    process = GitProcess("git", "/usr/bin", Path("/"), "ghs_token")

    cleaned = process.detail("fatal: \x1b[31mred\x00 ghs_token\n\n   \nsecond line")

    assert "\x1b" not in cleaned and "\x00" not in cleaned
    assert "ghs_token" not in cleaned
    assert cleaned.endswith("second line")
