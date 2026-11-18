# SPDX-License-Identifier: LicenseRef-Proprietary

"""Pins down how the runner validates the job it reads from stdin: the shape, the allowed commands,
the pull request URL and the host it may point to. A bad job must be refused with a stable error
code before PR-Agent is imported, and the refusal must never echo a value from the job."""

import json
from pathlib import Path
from typing import Any

import pytest
from support import fake_provider

from code_reviewer_runner import llm_providers
from code_reviewer_runner.job import RESERVED_OPTIONS, Command, JobError, parse_job
from code_reviewer_runner.result import ErrorCode

PR_URL = "https://github.com/octo/repo/pull/7"
TOKEN = "dummy-installation-token-0123456789"
API_KEY = "dummy-openrouter-key-0123456789"
# A review job a previous release's app could have sent (frozen in fakes/fixtures).
PREVIOUS_RELEASE_JOB = (
    Path(__file__).resolve().parents[3] / "fakes" / "fixtures" / "previous-release-review-job.json"
)


def valid_job(**overrides: Any) -> dict[str, Any]:
    job: dict[str, Any] = {
        "prUrl": "https://github.com/octo/repo/pull/7",
        "command": "review",
        "git": {
            "provider": "github",
            "baseUrl": "https://api.github.com",
            "token": TOKEN,
            "botLogin": "code-reviewer[bot]",
        },
        "llm": {"provider": "openrouter", "model": "deepseek/deepseek-chat", "apiKey": API_KEY},
    }
    job.update(overrides)
    return job


def parse(job: dict[str, Any]) -> Any:
    return parse_job(json.dumps(job))


def refusal(raw: str) -> JobError:
    with pytest.raises(JobError) as caught:
        parse_job(raw)
    return caught.value


# CR-10-T01
def test_a_valid_job_is_parsed_into_typed_fields() -> None:
    job = parse(valid_job())

    assert job.command is Command.REVIEW
    assert job.pr_url == "https://github.com/octo/repo/pull/7"
    assert job.git.token == TOKEN
    assert job.git.bot_login == "code-reviewer[bot]"
    assert job.llm.api_key == API_KEY
    assert job.env == {}


def test_the_bot_login_gets_the_bot_suffix_when_it_is_missing() -> None:
    job = parse(valid_job(git={**valid_job()["git"], "botLogin": "code-reviewer"}))

    assert job.git.bot_login == "code-reviewer[bot]"


# #203-T14: /review is the only command; the removed ones are refused before PR-Agent is loaded.
def test_the_review_command_is_accepted() -> None:
    assert parse(valid_job(command="review")).command.value == "review"


@pytest.mark.parametrize("command", ["ask", "improve", "describe"])
def test_a_removed_command_is_an_invalid_command(command: str) -> None:
    error = refusal(json.dumps(valid_job(command=command)))

    assert error.code is ErrorCode.INVALID_COMMAND
    assert command not in error.detail


# CR-10-T04
@pytest.mark.parametrize(
    "raw",
    ["", "not json", "[1, 2]", '"text"', "null", '{"prUrl": '],
)
def test_input_that_is_not_a_json_object_is_an_invalid_job(raw: str) -> None:
    assert refusal(raw).code is ErrorCode.INVALID_JOB


# CR-10-T04
@pytest.mark.parametrize(
    "path",
    ["prUrl", "git", "git.token", "git.botLogin", "git.baseUrl", "llm", "llm.apiKey", "llm.model"],
)
def test_a_missing_required_field_is_an_invalid_job_that_names_the_field(path: str) -> None:
    job = valid_job()
    target: dict[str, Any] = job
    *parents, leaf = path.split(".")
    for key in parents:
        target = target[key]
    del target[leaf]

    error = refusal(json.dumps(job))

    assert error.code is ErrorCode.INVALID_JOB
    assert path in error.detail


@pytest.mark.parametrize("token", ["", "   ", "has space", "line\nbreak", 42, None])
def test_a_token_that_is_empty_or_not_a_clean_string_is_an_invalid_job(token: Any) -> None:
    job = valid_job(git={**valid_job()["git"], "token": token})

    assert refusal(json.dumps(job)).code is ErrorCode.INVALID_JOB


