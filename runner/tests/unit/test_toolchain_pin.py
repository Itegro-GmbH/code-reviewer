# SPDX-License-Identifier: LicenseRef-Proprietary

"""Pins down the pins of the Implementer toolchain and the helper that installs them (#761).

The agent of the Implementer runs git, node, pnpm and compilers inside the Worker container. git is
built from a pinned source release (Debian's is older than the 2.53 the branch guard needs), node
and pnpm are unpacked from pinned release archives. Each is named by exact version, release asset
and SHA-256, checked like the engine and ripgrep: a download is accepted only with the pinned size
and digest, before anything is unpacked. Nothing here touches the network: the download is injected.
"""

import hashlib
import importlib.util
import io
import json
import re
import sys
import tarfile
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

SCRIPTS = Path(__file__).parents[2] / "scripts"
RUNNER = Path(__file__).parents[2]
COMPONENTS = ("git", "node", "pnpm")


def load_script() -> ModuleType:
    # The script imports its sibling `fetch_opencode`, as it does when it is run from scripts/.
    sys.path.insert(0, str(SCRIPTS))
    try:
        spec = importlib.util.spec_from_file_location(
            "fetch_toolchain", SCRIPTS / "fetch_toolchain.py"
        )
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        sys.modules["fetch_toolchain"] = module
        spec.loader.exec_module(module)
    finally:
        sys.path.remove(str(SCRIPTS))
    return module


def pin_of(component: str) -> dict[str, Any]:
    return json.loads((RUNNER / f"{component}-pin.json").read_text(encoding="utf-8"))


def archive_of(members: dict[str, bytes], *, kind: bytes = tarfile.REGTYPE) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as bundle:
        for name, content in members.items():
            info = tarfile.TarInfo(name)
            info.size = len(content)
            info.type = kind
            info.mode = 0o755 if name.endswith("/bin/tool") else 0o644
            bundle.addfile(info, io.BytesIO(content))
    return buffer.getvalue()


def fake_pin(archive: bytes, *, executable: bytes | None = None) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "asset": "tool-1.0.tar.gz",
        "url": "https://example.invalid/tool-1.0.tar.gz",
        "archiveBytes": len(archive),
        "archiveSha256": hashlib.sha256(archive).hexdigest(),
    }
    if executable is not None:
        entry |= {
            "member": "tool-1.0/bin/tool",
            "executableBytes": len(executable),
            "executableSha256": hashlib.sha256(executable).hexdigest(),
        }
    return {"version": "1.0", "platforms": {"linux-x64": entry}}


def serving(archive: bytes) -> Any:
    def download(url: str, target: Path, limit: int) -> None:
        assert url.startswith("https://")
        target.write_bytes(archive)

    return download


TOOL = b"#!/bin/sh\necho tool 1.0\n"
MEMBERS = {"tool-1.0/bin/tool": TOOL, "tool-1.0/LICENSE": b"license text"}


# #761-T02
@pytest.mark.parametrize("component", COMPONENTS)
def test_a_pin_names_an_exact_release_with_digests(component: str) -> None:
    pin = pin_of(component)

    assert pin["name"] == component
    assert re.fullmatch(r"\d+\.\d+\.\d+", pin["version"])
    assert re.fullmatch(r"[0-9a-f]{40}", pin["commit"])
    assert pin["license"] and pin["licenseUrl"].startswith("https://")
    entry = pin["platforms"]["linux-x64"]
    assert re.fullmatch(r"[0-9a-f]{64}", entry["archiveSha256"])
    assert entry["archiveBytes"] > 1_000_000
    # An exact release asset over https; the version is in the file name, no latest.
    assert entry["url"].startswith("https://")
    assert entry["url"].endswith(f"/{entry['asset']}")
    assert pin["version"] in entry["asset"]
    assert "latest" not in json.dumps(pin)


# #761-T01
def test_git_is_pinned_to_a_release_the_branch_guard_can_see_a_checkout_in() -> None:
    pin = pin_of("git")

    version = tuple(int(part) for part in pin["version"].split("."))
    assert version >= (2, 53, 0)
    assert pin["license"] == "GPL-2.0-only"
    # Built from the source tarball, so there is no pinned executable.
    assert "executableSha256" not in pin["platforms"]["linux-x64"]


