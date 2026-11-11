# SPDX-License-Identifier: LicenseRef-Proprietary

"""A machine for the tests of the installer and updater (#982): `runner/install/install.sh` run
against stand-ins for every command that needs root (`useradd`, `ip`, `nft`, `systemctl`, `runuser`,
`chown`, `curl`) in a directory that plays the machine's root. What the script verifies it verifies
with the real `openssl`, `jq`, `zstd`, `tar` and `sha256sum`, against releases that this module
signs with a real ECDSA P-256 key and compresses with the real `zstd`: a signature, a digest or a
file name that is wrong is caught by the code under test, not by the stand-in.

A release has two parts, as published (docs/runner.md, "Install"): the **program** (a tarball with
the runner, Firecracker, the nft table and this script) and the **VM artifacts** (kernel, root file
system, Docker data disk, a manifest of the shape `dispatcher/src/vm-artifacts/manifest.ts`)."""

import base64
import hashlib
import io
import json
import os
import subprocess
import tarfile
from dataclasses import dataclass, field
from pathlib import Path

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

RUNNER = Path(__file__).resolve().parents[2]
REPOSITORY_ROOT = RUNNER.parent
SCRIPT = RUNNER / "install" / "install.sh"
NFT_FILE = REPOSITORY_ROOT / "docker" / "vm" / "host" / "outer-wall.nft"

PROGRAM_BASE = "https://releases.example/runner/"
VM_BASE = "https://releases.example/vm/"
PROGRAM_MANIFEST = "runner-manifest.json"
PROGRAM_SIGNATURE = "runner-manifest.sig"
VM_MANIFEST = "vm-artifacts-manifest.json"
VM_SIGNATURE = "vm-artifacts-manifest.sig"
TOKEN = "crt_" + "T" * 43


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def zstd(data: bytes) -> bytes:
    return subprocess.run(["zstd", "-q", "-c"], input=data, capture_output=True, check=True).stdout


