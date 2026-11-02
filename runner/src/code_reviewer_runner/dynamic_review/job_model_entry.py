# SPDX-License-Identifier: LicenseRef-Proprietary

"""The per-job model entry (#548, part E) and the provider block of the engine's configuration.

The app tells a job which provider and model it runs with in an entry that holds no secret
(`contracts/job-model-entry.v1.json`, written by `app/src/models-dev/job-entry.ts`). This module
reads that entry strictly (the closed object of the contract, with no schema library at run time)
and builds from it the `provider.<id>` block the pinned engine is configured with. What the spike
(#546) found about that engine decides the shape:

- `npm` is always set: a provider the engine does not know is otherwise treated as OpenAI-compatible
  and spoken to in Chat;
- the engine is pointed at the loopback address of the per-job proxy with a dummy key
  (`options.baseURL`, `options.apiKey`); the real key and the upstream address are the supervisor's
  and never enter the block;
- a model that is not in the engine's own snapshot is resolved from `models.<m>` alone, with both
  limits (or none) and a status the engine does not drop (`deprecated` and `alpha` models are
  dropped; the app writes them as `active`).

Nothing here is wired into the job yet: the production path still builds its configuration in
`config.py`. The passthrough proxy that makes the block usable is #550.
"""

import copy
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from code_reviewer_runner.job_loop.jsonvalues import as_object

_PROVIDER_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_MODEL_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,199}$")
_UPSTREAM = re.compile(r"^https://[^\s?#@]+$")
# The SDKs the pinned engine bundles (BUNDLED_PROVIDERS at the pin), an allow-list: the SDK
# decides which code the engine loads. The same list as `contracts/job-model-entry.v1.json`
# (a contract test compares them).
BUNDLED_NPM = (
    "@ai-sdk/amazon-bedrock",
    "@ai-sdk/amazon-bedrock/mantle",
    "@ai-sdk/anthropic",
    "@ai-sdk/azure",
    "@ai-sdk/google",
    "@ai-sdk/google-vertex",
    "@ai-sdk/google-vertex/anthropic",
    "@ai-sdk/openai",
    "@ai-sdk/openai-compatible",
    "@openrouter/ai-sdk-provider",
    "@ai-sdk/xai",
    "@ai-sdk/mistral",
    "@ai-sdk/groq",
    "@ai-sdk/deepinfra",
    "@ai-sdk/cerebras",
    "@ai-sdk/cohere",
    "@ai-sdk/gateway",
    "@ai-sdk/togetherai",
    "@ai-sdk/perplexity",
    "@ai-sdk/vercel",
    "@ai-sdk/alibaba",
    "gitlab-ai-provider",
    "@ai-sdk/github-copilot",
    "venice-ai-sdk-provider",
)
# The names the entry may carry the reasoning of a tool loop in (`Interleaved.field`).
INTERLEAVED_FIELDS = ("reasoning_content", "reasoning_details")
_FAMILIES = ("openai-chat", "openai-responses", "anthropic-messages", "google")
_AUTH_HEADERS = ("Authorization", "x-api-key", "x-goog-api-key")
_MODALITIES = ("text", "audio", "image", "video", "pdf")
_STATUSES = ("active", "beta")
_MAX_LIMIT = 100_000_000
_ENTRY_KEYS = {
    "version",
    "providerId",
    "npm",
    "family",
    "authHeader",
    "upstreamBaseUrl",
    "modelId",
    "model",
}
_MODEL_KEYS = {
    "name",
    "status",
    "tool_call",
    "reasoning",
    "temperature",
    "limit",
    "modalities",
    "interleaved",
}
_REQUIRED_MODEL_KEYS = _MODEL_KEYS - {"interleaved"}
# The keys a model of the engine's configuration may have (the same set the entry is read with).
MODEL_KEYS = frozenset(_MODEL_KEYS)


