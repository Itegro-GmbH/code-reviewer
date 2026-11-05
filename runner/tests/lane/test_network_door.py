# SPDX-License-Identifier: LicenseRef-Proprietary

"""The network door on a real Docker daemon (#745, step 7 of the sandbox plan).

What runs here is the real thing: the door's container made by `start_network_door` from the
Worker's image (hardened, on the model network at its own address, its egress table installed by the
one-shot `nft` container, the rule on its stdin), and an "agent" container of the agent image on the
model network with the environment the real agent container gets (`proxy_environment`). What is a
double is only the internet. CI has no internet, so the names the rule lists resolve, through the
door's `/etc/hosts`, to servers of ours on a second Docker network that the door treats as public
(`CiNetwork`: honoured only inside `10.213.99.0/24`, never set by production). Everything else the
door refuses is refused by the real checks: a name that is not listed, an IP literal, a port, a name
that resolves to a private address (and one that resolves to a private and a public one).

What it proves: the agent reaches a listed name through the door over plain HTTP and over a real
TLS tunnel, and is refused with the door's word for everything else; it has no way round the door
(the model network has no exit: a direct connection to the server fails, while a plain container on
the server's network reaches it, so the failure means something); the door cannot be used to reach
the VM's side of things (its own egress table drops the private ranges and the model network, and
lets only ports 80 and 443 through); and the log the door reports is the one of what happened.

What only a VM proves, and `docs/implementer.md` reports: the Sysbox wall and the platform's network
policy (the second wall), the registries of the internet, `npm install` and `pip install`."""

import json
import os
import re
import subprocess
import time
from collections.abc import Iterator

import pytest
from lane_support import LaneConfig, docker, lane_config

from code_reviewer_runner.dynamic_review.model_door_route import (
    MODEL_AGENT_ADDRESS,
    MODEL_NETWORK_GATEWAY,
    MODEL_NETWORK_NAME,
    MODEL_NETWORK_SUBNET,
    NETWORK_DOOR_ADDRESS,
    NETWORK_DOOR_PORT,
)
from code_reviewer_runner.implementer.agent_container import (
    NO_PROXY,
    PYTHON,
    proxy_environment,
)
from code_reviewer_runner.implementer.docker_api import DOCKER_SOCKET, DockerApi
from code_reviewer_runner.implementer.netdoor_launcher import (
    NETDOOR_CONTAINER_NAME,
    RULES_CONTAINER_NAME,
    CiNetwork,
    NetDoorSeams,
    RunningNetDoor,
    start_network_door,
)
from code_reviewer_runner.implementer.network_rule import MODE_LIST, NetworkRule
from code_reviewer_runner.job import JobError
from code_reviewer_runner.result import ErrorCode

CONTROL = "code-reviewer-lane-net-control"
AGENT = "code-reviewer-lane-net-agent"
ORIGIN = "code-reviewer-lane-net-origin"
ORIGIN_TWO = "code-reviewer-lane-net-origin-two"
OUTSIDER = "code-reviewer-lane-net-outsider"
CI_NETWORK = "code-reviewer-lane-net-public"
CI_CIDR = "10.213.99.0/29"
CI_GATEWAY = "10.213.99.1"
ORIGIN_ADDRESS = "10.213.99.2"
ORIGIN_TWO_ADDRESS = "10.213.99.3"
PRIVATE_ADDRESS = "10.0.9.9"
LABEL = ["--label", "code-reviewer.lane=1"]
RULE = NetworkRule(MODE_LIST, ("allowed.test", "*.pkg.test", "mixed.test", "internal.test"))
HOSTS = (
    f"allowed.test:{ORIGIN_ADDRESS}",
    f"a.pkg.test:{ORIGIN_ADDRESS}",
    f"deep.sub.pkg.test:{ORIGIN_ADDRESS}",
    f"other.test:{ORIGIN_TWO_ADDRESS}",
    f"internal.test:{PRIVATE_ADDRESS}",
    # One name with a public and a private address: refused as a whole.
    f"mixed.test:{ORIGIN_ADDRESS}",
    f"mixed.test:{PRIVATE_ADDRESS}",
)

