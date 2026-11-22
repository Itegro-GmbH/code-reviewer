# SPDX-License-Identifier: LicenseRef-Proprietary

"""The package registries the network door lets the agent read and never write (#784).

A tunnel decides on the host name of the `CONNECT` and sees nothing inside it, so `npm publish`,
`twine upload`, `cargo publish` and `gem push` went through every list that named their registry,
and after the handshake any SNI and `Host` could go to the other tenants of the CDN address. For
the names below the door therefore does not tunnel: it ends the TLS connection itself
(`intercept.py`), lets `GET` and `HEAD` through to the name it checked and refuses everything else.

The table is an exit guard like the owner's list, nothing the engine is held to: a registry that is
not in it keeps being a tunnel. It names registry **domains**; a name is a registry name when it is
one of them or below one (`upload.pypi.org` is, so a list that names it reaches it read-only).

Only a rule of mode `list` that names at least one registry is intercepted (`rule_has_registries`):
with `open` the agent can `POST` to any public host anyway, and a list without a registry has
nothing to guard here.

**Read-only hosts of a rule (#1126).** A rule may also name hosts that are read like a registry
(`NetworkRule.read_only`): the Claude Code subscription turn lists them for the build and the
checks it runs (fonts, the site it looks at), and the login is in its container, so everything but
its API host is read-only (`claude_code/gates.py`). They go through the same gate, the same
`GET`/`HEAD` rule and the same door certificate, whose name constraint is the registries plus
these hosts (`intercepted_domains`).
"""

from collections.abc import Callable
from typing import Final

from ..network_rule import MODE_LIST, NetworkRule, RuleMatcher

# npm and Yarn, PyPI and its file host, crates.io, RubyGems.
REGISTRY_DOMAINS: Final = (
    "npmjs.org",
    "npmjs.com",
    "yarnpkg.com",
    "pypi.org",
    "pythonhosted.org",
    "crates.io",
    "rubygems.org",
)
# What a read of a registry is: nothing else is forwarded.
READ_METHODS: Final = frozenset({"GET", "HEAD"})


def is_registry_name(name: str) -> bool:
    """Whether `name` (comparison form) is a registry domain or a name below one."""
    return any(name == domain or name.endswith("." + domain) for domain in REGISTRY_DOMAINS)


def rule_has_registries(rule: NetworkRule) -> bool:
    """Whether the door ends TLS connections for the rule: it lists a registry name or a suffix of
    registry names, or it names read-only hosts (`NetworkRule.read_only`). Then the agent trusts
    the door's CA for them. False for `off`, `open` and a list without either."""
    if rule.mode != MODE_LIST:
        return False
    if rule.read_only:
        return True
    return any(is_registry_name(entry.removeprefix("*.")) for entry in rule.hosts)


def intercepted_domains(rule: NetworkRule) -> tuple[str, ...]:
    """The domains the door's certificate authority is limited to for this rule: the registries
    and the read-only hosts of the rule (a `*.` entry by its suffix)."""
    extra = tuple(entry.removeprefix("*.") for entry in rule.read_only)
    return tuple(dict.fromkeys((*REGISTRY_DOMAINS, *extra)))


def interceptor_for(rule: NetworkRule) -> Callable[[str], bool]:
    """Whether a name (comparison form) is read through the door's gate under this rule: a
    registry name, or one of the rule's read-only hosts."""
    read_only = RuleMatcher(NetworkRule(MODE_LIST, rule.read_only)) if rule.read_only else None

    def intercepts(name: str) -> bool:
        return is_registry_name(name) or (read_only is not None and read_only.allows(name))

    return intercepts
