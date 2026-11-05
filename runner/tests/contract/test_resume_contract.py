# SPDX-License-Identifier: LicenseRef-Proprietary

"""The stored session of a follow-up turn from the runner's side (#840).

The app checks the same schema against its own reading (`resume-session-contract.test.ts`,
`implementer-contract.test.ts`); here the other half: the examples are valid, the runner's reading of
`implementer.resume` gives the schema's verdict, the words the runner reports are the schema's, the
headers its client reads are the ones the schema requires, and the report it builds is valid.
"""

import json
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from code_reviewer_runner import job as runner_job
from code_reviewer_runner.implementer.preface import ResumeMode
from code_reviewer_runner.implementer.report import _RESUME_REASONS  # pyright: ignore[reportPrivateUsage]
from code_reviewer_runner.job_loop.worker_api import _resume_header  # pyright: ignore[reportPrivateUsage]
from code_reviewer_runner.resume_wire import (
    HEADER_BYTES,
    HEADER_PARTS,
    HEADER_RAW_BYTES,
    HEADER_SHA256,
    HEADER_VERSION,
    ResumeReason,
)

pytestmark = pytest.mark.contract

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"


def _load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _registry() -> tuple[Registry[Any], dict[str, str]]:
    registry: Registry[Any] = Registry()
    ids: dict[str, str] = {}
    for name in ("runner-api.v1.json", "worker-api.v1.json"):
        schema = _load(CONTRACTS / name)
        ids[name] = schema["$id"]
        registry = registry.with_resource(schema["$id"], Resource.from_contents(schema))
    return registry, ids


REGISTRY, IDS = _registry()


def _accepts(file: str, definition: str, instance: Any) -> bool:
    validator = Draft202012Validator(
        {"$ref": f"{IDS[file]}#/$defs/{definition}"}, registry=REGISTRY
    )
    return bool(validator.is_valid(instance))  # pyright: ignore[reportUnknownMemberType]


def _worker_example(name: str) -> Any:
    return _load(CONTRACTS / "examples" / "worker-api" / f"{name}.json")


def _implementer_example(name: str) -> Any:
    return _load(CONTRACTS / "examples" / "implementer" / f"{name}.json")


# #840-T150
def test_the_examples_are_valid() -> None:
    assert _accepts(
        "worker-api.v1.json", "ResumeSessionQuery", _worker_example("ResumeSessionQuery")
    )
    assert _accepts(
        "worker-api.v1.json", "ResumeSessionHeaders", _worker_example("ResumeSessionHeaders")
    )
    assert _accepts(
        "runner-api.v1.json", "ImplementerResume", _implementer_example("ImplementerResume")
    )
    assert _accepts("runner-api.v1.json", "RunnerResult", _implementer_example("RunnerResult"))


# #840-T151
def test_the_reasons_the_runner_reports_are_the_schemas() -> None:
    schema = _load(CONTRACTS / "runner-api.v1.json")["$defs"]["ImplementerResumeResult"]

    assert [reason.value for reason in ResumeReason] == schema["properties"]["reason"]["enum"]
    assert sorted(_RESUME_REASONS) == sorted(schema["properties"]["reason"]["enum"])
    assert [mode.value for mode in ResumeMode] == schema["properties"]["mode"]["enum"]


# #840-T152
@pytest.mark.parametrize(
    "result",
    [
        {"mode": "imported"},
        *({"mode": "summary_only", "reason": reason.value} for reason in ResumeReason),
    ],
)
def test_the_blocks_the_runner_makes_are_valid(result: dict[str, str]) -> None:
    example = _implementer_example("RunnerResult")
    example["implementer"]["resume"] = result

    assert _accepts("runner-api.v1.json", "RunnerResult", example)


