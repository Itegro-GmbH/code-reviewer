# SPDX-License-Identifier: LicenseRef-Proprietary

"""The mount names of a multi-repository turn (#1093, epic #1090, ADR 0006).

The app derives the name of every repository of a job and carries it in
`implementer.repos[].name`; the runner **re-derives it from the `fullName`s** and refuses a name
that differs, so both sides share one definition (`ImplementerMountName` of
`contracts/runner-api.v1.json`). The rule: the name part of `owner/name`, or `<owner>__<name>` for
**every** repository whose name part another repository of the job has too (compared without
regard to case, so the result does not depend on the order of the list) and for every repository
whose name part is reserved: `result` and `reserve`, which the work volume uses itself, and
`.git`, which would make `/work` look like a repository (any case).

Pure functions on strings: nothing here reads a disk or a job.
"""

import re
from collections.abc import Sequence
from typing import Final

# The names the work volume uses itself and `.git`: never a mount name as they are (any case).
RESERVED_MOUNT_NAMES: Final = frozenset({"result", "reserve", ".git"})
# The schema's pattern (`ImplementerMountName`): no leading `-`, so a name is never read as an
# option by `git`, `docker` or `mkdir`; a leading `.` stays, for `.github`.
_MOUNT_NAME: Final = re.compile(r"[A-Za-z0-9._][A-Za-z0-9._-]{0,201}")
MAX_REPOS: Final = 10


def is_mount_name(name: str) -> bool:
    """Whether `name` is a name the contract allows as a mount (`ImplementerMountName`)."""
    return (
        _MOUNT_NAME.fullmatch(name) is not None
        and name not in (".", "..")
        and name.lower() not in RESERVED_MOUNT_NAMES
    )


def derive_mount_names(full_names: Sequence[str]) -> list[str]:
    """The mount name of every repository of a job from its `fullName`s alone."""
    parts = [tuple(full_name.split("/", 1)) for full_name in full_names]
    counts: dict[str, int] = {}
    for _, name in parts:
        counts[name.lower()] = counts.get(name.lower(), 0) + 1
    return [
        f"{owner}__{name}"
        if counts[name.lower()] > 1 or name.lower() in RESERVED_MOUNT_NAMES
        else name
        for owner, name in parts
    ]
