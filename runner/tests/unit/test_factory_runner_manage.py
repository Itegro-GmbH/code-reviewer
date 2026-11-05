# SPDX-License-Identifier: LicenseRef-Proprietary

"""`factory-runner config set`, `credential` and `update` (#855, R2): the settings of a runner live
in its file and are changed on the device, the credential is renewed there and never shown, and an
update is only ever staged: verified, and never during a job."""

import io
import json
import stat
from pathlib import Path
from typing import Any

import pytest
from release_support import (
    DIGEST,
    MANIFEST_URL,
    REPOSITORY,
    SIGNATURE_URL,
    Release,
    fetcher,
)

from code_reviewer_runner.factory_runner.app_client import ApiError, Revoked
from code_reviewer_runner.factory_runner.base import (
    EXIT_CONFIG,
    EXIT_FAILED,
    EXIT_OK,
    EXIT_REVOKED,
    EXIT_USAGE,
)
from code_reviewer_runner.factory_runner.cli import CliSeams, main
from code_reviewer_runner.factory_runner.config import (
    Limits,
    RunnerConfig,
    load_config,
    save_config,
)
from code_reviewer_runner.factory_runner.update import (
    CURRENT_REFERENCE,
    PREVIOUS_REFERENCE,
    RELEASE_LABEL,
    UpdateError,
    load_channel,
    verified_manifest,
)
from code_reviewer_runner.implementer.docker_api import DockerError

pytestmark = pytest.mark.unit

CREDENTIAL = "crc_" + "A" * 43
RENEWED = "crc_" + "B" * 43


class Client:
    def __init__(self, *, error: Exception | None = None) -> None:
        self.error = error
        self.renewals = 0

    def renew(self) -> str:
        self.renewals += 1
        if self.error is not None:
            raise self.error
        return RENEWED


class Daemon:
    """The images of a daemon, by reference, and the calls made about them."""

    def __init__(self, *, release: int, label: int | None = None) -> None:
        self.images: dict[str, dict[str, Any]] = {
            "own-image": {"Config": {"Labels": {RELEASE_LABEL: str(release)}}}
        }
        # The release number the image carries that a pull of the digest brings (None: nothing).
        self.label = label
        self.calls: list[tuple[str, str]] = []

    def inspect_container(self, name: str) -> dict[str, Any]:
        return {"Image": "own-image"}

    def inspect_image(self, reference: str) -> dict[str, Any]:
        if reference not in self.images:
            raise DockerError(404, "no such image")
        return self.images[reference]

    def request(self, method: str, path: str, *args: Any, **kwargs: Any) -> Any:
        self.calls.append((method, path))
        if path.startswith("/images/create"):
            assert path == f"/images/create?fromImage={REPOSITORY}&tag={DIGEST}"
            if self.label is not None:
                self.images[f"{REPOSITORY}@{DIGEST}"] = {
                    "Config": {"Labels": {RELEASE_LABEL: str(self.label)}}
                }
            return None
        if method == "POST" and "/tag?" in path:
            source = path.split("/images/")[1].split("/tag?")[0]
            target = path.split("repo=")[1].replace("&tag=", ":")
            if source not in self.images:
                raise DockerError(404, "no such image")
            self.images[target] = self.images[source]
        if method == "DELETE":
            self.images.pop(path.split("/images/")[1], None)
        return None


def invoke(
    tmp_path: Path,
    *argv: str,
    client: Client | None = None,
    daemon: Daemon | None = None,
    release: Release | None = None,
    served: dict[str, bytes] | None = None,
    **env: str,
) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    seams = CliSeams(
        client=lambda _url, _credential: client or Client(),  # type: ignore[arg-type,return-value]
        now=lambda: 10 * 86400.0,
        hostname=lambda: "box",
        docker=lambda: daemon,  # type: ignore[arg-type,return-value]
        channel=lambda: None if release is None else release.channel(),
        fetch=fetcher(
            served if served is not None else ({} if release is None else release.served())
        ),
    )
    code = main(
        list(argv),
        environment={"FACTORY_RUNNER_HOME": str(tmp_path / "home"), **env},
        seams=seams,
        out=out,
        err=err,
        stdin=io.StringIO(),
    )
    return code, out.getvalue(), err.getvalue()


