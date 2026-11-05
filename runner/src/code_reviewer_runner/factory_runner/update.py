# SPDX-License-Identifier: LicenseRef-Proprietary

"""Signed updates of the runner's own image (#855, R2; plan decision 9).

A runner updates itself between jobs, or on the device (`factory-runner update`), never from
the app.
The unit that the installer writes starts the container from the local tag `factory-runner:current`
and restarts it when it ends. An update is therefore two separate acts:

1. **Stage** (`stage`): find the newest release, prove it is ours, and point the local tag at it.
   The release channel is the tag `stable` of the runner image in the registry
   (`ghcr.io/itegro-gmbh/code-reviewer-factory-runner`). The image is pulled by that tag, which only
   downloads it, and **then verified by its digest**: `cosign verify` against the keyless signature
   that the release workflow `.github/workflows/runner-image.yml` makes with GitHub's OIDC identity
   (no key to keep: the certificate says which workflow of which repository signed, and `SIGNER`
   pins it). Only a verified digest is tagged `current` (the one before it `previous`, for
   `--rollback`); an image that does not verify is removed and nothing changes. The image carries
   the number of its release (`code-reviewer.runner.release`, a label set by the workflow); an image
   whose number is not higher than the running one's is not taken, so a signed older image that
   somebody puts behind `stable` is no way to go back.
2. **Apply** (`switch_needed`): when the image behind `current` is another one than the one this
   container runs, the service ends (exit code 10) **between jobs**, never during one, and the unit
   starts it again from the new image. `factory-runner update` only stages; a running job is never
   touched.

The service does both on its own (`UpdatePolicy`): a check some minutes after the start and then
every six hours, at the moment between two jobs; at once when the app answers a claim with "update
needed" (a base below the minimum version). The service follows the tag only when the unit says
so (`FACTORY_RUNNER_IMAGE_TAG`), so a runner that somebody started by hand (`docker run` without a
supervisor) never ends itself for an update. `run --once` never updates.
"""

import contextlib
import logging
import random
import subprocess
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from enum import StrEnum
from functools import partial
from typing import Final, cast

from code_reviewer_runner.implementer.docker_api import DockerApi, DockerError
from code_reviewer_runner.job_loop.jsonvalues import as_object

REPOSITORY: Final = "ghcr.io/itegro-gmbh/code-reviewer-factory-runner"
CHANNEL_TAG: Final = "stable"
CURRENT_REPOSITORY: Final = "factory-runner"
CURRENT_TAG: Final = "current"
PREVIOUS_TAG: Final = "previous"
CURRENT_REFERENCE: Final = f"{CURRENT_REPOSITORY}:{CURRENT_TAG}"
PREVIOUS_REFERENCE: Final = f"{CURRENT_REPOSITORY}:{PREVIOUS_TAG}"
# The unit sets it to `CURRENT_REFERENCE`: the tag this container follows.
IMAGE_TAG_VARIABLE: Final = "FACTORY_RUNNER_IMAGE_TAG"
# The number of a release, a whole number that grows with every release (the workflow's run number).
RELEASE_LABEL: Final = "code-reviewer.runner.release"
# Who may sign a runner image: the release workflow of this repository, run from `main` or from a
# tag, as GitHub's OIDC issuer says it. Not configurable: a runner that took another identity from
# its configuration would be as safe as the file that names it.
SIGNER: Final = (
    r"^https://github\.com/Itegro-GmbH/code-reviewer/\.github/workflows/runner-image\.yml"
    r"@refs/(heads/main|tags/.+)$"
)
OIDC_ISSUER: Final = "https://token.actions.githubusercontent.com"
COSIGN: Final = "cosign"
VERIFY_SECONDS: Final = 180.0
PULL_SECONDS: Final = 1800.0

FIRST_CHECK_SECONDS: Final = 600.0
CHECK_INTERVAL_SECONDS: Final = 6 * 3600.0
CHECK_JITTER: Final = 0.1

Runner = Callable[..., "subprocess.CompletedProcess[str]"]


