# SPDX-License-Identifier: LicenseRef-Proprietary

"""The network setting of an Implementer container and the engine environment it implies (#763).

Two variables of the Worker's own container spec (#746) decide everything:
`RUNNER_IMPLEMENTER_NETWORK` (`registries` | `none`) and `RUNNER_IMPLEMENTER_EGRESS_PORT`. The
supervisor reads them from its trusted environment. The allowlist is not configurable at all
(`egress_policy.DEFAULT_ALLOWLIST`), so no job, repository or other environment name can widen
what the agent reaches.

`registries` starts the proxy (`egress_proxy.py`) and points the agent's package managers at it;
`none` starts nothing and sets nothing: the engine user's rules still allow no other way out.
"""

from collections.abc import Mapping
from dataclasses import dataclass

from code_reviewer_runner.dynamic_review.netguard import IsolationError
from code_reviewer_runner.dynamic_review.static_isolation import (
    ImplementerNetwork,
    slot_ports,
)

from .egress_proxy import (
    LOOPBACK,
    Connector,
    EgressLimits,
    EgressProxy,
    Resolver,
    system_resolve,
    tcp_connect,
)

# Every name through which a tool picks a proxy, case-insensitively. The engine environment is
# stripped of all of them before the runner's own are set: an inherited `NO_PROXY` or `ALL_PROXY`
# would otherwise let a tool bypass or replace the allowlist proxy.
_PROXY_NAMES = frozenset(
    {
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "ftp_proxy",
        "no_proxy",
        "npm_config_proxy",
        "npm_config_https_proxy",
        "npm_config_http_proxy",
        "npm_config_noproxy",
        "pip_proxy",
        "yarn_proxy",
        "yarn_http_proxy",
        "yarn_https_proxy",
    }
)


class EgressConfigError(Exception):
    """The network setting is unusable. The message names the variable, never its value."""


@dataclass(frozen=True)
class EgressSettings:
    """`port` is the proxy's loopback port when `network` is `registries`, else None."""

    network: ImplementerNetwork
    port: int | None


def egress_settings_from_environment(environment: Mapping[str, str]) -> EgressSettings:
    """The setting from the supervisor's environment. Raises `EgressConfigError`."""
    try:
        ports = slot_ports(environment)
    except IsolationError as error:
        raise EgressConfigError(error.detail) from None
    if ports.egress is None:
        return EgressSettings(ImplementerNetwork.NONE, None)
    return EgressSettings(ImplementerNetwork.REGISTRIES, ports.egress)


def egress_environment(settings: EgressSettings) -> dict[str, str]:
    """What the engine and its tools get to find the proxy; nothing for `none`.

    `NO_PROXY` is never set: nothing may bypass the proxy by name (and the engine user could not
    reach it directly anyway).
    """
    if settings.network is ImplementerNetwork.NONE or settings.port is None:
        return {}
    url = f"http://{LOOPBACK}:{settings.port}"
    return {
        "HTTPS_PROXY": url,
        "https_proxy": url,
        "npm_config_proxy": url,
        "npm_config_https_proxy": url,
        "PIP_PROXY": url,
    }


def apply_egress_environment(
    environment: Mapping[str, str], settings: EgressSettings
) -> dict[str, str]:
    """`environment` without any proxy variable of its own, plus the egress proxy's."""
    kept = {name: value for name, value in environment.items() if name.lower() not in _PROXY_NAMES}
    return {**kept, **egress_environment(settings)}


def start_egress(
    settings: EgressSettings,
    *,
    limits: EgressLimits | None = None,
    resolve: Resolver = system_resolve,
    connect: Connector = tcp_connect,
) -> EgressProxy | None:
    """Start the allowlist proxy on the configured port; None (nothing started) for `none`."""
    if settings.network is ImplementerNetwork.NONE or settings.port is None:
        return None
    proxy = EgressProxy(port=settings.port, limits=limits, resolve=resolve, connect=connect)
    proxy.start()
    return proxy
