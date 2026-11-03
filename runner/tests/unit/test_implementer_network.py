# SPDX-License-Identifier: LicenseRef-Proprietary

"""The environment's network rule from the job to the report (#745, step 7), without Docker: how the
job carries it, how the agent's container is told about the door, how the session starts the door
and narrows the VM's network policy, in which order and with what, and what the report says.

The door's own behaviour is `test_netdoor_proxy.py`; its container is `test_netdoor_launcher.py`."""

import json
from collections.abc import Callable
from typing import Any, cast

import pytest
from door_support import implementer_job_text

from code_reviewer_runner.implementer import session as session_module
from code_reviewer_runner.implementer.agent_container import (
    NETWORK_DOOR_URL,
    NO_PROXY,
    agent_document,
    proxy_environment,
)
from code_reviewer_runner.implementer.network_report import network_report
from code_reviewer_runner.implementer.network_rule import (
    MODE_LIST,
    MODE_OPEN,
    OFF,
    NetworkRule,
    parse_rule,
)
from code_reviewer_runner.implementer.network_switch import (
    model_host_of,
    narrow_policy,
    parse_switch,
)
from code_reviewer_runner.implementer.report import valid_block
from code_reviewer_runner.implementer.session import ImplementerSession, SessionSeams
from code_reviewer_runner.job import (
    IMPLEMENTER_NETWORK_SWITCH_VARIABLE,
    ImplementerEnvironment,
    JobError,
    parse_implementer_input,
)
from code_reviewer_runner.result import ErrorCode

pytestmark = pytest.mark.unit

LIST = NetworkRule(MODE_LIST, ("registry.npmjs.org", "*.pythonhosted.org"))
OPEN = NetworkRule(MODE_OPEN)


def job_text(environment: dict[str, Any] | None) -> str:
    document: dict[str, Any] = json.loads(implementer_job_text())
    if environment is not None:
        document["implementer"]["environment"] = environment
    return json.dumps(document)


# -- the job ---


# #745-T21
def test_the_job_carries_the_rule_with_or_without_a_script() -> None:
    both = parse_implementer_input(
        job_text({"name": "Node", "setupScript": "npm ci\n", "network": LIST.to_json()})
    ).implementer.environment
    assert both == ImplementerEnvironment("Node", "npm ci\n", LIST)
    assert both is not None and both.has_script

    only = parse_implementer_input(
        job_text({"name": "Node", "network": OPEN.to_json()})
    ).implementer.environment
    assert only == ImplementerEnvironment("Node", "", OPEN)
    assert only is not None and not only.has_script

    plain = parse_implementer_input(job_text({"name": "Node", "setupScript": "x\n"}))
    assert plain.implementer.environment is not None
    assert plain.implementer.environment.network == OFF, "no rule is off"


@pytest.mark.parametrize(
    "network",
    [
        {"mode": "list", "hosts": []},
        {"mode": "list", "hosts": ["10.0.0.1"]},
        {"mode": "open", "hosts": ["a.example.com"]},
        {"mode": "everything", "hosts": []},
        {"mode": "list"},
        "open",
        None,
    ],
)
def test_a_rule_that_is_not_the_contracts_makes_the_job_invalid(network: Any) -> None:
    with pytest.raises(JobError) as caught:
        parse_implementer_input(job_text({"name": "Node", "network": network}))
    assert caught.value.code is ErrorCode.INVALID_JOB
    assert "implementer.environment.network" in caught.value.detail
    assert "10.0.0.1" not in caught.value.detail, "the message names the field, not the value"


def test_an_empty_script_next_to_a_rule_is_still_refused() -> None:
    with pytest.raises(JobError):
        parse_implementer_input(job_text({"name": "Node", "setupScript": " \n", "network": {}}))


# -- the agent's container ---


