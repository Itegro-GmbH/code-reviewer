// SPDX-License-Identifier: LicenseRef-Proprietary

import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SANDBOX_LAUNCHER_ADDITIONS,
  WORKER_CONTAINER_SPEC,
} from "../launchers/container-spec.ts";
import { renderDockerRunArguments } from "../launchers/container.ts";
import { resolveConfig } from "./config.ts";
import {
  EXIT_ANCHOR_MISSING,
  EXIT_LISTING_EMPTY,
  EXIT_MANIFEST_EMPTY,
  EXIT_MANIFEST_MISSING,
  EXIT_MANIFEST_MODIFIED,
  EXIT_TOOL_FAILED,
  PATHS,
  buildImageScript,
  checkNoContainersScript,
  cleanBuilderScript,
  daemonConfigJson,
  installDockerScript,
  installHostScriptsScript,
  installSysboxScript,
  inspectImageScript,
  probeRunArguments,
  probeScript,
  recordBaseManifestScript,
  scanScript,
  SCAN_ROOTS,
  shellQuote,
  startDaemonScript,
  stopDaemonScript,
  sysboxProbeScript,
  writeDaemonConfigScript,
} from "./scripts.ts";

const config = resolveConfig();
const REPO = join(import.meta.dirname, "..", "..", "..");

/** A block device needs root (or CAP_MKNOD): the test that needs one runs where the runner has it, like a CI VM. */
function makeBlockDevice(path: string): boolean {
  return (
    spawnSync("mknod", [path, "b", "254", "16"], { stdio: "ignore" }).status ===
    0
  );
}

function canMakeBlockDevice(dir: string): boolean {
  const probe = join(mkdtempSync(join(dir, "golden-mknod-")), "probe");
  const made = makeBlockDevice(probe);
  rmSync(join(probe, ".."), { recursive: true, force: true });
  return made;
}

function syntaxErrors(script: string): string {
  const result = spawnSync("bash", ["-n", "-c", script], { encoding: "utf8" });
  return result.status === 0 ? "" : result.stderr;
}

describe("the scripts the builder VM runs", () => {
  const everyScript: Record<string, string> = {
    installDocker: installDockerScript(config),
    installSysbox: installSysboxScript(config),
    writeDaemonConfig: writeDaemonConfigScript(),
    installHostScripts: installHostScriptsScript(),
    startDaemon: startDaemonScript(),
    buildImage: buildImageScript(config),
    inspectImage: inspectImageScript(config),
    recordBaseManifest: recordBaseManifestScript(),
    cleanBuilder: cleanBuilderScript(),
    checkNoContainers: checkNoContainersScript(),
    stopDaemon: stopDaemonScript(),
    scan: scanScript(),
    probe: probeScript(config),
  };

  it.each(Object.entries(everyScript))(
    "%s is valid bash and fails on the first error",
    (_name, script) => {
      expect(syntaxErrors(script)).toBe("");
      expect(script).toContain("set -euo pipefail");
    },
  );

  it("quotes a value so that it stays one word", () => {
    expect(shellQuote("plain")).toBe("'plain'");
    expect(shellQuote("it's")).toBe(`'it'"'"'s'`);
    expect(
      execFileSync(
        "bash",
        ["-c", `printf %s ${shellQuote("a b'; echo pwned")}`],
        {
          encoding: "utf8",
        },
      ),
    ).toBe("a b'; echo pwned");
  });

  // #330-T01
  it("installs the pinned Docker and buildx with apt-get and refuses another version", () => {
    const script = installDockerScript(config);
    expect(script).toContain("apt-get install");
    expect(script).toContain(`docker.io=${config.dockerVersion}*`);
    expect(script).toContain(`docker-buildx=${config.buildxVersion}*`);
    expect(script).toContain("dpkg-query");
    expect(script).toMatch(/exit 42/);
  });

  it("writes a daemon.json that keeps IPv6 and its tables off and the container logs small", () => {
    const parsed = JSON.parse(daemonConfigJson()) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      ipv6: false,
      ip6tables: false,
      "live-restore": false,
    });
    // The runtime is registered, not made the default: every container that does not name it runs as before.
    expect(parsed).toMatchObject({
      runtimes: { "sysbox-runc": { path: "/usr/bin/sysbox-runc" } },
    });
    expect(parsed).not.toHaveProperty("default-runtime");
    expect(parsed).not.toHaveProperty("hosts");
    expect(parsed).not.toHaveProperty("insecure-registries");
    expect(parsed).not.toHaveProperty("tls");
  });

  it("installs daemon.json and vm-prepare.sh as root-owned files and runs vm-prepare as root", () => {
    expect(writeDaemonConfigScript()).toContain(
      `install -D -m 0644 -o root -g root ${PATHS.daemonJson} /etc/docker/daemon.json`,
    );
    expect(installHostScriptsScript()).toContain(
      `install -D -m 0755 -o root -g root ${PATHS.vmPrepare} ${PATHS.vmPrepareInstalled}`,
    );
    expect(installHostScriptsScript()).toContain(
      `install -D -m 0755 -o root -g root ${PATHS.sysboxPrepare} ${PATHS.sysboxPrepareInstalled}`,
    );
    // The daemon start of the snapshot and of every job VM is vm-prepare.sh alone: Sysbox is a step of its own.
    expect(startDaemonScript()).not.toContain("sysbox");
    expect(startDaemonScript()).toContain(PATHS.vmPrepareInstalled);
  });

  it("builds the configured target from the extracted commit and prints nothing but the build tail on failure", () => {
    const script = buildImageScript(resolveConfig({ target: "dynamic" }));
    expect(script).toContain("--target 'dynamic'");
    expect(script).toContain("--file 'runner/Dockerfile'");
    expect(script).toContain(`tar xzf ${PATHS.context}`);
    expect(script).toContain("tail -n");
  });

  it("checks every container, not only the running ones", () => {
    expect(checkNoContainersScript()).toContain("docker ps -aq");
  });

  // #330-T04
  it("stops the daemon with SIGTERM, never SIGKILL, and waits until dockerd and containerd are gone", () => {
    const script = stopDaemonScript();
    expect(script).toContain("kill -TERM");
    expect(script).not.toMatch(/kill -(9|KILL)|pkill|killall/);
    expect(script).toContain("dockerd");
    expect(script).toContain("containerd");
    // pgrep sees the kernel's 15-character process name: the shim is "containerd-shim", not its file name.
    expect(script).toContain("pgrep -x 'dockerd|containerd|containerd-shim'");
  });

  it("reads the image id with docker image inspect", () => {
    expect(inspectImageScript(config)).toContain(
      "docker image inspect --format '{{.Id}}'",
    );
  });

  it("removes the build cache and the staged files, then syncs", () => {
    const script = cleanBuilderScript();
    expect(script).toContain("docker builder prune -af");
    expect(script).toContain("rm -rf /tmp/golden-*");
    expect(script).toContain("sync");
  });
});

