# SPDX-License-Identifier: LicenseRef-Proprietary

"""The probe that proves the egress port is reachable and nothing else is (#763).

The kernel's part is the privileged suite's; here is how the runner builds the probe and judges
its answer, with real loopback listeners for the sentinels.
"""

import json
import socket
from collections.abc import Mapping

import pytest

from code_reviewer_runner.dynamic_review import netguard
from code_reviewer_runner.dynamic_review.netguard import IsolationError, verify_confinement

UID = GID = 10101
CONFINED = {"allowed": True, "other_port": False, "other_host": False}


def probe_that(reaches: Mapping[str, object], seen: list[list[str]]) -> netguard.ProbeRunner:
    def run(argv: list[str], uid: int, gid: int) -> str:
        seen.append(argv)
        return json.dumps(reaches)

    return run


# #763-T06
def test_without_extra_ports_the_probe_is_the_one_dynamic_always_ran() -> None:
    seen: list[list[str]] = []

    verify_confinement(UID, GID, 4000, run_probe=probe_that(CONFINED, seen))

    assert len(seen[0]) == 11  # python -I -c script + seven arguments


# #763-T06
def test_the_egress_port_is_probed_as_reachable_and_the_probe_must_say_so() -> None:
    seen: list[list[str]] = []

    verify_confinement(
        UID, GID, 4000, 4002, run_probe=probe_that({**CONFINED, "extra": True}, seen)
    )

    assert seen[0][-1] == "4002"


# #763-T06
@pytest.mark.parametrize("extra", [False, None, "yes", 1])
def test_an_unreachable_egress_port_fails_closed(extra: object) -> None:
    with pytest.raises(IsolationError, match="egress proxy"):
        verify_confinement(
            UID, GID, 4000, 4002, run_probe=probe_that({**CONFINED, "extra": extra}, [])
        )


# #763-T06
def test_a_probe_that_does_not_answer_for_the_egress_port_fails_closed() -> None:
    with pytest.raises(IsolationError, match="egress proxy"):
        verify_confinement(UID, GID, 4000, 4002, run_probe=probe_that(CONFINED, []))


# #763-T06
def test_a_real_probe_reaches_both_listeners_and_still_sees_the_sentinels_without_rules() -> None:
    # No filter here: every sentinel accepts, so the check fails on the sentinels, not on the ports.
    with socket.socket() as proxy, socket.socket() as egress:
        for listener in (proxy, egress):
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)

        def run_locally(argv: list[str], uid: int, gid: int) -> str:
            import subprocess

            return subprocess.run(
                argv, capture_output=True, text=True, timeout=20, check=True
            ).stdout

        with pytest.raises(IsolationError, match="other than its model proxy"):
            verify_confinement(
                UID,
                GID,
                int(proxy.getsockname()[1]),
                int(egress.getsockname()[1]),
                run_probe=run_locally,
            )