# A server on both web ports. The TLS one has a certificate made for the run; the agent does not verify it (the
# door never looks inside a tunnel, so a certificate is not its business). Every request is answered with the Host
# it asked for.
ORIGIN_CODE = r"""
import http.server, os, ssl, subprocess, sys, threading
name = sys.argv[1]
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        host = self.headers.get("Host")
        body = ("origin-ok %s host=%s path=%s\n" % (name, host, self.path)).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        print("ACCESS %s %s" % (name, self.headers.get("Host")), flush=True)
    do_POST = do_GET
    def log_message(self, *a): pass
subprocess.run(
    ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "/tmp/k.pem",
     "-out", "/tmp/c.pem", "-days", "1", "-subj", "/CN=lane"],
    check=True, capture_output=True)
http.server.ThreadingHTTPServer.request_queue_size = 256
plain = http.server.ThreadingHTTPServer(("0.0.0.0", 80), Handler)
secure = http.server.ThreadingHTTPServer(("0.0.0.0", 443), Handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain("/tmp/c.pem", "/tmp/k.pem")
secure.socket = context.wrap_socket(secure.socket, server_side=True)
threading.Thread(target=plain.serve_forever, daemon=True).start()
print("READY", flush=True)
secure.serve_forever()
"""

# What the agent runs: a request through the proxy of its environment, answered with one line a test can
# read.
CLIENT_CODE = r"""
import json, socket, ssl, sys, urllib.error, urllib.request
kind, target = sys.argv[1], sys.argv[2]
def done(**fields):
    print(json.dumps(fields), flush=True)
try:
    if kind == "http":
        with urllib.request.urlopen(target, timeout=15) as r:
            done(status=r.status, body=r.read().decode(), door=r.headers.get("X-Network-Door"))
    elif kind == "https":
        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        with urllib.request.urlopen(target, timeout=15, context=context) as r:
            done(status=r.status, body=r.read().decode(), door=None)
    elif kind == "connect":
        host, port = target.rsplit(":", 1)
        import os
        proxy = os.environ["HTTPS_PROXY"].split("//")[1]
        s = socket.create_connection((proxy.split(":")[0], int(proxy.split(":")[1])), timeout=15)
        s.sendall(("CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n" % (target, target)).encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = s.recv(4096)
            if not chunk: break
            head += chunk
        lines = head.decode("latin-1").split("\r\n")
        door = [l.split(":", 1)[1].strip() for l in lines if l.lower().startswith("x-network-door")]
        done(status=int(lines[0].split()[1]), door=door[0] if door else None)
    elif kind == "hold":
        import os, threading, time
        proxy = os.environ["HTTPS_PROXY"].split("//")[1]
        host, port = proxy.split(":")
        held = []
        def tunnel():
            s = socket.create_connection((host, int(port)), timeout=15)
            s.sendall(b"CONNECT allowed.test:80 HTTP/1.1\r\nHost: allowed.test:80\r\n\r\n")
            data = b""
            while b"\r\n\r\n" not in data:
                data += s.recv(4096)
            held.append((s, data.split(b" ")[1]))
        threads = [threading.Thread(target=tunnel) for _ in range(int(target))]
        for t in threads: t.start()
        for t in threads: t.join()
        done(opened=sum(1 for _, status in held if status == b"200"), refused=sum(1 for _, status in held if status != b"200"))
        time.sleep(8)
    elif kind == "direct":
        host, port = target.rsplit(":", 1)
        s = socket.create_connection((host, int(port)), timeout=4)
        s.close()
        done(connected=True)
except urllib.error.HTTPError as error:
    done(status=error.code, door=error.headers.get("X-Network-Door"), body=error.read().decode())
except OSError as error:
    done(error=type(error).__name__)
"""