describe("the Sysbox install of the builder VM", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "golden-sysbox-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Runs the real script with stand-ins for the tools that would change the machine (curl, apt-get, dpkg, dpkg-query,
   * sysbox-runc), which record what they are called with. The package is written under the test's directory.
   */
  function runInstall(options: {
    packageText: string;
    sha256: string;
    installedVersion?: string;
  }) {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const calls = join(dir, "calls");
    const deb = join(dir, "sysbox.deb");
    const stand = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    stand(
      "curl",
      `echo "curl $*" >> ${calls}
while [ "$#" -gt 0 ]; do if [ "$1" = "--output" ]; then out=$2; fi; shift; done
printf '%s' ${shellQuote(options.packageText)} > "$out"`,
    );
    stand(
      "apt-get",
      `echo "apt-get $* systemctl=$(command -v systemctl)" >> ${calls}`,
    );
    stand("dpkg", `echo "dpkg $*" >> ${calls}`);
    stand(
      "dpkg-query",
      `echo ${shellQuote(options.installedVersion ?? "0.7.1.linux")}`,
    );
    stand("sysbox-runc", `echo "sysbox-runc $*" >> ${calls}`);
    const script = installSysboxScript(
      resolveConfig({ sysboxSha256: options.sha256 }),
    ).replaceAll(PATHS.sysboxDeb, deb);
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    const recorded = existsSync(calls)
      ? readFileSync(calls, "utf8").trim().split("\n")
      : [];
    return { result, calls: recorded, deb };
  }

  const sha256 = (text: string) =>
    createHash("sha256").update(text).digest("hex");

  it("downloads the pinned release over https and installs it with a stub systemctl first on the PATH", () => {
    const { result, calls, deb } = runInstall({
      packageText: "the package",
      sha256: sha256("the package"),
    });

    expect(result.status).toBe(0);
    expect(calls[0]).toContain(
      "https://github.com/nestybox/sysbox/releases/download/v0.7.1/sysbox-ce_0.7.1.linux_amd64.deb",
    );
    const apt = calls.find((call) => call.startsWith("apt-get"));
    expect(apt).toContain(`install -y -qq ${deb} kmod`);
    // The stub is what the maintainer scripts of the package find; it is gone afterwards.
    const stub = /systemctl=(\S+)/.exec(apt ?? "")?.[1] ?? "";
    expect(stub).toMatch(/\/systemctl$/);
    expect(existsSync(stub)).toBe(false);
    expect(existsSync(deb)).toBe(false);
    expect(calls.some((call) => call.startsWith("dpkg --purge"))).toBe(false);
  });

  it("refuses a package that is not the pinned one before apt sees it, and exits with its own status", () => {
    const { result, calls, deb } = runInstall({
      packageText: "another package",
      sha256: sha256("the package"),
    });

    expect(result.status).toBe(41);
    expect(result.stderr).toContain("not the pinned one");
    expect(calls.some((call) => call.startsWith("apt-get"))).toBe(false);
    expect(existsSync(deb)).toBe(false);
  });

  it("purges what it unpacked when the installed version is not the pinned one", () => {
    const { result, calls } = runInstall({
      packageText: "the package",
      sha256: sha256("the package"),
      installedVersion: "0.8.0.linux",
    });

    expect(result.status).toBe(44);
    expect(calls).toContain("dpkg --purge --force-all sysbox-ce");
  });

  it("leaves no fake systemctl in the snapshot: the stub lives in a directory of its own", () => {
    const script = installSysboxScript(config);
    expect(script).toContain("stub=$(mktemp -d)");
    expect(script).not.toMatch(/\/usr\/(local\/)?s?bin\/systemctl/);
  });
});

