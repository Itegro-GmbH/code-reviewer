# SPDX-License-Identifier: LicenseRef-Proprietary

"""The environment's network rule and its matcher (#745, step 7): what a list entry is, how a name
is brought to the one form it is compared in, and what each mode lets through. Pure logic."""

from typing import Any

import pytest

from code_reviewer_runner.implementer.netdoor.addresses import is_public
from code_reviewer_runner.implementer.network_rule import (
    MAX_HOSTS,
    MODE_LIST,
    MODE_OFF,
    MODE_OPEN,
    NetworkRule,
    RuleError,
    RuleMatcher,
    ascii_name,
    is_ip_literal,
    normalize_entry,
    parse_rule,
)

pytestmark = pytest.mark.unit


def listed(*hosts: str) -> RuleMatcher:
    return RuleMatcher(NetworkRule(MODE_LIST, hosts))


# -- the matcher -------------------------------------------------------------------------------


def test_an_exact_entry_matches_that_name_and_no_other() -> None:
    matcher = listed("registry.npmjs.org")
    assert matcher.allows("registry.npmjs.org")
    assert not matcher.allows("npmjs.org")
    assert not matcher.allows("evil.registry.npmjs.org")
    assert not matcher.allows("registry.npmjs.org.evil.com")
    assert not matcher.allows("xregistry.npmjs.org")


def test_a_suffix_entry_matches_every_name_below_it_and_not_the_name_itself() -> None:
    matcher = listed("*.pythonhosted.org")
    assert matcher.allows("files.pythonhosted.org")
    assert matcher.allows("a.b.pythonhosted.org")
    assert not matcher.allows("pythonhosted.org"), "the apex is its own entry"
    assert not matcher.allows("evilpythonhosted.org"), "the dot is part of the suffix"
    assert not matcher.allows("pythonhosted.org.evil.com")


def test_both_forms_can_be_listed_together() -> None:
    matcher = listed("github.com", "*.github.com")
    assert matcher.allows("github.com") and matcher.allows("api.github.com")


def test_off_allows_nothing_and_open_allows_every_name() -> None:
    assert not RuleMatcher(NetworkRule(MODE_OFF)).allows("registry.npmjs.org")
    assert RuleMatcher(NetworkRule(MODE_OPEN)).allows("anything.example")


# -- the comparison form ------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "form"),
    [
        ("Registry.NPMJS.org", "registry.npmjs.org"),
        ("registry.npmjs.org.", "registry.npmjs.org"),
        ("REGISTRY.npmjs.ORG.", "registry.npmjs.org"),
        ("bücher.example", "xn--bcher-kva.example"),
        ("xn--bcher-kva.example", "xn--bcher-kva.example"),
        ("münchen.de.", "xn--mnchen-3ya.de"),
        ("a-b.c", "a-b.c"),
    ],
)
def test_a_name_is_compared_lower_case_ascii_without_its_trailing_dot(raw: str, form: str) -> None:
    assert ascii_name(raw) == form


@pytest.mark.parametrize(
    "raw",
    [
        "",
        ".",
        "a..b",
        "-a.b",
        "a-.b",
        "a b.c",
        "a/b.c",
        "a:443",
        "a_b.c",
        "x" * 64 + ".com",
        ("a" * 60 + ".") * 5 + "com",
        "a.b\x00",
        "a.b\n",
        "‮a.b",
    ],
)
def test_a_string_that_is_not_a_dns_name_has_no_form(raw: str) -> None:
    assert ascii_name(raw) is None


def test_an_idn_name_matches_the_punycode_entry_and_the_other_way_round() -> None:
    matcher = listed("xn--bcher-kva.example", "*.xn--mnchen-3ya.de")
    assert matcher.allows(ascii_name("Bücher.Example.") or "")
    assert matcher.allows(ascii_name("www.münchen.de") or "")
    assert normalize_entry("Bücher.example") == "xn--bcher-kva.example"
    assert normalize_entry("*.München.de") == "*.xn--mnchen-3ya.de"


@pytest.mark.parametrize(
    "text",
    [
        "127.0.0.1",
        "10.1.2.3",
        "8.8.8.8",
        "[::1]",
        "::1",
        "[2001:db8::1]",
        "fe80::1%eth0",
        "2130706433",
        "0x7f000001",
        "0x7f.1",
        "127.1",
        "0177.0.0.1",
        "1.2.3.4.",
        "[::ffff:127.0.0.1]",
    ],
)
def test_an_ip_address_in_any_spelling_is_a_literal(text: str) -> None:
    assert is_ip_literal(text)