def register(tmp_path: Path, **changes: Any) -> dict[str, str]:
    environment = {"FACTORY_RUNNER_HOME": str(tmp_path / "home")}
    save_config(
        RunnerConfig(
            url="https://app.example",
            name="box",
            labels=("linux",),
            credential=CREDENTIAL,
            runner_id="r1",
            credential_renewed_at=3 * 86400.0,
            limits=Limits(cpus=2),
            **changes,
        ),
        environment,
    )
    return environment


# -- config set --------------------------------------------------------------------------------


def test_config_set_changes_labels_limits_and_parallelism_and_keeps_the_rest(
    tmp_path: Path,
) -> None:
    environment = register(tmp_path)

    code, out, _ = invoke(
        tmp_path,
        "config", "set",
        "--labels", "Linux,GPU",
        "--memory-mb", "8192",
        "--disk-gb", "40",
        "--parallel", "1",
    )  # fmt: skip

    assert code == EXIT_OK
    config = load_config(environment)
    assert config.labels == ("linux", "gpu")
    assert config.limits == Limits(cpus=2, memory_mb=8192, disk_gb=40, parallel_runs=1)
    assert (config.credential, config.runner_id, config.name) == (CREDENTIAL, "r1", "box")
    assert "restart" in out
    path = tmp_path / "home" / "config.json"
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_a_limit_is_removed_with_none_and_a_wrong_value_changes_nothing(tmp_path: Path) -> None:
    environment = register(tmp_path)
    path = tmp_path / "home" / "config.json"
    before = path.read_text()

    code, _, err = invoke(tmp_path, "config", "set", "--cpus", "none")
    assert code == EXIT_OK
    assert load_config(environment).limits.cpus is None

    path.write_text(before)
    code, _, err = invoke(tmp_path, "config", "set", "--labels", "ok", "--memory-mb", "lots")
    assert code == EXIT_CONFIG
    assert "memoryMb" in err
    assert path.read_text() == before  # the label was not saved either


def test_more_than_one_job_at_a_time_is_refused_with_the_reason(tmp_path: Path) -> None:
    register(tmp_path)

    code, _, err = invoke(tmp_path, "config", "set", "--parallel", "3")

    assert code == EXIT_CONFIG
    assert "one job at a time" in err


def test_auto_update_is_a_switch_and_config_show_has_it(tmp_path: Path) -> None:
    register(tmp_path)

    assert invoke(tmp_path, "config", "set", "--auto-update", "off")[0] == EXIT_OK
    _, out, _ = invoke(tmp_path, "config", "show")

    assert json.loads(out)["autoUpdate"] is False
    assert invoke(tmp_path, "config", "set", "--auto-update", "maybe")[0] == EXIT_CONFIG


def test_config_set_without_a_setting_is_a_usage_error_and_needs_a_registration(
    tmp_path: Path,
) -> None:
    code, _, err = invoke(tmp_path, "config", "set", "--cpus", "2")
    assert code == EXIT_CONFIG
    assert "register" in err

    register(tmp_path)
    assert invoke(tmp_path, "config", "set")[0] == EXIT_USAGE


def test_config_set_says_when_the_environment_wins_over_the_file(tmp_path: Path) -> None:
    register(tmp_path)

    _, _, err = invoke(tmp_path, "config", "set", "--labels", "a", FACTORY_RUNNER_LABELS="b")

    assert "FACTORY_RUNNER_LABELS" in err


# -- credential --------------------------------------------------------------------------------


def test_credential_show_says_set_and_its_age_but_never_the_value(tmp_path: Path) -> None:
    register(tmp_path)

    code, out, err = invoke(tmp_path, "credential", "show")

    assert code == EXIT_OK
    assert "set (from the file)" in out
    assert "7 days ago" in out
    assert CREDENTIAL not in out + err


def test_credential_show_without_one_says_not_set(tmp_path: Path) -> None:
    assert invoke(tmp_path, "credential", "show")[1] == "credential: not set\n"


