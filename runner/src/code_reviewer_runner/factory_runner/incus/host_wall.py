# SPDX-License-Identifier: LicenseRef-Proprietary

"""The host's static nft table of the Incus outer wall (#1008, Runner v2, epic #969, spike #1005).

Incus alone leaves **port 53 of every host-local address** open to an instance (its implicit
DNS/DHCP accept comes before the network's ACL, still so on 7.6), and an ACL cannot do more than the
bridge it is on. So the outer wall has a part that is not Incus's: a table of our own, loaded once
at install as root and never changed while jobs come and go. From an **instance bridge** (a network
named `<prefix>-<owner>-*`, outer and inner alike) it drops everything addressed to the host except,
per slot, a TCP connection from that slot's A or B to the dispatcher's proxy on the slot's own
bridge address. Everything forwarded (the LAN, the cloud metadata address, the internet, the other
bridges, Docker's), IPv6 and DNS of any host-local address (the bridge's own, `incusbr0`'s,
`docker0`'s, the machine's) is dropped. It is a table of its own that names only our bridges, so the
host's own traffic and every other table of the machine (Docker's, Incus's) are untouched: this
module never names them and never edits them.

The table is per **owner** (`settings.owner`): two dispatchers on one Incus daemon (two users of
`incus-admin`) each have their own bridges and so their own table, `code_reviewer_wall_<owner>`.
Slot *N* of the slots' network is `<prefix>-<owner>-o<N>`, with the host at the first address of its
/29, A at the second and B at the third (`slots.py`); the table carries a rule for every slot the
network has room for (at most 32), so it does not depend on how many jobs the runner runs at once.

Three parties:

* `HostWallSpec.ruleset()` is the table, as text; it is printed in `docs/runner.md`.
* `apply` and `check` run **as root** (`factory-runner host-wall`, `host_wall_cli.py`): `apply`
  loads the table in one transaction, lists it back and writes the **status file**; `check`
  compares what the kernel holds with what `apply` loaded (and with what this program renders
  now) and, with `reapply`, loads the table again when it is gone or differs. A root timer runs
  `check` every few seconds, the way #979's `check-wall` did.
* `HostWallGate` is what **the dispatcher** asks before it takes a job. The dispatcher is an
  unprivileged user who cannot read nft, so it reads the status file root writes (in a directory
  only root can write to): the table counts as there only when the last check found it as loaded,
  for exactly these settings, and is not older than `max_age_seconds`. A missing, stale, failed or
  foreign record means no jobs.

A flush of the machine's rules after a check leaves a window of up to the timer's period in which a
running job's bridge has no table; the dispatcher takes no new job from the first look that fails
(`HostWallGate.verify` per claim), the timer's `reapply` closes it, and the window is in
`docs/runner.md` under "Known limits"."""

import hashlib
import ipaddress
import json
import logging
import os
import re
import subprocess
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from code_reviewer_runner.factory_runner.incus.provision import PROXY_PORT

from .settings import IncusSettings
from .slots import ADDRESSES_PER_SLOT, MAX_SLOTS, IncusSlot

TABLE_PREFIX: Final = "code_reviewer_wall_"
# Before the filter hooks other firewalls (Docker's, Incus's, ufw) have at priority 0; a drop here
# is final for the packet whatever they would accept.
PRIORITY: Final = -150
STATUS_DIRECTORY: Final = Path("/run/code-reviewer")
STATUS_VERSION: Final = 1
# The root timer runs every 10 seconds; a record that is older says the check does not run.
DEFAULT_MAX_AGE_SECONDS: Final = 60.0
# A record dated this far ahead of the dispatcher's clock is not believed.
CLOCK_SKEW_SECONDS: Final = 5.0
NFT_SECONDS: Final = 30.0

_OWNER = re.compile(r"[0-9a-f]{4}")
_PREFIX = re.compile(r"[a-z][a-z0-9]{0,15}")
_COUNTERS = re.compile(r"counter packets \d+ bytes \d+")

_log = logging.getLogger(__name__)


class HostWallError(Exception):
    """The table could not be rendered, loaded or read back. The message names what failed."""


