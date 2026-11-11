# SPDX-License-Identifier: LicenseRef-Proprietary

"""The test CA of the whole-job lane (#999; not a test file).

A job clones its repository over https and calls its model provider over https, with the closed
environment of the Worker, which trusts what its image trusts. The lane has no public git host and
no provider, so its fakes (a git endpoint and a provider) answer with certificates of a CA that
exists for one run, and **only a lane-only copy of the Worker image trusts it** (the workflow
derives it: `FROM` the release's Worker image, the CA appended to the image's bundle, a data disk
made from that copy and used by this lane alone). The release's image and data disk are never
touched; the CA's key is made in the run, lives on the runner and is gone with it.

The CA may sign for **one DNS domain only** (a critical name constraint: that domain is the one
permitted subtree, every IPv4 and IPv6 address is excluded): even in the lane's image it could not
vouch for any other name, nor for an IP address. Nothing here is a secret worth keeping, and
nothing here is ever committed (`*.key` and `*.pem` are ignored by the repository).

    python lane_pki.py ca <directory>        makes `lane-ca.crt` and `lane-ca.key` there"""

import datetime
import ipaddress
import ssl
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

# The one domain the CA signs for. `example.com` is reserved (RFC 2606) and has no host below it
# that resolves: a lane that failed open would find nothing there.
LANE_DOMAIN: Final = "lane.example.com"
CA_CERTIFICATE: Final = "lane-ca.crt"
CA_KEY: Final = "lane-ca.key"
CA_NAME: Final = "code-reviewer KVM lane CA (test only)"
CA_DAYS: Final = 3
LEAF_DAYS: Final = 2


@dataclass(frozen=True)
class Ca:
    certificate: x509.Certificate
    key: ec.EllipticCurvePrivateKey
    directory: Path

    @property
    def certificate_path(self) -> Path:
        return self.directory / CA_CERTIFICATE


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.UTC) - datetime.timedelta(minutes=5)


def create_ca(directory: Path, domain: str = LANE_DOMAIN) -> Ca:
    """Make the CA, restricted to `domain` and what is below it, and write it into `directory`."""
    directory.mkdir(parents=True, exist_ok=True)
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, CA_NAME)])
    begin = _now()
    certificate = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(begin)
        .not_valid_after(begin + datetime.timedelta(days=CA_DAYS))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=False,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=True,
                crl_sign=True,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.NameConstraints(
                permitted_subtrees=[x509.DNSName(domain)],
                excluded_subtrees=[
                    x509.IPAddress(ipaddress.ip_network("0.0.0.0/0")),
                    x509.IPAddress(ipaddress.ip_network("::/0")),
                ],
            ),
            critical=True,
        )
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        .sign(key, hashes.SHA256())
    )
    (directory / CA_CERTIFICATE).write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    key_file = directory / CA_KEY
    key_file.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    key_file.chmod(0o600)
    return Ca(certificate, key, directory)


def load_ca(directory: Path) -> Ca:
    certificate = x509.load_pem_x509_certificate((directory / CA_CERTIFICATE).read_bytes())
    key = serialization.load_pem_private_key((directory / CA_KEY).read_bytes(), password=None)
    assert isinstance(key, ec.EllipticCurvePrivateKey)
    return Ca(certificate, key, directory)


def issue(ca: Ca, names: list[str], directory: Path) -> tuple[Path, Path]:
    """A server certificate for `names` (DNS names only: no address is ever a name here), signed by
    the CA; the files of the certificate chain and of the key, in `directory`."""
    directory.mkdir(parents=True, exist_ok=True)
    key = ec.generate_private_key(ec.SECP256R1())
    begin = _now()
    certificate = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, names[0])]))
        .issuer_name(ca.certificate.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(begin)
        .not_valid_after(begin + datetime.timedelta(days=LEAF_DAYS))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .add_extension(
            x509.SubjectAlternativeName([x509.DNSName(name) for name in names]), critical=False
        )
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(ca.key.public_key()),
            critical=False,
        )
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        .sign(ca.key, hashes.SHA256())
    )
    stem = names[0]
    chain = directory / f"{stem}.crt"
    chain.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    private = directory / f"{stem}.key"
    private.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    private.chmod(0o600)
    return chain, private


def server_context(ca: Ca, names: list[str], directory: Path) -> ssl.SSLContext:
    """What a fake server wraps its socket with: the certificate for `names`."""
    chain, private = issue(ca, names, directory)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(chain, private)
    return context


def main(arguments: list[str]) -> int:
    if len(arguments) != 2 or arguments[0] != "ca":
        print("usage: lane_pki.py ca <directory>", file=sys.stderr)
        return 2
    ca = create_ca(Path(arguments[1]))
    print(ca.certificate_path)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
