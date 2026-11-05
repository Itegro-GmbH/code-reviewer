# SPDX-License-Identifier: LicenseRef-Proprietary

"""Signed updates of the runner's own image (#855, R2; plan decision 9).

A runner updates itself between jobs, or on the device (`factory-runner update`), never from the
app.
The unit that the installer writes starts the container from the local tag `factory-runner:current`
and restarts it when it ends. An update is therefore two separate acts:

1. **Stage** (`stage`): find the newest release, prove it is ours, and point the local tag at it.
   The release is named by a **signed manifest**, a small JSON file
   `{"repository": ..., "digest": "sha256:...", "release": N}`, and its detached signature (ECDSA
   over
   P-256 with SHA-256, DER). Where they are and the public key that proves them are the **release
   channel**, the file `runner/release-channel.json`, which is baked into the image
   (`/opt/code-reviewer/release-channel.json`): a setting on the device cannot redirect an update.
   The
   runner needs no extra program for this: the check is the `cryptography` library the runner
   already
   has, and the installer does the same with `openssl`. Only when the manifest verifies is the image
   pulled **by the digest it names** (the daemon checks the content against it), and its own label
   `code-reviewer.runner.release` must be the manifest's number. A release number that is not higher
   than the running one's is not taken, so an old signed manifest that somebody serves again is no
   way
   back. Only then is the digest named `factory-runner:current` (the one before it `previous`, for
   `--rollback`); an image that does not match is removed and nothing changes.
2. **Apply** (`switch_needed`): when the image behind `current` is another one than the one this
   container runs, the service ends (exit code 10) **between jobs**, never during one, and the unit
   starts it again from the new image. `factory-runner update` only stages; a running job is never
   touched.

The release channel is **empty until the owner fills it** (there is no release pipeline in this
repository: `docs/runner.md`, "Updates", says what it has to make). A runner with an empty channel
does not look for updates and says so; `factory-runner update` ends with exit code 1 and the reason.

The service does both on its own (`UpdatePolicy`): a check some minutes after the start and then
every six hours, at the moment between two jobs; at once when the app answers a claim with "update
needed" (a base below the minimum version). The service follows the tag only when the unit says
so (`FACTORY_RUNNER_IMAGE_TAG`), so a runner that somebody started by hand (`docker run` without a
supervisor) never ends itself for an update. `run --once` never updates.
"""

import base64
import binascii
import contextlib
import json
import logging
import random
import re
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Final

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import load_der_public_key

from code_reviewer_runner.implementer.docker_api import DockerApi, DockerError
from code_reviewer_runner.job_loop.jsonvalues import as_object

CHANNEL_FILE: Final = Path("/opt/code-reviewer/release-channel.json")
CURRENT_REPOSITORY: Final = "factory-runner"
CURRENT_TAG: Final = "current"
PREVIOUS_TAG: Final = "previous"
CURRENT_REFERENCE: Final = f"{CURRENT_REPOSITORY}:{CURRENT_TAG}"
PREVIOUS_REFERENCE: Final = f"{CURRENT_REPOSITORY}:{PREVIOUS_TAG}"
# The unit sets it to `CURRENT_REFERENCE`: the tag this container follows.
IMAGE_TAG_VARIABLE: Final = "FACTORY_RUNNER_IMAGE_TAG"
# The number of a release, a whole number that grows with every release.
RELEASE_LABEL: Final = "code-reviewer.runner.release"
FETCH_SECONDS: Final = 60.0
# A manifest and a signature are a few hundred bytes; nothing bigger is read.
MAX_DOCUMENT_BYTES: Final = 64 * 1024
PULL_SECONDS: Final = 1800.0
_DIGEST: Final = re.compile(r"sha256:[0-9a-f]{64}")
_REPOSITORY: Final = re.compile(r"[a-z0-9][a-z0-9._/-]{0,200}")

FIRST_CHECK_SECONDS: Final = 600.0
CHECK_INTERVAL_SECONDS: Final = 6 * 3600.0
CHECK_JITTER: Final = 0.1

Fetch = Callable[[str], bytes]


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


@dataclass(frozen=True)
class ReleaseChannel:
    """Where releases are announced and what proves them: the file `release-channel.json`."""

    repository: str
    manifest_url: str
    signature_url: str
    public_key: bytes  # the DER of the SubjectPublicKeyInfo


@dataclass(frozen=True)
class Manifest:
    repository: str
    digest: str
    release: int


