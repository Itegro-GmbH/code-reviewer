# SPDX-License-Identifier: LicenseRef-Proprietary

"""The snapshot call of the Worker API from the runner's side (#839).

The app checks the same schema against its own reading of a request
(`snapshot-contract.test.ts`); here the other half: the examples are valid, the query the runner
builds for every part of a file, up to the largest, is a valid `SessionPartQuery` of the size the
app expects, and the bounds the runner keeps (the cap, the part size, the version and digest
shapes, the feature name) are the schema's.
"""

import hashlib
import json
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl

import pytest
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from code_reviewer_runner.job_loop.snapshot_sender import SnapshotPart
from code_reviewer_runner.job_loop.worker_api import snapshot_query
from code_reviewer_runner.snapshot_wire import (
    CHUNK_BYTES,
    FEATURE_IMPLEMENTER_SNAPSHOT,
    MAX_SNAPSHOT_BYTES,
    SnapshotHeader,
    header_line,
    parse_header,
    parts_of,
)

pytestmark = pytest.mark.contract

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"


def _load(name: str) -> dict[str, Any]:
    return json.loads((CONTRACTS / name).read_text(encoding="utf-8"))


def _registry() -> tuple[Registry[Any], dict[str, str]]:
    registry: Registry[Any] = Registry()
    ids: dict[str, str] = {}
    for name in ("runner-api.v1.json", "worker-api.v1.json"):
        schema = _load(name)
        ids[name] = schema["$id"]
        registry = registry.with_resource(schema["$id"], Resource.from_contents(schema))
    return registry, ids


REGISTRY, IDS = _registry()


def _accepts(file: str, definition: str, instance: Any) -> bool:
    validator = Draft202012Validator(
        {"$ref": f"{IDS[file]}#/$defs/{definition}"}, registry=REGISTRY
    )
    return bool(validator.is_valid(instance))  # pyright: ignore[reportUnknownMemberType]


@pytest.mark.parametrize(
    ("definition", "example"),
    [
        ("SessionPartQuery", "examples/worker-api/SessionPartQuery.json"),
        ("SessionPartResponse", "examples/worker-api/SessionPartResponse.json"),
    ],
)
# #839-T43
def test_the_examples_are_valid(definition: str, example: str) -> None:
    assert _accepts("worker-api.v1.json", definition, _load(example))


# #839-T43
@pytest.mark.parametrize(
    "size", [1, CHUNK_BYTES - 1, CHUNK_BYTES, CHUNK_BYTES + 1, MAX_SNAPSHOT_BYTES]
)
def test_the_query_of_every_part_of_a_file_is_a_valid_query(size: int) -> None:
    digest = hashlib.sha256(str(size).encode()).hexdigest()
    count = parts_of(size)
    for index in range(count):
        body = CHUNK_BYTES if index < count - 1 else size - CHUNK_BYTES * (count - 1)
        part = SnapshotPart(index, count, size, digest, 4 * size, "1.19.0", b"x" * min(body, 10))

        query = dict(parse_qsl(snapshot_query(part), strict_parsing=True))

        assert _accepts("worker-api.v1.json", "SessionPartQuery", query), query
        assert set(query) == {"part", "parts", "bytes", "rawBytes", "sha256", "opencodeVersion"}
        assert int(query["parts"]) == count and int(query["part"]) == index
        assert 0 < body <= CHUNK_BYTES


# #839-T44
def test_the_bounds_of_the_runner_are_the_schemas() -> None:
    schema = _load("worker-api.v1.json")["$defs"]
    query = schema["SessionPartQuery"]["properties"]

    assert MAX_SNAPSHOT_BYTES == 8 * 1024 * 1024 and CHUNK_BYTES == 3 * 1024 * 1024
    assert (
        parts_of(MAX_SNAPSHOT_BYTES)
        == schema["SessionPartResponse"]["properties"]["parts"]["maximum"]
    )
    assert query["parts"]["pattern"] == f"^[1-{parts_of(MAX_SNAPSHOT_BYTES)}]$"
    # The header the process hands the host uses the same shapes the app checks.
    header = SnapshotHeader(10, 40, "f" * 64, "1.19.0")
    assert parse_header(header_line(header)) == header
    assert _accepts(
        "worker-api.v1.json",
        "SessionPartQuery",
        {
            "part": "0",
            "parts": "1",
            "bytes": "10",
            "rawBytes": "40",
            "sha256": header.sha256,
            "opencodeVersion": header.version,
        },
    )
    assert (
        FEATURE_IMPLEMENTER_SNAPSHOT
        in _load("runner-api.v1.json")["$defs"]["KnownAppFeature"]["enum"]
    )


