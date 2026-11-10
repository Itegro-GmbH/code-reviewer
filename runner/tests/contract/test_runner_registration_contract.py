# SPDX-License-Identifier: LicenseRef-Proprietary

"""Pins down the runner registration contract (#854) from the runner's side.

The app checks its real answers against the same file (the route files test and
registration-contract.test.ts under app/), so a change to the format has to change both
sides. The runner is the writer of the registration and announcement bodies, so what it
will send must be valid under the file, and the rules it relies on (labels, the version
of the base, a ready harness, credentials that cannot be taken for a registration token)
hold. The runner's own client for these calls comes with the runner image (R1b); until
then only the file and its examples are held.
"""

import json
import re
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"
SCHEMA_PATH = CONTRACTS / "runner-registration.v1.json"
EXAMPLES = CONTRACTS / "examples" / "runner-registration"
RUNNER_API_PATH = CONTRACTS / "runner-api.v1.json"

# The definitions that describe a whole request or response body. Each has one example file.
BODIES = (
    "RegisterRequest",
    "RegisterResponse",
    "AnnounceRequest",
    "AnnounceResponse",
    "CredentialResponse",
)

Document = dict[str, Any]


def _load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


_SCHEMA: Document = _load(SCHEMA_PATH)
_RUNNER_API: Document = _load(RUNNER_API_PATH)


def _registry() -> Registry[Any]:
    registry: Registry[Any] = Registry()
    for schema in (_SCHEMA, _RUNNER_API):
        registry = registry.with_resource(schema["$id"], Resource.from_contents(schema))
    return registry


_REGISTRY = _registry()


def _accepts(definition: str, document: Any) -> bool:
    validator = Draft202012Validator(
        {"$ref": f"{_SCHEMA['$id']}#/$defs/{definition}"}, registry=_REGISTRY
    )
    return bool(validator.is_valid(document))  # pyright: ignore[reportUnknownMemberType]


def _example(definition: str) -> Document:
    return _load(EXAMPLES / f"{definition}.json")


def test_the_contract_file_is_a_valid_schema_of_version_one() -> None:
    Draft202012Validator.check_schema(_SCHEMA)
    assert _SCHEMA["version"] == 1


@pytest.mark.parametrize("definition", BODIES)
def test_the_example_of_every_body_is_valid(definition: str) -> None:
    assert _accepts(definition, _example(definition))


def test_there_is_exactly_one_example_per_body() -> None:
    assert sorted(path.stem for path in EXAMPLES.glob("*.json")) == sorted(BODIES)


def test_a_body_with_fields_the_runner_does_not_know_is_still_valid() -> None:
    body = _example("AnnounceResponse")
    body["somethingNew"] = {"a": 1}
    assert _accepts("AnnounceResponse", body)


@pytest.mark.parametrize(
    ("label", "valid"),
    [
        ("linux", True),
        ("gpu-a100", True),
        ("team:a", True),
        ("v1.2_x", True),
        ("a" * 40, True),
        ("a" * 41, False),
        ("Linux", False),
        ("two words", False),
        ("-leading", False),
        ("", False),
    ],
)
def test_a_label_is_lower_case_without_spaces_and_at_most_forty_characters(
    label: str, valid: bool
) -> None:
    body = _example("AnnounceRequest")
    body["labels"] = [label]
    assert _accepts("AnnounceRequest", body) is valid


def test_at_most_twenty_labels() -> None:
    body = _example("AnnounceRequest")
    body["labels"] = [f"l{index}" for index in range(20)]
    assert _accepts("AnnounceRequest", body)
    body["labels"].append("l20")
    assert not _accepts("AnnounceRequest", body)


@pytest.mark.parametrize(
    ("version", "valid"),
    [
        ("1.0.0", True),
        ("12.34.56", True),
        ("1.0.0-rc1", True),
        ("1.0", False),
        ("v1.0.0", False),
        ("1.0.0.0", False),
        ("latest", False),
    ],
)
def test_the_base_version_is_three_numbers_and_an_optional_pre_release(
    version: str, valid: bool
) -> None:
    body = _example("AnnounceRequest")
    body["baseVersion"] = version
    assert _accepts("AnnounceRequest", body) is valid


