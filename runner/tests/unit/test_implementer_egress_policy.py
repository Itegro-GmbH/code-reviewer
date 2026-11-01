# SPDX-License-Identifier: LicenseRef-Proprietary

"""Which hosts the Implementer agent's egress proxy tunnels to, and to which addresses (#763).

The proxy is the only way out the agent's tools have. These tables pin the decision before any
socket is involved: the form of the CONNECT target, the allowlist match and the judgement of what
the name resolved to.
"""

import pytest

from code_reviewer_runner.implementer.egress_policy import (
    DEFAULT_ALLOWLIST,
    EgressAllowlist,
    EgressRefused,
    Refusal,
    check_resolved,
    judge_authority,
)

WILDCARDS = EgressAllowlist(("*.pkg.test", "exact.example.test"))


def refusal_of(authority: str, allowlist: EgressAllowlist = DEFAULT_ALLOWLIST) -> Refusal:
    with pytest.raises(EgressRefused) as refused:
        judge_authority(authority, allowlist)
    return refused.value.reason


# #763-T02
@pytest.mark.parametrize(
    ("authority", "host"),
    [
        ("registry.npmjs.org:443", "registry.npmjs.org"),
        ("REGISTRY.NPMJS.ORG:443", "registry.npmjs.org"),
        ("Registry.Npmjs.Org.:443", "registry.npmjs.org"),
        ("registry.yarnpkg.com:443", "registry.yarnpkg.com"),
        ("pypi.org:443", "pypi.org"),
        ("files.pythonhosted.org:443", "files.pythonhosted.org"),
        ("index.crates.io:443", "index.crates.io"),
        ("static.crates.io:443", "static.crates.io"),
    ],
)
def test_the_default_hosts_are_allowed_in_any_case_and_with_a_trailing_dot(
    authority: str, host: str
) -> None:
    assert judge_authority(authority, DEFAULT_ALLOWLIST) == host


# #763-T02
def test_the_default_allowlist_is_exactly_the_package_registries() -> None:
    assert DEFAULT_ALLOWLIST.entries == (
        "registry.npmjs.org",
        "registry.yarnpkg.com",
        "pypi.org",
        "files.pythonhosted.org",
        "index.crates.io",
        "static.crates.io",
    )


# #763-T02
@pytest.mark.parametrize(
    "authority",
    [
        "github.com:443",
        "api.github.com:443",
        "codeload.github.com:443",
        "npmjs.org:443",  # the apex of a registry is not the registry
        "evil.registry.npmjs.org:443",  # no wildcard in the default list
        "registry.npmjs.org.evil.com:443",
        "xregistry.npmjs.org:443",
        "proxy.golang.org:443",  # a fetcher: it fetches any host named in the path
        "sum.golang.org:443",
        "localhost:443",
        "metadata.google.internal:443",
        "dispatcher.internal:443",
    ],
)
def test_every_other_host_is_refused_as_not_allowed(authority: str) -> None:
    assert refusal_of(authority) is Refusal.NOT_ALLOWED


# #763-T02
@pytest.mark.parametrize(
    "authority",
    [
        "registry.npmjs.org:80",
        "registry.npmjs.org:8443",
        "registry.npmjs.org:0443",
        "registry.npmjs.org:+443",
        "registry.npmjs.org:443.0",
        "registry.npmjs.org:",
        "registry.npmjs.org",
        "registry.npmjs.org:65536",
    ],
)
def test_only_port_443_exactly_is_tunnelled(authority: str) -> None:
    assert refusal_of(authority) in (Refusal.PORT, Refusal.MALFORMED)
    assert not _allowed(authority)


# #763-T02
@pytest.mark.parametrize(
    "authority",
    [
        "1.2.3.4:443",
        "151.101.0.1:443",
        "127.0.0.1:443",
        "169.254.169.254:443",
        "10.0.0.1:443",
        "[::1]:443",
        "[2606:4700::1111]:443",
        "[::ffff:127.0.0.1]:443",
        "2130706433:443",  # 127.0.0.1 as one number
        "0x7f.0.0.1:443",
        "0177.0.0.1:443",
        "127.1:443",
        "1.2.3.4.:443",
    ],
)
def test_ip_literals_in_every_spelling_are_refused(authority: str) -> None:
    assert refusal_of(authority) is Refusal.IP_LITERAL


# #763-T02
@pytest.mark.parametrize(
    "authority",
    [
        "user@registry.npmjs.org:443",
        "user:password@registry.npmjs.org:443",
        "registry.npmjs.org@evil.example:443",
        "registry.npmjs.org%40evil.example:443",
        "@registry.npmjs.org:443",
    ],
)
def test_userinfo_is_refused(authority: str) -> None:
    assert refusal_of(authority) in (Refusal.USERINFO, Refusal.MALFORMED)
    assert not _allowed(authority)


