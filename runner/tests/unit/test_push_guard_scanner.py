# SPDX-License-Identifier: LicenseRef-Proprietary

"""The bytes side of the push guard (#856): a form of the secret is found whatever the chunks are,
and a set with nothing to look for finds nothing."""

import base64
from collections.abc import Callable

import pytest

from code_reviewer_runner.implementer.push_guard import MIN_SECRET_CHARS, SecretScanner

pytestmark = pytest.mark.unit

SECRET = "sk-" + "ant-" + "oat01-abcdefghijklmnop"


# #856-G07
def test_a_secret_split_over_two_chunks_is_found() -> None:
    data = f"before {SECRET} after".encode()
    for cut in range(1, len(data)):
        scanner = SecretScanner([SECRET])
        scanner.feed(data[:cut])
        assert scanner.feed(data[cut:]), cut


# #856-G07
def test_a_secret_split_over_many_tiny_chunks_is_found() -> None:
    scanner = SecretScanner([SECRET])
    data = f"x{SECRET}y".encode()
    results = [scanner.feed(data[i : i + 1]) for i in range(len(data))]
    assert results[-1] is True and scanner.found


# #856-G07
def test_text_without_the_secret_is_not_found_and_a_reset_forgets_the_tail() -> None:
    scanner = SecretScanner([SECRET])
    half = SECRET.encode()[:10]
    assert not scanner.feed(half)
    scanner.reset()
    assert not scanner.feed(SECRET.encode()[10:])


# #856-G07
def test_a_value_too_short_to_watch_is_not_watched() -> None:
    scanner = SecretScanner(["a" * (MIN_SECRET_CHARS - 1), "   ", ""])
    assert not scanner.active
    assert not scanner.feed(b"aaaaaaa aaaaaaa")


# #856-G08: base64 of a larger value that holds the login is found at any of the three alignments
@pytest.mark.parametrize(
    "encoder", [base64.b64encode, base64.urlsafe_b64encode], ids=["std", "urlsafe"]
)
@pytest.mark.parametrize("padded", [True, False], ids=["padded", "unpadded"])
@pytest.mark.parametrize("offset", [0, 1, 2])
@pytest.mark.parametrize("suffix", ["", "x", "xy"])
def test_base64_that_holds_the_secret_is_found_at_every_offset(
    encoder: Callable[[bytes], bytes], padded: bool, offset: int, suffix: str
) -> None:
    value = "p" * (3 + offset) + SECRET + suffix
    encoded = encoder(value.encode()).decode()
    encoded = encoded if padded else encoded.rstrip("=")
    data = f"key = {encoded}\n".encode()

    scanner = SecretScanner([SECRET])

    assert scanner.feed(data)


# #856-G08
@pytest.mark.parametrize("offset", [0, 1, 2])
def test_base64_at_an_offset_is_found_over_chunk_borders_too(offset: int) -> None:
    encoded = base64.b64encode(("q" * (6 + offset) + SECRET + "z").encode())
    scanner = SecretScanner([SECRET])

    results = [scanner.feed(encoded[i : i + 3]) for i in range(0, len(encoded), 3)]

    assert results[-1] is True


# #856-G08
def test_base64_of_something_else_is_not_found() -> None:
    other = base64.b64encode(
        ("q" * 4 + SECRET.replace("abcdefghijklmnop", "ABCDEFGHIJKLMNOP")).encode()
    )

    assert not SecretScanner([SECRET]).feed(other)
