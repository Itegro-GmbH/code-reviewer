# SPDX-License-Identifier: LicenseRef-Proprietary

"""MCP servers of an Implementer step (#1067, epic #1049): the job's `implementer.mcp`, the access
the job host hands the door, the harness configuration of both engines, and the feature the Worker
announces. Pure: nothing is run."""

import json
from pathlib import Path
from typing import Any

import pytest
from mcp_door_support import JOB_CREDENTIAL, JOB_ID, SERVER_A, SERVER_B

from code_reviewer_runner.dynamic_review.job_model_entry import (
    native_model_reference,
    native_provider_config,
)
from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily, spec_of
from code_reviewer_runner.implementer.agent_container import (
    NO_PROXY,
    agent_document,
    proxy_environment,
)
from code_reviewer_runner.implementer.claude_code.command import (
    FINISH_SERVER,
    ClaudeCommand,
    SessionChoice,
    claude_environment,
)
from code_reviewer_runner.implementer.claude_code.login import ClaudeLogin
from code_reviewer_runner.implementer.config import (
    ALLOWED_TOOLS,
    DENIED_TOOLS,
    FINISH_MCP_SERVER,
    FINISH_TOOL_NAME,
    build_engine_config,
)
from code_reviewer_runner.implementer.mcp_config import (
    RESERVED_TOOL_NAMES,
    endpoint_keys,
    endpoints_of,
    mcp_door_wanted,
    opencode_block,
    opencode_permissions,
)
from code_reviewer_runner.implementer.network_rule import MODE_LIST, NetworkRule
from code_reviewer_runner.implementer.placement import HOSTED, Placement
from code_reviewer_runner.job import (
    JobError,
    McpServerRef,
    ReviewKind,
    parse_implementer_input,
)
from code_reviewer_runner.job_loop.host import mcp_access_of, process_stdin
from code_reviewer_runner.job_loop.worker_api import WORKER_FEATURES, HttpWorkerApi

pytestmark = pytest.mark.unit

ROOT = Path(__file__).resolve().parents[3]
EXAMPLE = ROOT / "contracts" / "examples" / "implementer" / "RunnerJobInput.json"
DOOR_URL = "http://10.213.77.5:3129"
MCP = {
    "servers": [
        {"id": SERVER_A, "name": "Issues", "transport": "streamable-http"},
        {"id": SERVER_B, "name": "Docs", "transport": "sse"},
    ]
}
ACCESS = {"appUrl": "https://app.example", "jobId": JOB_ID, "credential": JOB_CREDENTIAL}


def document(**changes: Any) -> dict[str, Any]:
    job = json.loads(EXAMPLE.read_text(encoding="utf-8"))
    for key, value in changes.items():
        if key == "mcp":
            job["implementer"]["mcp"] = value
        else:
            job[key] = value
    return job


def parsed(**changes: Any) -> Any:
    return parse_implementer_input(json.dumps(document(**changes)))


# -- the job -----------------------------------------------------------------------------------


# #1067-T07
def test_a_job_without_mcp_has_none_and_nothing_else_changes() -> None:
    job = parsed()

    assert job.implementer.mcp is None and job.mcp_access is None
    assert not mcp_door_wanted(job.implementer, {})


# #1067-T02
def test_the_servers_and_the_count_of_unavailable_ones_are_read_as_the_contract_says() -> None:
    job = parsed(mcp={**MCP, "unavailable": 2}, mcpAccess=ACCESS)

    mcp = job.implementer.mcp
    assert mcp is not None and mcp.unavailable == 2
    assert [(s.id, s.name, s.transport) for s in mcp.servers] == [
        (SERVER_A, "Issues", "streamable-http"),
        (SERVER_B, "Docs", "sse"),
    ]
    assert mcp_door_wanted(job.implementer, {})
    assert job.mcp_access is not None and job.mcp_access.credential == JOB_CREDENTIAL


# #1067-T07
def test_only_unavailable_servers_mean_no_door() -> None:
    job = parsed(mcp={"servers": [], "unavailable": 1})

    assert job.implementer.mcp is not None and job.implementer.mcp.servers == ()
    assert not mcp_door_wanted(job.implementer, {})


BAD_MCP: list[Any] = [
    {"servers": [{"id": SERVER_A, "name": "x", "transport": "stdio"}]},
    {"servers": [{"id": "nope", "name": "x", "transport": "sse"}]},
    {"servers": [{"id": SERVER_A, "name": "", "transport": "sse"}]},
    {"servers": [{"id": SERVER_A, "name": "n" * 65, "transport": "sse"}]},
    {"servers": [{"id": SERVER_A, "name": "x", "transport": "sse", "url": "https://x"}]},
    {"servers": [{"id": SERVER_A, "name": "x", "transport": "sse", "headers": {}}]},
    {"servers": [{"id": SERVER_A, "name": "x", "transport": "sse"}] * 2},
    {"servers": [], "unavailable": -1},
    {"servers": [], "unavailable": True},
    {"servers": "x"},
    {"servers": [], "extra": 1},
    "x",
]


