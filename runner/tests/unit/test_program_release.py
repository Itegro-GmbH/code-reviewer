# SPDX-License-Identifier: LicenseRef-Proprietary

"""The release pipeline of the Factory-Runner's program (#1002): `runner/release/build_program.py`
makes the tarball and its manifest, `runner/release/verify-release.sh` checks them the way a
customer's machine does, and the unchanged `runner/install/install.sh` installs, updates and rolls
back what the build made.

The downloads of the pins (the standalone Python, Firecracker, three wheels) are replaced by small
stand-in archives, the way the installer's tests replace `useradd` and `nft`: everything else is the
real code (the tree, the tar, `zstd`, `openssl`, `jq`, `tar`, `sha256sum` and the installer). The
real pins, a real build and the real installer on a real systemd are the lane of CI
(`runner/release/lane.sh`).

#1002-T01 the manifest verifies with the channel's key and names the tarball by size and sha256;
#1002-T02 the tarball passes the installer's checks; #1002-T03 `install.sh` against the build's
output."""

import base64
import hashlib
import io
import json
import os
import re
import stat
import subprocess
import sys
import tarfile
import tomllib
import zipfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import pytest
from host_install_support import (
    NFT_FILE,
    REPOSITORY_ROOT,
    SCRIPT,
    Machine,
    Release,
    new_machine,
    zstd,
)

RELEASE_DIR = REPOSITORY_ROOT / "runner" / "release"
sys.path.insert(0, str(RELEASE_DIR))

import build_program as bp  # noqa: E402  (the path above makes it importable)

pytestmark = pytest.mark.unit

VERIFY = RELEASE_DIR / "verify-release.sh"
COMMIT = "a" * 40
EPOCH = 1_700_000_000
FIRECRACKER_VERSION = bp.read_env(REPOSITORY_ROOT / "docker/vm/pins.env")["FIRECRACKER_VERSION"]


# -- stand-ins for the pinned downloads ------------------------------------------------------------