def api() -> DockerApi:
    host = os.environ.get("DOCKER_HOST", "")
    path = host.removeprefix("unix://") if host.startswith("unix://") else DOCKER_SOCKET
    return DockerApi(path, timeout=30.0)


def remove_everything() -> None:
    for name in (
        AGENT,
        ORIGIN,
        ORIGIN_TWO,
        OUTSIDER,
        CONTROL,
        NETDOOR_CONTAINER_NAME,
        RULES_CONTAINER_NAME,
    ):
        docker("rm", "-f", name, check=False)
    docker("network", "rm", MODEL_NETWORK_NAME, check=False)
    docker("network", "rm", CI_NETWORK, check=False)


def exec_in(
    container: str, *command: str, timeout: float = 60.0
) -> subprocess.CompletedProcess[str]:
    return docker("exec", container, *command, check=False, timeout=timeout)


def client(kind: str, target: str, container: str = AGENT) -> dict[str, object]:
    done = exec_in(container, PYTHON, "-I", "-c", CLIENT_CODE, kind, target)
    lines = [line for line in done.stdout.splitlines() if line.startswith("{")]
    assert lines, f"the client said nothing: {done.stdout!r} {done.stderr!r}"
    return json.loads(lines[-1])


def origin_log(name: str) -> str:
    return docker("logs", name, check=False).stdout


def door_seams() -> NetDoorSeams:
    return NetDoorSeams(
        api=api,
        hostname=lambda: CONTROL,
        ready_seconds=60.0,
        ci_network=CiNetwork(CI_NETWORK, CI_CIDR, HOSTS),
    )


@pytest.fixture(scope="module")
def lane() -> Iterator[RunningNetDoor]:
    config = lane_config()
    for image in (config.worker_image, config.agent_image):
        if docker("image", "inspect", image, check=False).returncode != 0:
            raise AssertionError(
                f"the image {image} is not in the daemon: build the targets `sandbox` "
                "(LANE_WORKER_IMAGE) and `agent` (LANE_AGENT_IMAGE) of runner/Dockerfile"
            )
    remove_everything()
    # The model network, as the model door's launcher makes it (no exit); the second network is "the internet",
    # with no exit either.
    try:
        docker(
            "network", "create", "--internal",
            "-o", "com.docker.network.bridge.gateway_mode_ipv4=isolated",
            "--subnet", MODEL_NETWORK_SUBNET, "--gateway", MODEL_NETWORK_GATEWAY,
            MODEL_NETWORK_NAME,
        )  # fmt: skip
    except AssertionError:
        # A daemon without the isolated gateway mode: an internal network has no exit all the same.
        docker(
            "network", "create", "--internal",
            "--subnet", MODEL_NETWORK_SUBNET, "--gateway", MODEL_NETWORK_GATEWAY,
            MODEL_NETWORK_NAME,
        )  # fmt: skip
    docker(
        "network", "create", "--internal", "--subnet", CI_CIDR, "--gateway", CI_GATEWAY, CI_NETWORK
    )
    for name, address in ((ORIGIN, ORIGIN_ADDRESS), (ORIGIN_TWO, ORIGIN_TWO_ADDRESS)):
        docker(
            "run", "-d", "--name", name, *LABEL, "--network", CI_NETWORK, "--ip", address,
            "--entrypoint", "/opt/venv/bin/python", config.worker_image,
            "-I", "-c", ORIGIN_CODE, name,
        )  # fmt: skip
    for name in (ORIGIN, ORIGIN_TWO):
        deadline = time.monotonic() + 60
        while "READY" not in origin_log(name):
            assert time.monotonic() < deadline, f"{name} did not start: {origin_log(name)}"
            time.sleep(0.3)
    # The stand-in of Control: the door's launcher takes the image to start the door from from the container it
    # runs in.
    docker(
        "run", "-d", "--name", CONTROL, *LABEL, "--entrypoint", "/usr/bin/tini",
        config.worker_image, "--", "sleep", "3600",
    )  # fmt: skip
    door = start_network_door(RULE, deadline_seconds=600.0, seams=door_seams())
    docker(
        "run", "-d", "--name", AGENT, *LABEL, "--network", MODEL_NETWORK_NAME,
        "--ip", MODEL_AGENT_ADDRESS, "--user", "0:0", "--runtime", config.runtime,
        *[a for n, v in proxy_environment(RULE).items() for a in ("--env", f"{n}={v}")],
        "--entrypoint", "sleep", config.agent_image, "3600",
    )  # fmt: skip
    # A plain container on the servers' network, without the door: the control that says a direct connection
    # works where it can.
    docker(
        "run", "-d", "--name", OUTSIDER, *LABEL, "--network", CI_NETWORK, "--user", "0:0",
        "--entrypoint", "sleep", config.agent_image, "3600",
    )  # fmt: skip
    try:
        yield door
    finally:
        door.stop()
        remove_everything()