class JobModelEntryError(ValueError):
    """The entry breaks the contract, or the engine would be pointed somewhere it must not be."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class JobModelEntry:
    provider_id: str
    npm: str
    family: str
    auth_header: str
    upstream_base_url: str
    model_id: str
    model: dict[str, Any]


def _invalid() -> JobModelEntryError:
    return JobModelEntryError("job_model_entry_invalid")


def _integer(value: Any, *, maximum: int = _MAX_LIMIT) -> bool:
    # `True` is an int in Python and not one in JSON.
    return isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= maximum


def _text(value: Any, pattern: re.Pattern[str], limit: int) -> bool:
    return isinstance(value, str) and len(value) <= limit and pattern.fullmatch(value) is not None


def _checked_limit(value: Any) -> dict[str, int]:
    limit = as_object(value)
    if limit is None or not {"context", "output"} <= set(limit) <= {"context", "output", "input"}:
        raise _invalid()
    if not all(_integer(item) for item in limit.values()):
        raise _invalid()
    return {key: int(item) for key, item in limit.items()}


def _checked_modalities(value: Any) -> dict[str, list[str]]:
    modalities = as_object(value)
    if modalities is None or set(modalities) != {"input", "output"}:
        raise _invalid()
    result: dict[str, list[str]] = {}
    for side in ("input", "output"):
        items: Any = modalities[side]
        if not isinstance(items, list):
            raise _invalid()
        listed: list[Any] = list(items)  # pyright: ignore[reportUnknownArgumentType]
        if len(set(map(str, listed))) != len(listed) or any(
            item not in _MODALITIES for item in listed
        ):
            raise _invalid()
        result[side] = [str(item) for item in listed]
    return result


def _checked_model(value: Any) -> dict[str, Any]:
    model = as_object(value)
    if model is None or not _REQUIRED_MODEL_KEYS <= set(model) <= _MODEL_KEYS:
        raise _invalid()
    name = model["name"]
    if not isinstance(name, str) or not 1 <= len(name) <= 120:
        raise _invalid()
    if model["status"] not in _STATUSES or model["tool_call"] is not True:
        raise _invalid()
    if not isinstance(model["reasoning"], bool) or not isinstance(model["temperature"], bool):
        raise _invalid()
    checked: dict[str, Any] = {
        "name": name,
        "status": model["status"],
        "tool_call": True,
        "reasoning": model["reasoning"],
        "temperature": model["temperature"],
        "limit": _checked_limit(model["limit"]),
        "modalities": _checked_modalities(model["modalities"]),
    }
    if "interleaved" in model:
        interleaved = model["interleaved"]
        field = as_object(interleaved)
        if interleaved is True:
            checked["interleaved"] = True
        elif field is not None and set(field) == {"field"} and field["field"] in INTERLEAVED_FIELDS:
            checked["interleaved"] = {"field": field["field"]}
        else:
            raise _invalid()
    return checked


def parse_job_model_entry(document: Any) -> JobModelEntry:
    """The entry of the claim, or `JobModelEntryError`. Strict: an unknown field is refused."""
    entry = as_object(document)
    if entry is None or set(entry) != _ENTRY_KEYS:
        raise _invalid()
    version = entry["version"]
    if isinstance(version, bool) or version != 1:
        raise _invalid()
    npm = entry["npm"]
    if not isinstance(npm, str) or npm not in BUNDLED_NPM:
        raise _invalid()
    if (
        not _text(entry["providerId"], _PROVIDER_ID, 64)
        or not _text(entry["modelId"], _MODEL_ID, 200)
        or entry["family"] not in _FAMILIES
        or entry["authHeader"] not in _AUTH_HEADERS
        or not _text(entry["upstreamBaseUrl"], _UPSTREAM, 2048)
    ):
        raise _invalid()
    return JobModelEntry(
        provider_id=entry["providerId"],
        npm=npm,
        family=entry["family"],
        auth_header=entry["authHeader"],
        upstream_base_url=entry["upstreamBaseUrl"],
        model_id=entry["modelId"],
        model=_checked_model(entry["model"]),
    )


def _is_loopback_proxy(base_url: str, door_host: str | None = None) -> bool:
    try:
        parts = urlsplit(base_url)
    except ValueError:
        return False
    hosts = ("127.0.0.1", "::1", "localhost", *(() if door_host is None else (door_host,)))
    return parts.scheme == "http" and parts.hostname in hosts


def native_provider_config(
    entry: JobModelEntry, *, base_url: str, api_key: str, door_host: str | None = None
) -> dict[str, Any]:
    """The `provider` object of the engine's configuration for this job: one provider, one model.

    `base_url` is the loopback address of the per-job proxy (anything else is refused: the engine
    must never be handed the upstream address) and `api_key` the job's dummy capability for it. The
    model entry is copied, so changing the configuration later never changes the entry.

    `door_host` is the one other address the proxy may be at: the Implementer's model door, a
    container of its own at a fixed address (#745, step 3).
    """
    if not _is_loopback_proxy(base_url, door_host):
        raise JobModelEntryError("job_model_proxy_not_loopback")
    return {
        entry.provider_id: {
            "npm": entry.npm,
            "options": {"baseURL": base_url, "apiKey": api_key},
            "models": {entry.model_id: copy.deepcopy(entry.model)},
        }
    }


def native_model_reference(entry: JobModelEntry) -> str:
    """How the agent names the model in the engine's configuration: `<provider>/<model>`."""
    return f"{entry.provider_id}/{entry.model_id}"