def load_channel(path: Path = CHANNEL_FILE) -> ReleaseChannel | None:
    """The release channel of this image, None when it is empty (the owner has not filled it) or
    cannot be read: a runner without one does not update by itself."""
    try:
        document = as_object(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return None
    if document is None:
        return None
    repository, manifest, signature, key = (
        document.get(name) for name in ("repository", "manifestUrl", "signatureUrl", "publicKey")
    )
    if not all(
        isinstance(value, str) and value for value in (repository, manifest, signature, key)
    ):
        return None
    assert isinstance(repository, str) and isinstance(manifest, str)
    assert isinstance(signature, str) and isinstance(key, str)
    try:
        public_key = base64.b64decode(key, validate=True)
    except (binascii.Error, ValueError):
        return None
    if not _REPOSITORY.fullmatch(repository) or not (
        manifest.startswith("https://") and signature.startswith("https://")
    ):
        return None
    return ReleaseChannel(repository, manifest, signature, public_key)


def fetch_https(url: str) -> bytes:
    """A small document from an `https` address. `UpdateError` for anything else."""
    if not url.startswith("https://"):
        raise UpdateError("a release document must come from an https address")
    try:
        with urllib.request.urlopen(url, timeout=FETCH_SECONDS) as answer:
            data: bytes = answer.read(MAX_DOCUMENT_BYTES + 1)
    except (urllib.error.URLError, OSError, ValueError):
        raise UpdateError(
            "the release manifest could not be fetched (is the network reachable?)"
        ) from None
    if len(data) > MAX_DOCUMENT_BYTES:
        raise UpdateError("a release document is larger than it can be")
    return data


def verified_manifest(channel: ReleaseChannel, fetch: Fetch = fetch_https) -> Manifest:
    """Fetch the manifest and its signature and prove them with the channel's key. `UpdateError`
    unless the signature is valid and the manifest says what a release says."""
    document = fetch(channel.manifest_url)
    signature = fetch(channel.signature_url)
    try:
        key = load_der_public_key(channel.public_key)
        if not isinstance(key, ec.EllipticCurvePublicKey) or not isinstance(
            key.curve, ec.SECP256R1
        ):
            raise UpdateError("the release channel's key is not an ECDSA P-256 key")
        key.verify(signature, document, ec.ECDSA(hashes.SHA256()))
    except InvalidSignature:
        raise UpdateError(
            "the signature of the release manifest is not valid: not our release"
        ) from None
    except ValueError:
        raise UpdateError("the release channel's key cannot be read") from None
    try:
        fields = as_object(json.loads(document))
    except ValueError:
        fields = None
    repository = None if fields is None else fields.get("repository")
    digest = None if fields is None else fields.get("digest")
    release = None if fields is None else fields.get("release")
    if (
        repository != channel.repository
        or not isinstance(digest, str)
        or not _DIGEST.fullmatch(digest)
        or not isinstance(release, int)
        or isinstance(release, bool)
        or release < 1
    ):
        raise UpdateError("the release manifest is not a manifest of this channel")
    return Manifest(channel.repository, digest, release)


def release_of(image: Mapping[str, object]) -> int:
    labels = as_object((as_object(image.get("Config")) or {}).get("Labels")) or {}
    raw = labels.get(RELEASE_LABEL)
    return int(raw) if isinstance(raw, str) and raw.isascii() and raw.isdigit() else 0


def own_image(api: DockerApi, hostname: str) -> dict[str, object]:
    """The image this container runs, as the daemon describes it."""
    try:
        container = api.inspect_container(hostname)
        return dict(api.inspect_image(str(container.get("Image", ""))))
    except DockerError as error:
        raise UpdateError(f"the daemon cannot say which image this runner runs ({error})") from None


def stage(
    api: DockerApi,
    channel: ReleaseChannel,
    *,
    running_release: int,
    fetch: Fetch = fetch_https,
    pull_seconds: float = PULL_SECONDS,
) -> Staged:
    """Prove the release the channel announces, and make it `current` when it is newer than
    `running_release`. `UpdateError` for anything that stops that; nothing is tagged then, and an
    image that does not match its manifest is removed again."""
    manifest = verified_manifest(channel, fetch)
    if manifest.release <= running_release:
        return Staged(Outcome.UP_TO_DATE, running_release, manifest.digest)
    by_digest = f"{manifest.repository}@{manifest.digest}"
    try:
        api.request(
            "POST",
            f"/images/create?fromImage={manifest.repository}&tag={manifest.digest}",
            ok=(200,),
            timeout=pull_seconds,
        )
        image = dict(api.inspect_image(by_digest))
    except DockerError as error:
        raise UpdateError(f"the release image cannot be pulled ({error})") from None
    if release_of(image) != manifest.release:
        _forget(api, by_digest)
        raise UpdateError("the image is not the release its manifest names")
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
    return Staged(Outcome.STAGED, manifest.release, manifest.digest)


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
        channel: Callable[[], ReleaseChannel | None] = load_channel,
        fetch: Fetch = fetch_https,
        logger: logging.Logger | None = None,
    ) -> None:
        self._api = api
        self._tag = environment.get(IMAGE_TAG_VARIABLE, "").strip()
        self._auto = auto_update
        self._hostname = hostname
        self._now = now
        self._jitter = jitter
        self._channel = channel
        self._fetch = fetch
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
        channel = self._channel()
        if channel is None:
            self._log.info("no update: this image has no release channel (the owner fills it)")
            return
        try:
            running = release_of(own_image(api, self._hostname()))
            staged = stage(api, channel, running_release=running, fetch=self._fetch)
        except UpdateError as error:
            self._log.warning("no update: %s", error)
            return
        if staged.outcome is Outcome.STAGED:
            self._log.info("release %d is staged (%s)", staged.release, staged.digest)