@pytest.mark.parametrize("mcp", BAD_MCP)
def test_a_document_that_is_not_the_contracts_is_refused_free(mcp: Any) -> None:
    with pytest.raises(JobError):
        parsed(mcp=mcp)


@pytest.mark.parametrize(
    "access",
    [
        {**ACCESS, "credential": "crc_" + "x" * 43},
        {**ACCESS, "credential": "x"},
        {**ACCESS, "jobId": "nope"},
        {**ACCESS, "appUrl": "ftp://x"},
        {"appUrl": ACCESS["appUrl"], "jobId": JOB_ID},
        {**ACCESS, "extra": "x"},
    ],
)
def test_an_access_that_is_not_one_is_refused_without_naming_a_value(access: Any) -> None:
    with pytest.raises(JobError) as caught:
        parsed(mcp=MCP, mcpAccess=access)

    assert JOB_CREDENTIAL not in str(caught.value) and "crc_" not in str(caught.value)


# #1067-T01
def test_the_credential_is_scrubbed_from_every_output_and_never_printed() -> None:
    job = parsed(mcp=MCP, mcpAccess=ACCESS)

    assert JOB_CREDENTIAL in job.secrets
    assert JOB_CREDENTIAL not in repr(job) and JOB_CREDENTIAL not in repr(job.mcp_access)


# -- the job host --------------------------------------------------------------------------------


class _Api:
    worker_app_url = "https://app.example"


def raw(servers: list[dict[str, str]] | None) -> dict[str, Any]:
    if servers is None:
        return {"implementer": {}}
    return {"implementer": {"mcp": {"servers": servers}}}


# #1067-T01
def test_a_turn_with_servers_gets_the_access_on_its_stdin_and_nowhere_else() -> None:
    access = mcp_access_of(_Api(), JOB_ID, JOB_CREDENTIAL, raw(MCP["servers"]))
    assert access == ACCESS

    text = process_stdin({"reviewKind": "implementer"}, ReviewKind.IMPLEMENTER, None, access)

    assert json.loads(text)["mcpAccess"] == ACCESS


# #1067-T07
@pytest.mark.parametrize("servers", [None, [], [{"id": SERVER_A}]][:2])
def test_a_turn_without_servers_gets_no_access(servers: list[dict[str, str]] | None) -> None:
    assert mcp_access_of(_Api(), JOB_ID, JOB_CREDENTIAL, raw(servers)) is None
    text = process_stdin({"reviewKind": "implementer"}, ReviewKind.IMPLEMENTER, None, None)
    assert "mcpAccess" not in json.loads(text)


# #1067-T07
def test_the_loop_has_no_job_credential_so_its_turns_get_no_access() -> None:
    assert mcp_access_of(object(), JOB_ID, "lease-token", raw(MCP["servers"])) is None


# #1067-T07
def test_a_review_job_never_gets_an_access() -> None:
    text = process_stdin({"x": 1}, ReviewKind.DIFF, "t" * 43, ACCESS)

    assert json.loads(text) == {"x": 1}


def test_the_worker_api_says_which_app_its_credential_is_good_for() -> None:
    api = HttpWorkerApi("https://app.example/", JOB_CREDENTIAL)

    assert api.worker_app_url == "https://app.example"


# #1067-T08
def test_the_worker_announces_the_feature_that_reads_implementer_mcp() -> None:
    assert "implementer_mcp" in WORKER_FEATURES


# -- the keys, the endpoints -------------------------------------------------------------------


def refs(*names: str) -> list[McpServerRef]:
    return [
        McpServerRef(f"{i:08x}-0000-4000-8000-000000000000", name, "sse")
        for i, name in enumerate(names)
    ]


# #1067-T02
def test_a_key_is_the_name_as_a_plain_token_unique_and_never_the_finish_servers() -> None:
    keys = endpoint_keys(refs("Issues", "My Docs!", "finish", "issues", "!!!", "x" * 80))

    assert keys[0] == "Issues" and keys[1] == "My_Docs"
    assert keys[2] != "finish" and keys[2].startswith("finish_")
    assert keys[3] != "issues" and keys[3].lower() != "issues"
    assert keys[4] == "mcp"
    assert len(keys[5]) <= 64
    assert len({key.lower() for key in keys}) == len(keys)
    assert all(key.replace("_", "").replace("-", "").isalnum() for key in keys)


