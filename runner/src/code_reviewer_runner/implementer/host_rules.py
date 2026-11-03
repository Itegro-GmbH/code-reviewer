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
  pinging
  `ff02::1`) and connect to **port 23456 of the VM** over it: the VM's control service listens on
  `*`, and neither the isolated gateway mode nor an `ip` table sees IPv6 (the VM's kernel has no
  `ip6` or `inet` netfilter). The bridge has an IPv6 address because the kernel gives every
  interface a link-local one when it comes up. With `addrgenmode none` and the address flushed, the
  host side has no IPv6 address on that segment and there is nothing to connect to (measured: the
  same probe times out; a container that joins afterwards finds no neighbour). The VM does not
  forward IPv6 (`net.ipv6.conf.all.forwarding = 0`).

The commands are constants, with the bridge's name as the one value: a name the daemon gave, or one
of ours, held to the characters of an interface name (`bridge_name`).
"""

import logging
import re
from typing import Any, Final

from .docker_api import DockerApi, DockerError

_log = logging.getLogger(__name__)

HELPER_NAME: Final = "code-reviewer-host-helper"
HELPER_ROLE_LABEL: Final = "code-reviewer.role"
HELPER_SECONDS: Final = 20.0
_INTERFACE_NAME = re.compile(r"[A-Za-z0-9_-]{1,15}")
BRIDGE_OPTION: Final = "com.docker.network.bridge.name"


class HelperFailed(Exception):
    """A helper container ended with a status other than 0 (or could not run). The reason is a
    word and a number, never output."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


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
        "Labels": {HELPER_ROLE_LABEL: role},
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
        raise HelperFailed(f"the helper ended with exit code {code}")


def ipv6_script(bridge: str) -> str:
    """No link-local address will be made for the bridge again, and the one it has is gone."""
    name = bridge_name(bridge)
    return f"ip link set dev {name} addrgenmode none && ip -6 addr flush dev {name}"


def close_bridge_ipv6(api: DockerApi, image: str, network: str) -> None:
    """Take the VM's IPv6 address off the bridge of `network`, before any container joins it. The
    image must have `ip` (the agent image does; the Worker image does not). Raises
    `HelperFailed`."""
    run_helper(api, image, ["/bin/sh", "-c"], [ipv6_script(bridge_of(api, network))], "bridge-ipv6")
