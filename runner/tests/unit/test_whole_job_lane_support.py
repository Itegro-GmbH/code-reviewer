# SPDX-License-Identifier: LicenseRef-Proprietary

"""What the whole-job lane (#999) stands on, run here against loopback: a lane costs a half hour of
CI and has no KVM here, so everything that is not the VM runs on this machine first. The test CA and
its name constraint; the lane's git host and provider with certificates of that CA; the
public-looking names and the two seams that make the *real* outer-wall proxy reach them; git as
the Worker runs it (`http.proxy`, https only, the token's header) cloning and pushing through the
proxy; the model door's upstream (`HttpsUpstream`) reaching the provider through it; a plain host
through it; the narrowing; and the lane's job document through the Worker's own parser.

What is not here, and only the lane proves: the Worker image trusting the CA, the guest's kernel,
the three rulesets in it, Sysbox, the agent."""

import asyncio
import json
import os
import socket
import ssl
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from collections.abc import Generator
from dataclasses import dataclass
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from fakes.wire.formats import Turn
from fakes.wire.upstream import ScriptedUpstream

from code_reviewer_runner.dynamic_review.passthrough.upstream import (
    HttpsUpstream,
    UpstreamError,
    UpstreamRequest,
)
from code_reviewer_runner.factory_runner.app_client import AppClient
from code_reviewer_runner.factory_runner.firecracker.outer_wall import VmIdentity
from code_reviewer_runner.factory_runner.firecracker.proxy_wall import SlotAddresses
from code_reviewer_runner.factory_runner.firecracker.slots import Slot
from code_reviewer_runner.factory_runner.firecracker.wire import NarrowMessage
from code_reviewer_runner.implementer.network_rule import MODE_LIST, NetworkRule
from code_reviewer_runner.outer_proxy import OuterProxy
from git_support import Origin, basic, raw, system_git

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "kvm"))
import lane_pki
import whole_job_support as job
from lane_internet import (
    APP_HOST,
    FILES_HOST,
    GIT_HOST,
    MODEL_HOST,
    SETUP_ONLY_HOST,
    FilesHost,
    LaneInternet,
)

pytestmark = [
    pytest.mark.integration,
    pytest.mark.allow_hosts(["127.0.0.1", "127.0.1.1"]),
]

# The proxy listens on HOST; the clients connect from 127.0.0.1, which is the guest the wall serves.
HOST, GUEST = "127.0.1.1", "127.0.0.1"
RUNNER = "crc_" + "K" * 43
VM = VmIdentity("vm-lane", Slot(0), APP_HOST, 80)
# What the door is told (a private address, as in a VM); `Lane.dial_proxy` stands for the TAP.
VM_PROXY = OuterProxy(Slot(0).host_address, 3128)


@dataclass
class Lane:
    ca: lane_pki.Ca
    fakes: job.LaneFakes
    wall: job.RecordingProxyWall
    port: int

    @property
    def internet(self) -> LaneInternet:
        return self.fakes.internet

    @property
    def origin(self) -> Origin:
        return self.fakes.origin

    @property
    def model(self) -> ScriptedUpstream:
        return self.fakes.model

    @property
    def files(self) -> FilesHost:
        return self.fakes.files

    def trust(self) -> ssl.SSLContext:
        """What the Worker image's trust store is: the system's, plus the lane's CA."""
        return ssl.create_default_context(cafile=str(self.ca.certificate_path))

    def narrow(self) -> None:
        message = NarrowMessage(
            NetworkRule(MODE_LIST, (job.GIT_HOST, job.FILES_HOST)), job.MODEL_HOST
        )
        assert asyncio.run(self.wall.narrow(VM, message)) is None

    def dial_proxy(self, address: tuple[str, int], timeout: float) -> socket.socket:
        """The door dials the host's address on the slot's TAP; here that is a loopback address."""
        assert address == (VM_PROXY.host, VM_PROXY.port)
        return socket.create_connection((HOST, self.port), timeout)

    def git(self, *args: str, cwd: Path) -> subprocess.CompletedProcess[str]:
        """git as the Worker runs it: https only, the token's header, the proxy as `http.proxy`."""
        environment = {
            "PATH": os.environ["PATH"],
            "HOME": str(cwd),
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_ALLOW_PROTOCOL": "https",
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_SSL_CAINFO": str(self.ca.certificate_path),
            "GIT_AUTHOR_NAME": "Lane",
            "GIT_AUTHOR_EMAIL": "lane@example.invalid",
            "GIT_COMMITTER_NAME": "Lane",
            "GIT_COMMITTER_EMAIL": "lane@example.invalid",
        }
        return subprocess.run(
            [
                system_git(),
                "-c",
                f"http.proxy=http://{HOST}:{self.port}",
                "-c",
                f"http.extraHeader=Authorization: {basic(job.GIT_TOKEN)}",
                *args,
            ],
            cwd=cwd,
            env=environment,
            capture_output=True,
            text=True,
            check=False,
            timeout=90,
        )