# #745-T22
def test_off_gives_the_container_no_variable_and_the_other_modes_the_door_as_the_proxy() -> None:
    assert proxy_environment(OFF) == {}
    assert agent_document("sha256:x", "vol", 1)["Env"] == []
    for rule in (LIST, OPEN):
        variables = proxy_environment(rule)
        for name in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
            assert variables[name] == NETWORK_DOOR_URL
        assert variables["NO_PROXY"] == variables["no_proxy"] == NO_PROXY
        assert variables["NODE_USE_ENV_PROXY"] == "1"
        document = agent_document("sha256:x", "vol", 1, rule=rule)
        assert sorted(document["Env"]) == sorted(f"{k}={v}" for k, v in variables.items())
        assert NETWORK_DOOR_URL == "http://10.213.77.3:3128"


# #745-T22
def test_the_model_door_and_the_machine_itself_are_not_proxied() -> None:
    names = NO_PROXY.split(",")
    for name in ("localhost", "127.0.0.1", "10.213.77.2", "10.213.77.3"):
        assert name in names
    document = agent_document("sha256:x", "vol", 1, rule=LIST)
    joined = " ".join(document["Env"])
    assert "KEY" not in joined and "TOKEN" not in joined and "SECRET" not in joined


# -- the call that narrows the policy ---


def switch_text(rule: NetworkRule) -> str:
    return json.dumps(
        {
            "url": "https://dispatcher.example.test/network",
            "vm": "cr-implementer-0b9f6f4e-3c1a-4d9e-8f43-2a7d5e1c9b10-1",
            "appId": "factory",
            "network": rule.to_json(),
            "token": "t" * 64,
        }
    )


SWITCH = switch_text(LIST)


def test_the_switch_of_the_environment_is_read_back_and_unset_is_none() -> None:
    switch = parse_switch(SWITCH)
    assert switch is not None and switch.rule == LIST and switch.app_id == "factory"
    assert "t" * 64 not in repr(switch), "the token is not in a log line"
    assert parse_switch(None) is None and parse_switch("  ") is None


@pytest.mark.parametrize(
    "text",
    [
        "not json",
        "[]",
        json.dumps({"url": "https://x.example"}),
        SWITCH.replace("https://", "http://"),
        SWITCH.replace(
            "https://dispatcher.example.test", "https://user:pw@dispatcher.example.test"
        ),
        SWITCH.replace('"token": ', '"extra": 1, "token": '),
        SWITCH.replace('"mode": "list"', '"mode": "open"'),
        "x" * 40_000,
    ],
)
def test_a_switch_that_is_set_and_is_not_one_is_a_config_error_not_a_missing_switch(
    text: str,
) -> None:
    with pytest.raises(JobError) as caught:
        parse_switch(text)
    assert caught.value.code is ErrorCode.IMPLEMENTER_CONFIG_INVALID


class Dispatcher:
    """What the call meets: the answers in order, then the last one for ever."""

    def __init__(self, *answers: tuple[int, bytes] | type[BaseException]) -> None:
        self.answers = list(answers)
        self.bodies: list[dict[str, Any]] = []

    def __call__(self, url: str, body: bytes, timeout: float) -> tuple[int, bytes]:
        assert url == "https://dispatcher.example.test/network" and timeout > 0
        self.bodies.append(json.loads(body))
        answer = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        if isinstance(answer, type):
            raise answer("cut off")
        return answer


APPLIED = (200, b'{"status":"applied"}')


def narrow(post: Dispatcher, *, rule: NetworkRule = LIST, attempts: int = 4) -> int:
    switch = parse_switch(SWITCH)
    assert switch is not None
    return narrow_policy(
        switch, rule, "api.anthropic.com", post=post, attempts=attempts, sleep=lambda _: None
    )


# #745-T23
def test_the_call_sends_the_vm_the_rule_the_model_host_and_the_token_and_nothing_else() -> None:
    post = Dispatcher(APPLIED)
    assert narrow(post) == 1
    assert post.bodies == [
        {
            "vm": "cr-implementer-0b9f6f4e-3c1a-4d9e-8f43-2a7d5e1c9b10-1",
            "appId": "factory",
            "network": LIST.to_json(),
            "modelHost": "api.anthropic.com",
            "token": "t" * 64,
        }
    ]