describe("the Sysbox proof of the check VM", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "golden-sysbox-probe-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** The proof with a stand-in for sysbox-prepare.sh and for docker; the lines it prints are what the pipeline reads. */
  function runProof(options: { prepare: string; docker?: string }) {
    const here = mkdtempSync(join(dir, "run-"));
    const bin = join(here, "bin");
    mkdirSync(bin);
    const prepare = join(here, "sysbox-prepare.sh");
    writeFileSync(prepare, `#!/bin/sh\n${options.prepare}\n`);
    chmodSync(prepare, 0o755);
    const stand = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    stand("docker", options.docker ?? "exit 0");
    stand("timeout", 'shift; exec "$@"');
    // The waits of the proof are for a real daemon.
    stand("sleep", "exit 0");
    // The VM's addresses: the proof asks the isolated network for each of them.
    stand(
      "ip",
      "echo '2: eth0    inet 10.0.0.5/24 brd 10.0.0.255 scope global eth0'",
    );
    const script = sysboxProbeScript(config).replaceAll(
      PATHS.sysboxPrepareInstalled,
      prepare,
    );
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    return { result, lines: result.stdout.trim().split("\n") };
  }

  it("is valid bash that ends with its marker and never exits non-zero for what it found", () => {
    const { result, lines } = runProof({
      prepare: "echo 'sysbox-prepare: sysbox_mgr_not_ready tail' >&2; exit 24",
    });

    expect(result.status).toBe(0);
    expect(lines.at(-1)).toBe("SYSBOX_PROBE_DONE");
  });

  it("names the failure of the boot step by the name the boot script gave it, and runs nothing else", () => {
    const { lines } = runProof({
      prepare:
        "echo 'sysbox-prepare: sysbox_proc_unmount_failed /proc/keys' >&2; exit 22",
      docker: "echo docker was called >&2; exit 0",
    });

    expect(lines).toEqual([
      "SYSBOX_PROBE fail sysbox_proc_unmount_failed",
      "SYSBOX_PROBE_DONE",
    ]);
  });

  it("falls back to a name of its own when the boot step fails without one", () => {
    const { lines } = runProof({ prepare: "exit 1" });
    expect(lines[0]).toBe("SYSBOX_PROBE fail sysbox_boot_failed");
  });

  it("says the proof did not run, not that Sysbox is broken, when the agent image is not in the snapshot", () => {
    const { lines } = runProof({
      prepare: "exit 0",
      docker: 'if [ "$1" = image ]; then exit 1; fi; exit 0',
    });

    expect(lines).toEqual([
      "SYSBOX_PROBE ok boot",
      "SYSBOX_PROBE fail sysbox_probe_image_unavailable",
      "SYSBOX_PROBE_DONE",
    ]);
  });

  it("reports a container that does not start and a daemon in it that does not answer", () => {
    const started = runProof({
      prepare: "exit 0",
      docker: 'if [ "$1" = run ]; then exit 1; fi; exit 0',
    });
    expect(started.lines).toContain(
      "SYSBOX_PROBE fail sysbox_container_failed",
    );

    const answered = runProof({
      prepare: "exit 0",
      docker: 'if [ "$1" = exec ]; then exit 1; fi; exit 0',
    });
    expect(answered.lines).toContain(
      "SYSBOX_PROBE fail sysbox_inner_docker_failed",
    );
  });

  /**
   * A docker that gets every step of the proof right and answers the network checks as told. `box` is what the isolated
   * container's own `nc` and `ping` return (0 = the connection was made), `control` what a plain container on the VM
   * returns for the same targets, `alive` how often `docker exec <box> true` succeeds before the box is gone.
   */
  function networkDocker(
    options: {
      boxLoopNc?: number;
      boxOutsideNc?: number;
      boxPing?: number;
      vmControl?: number;
      outsideNc?: number;
      outsidePing?: number;
      aliveCalls?: number;
    } = {},
  ) {
    const o = {
      boxLoopNc: 1,
      boxOutsideNc: 1,
      boxPing: 1,
      vmControl: 0,
      outsideNc: 0,
      outsidePing: 0,
      aliveCalls: 99,
      ...options,
    };
    return `
case "$1" in
  network) if [ "$2" = inspect ]; then echo 172.30.0.1; fi; exit 0 ;;
  run)
    if [ "$2" = --detach ]; then exit 0; fi
    for last; do :; done
    case "$last" in
      *1.1.1.1*) exit ${o.outsideNc} ;;
      *ping*) exit ${o.outsidePing} ;;
      *) exit ${o.vmControl} ;;
    esac ;;
  exec)
    case "$3" in
      true)
        calls=$(cat "$0.alive" 2> /dev/null || echo 0)
        echo $((calls + 1)) > "$0.alive"
        if [ "$calls" -lt ${o.aliveCalls} ]; then exit 0; fi
        exit 1 ;;
      docker | test) exit 0 ;;
      sh)
        case "$5" in
          *"docker import"*) echo "tini version 0.19.0 - git.de40ad0"; exit 0 ;;
          *1.1.1.1*) exit ${o.boxOutsideNc} ;;
          *ping*) exit ${o.boxPing} ;;
          *) exit ${o.boxLoopNc} ;;
        esac ;;
    esac ;;
esac
exit 0`;
  }

  function isolation(options: Parameters<typeof networkDocker>[0]) {
    return runProof({ prepare: "exit 0", docker: networkDocker(options) })
      .lines;
  }

  it("proves the isolation when every address is blocked from the box and reachable from a plain container", () => {
    const lines = isolation({});
    expect(lines).toEqual([
      "SYSBOX_PROBE ok boot",
      "SYSBOX_PROBE ok inner_docker",
      "SYSBOX_PROBE ok inner_container",
      "SYSBOX_PROBE ok network_control",
      "SYSBOX_PROBE ok outside_control",
      "SYSBOX_PROBE ok network_isolated",
      "SYSBOX_PROBE_DONE",
    ]);
  });

  it.each([
    ["an address of the VM", { boxLoopNc: 0 }],
    ["an outside address", { boxOutsideNc: 0 }],
    ["an outside name", { boxPing: 0 }],
  ])("fails when the isolated container reaches %s", (_name, options) => {
    const lines = isolation(options);
    expect(lines).toContain("SYSBOX_PROBE fail sysbox_network_not_isolated");
    expect(lines).not.toContain("SYSBOX_PROBE ok network_isolated");
    expect(lines.at(-1)).toBe("SYSBOX_PROBE_DONE");
  });

  it.each([
    ["the box is gone before the checks", { aliveCalls: 0 }],
    ["the box is gone after the checks", { aliveCalls: 1 }],
    ["a plain network cannot reach the VM's listener", { vmControl: 1 }],
    ["a plain container has no way out to an address", { outsideNc: 1 }],
    ["a plain container has no way out to a name", { outsidePing: 1 }],
  ])(
    "calls the check inconclusive, and not isolated, when %s",
    (_name, options) => {
      const lines = isolation({ ...options, boxLoopNc: 1 });
      expect(lines).toContain(
        "SYSBOX_PROBE fail sysbox_network_check_inconclusive",
      );
      expect(lines).not.toContain("SYSBOX_PROBE ok network_isolated");
      expect(lines).not.toContain(
        "SYSBOX_PROBE fail sysbox_network_not_isolated",
      );
      expect(lines.at(-1)).toBe("SYSBOX_PROBE_DONE");
    },
  );

  it("asks a plain container on the VM for each outside target the isolated box is asked for", () => {
    const script = sysboxProbeScript(config);
    expect(script).toContain("nc -w 3 -z 1.1.1.1 443");
    expect(script).toContain("ping -c 1 -W 3 example.com");
    expect(script.indexOf('docker exec "$box" true')).toBeLessThan(
      script.indexOf("for target in"),
    );
  });

  it("runs the agent image, as the Implementer starts it, with the Sysbox runtime on the network with no exit", () => {
    const script = sysboxProbeScript(config);

    expect(script).toContain(
      "docker network create --internal -o com.docker.network.bridge.gateway_mode_ipv4=isolated",
    );
    expect(script).toContain("--runtime=sysbox-runc");
    expect(script).toContain(shellQuote(config.agentImageTag));
    // Nothing is pulled: the image is the one in the snapshot.
    expect(script).not.toContain("docker pull");
    // The control network is a plain --internal one; without it a "blocked" would prove nothing.
    expect(script).toContain('docker network create --internal "$ctl"');
    expect(script).toContain("sysbox_network_check_inconclusive");
    expect(script).toContain("sysbox_network_not_isolated");
  });

  it("starts with the boot script of the job VMs, so that the proof covers the steps a job runs", () => {
    const script = sysboxProbeScript(config);
    expect(script.indexOf(PATHS.sysboxPrepareInstalled)).toBeGreaterThan(-1);
    expect(script.indexOf(PATHS.sysboxPrepareInstalled)).toBeLessThan(
      script.indexOf("docker image inspect"),
    );
  });

  it("holds no secret", () => {
    expect(sysboxProbeScript(config)).not.toMatch(
      /token|secret|password|credential/i,
    );
  });
});

