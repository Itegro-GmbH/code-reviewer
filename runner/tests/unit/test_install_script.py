# SPDX-License-Identifier: LicenseRef-Proprietary

"""The installer of the Factory-Runner (#855, R2): `runner/install/install.sh` against stand-ins for
`docker`, `systemctl`, `curl` and the rest, in a directory that plays the machine's root. The
signature of the release manifest is checked by the real `openssl`, against files that
`cryptography` signed, so the two implementations that have to agree (the installer's and the
runner's) do. Nothing
of the machine running the test is touched: no package, no unit, no daemon. What a real systemd and
a real daemon do with the files is the job of the first install on a machine (docs/runner.md)."""

import fcntl
import json
import os
import re
import select
import stat
import subprocess
import termios
import time
from dataclasses import dataclass
from pathlib import Path

import pytest
from release_support import DIGEST, REPOSITORY, Release

from code_reviewer_runner.factory_runner import update

pytestmark = pytest.mark.unit

RUNNER = Path(__file__).resolve().parents[2]
REPOSITORY_ROOT = RUNNER.parent
SCRIPT = RUNNER / "install" / "install.sh"
TOKEN = "crt_" + "T" * 43

DOCKER = """\
#!/bin/sh
printf 'docker %s\\n' "$*" >>"$STUB_LOG"
last=""
for last; do :; done
case "$1" in
  info) case "$*" in *SecurityOptions*) echo "[name=seccomp,profile=builtin]" ;; esac ;;
  pull) ;;
  image)
    if [ "$2" = inspect ]; then
      case "$*" in
        *RepoDigests*) echo "${STUB_REPODIGESTS:-}" ;;
        *Labels*)
          if [ "$last" = factory-runner:current ]; then
            [ -f "$STUB_STATE/current.release" ] && cat "$STUB_STATE/current.release" || exit 1
          else
            echo "${STUB_LABEL:-7}"
          fi ;;
        *.Id*)
          if [ "$last" = factory-runner:current ]; then
            [ -f "$STUB_STATE/current.id" ] && cat "$STUB_STATE/current.id" || exit 1
          else
            echo "${STUB_NEW_ID:-id-new}"
          fi ;;
        *) [ -f "$STUB_STATE/current" ] || exit 1 ;;
      esac
    fi ;;
  images) [ -f "$STUB_STATE/current" ] && echo abc123 || true ;;
  tag)
    case "$3" in
      factory-runner:current)
        touch "$STUB_STATE/current"
        echo "${STUB_NEW_ID:-id-new}" >"$STUB_STATE/current.id"
        echo "${STUB_LABEL:-7}" >"$STUB_STATE/current.release" ;;
      factory-runner:previous)
        touch "$STUB_STATE/previous"
        cp "$STUB_STATE/current.id" "$STUB_STATE/previous.id" ;;
    esac ;;
  ps) [ -n "${STUB_CONTAINERS:-}" ] && echo "${STUB_CONTAINERS}" || true ;;
  run)
    case "$*" in
      *rejected-release*) echo "${STUB_REJECTED:-}" ;;
      *credential*show*)
        cat >"$STUB_STATE/credential-stdin"
        if [ -f "$STUB_STATE/registered" ]; then
          echo "credential: set"
        else
          echo "credential: not set"
        fi ;;
      *register*) cat >"$STUB_STATE/register-stdin"; touch "$STUB_STATE/registered" ;;
      *config*set*) cat >"$STUB_STATE/config-stdin" ;;
    esac ;;
esac
exit 0
"""