def _tar_gz(entries: dict[str, bytes | str | None], modes: dict[str, int] | None = None) -> bytes:
    """A .tar.gz: a value of bytes is a file, a str is a link to it, None is a directory."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for name, content in entries.items():
            info = tarfile.TarInfo(name)
            info.mtime = 1
            if content is None:
                info.type, info.mode = tarfile.DIRTYPE, 0o755
                archive.addfile(info)
            elif isinstance(content, str):
                info.type, info.linkname, info.mode = tarfile.SYMTYPE, content, 0o777
                archive.addfile(info)
            else:
                info.size, info.mode = len(content), (modes or {}).get(name, 0o644)
                archive.addfile(info, io.BytesIO(content))
    return buffer.getvalue()


def _python_archive() -> bytes:
    stub = b'#!/bin/sh\necho "factory-runner 0.1.0 (stand-in interpreter)"\n'
    return _tar_gz(
        {
            "python/bin/python3.13": stub,
            "python/bin/python3": "python3.13",
            "python/bin/python": "python3",
            "python/bin/pip3": b"#!/bin/sh\n",
            "python/include/python3.13/Python.h": b"/* excluded */",
            "python/share/man/man1/python3.1": b"excluded",
            "python/lib/libpython3.13.so.1.0": b"excluded",
            "python/lib/tcl9.0/init.tcl": b"excluded",
            "python/lib/python3.13/LICENSE.txt": b"PSF",
            "python/lib/python3.13/os.py": b"sep = '/'\n",
            "python/lib/python3.13/test/test_x.py": b"excluded",
            "python/lib/python3.13/idlelib/x.py": b"excluded",
            "python/lib/python3.13/lib-dynload/_ssl.cpython-313-x86_64-linux-gnu.so": b"so",
            "python/lib/python3.13/lib-dynload/_tkinter.cpython-313-x86_64-linux-gnu.so": b"drop",
            "python/lib/python3.13/site-packages/pip/__init__.py": b"excluded",
        },
        modes={"python/bin/python3.13": 0o755, "python/bin/pip3": 0o755},
    )


def _firecracker_archive() -> bytes:
    prefix = f"release-v{FIRECRACKER_VERSION}-x86_64"
    binary = f'#!/bin/sh\necho "Firecracker v{FIRECRACKER_VERSION}"\n'.encode()
    return _tar_gz(
        {
            f"{prefix}/firecracker-v{FIRECRACKER_VERSION}-x86_64": binary,
            f"{prefix}/jailer-v{FIRECRACKER_VERSION}-x86_64": b"not shipped",
            f"{prefix}/LICENSE": b"Apache License",
            f"{prefix}/NOTICE": b"notice",
            f"{prefix}/THIRD-PARTY": b"third party",
        },
        modes={f"{prefix}/firecracker-v{FIRECRACKER_VERSION}-x86_64": 0o755},
    )


def _wheel(name: str, version: str) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(f"{name}/__init__.py", "")
        archive.writestr(f"{name}-{version}.dist-info/METADATA", f"Name: {name}\n")
        archive.writestr(f"{name}-{version}.dist-info/licenses/LICENSE", "licence")
    return buffer.getvalue()


@pytest.fixture
def pins(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """The pinned downloads replaced by stand-ins (nothing leaves the machine), and no byte code
    compiled (the stand-in interpreter is a shell script). Returns the cache directory."""
    served: dict[str, bytes] = {
        "python.tar.gz": _python_archive(),
        "firecracker.tgz": _firecracker_archive(),
    }
    for wheel in bp.runtime_wheels(REPOSITORY_ROOT / "runner/uv.lock"):
        served[wheel.filename] = _wheel(wheel.name, wheel.version)

    def fetch(url: str, sha256: str, destination: Path) -> Path:
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(served[destination.name])
        return destination

    monkeypatch.setattr(bp, "fetch_pinned", fetch)

    def no_bytecode(python: Path, library: Path, release: int) -> None:
        return None

    monkeypatch.setattr(bp, "compile_bytecode", no_bytecode)
    return tmp_path / "cache"


def make_release(pins: Path, out: Path, number: int = 1, commit: str = COMMIT) -> Path:
    return bp.build(REPOSITORY_ROOT, out, release=number, commit=commit, epoch=EPOCH, cache=pins)


def listing(tarball: Path) -> list[str]:
    plain = subprocess.run(["zstd", "-dcq", str(tarball)], capture_output=True, check=True).stdout
    with tarfile.open(fileobj=io.BytesIO(plain)) as archive:
        return archive.getnames()


# -- the release, signed and verified --------------------------------------------------------------


@dataclass
class Signing:
    key: Path
    channel: Path

    def sign(self, manifest: Path, signature: Path) -> None:
        subprocess.run(
            [
                "openssl",
                "dgst",
                "-sha256",
                "-sign",
                str(self.key),
                "-out",
                str(signature),
                str(manifest),
            ],
            check=True,
        )


def make_key(folder: Path, curve: str = "prime256v1", name: str = "key") -> Signing:
    key = folder / f"{name}.pem"
    subprocess.run(
        ["openssl", "ecparam", "-genkey", "-name", curve, "-noout", "-out", str(key)], check=True
    )
    der = subprocess.run(
        ["openssl", "pkey", "-in", str(key), "-pubout", "-outform", "DER"],
        capture_output=True,
        check=True,
    ).stdout
    channel = folder / f"{name}-channel.json"
    channel.write_text(
        json.dumps(
            {
                "version": 2,
                "baseUrl": "https://releases.example/runner/",
                "manifestAsset": "runner-manifest.json",
                "signatureAsset": "runner-manifest.sig",
                "publicKey": base64.b64encode(der).decode(),
            }
        )
    )
    return Signing(key, channel)


def verify(
    directory: Path, signing: Signing, *extra: str, manifest: str = "manifest.json"
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            *("bash", str(VERIFY), "--dir", str(directory)),
            *("--manifest", str(directory / manifest)),
            *("--signature", str(directory / "manifest.sig")),
            *("--channel", str(signing.channel)),
            *extra,
        ],
        capture_output=True,
        text=True,
        check=False,
    )


@pytest.fixture
def built(pins: Path, tmp_path: Path) -> tuple[Path, Signing]:
    """A release 1 made by the build, its manifest signed by a throwaway key: (directory, key)."""
    out = tmp_path / "release"
    make_release(pins, out)
    signing = make_key(tmp_path)
    signing.sign(out / "manifest.json", out / "manifest.sig")
    return out, signing


# -- T01 -------------------------------------------------------------------------------------------


# #1002-T01
def test_the_manifest_verifies_with_the_channel_key_and_names_the_tarball_by_size_and_sha256(
    built: tuple[Path, Signing],
) -> None:
    out, signing = built
    tarball = out / "factory-runner-1-x86_64.tar.zst"

    done = verify(
        out, signing, "--release", "1", "--commit", COMMIT, "--min-release", "0", "--exact-dir"
    )

    assert done.returncode == 0, done.stderr
    manifest = json.loads((out / "manifest.json").read_text())
    assert manifest == {
        "version": 1,
        "release": 1,
        "arch": "x86_64",
        "file": {
            "name": tarball.name,
            "size": tarball.stat().st_size,
            "sha256": hashlib.sha256(tarball.read_bytes()).hexdigest(),
        },
    }


# #1002-T01
def test_the_manifest_has_the_shape_of_the_installers_tests_and_the_documented_format(
    built: tuple[Path, Signing],
) -> None:
    out, _ = built
    tarball = out / "factory-runner-1-x86_64.tar.zst"

    ours = json.loads((out / "manifest.json").read_text())
    theirs = json.loads(Release(program=1).program_manifest(tarball.read_bytes()))

    assert ours == theirs


# #1002-T01
def test_a_signature_by_another_key_or_over_other_bytes_is_refused(
    built: tuple[Path, Signing], tmp_path: Path
) -> None:
    out, signing = built
    other = make_key(tmp_path, name="other")
    other.sign(out / "manifest.json", out / "manifest.sig")
    assert "signature of the manifest is not valid" in verify(out, signing).stderr
    signing.sign(out / "manifest.json", out / "manifest.sig")
    assert verify(out, signing).returncode == 0

    (out / "manifest.json").write_text(
        (out / "manifest.json").read_text().replace('"release": 1', '"release": 2')
    )
    done = verify(out, signing)

    assert done.returncode != 0 and "signature of the manifest is not valid" in done.stderr


# #1002-T01
def test_a_key_that_is_not_ecdsa_p256_is_refused(
    built: tuple[Path, Signing], tmp_path: Path
) -> None:
    out, _ = built
    wrong_curve = make_key(tmp_path, curve="secp384r1", name="p384")
    wrong_curve.sign(out / "manifest.json", out / "manifest.sig")

    done = verify(out, wrong_curve)

    assert done.returncode != 0 and "not an ECDSA P-256 key" in done.stderr


# #1002-T01
def test_a_changed_byte_or_size_of_the_tarball_is_refused(built: tuple[Path, Signing]) -> None:
    out, signing = built
    tarball = out / "factory-runner-1-x86_64.tar.zst"
    original = tarball.read_bytes()

    tarball.write_bytes(original[:-1] + bytes([original[-1] ^ 1]))
    assert "does not match the digest" in verify(out, signing).stderr
    tarball.write_bytes(original + b"x")
    assert "not the size its manifest names" in verify(out, signing).stderr


# #1002-T01
def test_the_number_only_grows_the_commit_must_match_and_nothing_else_may_be_in_the_directory(
    built: tuple[Path, Signing],
) -> None:
    out, signing = built

    assert "not higher than 1" in verify(out, signing, "--min-release", "1").stderr
    assert "not 2" in verify(out, signing, "--release", "2").stderr
    assert "not " + "b" * 40 in verify(out, signing, "--commit", "b" * 40).stderr
    (out / "stray.txt").write_text("x")
    assert "other files than the tarball" in verify(out, signing, "--exact-dir").stderr


# -- T02: the tarball ------------------------------------------------------------------------------


# #1002-T02
def test_the_tarball_holds_the_four_parts_and_only_names_and_links_the_installer_accepts(
    built: tuple[Path, Signing],
) -> None:
    out, _ = built
    tarball = out / "factory-runner-1-x86_64.tar.zst"
    names = listing(tarball)

    for part in bp.REQUIRED_PARTS:
        assert part in names
    # The installer's own pattern, on the names `tar -t` lists.
    assert not [name for name in names if bp.INSTALLER_BAD_NAME.search(name)]
    plain = subprocess.run(["zstd", "-dcq", str(tarball)], capture_output=True, check=True).stdout
    with tarfile.open(fileobj=io.BytesIO(plain)) as archive:
        kinds = {member.type for member in archive.getmembers()}
        links = {m.name: m.linkname for m in archive.getmembers() if m.issym()}
    assert kinds <= {tarfile.REGTYPE, tarfile.DIRTYPE, tarfile.SYMTYPE}
    assert links["python/bin/python"] == "python3" and not any(
        target.startswith("/") or ".." in target for target in links.values()
    )


# #1002-T02
def test_the_parts_are_the_files_of_the_repository_and_the_launcher_starts_the_bundled_python(
    built: tuple[Path, Signing], tmp_path: Path
) -> None:
    out, _ = built
    tree = tmp_path / "unpacked"
    tree.mkdir()
    plain = subprocess.run(
        ["zstd", "-dcq", str(out / "factory-runner-1-x86_64.tar.zst")],
        capture_output=True,
        check=True,
    ).stdout
    with tarfile.open(fileobj=io.BytesIO(plain)) as archive:
        archive.extractall(tree, filter="data")

    assert (tree / "share/outer-wall.nft").read_bytes() == NFT_FILE.read_bytes()
    assert b"@SLOT_NETWORK@" in (tree / "share/outer-wall.nft").read_bytes()
    assert (tree / "libexec/host.sh").read_bytes() == SCRIPT.read_bytes()
    launcher = (tree / "bin/factory-runner").read_text()
    assert 'readlink -f "$0"' in launcher and '"$root/python/bin/python3" -I -B -c' in launcher
    assert stat.S_IMODE((tree / "bin/factory-runner").stat().st_mode) == 0o755
    assert (tree / "bin/firecracker").read_text().startswith("#!/bin/sh")
    assert subprocess.run(
        [str(tree / "bin/factory-runner"), "--version"], capture_output=True, check=True
    )
    # The runtime is the program's own: no pip, no headers, no Tcl, no tests; the packages of the
    # lock are there.
    site = tree / "python/lib/python3.13/site-packages"
    assert {"cryptography", "cffi", "pycparser", "code_reviewer_runner"} <= {
        p.name for p in site.iterdir()
    }
    for excluded in ("include", "share/man", "lib/libpython3.13.so.1.0", "lib/tcl9.0", "bin/pip3"):
        assert not (tree / "python" / excluded).exists(), excluded
    assert not (tree / "python/lib/python3.13/test").exists()
    assert not (site / "pip").exists()
    assert not list((tree / "python/lib/python3.13/lib-dynload").glob("_tkinter*"))
    # The package is the one of the tagged commit, with its data files and the metadata that gives
    # the version.
    assert (site / "code_reviewer_runner/factory_runner/cli.py").is_file()
    assert (site / "code_reviewer_runner/licenses/NOTICE").is_file()
    assert (site / "code_reviewer_runner-0.1.0.dist-info/METADATA").read_text().count(
        "Version: 0.1.0"
    ) == 1
    info = json.loads((tree / "share/release.json").read_text())
    assert info["release"] == 1 and info["commit"] == COMMIT and info["vmArtifacts"] >= 1
    assert {p["name"] for p in info["packages"]} == set(bp.RUNTIME_PACKAGES)
    assert (tree / "share/licenses/firecracker/LICENSE").is_file()
    assert not any("jailer" in str(p) for p in tree.rglob("*"))


# #1002-T02
def test_the_build_is_reproducible_and_a_new_release_number_or_commit_is_a_new_tarball(
    pins: Path, tmp_path: Path
) -> None:
    first = make_release(pins, tmp_path / "a")
    second = make_release(pins, tmp_path / "b")
    other_number = make_release(pins, tmp_path / "c", number=2)
    other_commit = make_release(pins, tmp_path / "d", commit="c" * 40)

    assert first.read_bytes() == second.read_bytes()
    assert (tmp_path / "a/manifest.json").read_bytes() == (
        tmp_path / "b/manifest.json"
    ).read_bytes()
    assert other_number.read_bytes() != first.read_bytes()
    assert other_commit.read_bytes() != first.read_bytes()
    assert other_number.name == "factory-runner-2-x86_64.tar.zst"


# #1002-T02
def test_every_entry_has_owner_root_one_mtime_and_a_normalised_mode_in_sorted_order(
    built: tuple[Path, Signing],
) -> None:
    out, _ = built
    plain = subprocess.run(
        ["zstd", "-dcq", str(out / "factory-runner-1-x86_64.tar.zst")],
        capture_output=True,
        check=True,
    ).stdout
    with tarfile.open(fileobj=io.BytesIO(plain)) as archive:
        members = archive.getmembers()

    assert {(m.uid, m.gid, m.uname, m.gname, m.mtime) for m in members} == {
        (0, 0, "root", "root", EPOCH)
    }
    assert {m.mode for m in members if m.isdir()} == {0o755}
    assert {m.mode for m in members if m.isfile()} <= {0o644, 0o755}
    # Sorted inside each directory (a directory comes before what is in it).
    names = [m.name for m in members]
    assert names == sorted(names, key=lambda n: [part.encode() for part in n.split("/")])


# #1002-T02
@pytest.mark.parametrize(
    "damage, message",
    [
        ("bad-name", "name:"),
        ("absolute-link", "link out of the tree"),
        ("escaping-link", "link out of the tree"),
        ("fifo", "not a file, directory or link"),
        ("missing-part", "missing: bin/firecracker"),
    ],
)
def test_the_build_refuses_a_tree_the_installer_would_refuse(
    damage: str, message: str, tmp_path: Path
) -> None:
    tree = tmp_path / "tree"
    for name in bp.REQUIRED_PARTS:
        (tree / name).parent.mkdir(parents=True, exist_ok=True)
        (tree / name).write_text("x")
    bp.validate_tree(tree)  # a complete tree is fine

    if damage == "bad-name":
        (tree / "share/a b").write_text("x")
    elif damage == "absolute-link":
        (tree / "share/out").symlink_to("/etc/passwd")
    elif damage == "escaping-link":
        (tree / "share/out").symlink_to("../../outside")
    elif damage == "fifo":
        os.mkfifo(tree / "share/pipe")
    else:
        (tree / "bin/firecracker").unlink()
    with pytest.raises(bp.BuildError, match=message):
        bp.validate_tree(tree)


# #1002-T02
def test_a_link_inside_the_tree_is_fine(tmp_path: Path) -> None:
    tree = tmp_path / "tree"
    for name in bp.REQUIRED_PARTS:
        (tree / name).parent.mkdir(parents=True, exist_ok=True)
        (tree / name).write_text("x")
    (tree / "bin/alias").symlink_to("firecracker")
    (tree / "python/bin").mkdir(parents=True)
    (tree / "python/bin/up").symlink_to("../../bin/firecracker")

    bp.validate_tree(tree)


def forge(
    tmp_path: Path, signing: Signing, build_members: Callable[[tarfile.TarFile], None]
) -> Path:
    """A signed release whose tarball the test shapes: the installer refuses each damage, and so
    must the verifier."""
    out = tmp_path / "forged"
    out.mkdir()
    plain = io.BytesIO()
    with tarfile.open(fileobj=plain, mode="w") as archive:
        build_members(archive)
    tarball = out / "factory-runner-1-x86_64.tar.zst"
    tarball.write_bytes(zstd(plain.getvalue()))
    (out / "manifest.json").write_text(
        json.dumps(
            {
                "version": 1,
                "release": 1,
                "arch": "x86_64",
                "file": {
                    "name": tarball.name,
                    "size": tarball.stat().st_size,
                    "sha256": hashlib.sha256(tarball.read_bytes()).hexdigest(),
                },
            }
        )
    )
    signing.sign(out / "manifest.json", out / "manifest.sig")
    return out


def good_members(
    archive: tarfile.TarFile,
    *,
    skip: str | None = None,
    commit: str = COMMIT,
    template: bytes = b"@SLOT_NETWORK@\n",
    vm: object = 1,
) -> None:
    files = {
        "bin/factory-runner": b"#!/bin/sh\n",
        "bin/firecracker": b"#!/bin/sh\n",
        "libexec/host.sh": b"#!/bin/sh\n",
        "share/outer-wall.nft": template,
        "share/release.json": json.dumps(
            {"release": 1, "commit": commit, "vmArtifacts": vm}
        ).encode(),
    }
    for name, content in files.items():
        if name == skip:
            continue
        info = tarfile.TarInfo(name)
        info.size = len(content)
        archive.addfile(info, io.BytesIO(content))


@pytest.mark.parametrize(
    "damage, message",
    [
        ("absolute", "outside its own tree or an odd name"),
        ("parent", "outside its own tree or an odd name"),
        ("space", "outside its own tree or an odd name"),
        ("link-out", "points out of its tree"),
        ("device", "cannot be unpacked|device or a socket"),
        ("no-part", "has no bin/firecracker"),
        ("no-info", "no share/release.json"),
        ("wrong-commit", "names the commit"),
        ("no-template", "no @SLOT_NETWORK@"),
        ("vm-not-a-number", "does not name the VM artifacts release it needs"),
    ],
)
def test_the_verifier_refuses_what_the_installer_refuses(
    damage: str, message: str, built: tuple[Path, Signing], tmp_path: Path
) -> None:
    _, signing = built

    def members(archive: tarfile.TarFile) -> None:
        good_members(
            archive,
            skip={"no-part": "bin/firecracker", "no-info": "share/release.json"}.get(damage),
            commit="b" * 40 if damage == "wrong-commit" else COMMIT,
            template=b"x\n" if damage == "no-template" else b"@SLOT_NETWORK@\n",
            vm="one" if damage == "vm-not-a-number" else 1,
        )
        path = {"absolute": "/etc/evil", "parent": "../evil", "space": "share/a b"}.get(
            damage, "share/x"
        )
        extra = tarfile.TarInfo(path)
        if damage in ("absolute", "parent", "space"):
            extra.size = 1
            archive.addfile(extra, io.BytesIO(b"x"))
        elif damage == "link-out":
            extra.type, extra.linkname = tarfile.SYMTYPE, "/etc/passwd"
            archive.addfile(extra)
        elif damage == "device":
            extra.type, extra.devmajor, extra.devminor = tarfile.CHRTYPE, 1, 3
            archive.addfile(extra)

    out = forge(tmp_path, signing, members)

    done = verify(out, signing, "--commit", COMMIT)

    assert done.returncode != 0, done.stdout
    assert re.search(message, done.stderr), done.stderr


# #1002-T21
def test_the_verifier_holds_the_release_to_the_vm_artifacts_release_it_is_asked_for(
    built: tuple[Path, Signing], tmp_path: Path
) -> None:
    _, signing = built
    out = forge(tmp_path, signing, good_members)  # names VM artifacts release 1

    assert verify(out, signing, "--commit", COMMIT, "--vm", "1").returncode == 0
    wrong = verify(out, signing, "--commit", COMMIT, "--vm", "2")

    assert wrong.returncode != 0
    assert "names the VM artifacts release 1, not 2" in wrong.stderr


# #1002-T21
def test_the_build_names_the_vm_artifacts_release_of_pair_json_unless_a_lane_names_another(
    pins: Path, tmp_path: Path
) -> None:
    pair = json.loads((RELEASE_DIR / "pair.json").read_text())["vmArtifactsRelease"]

    def named(out: Path, **options: int) -> int:
        tarball = bp.build(
            REPOSITORY_ROOT, out, release=1, commit=COMMIT, epoch=EPOCH, cache=pins, **options
        )
        plain = subprocess.run(
            ["zstd", "-dcq", str(tarball)], capture_output=True, check=True
        ).stdout
        with tarfile.open(fileobj=io.BytesIO(plain)) as archive:
            member = archive.extractfile("share/release.json")
            assert member is not None
            return json.loads(member.read())["vmArtifacts"]

    assert named(tmp_path / "a") == pair
    assert named(tmp_path / "b", vm_artifacts=pair + 6) == pair + 6
    with pytest.raises(bp.BuildError, match="whole number from 1"):
        named(tmp_path / "c", vm_artifacts=0)


def test_a_complete_forged_tarball_passes_so_the_refusals_above_are_the_damage_and_nothing_else(
    built: tuple[Path, Signing], tmp_path: Path
) -> None:
    _, signing = built
    out = forge(tmp_path, signing, good_members)

    done = verify(out, signing, "--commit", COMMIT)

    assert done.returncode == 0, done.stderr


# -- T03: the unchanged installer takes what the build made ----------------------------------------


class ProgramRelease(Release):
    """A release whose program is the tarball the build made (the installer's tests use a four-file
    stand-in)."""

    tarball_path: Path | None = None

    def bundle(self) -> bytes:
        assert self.tarball_path is not None
        return self.tarball_path.read_bytes()


def program_release(
    pins: Path, tmp_path: Path, number: int, vm: int, *, like: Release | None = None
) -> ProgramRelease:
    out = tmp_path / f"program-{number}"
    tarball = make_release(pins, out, number=number)
    release = (
        ProgramRelease(program=number, vm=vm, key=like.key)
        if like
        else ProgramRelease(program=number, vm=vm)
    )
    release.tarball_path = tarball
    # The manifest the build wrote is the one the release is signed with: same bytes the installer
    # would be served.
    assert json.loads((out / "manifest.json").read_text()) == json.loads(
        release.program_manifest(tarball.read_bytes())
    )
    return release


# #1002-T03
def test_the_installer_installs_updates_and_rolls_back_the_programs_the_build_made(
    pins: Path, tmp_path: Path
) -> None:
    # Both builds name the VM artifacts release of runner/release/pair.json: the installer takes exactly that one with them.
    vm = json.loads((RELEASE_DIR / "pair.json").read_text())["vmArtifactsRelease"]
    first = program_release(pins, tmp_path, 1, vm)
    machine: Machine = new_machine(tmp_path / "machine", first)

    installed = machine.install()

    assert installed.returncode == 0, installed.stderr
    assert machine.release_of("current", parent=machine.opt) == "1"
    # The files the installer put in place are the build's, read-only for the service, and the smoke
    # test passed.
    current = machine.opt / "releases" / "1"
    for part in bp.REQUIRED_PARTS:
        assert (current / part).is_file()
    assert (current / "libexec/host.sh").read_bytes() == SCRIPT.read_bytes()
    assert json.loads((current / "share/release.json").read_text())["release"] == 1

    second = program_release(pins, tmp_path, 2, vm, like=first)
    machine.publish(second)
    staged = machine.host("update")
    assert staged.returncode == 0, staged.stderr
    assert "staged the program release 2" in staged.stdout
    assert machine.release_of("artifacts", parent=machine.state_dir) == str(vm)
    switched = machine.host("switch")
    assert switched.returncode == 0, switched.stderr
    assert machine.release_of("current", parent=machine.opt) == "2"
    assert machine.release_of("previous", parent=machine.opt) == "1"

    back = machine.host("rollback")
    assert back.returncode == 0, back.stderr
    assert machine.host("switch").returncode == 0
    assert machine.release_of("current", parent=machine.opt) == "1"
    assert "was rolled back" in machine.host("update").stdout


# -- what the program may import -------------------------------------------------------------------


def test_the_program_on_the_host_imports_nothing_the_tarball_does_not_carry() -> None:
    """The tarball carries the standard library, the package and `cryptography` (with `cffi` and
    `pycparser`): another top-level import in the command's reach would pass every test in a full
    environment and fail on the first machine."""
    program = """