# #745-T23
def test_a_call_that_was_cut_off_is_made_again_until_it_is_answered() -> None:
    """The switch ends the connection that carries the call that asks for it."""
    post = Dispatcher(ConnectionResetError, TimeoutError, (502, b""), APPLIED)
    assert narrow(post) == 4 and len(post.bodies) == 4


# #745-T23
def test_a_call_that_never_gets_through_ends_the_turn_free() -> None:
    post = Dispatcher(ConnectionResetError)
    with pytest.raises(JobError) as caught:
        narrow(post, attempts=3)
    assert caught.value.code is ErrorCode.SETUP_FAILED
    assert "network_switch_unavailable" in caught.value.detail and len(post.bodies) == 3


# #745-T23
@pytest.mark.parametrize("status", [400, 401, 403, 404, 409, 422])
def test_an_answer_of_no_is_not_asked_again(status: int) -> None:
    post = Dispatcher((status, b""))
    with pytest.raises(JobError) as caught:
        narrow(post)
    assert caught.value.code is ErrorCode.SETUP_FAILED
    assert "network_switch_refused" in caught.value.detail and len(post.bodies) == 1


# #745-T23
def test_a_200_that_does_not_say_applied_is_not_applied() -> None:
    post = Dispatcher((200, b"<html>ok</html>"), (200, b'{"status":"accepted"}'), APPLIED)
    assert narrow(post) == 3


# #745-T23
def test_a_rule_in_the_job_that_is_not_the_one_the_dispatcher_read_is_refused() -> None:
    post = Dispatcher(APPLIED)
    with pytest.raises(JobError) as caught:
        narrow(post, rule=OPEN)
    assert caught.value.code is ErrorCode.IMPLEMENTER_CONFIG_INVALID and post.bodies == []


def test_the_model_host_is_the_name_of_the_providers_address() -> None:
    assert model_host_of("https://API.Anthropic.com/v1") == "api.anthropic.com"
    assert model_host_of("https://openrouter.ai:443/api/v1") == "openrouter.ai"
    for bad in ("https://10.0.0.1/v1", "https://[::1]/v1", "https:///v1", ""):
        with pytest.raises(JobError):
            model_host_of(bad)


# -- the session ---


class FakeDoor:
    def __init__(self, calls: list[str], log: dict[str, Any] | None = None) -> None:
        self._calls = calls
        self._log = log
        self.end = None
        self.stopped = 0

    def stop(self) -> dict[str, Any] | None:
        self.stopped += 1
        self._calls.append("stop door")
        return self._log


class Rig:
    def __init__(
        self,
        monkeypatch: pytest.MonkeyPatch,
        environment: dict[str, Any] | None,
        *,
        switch: bool,
        answers: tuple[Any, ...] = (APPLIED,),
        door_error: JobError | None = None,
    ) -> None:
        self.calls: list[str] = []
        self.started_with: list[tuple[NetworkRule, float]] = []
        self.door = FakeDoor(
            self.calls,
            {
                "final": True,
                "allowed": 2,
                "refused": 1,
                "bytesIn": 900,
                "bytesOut": 100,
                "dropped": 0,
                "connections": [
                    {
                        "host": "example.com",
                        "port": 443,
                        "outcome": "refused",
                        "reason": "not_listed",
                        "count": 1,
                        "bytesIn": 0,
                        "bytesOut": 0,
                    }
                ],
            },
        )
        self.post = Dispatcher(*answers)
        original = self.post.__call__

        def post(url: str, body: bytes, timeout: float) -> tuple[int, bytes]:
            self.calls.append("narrow policy")
            return original(url, body, timeout)

        def start(rule: NetworkRule, *, deadline_seconds: float, seams: Any) -> FakeDoor:
            _ = seams
            self.calls.append("start door")
            if door_error is not None:
                raise door_error
            self.started_with.append((rule, deadline_seconds))
            return self.door

        monkeypatch.setattr(session_module, "start_network_door", start)
        job = parse_implementer_input(job_text(environment))
        rule = OFF if environment is None else parse_rule(environment["network"])
        variables = {IMPLEMENTER_NETWORK_SWITCH_VARIABLE: switch_text(rule)} if switch else {}
        self.session = ImplementerSession(
            job,
            workspace=cast("Any", None),
            command=["opencode"],
            place=lambda: cast("Any", None),
            environment=variables,
            seams=SessionSeams(switch_post=post, switch_pause_seconds=0),
        )

    def start(self) -> None:
        model = cast("Any", self.session)
        entry = model.job.implementer.model_entry
        self.session._start_network(  # pyright: ignore[reportPrivateUsage]
            cast("Any", type("Model", (), {"entry": entry})())
        )

    def block(self) -> dict[str, Any] | None:
        self.session._stop_network()  # pyright: ignore[reportPrivateUsage]
        return self.session._network_block()  # pyright: ignore[reportPrivateUsage]