# #1067-T02
def test_a_key_that_could_build_the_name_of_a_built_in_tool_or_permission_is_renamed() -> None:
    # The engine names a tool `<key>_<tool>` and the config allows `<key>_*`: `finish_submit` +
    # `result` is the finish tool, `doom` + `loop` the permission `doom_loop`.
    names = ("finish_submit", "doom", "external", "Doom_Loop", "bash", "finish_submit_result")
    keys = endpoint_keys(refs(*names))

    for key in keys:
        for reserved in RESERVED_TOOL_NAMES:
            assert key.lower() != reserved and not reserved.startswith(key.lower() + "_"), key
    assert len({key.lower() for key in keys}) == len(keys)
    assert endpoint_keys(refs("github", "doomsday")) == ["github", "doomsday"], (
        "others stay as named"
    )


def test_the_reserved_names_hold_every_tool_and_permission_the_engine_config_names() -> None:
    assert set(ALLOWED_TOOLS) | set(DENIED_TOOLS) <= RESERVED_TOOL_NAMES
    assert f"{FINISH_MCP_SERVER}_{FINISH_TOOL_NAME}" in RESERVED_TOOL_NAMES
    assert {"doom_loop", "external_directory"} <= RESERVED_TOOL_NAMES


# #1067-T02
def test_an_endpoint_is_the_door_and_the_server_id_and_nothing_of_the_real_server() -> None:
    endpoints = endpoints_of(refs("Issues"), DOOR_URL + "/")

    assert [(e.key, e.url) for e in endpoints] == [
        ("Issues", f"{DOOR_URL}/mcp/00000000-0000-4000-8000-000000000000")
    ]


# -- OpenCode -------------------------------------------------------------------------------------


def make_engine_config(**overrides: Any) -> dict[str, Any]:
    entry = parse_implementer_input(EXAMPLE.read_text(encoding="utf-8")).implementer.model_entry
    assert entry is not None
    family = WireFamily(entry.family)
    options: dict[str, Any] = {
        "provider": native_provider_config(
            entry,
            base_url=spec_of(family).proxy_base_url("http://127.0.0.1:41000"),
            api_key="c" * 43,
        ),
        "model_reference": native_model_reference(entry),
        "family": family,
        "proxy_url": "http://127.0.0.1:41000",
        "capability": "c" * 43,
        "instructions_path": "/etc/code-reviewer/instructions.md",
    }
    options.update(overrides)
    return build_engine_config(**options)


# #1067-T02
def test_opencode_gets_a_remote_server_at_the_local_endpoint_for_each_server() -> None:
    endpoints = endpoints_of(refs("Issues", "Docs"), DOOR_URL)

    config = make_engine_config(mcp_endpoints=endpoints)

    assert config["mcp"] == {
        "Issues": {
            "type": "remote",
            "url": f"{DOOR_URL}/mcp/00000000-0000-4000-8000-000000000000",
            "enabled": True,
            "oauth": False,
            "timeout": 30000,
        },
        "Docs": {
            "type": "remote",
            "url": f"{DOOR_URL}/mcp/00000001-0000-4000-8000-000000000000",
            "enabled": True,
            "oauth": False,
            "timeout": 30000,
        },
    }
    assert config["permission"]["Issues_*"] == "allow" and config["permission"]["Docs_*"] == "allow"
    assert config["permission"]["*"] == "deny", "default-deny stays"
    assert "headers" not in json.dumps(config["mcp"]), "no header: the credential is not here"


# #1067-T02
def test_the_finish_tool_and_the_mcp_servers_live_side_by_side() -> None:
    config = make_engine_config(
        mcp_endpoints=endpoints_of(refs("Issues"), DOOR_URL),
        finish_command=("python3", "-I", "/etc/code-reviewer/factory-submit", "mcp"),
    )

    assert set(config["mcp"]) == {"finish", "Issues"}
    assert config["permission"]["finish_submit_result"] == "allow"


# #1067-T07
def test_a_turn_without_servers_has_the_config_it_had_before() -> None:
    assert make_engine_config(mcp_endpoints=()) == make_engine_config()
    assert make_engine_config()["mcp"] == {}


# #1067-T01
def test_no_credential_and_no_real_address_is_in_the_opencode_file() -> None:
    config = make_engine_config(mcp_endpoints=endpoints_of(refs("Issues"), DOOR_URL))

    text = json.dumps(config)
    assert JOB_CREDENTIAL not in text and "crj_" not in text
    assert "https://" not in json.dumps(config["mcp"]), "the address of a real server is not there"


