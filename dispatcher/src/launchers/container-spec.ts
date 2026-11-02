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
  stopTimeoutSeconds: 90,
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

// The profile of the Implementer (#760, contracts/worker-container.v1.json, `ImplementerContainerSpec`): the spec above
// with exactly six fields changed (the four of #760, the VM's Docker socket and the matching `forbiddenKeys`, #745), so
// that the hardening floor cannot differ between the two. The agent builds and
// tests a repository, which the floor alone cannot host (a read-only root, `noexec` tmpfs of 512 MB, 2 GB, 512
// processes): one Docker named volume at /work, on the VM's disk and the only writable path that may run a program,
// room for `pnpm install` and a test run (3 GB; the VM has 4 GB), and 2048 processes. The four names are what the
// Dispatcher tells the Worker about its work directory, its network and its model door (runner-api.v1.json,
// `ImplementerEnvironmentName`).
//
// The Docker socket of the VM (#745, step 3): the Worker is the Control container of the turn and starts the model door,
// the container that holds the model key, through the VM's Docker. That makes it effectively root on the VM. It is
// accepted because the agent never reaches it (the socket is root's inside the container and the agent is another user;
// from step 4 the agent is another container), and the runner puts nothing of a job or of the agent's output into a
// request to the socket (runner/src/code_reviewer_runner/implementer/docker_api.py). Diff and Dynamic have no such mount.
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
  memory: { limit: "3g", reservation: "2560m", swap: "3g" },
  pids: { limit: 2048 },
  allowedEnvironment: [
    ...WORKER_CONTAINER_SPEC.allowedEnvironment,
    "RUNNER_IMPLEMENTER_WORK_DIR",
    "RUNNER_IMPLEMENTER_EGRESS_PORT",
    "RUNNER_IMPLEMENTER_NETWORK",
    "RUNNER_IMPLEMENTER_MODEL_DOOR",
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