@dataclass
class Release:
    """What the owner publishes: one key, a program release and a VM artifacts release."""

    program: int = 1
    vm: int = 10
    key: ec.EllipticCurvePrivateKey = field(
        default_factory=lambda: ec.generate_private_key(ec.SECP256R1())
    )
    image_id: str = "sha256:" + "5" * 64
    # Changes the tests make to what is published, by name.
    tamper: set[str] = field(default_factory=set)

    @property
    def public_key(self) -> str:
        der = self.key.public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
        )
        return base64.b64encode(der).decode()

    def sign(self, document: bytes) -> bytes:
        return self.key.sign(document, ec.ECDSA(hashes.SHA256()))

    def program_channel(self, base: str = PROGRAM_BASE) -> dict[str, object]:
        return {
            "version": 2,
            "baseUrl": base,
            "manifestAsset": PROGRAM_MANIFEST,
            "signatureAsset": PROGRAM_SIGNATURE,
            "publicKey": self.public_key,
        }

    def vm_channel(self, base: str = VM_BASE) -> dict[str, object]:
        return {
            "version": 1,
            "repository": "Itegro-GmbH/code-reviewer",
            "baseUrl": base,
            "manifestAsset": VM_MANIFEST,
            "signatureAsset": VM_SIGNATURE,
            "publicKey": self.public_key,
        }

    # -- the program ----------------------------------------------------------------------------

    def bundle(self) -> bytes:
        """The program tarball: `bin/factory-runner`, `bin/firecracker`, `share/outer-wall.nft`
        and `libexec/host.sh` (this very script, as a release carries it)."""
        runner = FACTORY_RUNNER.replace("@RELEASE@", str(self.program))
        if "program-broken" in self.tamper:
            runner = "#!/bin/sh\nexit 3\n"
        files: dict[str, tuple[bytes, int]] = {
            "bin/factory-runner": (runner.encode(), 0o755),
            "bin/firecracker": (b'#!/bin/sh\necho "Firecracker v1.17.0"\n', 0o755),
            "share/outer-wall.nft": (NFT_FILE.read_bytes(), 0o644),
            "libexec/host.sh": (SCRIPT.read_bytes(), 0o755),
        }
        for name in self.tamper:
            if name.startswith("bundle-drop:"):
                files.pop(name.removeprefix("bundle-drop:"))
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w") as archive:
            for name, (content, mode) in files.items():
                info = tarfile.TarInfo(name)
                info.size, info.mode, info.mtime = len(content), mode, 0
                archive.addfile(info, io.BytesIO(content))
            if "bundle-escape" in self.tamper:
                info = tarfile.TarInfo("../escaped")
                info.size = 1
                archive.addfile(info, io.BytesIO(b"x"))
            if "bundle-link-out" in self.tamper:
                link = tarfile.TarInfo("lib/out")
                link.type, link.linkname = tarfile.SYMTYPE, "/etc/passwd"
                archive.addfile(link)
        return zstd(buffer.getvalue())

    def program_manifest(self, bundle: bytes) -> bytes:
        name = f"factory-runner-{self.program}-x86_64.tar.zst"
        return json.dumps(
            {
                "version": 1,
                "release": self.program,
                "arch": "x86_64",
                "file": {"name": name, "size": len(bundle), "sha256": sha256(bundle)},
            },
            indent=2,
        ).encode()

    # -- the VM artifacts -----------------------------------------------------------------------

    def kernel(self) -> bytes:
        return f"vmlinux of release {self.vm}\n".encode() * 50

    def rootfs(self) -> bytes:
        return f"rootfs of release {self.vm}\n".encode() * 500

    def data_disk(self) -> bytes:
        return f"data disk of release {self.vm}\n".encode() * 800

    def vm_manifest(self, kernel: bytes, rootfs: bytes, data: bytes) -> bytes:
        rootfs_zst, data_zst = zstd(rootfs), zstd(data)

        def plain(name: str, content: bytes) -> dict[str, object]:
            return {"name": name, "size": len(content), "sha256": sha256(content)}

        def packed(name: str, packed_bytes: bytes, content: bytes) -> dict[str, object]:
            return {
                **plain(name, packed_bytes),
                "uncompressed": {"size": len(content), "sha256": sha256(content)},
            }

        document = {
            "version": 1,
            "release": self.vm,
            "arch": "x86_64",
            "builtAt": "2026-11-10T12:00:00.000Z",
            "commit": "a" * 40,
            "files": {
                "kernel": plain("vmlinux", kernel),
                "rootfs": packed("rootfs.ext4.zst", rootfs_zst, rootfs),
                "dockerData": packed("dockerdata.ext4.zst", data_zst, data),
                "kernelSource": plain("linux-6.18.62.tar.xz", b"source"),
                "kernelConfig": plain("kernel.config", b"config"),
                "kernelBaseConfig": plain("fc-base.config", b"base"),
                "kernelFragment": plain("config.fragment", b"fragment"),
                "packages": plain("packages.txt", b"packages"),
            },
            "kernel": {
                "version": "6.18.62",
                "sourceSha256": "0" * 64,
                "baseConfigSha256": "1" * 64,
                "fragmentSha256": "2" * 64,
                "configSha256": "3" * 64,
                "bootArgs": "reboot=k panic=1 8250.nr_uarts=0 quiet loglevel=0",
                "initCommand": "/usr/bin/docker-init -- /usr/local/sbin/vm-boot",
            },
            "firecracker": {"version": "1.17.0"},
            "components": {
                "ubuntuBase": "26.04.1",
                "dockerd": "29.0.0",
                "buildx": "0.30.0",
                "sysbox": "0.7.1",
                "sysboxSha256": "4" * 64,
            },
            "images": {
                "worker": {"tag": "code-reviewer-worker:golden", "id": self.image_id},
                "agent": {"tag": "code-reviewer-agent:golden", "id": "sha256:" + "6" * 64},
            },
        }
        return json.dumps(document, indent=2).encode()

    # -- publishing -----------------------------------------------------------------------------

    def publish(self, served: Path) -> None:
        """Write what the two release addresses answer into `served` (a stand-in `curl` copies
        from there by file name), replacing an earlier release."""
        served.mkdir(parents=True, exist_ok=True)
        bundle = self.bundle()
        program_manifest = self.program_manifest(bundle)
        name = json.loads(program_manifest)["file"]["name"]
        (served / name).write_bytes(bundle)
        (served / PROGRAM_MANIFEST).write_bytes(program_manifest)
        (served / PROGRAM_SIGNATURE).write_bytes(self.sign(program_manifest))

        kernel, rootfs, data = self.kernel(), self.rootfs(), self.data_disk()
        manifest = self.vm_manifest(kernel, rootfs, data)
        files = {"vmlinux": kernel, "rootfs.ext4.zst": zstd(rootfs), "dockerdata.ext4.zst": zstd(data)}
        if "vm-flip-kernel" in self.tamper:
            files["vmlinux"] = b"X" + kernel[1:]
        if "vm-flip-rootfs" in self.tamper:
            files["rootfs.ext4.zst"] = zstd(b"another root file system, same name")
        for file_name, content in files.items():
            (served / file_name).write_bytes(content)
        (served / VM_MANIFEST).write_bytes(manifest)
        signature = self.sign(manifest)
        if "vm-bad-signature" in self.tamper:
            signature = Release().sign(manifest)  # another key
        (served / VM_SIGNATURE).write_bytes(signature)
        if "program-bad-signature" in self.tamper:
            (served / PROGRAM_SIGNATURE).write_bytes(Release().sign(program_manifest))
        if "program-flip-byte" in self.tamper:
            data_bytes = bytearray((served / name).read_bytes())
            data_bytes[-1] ^= 1
            (served / name).write_bytes(bytes(data_bytes))

    def write_channels(self, folder: Path) -> tuple[Path, Path]:
        folder.mkdir(parents=True, exist_ok=True)
        program, vm = folder / "program-channel.json", folder / "vm-channel.json"
        program.write_text(json.dumps(self.program_channel(), indent=2))
        vm.write_text(json.dumps(self.vm_channel(), indent=2))
        return program, vm