# #763-T02
@pytest.mark.parametrize(
    "authority",
    [
        "",
        ":443",
        ".:443",
        "registry..npmjs.org:443",
        "registry.npmjs.org..:443",
        ".registry.npmjs.org:443",
        " registry.npmjs.org:443",
        "registry.npmjs.org :443",
        "registry.npmjs.org:443 ",
        "registry.npmjs.org:443/",
        "registry.npmjs.org/x:443",
        "registry.npmjs.org\x00.evil.example:443",
        "registry.npmjs.org\r\nHost: evil.example:443",
        "registry.npmjs.org\\.evil.example:443",
        "https://registry.npmjs.org:443",
        "registry.npmjs.org:443:443",
        "régistry.npmjs.org:443",  # an internationalised name must arrive as punycode
        "registry.npmjs.org:443\u2028",
        "a" * 300 + ".npmjs.org:443",
        "-registry.npmjs.org:443",
    ],
)
def test_an_odd_target_is_malformed_and_never_allowed(authority: str) -> None:
    assert not _allowed(authority)


# #763-T02
def test_a_name_that_only_lowercases_to_an_allowed_one_is_malformed_not_allowed() -> None:
    kelvin = "\u212a"  # KELVIN SIGN: not ASCII, but `str.lower()` turns it into "k"
    assert kelvin.lower() == "k"
    assert judge_authority("registry.yarnpkg.com:443", DEFAULT_ALLOWLIST) == "registry.yarnpkg.com"
    assert refusal_of(f"registry.yarnp{kelvin}g.com:443") is Refusal.MALFORMED
    assert refusal_of(f"REGISTRY.YARNP{kelvin}G.COM:443") is Refusal.MALFORMED


# #763-T02
def test_a_punycode_label_is_only_allowed_where_the_list_names_or_covers_it() -> None:
    assert refusal_of("xn--rgistry-0ra.npmjs.org:443") is Refusal.NOT_ALLOWED
    assert judge_authority("xn--pkg-9la.pkg.test:443", WILDCARDS) == "xn--pkg-9la.pkg.test"
    assert refusal_of("pkgé.pkg.test:443", WILDCARDS) is Refusal.MALFORMED


# #763-T02
def test_a_wildcard_matches_one_label_below_it_and_never_the_apex() -> None:
    assert judge_authority("a.pkg.test:443", WILDCARDS) == "a.pkg.test"
    assert judge_authority("A.PKG.TEST.:443", WILDCARDS) == "a.pkg.test"
    assert judge_authority("exact.example.test:443", WILDCARDS) == "exact.example.test"
    assert refusal_of("pkg.test:443", WILDCARDS) is Refusal.NOT_ALLOWED
    assert refusal_of("a.b.pkg.test:443", WILDCARDS) is Refusal.NOT_ALLOWED
    assert refusal_of("evilpkg.test:443", WILDCARDS) is Refusal.NOT_ALLOWED
    assert refusal_of("pkg.test.evil.example:443", WILDCARDS) is Refusal.NOT_ALLOWED
    assert refusal_of("other.example.test:443", WILDCARDS) is Refusal.NOT_ALLOWED
    assert refusal_of("sub.exact.example.test:443", WILDCARDS) is Refusal.NOT_ALLOWED


# #763-T02
@pytest.mark.parametrize(
    "entries",
    [
        ("*",),
        ("*.com",),
        ("*.*.example.test",),
        ("a.*.example.test",),
        ("*example.test",),
        ("1.2.3.4",),
        ("[::1]",),
        ("localhost",),
        ("Example.Test",),
        ("example.test.",),
        ("user@example.test",),
        ("example.test:443",),
        ("",),
        ("régistry.example.test",),
    ],
)
def test_an_allowlist_that_is_too_broad_or_not_a_plain_name_cannot_be_built(
    entries: tuple[str, ...],
) -> None:
    with pytest.raises(ValueError, match="allowlist"):
        EgressAllowlist(entries)


# #763-T03
@pytest.mark.parametrize(
    "address",
    [
        "127.0.0.1",
        "127.255.255.254",
        "10.0.0.1",
        "10.255.255.255",
        "172.16.0.1",
        "192.168.1.1",
        "169.254.169.254",  # cloud metadata
        "169.254.0.1",
        "100.64.0.1",
        "0.0.0.0",
        "224.0.0.1",
        "255.255.255.255",
        "192.0.2.1",
        "::1",
        "::",
        "fc00::1",
        "fd12:3456::1",
        "fe80::1",
        "fd00:ec2::254",  # the IPv6 metadata address of AWS
        "::ffff:127.0.0.1",
        "::ffff:169.254.169.254",
        "64:ff9b::7f00:1",
        "2002:7f00:1::1",
    ],
)
def test_names_that_resolve_to_a_private_loopback_link_local_or_metadata_address_are_refused(
    address: str,
) -> None:
    with pytest.raises(EgressRefused) as refused:
        check_resolved([address])
    assert refused.value.reason is Refusal.ADDRESS


# #763-T03
def test_one_bad_address_among_good_ones_refuses_the_name() -> None:
    # The connection may pick any address of the answer, so one that must not be used spoils all.
    with pytest.raises(EgressRefused) as refused:
        check_resolved(["151.101.0.1", "10.0.0.5"])
    assert refused.value.reason is Refusal.ADDRESS


# #763-T03
def test_a_name_that_resolves_to_nothing_is_refused() -> None:
    with pytest.raises(EgressRefused) as refused:
        check_resolved([])
    assert refused.value.reason is Refusal.UNRESOLVED


# #763-T03
def test_public_addresses_pass() -> None:
    check_resolved(["151.101.0.1", "2606:4700:4700::1111"])


def _allowed(authority: str) -> bool:
    try:
        judge_authority(authority, DEFAULT_ALLOWLIST)
    except EgressRefused:
        return False
    return True
