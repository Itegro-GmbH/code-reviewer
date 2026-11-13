# SPDX-License-Identifier: LicenseRef-Proprietary

"""Builds the program tarball of the Factory-Runner (#1002) and the manifest that describes it.

build_program.py --release N --commit SHA --out DIR [--cache DIR] [--root REPO] [--epoch SECONDS]

writes `DIR/factory-runner-N-x86_64.tar.zst` and `DIR/manifest.json` (unsigned: the release job
signs it). The format is the one `runner/install/install.sh` takes and docs/runner.md ("Updates")
names: a tar in zstd of a relocatable tree, `bin/factory-runner`, `bin/firecracker`,
`share/outer-wall.nft`, `libexec/host.sh` and a standalone Python with the program in it.

What goes in, and why:

* a pinned standalone CPython (`pins.env`): the machine needs no Python;
* the `code_reviewer_runner` package as the tagged commit has it (`git ls-files`), not a wheel: the
  wheel build asks for an unpinned hatchling, so two builds of one commit could differ. A minimal
  `.dist-info` makes `importlib.metadata` answer the version, which `factory-runner --version`
  prints;
* `cryptography` and what it needs (`cffi`, `pycparser`), the one third-party import of the host
  program (the dispatcher's proxy makes certificates); version and sha256 of each wheel come from
  `runner/uv.lock`. The Worker's own dependencies (PR-Agent and the rest) run in the VM's image,
  never on the host, so they are not here: a test holds the host program to the standard library
  plus these three;
* the pinned Firecracker of `docker/vm/pins.env` with its licence texts.

The tar inside is reproducible: the same commit, release number and pins give the same bytes
(sorted names, owner root, one fixed mtime, normalised modes, byte code compiled with a fixed hash
seed into hash-checked `.pyc` files). The tarball is that tar in `zstd -19` on one thread, which
gives the same bytes for the same `zstd` version only (another version may encode it differently):
compare the uncompressed tar (`zstd -dc <tarball> | sha256sum`) to check a rebuild against a
release.
Only the standard library runs here, besides `zstd` and the bundled Python itself.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import tomllib
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, cast

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]

ARCH = "x86_64"
PYTHON_MINOR = "3.13"
# Where a release is unpacked on a machine (install.sh: /opt/code-reviewer/releases/<N>): compiled
# into the byte code, so that a traceback names the path of the machine, not of the build.
INSTALL_ROOT = "/opt/code-reviewer/releases"
COMMAND_MODULE = "code_reviewer_runner.factory_runner.cli"
ENTRY_POINT = f"from {COMMAND_MODULE} import entry_point; entry_point()"

# The third-party packages the host program imports, and nothing else (the closure of `cryptography`
# in uv.lock). A new one is a decision: it grows a tarball every customer downloads and every
# update.
RUNTIME_PACKAGES = ("cryptography", "cffi", "pycparser")
PACKAGE_DIR = "runner/src/code_reviewer_runner"

# The names `install.sh` accepts in a tarball (see `stage_program`): nothing else is listed, so
# nothing else may be in it.
INSTALLER_BAD_NAME = re.compile(r"(^/|(^|/)\.\.(/|$)|[^A-Za-z0-9._+/@=-])")
REQUIRED_PARTS = (
    "bin/factory-runner",
    "bin/firecracker",
    "libexec/host.sh",
    "share/outer-wall.nft",
)

# Taken out of the standalone Python: what the program never runs and what would only add weight and
# attack surface.
PYTHON_EXCLUDED = (
    "include",
    "share",
    "lib/pkgconfig",
    f"lib/python{PYTHON_MINOR}/test",
    f"lib/python{PYTHON_MINOR}/idlelib",
    f"lib/python{PYTHON_MINOR}/tkinter",
    f"lib/python{PYTHON_MINOR}/turtledemo",
    f"lib/python{PYTHON_MINOR}/turtle.py",
    f"lib/python{PYTHON_MINOR}/ensurepip",
    f"lib/python{PYTHON_MINOR}/config-{PYTHON_MINOR}-x86_64-linux-gnu",
    f"lib/python{PYTHON_MINOR}/site-packages",
    "bin/idle3",
    f"bin/idle{PYTHON_MINOR}",
    "bin/pip",
    "bin/pip3",
    f"bin/pip{PYTHON_MINOR}",
    "bin/pydoc3",
    f"bin/pydoc{PYTHON_MINOR}",
    "bin/python3-config",
    f"bin/python{PYTHON_MINOR}-config",
)
PYTHON_EXCLUDED_PATTERNS = (
    # the interpreter binary has libpython built in: nothing links the shared one
    re.compile(r"^lib/libpython"),
    re.compile(r"^lib/(tcl|tk|itcl|libtcl|libtk|thread)"),  # Tcl/Tk, for tkinter
    re.compile(rf"^lib/python{PYTHON_MINOR}/lib-dynload/_(tkinter|test)"),
)

LAUNCHER = f"""\
#!/bin/sh
# SPDX-License-Identifier: LicenseRef-Proprietary
#
# The command of the Factory-Runner (docs/runner.md, "Updates"). It finds its own directory (so a
# release can be moved and a link to it followed) and starts the Python bundled with it. `-I`
# (isolated): no PYTHON* variable, no user site and no current directory is read. `-B`: the release
# is read-only and nothing is written next to it.
here="$(dirname "$(readlink -f "$0")")"
root="$(dirname "$here")"
exec "$root/python/bin/python3" -I -B -c '{ENTRY_POINT}' "$@"
"""


class BuildError(Exception):
    """A build that must not produce a release."""


# -- pins -----------------------------------------------------------------------------------------


def read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip()
    return values


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def fetch_pinned(url: str, sha256: str, destination: Path) -> Path:
    """Downloads `url` unless `destination` already has the checksum; always verifies."""
    if destination.is_file() and sha256_file(destination) == sha256:
        return destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_name(destination.name + ".part")
    request = urllib.request.Request(url, headers={"User-Agent": "code-reviewer-release"})
    with urllib.request.urlopen(request, timeout=300) as response, partial.open("wb") as stream:
        shutil.copyfileobj(response, stream)
    got = sha256_file(partial)
    if got != sha256:
        partial.unlink()
        raise BuildError(f"CHECKSUM MISMATCH for {url}: pinned {sha256}, got {got}")
    partial.replace(destination)
    return destination


# -- the Python packages, from uv.lock -------------------------------------------------------------


@dataclass(frozen=True)
class Wheel:
    name: str
    version: str
    filename: str
    url: str
    sha256: str
    glibc: tuple[int, int]


_MANYLINUX_ALIASES = {"manylinux1": (2, 5), "manylinux2010": (2, 12), "manylinux2014": (2, 17)}


def _glibc_of(platform_tag: str) -> tuple[int, int] | None:
    """The glibc a platform tag asks for: (0, 0) for `any`, None for a tag not of this machine."""
    if platform_tag == "any":
        return (0, 0)
    match = re.fullmatch(r"manylinux_(\d+)_(\d+)_x86_64", platform_tag)
    if match:
        return (int(match.group(1)), int(match.group(2)))
    for alias, version in _MANYLINUX_ALIASES.items():
        if platform_tag == f"{alias}_x86_64":
            return version
    return None


def _python_compatible(python_tag: str, abi_tag: str) -> bool:
    minor = int(PYTHON_MINOR.split(".")[1])
    if python_tag == f"cp3{minor}" and abi_tag == f"cp3{minor}":
        return True
    if abi_tag == "abi3" and (m := re.fullmatch(r"cp3(\d+)", python_tag)):
        return int(m.group(1)) <= minor
    return abi_tag == "none" and python_tag in ("py3", f"py3{minor}")


def pick_wheel(name: str, version: str, urls_and_hashes: list[tuple[str, str]]) -> Wheel:
    """The wheel for CPython 3.13 on x86_64 glibc that needs the OLDEST glibc (it runs on most
    machines)."""
    candidates: list[Wheel] = []
    for url, digest in urls_and_hashes:
        filename = url.rsplit("/", 1)[1]
        if not filename.endswith(".whl"):
            continue
        python_tag, abi_tag, platform = filename[:-4].split("-")[-3:]
        glibcs = [g for tag in platform.split(".") if (g := _glibc_of(tag)) is not None]
        if not glibcs or not any(
            _python_compatible(p, a) for p in python_tag.split(".") for a in abi_tag.split(".")
        ):
            continue
        candidates.append(
            Wheel(name, version, filename, url, digest.removeprefix("sha256:"), min(glibcs))
        )
    if not candidates:
        raise BuildError(
            f"uv.lock has no wheel of {name} {version} for CPython {PYTHON_MINOR} on x86_64 glibc"
        )
    return sorted(candidates, key=lambda w: (w.glibc, w.filename))[0]


def lock_packages(lock: dict[str, object]) -> dict[str, dict[str, Any]]:
    # Any: a TOML document, whose shape is uv.lock's (per package: name, version, dependencies,
    # wheels).
    return {p["name"]: p for p in cast(list[dict[str, Any]], lock["package"])}


def lock_closure(lock: dict[str, object], root: str) -> list[str]:
    """`root` and every package it depends on, by uv.lock's dependency lists (markers are not
    evaluated: a conditional dependency is counted, which only makes the check stricter)."""
    packages = lock_packages(lock)
    seen: list[str] = []
    todo = [root]
    while todo:
        name = todo.pop()
        if name in seen:
            continue
        seen.append(name)
        todo.extend(d["name"] for d in packages[name].get("dependencies", []))
    return sorted(seen)


def runtime_wheels(lock_path: Path) -> list[Wheel]:
    lock = tomllib.loads(lock_path.read_text())
    closure = lock_closure(lock, RUNTIME_PACKAGES[0])
    if closure != sorted(RUNTIME_PACKAGES):
        raise BuildError(
            f"the dependencies of {RUNTIME_PACKAGES[0]} in uv.lock are {closure}, "
            f"not {sorted(RUNTIME_PACKAGES)}: a new package in the host program is a decision "
            "(build_program.py, RUNTIME_PACKAGES)"
        )
    packages = lock_packages(lock)
    return [
        pick_wheel(
            name,
            packages[name]["version"],
            [(w["url"], w["hash"]) for w in packages[name]["wheels"]],
        )
        for name in sorted(RUNTIME_PACKAGES)
    ]


def unpack_wheel(wheel: Path, site_packages: Path) -> None:
    """A wheel whose root is purelib/platlib is its files under site-packages. One with a `.data`
    directory (scripts, headers) needs an installer's decisions: none of ours has one, and a build
    says so if one gets it."""
    with zipfile.ZipFile(wheel) as archive:
        for member in archive.infolist():
            name = member.filename
            if member.is_dir():
                continue
            if name.startswith("/") or ".." in PurePosixPath(name).parts:
                raise BuildError(f"{wheel.name} holds a path outside its tree: {name}")
            if PurePosixPath(name).parts[0].endswith(".data"):
                raise BuildError(
                    f"{wheel.name} has a .data directory ({name}): the build does not install those"
                )
            target = site_packages / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.read(member))
            executable = (member.external_attr >> 16) & stat.S_IXUSR
            target.chmod(0o755 if executable else 0o644)


# -- the tree --------------------------------------------------------------------------------------


def package_files(root: Path) -> list[Path]:
    """The files of the package, relative to `root / PACKAGE_DIR`: what git tracks (a checkout may
    hold other files), or, outside a git checkout (the tests' stand-in tree), every file but byte
    code."""
    base = root / PACKAGE_DIR
    if (root / ".git").exists():
        listed = subprocess.run(
            ["git", "-C", str(root), "ls-files", "-z", "--", PACKAGE_DIR],
            check=True,
            capture_output=True,
        ).stdout
        names = [Path(n).relative_to(PACKAGE_DIR) for n in listed.decode().split("\0") if n]
    else:
        names = [
            p.relative_to(base)
            for p in base.rglob("*")
            if p.is_file() and "__pycache__" not in p.parts
        ]
    return sorted(names)


def pyproject_version(root: Path) -> str:
    return tomllib.loads((root / "runner/pyproject.toml").read_text())["project"]["version"]


def write_dist_info(site_packages: Path, version: str) -> None:
    """What `importlib.metadata.version("code-reviewer-runner")` reads, and the console script the
    command stands for."""
    info = site_packages / f"code_reviewer_runner-{version}.dist-info"
    info.mkdir()
    (info / "METADATA").write_text(
        "Metadata-Version: 2.1\nName: code-reviewer-runner\n"
        f"Version: {version}\nSummary: The Factory-Runner program (release build)\n"
    )
    (info / "INSTALLER").write_text("build_program.py\n")
    (info / "entry_points.txt").write_text(
        f"[console_scripts]\nfactory-runner = {COMMAND_MODULE}:entry_point\n"
    )


def _excluded(relative: str) -> bool:
    if relative in PYTHON_EXCLUDED or any(
        relative.startswith(prefix + "/") for prefix in PYTHON_EXCLUDED
    ):
        return True
    return any(pattern.match(relative) for pattern in PYTHON_EXCLUDED_PATTERNS)


def unpack_python(archive: Path, destination: Path) -> None:
    """The standalone Python's `python/` directory, as `destination` (minus what is excluded). Never
    trusts a name in the archive."""
    with tarfile.open(archive, "r:gz") as tar:
        for member in tar:
            parts = PurePosixPath(member.name).parts
            if not parts or parts[0] != "python" or member.name.startswith("/") or ".." in parts:
                raise BuildError(f"the Python archive holds a name outside python/: {member.name}")
            relative = "/".join(parts[1:])
            if not relative or _excluded(relative):
                continue
            target = destination / relative
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif member.issym():
                target.parent.mkdir(parents=True, exist_ok=True)
                target.symlink_to(member.linkname)
            elif member.isreg():
                target.parent.mkdir(parents=True, exist_ok=True)
                source = tar.extractfile(member)
                assert source is not None
                target.write_bytes(source.read())
                target.chmod(0o755 if member.mode & stat.S_IXUSR else 0o644)
            else:
                raise BuildError(f"the Python archive holds a {member.type!r} entry: {member.name}")
    (destination / "lib" / f"python{PYTHON_MINOR}" / "site-packages").mkdir(
        parents=True, exist_ok=True
    )


def compile_bytecode(python: Path, library: Path, release: int) -> None:
    """Hash-checked byte code for everything under the library: the release is read-only, so a
    Python that finds none compiles in memory at every start; timestamp-based byte code would not
    survive the fixed mtimes. `-f` because the interpreter that compiles has imported some modules
    itself and `-B` keeps it from writing its own timestamp-based cache for them. The fixed hash
    seed makes the constants that are sets come out in one order, and `-d` makes the path in a
    traceback the one of the machine."""
    for cache in sorted(library.rglob("__pycache__")):
        shutil.rmtree(cache)
    env = {"PATH": "/usr/bin:/bin", "PYTHONHASHSEED": "0", "HOME": str(library)}
    subprocess.run(
        [
            str(python),
            *("-B", "-m", "compileall", "-q", "-f", "-j", "1"),
            *("--invalidation-mode", "checked-hash"),
            *("-d", f"{INSTALL_ROOT}/{release}/python/lib/python{PYTHON_MINOR}"),
            str(library),
        ],
        check=True,
        env=env,
    )


def write_text(path: Path, text: str, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(mode)


def copy_file(source: Path, destination: Path, mode: int) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    destination.chmod(mode)


def notice_text(python_version: str) -> str:
    return (
        "Third-party components of this program release (THIRD_PARTY_LICENSES.md of the\n"
        'repository, "Factory-Runner program release"):\n\n'
        f"- CPython {python_version} (PSF-2.0), a standalone build by\n"
        "  astral-sh/python-build-standalone. Its licence text is lib/python3.13/LICENSE.txt in\n"
        "  the bundled Python; the texts of the libraries it is built with (OpenSSL, libffi,\n"
        "  zlib, bzip2, xz, SQLite, expat, mpdecimal, libedit, ncurses, libuuid, Berkeley DB)\n"
        "  are in share/licenses/third-party/python/, copied from the publisher's full archive\n"
        "  of this build.\n"
        "- Firecracker (Apache-2.0): share/licenses/firecracker/LICENSE, NOTICE and THIRD-PARTY.\n"
        "- cryptography (Apache-2.0 OR BSD-3-Clause), cffi (MIT) and pycparser (BSD-3-Clause):\n"
        "  the licence files are in the .dist-info directories under\n"
        "  python/lib/python3.13/site-packages. OpenSSL 4.0.3 (Apache-2.0) is linked into the\n"
        "  cryptography wheel: its licence text is\n"
        "  share/licenses/third-party/openssl-4.0.3/LICENSE.txt (the wheel's SBOM names it).\n"
        "- code_reviewer_runner (proprietary, source-visible): the files in\n"
        "  python/lib/python3.13/site-packages/code_reviewer_runner/licenses/.\n"
    )


def copy_licenses(source: Path, tree: Path) -> None:
    """The licence texts of the libraries the Python and the `cryptography` wheel are built with,
    copied out of the archives they came from (`source/SOURCES.md` says which): into
    `share/licenses/third-party/`, each checked against `SHA256SUMS`; an unlisted or changed file
    stops the build."""
    pinned: dict[str, str] = {}
    for line in (source / "SHA256SUMS").read_text().splitlines():
        if line.strip():
            digest, name = line.split("  ", 1)
            pinned[name] = digest
    for path in sorted(p for p in source.rglob("*") if p.is_file()):
        name = str(path.relative_to(source))
        if name not in pinned and name not in ("SHA256SUMS", "SOURCES.md"):
            raise BuildError(f"the licence text {name} is not pinned in {source}/SHA256SUMS")
    for name, digest in sorted(pinned.items()):
        text = source / name
        if not text.is_file() or sha256_file(text) != digest:
            raise BuildError(
                f"the licence text {name} does not match its pin in {source}/SHA256SUMS"
            )
        copy_file(text, tree / "share/licenses/third-party" / name, 0o644)


def assemble_tree(
    root: Path,
    tree: Path,
    *,
    release: int,
    commit: str,
    cache: Path,
    vm_release: int,
) -> dict[str, object]:
    """Makes the release's directory tree under `tree`; returns what `share/release.json` says."""
    pins = read_env(HERE / "pins.env")
    firecracker_pins = read_env(root / "docker/vm/pins.env")
    wheels = runtime_wheels(root / "runner/uv.lock")

    python_archive = fetch_pinned(
        pins["PYTHON_URL"], pins["PYTHON_SHA256"], cache / "python.tar.gz"
    )
    firecracker_archive = fetch_pinned(
        firecracker_pins["FIRECRACKER_URL"],
        firecracker_pins["FIRECRACKER_SHA256"],
        cache / "firecracker.tgz",
    )
    wheel_files = [fetch_pinned(w.url, w.sha256, cache / "wheels" / w.filename) for w in wheels]

    python_dir = tree / "python"
    unpack_python(python_archive, python_dir)
    library = python_dir / "lib" / f"python{PYTHON_MINOR}"
    site_packages = library / "site-packages"
    for wheel in wheel_files:
        unpack_wheel(wheel, site_packages)

    # The program: the files of the package, as the commit has them.
    version = pyproject_version(root)
    package = site_packages / "code_reviewer_runner"
    for relative in package_files(root):
        copy_file(root / PACKAGE_DIR / relative, package / relative, 0o644)
    write_dist_info(site_packages, version)

    # Firecracker, with its licence texts.
    prefix = f"release-v{firecracker_pins['FIRECRACKER_VERSION']}-{ARCH}"
    with tarfile.open(firecracker_archive, "r:gz") as tar:
        for name, destination, mode in (
            (
                f"{prefix}/firecracker-v{firecracker_pins['FIRECRACKER_VERSION']}-{ARCH}",
                tree / "bin/firecracker",
                0o755,
            ),
            (f"{prefix}/LICENSE", tree / "share/licenses/firecracker/LICENSE", 0o644),
            (f"{prefix}/NOTICE", tree / "share/licenses/firecracker/NOTICE", 0o644),
            (f"{prefix}/THIRD-PARTY", tree / "share/licenses/firecracker/THIRD-PARTY", 0o644),
        ):
            source = tar.extractfile(name)
            if source is None:
                raise BuildError(f"the Firecracker archive has no {name}")
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(source.read())
            destination.chmod(mode)

    copy_licenses(root / "runner/release/licenses", tree)

    write_text(tree / "bin/factory-runner", LAUNCHER, 0o755)
    copy_file(root / "docker/vm/host/outer-wall.nft", tree / "share/outer-wall.nft", 0o644)
    copy_file(root / "runner/install/install.sh", tree / "libexec/host.sh", 0o755)

    compile_bytecode(python_dir / "bin" / "python3", library, release)

    release_info: dict[str, object] = {
        "release": release,
        "commit": commit,
        "arch": ARCH,
        "version": version,
        "vmArtifacts": vm_release,
        "glibc": "{}.{}".format(*max([w.glibc for w in wheels] + [(2, 17)])),
        "python": {
            "version": pins["PYTHON_VERSION"],
            "buildTag": pins["PYTHON_BUILD_TAG"],
            "sha256": pins["PYTHON_SHA256"],
        },
        "firecracker": {
            "version": firecracker_pins["FIRECRACKER_VERSION"],
            "sha256": firecracker_pins["FIRECRACKER_SHA256"],
        },
        "packages": [{"name": w.name, "version": w.version, "sha256": w.sha256} for w in wheels],
    }
    write_text(
        tree / "share/release.json",
        json.dumps(release_info, indent=2, sort_keys=True) + "\n",
        0o644,
    )
    write_text(tree / "share/licenses/NOTICE.txt", notice_text(pins["PYTHON_VERSION"]), 0o644)
    return release_info


# -- the tarball -----------------------------------------------------------------------------------


def tree_entries(tree: Path) -> list[tuple[str, Path]]:
    """Every path of the tree, sorted by name, as (name inside the tarball, path on disk).
    Directories end in no slash here."""
    found: list[tuple[str, Path]] = []

    def walk(directory: Path, prefix: str) -> None:
        for entry in sorted(directory.iterdir(), key=lambda p: p.name.encode()):
            name = f"{prefix}{entry.name}"
            found.append((name, entry))
            if entry.is_dir() and not entry.is_symlink():
                walk(entry, f"{name}/")

    walk(tree, "")
    return found


def validate_tree(tree: Path) -> None:
    """The rules `install.sh` holds a program to, held to the tree before it is packed: names it
    accepts, no device or socket, a link only inside the tree, the parts it looks for."""
    bad: list[str] = []
    for name, path in tree_entries(tree):
        if INSTALLER_BAD_NAME.search(name):
            bad.append(f"name: {name}")
        mode = path.lstat().st_mode
        if stat.S_ISLNK(mode):
            target = os.path.normpath(os.path.join(os.path.dirname(name), os.readlink(path)))
            if os.path.isabs(os.readlink(path)) or target == ".." or target.startswith("../"):
                bad.append(f"link out of the tree: {name} -> {os.readlink(path)}")
        elif not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
            bad.append(f"not a file, directory or link: {name}")
    for part in REQUIRED_PARTS:
        if not (tree / part).is_file():
            bad.append(f"missing: {part}")
    if bad:
        raise BuildError("the tree is not one the installer takes:\n  " + "\n  ".join(bad[:40]))


def write_tar(tree: Path, destination: Path, epoch: int) -> None:
    """A tar with names sorted, owner root, one mtime, directories 0755, files 0755 or 0644 by the
    owner's execute bit."""
    with tarfile.open(destination, "w", format=tarfile.GNU_FORMAT) as tar:
        for name, path in tree_entries(tree):
            mode = path.lstat().st_mode
            info = tarfile.TarInfo(name)
            info.uid = info.gid = 0
            info.uname = info.gname = "root"
            info.mtime = epoch
            if stat.S_ISDIR(mode):
                info.type, info.mode = tarfile.DIRTYPE, 0o755
                tar.addfile(info)
            elif stat.S_ISLNK(mode):
                info.type, info.mode, info.linkname = tarfile.SYMTYPE, 0o777, os.readlink(path)
                tar.addfile(info)
            else:
                info.type = tarfile.REGTYPE
                info.mode = 0o755 if mode & stat.S_IXUSR else 0o644
                info.size = path.stat().st_size
                with path.open("rb") as stream:
                    tar.addfile(info, stream)


def compress(source: Path, destination: Path) -> None:
    subprocess.run(
        ["zstd", "-19", "-T1", "-q", "--no-progress", "-f", "-o", str(destination), str(source)],
        check=True,
    )


def manifest_for(tarball: Path, release: int) -> bytes:
    document = {
        "version": 1,
        "release": release,
        "arch": ARCH,
        "file": {
            "name": tarball.name,
            "size": tarball.stat().st_size,
            "sha256": sha256_file(tarball),
        },
    }
    return (json.dumps(document, indent=2) + "\n").encode()


def smoke_test(tree: Path) -> None:
    """The two commands the installer runs at the switch, from the tree that was just made."""
    for command in (tree / "bin/factory-runner", tree / "bin/firecracker"):
        result = subprocess.run(
            [str(command), "--version"],
            capture_output=True,
            text=True,
            check=False,
            stdin=subprocess.DEVNULL,
        )
        if result.returncode != 0:
            tail = result.stderr.strip()[-400:]
            raise BuildError(f"{command.name} --version failed ({result.returncode}): {tail}")


def build(
    root: Path,
    out: Path,
    *,
    release: int,
    commit: str,
    epoch: int,
    cache: Path,
    vm_artifacts: int | None = None,
) -> Path:
    if release < 1:
        raise BuildError("the release number is a whole number from 1")
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise BuildError("the commit is a full 40-character SHA")
    # The VM artifacts release the program needs, exactly: the installer takes this release with
    # it. The file is the truth; only a lane that builds a second program for the same commit
    # names another (`--vm-artifacts`), never a release.
    if vm_artifacts is not None:
        vm_release = vm_artifacts
    else:
        vm_release = json.loads((root / "runner/release/pair.json").read_text())[
            "vmArtifactsRelease"
        ]
    if not isinstance(vm_release, int) or vm_release < 1:
        raise BuildError(
            "the VM artifacts release (runner/release/pair.json) is a whole number from 1"
        )
    out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="program-build-") as work_name:
        work = Path(work_name)
        tree = work / "tree"
        tree.mkdir()
        assemble_tree(
            root, tree, release=release, commit=commit, cache=cache, vm_release=vm_release
        )
        validate_tree(tree)
        smoke_test(tree)
        for compiled in tree.rglob(
            "__pycache__"
        ):  # the smoke test ran with -B, but a build must never ship a stray cache
            if any(not f.name.endswith(".pyc") for f in compiled.iterdir()):
                raise BuildError(f"unexpected file in {compiled}")
        plain = work / "program.tar"
        write_tar(tree, plain, epoch)
        tarball = out / f"factory-runner-{release}-{ARCH}.tar.zst"
        compress(plain, tarball)
    (out / "manifest.json").write_bytes(manifest_for(tarball, release))
    return tarball


