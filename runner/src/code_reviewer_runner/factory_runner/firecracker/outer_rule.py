# SPDX-License-Identifier: LicenseRef-Proprietary

"""The rule of the outer wall for one VM (#979): the hosted second wall's rule language on a
customer's machine.

Hosted, the VM's network policy is narrowed after the setup to GitHub, the model provider, the app
and the rule's own hosts (`policyFor` in `dispatcher/src/network/rule.ts`, with the Dispatcher's own
host, which a local machine has none of). The local proxy narrows to the same names, so
`narrowed_rule` makes that list; a rule that is `open` is not narrowed, as hosted.
`contracts/network-rule-examples.json` is read by both suites and holds the two to the same
answers.

What the proxy does with a name is the network door's decision (`implementer/netdoor/proxy.py`,
`Decider`: an address is never a name, only 80 and 443, the rule must list the name, then the
lookup and the public-address check), so the outer wall and the inner one cannot drift apart: the
list below is a `NetworkRule` of the mode `list`, which that code already reads. It is applied
before anything is resolved: a name the rule does not list is never sent to a resolver."""

from typing import Final

from code_reviewer_runner.implementer.network_rule import (
    MODE_LIST,
    MODE_OPEN,
    NetworkRule,
    normalize_entry,
)

# The names the VM always needs after the setup: the repository's host (the final push), nothing
# else of GitHub's (`GITHUB_HOSTS` of `dispatcher/src/network/rule.ts`; the examples file holds
# them equal).
GITHUB_HOSTS: Final = ("github.com", "api.github.com")

# The rule of the setup: any public name on 80 and 443 (the setup's own internet, as hosted).
WIDE: Final = NetworkRule(MODE_OPEN)


class OuterRuleError(ValueError):
    """The rule of a VM cannot be held by the wall. The text names what, never a value of a job."""


def _name(value: str | None, what: str) -> str:
    """`value` as an entry of a rule (a plain host name in its comparison form), or
    `OuterRuleError`."""
    if value is None or normalize_entry(value) != value or value.startswith("*."):
        raise OuterRuleError(f"{what} is not a host name a rule can hold")
    return value


def allow_list(rule: NetworkRule, model_host: str, app_host: str | None) -> tuple[str, ...] | None:
    """The names a narrowed VM may reach, or None when the rule is `open` (it is not narrowed).
    Raises `OuterRuleError` when the model provider's host or the app's host is not a name a rule
    can hold (an address, a host of one label): the Worker could not reach it through the proxy,
    so the wall refuses to claim it holds a rule that cannot work."""
    if rule.mode == MODE_OPEN:
        return None
    names = [*GITHUB_HOSTS, _name(model_host, "the model host"), _name(app_host, "the app's host")]
    names.extend(rule.hosts)
    return tuple(dict.fromkeys(names))


def narrowed_rule(rule: NetworkRule, model_host: str, app_host: str | None) -> NetworkRule:
    """The rule the proxy holds once the job's rule is in: `WIDE` for `open`, else a list of
    `allow_list`'s names (which may be more than the contract's hundred: the cap is the job's own
    hosts)."""
    names = allow_list(rule, model_host, app_host)
    if names is None:
        return WIDE
    return NetworkRule(MODE_LIST, names)