def test_a_harness_says_its_version_and_whether_it_is_ready() -> None:
    body = _example("AnnounceRequest")
    body["manifest"] = {"harnesses": {"opencode": {"version": "1.19.0"}}}
    assert not _accepts("AnnounceRequest", body)
    body["manifest"] = {"harnesses": {"opencode": {"version": "1.19.0", "ready": "yes"}}}
    assert not _accepts("AnnounceRequest", body)
    body["manifest"] = {"harnesses": {"custom/my-tool": {"version": "0.3", "ready": False}}}
    assert _accepts("AnnounceRequest", body)
    body["manifest"] = {"harnesses": {"OpenCode": {"version": "1", "ready": True}}}
    assert not _accepts("AnnounceRequest", body)


# #973-T04
def test_an_entry_names_a_harness_a_version_an_auth_and_for_a_device_the_models() -> None:
    body = _example("AnnounceRequest")
    opencode = {"harness": "opencode", "version": "1.19.0", "auth": "app-key"}
    claude = {"harness": "claude-code", "version": "2.1.311", "auth": "subscription"}
    body["manifest"] = {"harnesses": [opencode, {**claude, "models": ["sonnet", "opus"]}]}
    assert _accepts("AnnounceRequest", body)
    body["manifest"] = {"harnesses": [opencode, claude]}  # no models: the device allows any
    assert _accepts("AnnounceRequest", body)
    for bad in (
        {**opencode, "auth": "token"},  # not one of the four
        {"harness": "opencode", "version": "1.19.0"},  # no auth
        {**opencode, "models": ["x"]},  # a key of the app: the catalog decides, no models
        {**claude, "models": []},
        {**claude, "models": ["sonnet", "sonnet"]},
        {**claude, "models": ["bad model"]},
    ):
        body["manifest"] = {"harnesses": [bad]}
        assert not _accepts("AnnounceRequest", body), bad
    body["manifest"] = {"harnesses": [{**opencode, "auth": "managed"}]}
    assert _accepts("AnnounceRequest", body)  # the file knows it; the app refuses it with 422 for a customer


def test_the_registration_needs_a_token_a_name_labels_and_a_base_version() -> None:
    for missing in ("token", "name", "labels", "baseVersion"):
        body = _example("RegisterRequest")
        del body[missing]
        assert not _accepts("RegisterRequest", body), missing


def test_a_credential_cannot_be_taken_for_a_registration_token_or_the_other_way() -> None:
    credential = _example("RegisterResponse")["credential"]
    token = _example("RegisterRequest")["token"]
    request = _example("RegisterRequest")
    response = _example("RegisterResponse")
    request["token"] = credential
    response["credential"] = token
    assert not _accepts("RegisterRequest", request)
    assert not _accepts("RegisterResponse", response)


def test_the_minimum_version_of_the_response_is_a_version_or_null() -> None:
    body = _example("RegisterResponse")
    body["minBaseVersion"] = None
    assert _accepts("RegisterResponse", body)
    body["minBaseVersion"] = "soon"
    assert not _accepts("RegisterResponse", body)


def test_the_runner_api_names_the_codes_the_registration_answers_with() -> None:
    codes: list[str] = _RUNNER_API["$defs"]["ApiErrorCode"]["enum"]
    assert "RUNNER_REGISTRATION_TOKEN_INVALID" in codes
    assert "RUNNER_UPDATE_NEEDED" in codes
    error = _load(CONTRACTS / "examples" / "ErrorResponse.json")
    error["error"]["code"] = "RUNNER_UPDATE_NEEDED"
    error["error"]["minBaseVersion"] = "1.4.0"
    validator = Draft202012Validator(
        {"$ref": f"{_RUNNER_API['$id']}#/$defs/ErrorResponse"}, registry=_REGISTRY
    )
    assert validator.is_valid(error)  # pyright: ignore[reportUnknownMemberType]
    error["error"]["minBaseVersion"] = "soon"
    assert not validator.is_valid(error)  # pyright: ignore[reportUnknownMemberType]


def test_a_secret_never_shows_in_the_example_patterns_beyond_their_prefix() -> None:
    # Both secrets are 43 characters of base64url after their prefix: 256 random bits.
    for definition in ("RegistrationToken", "RunnerCredential"):
        pattern: str = _SCHEMA["$defs"][definition]["pattern"]
        assert re.search(r"\{43\}\$$", pattern)
