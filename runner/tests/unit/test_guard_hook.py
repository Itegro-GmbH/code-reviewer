# SPDX-License-Identifier: LicenseRef-Proprietary

"""The accident guard of the Implementer: the `reference-transaction` hook and its matrix (#761).

The hook keeps the agent on its branch (no amend, reset, rebase, branch switch) and tells the runner
about every commit through a spool file. It is an accident guard, not a security boundary: the
guarantee is the runner's fetch and ancestor check (#762). The hook is fed by hand here, the way git
feeds it, so these tests do not depend on the git version of the host. The matrix script runs the
real git actions and needs git 2.53 or newer; on an older host it must say so and fail, never pass.
"""

import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

RUNNER = Path(__file__).parents[2]
HOOK = RUNNER / "guard" / "reference-transaction"
MATRIX = RUNNER / "scripts" / "guard_matrix.sh"
ZERO = "0" * 40


def git(repo: Path, *args: str) -> str:
    done = subprocess.run(
        ["git", "-C", str(repo), "-c", "user.name=T", "-c", "user.email=t@example.invalid", *args],
        capture_output=True,
        text=True,
        check=True,
        env={
            "PATH": os.environ["PATH"],
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_CONFIG_SYSTEM": "/dev/null",
        },
    )
    return done.stdout.strip()


@pytest.fixture
def repo(tmp_path: Path) -> dict[str, str]:
    """A repository on branch `work` with a start commit, and a guard configuration for it."""
    path = tmp_path / "repo"
    git(tmp_path, "init", "-q", "-b", "work", str(path))
    git(path, "commit", "-q", "--allow-empty", "-m", "start")
    start = git(path, "rev-parse", "HEAD")
    git(path, "commit", "-q", "--allow-empty", "-m", "one")
    conf = tmp_path / "guard.conf"
    spool = tmp_path / "spool"
    spool.touch()
    conf.write_text(f"BRANCH=work\nSTART={start}\nSPOOL={spool}\nREPO={path}\n", encoding="utf-8")
    return {
        "path": str(path),
        "start": start,
        "tip": git(path, "rev-parse", "HEAD"),
        "conf": str(conf),
        "spool": str(spool),
    }


def run_hook(
    repo: dict[str, str],
    state: str,
    lines: list[str],
    *,
    conf: str | None = None,
    cwd: str | Path | None = None,
    environment: dict[str, str] | None = None,
    command: str | None = None,
) -> subprocess.CompletedProcess[str]:
    """The hook as git runs it. `command` is the git command that runs the transaction: the hook
    reads it from the command line of its parent, so the hook is started by a process that has the
    argument vector `git <command>` (a shell that runs a script named like the command)."""
    env = {
        "PATH": os.environ["PATH"],
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_CONFIG_SYSTEM": "/dev/null",
        **(environment or {}),
    }
    if conf != "":
        env["CODE_REVIEWER_GUARD_CONF"] = conf or repo["conf"]
    where = str(cwd or repo["path"])
    if command is None:
        return subprocess.run(
            ["bash", str(HOOK), state],
            input="".join(f"{line}\n" for line in lines),
            capture_output=True,
            text=True,
            cwd=where,
            env=env,
            check=False,
        )
    launcher = Path(repo["conf"]).parent / "launcher" / command
    launcher.parent.mkdir(exist_ok=True)
    launcher.write_text('cd "$1" && bash "$2" "$3"\nexit $?\n', encoding="utf-8")
    return subprocess.run(
        ["git", command, where, str(HOOK), state],
        executable="/bin/bash",
        input="".join(f"{line}\n" for line in lines),
        capture_output=True,
        text=True,
        cwd=launcher.parent,
        env=env,
        check=False,
    )


def spooled(repo: dict[str, str]) -> list[str]:
    return Path(repo["spool"]).read_text(encoding="utf-8").splitlines()


