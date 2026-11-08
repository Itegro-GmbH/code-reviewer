# SPDX-License-Identifier: LicenseRef-Proprietary

"""The passthrough proxy of one job (#550): authenticate, swap the key, relay, count.

For every request the engine makes, in this order:

1. **Admission** (`admission.py`): the capability, one method, path, query and header set, a body
   length that can be measured; the body against the closed schema of the family (`body_schema.py`).
   A refusal is answered locally with a stable code and nothing is reserved or forwarded.
2. **One call at a time.** The engine's calls are serial (one agent, no subagent: a step waits for
   its tool results). A second request while one is in flight is refused at once with a 429 and a
   `retry-after` of one second (`call_in_flight`): not a call, nothing reserved, no reason to end
   the run. It is refused and not queued because a queue is something a hostile engine can fill; the
   engine retries a 429 by itself and loses nothing by it.
3. **Reservation**: the ledger (`budget.py`, the realistic guard of #540/#542) reserves the call
   from the bytes of the body and what the run has shown. Every upstream call is a call of its own,
   the engine's retries (429, 5xx, a cut stream, an error event in a 200) included.
4. **The relay**: the request goes out byte for byte with the one real key in the one header of the
   family and `accept-encoding: identity`, to the job's one upstream, with no redirect followed. The
   answer comes back byte for byte, a stream one whole event at a time, while the tee reads the
   usage from the same bytes. **A successful answer is never changed** (`redact.py`: redaction of
   content is an oracle for the key).
5. **Settlement**: a complete answer with a usage and a price settles the reservation; a refusal
   from the provider with a 4xx (not 408), a 429 or a 500/502/503/529 that is only a status (soon,
   not an event stream, no usage in its body: `_billed`) costs nothing. Everything else that was
   sent and whose usage was not read (a cut stream, an error event, a 408, 504 or 524, a timeout
   after the request went out) is **unknown**: booked at its worst case, not at what it was
   expected to cost, and for a managed key the run ends (`dynamic_accounting_failed`); relaxing
   that for an own key is #553. An engine that hangs up does not make a call unknown: the proxy
   keeps reading the provider's answer, without forwarding it, to its end or the byte and deadline
   bounds, and then settles normally.

What the provider says about an error is not passed on: the engine gets the status, a code and a
sentence of ours, and the retry hint (`retry-after`), nothing else. An error event inside a 200
stream is replaced by a fixed event of ours; the headers of an answer have the key cut out. A
refusal that ends the run (a policy violation, a limit, a provider error that no retry will help)
is recorded in the ledger with a stable `ErrorCode`; one the engine retries by itself (429, a cut
stream) is not, and its code is kept in `last_upstream_error` for the caller to name when the
engine gives up. No file here logs, except `usage_report.py`: names of usage fields and a count.

Not done here: how a final call is told to answer (#552: a call is never rewritten on this path, so
the ledger is asked with `can_wrap_up=False` and a call the limit cannot hold is refused); an own
key without prices (#553).
"""

import json
import re
import threading
from collections.abc import Callable, Sequence
from typing import Final

from code_reviewer_runner.cache_usage import CacheTally
from code_reviewer_runner.dynamic_review.budget import (
    BudgetLedger,
    LimitError,
    Reservation,
    UnitCosts,
)
from code_reviewer_runner.dynamic_review.config import PROXY_CAPABILITY_BYTES
from code_reviewer_runner.dynamic_review.passthrough.admission import (
    Admission,
    Admitted,
    Head,
    PassthroughTarget,
    RefusalCode,
    Refused,
)
from code_reviewer_runner.dynamic_review.passthrough.call_usage import CallUsage
from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily, spec_of
from code_reviewer_runner.dynamic_review.passthrough.fetch_parts import URL_SOURCE
from code_reviewer_runner.dynamic_review.passthrough.price_book import (
    PriceBook,
    PriceBookError,
    book_from_unit_costs,
)
from code_reviewer_runner.dynamic_review.passthrough.pricing import price_call
from code_reviewer_runner.dynamic_review.passthrough.redact import MIN_KEY_CHARS, Redactor
from code_reviewer_runner.dynamic_review.passthrough.sink import ClientGone, ResponseSink
from code_reviewer_runner.dynamic_review.passthrough.sse import SseFramer
from code_reviewer_runner.dynamic_review.passthrough.upstream import (
    Upstream,
    UpstreamError,
    UpstreamFailure,
    UpstreamRequest,
    UpstreamResponse,
)
from code_reviewer_runner.dynamic_review.passthrough.usage import (
    TapResult,
    UsageTap,
    is_error_event,
    tap_for,
)
from code_reviewer_runner.dynamic_review.passthrough.usage_report import (
    log_price_drift,
    log_price_risk,
    log_unknown_fields,
)
from code_reviewer_runner.error_mapping import is_context_length_exceeded, llm_status_code
from code_reviewer_runner.result import ErrorCode

