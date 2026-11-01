# SPDX-License-Identifier: LicenseRef-Proprietary

"""What the Implementer agent's egress proxy tunnels to (#763): allowlist and target judgement.

The agent may reach package registries and nothing else. The allowlist is a constant of the
runner: no job, repository, tool or environment name can add to it (`egress_config.py` reads only
the network mode and the port). The proxy judges in two steps:

1. `judge_authority`: the target of a CONNECT is `host:443` with a plain, lowercase-able ASCII name
   on the list. IP literals in any spelling, user information, odd characters and every other port
   are refused before a name is looked up.
2. `check_resolved`: every address the name resolves to must be public (`passthrough/address.py`,
   the rule the model proxy applies to the provider). One loopback, private, link-local, metadata
   or otherwise special address refuses the name, because the connection may pick any of them.

A `*.` entry matches exactly one label below it and never the apex. Matching is on the name the
client asked for; the proxy cannot see inside the tunnel (SNI, `Host`), which is why only names
whose operators serve nothing else on those addresses belong on the list. A name whose service
fetches other hosts for the client (the Go module proxy fetches any host named in the path) is
never one of them: it would be a way out.
"""

import re
from collections.abc import Iterable
from dataclasses import dataclass
from enum import StrEnum
from typing import Final

from code_reviewer_runner.dynamic_review.passthrough.address import is_public_address

TUNNEL_PORT: Final = "443"
_LABEL: Final = r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?"
_NAME: Final = re.compile(rf"^{_LABEL}(\.{_LABEL})*$")
_ENTRY: Final = re.compile(rf"^(\*\.)?{_LABEL}(\.{_LABEL})+$")
_MAX_NAME: Final = 253
# The last label of an address in a spelling a resolver would accept: `127.1`, `0x7f.1`,
# `0177.0.0.1`, `2130706433`. A real top-level domain has a letter and does not start with `0x`.
_NUMERIC_TOP: Final = re.compile(r"^(0x[0-9a-f]*|[0-9]+)$")


class Refusal(StrEnum):
    """Why a target was not tunnelled. Stable: counted in the job log, never carries the target."""

    MALFORMED = "malformed"
    PORT = "port"
    IP_LITERAL = "ip_literal"
    USERINFO = "userinfo"
    NOT_ALLOWED = "not_allowed"
    ADDRESS = "address"
    UNRESOLVED = "unresolved"
    # Not a verdict on the target but on the request or the proxy's own state.
    NOT_CONNECT = "not_connect"
    HOST_HEADER = "host_header"
    UNREACHABLE = "unreachable"
    LIMIT = "limit"


class EgressRefused(Exception):
    """A target the proxy will not open. The text names the reason, never the target."""

    def __init__(self, reason: Refusal) -> None:
        super().__init__(reason.value)
        self.reason = reason


@dataclass(frozen=True)
class EgressAllowlist:
    """Exact names and `*.` wildcards, all lowercase ASCII. Built once from the runner's code."""

    entries: tuple[str, ...]

    def __post_init__(self) -> None:
        for entry in self.entries:
            if len(entry) > _MAX_NAME or _ENTRY.fullmatch(entry) is None:
                raise ValueError("the egress allowlist holds an entry that is not a plain name")
            if _NUMERIC_TOP.fullmatch(entry.rsplit(".", 1)[-1]):
                raise ValueError("the egress allowlist holds an IP address, not a name")
            suffix = entry.removeprefix("*.")
            if suffix == "localhost" or suffix.endswith((".localhost", ".local", ".internal")):
                raise ValueError("the egress allowlist holds a name that is only known privately")

    def matches(self, host: str) -> bool:
        """Whether `host` (normalised, see `judge_authority`) is on the list."""
        _, _, parent = host.partition(".")
        return any(
            host == entry or (entry.startswith("*.") and parent == entry[2:])
            for entry in self.entries
        )


DEFAULT_ALLOWLIST: Final = EgressAllowlist(
    (
        "registry.npmjs.org",
        "registry.yarnpkg.com",
        "pypi.org",
        "files.pythonhosted.org",
        "index.crates.io",
        "static.crates.io",
    )
)


def judge_authority(authority: str, allowlist: EgressAllowlist) -> str:
    """The normalised host of a CONNECT target `host:443` that may be tunnelled, or `EgressRefused`.

    Normalised means lowercase without the one trailing dot of an absolute name. Everything that
    is not a plain ASCII name followed by exactly `:443` is refused, and so is a name that is not
    on the list.
    """
    if not authority.isascii() or not authority.isprintable() or " " in authority:
        raise EgressRefused(Refusal.MALFORMED)
    if "@" in authority or "%" in authority:
        raise EgressRefused(Refusal.USERINFO)
    if authority.startswith("["):
        raise EgressRefused(Refusal.IP_LITERAL)
    host, separator, port = authority.rpartition(":")
    if not separator or not host or ":" in host or "/" in host or "\\" in host:
        raise EgressRefused(Refusal.MALFORMED)
    host = host.lower().removesuffix(".")
    top = host.rsplit(".", 1)[-1]
    if host and _NUMERIC_TOP.fullmatch(top):
        raise EgressRefused(Refusal.IP_LITERAL)
    if len(host) > _MAX_NAME or _NAME.fullmatch(host) is None:
        raise EgressRefused(Refusal.MALFORMED)
    if port != TUNNEL_PORT:
        raise EgressRefused(Refusal.PORT)
    if not allowlist.matches(host):
        raise EgressRefused(Refusal.NOT_ALLOWED)
    return host


def check_resolved(addresses: Iterable[str]) -> list[str]:
    """The addresses a name resolved to when every one of them is public, else `EgressRefused`."""
    found = list(addresses)
    if not found:
        raise EgressRefused(Refusal.UNRESOLVED)
    if not all(is_public_address(address) for address in found):
        raise EgressRefused(Refusal.ADDRESS)
    return found