def test_the_hook_is_executable_and_has_the_license_header() -> None:
    assert os.access(HOOK, os.X_OK)
    assert (
        "SPDX-License-Identifier: LicenseRef-Proprietary" in HOOK.read_text(encoding="utf-8")[:200]
    )


# #761-T04
def test_a_forward_move_of_the_branch_is_allowed_and_a_committed_one_is_spooled(
    repo: dict[str, str],
) -> None:
    new = git(Path(repo["path"]), "commit-tree", "-p", repo["tip"], "-m", "next", "HEAD^{tree}")
    update = f"{repo['tip']} {new} refs/heads/work"

    assert run_hook(repo, "prepared", [update]).returncode == 0
    assert spooled(repo) == []
    assert run_hook(repo, "committed", [update]).returncode == 0
    lines = spooled(repo)
    assert len(lines) == 1 and lines[0].endswith(f" {new}")
    assert re.fullmatch(r"\d+\.\d+ [0-9a-f]{40}", lines[0])


# #761-T04
@pytest.mark.parametrize(
    "ref",
    [
        "refs/stash",
        "refs/remotes/origin/main",
        "ORIG_HEAD",
        "FETCH_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
    ],
)
def test_the_refs_that_revert_stash_and_fetch_need_are_allowed_and_not_spooled(
    repo: dict[str, str], ref: str
) -> None:
    result = run_hook(repo, "prepared", [f"{ZERO} {repo['tip']} {ref}"])

    assert result.returncode == 0, result.stderr
    run_hook(repo, "committed", [f"{ZERO} {repo['tip']} {ref}"])
    assert spooled(repo) == []


# #761-T04
@pytest.mark.parametrize(
    ("label", "line"),
    [
        ("another branch", f"{ZERO} {{tip}} refs/heads/other"),
        ("a tag", f"{ZERO} {{tip}} refs/tags/v1"),
        ("the branch deleted", "{tip} " + ZERO + " refs/heads/work"),
        ("the branch below the start", "{tip} {start} refs/heads/work"),
        ("HEAD at another branch", "ref:refs/heads/work ref:refs/heads/main HEAD"),
        ("HEAD detached at a commit alone", f"{ZERO} {{start}} HEAD"),
    ],
)
def test_everything_else_is_denied_before_it_happens(
    repo: dict[str, str], label: str, line: str
) -> None:
    result = run_hook(repo, "prepared", [line.format(tip=repo["tip"], start=repo["start"])])

    assert result.returncode != 0, label
    assert "code-reviewer-guard" in result.stderr


# #761-T04
def test_a_new_branch_that_does_not_contain_the_start_commit_is_denied(
    repo: dict[str, str],
) -> None:
    git(Path(repo["path"]), "checkout", "-q", "--orphan", "alien")
    git(Path(repo["path"]), "commit", "-q", "--allow-empty", "-m", "unrelated")
    alien = git(Path(repo["path"]), "rev-parse", "HEAD")
    # The configured branch does not exist yet, so only the start commit decides.
    Path(repo["conf"]).write_text(
        f"BRANCH=fresh\nSTART={repo['start']}\nSPOOL={repo['spool']}\nREPO={repo['path']}\n",
        encoding="utf-8",
    )

    result = run_hook(repo, "prepared", [f"{ZERO} {alien} refs/heads/fresh"])

    assert result.returncode != 0
    assert "start commit" in result.stderr


# #761-T04
def test_head_may_follow_the_branch_in_the_same_transaction_only(
    repo: dict[str, str],
) -> None:
    new = git(Path(repo["path"]), "commit-tree", "-p", repo["tip"], "-m", "next", "HEAD^{tree}")
    together = [f"{repo['tip']} {new} refs/heads/work", f"{repo['tip']} {new} HEAD"]

    assert run_hook(repo, "prepared", together).returncode == 0
    assert run_hook(repo, "prepared", [f"{ZERO} {new} HEAD"]).returncode != 0
    assert (
        run_hook(repo, "prepared", ["ref:refs/heads/work ref:refs/heads/work HEAD"]).returncode == 0
    )