def test_an_unknown_top_level_field_is_an_invalid_job() -> None:
    error = refusal(json.dumps(valid_job(surprise=True)))

    assert error.code is ErrorCode.INVALID_JOB
    assert "surprise" in error.detail


def test_only_the_github_provider_and_a_registered_llm_provider_are_supported() -> None:
    gitlab = valid_job(git={**valid_job()["git"], "provider": "gitlab"})
    openai = valid_job(llm={**valid_job()["llm"], "provider": "openai"})

    assert refusal(json.dumps(gitlab)).code is ErrorCode.INVALID_JOB
    assert refusal(json.dumps(openai)).code is ErrorCode.INVALID_JOB


# #424-T03
@pytest.mark.parametrize(
    "provider",
    ["openai", "OpenRouter", "fakeai", "", "a" * 33, "open router", None, 7, ["openrouter"]],
)
def test_a_job_with_an_unregistered_llm_provider_is_an_invalid_job(provider: Any) -> None:
    job = valid_job(llm={**valid_job()["llm"], "provider": provider})

    error = refusal(json.dumps(job))

    assert error.code is ErrorCode.INVALID_JOB
    assert "llm.provider" in error.detail
    assert API_KEY not in error.detail


# #424-T03
def test_a_provider_that_the_registry_gains_is_accepted_and_kept_on_the_job(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = fake_provider()
    monkeypatch.setitem(llm_providers.PROVIDERS, fake.id, fake)

    job = parse(valid_job(llm={**valid_job()["llm"], "provider": "fakeai"}))

    assert job.llm.provider == "fakeai"


# #424-T04
def test_a_job_without_a_registry_change_keeps_openrouter_as_its_provider() -> None:
    assert parse(valid_job()).llm.provider == "openrouter"


# CR-10-T06
@pytest.mark.parametrize(
    "command",
    ["review; rm -rf /", "merge", "REVIEW", "review ", "add_docs", "", 7, None, ["review"]],
)
def test_a_command_outside_the_allowed_set_is_an_invalid_command(command: Any) -> None:
    assert refusal(json.dumps(valid_job(command=command))).code is ErrorCode.INVALID_COMMAND


def test_a_job_without_a_command_is_an_invalid_job() -> None:
    job = valid_job()
    del job["command"]

    assert refusal(json.dumps(job)).code is ErrorCode.INVALID_JOB


# #203-T13/T14: a review payload from a previous release may carry the legacy `args` and the option
# families of the removed tools; they are accepted for v1 compatibility and never reach PR-Agent.
def test_a_previous_release_review_payload_is_accepted_and_its_legacy_fields_are_ignored() -> None:
    job_input: dict[str, Any] = json.loads(PREVIOUS_RELEASE_JOB.read_text(encoding="utf-8"))
    job_input["args"] = ["why is this here?"]

    job = parse(job_input)

    assert job.command is Command.REVIEW
    assert job.llm.provider == "openrouter"  # #424-T04
    # Only the review tool's options are kept; the removed tools' options are dropped.
    assert job.env == {
        "PR_REVIEWER__EXTRA_INSTRUCTIONS": "Follow the repository rules.",
        "PR_REVIEWER__NUM_MAX_FINDINGS": "5",
    }


def test_legacy_review_arguments_are_accepted_and_never_echoed() -> None:
    job = parse(valid_job(command="review", args=[f"--config.model={API_KEY}"]))

    assert job.command is Command.REVIEW


# #203-T14: the removed commands are still refused, whatever else the payload carries.
def test_a_question_with_a_removed_command_is_an_invalid_command() -> None:
    error = refusal(json.dumps(valid_job(command="ask", args=[f"why {API_KEY}?"])))

    assert error.code is ErrorCode.INVALID_COMMAND
    assert "why" not in error.detail
    assert API_KEY not in error.detail


# CR-10-T09
@pytest.mark.parametrize(
    "pr_url",
    [
        "https://github.com/o/r/pull/1; id",
        "https://github.com/o/r/pull/1 && id",
        "https://github.com/o/r/pull/",
        "https://github.com/o/r/pull/abc",
        "https://github.com/o/r/pull/0",
        "https://github.com/o/r/pull/1/files",
        "https://github.com/o/r/pull/1?x=1",
        "https://github.com/o/r/pull/1#fragment",
        "https://github.com/o/r/issues/1",
        "https://github.com/o/pull/1",
        "https://user:pass@github.com/o/r/pull/1",
        "https://evil.example.com/o/r/pull/1",
        "https://github.com.evil.example.com/o/r/pull/1",
        "http://github.com/o/r/pull/1",
        "file:///etc/passwd",
        "ftp://github.com/o/r/pull/1",
        "github.com/o/r/pull/1",
        "$(id)",
        "",
        42,
        None,
    ],
)
def test_a_manipulated_pull_request_url_is_an_invalid_job(pr_url: Any) -> None:
    assert refusal(json.dumps(valid_job(prUrl=pr_url))).code is ErrorCode.INVALID_JOB


def test_the_pull_request_must_live_on_the_host_of_the_configured_git_api() -> None:
    enterprise = valid_job(
        prUrl="https://ghe.example.com/o/r/pull/3",
        git={**valid_job()["git"], "baseUrl": "https://ghe.example.com/api/v3"},
    )
    mismatch = valid_job(
        prUrl="https://github.com/o/r/pull/3",
        git={**valid_job()["git"], "baseUrl": "https://ghe.example.com/api/v3"},
    )

    assert parse(enterprise).pr_url == "https://ghe.example.com/o/r/pull/3"
    assert refusal(json.dumps(mismatch)).code is ErrorCode.INVALID_JOB


def test_plain_http_is_only_accepted_for_loopback_hosts() -> None:
    loopback = valid_job(
        prUrl="http://127.0.0.1:4010/o/r/pull/3",
        git={**valid_job()["git"], "baseUrl": "http://127.0.0.1:4010/api/v3"},
    )
    remote = valid_job(
        prUrl="http://ghe.example.com/o/r/pull/3",
        git={**valid_job()["git"], "baseUrl": "http://ghe.example.com/api/v3"},
    )

    assert parse(loopback).git.base_url == "http://127.0.0.1:4010/api/v3"
    assert refusal(json.dumps(remote)).code is ErrorCode.INVALID_JOB


@pytest.mark.parametrize(
    "base_url",
    [
        "https://user:pass@api.github.com",
        "https://api.github.com?x=1",
        "https://api.github.com#x",
        "ftp://api.github.com",
        "api.github.com",
        "",
    ],
)
def test_a_malformed_git_api_base_url_is_an_invalid_job(base_url: str) -> None:
    job = valid_job(git={**valid_job()["git"], "baseUrl": base_url})

    assert refusal(json.dumps(job)).code is ErrorCode.INVALID_JOB


def test_extra_environment_values_are_tool_settings_given_as_strings() -> None:
    job = parse(valid_job(env={"PR_REVIEWER__NUM_MAX_FINDINGS": "3"}))

    assert job.env == {"PR_REVIEWER__NUM_MAX_FINDINGS": "3"}
    for bad in ({"PATH": "/tmp"}, {"lower__case": "x"}, {"PR_REVIEWER__X": 3}, ["A__B"]):
        assert refusal(json.dumps(valid_job(env=bad))).code is ErrorCode.INVALID_JOB


@pytest.mark.parametrize(
    "key",
    [
        "GITHUB__USER_TOKEN",
        "GITHUB__BASE_URL",
        "GITHUB__PRIVATE_KEY",
        "GITHUB__DEPLOYMENT_TYPE",
        "OPENROUTER__KEY",
        "OPENROUTER__API_BASE",
        "OPENAI__KEY",
        "OPENAI__API_BASE",
        "ANTHROPIC__KEY",
        "AZURE__API_BASE",
        "LITELLM__EXTRA_HEADERS",
        "LITELLM__SUCCESS_CALLBACK",
        "CONFIG__MODEL",
        "CONFIG__MODEL_WEAK",
        "CONFIG__MODEL_REASONING",
        "CONFIG__FALLBACK_MODELS",
        "CONFIG__CUSTOM_MODEL_MAX_TOKENS",
        "CONFIG__MAX_MODEL_TOKENS",
        "CONFIG__EXTRA_CONFIG_URL",
        "CONFIG__GIT_PROVIDER",
        "CONFIG__PUBLISH_OUTPUT",
        "CONFIG__USE_REPO_SETTINGS_FILE",
        "PUSH_OUTPUTS__WEBHOOK_URL",
    ],
)
def test_extra_environment_cannot_touch_credentials_endpoints_models_or_outputs(key: str) -> None:
    error = refusal(json.dumps(valid_job(env={key: "attacker"})))

    assert error.code is ErrorCode.INVALID_JOB


def test_extra_environment_is_limited_to_the_settings_of_the_review_tool() -> None:
    assert parse(valid_job(env={"PR_REVIEWER__EXTRA_INSTRUCTIONS": "x"})).env == {
        "PR_REVIEWER__EXTRA_INSTRUCTIONS": "x"
    }


# #203 v1 compatibility: the removed tools' option families are accepted and ignored.
@pytest.mark.parametrize(
    "key",
    [
        "PR_DESCRIPTION__EXTRA_INSTRUCTIONS",
        "PR_CODE_SUGGESTIONS__EXTRA_INSTRUCTIONS",
        "PR_QUESTIONS__ENABLE_HELP_TEXT",
    ],
)
def test_extra_environment_ignores_the_settings_of_a_removed_tool(key: str) -> None:
    assert parse(valid_job(env={key: "x"})).env == {}


def test_extra_environment_values_are_not_treated_as_secrets() -> None:
    job = parse(valid_job(env={"PR_REVIEWER__INLINE_KEY_ISSUES": "true"}))

    assert job.env == {"PR_REVIEWER__INLINE_KEY_ISSUES": "true"}
    assert job.secrets == (job.git.token, job.llm.api_key)


def test_the_llm_endpoint_can_only_be_overridden_with_a_loopback_address() -> None:
    llm = valid_job()["llm"]

    assert parse(
        valid_job(llm={**llm, "baseUrl": "http://127.0.0.1:4011/api/v1/"})
    ).llm.base_url == ("http://127.0.0.1:4011/api/v1")
    assert parse(valid_job()).llm.base_url is None
    for base_url in (
        "https://openrouter.ai/api/v1",
        "https://evil.example.com/v1",
        "http://evil.example.com/v1",
        "http://127.0.0.1.evil.example.com/v1",
        "http://user:pw@127.0.0.1:1/v1",
        "http://127.0.0.1:1/v1?x=1",
        "ftp://127.0.0.1/v1",
        "",
        7,
    ):
        job = valid_job(llm={**llm, "baseUrl": base_url})
        assert refusal(json.dumps(job)).code is ErrorCode.INVALID_JOB, base_url


# #270-T04
def test_only_openrouter_requires_parameters_unless_a_test_double_asks() -> None:
    llm = valid_job()["llm"]
    loopback = "http://127.0.0.1:4011/api/v1"

    # No `baseUrl` is the provider itself (OpenRouter): the capability requirement applies.
    assert parse(valid_job()).llm.require_parameters is True
    # A local fake gets the request unchanged ...
    assert parse(valid_job(llm={**llm, "baseUrl": loopback})).llm.require_parameters is False
    # ... unless the test double that added the address asks for the field as well.
    asking = {**llm, "baseUrl": loopback, "requireParameters": True}
    assert parse(valid_job(llm=asking)).llm.require_parameters is True
    declining = {**llm, "baseUrl": loopback, "requireParameters": False}
    assert parse(valid_job(llm=declining)).llm.require_parameters is False


# #270-T04
def test_the_field_that_asks_for_required_parameters_is_only_accepted_with_a_loopback_address() -> (
    None
):
    llm = valid_job()["llm"]

    # The default destination always requires them: no switch to turn that off (or on) from a job.
    for value in (True, False):
        job = valid_job(llm={**llm, "requireParameters": value})
        assert refusal(json.dumps(job)).code is ErrorCode.INVALID_JOB, value
    for value in ("true", 1, None):
        job = valid_job(
            llm={**llm, "baseUrl": "http://127.0.0.1:4011/api/v1", "requireParameters": value}
        )
        assert refusal(json.dumps(job)).code is ErrorCode.INVALID_JOB, value


def test_the_context_window_of_an_unknown_model_is_an_explicit_bounded_number() -> None:
    llm = valid_job()["llm"]

    assert parse(valid_job(llm={**llm, "maxTokens": 163840})).llm.max_tokens == 163840
    assert parse(valid_job()).llm.max_tokens is None
    for value in (0, -1, 999, 10_000_001, 1.5, "1000", True):
        job = valid_job(llm={**llm, "maxTokens": value})
        assert refusal(json.dumps(job)).code is ErrorCode.INVALID_JOB, value


# CR-45-T06
def test_fallback_models_are_an_optional_bounded_list_of_valid_model_ids() -> None:
    llm = valid_job()["llm"]
    fallbacks = [
        "qwen/qwen3-coder",
        "openrouter/google/gemini-2.5-flash",
        "meta-llama/llama-3.3:free",
    ]

    parsed = parse(valid_job(llm={**llm, "fallbackModels": fallbacks}))

    assert parsed.llm.fallback_models == tuple(fallbacks)
    assert parse(valid_job(llm={**llm, "fallbackModels": []})).llm.fallback_models == ()
    assert parse(valid_job()).llm.fallback_models == ()


# CR-45-T06
@pytest.mark.parametrize(
    "value",
    [
        "qwen/qwen3-coder",  # not a list
        None,
        {"0": "qwen/qwen3-coder"},
        [7],
        [None],
        [["a/b"]],
        [""],
        ["  "],
        ["bad model"],
        ["model;rm -rf"],
        ["@format {env[X]}"],
        ["a/b\n"],
        ["a" * 201],
        ["a/b", "a/b"],  # repeated
        ["deepseek/deepseek-chat"],  # the primary model again
        ["openrouter/deepseek/deepseek-chat"],  # the primary model again, with the prefix
        [f"vendor/model-{n}" for n in range(6)],  # more than five
    ],
)
def test_an_invalid_fallback_model_list_is_an_invalid_job(value: Any) -> None:
    llm = valid_job()["llm"]

    error = refusal(json.dumps(valid_job(llm={**llm, "fallbackModels": value})))

    assert error.code is ErrorCode.INVALID_JOB
    assert "llm.fallbackModels" in error.detail


# CR-45-T06
def test_a_refused_fallback_model_is_not_echoed() -> None:
    llm = valid_job()["llm"]

    error = refusal(json.dumps(valid_job(llm={**llm, "fallbackModels": [f"bad {API_KEY}"]})))

    assert API_KEY not in error.detail


# CR-45 review: the runner's own pins win over the job
@pytest.mark.parametrize("key", sorted(RESERVED_OPTIONS))
def test_a_job_cannot_set_an_option_the_runner_pins(key: str) -> None:
    error = refusal(json.dumps(valid_job(env={key: "true"})))

    assert error.code is ErrorCode.INVALID_JOB
    assert key in error.detail


# CR-45-T04
@pytest.mark.parametrize(
    "key", ["PR_REVIEWER__A__B", "PR_REVIEWER__", "PR_REVIEWER___X", "PR_REVIEWER__X_"]
)
def test_extra_environment_names_are_a_single_option_name_without_nesting(key: str) -> None:
    assert refusal(json.dumps(valid_job(env={key: "x"}))).code is ErrorCode.INVALID_JOB


@pytest.mark.parametrize("suffix", ["\n", "\r", "\t", " ", "\x00", "\u200b", "\x7f"])
def test_a_pull_request_url_with_whitespace_or_control_characters_is_an_invalid_job(
    suffix: str,
) -> None:
    for pr_url in (PR_URL + suffix, suffix + PR_URL, PR_URL.replace("/pull/", f"/pull{suffix}/")):
        assert refusal(json.dumps(valid_job(prUrl=pr_url))).code is ErrorCode.INVALID_JOB


# CR-10-T07
def test_a_refusal_never_contains_a_value_from_the_job() -> None:
    job = valid_job(
        prUrl=f"https://evil.example.com/{TOKEN}/r/pull/1",
        git={**valid_job()["git"], "botLogin": f"bad login {API_KEY}"},
    )

    error = refusal(json.dumps(job))

    assert TOKEN not in error.detail
    assert API_KEY not in error.detail
    assert TOKEN not in str(error)


def test_input_beyond_the_size_limit_is_an_invalid_job() -> None:
    assert refusal(" " * (1024 * 1024 + 1)).code is ErrorCode.INVALID_JOB


def dynamic_job(**base_overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "repository": "octo/repo",
        "baseRef": "main",
        "headSha": "a" * 40,
        "previousReviewedSha": None,
        "comparison": "full",
    }
    base.update(base_overrides)
    return valid_job(
        reviewKind="dynamic",
        dynamic={"model": "vendor/model", "skill": "s", "limits": {"maxFindings": 5}},
        base=base,
    )


# #255-T01
def test_the_attempted_heads_of_a_claim_are_read_and_default_to_none() -> None:
    job = parse_job(json.dumps(dynamic_job(attemptedShas=["b" * 40, "c" * 40])))
    assert job.base is not None
    assert job.base.attempted_shas == ("b" * 40, "c" * 40)

    older = parse_job(json.dumps(dynamic_job()))
    assert older.base is not None
    assert older.base.attempted_shas == ()


# #255-T02
@pytest.mark.parametrize(
    "attempted",
    ["b" * 40, [1], ["B" * 40], ["short"], ["b" * 40] * 2, [f"{n:040x}" for n in range(21)], None],
)
def test_malformed_attempted_heads_are_an_invalid_job(attempted: Any) -> None:
    with pytest.raises(JobError) as refused:
        parse_job(json.dumps(dynamic_job(attemptedShas=attempted)))
    assert refused.value.code is ErrorCode.INVALID_JOB


# #257-T04
def test_the_truncation_flag_of_a_claim_is_read_and_defaults_to_false() -> None:
    truncated = parse_job(json.dumps(dynamic_job(attemptedShasTruncated=True)))
    assert truncated.base is not None
    assert truncated.base.attempted_shas_truncated is True

    older = parse_job(json.dumps(dynamic_job()))
    assert older.base is not None
    assert older.base.attempted_shas_truncated is False


# #257-T04
@pytest.mark.parametrize("flag", ["true", 1, None, [True]])
def test_a_malformed_truncation_flag_is_an_invalid_job(flag: Any) -> None:
    with pytest.raises(JobError) as refused:
        parse_job(json.dumps(dynamic_job(attemptedShasTruncated=flag)))
    assert refused.value.code is ErrorCode.INVALID_JOB


# #1093: `git.tokens` belongs to the Implementer's multi-repository job. A review never carries it,
# and `ReviewInput.secrets` would not mask it: refused, not ignored.
def test_a_review_job_with_git_tokens_is_refused() -> None:
    job = valid_job()
    job["git"] = {**job["git"], "tokens": [{"id": "t1", "token": "ghs_other-0123456789"}]}

    error = refusal(json.dumps(job))

    assert error.code is ErrorCode.INVALID_JOB
    assert "git.tokens is only for an implementer job" in error.detail
    assert "ghs_other" not in error.detail


def test_a_dynamic_review_job_with_git_tokens_is_refused() -> None:
    job = dynamic_job()
    job["git"] = {**job["git"], "tokens": [{"id": "t1", "token": "ghs_other-0123456789"}]}

    error = refusal(json.dumps(job))

    assert error.code is ErrorCode.INVALID_JOB
    assert "git.tokens is only for an implementer job" in error.detail