# What the bundle's `bin/factory-runner` is in the tests: it answers `--version` and, as the real
# one would, takes the registration on its standard input. It records what it was asked.
FACTORY_RUNNER = """\
#!/bin/sh
printf 'factory-runner %s image=%s release=%s\\n' "$*" "${FACTORY_RUNNER_VM_IMAGE_ID:-}" "${FACTORY_RUNNER_RELEASE:-}" >>"$STUB_STATE/cli.log"
case "${1:-}" in
  --version) echo "factory-runner 0.1.0 (release @RELEASE@)" ;;
  credential)
    if [ -f "$STUB_STATE/registered" ]; then echo "credential: set"; else echo "credential: not set"; fi ;;
  register) cat >"$STUB_STATE/register-stdin"; touch "$STUB_STATE/registered" ;;
  config) cat >"$STUB_STATE/config-stdin" ;;
esac
exit 0
"""

# Stand-ins, one per command that needs root or the network. Each records its call in $STUB_LOG.
STUBS: dict[str, str] = {
    "id": 'case "$1" in -u) echo "${STUB_UID:-0}" ;; *) echo root ;; esac',
    "uname": 'case "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac',
    "systemctl": r"""
printf 'systemctl %s\n' "$*" >>"$STUB_LOG"
case "$1" in
  --version) echo "systemd ${STUB_SYSTEMD:-255} (${STUB_SYSTEMD:-255}.4-1)" ;;
  is-active) [ -f "$STUB_STATE/active" ] ;;
  enable|start|restart) touch "$STUB_STATE/active" ;;
  stop) rm -f "$STUB_STATE/active" ;;
  disable) case "$*" in *--now*) rm -f "$STUB_STATE/active" ;; esac ;;
esac
exit 0
""",
    "getent": r"""
case "$1 $2" in
  "passwd "*) [ -f "$STUB_STATE/users/$2" ] ;;
  "group kvm") [ -z "${STUB_NO_KVM_GROUP:-}" ] && echo "kvm:x:108:" ;;
  *) exit 2 ;;
esac
""",
    "useradd": r"""
printf 'useradd %s\n' "$*" >>"$STUB_LOG"
for name; do :; done
mkdir -p "$STUB_STATE/users"
echo "$*" >"$STUB_STATE/users/$name"
""",
    "userdel": r"""
printf 'userdel %s\n' "$*" >>"$STUB_LOG"
for name; do :; done
rm -f "$STUB_STATE/users/$name"
""",
    "runuser": r"""
printf 'runuser %s\n' "$*" >>"$STUB_LOG"
[ "$1" = -u ] || exit 64
shift 2
[ "$1" = -- ] && shift
exec "$@"
""",
    "chown": r"""
printf 'chown %s\n' "$*" >>"$STUB_LOG"
""",
    "ip": r"""
printf 'ip %s\n' "$*" >>"$STUB_LOG"
taps="$STUB_STATE/taps"
mkdir -p "$taps"
case "$*" in
  "-o link show"*) for tap in "$taps"/*; do [ -e "$tap" ] && echo "7: $(basename "$tap"): <BROADCAST> mtu 1500"; done; exit 0 ;;
  "link show "*) [ -e "$taps/$3" ] ;;
  "tuntap add dev "*) [ -n "${STUB_TUNTAP_FAIL:-}" ] && exit 1; echo "$*" >"$taps/$4" ;;
  "link delete "*) rm -f "$taps/$3" ;;
  *) exit 0 ;;
esac
""",
    "nft": r"""
printf 'nft %s\n' "$*" >>"$STUB_LOG"
case "$*" in
  "-c -f "*) [ -z "${STUB_NFT_CHECK_FAIL:-}" ] ;;
  "-f "*) [ -z "${STUB_NFT_LOAD_FAIL:-}" ] && cp "$2" "$STUB_STATE/nft-table" ;;
  "list table inet code_reviewer_wall") [ -f "$STUB_STATE/nft-table" ] && [ -z "${STUB_NFT_LIST_FAIL:-}" ] && echo "table inet code_reviewer_wall" ;;
  "delete table inet code_reviewer_wall") rm -f "$STUB_STATE/nft-table" ;;
  *) exit 1 ;;
esac
""",
    "curl": r"""
printf 'curl %s\n' "$*" >>"$STUB_LOG"
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in -o) out="$2"; shift ;; https://*|http://*) url="$1" ;; esac
  shift
done
[ -z "${STUB_CURL_FAIL:-}" ] || exit 7
name="${url##*/}"
[ -f "$STUB_SERVED/$name" ] || exit 22
cp "$STUB_SERVED/$name" "$out"
""",
    "resize2fs": 'exit 0',
    "e2fsck": 'exit 0',
    "cp": r"""
case "$*" in
  *--reflink=always*)
    [ -n "${STUB_REFLINK:-}" ] || exit 1
    args=""
    for each; do [ "$each" = --reflink=always ] || args="$args $each"; done
    # shellcheck disable=SC2086
    exec /bin/cp $args ;;
esac
exec /bin/cp "$@"
""",
}


