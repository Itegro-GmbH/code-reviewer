# SPDX-License-Identifier: LicenseRef-Proprietary

"""The delete commands of the refs a setup script made (#818), streamed from a listing."""

import threading
from collections.abc import Callable

import pytest

from code_reviewer_runner.implementer.git_process import Outcome
from code_reviewer_runner.implementer.ref_drop import RefDeletions, RefListingFailed

pytestmark = pytest.mark.unit


def listing_of(chunks: list[bytes], code: int = 0) -> Callable[[Callable[[bytes], None]], Outcome]:
    def listing(consume: Callable[[bytes], None]) -> Outcome:
        for chunk in chunks:
            consume(chunk)
        return Outcome(code, "", "")

    return listing


def test_every_branch_but_the_kept_ones_and_every_tag_becomes_a_delete_command() -> None:
    # Names are cut at any byte between chunks; a name that is not text is dropped like the rest.
    deletions = RefDeletions(
        listing_of(
            [
                b"refs/heads/main\0refs/hea",
                b"ds/tmp\0refs/tags/v1\0refs/heads/task\0refs/heads/\xff\xfe\0",
            ]
        ),
        {"main", "task"},
    )

    commands = b"".join(deletions)

    assert commands == (
        b"delete refs/heads/tmp\0\0delete refs/tags/v1\0\0delete refs/heads/\xff\xfe\0\0"
    )
    assert deletions.count == 3


def test_a_listing_that_ends_with_an_error_raises_at_its_end() -> None:
    deletions = RefDeletions(listing_of([b"refs/heads/a\0"], code=128), set())

    with pytest.raises(RefListingFailed):
        list(deletions)


def test_a_listing_that_breaks_half_way_raises() -> None:
    def broken(consume: Callable[[bytes], None]) -> Outcome:
        consume(b"refs/heads/a\0")
        raise OSError("the connection broke")

    with pytest.raises(RefListingFailed):
        list(RefDeletions(broken, set()))


def test_a_consumer_that_stops_early_does_not_leave_the_listing_blocked() -> None:
    threads = threading.active_count()
    many = [b"refs/heads/" + str(number).encode() + b"\0" for number in range(1000)]
    deletions = RefDeletions(listing_of(many), set())

    commands = iter(deletions)
    first = next(commands)
    commands.close()  # joins the listing's thread, which is told to stop

    assert first.startswith(b"delete refs/heads/")
    assert threading.active_count() == threads
