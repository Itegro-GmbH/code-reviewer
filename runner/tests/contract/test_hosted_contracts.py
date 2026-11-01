# SPDX-License-Identifier: LicenseRef-Proprietary

"""Pins down the hosted-deployment contracts (#316, #318) from the runner's side.

The Worker (Python) reads the Worker API and the runner API additions; the files are the source and
the app (app/integration-tests/compatibility/hosted-contracts.integration.test.ts) checks the same
examples and vectors. Here the examples are valid, the closed objects are closed, an additive field
is ignored and the signing vectors give their verdicts, computed independently of the TypeScript
reference.
"""

import hashlib
import hmac
import json
from pathlib import Path
from typing import Any, cast

import pytest
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"
Document = dict[str, Any]

SCHEMA_FILES = (
    "runner-api.v1.json",
    "worker-api.v1.json",
    "dispatch-webhook.v1.json",
    "worker-container.v1.json",
)


def _load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _registry() -> tuple[Registry[Any], dict[str, str]]:
    registry: Registry[Any] = Registry()
    ids: dict[str, str] = {}
    for name in SCHEMA_FILES:
        schema: Document = _load(CONTRACTS / name)
        ids[name] = schema["$id"]
        registry = registry.with_resource(schema["$id"], Resource.from_contents(schema))
    return registry, ids


REGISTRY, IDS = _registry()


def _validator(file: str, definition: str) -> Draft202012Validator:
    return Draft202012Validator({"$ref": f"{IDS[file]}#/$defs/{definition}"}, registry=REGISTRY)


def _accepts(file: str, definition: str, document: Any) -> bool:
    return bool(_validator(file, definition).is_valid(document))  # pyright: ignore[reportUnknownMemberType]


def _examples(folder: str) -> list[tuple[str, Document]]:
    return [(path.stem, _load(path)) for path in sorted((CONTRACTS / folder).glob("*.json"))]


def _example(folder: str, definition: str) -> Document:
    return _load(CONTRACTS / folder / f"{definition}.json")


FOLDERS = {
    "worker-api.v1.json": "examples/worker-api",
    "dispatch-webhook.v1.json": "examples/dispatch-webhook",
    "worker-container.v1.json": "examples/worker-container",
}

CASES = [
    (file, definition) for file, folder in FOLDERS.items() for definition, _ in _examples(folder)
]


@pytest.mark.contract
@pytest.mark.parametrize(("file", "definition"), CASES)
def test_every_example_is_valid_against_its_schema(file: str, definition: str) -> None:
    # #318-T01
    assert _accepts(file, definition, _example(FOLDERS[file], definition))


@pytest.mark.contract
@pytest.mark.parametrize(
    "definition",
    [
        "SplitClaimResponse",
        "ReleaseRequest",
        "ReleaseResponse",
        "VersionResponse",
        "JobStateResponse",
        "VmStartRequest",
        "VmStartResponse",
    ],
)
def test_the_new_runner_api_examples_are_valid(definition: str) -> None:
    # #318-T01
    assert _accepts("runner-api.v1.json", definition, _example("examples", definition))


@pytest.mark.contract
@pytest.mark.parametrize(
    "addition",
    [
        {"extra": "value"},
        {"secret": "example-secret"},
        {"token": "example-token"},
        {"credential": "crj_EXAMPLE"},
        {"signature": "v1=00"},
    ],
)
def test_the_dispatch_webhook_is_closed(addition: Document) -> None:
    # #318-T03
    body = {**_example("examples/dispatch-webhook", "DispatchWebhook"), **addition}

    assert not _accepts("dispatch-webhook.v1.json", "DispatchWebhook", body)


@pytest.mark.contract
@pytest.mark.parametrize(
    ("definition", "inner"),
    [
        ("WorkerJobDetailsResponse", "job"),
        ("WorkerHeartbeatResponse", "job"),
        ("WorkerResultResponse", "job"),
        ("WorkerErrorResponse", "error"),
    ],
)
def test_a_reader_ignores_an_additive_field_of_a_worker_api_answer(
    definition: str, inner: str
) -> None:
    # #318-T04
    body = _example("examples/worker-api", definition)
    nested = {**body[inner], "addedLater": {"deep": True}}

    assert _accepts("worker-api.v1.json", definition, {**body, "addedLater": 1})
    assert _accepts("worker-api.v1.json", definition, {**body, inner: nested})


@pytest.mark.contract
def test_the_job_input_in_the_details_answer_stays_closed() -> None:
    # #318-T04
    body = _example("examples/worker-api", "WorkerJobDetailsResponse")
    body["job"]["input"]["addedLater"] = 1

    assert not _accepts("worker-api.v1.json", "WorkerJobDetailsResponse", body)