@pytest.fixture
def lane(tmp_path: Path) -> Generator[Lane]:
    ca = lane_pki.create_ca(tmp_path / "pki")
    with job.lane_fakes(tmp_path, ca) as fakes:
        wall = job.RecordingProxyWall(
            1,
            port=0,
            addresses=lambda _slot: SlotAddresses(HOST, GUEST),  # pyright: ignore[reportUnknownLambdaType]
            resolver=fakes.internet.resolve,
            connector=fakes.internet.connect,
        )
        asyncio.run(wall.start())
        asyncio.run(wall.admit(VM))
        try:
            yield Lane(ca, fakes, wall, wall.port_of(Slot(0)))
        finally:
            asyncio.run(wall.close())


def through(lane: Lane, url: str) -> bytes:
    """A plain http request through the proxy, as the Worker's opener makes it."""
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({"http": f"http://{HOST}:{lane.port}"})
    )
    with opener.open(url, timeout=30) as answer:
        return answer.read()


# #999-T03 (the job the lane sends is one the Worker accepts)
def test_the_lanes_job_is_one_the_worker_parses_with_the_lanes_repository_provider_and_rule() -> (
    None
):
    parsed = job.parsed()

    spec = parsed.implementer
    assert spec.repo.clone_url == job.CLONE_URL and spec.repo.full_name == "acme/widgets"
    assert spec.environment is not None
    assert spec.environment.network.hosts == (GIT_HOST, FILES_HOST)
    assert "files.lane.example.com/setup" in spec.environment.setup_script
    assert parsed.model_access is not None
    assert parsed.model_access["modelEntry"]["upstreamBaseUrl"] == f"https://{MODEL_HOST}/v1"


def test_the_fake_app_holds_the_lanes_job_to_the_contract_and_hands_it_to_the_claimant(
    lane: Lane,
) -> None:
    app = lane.fakes.app
    app.credentials[RUNNER] = "runner-kvm"
    app.queue_job("00000000-0000-4000-8000-0000000000e1", job.job_document())
    claim = AppClient(app.url, credential=RUNNER).claim()
    assert claim is not None

    request = urllib.request.Request(
        f"{app.url}/api/workers/v1/jobs/{claim.job_id}",
        headers={"Authorization": f"Bearer {claim.credential}"},
    )
    with urllib.request.urlopen(request, timeout=10) as answer:
        document = json.loads(answer.read())

    # The Worker gets the job as the lane wrote it; the App's contract checks (every request and
    # answer is held to the schemas) found nothing wrong with it.
    assert document["job"]["input"]["implementer"]["repo"]["cloneUrl"] == job.CLONE_URL
    assert app.violations == []


def test_the_lanes_job_carries_no_address_and_every_host_of_it_is_below_the_cas_one_domain() -> (
    None
):
    text = str(job.job_document())

    for host in (GIT_HOST, MODEL_HOST, APP_HOST, FILES_HOST, SETUP_ONLY_HOST):
        assert host.endswith("." + lane_pki.LANE_DOMAIN)
    assert "151.101" not in text and "127.0.0.1" not in text


