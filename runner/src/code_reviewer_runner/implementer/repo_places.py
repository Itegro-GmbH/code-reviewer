# SPDX-License-Identifier: LicenseRef-Proprietary

"""Where the repositories of a turn are, for each of the places that sees them (#1093, epic #1090).

A turn of one repository, as it always was: the agent's repository is the directory `repo` of the
work volume, it is `/work/repo` in the agent's container and in Control, `/repo` in the readers, and
the agent works in it. A multi-repository turn (ADR 0006) has one directory per repository, named by
its mount name (`ImplementerMountName`): the agent's container mounts **each** as its own Subpath
at `/work/<name>`, the readers at `/repos/<name>`, and **the agent's working directory is `/work`**,
which is not a repository. Nothing here reads a disk.

If a harness did not work well from a directory that is not a repository, the documented fallback is
the first repository's mount as the working directory (`workdir_of_first`): it is one flag of this
module and nothing else changes. #1093 measured OpenCode and found no reason for it
(`docs/implementer.md`).
"""

from dataclasses import dataclass
from typing import Final

WORK_VOLUME_TARGET: Final = "/work"
# The names of the single-repository layout.
SINGLE_NAME: Final = "repo"
READER_SINGLE_REPO: Final = "/repo"
READER_MULTI_ROOT: Final = "/repos"


@dataclass(frozen=True)
class RepoPlaces:
    """The mount names of a turn: `("repo",)` for a turn of one repository, the mount name of every
    repository for a multi-repository turn."""

    names: tuple[str, ...] = (SINGLE_NAME,)
    multi: bool = False
    # The documented fallback of ADR 0006: the first repository's mount is the working directory.
    workdir_of_first: bool = False

    def agent_path(self, name: str) -> str:
        """Where the agent's container (and the setup's) has the repository."""
        return f"{WORK_VOLUME_TARGET}/{name}"

    def reader_path(self, name: str) -> str:
        """Where a reader has the repository."""
        return f"{READER_MULTI_ROOT}/{name}" if self.multi else READER_SINGLE_REPO

    @property
    def agent_paths(self) -> tuple[str, ...]:
        return tuple(self.agent_path(name) for name in self.names)

    @property
    def agent_workdir(self) -> str:
        """The agent's working directory: the repository for a turn of one, `/work` for several."""
        if not self.multi or self.workdir_of_first:
            return self.agent_path(self.names[0])
        return WORK_VOLUME_TARGET


SINGLE: Final = RepoPlaces()


def places_of(names: tuple[str, ...] | None) -> RepoPlaces:
    """The places of a job: `None` (no `repos`) is the single layout."""
    return SINGLE if names is None else RepoPlaces(names=names, multi=True)
