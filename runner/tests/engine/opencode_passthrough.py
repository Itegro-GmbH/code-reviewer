# SPDX-License-Identifier: LicenseRef-Proprietary

"""Support for the engine tests of the passthrough proxy (#550): the real pinned OpenCode against
the production `PassthroughProxy`, with the strict generic fakes of `fakes/wire` behind it.

It is `opencode_native.native_engine` with the key swapping relay of the spike replaced by the
proxy the runner ships: the engine holds a random per-job capability, the proxy swaps in the real
key and counts in a ledger of its own, and the strict fake accepts nothing but the real key under
the real header. Only the last hop is a double (`LoopbackUpstream`: plain http on loopback instead
of the pinned https connection). Nothing here talks beyond loopback.
"""

import shutil
import sys
from collections.abc import Generator, Mapping, Sequence
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fakes.wire.relay import Seen
from fakes.wire.upstream import ScriptedUpstream
from opencode_native import (
    BASE_PATH,
    REAL_KEY,
    NativeEngine,
    Provider,
    Running,
    _Engine,  # pyright: ignore[reportPrivateUsage]
    engine_config,
    make_export,
    provider_block,
    tool_script,
)

from code_reviewer_runner.dynamic_review.budget import BudgetLedger, DynamicLimits, UnitCosts
from code_reviewer_runner.dynamic_review.config import new_proxy_capability
from code_reviewer_runner.dynamic_review.passthrough.admission import (
    PassthroughTarget,
    output_allowance,
)
from code_reviewer_runner.dynamic_review.passthrough.cost_policy import CostPolicy
from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily
from code_reviewer_runner.dynamic_review.passthrough.native_run import build_native_run
from code_reviewer_runner.dynamic_review.passthrough.proxy import PassthroughProxy
from code_reviewer_runner.dynamic_review.passthrough.server import PassthroughServer
from passthrough_loopback import LoopbackUpstream

PRICES = UnitCosts(
    input_usd_per_mtok=Decimal(3),
    output_usd_per_mtok=Decimal(15),
    cache_read_usd_per_mtok=Decimal("0.3"),
    cache_write_usd_per_mtok=Decimal("3.75"),
    cache_write_1h_usd_per_mtok=Decimal(6),
)
# The same prices as a price book (#549), for the independent calculator of `usage_calc.py`.
PRICE_BOOK_JSON: dict[str, object] = {
    "input": "3000000",
    "output": "15000000",
    "cacheRead": "300000",
    "cacheWrite5m": "3750000",
    "cacheWrite1h": "6000000",
}
WIRE: dict[str, WireFamily] = {
    "chat": WireFamily.OPENAI_CHAT,
    "responses": WireFamily.OPENAI_RESPONSES,
    "messages": WireFamily.ANTHROPIC_MESSAGES,
    "google": WireFamily.GOOGLE,
}


@dataclass
class PassthroughFront:
    """The proxy of one provider, its ledger and the capability the engine holds."""

    proxy: PassthroughProxy
    server: PassthroughServer
    ledger: BudgetLedger
    capability: str
    seen: list[Seen] = field(default_factory=lambda: [])

    @property
    def url(self) -> str:
        return self.server.url


class PassthroughEngine(NativeEngine):
    def __init__(self, process: _Engine, running: dict[str, Running]) -> None:
        super().__init__(process, running)

    def front(self, provider: str) -> PassthroughFront:
        front = self.running[provider].relay
        assert isinstance(front, PassthroughFront)
        return front


@contextmanager
def passthrough_engine(
    scratch: Path,
    providers: Sequence[Provider],
    *,
    limit: str = "5.00",
    policies: Mapping[str, CostPolicy] | None = None,
) -> Generator[PassthroughEngine]:
    """The fakes, a passthrough proxy in front of each, and one engine that knows all of them.

    A provider named in `policies` (#553) is run under its cost policy: its ledger is the one
    `build_native_ledger` makes and its proxy prices from the policy's book, as a native job does.
    Any other provider keeps the legacy per-job prices."""
    export = make_export(scratch)
    with ExitStack() as stack:
        running: dict[str, Running] = {}
        blocks: dict[str, dict[str, object]] = {}
        for provider in providers:
            upstream = stack.enter_context(
                ScriptedUpstream(
                    provider.family,
                    provider.script(export)
                    if provider.script is not None
                    else tool_script(export, provider.steps, provider.thinking),
                    provider.model_id,
                    real_key=REAL_KEY,
                    judge=provider.judge,
                    on_answer=provider.on_answer,
                    also_models=provider.served,
                )
            )
            if provider.tune is not None:
                provider.tune(upstream)
            limits = DynamicLimits(max_cost_usd=Decimal(limit))
            output = (provider.entry or {}).get("limit", {}).get("output", 8192)
            policy = (policies or {}).get(provider.provider_id)
            capability = new_proxy_capability()
            target = PassthroughTarget(
                family=WIRE[provider.family],
                model=provider.model_id,
                output_allowance=output_allowance(int(output)),
            )
            hop = LoopbackUpstream(upstream.url + BASE_PATH[provider.family])
            if policy is None:
                ledger = BudgetLedger(
                    limits,
                    window_tokens=1_000_000,
                    output_tokens=output_allowance(int(output)),
                    unit_costs=PRICES,
                )
                proxy = PassthroughProxy(
                    ledger=ledger,
                    target=target,
                    upstream=hop,
                    upstream_api_key=REAL_KEY,
                    capability=capability,
                    prices=PRICES,
                )
            else:
                # A native job: the ledger and the proxy of one policy, from the one factory.
                run = build_native_run(
                    policy,
                    limits,
                    window_tokens=1_000_000,
                    output_tokens=output_allowance(int(output)),
                    target=target,
                    upstream=hop,
                    upstream_api_key=REAL_KEY,
                    capability=capability,
                )
                ledger, proxy = run.ledger, run.proxy
            server = PassthroughServer(proxy, "127.0.0.1", 0).start()
            stack.callback(server.stop)
            front = PassthroughFront(proxy, server, ledger, capability)
            running[provider.provider_id] = Running(provider, upstream, front)
            block = provider_block(provider, server.url)
            block["options"]["apiKey"] = capability  # the engine holds this job's capability
            blocks[provider.provider_id] = block
        first = providers[0]
        config = engine_config(blocks, f"{first.provider_id}/{first.model_id}")
        process = _Engine(
            config, export, scratch / "home", next(iter(running.values())).relay.url, None
        )
        stack.callback(process.stop)
        try:
            yield PassthroughEngine(process, running)
        finally:
            shutil.rmtree(export, ignore_errors=True)
