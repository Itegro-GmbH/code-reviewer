# SPDX-License-Identifier: LicenseRef-Proprietary

"""Things Control does to the VM's own network, from a one-shot container in the host's network
namespace with `NET_ADMIN` and nothing else (#818, and the IPv6 finding of the same round).

Two uses, both closing an exit of a container that is root of a user namespace of its own and so
owns its own network namespace (what it installs inside, it can remove; what is on the VM's side of
its veth, it cannot reach):

* **The Setup container's firewall** (`setup_container.EGRESS_RULES`, an `nft` table).
* **No IPv6 address on the VM's side of a container's bridge** (`close_bridge_ipv6`). Measured on a
  platform VM (2026-11-03): root in a container on an `internal`, `isolated` network, or on the
  Setup network, can switch IPv6 on in its own namespace (Docker leaves it off, a sysctl of that
  namespace), find the bridge's link-local address (`fe80::...%eth0`, a neighbour it finds by
  pinging `ff02::1`) and connect to **port 23456 of the VM** over it: the VM's control service
  listens on `*`, and neither the isolated gateway mode nor an `ip` table sees IPv6 (the VM's
  kernel has no `ip6` or `inet` netfilter). The bridge has an IPv6 address because the kernel
  gives every interface a link-local one when it comes up. With `addrgenmode none` and the address
  flushed, the host side has no IPv6 address on that segment and there is nothing to connect to
  (measured: the same probe times out; a container that joins afterwards finds no neighbour). The
  VM does not forward IPv6 (`net.ipv6.conf.all.forwarding = 0`).

* **An `inet` table that drops IPv6 from a container's bridge** (`close_bridge_inet`), for the
  kernel that has the family: the second wall behind the VM's sysctls (the Launcher switches IPv6
  off before the daemon starts) and the missing address. The platform's kernel has no `inet` family
  (measured 2026-11-03, `Operation not supported`), so the table is tried and its absence is a log
  line, not a failure: nothing depends on it there.

The commands are constants, with the bridge's name as the one value: a name the daemon gave, or one
of ours, held to the characters of an interface name (`bridge_name`).
"""

import logging
import re
from typing import Any, Final

from .docker_api import DockerApi, DockerError
from .role_labels import role_labels

_log = logging.getLogger(__name__)

HELPER_NAME: Final = "code-reviewer-host-helper"
HELPER_SECONDS: Final = 20.0
NFT: Final = "/usr/sbin/nft"
_INTERFACE_NAME = re.compile(r"[A-Za-z0-9_-]{1,15}")
BRIDGE_OPTION: Final = "com.docker.network.bridge.name"


class HelperFailed(Exception):
    """A helper container ended with a status other than 0 (or could not run). The reason is a
    word and a number, never output."""

    def __init__(self, reason: str, code: int | None = None) -> None:
        super().__init__(reason)
        self.reason = reason
        # The helper's exit status when it ran and ended with one.
        self.code = code


def bridge_name(candidate: str) -> str:
    """The name of a bridge as an interface name, or `HelperFailed`: nothing else is ever put in
    a command."""
    if _INTERFACE_NAME.fullmatch(candidate) is None:
        raise HelperFailed("the bridge has no usable name")
    return candidate


def bridge_of(api: DockerApi, network: str) -> str:
    """The bridge a network lives on: the name it was given by option, else Docker's `br-<id>`."""
    document = api.inspect_network(network)
    options = document.get("Options")
    named = options.get(BRIDGE_OPTION) if isinstance(options, dict) else None  # type: ignore[reportUnknownMemberType]
    if isinstance(named, str) and named:
        return bridge_name(named)
    identifier = document.get("Id")
    if not isinstance(identifier, str) or len(identifier) < 12 or not identifier.isalnum():
        raise HelperFailed("the network has no identifier")
    return bridge_name(f"br-{identifier[:12]}")


def helper_document(
    image: str, entrypoint: list[str], command: list[str], role: str
) -> dict[str, Any]:
    """The one-shot container: the host's network namespace, `NET_ADMIN` and no other capability,
    a read-only root, no mount, no environment, one constant command."""
    return {
        "Image": image,
        "Entrypoint": entrypoint,
        "Cmd": command,
        "User": "0:0",
        "Env": [],
        "Labels": role_labels(role),
        "HostConfig": {
            "NetworkMode": "host",
            "Privileged": False,
            "ReadonlyRootfs": True,
            "CapDrop": ["ALL"],
            "CapAdd": ["NET_ADMIN"],
            "SecurityOpt": ["no-new-privileges:true"],
            "Memory": 64 * 1024 * 1024,
            "MemorySwap": 64 * 1024 * 1024,
            "PidsLimit": 16,
            "RestartPolicy": {"Name": "no"},
        },
    }


def run_helper(
    api: DockerApi,
    image: str,
    entrypoint: list[str],
    command: list[str],
    role: str,
    *,
    seconds: float = HELPER_SECONDS,
) -> None:
    """Run one helper to its end; `HelperFailed` unless it ended with status 0. The container is
    always removed."""
    try:
        helper = api.create_container(
            helper_document(image, entrypoint, command, role), HELPER_NAME
        )
    except DockerError as error:
        raise HelperFailed(f"the helper could not be made ({error.status})") from None
    try:
        api.start_container(helper)
        code = api.wait_container(helper, timeout=seconds)
    except DockerError as error:
        raise HelperFailed(f"the helper did not run ({error.status})") from None
    finally:
        try:
            api.remove_container(helper)
        except DockerError as error:
            _log.warning("a host helper could not be removed (%s)", error.status)
    if code != 0:
        raise HelperFailed(f"the helper ended with exit code {code}", code)