def test_the_permissions_are_the_servers_of_the_step_and_no_more() -> None:
    assert opencode_permissions(endpoints_of(refs("a", "b"), DOOR_URL)) == {
        "a_*": "allow",
        "b_*": "allow",
    }
    assert opencode_block(()) == {} and opencode_permissions(()) == {}


# -- Claude Code ----------------------------------------------------------------------------------

SESSION = "d847dcf5-e741-4252-98b0-d73cbc39f2c0"


# #1067-T02
def test_claude_code_gets_http_servers_at_the_local_endpoints_next_to_the_finish_tool() -> None:
    argv = ClaudeCommand(
        model=None,
        session=SessionChoice.new(SESSION),
        finish_command=("/usr/local/bin/python3", "-I", "/etc/code-reviewer/factory-submit", "mcp"),
        mcp_endpoints=endpoints_of(refs("Issues", "Docs"), DOOR_URL),
    ).argv()

    servers = json.loads(argv[argv.index("--mcp-config") + 1])["mcpServers"]

    assert set(servers) == {FINISH_SERVER, "Issues", "Docs"}
    assert servers["Issues"] == {
        "type": "http",
        "url": f"{DOOR_URL}/mcp/00000000-0000-4000-8000-000000000000",
    }
    assert "--strict-mcp-config" in argv, "no .mcp.json of the repository"
    assert JOB_CREDENTIAL not in " ".join(argv) and "headers" not in json.dumps(servers)


# #1067-T07
def test_without_servers_and_without_a_schema_there_is_no_mcp_config_at_all() -> None:
    argv = ClaudeCommand(model=None, session=SessionChoice.new(SESSION)).argv()

    assert "--mcp-config" not in argv


# #1067-T02
def test_servers_without_a_result_schema_are_a_config_of_their_own() -> None:
    argv = ClaudeCommand(
        model=None,
        session=SessionChoice.new(SESSION),
        mcp_endpoints=endpoints_of(refs("Issues"), DOOR_URL),
    ).argv()

    assert set(json.loads(argv[argv.index("--mcp-config") + 1])["mcpServers"]) == {"Issues"}


# #1067-T01
def test_the_claude_environment_holds_the_login_and_no_job_credential() -> None:
    login = ClaudeLogin(
        "CLAUDE_CODE_OAUTH_TOKEN", "sk-" + "ant-" + "oat01-made-up-token-0000000000000000"
    )

    environment = claude_environment(login)

    assert JOB_CREDENTIAL not in " ".join(environment.values())


# -- the agent's container and the network door ---------------------------------------------------

LIST = NetworkRule(MODE_LIST, ("registry.npmjs.org",))


# #1067-T03
def test_the_mcp_door_is_not_sent_to_the_network_door_only_for_a_turn_that_has_one() -> None:
    plain = proxy_environment(LIST)
    with_mcp = proxy_environment(LIST, mcp=True)

    assert plain["NO_PROXY"] == NO_PROXY, "a turn without MCP is exactly what it was"
    assert "10.213.77.5" not in plain["NO_PROXY"].split(",")
    assert "10.213.77.5" in with_mcp["NO_PROXY"].split(",")
    assert {k: v for k, v in with_mcp.items() if k not in ("NO_PROXY", "no_proxy")} == {
        k: v for k, v in plain.items() if k not in ("NO_PROXY", "no_proxy")
    }, "the network rule itself is not changed: no MCP host, no new destination"


# #1067-T03
def test_the_agents_container_has_no_credential_no_door_mount_and_the_same_network_as_before() -> (
    None
):
    plain = agent_document("sha256:x", "vol", 1, rule=LIST)
    with_mcp = agent_document("sha256:x", "vol", 1, rule=LIST, mcp=True)

    assert JOB_CREDENTIAL not in json.dumps(with_mcp)
    differing = {k for k in with_mcp if with_mcp[k] != plain[k]}
    assert differing == {"Env"}, "only the proxy exemption differs"
    assert agent_document("sha256:x", "vol", 1, rule=LIST, mcp=False) == plain
    host = with_mcp["HostConfig"]
    assert host["NetworkMode"] == "code-reviewer-model"
    assert "PidMode" not in host and "VolumesFrom" not in host


def test_a_placement_on_the_incus_backend_has_no_mcp_door_yet() -> None:
    assert HOSTED.mcp_supported and HOSTED.mcp_door_url == DOOR_URL
    assert not Placement(split=True, door_address="10.9.9.9").mcp_supported
    assert HOSTED.no_proxy == HOSTED.no_proxy_for() and "10.213.77.5" not in HOSTED.no_proxy
