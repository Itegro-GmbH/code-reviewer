# SPDX-License-Identifier: LicenseRef-Proprietary

"""A release channel for the tests of the update (#855): a real ECDSA P-256 key, a manifest signed
with it, and the channel file that names both, so that the checks run against real signatures."""

import base64
import json
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

from code_reviewer_runner.factory_runner.update import ReleaseChannel, UpdateError

REPOSITORY = "registry.example/code-reviewer-factory-runner"
MANIFEST_URL = "https://releases.example/runner/manifest.json"
SIGNATURE_URL = "https://releases.example/runner/manifest.sig"
DIGEST = "sha256:" + "d" * 64


@dataclass
class Release:
    """The owner's side: a key, and what it signs."""

    release: int = 7
    digest: str = DIGEST
    repository: str = REPOSITORY
    key: ec.EllipticCurvePrivateKey = field(
        default_factory=lambda: ec.generate_private_key(ec.SECP256R1())
    )

    @property
    def public_key_der(self) -> bytes:
        return self.key.public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
        )

    def manifest(self) -> bytes:
        return json.dumps(
            {"repository": self.repository, "digest": self.digest, "release": self.release}
        ).encode()

    def signature(self, document: bytes | None = None) -> bytes:
        return self.key.sign(document or self.manifest(), ec.ECDSA(hashes.SHA256()))

    def channel(self) -> ReleaseChannel:
        return ReleaseChannel(self.repository, MANIFEST_URL, SIGNATURE_URL, self.public_key_der)

    def channel_document(self) -> dict[str, object]:
        return {
            "version": 1,
            "repository": self.repository,
            "manifestUrl": MANIFEST_URL,
            "signatureUrl": SIGNATURE_URL,
            "publicKey": base64.b64encode(self.public_key_der).decode(),
        }

    def served(self) -> dict[str, bytes]:
        """What the two addresses answer."""
        return {MANIFEST_URL: self.manifest(), SIGNATURE_URL: self.signature()}


def fetcher(served: dict[str, bytes]) -> Callable[[str], bytes]:
    def fetch(url: str) -> bytes:
        if url not in served:
            raise UpdateError(
                "the release manifest could not be fetched (is the network reachable?)"
            )
        return served[url]

    return fetch


def write_openssl_files(release: Release, folder: Path) -> None:
    """The same files as the owner makes them with `openssl` (docs/runner.md): the manifest, its
    signature and the channel, to check that `openssl` and `cryptography` agree."""
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "manifest.json").write_bytes(release.manifest())
    (folder / "manifest.sig").write_bytes(release.signature())
    (folder / "release-channel.json").write_text(json.dumps(release.channel_document(), indent=2))