import importlib.abc, sys
ALLOWED = {"code_reviewer_runner", "cryptography", "cffi", "_cffi_backend", "pycparser"}
class Block(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path=None, target=None):
        top = name.split(".")[0]
        if top in sys.stdlib_module_names or top in ALLOWED or top.startswith("_"):
            return None
        raise ImportError("the program carries no " + top)
sys.meta_path.insert(0, Block())
from code_reviewer_runner.factory_runner.cli import entry_point
import code_reviewer_runner.factory_runner.service, code_reviewer_runner.factory_runner.update
"""
    done = subprocess.run(
        [sys.executable, "-c", program],
        env={"PYTHONPATH": str(REPOSITORY_ROOT / "runner/src"), "PATH": os.environ.get("PATH", "")},
        capture_output=True,
        text=True,
        check=False,
    )

    assert done.returncode == 0, done.stderr[-1500:]


# -- pins ------------------------------------------------------------------------------------------


def test_the_wheels_come_from_the_lock_with_its_hashes_and_need_the_oldest_glibc() -> None:
    wheels = {w.name: w for w in bp.runtime_wheels(REPOSITORY_ROOT / "runner/uv.lock")}

    assert set(wheels) == set(bp.RUNTIME_PACKAGES)
    lock = tomllib.loads((REPOSITORY_ROOT / "runner/uv.lock").read_text())
    for package in lock["package"]:
        if package["name"] in wheels:
            wheel = wheels[package["name"]]
            assert wheel.version == package["version"]
            assert f"sha256:{wheel.sha256}" in {w["hash"] for w in package["wheels"]}
            assert "musllinux" not in wheel.filename and wheel.glibc <= (2, 17)


def test_a_new_dependency_of_cryptography_is_a_decision_not_a_surprise() -> None:
    lock = tomllib.loads((REPOSITORY_ROOT / "runner/uv.lock").read_text())
    assert bp.lock_closure(lock, "cryptography") == sorted(bp.RUNTIME_PACKAGES)
    package = next(p for p in lock["package"] if p["name"] == "cryptography")

    package["dependencies"].append({"name": "idna"})

    assert bp.lock_closure(lock, "cryptography") != sorted(bp.RUNTIME_PACKAGES)


@pytest.mark.parametrize(
    "tags, picked",
    [
        (
            [
                "a-1-cp313-cp313-manylinux_2_28_x86_64.whl",
                "a-1-cp313-cp313-manylinux2014_x86_64.manylinux_2_17_x86_64.whl",
            ],
            "manylinux2014",
        ),
        (
            ["a-1-cp311-abi3-manylinux_2_28_x86_64.whl", "a-1-cp311-abi3-musllinux_1_2_x86_64.whl"],
            "manylinux_2_28",
        ),
        (["a-1-py3-none-any.whl", "a-1-cp313-cp313-manylinux_2_28_x86_64.whl"], "any"),
    ],
)
def test_the_wheel_is_the_one_for_cpython_313_on_glibc_with_the_lowest_requirement(
    tags: list[str], picked: str
) -> None:
    wheel = bp.pick_wheel("a", "1", [(f"https://x/{tag}", "sha256:" + "0" * 64) for tag in tags])

    assert picked in wheel.filename


def test_a_package_with_only_musl_or_other_python_wheels_stops_the_build() -> None:
    with pytest.raises(bp.BuildError, match="no wheel"):
        bp.pick_wheel(
            "a",
            "1",
            [
                ("https://x/a-1-cp313-cp313-musllinux_1_2_x86_64.whl", "sha256:0"),
                ("https://x/a-1-cp312-cp312-manylinux2014_x86_64.whl", "sha256:0"),
            ],
        )


def test_the_pins_name_a_checksum_and_the_files_of_the_release_cannot_be_swapped(
    tmp_path: Path,
) -> None:
    pins = bp.read_env(RELEASE_DIR / "pins.env")
    assert re.fullmatch(r"[0-9a-f]{64}", pins["PYTHON_SHA256"]) and pins["PYTHON_URL"].startswith(
        "https://"
    )
    assert (
        pins["PYTHON_VERSION"] in pins["PYTHON_URL"]
        and pins["PYTHON_BUILD_TAG"] in pins["PYTHON_URL"]
    )
    assert "x86_64-unknown-linux-gnu-install_only_stripped" in pins["PYTHON_URL"]
    served = tmp_path / "file"
    served.write_bytes(b"other bytes")
    with pytest.raises(bp.BuildError, match="CHECKSUM MISMATCH"):
        bp.fetch_pinned(served.as_uri(), "0" * 64, tmp_path / "out" / "file")
    assert not (tmp_path / "out" / "file").exists()


def test_the_pair_file_names_the_vm_artifacts_release_this_program_needs() -> None:
    pair = json.loads((RELEASE_DIR / "pair.json").read_text())

    assert (
        set(pair) == {"vmArtifactsRelease"}
        and isinstance(pair["vmArtifactsRelease"], int)
        and pair["vmArtifactsRelease"] >= 1
    )


def test_the_launcher_text_is_what_the_documentation_says() -> None:
    assert bp.LAUNCHER.splitlines()[0] == "#!/bin/sh"
    assert "-I -B -c" in bp.LAUNCHER and "entry_point" in bp.LAUNCHER
    # `readlink -f`: the installed command and the unit run it through the `current` link.
    assert 'readlink -f "$0"' in bp.LAUNCHER
