# SPDX-License-Identifier: LicenseRef-Proprietary

"""The steps call of the runner API and the Worker API from the runner's side (#745).

The app checks the same schema against its own reading of a request
(`steps-contract.test.ts`); here the other half: the examples are valid, and every record the
runner's converter makes, at the size of its caps and in the worst spelling, is a valid `StepRecord`
in a valid batch. The caps of the converter and the bounds of the schema are two copies of the same
numbers, and one test holds them equal.
"""

import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from code_reviewer_runner.implementer.step_records import (
    MAX_ERROR_BYTES,
    MAX_ID_CHARS,
    MAX_INPUT_BYTES,
    MAX_NAME_CHARS,
    MAX_TEXT_BYTES,
    MAX_TITLE_BYTES,
    REASONING,
    STEP,
    TEXT,
    TOOL,
    StepConverter,
    StepRecord,
)
from code_reviewer_runner.redaction import Redactor

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"
Document = dict[str, Any]
SESSION = "ses_1"
# The room the schema leaves for the mark the converter adds when it cuts (`\n[N bytes cut]`).
MARK = 64


def _load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _registry() -> tuple[Registry[Any], dict[str, str]]:
    registry: Registry[Any] = Registry()
    ids: dict[str, str] = {}
    for name in ("runner-api.v1.json", "worker-api.v1.json"):
        schema: Document = _load(CONTRACTS / name)
        ids[name] = schema["$id"]
        registry = registry.with_resource(schema["$id"], Resource.from_contents(schema))
    return registry, ids


REGISTRY, IDS = _registry()
RUNNER_SCHEMA: Document = _load(CONTRACTS / "runner-api.v1.json")


def _accepts(file: str, definition: str, document: Any) -> bool:
    validator = Draft202012Validator(
        {"$ref": f"{IDS[file]}#/$defs/{definition}"}, registry=REGISTRY
    )
    return bool(validator.is_valid(document))  # pyright: ignore[reportUnknownMemberType]


def _batch(records: list[StepRecord]) -> Document:
    return {
        "leaseToken": "6f1d2c9a-5b3e-4a77-9c0d-8e2f1a4b7c33",
        "records": [r.as_json() for r in records],
    }


def _part(body: Mapping[str, Any], at: int = 1_000) -> Document:
    return {
        "type": "message.part.updated",
        "properties": {"sessionID": SESSION, "part": dict(body), "time": at},
    }


def _convert(events: list[Document], secret: str = "hunter2-x7Qp9Zr") -> list[StepRecord]:
    converter = StepConverter(SESSION, Redactor([secret]))
    records = (converter.convert(event) for event in events)
    return [record for record in records if record is not None]


def _turn(text: str = "The build fails in a test.", command: str = "npm test") -> list[Document]:
    base: Document = {"sessionID": SESSION, "messageID": "msg_a"}
    return [
        {
            "type": "message.updated",
            "properties": {"sessionID": SESSION, "info": {"id": "msg_a", "role": "assistant"}},
        },
        _part(
            {
                **base,
                "id": "prt_r",
                "type": "reasoning",
                "text": text,
                "time": {"start": 10, "end": 20},
            }
        ),
        _part(
            {
                **base,
                "id": "prt_t",
                "type": "tool",
                "callID": "call_1",
                "tool": "bash",
                "state": {
                    "status": "running",
                    "input": {"command": command},
                    "title": "run the tests",
                    "time": {"start": 100},
                },
            }
        ),
        _part(
            {
                **base,
                "id": "prt_t",
                "type": "tool",
                "callID": "call_1",
                "tool": "bash",
                "state": {
                    "status": "error",
                    "input": {"command": command},
                    "error": "exit 1 " + text,
                    "time": {"start": 100, "end": 160},
                },
            }
        ),
        _part(
            {
                **base,
                "id": "prt_x",
                "type": "text",
                "text": text,
                "time": {"start": 170, "end": 180},
            }
        ),
        _part(
            {
                **base,
                "id": "prt_fin",
                "type": "step-finish",
                "reason": "tool-calls",
                "cost": 0.0125,
                "tokens": {
                    "input": 1000,
                    "output": 300,
                    "reasoning": 150,
                    "cache": {"read": 40, "write": 10},
                },
            },
            at=2_000,
        ),
    ]