def environment_of(rule: NetworkRule) -> dict[str, Any]:
    return {"name": "Node", "network": rule.to_json()}


# #745-T24
def test_a_list_starts_the_door_first_and_then_narrows_the_policy_with_the_model_host(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rig = Rig(monkeypatch, environment_of(LIST), switch=True)
    rig.start()

    assert rig.calls == ["start door", "narrow policy"], "the door is up before the switch"
    assert rig.started_with[0][0] == LIST
    [body] = rig.post.bodies
    entry = rig.session.job.implementer.model_entry
    assert body["modelHost"] == model_host_of(entry.upstream_base_url)
    block = rig.block()
    assert block is not None and valid_block(_with_base(block)) is not None
    assert (block["mode"], block["door"], block["vmPolicy"]) == ("list", True, "narrowed")
    assert (block["allowed"], block["refused"]) == (2, 1)
    assert rig.calls[-1] == "stop door"


# #745-T24
def test_open_has_a_door_and_leaves_the_policy_alone(monkeypatch: pytest.MonkeyPatch) -> None:
    rig = Rig(monkeypatch, environment_of(OPEN), switch=True)
    rig.start()

    assert rig.calls == ["start door"] and rig.post.bodies == []
    block = rig.block()
    assert block is not None
    assert (block["mode"], block["door"], block["vmPolicy"]) == ("open", True, "unchanged")


# #745-T24
def test_off_has_no_door_and_still_narrows_the_policy_to_what_control_needs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for environment in (environment_of(OFF), None):
        rig = Rig(monkeypatch, environment, switch=True)
        rig.start()

        assert rig.calls == ["narrow policy"], "no door at all"
        assert rig.post.bodies[0]["network"] == {"mode": "off", "hosts": []}
        block = rig.block()
        assert block is not None
        assert (block["mode"], block["door"], block["vmPolicy"]) == ("off", False, "narrowed")
        assert block["connections"] == []


# #745-T24
def test_without_a_switch_the_first_wall_alone_holds_and_the_report_says_so(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rig = Rig(monkeypatch, environment_of(LIST), switch=False)
    rig.start()

    assert rig.calls == ["start door"]
    block = rig.block()
    assert block is not None and block["vmPolicy"] == "not_configured"
    assert any("network policy was not changed" in note for note in rig.session._notes)  # pyright: ignore[reportPrivateUsage]


# #745-T24
def test_off_without_a_switch_has_nothing_to_report(monkeypatch: pytest.MonkeyPatch) -> None:
    rig = Rig(monkeypatch, None, switch=False)
    rig.start()

    assert rig.calls == [] and rig.block() is None


# #745-T24
def test_a_switch_that_is_refused_ends_the_turn_and_the_door_is_stopped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rig = Rig(monkeypatch, environment_of(LIST), switch=True, answers=((403, b""),))
    with pytest.raises(JobError) as caught:
        rig.start()

    assert caught.value.code is ErrorCode.SETUP_FAILED
    rig.session._stop_network()  # pyright: ignore[reportPrivateUsage]
    assert rig.door.stopped == 1, "the door the failed start left is ended with the turn"
    rig.session._stop_network()  # pyright: ignore[reportPrivateUsage]
    assert rig.door.stopped == 1, "and only once"


# #745-T24
def test_a_door_that_cannot_start_stops_the_turn_before_the_policy_is_touched(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    failure = JobError(ErrorCode.SETUP_FAILED, "network_door_unavailable: nope")
    rig = Rig(monkeypatch, environment_of(LIST), switch=True, door_error=failure)
    with pytest.raises(JobError):
        rig.start()

    assert rig.calls == ["start door"], "the policy is not narrowed for a turn that does not run"


# -- the report ---


def _with_base(network: dict[str, Any]) -> dict[str, Any]:
    return {
        "baseCommit": "a" * 40,
        "headCommit": None,
        "pushed": False,
        "branches": [],
        "branchesDropped": {"invalid": 0, "overflow": 0},
        "commits": [],
        "filesChanged": [],
        "summary": "",
        "opencode": None,
        "network": network,
    }


def block_with(**changes: Any) -> dict[str, Any]:
    block = network_report(LIST, None, door=True, vm_policy="narrowed")
    block.update(changes)
    return block


# #745-T25
def test_the_report_without_a_log_counts_nothing_and_is_a_valid_block() -> None:
    block = network_report(LIST, None, door=True, vm_policy="narrowed")

    assert block["connections"] == [] and block["allowed"] == block["refused"] == 0
    assert valid_block(_with_base(block)) is not None


# #745-T25
@pytest.mark.parametrize(
    "bad",
    [
        {"mode": "closed"},
        {"vmPolicy": "yes"},
        {"door": 1},
        {"allowed": -1},
        {"bytesIn": True},
        {"dropped": "0"},
        {"connections": "none"},
        {"connections": [{"host": "x"}]},
        {
            "connections": [
                dict(
                    host="a",
                    port=70000,
                    outcome="allowed",
                    reason=None,
                    count=1,
                    bytesIn=0,
                    bytesOut=0,
                )
            ]
        },
        {
            "connections": [
                dict(
                    host="a", port=443, outcome="maybe", reason=None, count=1, bytesIn=0, bytesOut=0
                )
            ]
        },
        {
            "connections": [
                dict(
                    host="a",
                    port=443,
                    outcome="refused",
                    reason="Not Listed",
                    count=1,
                    bytesIn=0,
                    bytesOut=0,
                )
            ]
        },
        {
            "connections": [
                dict(
                    host="a",
                    port=443,
                    outcome="refused",
                    reason=None,
                    count=0,
                    bytesIn=0,
                    bytesOut=0,
                )
            ]
        },
        {
            "connections": [
                dict(
                    host="a" * 254,
                    port=443,
                    outcome="allowed",
                    reason=None,
                    count=1,
                    bytesIn=0,
                    bytesOut=0,
                )
            ]
        },
        {"extra": 1},
    ],
)
def test_a_network_block_that_is_not_the_contracts_is_refused(bad: dict[str, Any]) -> None:
    assert valid_block(_with_base(block_with(**bad))) is None


# #745-T25
def test_a_hundred_entries_are_the_most_a_block_may_list() -> None:
    entry: Callable[[int], dict[str, Any]] = lambda i: {  # noqa: E731
        "host": f"h{i}.example",
        "port": 443,
        "outcome": "allowed",
        "reason": None,
        "count": 1,
        "bytesIn": 1,
        "bytesOut": 1,
    }
    assert (
        valid_block(_with_base(block_with(connections=[entry(i) for i in range(100)]))) is not None
    )
    assert valid_block(_with_base(block_with(connections=[entry(i) for i in range(101)]))) is None