@dataclass
class Machine:
    root: Path
    bin: Path
    state: Path
    log: Path
    # What the release addresses answer (the stand-in `curl` copies from here by file name).
    served: Path
    channel: Path
    release: Release

    def run(
        self,
        *args: str,
        env: dict[str, str] | None = None,
        stdin: str | None = None,
        channel: bool = True,
    ) -> subprocess.CompletedProcess[str]:
        variables = {
            "PATH": f"{self.bin}:/usr/bin:/bin",
            "HOME": str(self.root),
            "FACTORY_RUNNER_ROOT": str(self.root),
            "FACTORY_RUNNER_NO_SYSTEMCTL": "",
            "STUB_LOG": str(self.log),
            "STUB_STATE": str(self.state),
            "STUB_SERVED": str(self.served),
            **(env or {}),
        }
        return subprocess.run(
            [
                "/bin/sh",
                str(SCRIPT),
                *(["--channel-file", str(self.channel)] if channel else []),
                *args,
            ],
            env=variables,
            input=stdin if stdin is not None else "",
            capture_output=True,
            text=True,
            check=False,
            timeout=60,
            # No controlling terminal: nothing can be asked, as under `curl | sh` in a cron job.
            start_new_session=True,
        )

    def environment(self, env: dict[str, str] | None = None) -> dict[str, str]:
        return {
            "PATH": f"{self.bin}:/usr/bin:/bin",
            "HOME": str(self.root),
            "FACTORY_RUNNER_ROOT": str(self.root),
            "FACTORY_RUNNER_NO_SYSTEMCTL": "",
            "STUB_LOG": str(self.log),
            "STUB_STATE": str(self.state),
            "STUB_SERVED": str(self.served),
            **(env or {}),
        }

    def run_piped(
        self, text: str, *args: str, env: dict[str, str] | None = None
    ) -> subprocess.CompletedProcess[str]:
        """`curl ... | sh -s -- ARGS`: the shell reads the script from its standard input."""
        return subprocess.run(
            ["/bin/sh", "-s", "--", "--channel-file", str(self.channel), *args],
            env=self.environment(env),
            input=text,
            capture_output=True,
            text=True,
            check=False,
            timeout=60,
            start_new_session=True,
        )

    def run_on_terminal(
        self, *args: str, answers: dict[str, str], env: dict[str, str] | None = None
    ) -> tuple[int, str]:
        """The script with a controlling terminal, as an administrator runs it. `answers` maps a
        text the terminal shows (a prompt) to what is typed when it appears. Returns the exit
        code and everything the terminal showed."""
        master, slave = os.openpty()
        process = subprocess.Popen(
            ["/bin/sh", str(SCRIPT), "--channel-file", str(self.channel), *args],
            env=self.environment(env),
            stdin=slave,
            stdout=slave,
            stderr=slave,
            start_new_session=True,
            preexec_fn=lambda: fcntl.ioctl(0, termios.TIOCSCTTY, 1),
        )
        os.close(slave)
        shown = b""
        pending = dict(answers)
        deadline = time.monotonic() + 60
        try:
            while time.monotonic() < deadline:
                ready, _, _ = select.select([master], [], [], 1.0)
                if not ready:
                    continue
                try:
                    chunk = os.read(master, 4096)
                except OSError:  # the other end is closed: the script has ended
                    break
                if not chunk:
                    break
                shown += chunk
                for prompt, typed in list(pending.items()):
                    if prompt.encode() in shown:
                        del pending[prompt]
                        time.sleep(0.3)  # the script switches the echo off right after asking
                        os.write(master, typed.encode())
            code = process.wait(timeout=30)
        finally:
            os.close(master)
        return code, shown.decode(errors="replace")

    def install_image(self, *, release: int, image_id: str) -> None:
        """An image that is `current` already."""
        (self.state / "current").touch()
        (self.state / "current.id").write_text(image_id)
        (self.state / "current.release").write_text(str(release))

    def calls(self) -> list[str]:
        return self.log.read_text().splitlines() if self.log.exists() else []

    @property
    def unit(self) -> Path:
        return self.root / "etc" / "systemd" / "system" / "factory-runner.service"

    @property
    def command(self) -> Path:
        return self.root / "usr" / "local" / "bin" / "factory-runner"


def stub(path: Path, body: str) -> None:
    path.write_text(f"#!/bin/sh\n{body}\n")
    path.chmod(0o755)


@pytest.fixture
def machine(tmp_path: Path) -> Machine:
    root, bin_dir, state = tmp_path / "root", tmp_path / "bin", tmp_path / "state"
    (root / "run" / "systemd" / "system").mkdir(parents=True)
    bin_dir.mkdir()
    state.mkdir()
    (bin_dir / "docker").write_text(DOCKER)
    (bin_dir / "docker").chmod(0o755)
    stub(bin_dir / "id", "echo 0")
    stub(bin_dir / "uname", 'case "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac')
    stub(
        bin_dir / "systemctl",
        'printf "systemctl %s\\n" "$*" >>"$STUB_LOG"; '
        'case "$1" in is-active) [ -f "$STUB_STATE/active" ] ;; esac',
    )
    stub(
        bin_dir / "curl",
        'printf "curl %s\\n" "$*" >>"$STUB_LOG"; out=""; url=""; '
        'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; https://*) url="$1" ;; esac; '
        'shift; done; name="${url##*/}"; '
        '[ -f "$STUB_SERVED/$name" ] && cp "$STUB_SERVED/$name" "$out" || echo junk >"$out"',
    )
    stub(bin_dir / "apt-get", 'printf "apt-get %s\\n" "$*" >>"$STUB_LOG"')
    stub(bin_dir / "jq", "true")
    served = tmp_path / "served"
    release = Release(release=7)
    write_release(release, served)
    return Machine(
        root,
        bin_dir,
        state,
        tmp_path / "calls.log",
        served,
        served / "release-channel.json",
        release,
    )


