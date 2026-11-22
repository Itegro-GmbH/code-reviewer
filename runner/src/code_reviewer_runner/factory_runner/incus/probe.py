# SPDX-License-Identifier: LicenseRef-Proprietary

"""The self-test of the agent's own Docker on the Incus backend (#1136).

`agent-docker` was announced here without anything being run. A job's setup script then failed at
the second layer of any image (`failed to mount ... overlay ... err: invalid argument`): the
agent's container, which runs its own `dockerd`, had its data root on the overlay of instance B's
Docker, and an overlay cannot sit on an overlay. A container made from a file has one layer and
never mounts one, so no small check could have shown it. This probe runs what a job runs:

1. a throwaway instance B, made as the launcher makes one (`instances.py`: the same image and
   configuration, a `proxy` device that gives the host B's Docker socket);
2. the agent's container in it, made by the Worker's own `AgentContainer` (the same document, the
   same seal check, the same wait for the container's Docker);
3. an image of three layers (built in B from B's own static `docker-init`), loaded into the
   container's Docker, which unpacks every layer, and run there.

Only when the program prints its version is `agent-docker` true. Whatever happens, the instance and
its directory are deleted. The probe never raises: a failure is a check that says which step."""

import asyncio
import logging
import os
import secrets
import shutil
from collections.abc import Callable
from dataclasses import dataclass
from typing import Final

from code_reviewer_runner.factory_runner.selftest import CHECK_AGENT_DOCKER, Check
from code_reviewer_runner.implementer.agent_container import (
    AGENT_CONTAINER_NAME,
    AgentContainer,
    AgentSeams,
)
from code_reviewer_runner.implementer.docker_api import DockerApi
from code_reviewer_runner.implementer.network_rule import OFF
from code_reviewer_runner.implementer.placement import (
    B_WORK_VOLUME,
    SPLIT_RUNTIME,
    Placement,
)
from code_reviewer_runner.job import JobError

from .client import IncusClient, IncusError, run_exec
from .instances import instance_spec
from .launcher import B_DOCKER_SOCKET_IN_B
from .settings import IncusSettings
from .slots import INNER_A_ADDRESS

_log = logging.getLogger(__name__)

# The job mark of the probe's instance: the reaper deletes what a killed service left of it.
PROBE_MARK: Final = "selftest"
PROBE_IMAGE: Final = "cr-probe-layers"
# What the program of the probe image prints (tini, the `docker-init` of Docker's static bundle).
PROBE_OUTPUT: Final = "version"
DEVICE_SOCKET: Final = "bdocker"
SOCKET_FILE: Final = "bdocker.sock"
BUILD_SECONDS: Final = 180.0
LOAD_SECONDS: Final = 300.0
CALL_SECONDS: Final = 30.0
# The whole probe, the clean-up of its instance excluded: the probe is in the start path of the
# service, so a hang must cost the capability, not minutes of registration.
PROBE_SECONDS: Final = 180.0
# The delete of the probe's instance after a timeout or a crash gets its own short deadline.
DELETE_SECONDS: Final = 60.0
# Three layers of a few bytes and one static program: the least that makes the container's Docker
# mount an overlay for the second and the third.
BUILD_SCRIPT: Final = f"""set -eu
work=$(mktemp -d)
cd "$work"
cp /usr/local/bin/docker-init init
printf one > one
printf two > two
{{
  echo 'FROM scratch'
  echo 'COPY one /one'
  echo 'COPY init /init'
  echo 'COPY two /two'
  echo 'ENTRYPOINT ["/init","--version"]'
}} > Dockerfile
docker build -q -t {PROBE_IMAGE} . >/dev/null
cd /
rm -rf "$work"
# The work volume the agent's definition mounts a subdirectory of (the launcher's job makes it
# before the agent exists).
docker volume create {B_WORK_VOLUME} >/dev/null
root=$(docker volume inspect --format '{{{{.Mountpoint}}}}' {B_WORK_VOLUME})
mkdir -p "$root/repo"
"""
LOAD_SCRIPT: Final = f"""set -eu
docker save {PROBE_IMAGE} | docker exec -i {AGENT_CONTAINER_NAME} docker load >/dev/null
docker exec {AGENT_CONTAINER_NAME} docker run --rm --network none {PROBE_IMAGE}
"""


@dataclass(frozen=True)
class ProbeSeams:
    """What the tests replace; production leaves the defaults. B's socket on the host does not
    half-close (`DockerApi.half_close`)."""

    api: Callable[[str], DockerApi] = lambda path: DockerApi(path, half_close=False)


class _Progress:
    """The step the probe is at, so that a timeout or a crash can say where it happened."""

    step: str = "making the probe instance"


class _Failed(Exception):
    """A step of the probe did not hold; the text says which and never carries more than the
    tail of a command's output."""


def _tail(text: str, keep: int = 400) -> str:
    return " ".join(text.strip().split())[-keep:]


async def _step(
    client: IncusClient, name: str, argv: tuple[str, ...], *, seconds: float, what: str
) -> str:
    done = await run_exec(client, name, argv, timeout=seconds)
    if done.exit_code != 0:
        raise _Failed(f"{what} failed (exit {done.exit_code}): {_tail(done.stderr or done.stdout)}")
    return done.stdout


