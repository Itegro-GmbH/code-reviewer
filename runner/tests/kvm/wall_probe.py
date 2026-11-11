# SPDX-License-Identifier: LicenseRef-Proprietary

"""The probe of the outer-wall lane (#979; not a test file): a program that runs **inside a job's
VM** and says what the VM can reach, before and after a real `narrow`.

It runs as Control's container does (the launcher's `docker run` flags, the VM's token on stdin, the
seccomp profile that allows AF_VSOCK), with the Worker image's interpreter as its entry point: the
lane replaces the Worker's command by this program, because a job clones its repository over https
before it narrows the network, which no lane has a git host for. What is real is everything around
it: the VM, its network, vm-init, the vsock, the token, the host's session, the wall and the nft
table. The probe's own `narrow` is the Worker's own client (`implementer/environment_control.py`,
with the token it read from stdin) and not a re-implementation.

What it does, in order:

1. connects **directly** to targets the table must keep it from (the host's TAP address, RFC1918
   addresses, a link-local address, the cloud metadata address, an address of the internet) and to
   an IPv6 address;
2. asks the proxy for `CONNECT <setup-only host>:443`: the wide rule of the setup lets it through;
3. sends a `narrow` **without** the token (the host must refuse it) and then the real one, with it
   (the host holds the job's rule in the proxy, then acknowledges);
4. asks the proxy for the setup-only host again (now refused), for GitHub (still allowed) and for
   the metadata address as an address (refused whatever the rule);
5. reports what it saw. The VM's output is dropped by vm-init and an exit status holds eight bits,
   so the report goes through the path under test: a `CONNECT r<bits>.report.invalid:443`, which
   the proxy refuses (or cannot resolve) and **logs with the host name the request named**, where
   the host reads it. The exit status is 0 when the probe got that far and 1 when it did not.

Outside a VM the same program runs against loopback stand-ins
(`tests/unit/test_firecracker_wall_probe.py`): the configuration names the addresses, the source
address of the proxy calls and a TCP control instead of vsock. The lane's configuration is
`lane_config`."""

import json
from typing import Any, Final

# The things the probe reports, in the order of the bits of its report.
DIRECT: Final = (
    "host_tap",
    "rfc1918_10",
    "rfc1918_172",
    "rfc1918_192",
    "link_local",
    "metadata",
    "internet",
    "ipv6",
)
PROXY: Final = (
    "setup_host_before",
    "tokenless_narrow_refused",
    "narrow_acked",
    "setup_host_after",
    "github_after",
    "metadata_literal_after",
)
RESULTS: Final = (*DIRECT, *PROXY)
REPORT_DOMAIN: Final = "report.invalid"
MODEL_HOST: Final = "api.anthropic.com"
# Where the host listens for the direct probes (the workflow puts the addresses on the host).
DIRECT_PORT: Final = 9999
SETUP_ONLY_HOST: Final = "example.com"


def lane_config(gateway: str) -> dict[str, Any]:
    """The probe's targets in a lane's VM: `gateway` is the host's address on the slot's TAP, which
    is also where the proxy listens. The other addresses are put on the host by the workflow."""
    return {
        "gateway": gateway,
        "proxy_port": 3128,
        "direct": {
            "host_tap": [gateway, DIRECT_PORT],
            "rfc1918_10": ["10.77.0.2", DIRECT_PORT],
            "rfc1918_172": ["172.16.77.2", DIRECT_PORT],
            "rfc1918_192": ["192.168.77.2", DIRECT_PORT],
            "link_local": ["169.254.169.253", DIRECT_PORT],
            "metadata": ["169.254.169.254", 80],
            "internet": ["1.1.1.1", 443],
        },
        "ipv6": ["fd00:fc:0::1", DIRECT_PORT],
        "setup_host": SETUP_ONLY_HOST,
        "github_host": "github.com",
        "model_host": MODEL_HOST,
        "connect_seconds": 4.0,
        "control": {"kind": "vsock"},
        "source": None,
    }


def render(config: dict[str, Any]) -> str:
    """The program, with `config` in it."""
    return _SOURCE.replace("@CONFIG@", repr(json.dumps(config)))


def decode(host: str) -> dict[str, bool] | None:
    """What a `CONNECT r<bits>.report.invalid` named, or None when `host` is not a report."""
    suffix = f".{REPORT_DOMAIN}"
    if not host.endswith(suffix) or not host.startswith("r"):
        return None
    bits = host[1 : -len(suffix)]
    if len(bits) != len(RESULTS) or set(bits) - {"0", "1"}:
        return None
    return {name: bit == "1" for name, bit in zip(RESULTS, bits, strict=True)}


_SOURCE: Final = r"""
import concurrent.futures
import json
import socket
import sys

CONFIG = json.loads(@CONFIG@)
DIRECT = @DIRECT@
PROXY = @PROXY@
RESULTS = DIRECT + PROXY


def reachable(host, port, family):
    try:
        with socket.socket(family, socket.SOCK_STREAM) as probe:
            probe.settimeout(CONFIG["connect_seconds"])
            probe.connect((host, port))
        return True
    except OSError:
        return False


def through_proxy(target):
    source = CONFIG["source"]
    try:
        with socket.create_connection(
            (CONFIG["gateway"], CONFIG["proxy_port"]),
            timeout=10,
            source_address=None if source is None else (source, 0),
        ) as proxy:
            proxy.settimeout(30)
            proxy.sendall(("CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n" % (target, target)).encode())
            head = proxy.recv(256)
    except OSError:
        return 0
    parts = head.split(b" ", 2)
    return int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0


def control(token):
    from code_reviewer_runner.implementer.environment_control import VsockControl

    kind = CONFIG["control"]
    if kind["kind"] == "vsock":
        return VsockControl(token=token, narrow_seconds=25.0)

    def connect(timeout):
        return socket.create_connection((kind["host"], kind["port"]), timeout=timeout)

    return VsockControl(connect=connect, token=token, narrow_seconds=25.0)


def narrow(token):
    from code_reviewer_runner.implementer.network_rule import OFF

    try:
        control(token).narrow(OFF, CONFIG["model_host"])
    except Exception as error:
        return False, str(getattr(error, "detail", ""))
    return True, ""


def main():
    job = json.loads(sys.stdin.readline())
    token = job["controlToken"]
    seen = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futures = {
            name: pool.submit(reachable, host, port, socket.AF_INET)
            for name, (host, port) in CONFIG["direct"].items()
        }
        host6, port6 = CONFIG["ipv6"]
        futures["ipv6"] = pool.submit(reachable, host6, port6, socket.AF_INET6)
        for name, future in futures.items():
            seen[name] = future.result()
    setup = CONFIG["setup_host"] + ":443"
    seen["setup_host_before"] = through_proxy(setup) == 200
    tokenless, detail = narrow(None)
    seen["tokenless_narrow_refused"] = not tokenless and "environment_control_refused" in detail
    seen["narrow_acked"] = narrow(token)[0]
    seen["setup_host_after"] = through_proxy(setup) == 200
    seen["github_after"] = through_proxy(CONFIG["github_host"] + ":443") == 200
    seen["metadata_literal_after"] = through_proxy("169.254.169.254:80") == 200
    bits = "".join("1" if seen[name] else "0" for name in RESULTS)
    through_proxy("r%s.report.invalid:443" % bits)
    return 0


try:
    status = main()
except BaseException:
    status = 1
sys.exit(status)
""".replace("@DIRECT@", repr(DIRECT)).replace("@PROXY@", repr(PROXY))