class UpdateError(Exception):
    """The update did not happen; the message says why and never holds a secret."""


class Outcome(StrEnum):
    UP_TO_DATE = "up_to_date"
    STAGED = "staged"


@dataclass(frozen=True)
class Staged:
    outcome: Outcome
    release: int
    digest: str


def verify_command(reference: str, cosign: str = COSIGN) -> list[str]:
    """What proves a digest: the signature of the release workflow, nothing else."""
    return [
        cosign,
        "verify",
        "--certificate-identity-regexp",
        SIGNER,
        "--certificate-oidc-issuer",
        OIDC_ISSUER,
        reference,
    ]


def cosign_verify(
    reference: str, *, environment: Mapping[str, str], run: Runner = subprocess.run
) -> None:
    """Raise `UpdateError` unless `reference` (by digest) carries our signature. The output of
    `cosign` is not shown: its exit status is the answer."""
    # Only what cosign needs: the search path, and a home for its cache of the signing roots (the
    # runner's own configuration volume).
    home = environment.get("FACTORY_RUNNER_HOME") or environment.get("HOME") or "/tmp"
    env = {"PATH": environment.get("PATH", "/usr/local/bin:/usr/bin:/bin"), "HOME": home}
    try:
        done = run(
            verify_command(reference),
            capture_output=True,
            text=True,
            timeout=VERIFY_SECONDS,
            check=False,
            env=env,
        )
    except FileNotFoundError:
        raise UpdateError("cosign is not installed: the signature cannot be checked") from None
    except subprocess.TimeoutExpired:
        raise UpdateError(
            "checking the signature took too long (is the network reachable?)"
        ) from None
    if done.returncode != 0:
        raise UpdateError("the signature of the image could not be verified: not our release")


def release_of(image: Mapping[str, object]) -> int:
    labels = as_object((as_object(image.get("Config")) or {}).get("Labels")) or {}
    raw = labels.get(RELEASE_LABEL)
    return int(raw) if isinstance(raw, str) and raw.isascii() and raw.isdigit() else 0


def _digest_of(image: Mapping[str, object]) -> str | None:
    listed: object = image.get("RepoDigests")
    entries: list[object] = list(cast("list[object]", listed)) if isinstance(listed, list) else []
    for entry in entries:
        if isinstance(entry, str) and entry.startswith(f"{REPOSITORY}@sha256:"):
            digest = entry.split("@", 1)[1]
            if len(digest) == len("sha256:") + 64:
                return digest
    return None


def own_image(api: DockerApi, hostname: str) -> dict[str, object]:
    """The image this container runs, as the daemon describes it."""
    try:
        container = api.inspect_container(hostname)
        return dict(api.inspect_image(str(container.get("Image", ""))))
    except DockerError as error:
        raise UpdateError(f"the daemon cannot say which image this runner runs ({error})") from None


def stage(
    api: DockerApi,
    *,
    running_release: int,
    verify: Callable[[str], None],
    pull_seconds: float = PULL_SECONDS,
) -> Staged:
    """Find the release behind `stable`, prove it, and make it `current` when it is newer than
    `running_release`. `UpdateError` for anything that stops that; nothing is tagged then, and an
    image that failed its proof is removed again."""
    channel = f"{REPOSITORY}:{CHANNEL_TAG}"
    try:
        api.request(
            "POST",
            f"/images/create?fromImage={REPOSITORY}&tag={CHANNEL_TAG}",
            ok=(200,),
            timeout=pull_seconds,
        )
        image = dict(api.inspect_image(channel))
    except DockerError as error:
        raise UpdateError(f"the release channel cannot be pulled ({error})") from None
    digest = _digest_of(image)
    if digest is None:
        raise UpdateError("the pulled image has no digest of the release repository")
    by_digest = f"{REPOSITORY}@{digest}"
    try:
        verify(by_digest)
    except UpdateError:
        _forget(api, channel)
        raise
    release = release_of(image)
    if release <= running_release:
        return Staged(Outcome.UP_TO_DATE, running_release, digest)
    try:
        if _exists(api, CURRENT_REFERENCE):
            api.request(
                "POST",
                f"/images/{CURRENT_REFERENCE}/tag?repo={CURRENT_REPOSITORY}&tag={PREVIOUS_TAG}",
                ok=(201,),
            )
        api.request(
            "POST",
            f"/images/{by_digest}/tag?repo={CURRENT_REPOSITORY}&tag={CURRENT_TAG}",
            ok=(201,),
        )
    except DockerError as error:
        raise UpdateError(f"the new image could not be named ({error})") from None
    return Staged(Outcome.STAGED, release, digest)