# #761-T02
@pytest.mark.parametrize("component", ["node", "pnpm"])
def test_node_and_pnpm_pin_the_executable_inside_the_archive(component: str) -> None:
    entry = pin_of(component)["platforms"]["linux-x64"]

    assert re.fullmatch(r"[0-9a-f]{64}", entry["executableSha256"])
    assert entry["executableBytes"] > 0
    assert entry["member"].endswith(("/bin/node", "/dist/pnpm.cjs"))


# #761-T02
def test_node_is_the_24_line_and_pnpm_the_repository_version() -> None:
    assert pin_of("node")["version"].startswith("24.")
    root = json.loads((RUNNER.parent / "package.json").read_text(encoding="utf-8"))
    assert root["packageManager"] == f"pnpm@{pin_of('pnpm')['version']}"


# #761-T02
def test_a_verified_download_is_unpacked_without_its_top_directory(
    tmp_path: Path,
) -> None:
    script = load_script()
    archive = archive_of(MEMBERS)

    path = script.install(
        tmp_path / "out",
        pin=fake_pin(archive, executable=TOOL),
        key="linux-x64",
        download=serving(archive),
    )

    assert path == tmp_path / "out"
    assert (path / "bin" / "tool").read_bytes() == TOOL
    assert (path / "bin" / "tool").stat().st_mode & 0o777 == 0o755
    assert (path / "LICENSE").read_bytes() == b"license text"
    # No download leftovers next to the result.
    assert sorted(entry.name for entry in tmp_path.iterdir()) == ["out"]


# #761-T02
def test_installing_again_downloads_nothing(tmp_path: Path) -> None:
    script = load_script()
    archive = archive_of(MEMBERS)
    pin = fake_pin(archive)
    script.install(tmp_path / "out", pin=pin, key="linux-x64", download=serving(archive))

    def must_not_download(url: str, target: Path, limit: int) -> None:
        raise AssertionError("an installed, verified tree is not downloaded again")

    script.install(tmp_path / "out", pin=pin, key="linux-x64", download=must_not_download)


# #761-T02
def test_a_download_with_another_digest_is_refused_and_nothing_is_written(
    tmp_path: Path,
) -> None:
    script = load_script()
    archive = archive_of(MEMBERS)
    pin = fake_pin(archive)
    pin["platforms"]["linux-x64"]["archiveSha256"] = "0" * 64

    with pytest.raises(script.PinError, match="SHA-256"):
        script.install(tmp_path / "out", pin=pin, key="linux-x64", download=serving(archive))

    assert not (tmp_path / "out").exists()


# #761-T02
def test_a_download_with_another_size_is_refused(tmp_path: Path) -> None:
    script = load_script()
    archive = archive_of(MEMBERS)
    pin = fake_pin(archive)
    pin["platforms"]["linux-x64"]["archiveBytes"] += 1

    with pytest.raises(script.PinError, match="size"):
        script.install(tmp_path / "out", pin=pin, key="linux-x64", download=serving(archive))


# #761-T02
def test_a_pinned_executable_that_differs_is_refused(tmp_path: Path) -> None:
    script = load_script()
    archive = archive_of(MEMBERS)

    with pytest.raises(script.PinError, match="executable"):
        script.install(
            tmp_path / "out",
            pin=fake_pin(archive, executable=b"something else"),
            key="linux-x64",
            download=serving(archive),
        )

    assert not (tmp_path / "out").exists()


# #761-T02
@pytest.mark.parametrize(
    "name",
    ["tool-1.0/../../escape", "/etc/escape", "other-1.0/../escape"],
)
def test_a_member_that_leaves_the_destination_is_refused(tmp_path: Path, name: str) -> None:
    script = load_script()
    archive = archive_of({"tool-1.0/ok": b"ok", name: b"bad"})

    with pytest.raises(script.PinError, match="outside"):
        script.install(
            tmp_path / "out",
            pin=fake_pin(archive),
            key="linux-x64",
            download=serving(archive),
        )

    assert not (tmp_path.parent / "escape").exists()
    assert not (tmp_path / "escape").exists()