describe("the container flags of the self-check probe", () => {
  const args = probeRunArguments(config);

  // #330-extra-probe
  it("mirror the hardening of the container spec, plus the IPv6 sysctls the reduced ruleset needs", () => {
    const joined = args.join(" ");
    for (const flag of [
      "--user 0:0",
      "--cap-drop ALL",
      "--security-opt no-new-privileges:true",
      "--read-only",
      "--pids-limit 512",
      "--memory 1536m",
      "--memory-swap 1536m",
      "--sysctl net.ipv6.conf.all.disable_ipv6=1",
      "--sysctl net.ipv6.conf.default.disable_ipv6=1",
    ])
      expect(joined, flag).toContain(flag);
    for (const cap of [
      "SETUID",
      "SETGID",
      "KILL",
      "CHOWN",
      "DAC_OVERRIDE",
      "FOWNER",
      "NET_ADMIN",
      "SETPCAP",
    ])
      expect(joined, cap).toContain(`--cap-add ${cap}`);
    expect(args.filter((arg) => arg === "--cap-add")).toHaveLength(8);
  });

  // #330-extra-probe
  it("use the tmpfs, capabilities and limits of the example spec of the hardened container contract", () => {
    const spec = JSON.parse(
      readFileSync(
        join(
          REPO,
          "contracts/examples/worker-container/WorkerContainerSpec.json",
        ),
        "utf8",
      ),
    ) as {
      capAdd: { name: string }[];
      pids: { limit: number };
      readOnly: boolean;
      tmpfs: { path: string }[];
    };
    const tmpfs = args.filter((_, index) => args[index - 1] === "--tmpfs");
    expect(tmpfs).toHaveLength(spec.tmpfs.length);
    for (const mount of spec.tmpfs)
      expect(
        tmpfs.some((entry) => entry.startsWith(`${mount.path}:`)),
        mount.path,
      ).toBe(true);
    expect(
      args.filter((_, index) => args[index - 1] === "--cap-add").sort(),
    ).toEqual(spec.capAdd.map((cap) => cap.name).sort());
    expect(args.join(" ")).toContain(`--pids-limit ${String(spec.pids.limit)}`);
    expect(spec.readOnly).toBe(true);
    expect(args).toContain("--read-only");
  });

  // #330-extra-probe
  it("never ask for more than the hardened container spec allows", () => {
    for (const forbidden of [
      "--privileged",
      "--volume",
      "-v",
      "--mount",
      "--device",
      "--pid",
      "--ipc",
      "--userns",
      "--cgroupns",
      "--security-opt=seccomp=unconfined",
      "seccomp=unconfined",
      "apparmor=unconfined",
    ])
      expect(args, forbidden).not.toContain(forbidden);
    expect(args.join(" ")).not.toContain("--network host");
    expect(args.join(" ")).not.toContain("--network=host");
  });

  it("give the probe no token, no URL and no credential, only what its settings read", () => {
    const environment = args.filter((_, index) => args[index - 1] === "--env");
    expect(environment).toEqual([
      "HOME=/home/runner",
      "RUNNER_DIFF_JOB_USER=10001:10001",
    ]);
  });

  // #330-extra-probe
  it("are the output of the shared renderer (#325) for the Sandbox variant, not flags written here", () => {
    expect(args).toEqual(
      renderDockerRunArguments(WORKER_CONTAINER_SPEC, {
        image: config.imageTag,
        environment: {
          HOME: "/home/runner",
          RUNNER_DIFF_JOB_USER: "10001:10001",
        },
        command: ["probe"],
        overrides: {
          memory: { limit: config.probeMemory, swap: config.probeMemory },
        },
        additions: SANDBOX_LAUNCHER_ADDITIONS,
      }),
    );
    expect(args.slice(-2)).toEqual([config.imageTag, "probe"]);
    expect(args.slice(0, 3)).toEqual(["run", "--interactive", "--rm"]);
  });

  it("run the probe mode of the configured image once, with a backstop timeout", () => {
    expect(probeScript(config)).toContain(
      `timeout 180 docker ${args.map(shellQuote).join(" ")}`,
    );
  });
});