# #999-T02 (the test CA vouches for one domain and nothing else)
def test_a_certificate_of_the_ca_is_good_for_a_lane_name_and_for_no_other_name(
    tmp_path: Path,
) -> None:
    ca = lane_pki.create_ca(tmp_path / "pki")
    good = lane_pki.server_context(ca, [GIT_HOST], tmp_path / "good")
    elsewhere = lane_pki.server_context(ca, ["github.com"], tmp_path / "elsewhere")
    client = ssl.create_default_context(cafile=str(ca.certificate_path))

    def handshake(server_context: ssl.SSLContext, name: str) -> str:
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)

        def serve() -> None:
            try:
                connection, _ = listener.accept()
                with server_context.wrap_socket(connection, server_side=True):
                    pass
            except OSError:
                pass

        thread = threading.Thread(target=serve, daemon=True)
        thread.start()
        try:
            address = ("127.0.0.1", listener.getsockname()[1])
            with (
                socket.create_connection(address, 10) as raw_,
                client.wrap_socket(raw_, server_hostname=name),
            ):
                return "ok"
        except ssl.SSLCertVerificationError as error:
            return error.verify_message
        finally:
            thread.join(5)
            listener.close()

    assert handshake(good, GIT_HOST) == "ok"
    assert handshake(good, "git.other.example.org") != "ok", "the name does not match"
    # A certificate of the CA for a name outside its domain is refused by the constraint, even
    # though the name on the certificate is the name asked for.
    assert "permitted" in handshake(elsewhere, "github.com")


def test_the_ca_and_its_key_are_the_only_secret_and_the_key_is_private_to_its_owner(
    tmp_path: Path,
) -> None:
    ca = lane_pki.create_ca(tmp_path)

    assert (tmp_path / lane_pki.CA_KEY).stat().st_mode & 0o777 == 0o600
    assert b"PRIVATE KEY" not in ca.certificate_path.read_bytes()
    assert lane_pki.load_ca(tmp_path).certificate == ca.certificate


# #999-T01 (the lane's resolver and connector: real decisions, an invented last step)
def test_a_lane_name_resolves_to_a_public_looking_address_and_anything_else_is_refused() -> None:
    internet = LaneInternet()
    internet.expose(GIT_HOST, 443, 40001)
    internet.expose(FILES_HOST, 80, 40002)

    [address] = internet.resolve(GIT_HOST, 443)

    assert address.startswith("151.101.1.")
    with pytest.raises(OSError, match="not a name of the lane"):
        internet.resolve("github.com", 443)
    with pytest.raises(OSError, match="nothing of the lane"):
        internet.connect(address, 80, 1.0)
    with pytest.raises(OSError, match="nothing of the lane"):
        internet.connect("151.101.1.99", 443, 1.0)


# #999-T01 (git through the proxy to the lane's https endpoint, as the Worker runs it)
def test_git_clones_and_pushes_through_the_proxy_to_the_lane_endpoint_with_the_token_and_the_ca(
    lane: Lane, tmp_path: Path
) -> None:
    work = tmp_path / "work"
    work.mkdir()

    cloned = lane.git("clone", "-q", job.CLONE_URL, "repo", cwd=work)

    assert cloned.returncode == 0, cloned.stderr
    repo = work / "repo"
    (repo / "hello.txt").write_text("hello\n")
    raw("add", "-A", cwd=repo)
    raw("commit", "-qm", "Add hello", cwd=repo)
    lane.narrow()
    pushed = lane.git("push", "-q", job.CLONE_URL, f"HEAD:refs/heads/{job.BRANCH}", cwd=repo)
    assert pushed.returncode == 0, pushed.stderr
    assert lane.origin.tip(job.BRANCH) == raw("rev-parse", "HEAD", cwd=repo)
    log = lane.wall.log_of(Slot(0))["connections"]
    assert {(each["host"], each["port"], each["outcome"]) for each in log} == {
        (GIT_HOST, 443, "allowed")
    }


