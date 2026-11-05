# SPDX-License-Identifier: LicenseRef-Proprietary

"""Pins down secret redaction: the exact secrets of a job are replaced wherever they appear (also
quoted or encoded), well known token shapes are replaced even when the runner does not know them,
and the streams PR-Agent writes to cannot leak a secret that is split across writes."""

import base64
import io
from collections.abc import Callable
from urllib.parse import quote

import pytest

from code_reviewer_runner.redaction import REDACTED, RedactingStream, Redactor

TOKEN = "dummy-installation-token-0123456789"
API_KEY = "dummy-openrouter-key-0123456789"


# CR-10-T07
def test_every_secret_of_the_job_is_replaced_by_the_marker() -> None:
    redactor = Redactor([TOKEN, API_KEY])

    text = redactor.redact(f"token={TOKEN} key={API_KEY} again {TOKEN}")

    assert text == f"token={REDACTED} key={REDACTED} again {REDACTED}"


def test_url_quoted_and_base64_forms_of_a_secret_are_replaced_too() -> None:
    secret = "abc/def+ghi=jkl mno"
    redactor = Redactor([secret])
    encoded = base64.b64encode(secret.encode()).decode()

    text = redactor.redact(f"{quote(secret, safe='')} {encoded} {quote(secret)}")

    assert secret not in text
    assert encoded not in text
    assert "abc%2Fdef" not in text


def test_a_secret_that_contains_another_one_is_replaced_completely() -> None:
    redactor = Redactor(["secret", "secret-with-suffix"])

    assert redactor.redact("x secret-with-suffix y") == f"x {REDACTED} y"


def test_empty_secrets_are_ignored_instead_of_matching_everywhere() -> None:
    assert Redactor(["", "   "]).redact("unchanged text") == "unchanged text"


def test_well_known_token_shapes_are_replaced_without_knowing_the_value() -> None:
    redactor = Redactor([])
    samples = [
        "ghp_" + "a" * 36,
        "gho_" + "b" * 36,
        "ghs_" + "c" * 36,
        "github_pat_" + "d" * 40,
        "sk-or-v1-" + "e" * 40,
        "sk-" + "f" * 40,
        "Authorization: Bearer abcdef0123456789",
        "https://x-access-token:supersecret@github.com/o/r.git",
    ]

    for sample in samples:
        assert redactor.redact(f"before {sample} after") != f"before {sample} after", sample

    assert "supersecret" not in redactor.redact(samples[-1])
    assert "abcdef0123456789" not in redactor.redact(samples[-2])


def test_ordinary_text_is_left_alone() -> None:
    text = "Reviewing PR: https://github.com/octo/repo/pull/7 with model deepseek/deepseek-chat"

    assert Redactor([TOKEN]).redact(text) == text


# CR-10-T07
def test_a_secret_written_in_two_pieces_is_still_redacted_in_the_stream() -> None:
    target = io.StringIO()
    stream = RedactingStream(target, Redactor([TOKEN]))

    stream.write(TOKEN[:10])
    stream.write(TOKEN[10:] + " done\n")
    stream.flush()

    assert target.getvalue() == f"{REDACTED} done\n"


def test_the_stream_holds_back_an_unfinished_line_until_it_ends_or_closes() -> None:
    target = io.StringIO()
    stream = RedactingStream(target, Redactor([TOKEN]))

    stream.write("partial " + TOKEN[:8])
    stream.flush()
    assert target.getvalue() == ""

    stream.close()
    assert target.getvalue() == "partial " + TOKEN[:8]


def test_a_secret_that_straddles_the_release_of_a_very_long_line_is_still_redacted() -> None:
    target = io.StringIO()
    stream = RedactingStream(target, Redactor([TOKEN]), max_line_chars=1000)

    stream.write("x" * 990 + TOKEN[:20])
    stream.write(TOKEN[20:] + "y" * 600)
    stream.write("z" * 600)
    stream.close()

    output = target.getvalue()
    assert TOKEN not in output
    assert TOKEN[:20] not in output
    assert output.count(REDACTED) == 1
    assert output.count("x") == 990
    assert output.count("y") == 600
    assert output.count("z") == 600


ALIGNMENT_SECRET = "tok_" + "Zq9Lm3XvTn8Rk5Wc2Yb7"
ENCODERS: dict[str, Callable[[bytes], bytes]] = {
    "std": base64.b64encode,
    "urlsafe": base64.urlsafe_b64encode,
}


def shifted(prefix: str, suffix: str, encoder: str, *, padded: bool) -> str:
    """The secret between a prefix and a suffix, base64 encoded as a whole: the text a tool prints
    when it encodes a larger value that holds the secret."""
    text = ENCODERS[encoder]((prefix + ALIGNMENT_SECRET + suffix).encode()).decode()
    return text if padded else text.rstrip("=")


# #856-T43: base64 is found where the secret starts at any of the three positions of a group
@pytest.mark.unit
@pytest.mark.parametrize("encoder", sorted(ENCODERS))
@pytest.mark.parametrize("padded", [True, False], ids=["padded", "unpadded"])
@pytest.mark.parametrize(
    "prefix", ["", "a", "ab", "abc", "abcd"], ids=lambda v: f"offset{len(v) % 3}+{len(v)}"
)
@pytest.mark.parametrize("suffix", ["", "x", "xy", "xyz"], ids=lambda v: f"tail{len(v)}")
def test_base64_of_a_larger_value_that_holds_the_secret_is_replaced_at_any_alignment(
    encoder: str, padded: bool, prefix: str, suffix: str
) -> None:
    redactor = Redactor([ALIGNMENT_SECRET])
    encoded = shifted(prefix, suffix, encoder, padded=padded)

    text = redactor.redact(f"value={encoded};")

    assert REDACTED in text
    # What is left of the encoded value is the prefix, the suffix and the edges.
    left = len(text.replace(REDACTED, "")) - len("value=;")
    assert left <= (len(prefix) + 2) // 3 * 4 + (len(suffix) + 2) // 3 * 4 + 4


# #856-T43
@pytest.mark.unit
def test_text_that_only_looks_like_base64_is_left_alone() -> None:
    redactor = Redactor([ALIGNMENT_SECRET])
    other = base64.b64encode(("tok_" + "Aq9Lm3XvTn8Rk5Wc2Yb7").encode()).decode()

    assert redactor.redact(other) == other