@dataclass
class Machine:
    root: Path
    bin: Path
    state: Path
    log: Path
    served: Path
    program_channel: Path
    vm_channel: Path
    release: Release
    # The directory tree of a machine that has nothing of ours, for "nothing is left behind".
    baseline: dict[str, str] = field(default_factory=dict)

    # -- paths ----------------------------------------------------------------------------------

    def path(self, *parts: str) -> Path:
        return self.root.joinpath(*parts)

    @property
    def unit(self) -> Path:
        return self.path("etc/systemd/system/factory-runner.service")

    @property
    def opt(self) -> Path:
        return self.path("opt/code-reviewer")

    @property
    def state_dir(self) -> Path:
        return self.path("var/lib/code-reviewer")

    @property
    def conf(self) -> Path:
        return self.path("etc/code-reviewer")

    @property
    def host_script(self) -> Path:
        return self.opt / "current" / "libexec" / "host.sh"

    # -- running --------------------------------------------------------------------------------

    def environment(self, env: dict[str, str] | None = None) -> dict[str, str]:
        return {
            "PATH": f"{self.bin}:/usr/bin:/bin",
            "HOME": str(self.root),
            "FACTORY_RUNNER_ROOT": str(self.root),
            "STUB_LOG": str(self.log),
            "STUB_STATE": str(self.state),
            "STUB_SERVED": str(self.served),
            **(env or {}),
        }

    def run_script(
        self,
        script: Path,
        *args: str,
        env: dict[str, str] | None = None,
        stdin: str = "",
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["/bin/sh", str(script), *args],
            env=self.environment(env),
            input=stdin,
            capture_output=True,
            text=True,
            check=False,
            timeout=120,
            # No controlling terminal: nothing can be asked, as in a cron job.
            start_new_session=True,
        )

    def install(
        self,
        *args: str,
        env: dict[str, str] | None = None,
        token: bool = True,
        channels: bool = True,
        stdin: str = "",
    ) -> subprocess.CompletedProcess[str]:
        channel_args = (
            ["--program-channel-file", str(self.program_channel), "--vm-channel-file", str(self.vm_channel)]
            if channels
            else []
        )
        variables = {"FACTORY_RUNNER_TOKEN": TOKEN} if token else {}
        return self.run_script(
            SCRIPT, *channel_args, *args, env={**variables, **(env or {})}, stdin=stdin
        )

    def host(
        self, *args: str, env: dict[str, str] | None = None
    ) -> subprocess.CompletedProcess[str]:
        """The script the installed machine runs: the one inside the current program release."""
        return self.run_script(self.host_script, *args, env=env)

    def publish(self, release: Release | None = None) -> None:
        (release or self.release).publish(self.served)

    # -- looking --------------------------------------------------------------------------------

    def calls(self, prefix: str = "") -> list[str]:
        lines = self.log.read_text().splitlines() if self.log.exists() else []
        return [line for line in lines if line.startswith(prefix)]

    def tree(self) -> dict[str, str]:
        """Every path under the root with its kind (and a link's target)."""
        found: dict[str, str] = {}
        for current, directories, names in os.walk(self.root):
            for name in (*directories, *names):
                path = Path(current) / name
                relative = str(path.relative_to(self.root))
                if path.is_symlink():
                    found[relative] = f"link:{os.readlink(path)}"
                else:
                    found[relative] = "dir" if path.is_dir() else "file"
        return found

    def release_of(self, link: str, *, parent: Path | None = None) -> str | None:
        """The release a `current`/`previous`/`artifacts` link points at: its directory name."""
        target = (parent or self.opt) / link
        return Path(os.readlink(target)).name if target.is_symlink() else None

    @property
    def taps(self) -> list[str]:
        folder = self.state / "taps"
        return sorted(path.name for path in folder.iterdir()) if folder.exists() else []

    @property
    def user_exists(self) -> bool:
        return (self.state / "users" / "factory-runner").exists()

    @property
    def table_loaded(self) -> bool:
        return (self.state / "nft-table").exists()


def new_machine(tmp_path: Path, release: Release | None = None) -> Machine:
    """A machine that satisfies every preflight and has nothing of ours."""
    root, bin_dir, state = tmp_path / "root", tmp_path / "bin", tmp_path / "state"
    for folder in (
        "run/systemd/system",
        "dev",
        "sys/fs/cgroup",
        "etc/systemd/system",
        "usr/local/bin",
        "usr/local/lib",
        "var/lib",
        "opt",
    ):
        (root / folder).mkdir(parents=True)
    (root / "dev" / "kvm").write_text("")
    (root / "sys/fs/cgroup/cgroup.controllers").write_text("cpuset cpu io memory pids\n")
    bin_dir.mkdir()
    state.mkdir()
    for name, body in STUBS.items():
        path = bin_dir / name
        path.write_text(f"#!/bin/sh\n{body.strip()}\n")
        path.chmod(0o755)
    served = tmp_path / "served"
    published = release or Release()
    published.publish(served)
    program_channel, vm_channel = published.write_channels(tmp_path / "channels")
    log = tmp_path / "calls.log"
    machine = Machine(root, bin_dir, state, log, served, program_channel, vm_channel, published)
    machine.baseline = machine.tree()
    return machine

