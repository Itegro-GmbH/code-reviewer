# SPDX-License-Identifier: LicenseRef-Proprietary

"""`factory-runner host-wall`: the commands of the host's static nft table of the Incus outer wall
(#1008), which the installer (#1011) and its root timer run.

    host-wall print    the table as text (any user; what `apply` loads)
    host-wall apply    load the table in one transaction, read it back, record it   (root)
    host-wall check    compare the kernel's table with what was loaded, record the verdict;
                       with --reapply load it again when it is gone or differs      (root)
    host-wall status   what the dispatcher sees: the record and its verdict         (any user)

The table is the dispatcher's own: `--user` names the user the dispatcher runs as (its id is in the
owner id, which names the bridges and the table), `--state-dir` its state directory
(`FACTORY_RUNNER_VM_STATE_DIR`, the other half of the owner id), `--prefix` and `--slot-network` the
objects' prefix and the slots' network (`FACTORY_RUNNER_INCUS_PREFIX`,
`FACTORY_RUNNER_SLOT_NETWORK`).
Every one of them must be what the dispatcher is run with: a table for other settings is refused by
its gate. Exit codes: 0 in place (or loaded), 1 not in place, 2 usage, 6 configuration."""

import argparse
import ipaddress
import os
import pwd
import time
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any, TextIO

from code_reviewer_runner.factory_runner.base import (
    EXIT_CONFIG,
    EXIT_FAILED,
    EXIT_OK,
)

from .host_wall import (
    DEFAULT_MAX_AGE_SECONDS,
    HostWallError,
    HostWallGate,
    HostWallSpec,
    NftRunner,
    apply,
    check,
    default_status_path,
    run_nft,
)
from .settings import DEFAULT_PREFIX, STATE_DIR, owner_id
from .slots import DEFAULT_SLOT_NETWORK

PROGRAM = "factory-runner"
ACTIONS = ("print", "apply", "check", "status")
NEEDS_ROOT = ("apply", "check")


def add_parsers(commands: "argparse._SubParsersAction[Any]") -> None:  # pyright: ignore[reportPrivateUsage]
    wall = commands.add_parser(
        "host-wall", help="the host's nft table of the Incus outer wall (apply and check: root)"
    )
    wall.add_argument("action", choices=ACTIONS)
    who = wall.add_mutually_exclusive_group()
    who.add_argument("--user", help="the user the dispatcher runs as (its id is in the owner id)")
    who.add_argument("--owner", help="the owner id (four hex digits) instead of --user")
    wall.add_argument(
        "--state-dir", help="the dispatcher's state directory (the other half of the owner id)"
    )
    wall.add_argument("--prefix", help="the prefix of the objects (default: cr)")
    wall.add_argument("--slot-network", help="the slots' network (default: 10.99.0.0/24)")
    wall.add_argument("--status-file", help="where the record is kept")
    wall.add_argument(
        "--max-age",
        type=float,
        default=None,
        help=f"status: how old the record may be, in seconds (default {DEFAULT_MAX_AGE_SECONDS:g})",
    )
    wall.add_argument(
        "--reapply",
        action="store_true",
        help="check: load the table again when it is gone or differs, and say so",
    )


def _spec(arguments: argparse.Namespace, env: Mapping[str, str]) -> HostWallSpec:
    def pick(option: str | None, variable: str, default: str) -> str:
        return (option or env.get(variable, "")).strip() or default

    if arguments.owner:
        owner = str(arguments.owner).strip()
    else:
        user = str(arguments.user or env.get("FACTORY_RUNNER_SERVICE_USER", "")).strip()
        if not user:
            raise HostWallError("--user (or --owner) names the dispatcher's user")
        try:
            uid = pwd.getpwnam(user).pw_uid
        except KeyError:
            raise HostWallError(f"there is no user {user}") from None
        state_dir = Path(pick(arguments.state_dir, "FACTORY_RUNNER_VM_STATE_DIR", str(STATE_DIR)))
        owner = owner_id(state_dir, uid)
    network_text = pick(arguments.slot_network, "FACTORY_RUNNER_SLOT_NETWORK", "")
    try:
        network = (
            ipaddress.IPv4Network(network_text, strict=True)
            if network_text
            else DEFAULT_SLOT_NETWORK
        )
    except ValueError:
        raise HostWallError("--slot-network is an IPv4 network such as 10.250.0.0/24") from None
    return HostWallSpec(
        pick(arguments.prefix, "FACTORY_RUNNER_INCUS_PREFIX", DEFAULT_PREFIX), owner, network
    )


def run(
    arguments: argparse.Namespace,
    env: Mapping[str, str],
    out: TextIO,
    err: TextIO,
    *,
    nft: NftRunner = run_nft,
    is_root: Callable[[], bool] = lambda: os.geteuid() == 0,
    clock: Callable[[], float] = time.time,
) -> int:
    action = str(arguments.action)
    if action in NEEDS_ROOT and not is_root():
        err.write(f"{PROGRAM}: host-wall {action} needs root (it talks to the kernel's nft)\n")
        return EXIT_CONFIG
    try:
        spec = _spec(arguments, env)
    except HostWallError as error:
        err.write(f"{PROGRAM}: host-wall: {error}\n")
        return EXIT_CONFIG
    configured = str(
        arguments.status_file or env.get("FACTORY_RUNNER_HOST_WALL_STATUS", "")
    ).strip()
    path = Path(configured) if configured else default_status_path(spec.owner)
    if action == "print":
        out.write(spec.ruleset())
        return EXIT_OK
    if action == "status":
        return _status(arguments, spec, path, out, err, clock)
    try:
        if action == "apply":
            apply(spec, path, run=nft, now=clock)
            out.write(f"loaded: {spec.table} ({spec.slot_count} slots), record {path}\n")
            return EXIT_OK
        result = check(spec, path, reapply=bool(arguments.reapply), run=nft, now=clock)
    except HostWallError as error:
        err.write(f"{PROGRAM}: host-wall: {error}\n")
        return EXIT_FAILED
    if result.reapplied:
        out.write(f"reapplied: {result.reason}\n")
    elif result.ok:
        out.write(f"ok: {spec.table}\n")
    else:
        err.write(f"{PROGRAM}: {result.reason}\n")
    return EXIT_OK if result.ok else EXIT_FAILED


def _status(
    arguments: argparse.Namespace,
    spec: HostWallSpec,
    path: Path,
    out: TextIO,
    err: TextIO,
    clock: Callable[[], float],
) -> int:
    max_age = DEFAULT_MAX_AGE_SECONDS if arguments.max_age is None else float(arguments.max_age)
    verdict = HostWallGate(spec, path, max_age_seconds=max_age, clock=clock).verify()
    if verdict.ok:
        out.write(f"in place: {spec.table}\n")
        return EXIT_OK
    err.write(f"{PROGRAM}: not in place: {verdict.reason}\n")
    return EXIT_FAILED


__all__ = ["add_parsers", "run"]