def write_release(release: Release, folder: Path) -> None:
    """The files the owner publishes, and the channel that names them."""
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "manifest.json").write_bytes(release.manifest())
    (folder / "manifest.sig").write_bytes(release.signature())
    (folder / "release-channel.json").write_text(json.dumps(release.channel_document(), indent=2))


def test_the_install_verifies_the_manifest_pulls_its_digest_writes_the_unit_and_starts(
    machine: Machine,
) -> None:
    done = machine.run(
        "--labels", "linux,gpu", "--name", "build box", env={"FACTORY_RUNNER_TOKEN": TOKEN}
    )

    assert done.returncode == 0, done.stderr
    calls = machine.calls()
    # The manifest and its signature were fetched, proved, and only then was the digest pulled.
    fetched = [call for call in calls if call.startswith("curl")]
    assert any("manifest.json" in call for call in fetched)
    assert any("manifest.sig" in call for call in fetched)
    assert f"docker pull -q {REPOSITORY}@{DIGEST}" in calls
    assert f"docker tag {REPOSITORY}@{DIGEST} factory-runner:current" in calls
    assert done.stdout.count("verified release 7") == 1
    unit = machine.unit.read_text()
    for part in (
        "--stop-timeout 150",
        "-v /var/run/docker.sock:/run/docker.sock",
        "-v factory-runner-work:/work",
        "-v factory-runner-home:/var/lib/factory-runner",
        "-e FACTORY_RUNNER_IMAGE_TAG=factory-runner:current",
        "factory-runner:current run",
        "RestartPreventExitStatus=4 6 9",
    ):
        assert part in unit
    assert "--privileged" not in unit and "--network host" not in unit
    assert "systemctl start factory-runner" in calls
    assert "systemctl enable factory-runner" in calls
    assert machine.command.stat().st_mode & stat.S_IXUSR


def test_the_token_is_never_in_an_argument_or_in_the_files_only_on_standard_input(
    machine: Machine,
) -> None:
    done = machine.run("--labels", "linux", env={"FACTORY_RUNNER_TOKEN": TOKEN})

    assert done.returncode == 0, done.stderr
    assert (machine.state / "register-stdin").read_text() == TOKEN
    register = next(call for call in machine.calls() if "register" in call)
    assert "--token-file -" in register
    everything = "\n".join(machine.calls()) + machine.unit.read_text() + machine.command.read_text()
    assert TOKEN not in everything + done.stdout + done.stderr


@pytest.mark.parametrize("flag", ["--token", "--token=" + TOKEN])
def test_a_token_as_an_argument_is_refused_and_not_echoed(machine: Machine, flag: str) -> None:
    arguments = [flag] if "=" in flag else [flag, TOKEN]

    done = machine.run(*arguments)

    assert done.returncode != 0
    assert "never an argument" in done.stderr
    assert TOKEN not in done.stdout + done.stderr
    assert not machine.unit.exists()


def test_the_token_comes_from_a_file_or_from_standard_input(
    machine: Machine, tmp_path: Path
) -> None:
    file = tmp_path / "token"
    file.write_text(TOKEN + "\n")
    assert machine.run("--token-file", str(file)).returncode == 0
    assert (machine.state / "register-stdin").read_text() == TOKEN

    (machine.state / "registered").unlink()
    (machine.state / "register-stdin").unlink()
    done = machine.run("--token-file", "-", stdin=TOKEN + "\n")
    assert done.returncode == 0, done.stderr
    assert (machine.state / "register-stdin").read_text() == TOKEN


def test_a_token_of_the_wrong_form_is_refused_before_anything_is_registered(
    machine: Machine,
) -> None:
    done = machine.run(env={"FACTORY_RUNNER_TOKEN": "not-a-token-" + "x" * 10})

    assert done.returncode != 0
    assert "form of a token" in done.stderr and "x" * 10 not in done.stderr
    assert not (machine.state / "registered").exists()