describe("the final scan of the restored snapshot", () => {
  let work: string;
  let roots: string;
  let docker: string;
  let manifest: string;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "golden-scan-"));
    roots = join(work, "root");
    docker = join(work, "docker");
    manifest = join(work, "base-manifest");
    mkdirSync(join(roots, "home", "ubuntu"), { recursive: true });
    mkdirSync(join(roots, "etc"), { recursive: true });
    mkdirSync(join(docker, "containers"), { recursive: true });
    mkdirSync(join(docker, "volumes"), { recursive: true });
    writeFileSync(join(docker, "volumes", "metadata.db"), "bolt");
    writeFileSync(
      join(roots, "etc", "app.conf"),
      "listen = 8080\nnothing secret here\n",
    );
    // The base layer as it is after the platform booted: what a test writes from here on is the pipeline's.
    recordBase();
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  /** The file the scan expects the pipeline to have written (vm-prepare.sh in production), a canary for an empty listing. */
  const anchor = () => join(roots, "usr", "local", "sbin", "vm-prepare.sh");

  /** The builder's first command, on the base layer as it is now: what is written later is the pipeline's. */
  function recordBase(): string {
    rmSync(anchor(), { force: true });
    const out = execFileSync(
      "bash",
      [
        "-c",
        recordBaseManifestScript({ roots: [roots], manifestPath: manifest }),
      ],
      { encoding: "utf8" },
    );
    return /^MANIFEST_SHA256 ([0-9a-f]{64})$/m.exec(out)?.[1] ?? "";
  }

  function scanOptions(extra: Partial<Parameters<typeof scanScript>[0]> = {}) {
    return {
      roots: [roots],
      dockerRoot: docker,
      manifestPath: manifest,
      anchorPath: anchor(),
      ...extra,
    };
  }

  /** The pipeline writes vm-prepare.sh after the record, as the builder does. */
  function writeAnchor(): void {
    mkdirSync(join(roots, "usr", "local", "sbin"), { recursive: true });
    writeFileSync(anchor(), "#!/usr/bin/env bash\n");
  }

  function scanResult(
    extra: Partial<Parameters<typeof scanScript>[0]> = {},
    env: NodeJS.ProcessEnv = process.env,
  ) {
    return spawnSync("bash", ["-c", scanScript(scanOptions(extra))], {
      encoding: "utf8",
      env,
    });
  }

  /** The scan as the check VM runs it, over what the pipeline wrote after the record. */
  function scanOutput(): string {
    expect(existsSync(manifest), "a test records the base first").toBe(true);
    if (!existsSync(anchor())) writeAnchor();
    return execFileSync("bash", ["-c", scanScript(scanOptions())], {
      encoding: "utf8",
    });
  }
  const scan = scanOutput;

  const DOC_EXAMPLES: Record<string, string> = {
    "config.md": "Set `key` to a PEM file:\n-----BEGIN PRIVATE KEY-----\n",
    "npmrc.md": "//registry.example.org/:_authToken=MYTOKEN1\n",
    "CHANGELOG.md": "//reg.example.org/:_authToken=${ORG_A_TOKEN}\n",
    "AssumeRoleCommand.d.ts": "@example accessKeyId: AKIAIOSFODNN7EXAMPLE\n",
    "pnpm.mjs": "var x = 'AKIAUEFSCETA0ACQCAKI';\n",
  };

  /** A base image layer as the platform ships it: global Node packages whose docs and bundles hold example secrets. */
  function writeBaseImageLayer(): string {
    const packages = join(roots, "usr", "local", "lib", "node_modules", "npm");
    mkdirSync(join(packages, "docs"), { recursive: true });
    for (const [file, content] of Object.entries(DOC_EXAMPLES))
      writeFileSync(join(packages, "docs", file), content);
    return packages;
  }

  // #357-T12
  it("finds nothing in a clean tree and ends with its marker", () => {
    expect(scan()).toBe("SCAN_DONE\n");
  });

  // #357-T12
  it.each([
    ["secret_file", ".env", "A=1\n"],
    ["secret_file", ".env.production", "A=1\n"],
    ["secret_file", ".netrc", "machine x\n"],
    ["secret_file", ".git-credentials", "https://u:p@github.com\n"],
    ["secret_file", "id_ed25519", "x\n"],
    ["history", ".bash_history", "export X=1\n"],
    ["private_key", "key.txt", "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n"],
    ["private_key", "rsa.txt", "-----BEGIN RSA PRIVATE KEY-----\nabc\n"],
    ["token", "gh.txt", `token ghp_${"A1b2".repeat(10)}\n`],
    ["token", "pat.txt", `github_pat_${"a1B2".repeat(8)}\n`],
    [
      "token",
      "or.txt",
      `OPENROUTER=sk-or-v1-${"0123456789abcdef".repeat(2)}\n`,
    ],
    ["token", "job.txt", `Authorization crj_${"abcDEF123-_".repeat(4)}\n`],
    [
      "token",
      "npmrc.txt",
      "//registry.example.org/:_authToken=abcdef0123456789\n",
    ],
    ["token", "env.txt", "RUNNER_TOKEN=abcdefghijklmnop\n"],
  ])(
    "reports a %s (%s) written after the base was recorded, by path, and never prints its content",
    (kind, file, content) => {
      recordBase();
      const path = join(roots, "home", "ubuntu", file);
      writeFileSync(path, content);
      const out = scan();
      expect(out).toContain(`FINDING ${kind} ${path}\n`);
      expect(out.endsWith("SCAN_DONE\n")).toBe(true);
      for (const word of content.split(/[\s=]/))
        if (word.length >= 16) expect(out).not.toContain(word);
    },
  );

  // #357-T12
  it("reports a Docker config that holds an auth entry, not an empty one, and allows .env.example", () => {
    recordBase();
    mkdirSync(join(roots, "home", "ubuntu", ".docker"), { recursive: true });
    const config = join(roots, "home", "ubuntu", ".docker", "config.json");
    writeFileSync(config, '{"auths":{}}');
    writeFileSync(join(roots, "home", "ubuntu", ".env.example"), "A=\n");
    expect(scan()).toBe("SCAN_DONE\n");
    writeFileSync(
      config,
      '{"auths":{"vcr.example.test":{"auth":"dXNlcjpwYXNz"}}}',
    );
    expect(scan()).toContain(`FINDING docker_auth ${config}\n`);
  });

  // #357-T12
  it("allows the distribution's snake-oil key and reports a key of the same shape under any other name", () => {
    mkdirSync(join(roots, "etc", "ssl"), { recursive: true });
    writeFileSync(
      join(roots, "etc", "ssl", "ssl-cert-snakeoil.key"),
      "-----BEGIN PRIVATE KEY-----\nabc\n",
    );
    expect(scan()).toBe("SCAN_DONE\n");
    const other = join(roots, "etc", "ssl", "server.key");
    writeFileSync(other, "-----BEGIN PRIVATE KEY-----\nabc\n");
    expect(scan()).toBe(`FINDING private_key ${other}\nSCAN_DONE\n`);
  });

  describe("what the platform's base image ships", () => {
    // #357-T01
    it("is not reported: documentation and bundles with an example key, a PEM header and placeholder tokens", () => {
      writeBaseImageLayer();
      recordBase();
      expect(scanOutput()).toBe("SCAN_DONE\n");
    });

    // #357-T01
    it("is skipped while the pipeline's own files next to it are still scanned", () => {
      writeBaseImageLayer();
      recordBase();
      const planted = join(roots, "home", "ubuntu", "leak.txt");
      writeFileSync(planted, `ghp_${"A1b2".repeat(10)}\n`);
      expect(scanOutput()).toBe(`FINDING token ${planted}\nSCAN_DONE\n`);
    });
  });

  describe("what the pipeline adds or changes", () => {
    // #357-T02
    it("reports a secret planted in a new file in a base-image directory", () => {
      const packages = writeBaseImageLayer();
      recordBase();
      const planted = join(packages, "docs", "new.md");
      writeFileSync(planted, `RUNNER_TOKEN=${"x1y2z3".repeat(4)}\n`);
      expect(scanOutput()).toBe(`FINDING token ${planted}\nSCAN_DONE\n`);
    });

    // #357-T03
    it("reports a base file that grew to hold a secret", () => {
      const packages = writeBaseImageLayer();
      recordBase();
      const file = join(packages, "docs", "npmrc.md");
      appendFileSync(file, `ghp_${"A1b2".repeat(10)}\n`);
      expect(scanOutput()).toContain(`FINDING token ${file}\n`);
    });

    // #357-T03
    it("reports a base file rewritten to the same size with a newer time", () => {
      writeBaseImageLayer();
      const file = join(roots, "etc", "app.conf");
      writeFileSync(
        file,
        `${"# a base file, long enough for a token\n".repeat(2)}`,
      );
      recordBase();
      const old = readFileSync(file, "utf8");
      const replaced = `ghp_${"A1b2".repeat(10)}`.padEnd(old.length, "\n");
      expect(replaced.length).toBe(old.length);
      writeFileSync(file, replaced);
      utimesSync(file, new Date(), new Date(Date.now() + 5000));
      expect(scanOutput()).toContain(`FINDING token ${file}\n`);
    });

    // #357-T16
    it("reports a base file rewritten to the same size with its old modification time restored", () => {
      const file = join(roots, "etc", "app.conf");
      writeFileSync(file, "# a base file, long enough for a token\n".repeat(2));
      recordBase();
      const before = statSync(file, { bigint: true });
      const reference = join(work, "reference");
      writeFileSync(reference, "x");
      execFileSync("touch", ["-r", file, reference]);
      writeFileSync(
        file,
        `ghp_${"A1b2".repeat(10)}`.padEnd(Number(before.size), "\n"),
      );
      // What `touch -r`, `cp -p` and an archive extraction do: size and mtime are exactly the old ones.
      execFileSync("touch", ["-r", reference, file]);
      const after = statSync(file, { bigint: true });
      expect(after.size).toBe(before.size);
      expect(after.mtimeNs).toBe(before.mtimeNs);
      expect(scanOutput()).toContain(`FINDING token ${file}\n`);
    });

    // #357-T04
    it("reports a documented example key in a file the pipeline wrote", () => {
      recordBase();
      const written = join(roots, "etc", "docker-notes.txt");
      writeFileSync(written, "key AKIAIOSFODNN7EXAMPLE\n");
      expect(scanOutput()).toBe(`FINDING token ${written}\nSCAN_DONE\n`);
    });

    // #357-T04
    it("reports a PEM header and a placeholder token in files the pipeline wrote", () => {
      recordBase();
      const pem = join(roots, "etc", "ca.pem");
      const rc = join(roots, "home", "ubuntu", ".npmrc");
      writeFileSync(pem, "-----BEGIN PRIVATE KEY-----\nabc\n");
      writeFileSync(rc, "//registry.example.org/:_authToken=MYTOKEN1\n");
      const out = scanOutput();
      expect(out).toContain(`FINDING private_key ${pem}\n`);
      expect(out).toContain(`FINDING token ${rc}\n`);
    });

    // #357-T04
    it("skips nothing that is only a file of the same name as a base file", () => {
      writeBaseImageLayer();
      recordBase();
      const elsewhere = join(roots, "home", "ubuntu", "npmrc.md");
      writeFileSync(elsewhere, DOC_EXAMPLES["npmrc.md"] ?? "");
      expect(scanOutput()).toContain(`FINDING token ${elsewhere}\n`);
    });

    // #357-T09
    it("does not report a file that was removed after the record", () => {
      writeBaseImageLayer();
      recordBase();
      rmSync(join(roots, "usr", "local", "lib", "node_modules"), {
        recursive: true,
      });
      expect(scanOutput()).toBe("SCAN_DONE\n");
    });
  });

  describe("the base manifest", () => {
    // #357-T07
    it("makes the scan fail without a marker when it is missing", () => {
      const result = spawnSync(
        "bash",
        [
          "-c",
          scanScript({
            roots: [roots],
            dockerRoot: docker,
            manifestPath: join(work, "no-such-manifest"),
          }),
        ],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(EXIT_MANIFEST_MISSING);
      expect(result.stdout).not.toContain("SCAN_DONE");
    });

    // #357-T07
    it("makes the scan fail without a marker when it is empty", () => {
      writeFileSync(manifest, "");
      const result = spawnSync(
        "bash",
        [
          "-c",
          scanScript({
            roots: [roots],
            dockerRoot: docker,
            manifestPath: manifest,
          }),
        ],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(EXIT_MANIFEST_MISSING);
      expect(result.stdout).not.toContain("SCAN_DONE");
    });

    // #357-T07
    it("is refused by the record step when the roots hold no file", () => {
      const result = spawnSync(
        "bash",
        [
          "-c",
          recordBaseManifestScript({
            roots: [join(work, "missing")],
            manifestPath: join(work, "none", "manifest"),
          }),
        ],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(EXIT_MANIFEST_EMPTY);
      expect(existsSync(join(work, "none", "manifest"))).toBe(false);
      expect(result.stdout).not.toContain("MANIFEST_SHA256");
    });

    // #357-T09
    it("lists each file once with its size, modification and status change time, one NUL terminated record per file", () => {
      const records = readFileSync(manifest, "utf8").split("\0");
      expect(records.pop()).toBe("");
      expect(records).toHaveLength(1);
      expect(records[0]).toMatch(
        new RegExp(
          `^${join(roots, "etc", "app.conf").replaceAll(".", "\\.")}\t${statSync(join(roots, "etc", "app.conf")).size}\t\\d+\\.\\d+\t\\d+\\.\\d+$`,
        ),
      );
      expect(readFileSync(manifest, "utf8")).not.toContain("SCAN_DONE");
    });

    // #357-T09
    it("is recorded and scanned over the same roots by default", () => {
      const roots = [...SCAN_ROOTS].map((root) => shellQuote(root)).join(" ");
      expect(recordBaseManifestScript()).toContain(`roots=(${roots})`);
      expect(scanScript()).toContain(`roots=(${roots})`);
      expect(recordBaseManifestScript()).toContain(PATHS.baseManifest);
      expect(scanScript()).toContain(PATHS.baseManifest);
    });

    // #357-T09
    it("lies outside the scan roots and outside the staged files the clean step removes", () => {
      for (const root of SCAN_ROOTS)
        expect(PATHS.baseManifest.startsWith(`${root}/`)).toBe(false);
      expect(PATHS.baseManifest.startsWith("/tmp/")).toBe(false);
    });
  });

  describe("Docker's own data", () => {
    // #357-T05
    it("allows the volume database as a regular file and nothing else of the two directories empty", () => {
      expect(scan()).toBe("SCAN_DONE\n");
    });

    // #357-T05
    it.skipIf(!canMakeBlockDevice(tmpdir()))(
      "allows the block device dockerd creates in volumes at every start",
      () => {
        makeBlockDevice(join(docker, "volumes", "backingFsBlockDev"));
        expect(scan()).toBe("SCAN_DONE\n");
      },
    );

    // #357-T06
    it("reports a container directory or a volume, but not the volume database", () => {
      mkdirSync(join(docker, "containers", "abc123"));
      expect(scan()).toContain(
        `FINDING job_data ${join(docker, "containers", "abc123")}\n`,
      );
      rmSync(join(docker, "containers", "abc123"), { recursive: true });
      expect(scan()).toBe("SCAN_DONE\n");
      mkdirSync(join(docker, "volumes", "vol1"));
      expect(scan()).toContain(
        `FINDING job_data ${join(docker, "volumes", "vol1")}\n`,
      );
    });

    // #357-T06
    it.each([
      [
        "a regular file",
        (path: string) => writeFileSync(path, "not a device\n"),
      ],
      ["a directory", (path: string) => mkdirSync(path)],
      ["a symbolic link", (path: string) => symlinkSync("/dev/null", path)],
    ])(
      "reports %s named backingFsBlockDev: only a block device is Docker's own",
      (_what, create) => {
        const path = join(docker, "volumes", "backingFsBlockDev");
        create(path);
        expect(scan()).toContain(`FINDING job_data ${path}\n`);
      },
    );

    // #357-T06
    it("reports a volume database that is not a regular file, and a database in the container directory", () => {
      rmSync(join(docker, "volumes", "metadata.db"));
      mkdirSync(join(docker, "volumes", "metadata.db"));
      expect(scan()).toContain(
        `FINDING job_data ${join(docker, "volumes", "metadata.db")}\n`,
      );
      rmSync(join(docker, "volumes", "metadata.db"), { recursive: true });
      writeFileSync(join(docker, "containers", "metadata.db"), "bolt");
      expect(scan()).toContain(
        `FINDING job_data ${join(docker, "containers", "metadata.db")}\n`,
      );
    });

    // #357-T06
    it("reads every file of the container and volume directories, new or not", () => {
      mkdirSync(join(docker, "volumes", "vol1"));
      const leak = join(docker, "volumes", "vol1", "out.txt");
      writeFileSync(leak, `ghp_${"A1b2".repeat(10)}\n`);
      recordBase();
      const out = scanOutput();
      expect(out).toContain(`FINDING token ${leak}\n`);
      expect(out).toContain(
        `FINDING job_data ${join(docker, "volumes", "vol1")}\n`,
      );
    });
  });

  it("skips a root that does not exist", () => {
    writeAnchor();
    const result = scanResult({ roots: [join(work, "missing"), roots] });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("SCAN_DONE\n");
  });

  describe("failing closed", () => {
    // #357-T15
    it("fails without a marker when the listing of the roots is empty", () => {
      writeAnchor();
      const result = scanResult({ roots: [join(work, "missing")] });
      expect(result.status).toBe(EXIT_LISTING_EMPTY);
      expect(result.stdout).not.toContain("SCAN_DONE");
    });

    // #357-T15
    it("fails without a marker when the pipeline's own file is not among the added files", () => {
      // No vm-prepare.sh was written after the record: the listing is not the one of the pipeline's VM.
      writeFileSync(
        join(roots, "home", "ubuntu", "other.txt"),
        "something new\n",
      );
      const result = scanResult();
      expect(result.status).toBe(EXIT_ANCHOR_MISSING);
      expect(result.stdout).not.toContain("SCAN_DONE");
    });

    /** A directory of stand-ins that come first on PATH. */
    function stubTools(stubs: Record<string, string>): NodeJS.ProcessEnv {
      const bin = join(work, "stub-bin");
      mkdirSync(bin, { recursive: true });
      for (const [name, body] of Object.entries(stubs)) {
        writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
        chmodSync(join(bin, name), 0o755);
      }
      return { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
    }

    // #357-T15
    it.each([
      ["find exits 2", { find: "exit 2" }, false],
      ["find exits 1 (a file vanished)", { find: "exit 1" }, false],
      ["grep exits 2", { grep: "exit 2" }, false],
      ["grep exits 3", { grep: "exit 3" }, false],
      ["grep is killed", { grep: "kill -9 $$" }, false],
      [
        "grep exits 2 for the Docker auth check only",
        { grep: 'case "$*" in *-qE*) exit 2 ;; esac; exec /usr/bin/grep "$@"' },
        true,
      ],
    ])(
      "fails without a marker and with the tool failure status when %s, with a token planted",
      (_what, stubs, withDockerConfig) => {
        writeAnchor();
        if (withDockerConfig) {
          mkdirSync(join(roots, "home", "ubuntu", ".docker"), {
            recursive: true,
          });
          writeFileSync(
            join(roots, "home", "ubuntu", ".docker", "config.json"),
            '{"auths":{}}',
          );
        }
        writeFileSync(
          join(roots, "home", "ubuntu", "leak.txt"),
          `ghp_${"A1b2".repeat(10)}\n`,
        );
        const result = scanResult({}, stubTools(stubs));
        expect(result.status).toBe(EXIT_TOOL_FAILED);
        expect(result.stdout).not.toContain("SCAN_DONE");
      },
    );

    // #357-T15
    it("is not fooled by a grep that finds the token and fails afterwards", () => {
      writeAnchor();
      writeFileSync(
        join(roots, "home", "ubuntu", "leak.txt"),
        `ghp_${"A1b2".repeat(10)}\n`,
      );
      const result = scanResult(
        {},
        stubTools({ grep: '/usr/bin/grep "$@"; exit 2' }),
      );
      expect(result.status).toBe(EXIT_TOOL_FAILED);
      expect(result.stdout).not.toContain("SCAN_DONE");
    });

    // #357-T18
    it("does not fail on a file that was listed and is gone when grep asks for it, and still reports the others", () => {
      writeAnchor();
      const victim = join(roots, "etc", "ca-certificates.crt.new");
      writeFileSync(victim, "a temporary file of the boot\n");
      const leak = join(roots, "home", "ubuntu", "leak.txt");
      writeFileSync(leak, `ghp_${"A1b2".repeat(10)}\n`);
      // The stand-in lists as the real find does and removes the temporary file right after, as the boot does.
      const env = {
        ...stubTools({
          find: `/usr/bin/find "$@"; status=$?; case "$*" in *-printf*) rm -f "$GOLDEN_VICTIM" ;; esac; exit $status`,
        }),
        GOLDEN_VICTIM: victim,
      };
      const result = scanResult({}, env);
      expect(result.stdout).toBe(`FINDING token ${leak}\nSCAN_DONE\n`);
      expect(result.status).toBe(0);
    });

    // #357-T18
    it("lists again when find fails once, and passes", () => {
      writeAnchor();
      const flag = join(work, "find-failed-once");
      const env = {
        ...stubTools({
          find: `case "$*" in *-printf*) if [ ! -e "$GOLDEN_FLAG" ]; then : > "$GOLDEN_FLAG"; echo "find: vanished" >&2; exit 1; fi ;; esac; exec /usr/bin/find "$@"`,
        }),
        GOLDEN_FLAG: flag,
      };
      const result = scanResult({}, env);
      expect(existsSync(flag)).toBe(true);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("SCAN_DONE\n");
    });

    // #357-T15
    it("still passes when grep finds nothing in some of its batches (exit 1 is a plain no-match)", () => {
      writeAnchor();
      for (let index = 0; index < 5; index += 1)
        writeFileSync(
          join(roots, "home", "ubuntu", `f${index}.txt`),
          "plain\n",
        );
      const result = scanResult();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("SCAN_DONE\n");
    });

    // #357-T15
    it("fails without a marker when the manifest no longer has the hash the pipeline pinned", () => {
      const pinned = createHash("sha256")
        .update(readFileSync(manifest))
        .digest("hex");
      writeAnchor();
      const good = scanResult({ manifestSha256: pinned });
      expect(good.status).toBe(0);
      expect(good.stdout).toBe("SCAN_DONE\n");
      // A record is added: a shrunk or garbled manifest would hide files.
      appendFileSync(manifest, "/etc/app.conf\t1\t1.0\t1.0\0");
      const tampered = scanResult({ manifestSha256: pinned });
      expect(tampered.status).toBe(EXIT_MANIFEST_MODIFIED);
      expect(tampered.stdout).not.toContain("SCAN_DONE");
      const wrong = scanResult({ manifestSha256: "0".repeat(64) });
      expect(wrong.status).toBe(EXIT_MANIFEST_MODIFIED);
    });

    // #357-T15
    it("prints the hash of the manifest the record step wrote, and nothing else of it", () => {
      const printed = recordBase();
      expect(printed).toBe(
        createHash("sha256").update(readFileSync(manifest)).digest("hex"),
      );
    });

    // #357-T15
    it("refuses a hash that is not 64 hex digits instead of ignoring it", () => {
      expect(() => scanScript({ manifestSha256: "abc" })).toThrow();
    });

    it("exits with codes of its own for each of its failures", () => {
      const codes = [
        EXIT_MANIFEST_MISSING,
        EXIT_MANIFEST_EMPTY,
        EXIT_LISTING_EMPTY,
        EXIT_ANCHOR_MISSING,
        EXIT_TOOL_FAILED,
        EXIT_MANIFEST_MODIFIED,
      ];
      expect(new Set(codes).size).toBe(codes.length);
    });
  });

  // #357-T08
  it("is not fooled by a file name with a space, a tab or a newline", () => {
    recordBase();
    const odd = join(roots, "home", "ubuntu", "my .env");
    writeFileSync(odd, "A=1\n");
    chmodSync(odd, 0o600);
    expect(scan()).toBe("SCAN_DONE\n");
    const tokenFile = join(roots, "home", "ubuntu", "a b.txt");
    writeFileSync(tokenFile, `ghp_${"A1b2".repeat(10)}\n`);
    expect(scan()).toContain(`FINDING token ${tokenFile}\n`);
    const tabbed = join(roots, "home", "ubuntu", "t\t5\t1.5.txt");
    writeFileSync(tabbed, `ghp_${"A1b2".repeat(10)}\n`);
    expect(scan()).toContain(`FINDING token ${tabbed}\n`);
    const lined = join(roots, "home", "ubuntu", "new\nline.txt");
    writeFileSync(lined, `ghp_${"A1b2".repeat(10)}\n`);
    expect(scan()).toContain(`FINDING token ${lined}\n`);
  });

  // #357-T08
  it("is not fooled by a base file with an odd name that changed", () => {
    const lined = join(roots, "home", "ubuntu", "base\n5\nfile.txt");
    writeFileSync(lined, "plain\n");
    recordBase();
    expect(scanOutput()).toBe("SCAN_DONE\n");
    appendFileSync(lined, `ghp_${"A1b2".repeat(10)}\n`);
    expect(scanOutput()).toContain(`FINDING token ${lined}\n`);
  });
});