@dataclass(frozen=True)
class HostWallSpec:
    """What the table is made from: the prefix of the machine's objects, the owner of this
    dispatcher and the slots' network. Nothing else (not the number of jobs)."""

    prefix: str
    owner: str
    slot_network: ipaddress.IPv4Network

    def __post_init__(self) -> None:
        if not _PREFIX.fullmatch(self.prefix):
            raise HostWallError("prefix: lower-case letters and digits, starting with a letter")
        if not _OWNER.fullmatch(self.owner):
            raise HostWallError("owner: four hex digits")
        if self.slot_network.num_addresses < ADDRESSES_PER_SLOT:
            raise HostWallError("the slots' network has room for no slot")

    @property
    def name_prefix(self) -> str:
        """What every instance bridge of this dispatcher starts with."""
        return f"{self.prefix}-{self.owner}"

    @property
    def table(self) -> str:
        return f"{TABLE_PREFIX}{self.owner}"

    @property
    def slot_count(self) -> int:
        return min(MAX_SLOTS, self.slot_network.num_addresses // ADDRESSES_PER_SLOT)

    def slots(self) -> list[IncusSlot]:
        return [IncusSlot(index, self.slot_network) for index in range(self.slot_count)]

    def outer_bridge(self, slot: int) -> str:
        return f"{self.name_prefix}-o{slot}"

    def ruleset(self) -> str:
        """The table, as `nft -f` takes it: declared, deleted and declared with its content, so it
        loads the first time and replaces an earlier load, in one transaction."""
        name, bridges = self.table, f'"{self.name_prefix}-*"'
        header = [
            "# SPDX-License-Identifier: LicenseRef-Proprietary",
            "#",
            "# The outer wall of the Incus instance bridges of one dispatcher (#1008).",
            f"# Every rule names a bridge `{self.name_prefix}-*` and nothing else: the",
            "# machine's own traffic and every other table (Docker's, Incus's) are untouched.",
            "# Loaded once at install as root; never changed while jobs run.",
        ]
        accepts = [
            f'    iifname "{self.outer_bridge(slot.index)}" '
            f"ip saddr {{ {slot.guest_address}, {slot.b_address} }} ip daddr {slot.host_address} "
            f'tcp dport {PROXY_PORT} counter accept comment "slot {slot.index}: the proxy"'
            for slot in self.slots()
        ]
        lines = [
            *header,
            f"table inet {name}",
            f"delete table inet {name}",
            f"table inet {name} {{",
            "  chain input {",
            f"    type filter hook input priority {PRIORITY}; policy accept;",
            *accepts,
            f'    iifname {bridges} meta nfproto ipv6 counter drop comment "no IPv6"',
            f'    iifname {bridges} counter drop comment "all else to the host, DNS included"',
            "  }",
            "  chain forward {",
            f"    type filter hook forward priority {PRIORITY}; policy accept;",
            f'    iifname {bridges} counter drop comment "an instance forwards to nothing"',
            f'    oifname {bridges} counter drop comment "nothing forwards to an instance"',
            "  }",
            "  chain output {",
            f"    type filter hook output priority {PRIORITY}; policy accept;",
            f'    oifname {bridges} ct state established,related counter accept comment "answers"',
            f'    oifname {bridges} counter drop comment "the host opens no connection"',
            "  }",
            "}",
        ]
        return "\n".join(lines) + "\n"

    @property
    def source_digest(self) -> str:
        """The digest of `ruleset()`: what a record says was loaded, and what a gate expects."""
        return hashlib.sha256(self.ruleset().encode("ascii")).hexdigest()


def spec_for(settings: IncusSettings) -> HostWallSpec:
    return HostWallSpec(settings.prefix, settings.owner, settings.slot_network)


def default_status_path(owner: str) -> Path:
    return STATUS_DIRECTORY / f"host-wall-{owner}.json"


def status_path_for(settings: IncusSettings) -> Path:
    return settings.host_wall_status or default_status_path(settings.owner)


# -- nft ---


@dataclass(frozen=True)
class NftResult:
    returncode: int
    stdout: str = ""
    stderr: str = ""


# `nft <arguments>` with an optional standard input; tests bring a fake.
NftRunner = Callable[[Sequence[str], str | None], NftResult]


def run_nft(arguments: Sequence[str], stdin: str | None = None) -> NftResult:
    try:
        done = subprocess.run(
            ["nft", *arguments],
            input=stdin,
            capture_output=True,
            text=True,
            timeout=NFT_SECONDS,
            check=False,
        )
    except FileNotFoundError:
        raise HostWallError("nft is not installed") from None
    except subprocess.TimeoutExpired:
        raise HostWallError("nft did not answer in time") from None
    return NftResult(done.returncode, done.stdout, done.stderr)


def _first_line(text: str) -> str:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return lines[0] if lines else "no message"


def normalized(listing: str) -> str:
    """A listing of the table without its counters, which change with every packet."""
    return _COUNTERS.sub("counter", listing)


def listing_of(spec: HostWallSpec, run: NftRunner) -> str | None:
    """What the kernel holds for the table, without counters; None when there is no such table."""
    result = run(["list", "table", "inet", spec.table], None)
    if result.returncode != 0:
        return None
    return normalized(result.stdout)


def _digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _holds(spec: HostWallSpec, listing: str) -> bool:
    """The three chains are there and so is a proxy rule for every slot: a sanity check on what
    `nft -f` loaded, not a comparison (`check` compares)."""
    return all(f"chain {chain}" in listing for chain in ("input", "forward", "output")) and (
        listing.count(f"tcp dport {PROXY_PORT}") == spec.slot_count
    )


# -- the status file ---


def read_status(path: Path) -> dict[str, object] | None:
    """The record, or None when there is none or it is not a record of this version."""
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(document, dict) or document.get("version") != STATUS_VERSION:  # pyright: ignore[reportUnknownMemberType]
        return None
    return {str(key): value for key, value in document.items()}  # pyright: ignore[reportUnknownVariableType, reportUnknownArgumentType]


def _write_status(path: Path, document: Mapping[str, object]) -> None:
    """Atomically, readable by everybody (the dispatcher's user reads it), in a directory that only
    its owner can write to."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(json.dumps(document, sort_keys=True), encoding="utf-8")
    temporary.chmod(0o644)
    os.replace(temporary, path)


def _record(
    spec: HostWallSpec,
    path: Path,
    now: float,
    *,
    ok: bool,
    reason: str = "",
    listing: str | None = None,
    kept: object = None,
) -> None:
    document: dict[str, object] = {
        "version": STATUS_VERSION,
        "table": spec.table,
        "source": spec.source_digest,
        "ok": ok,
        "reason": reason,
        "checkedAt": now,
    }
    if listing is not None:
        document["listing"] = _digest(listing)
    elif isinstance(kept, str):
        document["listing"] = kept
    _write_status(path, document)


# -- root: apply and check ---


def apply(
    spec: HostWallSpec,
    path: Path,
    *,
    run: NftRunner = run_nft,
    now: Callable[[], float] = time.time,
) -> None:
    """Load the table in one transaction (it replaces an earlier load of its own and touches no
    other table), read it back and record it. Raises `HostWallError` and leaves the record not
    ok."""
    loaded = run(["-f", "-"], spec.ruleset())
    if loaded.returncode != 0:
        reason = f"nft refused the table: {_first_line(loaded.stderr)}"
        _record(spec, path, now(), ok=False, reason=reason)
        raise HostWallError(reason)
    listing = listing_of(spec, run)
    if listing is None or not _holds(spec, listing):
        reason = f"table {spec.table} is not what was loaded when read back"
        _record(spec, path, now(), ok=False, reason=reason)
        raise HostWallError(reason)
    _record(spec, path, now(), ok=True, listing=listing)


@dataclass(frozen=True)
class CheckResult:
    ok: bool
    reason: str = ""
    reapplied: bool = False


def _problem(spec: HostWallSpec, path: Path, run: NftRunner) -> tuple[str, str | None]:
    """What is wrong with the table (empty: nothing) and the listing that was read."""
    listing = listing_of(spec, run)
    if listing is None:
        return f"table {spec.table} is not loaded", None
    record = read_status(path)
    if record is None or record.get("source") != spec.source_digest or "listing" not in record:
        return (
            f"table {spec.table} was not loaded by this program with these settings "
            "(no record, or it is for other settings)",
            listing,
        )
    if record["listing"] != _digest(listing):
        return f"table {spec.table} differs from what was loaded", listing
    return "", listing


def check(
    spec: HostWallSpec,
    path: Path,
    *,
    reapply: bool = False,
    run: NftRunner = run_nft,
    now: Callable[[], float] = time.time,
) -> CheckResult:
    """Compare what the kernel holds with what `apply` loaded and record the verdict (the gate
    reads it). With `reapply` a table that is gone or differs is loaded again, and the result says
    so. Never raises for a table that is wrong: that is the result; `HostWallError` only when nft
    cannot be asked or a reload fails."""
    reason, listing = _problem(spec, path, run)
    if not reason:
        _record(spec, path, now(), ok=True, listing=listing)
        return CheckResult(True)
    if reapply:
        apply(spec, path, run=run, now=now)
        return CheckResult(True, reason, reapplied=True)
    # What was loaded stays in the record, so that a table put back by hand passes the next check
    # and a table that differs is still reported as one that differs (a failed record is not a
    # forgotten one).
    previous = read_status(path)
    kept = (
        previous.get("listing")
        if previous and previous.get("source") == spec.source_digest
        else None
    )
    _record(spec, path, now(), ok=False, reason=reason, kept=kept)
    return CheckResult(False, reason)


# -- the dispatcher: the gate ---


@dataclass(frozen=True)
class WallVerdict:
    ok: bool
    reason: str = ""


class HostWallGate:
    """What the dispatcher asks before it takes a job: has root found the table as loaded, for these
    settings, lately? It reads the status file and never nft (an unprivileged user cannot)."""

    def __init__(
        self,
        spec: HostWallSpec,
        path: Path,
        *,
        max_age_seconds: float = DEFAULT_MAX_AGE_SECONDS,
        clock: Callable[[], float] = time.time,
        logger: logging.Logger = _log,
    ) -> None:
        self.spec = spec
        self.path = path
        self._max_age = max_age_seconds
        self._clock = clock
        self._log = logger
        self._last: WallVerdict | None = None

    @classmethod
    def for_settings(cls, settings: IncusSettings) -> "HostWallGate":
        return cls(
            spec_for(settings),
            status_path_for(settings),
            max_age_seconds=settings.host_wall_max_age_seconds,
        )

    def verify(self) -> WallVerdict:
        verdict = self._look()
        if verdict != self._last:
            # Logged when it changes, not at every claim.
            (self._log.info if verdict.ok else self._log.error)(
                "the host's outer wall table %s: %s",
                self.spec.table,
                "in place" if verdict.ok else verdict.reason,
            )
            self._last = verdict
        return verdict

    def _look(self) -> WallVerdict:
        record = read_status(self.path)
        if record is None:
            return WallVerdict(
                False,
                f"no record of the table {self.spec.table} at {self.path} "
                "(factory-runner host-wall apply, as root)",
            )
        if record.get("source") != self.spec.source_digest:
            return WallVerdict(
                False,
                "the loaded table is for other settings (prefix, owner or slot network) than "
                "this dispatcher's",
            )
        checked = record.get("checkedAt")
        if not isinstance(checked, int | float) or isinstance(checked, bool):
            return WallVerdict(False, "the record of the table has no time")
        age = self._clock() - float(checked)
        if age < -CLOCK_SKEW_SECONDS:
            return WallVerdict(False, "the record of the table is dated in the future")
        if age > self._max_age:
            return WallVerdict(
                False,
                f"the record of the table is {age:.0f} s old (at most {self._max_age:.0f} s): "
                "the root check does not run",
            )
        if record.get("ok") is not True:
            why = record.get("reason")
            return WallVerdict(
                False,
                f"the last check failed: {why if isinstance(why, str) and why else 'unknown'}",
            )
        return WallVerdict(True)
