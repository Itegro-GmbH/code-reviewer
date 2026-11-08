# SPDX-License-Identifier: LicenseRef-Proprietary

"""The certificate authority of one network door (#784): the certificates the agent's tools see
when they connect to a package registry through the door.

The door makes the authority when it starts, in memory: the **CA's private key is never written**
and never leaves the door's process (not logged, not sent anywhere), and the door ends with the
turn. The key of the certificates it signs touches the door's own `/tmp` (a tmpfs the agent cannot
reach) for the moment `ssl` takes to load it. Control gets the public certificate only (`ready.ca`)
and puts it into the agent's container, where the tools are told to trust it
(`agent_container.trust_environment`).

Two things keep a copy of the certificate from being worth anything to the agent: the authority is
**constrained to the registry domains** (an X.509 name constraint, so no client that honours it
accepts a certificate of this authority for any other name), and it is **valid for this turn
only** (the key is gone when the door is).

The certificate the door shows for a name has that name and no other, one key for all of them
(`server_context`; the contexts of the last `MAX_CONTEXTS` names are kept, so the door's memory
does not grow with the names a client asks for). The context refuses a client that sends no server
name or another one than the name of its `CONNECT`: the name the door checked, the name in the
certificate and the name the client asked for are one.
"""

import collections
import datetime
import ipaddress
import os
import ssl
import tempfile
import threading
from typing import Final

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

from ..network_rule import ascii_name
from .registries import REGISTRY_DOMAINS

CA_COMMON_NAME: Final = "Network door (this turn only)"
_BACKDATE: Final = datetime.timedelta(minutes=5)
MIN_LIFETIME_SECONDS: Final = 3600
# One `SSLContext` is about 120 KB; the door has 96 MB.
MAX_CONTEXTS: Final = 64
# No IP address is ever a name of this authority (the door refuses IP literals anyway).
_NO_ADDRESSES: Final = (
    x509.IPAddress(ipaddress.ip_network("0.0.0.0/0")),
    x509.IPAddress(ipaddress.ip_network("::/0")),
)


def _name(common_name: str) -> x509.Name:
    return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common_name)])


class Authority:
    """The CA and the certificates it signs. `ca_pem` is the public certificate."""

    def __init__(
        self,
        *,
        lifetime_seconds: float,
        domains: tuple[str, ...] = REGISTRY_DOMAINS,
        now: datetime.datetime | None = None,
    ) -> None:
        issued = now or datetime.datetime.now(datetime.UTC)
        self._not_before = issued - _BACKDATE
        self._not_after = issued + datetime.timedelta(
            seconds=max(float(lifetime_seconds), float(MIN_LIFETIME_SECONDS))
        )
        self._domains = domains
        self._ca_key = ec.generate_private_key(ec.SECP256R1())
        self._leaf_key = ec.generate_private_key(ec.SECP256R1())
        subject = _name(CA_COMMON_NAME)
        ca = (
            x509.CertificateBuilder()
            .subject_name(subject)
            .issuer_name(subject)
            .public_key(self._ca_key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(self._not_before)
            .not_valid_after(self._not_after)
            .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
            .add_extension(
                x509.KeyUsage(
                    digital_signature=False,
                    content_commitment=False,
                    key_encipherment=False,
                    data_encipherment=False,
                    key_agreement=False,
                    key_cert_sign=True,
                    crl_sign=False,
                    encipher_only=False,
                    decipher_only=False,
                ),
                critical=True,
            )
            .add_extension(
                x509.NameConstraints(
                    permitted_subtrees=[x509.DNSName(domain) for domain in domains],
                    excluded_subtrees=list(_NO_ADDRESSES),
                ),
                critical=True,
            )
            .add_extension(
                x509.SubjectKeyIdentifier.from_public_key(self._ca_key.public_key()),
                critical=False,
            )
            .sign(self._ca_key, hashes.SHA256())
        )
        self._ca = ca
        self.ca_pem: bytes = ca.public_bytes(serialization.Encoding.PEM)
        self._lock = threading.Lock()
        self._contexts: collections.OrderedDict[str, ssl.SSLContext] = collections.OrderedDict()

    def issue(self, name: str) -> bytes:
        """A PEM with the private key and the certificate of `name` (a server certificate for that
        name only). Raises `ValueError` for a name outside the domains the authority is limited to:
        a certificate the clients would refuse is not made."""
        if not any(name == d or name.endswith("." + d) for d in self._domains):
            raise ValueError("the name is not one of the authority's domains")
        certificate = (
            x509.CertificateBuilder()
            .subject_name(_name(name))
            .issuer_name(self._ca.subject)
            .public_key(self._leaf_key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(self._not_before)
            .not_valid_after(self._not_after)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.SubjectAlternativeName([x509.DNSName(name)]), critical=False)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .add_extension(
                x509.AuthorityKeyIdentifier.from_issuer_public_key(self._ca_key.public_key()),
                critical=False,
            )
            .sign(self._ca_key, hashes.SHA256())
        )
        key = self._leaf_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
        return key + certificate.public_bytes(serialization.Encoding.PEM)

    @property
    def context_count(self) -> int:
        with self._lock:
            return len(self._contexts)

    def server_context(self, name: str) -> ssl.SSLContext:
        """The TLS server context for connections that `CONNECT`ed to `name`: its certificate,
        HTTP/1.1 only, and a handshake that fails unless the client's server name is `name`."""
        with self._lock:
            known = self._contexts.get(name)
            if known is not None:
                self._contexts.move_to_end(name)
                return known
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.minimum_version = ssl.TLSVersion.TLSv1_2
            context.set_alpn_protocols(["http/1.1"])
            # `load_cert_chain` reads files only: the pair goes through a private file of the
            # door's own `/tmp` for the moment it takes to load and is removed at once.
            handle, path = tempfile.mkstemp(prefix="leaf-", suffix=".pem")
            try:
                with os.fdopen(handle, "wb") as written:
                    written.write(self.issue(name))
                context.load_cert_chain(path)
            finally:
                os.unlink(path)
            context.sni_callback = _require_name(name)
            self._contexts[name] = context
            while len(self._contexts) > MAX_CONTEXTS:
                self._contexts.popitem(last=False)
            return context


def _require_name(expected: str):
    def check(
        _socket: ssl.SSLObject, server_name: str | None, _context: ssl.SSLContext
    ) -> int | None:
        if server_name is None or ascii_name(server_name) != expected:
            return ssl.ALERT_DESCRIPTION_UNRECOGNIZED_NAME
        return None

    return check
