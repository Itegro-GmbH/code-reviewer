# SPDX-License-Identifier: LicenseRef-Proprietary

"""The admission of a request to the passthrough proxy (#550): decided before a byte is reserved.

The engine is the untrusted side, so a request is admitted only if it is exactly what the job's
family, model and output cap allow, and only the proxy's own copy of the headers is ever forwarded:

1. **Who.** The job's random capability, in the one header the family uses for its key, exactly once
   (constant-time compare). Anything else is a 401 and nothing else is looked at.
2. **What.** One method, one path and one query per family, compared as plain text (no decoding, so
   `..`, `%2e%2e`, `;x`, a second `?` and an absolute URL are all just different text). Google's
   model is in the path and has to be the job's.
3. **How.** A header allow-list (and an allow-list of `anthropic-beta` values); every credential,
   cookie and proxy header is dropped. A body length that can be measured before it is read.
4. **The body.** Read as JSON and walked against the closed schema of the family
   (`body_schema.py`): the job's model, exactly one output cap within the allowance, function tools
   and text only, and no key the pinned engine does not send. The body that is forwarded is the
   bytes that arrived.

Every refusal is a stable `RefusalCode`, and the `ErrorCode` the run records for it.
"""

import hmac
import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Final, Protocol

from code_reviewer_runner.dynamic_review.passthrough.body_schema import NotAllowed, check_body
from code_reviewer_runner.dynamic_review.passthrough.families import (
    ALLOWED_ANTHROPIC_BETAS,
    ALLOWED_ANTHROPIC_VERSIONS,
    FamilySpec,
    WireFamily,
    spec_of,
)
from code_reviewer_runner.dynamic_review.passthrough.last_user import last_user_text
from code_reviewer_runner.result import ErrorCode


class RefusalCode(StrEnum):
    """What the engine is told. Stable; the text next to it never names a value of the request."""

    CAPABILITY_INVALID = "capability_invalid"
    REQUEST_NOT_ALLOWED = "request_not_allowed"
    MODEL_NOT_ALLOWED = "model_not_allowed"
    REQUEST_TOO_LARGE = "request_too_large"
    LENGTH_REQUIRED = "length_required"
    # A second call while one is in flight (the engine's calls are serial): refused at once, not a
    # call, no reason to end the run. The engine retries a 429 by itself.
    CALL_IN_FLIGHT = "call_in_flight"


_STATUS: Final = {
    RefusalCode.CAPABILITY_INVALID: 401,
    RefusalCode.REQUEST_NOT_ALLOWED: 403,
    RefusalCode.MODEL_NOT_ALLOWED: 403,
    RefusalCode.REQUEST_TOO_LARGE: 413,
    RefusalCode.LENGTH_REQUIRED: 411,
    RefusalCode.CALL_IN_FLIGHT: 429,
}
_RUN_CODE: Final = {
    RefusalCode.REQUEST_TOO_LARGE: ErrorCode.DYNAMIC_BUDGET_EXCEEDED,
}


class Refused(Exception):
    """A request the proxy does not forward. `error` is what the run records (not for a 401).

    `where` says what failed, for the operator's log and never for the engine: the path of a key of
    the body (`service_tier (unknown key)`) or the name of a header (`header anthropic-beta`). It is
    built from constants and plain short names, never from a value of the request.
    """

    def __init__(self, code: RefusalCode, where: str | None = None) -> None:
        super().__init__(code.value)
        self.code = code
        self.status = _STATUS[code]
        self.error = _RUN_CODE.get(code, ErrorCode.DYNAMIC_POLICY_VIOLATION)
        self.where = where


# The pinned engine sends `min(limit.output, 32000)` as the output cap, whatever the catalog says
# (spike #546): a model with a limit of 128000 is asked for 32000. The reservation of the ledger
# and the cap a request may ask for are this number, not the catalog's.
ENGINE_OUTPUT_CAP: Final = 32_000


def output_allowance(limit_output: int) -> int:
    """The output cap the engine will send for a model whose entry states `limit_output`."""
    return max(1, min(limit_output, ENGINE_OUTPUT_CAP))


