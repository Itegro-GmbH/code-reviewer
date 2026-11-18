# SPDX-License-Identifier: LicenseRef-Proprietary

"""The rules of a multi-repository job that JSON Schema cannot state (#1091, ADR 0006).

A small reference implementation for the shared negative corpus
(contracts/examples/implementer-multi-repo/invalid/). The real checks are the app's lane validation
and claim (#1092) and the runner's parser (#1093); they must reject every case of the corpus with
the same rule. The TypeScript twin is app/src/test-support/multi-repo-rules.ts: change both
together.
"""

import copy
from typing import Any, cast
from urllib.parse import urlsplit

Document = dict[str, Any]

# The names the work volume uses itself (and `.git`, which would make `/work` a repository).
RESERVED_MOUNT_NAMES = {"result", "reserve", ".git"}


def derive_mount_names(full_names: list[str]) -> list[str]:
    """The mount name of every repository of a job, from the `fullName`s alone."""
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


def _has_duplicates(values: list[str]) -> bool:
    return len(set(values)) != len(values)


def _web_host(base_url: str) -> str:
    netloc = urlsplit(base_url).netloc
    return "github.com" if netloc == "api.github.com" else netloc


def break_of_job_rule(job: Document) -> str | None:
    """The rule of the job a document breaks, or None.

    The order is fixed, so every implementation names the same rule.
    """
    implementer: Document = job.get("implementer", {})
    repos: list[Document] | None = implementer.get("repos")
    if repos is None:
        return None
    git: Document = job.get("git", {})
    tokens: list[Document] = git.get("tokens", [])

    if _has_duplicates([str(token["id"]) for token in tokens]):
        return "token_id_repeated"
    ids = {str(token["id"]) for token in tokens}
    if any(str(repo["tokenId"]) not in ids for repo in repos):
        return "token_unresolved"
    used = {str(repo["tokenId"]) for repo in repos}
    if any(str(token["id"]) not in used for token in tokens):
        return "token_unused"
    first = next((token for token in tokens if token["id"] == repos[0]["tokenId"]), None)
    if first is None or first["token"] != git.get("token"):
        return "git_token_mismatch"

    if _has_duplicates([str(repo["fullName"]).lower() for repo in repos]):
        return "full_name_repeated"
    if _has_duplicates([str(repo["name"]).lower() for repo in repos]):
        return "mount_name_repeated"
    derived = derive_mount_names([str(repo["fullName"]) for repo in repos])
    if any(repo["name"] != derived[index] for index, repo in enumerate(repos)):
        return "mount_name_not_derived"

    host = _web_host(str(git.get("baseUrl")))
    for repo in repos:
        url = urlsplit(str(repo["cloneUrl"]))
        if url.netloc != host:
            return "clone_url_host"
        if url.path not in (f"/{repo['fullName']}", f"/{repo['fullName']}.git"):
            return "clone_url_path"

    resume: list[Document] | None = implementer.get("resume", {}).get("repos")
    if resume is not None:
        names = [entry["name"] for entry in resume]
        if names != [repo["name"] for repo in repos]:
            return "resume_names"
    return None


def break_of_lane_rule(step: Document) -> str | None:
    """The code a lane step with `repos` breaks that the schema cannot state (from its literals)."""
    repos: list[Document] = step.get("repos", [])
    literals = [str(entry["repo"]) for entry in repos if "{{" not in str(entry["repo"])]
    if _has_duplicates([repo.lower() for repo in literals]):
        return "repo_duplicate"
    if len(literals) == len(repos) and _has_duplicates(
        [name.lower() for name in derive_mount_names(literals)]
    ):
        return "repo_name_clash"
    return None


def _pointer(path: str) -> list[str]:
    return [part.replace("~1", "/").replace("~0", "~") for part in path.split("/")[1:]]


def _patch_list(items: list[Any], operation: str, last: str, value: Any) -> None:
    index = len(items) if last == "-" else int(last)
    if operation == "add":
        items.insert(index, value)
    elif operation == "replace":
        items[index] = value
    elif operation == "remove":
        del items[index]
    else:
        raise ValueError(f"unknown patch operation {operation}")


def _walk(root: Any, keys: list[str]) -> Any:
    node: Any = root
    for key in keys:
        if isinstance(node, list):
            node = cast(list[Any], node)[int(key)]
        else:
            node = cast(Document, node)[key]
    return node


def apply_patch(document: Document, patch: list[Document]) -> Document:
    """A minimal RFC 6902 patch (add, replace, remove; `-` appends) of a copy of `document`."""
    result = copy.deepcopy(document)
    for step in patch:
        keys = _pointer(step["path"])
        last = keys.pop()
        parent = _walk(result, keys)
        if isinstance(parent, list):
            _patch_list(cast(list[Any], parent), step["op"], last, step.get("value"))
            continue
        operation = step["op"]
        if operation == "remove":
            del parent[last]
        elif operation in ("add", "replace"):
            parent[last] = step["value"]
        else:
            raise ValueError(f"unknown patch operation {operation}")
    return result