# #761-T03
@pytest.mark.parametrize("state", ["prepared", "committed", "aborted"])
def test_the_hook_fails_closed_without_its_configuration(repo: dict[str, str], state: str) -> None:
    missing = run_hook(
        repo, state, [f"{ZERO} {repo['tip']} refs/heads/work"], conf="/nonexistent/guard.conf"
    )

    assert missing.returncode != 0
    assert "configuration" in missing.stderr


# #761-T03
def test_the_hook_fails_closed_on_an_incomplete_configuration(
    repo: dict[str, str], tmp_path: Path
) -> None:
    partial = tmp_path / "partial.conf"
    partial.write_text("BRANCH=work\n", encoding="utf-8")

    result = run_hook(
        repo, "prepared", [f"{ZERO} {repo['tip']} refs/heads/work"], conf=str(partial)
    )

    assert result.returncode != 0
    assert "incomplete" in result.stderr


def other_repository(tmp_path: Path, name: str = "other") -> Path:
    path = tmp_path / name
    git(tmp_path, "init", "-q", "-b", "main", str(path))
    return path


DENIED_IN_THE_WORK_REPOSITORY = f"{ZERO} {{tip}} refs/tags/v1"


# #761-T04 (review of #777, finding 1): core.hooksPath reaches every repository of the job.
def test_another_repository_is_none_of_the_guards_business(
    repo: dict[str, str], tmp_path: Path
) -> None:
    other = other_repository(tmp_path)
    line = DENIED_IN_THE_WORK_REPOSITORY.format(tip=repo["tip"])

    assert run_hook(repo, "prepared", [line]).returncode != 0
    assert run_hook(repo, "prepared", [line], cwd=other).returncode == 0
    assert (
        run_hook(repo, "committed", [f"{ZERO} {repo['tip']} refs/heads/work"], cwd=other).returncode
        == 0
    )
    assert spooled(repo) == []


# #761-T04 (review of #777, finding 1): git passes GIT_DIR while it makes a repository,
# and at the time of init that repository is not valid yet.
def test_a_repository_that_git_is_creating_is_none_of_the_guards_business(
    repo: dict[str, str], tmp_path: Path
) -> None:
    clone = tmp_path / "clone"
    line = DENIED_IN_THE_WORK_REPOSITORY.format(tip=repo["tip"])
    git(tmp_path, "clone", "-q", repo["path"], str(clone))

    assert (
        run_hook(
            repo, "prepared", [line], cwd=tmp_path, environment={"GIT_DIR": str(clone / ".git")}
        ).returncode
        == 0
    )
    half_made = tmp_path / "half-made" / ".git"
    half_made.mkdir(parents=True)
    head_line = f"{ZERO} ref:refs/heads/main HEAD"
    assert (
        run_hook(
            repo, "prepared", [head_line], cwd=tmp_path, environment={"GIT_DIR": str(half_made)}
        ).returncode
        == 0
    )


# #761-T04: linked worktrees of the work repository share its refs and stay guarded; a repository
# nested in its work tree is another repository.
def test_a_worktree_of_the_work_repository_stays_guarded_and_a_nested_repository_does_not(
    repo: dict[str, str], tmp_path: Path
) -> None:
    linked = tmp_path / "linked"
    git(Path(repo["path"]), "worktree", "add", "-q", "-b", "side", str(linked))
    nested = other_repository(Path(repo["path"]), "nested")
    line = DENIED_IN_THE_WORK_REPOSITORY.format(tip=repo["tip"])

    assert run_hook(repo, "prepared", [line], cwd=linked).returncode != 0
    assert run_hook(repo, "prepared", [line], cwd=nested).returncode == 0