# `secrets.token_urlsafe(n)` yields ceil(4n/3) characters: the shortest acceptable capability.
_MIN_CAPABILITY_CHARS: Final = -(-PROXY_CAPABILITY_BYTES * 4 // 3)
# The wait for the provider: connecting and each read. The job's own deadline can be shorter.
CALL_TIMEOUT_SECONDS: Final = 120.0
_READ_BYTES: Final = 65536
# A server-sent stream is far larger than the text in it: an event per token costs about 100 bytes
# of framing. The bound of a stream is the larger of the ledger's and this much per output token.
_STREAM_BYTES_PER_OUTPUT_TOKEN: Final = 256
# The headers of a successful answer that reach the engine. The engine's retries read the first
# ones; the rest identify a call in a log. Everything else (cookies, rate-limit state, the server)
# is the provider's own business.
_RESPONSE_HEADERS: Final = frozenset(
    {
        "content-type",
        "retry-after",
        "retry-after-ms",
        "x-should-retry",
        "request-id",
        "x-request-id",
    }
)
_MAX_HEADER_VALUE: Final = 1024
# Server errors that are not billed when they arrive as a status before any byte of the answer.
# Open point (live checklist L13): whether a real provider ever bills one.
_UNBILLED_SERVER_ERRORS: Final = frozenset({500, 502, 503, 529})
# ... and only when the status line came this soon after the request: a provider that thought about
# it for longer may have been generating.
_STATUS_WITHIN_SECONDS: Final = 15.0
_USAGE_KEYS: Final = frozenset({"usage", "usageMetadata", "usage_metadata"})
_SHORTEST_READ: Final = 0.05
# The only things of a provider's error that reach the engine: when to retry, as a number.
_RETRY_HINTS: Final = {
    "retry-after": re.compile(r"[0-9]{1,6}(\.[0-9]{1,3})?"),
    "retry-after-ms": re.compile(r"[0-9]{1,9}"),
}
_REFUSAL_DETAIL: Final = {
    RefusalCode.CAPABILITY_INVALID: "the request carries no valid capability",
    RefusalCode.REQUEST_NOT_ALLOWED: "the request is not one this job may make",
    RefusalCode.MODEL_NOT_ALLOWED: "the request names another model",
    RefusalCode.REQUEST_TOO_LARGE: "the request exceeds the protocol byte bound",
    RefusalCode.LENGTH_REQUIRED: "the request has no length that can be measured",
    RefusalCode.CALL_IN_FLIGHT: "another call is in flight; the calls of a job are serial",
}


# What the engine is told in the place of an error the provider sent inside a 200 answer. The
# events are ours: the engine's retry logic reads their shape, and nothing the provider wrote (nor
# any word of what the request said) is in them. The shapes are those of the fakes, which the
# pinned engine is known to read as an error (spike #546); a real capture is live item L7.
_ERROR_SENTENCE: Final = "the model provider reported an error"


def _sse(name: str | None, data: object) -> bytes:
    head = b"" if name is None else f"event: {name}\n".encode()
    return head + b"data: " + json.dumps(data).encode("utf-8") + b"\n\n"


def fixed_error_event(family: WireFamily) -> bytes:
    """The event the engine gets in the place of an error event of the provider's."""
    if family is WireFamily.ANTHROPIC_MESSAGES:
        return _sse(
            "error",
            {"type": "error", "error": {"type": "api_error", "message": _ERROR_SENTENCE}},
        )
    if family is WireFamily.OPENAI_RESPONSES:
        return _sse(
            "error",
            {
                "type": "error",
                "code": "server_error",
                "message": _ERROR_SENTENCE,
                "sequence_number": 0,
            },
        )
    if family is WireFamily.GOOGLE:
        return _sse(
            None, {"error": {"code": 500, "message": _ERROR_SENTENCE, "status": "INTERNAL"}}
        )
    return _sse(
        None, {"error": {"message": _ERROR_SENTENCE, "type": "api_error", "code": "server_error"}}
    )


def _fixed_error_document() -> bytes:
    return json.dumps(
        {
            "type": "error",
            "error": {"type": "api_error", "code": "server_error", "message": _ERROR_SENTENCE},
        }
    ).encode("utf-8")


def _error_kind(status: int) -> str:
    """The `type` of an Anthropic-shaped error for a status: the engine's SDK reads it."""
    if status == 429:
        return "rate_limit_error"
    if status in (401, 403):
        return "authentication_error"
    if status >= 500 or status == 408:
        return "api_error"
    return "invalid_request_error"


def _error_body(code: str, detail: str, kind: str = "invalid_request_error") -> bytes:
    """The stable error shape the engine sees: a code and a sentence of ours, never a message with
    data in it. `type` and `message` are what the engine's SDKs read."""
    return json.dumps(
        {"type": "error", "error": {"type": kind, "code": code, "message": detail}}
    ).encode("utf-8")


def _states_usage(body: bytes) -> bool:
    """Whether an error body states a usage. JSON: an object under `usage`/`usageMetadata`
    anywhere in it. Anything that does not parse (an HTML page, a cut or too deep document): the
    word `usage` anywhere in it, since a body we cannot read may state one."""
    try:
        document: object = json.loads(body)
    except (ValueError, RecursionError):
        return b"usage" in body.lower()
    pending: list[object] = [document]
    while pending:
        node = pending.pop()
        if isinstance(node, dict):
            for key, value in node.items():  # pyright: ignore[reportUnknownVariableType]
                if key in _USAGE_KEYS and isinstance(value, dict):
                    return True
                pending.append(value)  # pyright: ignore[reportUnknownArgumentType]
        elif isinstance(node, list):
            pending.extend(node)  # pyright: ignore[reportUnknownArgumentType]
    return False


class PassthroughProxy:
    """One per job. `handle` is the whole policy for one request; `server.py` puts it on
    loopback."""

    def __init__(
        self,
        *,
        ledger: BudgetLedger,
        target: PassthroughTarget,
        upstream: Upstream,
        upstream_api_key: str,
        capability: str,
        prices: UnitCosts | PriceBook | None,
        superseded: Callable[[], bool] = lambda: False,
        call_timeout: float = CALL_TIMEOUT_SECONDS,
        unknown_cost_ends_run: bool = True,
    ) -> None:
        if len(capability) < _MIN_CAPABILITY_CHARS:
            raise LimitError(
                ErrorCode.DYNAMIC_CONFIG_INVALID, "the proxy capability is not strong enough"
            )
        if len(upstream_api_key) < MIN_KEY_CHARS:
            raise LimitError(
                ErrorCode.DYNAMIC_CONFIG_INVALID, "the upstream key is too short to be a key"
            )
        self.ledger = ledger
        # How much of the input of the run came from the provider's cache (counts only, #539).
        self.cache_tally = CacheTally()
        # The stable code of the last call's failure (429, 5xx, a cut stream), kept for the caller
        # to name if the engine gives up: the engine retries these itself, and a call that went
        # through clears it.
        self.last_upstream_error: ErrorCode | None = None
        self._admission = Admission(target, capability)
        self._spec = spec_of(target.family)
        self._upstream = upstream
        self._key = upstream_api_key
        self._redactor = Redactor(upstream_api_key)
        # Read once: prices that are no prices are refused here and not in the middle of a call.
        # No prices at all (#553) is an own key whose model nobody priced: every call is settled
        # by its tokens, and a managed key never gets there.
        if prices is None and unknown_cost_ends_run:
            raise LimitError(ErrorCode.DYNAMIC_CONFIG_INVALID, "a managed key needs prices")
        self._prices: PriceBook | None = None
        try:
            if prices is not None:
                self._prices = (
                    prices if isinstance(prices, PriceBook) else book_from_unit_costs(prices)
                )
        except PriceBookError as error:
            raise LimitError(
                ErrorCode.DYNAMIC_CONFIG_INVALID, "the prices of the model are not prices"
            ) from error
        # Calls whose stated charge the price book did not agree with (counts only, `price_drift`).
        self.price_drift_calls = 0
        # Calls of an own key whose tokens were read and whose cost could not be (counts only,
        # `price_risk`, #553).
        self.price_risk_calls = 0
        self._superseded = superseded
        self._call_timeout = call_timeout
        # Whether a call whose usage was never seen, or whose cost cannot be known, ends the run:
        # the managed key's rule (#553, `cost_policy.py`). An own key goes on, booked by its tokens.
        self._unknown_ends_run = unknown_cost_ends_run
        # The one call that may be in flight.
        self._slot = threading.Lock()
        self._family = target.family
        # Requests being answered right now (`wait_idle`: a superseded run lets them finish).
        self._in_flight = 0
        self._idle = threading.Condition()

    @property
    def ends_run_on_unknown_cost(self) -> bool:
        """The managed key's rule (#553): a call whose cost is unknown ends the run."""
        return self._unknown_ends_run

    def authorized(self, headers: Sequence[tuple[str, str]]) -> bool:
        return self._admission.authorized(headers)

    def wait_idle(self, timeout: float) -> bool:
        """Wait until no request is being answered; False when `timeout` ran out first."""
        with self._idle:
            return self._idle.wait_for(lambda: self._in_flight == 0, timeout=timeout)

    # -- one request ------------------------------------------------------------------------------

    def handle(
        self,
        method: str,
        raw_target: str,
        headers: Sequence[tuple[str, str]],
        read_body: Callable[[int], bytes],
        sink: ResponseSink,
    ) -> None:
        """Decide on one request and answer it through `sink`. Every refusal is a stable code."""
        with self._idle:
            self._in_flight += 1
        try:
            self._handle(method, raw_target, headers, read_body, sink)
        finally:
            with self._idle:
                self._in_flight -= 1
                self._idle.notify_all()

    def _handle(
        self,
        method: str,
        raw_target: str,
        headers: Sequence[tuple[str, str]],
        read_body: Callable[[int], bytes],
        sink: ResponseSink,
    ) -> None:
        try:
            head = self._admission.head(
                method, raw_target, headers, self.ledger.limits.max_request_bytes
            )
        except Refused as refused:
            self._refuse(sink, refused)
            return
        # Only the holder of the capability is told that a call is in flight.
        if not self._slot.acquire(blocking=False):
            detail = _REFUSAL_DETAIL[RefusalCode.CALL_IN_FLIGHT]
            body = _error_body(RefusalCode.CALL_IN_FLIGHT.value, detail, "rate_limit_error")
            self._respond(sink, 429, body, [("retry-after", "1")])
            return
        try:
            self._admit_and_relay(head, read_body, sink)
        finally:
            self._slot.release()

    def _admit_and_relay(
        self, head: Head, read_body: Callable[[int], bytes], sink: ResponseSink
    ) -> None:
        try:
            if self._superseded():
                raise LimitError(ErrorCode.SUPERSEDED, "the run was superseded by a newer push")
            admitted = self._admission.body(head, read_body(head.content_length))
            reservation = self.ledger.reserve_call(
                admitted.body,
                output_tokens=admitted.output_cap,
                last_user_text=admitted.last_user_text,
            )
        except Refused as refused:
            self._refuse(sink, refused)
            return
        except LimitError as error:
            # 403, not 5xx: a deterministic refusal must not be retried (every retry is a call).
            self.ledger.record_failure(error)
            self._respond(sink, 403, _error_body(error.code.value, error.detail))
            return
        self._relay(head, admitted, reservation, sink)

    def _refuse(self, sink: ResponseSink, refused: Refused) -> None:
        detail = _REFUSAL_DETAIL[refused.code]
        if refused.where is not None and refused.where.endswith(f"({URL_SOURCE})"):
            # The kind of part, never its value: the engine can tell what to change.
            detail += ": a message part asks the provider to fetch a URL"
        if refused.code is not RefusalCode.CAPABILITY_INVALID:
            # An engine that asks for what it may not is misbehaving: the run stops. A caller that
            # proved nothing is not the engine of this job and does not end it. What the run
            # records says where the request failed (a path or a header name, never a value), so
            # the log tail of the job names the next unknown in one run; the engine is told only
            # the fixed sentence.
            where = "" if refused.where is None else f" [{refused.where}]"
            self.ledger.record_failure(LimitError(refused.error, detail + where))
        self._respond(sink, refused.status, _error_body(refused.code.value, detail))

    @staticmethod
    def _respond(
        sink: ResponseSink, status: int, body: bytes, extra: Sequence[tuple[str, str]] = ()
    ) -> None:
        try:
            sink.start(status, [("content-type", "application/json"), *extra], len(body))
            sink.write(body)
            sink.end()
        except ClientGone:
            sink.abort()

    # -- the call -----------------------------------------------------------------------------

    def _relay(
        self, head: Head, admitted: Admitted, reservation: Reservation, sink: ResponseSink
    ) -> None:
        started_ms = int(self.ledger.elapsed_seconds() * 1000)
        outgoing = dict(head.headers)
        # The content type is ours: the engine's is checked at admission and not passed on.
        outgoing["content-type"] = "application/json"
        outgoing[self._spec.key_header] = self._spec.key_value(self._key)
        # A tee that reads the usage cannot read an answer that was compressed for the engine.
        outgoing["accept-encoding"] = "identity"
        timeout = min(self._call_timeout, self.ledger.remaining_seconds())
        sent_at = self.ledger.elapsed_seconds()
        try:
            response = self._upstream.send(
                UpstreamRequest(head.upstream_path, outgoing, admitted.body), timeout
            )
        except UpstreamError as error:
            self._no_answer(sink, error, reservation, started_ms)
            return
        except Exception:
            self._no_answer(
                sink, UpstreamError(UpstreamFailure.CUT, sent=True), reservation, started_ms
            )
            return
        latency = self.ledger.elapsed_seconds() - sent_at
        try:
            self._answer(response, admitted, reservation, started_ms, latency, sink)
        except Exception:
            # The request was sent: whatever broke, the call may have been billed. It is booked
            # (once: a call the normal path already settled is not settled again) and the engine's
            # connection is dropped, so the run ends with `dynamic_accounting_failed` and not with
            # a generic `runner_error` that says nothing about the cost.
            self._unknown(reservation, started_ms)
            sink.abort()
        finally:
            response.close()

    def _read_timeout(self) -> float:
        """What the next read of the provider's answer may wait: the budget of a call, or what the
        job has left."""
        return max(min(self._call_timeout, self.ledger.remaining_seconds()), _SHORTEST_READ)

    def _no_answer(
        self, sink: ResponseSink, error: UpstreamError, reservation: Reservation, started_ms: int
    ) -> None:
        # A call that never left costs nothing; one that was sent may have been billed.
        if error.sent:
            self._unknown(reservation, started_ms)
        else:
            self.ledger.settle_unbilled(reservation)
            self._trace_failed(started_ms, reservation)
        if error.kind is UpstreamFailure.ADDRESS_REFUSED:
            problem = LimitError(
                ErrorCode.DYNAMIC_POLICY_VIOLATION, "the model provider is not at a public address"
            )
            self.ledger.record_failure(problem)
            self._respond(sink, 502, _error_body(problem.code.value, problem.detail, "api_error"))
            return
        timed_out = error.kind is UpstreamFailure.TIMEOUT
        code = ErrorCode.LLM_TIMEOUT if timed_out else ErrorCode.LLM_UNAVAILABLE
        self.last_upstream_error = code
        detail = (
            "the model provider did not answer in time"
            if timed_out
            else "the model provider could not be reached"
        )
        self._respond(sink, 504 if timed_out else 502, _error_body(code.value, detail, "api_error"))

    def _answer(
        self,
        response: UpstreamResponse,
        admitted: Admitted,
        reservation: Reservation,
        started_ms: int,
        latency: float,
        sink: ResponseSink,
    ) -> None:
        status = response.status
        headers = {name.lower(): value for name, value in response.headers}
        if 300 <= status < 400:
            # Never followed, and the destination it names is never read.
            self.ledger.settle_unbilled(reservation)
            self._trace_failed(started_ms, reservation)
            problem = LimitError(
                ErrorCode.DYNAMIC_POLICY_VIOLATION, "the model provider answered with a redirect"
            )
            self.ledger.record_failure(problem)
            self._respond(sink, 502, _error_body(problem.code.value, problem.detail, "api_error"))
            return
        if not 200 <= status < 300:
            self._provider_error(response, status, reservation, started_ms, latency, sink)
            return
        if headers.get("content-encoding", "identity").lower() != "identity":
            problem = LimitError(
                ErrorCode.DYNAMIC_ACCOUNTING_FAILED,
                "the model provider answered with an encoded body",
            )
            self._unknown(reservation, started_ms, problem)
            self._respond(sink, 502, _error_body(problem.code.value, problem.detail, "api_error"))
            return
        sse = headers.get("content-type", "").lower().startswith("text/event-stream")
        if sse:
            self._stream(response, admitted, reservation, started_ms, sink)
        else:
            self._document(response, status, reservation, started_ms, sink)

    def _forwarded_headers(self, response: UpstreamResponse) -> list[tuple[str, str]]:
        """The headers of a successful answer that are passed on, with the key cut out of them."""
        return [
            (name.lower(), self._redactor.redact(value.encode("utf-8")).decode("utf-8", "replace"))
            for name, value in response.headers
            if name.lower() in _RESPONSE_HEADERS and len(value) <= _MAX_HEADER_VALUE
        ]

    @staticmethod
    def _retry_hints(response: UpstreamResponse) -> list[tuple[str, str]]:
        """When to retry, as the provider states it, if it is a plain number. Nothing else of an
        error's headers is passed on."""
        hints: dict[str, str] = {}
        for name, value in response.headers:
            pattern = _RETRY_HINTS.get(name.lower())
            if pattern is not None and name.lower() not in hints and pattern.fullmatch(value):
                hints[name.lower()] = value
        return list(hints.items())

    def _provider_error(
        self,
        response: UpstreamResponse,
        status: int,
        reservation: Reservation,
        started_ms: int,
        latency: float,
        sink: ResponseSink,
    ) -> None:
        # The body is read to tell a too-long request from other refusals, and to see whether the
        # provider states a usage. It is read here and not passed on: what a provider writes about
        # an error can quote what the request said, so the engine (which wrote the request) gets
        # a status, our sentence and the retry hint.
        body, complete = self._read_bounded(response, self.ledger.limits.max_response_bytes)
        text = body.decode("utf-8", errors="replace")
        code = (
            ErrorCode.LLM_CONTEXT_LENGTH_EXCEEDED
            if is_context_length_exceeded(status, text)
            else llm_status_code(status) or ErrorCode.LLM_BAD_REQUEST
        )
        self.last_upstream_error = code
        # The engine retries these itself; any other refusal ends its turn, and so the run.
        if status >= 200 and not (status in (408, 409, 429) or status >= 500):
            self.ledger.record_failure(LimitError(code, "the model provider refused the request"))
        content_type = dict((n.lower(), v) for n, v in response.headers).get("content-type", "")
        if self._billed(status, latency, content_type, body, complete):
            self._unknown(reservation, started_ms)
        else:
            self.ledger.settle_unbilled(reservation)
            self._trace_failed(started_ms, reservation)
        sentence = (
            "the model provider is rate limiting requests"
            if status == 429
            else "the model provider did not answer the request"
            if status >= 500 or status == 408
            else "the model provider refused the request"
        )
        self._respond(
            sink,
            status,
            _error_body(code.value, sentence, _error_kind(status)),
            self._retry_hints(response),
        )

    @staticmethod
    def _billed(
        status: int, latency: float, content_type: str, body: bytes, complete: bool
    ) -> bool:
        """Whether a call that was answered with this error status may have been billed.

        A 4xx (not 408) and a 429 are refused before anything is generated. A 500, 502, 503 or 529
        is the same, when it really is only a status: it came soon (`_STATUS_WITHIN_SECONDS`), it
        is not an event stream, and its body, read whole, states no usage. Everything else (408,
        504, 524, a status below 200 or any other 5xx, and a 5xx that fails one of those three
        conditions) says the provider may have been working on the call.
        """
        if status < 200 or status == 408:
            return True
        if status < 500:
            return False
        if status not in _UNBILLED_SERVER_ERRORS:
            return True
        return (
            latency > _STATUS_WITHIN_SECONDS
            or content_type.lower().startswith("text/event-stream")
            or not complete
            or _states_usage(body)
        )

    def _read_bounded(self, response: UpstreamResponse, limit: int) -> tuple[bytes, bool]:
        """At most `limit` bytes of the body. The flag is False when it ended early or ran past."""
        body = b""
        try:
            while len(body) <= limit:
                data = response.read(_READ_BYTES, self._read_timeout())
                if not data:
                    return body, True
                body += data
        except UpstreamError:
            return body, False
        return body[:limit], False

    def _document(
        self,
        response: UpstreamResponse,
        status: int,
        reservation: Reservation,
        started_ms: int,
        sink: ResponseSink,
    ) -> None:
        # A document, not a stream: read whole (bounded), settled, then sent with its length. A
        # long-lived answer that is not server-sent events is not streamed; none of the four
        # families answers a streaming request that way, and one that does is cut at the bound.
        tap = tap_for(self._family, sse=False)
        limit = self.ledger.limits.max_response_bytes
        body = b""
        try:
            while True:
                data = response.read(_READ_BYTES, self._read_timeout())
                if not data:
                    break
                body += data
                if len(body) > limit:
                    self._too_large(reservation, started_ms, sink)
                    return
                tap.feed(data)
        except UpstreamError as error:
            self._cut(sink, error, reservation, started_ms)
            return
        result = tap.finish()
        # Content is never changed; an answer that is an error (a 200 with an `error` object) is
        # the provider's words about a failure, and the engine gets a fixed document of ours.
        shown = _fixed_error_document() if result.errored else body
        self._settle(result, reservation, started_ms)
        try:
            sink.start(status, self._forwarded_headers(response), len(shown))
            sink.write(shown)
            sink.end()
        except ClientGone:
            sink.abort()

    def _guarded(self, event: bytes) -> bytes:
        """One event of the stream as the engine gets it: unchanged, unless it is an error event
        (decided by the provider's structure, never by a word of the model's: see
        `is_error_event`), which is replaced by a fixed one of ours."""
        return fixed_error_event(self._family) if is_error_event(event) else event

    def _stream(
        self,
        response: UpstreamResponse,
        admitted: Admitted,
        reservation: Reservation,
        started_ms: int,
        sink: ResponseSink,
    ) -> None:
        tap: UsageTap = tap_for(self._family, sse=True)
        framer = SseFramer()
        limit = max(
            self.ledger.limits.max_stream_bytes,
            admitted.output_cap * _STREAM_BYTES_PER_OUTPUT_TOKEN,
        )
        total = 0
        # The engine hung up: the call is still read to its usage, but nothing more is forwarded.
        # Hanging up must not make a call's cost unreadable.
        engine_here = True
        try:
            try:
                sink.start(response.status, self._forwarded_headers(response), None)
            except ClientGone:
                engine_here = False
                sink.abort()
            while True:
                if self.ledger.expired():
                    self._deadline(reservation, started_ms, sink)
                    return
                data = response.read(_READ_BYTES, self._read_timeout())
                if not data:
                    break
                total += len(data)
                if total > limit:
                    self._too_large(reservation, started_ms, sink)
                    return
                tap.feed(data)
                if not engine_here:
                    # Read on to the end of the answer, forwarding nothing.
                    continue
                try:
                    for event in framer.feed(data):
                        sink.write(self._guarded(event))
                except ClientGone:
                    engine_here = False
                    sink.abort()
            if engine_here:
                rest = framer.finish()
                if rest:
                    sink.write(self._guarded(rest))
        except UpstreamError as error:
            self._cut(sink, error, reservation, started_ms)
            return
        except ClientGone:
            engine_here = False
            sink.abort()
        result = tap.finish()
        if not result.errored and not result.terminated:
            # A closed connection is no end of the answer: the engine sees a cut stream too.
            self._unknown(reservation, started_ms)
            self.last_upstream_error = ErrorCode.LLM_UNAVAILABLE
            sink.abort()
            return
        self._settle(result, reservation, started_ms)
        if engine_here:
            sink.end()

    # -- settlement ---------------------------------------------------------------------------

    def _unknown(
        self, reservation: Reservation, started_ms: int, reason: LimitError | None = None
    ) -> None:
        """A call that may have been billed and whose usage was not read: booked at its worst
        case, in the trace with nothing known about it, and for a managed key the end of the run.
        `reason` (a limit that was hit) is recorded first, since the first failure is the one that
        is reported."""
        if not self.ledger.settle_unknown(reservation, worst_case=self._unknown_ends_run):
            return  # settled already: nothing more to book, and the run's failure is recorded
        self._trace_failed(started_ms, reservation)
        if reason is not None:
            self.ledger.record_failure(reason)
        if self._unknown_ends_run:
            self.ledger.record_failure(
                LimitError(
                    ErrorCode.DYNAMIC_ACCOUNTING_FAILED,
                    "the cost of a model call could not be read",
                )
            )

    def _settle(self, result: TapResult, reservation: Reservation, started_ms: int) -> None:
        """Settle a call whose answer arrived whole."""
        if result.errored:
            # An error inside a 200: the status never showed it. The call failed and may have been
            # billed for what it generated; the engine retries it as a new call.
            self._unknown(reservation, started_ms)
            self.last_upstream_error = ErrorCode.LLM_UNAVAILABLE
            return
        usage = result.usage
        if usage is None or not usage.complete:
            # A complete answer without usage fails the run for every key (#553 will price an own
            # key's calls another way); the call itself is booked at its worst case.
            self._unknown(
                reservation,
                started_ms,
                LimitError(
                    ErrorCode.DYNAMIC_ACCOUNTING_FAILED, "the provider did not report usage"
                ),
            )
            return
        if usage.unknown_fields:
            # The provider stated something the proxy cannot price (a field it does not know that
            # could carry a charge, a value it cannot trust, a second choice, a service tier): the
            # call is unknown, whatever the figures say, and a managed run ends. An own key goes
            # on with the tokens the provider stated and a cost that is unknown (#553).
            log_unknown_fields(usage.unknown_fields)
            if self._unknown_ends_run:
                self._unknown(reservation, started_ms)
            else:
                self._tokens_only(usage, reservation, started_ms, result.finish_reason)
            return
        if self._prices is None:
            self._tokens_only(usage, reservation, started_ms, result.finish_reason, risk=False)
            return
        priced = price_call(usage, self._prices)
        if priced.drift:
            self.price_drift_calls += 1
            log_price_drift(self.price_drift_calls)
        cost = priced.cost
        if cost is None:
            # The book cannot price the call, or the charge the provider states is not to be
            # believed: unknown, booked at the worst case, never at what it was expected to cost.
            # An own key goes on by the tokens (#553).
            if self._unknown_ends_run:
                self._unknown(reservation, started_ms)
            else:
                self._tokens_only(usage, reservation, started_ms, result.finish_reason)
            return
        # Noted before the settlement: a call the ledger then stops the run for is in the trace too.
        self.ledger.trace.model_call(
            t_ms=started_ms,
            prompt_tokens=usage.prompt_tokens,
            cache_read=usage.cache_read,
            cache_write=usage.cache_write,
            completion_tokens=usage.completion_tokens,
            cost=cost,
            finish_reason=result.finish_reason,
            final=reservation.final,
            tool_names=[],
        )
        try:
            self.ledger.settle_call(
                reservation,
                prompt_tokens=usage.prompt_tokens,
                completion_tokens=usage.completion_tokens,
                cost=cost,
                cache_read_tokens=usage.cache_read,
                cache_write_tokens=usage.cache_write,
            )
        except LimitError as error:
            self.ledger.record_failure(error)
            return
        self.cache_tally.add(
            {
                "prompt_tokens": usage.prompt_tokens,
                "cache_read_input_tokens": usage.cache_read,
                "cache_creation_input_tokens": usage.cache_write,
            }
        )
        # The engine retried a refusal and the call went through: the earlier code is not the
        # reason the run would give up now.
        self.last_upstream_error = None

    def _tokens_only(
        self,
        usage: CallUsage,
        reservation: Reservation,
        started_ms: int,
        finish_reason: str | None,
        *,
        risk: bool = True,
    ) -> None:
        """Settle a call of an own key by its tokens (#553): the provider stated its usage and
        nobody can say what it cost. The tokens count against the cap, the cost of the run
        becomes unknown (`costUsd: null`, minutes only in billing), and the run goes on.
        `risk` is False for a model nobody priced: that is no surprise and not counted."""
        if risk:
            self.price_risk_calls += 1
            log_price_risk(self.price_risk_calls)
        self.ledger.trace.model_call(
            t_ms=started_ms,
            prompt_tokens=usage.prompt_tokens,
            cache_read=usage.cache_read,
            cache_write=usage.cache_write,
            completion_tokens=usage.completion_tokens,
            cost=None,
            finish_reason=finish_reason,
            final=reservation.final,
            tool_names=[],
        )
        # The call is booked at the largest of what it states: its counts, the total it states (a
        # total above the counts is tokens the parser has no field for), and reasoning on top of
        # the completion (xAI). A cap that counted the counts alone could be passed unseen.
        counted = usage.prompt_tokens + usage.completion_tokens
        booked = max(
            counted,
            usage.stated_total or 0,
            counted + max(usage.reasoning_tokens - usage.completion_tokens, 0),
        )
        try:
            self.ledger.settle_call(
                reservation,
                prompt_tokens=usage.prompt_tokens,
                completion_tokens=usage.completion_tokens,
                cost=None,
                cache_read_tokens=usage.cache_read,
                cache_write_tokens=usage.cache_write,
                allow_unpriced=True,
                extra_tokens=booked - counted,
            )
        except LimitError as error:
            self.ledger.record_failure(error)
            return
        self.cache_tally.add(
            {
                "prompt_tokens": usage.prompt_tokens,
                "cache_read_input_tokens": usage.cache_read,
                "cache_creation_input_tokens": usage.cache_write,
            }
        )

    def _trace_failed(self, started_ms: int, reservation: Reservation) -> None:
        """A call that gave no usable answer is in the trace with nothing known about it."""
        self.ledger.trace.model_call(
            t_ms=started_ms,
            prompt_tokens=None,
            cache_read=None,
            cache_write=None,
            completion_tokens=None,
            cost=None,
            finish_reason=None,
            final=reservation.final,
            tool_names=[],
        )

    def _cut(
        self, sink: ResponseSink, error: UpstreamError, reservation: Reservation, started_ms: int
    ) -> None:
        """The connection stopped mid-answer. The engine's is dropped the same way, and it retries
        the call as a whole new one."""
        self._unknown(reservation, started_ms)
        self.last_upstream_error = (
            ErrorCode.LLM_TIMEOUT
            if error.kind is UpstreamFailure.TIMEOUT
            else ErrorCode.LLM_UNAVAILABLE
        )
        sink.abort()

    def _too_large(self, reservation: Reservation, started_ms: int, sink: ResponseSink) -> None:
        self._unknown(
            reservation,
            started_ms,
            LimitError(
                ErrorCode.DYNAMIC_BUDGET_EXCEEDED, "the response exceeds the protocol byte bound"
            ),
        )
        sink.abort()

    def _deadline(self, reservation: Reservation, started_ms: int, sink: ResponseSink) -> None:
        self._unknown(
            reservation,
            started_ms,
            LimitError(ErrorCode.DYNAMIC_BUDGET_EXCEEDED, "the whole-job deadline was reached"),
        )
        sink.abort()