def test_a_second_run_registers_nothing_again_and_does_not_restart_a_running_service(
    machine: Machine,
) -> None:
    assert machine.run(env={"FACTORY_RUNNER_TOKEN": TOKEN}).returncode == 0
    (machine.state / "active").touch()
    machine.log.write_text("")
    unit_before = machine.unit.stat().st_mtime_ns

    done = machine.run(env={"FACTORY_RUNNER_TOKEN": TOKEN})

    assert done.returncode == 0, done.stderr
    calls = machine.calls()
    assert not any("register" in call for call in calls)
    assert "systemctl start factory-runner" not in calls
    assert not any(call.startswith("systemctl restart") for call in calls)
    assert machine.unit.stat().st_mtime_ns == unit_before  # the same unit is not written again
    assert "it is not restarted" in done.stdout


def test_a_setting_passed_to_a_registered_machine_is_applied_with_config_set(
    machine: Machine,
) -> None:
    assert machine.run(env={"FACTORY_RUNNER_TOKEN": TOKEN}).returncode == 0

    done = machine.run("--labels", "linux,gpu", "--disk-gb", "40")

    assert done.returncode == 0, done.stderr
    assert any("config set --labels linux,gpu --disk-gb 40" in call for call in machine.calls())


def test_a_manifest_that_somebody_else_signed_installs_nothing_and_pulls_nothing(
    machine: Machine,
) -> None:
    write_release(Release(release=7), machine.served / "forged")
    for name in ("manifest.json", "manifest.sig"):  # their manifest and signature, our channel
        (machine.served / name).write_bytes((machine.served / "forged" / name).read_bytes())

    done = machine.run(env={"FACTORY_RUNNER_TOKEN": TOKEN})

    assert done.returncode != 0
    assert "not our release" in done.stderr
    assert not machine.unit.exists() and not machine.command.exists()
    assert not any(call.startswith(("docker pull", "docker tag")) for call in machine.calls())


def test_a_manifest_changed_after_it_was_signed_is_refused(machine: Machine) -> None:
    manifest = machine.served / "manifest.json"
    manifest.write_bytes(manifest.read_bytes().replace(b'"release": 7', b'"release": 8'))

    done = machine.run(env={"FACTORY_RUNNER_TOKEN": TOKEN})

    assert done.returncode != 0 and "not our release" in done.stderr
    assert not any(call.startswith("docker pull") for call in machine.calls())


def test_an_image_that_is_not_the_release_its_manifest_names_is_removed(machine: Machine) -> None:
    done = machine.run(env={"FACTORY_RUNNER_TOKEN": TOKEN, "STUB_LABEL": "3"})

    assert done.returncode != 0 and "not the release its manifest names" in done.stderr
    assert any(call.startswith("docker rmi") for call in machine.calls())
    assert not any(call.startswith("docker tag") for call in machine.calls())
    assert not machine.unit.exists()


def test_with_the_release_channel_of_the_repository_nothing_is_installed_until_it_is_filled(
    machine: Machine,
) -> None:
    empty = RUNNER / "release-channel.json"

    done = machine.run(
        "--channel-file", str(empty), channel=False, env={"FACTORY_RUNNER_TOKEN": TOKEN}
    )

    assert done.returncode != 0
    assert "no runner image is published yet" in done.stderr
    assert not machine.unit.exists()


def test_without_a_token_the_service_is_installed_and_not_started(machine: Machine) -> None:
    done = machine.run()

    assert done.returncode == 0, done.stderr
    assert machine.unit.exists()
    assert "systemctl start factory-runner" not in machine.calls()
    assert "no registration token" in done.stdout


def test_a_dry_run_says_what_it_would_do_and_changes_nothing(machine: Machine) -> None:
    done = machine.run("--dry-run", "--sysbox", "--yes", env={"FACTORY_RUNNER_TOKEN": TOKEN})

    assert done.returncode == 0, done.stderr
    assert "dry run: nothing was changed" in done.stdout
    assert "would write" in done.stdout and "would run: download the manifest" in done.stdout
    assert not machine.unit.exists() and not machine.command.exists()
    changing = ("docker pull", "docker tag", "docker run", "systemctl", "apt-get", "curl")
    assert not [call for call in machine.calls() if call.startswith(changing)]


def test_a_docker_that_does_not_answer_is_told_so(machine: Machine) -> None:
    stub(machine.bin / "docker", 'case "$1" in info) exit 1 ;; esac')

    done = machine.run()

    assert done.returncode != 0 and "the Docker daemon does not answer" in done.stderr