@pytest.mark.parametrize(
    "text", ["registry.npmjs.org", "a1.b2.example", "0x.example", "1password.com", "x"]
)
def test_a_host_name_is_not_a_literal(text: str) -> None:
    assert not is_ip_literal(text)


# -- the entry ----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "entry",
    [
        "10.0.0.1",
        "127.0.0.1",
        "*.com",
        "*",
        "*.",
        "com",
        "localhost",
        "Registry.npmjs.org",
        "registry.npmjs.org.",
        "registry.npmjs.org:443",
        "registry.npmjs.org/path",
        "https://registry.npmjs.org",
        "*.*.example.com",
        "a.*.example.com",
        "*example.com",
        "bücher.example",
        "[::1]",
        "foo.1",
        "foo.0x7f",
        " registry.npmjs.org",
        "",
    ],
)
def test_a_rule_refuses_an_entry_that_is_not_a_host_name_or_a_suffix_of_two_labels(
    entry: str,
) -> None:
    with pytest.raises(RuleError):
        parse_rule({"mode": "list", "hosts": [entry]})


# -- the rule of a job ---------------------------------------------------------------------------


def test_a_rule_of_each_mode_is_read_back() -> None:
    assert parse_rule({"mode": "off", "hosts": []}) == NetworkRule(MODE_OFF)
    assert parse_rule({"mode": "open", "hosts": []}) == NetworkRule(MODE_OPEN)
    rule = parse_rule({"mode": "list", "hosts": ["pypi.org", "*.pythonhosted.org", "pypi.org"]})
    assert rule == NetworkRule(MODE_LIST, ("pypi.org", "*.pythonhosted.org"))
    assert rule.to_json() == {"mode": "list", "hosts": ["pypi.org", "*.pythonhosted.org"]}


@pytest.mark.parametrize(
    "document",
    [
        None,
        [],
        "list",
        {},
        {"mode": "list"},
        {"hosts": []},
        {"mode": "list", "hosts": [], "extra": 1},
        {"mode": "closed", "hosts": []},
        {"mode": "list", "hosts": []},
        {"mode": "list", "hosts": "pypi.org"},
        {"mode": "list", "hosts": [1]},
        {"mode": "off", "hosts": ["pypi.org"]},
        {"mode": "open", "hosts": ["pypi.org"]},
        {"mode": "list", "hosts": [f"h{i}.example.com" for i in range(MAX_HOSTS + 1)]},
    ],
)
def test_a_rule_that_is_not_the_contracts_is_refused(document: Any) -> None:
    with pytest.raises(RuleError):
        parse_rule(document)


def test_the_longest_list_is_accepted_and_the_message_names_the_field_only() -> None:
    hosts = [f"h{i}.example.com" for i in range(MAX_HOSTS)]
    assert len(parse_rule({"mode": "list", "hosts": hosts}).hosts) == MAX_HOSTS
    with pytest.raises(RuleError) as caught:
        parse_rule({"mode": "list", "hosts": ["secret-looking.value", "bad host"]}, "net")
    assert "secret-looking" not in str(caught.value) and "bad host" not in str(caught.value)
    assert str(caught.value).startswith("net.hosts")


# -- the addresses --------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "address",
    [
        "0.0.0.1",
        "10.213.77.2",
        "10.0.0.1",
        "100.64.0.1",
        "100.127.255.254",
        "127.0.0.1",
        "169.254.169.254",
        "169.254.0.1",
        "172.16.0.1",
        "172.17.0.1",
        "172.31.255.255",
        "192.168.0.1",
        "192.0.0.8",
        "198.18.0.1",
        "224.0.0.1",
        "239.255.255.250",
        "255.255.255.255",
        "240.0.0.1",
        "::1",
        "not an address",
    ],
)
def test_a_private_special_or_metadata_address_is_not_public(address: str) -> None:
    assert not is_public(address)


@pytest.mark.parametrize(
    "address", ["1.1.1.1", "8.8.8.8", "104.16.0.1", "151.101.1.1", "172.32.0.1"]
)
def test_an_ordinary_address_is_public(address: str) -> None:
    assert is_public(address)
