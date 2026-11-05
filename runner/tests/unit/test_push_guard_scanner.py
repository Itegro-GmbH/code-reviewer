# SPDX-License-Identifier: LicenseRef-Proprietary

"""The bytes side of the push guard (#856): a form of the secret is found whatever the chunks are,
and a set with nothing to look for finds nothing."""

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