async def _wait_for_docker(client: IncusClient, name: str, seconds: float) -> None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + seconds
    while True:
        done = await run_exec(
            client,
            name,
            ("docker", "version", "--format", "{{.Server.Version}}"),
            timeout=CALL_SECONDS,
        )
        if done.exit_code == 0:
            return
        if loop.time() >= deadline:
            raise _Failed("Docker did not answer in the probe instance")
        await asyncio.sleep(0.5)


def _agent_container(
    settings: IncusSettings, socket: str, seams: ProbeSeams, memory_mib: int
) -> AgentContainer:
    placement = Placement(split=True, docker_socket=socket, door_address=INNER_A_ADDRESS)
    return AgentContainer(
        memory_mib,
        AgentSeams(
            api=lambda: seams.api(socket),
            runtime=SPLIT_RUNTIME,
            entrypoint=None,
            placement=placement,
            ready_seconds=settings.ready_seconds,
        ),
        OFF,
    )


async def _delete(client: IncusClient, name: str) -> None:
    """Delete the probe's instance. A failure is logged with the name (a running B keeps memory and
    disk until the reaper of the next launcher start, `PROBE_MARK`), never raised."""
    try:
        async with asyncio.timeout(DELETE_SECONDS):
            await client.delete(name)
    except Exception as error:
        detail = error.detail if isinstance(error, IncusError) else type(error).__name__
        _log.warning("the probe's instance %s could not be deleted (%s)", name, detail)


async def _run(
    settings: IncusSettings,
    client: IncusClient,
    seams: ProbeSeams,
    name: str,
    progress: _Progress,
) -> None:
    directory = settings.jobs_dir / f"job-{name.rsplit('-', 1)[-1]}"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    socket = directory / SOCKET_FILE
    try:
        await client.create(instance_spec(settings, name=name, role="b", job=PROBE_MARK, slot=None))
        await client.add_device(
            name,
            DEVICE_SOCKET,
            {
                "type": "proxy",
                "listen": f"unix:{socket}",
                "connect": f"unix:{B_DOCKER_SOCKET_IN_B}",
                "bind": "host",
                # The launcher's job sockets belong to `incusd` (nothing but A's device may use
                # them). The probe's own Worker code drives B's Docker from here, so this one
                # belongs to the service's user, in a directory only that user can enter.
                "uid": str(os.getuid()),
                "gid": str(os.getgid()),
                "mode": "0600",
            },
        )
        progress.step = "starting the probe instance"
        await client.start(name)
        progress.step = "waiting for Docker in the probe instance"
        await _wait_for_docker(client, name, settings.ready_seconds)
        progress.step = "building the three-layer image"
        await _step(
            client, name, ("sh", "-c", BUILD_SCRIPT), seconds=BUILD_SECONDS, what="the build"
        )
        progress.step = "making the agent's container"
        container = _agent_container(settings, str(socket), seams, settings.memory_mib)
        try:
            await asyncio.to_thread(container.create)
        except JobError as error:
            raise _Failed(
                f"the agent's container could not be made: {_tail(error.detail)}"
            ) from None
        progress.step = "loading and running the image in the container's Docker"
        printed = await _step(
            client,
            name,
            ("sh", "-c", LOAD_SCRIPT),
            seconds=LOAD_SECONDS,
            what="loading and running an image of three layers in the container's Docker",
        )
        if PROBE_OUTPUT not in printed:
            raise _Failed("the three-layer image ran but printed nothing it should have")
    finally:
        await _delete(client, name)
        shutil.rmtree(directory, ignore_errors=True)


async def probe_agent_docker(
    settings: IncusSettings,
    client: IncusClient,
    seams: ProbeSeams | None = None,
    *,
    seconds: float = PROBE_SECONDS,
) -> Check:
    """Run the probe; the check `agent-docker`, true only when a three-layer image was unpacked and
    run in the container's own Docker. Never raises (the service starts with it) and never takes
    longer than `seconds` plus the delete of the instance: whatever ends the probe, the instance
    and its directory go."""
    name = settings.instance_b(f"{PROBE_MARK}-{secrets.token_hex(3)}")
    progress = _Progress()
    try:
        async with asyncio.timeout(seconds):
            await _run(settings, client, seams or ProbeSeams(), name, progress)
    except _Failed as failed:
        return Check(CHECK_AGENT_DOCKER, False, str(failed))
    except TimeoutError:
        _log.warning(
            "the agent-docker probe took longer than %.0f s and was stopped (%s)",
            seconds,
            progress.step,
        )
        return Check(
            CHECK_AGENT_DOCKER,
            False,
            f"the probe did not finish within {seconds:.0f} s (stopped while {progress.step})",
        )
    except (IncusError, OSError) as error:
        detail = error.detail if isinstance(error, IncusError) else type(error).__name__
        _log.warning("the agent-docker probe could not run (%s)", detail)
        return Check(CHECK_AGENT_DOCKER, False, f"the probe instance could not be used ({detail})")
    except Exception as error:
        # A bug in the code the probe drives (`AgentContainer.create` runs in a thread) costs
        # `agent-docker`, not the service: `prepare_incus` promises never to raise.
        message = _tail(str(error), 200)
        _log.warning(
            "the agent-docker probe crashed while %s (%s: %s)",
            progress.step,
            type(error).__name__,
            message,
        )
        return Check(
            CHECK_AGENT_DOCKER,
            False,
            f"the probe crashed while {progress.step} ({type(error).__name__}: {message})",
        )
    return Check(CHECK_AGENT_DOCKER, True, "")