def test_credential_renew_saves_the_new_one_before_anything_uses_it(tmp_path: Path) -> None:
    environment = register(tmp_path)
    client = Client()

    code, out, err = invoke(tmp_path, "credential", "renew", client=client)

    assert code == EXIT_OK
    config = load_config(environment)
    assert config.credential == RENEWED
    assert config.credential_renewed_at == 10 * 86400.0
    assert client.renewals == 1
    assert RENEWED not in out + err


@pytest.mark.parametrize(
    ("error", "code"),
    [(Revoked("no", 401), EXIT_REVOKED), (ApiError("down"), EXIT_FAILED)],
)
def test_a_renewal_that_fails_leaves_the_credential_alone(
    tmp_path: Path, error: Exception, code: int
) -> None:
    environment = register(tmp_path)

    assert invoke(tmp_path, "credential", "renew", client=Client(error=error))[0] == code
    assert load_config(environment).credential == CREDENTIAL


def test_a_credential_from_the_environment_is_not_renewed_here(tmp_path: Path) -> None:
    register(tmp_path)
    client = Client()

    code, _, _ = invoke(
        tmp_path, "credential", "renew", client=client, FACTORY_RUNNER_CREDENTIAL=RENEWED
    )

    assert code == EXIT_CONFIG
    assert client.renewals == 0


# -- update ------------------------------------------------------------------------------------


def test_update_stages_a_newer_signed_release_and_keeps_the_one_before(tmp_path: Path) -> None:
    daemon = Daemon(release=4, label=7)
    daemon.images[CURRENT_REFERENCE] = {"Id": "old"}

    code, out, _ = invoke(tmp_path, "update", daemon=daemon, release=Release(release=7))

    assert code == EXIT_OK
    # What was pulled is the digest the signed manifest names, never a tag.
    assert ("POST", f"/images/create?fromImage={REPOSITORY}&tag={DIGEST}") in daemon.calls
    assert daemon.images[CURRENT_REFERENCE] is daemon.images[f"{REPOSITORY}@{DIGEST}"]
    assert daemon.images[PREVIOUS_REFERENCE] == {"Id": "old"}
    assert "release 7" in out and "after the job" in out


def test_update_with_nothing_newer_pulls_and_stages_nothing(tmp_path: Path) -> None:
    daemon = Daemon(release=7, label=7)

    code, out, _ = invoke(tmp_path, "update", daemon=daemon, release=Release(release=7))

    assert code == EXIT_OK
    assert "up to date" in out
    assert CURRENT_REFERENCE not in daemon.images
    assert not any(path.startswith("/images/create") for _, path in daemon.calls)


def test_an_older_signed_manifest_served_again_is_no_way_back(tmp_path: Path) -> None:
    daemon = Daemon(release=7, label=3)

    invoke(tmp_path, "update", daemon=daemon, release=Release(release=3))

    assert CURRENT_REFERENCE not in daemon.images
    assert not any(path.startswith("/images/create") for _, path in daemon.calls)


def test_a_manifest_that_somebody_else_signed_pulls_nothing(tmp_path: Path) -> None:
    ours, theirs = Release(release=9), Release(release=9)
    served = {MANIFEST_URL: theirs.manifest(), SIGNATURE_URL: theirs.signature()}
    daemon = Daemon(release=1, label=9)

    code, _, err = invoke(tmp_path, "update", daemon=daemon, release=ours, served=served)

    assert code == EXIT_FAILED
    assert "not our release" in err
    assert daemon.calls == []  # not even a pull


def test_an_image_that_is_not_the_release_its_manifest_names_is_removed_and_not_named(
    tmp_path: Path,
) -> None:
    daemon = Daemon(release=1, label=5)  # the manifest says 9

    code, _, err = invoke(tmp_path, "update", daemon=daemon, release=Release(release=9))

    assert code == EXIT_FAILED
    assert "not the release its manifest names" in err
    assert CURRENT_REFERENCE not in daemon.images
    assert f"{REPOSITORY}@{DIGEST}" not in daemon.images