def rollback(api: DockerApi) -> None:
    """Point `current` back at the image before the last update. `UpdateError` without one."""
    try:
        api.request(
            "POST",
            f"/images/{PREVIOUS_REFERENCE}/tag?repo={CURRENT_REPOSITORY}&tag={CURRENT_TAG}",
            ok=(201,),
        )
    except DockerError:
        raise UpdateError("there is no earlier image to go back to") from None


def _exists(api: DockerApi, reference: str) -> bool:
    try:
        api.inspect_image(reference)
    except DockerError:
        return False
    return True


def _forget(api: DockerApi, reference: str) -> None:
    with contextlib.suppress(DockerError):
        api.request("DELETE", f"/images/{reference}", ok=(200, 404, 409))


def switch_needed(api: DockerApi, hostname: str, tag: str) -> bool:
    """True when `tag` names another image than the one this container runs."""
    try:
        own = api.inspect_container(hostname).get("Image")
        followed = api.inspect_image(tag).get("Id")
    except DockerError:
        return False
    return isinstance(own, str) and isinstance(followed, str) and own != followed


class UpdatePolicy:
    """When the service looks for an update, and what it does about what it finds. Used between
    two jobs only; every call ends in `False` (go on) or `True` (end now, the unit restarts)."""

    def __init__(
        self,
        api: Callable[[], DockerApi],
        environment: Mapping[str, str],
        *,
        auto_update: bool,
        hostname: Callable[[], str],
        now: Callable[[], float],
        jitter: Callable[[], float] = random.random,
        verify: Callable[[str], None] | None = None,
        logger: logging.Logger | None = None,
    ) -> None:
        self._api = api
        self._tag = environment.get(IMAGE_TAG_VARIABLE, "").strip()
        self._auto = auto_update
        self._hostname = hostname
        self._now = now
        self._jitter = jitter
        self._verify: Callable[[str], None] = verify or partial(
            cosign_verify, environment=environment
        )
        self._log = logger or logging.getLogger(__name__)
        self._next_check = now() + FIRST_CHECK_SECONDS

    @property
    def follows_a_tag(self) -> bool:
        """The unit follows `current` and restarts this container: it may end for an update."""
        return bool(self._tag)

    def switch_due(self, *, needed: bool = False) -> bool:
        """True when this container should end now. `needed`: the app requires a newer base, so
        look at once, whether or not automatic updates are on (the requirement is the app's)."""
        if not self._tag:
            return False
        api = self._api()
        if self._due(needed):
            self._check(api)
        if switch_needed(api, self._hostname(), self._tag):
            self._log.info("a new image is staged: ending so that the service starts it")
            return True
        return False

    def _due(self, needed: bool) -> bool:
        if needed:
            return True
        return self._auto and self._now() >= self._next_check

    def _check(self, api: DockerApi) -> None:
        self._next_check = self._now() + CHECK_INTERVAL_SECONDS * (
            1 + CHECK_JITTER * (self._jitter() - 0.5) * 2
        )
        try:
            running = release_of(own_image(api, self._hostname()))
            staged = stage(api, running_release=running, verify=self._verify)
        except UpdateError as error:
            self._log.warning("no update: %s", error)
            return
        if staged.outcome is Outcome.STAGED:
            self._log.info("release %d is staged (%s)", staged.release, staged.digest)
