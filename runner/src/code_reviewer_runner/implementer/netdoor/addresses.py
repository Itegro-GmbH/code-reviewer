# SPDX-License-Identifier: LicenseRef-Proprietary

"""Which addresses the network door will connect to, and how it looks a name up (#745, step 7).

The door connects to **the address it checked**: `resolve_public` returns the addresses of a name
and says whether every one of them is public; the connection is then made to one of those, never to
the name again, so a resolver that answers differently the second time (DNS rebinding) changes
nothing. A name that resolves to a public and a private address is refused as a whole: the agent
cannot be left to guess which one a library takes.

Only IPv4 is looked up. The door's container has IPv6 switched off (the rules that close the door's
egress are an `ip` table, which does not see IPv6), so a name with only an AAAA record is not
reachable through it.

**The test network.** A CI runner may have no internet, and the lane has to prove a connection
through the door to a name that "looks public". `NETDOOR_TEST_PUBLIC_CIDR` (a variable of the
door's own environment, set by the test seam of the launcher and never by `door_document`)
names one network inside `TEST_PUBLIC_LIMIT` that the check treats as public. Outside that range
it is ignored, so even a value that reached the environment cannot open a private range of the VM.
"""

import ipaddress
import os
import socket
from collections.abc import Callable
from dataclasses import dataclass
from typing import Final

# Every range a connection from the door must not go to: the VM, its neighbours, the other
# containers, the platform's services, the metadata address (inside link-local), shared address
# space, the special-purpose and documentation ranges, multicast and the reserved block (which holds
# the broadcast address). The same list, with a few more, as the door's egress table
# (`door_launcher.PRIVATE_RANGES`): the table drops what the process should not have tried.
BLOCKED_V4: Final = tuple(
    ipaddress.IPv4Network(text)
    for text in (
        "0.0.0.0/8",
        "10.0.0.0/8",
        "100.64.0.0/10",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "172.16.0.0/12",
        "192.0.0.0/24",
        "192.0.2.0/24",
        "192.88.99.0/24",
        "192.168.0.0/16",
        "198.18.0.0/15",
        "198.51.100.0/24",
        "203.0.113.0/24",
        "224.0.0.0/3",
    )
)
TEST_PUBLIC_VARIABLE: Final = "NETDOOR_TEST_PUBLIC_CIDR"
# The only range the test network may be in: a /24 next to the model network (10.213.77.0/29), which
# nothing else on a VM uses.
TEST_PUBLIC_LIMIT: Final = ipaddress.IPv4Network("10.213.99.0/24")

Resolver = Callable[[str, int], list[str]]


def system_resolver(name: str, port: int) -> list[str]:
    """The IPv4 addresses of `name`, in the order the resolver gave them, without repeats. Raises
    `OSError` when it has none or the lookup failed."""
    found = socket.getaddrinfo(name, port, socket.AF_INET, socket.SOCK_STREAM)
    return list(dict.fromkeys(str(entry[4][0]) for entry in found))


def ci_public_network(environ: dict[str, str] | None = None) -> ipaddress.IPv4Network | None:
    """The network the variable names, when it is one inside `TEST_PUBLIC_LIMIT`; else None."""
    value = (os.environ if environ is None else environ).get(TEST_PUBLIC_VARIABLE, "").strip()
    if not value:
        return None
    try:
        network = ipaddress.IPv4Network(value)
    except ValueError:
        return None
    return network if network.subnet_of(TEST_PUBLIC_LIMIT) else None


def is_public(address: str, test_network: ipaddress.IPv4Network | None = None) -> bool:
    """Whether the door may connect to `address`. False for anything that is not a plain IPv4
    address."""
    try:
        ip = ipaddress.IPv4Address(address)
    except ValueError:
        return False
    if test_network is not None and ip in test_network:
        return True
    return not any(ip in blocked for blocked in BLOCKED_V4)


@dataclass(frozen=True)
class Resolution:
    """What a lookup came to: the checked addresses, or the reason word of the refusal."""

    addresses: tuple[str, ...] = ()
    reason: str | None = None


REASON_UNRESOLVABLE: Final = "unresolvable"
REASON_PRIVATE: Final = "private_address"


def resolve_public(
    name: str,
    port: int,
    resolver: Resolver = system_resolver,
    test_network: ipaddress.IPv4Network | None = None,
) -> Resolution:
    """Look `name` up and check every address. The addresses are those to connect to."""
    try:
        found = resolver(name, port)
    except (OSError, UnicodeError, ValueError):
        return Resolution(reason=REASON_UNRESOLVABLE)
    if not found:
        return Resolution(reason=REASON_UNRESOLVABLE)
    if not all(is_public(address, test_network) for address in found):
        return Resolution(reason=REASON_PRIVATE)
    return Resolution(addresses=tuple(found))
