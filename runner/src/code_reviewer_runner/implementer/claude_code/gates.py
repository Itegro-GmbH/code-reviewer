# SPDX-License-Identifier: LicenseRef-Proprietary

"""The gates of a turn that runs on the device's login (#856).

The login is inside the agent's container: Claude Code needs it there, and a tool of the agent can
read it. The decision (the lead's, owner may revise) is to accept that and to guard the exits:

* **The network.** Claude Code has to reach Anthropic; nothing else is needed to *talk*. So a
  subscription turn is forced onto the network door with the rule `list`: `api.anthropic.com`
  (an exact name, no suffix) on **port 443 only**: Claude Code speaks TLS, so the entry does not
  get the port 80 that a listed host has in every other rule (`ports` of the rule; the door
  refuses 80 for it with `port_not_allowed`). The step's own rule cannot widen that: an `open`
  rule refuses the turn, free (`subscription_network_open`), because any public host could be a
  place to send the token to. A step that is `off`, or lists exactly that host, gets the rule
  above.
* **Hosts the work needs (#1126).** A build or a check the agent runs may need more than the API
  (`next build` fetches fonts, the agent looks at a live site). A `list` rule of the step may name
  those hosts; each one besides the API host is **read-only**: the door ends the TLS connection
  itself and lets `GET` and `HEAD` through, so a `POST`, a `PUT` or a body never leaves (the door's
  one reading of the package registries, `netdoor/registries.py`), on port 443 only. The token is in
  the container, so every host listed is still a place a `GET` can carry something to (in its path
  or query); read-only narrows that to a host that does not publish what it was asked, it does not
  remove it. That is why the list is the owner's to write and `open` is never allowed here.
* **The push** (`push_guard.py`) and **the redaction** (the agent's `Redactor` knows the login)
  keep the token out of the repository and out of every output.

The code of a refusal is `implementer_config_invalid`, as for any job the runner cannot run as
asked; the reason word at the start of the detail is the stable part to branch on.
"""

import re
from typing import Final

from code_reviewer_runner.implementer.network_rule import (
    MODE_LIST,
    MODE_OPEN,
    NetworkRule,
    RuleMatcher,
)
from code_reviewer_runner.job import JobError
from code_reviewer_runner.result import ErrorCode

ANTHROPIC_HOST: Final = "api.anthropic.com"
ANTHROPIC_PORTS: Final = (443,)
NETWORK_OPEN_REASON: Final = "subscription_network_open"
NETWORK_HOSTS_REASON: Final = "subscription_network_hosts"
NETWORK_WILDCARD_REASON: Final = "subscription_network_wildcard"
# A `*.suffix` entry on one of these covers hosts anybody can get (user content, hosting, a
# country's public suffix): the login is in the container, so a GET to any tenant's host could
# carry it. An exact host on these domains stays the owner's choice. Small on purpose, the common
# cases; the app keeps the same list (`app/src/network-rule/shared-domains.ts`, validator and
# claim), and a test on each side pins it.
SHARED_SUFFIXES: Final = (
    "github.io",
    "githubusercontent.com",
    "gitlab.io",
    "bitbucket.io",
    "pages.dev",
    "workers.dev",
    "r2.dev",
    "vercel.app",
    "netlify.app",
    "herokuapp.com",
    "onrender.com",
    "fly.dev",
    "web.app",
    "firebaseapp.com",
    "appspot.com",
    "blogspot.com",
    "azurewebsites.net",
    "cloudfront.net",
    "amazonaws.com",
    "glitch.me",
    "repl.co",
    "ngrok.io",
    "surge.sh",
)
_COUNTRY_SECOND_LEVEL: Final = re.compile(r"(co|com|org|net|ac|gov|edu)\.[a-z]{2}")


def is_shared_wildcard(entry: str) -> bool:
    """Whether a rule entry is a `*.` entry on a shared domain (`SHARED_SUFFIXES`, or a country's
    second-level suffix such as `co.uk`)."""
    if not entry.startswith("*."):
        return False
    base = entry[2:]
    return base in SHARED_SUFFIXES or _COUNTRY_SECOND_LEVEL.fullmatch(base) is not None


def subscription_rule(environment: NetworkRule) -> NetworkRule:
    """The rule of the agent's network for a subscription turn: the API host on 443, and every
    other host of the step's list read-only on 443 (`NetworkRule.read_only`). `JobError` when the
    step's rule is `open`."""
    if environment.mode == MODE_OPEN:
        raise JobError(
            ErrorCode.IMPLEMENTER_CONFIG_INVALID,
            f"{NETWORK_OPEN_REASON}: a turn on a subscription login reaches only "
            f"{ANTHROPIC_HOST} and the hosts its step lists (read-only), so a step with an "
            "open network cannot run it",
        )
    extra = (
        tuple(host for host in environment.hosts if host != ANTHROPIC_HOST)
        if environment.mode == MODE_LIST
        else ()
    )
    for host in extra:
        if is_shared_wildcard(host):
            raise JobError(
                ErrorCode.IMPLEMENTER_CONFIG_INVALID,
                f"{NETWORK_WILDCARD_REASON}: an entry of the step's network covers a domain "
                "whose subdomains anybody can get, and the login is in the container: name the "
                "exact hosts",
            )
        # A wildcard over the API host would make the model's own host read-only, and Claude Code
        # posts to it: the turn could not work, and the rule would say something it does not mean.
        if RuleMatcher(NetworkRule(MODE_LIST, (host,))).allows(ANTHROPIC_HOST):
            raise JobError(
                ErrorCode.IMPLEMENTER_CONFIG_INVALID,
                f"{NETWORK_HOSTS_REASON}: an entry of the step's network covers {ANTHROPIC_HOST}, "
                "which is reached as it is and cannot be read-only",
            )
    return NetworkRule(MODE_LIST, (ANTHROPIC_HOST, *extra), ports=ANTHROPIC_PORTS, read_only=extra)
