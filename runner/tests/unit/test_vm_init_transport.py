# SPDX-License-Identifier: LicenseRef-Proprietary

"""The listener and the connection of vm-init (#977) as far as they can be tested without a vsock
device: the listener's accept logic over a Unix socket, and the refusal on a platform without
AF_VSOCK. The AF_VSOCK sockets themselves are proven by the KVM lane of #978."""

import socket
from pathlib import Path

import pytest

from code_reviewer_runner.vm_init import transport


def _listener(path: Path) -> tuple[transport.Listener, socket.socket]:
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(str(path))
    server.listen(2)
    return transport._SocketListener(server), server  # pyright: ignore[reportPrivateUsage]


# #977-T02
@pytest.mark.parametrize("timeout", [0.0, 0.05])
def test_a_listener_with_no_connection_answers_none_after_its_time(
    tmp_path: Path, timeout: float
) -> None:
    listener, _server = _listener(tmp_path / "s")

    assert listener.accept(timeout) is None
    listener.close()


# #977-T01
def test_a_connection_made_before_the_accept_is_accepted_even_with_no_time_left(
    tmp_path: Path,
) -> None:
    listener, _server = _listener(tmp_path / "s")
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.connect(str(tmp_path / "s"))

    connection = listener.accept(0.0)

    assert connection is not None
    client.sendall(b"x")
    connection.settimeout(1.0)
    assert connection.recv(1) == b"x"
    connection.close()
    listener.close()


# #977-T02
def test_a_platform_without_af_vsock_cannot_listen_or_connect(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delattr(socket, "AF_VSOCK", raising=False)

    with pytest.raises(OSError):
        transport.RealVsock().listen(5000)
    with pytest.raises(OSError):
        transport.RealVsock().connect_host(5101, 1.0)