# #761-T04: a symlink to the work repository is the same repository.
def test_a_symlink_to_the_work_repository_is_the_same_repository(
    repo: dict[str, str], tmp_path: Path
) -> None:
    link = tmp_path / "link"
    link.symlink_to(repo["path"])
    Path(repo["conf"]).write_text(
        f"BRANCH=work\nSTART={repo['start']}\nSPOOL={repo['spool']}\nREPO={link}\n",
        encoding="utf-8",
    )

    result = run_hook(repo, "prepared", [DENIED_IN_THE_WORK_REPOSITORY.format(tip=repo["tip"])])

    assert result.returncode != 0


# #761-T03: a configuration without REPO (the first format) guards every repository, as before;
# one that names something that is no repository fails closed.
def test_without_a_named_repository_every_repository_is_guarded_and_a_wrong_one_fails_closed(
    repo: dict[str, str], tmp_path: Path
) -> None:
    other = other_repository(tmp_path)
    line = DENIED_IN_THE_WORK_REPOSITORY.format(tip=repo["tip"])
    old = tmp_path / "old.conf"
    old.write_text(f"BRANCH=work\nSTART={repo['start']}\nSPOOL={repo['spool']}\n", encoding="utf-8")
    wrong = tmp_path / "wrong.conf"
    wrong.write_text(
        f"BRANCH=work\nSTART={repo['start']}\nSPOOL={repo['spool']}\nREPO={tmp_path / 'nothing'}\n",
        encoding="utf-8",
    )

    assert run_hook(repo, "prepared", [line], conf=str(old), cwd=other).returncode != 0
    refused = run_hook(repo, "prepared", [line], conf=str(wrong), cwd=other)
    assert refused.returncode != 0 and "not one" in refused.stderr


def packed(repo: dict[str, str], ref: str, oid: str) -> None:
    (Path(repo["path"]) / ".git" / "packed-refs").write_text(
        f"# pack-refs with: peeled fully-peeled sorted \n{oid} {ref}\n", encoding="utf-8"
    )


# #761-T04 (review of #777, finding 2): gc, pack-refs and maintenance prune loose refs, which git
# reports as deletions although the refs stay.
def test_packing_and_pruning_refs_is_allowed_and_deleting_the_branch_is_not(
    repo: dict[str, str],
) -> None:
    prune = [f"{repo['tip']} {ZERO} refs/heads/work", f"{repo['tip']} {ZERO} refs/heads/main"]
    git(Path(repo["path"]), "branch", "main")
    packed(repo, "refs/heads/work", repo["tip"])

    # Not packed (yet) at this id: the same line from `pack-refs` is a deletion of the last copy.
    assert run_hook(repo, "prepared", prune, command="pack-refs").returncode != 0
    (Path(repo["path"]) / ".git" / "packed-refs").write_text(
        f"# pack-refs with: peeled fully-peeled sorted \n{repo['tip']} refs/heads/main\n"
        f"{repo['tip']} refs/heads/work\n",
        encoding="utf-8",
    )
    assert run_hook(repo, "prepared", prune, command="pack-refs").returncode == 0
    assert run_hook(repo, "committed", prune, command="pack-refs").returncode == 0
    assert spooled(repo) == []
    # A real deletion is the same line from another command, packed or not.
    for command in ("branch", "update-ref"):
        refused = run_hook(repo, "prepared", prune[:1], command=command)
        assert refused.returncode != 0 and "deleting work" in refused.stderr


# #761-T04 (review of #777, finding 2): packing writes each ref at the id it has (a creation).
def test_packing_writes_the_refs_at_the_id_they_have_and_nothing_else(repo: dict[str, str]) -> None:
    git(Path(repo["path"]), "branch", "main")
    same = [f"{ZERO} {repo['tip']} refs/heads/main", f"{ZERO} {repo['tip']} refs/heads/work"]
    elsewhere = [f"{ZERO} {repo['start']} refs/heads/main"]

    assert run_hook(repo, "prepared", same, command="pack-refs").returncode == 0
    assert run_hook(repo, "prepared", elsewhere, command="pack-refs").returncode != 0
    assert run_hook(repo, "prepared", same).returncode != 0


