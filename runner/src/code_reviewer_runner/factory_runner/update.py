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

   A rollback remembers the release it left (`rejected-release` in the configuration volume): no
   release up to that number is taken again, by the service or by `factory-runner update`, until a
   higher one is announced. Without that, the service would take the same release back ten minutes
   after the operator had rolled it back. After a switch the service removes the digest references
   of the releases before `current` and `previous`, so that old images can be freed.
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
import os
import random
import re
import tempfile
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Any, Final

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import load_der_public_key

from code_reviewer_runner.factory_runner.config import home_directory
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
# The highest release an operator rolled back from, a whole number in a file of the configuration
# volume (the service and the command see the same volume).
REJECTED_FILE: Final = "rejected-release"
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
    # The channel announces a release that is newer than the running one but was rolled back.
    REJECTED = "rejected"
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


class HttpsRedirects(urllib.request.HTTPRedirectHandler):
    """A redirect is followed only to another https address."""

    def redirect_request(  # pyright: ignore[reportIncompatibleMethodOverride]
        self,
        req: urllib.request.Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> urllib.request.Request | None:
        if not newurl.lower().startswith("https://"):
            raise urllib.error.URLError("a release document does not redirect away from https")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def https_opener() -> urllib.request.OpenerDirector:
    """An opener that knows `https` and nothing else: no `file:`, `ftp:`, `data:`, plain `http:`."""
    opener = urllib.request.OpenerDirector()
    for handler in (
        urllib.request.HTTPSHandler(),
        HttpsRedirects(),
        urllib.request.UnknownHandler(),  # any other scheme is a `URLError`, not a silent None
        urllib.request.HTTPDefaultErrorHandler(),
        urllib.request.HTTPErrorProcessor(),
    ):
        opener.add_handler(handler)
    return opener


def fetch_https(url: str) -> bytes:
    """A small document from an `https` address. `UpdateError` for anything else."""
    if not url.startswith("https://"):
        raise UpdateError("a release document must come from an https address")
    try:
        with https_opener().open(url, timeout=FETCH_SECONDS) as answer:
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


def rejected_release(home: Path) -> int:
    """The highest release a rollback left, 0 when there was none or the file is unreadable."""
    try:
        raw = (home / REJECTED_FILE).read_text(encoding="ascii").strip()
    except (OSError, ValueError):
        return 0
    return int(raw) if raw.isascii() and raw.isdigit() else 0


def reject_release(home: Path, release: int) -> None:
    """Remember that `release` (and every one below it) is not to be taken again. Never lowers
    what is remembered. `OSError` when the file cannot be written."""
    release = max(release, rejected_release(home))
    home.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".rejected-", dir=home)
    try:
        with os.fdopen(descriptor, "w", encoding="ascii") as handle:
            handle.write(f"{release}\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, home / REJECTED_FILE)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(temporary)
        raise


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
    rejected: int = 0,
    fetch: Fetch = fetch_https,
    pull_seconds: float = PULL_SECONDS,
) -> Staged:
    """Prove the release the channel announces, and make it `current` when it is newer than
    `running_release` and than `rejected` (the highest release a rollback left). `UpdateError`
    for anything that stops that; nothing is tagged then, and an image that does not match its
    manifest is removed again."""
    manifest = verified_manifest(channel, fetch)
    if manifest.release <= running_release:
        return Staged(Outcome.UP_TO_DATE, running_release, manifest.digest)
    if manifest.release <= rejected:
        return Staged(Outcome.REJECTED, manifest.release, manifest.digest)
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


def rollback(api: DockerApi, home: Path) -> int:
    """Point `current` back at the image before the last update, and remember the release it
    leaves as rejected (`rejected_release`), so that no update takes it again. Returns that
    release. `UpdateError` without an earlier image, or when the memory cannot be written (then
    nothing is tagged: a rollback that would be undone is no rollback)."""
    try:
        api.inspect_image(PREVIOUS_REFERENCE)
    except DockerError:
        raise UpdateError("there is no earlier image to go back to") from None
    left = release_of(_described(api, CURRENT_REFERENCE))
    try:
        if left > 0:
            reject_release(home, left)
    except OSError:
        raise UpdateError(
            "the rollback cannot be remembered (the configuration folder is not writable)"
        ) from None
    try:
        api.request(
            "POST",
            f"/images/{PREVIOUS_REFERENCE}/tag?repo={CURRENT_REPOSITORY}&tag={CURRENT_TAG}",
            ok=(201,),
        )
    except DockerError:
        raise UpdateError("there is no earlier image to go back to") from None
    return left


def _described(api: DockerApi, reference: str) -> dict[str, object]:
    try:
        return dict(api.inspect_image(reference))
    except DockerError:
        return {}


def prune_references(api: DockerApi, repository: str) -> list[str]:
    """Remove the digest references of `repository` that neither `current` nor `previous` is: every
    release the installer or the service pulled by its digest leaves one, and while it stays the
    daemon cannot free the image after the tags have moved on. Returns the references removed; a
    daemon that does not answer removes nothing."""
    kept: set[str] = set()
    for reference in (CURRENT_REFERENCE, PREVIOUS_REFERENCE):
        kept.update(_digests(_described(api, reference)))
    try:
        listed = api.request("GET", "/images/json?digests=1")
    except DockerError:
        return []
    removed: list[str] = []
    for item in listed if isinstance(listed, list) else []:  # pyright: ignore[reportUnknownVariableType]
        entry = as_object(item)  # pyright: ignore[reportUnknownArgumentType]
        for reference in _digests(entry or {}):
            if reference in kept or not reference.startswith(f"{repository}@"):
                continue
            _forget(api, reference)
            removed.append(reference)
    return removed


def _digests(image: Mapping[str, object]) -> list[str]:
    raw = image.get("RepoDigests")
    return [value for value in raw if isinstance(value, str)] if isinstance(raw, list) else []  # pyright: ignore[reportUnknownVariableType]


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
        home: Path | None = None,
        logger: logging.Logger | None = None,
    ) -> None:
        self._api = api
        self._tag = environment.get(IMAGE_TAG_VARIABLE, "").strip()
        self._home = home or home_directory(environment)
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
            staged = stage(
                api,
                channel,
                running_release=running,
                rejected=rejected_release(self._home),
                fetch=self._fetch,
            )
        except UpdateError as error:
            self._log.warning("no update: %s", error)
            return
        if staged.outcome is Outcome.STAGED:
            self._log.info("release %d is staged (%s)", staged.release, staged.digest)
        elif staged.outcome is Outcome.REJECTED:
            self._log.info(
                "release %d was rolled back by the operator: waiting for a higher one",
                staged.release,
            )

    def tidy_references(self) -> None:
        """At the start of the service: drop the digest references of old releases (see
        `prune_references`). Nothing for a runner that follows no tag or has no channel."""
        channel = self._channel() if self._tag else None
        if channel is None:
            return
        try:
            removed = prune_references(self._api(), channel.repository)
        except Exception:  # housekeeping must never stop the service
            self._log.warning("the references of old releases could not be removed")
            return
        if removed:
            self._log.info("removed the references of %d old release(s)", len(removed))