def test_git_without_the_lanes_ca_does_not_trust_the_endpoint(lane: Lane, tmp_path: Path) -> None:
    # The image of the release has no such CA: a clone from the lane's host fails there. This is the
    # reason the lane derives an image of its own.
    done = subprocess.run(
        [system_git(), "-c", f"http.proxy=http://{HOST}:{lane.port}", "ls-remote", job.CLONE_URL],
        cwd=tmp_path,
        env={
            "PATH": os.environ["PATH"],
            "HOME": str(tmp_path),
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_SSL_CAINFO": "/nonexistent",
        },
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )

    assert done.returncode != 0
    assert "certificate" in done.stderr.lower() or "ssl" in done.stderr.lower()


def test_the_git_endpoint_refuses_a_request_without_the_token(lane: Lane, tmp_path: Path) -> None:
    environment = {
        "PATH": os.environ["PATH"],
        "HOME": str(tmp_path),
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_SSL_CAINFO": str(lane.ca.certificate_path),
    }

    done = subprocess.run(
        [system_git(), "-c", f"http.proxy=http://{HOST}:{lane.port}", "ls-remote", job.CLONE_URL],
        cwd=tmp_path,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )

    assert done.returncode != 0
    assert "Username" in done.stderr or "401" in done.stderr or "Authentication" in done.stderr


# #999-T01 (the model door's upstream reaches the lane's provider through the proxy)
def test_the_model_doors_upstream_reaches_the_lanes_provider_through_the_proxy_and_checks_the_ca(
    lane: Lane,
) -> None:
    def upstream(trust: ssl.SSLContext) -> HttpsUpstream:
        return HttpsUpstream(
            f"https://{MODEL_HOST}/v1",
            connect=lane.dial_proxy,
            tls=lambda raw_, hostname: trust.wrap_socket(raw_, server_hostname=hostname),
            proxy=VM_PROXY,
        )

    request = UpstreamRequest(
        "/chat/completions",
        {"content-type": "application/json", "authorization": f"Bearer {job.MODEL_KEY}"},
        b'{"model": "%s", "messages": [], "tools": [{"type": "function", '
        b'"function": {"name": "bash"}}]}' % job.MODEL.encode(),
    )

    answer = upstream(lane.trust()).send(request, 30)
    status = answer.status
    answer.close()
    # An image without the CA cannot reach it: the door's own TLS check holds through the tunnel.
    with pytest.raises(UpstreamError):
        upstream(ssl.create_default_context()).send(request, 30)

    assert status in (200, 400), "the provider answered (its strictness about the body is its own)"
    assert lane.model.records, "the provider saw the request"
    assert lane.model.records[0].headers.get("authorization") == f"Bearer {job.MODEL_KEY}"


# #999-T01 (a plain host through the proxy: the setup before the narrowing, the agent after it)
def test_a_plain_host_is_reached_through_the_proxy_and_a_setup_only_host_stops_at_the_narrowing(
    lane: Lane,
) -> None:
    assert through(lane, f"http://{FILES_HOST}/setup") == FilesHost.SETUP_BODY
    assert through(lane, f"http://{SETUP_ONLY_HOST}/setup") == FilesHost.SETUP_BODY

    lane.narrow()

    assert through(lane, f"http://{FILES_HOST}/agent") == FilesHost.AGENT_BODY
    with pytest.raises(urllib.error.HTTPError) as refused:
        through(lane, f"http://{SETUP_ONLY_HOST}/setup")
    assert refused.value.code == 403
    log = {
        (each["host"], each["outcome"], each["reason"])
        for each in lane.wall.log_of(Slot(0))["connections"]
    }
    assert (SETUP_ONLY_HOST, "allowed", None) in log
    assert (SETUP_ONLY_HOST, "refused", "not_listed") in log
    assert lane.wall.narrows and lane.wall.narrows[0].model_host == MODEL_HOST
    assert lane.wall.narrowed_at is not None


def test_the_lanes_scripted_model_is_the_one_script_the_job_needs() -> None:
    script = job.agent_script()

    assert [turn.tool for turn in script] == ["bash", None]
    assert isinstance(script[0], Turn) and job.AGENT_COPY in str(script[0].args)
    assert script[1].text == job.CLOSING