# -- the door's container ---


# #745-L10
def test_the_door_is_the_container_the_launcher_describes_and_the_daemon_agrees(
    lane: RunningNetDoor,
) -> None:
    document = json.loads(docker("inspect", NETDOOR_CONTAINER_NAME).stdout)[0]
    host = document["HostConfig"]
    networks = document["NetworkSettings"]["Networks"]

    assert document["State"]["Running"] is True
    assert document["Config"]["User"] not in ("", "0", "0:0", "root")
    assert host["ReadonlyRootfs"] is True and host["Privileged"] is False
    assert host["CapDrop"] == ["ALL"] and not host.get("CapAdd")
    assert "no-new-privileges:true" in host["SecurityOpt"]
    assert host["Memory"] == host["MemorySwap"] > 0
    # Asked for -500 (`door_document`; a test of the definition holds it). A rootless daemon cannot go below its own score and
    # clamps it, so what is asserted here is that the door ranks below the agent's 1000 for the VM's OOM killer.
    assert host["OomScoreAdj"] < 1000
    assert not host.get("Binds") and not document["Mounts"]
    assert set(networks) == {"bridge", MODEL_NETWORK_NAME, CI_NETWORK}
    assert networks[MODEL_NETWORK_NAME]["IPAMConfig"]["IPv4Address"] == NETWORK_DOOR_ADDRESS
    # The only variable the container was given beyond the image's own is the lane's, and no secret is anywhere in it.
    image = json.loads(docker("image", "inspect", lane_config().worker_image).stdout)[0]
    given = set(document["Config"]["Env"]) - set(image["Config"]["Env"])
    assert given == {"NETDOOR_TEST_PUBLIC_CIDR=10.213.99.0/29"}
    assert "pythonhosted" not in json.dumps(document), (
        "the rule is on the door's stdin, not in its definition"
    )
    assert (
        docker("ps", "-a", "--format", "{{.Names}}").stdout.split().count(RULES_CONTAINER_NAME) == 0
    )


# -- what the agent reaches ---


# #745-L11
def test_the_agent_reaches_a_listed_name_over_plain_http_through_the_proxy_of_its_environment(
    lane: RunningNetDoor,
) -> None:
    answer = client("http", "http://allowed.test/some/path?x=1")

    assert answer["status"] == 200
    assert answer["body"] == "origin-ok " + ORIGIN + " host=allowed.test path=/some/path?x=1\n"
    assert "ACCESS " + ORIGIN + " allowed.test" in origin_log(ORIGIN)


# #745-L11
def test_the_agent_reaches_a_listed_name_over_a_tls_tunnel_the_door_never_opens(
    lane: RunningNetDoor,
) -> None:
    answer = client("https", "https://allowed.test/secure")

    assert answer["status"] == 200
    assert answer["body"] == "origin-ok " + ORIGIN + " host=allowed.test path=/secure\n"


