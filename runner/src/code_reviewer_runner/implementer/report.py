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
# What the app takes out of the texts of the block before it judges them
# (`withoutControlCharacters` in `runner-api/requests.ts`): C0 controls except tab, line feed and
# carriage return, and DEL. A path is judged by what is left, so a file named `\x01` is no file
# for the app.
_APP_CONTROLS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_BLOCK_KEYS = frozenset(
    {
        "baseCommit",
        "headCommit",
        "pushed",
        "branches",
        "branchesDropped",
        "commits",
        "filesChanged",
        "summary",
        "opencode",
        "setup",
        "network",
    }
)
MAX_BRANCHES = 50
MAX_BRANCH_NAME_CHARS = 255
MAX_REASON_CHARS = 40
_REASON = re.compile(r"[a-z][a-z_]*")
# Not required: a block without the count (an older shape) is still one the app reads.
_OPTIONAL_KEYS = frozenset({"branchesDropped", "setup", "network"})
MAX_SETUP_OUTPUT_CHARS = 8192
_SETUP_KEYS = frozenset({"ok", "exitCode", "timedOut", "durationSeconds", "output"})
MAX_DROPPED = 1_000_000_000
# #745, step 7: `ImplementerNetworkReport`. The numbers are counts and bytes of one turn.
_NETWORK_KEYS = frozenset(
    {
        "mode",
        "door",
        "vmPolicy",
        "allowed",
        "refused",
        "bytesIn",
        "bytesOut",
        "dropped",
        "connections",
    }
)
_CONNECTION_KEYS = frozenset({"host", "port", "outcome", "reason", "count", "bytesIn", "bytesOut"})
MAX_NETWORK_CONNECTIONS = 100
MAX_NETWORK_HOST_CHARS = 253
MAX_COUNT = 10**15
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
        _is_string(file["path"], MAX_PATH_CHARS)
        and isinstance(file["path"], str)
        and len(_APP_CONTROLS.sub("", file["path"])) >= 1
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


def _dropped_ok(value: object) -> bool:
    dropped = as_object(value)
    if dropped is None or set(dropped) != {"invalid", "overflow"}:
        return False
    return all(
        isinstance(count, int) and not isinstance(count, bool) and 0 <= count <= MAX_DROPPED
        for count in dropped.values()
    )


def _setup_ok(value: object) -> bool:
    """The `setup` block (#818, `ImplementerSetupResult`): closed, every field present."""
    setup = as_object(value)
    if setup is None or frozenset(setup) != _SETUP_KEYS:
        return False
    code, duration = setup["exitCode"], setup["durationSeconds"]
    return (
        isinstance(setup["ok"], bool)
        and isinstance(setup["timedOut"], bool)
        and (
            code is None
            or (isinstance(code, int) and not isinstance(code, bool) and -255 <= code <= 255)
        )
        and isinstance(duration, int)
        and not isinstance(duration, bool)
        and 0 <= duration <= 86_400
        and _is_string(setup["output"], MAX_SETUP_OUTPUT_CHARS)
    )


def _count_ok(value: object, *, minimum: int = 0, maximum: int = MAX_COUNT) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and minimum <= value <= maximum


def _connection_ok(value: object) -> bool:
    connection = as_object(value)
    if connection is None or frozenset(connection) != _CONNECTION_KEYS:
        return False
    reason = connection["reason"]
    return (
        _is_string(connection["host"], MAX_NETWORK_HOST_CHARS)
        and _count_ok(connection["port"], maximum=65535)
        and connection["outcome"] in ("allowed", "refused")
        and (
            reason is None
            or (
                isinstance(reason, str)
                and _REASON.fullmatch(reason) is not None
                and len(reason) <= MAX_REASON_CHARS
            )
        )
        and _count_ok(connection["count"], minimum=1)
        and _count_ok(connection["bytesIn"])
        and _count_ok(connection["bytesOut"])
    )