def test_a_machine_that_is_not_systemd_or_is_not_root_is_refused(machine: Machine) -> None:
    (machine.root / "run" / "systemd" / "system").rmdir()
    assert "systemd" in machine.run().stderr

    (machine.root / "run" / "systemd" / "system").mkdir()
    stub(machine.bin / "id", "echo 1000")
    assert "run as root" in machine.run().stderr


# -- Sysbox: a step of its own -----------------------------------------------------------------


def test_sysbox_is_never_installed_without_asking_and_says_what_it_does(machine: Machine) -> None:
    done = machine.run("--sysbox", env={"FACTORY_RUNNER_TOKEN": TOKEN})

    assert done.returncode != 0
    for warning in (
        "daemon.json",
        "bip 172.20.0.1/16",
        "default-address-pools",
        "RESTARTS Docker",
        "jq",
    ):
        assert warning in done.stdout
    assert "no terminal to ask on" in done.stderr
    assert not any(call.startswith("apt-get") or "sysbox" in call for call in machine.calls())


def test_without_the_flag_the_warnings_and_the_step_do_not_appear(machine: Machine) -> None:
    done = machine.run(env={"FACTORY_RUNNER_TOKEN": TOKEN})

    assert "Sysbox" not in done.stdout
    assert not any(call.startswith("apt-get") for call in machine.calls())


def test_sysbox_waits_for_a_machine_with_no_running_container(machine: Machine) -> None:
    done = machine.run(
        "--sysbox", "--yes", env={"FACTORY_RUNNER_TOKEN": TOKEN, "STUB_CONTAINERS": "abc"}
    )

    assert done.returncode != 0 and "containers are running" in done.stderr
    assert not any(call.startswith("apt-get") for call in machine.calls())


def test_a_sysbox_package_that_is_not_the_pinned_one_is_never_installed(machine: Machine) -> None:
    done = machine.run("--sysbox", "--yes", env={"FACTORY_RUNNER_TOKEN": TOKEN})

    assert done.returncode != 0 and "not the pinned one" in done.stderr
    assert any(call.startswith("curl") and "sysbox-ce_0.7.1" in call for call in machine.calls())
    assert not any(call.startswith("apt-get") for call in machine.calls())


# -- uninstall ---------------------------------------------------------------------------------


def test_uninstall_removes_the_service_and_keeps_the_configuration_unless_purged(
    machine: Machine,
) -> None:
    assert machine.run(env={"FACTORY_RUNNER_TOKEN": TOKEN}).returncode == 0

    done = machine.run("--uninstall")

    assert done.returncode == 0, done.stderr
    assert not machine.unit.exists() and not machine.command.exists()
    assert "revoke this runner in the app" in done.stdout
    assert not any(call.startswith("docker volume rm") for call in machine.calls())

    machine.run("--uninstall", "--purge")
    assert "docker volume rm factory-runner-home factory-runner-work" in machine.calls()


# -- F1: a download that is cut off, the terminal, the standard input ---------------------------


def install_text() -> str:
    return SCRIPT.read_text()


def test_the_last_line_of_the_script_is_the_only_command_that_runs_anything() -> None:
    assert install_text().splitlines()[-1] == 'main "$@"'


# #855-F1 (S1)
def test_a_script_that_is_cut_off_anywhere_before_its_last_line_changes_nothing(
    machine: Machine,
) -> None:
    text = install_text()
    last_line = text.rindex('main "$@"')
    line_starts = [0] + [index + 1 for index, char in enumerate(text[:last_line]) if char == "\n"]
    middles = [start + 20 for start in line_starts[::5] if start + 20 < last_line]
    cuts = sorted({*line_starts, *middles, *range(last_line + 1, last_line + 4)})
    assert len(cuts) > 100

    for cut in cuts:
        done = machine.run_piped(text[:cut], env={"FACTORY_RUNNER_TOKEN": TOKEN})

        assert machine.calls() == [], f"cut at {cut}: {done.stderr[-200:]}"
        assert not machine.unit.exists() and not machine.command.exists(), cut
        assert "install: done" not in done.stdout, cut


# #855-F1 (S1)
def test_the_script_run_from_its_standard_input_installs_and_ends_with_the_marker(
    machine: Machine,
) -> None:
    done = machine.run_piped(install_text(), env={"FACTORY_RUNNER_TOKEN": TOKEN})

    assert done.returncode == 0, done.stderr
    assert done.stdout.splitlines()[-1] == "install: done"
    assert machine.unit.exists() and (machine.state / "register-stdin").read_text() == TOKEN


