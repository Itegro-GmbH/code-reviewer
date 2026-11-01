# SPDX-License-Identifier: LicenseRef-Proprietary

"""What the Implementer's result says about the branch (#764): the commits since the start commit
and the files that differ, read as the agent's user from its repository, bounded and sanitised."""

from code_reviewer_runner.implementer.git_workspace import GitWorkspace
from code_reviewer_runner.implementer.history import ChangeKind, CommitInfo, FileChange
from git_support import raw
from workspace_support import Rig, agent_git


def commit_file(workspace: GitWorkspace, name: str, content: str, message: str) -> str:
    path = workspace.repo / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    assert agent_git(workspace, "add", "-A").returncode == 0
    done = agent_git(workspace, "commit", "-qm", message)
    assert done.returncode == 0, done.stderr
    return raw("rev-parse", "HEAD", cwd=workspace.repo, git=workspace.git)


# #764-T03
def test_the_commits_since_the_start_are_listed_oldest_first_with_their_subjects(rig: Rig) -> None:
    workspace = rig.prepared()
    first = commit_file(workspace, "a.txt", "1\n", "Add a\n\nlong body that is not a subject")
    second = commit_file(workspace, "b.txt", "2\n", "Add b")

    assert workspace.commits_since_start() == [
        CommitInfo(first, "Add a"),
        CommitInfo(second, "Add b"),
    ]


# #764-T08
def test_a_branch_without_commits_lists_none(rig: Rig) -> None:
    workspace = rig.prepared()

    assert workspace.commits_since_start() == []
    assert workspace.changed_files() == []


def commit_all(workspace: GitWorkspace, message: str = "change") -> None:
    assert agent_git(workspace, "add", "-A").returncode == 0
    done = agent_git(workspace, "commit", "-qm", message)
    assert done.returncode == 0, done.stderr


# #764-T03
def test_an_added_and_a_modified_file_have_their_statuses(rig: Rig) -> None:
    workspace = rig.prepared()
    (workspace.repo / "src" / "app.py").write_text("print('changed')\n")
    (workspace.repo / "new.txt").write_text("fresh\n")
    commit_all(workspace)

    assert sorted(workspace.changed_files(), key=lambda change: change.path) == [
        FileChange("new.txt", ChangeKind.ADDED),
        FileChange("src/app.py", ChangeKind.MODIFIED),
    ]


# #764-T03
def test_a_deleted_file_is_deleted(rig: Rig) -> None:
    workspace = rig.prepared()
    (workspace.repo / "README.md").unlink()
    commit_all(workspace)

    assert workspace.changed_files() == [FileChange("README.md", ChangeKind.DELETED)]


# #764-T03
def test_a_renamed_file_is_listed_under_its_new_path(rig: Rig) -> None:
    workspace = rig.prepared()
    (workspace.repo / "docs").mkdir()
    (workspace.repo / "README.md").rename(workspace.repo / "docs" / "README.md")
    commit_all(workspace)

    assert workspace.changed_files() == [FileChange("docs/README.md", ChangeKind.RENAMED)]


# #764-T03
def test_a_file_that_became_a_link_is_a_change_of_type(rig: Rig) -> None:
    workspace = rig.prepared()
    (workspace.repo / "README.md").unlink()
    (workspace.repo / "README.md").symlink_to("src/app.py")
    commit_all(workspace)

    assert workspace.changed_files() == [FileChange("README.md", ChangeKind.TYPECHANGE)]


# #764-T03
def test_a_path_with_odd_characters_is_returned_as_it_is(rig: Rig) -> None:
    workspace = rig.prepared()
    commit_file(workspace, "dir with space/ünï cödé\ttab.txt", "x\n", "odd")

    assert workspace.changed_files() == [
        FileChange("dir with space/ünï cödé\ttab.txt", ChangeKind.ADDED)
    ]


# #764-T03
def test_a_huge_subject_and_a_flood_of_files_are_bounded(rig: Rig) -> None:
    workspace = rig.prepared()
    done = agent_git(workspace, "commit", "-q", "--allow-empty", "-m", "S" * 100_000)
    assert done.returncode == 0, done.stderr
    for number in range(30):
        (workspace.repo / f"f{number}.txt").write_text("x\n")
    commit_all(workspace, "files\u0007with\u001b[31mcontrol")

    commits = workspace.commits_since_start()
    files = workspace.changed_files()

    assert len(commits[0].subject) == 500 and set(commits[0].subject) == {"S"}
    assert "\u0007" not in commits[1].subject and "\u001b" not in commits[1].subject
    assert len(files) == 30