# #745-L11
def test_a_suffix_entry_lets_every_name_below_it_through_and_not_the_name_itself(
    lane: RunningNetDoor,
) -> None:
    assert client("https", "https://a.pkg.test/")["status"] == 200
    assert client("https", "https://deep.sub.pkg.test/")["status"] == 200
    refused = client("connect", "pkg.test:443")
    assert (refused["status"], refused["door"]) == (403, "not_listed")


# -- what the agent is refused ---


# #745-L12
def test_a_name_the_list_does_not_have_is_refused_with_the_doors_word_and_never_reaches_the_server(
    lane: RunningNetDoor,
) -> None:
    before = origin_log(ORIGIN_TWO)

    plain = client("http", "http://other.test/")
    tunnel = client("connect", "other.test:443")

    assert (plain["status"], plain["door"]) == (403, "not_listed")
    assert (tunnel["status"], tunnel["door"]) == (403, "not_listed")
    assert origin_log(ORIGIN_TWO) == before, "the server of the unlisted name saw nothing"


# #745-L12
@pytest.mark.parametrize(
    "address", [ORIGIN_ADDRESS, "169.254.169.254", "8.8.8.8", "2130706433", "0x7f.1"]
)
def test_an_ip_address_is_refused_for_plain_http_and_for_a_tunnel(
    lane: RunningNetDoor, address: str
) -> None:
    plain = client("http", f"http://{address}/")
    tunnel = client("connect", f"{address}:443")

    assert (plain["status"], plain["door"]) == (403, "ip_literal")
    assert (tunnel["status"], tunnel["door"]) == (403, "ip_literal")


# #745-L12
@pytest.mark.parametrize("address", ["127.0.0.1", "[::1]", "[2001:db8::1]"])
def test_a_tunnel_to_loopback_or_an_ipv6_literal_is_refused_too(
    lane: RunningNetDoor, address: str
) -> None:
    # `NO_PROXY` keeps the agent's own loopback out of the proxy, so only a tunnel asked for by hand meets the door.
    tunnel = client("connect", f"{address}:443")

    assert (tunnel["status"], tunnel["door"]) == (403, "ip_literal")


# #745-L12
@pytest.mark.parametrize("name", ["internal.test", "mixed.test"])
def test_a_name_that_resolves_to_a_private_address_is_refused_also_with_a_public_one_beside_it(
    lane: RunningNetDoor, name: str
) -> None:
    before = origin_log(ORIGIN)

    tunnel = client("connect", f"{name}:443")
    plain = client("http", f"http://{name}/")

    assert (tunnel["status"], tunnel["door"]) == (403, "private_address")
    assert (plain["status"], plain["door"]) == (403, "private_address")
    assert f"host={name}" not in origin_log(ORIGIN)[len(before) - 1 :], (
        "the public address was not tried"
    )


# #745-L12
@pytest.mark.parametrize("port", [22, 25, 8080, 8443, 5432])
def test_a_port_other_than_80_and_443_is_refused_for_a_listed_name(
    lane: RunningNetDoor, port: int
) -> None:
    tunnel = client("connect", f"allowed.test:{port}")
    plain = client("http", f"http://allowed.test:{port}/")

    assert (tunnel["status"], tunnel["door"]) == (403, "port_not_allowed")
    assert (plain["status"], plain["door"]) == (403, "port_not_allowed")


# -- no way round the door ---


# #745-L13
@pytest.mark.parametrize(
    "target",
    [
        f"{ORIGIN_ADDRESS}:80",
        f"{ORIGIN_ADDRESS}:443",
        f"{ORIGIN_TWO_ADDRESS}:80",
        "1.1.1.1:443",
        f"{MODEL_NETWORK_GATEWAY}:22",
        f"{CI_GATEWAY}:80",
    ],
)
def test_the_agent_cannot_connect_to_anything_but_the_door_without_it(
    lane: RunningNetDoor, target: str
) -> None:
    answer = client("direct", target)

    assert "error" in answer and "connected" not in answer, answer


