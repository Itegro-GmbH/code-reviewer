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
nothing to guard here (the Claude Code subscription turn's list is one host).
"""

from typing import Final

from ..network_rule import MODE_LIST, NetworkRule

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
    """Whether the rule lists a registry name or a suffix of registry names: then the door ends the
    TLS connections to them and the agent trusts the door's CA for them. False for `off`, `open`
    and a list without one."""
    if rule.mode != MODE_LIST:
        return False
    return any(is_registry_name(entry.removeprefix("*.")) for entry in rule.hosts)
