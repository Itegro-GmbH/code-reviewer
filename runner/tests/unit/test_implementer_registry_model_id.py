# SPDX-License-Identifier: LicenseRef-Proprietary

"""The model id of a task on a provider of the registry is a catalog model id.

The Implementer's agent is OpenCode and its model comes from the models.dev catalog, whose ids may
hold `@` (the app accepts them: `isCatalogModelId`). The registry's own rule for these two
providers (`_MODEL`) does not, so an Implementer job takes the catalog rule; a review job keeps
the registry rule, whatever the entry says."""

import json
from pathlib import Path
from typing import Any

import pytest

from code_reviewer_runner import job as runner_job
from code_reviewer_runner.result import ErrorCode

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts" / "examples" / "implementer"
FIXTURES = Path(__file__).resolve().parents[3] / "fakes" / "fixtures"
MODEL = "vendor/model@2026-11"

Document = dict[str, Any]


def _implementer_job(provider: str) -> Document:
    job: Document = json.loads((CONTRACTS / "RunnerJobInput.json").read_text(encoding="utf-8"))
    entry = job["implementer"]["modelEntry"]
    entry["providerId"] = provider
    entry["modelId"] = MODEL
    job["llm"]["provider"] = provider
    job["llm"]["model"] = MODEL
    if provider == "anthropic":
        entry["npm"] = "@ai-sdk/anthropic"
        entry["family"] = "anthropic-messages"
        entry["authHeader"] = "x-api-key"
        entry["upstreamBaseUrl"] = "https://api.anthropic.com/v1"
    return job


@pytest.mark.parametrize("provider", ["anthropic", "openrouter"])
def test_a_task_on_a_registry_provider_takes_a_model_id_with_an_at_sign(provider: str) -> None:
    parsed = runner_job.parse_implementer_input(json.dumps(_implementer_job(provider)))

    assert parsed.llm.provider == provider
    assert parsed.llm.model == MODEL


def test_a_task_still_refuses_a_model_id_the_catalog_rule_refuses() -> None:
    job = _implementer_job("anthropic")
    job["llm"]["model"] = "bad model"
    job["implementer"]["modelEntry"]["modelId"] = "bad model"

    with pytest.raises(runner_job.JobError) as refused:
        runner_job.parse_implementer_input(json.dumps(job))

    assert refused.value.code is ErrorCode.INVALID_JOB


# The rule is the Implementer's alone: a review on the same providers keeps the registry's.
def test_a_diff_review_on_a_registry_provider_still_refuses_an_at_sign() -> None:
    job: Document = json.loads(
        (FIXTURES / "previous-release-review-job.json").read_text(encoding="utf-8")
    )
    job["llm"]["model"] = MODEL

    with pytest.raises(runner_job.JobError) as refused:
        runner_job.parse_job(json.dumps(job))

    assert refused.value.code is ErrorCode.INVALID_JOB


def test_a_native_dynamic_review_on_a_registry_provider_still_refuses_an_at_sign() -> None:
    job: Document = json.loads(
        (FIXTURES / "dynamic-review-job-native-own.json").read_text(encoding="utf-8")
    )
    job["llm"]["model"] = MODEL
    job["dynamic"]["model"] = MODEL
    job["dynamic"]["modelEntry"]["modelId"] = MODEL

    with pytest.raises(runner_job.JobError) as refused:
        runner_job.parse_job(json.dumps(job))

    assert refused.value.code is ErrorCode.INVALID_JOB
