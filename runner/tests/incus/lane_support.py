# SPDX-License-Identifier: LicenseRef-Proprietary

"""What the Incus lane (#1007) needs besides the launcher: the machine it runs on, a client that
makes every instance carry the lane's stand-ins (an `nft` of the host, a stand-in `docker`), and
probes run from inside an instance.

The lane runs on a machine whose user is in `incus-admin`, with a storage pool, an image and a
prefix of the lane's own (never `default`, never an object it did not make), and a slot network of
its own. `CR_INCUS_LANE_POOL`, `CR_INCUS_LANE_IMAGE` (an alias of an Ubuntu 24.04 image in Incus),
`CR_INCUS_LANE_PREFIX` (default `crlane`), `CR_INCUS_LANE_NETWORK` (default `10.99.0.0/24`) and
`CR_INCUS_LANE_STATE` (a directory the Incus daemon can see: not under `/tmp`) name them."""

import os
import shutil
import subprocess
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from code_reviewer_runner.factory_runner.incus.client import (
    CliIncusClient,
    ExecResult,
    IncusClient,
    InstanceSpec,
    run_exec,
)

IMAGE_ID = "sha256:" + "ab" * 32
NFT = Path("/usr/sbin/nft")
HERE = Path(__file__).parent
# The libraries of `nft` that a stock Ubuntu 24.04 image lacks (the host is the same release).
LIBRARIES = ("libnftables.so.1", "libnftnl.so.11", "libjansson.so.4")
LIBRARY_DIRECTORY = Path("/lib/x86_64-linux-gnu")


@dataclass(frozen=True)
class Machine:
    pool: str
    image: str
    prefix: str
    network: str
    state: Path


def load_machine(environment: Mapping[str, str] = os.environ) -> Machine | None:
    pool, image = environment.get("CR_INCUS_LANE_POOL"), environment.get("CR_INCUS_LANE_IMAGE")
    state = environment.get("CR_INCUS_LANE_STATE")
    if not pool or not image or not state:
        return None
    return Machine(
        pool,
        image,
        environment.get("CR_INCUS_LANE_PREFIX", "crlane"),
        environment.get("CR_INCUS_LANE_NETWORK", "10.99.0.0/24"),
        Path(state),
    )


def have_nft_to_push() -> bool:
    return NFT.exists() and all((LIBRARY_DIRECTORY / name).exists() for name in LIBRARIES)


class StandInClient(CliIncusClient):
    """The real client; every instance it makes gets the stand-ins of the lane before it starts:
    the host's `nft` (so the inner wall is the real table in a real network namespace) and a
    `docker` that is Control (`fake_docker.py`)."""

    async def create(self, spec: InstanceSpec) -> None:
        await super().create(spec)
        name = spec.name
        await self.push_file(name, "/usr/local/sbin/nft", NFT.read_bytes(), mode="0755")
        for library in LIBRARIES:
            await self.push_file(
                name,
                f"/usr/lib/x86_64-linux-gnu/{library}",
                (LIBRARY_DIRECTORY / library).read_bytes(),
            )
        await self.push_file(
            name, "/usr/local/bin/docker", (HERE / "fake_docker.py").read_bytes(), mode="0755"
        )
        await self.push_file(name, "/etc/code-reviewer/fake-image-id", IMAGE_ID.encode())


async def probe(
    client: IncusClient, instance: str, command: str, *, seconds: float = 20.0
) -> ExecResult:
    """A shell command in an instance."""
    return await run_exec(client, instance, ("sh", "-c", command), timeout=seconds)


async def reaches(client: IncusClient, instance: str, address: str, port: int) -> bool:
    """Whether a TCP connection from `instance` to `address:port` is made (`nc`, 3 s)."""
    result = await probe(client, instance, f"nc -z -w3 {address} {port}")
    return result.exit_code == 0


def incus_available() -> bool:
    return (
        shutil.which("incus") is not None
        and subprocess.run(
            ["incus", "version"], capture_output=True, check=False, stdin=subprocess.DEVNULL
        ).returncode
        == 0
    )
