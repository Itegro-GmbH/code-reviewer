# SPDX-License-Identifier: LicenseRef-Proprietary

"""The gates of a turn that runs on the device's login (#856).

The login is inside the agent's container: Claude Code needs it there, and a tool of the agent can
read it. The decision (the lead's, owner may revise) is to accept that and to guard the exits:

* **The network.** Claude Code has to reach Anthropic; nothing else is needed for a turn. So a
  subscription turn is forced onto the network door with the rule `list` and exactly
  `api.anthropic.com` (an exact name, no suffix; the door dials ports 80 and 443 only, and Claude
  Code uses 443). The environment's own rule cannot widen that: an `open` environment, or one that
  lists any other host (any other host could be a place to send the token to), refuses the turn,
  free, with a reason word in the detail. An environment that is `off` or lists exactly that host is
  fine: the turn gets the same rule either way.
* **The push** (`push_guard.py`) and **the redaction** (the agent's `Redactor` knows the login)
  keep the token out of the repository and out of every output.

The code of a refusal is `implementer_config_invalid`, as for any job the runner cannot run as
asked; the reason word at the start of the detail is the stable part to branch on.
"""

from typing import Final

from code_reviewer_runner.implementer.network_rule import MODE_LIST, MODE_OPEN, NetworkRule
from code_reviewer_runner.job import JobError
from code_reviewer_runner.result import ErrorCode

ANTHROPIC_HOST: Final = "api.anthropic.com"
NETWORK_OPEN_REASON: Final = "subscription_network_open"
NETWORK_HOSTS_REASON: Final = "subscription_network_hosts"


def subscription_rule(environment: NetworkRule) -> NetworkRule:
    """The rule of the agent's network for a subscription turn, or `JobError` when the
    environment's rule is wider than that."""
    if environment.mode == MODE_OPEN:
        raise JobError(
            ErrorCode.IMPLEMENTER_CONFIG_INVALID,
            f"{NETWORK_OPEN_REASON}: a turn on a subscription login reaches only "
            f"{ANTHROPIC_HOST}, so an environment with an open network cannot run it",
        )
    if environment.mode == MODE_LIST and set(environment.hosts) != {ANTHROPIC_HOST}:
        raise JobError(
            ErrorCode.IMPLEMENTER_CONFIG_INVALID,
            f"{NETWORK_HOSTS_REASON}: a turn on a subscription login reaches only "
            f"{ANTHROPIC_HOST}, so an environment that lists other hosts cannot run it",
        )
    return NetworkRule(MODE_LIST, (ANTHROPIC_HOST,))