@dataclass(frozen=True)
class PassthroughTarget:
    """The one thing a job may ask of the provider.

    `output_allowance` is the output cap the engine will send (`min(limit.output, 32000)`: the
    engine caps at 32000, spike #546), and the most any request may ask for.
    """

    family: WireFamily
    model: str
    output_allowance: int


@dataclass(frozen=True)
class Head:
    """A request line and headers that passed, before the body is read."""

    upstream_path: str
    content_length: int
    # The headers that are forwarded, lower case. The key, the encoding and the length are not here.
    headers: dict[str, str]


@dataclass(frozen=True)
class Admitted:
    body: bytes
    model: str
    output_cap: int
    # The text of the last message of the body when it is a user message (the final call is bound
    # to it, `last_user.py`).
    last_user_text: str | None = None


_LENGTH = re.compile(r"[0-9]{1,12}")
_MAX_HEADER_VALUE = 1024
_GOOGLE_MODEL_PATH = re.compile(r"/v1beta/models/([^:/?#]+):streamGenerateContent")


class NativeEntry(Protocol):
    """What the proxy reads of the per-job model entry (`contracts/job-model-entry.v1.json`, #548:
    `job_model_entry.JobModelEntry` has these fields)."""

    @property
    def family(self) -> str: ...

    @property
    def model_id(self) -> str: ...

    @property
    def model(self) -> Mapping[str, Any]: ...


def target_from_entry(entry: NativeEntry) -> PassthroughTarget:
    """The target of a job from its entry. The allowance is what the engine will send, not the
    catalog's `limit.output`. Raises `ValueError` for an entry the proxy cannot serve."""
    try:
        family = WireFamily(entry.family)
    except ValueError:
        raise ValueError("the entry names a wire family the proxy does not know") from None
    limit = entry.model.get("limit")
    output = limit.get("output") if isinstance(limit, Mapping) else None  # pyright: ignore[reportUnknownMemberType, reportUnknownVariableType]
    if isinstance(output, bool) or not isinstance(output, int):
        raise ValueError("the entry has no output limit")
    return PassthroughTarget(
        family=family, model=entry.model_id, output_allowance=output_allowance(output)
    )


def _not_allowed(where: str | None = None) -> Refused:
    return Refused(RefusalCode.REQUEST_NOT_ALLOWED, where)


def _no_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    """Two parsers can read a key given twice differently (first wins, last wins): refuse it."""
    document: dict[str, Any] = {}
    for name, value in pairs:
        if name in document:
            raise ValueError("duplicate key")
        document[name] = value
    return document


def _refuse_constant(_name: str) -> Any:
    raise ValueError("not JSON")


