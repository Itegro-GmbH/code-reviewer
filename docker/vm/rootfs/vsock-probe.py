# SPDX-License-Identifier: LicenseRef-Proprietary
#
# The probe of the smoke boot (#978, the review of #977): can a program in a container open an AF_VSOCK socket? It runs INSIDE a container of
# the guest and exits 0 when the mode's expectation holds, 1 when it does not, and prints one line saying what it saw (no secret exists here).
# Every denial has a control: the same program under the Control container's profile (which allows AF_VSOCK) must say "created", so a "denied"
# can never come from a probe that could not have said otherwise. Standard library only (the images have python3).
#
#   vsock-denied      socket(AF_VSOCK, SOCK_STREAM) fails with EPERM or EACCES (Docker's default seccomp profile: the agent's container)
#   vsock-created     socket(AF_VSOCK, SOCK_STREAM) works (the control: Control's profile, runner/vm-init/control-seccomp.json)
#   ia32-unavailable  a 32-bit system call (`int 0x80`, `socketcall`) does NOT work: the process dies of SIGSEGV or gets ENOSYS. With IA32
#                     emulation in the kernel it answers EINVAL to the empty call, and the Docker profile's argument filter on `socket`
#                     would not see a 32-bit `socketcall` at all (the kernel of #976 is built without IA32 and X32 emulation)
#   ia32-available    the control of the above: the same call answers EINVAL (only on a kernel with IA32 emulation; x86_64 only)
import ctypes
import errno
import mmap
import os
import signal
import socket
import struct
import sys

AF_VSOCK = getattr(socket, "AF_VSOCK", 40)


def vsock_socket() -> tuple[bool, str]:
    try:
        sock = socket.socket(AF_VSOCK, socket.SOCK_STREAM)
    except OSError as error:
        return False, f"denied errno={errno.errorcode.get(error.errno or 0, error.errno)}"
    sock.close()
    return True, "created"


# push rbx; mov eax,102 (socketcall); xor ebx,ebx (call 0: invalid); xor ecx,ecx; int 0x80; pop rbx; ret
BLOB = bytes.fromhex("53b866000000" "31db" "31c9" "cd80" "5b" "c3")
EINVAL, ENOSYS = 22, 38


def ia32_call() -> str:
    """What `socketcall(0, 0)` through `int 0x80` does: `returned <n>` or `signal <name>`. Run in a child, which may die."""
    read, write = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(read)
        memory = mmap.mmap(-1, 4096, prot=mmap.PROT_READ | mmap.PROT_WRITE | mmap.PROT_EXEC)
        memory.write(BLOB)
        address = ctypes.addressof(ctypes.c_char.from_buffer(memory))
        result = ctypes.CFUNCTYPE(ctypes.c_int)(address)()
        os.write(write, struct.pack("i", result))
        os._exit(0)
    os.close(write)
    data = os.read(read, 4)
    os.close(read)
    _, status = os.waitpid(pid, 0)
    if os.WIFSIGNALED(status):
        return f"signal {signal.Signals(os.WTERMSIG(status)).name}"
    return f"returned {struct.unpack('i', data)[0]}" if len(data) == 4 else "no answer"


def main(mode: str) -> int:
    if mode in ("vsock-denied", "vsock-created"):
        created, text = vsock_socket()
        print(f"{mode}: {text}")
        if mode == "vsock-created":
            return 0 if created else 1
        return 0 if (not created and ("EPERM" in text or "EACCES" in text)) else 1
    if mode in ("ia32-unavailable", "ia32-available"):
        seen = ia32_call()
        print(f"{mode}: {seen}")
        usable = seen == f"returned {-EINVAL}"
        if mode == "ia32-available":
            return 0 if usable else 1
        return 0 if (seen.startswith("signal") or seen == f"returned {-ENOSYS}") else 1
    print("usage: vsock-probe.py vsock-denied|vsock-created|ia32-unavailable|ia32-available", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else ""))
