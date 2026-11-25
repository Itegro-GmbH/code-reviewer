# SPDX-License-Identifier: LicenseRef-Proprietary

"""The Worker's API client against `contracts/worker-api.v1.json` (#323).

A loopback server answers with the bodies of the contract examples and records what the client
sent: the routes, the credential in the one header it belongs in, and request bodies that are valid
against the schema. The client reads the examples as the contract says (the job details, the
heartbeat, the result), and an additive field of an answer does not break it.
"""

import asyncio
import json
import threading
from collections.abc import Iterator
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from code_reviewer_runner.job_loop.worker_api import HttpWorkerApi

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"
EXAMPLES = CONTRACTS / "examples" / "worker-api"
CREDENTIAL = "crj_" + "Q" * 43


def _registry() -> tuple[Registry[Any], str]:
    registry: Registry[Any] = Registry()
    worker_id = ""
    for name in ("runner-api.v1.json", "worker-api.v1.json"):
        schema = json.loads((CONTRACTS / name).read_text(encoding="utf-8"))
        registry = registry.with_resource(schema["$id"], Resource.from_contents(schema))
        worker_id = schema["$id"] if name == "worker-api.v1.json" else worker_id
    return registry, worker_id


REGISTRY, WORKER_ID = _registry()


def valid(definition: str, document: Any) -> bool:
    validator = Draft202012Validator(
        {"$ref": f"{WORKER_ID}#/$defs/{definition}"}, registry=REGISTRY
    )
    return bool(validator.is_valid(document))  # pyright: ignore[reportUnknownMemberType]


def example(name: str) -> Any:
    return json.loads((EXAMPLES / f"{name}.json").read_text(encoding="utf-8"))


class Recorder:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.extra_field = False
        self.superseded = False
        details = example("WorkerJobDetailsResponse")
        self.job_id: str = details["job"]["id"]
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def handle_any(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length)
                owner.calls.append(
                    {
                        "method": self.command,
                        "path": self.path,
                        "authorization": self.headers.get("Authorization"),
                        "body": json.loads(raw) if raw else None,
                    }
                )
                name = (
                    "WorkerJobDetailsResponse"
                    if self.command == "GET"
                    else "WorkerHeartbeatResponse"
                    if self.path.endswith("/heartbeat")
                    else "WorkerResultResponse"
                )
                answer = example(name)
                if owner.superseded and name == "WorkerHeartbeatResponse":
                    answer["job"]["superseded"] = True
                if owner.extra_field:
                    answer["somethingNew"] = {"nested": True}
                    answer["job"]["alsoNew"] = 1
                body = json.dumps(answer).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(body)

            do_GET = handle_any
            do_POST = handle_any

            def log_message(self, format: str, *args: Any) -> None:
                return

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"


@pytest.fixture
def recorder() -> Iterator[Recorder]:
    recording = Recorder()
    thread = threading.Thread(target=recording.server.serve_forever, daemon=True)
    thread.start()
    yield recording
    recording.server.shutdown()
    recording.server.server_close()
    thread.join(10)


# #323-T03
def test_the_client_speaks_the_worker_api_with_the_credential_in_the_authorization_header_only(
    recorder: Recorder,
) -> None:
    api = HttpWorkerApi(recorder.url, CREDENTIAL, request_timeout=5)
    result = example("WorkerResultRequest")["result"]
    job_id = recorder.job_id

    async def go() -> Any:
        job = await api.fetch(job_id)
        await api.heartbeat(job_id, CREDENTIAL)
        reply = await api.complete(job_id, CREDENTIAL, result)
        return job, reply

    job, reply = asyncio.run(go())

    paths = [(call["method"], call["path"].split("?")[0]) for call in recorder.calls]
    assert paths == [
        ("GET", f"/api/workers/v1/jobs/{job_id}"),
        ("POST", f"/api/workers/v1/jobs/{job_id}/heartbeat"),
        ("POST", f"/api/workers/v1/jobs/{job_id}/result"),
    ]
    assert {call["authorization"] for call in recorder.calls} == {f"Bearer {CREDENTIAL}"}
    # The credential is in no URL and in no body.
    assert CREDENTIAL not in json.dumps([[call["path"], call["body"]] for call in recorder.calls])
    # The details call names what this Worker reads, so the app sends optional fields to it.
    assert "features=dynamic_capabilities,supersede" in recorder.calls[0]["path"]
    # #424-T08: and the providers of the registry; an app from before ignores the parameter.
    # #511-T13: the registry has `anthropic` now, so the Worker advertises it.
    assert "llmProviders=openrouter,anthropic" in recorder.calls[0]["path"]
    query = parse_qs(urlsplit(str(recorder.calls[0]["path"])).query)
    assert valid("WorkerJobDetailsRequest", {name: values[0] for name, values in query.items()})
    assert valid("WorkerHeartbeatRequest", recorder.calls[1]["body"])
    assert valid("WorkerResultRequest", recorder.calls[2]["body"])
    assert job.id == job_id and job.input == example("WorkerJobDetailsResponse")["job"]["input"]
    assert reply.status in ("succeeded", "failed", "queued")