# #761-T02
def test_a_link_out_of_the_tree_is_refused(tmp_path: Path) -> None:
    script = load_script()
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as bundle:
        link = tarfile.TarInfo("tool-1.0/link")
        link.type = tarfile.SYMTYPE
        link.linkname = "../../../etc/passwd"
        bundle.addfile(link)
    archive = buffer.getvalue()

    with pytest.raises(script.PinError, match="outside"):
        script.install(
            tmp_path / "out",
            pin=fake_pin(archive),
            key="linux-x64",
            download=serving(archive),
        )


def archive_of_entries(entries: list[tuple[str, bytes, str | None]]) -> bytes:
    """Members in order: (name, content, link target); a link target makes the member a symlink."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as bundle:
        for name, content, linkname in entries:
            info = tarfile.TarInfo(name)
            if linkname is None:
                info.size = len(content)
                bundle.addfile(info, io.BytesIO(content))
            else:
                info.type = tarfile.SYMTYPE
                info.linkname = linkname
                bundle.addfile(info)
    return buffer.getvalue()


# #761-T02 (review of #777, finding 4): each link of the chain is inside the tree when it is read
# lexically, and together they lead out of it, so a file below the last one is written outside.
def test_a_chain_of_links_that_leads_out_of_the_tree_is_refused(tmp_path: Path) -> None:
    script = load_script()
    archive = archive_of_entries(
        [
            ("tool-1.0/d/up", b"", ".."),
            ("tool-1.0/esc", b"", "d/up/.."),
            ("tool-1.0/esc/pwned", b"escaped", None),
        ]
    )

    with pytest.raises(script.PinError, match="outside"):
        script.install(
            tmp_path / "out",
            pin=fake_pin(archive),
            key="linux-x64",
            download=serving(archive),
        )

    assert not (tmp_path / "out").exists()
    assert not list(tmp_path.rglob("pwned"))


# #761-T02: a file is never written through a link, even one that points inside the tree.
def test_a_file_is_not_written_through_a_link_of_the_tree(tmp_path: Path) -> None:
    script = load_script()
    archive = archive_of_entries(
        [
            ("tool-1.0/real", b"original", None),
            ("tool-1.0/alias", b"", "real"),
            ("tool-1.0/alias", b"changed", None),
        ]
    )

    with pytest.raises(script.PinError, match="link"):
        script.install(
            tmp_path / "out",
            pin=fake_pin(archive),
            key="linux-x64",
            download=serving(archive),
        )


# #761-T02: links that stay inside the tree, like node's `bin/npm`, are fine.
def test_links_that_stay_inside_the_tree_are_kept(tmp_path: Path) -> None:
    script = load_script()
    archive = archive_of_entries(
        [
            ("tool-1.0/lib/node_modules/npm/bin/npm-cli.js", b"cli", None),
            ("tool-1.0/bin/npm", b"", "../lib/node_modules/npm/bin/npm-cli.js"),
            ("tool-1.0/lib/up", b"", ".."),
        ]
    )

    tree = script.install(
        tmp_path / "out", pin=fake_pin(archive), key="linux-x64", download=serving(archive)
    )

    assert (tree / "bin" / "npm").read_text(encoding="utf-8") == "cli"
    assert (tree / "lib" / "up").resolve() == tree.resolve()


# #761-T02
def test_a_platform_without_a_pin_fails_the_build(tmp_path: Path) -> None:
    script = load_script()
    archive = archive_of(MEMBERS)

    with pytest.raises(script.NoPinForPlatform):
        script.install(
            tmp_path / "out",
            pin=fake_pin(archive),
            key="darwin-arm64",
            download=serving(archive),
        )


# #761-T02
def test_the_command_line_installs_a_component_and_reports_failures(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    script = load_script()

    def refuse(url: str, target: Path, limit: int) -> None:
        raise OSError("no network in a unit test")

    status = script.main(["--component", "git", "--dest", str(tmp_path / "git")], download=refuse)

    assert status == 1
    assert "cannot install the pinned git" in capsys.readouterr().err
    assert not (tmp_path / "git").exists()