# #745-L13
def test_the_servers_are_reachable_from_their_own_network_so_the_failure_above_means_something(
    lane: RunningNetDoor,
) -> None:
    assert client("direct", f"{ORIGIN_ADDRESS}:80", OUTSIDER) == {"connected": True}


# #745-L13
def test_the_agent_has_no_name_server_of_its_own_to_ask() -> None:
    done = exec_in(
        AGENT, PYTHON, "-I", "-c",
        "import socket\ntry:\n    socket.getaddrinfo('allowed.test', 80)\n    print('resolved')\n"
        "except OSError:\n    print('no-name')\n",
    )  # fmt: skip

    assert done.stdout.strip() == "no-name"


# #745-L13
def test_the_door_is_the_only_proxy_and_the_model_door_and_the_machine_itself_are_not_proxied() -> (
    None
):
    environment = {
        entry.split("=", 1)[0]: entry.split("=", 1)[1]
        for entry in json.loads(docker("inspect", AGENT).stdout)[0]["Config"]["Env"]
        if "=" in entry
    }

    for name in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
        assert environment[name] == f"http://{NETWORK_DOOR_ADDRESS}:{NETWORK_DOOR_PORT}"
    assert environment["NO_PROXY"] == NO_PROXY
    assert "10.213.77.2" in NO_PROXY and "localhost" in NO_PROXY


# -- the door's own egress ---


def from_the_doors_namespace(config: LaneConfig, target: str) -> bool:
    """Whether a process in the door's network namespace gets a connection to `target` (host:port)."""
    code = (
        "import socket,sys\nh,p=sys.argv[1].rsplit(':',1)\n"
        "try:\n    socket.create_connection((h,int(p)),timeout=3).close();print('open')\n"
        "except OSError:\n    print('shut')\n"
    )
    done = docker(
        "run", "--rm", "--network", f"container:{NETDOOR_CONTAINER_NAME}", "--user", "10001:10001",
        "--entrypoint", "/opt/venv/bin/python", config.worker_image, "-I", "-c", code, target,
        check=False, timeout=60,
    )  # fmt: skip
    return done.stdout.strip() == "open"


# #745-L14
def test_the_doors_own_rules_let_ports_80_and_443_through_to_a_public_address_and_nothing_else(
    lane: RunningNetDoor,
) -> None:
    config = lane_config()

    assert from_the_doors_namespace(config, f"{ORIGIN_ADDRESS}:80")
    assert from_the_doors_namespace(config, f"{ORIGIN_ADDRESS}:443")
    # The same server, a port the table does not open.
    assert not from_the_doors_namespace(config, f"{ORIGIN_ADDRESS}:8080")
    assert not from_the_doors_namespace(config, f"{ORIGIN_ADDRESS}:22")


# #745-L14
def test_the_doors_own_rules_drop_the_model_network_and_the_private_ranges(
    lane: RunningNetDoor,
) -> None:
    config = lane_config()

    # The agent is on the model network and answers nothing at all, but a new connection into that network is
    # dropped before it could ask: the control is the door's listener, reached from the agent (replies are open).
    assert not from_the_doors_namespace(config, f"{MODEL_AGENT_ADDRESS}:22")
    for private in (
        "10.0.9.9:80",
        "172.17.0.1:80",
        "192.168.1.1:443",
        "100.64.0.1:80",
        "169.254.169.254:80",
    ):
        assert not from_the_doors_namespace(config, private), private


# -- what the door reports ---