# #879: the same two calls for a customer's runner (`runner-api.v1.json`): the runner credential in
# Authorization, the lease token in a header; the query, the answers and the headers are those of
# the Worker API.
RUNNER_DEFINITIONS = (
    "RunnerLeaseTokenHeader",
    "RunnerSessionPartQuery",
    "RunnerSessionPartResponse",
    "RunnerResumeSessionQuery",
    "RunnerResumeSessionHeaders",
)


@pytest.mark.parametrize("definition", RUNNER_DEFINITIONS)
# #879-T54
def test_the_examples_of_the_runner_routes_are_valid(definition: str) -> None:
    example = _load(f"examples/{definition}.json")

    assert _accepts("runner-api.v1.json", definition, example)


# #879-T54
@pytest.mark.parametrize(
    "size", [1, CHUNK_BYTES - 1, CHUNK_BYTES, CHUNK_BYTES + 1, MAX_SNAPSHOT_BYTES]
)
def test_the_query_of_every_part_is_valid_for_the_runner_route_too(size: int) -> None:
    digest = hashlib.sha256(str(size).encode()).hexdigest()
    count = parts_of(size)
    for index in range(count):
        part = SnapshotPart(index, count, size, digest, 4 * size, "1.19.0", b"x")

        query = dict(parse_qsl(snapshot_query(part), strict_parsing=True))

        assert _accepts("runner-api.v1.json", "RunnerSessionPartQuery", query), query


# #879-T55
@pytest.mark.parametrize(
    ("worker", "runner"),
    [
        ("SessionPartQuery", "RunnerSessionPartQuery"),
        ("SessionPartResponse", "RunnerSessionPartResponse"),
        ("ResumeSessionQuery", "RunnerResumeSessionQuery"),
        ("ResumeSessionHeaders", "RunnerResumeSessionHeaders"),
    ],
)
def test_the_runner_routes_say_the_same_as_the_worker_routes_about_the_fields(
    worker: str, runner: str
) -> None:
    theirs = {
        k: v for k, v in _load("worker-api.v1.json")["$defs"][worker].items() if k != "description"
    }
    ours = {
        k: v for k, v in _load("runner-api.v1.json")["$defs"][runner].items() if k != "description"
    }

    assert ours == theirs


# #879-T56
def test_the_feature_of_the_runner_routes_is_listed_and_the_lease_token_is_the_contracts() -> None:
    schema = _load("runner-api.v1.json")["$defs"]

    assert "runner_session_snapshot" in schema["KnownAppFeature"]["enum"]
    assert FEATURE_IMPLEMENTER_SNAPSHOT in schema["KnownAppFeature"]["enum"]
    lease = schema["RunnerLeaseTokenHeader"]
    assert lease["required"] == ["x-lease-token"]
    assert lease["properties"]["x-lease-token"] == {"$ref": "#/$defs/LeaseToken"}
    # A token of the bounds of `LeaseToken` is accepted, one outside them is not.
    assert _accepts("runner-api.v1.json", "RunnerLeaseTokenHeader", {"x-lease-token": "x" * 8})
    assert _accepts("runner-api.v1.json", "RunnerLeaseTokenHeader", {"x-lease-token": "x" * 256})
    assert not _accepts("runner-api.v1.json", "RunnerLeaseTokenHeader", {"x-lease-token": "x" * 7})
    assert not _accepts(
        "runner-api.v1.json", "RunnerLeaseTokenHeader", {"x-lease-token": "x" * 257}
    )
    assert not _accepts("runner-api.v1.json", "RunnerLeaseTokenHeader", {})
