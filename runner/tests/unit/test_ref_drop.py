# SPDX-License-Identifier: LicenseRef-Proprietary

"""The delete commands of the refs a setup script made (#818), streamed from a listing."""

import threading
from collections.abc import Callable

import pytest

from code_reviewer_runner.implementer.git_process import Outcome
from code_reviewer_runner.implementer.ref_drop import (
    MAX_REF_BYTES,
    MAX_REFS,
    RefDeletions,
    RefListingFailed,
    TooManyRefBytes,
    TooManyRefs,
)

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
        b"option no-deref\0delete refs/heads/tmp\0\0"
        b"option no-deref\0delete refs/tags/v1\0\0"
        b"option no-deref\0delete refs/heads/\xff\xfe\0\0"
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

    assert first.startswith(b"option no-deref\0delete refs/heads/")
    assert threading.active_count() == threads


# #827-T06
def test_a_script_that_made_more_refs_than_the_limit_ends_the_listing_with_a_reason() -> None:
    many = [b"refs/heads/b" + str(number).encode() + b"\0" for number in range(6)]
    deletions = RefDeletions(listing_of(many), set(), limit=5)

    with pytest.raises(TooManyRefs) as raised:
        list(deletions)

    assert isinstance(raised.value, RefListingFailed)
    assert "more than 5 branches and tags" in str(raised.value)
    assert deletions.count == 6, "the one past the limit is what stopped it"


# #827-T06
def test_exactly_the_limit_is_still_deleted_and_the_kept_branches_do_not_count() -> None:
    names = [b"refs/heads/b" + str(number).encode() + b"\0" for number in range(5)]
    deletions = RefDeletions(listing_of([*names, b"refs/heads/main\0"]), {"main"}, limit=5)

    assert len(list(deletions)) >= 1 and deletions.count == 5


# #827-T06
def test_the_limit_leaves_the_reader_room_and_the_listing_thread_is_gone_after_it() -> None:
    assert 1000 <= MAX_REFS <= 1_000_000
    threads = threading.active_count()
    many = [b"refs/tags/t" + str(number).encode() + b"\0" for number in range(50)]

    with pytest.raises(TooManyRefs):
        list(RefDeletions(listing_of(many), set(), limit=10))

    assert threading.active_count() == threads


# #827-N2
def test_names_that_are_longer_than_the_byte_limit_end_the_listing_with_a_reason() -> None:
    long_name = b"refs/heads/" + b"x" * 200
    names = [long_name + str(number).encode() + b"\0" for number in range(10)]
    deletions = RefDeletions(listing_of(names), set(), max_bytes=1000)

    with pytest.raises(TooManyRefBytes) as raised:
        list(deletions)

    assert isinstance(raised.value, RefListingFailed)
    assert "more than 1000 bytes" in str(raised.value)
    assert deletions.count < 10, "nothing past the limit is counted or sent on"


# #827-N2
def test_names_within_the_byte_limit_are_all_deleted_and_kept_ones_do_not_count() -> None:
    names = [b"refs/heads/b" + str(number).encode() + b"\0" for number in range(5)]
    deletions = RefDeletions(listing_of([*names, b"refs/heads/main\0"]), {"main"}, max_bytes=10_000)

    assert len(b"".join(deletions)) > 0 and deletions.count == 5


# #827-N2
def test_the_byte_limit_is_a_fraction_of_what_the_reader_holds() -> None:
    assert 1 << 20 <= MAX_REF_BYTES <= 128 << 20
