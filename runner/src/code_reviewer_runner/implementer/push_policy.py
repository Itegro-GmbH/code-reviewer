# SPDX-License-Identifier: LicenseRef-Proprietary

"""Which local branches of the agent's repository the final push takes.

The owner's decision: inside its workspace the agent may do anything with git, it has no remote and
no credential, and when the turn ends the runner pushes **all local branches** of its repository.
There is no check of who committed, what descends from what, or which branch. A rule such as "only
the branch the form named" would go into `select_branches` and nowhere else; the names it refuses
are listed in `PUSH_EXCLUDED_BRANCHES`.

The names come from a repository the agent controls, so each one is checked (`branch_name_problem`)
before it is used in a refspec: a name that git itself would refuse, or that holds anything that
could be read as an option, a `+` (force), a `:` or a line break, is dropped and only counted. It is
never shown and never given to git.
"""

from dataclasses import dataclass, field

# Branch names the final push never takes (exact names). Empty for now: the owner decides what, if
# anything, belongs here. A name in this set is reported as rejected with `REASON_EXCLUDED`.
PUSH_EXCLUDED_BRANCHES: frozenset[str] = frozenset()

# The most branches one turn reports (pushed, rejected or excluded). More than that is not work, it
# is noise; the report and the time of the end of the turn are bounded by it. What is beyond is
# counted (`Selection.overflow`), and the person is told the count.
MAX_PUSHED_BRANCHES = 50
# Git's own limit for a ref name is the file system's (255 bytes for a component); the form allows
# 200 characters.
MAX_NAME_BYTES = 255

REASON_EXCLUDED = "excluded"

_FORBIDDEN = frozenset(" ~^:?*[\\")


def branch_name_problem(name: str) -> str | None:
    """Why `name` may not be pushed as `refs/heads/<name>`, or None when it may. Stricter than
    `git check-ref-format` (a name this accepts git accepts as well): printable characters only,
    none of git's forbidden ones, no leading `-` or `+`."""
    if not name or name.startswith(("-", "+")):
        return "a name cannot start with a dash or a plus, or be empty"
    try:
        encoded = name.encode("utf-8")
    except UnicodeEncodeError:
        return "a name must be valid UTF-8"
    if len(encoded) > MAX_NAME_BYTES:
        return "a name is too long"
    if not name.isprintable() or any(char in _FORBIDDEN for char in name):
        return "a name has a character git does not allow in a ref name"
    if name in ("@", "HEAD") or name.startswith("/") or name.endswith(("/", ".")):
        return "a name has a form git does not allow"
    if ".." in name or "//" in name or "@{" in name:
        return "a name has a sequence git does not allow"
    for part in name.split("/"):
        if part.startswith(".") or part.endswith(".lock"):
            return "a part of a name has a form git does not allow"
    return None


@dataclass(frozen=True)
class Selection:
    """What `select_branches` decided. `names` are pushed in this order (the form's branch first);
    `excluded` are valid names the rule keeps back, with the reason; `invalid` counts the names that
    are not branch names (never shown); `overflow` counts the valid names beyond the limit."""

    names: list[str] = field(default_factory=lambda: [])
    excluded: list[tuple[str, str]] = field(default_factory=lambda: [])
    invalid: int = 0
    overflow: int = 0


def select_branches(local_branches: list[str], *, form_branch: str) -> Selection:
    """The branches the final push takes, out of the local branches of the agent's repository.
    **The one place for a rule about which branches are pushed.** Today only the name checks and
    `PUSH_EXCLUDED_BRANCHES` decide."""
    unique = sorted(set(local_branches))
    # The task's branch first, then alphabetical: what the limit drops is the end of this order.
    ordered = sorted(unique, key=lambda name: (name != form_branch, name))
    names: list[str] = []
    excluded: list[tuple[str, str]] = []
    invalid = 0
    overflow = 0
    for name in ordered:
        if branch_name_problem(name) is not None:
            invalid += 1
        elif len(names) + len(excluded) >= MAX_PUSHED_BRANCHES:
            # Excluded names are entries of the report too, so they count toward its limit.
            overflow += 1
        elif name in PUSH_EXCLUDED_BRANCHES:
            excluded.append((name, REASON_EXCLUDED))
        else:
            names.append(name)
    return Selection(names, excluded, invalid, overflow)
