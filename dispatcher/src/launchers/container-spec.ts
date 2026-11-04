// SPDX-License-Identifier: LicenseRef-Proprietary

import type {
  ImplementerContainerSpec,
  WorkerContainerLauncherAdditions,
  WorkerContainerSpec,
} from "../contracts/worker-container.ts";

// The hardened container spec the launchers render (contracts/worker-container.v1.json, #316). It is the
// example spec of the contract, value for value; container-spec.test.ts fails when the two differ. A change of
// a flag is therefore made in both in one pull request.
export const WORKER_CONTAINER_SPEC: WorkerContainerSpec = {
  version: 1,
  user: "0:0",
  capDrop: ["ALL"],
  capAdd: [
    { name: "SETUID", startupOnly: false },
    { name: "SETGID", startupOnly: false },
    { name: "KILL", startupOnly: false },
    { name: "CHOWN", startupOnly: false },
    { name: "DAC_OVERRIDE", startupOnly: false },
    { name: "FOWNER", startupOnly: false },
    { name: "NET_ADMIN", startupOnly: true },
    { name: "SETPCAP", startupOnly: true },
  ],
  securityOpt: ["no-new-privileges:true"],
  readOnly: true,
  tmpfs: [
    {
      path: "/tmp",
      options: ["rw", "noexec", "nosuid", "nodev"],
      size: "512m",
      mode: "1777",
    },
    {
      path: "/run",
      options: ["rw", "noexec", "nosuid", "nodev"],
      size: "1m",
      mode: "0755",
    },
    {
      path: "/home/runner",
      options: ["rw", "noexec", "nosuid", "nodev"],
      size: "64m",
      uid: 10001,
      gid: 10001,
      mode: "0700",
    },
  ],
  memory: { limit: "2g", reservation: "1536m", swap: "2g" },
  pids: { limit: 512 },
  stopTimeoutSeconds: 150,
  network: { mode: "bridge" },
  allowedEnvironment: [
    "HOME",
    "RUNNER_DIFF_JOB_USER",
    "RUNNER_JOB_TIMEOUT_SECONDS",
    "RUNNER_DYNAMIC_CAPABILITIES",
    "RUNNER_DYNAMIC_MAX_COST_USD",
  ],
  forbiddenKeys: [
    "privileged",
    "binds",
    "volumes",
    "devices",
    "networkMode",
    "pid",
    "ipc",
    "uts",
    "userns",
    "cgroupns",
    "dockerSocket",
  ],
  overridable: ["memory.limit", "memory.reservation", "memory.swap"],
};

// The profile of the Implementer's Control container (#760, contracts/worker-container.v1.json, `ImplementerContainerSpec`):
// the spec above with exactly six fields changed (the four of #760, the VM's Docker socket and the matching `forbiddenKeys`,
// #745), so that the hardening floor cannot differ between the two. Control keeps the git token, makes the clone and the
// push, and starts the model door, the agent's container and the reader through the VM's Docker (#745, steps 3 and 4); the
// agent itself runs in a container of its own, so the profile no longer has to hold a build: one Docker named volume at
// /work, on the VM's disk and the only writable path (the mirror, and the agent's repository, which Control makes but never
// opens as trusted), and the memory of a runner that clones and pushes (768 MB; the rest of the VM is the agent's, see
// `agentMemoryMb` in sandbox.ts). The names are what the Dispatcher tells the Worker about its work directory, its Docker
// and the sandbox (runner-api.v1.json, `ImplementerEnvironmentName`).
//
// The Docker socket of the VM: Control is effectively root on the VM with it. That is accepted because the agent never
// reaches it: the agent's container has no socket, no bind and no network but the model network, and the runner puts nothing
// of a job or of the agent's output into a request to the socket
// (runner/src/code_reviewer_runner/implementer/docker_api.py). Diff and Dynamic have no such mount.
// The file of the contract equals this one; container-spec.test.ts fails when they differ.
export const IMPLEMENTER_CONTAINER_SPEC: ImplementerContainerSpec = {
  ...WORKER_CONTAINER_SPEC,
  workVolume: {
    path: "/work",
    options: ["rw", "nosuid", "nodev"],
    source: "named-volume",
  },
  dockerSocket: {
    source: "/var/run/docker.sock",
    target: "/run/docker.sock",
  },
  memory: { limit: "768m", reservation: "512m", swap: "768m" },
  pids: { limit: 2048 },
  allowedEnvironment: [
    ...WORKER_CONTAINER_SPEC.allowedEnvironment,
    "RUNNER_IMPLEMENTER_WORK_DIR",
    "RUNNER_IMPLEMENTER_MODEL_DOOR",
    "RUNNER_IMPLEMENTER_SANDBOX_PROOF",
    "RUNNER_IMPLEMENTER_AGENT_MEMORY_MB",
    "RUNNER_IMPLEMENTER_NETWORK_SWITCH",
  ],
  forbiddenKeys: WORKER_CONTAINER_SPEC.forbiddenKeys.filter(
    (key) => key !== "dockerSocket",
  ),
};

// What the Sandbox variant adds to the spec (`WorkerContainerLauncherAdditions`, #325, #345): IPv6 off in
// the container. The Sandbox VM kernel only has the nf_tables `ip` family, so the Dynamic-Worker installs
// its fallback egress rules there; an `ip` table does not see IPv6, so the Worker must prove IPv6 is off, and
// the container's /proc/sys is read-only: the switches have to come from `docker run --sysctl`. The Sandbox-
// Launcher (#329) passes this to its ContainerLauncher for every Worker kind; the shared spec
// has no sysctl.
export const SANDBOX_LAUNCHER_ADDITIONS: WorkerContainerLauncherAdditions = {
  sysctls: {
    "net.ipv6.conf.all.disable_ipv6": "1",
    "net.ipv6.conf.default.disable_ipv6": "1",
  },
};