# #840-T153
@pytest.mark.parametrize(
    "result",
    [
        {},
        {"mode": "copied"},
        {"mode": "summary_only"},
        {"mode": "imported", "reason": "import_failed"},
        {"mode": "summary_only", "reason": "free text"},
        {"mode": "imported", "extra": 1},
    ],
)
def test_the_blocks_the_schema_refuses_are_refused_by_the_runners_report_too(
    result: dict[str, str],
) -> None:
    from code_reviewer_runner.implementer.report import valid_block

    example = _implementer_example("RunnerResult")
    example["implementer"]["resume"] = result

    assert not _accepts("runner-api.v1.json", "RunnerResult", example)
    assert valid_block(example["implementer"]) is None


# #840-T154
def test_the_headers_the_client_reads_are_the_ones_the_schema_requires() -> None:
    schema = _load(CONTRACTS / "worker-api.v1.json")["$defs"]["ResumeSessionHeaders"]

    assert sorted(schema["required"]) == sorted(
        [HEADER_PARTS, HEADER_BYTES, HEADER_RAW_BYTES, HEADER_SHA256, HEADER_VERSION]
    )
    parsed = _resume_header(_worker_example("ResumeSessionHeaders"))
    assert parsed is not None
    header, parts = parsed
    assert (header.size, header.raw_bytes, header.version, parts) == (
        620544,
        2_600_000,
        "1.19.0",
        1,
    )


# #840-T155
@pytest.mark.parametrize(
    "change",
    [
        {HEADER_PARTS: "4"},
        {HEADER_BYTES: "0"},
        {HEADER_SHA256: "G" * 64},
        {HEADER_VERSION: "-1"},
        {HEADER_RAW_BYTES: "x"},
    ],
)
def test_headers_the_schema_refuses_are_refused_by_the_client_too(change: dict[str, str]) -> None:
    headers = {**_worker_example("ResumeSessionHeaders"), **change}

    assert not _accepts("worker-api.v1.json", "ResumeSessionHeaders", headers)
    assert _resume_header(headers) is None


def _job_with(resume: dict[str, Any]) -> runner_job.ImplementerInput:
    job = _load(CONTRACTS / "examples" / "implementer" / "RunnerJobInput.json")
    job["implementer"]["resume"] = resume
    return runner_job.parse_implementer_input(json.dumps(job))


# #840-T156
def test_the_runner_reads_the_example_resume_with_its_summary_and_digest() -> None:
    example = _implementer_example("ImplementerResume")

    resume = _job_with(example).implementer.resume

    assert resume is not None
    assert resume.snapshot is True
    assert resume.previous_summary == example["previousSummary"]
    assert resume.digest == example["digest"]


# #840-T157
@pytest.mark.parametrize(
    ("change", "accepted"),
    [
        ({}, True),
        ({"snapshot": False}, True),
        ({"snapshot": None}, False),
        ({"snapshot": "yes"}, False),
        ({"previousSummary": None}, True),
        ({"previousSummary": "x" * 8192}, True),
        ({"previousSummary": "x" * 8193}, False),
        ({"digest": None}, True),
        ({"digest": "x" * 16384}, True),
        ({"digest": "x" * 16385}, False),
        ({"digest": 3}, False),
        ({"previousSummary": ["a"]}, False),
        ({"somethingNew": True}, False),
    ],
)
def test_the_runner_and_the_schema_agree_on_the_new_fields_of_the_resume(
    change: dict[str, Any], accepted: bool
) -> None:
    resume = {**_implementer_example("ImplementerResume"), **change}

    assert _accepts("runner-api.v1.json", "ImplementerResume", resume) is accepted
    try:
        _job_with(resume)
        read = True
    except runner_job.JobError:
        read = False
    assert read is accepted


# #840-T158
def test_the_limits_are_counted_in_bytes_by_the_runner() -> None:
    """JSON Schema counts characters; the runner counts bytes, so four-byte characters reach the
    byte limit before the character limit (a text of 2049 of them is over 8 KiB)."""
    resume = {**_implementer_example("ImplementerResume"), "previousSummary": "\U0001f600" * 2049}

    assert _accepts("runner-api.v1.json", "ImplementerResume", resume)
    with pytest.raises(runner_job.JobError):
        _job_with(resume)
