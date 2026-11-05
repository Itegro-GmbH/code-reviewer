# SPDX-License-Identifier: LicenseRef-Proprietary

"""The snapshot channel between an Implementer job process and the job host (#839).

At the end of a turn the process has the engine's session as one gzip file
(`implementer/session_export.py`, up to 8 MiB). It holds neither the lease token nor the
Worker's credential, so the file goes over one more descriptor the host hands it, a third socket
pair beside the lease question and the steps (`RUNNER_SNAPSHOT_FD`), and only when the app lists
the feature `implementer_snapshot` (otherwise there is no channel and the process takes no
export).

One message per channel, fire and forget:

- process to host: a header line `S <size> <rawBytes> <sha256> <version>\n`, then exactly `<size>`
  bytes. `<size>` is the length of the gzip file, `<rawBytes>` the length of the JSON inside it,
  `<sha256>` the hex digest of the gzip file and `<version>` the engine's version.

The host reads it into memory (at most `MAX_SNAPSHOT_BYTES`), checks the digest and uploads it to
the app in parts of at most `CHUNK_BYTES` before the job's result is sent. The host never reads a path
from the process: a process that is compromised can only hand over bytes, which the app stores for
the job's own session and nothing else.
"""

import re
from dataclasses import dataclass
from typing import Final

SNAPSHOT_FD_VARIABLE: Final = "RUNNER_SNAPSHOT_FD"
# The feature of `GET /api/runners/v1/version` that says the snapshot call exists.
FEATURE_IMPLEMENTER_SNAPSHOT: Final = "implementer_snapshot"

# The plan's cap on a stored snapshot, gzipped. The app holds the same number.
MAX_SNAPSHOT_BYTES: Final = 8 * 1024 * 1024
# One request of the upload. Vercel's functions refuse a request body over 4.5 MB (413 before the
# app is called), so 3 MiB leaves room; an 8 MiB file is three parts.
CHUNK_BYTES: Final = 3 * 1024 * 1024
MAX_HEADER_BYTES: Final = 256
SNAPSHOT: Final = b"S"
_VERSION: Final = re.compile(r"[0-9A-Za-z][0-9A-Za-z._-]{0,31}")
_DIGEST: Final = re.compile(r"[0-9a-f]{64}")


@dataclass(frozen=True)
class SnapshotHeader:
    size: int
    raw_bytes: int
    sha256: str
    version: str


def parts_of(size: int) -> int:
    """How many requests a file of `size` bytes takes."""
    return max(1, -(-size // CHUNK_BYTES))


def header_line(header: SnapshotHeader) -> bytes:
    return b"%s %d %d %s %s\n" % (
        SNAPSHOT,
        header.size,
        header.raw_bytes,
        header.sha256.encode("ascii"),
        header.version.encode("ascii"),
    )


def parse_header(line: bytes) -> SnapshotHeader | None:
    """The header of a snapshot line, or None when it is not a well formed one."""
    if len(line) > MAX_HEADER_BYTES:
        return None
    parts = line.rstrip(b"\n").split(b" ")
    if len(parts) != 5 or parts[0] != SNAPSHOT:
        return None
    if not (parts[1].isdigit() and parts[2].isdigit()):
        return None
    try:
        digest, version = parts[3].decode("ascii"), parts[4].decode("ascii")
    except UnicodeDecodeError:
        return None
    size, raw = int(parts[1]), int(parts[2])
    if not 1 <= size <= MAX_SNAPSHOT_BYTES or raw < 1:
        return None
    if not _DIGEST.fullmatch(digest) or not _VERSION.fullmatch(version):
        return None
    return SnapshotHeader(size, raw, digest, version)
