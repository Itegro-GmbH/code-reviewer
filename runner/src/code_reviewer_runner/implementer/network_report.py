# SPDX-License-Identifier: LicenseRef-Proprietary

"""The `network` block of a turn's result (#745, step 7, `ImplementerNetworkReport`): the rule,
whether a door ran, what the second wall did, and the log of the door's connections.

The numbers and entries are the door's own (`netdoor/connections.py`), read from the last status it
wrote; the block holds nothing of what was sent."""

from typing import Any, Final

from .network_rule import NetworkRule

VM_POLICY_NARROWED: Final = "narrowed"
VM_POLICY_UNCHANGED: Final = "unchanged"
VM_POLICY_NOT_CONFIGURED: Final = "not_configured"


def network_report(
    rule: NetworkRule,
    log: dict[str, Any] | None,
    *,
    door: bool,
    vm_policy: str,
) -> dict[str, Any]:
    """The block. `log` is the door's last status (None: it said nothing, nothing was counted)."""
    seen: dict[str, Any] = log or {}
    return {
        "mode": rule.mode,
        "door": door,
        "vmPolicy": vm_policy,
        "allowed": seen.get("allowed", 0),
        "refused": seen.get("refused", 0),
        "bytesIn": seen.get("bytesIn", 0),
        "bytesOut": seen.get("bytesOut", 0),
        "dropped": seen.get("dropped", 0),
        "connections": list(seen.get("connections", [])),
    }