# #761-T04: `git fetch` follows the tags of what it fetches; a tag of the agent's own stays denied.
def test_a_fetch_may_create_a_tag_and_nothing_else_may_or_may_delete_one(
    repo: dict[str, str],
) -> None:
    create = [DENIED_IN_THE_WORK_REPOSITORY.format(tip=repo["tip"])]
    delete = [f"{repo['tip']} {ZERO} refs/tags/v1"]

    assert run_hook(repo, "prepared", create, command="fetch").returncode == 0
    assert run_hook(repo, "prepared", create, command="tag").returncode != 0
    assert run_hook(repo, "prepared", delete, command="fetch").returncode != 0


# #761-T03
def test_the_default_place_of_the_configuration_is_under_run() -> None:
    assert "/run/code-reviewer/guard.conf" in HOOK.read_text(encoding="utf-8")


def host_git_version() -> tuple[int, ...]:
    out = subprocess.run(["git", "--version"], capture_output=True, text=True, check=True).stdout
    match = re.search(r"(\d+)\.(\d+)\.(\d+)", out)
    assert match
    return tuple(int(part) for part in match.groups())


def run_matrix(*args: str, path: str | None = None) -> subprocess.CompletedProcess[str]:
    env = {
        "PATH": path or os.environ["PATH"],
        "GUARD_DIR": str(HOOK.parent),
        "TMPDIR": os.environ.get("TMPDIR", "/tmp"),
    }
    return subprocess.run(
        ["bash", str(MATRIX), *args],
        capture_output=True,
        text=True,
        env=env,
        check=False,
        timeout=600,
    )


def test_the_matrix_script_has_the_license_header_and_is_executable() -> None:
    assert os.access(MATRIX, os.X_OK)
    assert (
        "SPDX-License-Identifier: LicenseRef-Proprietary"
        in MATRIX.read_text(encoding="utf-8")[:200]
    )


# #761-T04
def test_the_matrix_lists_about_forty_actions_in_two_groups() -> None:
    listing = run_matrix("--list")

    assert listing.returncode == 0, listing.stderr
    rows = [line.split(None, 1) for line in listing.stdout.splitlines() if line.strip()]
    kinds = [kind for kind, _ in rows]
    assert 38 <= len(rows) <= 46
    assert {"allow", "block"} == set(kinds)
    assert kinds.count("allow") >= 16 and kinds.count("block") >= 22
    # The cases the spike found: a branch switch is what an old git cannot see.
    names = " ".join(name for _, name in rows)
    for expected in (
        "commit --amend",
        "reset --hard",
        "checkout main",
        "switch main",
        "rebase",
        "worktree add",
        "gc",
        "pack-refs",
        "maintenance",
        "clone of a repository with a tag",
        "a nested repository",
        "init, fetch and checkout FETCH_HEAD",
    ):
        assert expected in names


# #761-T01 / #761-T04: git older than 2.53 does not see a branch switch; the matrix must not pass.
def test_the_matrix_fails_loudly_on_a_git_older_than_2_53(tmp_path: Path) -> None:
    fake = tmp_path / "bin"
    fake.mkdir()
    (fake / "git").write_text('#!/bin/sh\necho "git version 2.43.0"\n', encoding="utf-8")
    (fake / "git").chmod(0o755)

    result = run_matrix(path=f"{fake}:{os.environ['PATH']}")

    assert result.returncode == 2
    assert "2.53" in result.stderr
    assert "passed" not in result.stdout


# #761-T04: with a git that has the version, every action behaves; with an older one the run is red.
def test_the_matrix_passes_on_a_git_that_is_new_enough_and_fails_on_an_older_one() -> None:
    assert shutil.which("git")
    result = run_matrix()

    if host_git_version() >= (2, 53, 0):
        assert result.returncode == 0, result.stdout + result.stderr
        assert re.search(r"guard matrix: \d+ passed, 0 failed", result.stdout)
    else:
        assert result.returncode == 2
        assert "2.53" in result.stderr