# #855-F1 (S2)
def test_the_token_is_asked_for_on_the_terminal_and_is_not_shown(machine: Machine) -> None:
    code, shown = machine.run_on_terminal(
        "--labels", "linux", answers={"input is hidden): ": TOKEN + "\n"}
    )

    assert code == 0, shown
    assert (machine.state / "register-stdin").read_text() == TOKEN
    assert "Registration token" in shown and TOKEN not in shown


# #855-F1 (S2)
def test_a_token_from_the_environment_works_with_a_warning_that_says_why_not(
    machine: Machine,
) -> None:
    done = machine.run(env={"FACTORY_RUNNER_TOKEN": TOKEN})

    assert done.returncode == 0, done.stderr
    assert "FACTORY_RUNNER_TOKEN" in done.stderr and "history" in done.stderr
    assert TOKEN not in done.stdout + done.stderr


# #855-F1 (S3)
def test_no_container_command_of_the_installer_reads_the_standard_input_it_was_given(
    machine: Machine,
) -> None:
    assert machine.run(env={"FACTORY_RUNNER_TOKEN": TOKEN}).returncode == 0

    done = machine.run("--labels", "linux,gpu", stdin="the rest of the script or the terminal")

    assert done.returncode == 0, done.stderr
    assert (machine.state / "config-stdin").read_text() == ""
    assert (machine.state / "credential-stdin").read_text() == ""


# #855-F1 (S11)
def test_the_hint_to_register_by_hand_is_a_command_that_works_inside_the_container(
    machine: Machine,
) -> None:
    done = machine.run()

    assert "factory-runner register --token-file - < /path/to/token-file" in done.stdout
    # The command passes the standard input on, so the file the shell opens is read by the runner.
    assert " run --rm -i " in machine.command.read_text()


# #855-F1 (N9)
def test_a_token_file_that_cannot_be_read_is_an_error_before_anything_is_changed(
    machine: Machine, tmp_path: Path
) -> None:
    done = machine.run("--token-file", str(tmp_path / "missing"))

    assert done.returncode != 0 and "does not exist or cannot be read" in done.stderr
    assert machine.calls() == [] and not machine.unit.exists()


# #855-F1 (N9)
def test_purge_without_uninstall_is_an_error(machine: Machine) -> None:
    done = machine.run("--purge")

    assert done.returncode != 0 and "--purge only goes with --uninstall" in done.stderr
    assert not any(call.startswith("docker volume") for call in machine.calls())


# -- F1: the installer never goes back --------------------------------------------------------


# #855-F1 (S4)
def test_the_installer_leaves_a_newer_installed_release_alone(machine: Machine) -> None:
    machine.install_image(release=9, image_id="id-9")

    done = machine.run(env={"FACTORY_RUNNER_TOKEN": TOKEN})

    assert done.returncode == 0, done.stderr
    assert "the installed image stays" in done.stdout
    assert not any(call.startswith(("docker pull", "docker tag")) for call in machine.calls())
    assert (machine.state / "current.id").read_text() == "id-9"


# #855-F1 (S4)
def test_a_newer_release_becomes_current_and_the_one_before_it_previous(machine: Machine) -> None:
    machine.install_image(release=5, image_id="id-5")

    done = machine.run(env={"FACTORY_RUNNER_TOKEN": TOKEN})

    assert done.returncode == 0, done.stderr
    calls = machine.calls()
    keep = calls.index("docker tag factory-runner:current factory-runner:previous")
    take = calls.index(f"docker tag {REPOSITORY}@{DIGEST} factory-runner:current")
    assert keep < take
    assert (machine.state / "previous.id").read_text() == "id-5"
    assert (machine.state / "current.id").read_text().strip() == "id-new"


# #855-F1 (S4)
def test_previous_is_set_only_when_the_image_changes(machine: Machine) -> None:
    machine.install_image(release=5, image_id="id-new")  # the very image the manifest names

    done = machine.run(env={"FACTORY_RUNNER_TOKEN": TOKEN})

    assert done.returncode == 0, done.stderr
    assert not any(call.startswith("docker tag") for call in machine.calls())
    assert not (machine.state / "previous").exists()


