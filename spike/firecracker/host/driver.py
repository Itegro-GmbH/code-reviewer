#!/usr/bin/env python3
"""Spike #970: the host side of the experiments, run as the NORMAL user `fcuser` inside a systemd service with
Delegate=yes (see tests/run.sh). It is what the Dispatcher's launcher would do per job:

  reflink copy of the prepared Docker disk -> cgroup under the delegated subtree -> Firecracker on a pre-made TAP,
  read-only shared rootfs + writable job disk, vsock to the guest.

Commands: smoke | t01 | t02 --phase control|wall | t03 | timing | q4 | disk
Every command writes results/<name>.json and prints what it measured; a failed check makes the exit status 1.
"""
import argparse
import json
import os
import pathlib
import shutil
import socket
import statistics
import subprocess
import sys
import threading
import time

WORK = pathlib.Path(os.environ.get("SPIKE_WORK", "/srv/fc"))
ART = WORK / "artifacts"
BASE = WORK / "base" / "base-disk.ext4"
RES = WORK / "results"
VMS = WORK / "vms"
FC = "/usr/local/bin/firecracker"
SLOTS = {
    0: dict(tap="fctap0", ip="172.31.0.2/30", gw="172.31.0.1", ip6="fd00:fc:0::2/64", gw6="fd00:fc:0::1", mac="06:00:AC:1F:00:02"),
    1: dict(tap="fctap1", ip="172.31.0.6/30", gw="172.31.0.5", ip6="fd00:fc:1::2/64", gw6="fd00:fc:1::1", mac="06:00:AC:1F:00:06"),
}
CHECKS: list[tuple[str, bool, str]] = []