class Admission:
    def __init__(self, target: PassthroughTarget, capability: str) -> None:
        self._target = target
        self._spec: FamilySpec = spec_of(target.family)
        self._capability = capability.encode("utf-8")

    # -- who, what, how -------------------------------------------------------

    def head(
        self,
        method: str,
        raw_target: str,
        headers: Sequence[tuple[str, str]],
        max_request_bytes: int,
    ) -> Head:
        """Decide on the request line and the headers. Raises `Refused`."""
        pairs = [(name.lower(), value) for name, value in headers]
        self._check_capability(pairs)
        if method != "POST":
            raise _not_allowed("method")
        self._check_target(raw_target)
        forwarded = self._forwarded_headers(pairs)
        length = self._content_length(pairs, max_request_bytes)
        return Head(
            upstream_path=self._spec.upstream_path(self._target.model),
            content_length=length,
            headers=forwarded,
        )

    def authorized(self, headers: Sequence[tuple[str, str]]) -> bool:
        try:
            self._check_capability([(name.lower(), value) for name, value in headers])
        except Refused:
            return False
        return True

    def _check_capability(self, pairs: Sequence[tuple[str, str]]) -> None:
        values = [value for name, value in pairs if name == self._spec.key_header]
        if len(values) != 1:
            raise Refused(RefusalCode.CAPABILITY_INVALID)
        presented = self._spec.presented_key(values[0])
        if presented is None or not hmac.compare_digest(
            presented.encode("utf-8", errors="replace"), self._capability
        ):
            raise Refused(RefusalCode.CAPABILITY_INVALID)

    def _check_target(self, raw_target: str) -> None:
        expected = self._spec.engine_target(self._target.model)
        if raw_target == expected:
            return
        if self._spec.model_in_route:
            found = _GOOGLE_MODEL_PATH.fullmatch(raw_target.partition("?")[0])
            if found is not None and found.group(1) != self._target.model:
                raise Refused(RefusalCode.MODEL_NOT_ALLOWED)
        raise _not_allowed("request target")

    def _forwarded_headers(self, pairs: Sequence[tuple[str, str]]) -> dict[str, str]:
        forwarded: dict[str, str] = {}
        for name, value in pairs:
            if name not in self._spec.request_headers:
                continue
            # Only the names of the allow-list reach a message: a header of the engine's own
            # invention is dropped, not refused.
            if name in forwarded:
                raise _not_allowed(f"header {name} (given twice)")
            if len(value) > _MAX_HEADER_VALUE or any(
                (ord(char) < 32 and char != "\t") or ord(char) == 127 for char in value
            ):
                raise _not_allowed(f"header {name} (invalid value)")
            forwarded[name] = value
        # The engine's content type is checked and then dropped: the proxy sends
        # `application/json` itself, so the provider never sees a parameter (a boundary, a charset)
        # the engine chose.
        if (
            not forwarded.pop("content-type", "application/json")
            .lower()
            .startswith("application/json")
        ):
            raise _not_allowed("header content-type")
        if "anthropic-version" in forwarded and (
            forwarded["anthropic-version"] not in ALLOWED_ANTHROPIC_VERSIONS
        ):
            raise _not_allowed("header anthropic-version")
        if "anthropic-beta" in forwarded:
            betas = [beta.strip() for beta in forwarded["anthropic-beta"].split(",")]
            if any(beta not in ALLOWED_ANTHROPIC_BETAS for beta in betas):
                raise _not_allowed("header anthropic-beta")
        return forwarded

    @staticmethod
    def _content_length(pairs: Sequence[tuple[str, str]], maximum: int) -> int:
        if any(name == "transfer-encoding" for name, _ in pairs):
            raise Refused(RefusalCode.LENGTH_REQUIRED)
        lengths = [value for name, value in pairs if name == "content-length"]
        if len(lengths) != 1 or _LENGTH.fullmatch(lengths[0]) is None:
            raise Refused(RefusalCode.LENGTH_REQUIRED)
        length = int(lengths[0])
        if length > maximum:
            raise Refused(RefusalCode.REQUEST_TOO_LARGE)
        return length

    # -- the body ---------------------------------------------------------------

    def body(self, head: Head, body: bytes) -> Admitted:
        """Decide on the body against the closed schema of the family. Raises `Refused`.

        `head` only proves the request was admitted; the body that comes back is `body` itself.
        """
        document = self._document(body)
        model = self._target.model
        if not self._spec.model_in_route:
            requested = document.get("model")
            if not isinstance(requested, str):
                raise _not_allowed("model (invalid value)")
            if requested != model:
                raise Refused(RefusalCode.MODEL_NOT_ALLOWED)
        try:
            output_cap = check_body(self._target.family, document, self._target.output_allowance)
        except NotAllowed as refusal:
            raise _not_allowed(refusal.path) from None
        except (OverflowError, RecursionError):
            raise _not_allowed("body (too deep or too large)") from None
        return Admitted(
            body=body,
            model=model,
            output_cap=output_cap,
            last_user_text=last_user_text(self._target.family, document),
        )

    @staticmethod
    def _document(body: bytes) -> dict[str, Any]:
        try:
            value: Any = json.loads(
                body.decode("utf-8"),
                object_pairs_hook=_no_duplicates,
                parse_constant=_refuse_constant,
            )
        except (ValueError, RecursionError):
            raise _not_allowed("body (not JSON the proxy reads)") from None
        if not isinstance(value, dict):
            raise _not_allowed("body (not an object)")
        return value  # pyright: ignore[reportUnknownVariableType]