def _network_ok(value: object) -> bool:
    """The `network` block (#745, step 7, `ImplementerNetworkReport`): closed, all fields in."""
    network = as_object(value)
    if network is None or frozenset(network) != _NETWORK_KEYS:
        return False
    connections = network["connections"]
    return (
        network["mode"] in ("off", "list", "open")
        and isinstance(network["door"], bool)
        and network["vmPolicy"] in ("narrowed", "unchanged", "not_configured")
        and all(
            _count_ok(network[name])
            for name in ("allowed", "refused", "bytesIn", "bytesOut", "dropped")
        )
        and isinstance(connections, list)
        and len(cast("list[object]", connections)) <= MAX_NETWORK_CONNECTIONS
        and all(_connection_ok(entry) for entry in cast("list[object]", connections))
    )


def _branch_ok(value: object) -> bool:
    branch = as_object(value)
    if branch is None or set(branch) != {"name", "head", "result", "reason"}:
        return False
    head, result, reason = branch["head"], branch["result"], branch["reason"]
    if not _is_string(branch["name"], MAX_BRANCH_NAME_CHARS, minimum=1):
        return False
    if not _sha_or_none(head, allow_none=True):
        return False
    if result == "pushed":
        return head is not None and reason is None
    return (
        result == "rejected"
        and isinstance(reason, str)
        and len(reason) <= MAX_REASON_CHARS
        and _REASON.fullmatch(reason) is not None
    )


def _sha_or_none(value: object, *, allow_none: bool) -> bool:
    if value is None:
        return allow_none
    return isinstance(value, str) and _SHA.fullmatch(value) is not None


def valid_block(value: object) -> dict[str, Any] | None:
    """The block when it is what the app reads (the bounds of the contract, its invariants), else
    None. A copy: the caller's object is not kept."""
    block = as_object(value)
    if block is None or not _BLOCK_KEYS - _OPTIONAL_KEYS <= set(block) <= _BLOCK_KEYS:
        return None
    if "branchesDropped" in block and not _dropped_ok(block["branchesDropped"]):
        return None
    if "setup" in block and not _setup_ok(block["setup"]):
        return None
    if "network" in block and not _network_ok(block["network"]):
        return None
    base, head, pushed = block["baseCommit"], block["headCommit"], block["pushed"]
    commits, files, branches = block["commits"], block["filesChanged"], block["branches"]
    if not _sha_or_none(base, allow_none=False) or not _sha_or_none(head, allow_none=True):
        return None
    if not isinstance(pushed, bool) or (pushed and head is None):
        return None
    if not isinstance(commits, list) or not isinstance(files, list):
        return None
    if not isinstance(branches, list):
        return None
    branch_list = cast("list[object]", branches)
    if len(branch_list) > MAX_BRANCHES or not all(_branch_ok(branch) for branch in branch_list):
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


def clip_texts(block: Mapping[str, Any]) -> dict[str, Any]:
    """The block with every text cut to the contract's bound and the files the app would refuse
    left out (a path that is nothing once its control characters are taken out). Redaction can make
    a text longer, and a hostile agent can name a file anything: neither may cost the summary and
    the rest of the list. A block that is not shaped like one is returned as it is (`valid_block`
    refuses it)."""
    try:
        clipped: dict[str, Any] = dict(block)
        clipped["summary"] = clipped["summary"][:MAX_SUMMARY_CHARS]
        if isinstance(clipped.get("setup"), dict):
            clipped["setup"] = {
                **clipped["setup"],
                "output": str(clipped["setup"].get("output", ""))[:MAX_SETUP_OUTPUT_CHARS],
            }
        clipped["branches"] = [
            {**branch, "name": branch["name"][:MAX_BRANCH_NAME_CHARS]}
            for branch in clipped["branches"]
        ]
        clipped["commits"] = [
            {**commit, "subject": commit["subject"][:MAX_SUBJECT_CHARS]}
            for commit in clipped["commits"]
        ]
        clipped["filesChanged"] = [
            {**file, "path": file["path"][:MAX_PATH_CHARS]}
            for file in clipped["filesChanged"]
            if len(_APP_CONTROLS.sub("", file["path"][:MAX_PATH_CHARS])) >= 1
        ]
    except (KeyError, TypeError):
        return dict(block)
    return clipped


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