def test_a_registry_that_cannot_be_reached_is_no_update_and_no_traceback(tmp_path: Path) -> None:
    daemon = Daemon(release=1, label=None)  # the pull brings nothing

    code, _, err = invoke(tmp_path, "update", daemon=daemon, release=Release(release=9))

    assert code == EXIT_FAILED
    assert "no update" in err


def test_without_a_release_channel_in_the_image_there_is_nothing_to_update_from(
    tmp_path: Path,
) -> None:
    code, _, err = invoke(tmp_path, "update", daemon=Daemon(release=1))

    assert code == EXIT_FAILED
    assert "no release channel" in err


def test_rollback_points_current_back_at_the_image_before(tmp_path: Path) -> None:
    daemon = Daemon(release=4)
    daemon.images[PREVIOUS_REFERENCE] = {"Id": "old"}

    assert invoke(tmp_path, "update", "--rollback", daemon=daemon)[0] == EXIT_OK
    assert daemon.images[CURRENT_REFERENCE] == {"Id": "old"}

    assert invoke(tmp_path, "update", "--rollback", daemon=Daemon(release=1))[0] == (EXIT_FAILED)


# -- the proof ---------------------------------------------------------------------------------


def test_a_manifest_is_good_only_with_the_channels_key_and_for_the_channels_repository() -> None:
    release = Release(release=7)
    channel = release.channel()

    manifest = verified_manifest(channel, fetcher(release.served()))
    assert (manifest.repository, manifest.digest, manifest.release) == (REPOSITORY, DIGEST, 7)

    forged = release.served() | {
        MANIFEST_URL: release.manifest().replace(b'"release": 7', b'"release": 8')
    }
    with pytest.raises(UpdateError, match="not our release"):
        verified_manifest(channel, fetcher(forged))

    other = Release(repository="registry.example/another-image")
    with pytest.raises(UpdateError, match="not a manifest of this channel"):
        verified_manifest(
            channel,
            fetcher(
                {MANIFEST_URL: other.manifest(), SIGNATURE_URL: release.signature(other.manifest())}
            ),
        )


@pytest.mark.parametrize(
    "document",
    [
        b"not json",
        b'{"repository": "%s", "digest": "sha256:short", "release": 7}' % REPOSITORY.encode(),
        b'{"repository": "%s", "digest": "sha256:%s", "release": true}'
        % (REPOSITORY.encode(), b"d" * 64),
        b'{"repository": "%s", "digest": "sha256:%s", "release": 0}'
        % (REPOSITORY.encode(), b"d" * 64),
    ],
)
def test_a_signed_document_that_is_not_a_release_is_refused(document: bytes) -> None:
    release = Release()
    served = {MANIFEST_URL: document, SIGNATURE_URL: release.signature(document)}

    with pytest.raises(UpdateError, match="not a manifest of this channel"):
        verified_manifest(release.channel(), fetcher(served))


def test_a_key_that_is_not_an_ecdsa_p256_key_is_refused() -> None:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ed25519

    release = Release()
    key = (
        ed25519.Ed25519PrivateKey.generate()
        .public_key()
        .public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    )
    channel = release.channel().__class__(REPOSITORY, MANIFEST_URL, SIGNATURE_URL, key)

    with pytest.raises(UpdateError, match="not an ECDSA P-256 key"):
        verified_manifest(channel, fetcher(release.served()))


def test_the_channel_of_the_repository_is_empty_until_the_owner_fills_it() -> None:
    path = Path(__file__).resolve().parents[2] / "release-channel.json"
    assert load_channel(path) is None  # nothing is published: no runner updates by itself


def test_a_filled_channel_file_is_read_and_a_wrong_one_is_none(tmp_path: Path) -> None:
    release = Release()
    good = tmp_path / "good.json"
    good.write_text(json.dumps(release.channel_document()))
    assert load_channel(good) == release.channel()

    for change in (
        {"manifestUrl": "http://plain.example/m"},
        {"publicKey": "%%%"},
        {"repository": ""},
    ):
        bad = tmp_path / "bad.json"
        bad.write_text(json.dumps(release.channel_document() | change))
        assert load_channel(bad) is None
    assert load_channel(tmp_path / "missing.json") is None