# #855-F1 (B1, installer side)
def test_a_release_that_was_rolled_back_is_not_installed_again_until_a_higher_one_comes(
    machine: Machine,
) -> None:
    machine.install_image(release=6, image_id="id-6")

    rolled_back = machine.run(env={"FACTORY_RUNNER_TOKEN": TOKEN, "STUB_REJECTED": "7"})

    assert rolled_back.returncode == 0, rolled_back.stderr
    assert "was rolled back on this machine" in rolled_back.stdout
    assert not any(call.startswith(("docker pull", "docker tag")) for call in machine.calls())

    write_release(Release(release=8), machine.served)
    higher = machine.run(
        env={"FACTORY_RUNNER_TOKEN": TOKEN, "STUB_REJECTED": "7", "STUB_LABEL": "8"}
    )

    assert higher.returncode == 0, higher.stderr
    assert any(call.startswith("docker pull") for call in machine.calls())


# -- F1: https only, the unit, the order of the Sysbox step -----------------------------------


# #855-F1 (N3)
def test_every_download_is_https_only_and_each_address_of_the_channel_is_checked(
    machine: Machine,
) -> None:
    assert machine.run(env={"FACTORY_RUNNER_TOKEN": TOKEN}).returncode == 0
    fetched = [call for call in machine.calls() if call.startswith("curl")]
    assert fetched and all("--proto =https --proto-redir =https" in call for call in fetched)

    document = machine.release.channel_document()
    document["signatureUrl"] = "http://releases.example/runner/manifest.sig"
    machine.channel.write_text(json.dumps(document))

    done = machine.run(env={"FACTORY_RUNNER_TOKEN": TOKEN})

    assert done.returncode != 0 and "https address for the signature" in done.stderr


# #855-F1 (N8, S7)
def test_the_unit_rotates_the_log_and_names_the_way_back_by_hand(machine: Machine) -> None:
    assert machine.run(env={"FACTORY_RUNNER_TOKEN": TOKEN}).returncode == 0

    unit = machine.unit.read_text()

    assert "--log-opt max-size=10m --log-opt max-file=3" in unit
    assert "docker tag factory-runner:previous factory-runner:current" in unit


# #855-F1 (S6)
def test_uninstall_removes_the_images_by_name_and_by_the_digest_they_were_pulled_with(
    machine: Machine,
) -> None:
    reference = f"{REPOSITORY}@{DIGEST}"
    assert machine.run(env={"FACTORY_RUNNER_TOKEN": TOKEN}).returncode == 0

    done = machine.run("--uninstall", env={"STUB_REPODIGESTS": f"{reference} "})

    assert done.returncode == 0, done.stderr
    removal = next(call for call in machine.calls() if call.startswith("docker rmi"))
    assert removal.split() == [
        "docker",
        "rmi",
        reference,
        "factory-runner:current",
        "factory-runner:previous",
    ]


# #855-F1 (S10)
def test_sysbox_that_cannot_be_asked_about_stops_before_the_first_change(
    machine: Machine,
) -> None:
    done = machine.run("--sysbox", env={"FACTORY_RUNNER_TOKEN": TOKEN})

    assert done.returncode != 0 and "nothing was changed" in done.stderr
    assert not any(call.startswith(("docker pull", "docker tag")) for call in machine.calls())
    assert not machine.unit.exists() and not machine.command.exists()
    assert not (machine.state / "registered").exists()


# #855-F1 (S10)
def test_a_no_to_sysbox_goes_on_with_the_base_installation(machine: Machine) -> None:
    code, shown = machine.run_on_terminal(
        "--sysbox",
        answers={
            "anything else continues without it): ": "no\n",
            "input is hidden): ": TOKEN + "\n",
        },
    )

    assert code == 0, shown
    assert "continues without" in shown or "goes on without it" in shown
    assert machine.unit.exists() and (machine.state / "registered").exists()
    assert not any(call.startswith("apt-get") for call in machine.calls())
    assert not any("sysbox-ce" in call for call in machine.calls())


