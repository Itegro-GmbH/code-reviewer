# SPDX-License-Identifier: LicenseRef-Proprietary

"""Fetches a pinned toolchain release (git, node, pnpm) and unpacks it into a directory (#761).

The Implementer's agent builds repositories inside the Worker container, so the image carries git,
Node.js and pnpm next to the engines. Each is named by an exact release in `runner/<name>-pin.json`
(version, source commit, per platform the release asset with its size and SHA-256), the same shape
as `opencode-pin.json` and `ripgrep-pin.json`, and checked the same way: the download is accepted
only when its size and SHA-256 equal the pin, before anything is unpacked.

    python scripts/fetch_toolchain.py --component git|node|pnpm --dest DIR

The archive is unpacked without its top directory into DIR. Every member must stay inside DIR (no
absolute or `..` path, no link that points out, no hard link or device), the unpacked size is
bounded, and a pinned executable (`member`, `executableSha256`) must be the exact one. The tree
appears under DIR only when all of it is verified; a failed run leaves nothing behind. Only
linux-x64 is pinned: on another platform the script fails the build. Nothing at run time downloads
anything.

Prints DIR. The image build runs it in its own stage (the one step with the internet besides the
dependency install and the other pins).
"""

import argparse
import os
import posixpath
import shutil
import sys
import tarfile
import tempfile
from collections.abc import Sequence
from pathlib import Path, PurePosixPath
from typing import Any

from fetch_opencode import (
    ATTEMPTS,
    CHUNK,
    Download,
    NoPinForPlatform,
    PinError,
    digest_of,
    https_download,
    load_pin,
    platform_key,
    verify_archive,
)

COMPONENTS = ("git", "node", "pnpm")
MARKER = ".pinned-sha256"
# The biggest component unpacks to about 200 MB; a bigger tree than this is not the pinned release.
MAX_UNPACKED_BYTES = 1 << 30


def pin_file(component: str) -> Path:
    return Path(__file__).resolve().parents[1] / f"{component}-pin.json"


def entry_for(pin: dict[str, Any], key: str) -> dict[str, Any]:
    platforms: dict[str, Any] = pin.get("platforms") or {}
    entry: Any = platforms.get(key)
    if not isinstance(entry, dict):
        raise NoPinForPlatform(
            f"there is no pinned {pin.get('name', 'toolchain')} artifact for {key}"
        )
    return entry  # pyright: ignore[reportUnknownVariableType]


def inner_parts(name: str) -> tuple[str, ...]:
    """The path of a member below the top directory; an error when it can leave the tree."""
    if name.startswith("/"):
        raise PinError("a member has an absolute path, outside the destination")
    parts = PurePosixPath(name).parts
    if ".." in parts:
        raise PinError("a member path leads outside the destination")
    return parts[1:]


def inside(tree: Path, path: Path) -> bool:
    """Whether `path` is in `tree` once every link on the way is followed (it need not exist)."""
    root = os.path.realpath(tree)
    return os.path.commonpath([root, os.path.realpath(path)]) == root


def unpack(archive: Path, tree: Path) -> None:
    """Write every member without its top directory into `tree`, with a bounded copy.

    The check is made on the disk, not on the names: a link that is inside the tree by its text can
    lead out of it through the links unpacked before it (`d/up -> ..`, then `esc -> d/up/..`), and a
    file below such a link would be written outside. So every member's parent and every link's
    target are resolved for real, and a file is never written onto a link.
    """
    written = 0
    with tarfile.open(archive, "r:*") as bundle:
        for member in bundle:
            rest = inner_parts(member.name)
            if not rest:
                continue
            target = tree.joinpath(*rest)
            if not inside(tree, target.parent) or target.is_symlink():
                raise PinError(
                    "a member would be written outside the destination or through a link"
                )
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif member.issym():
                if posixpath.isabs(member.linkname):
                    raise PinError("a link points outside the destination")
                resolved = posixpath.normpath(posixpath.join(*rest[:-1], member.linkname))
                if resolved == ".." or resolved.startswith("../"):
                    raise PinError("a link points outside the destination")
                target.parent.mkdir(parents=True, exist_ok=True)
                if not inside(tree, target.parent / member.linkname):
                    raise PinError("a link leads outside the destination")
                target.symlink_to(member.linkname)
            elif member.isreg():
                source = bundle.extractfile(member)
                if source is None:
                    raise PinError("an archive member cannot be read")
                target.parent.mkdir(parents=True, exist_ok=True)
                with source, target.open("wb") as stream:
                    while chunk := source.read(CHUNK):
                        written += len(chunk)
                        if written > MAX_UNPACKED_BYTES:
                            raise PinError("the archive unpacks to more than the allowed size")
                        stream.write(chunk)
                target.chmod(0o755 if member.mode & 0o111 else 0o644)
            else:
                raise PinError(
                    "the archive holds a member that is neither file, directory nor link"
                )


def verify_executable(tree: Path, entry: dict[str, Any]) -> None:
    if "member" not in entry:
        return
    executable = tree.joinpath(*inner_parts(entry["member"]))
    if (
        not executable.is_file()
        or executable.stat().st_size != entry["executableBytes"]
        or digest_of(executable) != entry["executableSha256"]
    ):
        raise PinError("the executable is not the pinned executable")


def install(
    dest: Path,
    *,
    pin: dict[str, Any],
    key: str | None = None,
    download: Download = https_download,
) -> Path:
    """Unpack the pinned release into `dest` and return it. Idempotent: a verified tree stays."""
    entry = entry_for(pin, key or platform_key())
    marker = dest / MARKER
    if marker.is_file() and marker.read_text(encoding="utf-8") == entry["archiveSha256"]:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    # A private directory next to the destination: nothing half verified is ever at the final path.
    work = Path(tempfile.mkdtemp(prefix=".toolchain-fetch-", dir=dest.parent))
    try:
        archive = work / entry["asset"]
        for attempt in range(1, ATTEMPTS + 1):
            try:
                download(entry["url"], archive, entry["archiveBytes"])
                break
            except OSError:
                if attempt == ATTEMPTS:
                    raise
        verify_archive(archive, entry)
        tree = work / "tree"
        tree.mkdir()
        unpack(archive, tree)
        verify_executable(tree, entry)
        (tree / MARKER).write_text(entry["archiveSha256"], encoding="utf-8")
        if dest.exists():
            shutil.rmtree(dest)
        os.replace(tree, dest)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return dest


def main(argv: Sequence[str], *, download: Download = https_download) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--component", choices=COMPONENTS, required=True)
    parser.add_argument("--dest", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        path = install(args.dest, pin=load_pin(pin_file(args.component)), download=download)
    except NoPinForPlatform:
        sys.stderr.write(
            f"cannot install the pinned {args.component}: "
            f"there is no pinned artifact for {platform_key()}\n"
        )
        return 1
    except (PinError, OSError, tarfile.TarError) as error:
        sys.stderr.write(f"cannot install the pinned {args.component}: {error}\n")
        return 1
    sys.stdout.write(f"{path}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