@pytest.mark.contract
@pytest.mark.parametrize(
    "change",
    [
        {"privileged": True},
        {"binds": ["/var/run/docker.sock:/var/run/docker.sock"]},
        {"volumes": ["/data:/data"]},
        {"devices": ["/dev/kvm"]},
        {"networkMode": "host"},
        {"network": {"mode": "host"}},
        {"pid": "host"},
        {"securityOpt": ["no-new-privileges:true", "seccomp=unconfined"]},
        {"securityOpt": []},
        {"readOnly": False},
        {"user": "10001:10001"},
        {"allowedEnvironment": ["RUNNER_TOKEN"]},
    ],
)
@pytest.mark.parametrize("definition", ["WorkerContainerSpec", "ImplementerContainerSpec"])
def test_the_container_spec_refuses_weakening(definition: str, change: Document) -> None:
    # #318-T05, #760-T01: the same refusals for every profile
    spec = {**_example("examples/worker-container", definition), **change}

    assert not _accepts("worker-container.v1.json", definition, spec)


@pytest.mark.contract
def test_the_implementer_profile_is_the_default_spec_plus_a_work_volume() -> None:
    # #760-T01
    standard = _example("examples/worker-container", "WorkerContainerSpec")
    profile = _example("examples/worker-container", "ImplementerContainerSpec")

    assert _accepts("worker-container.v1.json", "ImplementerContainerSpec", profile)
    assert not _accepts("worker-container.v1.json", "ImplementerContainerSpec", standard)
    assert not _accepts("worker-container.v1.json", "WorkerContainerSpec", profile)
    differing = sorted(
        key for key in {*standard, *profile} if standard.get(key) != profile.get(key)
    )
    assert differing == ["allowedEnvironment", "memory", "pids", "workVolume"]
    volume = profile["workVolume"]
    for change in (
        {"path": "/data"},
        {"options": ["rw", "nodev"]},
        {"options": ["rw", "nosuid"]},
        {"source": "/var/lib/docker"},
        {"propagation": "shared"},
    ):
        assert not _accepts(
            "worker-container.v1.json",
            "ImplementerContainerSpec",
            {**profile, "workVolume": {**volume, **change}},
        )
    assert not _accepts(
        "worker-container.v1.json", "ImplementerContainerSpec", {**profile, "pids": {"limit": 512}}
    )


@pytest.mark.contract
def test_the_container_overrides_allow_the_memory_limit_only() -> None:
    # #318-T05
    assert _accepts(
        "worker-container.v1.json",
        "WorkerContainerOverrides",
        {"memory": {"limit": "1536m", "swap": "1536m"}},
    )
    assert not _accepts("worker-container.v1.json", "WorkerContainerOverrides", {"readOnly": False})


def test_the_container_launcher_additions_allow_the_two_ipv6_switches_only() -> None:
    # #325-T08
    both = {
        "net.ipv6.conf.all.disable_ipv6": "1",
        "net.ipv6.conf.default.disable_ipv6": "1",
    }
    additions = "WorkerContainerLauncherAdditions"
    assert _accepts("worker-container.v1.json", additions, {"sysctls": both})
    assert _accepts("worker-container.v1.json", additions, {})
    assert not _accepts(
        "worker-container.v1.json", additions, {"sysctls": {"net.ipv4.ip_forward": "1"}}
    )
    assert not _accepts(
        "worker-container.v1.json",
        additions,
        {"sysctls": {**both, "net.ipv6.conf.all.disable_ipv6": "0"}},
    )
    # The spec itself has no sysctls: the self-hosted compose files carry none.
    spec = _example("examples/worker-container", "WorkerContainerSpec")
    assert not _accepts(
        "worker-container.v1.json", "WorkerContainerSpec", {**spec, "sysctls": both}
    )


# The reference verifier of the dispatch webhook, written here from the description in the schema
# and not copied from the TypeScript one (fakes/dispatcher-app/signing.ts).
def _verdict(vectors: Document, vector: Document) -> str:
    headers: dict[str, str] = vector["headers"]
    timestamp = headers.get("x-dispatch-timestamp", "")
    dispatch_id = headers.get("x-dispatch-id", "")
    signature = headers.get("x-dispatch-signature", "")
    key_id = headers.get("x-dispatch-key-id", "")
    if not timestamp.isdigit() or not signature.startswith("v1=") or not dispatch_id:
        return "malformed"
    if len(signature) != 3 + 64 or any(c not in "0123456789abcdef" for c in signature[3:]):
        return "malformed"
    if abs(int(timestamp) - int(vector["now"])) > int(vectors["toleranceSeconds"]):
        return "expired"
    keys = [key for key in vectors["keys"].values() if key["kid"] == key_id]
    if not keys:
        return "unknown_key"
    message = f"v1:{timestamp}:{dispatch_id}:{vector['body']}".encode()
    expected = "v1=" + hmac.new(keys[0]["secret"].encode(), message, hashlib.sha256).hexdigest()
    return "ok" if hmac.compare_digest(expected, signature) else "bad_signature"


def _vectors() -> Document:
    return cast(Document, _load(CONTRACTS / "dispatch-signing-vectors.json"))


@pytest.mark.contract
def test_the_signing_vectors_are_valid_against_their_definition() -> None:
    # #318-T06
    assert _accepts("dispatch-webhook.v1.json", "DispatchSigningVectors", _vectors())


@pytest.mark.contract
@pytest.mark.parametrize("vector", _vectors()["vectors"], ids=lambda v: str(v["name"]))
def test_each_signing_vector_gives_its_verdict(vector: Document) -> None:
    # #318-T06
    assert _verdict(_vectors(), vector) == vector["expected"]
