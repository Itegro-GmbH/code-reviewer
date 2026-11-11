# SPDX-License-Identifier: LicenseRef-Proprietary

"""Writes the three rulesets that a job's VM loads in its own kernel, as the Worker would with the
outer wall's proxy (#999; the review of #994), as files for `nft -c -f` (not a test file).

The model door's, the network door's and the Setup bridge's tables are strings of `nft` commands
that a container with `NET_ADMIN` runs inside the guest. The unit tests hold their rules as text
against a fake daemon; only a kernel says whether `nft` accepts them. The lane's workflow runs
`sudo nft -c -f <file>` on each file this program wrote (a syntax and semantics check on the
runner's kernel, nothing is loaded); the whole-job lane then loads them for real in the guest, and a
job whose rules the guest refuses does not start.

    python render_rulesets.py <directory>      writes the files, prints their paths"""

import sys
from pathlib import Path

from code_reviewer_runner.factory_runner.firecracker.slots import Slot
from code_reviewer_runner.implementer import door_launcher, netdoor_launcher, setup_container
from code_reviewer_runner.outer_proxy import OuterProxy

# The lane's slot network (`DEFAULT_SLOT_NETWORK`): the proxy is on the first slot's host address.
LANE_PROXY = OuterProxy(Slot(0).host_address, 3128)


def render(directory: Path, proxy: OuterProxy = LANE_PROXY) -> dict[str, str]:
    """Write the files; the name of each and the text it holds (a newline at the end)."""
    rulesets = {
        "model-door.nft": door_launcher.egress_rules(proxy),
        "network-door.nft": netdoor_launcher.egress_rules(None, proxy),
        "setup-bridge.nft": setup_container.egress_rules(proxy),
    }
    directory.mkdir(parents=True, exist_ok=True)
    for name, text in rulesets.items():
        (directory / name).write_text(text + "\n", encoding="utf-8")
    return rulesets


def main(arguments: list[str]) -> int:
    if len(arguments) != 1:
        print("usage: render_rulesets.py <directory>", file=sys.stderr)
        return 2
    directory = Path(arguments[0])
    for name in render(directory):
        print(directory / name)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
