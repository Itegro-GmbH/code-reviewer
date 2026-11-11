# SPDX-License-Identifier: LicenseRef-Proprietary

"""The probe of the clients lane (#994; not a test file): a program that runs **inside a job's VM**
and uses the product's own clients, with the outer wall's proxy the launcher gave the VM, to say
what each of them reaches with the nft table loaded.

It runs as Control's container does (the launcher's `docker run` flags, the start's `outerProxy` and
the VM's token on stdin, the seccomp profile that allows AF_VSOCK), with the Worker image's
interpreter as its entry point. The proxy is **read from the stdin vm-init wrote**, so the whole
path is exercised: the launcher puts the slot's address in the start, vm-init validates it and
writes it into Control's stdin, and what is below uses it. Every client is the product's, not a
copy: the Worker API's opener (`job_loop/http.py`) for Control's calls to the app, `git` as the
Implementer's workspace runs it (`implementer/git_process.py`), the model door's upstream
(`HttpsUpstream`) and the network door (`ProxyServer` with a chained `Decider`) in front of the
same proxy. The checks run before and after a real `narrow` over vsock (the Worker's own client,
with the VM's token), so the wide rule of the setup and the job's rule both decide.

The VM's output is dropped by vm-init and an exit status holds eight bits, so the report goes
through the path under test: a `CONNECT r<bits>.report.invalid:443`, which the proxy refuses and
**logs with the name the request named**, where the host reads it. Which checks ran is the
configuration's (`checks`): the lane runs all of them, the unit run (loopback stand-ins, plain
HTTP, no TLS and no git host) a subset.

Outside a VM the same program runs against loopback stand-ins
(`tests/unit/test_firecracker_clients_probe.py`): the configuration names the addresses, a TCP
control instead of vsock and, for the proxy's address check, the loopback network. The lane's
configuration is `lane_config`."""

import base64
import json
import zlib
from typing import Any, Final

# The checks, in the order of the bits of the report. A bit is "this happened" (see `EXPECTED`).
LANE_CHECKS: Final = (
    "proxy_from_start",
    "direct_before",
    "app_http_before",
    "app_https_before",
    "git_before",
    "model_before",
    "door_before",
    "other_before",
    "narrow_acked",
    "direct_after",
    "app_http_after",
    "git_after",
    "model_after",
    "door_after",
    "other_after",
    "door_refused_after",
    "proxy_down_fails",
)
# The checks of a run on loopback stand-ins: no TLS and no git host there.
PLAIN_CHECKS: Final = tuple(
    name for name in LANE_CHECKS if name not in ("app_https_before", "git_before", "git_after")
)
# What each bit must be. The proxy address came from the start; the VM reached nothing directly;
# every client reached its target through the proxy before the narrowing; the narrow was
# acknowledged; after it the app, GitHub and the model provider are reached, a host that is no part
# of the job's rule is refused (by the proxy for an opener, and through the chained door as a
# `502`), and a client whose proxy is not there fails and does not dial the target itself.
EXPECTED: Final = {
    "proxy_from_start": True,
    "direct_before": False,
    "app_http_before": True,
    "app_https_before": True,
    "git_before": True,
    "model_before": True,
    "door_before": True,
    "other_before": True,
    "narrow_acked": True,
    "direct_after": False,
    "app_http_after": True,
    "git_after": True,
    "model_after": True,
    "door_after": True,
    "other_after": False,
    "door_refused_after": False,
    "proxy_down_fails": True,
}
REPORT_DOMAIN: Final = "report.invalid"
MODEL_HOST: Final = "api.anthropic.com"


def lane_config(gateway: str, expected_port: int = 3128) -> dict[str, Any]:
    """The probe's targets in a lane's VM: `gateway` is the host's address on the slot's TAP, where
    the proxy listens (and what `outerProxy` of the start must say). The app is `example.com`
    (the lane starts the job with `http://example.com`), the host a job's rule does not list is
    `example.org`, and the git host is GitHub's smallest public repository."""
    return {
        "checks": list(LANE_CHECKS),
        "gateway": gateway,
        "expected_port": expected_port,
        "dead_port": 3129,
        "direct": ["1.1.1.1", 443],
        "other_url": "http://example.org/",
        "git_url": "https://github.com/octocat/Hello-World.git",
        "door_listed": ["github.com", "example.org"],
        "door_target": "github.com:443",
        "door_refused_target": "example.org:443",
        "model_host": MODEL_HOST,
        "tls": True,
        "slot_network": None,
        "connect_seconds": 4.0,
        "control": {"kind": "vsock"},
    }


