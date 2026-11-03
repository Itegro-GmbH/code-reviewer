# SPDX-License-Identifier: LicenseRef-Proprietary

"""The environment's rule for the agent's network (#745, step 7) and the matcher the network door
decides with.

The rule is the owner's: `off` (no network, no door), `list` (the host names the owner wrote, each
exact or a suffix) or `open` (any public name). This is the one place of the sandbox where a closed
list belongs, because the network door is an exit; everything else the agent does stays free.

A name is compared in one form only: lower-case ASCII, IDNA (punycode) for a name written in
Unicode, one trailing dot removed. A list entry is held to that form already (the app writes it so
and the runner checks it), a name that arrives in a request is brought to it first.

* `registry.npmjs.org` matches that name and no other.
* `*.pythonhosted.org` matches every name below `pythonhosted.org` (`files.pythonhosted.org`,
  `a.b.pythonhosted.org`) and not `pythonhosted.org` itself: whoever wants both writes both. A
  suffix has at least two labels after the `*.`, so `*.com` is not a rule (that is `open` with
  another name).
* An IP address is never an entry and never a name: a request to one is refused in every mode
  (`is_ip_literal`, which also takes the old forms a resolver would read as one: `2130706433`,
  `0x7f.1`, `127.1`).
"""

import ipaddress
import re
from dataclasses import dataclass
from typing import Any, Final

MODE_OFF: Final = "off"
MODE_LIST: Final = "list"
MODE_OPEN: Final = "open"
MODES: Final = (MODE_OFF, MODE_LIST, MODE_OPEN)
MAX_HOSTS: Final = 100
MAX_NAME_CHARS: Final = 253
MAX_LABEL_CHARS: Final = 63

_LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")
# What a resolver's `inet_aton` reads as an address: one to four numbers, decimal or `0x` hex.
_OLD_ADDRESS = re.compile(r"(?:0x[0-9a-f]*|[0-9]+)(?:\.(?:0x[0-9a-f]*|[0-9]+)){0,3}", re.IGNORECASE)


class RuleError(ValueError):
    """A rule that is not one. The text names the field and never holds a value of the rule."""


def is_ip_literal(text: str) -> bool:
    """Whether `text` is an IP address in any spelling a connect call or a resolver could accept:
    IPv4 or IPv6 (brackets, a zone), or the old numeric forms of IPv4."""
    candidate = text.strip()
    if not candidate:
        return False
    if ":" in candidate or "[" in candidate or "%" in candidate:
        return True
    if _OLD_ADDRESS.fullmatch(candidate.rstrip(".")) is not None:
        return True
    try:
        ipaddress.ip_address(candidate)
    except ValueError:
        return False
    return True


def ascii_name(raw: str) -> str | None:
    """The comparison form of a host name, or None when it is not a plausible DNS name: lower-case
    ASCII, at most 253 characters, labels of letters, digits and hyphens (63 at most, none starting
    or ending with a hyphen), at least one label. One trailing dot is removed; a name in Unicode is
    converted to punycode. An empty label (`a..b`), a space, a slash or a colon makes it None."""
    if not raw or len(raw) > MAX_NAME_CHARS * 4:
        return None
    name = raw[:-1] if raw.endswith(".") else raw
    if not name.isascii():
        try:
            name = name.encode("idna").decode("ascii")
        except UnicodeError:
            return None
    name = name.lower()
    if not name or len(name) > MAX_NAME_CHARS:
        return None
    labels = name.split(".")
    if not all(_LABEL.fullmatch(label) for label in labels):
        return None
    return name


def _entry_form(entry: str) -> str | None:
    """The form of a list entry: `name.tld` or `*.name.tld`, both with at least two labels, already
    in the comparison form, not an address. None when it is not that."""
    body = entry[2:] if entry.startswith("*.") else entry
    name = ascii_name(body)
    if name is None or name != body or len(name.split(".")) < 2 or is_ip_literal(name):
        return None
    # A name the comparison form would change (upper case, a trailing dot, Unicode) is not an
    # entry: the app writes the form, so a different one is a bug or a hand-made job.
    return entry


def normalize_entry(raw: str) -> str | None:
    """A list entry as a person typed it, brought to its form (`*.` kept, the name converted); None
    when it cannot be one. The app uses the same rules in TypeScript; this is for the runner's own
    tools and tests."""
    text = raw.strip()
    prefix = "*." if text.startswith("*.") else ""
    name = ascii_name(text[len(prefix) :])
    if name is None:
        return None
    return _entry_form(prefix + name)


@dataclass(frozen=True)
class NetworkRule:
    """The rule of one environment. `hosts` is empty unless the mode is `list`, and not empty
    then."""

    mode: str = MODE_OFF
    hosts: tuple[str, ...] = ()

    def to_json(self) -> dict[str, Any]:
        return {"mode": self.mode, "hosts": list(self.hosts)}


OFF: Final = NetworkRule()


def parse_rule(document: object, where: str = "network") -> NetworkRule:
    """The rule of a job (`ImplementerNetworkRule` of the contract), held to the contract. Raises
    `RuleError`; the message names the field, never a value."""
    if not isinstance(document, dict):
        raise RuleError(f"{where} must be an object")
    given: dict[str, Any] = {str(key): value for key, value in document.items()}  # type: ignore[reportUnknownVariableType]
    if given.keys() != {"mode", "hosts"}:
        raise RuleError(f"{where} must have exactly mode and hosts")
    mode = given["mode"]
    hosts: object = given["hosts"]
    if mode not in MODES:
        raise RuleError(f"{where}.mode must be one of {', '.join(MODES)}")
    if not isinstance(hosts, list):
        raise RuleError(f"{where}.hosts must be a list")
    entries: list[object] = list(hosts)  # type: ignore[reportUnknownArgumentType]
    if len(entries) > MAX_HOSTS:
        raise RuleError(f"{where}.hosts has more than {MAX_HOSTS} entries")
    if mode != MODE_LIST:
        if entries:
            raise RuleError(f"{where}.hosts must be empty unless the mode is list")
        return NetworkRule(str(mode))
    if not entries:
        raise RuleError(f"{where}.hosts must not be empty in the mode list")
    checked: list[str] = []
    for entry in entries:
        if not isinstance(entry, str) or _entry_form(entry) is None:
            raise RuleError(f"{where}.hosts has an entry that is not a host name or a *.suffix")
        checked.append(entry)
    return NetworkRule(MODE_LIST, tuple(dict.fromkeys(checked)))


class RuleMatcher:
    """Decides on a name for one rule. Built once; `allows` is a set lookup and a handful of
    suffix tests."""

    def __init__(self, rule: NetworkRule) -> None:
        self.rule = rule
        self._exact = frozenset(entry for entry in rule.hosts if not entry.startswith("*."))
        self._suffixes = tuple(entry[1:] for entry in rule.hosts if entry.startswith("*."))

    def allows(self, name: str) -> bool:
        """Whether the rule lets a connection to `name` (already in comparison form) through. The
        rule says nothing about addresses: that is the door's check, after this one, for every
        mode."""
        if self.rule.mode == MODE_OPEN:
            return True
        if self.rule.mode != MODE_LIST:
            return False
        if name in self._exact:
            return True
        return any(name.endswith(suffix) and len(name) > len(suffix) for suffix in self._suffixes)
