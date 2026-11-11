# SPDX-License-Identifier: LicenseRef-Proprietary

"""The drop counters of the outer wall's table, before and after a job (#999; the review of #994;
not a test file).

A lane that shows a client reached its target through the proxy shows only half of "nothing goes
round it": a client that dialled directly *and was dropped* would fall back to the proxy, or fail
quietly, and the job would still pass. The table counts every packet it drops, rule by rule, so
the negative side is read there: a job that ran with the table loaded must leave every drop
counter where it was. `NFT -j` prints each rule with its comment and counter; this reads that.

    wall_counters.py none <before.json> <after.json>    exit 1 and name every rule whose drop
                                                         counter moved (but the allowed ones)
    wall_counters.py some <before.json> <after.json>    the control: exit 1 unless at least one
                                                         drop counter moved (a table whose
                                                         counters never move proves nothing)

`before.json` and `after.json` are `nft -j list table inet code_reviewer_wall`, taken as root by the
workflow. Reloading the table between the two (a counter that went down) is an error: nothing can
be said about what happened in between.

**The one rule that may move** is "no IPv6": the guest kernel may send router solicitations or
multicast listener reports on its TAP whatever a client does, and the table drops them. A client
cannot reach the internet over IPv6 whether or not it is dropped (the guest has no IPv6 route and
the containers have IPv6 switched off), so a count there says nothing about the proxy. Every other
drop (a packet to the host's other ports, to anything forwarded, from a source that is not the
slot's) is a client that did not use the proxy."""

import json
import sys
from pathlib import Path
from typing import Any, Final, cast

TABLE: Final = "code_reviewer_wall"
# The comment of the rule that drops IPv6 (docker/vm/host/outer-wall.nft); the rest is a bypass.
ALLOWED: Final = frozenset({"input: no IPv6"})


class TableReloaded(Exception):
    """A counter is lower than it was: the table was loaded again between the two snapshots."""


def _objects(document: dict[str, Any]) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    entries = cast("list[object]", document.get("nftables", []))
    for entry in entries:
        rule = cast("dict[str, Any]", entry).get("rule") if isinstance(entry, dict) else None
        if isinstance(rule, dict):
            found.append(cast("dict[str, Any]", rule))
    return found


def drop_counters(document: dict[str, Any]) -> dict[str, tuple[int, int]]:
    """The (packets, bytes) of every rule of the table that drops, by `<chain>: <comment>`."""
    counters: dict[str, tuple[int, int]] = {}
    for rule in _objects(document):
        if rule.get("table") != TABLE:
            continue
        expressions: list[dict[str, Any]] = [
            each for each in rule.get("expr", []) if isinstance(each, dict)
        ]
        if not any("drop" in each for each in expressions):
            continue
        counter = next((each["counter"] for each in expressions if "counter" in each), None)
        if counter is None:
            continue
        name = f"{rule.get('chain')}: {rule.get('comment') or rule.get('handle')}"
        counters[name] = (int(counter["packets"]), int(counter["bytes"]))
    return counters


def moved(before: dict[str, tuple[int, int]], after: dict[str, tuple[int, int]]) -> dict[str, int]:
    """The rules whose packet count grew, with by how much."""
    grown: dict[str, int] = {}
    for name, (packets, _) in after.items():
        was = before.get(name, (0, 0))[0]
        if packets < was:
            raise TableReloaded(name)
        if packets > was:
            grown[name] = packets - was
    return grown


def unexpected(grown: dict[str, int]) -> dict[str, int]:
    """What moved that is not the allowed noise."""
    return {name: count for name, count in grown.items() if name not in ALLOWED}


def _load(path: str) -> dict[str, tuple[int, int]]:
    return drop_counters(json.loads(Path(path).read_text(encoding="utf-8")))


def main(arguments: list[str]) -> int:
    if len(arguments) != 3 or arguments[0] not in ("none", "some"):
        print("usage: wall_counters.py none|some <before.json> <after.json>", file=sys.stderr)
        return 2
    expectation, first, second = arguments
    before, after = _load(first), _load(second)
    if not after:
        print("no drop counter in the table: is it the table of the wall?")
        return 1
    try:
        grown = moved(before, after)
    except TableReloaded as error:
        print(f"the table was loaded again between the snapshots ({error}): nothing can be said")
        return 1
    for name, (packets, size) in sorted(after.items()):
        print(f"  {name}: {packets} packets, {size} bytes (+{grown.get(name, 0)})")
    if expectation == "some":
        if not grown:
            print("no drop counter moved: the control proves nothing")
            return 1
        print(f"the control: {len(grown)} drop counters moved")
        return 0
    bypass = unexpected(grown)
    if bypass:
        for name, count in sorted(bypass.items()):
            print(f"a packet that did not use the proxy was dropped: {name} (+{count})")
        return 1
    print("no drop counter moved (but the allowed noise): nothing went round the proxy")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