# #323-T01
def test_an_additive_field_of_an_answer_is_ignored(recorder: Recorder) -> None:
    recorder.extra_field = True
    api = HttpWorkerApi(recorder.url, CREDENTIAL, request_timeout=5)

    async def go() -> None:
        await api.fetch(recorder.job_id)
        await api.heartbeat(recorder.job_id, CREDENTIAL)
        await api.complete(recorder.job_id, CREDENTIAL, example("WorkerResultRequest")["result"])

    asyncio.run(go())

    assert len(recorder.calls) == 3


# #324-T11: the App accepts a Worker credential on /version only with the job id of its job.
def test_the_version_check_names_the_job_and_sends_the_credential_in_the_header_only(
    recorder: Recorder,
) -> None:
    api = HttpWorkerApi(recorder.url, CREDENTIAL, request_timeout=5)

    asyncio.run(api.check_app(recorder.job_id))

    (call,) = recorder.calls
    assert call["method"] == "GET"
    assert call["path"] == f"/api/runners/v1/version?jobId={recorder.job_id}"
    assert call["authorization"] == f"Bearer {CREDENTIAL}"
    assert CREDENTIAL not in call["path"]


# #396-T01
def test_a_superseded_heartbeat_answer_is_in_the_contract_and_is_understood(
    recorder: Recorder,
) -> None:
    recorder.superseded = True
    api = HttpWorkerApi(recorder.url, CREDENTIAL, request_timeout=5)

    reply = asyncio.run(api.heartbeat(recorder.job_id, CREDENTIAL))

    assert reply.superseded is True
    # The lease end of the answer reaches the host: the drain ends before it.
    assert (
        reply.lease_expires_at
        == datetime.fromisoformat(
            example("WorkerHeartbeatResponse")["job"]["leaseExpiresAt"]
        ).timestamp()
    )
    answer = {**example("WorkerHeartbeatResponse")}
    answer["job"] = {**answer["job"], "superseded": True}
    assert valid("WorkerHeartbeatResponse", answer)
    assert not valid(
        "WorkerHeartbeatResponse", {**answer, "job": {**answer["job"], "superseded": "yes"}}
    )


# #396-T01
def test_a_heartbeat_answer_without_the_field_is_not_superseded(recorder: Recorder) -> None:
    api = HttpWorkerApi(recorder.url, CREDENTIAL, request_timeout=5)

    assert asyncio.run(api.heartbeat(recorder.job_id, CREDENTIAL)).superseded is False


# #1150-W01
def test_a_worker_without_a_device_login_asks_for_the_login_of_the_workspace(
    recorder: Recorder,
) -> None:
    holding = HttpWorkerApi(recorder.url, CREDENTIAL, request_timeout=5)
    without = HttpWorkerApi(recorder.url, CREDENTIAL, request_timeout=5, workspace_login=True)

    async def go() -> None:
        await holding.fetch(recorder.job_id)
        await without.fetch(recorder.job_id)

    asyncio.run(go())

    kept, asked = (parse_qs(urlsplit(str(call["path"])).query) for call in recorder.calls[:2])
    assert "login" not in kept
    assert asked["login"] == ["workspace"]
    assert valid("WorkerJobDetailsRequest", {name: values[0] for name, values in asked.items()})