# #855-F1 (S10)
def test_daemon_json_is_copied_before_the_sysbox_package_is_installed(
    machine: Machine, tmp_path: Path
) -> None:
    daemon_json = tmp_path / "daemon.json"
    daemon_json.write_text('{"log-driver": "json-file"}')
    stub(machine.bin / "docker", 'case "$1" in info) echo \'{"sysbox-runc":{}}\' ;; esac')
    stub(
        machine.bin / "apt-get",
        'if [ -f "$DJ.factory-runner-backup" ]; then echo "backup existed" >>"$STUB_LOG"; fi; '
        'printf "apt-get %s\\n" "$*" >>"$STUB_LOG"',
    )
    text = install_text()
    functions = "\n".join(
        [
            re.search(r"^say\(\) .*$", text, re.MULTILINE).group(0),  # type: ignore[union-attr]
            re.search(r"^fail\(\) .*$", text, re.MULTILINE).group(0),  # type: ignore[union-attr]
            re.search(r"^install_sysbox\(\) \{.*?^\}\n", text, re.MULTILINE | re.DOTALL).group(0),  # type: ignore[union-attr]
        ]
    )
    done = subprocess.run(
        [
            "/bin/sh",
            "-c",
            "set -eu\n"
            + functions
            + '\nDOCKER_DAEMON_JSON="$DJ"\nSYSBOX_PACKAGE=/x.deb\ninstall_sysbox',
        ],
        env=machine.environment({"DJ": str(daemon_json)}),
        capture_output=True,
        text=True,
        check=False,
    )

    assert done.returncode == 0, done.stderr
    assert Path(f"{daemon_json}.factory-runner-backup").read_text() == '{"log-driver": "json-file"}'
    assert machine.calls()[-2:] == ["backup existed", "apt-get install -y /x.deb"]


# -- what has to stay equal --------------------------------------------------------------------


def shell_value(name: str) -> str:
    text = SCRIPT.read_text()
    found = re.search(rf"^{name}=(?:\"([^\"]*)\"|'([^']*)')$", text, re.MULTILINE)
    assert found is not None, name
    return found.group(1) if found.group(1) is not None else found.group(2)


def test_the_channel_the_installer_downloads_is_the_file_the_image_carries() -> None:
    channel = json.loads((RUNNER / "release-channel.json").read_text())
    dockerfile = (RUNNER / "Dockerfile.factory-runner").read_text()
    ignore = (RUNNER / "Dockerfile.factory-runner.dockerignore").read_text()

    assert set(channel) == {"version", "repository", "manifestUrl", "signatureUrl", "publicKey"}
    assert shell_value("CHANNEL_URL").endswith("/main/runner/release-channel.json")
    assert (
        "COPY --chown=0:0 --chmod=0644 release-channel.json " + str(update.CHANNEL_FILE)
        in dockerfile
    )
    assert "!release-channel.json" in ignore
    assert shell_value("CURRENT") == update.CURRENT_REFERENCE
    assert shell_value("PREVIOUS") == update.PREVIOUS_REFERENCE
    assert "FACTORY_RUNNER_IMAGE_TAG=$CURRENT" in SCRIPT.read_text()
    assert update.IMAGE_TAG_VARIABLE == "FACTORY_RUNNER_IMAGE_TAG"


def test_the_installer_and_the_runner_read_the_same_channel_file_the_same_way(
    tmp_path: Path,
) -> None:
    release = Release(release=7)
    write_release(release, tmp_path)

    channel = update.load_channel(tmp_path / "release-channel.json")

    assert channel == release.channel()
    for key, value in (
        ("repository", REPOSITORY),
        ("manifestUrl", release.channel().manifest_url),
        ("signatureUrl", release.channel().signature_url),
    ):
        script = f'. /dev/stdin <<"EOF"\n{json_functions()}\njson_value {key} "$1"\nEOF'
        found = subprocess.run(
            ["/bin/sh", "-c", script, "sh", str(tmp_path / "release-channel.json")],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        assert found == value, key


def json_functions() -> str:
    text = SCRIPT.read_text()
    match = re.search(r"^json_value\(\) .*?^}\n", text, re.MULTILINE | re.DOTALL)
    assert match is not None
    return match.group(0)


def test_sysbox_is_the_version_and_package_the_golden_snapshot_installs() -> None:
    config = (REPOSITORY_ROOT / "dispatcher" / "src" / "snapshot" / "config.ts").read_text()
    version = re.search(r'sysboxVersion: "([^"]+)"', config)
    sha = re.search(r'sysboxSha256:\s*"([0-9a-f]{64})"', config)

    assert version is not None and sha is not None
    assert shell_value("SYSBOX_VERSION") == version.group(1)
    assert shell_value("SYSBOX_SHA256") == sha.group(1)


def test_the_script_is_posix_sh_and_never_takes_a_token_from_an_argument() -> None:
    first = SCRIPT.read_text().splitlines()[0]
    assert first == "#!/bin/sh"
    assert "set -eu" in SCRIPT.read_text()
    assert subprocess.run(["/bin/sh", "-n", str(SCRIPT)], check=False).returncode == 0
    assert os.access(SCRIPT, os.R_OK)