def ipv6_script(bridge: str) -> str:
    """No link-local address will be made for the bridge again, and the one it has is gone."""
    name = bridge_name(bridge)
    return f"ip link set dev {name} addrgenmode none && ip -6 addr flush dev {name}"


def close_bridge_ipv6(api: DockerApi, image: str, network: str) -> None:
    """Take the VM's IPv6 address off the bridge of `network`, before any container joins it. The
    image must have `ip` (the agent image does; the Worker image does not). Raises
    `HelperFailed`."""
    run_helper(api, image, ["/bin/sh", "-c"], [ipv6_script(bridge_of(api, network))], "bridge-ipv6")


# One table per role, named in full: the names are a closed set, never built from a value.
INET_TABLES: Final = {
    "setup": "implementer_ipv6_setup",
    "agent": "implementer_ipv6_agent",
}
# What an IPv6 packet of a container must not be sent to: the unspecified and loopback addresses,
# IPv4 inside IPv6, the NAT64 prefix, unique local, link-local and multicast (the VM, its
# neighbours, the platform).
IPV6_PRIVATE_RANGES: Final = (
    "::/128",
    "::1/128",
    "::ffff:0:0/96",
    "64:ff9b::/96",
    "fc00::/7",
    "fe80::/10",
    "ff00::/8",
)


def inet_table(role: str) -> str:
    """The table of one role (`setup`, `agent`)."""
    table = INET_TABLES.get(role)
    if table is None:
        raise HelperFailed("the role has no table")
    return table


def inet_rules(role: str, bridge: str) -> str:
    """An `inet` table in the host's namespace, hooked before Docker's own rules: no IPv6 packet
    from the bridge to the VM itself, none through the VM to a private range. Only drops, like the
    `ip` tables beside it. `flush` makes a second install the same as the first."""
    table = inet_table(role)
    name = bridge_name(bridge)
    return "; ".join(
        [
            f"add table inet {table}",
            f"flush table inet {table}",
            f"add chain inet {table} input "
            "{ type filter hook input priority -10 ; policy accept ; }",
            f'add rule inet {table} input iifname "{name}" meta nfproto ipv6 drop',
            f"add chain inet {table} forward "
            "{ type filter hook forward priority -10 ; policy accept ; }",
            f'add rule inet {table} forward iifname "{name}" '
            f"ip6 daddr {{ {', '.join(IPV6_PRIVATE_RANGES)} }} drop",
        ]
    )


# The `nft` call of the `inet` table, in a shell, to tell a kernel with no `inet` family (the
# platform's, measured) from one that has it and refused: exit status 3 for the first, 1 for the
# second. Only the status decides whether a note is made, and the statuses of probes decide it,
# never the wording of `nft` (#827): when the table could not be installed, an empty `inet` table
# is tried (the family is there, so the table was refused: 1), then an empty `ip` table (`nft`
# works but the kernel has no `inet` family: 3), and if neither can be made `nft` itself is
# failing (1). The probe tables are removed again.
INET_NO_FAMILY_EXIT: Final = 3
INET_PROBE_TABLE: Final = "implementer_family_probe"
INET_SCRIPT: Final = (
    f'{NFT} "$1" && exit 0; '
    f"if {NFT} add table inet {INET_PROBE_TABLE}; then "
    f"{NFT} delete table inet {INET_PROBE_TABLE}; exit 1; fi; "
    f"if {NFT} add table ip {INET_PROBE_TABLE}; then "
    f"{NFT} delete table ip {INET_PROBE_TABLE}; exit {INET_NO_FAMILY_EXIT}; fi; "
    "exit 1"
)
INET_INSTALLED: Final = "installed"
INET_NO_FAMILY: Final = "no_family"
INET_FAILED: Final = "failed"


def close_bridge_inet(api: DockerApi, image: str, network: str, role: str) -> str:
    """Install the `inet` drop of `role` for the bridge of `network`: `INET_INSTALLED`, or
    `INET_NO_FAMILY` when the kernel has no `inet` family (the platform's has none, and the
    sysctls and the missing address close IPv6 there; a log line), or `INET_FAILED` when a kernel
    that has the family refused the table (a warning; the caller makes a note in the report). None
    of them stops the turn. The image must have `nft` and a shell."""
    try:
        run_helper(
            api,
            image,
            ["/bin/sh", "-c", INET_SCRIPT, "inet-rules"],
            [inet_rules(role, bridge_of(api, network))],
            f"{role}-ipv6-rules",
        )
    except HelperFailed as failed:
        if failed.code == INET_NO_FAMILY_EXIT:
            _log.info("the kernel has no inet family, so the %s bridge has no inet table", role)
            return INET_NO_FAMILY
        _log.warning("the inet table of the %s bridge is not in place (%s)", role, failed.reason)
        return INET_FAILED
    return INET_INSTALLED


def inet_failure_note(role: str) -> str:
    """The note of a kernel that has the `inet` family and refused the table."""
    return (
        f"the inet table that drops IPv6 from the {role} bridge could not be installed on a "
        "kernel that has the family; IPv6 is closed by the sysctls and the missing address only"
    )