def say(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def check(name: str, ok: bool, detail: str = "") -> bool:
    CHECKS.append((name, ok, detail))
    say(f"{'PASS' if ok else 'FAIL'} {name}{': ' + detail if detail else ''}")
    return ok


def save(name: str, data) -> None:
    RES.mkdir(parents=True, exist_ok=True)
    (RES / f"{name}.json").write_text(json.dumps(data, indent=2, default=str))


# --------------------------------------------------------------------------------------------------- cgroups

class Cgroups:
    """The delegated subtree: systemd gave this service's cgroup to our user (Delegate=yes). We make a leaf for ourselves
    first (a cgroup with processes cannot enable controllers for its children), then one child per VM."""

    def __init__(self) -> None:
        rel = open("/proc/self/cgroup").read().strip().split("::", 1)[1]
        self.root = pathlib.Path("/sys/fs/cgroup") / rel.lstrip("/")
        self.error = ""
        try:
            sup = self.root / "supervisor"
            sup.mkdir(exist_ok=True)
            (sup / "cgroup.procs").write_text(str(os.getpid()))
            (self.root / "cgroup.subtree_control").write_text("+cpu +memory +pids +io")
        except OSError as e:
            self.error = repr(e)
        self.ok = not self.error
        say(f"cgroup delegation: root={self.root} ok={self.ok} {self.error} controllers={self.read(self.root / 'cgroup.controllers')}")

    @staticmethod
    def read(p: pathlib.Path) -> str:
        try:
            return p.read_text().strip()
        except OSError as e:
            return f"<{e.strerror}>"

    def make(self, name: str, **limits: str) -> pathlib.Path | None:
        if not self.ok:
            return None
        d = self.root / name
        d.mkdir(exist_ok=True)
        for k, v in limits.items():
            (d / k.replace("_", ".")).write_text(v)
        return d


# --------------------------------------------------------------------------------------------------- the VM

class Vm:
    def __init__(self, name: str, slot: int = 0, mode: str = "full", mem_mib: int = 2048, vcpus: int = 2,
                 quota_gib: int | None = None, resize: str = "guest", cg: Cgroups | None = None, limits: dict[str, str] | None = None,
                 tap: str | None = None, extra_args: str = "") -> None:
        self.name, self.slot, self.mode = name, slot, mode
        self.mem_mib, self.vcpus, self.quota_gib, self.resize = mem_mib, vcpus, quota_gib, resize
        self.net = SLOTS[slot]
        self.tap = tap or self.net["tap"]
        self.dir = VMS / name
        self.events: list[dict] = []
        self.proc: subprocess.Popen | None = None
        self.cgdir: pathlib.Path | None = None
        self.cg, self.limits, self.extra_args = cg, limits or {}, extra_args
        self.timings: dict[str, float] = {}
        self._srv: socket.socket | None = None

    # -- files
    def prepare(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)
        self.dir.mkdir(parents=True)
        t0 = time.monotonic()
        subprocess.run(["cp", "--reflink=always", "--sparse=auto", str(BASE), str(self.dir / "job.ext4")], check=True)
        self.timings["reflink_copy_ms"] = (time.monotonic() - t0) * 1000
        if self.quota_gib:
            os.truncate(self.dir / "job.ext4", self.quota_gib << 30)
            if self.resize == "host":  # the unprivileged service grows the file system offline, before the VM starts
                t1 = time.monotonic()
                p = subprocess.run(["resize2fs", str(self.dir / "job.ext4")], capture_output=True, text=True)
                if p.returncode != 0 and "e2fsck" in p.stdout + p.stderr:  # resize2fs wants a checked file system first
                    subprocess.run(["e2fsck", "-fy", str(self.dir / "job.ext4")], capture_output=True)
                    p = subprocess.run(["resize2fs", str(self.dir / "job.ext4")], capture_output=True, text=True)
                self.timings["host_resize_ms"] = (time.monotonic() - t1) * 1000
                self.timings["host_resize_rc"] = p.returncode
                self.timings["host_resize_msg"] = (p.stdout + p.stderr).strip().replace("\n", " | ")[:300]
        (self.dir / "fc.log").touch()
        cmdline = (
            "console=ttyS0 reboot=k panic=1 pci=off 8250.nr_uarts=1 i8042.noaux i8042.nokbd cgroup_no_v1=all "
            "root=/dev/vda ro rootfstype=ext4 init=/usr/bin/docker-init "
            f"spike.mode={self.mode} spike.ip={self.net['ip']} spike.gw={self.net['gw']} "
            f"spike.ip6={self.net['ip6']} spike.gw6={self.net['gw6']} "
            f"{'spike.resize=1 ' if self.quota_gib and self.resize == 'guest' else ''}{self.extra_args} -- /spike/init"
        )
        cfg = {
            "boot-source": {"kernel_image_path": str(ART / "vmlinux"), "boot_args": cmdline},
            "drives": [
                {"drive_id": "rootfs", "path_on_host": str(ART / "rootfs.ext4"), "is_root_device": True, "is_read_only": True},
                {"drive_id": "jobdisk", "path_on_host": str(self.dir / "job.ext4"), "is_root_device": False, "is_read_only": False},
            ],
            "network-interfaces": [{"iface_id": "eth0", "guest_mac": self.net["mac"], "host_dev_name": self.tap}],
            "vsock": {"guest_cid": 3, "uds_path": str(self.dir / "v.sock")},
            "machine-config": {"vcpu_count": self.vcpus, "mem_size_mib": self.mem_mib, "smt": False},
            "logger": {"log_path": str(self.dir / "fc.log"), "level": "Info", "show_level": True, "show_log_origin": False},
        }
        (self.dir / "config.json").write_text(json.dumps(cfg, indent=2))

    # -- the event channel: guest -> host, Firecracker connects to <uds>_5001
    def _listen(self) -> None:
        path = str(self.dir / "v.sock_5001")
        self._srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._srv.bind(path)
        self._srv.listen(32)

        def loop() -> None:
            while True:
                try:
                    c, _ = self._srv.accept()  # type: ignore[union-attr]
                except OSError:
                    return
                now = time.monotonic()
                try:
                    c.settimeout(5)
                    buf = b""
                    while not buf.endswith(b"\n"):
                        d = c.recv(65536)
                        if not d:
                            break
                        buf += d
                    ev = json.loads(buf)
                    ev["host_ms"] = (now - self.t0) * 1000
                    self.events.append(ev)
                    c.sendall(b"ok\n")
                except (OSError, ValueError):
                    pass
                finally:
                    c.close()

        threading.Thread(target=loop, daemon=True).start()

    def start(self) -> None:
        self._listen()
        if self.cg:
            self.cgdir = self.cg.make(f"vm-{self.name}", **self.limits)
        self.t0 = time.monotonic()
        console = open(self.dir / "console.log", "wb")
        self.proc = subprocess.Popen([FC, "--no-api", "--config-file", str(self.dir / "config.json")],
                                     stdout=console, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
        if self.cgdir:
            (self.cgdir / "cgroup.procs").write_text(str(self.proc.pid))
        self.timings["spawn_ms"] = (time.monotonic() - self.t0) * 1000

    def event(self, name: str) -> dict | None:
        return next((e for e in self.events if e["name"] == name), None)

    def wait_event(self, name: str, timeout: float = 120) -> dict | None:
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if (e := self.event(name)):
                return e
            if self.proc and self.proc.poll() is not None:
                say(f"{self.name}: firecracker exited rc={self.proc.returncode} while waiting for {name}")
                return None
            time.sleep(0.02)
        return None

    def boot(self, wait: str = "boot_done", timeout: float = 120) -> bool:
        self.prepare()
        self.start()
        ok = self.wait_event(wait, timeout) is not None
        if not ok:
            say(f"{self.name}: no '{wait}' within {timeout}s; console tail:\n" + self.console_tail(60))
        return ok

    def console_tail(self, n: int = 40) -> str:
        try:
            return "\n".join((self.dir / "console.log").read_text(errors="replace").splitlines()[-n:])
        except OSError:
            return ""

    # -- the command channel: host -> guest, through <uds> with "CONNECT <port>"
    def request(self, obj: dict, timeout: float = 60) -> dict:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(timeout)
        try:
            s.connect(str(self.dir / "v.sock"))
            s.sendall(b"CONNECT 5000\n")
            f = s.makefile("rwb")
            ack = f.readline().decode().strip()
            if not ack.startswith("OK"):
                return {"ok": False, "error": f"vsock connect refused: {ack!r}"}
            f.write((json.dumps(obj) + "\n").encode())
            f.flush()
            return json.loads(f.readline())
        except (OSError, ValueError) as e:
            return {"ok": False, "error": repr(e)}
        finally:
            s.close()

    def sh(self, cmd: str, timeout: float = 60, stdin: str | None = None) -> dict:
        r = self.request({"type": "exec", "cmd": cmd, "timeout": timeout, **({"stdin": stdin} if stdin else {})}, timeout + 10)
        r.setdefault("rc", -1)
        r.setdefault("stdout", "")
        r.setdefault("stderr", r.get("error", ""))
        return r

    # -- measurements
    def host_stats(self) -> dict:
        out: dict = {}
        if self.proc is None or self.proc.poll() is not None:
            return out
        pid = self.proc.pid
        for line in pathlib.Path(f"/proc/{pid}/smaps_rollup").read_text().splitlines():
            k, _, v = line.partition(":")
            if k in ("Rss", "Pss", "Pss_Anon", "Pss_File", "Pss_Shmem", "Private_Dirty", "Shared_Clean"):
                out[f"{k.lower()}_mib"] = round(int(v.split()[0]) / 1024, 1)
        status = pathlib.Path(f"/proc/{pid}/status").read_text()
        for line in status.splitlines():
            if line.startswith(("CapEff", "CapPrm", "NoNewPrivs", "Seccomp:", "Uid", "Threads")):
                k, _, v = line.partition(":")
                out[k.strip().lower()] = v.strip()
        if self.cgdir:
            out["cgroup_memory_current_mib"] = round(int(Cgroups.read(self.cgdir / "memory.current")) / 2**20, 1)
            stat = dict(l.split() for l in Cgroups.read(self.cgdir / "memory.stat").splitlines() if " " in l)
            for k in ("anon", "file", "kernel", "shmem"):
                if k in stat:
                    out[f"cgroup_{k}_mib"] = round(int(stat[k]) / 2**20, 1)
        return out

    def guest_mem(self) -> dict:
        r = self.sh("awk '/MemTotal|MemAvailable|MemFree|^Cached|Slab/ {printf \"%s %d\\n\", $1, $2/1024}' /proc/meminfo")
        d = {}
        for line in r["stdout"].splitlines():
            k, _, v = line.partition(" ")
            d[k.strip(":").lower() + "_mib"] = int(v)
        if "memtotal_mib" in d and "memavailable_mib" in d:
            d["guest_used_mib"] = d["memtotal_mib"] - d["memavailable_mib"]
        return d

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.request({"type": "shutdown"}, 5)
            try:
                self.proc.wait(10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        if self._srv:
            self._srv.close()
        if self.cgdir:
            try:
                self.cgdir.rmdir()
            except OSError:
                pass
        (self.dir / "job.ext4").unlink(missing_ok=True)

    def boot_timeline(self) -> dict:
        t = {e["name"]: round(e["host_ms"]) for e in self.events if e["name"] not in ("exit",)}
        t["guest_uptime_at_boot_done_ms"] = round(1000 * (self.event("boot_done") or {}).get("uptime", 0))
        return t


def keep_logs(vm: Vm) -> None:
    dst = RES / "vm-logs" / vm.name
    dst.mkdir(parents=True, exist_ok=True)
    for f in ("console.log", "fc.log", "config.json"):
        if (vm.dir / f).exists():
            shutil.copy(vm.dir / f, dst / f)


def finish(name: str, extra: dict | None = None) -> int:
    failed = [c for c in CHECKS if not c[1]]
    save(name, {"checks": [{"name": n, "ok": ok, "detail": d} for n, ok, d in CHECKS], **(extra or {})})
    say(f"== {name}: {len(CHECKS) - len(failed)}/{len(CHECKS)} checks passed")
    return 1 if failed else 0


# --------------------------------------------------------------------------------------------------- commands

def cmd_smoke(a) -> int:
    cg = Cgroups()
    vm = Vm("smoke", cg=cg, limits={"memory_max": "3G"})
    ok = vm.boot()
    check("boot_done reached", ok)
    if ok:
        say(f"timeline ms: {vm.boot_timeline()}")
        r = vm.sh("uname -a; echo; findmnt -no SOURCE,FSTYPE,OPTIONS /; touch /spike/x 2>&1 | head -1; echo; findmnt -no SOURCE,FSTYPE /jobdisk /var/lib/sysbox; docker info --format '{{.ServerVersion}} {{.Driver}} cgroup{{.CgroupVersion}} {{.Runtimes}}'")
        print(r["stdout"], r["stderr"])
        check("rootfs is read-only", "Read-only file system" in r["stdout"] or "Read-only file system" in r["stderr"])
        check("dockerd answers", r["rc"] == 0)
        cc = vm.sh("/spike/check-config.sh /proc/config.gz 2>&1 | sed 's/\\x1b\\[[0-9;]*m//g'", 60)
        save("smoke-check-config", cc)
        print(cc["stdout"][-6000:])
        diag = vm.sh("cd /sys/fs/cgroup; echo controllers=$(cat cgroup.controllers); echo subtree=$(cat cgroup.subtree_control); "
                     "zcat /proc/config.gz | grep -E 'RT_GROUP_SCHED|CGROUP_SCHED' ; "
                     "for op in '-cpuset -cpu -pids' '+memory +io +cpu +cpuset +pids'; do echo \"$op\" > cgroup.subtree_control && echo \"ok [$op]\" || echo \"FAIL [$op]\"; done; "
                     "for c in cpuset cpu io memory pids; do echo \"+$c\" > cgroup.subtree_control 2>&1 && echo \"ok +$c\" || echo \"FAIL +$c\"; done; cat cgroup.subtree_control; "
                     "echo '--- vm-prepare.sh, traced:'; bash -x /usr/local/sbin/vm-prepare.sh 2>&1 | grep -v left_in_root | head -n 40")
        print("diag:\n" + diag["stdout"], diag["stderr"])
        cfg = vm.sh("zcat /proc/config.gz | grep -cE '^CONFIG_(USER_NS|OVERLAY_FS|VSOCKETS|NF_TABLES|FUSE_FS)=y'")
        check("config.gz readable in the guest", cfg["stdout"].strip() == "5", cfg["stdout"].strip())
    keep_logs(vm)
    vm.stop()
    return finish("smoke", {"timeline": vm.boot_timeline() if ok else None})


def cmd_t01(a) -> int:
    """T01: Sysbox container with its own inner dockerd runs `docker run hello-world`, a plain runc container next to it."""
    cg = Cgroups()
    vm = Vm("t01", mem_mib=3072, vcpus=2, cg=cg, limits={"memory_max": "5G"})
    if not check("VM boots to boot_done (dockerd + Sysbox daemons)", vm.boot()):
        keep_logs(vm)
        return finish("t01")
    for ev in ("docker_ready", "sysbox_ready"):
        check(f"event {ev}", vm.event(ev) is not None)
    info = vm.sh("docker info --format '{{.ServerVersion}} storage={{.Driver}} cgroup=v{{.CgroupVersion}} runtimes={{range $k,$v := .Runtimes}}{{$k}} {{end}}'")
    print(info["stdout"])
    check("sysbox-runc registered next to runc", "sysbox-runc" in info["stdout"] and "runc" in info["stdout"], info["stdout"].strip())
    mem = {"after_boot": {**vm.host_stats(), **vm.guest_mem()}}

    # Control's case: a plain runc container, payload on stdin
    t0 = time.monotonic()
    r = vm.sh('echo \'{"jobId":"j1","appUrl":"https://example.invalid"}\' | docker run -i --rm --runtime=runc busybox:spike cat', 60)
    control_ms = round((time.monotonic() - t0) * 1000)
    check("runc container: payload on stdin comes back", r["rc"] == 0 and '"jobId":"j1"' in r["stdout"], f"{control_ms} ms; {r['stderr'][-200:]}")
    mem["after_control"] = {**vm.host_stats(), **vm.guest_mem()}

    # The agent's case: sysbox-runc container with its own dockerd (docker:dind image), image seeded from a file, run hello-world
    t0 = time.monotonic()
    r = vm.sh("docker run -d --runtime=sysbox-runc --name agent -v /jobdisk/seed:/seed:ro --entrypoint dockerd docker:dind-spike --host=unix:///var/run/docker.sock", 90)
    check("sysbox-runc container starts", r["rc"] == 0, r["stderr"][-300:])
    ready_ms = None
    for _ in range(120):
        if vm.sh("docker exec agent docker info >/dev/null 2>&1", 15)["rc"] == 0:
            ready_ms = round((time.monotonic() - t0) * 1000)
            break
        time.sleep(1)
    check("inner dockerd ready", ready_ms is not None, f"{ready_ms} ms after docker run")
    if ready_ms is None:
        print(vm.sh("docker logs agent 2>&1 | tail -n 40; tail -n 30 /var/log/sysbox-mgr.log /var/log/sysbox-fs.log; dmesg | tail -n 20")["stdout"])
    else:
        r = vm.sh("docker exec agent docker load -i /seed/hello-world.tar && docker exec agent docker run --rm hello-world:spike", 120)
        print(r["stdout"][-600:], r["stderr"][-300:])
        check("inner `docker run hello-world` prints Hello from Docker!", "Hello from Docker!" in r["stdout"])
        ev = vm.sh(
            "echo '--- uid_map in the container:'; docker exec agent cat /proc/self/uid_map; "
            "echo '--- inner docker:'; docker exec agent docker info --format 'server={{.ServerVersion}} storage={{.Driver}} runtimes={{range $k,$v := .Runtimes}}{{$k}} {{end}}cgroup=v{{.CgroupVersion}}'; "
            "echo '--- container root fs / host uid of its init:'; docker exec agent sh -c 'mount | grep \" / \"'; ps -o user:20,pid,comm -p $(docker inspect -f '{{.State.Pid}}' agent); "
            "echo '--- idmapped mounts / shiftfs in the sysbox logs:'; grep -hiE 'id-mapped|idmap|shiftfs' /var/log/sysbox-mgr.log /var/log/sysbox-fs.log | sort | uniq -c | sort -rn | head -n 8; "
            "echo '--- sysbox versions:'; sysbox-runc --version | head -n 3; "
            "echo '--- container privileges:'; docker inspect -f 'privileged={{.HostConfig.Privileged}} runtime={{.HostConfig.Runtime}}' agent", 60)
        print(ev["stdout"], ev["stderr"][-300:])
        save("t01-evidence", ev)
        uid_line = next((l.split() for l in ev["stdout"].splitlines() if len(l.split()) == 3 and l.split()[0] == "0"), [])
        check("container root is an unprivileged host uid (user namespace)", len(uid_line) == 3 and int(uid_line[1]) > 0 and int(uid_line[2]) >= 65536, " ".join(uid_line))
        tl = vm.sh("docker logs --timestamps agent 2>&1 | cut -c1-160 | head -n 60", 30)
        print("--- inner dockerd start, with the container's own timestamps:\n" + tl["stdout"])
        save("t01-agent-logs", tl)
        mem["agent_sysbox_container_up"] = {**vm.host_stats(), **vm.guest_mem()}
        nxt = vm.sh("docker run --rm --runtime=runc busybox:spike echo runc-next-to-sysbox; docker ps --format '{{.Names}} {{.Image}}'", 60)
        check("a runc container runs next to the running Sysbox container", "runc-next-to-sysbox" in nxt["stdout"], nxt["stdout"].replace("\n", " | "))
        # the same on a SECOND sysbox container: ready time when the Sysbox daemons are warm and the image is in the cache
        t0 = time.monotonic()
        vm.sh("docker run -d --runtime=sysbox-runc --name agent2 -v /jobdisk/seed:/seed:ro --entrypoint dockerd docker:dind-spike --host=unix:///var/run/docker.sock", 90)
        ready2 = None
        for _ in range(60):
            if vm.sh("docker exec agent2 docker info >/dev/null 2>&1", 15)["rc"] == 0:
                ready2 = round((time.monotonic() - t0) * 1000)
                break
            time.sleep(0.5)
        check("a second Sysbox container is ready as well", ready2 is not None, f"{ready2} ms")
    keep_logs(vm)
    vm.stop()
    return finish("t01", {"timeline": vm.boot_timeline(), "control_container_ms": control_ms, "inner_dockerd_ready_ms": ready_ms,
                          "memory": mem, "docker_info": info["stdout"].strip()})


def t02_targets(host_ip: str, slot: int) -> list[dict]:
    n = SLOTS[slot]
    gw = n["gw"]
    gw6 = n["gw6"]
    dns = "7f3b0100000100000000000007657861" + "6d706c6503636f6d0000010001"  # a DNS query for example.com
    t = lambda name, proto, addr, port=0, fam=4, **kw: {"name": name, "proto": proto, "addr": addr, "port": port, "family": fam, **kw}
    return [
        t("proxy (TAP address :3128)", "tcp", gw, 3128),
        t("proxy (host's eth0 address :3128)", "tcp", host_ip, 3128),
        t("host TAP address :9999", "tcp", gw, 9999),
        t("host TAP address udp :9999", "udp", gw, 9999),
        t("host TAP address ping", "icmp", gw),
        t("host eth0 address :9999", "tcp", host_ip, 9999),
        t("RFC1918 10.77.0.2 :9999 (forwarded)", "tcp", "10.77.0.2", 9999),
        t("RFC1918 172.16.77.2 :9999 (forwarded)", "tcp", "172.16.77.2", 9999),
        t("RFC1918 192.168.77.2 :9999 (forwarded)", "tcp", "192.168.77.2", 9999),
        t("RFC1918 10.77.0.2 udp :9999", "udp", "10.77.0.2", 9999),
        t("link-local 169.254.169.253 :9999 (fixture)", "tcp", "169.254.169.253", 9999),
        t("metadata 169.254.169.254 :80 (the real Azure endpoint)", "tcp", "169.254.169.254", 80),
        t("internet 1.1.1.1 :443", "tcp", "1.1.1.1", 443),
        t("internet 1.1.1.1 ping", "icmp", "1.1.1.1"),
        t("internet 8.8.8.8 udp :53 (DNS)", "udp", "8.8.8.8", 53, hex=dns),
        t(f"IPv6 host TAP address [{gw6}] :9999", "tcp", gw6, 9999, 6),
        t(f"IPv6 host TAP address [{gw6}] ping", "icmp", gw6, 0, 6),
        t("IPv6 forwarded fd00:77::2 :9999", "tcp", "fd00:77::2", 9999, 6),
        t("the other VM (172.31.0.6) :9999", "tcp", "172.31.0.6", 9999),
    ]


def cmd_t02(a) -> int:
    """T02: what the guest can reach. Run twice: --phase control (wall removed, NAT on) and --phase wall (static nft table)."""
    host_ip = os.environ["HOST_IP"]
    cg = Cgroups()
    vm_a = Vm(f"t02-{a.phase}-a", slot=0, mode="bare", cg=cg)
    vm_b = Vm(f"t02-{a.phase}-b", slot=1, mode="bare", cg=cg)
    ok_b = vm_b.boot()
    ok_a = vm_a.boot()
    check("both VMs booted", ok_a and ok_b)
    if not (ok_a and ok_b):
        keep_logs(vm_a), keep_logs(vm_b)
        return finish(f"t02-{a.phase}")
    vm_b.sh("nohup python3 -I -c \"import socket,threading\n"
            "s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); s.bind(('0.0.0.0',9999)); s.listen(8)\n"
            "while True:\n c,_=s.accept(); c.sendall(b'HTTP/1.0 200 OK listener=vm-b\\r\\n\\r\\n'); c.close()\" > /dev/null 2>&1 &")
    time.sleep(1)
    targets = t02_targets(host_ip, 0)
    r = vm_a.sh("python3 -I /spike/probe.py", 90, stdin=json.dumps(targets))
    try:
        results = json.loads(r["stdout"])
    except ValueError:
        say(f"probe output unusable: {r}")
        results = []
    check("probe ran", len(results) == len(targets), r["stderr"][-200:])
    width = max((len(x["name"]) for x in results), default=10)
    for x in results:
        print(f"  {x['name']:{width}}  {x['result']:10} {x['ms']:5} ms  {x['detail']}")
    keep_logs(vm_a), keep_logs(vm_b)
    vm_a.stop(), vm_b.stop()
    return finish(f"t02-{a.phase}", {"phase": a.phase, "results": results, "host_ip": host_ip})


def cmd_t02_pull(a) -> int:
    """Bonus of T02 (wall must be loaded): a Sysbox container pulls an image THROUGH the proxy; the VM has no other way out."""
    cg = Cgroups()
    vm = Vm("t02-pull", mem_mib=3072, cg=cg)
    if not check("VM boots", vm.boot()):
        return finish("t02-pull")
    proxy = f"http://{SLOTS[0]['gw']}:3128"
    r = vm.sh(f"docker run -d --runtime=sysbox-runc --name agent -e HTTPS_PROXY={proxy} -e NO_PROXY=localhost,127.0.0.1 --entrypoint dockerd docker:dind-spike --host=unix:///var/run/docker.sock", 90)
    check("sysbox container starts", r["rc"] == 0, r["stderr"][-200:])
    for _ in range(90):
        if vm.sh("docker exec agent docker info >/dev/null 2>&1", 15)["rc"] == 0:
            break
        time.sleep(1)
    t0 = time.monotonic()
    r = vm.sh("docker exec agent docker pull public.ecr.aws/docker/library/hello-world:linux 2>&1 | tail -n 5 && docker exec agent docker run --rm public.ecr.aws/docker/library/hello-world:linux", 180)
    print(r["stdout"][-700:])
    check("inner docker pulls and runs hello-world through the proxy", "Hello from Docker!" in r["stdout"], f"{round(time.monotonic() - t0)} s")
    direct = vm.sh("docker run --rm --runtime=runc busybox:spike sh -c 'wget -q -T 4 -O /dev/null http://1.1.1.1/ 2>&1; echo wget_rc=$?'", 30)
    check("a container on the VM that does not use the proxy gets nowhere", "wget_rc=0" not in direct["stdout"] and "wget_rc=" in direct["stdout"], direct["stdout"].strip()[:150])
    keep_logs(vm)
    vm.stop()
    return finish("t02-pull")


def cmd_t03(a) -> int:
    """T03: vsock round trip host -> guest -> host, with the start payload and the exit report."""
    cg = Cgroups()
    vm = Vm("t03", mode="bare", cg=cg)
    if not check("VM boots", vm.boot()):
        return finish("t03")
    import hashlib
    payload = {"appUrl": "https://app.example.invalid", "jobId": "job_0123456789", "crj": "crj_" + "x" * 40,
               "unicode": "Grüße, 世界 ✓", "nested": {"a": [1, 2, {"b": None}]}}
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    t0 = time.monotonic()
    r = vm.request({"type": "start", "payload": payload})
    rtt = (time.monotonic() - t0) * 1000
    say(f"start reply: {r}")
    check("host -> guest: start payload accepted, guest echoes the payload digest", r.get("ok") and r.get("payloadSha256") == digest, f"{rtt:.1f} ms")
    ex = vm.wait_event("exit", 10)
    check("guest -> host: exit report arrives", ex is not None and ex.get("jobId") == "job_0123456789" and ex.get("code") == 0, json.dumps(ex))
    check("the exit report carries the same payload digest (round trip host -> guest -> host)", ex is not None and ex.get("payloadSha256") == digest)
    got = vm.sh("cat /run/job/start.json")
    check("the guest process holds the exact payload", got["rc"] == 0 and json.loads(got["stdout"]) == payload)
    big = {"jobId": "big", "blob": "A" * (1 << 20)}
    t0 = time.monotonic()
    r = vm.request({"type": "start", "payload": big}, 30)
    big_ms = (time.monotonic() - t0) * 1000
    check("1 MiB payload", r.get("ok") and r.get("payloadSha256") == hashlib.sha256(json.dumps(big, sort_keys=True).encode()).hexdigest(), f"{big_ms:.0f} ms")
    lat = []
    for _ in range(200):
        t0 = time.monotonic()
        p = vm.request({"type": "ping"}, 5)
        lat.append((time.monotonic() - t0) * 1000)
        if not p.get("ok"):
            break
    lat.sort()
    stats = {"n": len(lat), "p50_ms": round(lat[len(lat) // 2], 2), "p95_ms": round(lat[int(len(lat) * 0.95)], 2), "max_ms": round(lat[-1], 2)}
    check("200 new connections, each a request/response", len(lat) == 200, json.dumps(stats))
    keep_logs(vm)
    vm.stop()
    return finish("t03", {"start_rtt_ms": round(rtt, 2), "one_mib_ms": round(big_ms), "ping": stats})


def cmd_timing(a) -> int:
    """Q7: boot to dockerd ready and to 'Control could start', and the memory a VM costs. N boots, one VM at a time."""
    cg = Cgroups()
    runs, bare = [], []
    for i in range(a.n):
        vm = Vm(f"timing-{i}", mode="bare", cg=cg)
        vm.boot("boot_done")
        bare.append({**vm.boot_timeline(), "memory": {**vm.host_stats(), **vm.guest_mem()}, "reflink_copy_ms": round(vm.timings["reflink_copy_ms"], 1)})
        say(f"bare #{i}: {bare[-1]['boot_done']} ms")
        if i == 0:
            keep_logs(vm)
        vm.stop()
    quiet = []
    for i in range(a.n):
        vm = Vm(f"timing-quiet-{i}", mode="bare", cg=cg, extra_args="quiet loglevel=0")
        vm.boot("boot_done")
        quiet.append(vm.boot_timeline())
        vm.stop()
    for i in range(a.n):
        vm = Vm(f"timing-full-{i}", mode="full", cg=cg, mem_mib=2048)
        vm.boot("boot_done")
        tl = vm.boot_timeline()
        t0 = time.monotonic()
        r = vm.sh("docker run --rm --runtime=runc busybox:spike true", 60)
        tl["control_container_ran_ms"] = tl.get("boot_done", 0) + round((time.monotonic() - t0) * 1000)
        tl["control_container_alone_ms"] = round((time.monotonic() - t0) * 1000)
        tl["control_rc"] = r["rc"]
        mem = {"after_control": {**vm.host_stats(), **vm.guest_mem()}}
        t0 = time.monotonic()
        vm.sh("docker run -d --runtime=sysbox-runc --name agent --entrypoint dockerd docker:dind-spike --host=unix:///var/run/docker.sock", 90)
        for _ in range(200):
            if vm.sh("docker exec agent docker info >/dev/null 2>&1", 15)["rc"] == 0:
                break
            time.sleep(0.25)
        tl["agent_inner_dockerd_after_run_ms"] = round((time.monotonic() - t0) * 1000)
        mem["agent_up"] = {**vm.host_stats(), **vm.guest_mem()}
        runs.append({"timeline": tl, "memory": mem, "reflink_copy_ms": round(vm.timings["reflink_copy_ms"], 1)})
        say(f"full #{i}: {tl}")
        if i == 0:
            keep_logs(vm)
        vm.stop()

    def agg(rows, key):
        v = [r[key] for r in rows if key in r]
        return {"min": min(v), "median": statistics.median(v), "max": max(v)} if v else None
    summary = {"bare": {k: agg([b for b in bare], k) for k in ("init_up", "disk_ready", "boot_done", "guest_uptime_at_boot_done_ms")},
               "bare_quiet": {k: agg(quiet, k) for k in ("init_up", "disk_ready", "boot_done", "guest_uptime_at_boot_done_ms")},
               "full": {k: agg([r["timeline"] for r in runs], k) for k in ("init_up", "disk_ready", "docker_ready", "sysbox_ready", "boot_done",
                                                                              "control_container_ran_ms", "agent_inner_dockerd_after_run_ms")}}
    print(json.dumps(summary, indent=2))
    check("every full boot reached Control-ready", all(r["timeline"].get("control_rc") == 0 for r in runs))
    return finish("timing", {"summary": summary, "bare": bare, "full": runs})


def cmd_q4(a) -> int:
    """Q4: what the unprivileged host side can and cannot do, and whether the delegated cgroup limits hold."""
    me = subprocess.run(["id"], capture_output=True, text=True).stdout.strip()
    say(f"running as: {me}")
    check("not root", os.getuid() != 0, me)
    cg = Cgroups()
    check("cgroup v2 subtree delegated to this user (we can create children and enable controllers)", cg.ok, cg.error)

    def attempt(argv: list[str]) -> tuple[int, str]:
        p = subprocess.run(argv, capture_output=True, text=True)
        return p.returncode, (p.stderr or p.stdout).strip()[:160]
    rc, msg = attempt(["ip", "tuntap", "add", "dev", "fcnew0", "mode", "tap"])
    check("negative control: this user cannot create a TAP device", rc != 0, msg)
    rc, msg = attempt(["nft", "add", "table", "inet", "x"])
    check("negative control: this user cannot change nftables", rc != 0, msg)
    rc, msg = attempt(["mount", "-t", "tmpfs", "tmpfs", "/mnt"])
    check("negative control: this user cannot mount", rc != 0, msg)

    # A TAP the user does not own: Firecracker must fail to open it (so ownership is what permits the pre-created TAPs)
    bad = Vm("q4-notmytap", mode="bare", tap="rootowned0", cg=cg)
    bad.prepare()
    bad.start()
    try:
        bad.proc.wait(15)  # type: ignore[union-attr]
    except subprocess.TimeoutExpired:
        pass
    gone = bad.proc.poll() is not None  # type: ignore[union-attr]
    check("negative control: Firecracker cannot attach to a TAP owned by someone else", gone, bad.console_tail(3).replace("\n", " | ")[-200:])
    bad.stop()

    vm = Vm("q4-main", mode="bare", cg=cg, limits={"memory_max": "3G", "pids_max": "128"})
    ok = vm.boot()
    check("VM boots as this user (KVM through group kvm, pre-created TAP, no jailer)", ok)
    if ok:
        s = vm.host_stats()
        say(f"firecracker process: {s}")
        check("Firecracker holds no capabilities", s.get("capeff") == "0000000000000000", s.get("capeff", ""))
        check("Firecracker runs with its seccomp filter", s.get("seccomp:") in ("2",) or s.get("seccomp") == "2", str(s.get("seccomp")))
        ps = subprocess.run(["ps", "-o", "user=,pid=,args=", "-p", str(vm.proc.pid)], capture_output=True, text=True).stdout.strip()  # type: ignore[union-attr]
        say(ps)
        check("the process belongs to fcuser", ps.startswith("fcuser"), ps)
        threads = len(list(pathlib.Path(f"/proc/{vm.proc.pid}/task").iterdir()))  # type: ignore[union-attr]
        say(f"firecracker threads: {threads}; cgroup pids.current={Cgroups.read(vm.cgdir / 'pids.current')}")  # type: ignore[operator]
        # cpu.max: 50% of one CPU for a two-vCPU guest running two busy loops
        vm.cgdir and (vm.cgdir / "cpu.max").write_text("50000 100000")  # type: ignore[union-attr]
        before = dict(l.split() for l in Cgroups.read(vm.cgdir / "cpu.stat").splitlines())  # type: ignore[operator]
        t0 = time.monotonic()
        vm.sh("for i in 1 2; do (timeout 6 sh -c 'while :; do :; done' &) ; done; sleep 6.5", 30)
        wall = time.monotonic() - t0
        after = dict(l.split() for l in Cgroups.read(vm.cgdir / "cpu.stat").splitlines())  # type: ignore[operator]
        used = (int(after["usage_usec"]) - int(before["usage_usec"])) / 1e6
        thr = int(after["nr_throttled"]) - int(before["nr_throttled"])
        say(f"cpu.max=50%: guest busy on 2 vCPUs for ~6 s; host cgroup consumed {used:.2f} cpu-seconds in {wall:.1f} s wall, throttled {thr} periods")
        check("cpu.max is enforced on the VM (throttled, consumed about 0.5 CPU)", thr > 0 and used / wall < 0.75, f"{used/wall:.2f} CPU, nr_throttled+={thr}")
        save("q4-cpu", {"cpu_seconds": used, "wall": wall, "throttled": thr})
    keep_logs(vm)
    vm.stop()

    # memory.max below what the guest will touch: the cgroup kills the VM, the host is untouched
    vm2 = Vm("q4-oom", mode="bare", mem_mib=2048, cg=cg, limits={"memory_max": "700M", "memory_swap_max": "0"})
    ok = vm2.boot()
    check("second VM (memory.max = 700 MiB, guest RAM 2 GiB) boots", ok)
    if ok:
        r = vm2.sh("python3 -I -c \"b=bytearray(1400<<20)\nfor i in range(0,len(b),4096): b[i]=1\nprint('allocated')\"", 60)
        time.sleep(1)
        events = Cgroups.read(vm2.cgdir / "memory.events")  # type: ignore[operator]
        died = vm2.proc.poll() is not None  # type: ignore[union-attr]
        say(f"guest allocation: {r.get('stdout', '').strip()!r} {r.get('error', '')}; memory.events: {events.replace(chr(10), ' ')}; firecracker exited: {died} rc={vm2.proc.returncode}")  # type: ignore[union-attr]
        check("memory.max holds: the cgroup OOM-kills the VM instead of the host", died, events.replace("\n", " "))
    keep_logs(vm2)
    vm2.stop()
    return finish("q4")


def cmd_disk(a) -> int:
    """Q3 (in the VM): read-only shared rootfs + writable job disk; quota = size of the job disk file; growing it two ways."""
    cg = Cgroups()
    base_size = BASE.stat().st_size
    quota = 3
    out = {"base_bytes": base_size, "variants": {}}
    for mode in ("guest", "host"):
        vm = Vm(f"disk-{mode}", mode="full", quota_gib=quota, resize=mode, cg=cg, mem_mib=2048)
        ok = vm.boot()
        check(f"[{mode}] VM boots with the job disk grown to the quota", ok)
        if not ok:
            keep_logs(vm)
            continue
        if mode == "guest":
            rs = vm.event("resize_done") or {}
            say(f"[guest] resize2fs in the VM: rc={rs.get('rc')} {rs.get('ms')} ms: {rs.get('msg')}")
            out["variants"][mode] = {"ms": rs.get("ms"), "rc": rs.get("rc"), "msg": rs.get("msg")}
        else:
            say(f"[host] resize2fs on the file: rc={vm.timings.get('host_resize_rc')} {vm.timings.get('host_resize_ms'):.0f} ms: {vm.timings.get('host_resize_msg')}")
            out["variants"][mode] = {"ms": round(vm.timings.get("host_resize_ms", 0)), "rc": vm.timings.get("host_resize_rc"), "msg": vm.timings.get("host_resize_msg")}
        r = vm.sh("blockdev --getsize64 /dev/vdb; df -BM --output=size,used,avail /jobdisk | tail -n 1; findmnt -no FSTYPE,OPTIONS / | cut -d, -f1; touch /spike/x 2>&1 | head -n 1")
        print(r["stdout"], r["stderr"])
        lines = r["stdout"].splitlines()
        dev_bytes = int(lines[0]) if lines and lines[0].isdigit() else 0
        fs_mib = int(lines[1].split()[0].rstrip("M")) if len(lines) > 1 else 0
        check(f"[{mode}] the block device is the quota", dev_bytes == quota << 30, f"{dev_bytes >> 20} MiB")
        check(f"[{mode}] the file system grew to the quota", fs_mib > (quota << 10) * 0.9, f"df says {fs_mib} MiB of {quota << 10} MiB")
        check(f"[{mode}] root file system is read-only", "Read-only file system" in r["stdout"] + r["stderr"], "touch: Read-only file system")
        w = vm.sh("dd if=/dev/zero of=/jobdisk/fill bs=1M count=4096 conv=fsync 2>&1 | tail -n 2; df -BM --output=size,used,avail /jobdisk | tail -n 1", 180)
        print(w["stdout"])
        check(f"[{mode}] writing past the quota fails with ENOSPC", "No space left" in w["stdout"] + w["stderr"], w["stdout"].replace("\n", " | ")[-160:])
        st = (vm.dir / "job.ext4").stat()
        check(f"[{mode}] the job disk file stays within its quota on the host", st.st_size <= quota << 30 and st.st_blocks * 512 <= quota << 30, f"allocated {st.st_blocks * 512 >> 20} MiB of {quota << 10} MiB")
        out["variants"][mode]["fs_mib"] = fs_mib
        out["variants"][mode]["allocated_mib_after_fill"] = st.st_blocks * 512 >> 20
        keep_logs(vm)
        vm.stop()
    save("disk-vm", out)
    return finish("disk", out)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["smoke", "t01", "t02", "t02-pull", "t03", "timing", "q4", "disk"])
    ap.add_argument("--phase", choices=["control", "wall"], default="wall")
    ap.add_argument("-n", type=int, default=5)
    a = ap.parse_args()
    RES.mkdir(parents=True, exist_ok=True)
    fn = {"smoke": cmd_smoke, "t01": cmd_t01, "t02": cmd_t02, "t02-pull": cmd_t02_pull, "t03": cmd_t03, "timing": cmd_timing, "q4": cmd_q4, "disk": cmd_disk}[a.cmd]
    return fn(a)


if __name__ == "__main__":
    sys.exit(main())
