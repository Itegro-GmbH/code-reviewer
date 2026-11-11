# SPDX-License-Identifier: LicenseRef-Proprietary

"""The alias map of Claude Code models (#980): the runner's copy is the contract's, and answers its
test vectors (the app's copy runs the same ones)."""

import json
from pathlib import Path

import pytest

from code_reviewer_runner.implementer.claude_code.model_names import (
    ALIAS_ID_PATTERNS,
    models_match,
)

pytestmark = pytest.mark.contract

CONTRACT = json.loads(
    (Path(__file__).parents[3] / "contracts" / "claude-model-aliases.v1.json").read_text()
)


def test_the_runners_map_is_the_contracts() -> None:
    assert ALIAS_ID_PATTERNS == {entry["alias"]: entry["idPattern"] for entry in CONTRACT["aliases"]}


@pytest.mark.parametrize(
    "vector", CONTRACT["vectors"], ids=lambda v: f"{v['announced']}~{v['demanded']}"
)
def test_the_runner_answers_every_vector_of_the_contract(vector: dict[str, object]) -> None:
    assert models_match(str(vector["announced"]), str(vector["demanded"])) is vector["match"]


def test_the_default_aliases_of_a_credential_are_in_the_map() -> None:
    from code_reviewer_runner.implementer.claude_code.credentials import DEFAULT_MODELS

    assert set(DEFAULT_MODELS) <= set(ALIAS_ID_PATTERNS)
