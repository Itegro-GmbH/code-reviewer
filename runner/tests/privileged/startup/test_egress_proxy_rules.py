# SPDX-License-Identifier: LicenseRef-Proprietary

"""The Implementer container's third loopback port in the engine user's nft rules (#763-T06).

The same setup as `test_network_rules.py`: the production ruleset (`netguard.py`) installed for the
engine user, the supervisor's services played by loopback listeners the test owns, both rulesets.
As the engine user the model proxy port, the engine's own port and the egress proxy port accept;
another loopback port, another address, IPv6, UDP (DNS included) and a name lookup do not. A
container installed without the egress port refuses that port like any other.
"""

import socket

import pytest
from privileged_support import (
    ENGINE_GID,
    ENGINE_UID,
    blocked,
    connect_as,
    free_port,
    installed_rules,
    listener,
    run_as,
)

from code_reviewer_runner.dynamic_review.netguard import EgressMode

BOTH_MODES = pytest.mark.parametrize("mode", list(EgressMode), ids=lambda mode: mode.value)

SEND = (
    "import socket, sys; "
    "s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); "
    "s.sendto(b'x', (sys.argv[1], int(sys.argv[2])))"
)
LOOKUP = (
    "import socket, sys; "
    "socket.setdefaulttimeout(3); "
    "socket.getaddrinfo('registry.npmjs.org', 443, type=socket.SOCK_STREAM); "
    "sys.exit(0)"
)


def datagram_arrives(address: str, sentinel: socket.socket) -> bool:
    port = int(sentinel.getsockname()[1])
    run_as(ENGINE_UID, ENGINE_GID, SEND, address, str(port))
    try:
        sentinel.recvfrom(16)
    except OSError:
        return False
    return True


# #763-T06
@BOTH_MODES
def test_the_engine_user_reaches_the_proxy_the_engine_and_the_egress_ports_and_nothing_else(
    mode: EgressMode,
) -> None:
    with (
        listener() as model_proxy,
        listener() as engine,
        listener() as egress,
        listener() as other_port,
        listener("127.0.0.2") as other_address,
        installed_rules(model_proxy, engine, mode, egress),
    ):
        reached = connect_as(
            ENGINE_UID,
            ENGINE_GID,
            [
                ("model proxy", "127.0.0.1", model_proxy),
                ("engine", "127.0.0.1", engine),
                ("egress", "127.0.0.1", egress),
                ("other port", "127.0.0.1", other_port),
                ("other address", "127.0.0.2", other_address),
            ],
        )

    for label in ("model proxy", "engine", "egress"):
        assert reached[label]["connected"] is True, label
    for label in ("other port", "other address"):
        assert blocked(reached[label], mode), label


# #763-T06
@BOTH_MODES
def test_without_an_egress_port_in_the_rules_that_port_is_refused_like_any_other(
    mode: EgressMode,
) -> None:
    with (
        listener() as model_proxy,
        listener() as egress,
        installed_rules(model_proxy, free_port(), mode),
    ):
        reached = connect_as(ENGINE_UID, ENGINE_GID, [("egress", "127.0.0.1", egress)])

    assert blocked(reached["egress"], mode)


# #763-T06
@BOTH_MODES
def test_the_engine_user_sends_no_datagram_and_cannot_resolve_a_name(mode: EgressMode) -> None:
    with (
        listener() as model_proxy,
        listener() as egress,
        socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sentinel,
        socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as egress_udp,
        installed_rules(model_proxy, free_port(), mode, egress),
    ):
        sentinel.bind(("127.0.0.1", 0))
        sentinel.settimeout(1.0)
        # The egress port is open for TCP only: UDP to the same number is refused.
        egress_udp.bind(("127.0.0.1", egress))
        egress_udp.settimeout(1.0)
        assert not datagram_arrives("127.0.0.1", sentinel)
        assert not datagram_arrives("127.0.0.1", egress_udp)

        # A lookup needs a resolver: UDP/TCP to the nameserver of the container, all refused, so
        # the engine user gets no answer and no name resolves for it (the proxy resolves).
        lookup = run_as(ENGINE_UID, ENGINE_GID, LOOKUP)
        assert lookup.returncode != 0