# The most characters one argument of Control's `docker run` may have (`vm-init`'s contract).
MAX_ARGUMENT_CHARACTERS: Final = 4096


def render(config: dict[str, Any]) -> str:
    """The program, with `config` in it, as the one argument of `python -c`. It is longer than an
    argument of `docker run` may be (vm-init refuses more than 4096 characters), so it travels
    compressed and decompresses itself."""
    source = _SOURCE.replace("@CONFIG@", repr(json.dumps(config)))
    packed = base64.b85encode(zlib.compress(source.encode(), 9)).decode()
    return f"import base64,zlib;exec(zlib.decompress(base64.b85decode({packed!r})).decode())"


def decode(host: str, checks: tuple[str, ...] = LANE_CHECKS) -> dict[str, bool] | None:
    """What a `CONNECT r<bits>.report.invalid` named, or None when `host` is not a report."""
    suffix = f".{REPORT_DOMAIN}"
    if not host.endswith(suffix) or not host.startswith("r"):
        return None
    bits = host[1 : -len(suffix)]
    if len(bits) != len(checks) or set(bits) - {"0", "1"}:
        return None
    return {name: bit == "1" for name, bit in zip(checks, bits, strict=True)}


_SOURCE: Final = r"""
import ipaddress
import json
import re
import shutil
import socket
import sys
import tempfile
import urllib.request
from pathlib import Path

CONFIG = json.loads(@CONFIG@)
CHECKS = CONFIG["checks"]
ASKED = {}


def want(name):
    return name in CHECKS


def reachable(host, port):
    try:
        with socket.create_connection((host, port), timeout=CONFIG["connect_seconds"]):
            return True
    except OSError:
        return False


def opener_status(proxy, url, seconds=30):
    from code_reviewer_runner.job_loop.http import ApiUnavailable, build_opener, send

    try:
        request = urllib.request.Request(url, method="GET")
        return send(build_opener(proxy.url), request, seconds).status
    except ApiUnavailable:
        return 0


def git_lists(proxy, url):
    from code_reviewer_runner.implementer.git_process import (
        TRUSTED_PATH,
        GitProcess,
        config_environment,
        proxy_settings,
    )

    home = Path(tempfile.mkdtemp(prefix="probe-git-"))
    process = GitProcess(shutil.which("git", path=TRUSTED_PATH) or "git", TRUSTED_PATH, home, "x")
    configured = config_environment(proxy_settings(proxy.url))
    environment = {**process.base_environment("https"), **configured}
    done = process.run(["ls-remote", url, "HEAD"], env=environment, cwd="/", timeout=90)
    return done.returncode == 0 and re.match(r"[0-9a-f]{40}\tHEAD", done.stdout) is not None


def model_status(proxy):
    from code_reviewer_runner.dynamic_review.passthrough.upstream import (
        HttpsUpstream,
        UpstreamError,
        UpstreamRequest,
    )

    options = {} if CONFIG["tls"] else {"tls": lambda raw, hostname: raw}
    try:
        response = HttpsUpstream("https://" + CONFIG["model_host"], proxy=proxy, **options).send(
            UpstreamRequest("/v1/messages", {"content-type": "application/json"}, b"{}"), 30
        )
    except UpstreamError:
        return 0
    status = response.status
    response.close()
    return status


def door_status(proxy, listed, target):
    from code_reviewer_runner.implementer.netdoor.connections import ConnectionLog
    from code_reviewer_runner.implementer.netdoor.proxy import (
        Decider,
        ProxyServer,
        chained_connector,
    )
    from code_reviewer_runner.implementer.network_rule import MODE_LIST, NetworkRule

    log = ConnectionLog()
    decider = Decider(NetworkRule(MODE_LIST, tuple(listed)), log, chained=True)
    server = ProxyServer(("127.0.0.1", 0), decider, connector=chained_connector(proxy)).start()
    try:
        with socket.create_connection(("127.0.0.1", server.port), timeout=10) as agent:
            agent.settimeout(40)
            agent.sendall(("CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n" % (target, target)).encode())
            head = agent.recv(256)
    except OSError:
        return 0
    finally:
        server.stop()
    parts = head.split(b" ", 2)
    return int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0


def narrow(token):
    from code_reviewer_runner.implementer.environment_control import VsockControl
    from code_reviewer_runner.implementer.network_rule import OFF

    kind = CONFIG["control"]
    if kind["kind"] == "vsock":
        control = VsockControl(token=token, narrow_seconds=25.0)
    else:
        def connect(timeout):
            return socket.create_connection((kind["host"], kind["port"]), timeout=timeout)

        control = VsockControl(connect=connect, token=token, narrow_seconds=25.0)
    try:
        control.narrow(OFF, CONFIG["model_host"])
    except Exception:
        return False
    return True


def report(proxy, bits):
    # The proxy refuses this name and logs it: the report is the name.
    try:
        with socket.create_connection((proxy.host, proxy.port), timeout=10) as sock:
            sock.settimeout(30)
            target = "r%s.report.invalid:443" % bits
            sock.sendall(("CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n" % (target, target)).encode())
            sock.recv(64)
    except OSError:
        pass


def main():
    from code_reviewer_runner import outer_proxy

    if CONFIG["slot_network"] is not None:
        # The unit run's loopback stand-in for the slots' network; the VM has the real one.
        outer_proxy.SLOT_NETWORK = ipaddress.IPv4Network(CONFIG["slot_network"])
    job = json.loads(sys.stdin.readline())
    seen = {}
    try:
        proxy = outer_proxy.OuterProxy.from_json(job["outerProxy"])
    except Exception:
        return 1
    expected = (CONFIG["gateway"], CONFIG["expected_port"])
    seen["proxy_from_start"] = (proxy.host, proxy.port) == expected
    app = job["appUrl"].rstrip("/")
    direct_host, direct_port = CONFIG["direct"]

    seen["direct_before"] = reachable(direct_host, direct_port)
    seen["app_http_before"] = opener_status(proxy, app + "/") == 200
    if want("app_https_before"):
        secure = app.replace("http://", "https://")
        seen["app_https_before"] = opener_status(proxy, secure + "/") == 200
    if want("git_before"):
        seen["git_before"] = git_lists(proxy, CONFIG["git_url"])
    seen["model_before"] = model_status(proxy) in (400, 401, 403)
    seen["door_before"] = door_status(proxy, CONFIG["door_listed"], CONFIG["door_target"]) == 200
    seen["other_before"] = opener_status(proxy, CONFIG["other_url"]) == 200
    seen["narrow_acked"] = narrow(job["controlToken"])
    seen["direct_after"] = reachable(direct_host, direct_port)
    seen["app_http_after"] = opener_status(proxy, app + "/") == 200
    if want("git_after"):
        seen["git_after"] = git_lists(proxy, CONFIG["git_url"])
    seen["model_after"] = model_status(proxy) in (400, 401, 403)
    seen["door_after"] = door_status(proxy, CONFIG["door_listed"], CONFIG["door_target"]) == 200
    seen["other_after"] = opener_status(proxy, CONFIG["other_url"]) == 200
    seen["door_refused_after"] = (
        door_status(proxy, CONFIG["door_listed"], CONFIG["door_refused_target"]) == 200
    )
    dead = outer_proxy.OuterProxy(proxy.host, CONFIG["dead_port"])
    seen["proxy_down_fails"] = opener_status(dead, app + "/", 6) == 0
    report(proxy, "".join("1" if seen[name] else "0" for name in CHECKS))
    return 0


try:
    status = main()
except BaseException:
    status = 1
sys.exit(status)
"""
