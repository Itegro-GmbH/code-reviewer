# SPDX-License-Identifier: LicenseRef-Proprietary

"""The `implementer` block of a result: its bounds, its check and its fit into the body (#765).

Three bounds hold at once:

* the contract's (`IMPLEMENTER_RESULT_LIMITS` of the app: 200 commits, 500 files, 8192 characters of
  summary, a subject of 500 and a path of 4096 characters);
* the platform's: Vercel refuses a request body over 4.5 MB before the app sees it, and the app's
  own cap for this kind is far above that. The runner writes JSON with every non-ASCII character
  escaped, which makes a code point outside the Basic Multilingual Plane 12 bytes, so the limits
  above alone allow a body of about 26 MB. The escaped body is therefore held under
  `BODY_BUDGET_BYTES` (4 MB), measured on the text that is sent: **files are given up first, then
  commits** (the head commit, which the app requires to be the last one, always stays);
* the shape the app reads: closed objects, every field present, `pushed` never without a head
  commit, the head commit is the last commit when commits are listed. A block that is not that is
  refused (`valid_block`), so the app is never sent a result it would answer with 400.

Nothing here reads a repository; the facts were measured elsewhere.
"""

import json
import re
from collections.abc import Mapping, Sequence
from typing import Any, cast

from code_reviewer_runner.job_loop.jsonvalues import as_object

from .history import MAX_COMMITS, MAX_FILES, MAX_PATH_CHARS, MAX_SUBJECT_CHARS, ChangeKind

MAX_SUMMARY_CHARS = 8192
MAX_SESSION_ID_CHARS = 200
MAX_VERSION_CHARS = 64
# Under 4 MB, whichever way a megabyte is counted, and below the 4.5 MB of the platform with room
# for the wrapper a client puts around the result.
BODY_BUDGET_BYTES = 4_000_000

_SHA = re.compile(r"[0-9a-f]{40}")
_BLOCK_KEYS = frozenset(
    {"baseCommit", "headCommit", "pushed", "commits", "filesChanged", "summary", "opencode"}
)
_STATUSES = frozenset(kind.value for kind in ChangeKind)


def escaped_size(value: object) -> int:
    """The bytes `value` takes as the JSON the runner sends (non-ASCII escaped, default
    separators: a little more than the compact form, so the answer is on the safe side)."""
    return len(json.dumps(value))


def _is_string(value: object, limit: int, *, minimum: int = 0) -> bool:
    return isinstance(value, str) and minimum <= len(value) <= limit


def _commit_ok(value: object) -> bool:
    commit = as_object(value)
    if commit is None or set(commit) != {"sha", "subject"}:
        return False
    sha = commit["sha"]
    return (
        isinstance(sha, str)
        and _SHA.fullmatch(sha) is not None
        and _is_string(commit["subject"], MAX_SUBJECT_CHARS)
    )


def _file_ok(value: object) -> bool:
    file = as_object(value)
    if file is None or set(file) != {"path", "status"}:
        return False
    status = file["status"]
    return (
        _is_string(file["path"], MAX_PATH_CHARS, minimum=1)
        and isinstance(status, str)
        and status in _STATUSES
    )


def _opencode_ok(value: object) -> bool:
    if value is None:
        return True
    session = as_object(value)
    if session is None or set(session) != {"sessionId", "version"}:
        return False
    return _is_string(session["sessionId"], MAX_SESSION_ID_CHARS, minimum=1) and _is_string(
        session["version"], MAX_VERSION_CHARS, minimum=1
    )


def _sha_or_none(value: object, *, allow_none: bool) -> bool:
    if value is None:
        return allow_none
    return isinstance(value, str) and _SHA.fullmatch(value) is not None


def valid_block(value: object) -> dict[str, Any] | None:
    """The block when it is what the app reads (the bounds of the contract, its invariants), else
    None. A copy: the caller's object is not kept."""
    block = as_object(value)
    if block is None or set(block) != set(_BLOCK_KEYS):
        return None
    base, head, pushed = block["baseCommit"], block["headCommit"], block["pushed"]
    commits, files = block["commits"], block["filesChanged"]
    if not _sha_or_none(base, allow_none=False) or not _sha_or_none(head, allow_none=True):
        return None
    if not isinstance(pushed, bool) or (pushed and head is None):
        return None
    if not isinstance(commits, list) or not isinstance(files, list):
        return None
    commit_list, file_list = cast("list[object]", commits), cast("list[object]", files)
    if len(commit_list) > MAX_COMMITS or len(file_list) > MAX_FILES:
        return None
    if not all(_commit_ok(commit) for commit in commit_list):
        return None
    if not all(_file_ok(file) for file in file_list):
        return None
    if commit_list and cast("dict[str, str]", commit_list[-1])["sha"] != head:
        return None
    if not _is_string(block["summary"], MAX_SUMMARY_CHARS) or not _opencode_ok(block["opencode"]):
        return None
    return dict(block)


def _kept_commits(commits: Sequence[Mapping[str, str]], room: int) -> list[Mapping[str, str]]:
    """As many commits as fit in `room` bytes: the head (always last) and the oldest ones, the
    order `history.parse_commits` also keeps when there are too many."""
    if not commits:
        return []
    head = commits[-1]
    used = escaped_size(head) + 2
    kept: list[Mapping[str, str]] = []
    for commit in commits[:-1]:
        size = escaped_size(commit) + 2
        if used + size > room:
            break
        used += size
        kept.append(commit)
    return [*kept, head]


def fit_block(
    block: Mapping[str, Any], other_bytes: int, budget: int = BODY_BUDGET_BYTES
) -> dict[str, Any]:
    """The block cut so that the body (`other_bytes` of result around it, plus the block) is at
    most `budget` bytes: the counts of the contract first, then the files, then the commits.

    `other_bytes` is `escaped_size` of the result without its block."""
    fitted: dict[str, Any] = dict(block)
    commits: list[Mapping[str, str]] = list(fitted["commits"])[-MAX_COMMITS:]
    files: list[Mapping[str, str]] = list(fitted["filesChanged"])[:MAX_FILES]
    fixed = other_bytes + escaped_size({**fitted, "commits": [], "filesChanged": []})
    room = budget - fixed
    commit_bytes = sum(escaped_size(commit) + 2 for commit in commits)
    file_room = room - commit_bytes
    if file_room < 0:
        # The commits alone are too much: no file is listed, and the commits are cut as well.
        files = []
        commits = _kept_commits(commits, room)
    else:
        kept: list[Mapping[str, str]] = []
        used = 0
        for file in files:
            size = escaped_size(file) + 2
            if used + size > file_room:
                break
            used += size
            kept.append(file)
        files = kept
    fitted["commits"] = commits
    fitted["filesChanged"] = files
    return fitted