# #745-L15
def test_the_log_the_door_reports_is_what_happened_with_the_bytes_and_nothing_of_the_content(
    lane: RunningNetDoor,
) -> None:
    # (#827) The door of the module is shared: the log holds the connections of every test before
    # this one, `other.test:443` among them (refused by another test), and the door says its status
    # at most once a second, so the log this test reads can lag behind its own connections. A name
    # that no other test uses is counted once, whichever status this test reads, and the wait is
    # for that name, never for names the earlier tests left in the log.
    alone = "only-in-the-log-test.test"
    client("https", "https://allowed.test/logged")
    client("connect", f"{alone}:443")
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        log = lane.snapshot()
        hosts = {c["host"] for c in (log or {}).get("connections", [])}
        if {"allowed.test", alone} <= hosts:
            break
        time.sleep(0.3)

    log = lane.snapshot()
    assert log is not None
    entries = {(c["host"], c["port"], c["outcome"], c["reason"]): c for c in log["connections"]}
    allowed = entries[("allowed.test", 443, "allowed", None)]
    assert allowed["count"] >= 1 and allowed["bytesIn"] > 0 and allowed["bytesOut"] > 0
    assert entries[(alone, 443, "refused", "not_listed")]["count"] == 1
    assert ("a.pkg.test", 443, "allowed", None) in entries
    assert log["refused"] >= 1 and log["allowed"] >= 1
    text = json.dumps(log)
    for secret in ("logged", "/secure", "origin-ok", "some/path"):
        assert secret not in text, f"the log holds {secret}: a path or a body"


# #745-L15
def test_the_door_stays_small_under_the_lane(lane: RunningNetDoor) -> None:
    stats = docker(
        "stats", "--no-stream", "--format", "{{.MemUsage}}|{{.PIDs}}", NETDOOR_CONTAINER_NAME
    ).stdout.strip()
    usage, pids = stats.split("|")
    used = re.match(r"([\d.]+)([KMG]i?B)", usage)
    assert used is not None
    megabytes = (
        float(used.group(1))
        * {"KiB": 1 / 1024, "MiB": 1, "GiB": 1024, "KB": 1 / 1024, "MB": 1, "GB": 1024}[
            used.group(2)
        ]
    )
    print(
        f"network door: {usage}, {pids} processes"
    )  # for the report of the step, not an assertion of a figure
    assert megabytes < 96 and int(pids) < 400


# #745-L16
def test_a_second_door_cannot_be_made_beside_the_first_and_the_first_goes_on(
    lane: RunningNetDoor,
) -> None:
    with pytest.raises(JobError) as refused:
        start_network_door(RULE, deadline_seconds=60.0, seams=door_seams())

    assert refused.value.code is ErrorCode.SETUP_FAILED
    assert "network_door_unavailable" in refused.value.detail
    assert client("http", "http://allowed.test/")["status"] == 200


# #745-L17
def test_the_door_holds_a_hundred_tunnels_open_at_once_within_its_memory_and_its_process_limit(
    lane: RunningNetDoor,
) -> None:
    holding = subprocess.Popen(
        ["docker", "exec", AGENT, PYTHON, "-I", "-c", CLIENT_CODE, "hold", "100"],
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        assert holding.stdout is not None
        first = json.loads(holding.stdout.readline())
        stats = docker(
            "stats", "--no-stream", "--format", "{{.MemUsage}}|{{.PIDs}}", NETDOOR_CONTAINER_NAME
        ).stdout.strip()
        usage, pids = stats.split("|")
        print(f"network door with 100 tunnels open: {usage}, {pids} processes")
        assert first == {"opened": 100, "refused": 0}
        assert int(pids) < 400
        assert float(re.match(r"([\d.]+)MiB", usage).group(1)) < 96  # type: ignore[union-attr]
    finally:
        holding.wait(timeout=60)
    assert client("http", "http://allowed.test/after")["status"] == 200, (
        "the door serves on afterwards"
    )
    assert (
        docker("inspect", NETDOOR_CONTAINER_NAME, "--format", "{{.State.OOMKilled}}").stdout.strip()
        == "false"
    )
