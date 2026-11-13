# SPDX-License-Identifier: LicenseRef-Proprietary

"""The per-VM token the host checks (#978): the shared vectors of
`contracts/control-token-vectors.json`, which `dispatcher/src/launchers/control-token.ts` reads too,
and the shape and randomness of a token."""

import json
from pathlib import Path
from typing import Any

import pytest

from code_reviewer_runner.factory_runner.firecracker.tokens import (
    CONTROL_TOKEN_BYTES,
    TokenVerdict,
    control_token_matches,
    generate_control_token,
    is_control_token,
    verify_control_message,
    verify_exit_report,
)

pytestmark = pytest.mark.unit

VECTORS: dict[str, Any] = json.loads(
    (Path(__file__).resolve().parents[3] / "contracts" / "control-token-vectors.json").read_text()
)


# #978-T03
@pytest.mark.parametrize("case", VECTORS["cases"], ids=[c["name"] for c in VECTORS["cases"]])
def test_every_shared_vector_gets_the_verdict_the_typescript_host_gives(
    case: dict[str, Any],
) -> None:
    if case["kind"] == "control":
        verdict = verify_control_message(case["message"], VECTORS["token"])
    else:
        verdict = verify_exit_report(
            case["message"], expected=VECTORS["token"], start_acked=case["startAcked"]
        )

    assert verdict == TokenVerdict(case["verdict"])


# #978-T03
def test_a_token_is_random_of_the_contracts_shape_and_different_for_every_vm() -> None:
    first, second = generate_control_token(), generate_control_token()

    assert is_control_token(first)
    assert len(first) == -(-CONTROL_TOKEN_BYTES * 8 // 6)
    assert first != second


# #978-T03
def test_only_a_string_of_the_contracts_shape_is_a_token() -> None:
    token = generate_control_token()

    assert not is_control_token("short")
    assert not is_control_token(token + " ")
    assert not is_control_token(1)
    assert not is_control_token(None)


# #978-T03
def test_a_token_matches_only_itself() -> None:
    token, other = generate_control_token(), generate_control_token()

    assert control_token_matches(token, token)
    assert not control_token_matches(other, token)
    assert not control_token_matches(token[:-1], token)
    assert not control_token_matches(token + "x", token)
    for received in ("", None, 1, b"bytes", ["x"]):
        assert not control_token_matches(received, token)