def commit_epoch(root: Path, commit: str) -> int:
    result = subprocess.run(
        ["git", "-C", str(root), "show", "-s", "--format=%ct", commit],
        capture_output=True,
        text=True,
        check=True,
    )
    return int(result.stdout.strip())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n")[0])
    parser.add_argument("--release", type=int, required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument(
        "--cache", type=Path, default=Path(tempfile.gettempdir()) / "program-build-cache"
    )
    parser.add_argument("--root", type=Path, default=REPO)
    parser.add_argument(
        "--vm-artifacts",
        type=int,
        help=(
            "the VM artifacts release to name instead of runner/release/pair.json (for the lane "
            "that builds a second program; the release workflow never passes it)"
        ),
    )
    parser.add_argument(
        "--epoch",
        type=int,
        help="the mtime of every file in the tarball (default: the commit's time)",
    )
    arguments = parser.parse_args(argv)
    epoch = (
        arguments.epoch
        if arguments.epoch is not None
        else commit_epoch(arguments.root, arguments.commit)
    )
    try:
        tarball = build(
            arguments.root.resolve(),
            arguments.out,
            release=arguments.release,
            commit=arguments.commit,
            epoch=epoch,
            cache=arguments.cache,
            vm_artifacts=arguments.vm_artifacts,
        )
    except BuildError as error:
        print(f"build_program: {error}", file=sys.stderr)
        return 1
    print(f"{tarball} {tarball.stat().st_size} bytes sha256 {sha256_file(tarball)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