@pytest.mark.contract
@pytest.mark.parametrize(
    ("file", "definition", "example"),
    [
        ("runner-api.v1.json", "StepsRequest", "examples/StepsRequest.json"),
        ("runner-api.v1.json", "StepsResponse", "examples/StepsResponse.json"),
        ("worker-api.v1.json", "WorkerStepsRequest", "examples/worker-api/WorkerStepsRequest.json"),
        (
            "worker-api.v1.json",
            "WorkerStepsResponse",
            "examples/worker-api/WorkerStepsResponse.json",
        ),
    ],
)
def test_the_examples_of_the_steps_call_are_valid(file: str, definition: str, example: str) -> None:
    # #745-T30
    assert _accepts(file, definition, _load(CONTRACTS / example))


@pytest.mark.contract
def test_every_record_of_the_example_is_a_kind_the_converter_makes() -> None:
    # #745-T30
    example = _load(CONTRACTS / "examples/StepsRequest.json")
    kinds = {record["kind"] for record in example["records"]}

    assert kinds == {REASONING, TEXT, TOOL, STEP}
    assert set(RUNNER_SCHEMA["$defs"]["KnownStepKind"]["enum"]) == {REASONING, TEXT, TOOL, STEP}


@pytest.mark.contract
def test_the_records_of_a_turn_are_a_valid_batch() -> None:
    # #745-T31
    records = _convert(_turn())

    assert [record.kind for record in records] == [REASONING, TOOL, TOOL, TEXT, STEP]
    assert _accepts("runner-api.v1.json", "StepsRequest", _batch(records))
    for record in records:
        assert _accepts("runner-api.v1.json", "StepRecord", record.as_json())
    assert _accepts(
        "worker-api.v1.json", "WorkerStepsRequest", {"records": [r.as_json() for r in records]}
    )


@pytest.mark.contract
@pytest.mark.parametrize("unit", ["x", "é", "日", "😀"])
def test_a_record_at_the_size_of_its_caps_is_still_valid_in_characters_and_in_bytes(
    unit: str,
) -> None:
    # #745-T31: the schema counts characters, the converter bytes; 4 byte characters are the worst.
    text = unit * 40_000
    records = _convert(_turn(text=text, command=text))

    assert len(records) == 5
    for record in records:
        assert _accepts("runner-api.v1.json", "StepRecord", record.as_json())
    biggest = max(len(json.dumps(record.as_json(), ensure_ascii=True)) for record in records)
    # A record stays far below the 48 KiB a batch may be (ensure_ascii writes 4 bytes as 12).
    assert biggest < 48 * 1024 * 2


@pytest.mark.contract
def test_the_caps_of_the_converter_are_the_bounds_of_the_schema() -> None:
    # #745-T32
    properties = {
        **RUNNER_SCHEMA["$defs"]["StepRecord"]["properties"],
        **RUNNER_SCHEMA["$defs"]["KnownStepFields"]["properties"],
    }

    assert properties["text"]["maxLength"] == MAX_TEXT_BYTES + MARK
    assert properties["input"]["maxLength"] == MAX_INPUT_BYTES + MARK
    assert properties["error"]["maxLength"] == MAX_ERROR_BYTES + MARK
    assert properties["title"]["maxLength"] == MAX_TITLE_BYTES + MARK
    assert properties["tool"]["maxLength"] == MAX_NAME_CHARS
    assert properties["status"]["maxLength"] == 32
    assert properties["reason"]["maxLength"] == 64
    assert MAX_ID_CHARS == 256
    assert "{1,256}" in properties["partId"]["pattern"]
    assert RUNNER_SCHEMA["$defs"]["StepsRequest"]["properties"]["records"]["maxItems"] == 50


@pytest.mark.contract
def test_a_part_whose_id_the_app_would_refuse_is_not_reported() -> None:
    # #745-T33: one odd id would make the app refuse the whole batch.
    odd = _turn()
    odd[1]["properties"]["part"]["id"] = "prt with space"
    odd[4]["properties"]["part"]["id"] = "prt_ü"

    records = _convert(odd)

    assert [record.part_id for record in records] == ["prt_t", "prt_t", "prt_fin"]
    assert _accepts("runner-api.v1.json", "StepsRequest", _batch(records))


@pytest.mark.contract
def test_a_secret_never_reaches_the_batch_in_any_field() -> None:
    # #745-T34: the first line of defence is the runner's; the app cleans again.
    secret = "hunter2-x7Qp9Zr"
    records = _convert(_turn(text=f"my key is {secret}", command=f"curl -H 'x: {secret}'"), secret)

    assert secret not in json.dumps(_batch(records))
